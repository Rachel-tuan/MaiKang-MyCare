# 迈康 MyCare · Step 11 Final Logic Audit

> 审计日期：2026-09-16　｜　审计范围：Step 11 Phase 1 / 2 / 3 全部落地后的**当前实际状态**
> 审计方式：**只读核查**。逐一阅读当前代码、当前数据库、当前 README / MEMORY、当前验收脚本，
> 并**实跑**线上接口与反事实实验取证。**未修改任何业务代码、未修改任何测试、未放宽任何约束。**

## 0. 审计立场（先声明三条）

1. **本报告不证明"系统绝对没有问题"。** 它只回答：*在当前已实现范围内，是否有已知的关键逻辑矛盾；核心规则、边界、数据流、AI 权限、降级机制是否都已定义且有代码或验收证据支撑。*
2. **一切结论以当前代码与实跑结果为准**，不以设计稿为据。凡设计稿写了、代码没写、或代码写了、设计稿没写的，一律以代码为准并在下文标注。
3. **发现的问题不做粉饰**。本次审计共发现 **3 项 D 类**（真实逻辑缺陷）与 **7 项 C 类**（工程折中 / 已知限制）。D 类中的 **D-1 是可复现的真实规则缺陷**，已给出反事实实验证据。

---

## 1. 逐项核查结论

### A. 规则与今日任务生成

| # | 核查项 | 结论 | 证据 |
|---|---|---|---|
| A1 | clinicalRules 是否仍是医学判定/阈值的**唯一**来源 | ⚠️ **部分成立** —— 见 **D-2**。对「任务升频 / alerts 落库 / 患者端与医生端预警卡片」是唯一来源；但**晨报顶部风险等级**走 `tools.assessRisk()` 另一套实现 | `src/utils/clinicalRules.js:1-13`；`server/agents/tools.js:267-340`；`server/index.js:585` |
| A2 | `buildDailyTasks()` 是否仍是今日任务唯一生成器 | ✅ 是。全项目只有 `patientService.getDailyTasks()` 调用它，任务不落库、纯派生 | `src/utils/dailyTasks.js:243-456`；`server/data/patientService.js:1207-1225` |
| A3 | 医生 override 是否只能修改已有任务参数 | ✅ 是。白名单仅 4 个 taskId，且只接受 `target` / `slots` / `enabled`(恒拒 false)；`applyOverridesToTasks` 只在传入任务数组上就地改参，不增不删 | `src/utils/taskOverride.js:67-95`；`src/utils/dailyTasks.js:178-219` |
| A4 | 是否存在任何 API / 前端路径可以创造规则未生成的 task | ✅ 不存在。① 覆盖包必须命中 `ctx.generatedTaskIds`（`E_TASK_NOT_GENERATED_FOR_PATIENT`）；② 唯一写库出口 `applyOverridePackage()` 只写 `prescriptions` / `patient_targets`，**从不 INSERT 任务表**（今日任务本就无表）；③ 智能体工具层 `tools.js` **无任何写库语句** | `src/utils/taskOverride.js:184-188`；`server/data/taskOverrideService.js:146-238`；`server/agents/tools.js`（无 `INSERT/UPDATE/DELETE`） |
| A5 | task source 是否始终保持 `rule` | ✅ 恒为常量。`TASK_SOURCE='rule'` 是模块常量，覆盖层只挂 `override` 子对象、**从不改写 `source`** | `src/utils/dailyTasks.js:108, 282, 317, 349, 373, 399, 422, 441, 447-455` |
| A6 | override 是否只作为附加信息返回 | ✅ 是。`applyOverridesToTasks` 挂 `next.override = {applied,by,at,basis,fields}`，不覆盖任务本体字段；`getDailyTasks` 另下发 `taskOverrides` / `overridePackage` 供界面标注 | `src/utils/dailyTasks.js:216`；`server/data/patientService.js:1232-1233` |
| A7 | steps / exercise / bp_monitor / bg_monitor 字段语义是否完全一致 | ⚠️ **不完全一致（有意的）**。四者都是「规则域 → target + slots」的同一骨架，但语义分层不同：`bp_monitor`/`bg_monitor` 由 `slots.length` 决定 `target`（`targetIsSlotCount: true`）；`steps`/`exercise` 只有 `target`，`slots: []`；`weight_record`/服药项另有 `slots` 形态。差异**被契约显式登记**，不是漂移 | `src/utils/taskOverride.js:66-95`；`src/utils/dailyTasks.js:272-352, 389-405` |
| A8 | 是否存在 target / slots 之间不一致的可能 | ✅ **当前不可达**。契约将二者互斥：`bp_monitor` 只放行 `slots`（传 `target` → `E_UNKNOWN_FIELD`），`steps`/`exercise` 只放行 `target`（传 `slots` → `E_UNKNOWN_FIELD`）。故 `applyOverridesToTasks` 中「先按 slots 定 target、再被显式 target 覆盖」的分支**永远只可能走一条** | `src/utils/taskOverride.js:80-94`；`src/utils/dailyTasks.js:194-214`；验证见 `doctor-task-override` A22/A23/A24 |

**A 段小结**：任务生成链路是干净的单一来源；唯一破口在 A1 的「第二套风险判定」，已单列为 D-2。

---

### B. 医生任务调整

