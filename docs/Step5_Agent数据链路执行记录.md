# 迈康 MyCare · 第二阶段 Step 5 执行记录：Agent 数据链路改造

> 依据：导师 Step 5 指令 + `docs/Step0.1_取数契约冻结_v0.1.md`
> 目标闭环：**patient_id → dataProvider → Agent → 确定性规则 → alerts 落库 → 医生/患者端读取**
> 执行范围：**只做这条闭环的改造**，不新建表、不改人设、不改指标计算规则、不改 `clinicalRules.js`
> 结论：`scripts/db/verify-step5.mjs` **28/28 通过**；P0 仍 **22 张**，P1/P2 未建；前端不再向智能体接口回传 `records/profile/badges`

---

## 1. 一句话变化

Step 4 打通了「前端 → API → dataProvider → SQLite → 页面」；
**Step 5 把智能体也接进这条链路**：前端对智能体接口**只上传 `patient_id`**，上下文由后端 `dataProvider` 自取；
运行结束后，`clinicalRules` 的确定性命中结果**落库到 `alerts` 表**，患者端与医生端再**读取该表**展示。

改动前后：

| | 改造前（Step 4 及以前） | 改造后（Step 5） |
|---|---|---|
| 智能体接口入参 | 前端回传 `context = { user, records, badges }` | **只传 `{ patientId, goal }`**（兼容入站 `userId` 归一） |
| 上下文来源 | 前端内存（旧链路源自 `demoPatients.js`） | 后端 `patient_id → dataProvider → SQLite` |
| 预警 | 仅存在本次会话内存（`executor.effects.alerts`），刷新即丢 | **确定性规则命中 → `alerts` 表落库 → 两端可读** |
| 等级判定者 | 规则引擎 + 模型 `raise_alert` 混在内存里 | **落库只认 `clinicalRules`**；AI 只在内存会话里做表达 |

---

## 2. 改动文件

**新增（4）**
- `server/data/agentContext.js` —— 由 `patient_id` 装配智能体上下文（`buildAgentContext` / `buildVisionContext` / `toRulePatient` / `buildRuleEvaluation`）
- `server/data/alertService.js` —— 预警落库与读取（`persistRuleAlerts` / `listPatientAlerts` / `listPatientAlertRecords`）
- `scripts/db/verify-step5.mjs` —— Step 5 验证脚本（28 项）
- `data/step5-verify-record.json` —— 机器可读验证结果

**修改（8）**
- `server/index.js` —— `/api/agent/{briefing,orchestrate,chat}` 改为只收 `patientId`；协同结束后 `buildRuleEvaluation → persistRuleAlerts` 并下发 `alerts_persisted` 事件；`/api/vision/read` 改收 `patientId`；新增 `GET /api/patients/:patientId/alerts`
- `server/data/patientService.js` —— 导出 `monthsSinceLatestHbA1c`（R-BG-4 依赖的派生值）；`getDoctorPatients` 每人附 `alertRecords`（读 `alerts` 表）
- `src/services/agentApi.js` —— `getBriefing(patientId)` / `runOrchestration({patientId,goal})` / `chatWithAgent({...patientId})`，**移除 context 回传**
- `src/services/patientApi.js` —— 新增 `getAlerts(patientId, {limit})`
- `src/contexts/HealthDataContext.jsx` —— 新增 `alerts` 状态与 `refreshAlerts()`（读 `/api/patients/:id/alerts`）
- `src/contexts/AgentContext.jsx` —— 只下发 `patientId`；协同 `run_done`/`alerts_persisted` 后 `refreshAlerts()`；自定义注册用户（无库档案）不下发 patientId
- `src/pages/HomePage.jsx` —— 新增「当前健康预警」卡片（读落库数据）
- `src/pages/DoctorPage.jsx` —— 「健康预警」页优先展示后端 `alertRecords`（含 `level / ruleId / createdAt`）
- `src/components/Agent/VisionPanel.jsx` —— 多模态解读改传 `patientId`，不再回传 `context`

