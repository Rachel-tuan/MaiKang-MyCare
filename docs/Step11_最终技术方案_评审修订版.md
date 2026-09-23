-- =============================================================================
-- 迈康 MyCare · Step 11 最终技术方案（评审修订版）
-- =============================================================================
-- 状态：**待确认 · 代码零改动 · schema 零改动 · 未执行任何迁移**
-- 依据：以当前仓库实际代码为准（逐文件核对，非依据方案稿推断）
-- 本文件取代 docs/Step11_方案_AI评分与医生联动.md（原稿保留作对照）
--
-- 核对范围（均已实际读取）：
--   src/database/schema.sql                    22 张表定义
--   src/utils/dailyTasks.js                    buildDailyTasks() 唯一生成器
--   src/utils/healthScore.js                   computeDailyHealthScore() 唯一评分实现
--   src/utils/clinicalRules.js                 RULE_CATALOG / evaluateClinicalRules
--   server/data/patientService.js              getDailyTasks / getDoctorPatients / …
--   server/data/dataProvider.js                toUserProfileView / getSeries / getPatientProfile
--   server/data/agentContext.js                buildAgentContext / buildRuleEvaluation
--   server/data/alertService.js                persistRuleAlerts（落库范式参照）
--   server/index.js                            全部路由
--   server/agents/tools.js                     TOOL_SCHEMAS / createToolExecutor
--   server/agents/registry.js                  六智能体（planner = 方案规划）
--   server/agents/mock.js                      mockChat（降级对话分支）
--   server/agents/orchestrator.js              orchestrate / 降级分支
--   server/deepseek.js                         runToolLoop / chatJSON / safeParseJSON
--   src/contexts/AgentContext.jsx              sendMessage 的 SSE 事件分支
--   src/contexts/HealthDataContext.jsx         getActivePrescription(s)
--   src/pages/DoctorPage.jsx                   医生端现有能力与页签
--   scripts/db/verify-daily-tasks.mjs          既有断言 21/22/23
--   scripts/db/verify-health-score.mjs         既有断言 1–25
--   scripts/db/verify-step6.mjs                既有断言 J1–J4
-- =============================================================================


# Step 11 最终技术方案（评审修订版）

> 目标：把原方案修订为**可直接进入实施**的技术方案。
> 三个需求分别为 **① 医生端可修改今日任务**、**② 患者↔「方案规划」对话提案 → 医生审核联动**、**③ AI 参与评分**。
>
> 本次评审**新发现 6 个原方案未覆盖的实现层障碍**，其中 3 个属于「改了但没生效且不报错」的静默失败，若不先处理，Phase 1 会直接失败。全部列在 §1。

---

## 一、当前代码与 Step 11 方案的差异清单

> 逐条均为**实际核对结论**，标注文件与行号。标 🔴 者为「静默失败」——不报错但功能不生效。

### 🔴 F-1 · `patient_targets` 存在排序歧义：新增行会读不到（已实测复现）

原方案 §3.2 写「落两层：`patient_targets` 承接步数目标，`prescriptions.target_goals` 承接完整覆盖包」，隐含**插入新行**。

**实际代码有三处读取，用的都是同一个有歧义的排序：**

| 位置 | 语句用途 |
|---|---|
| `server/data/patientService.js:1188-1192` | `getDailyTasks()` 读 `steps_target` |
| `server/data/dataProvider.js:376` | `getSeries()` 读指标目标列 |
| `server/data/dataProvider.js:609` | `getPatientProfile()` 读整套目标 |

三处均为：

```sql
SELECT … FROM patient_targets WHERE patient_id = ?
ORDER BY COALESCE(effective_from, '') DESC LIMIT 1
```

而库里 3 位示范病例的 `effective_from` **全是 NULL**（已查实），`COALESCE(…, '')` 后排序键**全部等于 `''`** → 排序键完全相同 → SQLite 返回哪一行由实现决定。

**实测（在副本库副本上做，已删除临时库）：**

```
写入前读取 steps_target = {"steps_target":null}
已插入第二条目标行（医生改步数 5000）
当前目标行数: 2 | 新行目标: 5000
  第1次按现有语句读取 → {"steps_target":null}
  第2次按现有语句读取 → {"steps_target":null}
  第3次按现有语句读取 → {"steps_target":null}
--- 对照：按 created_at DESC 读 ---
{"steps_target":5000}
```

**结论：医生改完，患者端仍显示 8000，且没有任何错误。** 这是需求二最致命的坑，必须先修。

**处置（两条同时做）：**
1. **写入改为 `UPDATE` 既有行**（`patient_targets` 保持「每患者一行」语义，1:N 只在历史数据里存在；审计信息由 `prescriptions` 承担），不新增行。
2. **三处 `ORDER BY` 一并加固**为 `ORDER BY created_at DESC, rowid DESC`（幂等、不改语义、无歧义）。

### 🔴 F-2 · `patient_targets.basis` 已被登录页当作 JSON 消费，不能写入医生调整依据

原方案 §3.4 写「底部『调整依据』必填（写进 `basis`）」。

**实际：**
- 库里 3 行的 `basis` **都是 JSON 字符串**，形如
  `{"basis":"《中国老年高血压管理指南 2023》：…","controlTarget":"诊室血压 < 140/90 mmHg","demoThresholdNote":"…"}`
- `server/data/patientService.js:227-231` 用 `safeJson(tg?.basis, null)` 解析后取 `payload.controlTarget`
- 该值经 `listPatientEntries()` 输出为 `focus` 字段 → **登录页「一键进入示范病例」的「重点关注」文案**

**结论：把纯文本调整依据写进 `patient_targets.basis` 会让登录页重点关注文案变成 `null`。**

**处置：医生调整依据只写 `prescriptions.target_goals.basis`；`patient_targets.basis` 保持原值，一个字符都不动。**

### 🔴 F-3 · `prescriptions` 被 `HealthDataContext` / 健康建议页当作「健康处方」消费

**实际：**
- `src/contexts/HealthDataContext.jsx:365` `getActivePrescription = () => prescriptions.find((p) => p.is_active)`
- `:367` `getActivePrescriptions = () => prescriptions.filter((p) => p.is_active)`
- 消费方：`src/pages/PrescriptionPage.jsx:146,150,167`（健康建议页）、`src/pages/HomePage.jsx:276`
- 当前 `prescriptions` 表 0 行，两个消费方都走空数组，所以「现在没问题」

**结论：Phase 1 一旦把「任务覆盖包」写进 `prescriptions` 且 `is_active=1`，健康建议页会把覆盖包当成健康处方渲染。**

**处置：覆盖包 JSON 必须带 `kind` 字段；`getActivePrescription(s)` 必须按 `kind === 'task_override_package'` 过滤（**这是一处必须修改的既有业务文件**，原方案完全未提）。**

### F-4 · `prescriptions` 无唯一约束，「当前生效版本唯一」只能靠应用层保证

**实际 schema：**
```sql
CREATE TABLE IF NOT EXISTS prescriptions (
  prescription_id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  patient_id TEXT NOT NULL,
  exercise_plan TEXT, diet_plan TEXT, medication_reminders TEXT, target_goals TEXT,
  generated_date TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S','now','localtime')),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  doctor_modified INTEGER NOT NULL DEFAULT 0 CHECK (doctor_modified IN (0,1)),
  created_by TEXT NOT NULL DEFAULT 'agent' CHECK (created_by IN ('agent','doctor')),
  FOREIGN KEY (patient_id) REFERENCES patients(patient_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_prescriptions_patient_active ON prescriptions(patient_id, is_active);  -- 非唯一
```

- **没有** `updated_at` / `review_status` / `reviewed_by` / `reviewed_at`
- `generated_date` 是**唯一原生时间列**（由 DB 用 localtime 生成）
- `created_by` 只有 `('agent','doctor')` → 能表达「AI 出稿 / 医生调整」，但**表达不了「医生审核通过但未改动」与「医生亲自改」的区别**（需在 JSON 内用 `origin` + `reviewedBy` 区分）
- 索引非唯一 → **必须由写入函数在单事务内 `UPDATE is_active=0` + `INSERT is_active=1`**，DB 层无法兜底

### F-5 · `doctor_notes.doctor_id` 为 NOT NULL 且外键指向 `doctors` → **不适合承载 AI 提案**

**实际 schema：**
```sql
doctor_id TEXT NOT NULL,  -- FOREIGN KEY → doctors(doctor_id) ON DELETE CASCADE
note_type TEXT NOT NULL DEFAULT '建议' CHECK (note_type IN ('建议','警告','表扬','处方调整')),
```
- `doctor_id` **NOT NULL + 外键**：AI 提案发生时**还没有医生参与**，只能硬塞 `doc_li`，语义上是「这份提案是李医生写的」——**错误**。
- 无状态列、无 `updated_at`、`content` 是纯文本（塞 JSON 后 `is_read` 会被审核状态与「患者已读」两个语义争夺）

**结论：原方案决策点 D3 的选项 A（`doctor_notes` 加 3 列）方向应改。** 若确需 schema 变更，应加在 `prescriptions` 上，而非 `doctor_notes`。详见 §3。

### F-6 · 既有验收脚本有 4 条断言会被 Phase 1/2/3 打破（必须同步修订）