| # | 核查项 | 结论 | 证据 |
|---|---|---|---|
| B1 | `validateOverridePackage` 是否真的是唯一校验标准 | ✅ 是。医生端 PUT、提案审核 approve/modify、提案意图通道**三处全部调用它**，无第二套判定 | `server/index.js:430`；`server/data/proposalService.js:406`；`server/agents/proposalIntent.js:302` |
| B2 | PUT task-overrides 与 proposal review(modify) 是否使用同一校验 | ✅ 是，且**同一个 ctx 构造方式**（`generatedTaskIds` + `primaryDisease` + `diseases`） | `server/index.js:427, 430`；`server/data/proposalService.js:285-298, 406`；验证 `task-proposal` A19 |
| B3 | 前端是否存在绕过后端校验的路径 | ✅ 不存在。前端仅做即时提示（如「依据必填」），准入判定在后端路由；即使直接构造 HTTP 请求也必须过 `validateOverridePackage` | `src/components/Doctor/TaskOverrideDrawer.jsx`；`server/index.js:422-453`；验证 `doctor-task-override` B6（前端拦下）/ A17-A31（直打后端仍被拒） |
| B4 | patient_targets 是否仍然使用既有读取链 | ✅ 是，且**4 处读取全部加固**为 `ORDER BY created_at DESC, rowid DESC` | `server/data/dataProvider.js:379, 613`；`server/data/patientService.js:229`；`server/data/taskOverrideService.js:117-120` |
| B5 | 是否仍然保证 UPDATE 而不是错误 INSERT | ✅ 保证。`applyOverridePackage` 与 `revokeOverride` 均是「有行就 UPDATE，0 行才 INSERT」 | `server/data/taskOverrideService.js:210-222, 269-274, 317-323`；验证 `doctor-task-override` A9/A11/A13 |
| B6 | basis 是否完全避免污染 `patient_targets.basis` | ✅ 完全避免。全项目**没有任何语句写 `patient_targets.basis`**；调整依据只进 `prescriptions.target_goals.basis` | `server/data/taskOverrideService.js:207-222`（UPDATE 只写 `steps_target, set_by`）；验证 `doctor-task-override` A10 |
| B7 | prescription version 是否正确失效旧版本 | ✅ 正确。同事务内先 `UPDATE ... SET is_active=0`（且 `LIKE '%"kind":"task_override_package"%'` **只命中覆盖包行**），再 INSERT 新版本 | `server/data/taskOverrideService.js:192-205, 304-314` |
| B8 | 当前 active override 的读取是否唯一且 kind 正确 | ✅ 唯一且 kind 正确。`readEffectiveOverrides` 要求 `kind==='task_override_package'` 且 `contractVersion===1`，否则返回 null | `server/data/taskOverrideService.js:68-96`；`src/utils/taskOverride.js:279-296` |
| B9 | revoke 后是否完整回落规则值 | ✅ 完整。剩余覆盖为空 → 整包失效 + 步数目标还原到 `previousStepsTarget`；剩余非空 → 生成去项后的新版本 | `server/data/taskOverrideService.js:247-335`；验证 `doctor-task-override` A12/A13/A16 |
| B10 | 是否存在并发/重复提交导致两个 active version 的风险 | ✅ 当前不可达。① `BEGIN IMMEDIATE` 取写锁；② `node:sqlite` 是**同步** API 且本链路**无 await 插入事务中间** → 单进程内不存在交错；③ 旧版本失效与新版本写入**在同一事务** | `server/data/taskOverrideService.js:192-225` |

**B 段小结**：B 段 10 项全部通过，且每一项都有验收脚本的对应断言（A17–A31 覆盖 13 类错误码）。

---

### C. AI Proposal 完整链路

链路实证（`task-proposal` 29/29）：
`患者原话 → proposalIntent（预筛+抽取）→ currentValue 后端注入 → 白名单过滤 → validateOverridePackage → pending(is_active=0) → 医生审核 → approve/modify/reject → applyOverridePackage`

| # | 核查项 | 结论 | 证据 |
|---|---|---|---|
| C1 | AI 永远不能直接修改患者任务 | ✅ 成立。`proposalIntent.js` **不写库**、**不引用** `applyOverridePackage`；`proposalService.createOrUpdateProposal()` 只写 `is_active=0` 的提案行 | `server/agents/proposalIntent.js:19-21`；`server/data/proposalService.js:258-262` |
| C2 | approve 前患者任务严格零变化 | ✅ 成立，且**由读取口径保证**（`getDailyTasks` 只读 `is_active=1`），无需额外判断 | `server/data/patientService.js:1201-1202`；验证 `task-proposal` A7「逐字段一致」 |
| C3 | currentValue 不可信输入来自模型 | ✅ 已杜绝。`currentValue` 一律由 `getEffectiveTaskState()` 现算注入；模型/患者的返回值被丢弃 | `server/agents/proposalIntent.js:308-310`；验证 `task-proposal` A9（消息里写 `currentValue=1`，落库仍为后端值 8000） |
| C4 | unknown task / field / threshold / out-of-range 是否都正确处理 | ✅ 全部正确处理，且**非法项不生成提案**（计入 filtered），不落库 | `server/agents/proposalIntent.js:297-321`；验证 `task-proposal` A10（阈值 160 → filtered）/ A11（停用 → 不进库）/ A13（未生成域） |
| C5 | 单轮 ≤2 | ✅ 双层兜底：通道 `slice(0,2)` + 服务层 `list.slice(0, PROPOSAL_MAX_PER_TURN)` | `server/agents/proposalIntent.js:325`；`server/data/proposalService.js:205`；验证 `task-proposal` A12 |
| C6 | pending 去重是否真的更新而不是重复创建 | ✅ 成立。同 `patient+taskId+field` 命中 pending → UPDATE 该行并刷新 `generated_date`，行数不变 | `server/data/proposalService.js:187-238`；验证 `task-proposal` A8「prescriptions rows 1→1」 |
| C7 | 7 天过期逻辑是否一致 | ✅ 一致：`isProposalExpired()` 单一实现（`generated_date + 7d < now`），**懒判定不写库**；`toProposalView` 的 `status='expired'` 是**派生字段**（JSON 内恒为 `pending_review`） | `server/data/taskOverrideService.js:33, 342-346`；`server/data/proposalService.js:86-110`；验证 `task-proposal` A20（`doctor_modified=0` 未被改写） |
| C8 | reject 是否绝不改变患者任务 | ✅ 绝不。分支内只有 `UPDATE prescriptions` + 写一条医生建议，**无任何** `applyOverridePackage` / `patient_targets` 写入 | `server/data/proposalService.js:359-396`（含 L380 显式红线注释）；验证 `task-proposal` A16「unchanged=true」 |
| C9 | modify 是否重新经过后端验证 | ✅ 是。走与 PUT 完全相同的 `validateOverridePackage`，越界即 400 且患者端不变 | `server/data/proposalService.js:401-409`；验证 `task-proposal` A18/A19 |
| C10 | 有 Key / 无 Key 两条路径是否真的一致 | ✅ 一致。`buildProposalEvents()` 在**分支之前调用一次**，两种分支复用同一 `proposalEvents` 数组 | `server/index.js:766, 776（降级分支）, 818（模型分支）`；验证 `task-proposal` A23「emitCount=2」 |
| C11 | proposal kind 与 active task_override_package 是否完全隔离 | ✅ 完全隔离。读取端 `readEffectiveOverrides` 只认 `task_override_package`；提案查询另行限定 `created_by='agent' AND is_active=0 AND doctor_modified=0` | `src/utils/taskOverride.js:282`；`server/data/taskOverrideService.js:349-356` |
| C12 | `getActivePrescription(s)` 是否不会误读 proposal | ✅ 不会。两个 getter 均通过 `isHealthPrescription()` 显式排除两种 kind | `src/contexts/HealthDataContext.jsx:372-379` |