**未改动（红线）**
- ❌ 未执行任何 DDL：P0 仍 **22 张**，P1/P2 未建
- ❌ 未改三人人设（`src/data/demoPatients.js` 一字未改）
- ❌ **未改 `src/utils/clinicalRules.js`**：阈值 / 达标率 / 预警等级仍是同一份确定性实现
- ❌ 未改 `server/agents/tools.js` 的算法层与 `server/agents/registry.js` 的提示词与拓扑
- ❌ 未改 `schema.sql` / `package.json`

---

## 3. 新增 / 变更的接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/patients/:patientId/alerts?limit=` | **新增**：读取落库预警（患者端 / 医生端） |
| POST | `/api/agent/briefing` | 入参由 `{context}` 改为 `{patientId}`（兼容 `userId`） |
| POST | `/api/agent/orchestrate` | 入参由 `{context,goal}` 改为 `{patientId,goal}`；结束后落库并下发 `alerts_persisted` |
| POST | `/api/agent/chat` | 入参由 `{...,context}` 改为 `{...,patientId}`（无 patientId 时用空上下文） |
| POST | `/api/vision/read` | 入参由 `{...,context}` 改为 `{...,patientId}` |
| GET | `/api/doctors/:doctorId/patients` | 每人新增 `alertRecords` / `alertCount`（读 `alerts` 表） |

错误模型不变：`E_INVALID_ARG`→400、`E_PATIENT_NOT_FOUND`→404（**不回落默认患者**）。

---

## 4. alerts 落库规则（确定性，AI 不参与）

`server/data/alertService.js` 的 `persistRuleAlerts(patientId, evaluation, { source })`：

1. **取值来源**：只取 `evaluateClinicalRules(...).matched` 中命中且等级 ∈ `{emergency, alert, watch}` 的规则。
   - `提示`（info）级多为正向激励（记录达成 / 减重进展 / 运动达标）与单次轻微异常，与既有医生端「预警」语义
     （`emergency/alert/watch`，见 `patientService.getDoctorPatients`）保持一致，**不入库以免告警噪声**。
2. **字段映射（等级与依据均来自规则，非模型）**：

   | alerts 列 | 来源 |
   |---|---|
   | `level` | `ALERT_LEVEL[rule.level].label` → 提示 / 关注 / 预警 / 紧急 |
   | `title` | `rule.title` |
   | `detail` | `rule.basis`（含具体数值，如「连续 4 天收缩压 ≥140 mmHg，7 天涨幅 +30 mmHg」） |
   | `action` | `rule.action` |
   | `rule_id` | `rule.ruleId`（如 `R-BP-2`） |
   | `source` | `orchestrator`（协同运行）/ `rule_engine`（独立落库） |

3. **外发策略（合规）**：一律**只记录不外发** —— `notify_targets = ["self"]`、`pending_notify` 挂外部对象
   （紧急→`["family","doctor"]`，其余→`["family"]`）、`external_blocked = 1`、`confirmed = 0`。
   真实外发通道（短信/微信/Push/WebSocket）本阶段仍未实现，需「已授权 + 本人确认」双条件。
4. **幂等**：按 **(patient_id, rule_id, 自然日)** 做 upsert，同日复跑只更新不重复插入。

> 关键裁定：**AI 的 `raise_alert` 仍保留在会话内存中用于前端叙事，但不写库。**
> 写库的只有 `clinicalRules` 的确定性命中 —— 这是「AI 不猜等级」红线在落库层的具体落实。

---

## 5. 三位患者落库口径（实测，与演示一致）

| 患者 | 命中并落库的规则 | 等级 | 说明 |
|---|---|---|---|
| 张建国 `patient_1` | `R-BP-2` | **预警** | 连续 4 天收缩压 ≥140 mmHg，7 天涨幅 +30 mmHg；`R-BP-3` 未命中（未达 180） |
| 李秀英 `patient_2` | `R-BG-3` + `R-BG-2` | **预警** + **关注** | 7 天达标率 <60% 且趋势向上；7 天极差 ≥1.4 mmol/L |
| 王建军 `patient_3` | `R-WT-3` | **关注** | 单日体重回升 ≥0.5 kg（柔性提示，不报警） |

