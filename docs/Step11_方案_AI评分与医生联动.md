-- =============================================================================
-- 迈康 MyCare · Step 11 方案（待评审，暂不实施）
-- =============================================================================

# Step 11 方案 · AI 参与评分 + 医生端修改今日任务 + 对话提案联动

> 状态：**方案稿，代码零改动**，等拍板。
> 本文所有涉及 schema 的动作都单独列在「第五节 · 决策点」，因为项目有
> 「P0 冻结 22 张表、不新建 P1/P2 表」的红线，必须先确认边界。

---

## 〇、先看三个结论

1. **「AI 评分」与项目既有红线正面冲突**，不能简单照做。既有红线是
   「数值、达标率、预警等级全部由 13 条确定性规则计算；AI 只负责转述，不得自猜阈值、等级或达标率」。
   方案给三条路线（A 只解释 / **B 有限调分（推荐）** / C 全自主），三条的合规性、
   可复现性、答辩风险差别很大，需你选一条。

2. **医生改今日任务有一个隐藏前提被忽略了**：`patient_targets.steps_target` 在库里
   **全是 NULL**。也就是说今日任务卡上那句「个体化目标 8,000 步」实际来自
   `dailyTasks.js` 的 `fallbackTarget = 8000` 兜底常量，**不是任何数据驱动的结果**。
   医生端一旦能改，这条链路才第一次真正活起来 —— 所以需求二必须做实。

3. **今日任务目前是「派生视图、不落库」**（Step 9 冻结的口径）。医生要「修改」它，
   不能改成落库式，否则会推翻 Step 9。本方案采用
   **「规则生成 + 医生覆盖层」**：规则仍是唯一生成者，医生只能覆盖已生成任务的参数。

---

## 一、现状盘点

### 1.1 与需求一（AI 评分）相关的既有事实

| 事实 | 位置 |
|---|---|
| 评分唯一实现，纯函数、前后端共用 | `src/utils/healthScore.js` |
| 权重 步数 30 / 血压 25 / 血糖 25 / 运动 20 | 同上 `SCORE_WEIGHTS` |
| 分母按疾病谱固定，缺测记 0 分并标 `missing` | 同上（Step 10 刚修完的缺陷） |
| 分档 85 / 70 / 55 | 同上 `SCORE_GRADES` |
| 前端调用点 | `HealthDataContext.getHealthScore()` |
| 服务端调用点 | `tools.js` 的 `compute_health_score` → 晨报 `POST /api/agent/briefing` |
| 已有验收 | `scripts/db/verify-health-score.mjs` **29/29**，其中 6 项断言「界面分 = 服务端分 = 本地分」 |

**冲突点**：那 6 项同源一致性断言，是「可复现/可审计」的支柱。
引入模型评分后，这个支柱要么被替换成新断言（模型分必须落在锚分区间内、调整量守恒），
要么被削弱。这一点必须在动手前想清楚。

### 1.2 与需求二（医生改任务）相关的既有事实

| 事实 | 位置 / 现状 |
|---|---|
| 任务生成器（唯一实现，前后端共用） | `src/utils/dailyTasks.js` 的 `buildDailyTasks()` |
| 任务**不落库**，进度实时派生自 readings / medication_logs | Step 9 红线 |
| 步数目标的读取点 | `patientService.getDailyTasks()` 读 `patient_targets.steps_target` |
| **该列当前全为 NULL** | 3 位示范病例都是 `null` → 实际走 8000 兜底 |
| 血压 / 血糖频次与时段 | `DAILY_TASK_RULES` 常量，**当前无任何覆盖入口** |
| 服药任务来源 | `medications` 表（`is_active` 可控制），医生可增删改药 |
| 医生端现有能力 | 患者列表 / 健康预警 / 数据概览 / **「添加备注」（假功能：`useState` 内存态，刷新即丢）** |
| 医生端接口 | 仅 `GET /api/doctors/:doctorId/patients` 一个 |
| `doctor_notes` 表 | 结构完整（`note_type` 含「处方调整」、`source` 含 `'agent'`/`'doctor'`），但**库里 0 行** |
| `prescriptions` 表 | 有 `target_goals` JSON、`doctor_modified`、`created_by IN ('agent','doctor')`、`is_active`，**库里 0 行** |

**关键**：`prescriptions` 这张表就是为「AI 生成方案 → 医生修改」设计的
（`doctor_modified` + `created_by`），**目前完全闲置**。这是本方案最干净的落点。