**C 段小结**：12 项全部通过。唯一需要记录的结构性问题是**审结写入的非原子性**（见 **D-3**）。

---

### D. AI Score 三层（17 项）

| # | 核查项 | 结论 | 证据 |
|---|---|---|---|
| D1 | Rule Score 与原有 deterministic rules 完全一致 | ✅ 唯一实现。前端 `getHealthScoreDetail()` 与后端 `tools.computeHealthScore()` 都调用 `computeDailyHealthScore()` | `src/utils/healthScore.js:134-217`；`server/agents/tools.js:14, 233-264`；`src/contexts/HealthDataContext.jsx`；验证 `health-score` 20「界面=本地=晨报」、`ai-score` 1a-1m |
| D2 | AI 不直接生成 0–100 分 | ✅ 成立。提示词明令禁止；`buildAiAssessment` **只消费 `adjustments`**，模型若返回 `score` 字段无处可读 | `src/utils/aiScore.js:349-393`；`server/data/aiScoreService.js:145-165`；验证 `ai-score` 9d |
| D3 | adjustment 的 dimension 有患者适用性约束 | ✅ 有。`applicableDimensions` 由 Rule Score 分母实际维度派生，提示词动态下发，校验器再拦一次 | `server/data/aiScoreService.js:124-126`；`src/utils/aiScore.js:231-238`；验证 `ai-score` 8b / 8d（经真实路由） |
| D4 | 单条 delta ∈ [-5,+5] | ✅ | `src/utils/aiScore.js:36-38, 257-264`；验证 `ai-score` 3 / 3b |
| D5 | Σ\|delta\| ≤ 10 | ✅ | `src/utils/aiScore.js:40, 278-284`；验证 `ai-score` 4 / 4b |
| D6 | dimension 不允许重复 | ✅ | `src/utils/aiScore.js:239-247`；验证 `ai-score` 7 / 7b |
| D7 | reason 必须存在 | ✅ 去空白后 1–80 字 | `src/utils/aiScore.js:42-43, 265-272`；验证 `ai-score` 5 / 5b |
| D8 | 非法 AI 输出是否整包拒绝 | ✅ 整包丢弃、不部分采纳（逐条收集后统一判定） | `src/utils/aiScore.js:286-296`；验证 `ai-score` 3–8c |
| D9 | 模型失败是否 fallback Rule Score | ✅ 回落，且接口**永不**因 AI 不可用而报错 | `server/data/aiScoreService.js:288-303`；验证 `ai-score` 12（401 → unavailable）/ 17 / 17b |
| D10 | JSON 失败是否 fallback Rule Score | ✅ 结构不合法 → `structural:true` → `unavailable`（**与"违反约束"分开报**） | `src/utils/aiScore.js:192-201, 352-360`；验证 `ai-score` 11 |
| D11 | assisted score 是否由确定性函数合成 | ✅ `composeAssistedScore()` 纯函数，前后端共用 | `src/utils/aiScore.js:321-334`；验证 `ai-score` 2 / 9 / 9b |
| D12 | clamp 边界是否正确 | ✅ 上界与下界均验证，且 `clamped/rawAssisted` **如实上报** | `src/utils/aiScore.js:326-333`；验证 `ai-score` 10（98+10→100/raw108）、10b（2-5→0/raw-3） |
| D13 | cache key 是否与 input snapshot 一致 | ⚠️ **不完全一致** —— 见 **C-1**。今日体征 + 疾病谱 + Rule Score 一致；但提示词还用了**近 7 日明细**，而 `inputHash` 未覆盖该窗口 | `src/utils/aiScore.js:129-160`；`server/data/aiScoreService.js:167-196` |
| D14 | inputHash 变化是否使缓存失效 | ✅ 使其失效 | `server/data/aiScoreService.js:234-263`；验证 `ai-score` 14 / 14b（改当日 steps 后重新生成） |
| D15 | AI-assisted Score 是否绝不参与 alert / grade / 达标率 | ✅ 绝不。它只在 `aiScoreService` 内合成，不回流任何规则常量；实跑对照证明"rule 变而等级不变" | 验证 `ai-score` 18 / 18b / 18c / 18d、15（`clinicalRules.js` 逐字节未变）、15b（`patient_targets` 全部行未变） |
| D16 | UI 是否永远把 Rule Score 作为主数字 | ✅ 永远。主数字 `.health-score` = 本地 Rule Score；AI 分为次级区块并带 `[AI 辅助]` 标签 | `src/pages/HomePage.jsx:966, 981-1030`；验证 `ai-score` 16、`health-score` 26 |
| D17 | AI unavailable 时是否不显示伪造的 AI 分 | ✅ 不显示。渲染以 `aiStatus === 'ok' && ai` 为前提；否则只显示后端下发的文案 | `src/pages/HomePage.jsx:993, 1032-1040`；验证 `ai-score` 17 |

**D 段小结**：17 项中 16 项通过；D13 存在**缓存键覆盖不足**（列为 C-1）。

---

### E. 数据层

**表清单**：`sqlite_master` 实测 **22 张**（与 P0 冻结一致）。

