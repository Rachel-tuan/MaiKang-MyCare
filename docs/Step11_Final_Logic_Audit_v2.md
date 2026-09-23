# 迈康 MyCare · Step 11 Final Logic Audit v2（修复后复核版）

> 生成时间：2026-09-16
> 前序文档：`docs/Step11_Final_Logic_Audit.md`（v1，只读核查）
> 本版性质：**修复轮之后的复核**。v1 发现的 D-1 / D-2 已修复，本版逐项复验修复效果、更新结论分类与证据规模。
> 本轮**未修改**：schema、migration、`clinicalRules` 医学阈值、既有测试断言、D-3、C-1～C-7。

---

## 0. v1 → v2 变更摘要

| 项 | v1 结论 | v2 结论 | 依据 |
|---|---|---|---|
| **D-1** 未记录被读成 0 | 🔴 真实缺陷 | ✅ **已关闭** | 修复 + 反事实复验（§2.1） |
| **D-2** 两套风险等级同屏矛盾 | 🟠 真实缺陷 | ✅ **已关闭** | 唯一裁定者 + 四患者三级一致（§2.2） |
| **D-3** 提案审结非原子 | 🟡 保留 | 🟡 保留（未修） | §2.3 |
| **C 类** 工程折中 | 7 条 | **8 条**（新增 C-8 预警跨日快照） | §2.4 |
| B 类 外部医学锚点 | 4 条 | 4 条（未变） | §3.2 |
| E 类 未来扩展 | 8 条 | 8 条（未变） | §3.4 |
| 证据规模 | 13 脚本 / 401 断言 | **15 脚本 / 456–457 断言** | §4（v1 的计数未含 `verify-register-flow` 的 25 条，本版按实际执行为准） |

**一句话**：v1 指出的两个会影响系统逻辑一致性的缺陷均已关闭并有可复核的验收证据；其余 B / C / E 类项目**按要求冻结**，作为「当前版本限制与后续方向」如实披露，不以扩展功能的方式消除。

---

## 1. 修复内容与复核证据

### 1.1 D-1 · 「未记录」被读成「测得 0」

**根因（v1 已定位，本轮复验确认）**

不是 `clinicalRules.pick()` 本身错误。`pick()` 是**中立读取器**：遍历候选键、只接受显式有限数值。它**无法区分**「真测得的 0」与「视图层为缺测补的 0」——因此责任在**上游伪造**。

`server/data/patientService.js` 的 `toRecordView()` 曾为兼容视图补默认值：

```js
bloodPressure: { systolic: systolic ?? 0, diastolic: diastolic ?? 0 },
bloodSugar: bloodSugar ?? 0,
heartRate: heartRate ?? 0,
exerciseMinutes: exerciseMinutes ?? 0,
sleepHours: sleepHours ?? 7,
moodScore: moodScore ?? 4,
```

而 `FIELD_KEYS` 的候选键把 **DB 列名排在前、视图别名排在后**：

```js
systolic:  ['systolic_pressure', 'systolic', 'bloodPressure.systolic'],
bloodSugar:['blood_sugar', 'bloodSugar'],
```

于是 DB 为 `NULL` 时 `pick()` 继续向后落到别名的伪造 `0`，空白日以「0」进入规则序列（`seriesOf` 原先只过滤 `null`、不过滤 `0`）。

**可被污染的键**：`systolic` / `diastolic` / `bloodSugar` / `exerciseMinutes`。`steps` / `weight` 无别名，**本就不受影响**。

**触发条件**：某天**首次**录入只填了部分字段（`upsertDailyRecord` 用 `COALESCE` 合并，不会把未提交字段写成 NULL）。

**修复（2 处，均只改「读取语义」，不动任何医学阈值）**

| 文件 | 位置 | 改动 |
|---|---|---|
| `server/data/patientService.js` | `toRecordView()` 视图模型块 | **停止伪造**：`?? 0 / ?? 7 / ?? 4` 全部移除，缺测一律保留 `null`；附「不变量」注释说明后果 |
| `src/utils/clinicalRules.js` | `pick()` / `seriesOf()` / `evaluateBloodSugar` | 为 `pick()` / `seriesOf()` 补「不变量」文档注释（**上游一律不得为缺测伪造 0**）；`evaluateBloodSugar.stats.totalDays` 原先误写为 `min`（血糖最小值），改为 `flags.length`（窗口内**有记录**的天数），与血压块口径统一 |