SQLite 直接核对：`alerts` 表本次共落库 **4** 行，与 API 返回行数一致。

---

## 6. 验证结果（`node scripts/db/verify-step5.mjs` → 28/28 通过）

验证在隔离端口 3031 拉起后端并**强制本地推理引擎**（`DEEPSEEK_API_KEY=''`），确保可复现、不依赖网络。

| 组 | 验收项 | 结果 |
|---|---|---|
| P | 数据库仍为 P0（22 张，P1/P2 不存在） | ✅ |
| A | 晨报/协同/对话只传 `patientId`，后端自取；`userId` 别名归一 | ✅ |
| B | 协同 SSE 事件序列完整（`run_start…run_done`），4 个智能体依次启动；结束下发 `alerts_persisted` | ✅ |
| C | 三患者落库 rule_id / level 与演示一致；等级全为产品词表；每条带 rule_id 与确定性依据；`R-BP-2` 依据含「连续 + 数值」；外发策略 `self + blocked`；`source=orchestrator`；DB 行数与 API 一致 | ✅ |
| D | 医生端经关系表返回 3 人，每人带 `alertRecords`（1 / 2 / 1 条） | ✅ |
| E | **红线探针**：前端回传伪造 `records`（收缩压 999）被忽略 —— 未触发 `R-BP-3`，仍以 `patient_id` 自取，姓名未被篡改 | ✅ |
| F | 复跑协同幂等（同日同规则 `1 → 1`，不重复插入） | ✅ |
| G | 对话接口以 `patientId` 取数并流式返回 | ✅ |
| H | 缺 `patientId`→400；未知患者晨报/预警/协同→404（不回落默认患者） | ✅ |
| I | 静态扫描：前端不再向智能体接口回传 `records/profile/badges` | ✅ |

---

## 7. 红线确认

| 红线 | 状态 |
|---|---|
| `clinicalRules.js` 决定数值与告警等级 | ✅ 未改动；落库 `level` / `detail` / `rule_id` 全部取自其命中结果 |
| AI 只负责分析表达，不猜阈值 / 等级 / 改写结果 | ✅ 写库路径无 AI 参与；模型的 `raise_alert` 仅存会话内存 |
| 不改指标计算规则 | ✅ `src/utils/clinicalRules.js` 未动 |
| 不新增 P1/P2 表 | ✅ 仍 22 张 |
| 不改三人人设 | ✅ 未改 |
| 前端不把 `records/profile/badges` 回传后端 | ✅ 智能体与多模态接口均改为只收 `patient_id`，并已静态扫描 |
| 以 `patient_id` 为唯一身份来源；查不到不回落默认患者 | ✅ 400/404 实测 |
| 外部通知不擅自外发 | ✅ 落库 `notify_targets=['self']`、`external_blocked=1`、`confirmed=0` |

---

## 8. 待确认事项（本步未擅自决定）

1. **入库等级范围**：当前只落 `关注 / 预警 / 紧急`（与既有医生端预警语义一致），`提示` 级不入库。
   若希望把单次轻微异常（`R-BP-1` / `R-BG-1`，提示级）也落库，请指示。
2. **`reminders` 表未启用**：方案里的用药提醒（`schedule_reminder`）本次仍只在会话内存中，**未落 `reminders` 表**——
   本步闭环只针对 `alerts`。是否在后续步骤把提醒也落库，请指示。
3. **`agent_runs` 表未写**：协同运行的推理轨迹（事件流）目前只推给前端，未写入 `agent_runs`。是否留待后续。
4. **自定义注册用户**：无数据库档案 → 不下发 `patient_id`，智能体协同给出明确提示（不回落示范患者）。

---

## 9. 下一步（未启动，等指令）

- 若继续：可做 **预警的「已读 / 确认」交互**（患者端点确认 → 更新 `confirmed` 并真正外发），或 **`reminders` / `agent_runs` 落库**。
- 运行环境提醒：**改后端后必须重启**（旧进程跑旧代码会对新入参报错）。本步已重启本地 3000/3001。
