# 迈康 MyCare · 第二阶段 Step 4 执行记录：前端 API 接入（前端 → API → dataProvider → SQLite → 页面）

> 依据：`docs/Step0.1_取数契约冻结_v0.1.md`（已批准）+ 导师 Step 4 指令
> 执行范围：**只做数据链路接入**，不重新设计数据库、不新增表、不改人设、不改指标计算规则
> 结论：`scripts/db/verify-step4.mjs` **26/26 通过**；P0 仍 **22 张**，P1/P2 未建；`demoPatients.js` 已不再是运行时数据源

---

## 1. 已完成内容（严格按导师给定的 6 步顺序）

| 步骤 | 要求 | 落地情况 |
|---|---|---|
| 1 | 先改 `server/index.js` 挂载 dataProvider API 路由 | ✅ 新增 9 个路由；统一 `DataProviderError → HTTP` |
| 2 | 登录身份用 `patient_id`，API 入口兼容 `user_id` | ✅ `POST /api/patients/login` 收 `patientId`/`userId`，进入 dataProvider 前归一为 `patient_id` |
| 3 | 首页 / 健康趋势改调 `getDailySnapshot` / `getSeries` | ✅ `HomePage`、`DataRecordPage` 经 `HealthDataContext` 走 API；趋势由 `getSeries` 计算 |
| 4 | 健康处方 / 勋章由后端数据驱动，不重造积分等级 | ✅ 处方基于 DB 档案现算；勋章来自 `badges ⋈ badge_definitions`；积分/等级标为「待启用」 |
| 5 | 医生端按 `doctor_patient_relations` 查询 | ✅ `GET /api/doctors/:doctorId/patients`，不再硬编码患者名单 |
| 6 | 脱离验证：`demoPatients.js` 改名 `.bak` 仍可运行 | ✅ 见 §6（后端重启后仍可服务 + 前端产物零引用） |

---

## 2. 修改了哪些文件

**新增（5）**
- `server/data/patientService.js` —— 页面聚合取数 / 写入层（构建在三大契约之上）
- `src/services/patientApi.js` —— 前端患者数据 API 客户端
- `scripts/db/verify-step4.mjs` —— Step 4 验证脚本
- `data/step4-verify-record.json` —— 机器可读验证结果
- `docs/Step4_前端API接入执行记录.md` —— 本文件

**修改（9）**
- `server/index.js` —— 挂载患者数据 API 路由
- `src/contexts/UserContext.jsx` —— 登录改走 API；新增 `register()`；`getUserLevel()` 返回「待启用」
- `src/contexts/HealthDataContext.jsx` —— 记录/勋章/趋势改由 API 载入；写入走 POST；**移除 localStorage 健康数据主存储**
- `src/pages/LoginPage.jsx` —— 示范入口来自 `/api/patients`；注册走 `register()`
- `src/pages/DoctorPage.jsx` —— 患者列表来自关系表 API
- `src/pages/BadgePage.jsx` —— 等级不伪造（P1 待启用）
- `src/pages/ProfilePage.jsx` —— 同上，去掉 `等级 1` 兜底
- `src/pages/HomePage.jsx` —— 连续天数改由数据库记录现算（原写死 7）
- `src/pages/PrescriptionPage.jsx` —— 修正 `updateUserInfo` 未定义的历史缺陷；处方基于 DB 档案生成
- `src/pages/DataRecordPage.jsx` —— 录入改为 `await` 落库后由上下文刷新
- `src/App.jsx` —— 移除旧的 `syncForUser` 固定脚本同步链路

**未改动（红线）**
- ❌ 未改数据库结构：**未执行任何 DDL**，P0 仍 22 张，P1/P2 未建
- ❌ 未改三人人设：`src/data/demoPatients.js` 内容一字未改（仅验证时临时改名并还原）
- ❌ 未改指标计算规则：`src/utils/clinicalRules.js` 未动，阈值 / 达标率 / 预警等级仍由确定性规则引擎计算
- ❌ 未改 `schema.sql` / `package.json` / `server/agents/**`（Agent 数据链路属 Step 5）

---