| 脚本 | 断言 | 冲突原因 |
|---|---|---|
| `verify-daily-tasks.mjs` | **21**「每个任务都带 `source=rule` 的确定性标记」`allTargets.every(t => t.source === 'rule')` | 若把被覆盖任务的 `source` 改成 `'doctor'` → 必挂 |
| 同上 | **22**「响应携带固定免责声明」`t1.json?.source === 'rule'` | 同上（响应级 source） |
| 同上 | **23**「步数目标 … `[8000, 10000].includes(stepsTask.target)`」 | 医生改成 6000 后 → 必挂 |
| `verify-step6.mjs` | **J3**「`medication_logs` / `doctor_notes` / `vision_records` / `prescriptions` / 血压·血糖明细 **均未灌**」逐表断言 `rows === 0` | Phase 1 写入 `prescriptions` + `doctor_notes` 后 → 必挂 |
| `verify-health-score.mjs` | **20**「首页评分与同源实现一致（界面 = 服务端 = 本地）」 | Phase 3 引入 AI 辅助分后需拆成两组断言 |

**处置：**
- **任务级 `source` 恒为 `'rule'`**（不因覆盖而改）—— 覆盖信息放在**新增的 `override` 子对象**里。这既保住断言 21/22，也正是「规则仍是唯一生成者」的正确表达。
- 断言 23 改为「`steps.target` 等于**生效覆盖值**（若存在）否则等于回退常量」，并新增一条「覆盖值确实生效」的正向断言。
- **J3 改口径**：从「运行时库必须 0 行」改为「**重放 seed 后的基线库**为 0 行」或「本脚本运行前后这些表未变化」。推荐前者（更符合 J1–J4 的本意：它们断言的是「P0 灌数阶段未灌这些表」，而非「运行时永不写入」）。
- 断言 20 拆为「Rule Score 三层同源」+「AI 辅助分满足确定性约束」。

### F-7 · 无模型环境下提案链路会完全失效（原方案漏项）

**实际：`server/index.js:416-426`**

```js
if (!modelReady()) {
  resolveFallback(`对话智能体「${agent.name}」`)
  const text = mockChat(agent.id, message, { executor, user: context.user || {} })
  for (const chunk of textChunks(text)) { … }
  sse.send({ type: 'chat_done', degraded: true })
  return                     // ← 完全绕过 runToolLoop
}
```

- `modelReady()` 只取决于是否配了 `DEEPSEEK_API_KEY`
- 降级分支**不走 `runToolLoop`**，因此任何「挂在模型工具调用上的提案机制」在无 Key 时**根本不会触发**

**结论：若把提案识别做成模型工具，则答辩环境（未配 Key 时）**整条联动链路演示不了**。**

**处置：提案识别做成**确定性通道**（关键词预筛 + 结构化抽取 + 后端注入 currentValue），**两条分支共用同一个落库函数**；有模型时模型仅用于增强 `reason` 的措辞。这也更贴合本项目「判定归确定性代码」的气质。

### F-8 · `/api/agent/chat` 无结构化事件通道，前端只处理 3 类事件

**实际：`src/contexts/AgentContext.jsx:229-243`** 的 `onEvent` 只处理 `token` / `tool_call` / `error`。
服务端 SSE 事件现有 5 类：`chat_start` / `token` / `tool_call` / `chat_done` / `error`（`server/index.js:414-465`）。
`ChatPanel.jsx` 内**不含任何 SSE 事件处理**（全部集中在 `AgentContext`）。

**处置：** 新增 `task_proposal` 事件 → 需在 `AgentContext.onEvent` 加分支，并让 `ChatPanel` 能渲染提案卡片（消息对象新增 `proposal` 字段）。

### F-9 · `buildDailyTasks()` 目前无覆盖入口；`getDailyTasks()` 只传 `steps`

**实际：**
- `dailyTasks.js:180-192` 签名：`{ date, diseases, primaryDisease, evaluation, bpReadings, bgReadings, medications, medicationLogs, weeklyCounts, targets, activity }` —— **无 `taskOverrides`**
- `patientService.js:1210` 只传 `targets: { steps: targetRow?.steps_target ?? null }` —— **除步数外，血压/血糖/运动的频次与时段没有任何数据入口**（全是 `DAILY_TASK_RULES` 常量硬编码）

**结论：原方案「Phase 1 才让这条链路第一次真正活起来」的判断成立，且覆盖层是唯一入口。**

### F-10 · 任务 `taskId` 实际枚举（Contract 必须以实际值为准）

`dailyTasks.js` 实际产出 7 类 taskId：

| taskId | 生成条件 | target 语义 | 第一版可否覆盖 |
|---|---|---|---|
| `bp_monitor` | 主诊断含「高血压」 | `slots.length`（派生） | ✅ 仅 `slots` |
| `bg_monitor` | 主诊断含「糖尿病」 | `slots.length`（派生） | ✅ 仅 `slots` |
| `weight_record` | 主诊断含「肥胖」 | 恒 `1`（`count: 1`） | ❌ 无可覆盖字段 |
| `exercise` | 存在任一慢病 | 恒定 `30`（可覆盖） | ✅ 仅 `target` |
| `steps` | **恒有** | `patient_targets.steps_target` ?? `8000` | ✅ 仅 `target` |
| `DEMO-LF-BP` / `DEMO-LF-BG` | 合并症低频关注项 | `perWeek`（单位「次/周」） | ❌ 语义不同，第一版不覆盖 |
| `med_{medicationId}_{HHmm}` | 用药计划按「一药一时段」拆分 | 恒 `1` | ❌ 属 `medications` 表职责，医生应改药计划 |

**关键推论：**
- 监测类任务的 `target` **恒等于 `slots.length`**（`dailyTasks.js:211, 247`）→ **「修改频次」= 修改 `slots` 数量**，`target` 不可独立覆盖（否则会出现「3 次但只有 2 个时段」的自相矛盾）。
- 服药任务与低频项**排除在覆盖范围外**，避免与 `medications` 表、与「次/周」语义打架。

### F-11 · 现有「添加备注」确认为假功能（与方案稿一致，此处确认）

`src/pages/DoctorPage.jsx:275-290`：`handleSaveNote` 只做 `setDoctorNotes([newNote, ...doctorNotes])` —— 纯 `useState` 内存态，提示「添加备注成功」，刷新即丢。`doctor_notes` 表**库里 0 行**，服务端**无任何读写接口**（全部路由已核对，医生端只有 `GET /api/doctors/:doctorId/patients` 一个）。

---

## 二、按评审要求修订后的最终架构

### 2.1 三块需求的定位（与总体原则一一对应）

| 需求 | 本质 | 边界的实现方式 |
|---|---|---|
| 医生改今日任务 | 给 `buildDailyTasks()` 加**参数覆盖层** | 规则仍先生成；覆盖只改已生成任务的参数；不新建任务域 |
| 对话提案 → 审核联动 | 生成一张**需要医生签字的申请单** | AI 只写「待审提案行」；唯一写覆盖包的路径是医生审核通过 |
| AI 参与评分 | 给 `computeDailyHealthScore()` 加**有限修正层** | AI 只输出 `adjustments`（结构化、有界）；最终分由确定性纯函数合成 |

### 2.2 分层与数据流（最终形态）

```
                            ┌──────────────────────────────────────────┐
  患者端                    │  src/utils/dailyTasks.js  buildDailyTasks │
  ─────────────             │  ★ 唯一任务生成者（纯函数，前后端共用）    │
  今日任务卡片  ◀────────────┤  规则产出 7 类任务，source 恒为 'rule'    │
                            └───────────────▲──────────────────────────┘
                                            │ 入参新增 taskOverrides（可选，已校验）
                                            │
        ┌───────────────────────────────────┴───────────────────────────┐
        │  生效覆盖包读取（唯一来源）                                     │
        │  prescriptions.target_goals  WHERE is_active=1 AND kind='task_override_package'
        │  排序：generated_date DESC, rowid DESC  → 生效版本唯一           │
        └───────────────────────────────────▲───────────────────────────┘
                                            │ 写（单事务）
                            ┌───────────────┴───────────────┐
                            │  唯一写入者：applyOverridePackage()  │
                            │  · UPDATE 旧版本 is_active=0         │
                            │  · INSERT 新版本 is_active=1         │
                            │  · 若含 steps → UPDATE patient_targets
                            │    （F-1：UPDATE，绝不 INSERT）      │
                            └───────────────▲───────────────┘
                                            │
                     ┌──────────────────────┴──────────────────────┐
                     │  两条入口，共用同一把尺子                     │
                     │  validateOverridePackage()  ← src/utils/…    │
                     ├──────────────────────────────────────────────┤
                     │ A. 医生端抽屉         PUT task-overrides      │
                     │    （原子校验：任一项非法 → 整包 400）         │
                     │ B. 医生审核提案       POST …/review           │
                     │    approve / modify（modify 重新校验）        │
                     └──────────────────────────────────────────────┘

  患者对话                      ┌──────────────────────────────────────┐
  ──────────                    │  proposalIntent.js                    │
  「我膝盖疼，                   │  ★ 确定性通道，不依赖模型可用性（F-7） │
   8000 步走不下来」 ──────────▶│  ① 关键词/正则预筛（零成本）           │
                                │  ② 命中 → 结构化抽取 taskId/field/value│
                                │  ③ currentValue ← 后端注入（忽略模型） │
                                │  ④ 阈值字段 / 主诊断停用 → 直接过滤     │
                                │  ⑤ 单轮 ≤2 条 + 去重 + 7 天有效        │
                                └──────────────▲───────────────────────┘
                                               │ INSERT（pending：is_active=0,
                                               │         created_by='agent', doctor_modified=0）
                                     ┌─────────┴─────────┐
                                     │ 无模型：mockChat   │ 两条分支
                                     │ 有模型：runToolLoop│ 共用落库函数
                                     └───────────────────┘

  医生端                        ┌──────────────────────────────────────┐
  ──────────                    │  待审核列表（轮询 15–30s + 角标）      │
  提案卡片 ────────────────────▶│  【同意】【修改后生效】【驳回】        │
                                └──────────────┬───────────────────────┘
                                               │
             approve / modify ─────────────────┤──────────────── reject
                                               │                    │
                          applyOverridePackage()│             仅：提案行
                          + 提案行 doctor_modified=1             doctor_modified=1
                          + doctor_notes 通知患者                + doctor_notes 含理由
                                               │                    │
                                               ▼                    ▼
                                    患者端任务变化            患者端任务 ★零变化★

  评分（Phase 3，与上面两块完全解耦）
  ────────────────────────────────────
  L1 Rule Score    computeDailyHealthScore()      ← 完全确定性，唯一正式分
  L2 AI Assessment 模型 → adjustments[]（无分数）  ← 生成式，可失败
  L3 合成          composeAssistedScore()         ← 纯函数 + 守恒校验
                    · 任一约束不满足 → 整包丢弃 → 回落 Rule Score
                    · 缓存键 patientId + date + inputHash
```