| 表 | 定性 | 允许写入方 | AI 可否写 |
|---|---|---|---|
| `daily_health_records` | **事实层（日粒度兼容层）** | `patientService.upsertDailyRecord` / `recomputeDailyCompat` / 注册 | ❌ |
| `blood_pressure_readings` / `blood_glucose_readings` / `medication_logs` | **事实层（分钟粒度，纯追加）** | `appendBloodPressureReading` / `appendBloodGlucoseReading` / `appendMedicationLog`——**只有 INSERT，无 UPDATE/DELETE** | ❌ |
| `patients` / `patient_conditions` / `patient_lifestyle` / `patient_contacts` | 档案层 | `registerPatient` / `resetPatientPassword` | ❌ |
| `patient_targets` | **规则层（个体化目标）** | `applyOverridePackage`（UPDATE 优先）/ `revokeOverride` | ❌（只能经医生审结间接改 steps 目标） |
| `prescriptions` | **覆盖层 + AI 建议层（同表，kind 判别）** | 覆盖包 ← `taskOverrideService`；提案 ← `proposalService` | ⚠️ 仅能写 `is_active=0` 的提案行 |
| `alerts` | 规则结论层 | `alertService.persistRuleAlerts`（幂等 upsert） | ❌ |
| `doctor_notes` | 医生结论层 | `doctorNoteService.createDoctorNote`（FK 强校验医生存在） | ❌ |
| `badges` / `badge_definitions` | 静态种子层 | **仅 seed**（运行时零写入） | ❌ |
| `doctors` / `doctor_patient_relations` / `lab_results` / `medications` / `metric_definitions` | 静态配置层 | **仅 seed**（运行时零写入） | ❌ |
| `agent_runs` / `reminders` / `vision_records` | 已建**未持久化** | **全项目零写入** | ❌ |

| # | 核查项 | 结论 |
|---|---|---|
| E1–E4 | 事实层 / 规则层 / 覆盖层 / AI 建议层的划分 | ✅ 已划分且可机械判定：事实层是「只 INSERT」的三张 readings 表；规则层是 `patient_targets`；覆盖层与 AI 建议层**共用 `prescriptions` 一表，靠 `target_goals.kind` 判别** |
| E5 | 哪些允许写入 | ✅ 上表「允许写入方」列即全部；写入点已完全收敛（`grep INSERT/UPDATE/DELETE` 覆盖 6 个服务文件） |
| E6 | 哪些绝不允许被 AI 修改 | ✅ 所有事实层、`patient_targets` 的医学阈值列、`alerts`、`doctor_notes`、`clinicalRules.js` 常量。已由验收断言锁死（`ai-score` 15 / 15b、`task-proposal` A24、`doctor-task-override` A10） |
| E7 | 有没有同一事实被两个表同时作为"真值" | ⚠️ **有一处，但已被显式登记**：`daily_health_records`（日粒度兼容层）与三张 readings 表对「当日血压/血糖」并存。**设计上兼容层是"保守兼容代表值"**，并非第二真值；口径写在 MEMORY 红线 9。**但另有一处未登记的"双真值"：风险等级**，见 **D-2** |
| E8 | 是否存在未来状态扩展会造成语义冲突的问题 | ⚠️ 有 2 处需登记：① `prescriptions` 一表三义（健康处方 / 覆盖包 / 提案）全靠 JSON 内 `kind`，**无法建索引、无法纯 SQL 约束**，新增第四种用途会加剧；② `patient_targets` 用「同一行 UPDATE + `created_at DESC, rowid DESC` 兜底」表达版本，缺 DB 级唯一约束（见 **C-2**） |

---

### F. API 与前端

| # | 核查项 | 结论 | 证据 |
|---|---|---|---|
| F1 | API response 与实际 UI 是否一致 | ✅ 一致。抽查三处：评分卡（`rule`/`ai.assisted`/`sumDelta`/`clamped` 全部上屏）、今日任务（`override` 回显 → 徽标）、提案（`pending_review` → 卡片） | `src/pages/HomePage.jsx:966-1030`；验证 `ai-score` 16/16c、`doctor-task-override` B10/B11、`task-proposal` B3 |
| F2 | 前端显示值是否直接来自正确的后端字段 | ✅ 是。医生签名不前端拼装（后端 `toNoteView()` 从 `doctors` 表注入）；时段展示「午后」/落库「下午」有唯一映射表 | `server/data/doctorNoteService.js:48-63`；`src/utils/dailyTasks.js:28-33` |
| F3 | 医生端 / 患者端权限是否一致 | ⚠️ **本版本未做鉴权，两端接口均可被任意调用**。医生端写接口只校验「医生存在」（`assertDoctorExists`），不校验「当前登录者是不是该医生」。这是**刻意的演示取舍** | `server/index.js:426, 459, 533, 555`；见 **C-3** |
| F4 | 是否存在"按钮显示可以做，但后端其实不能做" | ✅ 不存在。抽屉只渲染 `target` / `slots` 编辑器，**不渲染停用开关**；停用项按 D4 显示禁用态与明确文案 | `src/components/Doctor/TaskOverrideDrawer.jsx:9, 214-255` |
| F5 | 是否存在后端允许但 UI 无法表达的状态 | ⚠️ 有 1 处轻微：契约允许 `exercise.target`（5–180，非 500 倍数）与 `bg_monitor.slots`；糖尿病患者才有 `bg_monitor`，无糖尿病的患者该域**后端拒绝、UI 也不显示**，两侧一致。**唯一不对称**是 `E_TARGET_NOT_MULTIPLE_OF_500` 的步数约束在 UI 用 `step={500}` 表达了，但 `exercise` 的整数无 `multipleOf` → 一致，无缺口 | `src/utils/taskOverride.js:67-95` |
| F6 | SSE / polling 是否有状态不同步的情况 | ⚠️ 见 **C-4**：**全项目没有任何 `setInterval` 轮询**；SSE 只用于 `/agent/chat` 与 `/agent/orchestrate`；其余数据（今日任务、预警、医生建议、徽标）依赖**进入页面时拉取**。因此"医生改了任务，患者端不重新进入页面不会自动更新" | `grep setInterval src` → 0 命中；`src/services/agentApi.js:49, 111, 116` |

---

### G. 测试与证据（分类，并说明每组**实际证明了什么**）

当前共 **13 个脚本 / 401 条断言**（另有 `verify-register-flow` 25 项独立格式）。