### 1.3 与需求三（对话提案联动）相关的既有事实

| 事实 | 位置 / 现状 |
|---|---|
| 六智能体注册表 | `server/agents/registry.js`，含 `planner`（方案规划智能体） |
| 与单个智能体对话 | `POST /api/agent/chat`（SSE 流式，工具闭环，`maxRounds: 4`） |
| 前端对话面板 | `src/components/Agent/ChatPanel.jsx`，可切换任意智能体 |
| 前端 SSE 消费 | `AgentContext.sendMessage()` |
| 工具副作用机制 | `createToolExecutor()` 内存收集 `effects.alerts / effects.reminders`，**由上层决定是否落库** |
| 落库先例 | orchestrator 跑完 → `persistRuleAlerts()` 写 alerts 表 |

**关键**：现有架构里「模型调用工具 → 上层落库」已有成熟范式，
提案不需要新机制，只需要照抄「内存收集 + 上层校验 + 落库」这条路径。

---

## 二、需求一 · AI 参与评分

### 2.1 设计：三层结构（锚定 → 修正 → 合成）

```
L1 规则锚（确定性，必算，永不失败）
     computeDailyHealthScore() → score=67, breakdown[4], missing=['血压']
        │
        ▼
L2 模型修正（生成式，可失败）
     输入：当日数据 + 疾病谱 + 近 7 日趋势 + L1 全量分项 + 规则命中等级
     输出：adjustments[]（逐条 delta + reason）+ narrative + insights[]
     硬约束：每个 delta ∈ [-5, +5]，Σ|delta| ≤ 10
        │
        ▼
L3 确定性合成（纯函数，前后端共用）
     applyModelAdjustment(anchorScore, adjustments)
       · 校验 Σdelta 与 adjustedScore 是否一致 → 不一致则整包丢弃，回落锚分
       · 校验每个 delta 是否越界 → 越界则整包丢弃
       · 输出 finalScore + 分档 + 逐条调整依据
```

**核心思想**：**模型负责「提出判断」，确定性代码负责「合成与校验」。**
模型永远不直接产出最终分数，它只能产出可分解的调整项，由纯函数合成。
这样既让模型真正参与了评分，又保住了可复现与可审计。

### 2.2 三条路线（**决策点 D1**）

| | 路线 A · 只解释 | **路线 B · 有限调分（推荐）** | 路线 C · 全自主 |
|---|---|---|---|
| 模型产出 | narrative + insights，**不改分** | adjustments（±5/条，Σ≤10）+ narrative + insights | 直接输出 0-100 分 |
| 最终分 | 规则分 | 规则分 + 模型调整（合成） | 模型分 |
| 可复现 | 完全 | **高**（temperature=0 + 当日缓存） | 低，同一天刷新可能变 |
| 与红线关系 | 不冲突 | **不冲突**（合成由确定性代码完成） | **冲突**，等于把裁定权交给模型 |
| 答辩说服力 | 稳，但「AI 含量」看起来低 | **强**：能当场解释「哪一项被 AI 调整了、为什么」 | 看起来强，但被追问「为什么这次 72 上次 68」会答不上 |
| 改动面 | 小 | 中 | 中 |
| 需重写验收 | 否 | **是**（6 项同源断言 → 新区间/守恒断言） | 是，且原 29 项大部分失效 |

**推荐路线 B**。理由：既满足「让大模型来评分」的诉求，又保住「分数可解释、可复现、可审计」这条本项目最核心的竞争力。C 路线在答辩场景下是负资产 —— 评委只要刷新两次页面就能看出分数在抖。

### 2.3 界面呈现（路线 B）

评分卡改为双行结构：

```
        72                    ← 主数字：合成分
   良好（AI 调整 +5）           ← 分档 + 调整标记
 ─────────────────────────
 规则基线 67  ·  AI 调整 +5    ← 可展开
   ★ 步数        30/30   优秀
     血压         0/25   今日未记录
     血糖        25/25
     运动        12/20   AI 下调 −3：连续 2 天运动后即刻血糖偏低
 未录入：血压（按 0 分计入满分 75 分）
```

规则：**任何被模型调整的维度必须显示 delta 值与理由**，不做黑箱。
模型不可用 → 只显示规则基线，并标注「AI 解读暂不可用」。

### 2.4 接口与缓存