**为什么真实 0 不受影响**

**没有**采用 `value > 0` 之类的粗暴过滤。理由：`schema.sql` 对 `systolic_pressure` / `fasting_glucose` **无 CHECK 约束**，`upsertDailyRecord` 也不校验取值范围 —— 因此**无法证明** 0 在整个系统中绝不合法。按「不通过简单过滤掩盖语义」的要求，改为**让缺测保持缺测**，`NULL` 与 `0` 严格区分。

验收断言 `2a` 实测：`steps=0` / `systolic=0` 均被保留为有效数值。

**反事实实验（修复前 vs 修复后，同一份数据）**

样本：patient_1（张建国），2026-09-15 **仅有步数**记录。

| 量 | 修复前 | 修复后 | 真值 |
|---|---|---|---|
| 血压序列 | `[136,138,144,152,158,0]` | `[136,138,144,152,158]` | 排除缺测日 |
| 血糖序列 | `[5.2,5.6,5.3,5.5,5.8,0]` | `[5.2,5.6,5.3,5.5,5.8]` | 排除缺测日 |
| 最高等级 | `watch` 关注 | **`alert` 预警** | 预警 |
| 命中规则 | R-BG-2（假） | **R-BP-2（真）** | — |
| 血压 7 天涨幅 | **−136** | **+22** | +22 |
| 血糖极差 / 最低 | 5.8 / **0** | **0.6 / 5.2** | 5.2 |
| 血压达标率 | **50%** | **40%** | 40% |
| 达标日数 | 3 | 2 | — |

**这是同一个缺陷同时造成三种后果的完整证据**：
① **假预警** —— 当日并未测血糖，却命中「血糖波动较大」并落库；
② **掩盖真预警** —— 收缩压 136→158、连续 3 天 ≥140 本应命中 R-BP-2，被末尾的伪 0 冲掉了涨幅判定；
③ **达标率虚高** —— 伪造的 0 小于阈值，被算作「达标日」。

**「缺测语义」是否已在规则层内统一（v1 遗留问题的答复）**

v1 指出：Step 10 已修 `healthScore.js` 的「缺测 = 满分」，但规则引擎的达标率仍是「缺测 = 达标」。**该问题现已一并消除。**

| 层 | 缺测的处理 | 是否把缺测当达标 |
|---|---|---|
| `healthScore.js`（当日综合得分） | 缺测维度按 **0 分**计入分母，并标 `missing` | ❌ 否 |
| `clinicalRules.js`（记录日达标率） | 缺测日**不进序列** → 既不进分子也不进分母；`totalDays` = 窗口内**有记录**的天数 | ❌ 否 |

两者口径**刻意不同**（一个算「当日综合分」，一个算「记录日达标率」，分母语义本就不同），但**同向**：都不把缺测当达标。断言 `4a` / `4b` 对照验证。

---

### 1.2 D-2 · 两套风险等级同屏矛盾

**根因**

`server/agents/tools.js` 的 `assessRisk()` **自备第二套阈值与等级词表**（收缩压 180/160、血糖 16.7/11.1、心率 120/45…，内部键 `critical/high/medium/low`），再把结果映射成与 `ALERT_LEVEL` **同名**的中文标签；而落库预警走 `clinicalRules`。两者在 `HomePage.jsx` **同页共现**，且因为标签同名，用户从文案上根本看不出这是两套系统。

v1 线上复现：4 例中 **3 例不一致**。

**修复思路：拆分两个职责，只留一个裁定者**

`assessRisk()` 原有两个职责：① 风险判定；② 晨报自然语言描述。本轮**保留 ②、把 ① 交还 `clinicalRules`**。

**统一后的调用链**

```
clinicalRules.evaluateClinicalRules()
        │  matched / byId
        ├─ triggered  ←「关注及以上」命中项 = 规范风险集合（本版新增字段）
        └─ highestLevel = highestAlertLevel(triggered)
                 │
                 ├──→ briefing.risk（等级 + label + 检出项）   server/index.js
                 ├──→ alerts 落库（PERSIST_LEVELS）            alertService.persistRuleAlerts
                 └──→ 医生端 evaluation.highestLevel           patientService.getDailyTasks

tools.assessRisk()
        └─ 只做转述：risks[] 的 level/levelLabel 取自命中项（经 toProductLevel 归一）
           + observations[] 纯描述素材（title/detail/action，不含任何等级键）
```