| 类别 | 脚本（断言数） | **实际证明了什么**（不是"多少绿"） |
|---|---|---|
| **1. 规则正确性** | `verify-ai-score` §1（1a–1m，13 条）、`verify-health-score`（30）、`verify-daily-tasks`（29）、`verify-readings`（21） | 证明 **Rule Score 口径**：① 缺测**不得**满分（回归 Step 10 修掉的"缺测=满分"缺陷）；② 分母按疾病谱适用维度固定、不随数据漂移；③ 步数阶梯**整条单调不减**（9999 步越不过 10000 步档）；④ 分档阈值统一 85/70/55。并证明**一天多次测量是追加不覆盖**、当日任务的进度由 readings **实时派生**、频次只来自规则常量 |
| **2. 数据一致性** | `verify-step6`（46）、`verify-ai-score` 13/13b/14/14b/15/15b/Z1/Z2、`verify-doctor-task-override` A9/A10/A11/A13、`verify-task-proposal` A7/A8/A24 | 证明 **"改动只发生在该发生的地方"**：① `clinicalRules.js` 评估前后**逐字节未变**；② `patient_targets` 全部行**逐项相等**（AI 未碰目标值）；③ 提案全程**不写事实层**（readings / medication_logs 零新增）；④ 缓存命中**不重复调模型**、`inputHash` 变化即失效；⑤ 真实库 `mycare.db` 与演示副本库 mtime+size **零改动** |
| **3. 安全边界** | `verify-doctor-task-override` A17–A31（13 类错误码）、`verify-task-proposal` A9/A10/A11/A13/A19/A22、`verify-ai-score` 3–8c/15/18/18b/18d | 证明**"越权做不到，且报错可分"**：未知任务域 / 白名单内不可覆盖 / 该患者当日未生成 / 医学阈值字段 / 白名单外字段 / 非 500 倍数 / 越界 / 空 slots / 重复 slots / 停用主诊断项 / 停用非主诊断项 / 依据缺失 / 空包 / 契约版本 —— **14 类输入各自返回专属错误码**，且**一合法一非法 → 整包拒绝、库零变化**；重复审结 409、不存在 404 |
| **4. AI 降级** | `verify-ai-score` 11/12/17/17b、`verify-fallback-flag`（29）、`verify-task-proposal` A2/A23 | 证明**"AI 挂了不影响主流程"**：非法 JSON → `unavailable`；模型 401 → `unavailable` **且接口不报错**；降级时界面**不显示** AI 辅助分但 Rule Score 仍在；`ALLOW_MOCK_FALLBACK` 开关两态行为正确；**无 Key 环境下整条提案链路仍可演示** |
| **5. UI** | `verify-ui-routes`（15）、`verify-task-actions`（19）、`verify-doctor-task-override` B 组（14）、`verify-task-proposal` B 组（4）、`verify-ai-score` 16–16e、`verify-health-score` 19–26 | 证明**"界面看到的与后端算的一致"**：逐路由无致命告警、任务卡点击跳转并聚焦、医生抽屉改值→患者端徽标→撤销消失的完整回流、提案卡片明示"审核前任务不变"、**主数字恒为 Rule Score 且 AI 区块必带标签与免责脚注**。并含**反假结果守卫断言**（`含「今日健康评分」&& !含登录入口`），从结构上堵死"回落登录页导致的集假失败/假通过" |
| **6. 回归** | `verify-step4`（26）、`verify-step5`（28）、`verify-step6`（46）、`verify-readings`（21）、`verify-daily-tasks`（29） | 证明 Step 4/5/9/11 的既有契约**未被本次改动破坏**：前端 API 接入链路、Agent 取数链路、动态任务覆盖层不改变任务域 |
| **7. 真实运行冒烟** | `verify-auth-gate`（16，真实浏览器 + 真实前后端 + 真实注册后清理）、本次审计的线上 `curl` 探针 | 证明**"先注册后才能登录"**端到端闭环、换号后晨报不残留；本次审计另**实跑**线上接口验证三层评分契约（`rule=67 / sumDelta=-6 / assisted=61 / clamped=false`）与晨报风险等级 |

---

### H. 来源审查（区分"系统怎么工作"与"为什么这么定"）

#### H-1 项目内部依据 —— 回答"系统实际上是怎么工作的"

| 依据 | 位置 | 它定义了 |
|---|---|---|
| 规则引擎 | `src/utils/clinicalRules.js` | 13 条命名规则（R-BP-1…R-WT-5）、4 级产品词表、血压/血糖/体重行为的判定与统计 |
| 任务生成 | `src/utils/dailyTasks.js` | 任务域、频次表（血压 2/3 次、血糖 2/3 次、运动 30 min、步数兜底 8000）、覆盖层应用 |
| 评分 | `src/utils/healthScore.js` | 权重 30/25/25/20、分档 85/70/55、各维度达成率阶梯 |
| 覆盖契约 | `src/utils/taskOverride.js` | 可覆盖 taskId 白名单、字段契约、14 类错误码、kind 判别 |
| 评分契约 | `src/utils/aiScore.js` | 六条硬约束、三态、合成与 clamp 公式、`inputHash` |
| 数据库 schema | `src/database/schema.sql` | 22 张表 + CHECK 枚举（时段、measure_type、note_type…） |
| API 契约 | `server/index.js`（33 条路由） | 入站只收 `patientId`，后端自取数 |
| 验收脚本 | `scripts/db/verify-*.mjs` | 401 条可执行断言 |
| 项目文档 | `README.md`（§7.4 等）、`.workbuddy/memory/MEMORY.md` | 口径与红线 |

#### H-2 外部依据 —— 回答"为什么采用这些医学指标与阈值"

**结论：外部依据目前只覆盖"演示病例的疾病谱与个体化目标"，不覆盖任何算法阈值。**

| 引用来源 | 出现位置 | 覆盖对象 |
|---|---|---|
| 《中国高血压防治指南（2024 年修订版）》 | `src/data/demoPatients.js:10` | 疾病谱设定 |
| 《中国老年高血压管理指南（2023）》 | `src/data/demoPatients.js:11, 90` | 张建国 `patient_targets.basis` = 140/90（可进一步 130/80） |
| 《中国 2 型糖尿病防治指南（2020 年版）》 | `src/data/demoPatients.js:12, 199` | 李秀英个体化控制目标 |
| 《肥胖症诊疗指南（2024 年版）》/《中国成人超重和肥胖预防控制指南 2021》 | `src/data/demoPatients.js:13, 318` | 王建军目标依据、BMI ≥28 / 腰围 ≥90 cm 判定说明 |

⚠️ **必须明确的边界（本报告不做越界表述）**：

1. `clinicalRules.js` 的 140/90、180/110、7.8、1.4、<60% 等阈值，**在代码中只以"本项目 Demo 判定阈值"出现**（`medical.demoThreshold` / `demoThresholdNote`），**没有**在任何一处标注为来自某指南的具体条款。
2. `healthScore.js` 的阶梯（步数 4000/6000/8000/10000、运动 15/30/60、血糖 7/8/10）文件头**明确自述为"本项目 Demo 规则，非临床指南"**。
3. `dailyTasks.js` 的频次表文件头**明确自述为"本项目 Demo 规则，非医学处方"**。
4. `aiScore.js` 的六条硬约束是**工程约束**（防止模型越界），不是医学标准。
5. `tools.assessRisk()` 的阈值（16.7/11.1、心率 120/45 等）**无外部引用**，且该函数**未在文件头声明其阈值来源**。