```
POST /api/agent/score
  body: { patientId }
  → { anchor: {score, grade, breakdown, missing},
      model: { adjustedScore, grade, adjustments[], narrative, insights[],
               model, degraded, cached, generatedAt } }

GET /api/patients/:patientId/score   → 读当日缓存，无缓存返回仅 anchor
```

- **缓存键**：`patientId + YYYY-MM-DD`，存进程内 `Map`（重启失效，可接受）
- **失效**：当日新增读数 / 录入记录 → 清该患者缓存
- **落库（可选）**：`agent_runs`（`goal='daily-score'`, `events` 存模型原始输出），
  用于追溯。**默认不落库**，避免高频写。
- **成本**：一次约 1.5–2.5k input tokens。建议只在「用户点开评分卡详情」或
  「进首页且当日无缓存」时调用，不在每次渲染时调用。

### 2.5 对既有验收的影响（必须接受）

`verify-health-score.mjs` 需改 6 项断言，从「界面分 = 服务端分 = 本地分」
改为：

1. 模型分 ∈ `[anchor − 10, anchor + 10]`
2. `Σ adjustments.delta == adjustedScore − anchorScore`（守恒）
3. 单条 delta ∈ `[-5, +5]`
4. 每条 adjustment 必须有非空 reason
5. 模型输出非法 / 越界 / 降级 → 最终分 == anchorScore，且 UI 标注降级
6. 同一 `patientId + date` 连续两次请求 → 分数完全一致（缓存断言）

---

## 三、需求二 · 医生端修改今日任务

### 3.1 设计：规则生成 + 医生覆盖层（不推翻 Step 9）

```
      buildDailyTasks(纯函数，仍是唯一生成者)
                │
                ├── 规则产出基础任务清单
                │
                └── 入参新增 taskOverrides（可选）
                          │  只允许：
                          │    · 改 target（数值 / 频次）
                          │    · 改 slots（时段集合）
                          │    · enabled: false（停用）
                          │  禁止：
                          │    · 创建规则未生成的任务域
                          │    · 修改医学阈值（140/90、7.0 等）
                          ▼
                  应用覆盖 → 任务带 source:'doctor' 标记
                             + overrideReason + overriddenBy + overriddenAt
```

覆盖格式（示例）：

```json
{
  "steps":     { "target": 6000, "reason": "患者膝关节不适，先降至 6000 步" },
  "bp_monitor":{ "slots": ["晨起", "睡前"], "target": 2, "reason": "血压近期平稳，恢复每日 2 次" },
  "exercise":  { "target": 20, "reason": "阶梯式恢复运动量" }
}
```

### 3.2 数据落点（**决策点 D2**）

| 选项 | 落点 | 优点 | 代价 |
|---|---|---|---|
| A | `patient_targets` 现有列（`steps_target` 等） | 零变更，已有读取链路 | **只能承载目标值**，承载不了频次 / 时段 / 启停 |
| **B（推荐）** | `prescriptions.target_goals`（JSON） | **零 schema 变更**；`doctor_modified` + `created_by` 天生为此设计；`is_active` 天然管版本 | 需约定 JSON 结构 |
| C | `patient_targets` 加一列 `task_overrides TEXT` | 语义直白 | 需 `ALTER TABLE` 加列 |

**推荐 B**：完全不动 schema，且顺带把闲置的 `prescriptions` 表用起来（这张表
本来就写着「方案由 AI 生成、医生可修改」的语义）。写入时 `created_by='doctor'`、
`doctor_modified=1`，旧记录 `is_active=0`，形成版本链。

另需**同时写 `patient_targets.steps_target`**（步数目标），因为它是既有读取链路
（`getDailyTasks` 直接读这一列）。落两层：`patient_targets` 承接步数目标，
`prescriptions.target_goals` 承接完整覆盖包。

### 3.3 接口

```
GET  /api/doctors/:doctorId/patients/:patientId/tasks
     → 今日任务清单（复用 getDailyTasks）+ 当前覆盖包 + 生效中目标
POST /api/doctors/:doctorId/patients/:patientId/task-overrides
     body: { overrides: {...}, basis: "《…指南》+ 患者主诉" }
     → 写 prescriptions（新 is_active=1，旧的置 0）
     + 写 patient_targets.steps_target（若含 steps）
     + 写 doctor_notes（note_type='建议', source='doctor'）→ 患者端可见「李医生调整了你的今日任务」
     → { applied: [...], warnings: [...] }
```