**改动清单**

| 文件 | 改动 |
|---|---|
| `src/utils/clinicalRules.js` | `evaluateClinicalRules()` 返回值新增 **`triggered`**（「关注及以上」命中项）作为**规范风险集合**，`highestLevel` 由它算出；附注释：任何消费方不得再自己写一遍过滤 |
| `server/agents/tools.js` | `assessRisk()` 退化为转述者；新增 `toProductLevel()`、`describeObservations()`；`assess_risk` 工具与 `raise_alert` 全部改走产品键 |
| `server/index.js` | `/api/agent/briefing` 的等级、检出项、headline 全部改为消费 `clinicalRules` 结果 |
| `server/agents/orchestrator.js` | 安全兜底补预警的判定改走 `clinicalRules` |
| `server/agents/mock.js` | `sentinel` 分支与晨报文案同源化 |
| `src/pages/HomePage.jsx` | 晨报风险标签着色改用与预警卡片**同一张** `LEVEL_COLOR[label]`，不再按 `critical/high` 内部键位判断 |

**没有做的事**：`clinicalRules` 的医学阈值**一字未改**；告警规则**一条未删**；这里统一的只是**等级来源**。

**四患者对照（线上 3001 实测）**

| 患者 | briefing | clinicalRules `highestLevel` | alerts 最高级 | 判定 |
|---|---|---|---|---|
| patient_1 张建国 | `alert` 预警 · R-BP-2 | `alert` | 预警（R-BP-2） | ✅ 一致 |
| patient_2 李秀英 | `alert` 预警 · R-BG-3 / R-BG-2 | `alert` | 预警（R-BG-3） | ✅ 一致 |
| patient_3 王建军 | `watch` 关注 · R-WT-3 | `watch` | 关注（R-WT-3） | ✅ 一致 |
| patient_4 赵小川 | `info` 提示 · 无命中 | `info` | **无规则告警命中** | ✅ 一致 |

> patient_4 无 alerts 属「**无规则告警命中**」，不是由另一套独立风险系统给出不同等级 —— 这正是本次统一要消除的歧义。

**静态与结构断言**

- `6a`：`assessRisk()` 函数体内**零命中**第二套阈值与内部等级字面量；
- `6b`：全项目只剩一份等级标签表（`ALERT_LEVEL`），不再各自复制中文标签映射；
- `6c`：首页风险标签着色与预警卡片**共用**同一套 `LEVEL_COLOR[label]`；
- `5e`：`observations[]` 只含 `title/detail/action`，**不含任何等级键**。

---

### 1.3 D-3 · 提案审结非原子（保留，未修）

`server/data/proposalService.js` 中，`applyOverridePackage()` **自身 COMMIT**，与随后标记提案为 `approved` 的 `UPDATE` **不在同一事务**。若两步之间进程被终止，会出现「覆盖包已生效、提案仍显示待审」；医生再点一次「同意」会重复应用（`applyOverridePackage` 是幂等替换，不至数据损坏，但会产生多余版本行）。

**影响**：低，需异常时序才能触发。**不影响当前答辩**。

**为什么本轮不修**：需让 `applyOverridePackage` 支持外部事务传入，属结构性改动，超出「D-1 + D-2」的授权范围。按用户要求排入下一阶段。

---

## 2. 最终审计结果：五类结论（v2）

### 2.1 A 类 —— 已明确定义，代码与测试均一致

| # | 结论 | 关键证据 |
|---|---|---|
| A-1 | **规则是今日任务的唯一生成者**：`buildDailyTasks()` 确定性生成，`source` 恒为 `rule`，AI 不得生成规则外任务 | `dailyTasks.js` `TASK_SOURCE='rule'`（8 处赋值）；覆盖层只能改**已生成**任务的参数 |
| A-2 | **覆盖包三道关口**：白名单 taskId → 字段契约 → 原子校验；任一项非法整包拒绝 | `taskOverride.js` `TASK_OVERRIDE_CONTRACT` / `NOT_OVERRIDABLE_TASK_IDS` / `THRESHOLD_FIELDS` |
| A-3 | **AI 权限边界**：`tools.js` 全文件**无任何 INSERT / UPDATE / DELETE** | 静态检索零命中 |
| A-4 | **三层评分分离**：L1 Rule Score 是唯一官方分；L2 是「意见」不是分；L3 仅辅助显示，绝不参与预警 / 档位 / 达标率 | `aiScore.js`；`verify-ai-score` 断言 18/18b/18c/18d |
| A-5 | **降级链路完整**：无 Key / 调用失败 / 结构畸形 → 回落 Rule Score，主流程不中断 | `ALLOW_MOCK_FALLBACK`；`verify-fallback-flag` 29 项 |
| A-6 | **写入面收敛**：全项目有写操作的表共 **12 张**，集中在 **5 个数据服务文件**；取数契约层 `dataProvider.js` **零写操作** | 下表 |