### 2.3 三道关口（缺一不可）

| 关口 | 位置 | 职责 |
|---|---|---|
| 关口 1 · 校验 | `src/utils/taskOverride.js` 的 `validateOverridePackage()` | 唯一尺子。字段白名单、数值范围、slots 枚举、taskId 白名单、`enabled=false` 硬拒 |
| 关口 2 · 应用 | `src/utils/dailyTasks.js` 的 `taskOverrides` 入参 | 只改参数，绝不增删任务域；`source` 不动；新增 `override` 回显 |
| 关口 3 · 写入 | `server/data/taskOverrideService.js` 的 `applyOverridePackage()` | 唯一写库函数。单事务、版本失效、`patient_targets` UPDATE、审计字段齐备 |

**AI 与前端都只能走到关口 1 之前**：AI 的提案要先过 `validateOverridePackage()` 才允许落库（不合法的**逐条过滤、不生成提案**）；医生审核 `modify` 时必须**重新过一遍关口 1**。前端只做体验级预校验，校验结果以后端为准。

---

## 三、D1–D8 最终建议（附修订理由）

| # | 决策 | **最终建议** | 相对原方案的修订 |
|---|---|---|---|
| **D1** | AI 评分路线 | **路线 B（有限调分），但表述重构为「三分层」** | ✅ 保留路线，**改动表述与验收**（详见 §4） |
| **D2** | 覆盖层落点 | **`prescriptions.target_goals` 承接完整覆盖包；`patient_targets.steps_target` 继续承接既有步数目标读取链路（改为 UPDATE）** | ✅ 落点不变，**补 Contract、补版本策略、补 F-1 处置、补 F-2 约束** |
| **D3** | 提案落点 | **首选 A′：仍用 `prescriptions`（同一张表，用 `kind` 区分 `task_proposal` 与 `task_override_package`），零 schema 变更** | ❌ **推翻原方案的「`doctor_notes` 加 3 列」**（理由 F-5：`doctor_id NOT NULL`）｜备选 B′ 见下 |
| **D4** | 能否停用主诊断监测项 | **第一版整体不接受 `enabled=false`**：主诊断监测项 → `E_PRIMARY_TASK_DISABLE_FORBIDDEN`；其余 → `E_DISABLE_NOT_SUPPORTED_IN_V1` | ❌ **推翻原方案的「允许 + 二次确认」**，改为硬拒绝 + 界面文案 |
| **D5** | 患者撤回提案 | 本轮不做 | 不变 |
| **D6** | 医生端实时性 | 基础版轮询（15–30s + 角标） | 不变 |
| **D7** | AI 评分是否落库 | 不落库，仅进程内当日缓存（与既有「`agent_runs` 不持久化」口径一致） | 不变 |
| **D8** | 顺带修「添加备注」假功能 | 修（写 `doctor_notes`，表结构已就绪） | 不变，但**须同步改 `verify-step6` J3 口径**（F-6） |

### D3 详解：`prescriptions` 能否干净承载 proposal？

**结论：能承载，干净度约 7/10。代价明确、可接受，且优于任何方案变体。**

**能力映射（`prescriptions` 原生列 → 四态）**

| 目标语义 | `is_active` | `created_by` | `doctor_modified` | `target_goals.kind` / `status` | 可查询性 |
|---|---|---|---|---|---|
| AI 提案待审 | `0` | `'agent'` | `0` | `task_proposal` / `pending_review` | ✅ 三列即可筛出 |
| AI 提案已驳回 | `0` | `'agent'` | `1` | `task_proposal` / `rejected` | ✅ 三列即可筛出 |
| 提案已过期 | `0` | `'agent'` | `0` | `task_proposal` / `pending_review` | ✅ 三列筛出 + `generated_date < now-7d` **懒判定，不写状态** |
| 当前生效覆盖包 | `1` | `'doctor'` | `1` | `task_override_package` / `active` | ✅ 索引 `(patient_id, is_active)` 直接命中 |
| 历史失效覆盖包 | `0` | `'doctor'` | `1` | `task_override_package` / `superseded` | ✅ 可查版本链 |

**待审列表查询（不需要解析 JSON）**

```sql
SELECT prescription_id, patient_id, target_goals, generated_date
  FROM prescriptions
 WHERE created_by = 'agent' AND is_active = 0 AND doctor_modified = 0
   AND kind  ← 需 JSON 判定，见下方代价
 ORDER BY generated_date DESC;
```

**⚠️ 代价（必须如实接受）**

1. **`kind` 只能存在 JSON 内** → 无法为「是提案还是覆盖包」建索引，也**无法纯 SQL 区分**。待审列表必须取出候选行后在应用层 `JSON.parse` 过滤 `kind`。在 3–5 位患者的演示规模下无所谓，但这是**明确的功能性代价**，不是「零成本」。
2. **「待审」与「已过期」在列上同形**，靠 `generated_date + 7 天` 懒判定区分（**好处**：无需写库改状态，过期自动生效；**代价**：没有「已过期」的历史留痕，只有读取时的计算结论）。
3. **无 `updated_at`**：审核时间只能记进 JSON（`reviewedAt`）。
4. **`prescriptions` 与医生无关联**：需经 `doctor_patient_relations` 解析出应审核的医生（当前演示只有 `doc_li`，成本为零）。
5. **与「健康处方」共享一张表** → **必须**同步修 `getActivePrescription(s)` 的 `kind` 过滤（F-3）。

**备选 B′（若你希望语义彻底干净，需 1 次 schema 变更）**

```sql
-- 仅作备选，本方案不执行
ALTER TABLE prescriptions ADD COLUMN review_status TEXT;   -- pending_review / approved / rejected / superseded / null
ALTER TABLE prescriptions ADD COLUMN reviewed_by   TEXT;   -- doctor_id
ALTER TABLE prescriptions ADD COLUMN reviewed_at   TEXT;   -- ISO 8601
CREATE UNIQUE INDEX IF NOT EXISTS uq_prescriptions_active
  ON prescriptions(patient_id) WHERE is_active = 1;         -- 生效版本唯一性由 DB 保证
```

**实施顺序建议：先按 A′（零变更）落地，把 `review_status` 作为「应用层计算得出的派生字段」暴露在 API 响应里。** 若日后需要按状态建索引 / 统计，再执行 B′ —— 届时 `review_status` 可由现有列一次性回填，**A′ 的写入完全向后兼容 B′**。这样既不阻塞实施，也不堵死后路。

**不推荐的方案变体：`doctor_notes` 加列（原 D3-A）** —— `doctor_id NOT NULL + FK` 使 AI 提案必须伪造医生身份，语义错误；且 `content` 塞 JSON 后 `is_read`（患者已读）与审核状态会互相争夺。

---

## 四、D1 修订详解：AI 评分的表述重构与验收重设计

### 4.1 术语三分（消除与「数值由确定性规则计算」的冲突）

| 术语 | 定义 | 谁产出 | 是否正式分 |
|---|---|---|---|
| **Rule Score** | 现行 `computeDailyHealthScore()` 输出 | 确定性纯函数 | ✅ **唯一正式健康评分** |
| **AI Assessment** | 模型输出的结构化 `adjustments[]` + `narrative` | 大模型 | ❌ 不是分数，是「意见」 |
| **AI-assisted Score** | `composeAssistedScore(ruleScore, adjustments)` 的合成结果 | 确定性纯函数 | ❌ **辅助显示项，永不由它驱动预警/等级/达标率** |

**红线转述（写进代码注释与 README）：**
> AI **永远不能直接输出 0–100 分**。它只能输出结构化 `adjustments`。最终合成必须由确定性纯函数完成；AI 辅助分**不是**临床判据，只用于向用户解释「规则分之外还看到了什么」。

### 4.2 AI Assessment 输出契约