`warnings` 用于承载「该覆盖实际未生效」的情况，例如覆盖了一个当日规则未生成的任务、
或覆盖值超出合理范围（步数 > 20000、频次 > 6）。

### 3.4 医生端界面

- 患者卡片新增第三个按钮「今日任务」（现有：查看详情 / 添加备注）
- 打开抽屉「任务与目标管理」，上半区=当日任务实况（含进度），下半区=可编辑项：
  - 步数目标：数字输入
  - 血压 / 血糖监测：时段多选 + 频次（由时段数派生，只读显示）
  - 运动打卡：目标分钟数
  - 每项可单独 `启用 / 停用`
  - 底部「调整依据」**必填**（写进 `basis`，进而在患者端展示）
- 保存前二次确认，列出「改动前 → 改动后」diff
- **红线提示**：停用「主诊断监测项」（如高血压患者的血压监测）时，弹二次确认并标注
  「该任务对应主诊断监测，停用后将不再提醒患者测量」

顺带把现有「添加备注」假功能修成真落库（写 `doctor_notes`）—— 表结构已就绪，
这件事的边际成本接近零，不修会在答辩时被一眼看穿。

---

## 四、需求三 · 对话提案 → 医生审核 → 联动

### 4.1 完整闭环

```
患者 ──对话──▶ 方案规划智能体（POST /api/agent/chat）
                     │
                     ├─① 正常对话回复（现有链路，不动）
                     │
                     └─② 意图检测（新增，两级，省 token）
                          ├─ 关键词预筛（零成本）
                          │   步数/目标/次数/监测/降低/减少/取消/改/疼/不舒服…
                          │   未命中 → 不做任何额外动作
                          └─ 命中 → 模型在回复之外多输出一段结构化提案
                               {
                                 proposals: [{
                                   taskId: "steps",
                                   field: "target",
                                   currentValue: 8000,     ← 后端注入，模型禁改
                                   proposedValue: 5000,
                                   reason: "…",
                                   evidence: ["患者自述膝关节疼痛", "近 7 日步数 3000–4000"]
                                 }],
                                 confidence: 0.8
                               }
                     │
                     ▼ 落库：待审核提案（决策点 D3 决定落点）
                     │
                     ▼ 医生端出现「待审核」角标
              ┌──────────────────────────────────────────┐
              │  待审核提案卡片                            │
              │  患者 张建国 · 由「方案规划智能体」提交      │
              │  变更：步数目标  8,000 步 → 5,000 步        │
              │  依据：患者自述膝关节疼痛；近 7 日实际步数…  │
              │  患者原话：「我膝盖疼，8000 步走不下来…」     │
              │  【同意并生效】【修改后生效】【驳回+理由】    │
              └──────────────────────────────────────────┘
                     │
                     ├─ 同意 ─▶ 写覆盖层（同 3.2）
                     │          + 写 doctor_notes 给患者（「李医生已同意…」）
                     │          + 提案置 approved（记录 reviewedBy / reviewedAt）
                     │
                     └─ 驳回 ─▶ 不写任何覆盖
                                + 写 doctor_notes 给患者（含驳回理由）
                                + 提案置 rejected
                     │
                     ▼ 联动生效
              患者端首页今日任务下次拉取 → 步数目标变 5,000
              患者端收到「医生已回复」提示（doctor_notes is_read=0）
```

**关键断言：在医生点「同意」之前，患者端的今日任务一个字都不变。**
这是整个联动的安全底线，也是验收脚本最重要的一条。

### 4.2 提案落点（**决策点 D3**）

| 选项 | 落点 | 优点 | 代价 |
|---|---|---|---|
| A | `doctor_notes` 加 3 列：`review_status` + `reviewed_by` + `reviewed_at` | 语义最干净，可建索引、可统计「待审 N 条」 | 1 次 `ALTER TABLE` 加列（**不是新建表**，但仍属 schema 变更） |
| B | `doctor_notes.content` 存 JSON，`is_read` 兼作审核位 | 零变更 | `is_read` 原义是「患者是否已读」，两个语义会互相干扰；无法按状态建索引 |
| C | `prescriptions` 草稿态（`is_active=0`）承载提案 | 零变更，语义较自然（AI 出草稿 → 医生审核 → 激活） | 与「历史作废版本」共用 `is_active=0`，语义会被挤；提案被驳回后的去留不好表达 |