## 3. 数据库实际表（未变）

22 张 P0：`agent_runs, alerts, badge_definitions, badges, blood_glucose_readings, blood_pressure_readings, daily_health_records, doctor_notes, doctor_patient_relations, doctors, lab_results, medication_logs, medications, metric_definitions, patient_conditions, patient_contacts, patient_lifestyle, patient_targets, patients, prescriptions, reminders, vision_records`
**P1/P2 确认未建**：`weight_readings / point_transactions / user_levels / community_activities / user_activity_participations` 均不存在 ✅

---

## 4. 新增 API 路由（patient_id 为唯一患者键）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/patients` | 登录页示范入口（DB 派生：姓名/年龄/性别/病名/控制目标） |
| POST | `/api/patients/login` | 身份解析 → `{ patientId, view }`；兼容入站 `userId` 别名 |
| GET | `/api/patients/:patientId/profile` | `getPatientProfile` + `toUserProfileView` |
| GET | `/api/patients/:patientId/snapshot?date=` | `getDailySnapshot` |
| GET | `/api/patients/:patientId/series/:metricKey?days=&source=&anchorMode=&from=&to=` | `getSeries`（source 解析遵守 `available_sources`） |
| GET | `/api/patients/:patientId/records?days=` | 记录列表（窗口锚定最新记录日） |
| POST | `/api/patients/:patientId/records` | **录入 / 修正当日数据（落库，追加不覆盖）** |
| GET | `/api/patients/:patientId/badges` | 勋章（`badges ⋈ badge_definitions`） |
| GET | `/api/doctors/:doctorId/patients` | 医生端患者列表（`doctor_patient_relations`） |

错误统一为 `DataProviderError`：`E_INVALID_ARG`→400、`E_PATIENT_NOT_FOUND`→404、`E_UNKNOWN_METRIC`→400、`E_DB_UNAVAILABLE`→503。

---

## 5. 实际查询样例（真实 HTTP 响应）

- `GET /api/patients` → `patient_1:张建国 / patient_2:李秀英 / patient_3:王建军`（含 68/65/62 岁、男/女/男、原发性高血压 2 级 / 2 型糖尿病 / 肥胖症 一级）
- `POST /api/patients/login {patientId:'patient_1'}` → `patientId=patient_1`、`姓名=张建国`、`控制目标=诊室血压 < 140/90 mmHg`、生活画像「口味偏咸…」
- `GET /api/patients/patient_1/snapshot` → `exists=true`、`date=2026-09-14`、`SBP=162 / 空腹血糖=5.4 / 体重=75`
- `GET /api/patients/patient_1/series/systolic_pressure?days=7` → `count=7`、`direction=rising`、`latest=162`、`sourceKey=daily`
- `GET /api/patients/patient_2/records?days=7` → `count=7`，窗口 `2026-09-08 ~ 2026-09-14`（`anchorMode=latest`）
- `GET /api/patients/patient_1/badges` → `first_record`、`week_streak`（来自 `badge_definitions.badge_key`）
- `GET /api/doctors/doc_li/patients` → 李医生｜主任医师·全科 管理 3 人：`张建国/attention（预警）`、`李秀英/attention（预警）`、`王建军/good（良好）`；手机号已脱敏 `138****8001`

### 三位患者的规则复算（与演示口径一致）
| 患者 | 命中规则 | 未命中（关键） |
|---|---|---|
| 张建国 | `R-BP-2`（连续异常趋势） | `R-BP-3` 未命中（162 < 180） |
| 李秀英 | `R-BG-3` + `R-BG-2` | `R-BG-1` 未命中；`R-BG-4` 未命中（HbA1c 距 2 个月 ≤ 3） |
| 王建军 | `R-WT-2` + `R-WT-3` | `R-WT-5`「健步如飞」未解锁 |

---

## 6. 动态数据链路验收（H 组，全部实测）