> 因此 H 段整体归入 **B 类**（已定义、有代码依据，**外部医学来源仍需整理**）。

---

## 2. 最终审计结果：五类结论

### A 类 —— 已明确定义，代码与测试均一致

1. **规则 → 任务的生成链路**（A2–A8、B1–B2）：`buildDailyTasks()` 是唯一生成器，任务不落库、纯派生，`source` 恒为 `'rule'`。
2. **覆盖包的唯一写库出口与三道关口**（B1、B5–B9）：白名单 + 原子校验 + 单事务 + 只 UPDATE 既有 `patient_targets` 行 + `basis` 不污染。
3. **提案链路的 AI 权限边界**（C1–C3、C6、C8–C12）：AI 只能写 `is_active=0` 的待审提案行，医生审结前患者端逐字段零变化。
4. **AI 评分的三层分离**（D1–D12、D14–D17）：模型只出 `adjustments`，合成由纯函数完成，守恒与 clamp 边界均有断言。
5. **降级链路**（D9–D10、C10、G-4）：模型未配置 / 401 / 非法 JSON 一律回落 Rule Score，接口不报错，界面不伪造 AI 分。
6. **数据写入面收敛**（E5–E6）：22 张表中仅 8 张有运行时写入，全部集中在 6 个服务文件；事实层三表只有 INSERT。

### B 类 —— 已定义、有代码依据，但外部医学来源仍需整理

1. **规则阈值**（140/90、180/110、7.8、1.4、<60%、HbA1c >3 个月）：代码可用、口径一致，但**未标注具体指南条款**。
2. **评分阶梯与权重**（30/25/25/20、4000–10000 步、15/30/60 min、7/8/10 mmol/L）：已自述为 Demo 规则，**缺外部锚点**。
3. **任务频次表**（血压 2/3 次、血糖 2/3 次、运动 30 min、步数 8000）：已自述为 Demo 规则，**缺外部锚点**。
4. **`tools.assessRisk()` 的阈值**（16.7/11.1、心率 120/45、睡眠、体重波动）：**连"Demo 规则"的自我声明都没有**，且与 clinicalRules 并存（见 D-2）。

### C 类 —— 已实现，但当前属于工程折中 / 已知限制

1. **C-1 `inputHash` 未覆盖近 7 日窗口**：提示词把近 7 日明细喂给模型，但缓存键只含「当日体征 + 疾病谱 + Rule Score」。若历史某天数值被回改而当日未变，缓存**不会失效**，AI 评估会停留在旧文本上。
   影响：低（应用只写当日记录）。*（对应 D13）*
2. **C-2 `patient_targets` 的"单行 + 排序兜底"版本表达**：靠 `UPDATE` 既有行 + `ORDER BY created_at DESC, rowid DESC` 兜底，**无 DB 级唯一约束**。未来若出现第二行写入，读取会静默返回其中一行。
3. **C-3 无登录鉴权 / 无医生身份校验**：医生端写接口只校验「`doctorId` 存在」，不校验请求者身份。**这是演示取舍**（无会话层设计），不是遗漏。
4. **C-4 实时性为"按需拉取"，且没有 polling**：全项目 `setInterval` 零命中；SSE 仅用于对话与协同。跨端变更（医生改任务 → 患者端）需要**重新进入页面**才可见。原设计文档中"realtime 采用 polling"的说法与实际不符 —— 实际连 polling 都没有。
5. **C-5 勋章为静态种子**：`badges` 只有 seed 写入，运行时不解锁新勋章；`R-WT-5` 只能展示"距离勋章还差多少"。
6. **C-6 血压序列的索引配对是"位置配对"**：`evaluateBloodPressure` 用 `diaValues[i]` 与 `sysValues[i]` 配对，而两条序列各自过滤了 null。**当前不可达**（`toRecordView` 恒同时输出两个别名），但一旦上游出现"只有收缩压没有舒张压"的记录，配对即错位。
7. **C-7 "极简 LRU" 实为 FIFO**：`remember()` 删除的是**最早插入**的键（`Map` 的 `set` 不改变已有键的顺序），注释写 `LRU` 不准确。演示规模（上限 200）下无实际影响。

### D 类 —— 当前确实存在逻辑未定义或潜在漏洞

> 3 项。**均未通过修改测试或降低约束来掩盖**。

---

#### 🔴 D-1（最高优先级）未记录的体征被读取为 `0`，同时制造假预警、掩盖真预警、虚高达标率

- **问题**：`server/data/patientService.js` 的 `toRecordView()` 为兼容视图模型补了一批 `?? 0` 别名（`bloodSugar: bloodSugar ?? 0`、`bloodPressure: { systolic: systolic ?? 0, diastolic: diastolic ?? 0 }`…）。而 `src/utils/clinicalRules.js` 的 `pick()` 候选键列表把 **DB 风格字段排在前面、视图模型别名排在后面**。当 DB 字段为 `NULL` 时，`pick()` 会**落到别名的 `0`**，于是"**未记录**"被当成"**测得 0**"进入规则序列。
  - `src/utils/clinicalRules.js:157-175`（`pick` + `FIELD_KEYS`）
  - `server/data/patientService.js:198-204`（`?? 0` 别名）
  - `src/utils/clinicalRules.js:185-189`（`seriesOf` 只过滤 `null`，**不过滤 `0`**）
- **触发场景**：某天**首次**只录入了部分指标（例如只录步数），该日其余指标为 `NULL`；只要同一序列里既有真实值又有该空白日，必然触发。
  （注：`upsertDailyRecord` 用 `COALESCE` 合并语义，**不会**把未提交字段写成 NULL —— 所以触发条件是"该日此前无行且本次只填了部分字段"。）