```jsonc
{
  "adjustments": [
    { "dimension": "exercise",          // 必须 ∈ 该患者适用维度
      "delta": -3,                      // 整数，∈ [-5, +5]
      "reason": "连续 2 天运动后即刻血糖偏低" }   // 非空，去空白后长度 ∈ [1, 80]
  ],
  "narrative": "…",                     // 可选，纯解释，不参与计分
  "insights": ["…"]                     // 可选，纯解释，不参与计分
}
```

### 4.3 确定性校验（`validateAdjustments()`，任一不满足 → **整包丢弃**）

| # | 约束 | 不满足时 |
|---|---|---|
| 1 | `adjustments` 必须是数组且长度 ≤ 4 | 整包丢弃 |
| 2 | `dimension` ∈ `{steps, bloodPressure, bloodGlucose, exercise}` ∩ **该患者适用维度** | 整包丢弃 |
| 3 | 同一 `dimension` 不得重复出现（防「拆分规避 ±5」） | 整包丢弃 |
| 4 | `delta` 必须是整数且 ∈ `[-5, +5]` | 整包丢弃 |
| 5 | `reason` 非空、去空白后长度 ∈ `[1, 80]` | 整包丢弃 |
| 6 | `Σ\|delta\|` ≤ 10 | 整包丢弃 |

**不做部分采纳。** 理由：半截调整无法向用户解释「为什么这条生效那条没有」，且会让 UI 的「守恒」展示失真。

### 4.4 合成与守恒（`composeAssistedScore()`）

```
Σdelta      = Σ adjustments[].delta
rawAssisted = ruleScore + Σdelta
assisted    = clamp(rawAssisted, 0, 100)
clamped     = assisted !== rawAssisted
```

**守恒断言：`assisted - ruleScore === Σdelta`（当 `clamped === false`）。
当 `clamped === true` 时，守恒式不成立 —— 此时必须**如实报告**（`clamped: true` + `rawAssisted`），**不得静默**。**（这是原方案漏掉的一个边界：`rule=98, Σ=+10` → `assisted=100`，若机械断言守恒会误判为失败。）**

### 4.5 可复现性表述（替换原方案的 `temperature=0` 说法）

> **原表述（弃用）：**「`temperature=0` + 当日缓存 → 完全可复现」
> —— 不成立：`temperature=0` 在服务端批处理、模型版本更新、并发调度下均**不构成**严格的确定性保证。
>
> **新表述（采用）：**
> 「同一 `patientId` + 日期 + **相同输入快照**，在**缓存命中**时结果完全一致；
> 重新生成时模型输出理论上可能变化，但**必须始终满足确定性约束**（§4.3 六条 + §4.4 守恒），
> 且 `AI-assisted Score − Rule Score` 恒等于 `Σdelta`。」
>
> 配套：缓存键 = `patientId + date + inputHash`，`inputHash` = 当日体征 + 疾病谱 + Rule Score 的稳定哈希。
> **`inputHash` 变化即缓存失效** —— 避免「数据变了分数没变」的更难解释的状态。

### 4.6 降级（一律回落 Rule Score，`aiStatus = 'unavailable' | 'rejected'`）

| 触发 | `aiStatus` | 界面 |
|---|---|---|
| 模型未配置 / 调用失败 / 超时 | `unavailable` | 只显示 Rule Score + 「AI 解读暂不可用」 |
| JSON 解析失败（`safeParseJSON` 回落 `{text}` → 无 `adjustments`） | `unavailable` | 同上 |
| 结构不完整（无 `adjustments` 数组） | `unavailable` | 同上 |
| 任一条违反 §4.3 约束 | `rejected` | 只显示 Rule Score + 「AI 建议未通过校验，已忽略」（可展开看被拒原因） |

### 4.7 界面呈现（**必须明确区分 Rule Score 与 AI-assisted Score**）

```
   67                    ← 主数字 = Rule Score（唯一正式分）
  一般  [规则评分]         ← 档位 + 明确标签
────────────────────────────────
  AI 辅助分  64  [AI 辅助]  ← 次级数字 + 明确标签，不抢主视觉
   · 运动   −3  连续 2 天运动后即刻血糖偏低
   · 步数   +0  （无调整）
  规则基线 67 · AI 调整 −3
────────────────────────────────
  ★ 步数        30/30   优秀
    血压         0/25   今日未记录
    血糖        25/25
    运动        17/20
  未录入：血压（按 0 分计入满分 75 分）
   [!] AI 辅助分由模型提出意见、确定性代码合成，不是临床判据，也不参与预警分级。
```

**规则：**
- **主数字永远是 Rule Score**（与晨报口播、与 `verify-health-score` 的既有断言一致）。
- AI 辅助分必须带 `[AI 辅助]` 标签 + 免责脚注。
- 任何被调整的维度必须显示 `delta` 与 `reason`，不做黑箱。
- AI 不可用 → 只显示 Rule Score，**不显示 AI 分**。

---

## 五、Task Override JSON Contract v1（正式契约）

### 5.1 生效覆盖包 · `prescriptions.target_goals`

```jsonc
{
  "kind": "task_override_package",        // 必填，常量
  "contractVersion": 1,                   // 必填，整数；未知版本 → 后端拒读并告警

  "status": "active",                     // active | superseded
  "origin": "doctor",                     // agent | doctor（谁是初稿来源）
  "reviewedBy": "doc_li",                 // 审核医生；医生自建时 = 操作医生
  "reviewedAt": "2026-09-16T10:12:00",    // ISO 8601
  "basis": "患者主诉膝关节疼痛，近 7 日步数 3,000–4,000",   // 必填，长度 [4, 200]
  "sourceUtterance": "我膝盖疼，8000 步走不下来",            // 可空：若源自对话提案
  "supersedes": "9f3c…",                  // 可空：被本版本取代的 prescription_id
  "createdAt": "2026-09-16T10:12:00",

  "overrides": {                          // 键必须是合法 taskId；值只含白名单 field
    "steps":      { "target": 6000, "basis": "膝关节不适，先降至 6000 步" },
    "exercise":   { "target": 20 },
    "bp_monitor": { "slots": ["晨起", "睡前"] }
  }
}
```

### 5.2 提案 · `prescriptions.target_goals`

```jsonc
{
  "kind": "task_proposal",
  "contractVersion": 1,

  "status": "pending_review",             // pending_review | rejected
                                          //   过期由 generated_date + 7d 懒判定（不写状态）
  "origin": "agent",
  "agentId": "planner",                   // 提交提案的智能体
  "patientId": "patient_1",
  "utterance": "我膝盖疼，8000 步走不下来",  // 患者原话（长度 ≤ 200，超出截断）
  "confidence": 0.8,                      // 可选，仅记录，不参与任何判定

  "proposals": [                          // 长度 ∈ [1, 2]
    {
      "proposalId": "prop_1",
      "taskId": "steps",
      "field": "target",
      "currentValue": 8000,               // ★ 后端注入；模型返回值一律忽略
      "currentValueSource": "effective_task_state",   // 固定值，表明来源可信
      "proposedValue": 5000,
      "reason": "患者自述膝关节疼痛，近 7 日实际步数 3,000–4,000",
      "evidence": ["患者原话：我膝盖疼，8000 步走不下来", "近 7 日步数均值 3,500"]
    }
  ],

  "createdAt": "2026-09-16T09:40:00",
  "expiresAt": "2026-09-23T09:40:00",     // = createdAt + 7 天

  "reviewedBy": null,                     // 审核后填 doc_li
  "reviewedAt": null,
  "reviewReason": null,                   // reject 时必填，长度 [4, 200]
  "resultingPrescriptionId": null         // approve / modify 时填新覆盖包的 prescription_id
}
```

### 5.3 `taskId` 枚举（第一版）

| taskId | 是否可覆盖 | 允许 field | 说明 |
|---|---|---|---|
| `steps` | ✅ | `target` | 恒存在的通用任务 |
| `exercise` | ✅ | `target` | 存在慢病时生成 |
| `bp_monitor` | ✅ | `slots` | 主诊断含「高血压」时生成 |
| `bg_monitor` | ✅ | `slots` | 主诊断含「糖尿病」时生成 |
| `weight_record` | ❌ | — | target 恒 1，无有意义的覆盖维度 |
| `DEMO-LF-BP` / `DEMO-LF-BG` | ❌ | — | 单位是「次/周」，与「次/日」语义不同 |
| `med_*`（动态） | ❌ | — | 属 `medications` 表职责，医生应改用药计划 |

**额外硬约束：** 覆盖的 `taskId` 必须是**该患者当日规则实际生成的任务**。对李秀英（糖尿病）提交 `bp_monitor` 覆盖 → `E_TASK_NOT_GENERATED_FOR_PATIENT`（这直接落实「医生不能创造规则不存在的任务域」）。

### 5.4 `field` 枚举与取值规则

| taskId | field | 类型 | 范围 / 枚举 | 可 null | 非法时错误码 |
|---|---|---|---|---|---|
| `steps` | `target` | integer | `[1000, 20000]`，且为 **500 的整数倍** | 否 | `E_TARGET_OUT_OF_RANGE` / `E_TARGET_NOT_MULTIPLE_OF_500` |
| `exercise` | `target` | integer | `[5, 180]`（分钟） | 否 | `E_TARGET_OUT_OF_RANGE` |
| `bp_monitor` | `slots` | string[] | ⊆ `['晨起','上午','下午','睡前']`，**非空、无重复** | 否 | `E_SLOTS_INVALID` |
| `bg_monitor` | `slots` | string[] | ⊆ `['空腹','餐后2h','随机','睡前']`，**非空、无重复** | 否 | `E_SLOTS_INVALID` |
| 任意 | `enabled` | boolean | **第一版只接受 `true`（no-op）** | 否 | 见 §5.5 |
| 任意 | 其它任何字段名 | — | — | — | `E_UNKNOWN_FIELD` |