| # | 验收项 | 结果 |
|---|---|---|
| H1 | 录入接口写入成功 | ✅ `created=true` |
| H2 | 数据真正写入 SQLite | ✅ `daily_health_records(patient_1, 2026-09-20)` 落到 `SBP=150/DBP=95/74.5kg` |
| H3 | 刷新后可见新值、趋势窗口前移 | ✅ 窗口 `09-14 → 09-20`，`latest 162 → 150` |
| H4 | 历史追加不覆盖 | ✅ 14 天记录数 `7 → 8` |
| H5 | 同日再录入为当日修正 | ✅ `updated=true`，行数不变，未提交字段（steps/weight）保留，`record_status=corrected` |
| H6 | 测试行清理、DB 恢复种子状态 | ✅ 测试行已删除，三位患者各 7 行 |

## 7. 脱离 `demoPatients.js` 验证（I / J / K）

- **I1 静态扫描**：`server/index.js`、`server/data/*`、`src/contexts/*`、`src/pages/*`、`src/services/*` 共 **18 个运行时文件，0 处 `demoPatients` 导入**
- **J1 运行时改名**：把 `src/data/demoPatients.js` 改名为 `.bak` 后**重启后端**，`/api/patients` 与 `/api/patients/login` 仍正常（`renamed=true, ok=true`）
- **J2**：验证后已还原（`restored=true`），文件内容未变
- **K1 前端产物**：`dist/assets/*.js` 中 **0 处** `demoPatients` 引用

> ⚠️ 说明：`scripts/{screenshots,demo-video,selftest,verify-demo-data}.mjs` 与 `scripts/db/seed-sqlite.mjs` 仍以 `demoPatients.js` 作为**种子 / 夹具来源**（非运行时）。它们是离线脚本，改名会影响其运行；Step 6 若有需要可另做迁移。

---

## 8. 红线确认

| 红线 | 状态 |
|---|---|
| 新增 P1/P2 表 | ✅ 未新增（仍 22 张） |
| 修改 3 位患者人设 | ✅ 未修改（`demoPatients.js` 与 DB 人设字段均未动） |
| 改指标计算规则 | ✅ `clinicalRules.js` 未动 |
| 让 AI「猜」阈值 / 等级 / 达标率 | ✅ 仍由确定性规则引擎计算，AI 只做转述 |
| 前端把 `records/profile/badges` 传回后端 | ✅ 本步未引入该模式（Agent 数据链路下沉属 Step 5） |
| 保留 `demoPatients.js` 作为「API 挂了时的兜底」 | ✅ 无任何兜底；`E_PATIENT_NOT_FOUND` 返回明确 404，前端显示空态 |
| 后端以 `patient_id` 为唯一身份来源 | ✅ 已落实；入站 `user_id` 别名在入口归一 |
| 查不到患者不回落默认患者 | ✅ 实测 404 |

---

## 9. 待确认事项（本步未擅自决定）

1. **自定义注册用户**：注册档案不入示范库，其健康数据接口将返回 `E_PATIENT_NOT_FOUND`，前端显示空态（不回落示范患者）。若希望注册用户也可写入数据库，需要在后续步骤新增「注册落库」能力（涉及 `patients` 写入，本步未做）。
2. **积分 / 等级**：按 Step 3 冻结结论标记为「待启用」，BadgePage / ProfilePage 均不再显示伪造等级。P1 `point_transactions` / `user_levels` 建成后再开放。
3. **医生备注**：`doctor_notes` 表已建但为空；医生端「添加备注」仍为前端会话内状态（不落库）。是否在后续步骤把备注写入 `doctor_notes`，请指示。
4. **运行环境**：本次修改后**必须重启后端**（旧进程仍跑旧代码，会出现新路由 404）。已清理占用 3001 的旧进程。

---

## 10. 当前验收结果与下一步

**验收结果**：`node scripts/db/verify-step4.mjs` → **26/26 通过**；`vite build` 通过；数据库 P0 22 张不变。

**Step 4 已完成并停止。** 下一步 **Step 5：改造 Agent 数据链路**（未启动，等指令）：
前端只向后端传 `{ patient_id, goal }`，后端 `patient_id → dataProvider → SQLite → context → Agent`，并严禁 Agent 运行时读取 `demoPatients.js`；同时把预警落库到 `alerts` 表。