**推荐 A**：审核流转是本需求的核心业务对象，需要「待审 / 已同意 / 已驳回」三态
可查询、可统计。挤进 `is_read` 会让医生端「已读」和「已审核」两件事纠缠不清，
验收脚本也很难写干净。

若要严格守住「零 schema 变更」，退而选 C（不用 B）。

### 4.3 安全约束（写进代码，不只是文档）

1. **AI 永不直接改任务**。提案只是「申请」，唯一写覆盖层的路径是医生审核通过。
2. **`currentValue` 由后端注入**，模型只能填 `proposedValue` 与 `reason`。
   模型若返回 `currentValue` 字段 → 直接忽略（防幻觉造现状）。
3. **阈值类变更一律过滤**：提案 `field` 只允许 `target` / `slots` / `enabled`。
   模型若提「把血压目标改成 160」→ 不生成提案（阈值归 `patient_targets` 与
   `clinicalRules`，AI 无权触碰）。
4. **停用主诊断监测项要标红**：即使模型提出，医生端也必须显示警示，
   并要求二次确认（与 3.4 同一口径）。
5. **单轮对话最多 2 条提案**，防刷屏。
6. **去重**：同患者 + 同 `taskId` + 同 `field` 若已有 pending 提案 → 更新而非新增。
7. **提案有效期 7 天**，过期自动置 expired（避免医生端堆积陈年提案）。

### 4.4 接口

```
# 患者侧（chat 流新增一个 SSE 事件）
POST /api/agent/chat
  ← 新增事件：{ type:'task_proposal', proposals:[...], status:'pending_review' }
     （在 chat_done 之前推送；前端 ChatPanel 渲染一张「已提交医生审核」卡片）

# 医生侧
GET  /api/doctors/:doctorId/task-proposals?status=pending&patientId=...
POST /api/doctors/:doctorId/task-proposals/:proposalId/review
     body: { decision:'approve'|'modify'|'reject', overrides?, reason? }
     → approve/modify：写覆盖层 + 通知患者
     → reject：仅通知患者（含理由）

# 患者侧读医生反馈
GET  /api/patients/:patientId/doctor-notes?unread=1
POST /api/patients/:patientId/doctor-notes/:noteId/read
```

### 4.5 「推送到医生端」的实时性

- **基础版（推荐）**：医生端进页面时拉一次 + 每 15–30s 轮询 `pending` 列表，
  侧边「待审核」Tab 显示角标。简单、稳、演示够用。
- **增强版（可选）**：提案落库时，用 SSE 推给所有已连接的医生端页面
  （`GET /api/doctors/:doctorId/stream`）。演示「实时推送」效果好，
  但需要维护订阅连接池，复杂度上升。

建议先做基础版；若答辩要演示「实时」，再叠增强版。

---

## 五、决策点汇总（**请逐条拍板**）

| # | 决策 | 选项 | 我的推荐 |
|---|---|---|---|
| **D1** | AI 评分路线 | A 只解释 / **B 有限调分** / C 全自主 | **B**（±5 每条，Σ≤10，确定性合成） |
| **D2** | 覆盖层落点 | A `patient_targets` 列 / **B `prescriptions.target_goals`** / C 加列 | **B**（零 schema 变更） |
| **D3** | 提案落点 | **A `doctor_notes` 加 3 列** / B 挤 `is_read` / C `prescriptions` 草稿态 | **A**（若必须零变更则退 C） |
| **D4** | 医生能否「停用主诊断监测项」 | 允许（二次确认+标红）/ **完全禁止** | 允许 + 强制标红（更贴近真实医患场景） |
| **D5** | 患者能否撤回提案 | 能 / **不能**（本轮不做） | 不能（本轮范围外） |
| **D6** | 医生端实时性 | **基础版轮询** / 增强版 SSE | 基础版 |
| **D7** | AI 评分是否落库 | **不落库（仅内存缓存）** / 落 `agent_runs` | 不落库 |
| **D8** | 顺带修「添加备注」假功能？ | **修**（写 `doctor_notes`，表已就绪） | 修（成本近零） |

---

## 六、分阶段实施

**Phase 1 · 医生改今日任务（可独立交付）**
1. `dailyTasks.js` 新增 `taskOverrides` 入参与应用逻辑（纯函数，加单测）
2. `patientService` 新增覆盖层读写（`prescriptions` + `patient_targets`）
3. 医生端新增「今日任务」抽屉 + 2 个接口
4. 顺带修「添加备注」真假问题
5. 患者端任务卡显示「医生已调整」徽标 + 依据