**枚举来源（必须与数据库 CHECK 对齐，不得自造）：**
- `bp_monitor.slots` → `dailyTasks.js` 的 `BP_SLOT_OPTIONS`（与 `blood_pressure_readings.slot` 的 `CHECK` 严格一致）
- `bg_monitor.slots` → `dailyTasks.js` 的 `GLUCOSE_MEASURE_TYPES`（与 `blood_glucose_readings.measure_type` 的 `CHECK` 严格一致）
- 展示层「午后」← 落库值「下午」的映射沿用 `SLOT_LABEL_ZH`（**只此一处定义，禁止各处拼字**）

**阈值类字段一律拒绝（`E_THRESHOLD_FIELD_FORBIDDEN`）：**
黑名单（不限于此，白名单之外一律拒绝）：

```
systolic_target  diastolic_target  fasting_glucose_target  hba1c_target
bmi_target  waist_target  weight_change_target  demoThreshold  阈值  阈值*
```

**关键区分（必须写进 Contract 注释）：**
> `steps.target` 与 `exercise.target` 是**行为目标**（走多少步 / 动多少分钟），**不是医学阈值**，允许覆盖。
> 血压 / 血糖的**控制目标数值**（`systolic_target` 等）以及 `140/90`、`7.0`、`7.8` 这些判定阈值属 `clinicalRules` 与 `patient_targets`，**AI 与医生覆盖层都不得触碰**。

### 5.5 `enabled` 的第一版口径（D4 落实）

**第一版整体不接受 `enabled: false`：**

| 场景 | 后端行为 | 错误码 | AI 侧 | 医生端界面 |
|---|---|---|---|---|
| 主诊断监测项 `enabled=false` | **硬拒绝（整包 400）** | `E_PRIMARY_TASK_DISABLE_FORBIDDEN` | **直接过滤，不生成提案** | 禁用开关，显示文案：**「当前版本不允许停用主诊断监测项」** |
| 非主诊断监测项 `enabled=false` | **硬拒绝（整包 400）** | `E_DISABLE_NOT_SUPPORTED_IN_V1` | 直接过滤 | 禁用开关，显示文案：**「当前版本不支持停用任务」** |
| `enabled: true` | 视为 no-op（等价于不传） | — | — | — |

「主诊断监测项」判定（**由后端依据疾病谱与当日生成结果推导，不由前端或 AI 声明**）：

```
主诊断含「高血压」 → bp_monitor 是主诊断监测项
主诊断含「糖尿病」 → bg_monitor 是主诊断监测项
主诊断含「肥胖」   → weight_record 是主诊断监测项
```

> **注意：`enabled` 字段在 Contract 中保留**（结构稳定），只是第一版校验值时恒拒 `false`。
> 未来放开「允许停用」只需收紧白名单判断，**写入记录与 API 形状无需变更**。

### 5.6 未知输入的处理（**必须区分医生端与 AI 侧**）

| 输入 | 医生端 API | AI 提案 |
|---|---|---|
| 未知 `taskId`（不在枚举内） | **整包 400** `E_UNKNOWN_TASK_ID` | **该条不生成提案**，计入 `filtered` 统计 |
| 枚举内但当日未生成 | **整包 400** `E_TASK_NOT_GENERATED_FOR_PATIENT` | 该条不生成提案 |
| 未知 `field` | **整包 400** `E_UNKNOWN_FIELD` | 该条不生成提案 |
| 阈值类字段 | **整包 400** `E_THRESHOLD_FIELD_FORBIDDEN` | 该条不生成提案 |
| 范围越界 / 枚举非法 | **整包 400** | 该条不生成提案 |

**「宁可报错，不要静默忽略」** —— 医生端必须原子拒绝：静默忽略会让医生以为改成功（`F-1` 就是同一类问题的另一种形态）。

### 5.7 前端与 AI 均不能绕过后端 validation（落实方式）

1. 校验函数 `validateOverridePackage()` 位于 `src/utils/taskOverride.js`，**前后端共用同一份实现**（与 `clinicalRules.js` / `dailyTasks.js` / `healthScore.js` 同构）。
2. 前端调用它做**体验级预校验**（即时提示、禁用非法选项），**不作为准入依据**。
3. 后端在 `PUT task-overrides` 与 `POST …/review（modify）` 中**无条件重新校验**。
4. AI 侧在 `proposalIntent.js` 中调用**同一个函数**做逐条过滤。
5. 验收脚本**绕过前端直接打 API** 提交非法值，断言仍为 400（`verify-doctor-task-override` 第 14 条）。

### 5.8 版本策略

| 规则 | 实现 |
|---|---|
| 新医生调整创建**新 prescription 版本** | `INSERT INTO prescriptions (…, is_active=1, doctor_modified=1, created_by='doctor')` |
| 旧版本失效 | 同事务内 `UPDATE prescriptions SET is_active=0 WHERE patient_id=? AND is_active=1` |
| **当前生效版本唯一** | 应用层单事务保证；读取 `ORDER BY generated_date DESC, rowid DESC LIMIT 1` 兜底**（原方案未给兜底）** |
| 审计信息保留 | `created_by` + `doctor_modified` + `generated_date`（原生）+ `target_goals.reviewedBy/reviewedAt/origin/basis/supersedes`（JSON） |
| 版本链 | 新版本的 `supersedes` 指向被取代的 `prescription_id`，可追溯完整链路 |
| 步数目标同步 | 同事务内 `UPDATE patient_targets SET steps_target=?, set_by=?`（**UPDATE，绝不 INSERT** —— F-1） |

---

## 六、统一 AI Proposal 安全边界（12 条，全部落到代码位置）

| # | 边界 | 实施位置 |
|---|---|---|
| 1 | AI 永远不能直接写 task override | 唯一写库函数 `applyOverridePackage()` **不被 `proposalIntent.js` 引用**；提案只写 `is_active=0` 的提案行 |
| 2 | `currentValue` 必须由后端注入 | `getEffectiveTaskState(patientId, date)` → 复用 `getDailyTasks()` 的内部结果 |
| 3 | 模型返回的 `currentValue` 一律忽略 | `proposalIntent.js` 只读模型的 `taskId/field/proposedValue/reason`，其余字段**丢弃** |
| 4 | AI 只能提出 `target` / `slots` / `enabled` | `field` 白名单，越界 → 该条不生成 |
| 5 | 阈值类字段全部过滤 | 白名单之外一律过滤（§5.4 黑名单） |
| 6 | 单轮最多 2 条 proposal | `proposals.slice(0, 2)`，超出计入 `filtered` |
| 7 | 同 `patient + taskId + field` 已有 pending → **更新而非新建** | `UPDATE` 该提案行的 `target_goals.proposals[0].proposedValue/reason` + 刷新 `generated_date`（**行数不变**） |
| 8 | proposal 7 天过期 | 读取时懒判定 `generated_date + 7d < now` → 归为 expired；**不写库** |
| 9 | 医生 approve 前，患者端任务完全不变 | 提案行 `is_active=0`，**不参与** `getDailyTasks()` 的覆盖读取 → 天然零影响 |
| 10 | approve 后才写入覆盖层 | `review()` → `applyOverridePackage()` |
| 11 | modify 必须经过同样的后端 validation | `review()` 内 `validateOverridePackage()` 重新执行，与 `PUT` 完全同一调用 |
| 12 | reject 不得改变患者任务 | `reject` 分支**只 UPDATE 提案行**，不触碰生效覆盖包、不触碰 `patient_targets` |

---

## 七、Phase 顺序与代码依赖复核

| Phase | 内容 | 代码依赖 | 是否可独立交付 |
|---|---|---|---|
| **Phase 1** | 医生修改今日任务（含修假备注、含 F-1/F-2/F-3 三处隐患处置） | `dailyTasks.js`（加 `taskOverrides`）· `taskOverride.js`（新）· `patientService.getDailyTasks` · `patient_targets` 三处排序加固 · `taskOverrideService.js`（新）· `doctorNoteService.js`（新）· `DoctorPage.jsx` · `HealthDataContext.getActivePrescription` 过滤 · `verify-daily-tasks` 23 号断言 · `verify-step6` J3 口径 | ✅ **是** |
| **Phase 2** | AI 对话提案 → 医生审核联动 | **强依赖 Phase 1**：<br>· `currentValue` ← Phase 1 的 `getEffectiveTaskState()`<br>· 合法性 ← Phase 1 的 `validateOverridePackage()`<br>· 落地 ← Phase 1 的 `applyOverridePackage()`<br>另需：`proposalIntent.js`（新，确定性通道）· `proposalService.js`（新）· `/api/agent/chat` 事件 · `AgentContext` 分支 · `ChatPanel` 卡片 · `DoctorPage` 待审核 Tab | ❌ 依赖 Phase 1 |
| **Phase 3** | AI-assisted Score | 与 Phase 1/2 **完全解耦**：仅新增 `aiScore.js`（纯函数）+ `aiScoreService.js` + 路由 + 评分卡 UI + 修订 `verify-health-score` 20 号断言 | ✅ 可任意顺序 |