**A-6 证据 · 写入面全量盘点**（`grep` 全项目 `INSERT INTO` / `UPDATE` / `DELETE FROM`）

| 文件 | 可写表 | 张数 |
|---|---|---|
| `server/data/patientService.js` | `patients` · `patient_contacts` · `patient_conditions` · `patient_lifestyle` · `daily_health_records` · `blood_pressure_readings` · `blood_glucose_readings` · `medication_logs` | 8 |
| `server/data/taskOverrideService.js` | `patient_targets` · `prescriptions` | 2 |
| `server/data/proposalService.js` | `prescriptions` | 1 |
| `server/data/alertService.js` | `alerts` | 1 |
| `server/data/doctorNoteService.js` | `doctor_notes` | 1 |

- 去重后共 **12 张表**（`prescriptions` 被两个服务共同触及）。
- `server/data/dataProvider.js`（取数契约层）**零写操作** —— 它只负责读取与字段映射。
- **`reminders` 与 `agent_runs` 全项目零写操作** —— 两表已建但按设计未持久化，此处得到验证。
- `tools.js`（智能体工具层）**零写操作** —— AI 不能直接改库（对应 A-3）。

### 2.2 B 类 —— 已定义、有代码依据，但**外部医学来源仍待整理**（4 条，未变）

| # | 项 | 现状 | 说明 |
|---|---|---|---|
| B-1 | 规则阈值（140/90、7.0、7.8、1.4 mmol/L…） | 代码内常量 | **无外部指南文件锚点**；`clinicalRules.js` 顶部声明为「Demo 规则」 |
| B-2 | 评分阶梯（4000/6000/8000/10000 步、25/30/60 分钟…） | 代码内常量 | 同上，属工程设定 |
| B-3 | 任务频次（血压 / 血糖每日 2 或 3 次） | `DAILY_TASK_RULES` | `disclaimer` 字段明示「本项目 Demo 规则，非医学处方」 |
| B-4 | `assessRisk` 曾用的独立阈值 | **已随 D-2 修复删除** | v2 起该项**不再存在**；B-4 收窄为「不存在第二套阈值」 |

> **口径要求**：对外只能说「这些阈值是**项目内定义的演示规则**」，**不得**声称它们来自某部指南，也不得把 AI 生成的建议当作医学依据。三位示范病例的个体化控制目标（`demoThreshold`）是**演示设定值**，不是诊断标准。

### 2.3 C 类 —— 已实现，属工程折中 / 已知限制（8 条）

| # | 项 | 说明 | 影响 |
|---|---|---|---|
| C-1 | `inputHash` 只含「当日体征 + 疾病谱 + Rule Score」，**不含近 7 日窗口** | 提示词却使用了 `recent` → 历史某天被回改而当日未变时，缓存不失效 | 低 |
| C-2 | `patient_targets` 的 active 唯一性靠 `UPDATE` 既有行 + `ORDER BY created_at DESC, rowid DESC`，**无 DB 级唯一约束** | 单进程串行写入下安全 | 低 |
| C-3 | 医生端写接口**只校验 `doctorId` 存在、不校验请求者身份** | 无会话层，刻意取舍 | 中（演示环境可接受） |
| C-4 | **实际没有 polling**（全项目 `setInterval` 零命中） | 实时性 = 按需拉取 + 对话 / 协同 SSE；跨端变更需重新进页面 | 低 |
| C-5 | `badges` 只有 seed 写入，**运行时不解锁新勋章** | 只能展示「还差多少」 | 低 |
| C-6 | `evaluateBloodPressure` 用 `diaValues[i]` 与 `sysValues[i]` **位置配对** | 两序列各自过滤 null；当前不可达（`toRecordView` 恒同时输出两别名） | 当前无 |
| C-7 | `remember()` 注释写 LRU，实为 **FIFO** | 演示规模（上限 200）无影响 | 无 |
| **C-8** | **新增 · 预警是「按患者 + 规则 + 日」的每日快照** | `persistRuleAlerts` 去重键含 `substr(created_at,1,10)`，跨日会各留一行；前端 `GET …/alerts?limit=20` **不按日期过滤**，首页 `alerts.slice(0,5)` → 跨天使用同一账号会出现**重复卡片** | 低（单日演示不显现） |