- **当前影响（已实测，不是推演）**：
  - 患者 1（`data/mycare.db`，`2026-09-15` 仅有步数）

    | 指标 | 现状（0 参与） | 反事实（未记录=null） |
    |---|---|---|
    | 最高预警等级 | `watch` 关注 | **`alert` 预警** |
    | 命中规则 | R-BG-2「血糖波动较大」 | **R-BP-2「血压连续升高」** |
    | 血压 7 天涨幅 | **−136** | **+22** |
    | 血糖极差 / 最低 | **5.8 / 0** | 0.6 / 5.2 |
    | 血压达标率 | 50% | 40% |

    即同一条缺陷**同时**造成：① **假预警**——未测血糖却命中「血糖波动较大｜7 天极差 5.8 mmol/L（最低 0）」，并已作为「关注」级**落库**到患者端与医生端；② **漏报真预警**——血压 136→158（+22）、连续 3 天 ≥140 本应命中 R-BP-2 预警，却因末位 0 使涨幅变负而**不命中**；③ **达标率虚高**（50% vs 40%）。
  - 与 Step 10 的关系：`healthScore.js` 已修掉"缺测=满分"，**但规则引擎的"达标率"仍是"缺测=达标"** —— 同一类缺陷在两个模块里一个已修、一个未修。
- **是否影响当前答辩**：**部分影响**。当前演示副本库三位患者**每天数据都完整**（已实测 21 行全无 NULL），故只读演示不显现。但以下两条演示路径会当场暴露：
  ① 演示"注册新账号 → 自己录入"，若第二天只录单项，即可复现；
  ② 演示"患者 1"时切到主库（含 09-15 空白日）会看到"血糖最低 0 mmol/L"这条不合理文案。
- **是否必须现在修复**：**建议修，且属于低成本高收益**。最小改法二选一（**本次审计未执行**）：① `toRecordView` 不再产出会与 DB 字段混淆的 `0` 别名（或把别名改为不参与 `pick` 的独立命名）；② `seriesOf` 增加 `value > 0` 之类的有效性过滤。修完需回归 `verify-health-score` / `verify-ai-score` / `verify-step6`（图表页与医生端依赖 `?? 0`，需一并核对）。

---

#### 🟠 D-2 两套并行的风险等级判定，导致**同屏矛盾**

- **问题**：`clinicalRules.js` 在文件头声明自己是"**唯一**的规则判定实现"，但 `/api/agent/briefing` 的风险等级来自 `tools.js` 的 `assessRisk()` —— 一套**独立**的等级词表（`critical/high/medium/low`）与**独立阈值**（收缩压 180/160、血糖 16.7/11.1、心率 120/45、睡眠、体重波动…），再映射成与 `ALERT_LEVEL` **同名**的标签（紧急/预警/关注/提示）。
  - `server/agents/tools.js:267-340`（判定与 `levelLabel` 映射）
  - `server/index.js:585`（`briefing` 用 `executor.risk()`）、`server/index.js:686-687`（`orchestrate` 用 `clinicalRules` + `persistRuleAlerts`）
  - `src/pages/HomePage.jsx:840`（渲染 `briefing.risk.label`）与 `:914-930`（渲染 alerts 卡片）—— **同页共现**
- **触发场景**：任何时候打开首页。两套实现阈值不同，结论可以不同甚至相反。
- **当前影响（已在线上接口复现）**：

  | 患者 | 晨报（同页顶部） | 落库预警卡片（同页下方） | 是否一致 |
  |---|---|---|---|
  | patient_1 | **预警**「指标达到预警等级，今天需要重点关注」 | 仅「关注 / 血糖波动较大」 | ❌ |
  | patient_2 | **关注**「整体可控，个别指标需留意」 | 「**预警** / 血糖控制不佳」 | ❌ |
  | patient_3 | **提示**「各项指标平稳，继续保持」 | 「关注 / 体重出现短期反弹」 | ❌ |
  | patient_4 | 提示 | 无 | ✅ |

  同屏出现"预警/关注"互相打脸；patient_3 更是"各项指标平稳"旁边挂着一条关注级预警。且因为**标签词表同名**，用户无法从文案上察觉这是两套系统。
- **是否影响当前答辩**：**影响**。这正落在首页最显眼的位置（晨报卡 + 预警卡），是评委最容易追问的一处。
- **是否必须现在修复**：**建议在答辩前处理**，但**不建议临时改代码**——最小风险做法是二选一并写进文档：① 明确"晨报风险等级"与"落库预警"是**两个不同用途的产品指标**（前者是"今日总体关注度"、后者是"规则命中明细"），并在 UI 上加一行说明；② 或让 `assessRisk` 的等级改由 `clinicalRules` 的 `highestLevel` 派生。**若时间紧张，最低限度必须在答辩口径中说明清楚，不能当作一处矛盾被当场发现。**
  > 附带风险：`tools.assessRisk()` 自身的阈值**无任何外部引用、也未自我声明为 Demo 规则**（见 B-4）。

---

#### 🟡 D-3 提案审结的"应用覆盖包"与"标记提案已审结"**不在同一事务**

- **问题**：`reviewProposal()` 先调用 `applyOverridePackage()`（自身单事务，已提交），随后**另起一条独立 UPDATE** 把提案行标记为 `approved`（`doctor_modified=1`）。两步之间若失败/进程中断，会出现「覆盖包已生效、提案仍显示待审」的状态；医生再次点"同意"会**再应用一次**（虽因覆盖是幂等替换而不至数据损坏，但会产生多余版本与重复医生建议）。
  - `server/data/proposalService.js:412-419`（应用覆盖包，内部 `COMMIT`）
  - `server/data/proposalService.js:421-432`（另一条独立 `UPDATE`，**不在同一事务**）
- **触发场景**：进程在两次写入之间被终止 / 第二条 UPDATE 抛错（磁盘、锁冲突）。单进程同步 SQLite 下概率低，但**不是不可能**。
- **当前影响**：低（需异常时序才发生）。当前演示不会命中。
- **是否影响当前答辩**：**不影响**。
- **是否必须现在修复**：**不必现在修**。若修，把两步纳入同一个 `BEGIN IMMEDIATE` 即可（需让 `applyOverridePackage` 支持外部事务，属结构性改动，建议排到下一阶段）。

---

### E 类 —— 属于未来扩展，不影响当前版本