**Phase 2 必须依赖 Phase 1 的 override mechanism —— 复核结论：成立，且依赖比原方案写的更深。** 原方案只说了「落点依赖」，实际上 Phase 2 还依赖 Phase 1 的**读取器**（`getEffectiveTaskState`）与**校验器**（`validateOverridePackage`）—— 三处复用点少一处，Phase 2 就会另写一套口径，直接违背「同一把尺子」的原则。

**⚠️ Phase 2 的额外前置（原方案漏项，F-7）：** 提案通道必须做成**确定性通道**，与模型可用性解耦，否则无 Key 环境下无法演示。

**推荐实施顺序：1 → 2 → 3。**

---

## 八、需要新增 / 修改的文件清单

### 8.1 新增（14 个）

| 文件 | Phase | 职责 |
|---|---|---|
| `src/utils/taskOverride.js` | 1 | **Contract 唯一实现**：`TASK_OVERRIDE_CONTRACT` / `validateOverridePackage()` / `applyTaskOverrides()` / `readEffectiveOverrides()`（纯函数，前后端共用） |
| `src/utils/aiScore.js` | 3 | `validateAdjustments()` / `composeAssistedScore()` / `AI_SCORE_CONSTRAINTS`（纯函数） |
| `server/data/taskOverrideService.js` | 1 | `applyOverridePackage()`（**唯一写库函数**，单事务）/ `readActiveOverridePackage()` / `revokeOverride()` / `getEffectiveTaskState()` |
| `server/data/doctorNoteService.js` | 1 | `doctor_notes` 真落库（`createDoctorNote` / `listPatientNotes` / `markNoteRead`），与 `alertService.js` 同构 |
| `server/data/proposalService.js` | 2 | 提案落库 / 去重 / 懒过期 / 审核流转（`createOrUpdateProposal` / `listProposals` / `reviewProposal`） |
| `server/agents/proposalIntent.js` | 2 | **确定性意图通道**：关键词预筛 → 结构化抽取 → 后端注入 `currentValue` → 过滤 → 落库调用 |
| `server/data/aiScoreService.js` | 3 | 模型调用 + `inputHash` 缓存 + 降级 |
| `src/services/doctorApi.js` | 1 | 医生端 API 客户端（与 `patientApi.js` / `agentApi.js` 同构） |
| `src/components/Doctor/TaskOverrideDrawer.jsx` | 1 | 「今日任务」抽屉：任务实况 + 可编辑项 + diff 二次确认 + 依据必填 |
| `src/components/Doctor/ProposalReviewList.jsx` | 2 | 「待审核」列表 + 同意/修改/驳回 |
| `src/components/Agent/TaskProposalCard.jsx` | 2 | 患者端对话内「已提交医生审核」卡片 |
| `scripts/db/verify-doctor-task-override.mjs` | 1 | 见 §9 |
| `scripts/db/verify-task-proposal.mjs` | 2 | 见 §9 |
| `scripts/db/verify-ai-score.mjs` | 3 | 见 §9 |

### 8.2 修改（12 个）

| 文件 | Phase | 改动 |
|---|---|---|
| `src/utils/dailyTasks.js` | 1 | 新增可选入参 `taskOverrides = {}`；应用覆盖时**只改 `target`/`slots`**；**`source` 恒为 `'rule'`**；新增 `override` 回显子对象（`{applied, by, at, basis, fields[]}`） |
| `server/data/patientService.js` | 1 | `getDailyTasks()`：读取生效覆盖包 + 下传 `taskOverrides` + `patient_targets` 排序加固 + 报告「生效值/原始值」双值；新增 `getEffectiveTaskState()` |
| `server/data/dataProvider.js` | 1 | **两处** `ORDER BY COALESCE(effective_from, '')` → `ORDER BY created_at DESC, rowid DESC`（`:376`、`:609`） |
| `server/index.js` | 1/2/3 | 新增医生端 / 提案 / 评分路由；`/api/agent/chat` 挂提案通道 + 新增 SSE `task_proposal` 事件 |
| `src/contexts/HealthDataContext.jsx` | 1 | `getActivePrescription(s)` 按 `kind` 过滤（F-3） |
| `src/pages/DoctorPage.jsx` | 1/2 | 新增「今日任务」按钮 + 抽屉；新「待审核」Tab + 角标；**把假备注改为真落库** |
| `src/pages/HomePage.jsx` | 1 | 任务卡显示「医生已调整」徽标 + 依据 |
| `src/contexts/AgentContext.jsx` | 2 | `onEvent` 新增 `task_proposal` 分支 |
| `src/components/Agent/ChatPanel.jsx` | 2 | 渲染提案卡片 |
| `scripts/db/verify-daily-tasks.mjs` | 1 | 修订 **23** 号断言（步数目标允许等于生效覆盖值）+ 新增「覆盖值确实生效」正向断言；**21/22 号因 `source` 不变而无需改** |
| `scripts/db/verify-step6.mjs` | 1 | 修订 **J3** 口径（改为「重放 seed 后的基线库为 0 行」或「运行前后未变化」） |
| `scripts/db/verify-health-score.mjs` | 3 | 修订 **20** 号断言 → 拆成「Rule Score 三层同源」+「AI 辅助分满足约束」 |
| `README.md` | 1/2/3 | 同步架构、Contract、验收清单、AI 评分表述（禁用 `temperature=0` 保证可复现的说法） |

**⚠️ 明确不改：**
`src/utils/clinicalRules.js`（零改动）· `src/database/schema.sql`（零改动）· `server/agents/registry.js` 的 6 个 systemPrompt（如需给 planner 补一句「可提任务调整申请」，属文案微调，非结构变更）

---

## 九、API 清单

### 9.1 患者侧

| 方法 | 路径 | Phase | 说明 |
|---|---|---|---|
| GET | `/api/patients/:patientId/daily-tasks` | 1 | **既有**。响应新增：每个 task 的 `override` 子对象；顶层新增 `taskOverrides`（当前生效覆盖包，供 UI 展示「依据」） |
| GET | `/api/patients/:patientId/doctor-notes?unread=1` | 1 | **新**。患者端读医生建议/调整通知 |
| POST | `/api/patients/:patientId/doctor-notes/:noteId/read` | 1 | **新**。标记已读 |
| POST | `/api/agent/chat` | 2 | **既有**。SSE 新增事件 `task_proposal`（在 `chat_done` 之前推送） |
| POST | `/api/agent/score` | 3 | **新**。body `{patientId}` → `{rule, ai, aiStatus, cached, generatedAt}` |
| GET | `/api/patients/:patientId/score` | 3 | **新**。读当日缓存；无缓存只返回 `rule` |

### 9.2 医生侧

| 方法 | 路径 | Phase | 说明 |
|---|---|---|---|
| GET | `/api/doctors/:doctorId/patients` | 1 | **既有**。响应新增 `pendingProposalCount`（角标） |
| GET | `/api/doctors/:doctorId/patients/:patientId/tasks` | 1 | **新**。当日任务实况（含进度）+ 当前生效覆盖包 + **可覆盖字段字典**（枚举/范围，供 UI 渲染合法选项，避免前后端各写一套） |
| PUT | `/api/doctors/:doctorId/patients/:patientId/task-overrides` | 1 | **新**。body `{overrides, basis}`。原子校验 → 单事务落库。用 `PUT` 表达「替换当前生效覆盖包」 |
| DELETE | `/api/doctors/:doctorId/patients/:patientId/task-overrides/:taskId` | 1 | **新**。撤销某任务域覆盖（回落规则值） |
| POST | `/api/doctors/:doctorId/patients/:patientId/notes` | 1 | **新**。把「添加备注」改成真落库 |
| GET | `/api/doctors/:doctorId/task-proposals?status=pending\|reviewed\|all&patientId=` | 2 | **新** |
| POST | `/api/doctors/:doctorId/task-proposals/:proposalId/review` | 2 | **新**。body `{decision:'approve'\|'modify'\|'reject', overrides?, reason?}` |

**错误码总表**

| 错误码 | HTTP | 触发 |
|---|---|---|
| `E_UNKNOWN_TASK_ID` | 400 | taskId 不在枚举内 |
| `E_TASK_NOT_OVERRIDABLE` | 400 | 枚举内但第一版不支持（`weight_record` / `DEMO-LF-*` / `med_*`） |
| `E_TASK_NOT_GENERATED_FOR_PATIENT` | 400 | 该患者当日规则未生成此任务 |
| `E_UNKNOWN_FIELD` | 400 | field 不在白名单 |
| `E_THRESHOLD_FIELD_FORBIDDEN` | 400 | 试图覆盖医学阈值 |
| `E_TARGET_OUT_OF_RANGE` | 400 | 数值越界 |
| `E_TARGET_NOT_MULTIPLE_OF_500` | 400 | 步数非 500 倍数 |
| `E_SLOTS_INVALID` | 400 | slots 空/含非法枚举/重复 |
| `E_PRIMARY_TASK_DISABLE_FORBIDDEN` | 400 | 停用主诊断监测项（D4） |
| `E_DISABLE_NOT_SUPPORTED_IN_V1` | 400 | 第一版不支持停用 |
| `E_BASIS_REQUIRED` | 400 | `basis` 缺失或过短 |
| `E_CONTRACT_VERSION_UNSUPPORTED` | 409 | `contractVersion` 未知 |
| `E_PROPOSAL_NOT_FOUND` / `E_PROPOSAL_ALREADY_REVIEWED` | 404 / 409 | 提案不存在 / 已审结 |
| `E_PROPOSAL_EXPIRED` | 409 | 提案已过 7 天 |