> C-8 是 v2 在 D-1 修复的**副作用排查**中新发现的：修复前主库 09-15 的 `patient_1 / R-BG-2` 正是 D-1 的产物；复核时确认该表为**每日快照**语义，故跨日重复是设计代价而非回归。**未删除任何历史行** —— 不以删数据的方式换取首页观感。

### 2.4 D 类 —— 当前确实存在的逻辑未定义或潜在漏洞

| # | 问题 | 触发场景 | 当前影响 | 影响答辩 | 必须现在修 |
|---|---|---|---|---|---|
| D-3 | 提案审结两步写入非原子 | 两次写入之间进程被终止 | 覆盖包已生效但提案仍待审；重复点「同意」产生多余版本（幂等替换，不损坏数据） | ❌ 不影响 | ❌ 不必（结构性改动） |

**D-1 / D-2 已从 D 类移出**（见 §1.1 / §1.2）。

### 2.5 E 类 —— 未来扩展，不影响当前版本（8 条，未变）

`prescriptions` 拆表 · `patient_targets` 正式版本化 · Proposal 状态机落库 · AI 辅助分落库 · 实时推送（polling / WebSocket）· 规则与模型的可配置化扩展 · 多模态与语音 · 登录鉴权与会话层。

---

## 3. 本系统当前能够被证明的结论

以下每一条都有**代码或已执行验收**支撑（§4）。

1. **今日任务完全由确定性规则派生**，`source` 恒为 `rule`；AI 无法新增规则外任务。
2. **医学判定不过模型**：13 条规则的阈值与命中由 `clinicalRules` 计算，模型不参与。
3. **AI 无法修改阈值、数据与任务**：`tools.js` 无写操作；`clinicalRules.js` 在评分评估前后逐字节不变（断言 15）；`patient_targets` 全部行逐项相等（断言 15b）。
4. **AI 不能直接给分**：模型只能输出 `adjustments[]`（意见），分数由确定性函数合成。
5. **AI 不可用不影响主流程**：回落 Rule Score，页面照常显示。
6. **医生审结前患者端零变化**：提案在 `pending` 期间不生效。
7. **写入面收敛**：仅 12 张表可写，集中在 5 个数据服务文件；取数契约层与智能体工具层均为零写操作。
8. **降级开关可控**：`ALLOW_MOCK_FALLBACK=false` 时真实错误原样抛出。
9. **同一套医学风险判定来源**（**v2 新增能力**）：briefing / alerts / 医生端三级同源，四位患者 4/4 一致。
10. **未记录不会被当作有效测量**（**v2 新增能力**）：`NULL` 与 `0` 严格区分；缺测既不进分子也不进分母。
11. **15 个验收脚本全绿**：456 / 457（唯一非绿为 `verify-register-flow` 脚本硬编码患者总数的既有问题，见 §4）。

### 当前**不能**被证明 / 不应声称的

| 不再适用的旧限制 | 状态 |
|---|---|
| ~~等级唯一无冲突~~ | ✅ **D-2 已修，现可声称** |
| ~~未记录不计入~~ | ✅ **D-1 已修，现可声称** |

| 仍然不能声称 | 原因 |
|---|---|
| 阈值有医学指南依据 | B 类，仅有项目内 Demo 规则声明 |
| AI 辅助分是临床评分 | L3 仅为辅助展示，不参与任何分级 |
| 具备实时同步 | C-4，无 polling / WebSocket |
| 具备账号鉴权 | C-3，医生端写接口不校验请求者身份 |
| 数据可跨日无重复呈现 | C-8，预警为每日快照，跨日会出现重复卡片 |

---

## 4. 验收证据（v2 基线）

**15 个脚本 / 456–457 条断言。**

**契约类（8 个脚本，跑在 `MYCARE_DB_PATH` 指向的副本库上）—— 257 / 257**