**Phase 2 · 对话提案 → 审核联动**（依赖 Phase 1 的覆盖层）
1. chat 流程加意图预筛 + 提案解析 + 三项安全过滤
2. 提案落库与去重 / 过期
3. 医生端「待审核」Tab + 审核接口
4. 患者端「医生已回复」提示
5. ChatPanel 新增提案卡片

**Phase 3 · AI 参与评分**（相互独立，可随时插入）
1. `healthScore.js` 新增 `applyModelAdjustment()` 纯函数（确定性合成）
2. 新增 `/api/agent/score` + 当日缓存
3. 评分卡双行展示 + 调整依据展开
4. 重写 `verify-health-score.mjs` 的 6 项同源断言

推荐顺序 **1 → 2 → 3**：Phase 1 是 Phase 2 的落点依赖；Phase 3 与另外两块解耦。

---

## 七、验收计划

| 脚本 | 覆盖 | 关键断言 |
|---|---|---|
| `verify-doctor-task-override.mjs`（新） | 医生改任务 | 改步数目标 → 患者端 `daily-tasks.target` 变化；覆盖不能创建新任务域；覆盖不存在的 taskId → 忽略 + warning；覆盖记录含 `set_by`/`basis` |
| `verify-task-proposal.mjs`（新） | 提案联动 | **医生同意前患者端任务零变化**；模型不能编造 `currentValue`；阈值类提案被过滤；approve → 任务变化 + 患者收到反馈；reject → 任务不变 + 收到理由；重复提案去重 |
| `verify-ai-score.mjs`（新） | AI 评分 | 分区间 `[锚−10, 锚+10]`；调整量守恒；单条 delta ≤5；降级回落锚分；同日两次请求分数一致 |
| `verify-health-score.mjs`（改） | 评分回归 | 锚分本身仍需与原口径一致（13 项纯函数断言保留） |
| 全量回归 | — | `step4/5/6`、`readings`、`daily-tasks`、`ui-routes`、`task-actions` 全绿 |

**通用约定**：后端验收一律在 `MYCARE_DB_PATH` 指向的副本库上跑，真实库零改动。
`verify-task-proposal.mjs` 需要真实前端 + 后端（走真实对话），结束时清理生成的
提案与覆盖记录（`prescriptions` / `doctor_notes` 按 id 精确删除，不整表清空）。

---

## 八、风险

| 风险 | 影响 | 处置 |
|---|---|---|
| 模型评分在某次演示中抖动 | 答辩现场被追问 | 路线 B + `temperature=0` + 当日缓存；缓存命中时不重新调模型 |
| 模型幻觉出「现状值」 | 医生看到错误对比 | `currentValue` 后端注入，模型返回的一律忽略 |
| 模型提出激进变更（停用监测项） | 医疗安全 | 三项过滤 + 医生端标红二次确认 |
| 提案把医生端刷满 | 体验 | 单轮 ≤2 条 + 去重 + 7 天过期 |
| 覆盖层与规则冲突（如停用主诊断监测） | 医学逻辑 | 规则仍先生成，覆盖只是参数级调整；停用需显式确认 |
| schema 加列（D3 选 A）影响既有库 | 数据风险 | `ALTER TABLE ADD COLUMN` 幂等迁移脚本；先在副本库验证；真实库备份后执行 |
| 引入模型评分后原 29 项验收部分失效 | 回归可信度下降 | 明确改写 6 项断言，其余 23 项保留 |

---

## 九、明确不做（本轮范围外）

- 不做患者端「撤回提案」
- 不做多医生协同 / 会诊
- 不做医生端 SSE 实时推送（Phase 2 基础版用轮询）
- 不改 `clinicalRules.js` 的任何阈值、等级、达标率口径（红线）
- 不新建任何数据表（22 张表维持不变；如需加列，仅 D3 一处且需你确认）
- 不把「今日任务」改成落库式（维持 Step 9 的派生视图口径）

---

## 十、一句话总结

> **Phase 1** 让「医生改任务」第一次真正可写（并把闲置的 `prescriptions` 用起来）；
> **Phase 2** 让患者与「方案规划」智能体的对话变成一张**需要医生签字的申请单**，
> 医生点同意之前患者端一个字都不变；
> **Phase 3** 让大模型参与评分，但只允许它**提出可分解的调整意见**，最终分由确定性代码合成 ——
> 既有「可复现、可审计」的竞争力不丢。