---

## 十、数据库使用方式（零 schema 变更）

### 10.1 读写路径总表

| 用途 | 表 | 操作 | 语句要点 |
|---|---|---|---|
| 读生效覆盖包 | `prescriptions` | SELECT | `WHERE patient_id=? AND is_active=1 AND target_goals LIKE '%"kind":"task_override_package"%' ORDER BY generated_date DESC, rowid DESC LIMIT 1`（`LIKE` 仅为减少解析量，最终判定仍在应用层 `JSON.parse`） |
| 写覆盖包（新版本） | `prescriptions` | UPDATE + INSERT（单事务） | `UPDATE SET is_active=0 WHERE patient_id=? AND is_active=1` → `INSERT (…, is_active=1, doctor_modified=1, created_by='doctor')` |
| 读待审提案 | `prescriptions` | SELECT | `WHERE created_by='agent' AND is_active=0 AND doctor_modified=0` → 应用层按 `kind` 过滤 + `generated_date+7d` 懒判过期 |
| 写提案 | `prescriptions` | INSERT | `created_by='agent', is_active=0, doctor_modified=0` |
| 去重更新提案 | `prescriptions` | UPDATE | 命中同 `patient+taskId+field` 的 pending 行 → 更新 `target_goals.proposals` + `generated_date` |
| 审核审结 | `prescriptions` | UPDATE | `SET doctor_modified=1`；`target_goals` 内记 `reviewedBy/reviewedAt/reviewReason/resultingPrescriptionId` |
| 步数目标（既有链路） | `patient_targets` | **UPDATE** | `UPDATE patient_targets SET steps_target=?, set_by=? WHERE target_id=?`（**F-1：绝不 INSERT 新行**；若该患者原本 0 行才 INSERT） |
| 读步数目标 | `patient_targets` | SELECT | `ORDER BY created_at DESC, rowid DESC LIMIT 1`（**加固后的排序**） |
| 医生建议/通知 | `doctor_notes` | INSERT / SELECT / UPDATE | 真落库（D8）；`note_type='建议'` 或 `'处方调整'`，`source='doctor'` |
| 医生-患者归属 | `doctor_patient_relations` | SELECT | 解析提案应由哪位医生审核 |
| 审核人签名 | `doctors` | SELECT | `name / title / department` → 患者端展示「李医生 · 主任医师 · 全科」 |

### 10.2 数据契约标识（沿用既有红线，不得改名）

| 标识 | 值 | 原因 |
|---|---|---|
| 表名 | `prescriptions` | 既有 |
| 列名 | `target_goals` / `is_active` / `doctor_modified` / `created_by` | 既有 |
| JSON 判别字段 | `kind` | 新增，用于区分提案与覆盖包（F-3） |
| `note_type` 枚举 | `'建议'`（界面文案「建议」） | 红线：枚举不得因文案调整而改名 |
| 界面文案 | 统一用「**建议**」，不出现「处方调整」字样 | 2026-09 起的既定文案口径 |

### 10.3 明确不写、不改的表

| 表 | 处置 |
|---|---|
| `clinicalRules` 相关阈值 | **零改动**（代码常量，非表） |
| `alerts` | Phase 1/2/3 均**不新增写入**（沿用既有 `persistRuleAlerts` 单一写入方） |
| `daily_health_records` / `*_readings` / `medication_logs` | **零改动**（事实层不参与覆盖；今日任务进度仍由此实时派生） |
| `agent_runs` | **仍不持久化**（D7；与既有 J2 断言一致） |
| `reminders` | 本轮不涉及 |
| 22 张表 | **不新建、不删列、不加列**（D3 选 A′） |

---

## 十一、验收脚本清单

### 11.1 `verify-doctor-task-override.mjs`（新，Phase 1，后端 + 浏览器）

| # | 断言 |
|---|---|
| 1 | 基线：改前 `GET /daily-tasks` 的 `steps.target === 8000`（回退常量） |
| 2 | `PUT task-overrides {steps:{target:6000}, basis:"…"}` → 200 |
| 3 | **`GET /daily-tasks` 的 `steps.target === 6000`** ← **直接锁死 F-1 隐患** |
| 4 | 覆盖不影响进度口径：`done` 仍为封顶值、`actualCount` 仍为真实值 |
| 5 | 改 `exercise.target = 20` → 患者端 `exercise.target === 20` |
| 6 | 改 `bp_monitor.slots = ['晨起','睡前']` → `target === 2`，slots 标签 `'晨起,睡前'` |
| 7 | 改 `bp_monitor.slots` 为 3 项 → `target === 3`（**验证「修改频次」**） |
| 8 | `steps.target = 999999` → 400 `E_TARGET_OUT_OF_RANGE` |
| 9 | `steps.target = 5500` → 400 `E_TARGET_NOT_MULTIPLE_OF_500` |
| 10 | 未知 taskId `foo` → 400 `E_UNKNOWN_TASK_ID` |
| 11 | 未知/阈值 field `systolic_target` → 400 `E_THRESHOLD_FIELD_FORBIDDEN` |
| 12 | 对李秀英提交 `bp_monitor`（当日未生成）→ 400 `E_TASK_NOT_GENERATED_FOR_PATIENT` |
| 13 | 主诊断监测项 `enabled=false` → 400 `E_PRIMARY_TASK_DISABLE_FORBIDDEN`；非主诊断 → `E_DISABLE_NOT_SUPPORTED_IN_V1` |
| 14 | **绕过前端直接打 API** 带非法值 → 仍 400（后端是唯一裁定者） |
| 15 | 覆盖块含 `setBy` / `basis` / `createdAt`（审计齐备） |
| 16 | 第二次 PUT → 旧行 `is_active=0`、新行 `is_active=1`，**生效行唯一**（`SELECT COUNT(*) WHERE is_active=1` === 1） |
| 17 | `DELETE` 撤销后患者端回落 `8000` |
| 18 | **规则仍是唯一生成者**：全部任务 `source === 'rule'`；`taskId` 集合与未覆盖时**完全一致**（不得出现新任务域） |
| 19 | 医学阈值未被动过：`patient_targets.systolic_target / diastolic_target / fasting_glucose_target` 覆盖前后逐列相等；`patient_targets.basis` **一字未变**（**锁死 F-2**） |
| 20 | 版本链：新行 `supersedes` === 旧行 `prescription_id` |
| 21 | 真实浏览器：医生端抽屉改值 → 显示 diff 二次确认 → 患者端任务卡出现「医生已调整」+ 依据文案 |
| 22 | 患者端健康建议页**未把覆盖包渲染成处方**（**锁死 F-3**） |

### 11.2 `verify-task-proposal.mjs`（新，Phase 2，后端 + 真实对话 + 浏览器）

| # | 断言 |
|---|---|
| 1 | 基线：记录患者端 `daily-tasks` 快照（`steps.target` + 全部 `taskId`） |
| 2 | 无 pending 时 `GET /task-proposals?status=pending` 为空 |
| 3 | 走真实 `/api/agent/chat`（`agentId='planner'`）说「我膝盖疼，8000 步走不下来」→ SSE 收到 `task_proposal` 事件，`status='pending_review'` |
| 4 | **★ 此时患者端 `daily-tasks` 与基线完全一致（零变化）** ← 全项目最重要的一条 |
| 5 | `currentValue === 8000`，且等于后端 `getEffectiveTaskState()` 的值 |
| 6 | **AI 无法伪造 `currentValue`**：构造模型返回含 `currentValue: 1` → 落库仍为 `8000` |
| 7 | 阈值类提案被过滤：说「把血压目标改成 160」→ `proposals` 为空（`filtered` 计数 +1） |
| 8 | 主诊断监测 `enabled=false` 被拒绝：说「我不想测血压了」（张建国）→ 不产生提案 |
| 9 | 单轮最多 2 条：构造 3 条诉求 → 落库提案 `proposals.length ≤ 2` |
| 10 | pending 去重：同 `patient+taskId+field` 再提一次 → **提案行数不变**，`proposedValue` 已更新 |
| 11 | 7 天过期：副本库直改该行 `generated_date` 回拨 8 天 → pending 列表不含它，且被标 `expired` |
| 12 | `approve` → 患者端 `steps.target` === `proposedValue`；提案行 `doctor_modified=1`；`resultingPrescriptionId` 非空 |
| 13 | `reject` → **患者端任务零变化** + 提案行 `status='rejected'` + 患者端收到 `doctor_notes`（含理由） |
| 14 | `modify`（医生改成 7000）→ 患者端 `steps.target === 7000`（**不是** 5000 —— 验证「按医生修改后的值生效」） |
| 15 | `modify` 走同一把尺子：医生提交越界值 → 400，患者端任务不变 |
| 16 | 医生端 `pendingProposalCount` === pending 行数 |
| 17 | **降级模式（`ALLOW_MOCK_FALLBACK=true` 且无 Key）提案通道仍能产出提案** ← **锁死 F-7** |
| 18 | 真实浏览器：ChatPanel 出现「已提交医生审核」卡片；医生端「待审核」Tab 角标正确 |
| 19 | 收尾清理：按 id 精确删除本次生成的 `prescriptions` / `doctor_notes` 行（不整表清空） |

### 11.3 `verify-ai-score.mjs`（新，Phase 3，纯函数 + 后端 + 浏览器）