| 脚本 | 断言 |
|---|---|
| `verify-step4` | 26 / 26 |
| `verify-step5` | 28 / 28 |
| `verify-step6` | 46 / 46 |
| `verify-readings` | 21 / 21 |
| `verify-daily-tasks` | 29 / 29 |
| `verify-doctor-task-override` | 49 / 49 |
| `verify-task-proposal` | 29 / 29 |
| `verify-fallback-flag` | 29 / 29 |

**浏览器 / 端到端类（6 个脚本，跑在真实 3000 / 3001）—— 168 / 169**

| 脚本 | 断言 |
|---|---|
| `verify-task-actions` | 19 / 19 |
| `verify-ui-routes` | 15 / 15 |
| `verify-auth-gate` | 16 / 16 |
| `verify-health-score` | 30 / 30 |
| `verify-ai-score` | 64 / 64（须带 `MYCARE_DB_PATH`；不设置为 63/63，见下） |
| `verify-register-flow` | 24 / 25（已知脚本硬编码问题） |

**缺陷修复定向验收（v2 新增）—— 31 / 31**

`scripts/db/verify-step11-fixes.mjs`：自起副本后端（3062），覆盖反事实实验、真 0 保真、缺测语义、`assessRisk` 零阈值静态扫描、四患者三级一致性、真实库零改动。

**⚠️ 两条容易误判为回归的计数说明**

1. `verify-ai-score` 末条断言 `Z2`（出厂真实库零改动）**仅在 `MYCARE_DB_PATH` 指向副本库时才注册**。不设环境变量 → 63/63；按基线口径 → 64/64。**不是回归。**
2. `verify-register-flow` 把「医生端患者总数」硬编码为「3 示范 + 1 新注册」，而真实注册账号 `patient_4「赵小川」` 让计数变 5 → 稳定 24/25。**待改为吃环境变量 + 动态计算期望值。**

**每组测试实际证明了什么（不只是绿数）**

| 组 | 实际证明的能力 |
|---|---|
| step4 / step5 | 前端经真实 HTTP 拿到数据；Agent 数据链路可用 |
| step6 | 端到端主流程在副本库上跑通，真实库零改动 |
| readings | 一天多次测量「追加不覆盖」；兼容层取值口径确定 |
| daily-tasks | 任务频次来自规则常量；服药任务拆实例；进度由当日有效记录派生 |
| doctor-task-override | 覆盖契约的 14 类错误码逐条拦截；真实浏览器里医生改值 → 患者端生效 |
| task-proposal | 对话提案 → 医生审核；后端以空 Key 启动验证 F-7 确定性通道 |
| fallback-flag | 降级开关的两个方向都真实改变行为 |
| health-score | 缺测不得满分；分母按疾病谱；三端同源；AI 辅助分不得当主数字 |
| ai-score | 六条硬约束逐条拒绝；clamp 与守恒；缓存命中不重调模型；三层真实同屏；对 `clinicalRules` / `patient_targets` / alerts 零影响 |
| step11-fixes | 反事实量化 D-1 影响并证明修复；四患者三级一致 |

---

## 附：本次复核的取证方式（可复核）

| 手段 | 用途 |
|---|---|
| **反事实实验** | 复制同一份数据，只改一个变量（有无 `?? 0` 伪造），实跑对照量化缺陷影响 —— D-1 的对照表由此得出 |
| **静态扫描** | 对 `assessRisk()` 函数体做阈值 / 等级字面量零命中检索（断言 6a）；对 `tools.js` 做写操作零命中检索（A-3） |
| **集合级比对** | 逐表 `SELECT *` → 每行 `JSON.stringify` 入 `Set` → 求对称差；**不使用行序敏感哈希**（重建会改变物理行序，产生假阳性） |
| **副本库隔离** | 所有写入型验收一律在 `MYCARE_DB_PATH` 副本上执行，真实库 `data/mycare.db` 以 mtime + size 前后比对自证零改动 |
| **线上冒烟** | 对运行中的 3001 直接发起真实请求，读取四位患者的 briefing / 规则命中 / 落库预警并交叉比对 |

---

## 结论

- **D-1 关闭**：根因消除，反事实实验复现吻合，真 0 保真，缺测语义在规则层内统一。
- **D-2 关闭**：`clinicalRules` 是唯一风险等级裁定者，briefing / alerts / 医生端三级 4/4 一致。
- **D-3 保留**，不影响当前答辩，需结构性改动，排下一阶段。
- **B / C / E 类冻结**，作为「当前版本限制与后续方向」如实披露。
- **未修改** schema、migration、`clinicalRules` 阈值、既有测试断言。