1. **`prescriptions` 状态字段独立规范化**：当前"健康处方 / 覆盖包 / 提案"三义共用一表、只靠 JSON 内 `kind` 判别，无法建索引、无法纯 SQL 约束。未来可拆出独立表或加 `package_kind` 列（**零 schema 变更**是 Step 11 的既定约束，故本版刻意不拆）。
2. **`patient_targets` 版本化**：当前靠应用层单事务 + 排序兜底保证 active 唯一；未来可加 partial unique index（P5 已明确"暂不加"）。
3. **proposal 状态改为实体状态机**：当前"7 天过期"是懒判定、不写库；未来可加定时任务落库为 `expired`。
4. **AI-assisted Score 落库**：当前**刻意不落库**（D7/P4，与"`agent_runs` 不持久化"同口径），只有进程内当日缓存；未来若需历史对比再考虑持久化。
5. **实时性升级**：当前为"按需拉取 + 对话/协同 SSE"，无 polling（见 C-4）；未来可把任务/预警/建议也纳入 SSE 或引入轮询。
6. **医疗规则与模型的继续扩展**：`RULE_CATALOG` 已预留结构化目录，可继续追加规则；AI 侧可扩维度（但必须同步扩 `ADJUSTMENT_DIMENSIONS` 与 `healthScore` 分母口径）。
7. **多模态 / 语音**：`vision_records` 表已建但**运行时零写入**（多模态结果当前不落库）；语音能力在 `/api/status` 的 `capabilities` 中列出，属下一阶段。
8. **登录鉴权与会话层**：见 C-3，本版本刻意不做。

---

## 3. 本系统当前能够被证明的结论

> 以下每一条都有可复核的代码位置或可复跑的断言支撑，**不包含"AI 能力"层面的夸大表述**。

1. **今日任务是确定性派生的，不是模型生成的。** 全项目只有 `buildDailyTasks()` 生成任务，`source` 恒为 `'rule'`，任务不落库，进度由当日有效 readings / logs 实时派生。（`dailyTasks.js:243-456`；`verify-daily-tasks` 29/29）
2. **医学判定与预警等级不经过大模型。** 落库预警与医生端状态一律取自 `clinicalRules` 的命中结果；智能体工具层**没有任何写库语句**。（`alertService.js:89-168`；`tools.js` 无 INSERT/UPDATE/DELETE）
3. **AI 无法修改任何医学阈值，也无法修改任何患者数据或任务。** 阈值字段在白名单外一律拒绝；AI 只能写"待审提案"行；`clinicalRules.js` 在 AI 评估前后逐字节未变，`patient_targets` 全部行逐项相等。（`ai-score` 15/15b；`task-override` A20；`task-proposal` A24）
4. **AI 不能直接给分。** 它只能产出有界的 `adjustments[]`；最终辅助分由确定性纯函数合成，守恒式 `assisted − rule === Σdelta` 与 clamp 边界均已验证；**主数字恒为 Rule Score**。（`aiScore.js:321-334`；`ai-score` 2/9/10/10b/16）
5. **AI 不可用不影响主流程。** 未配置 / 401 / 非法 JSON 三种情况均回落 Rule Score，接口不报错，界面不显示伪造的 AI 分。（`ai-score` 11/12/17/17b；`fallback-flag` 29/29）
6. **"医生审结前患者端零变化"是可验证的事实，而非承诺。** 由读取口径（只读 `is_active=1`）结构性保证，并有"逐字段一致"的断言。（`task-proposal` A7；`patientService.js:1201-1202`）
7. **写入面是收敛的。** 22 张表中仅 8 张有运行时写入；事实层三表只有 INSERT、无 UPDATE/DELETE；`agent_runs` / `reminders` / `vision_records` 运行时零写入。
8. **降级开关与配置来源可控。** 无 Key 环境下"对话 → 提案 → 医生审核"整条链路仍可演示；`ALLOW_MOCK_FALLBACK=false` 时按排障语义原样抛出真实错误。（`task-proposal` A23；`fallback-flag`）
9. **当前测试总量：13 个脚本 / 401 条断言全绿**（另有 `verify-register-flow` 24/25，其唯一失败项是**脚本硬编码患者总数**导致的已知问题，与产品逻辑无关）。

### 当前**不能**被证明 / 不应声称的

1. **不能声称"预警等级是唯一的、内部无冲突的"** —— 见 D-2，晨报等级与落库预警来自两套实现。
2. **不能声称"规则阈值有医学指南依据"** —— 见 H-2，外部引用只覆盖演示病例的目标值，算法阈值均自述为 Demo 规则或无声明。
3. **不能声称"未记录的指标不会被计入"** —— 见 D-1，`0` 别名会让"未记录"进入规则序列。
4. **不能声称"AI 辅助分是临床评分"** —— 它是模型意见经确定性合成后的**辅助显示项**，不参与预警 / 档位 / 达标率。
5. **不能声称"系统具备实时同步能力"** —— 见 C-4，实际为按需拉取。
6. **不能声称"具备账号鉴权"** —— 见 C-3，本版本刻意不做。

---

## 附：本次审计的取证方式（可复核）

| 取证动作 | 命令 / 位置 | 结果 |
|---|---|---|
| 通读核心规则层 | `src/utils/{clinicalRules,dailyTasks,healthScore,taskOverride,aiScore,disease}.js` | 2,093 行全文 |
| 通读 Step 11 服务层 | `server/data/{taskOverrideService,proposalService,proposalIntent,aiScoreService,alertService,doctorNoteService}.js` | 1,681 行全文 |
| 写库点穷举 | `grep -rn "INSERT INTO\|UPDATE \|DELETE FROM" server/` | 仅 6 个服务文件命中 |
| 工具层越权检查 | `server/agents/tools.js` 全文检索 | 无任何写库语句 |
| 表清单 | `sqlite_master` 实查 | 22 张 |
| 两套风险判定对照 | 本地 `evaluateClinicalRules()` vs `assessRisk()` + 线上 `POST /api/agent/briefing` & `GET /alerts` | 4 例中 3 例不一致（D-2） |
| `0` 别名缺陷取证 | `seriesOf()` 实测序列 + **反事实实验** | 序列末位 `value:0`；反事实使等级由 `watch` → `alert`（D-1） |
| 线上三层评分契约 | `POST /api/agent/score` | `rule=67 / sumDelta=-6 / assisted=61 / clamped=false`，守恒成立 |
| 验收证据 | `data/*-verify-record.json` 的 `checks` 字段 | 13 脚本 / 401 断言全绿 |

**审计期间对业务代码的改动：无。对测试的改动：无。对数据库的改动：无**（仅执行只读查询与只读接口；另在审计前已将验收残留的副本库经 `reset-demo` 复位）。