| # | 断言 |
|---|---|
| 1 | **Rule Score 与原有 13 条确定性规则完全一致**（复用 `verify-health-score` 的 1–13 条纯函数断言） |
| 2 | `composeAssistedScore(rule, [])` → `assisted === rule` |
| 3 | 单条 `delta ∈ [-5,+5]`：越界 → **整包丢弃** → `assisted === rule`、`aiStatus='rejected'` |
| 4 | `Σ\|delta\| ≤ 10`：Σ=12 → 整包丢弃 |
| 5 | 缺少 `reason` → 整包丢弃 |
| 6 | `delta` 非整数 → 整包丢弃 |
| 7 | 同一 `dimension` 重复 → 整包丢弃 |
| 8 | 未知 `dimension` / 非适用维度 → 整包丢弃 |
| 9 | **守恒**：合法包 → `assisted − rule === Σdelta` |
| 10 | **clamp 边界**：`rule=98, Σ=+10` → `assisted=100`、`clamped=true`、`rawAssisted=108` 如实上报（**不误判为守恒失败**） |
| 11 | 非法 JSON → `aiStatus='unavailable'`、`assisted === rule` |
| 12 | 模型失败（模拟 401）→ 同上 |
| 13 | **缓存命中一致**：同 `patientId+date+inputHash` 连续两次 → `assisted` / `adjustments` 完全一致，且第二次未再调模型 |
| 14 | **`inputHash` 变化即失效**：当日新增一条读数 → 缓存失效、重新生成 |
| 15 | **AI 不得修改 clinicalRules 阈值**：评估前后 `clinicalRules` 阈值常量与 `patient_targets` 数值逐项相等 |
| 16 | **UI 明确区分**：界面同时出现「规则评分」与「AI 辅助」两个标签，且**主数字为 Rule Score** |
| 17 | 降级时 UI 显示「AI 解读暂不可用」，**不显示 AI 辅助分** |
| 18 | AI 辅助分**未参与**预警等级 / 达标率：同屏 `alerts` 与 `highestLevel` 与 Phase 3 之前一致 |

### 11.4 回归

| 脚本 | 基线 | 本次变动 |
|---|---|---|
| `verify-daily-tasks.mjs` | 26/26 | 修订 23 号断言（21/22 不必改） |
| `verify-health-score.mjs` | 29/29 | 修订 20 号断言（Phase 3） |
| `verify-step6.mjs` | 45/45 | 修订 J3 口径（Phase 1） |
| `verify-step4.mjs` / `verify-step5.mjs` | 26/26 · 28/28 | 预期无变动，须全绿 |
| `verify-readings.mjs` | 21/21 | 预期无变动 |
| `verify-ui-routes.mjs` | 15/15 | 新增页面须纳入逐路由冒烟 |
| `verify-task-actions.mjs` | 19/19 | 预期无变动 |
| `verify-auth-gate.mjs` | 16/16 | 预期无变动 |
| `verify-fallback-flag.mjs` | 29/29 | 预期无变动（Phase 2 涉降级路径，须复跑） |

**通用约定：** 后端验收一律在 `MYCARE_DB_PATH` 指向的副本库上跑，真实库零改动。
`verify-task-proposal.mjs` 需真实前端 + 后端（走真实对话），结束时按 id 精确清理。

---

## 十二、风险清单

| # | 风险 | 等级 | 处置 |
|---|---|---|---|
| R1 | **`patient_targets` 排序歧义：医生改了读不到且不报错** | 🔴 高 | 写入改 `UPDATE` 单行 + 三处 `ORDER BY` 加固 + 验收第 3 条专门锁死（**F-1，已实测复现**） |
| R2 | **`patient_targets.basis` 被登录页当作 JSON 消费，写入纯文本会破坏「重点关注」** | 🔴 高 | 医生依据只写 `prescriptions.target_goals.basis`；`patient_targets.basis` 一字不动 + 验收第 19 条（**F-2**） |
| R3 | **`prescriptions` 被健康建议页当作健康处方消费** | 🔴 高 | 覆盖包必带 `kind`；`getActivePrescription(s)` 按 `kind` 过滤 + 验收第 22 条（**F-3**） |
| R4 | **无 Key 环境下提案链路完全失效** | 🔴 高 | 提案做确定性通道，与模型可用性解耦 + 验收 17 条（**F-7**） |
| R5 | 「当前生效版本唯一」无 DB 约束兜底 | 🟠 中 | 单事务 + `ORDER BY generated_date DESC, rowid DESC` 读取兜底 + 验收第 16 条；可选 partial unique index（见待拍板 P5） |
| R6 | 状态机寄生在既有列上，`is_active=0` 承载 4 种语义 | 🟠 中 | `kind` + `status` + 查询口径表（§3）+ 懒过期（不写状态）；**明确接受「无法按状态建索引」的代价** |
| R7 | AI 辅助分被当作临床判据 | 🟠 中 | UI 主数字恒为 Rule Score；带 `[AI 辅助]` 标签 + 免责脚注；AI 分不参与预警/等级/达标率 + 验收第 18 条 |
| R8 | 模型幻觉出 `currentValue` | 🟠 中 | 后端注入 + 忽略模型返回值 + 验收 5/6 条 |
| R9 | 既有断言被覆盖功能打破 | 🟠 中 | 任务级 `source` 恒为 `'rule'`（覆盖信息放 `override` 子对象）；同步修订 `verify-daily-tasks` 23 号、`verify-step6` J3、`verify-health-score` 20 号 |
| R10 | 引入 AI 评分削弱「可复现」叙事 | 🟠 中 | 缓存 + 6 条硬约束 + 守恒断言；**弃用「`temperature=0` 保证可复现」的说法**，改用「缓存命中一致 + 约束恒成立」 |
| R11 | 提案把医生端刷满 / 陈年堆积 | 🟢 低 | 单轮 ≤2 + 去重（更新不新建）+ 7 天懒过期 |
| R12 | 真实库被验收污染 | 🟠 中 | 全部后端验收走 `MYCARE_DB_PATH` 副本库；提案验收按 id 精确清理 |
| R13 | `prescriptions` 语义被占用后，未来「健康处方」功能受限 | 🟢 低 | `kind` 字段已预留；若日后需要独立处方表，属 P1 表范畴，与本轮红线无冲突 |
| R14 | 医生端「添加备注」转真落库后，`verify-step6` J3 在真实库上失败 | 🟠 中 | 修订 J3 口径为「基线库 0 行」（F-6）；文档标注该脚本须在副本库跑 |

---

## 十三、仍需你拍板的事项

| # | 事项 | 我的推荐 | 影响 |
|---|---|---|---|
| **P1** | **D3 最终落点** | **A′：`prescriptions` 单一表 + `kind` 区分，零 schema 变更** | 决定是否执行 1 次 `ALTER TABLE`。A′ 全程零变更；B′（加 3 列 + partial unique index）语义更干净但动 schema。**A′ 的写入向后兼容 B′，可先 A′ 后补 B′** |
| **P2** | **`enabled=false` 的第一版范围** | **整体冻结**（主诊断 → `E_PRIMARY_TASK_DISABLE_FORBIDDEN`；其余 → `E_DISABLE_NOT_SUPPORTED_IN_V1`） | 范围最小、边界最清晰、验收最简单。若你希望「非监测项可停用」，改动仅在白名单判断 |
| **P3** | **接受 3 处既有断言的修订** | **必须接受**：`verify-daily-tasks` 23 号、`verify-step6` J3、`verify-health-score` 20 号 | 不接受则覆盖功能无法落地。21/22 号因 `source` 设计不变而无需改 |
| **P4** | AI 评分是否落库 | **不落库**（进程内缓存，与 `agent_runs` 不持久化的既有口径一致） | 落库会与 J2 断言冲突，且引入高频写 |
| **P5** | 是否允许 **partial unique index**（`CREATE UNIQUE INDEX … WHERE is_active=1`） | **暂不加**（应用层事务 + 读取兜底已够） | 属 schema 变更；3–4 位患者的演示规模下收益有限 |
| **P6** | AI 辅助分的界面位置 | **与 Rule Score 同屏并列，主数字仍是 Rule Score** | 若你希望「AI 含量」更突出，可改为并列等权重 —— 但**不建议把 AI 分设为主数字** |
| **P7** | 提案 7 天过期是否写入 `expired` 状态 | **懒判定，不写库**（`generated_date + 7d`） | 少一次写；代价是无「已过期」历史留痕 |
| **P8** | Phase 实施顺序 | **1 → 2 → 3** | Phase 2 强依赖 Phase 1（读取器 + 校验器 + 写入器三处复用） |

---

## 十四、一句话总结

> **Phase 1** 先把 `patient_targets` 排序歧义（**实测复现的静默失败**）、`basis` 被登录页消费、`prescriptions` 被健康建议页消费这三个隐患修掉，再让「医生改任务」第一次真正可写 ——
> **Phase 2** 让患者与「方案规划」智能体的对话变成一张**需要医生签字的申请单**（且这条链路做成确定性通道，无模型也能演示），医生点同意之前患者端一个字都不变 ——
> **Phase 3** 让大模型参与评分，但它**只能提出结构化、有界、可解释的调整意见**，最终分由确定性代码合成；界面严格区分 Rule Score 与 AI-assisted Score。

**本方案零代码改动、零 schema 变更、未执行任何迁移。等你确认 P1–P8 后进入 Phase 1 实施。**
