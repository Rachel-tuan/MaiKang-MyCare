# 第二阶段 · Step 2 · 种子数据导入记录（三位示范患者 → SQLite）

> 项目：迈康 MyCare · 老年慢病多智能体协同健康管理平台
> 依据：`docs/Step0.1_取数契约冻结_v0.1.md`（已批准）
> 前置：Step 1 已建成 SQLite（`data/mycare.db`，P0 22 张表 + `metric_definitions` 18 条）
> 日期：2026-09-14
> 结论：**三位示范患者已完整 Seed 进数据库；未进入 Step 3。**

---

## 1. 已完成内容

| # | 事项 | 结果 |
|---|---|---|
| 1 | 以 `src/data/demoPatients.js` 为**唯一数据源**（脚本直接 `import`，非复制粘贴） | ✅ 来源零走样 |
| 2 | 三位患者经 **`patient_id` 正确关联**写入 | ✅ `patient_1/2/3` |
| 3 | 身份 / 联系人 / 诊断 / 画像 / 目标 / 用药 / 医生关系 / 勋章 / 7 天体征 / 化验 全部映射 | ✅ 见表 §3 |
| 4 | `height → patients`、`waist → daily_health_records` 落地（唯一归属、不双存） | ✅ |
| 5 | 时序表带 `source` + `record_status`；`(patient_id, 时间)` 唯一键生效 | ✅ |
| 6 | **规则引擎复算**：用数据库数据重放，复现原演示结论 | ✅ 见表 §5 |
| 7 | 幂等导入（先清后灌）+ 零第三方依赖（Node 内置 `node:sqlite`） | ✅ |
| 8 | 机器可读记录 | ✅ `data/step2-seed-record.json` |

> 导入命令（可复现，可重复运行）：
> ```
> node scripts/db/seed-sqlite.mjs
> SEED_END_DATE=2026-09-14 node scripts/db/seed-sqlite.mjs   # 指定 7 天窗口末日期
> ```

---

## 2. 文件变更清单

**新增**
- `scripts/db/seed-sqlite.mjs` —— 种子导入 + 校验脚本
- `data/step2-seed-record.json` —— 导入执行记录（机器可读，含逐患者完整性 / 归属 / 规则复算 / 断言）
- `docs/Step2_种子数据导入记录.md` —— 本文件

**数据写入（不新增文件）**
- `data/mycare.db` —— 写入 12 张表的种子数据（`metric_definitions` 保留 Step 1 结果）

**明确未改动**
- ❌ 表结构 / DDL（`src/database/schema.sql` 未动，未增删任何列/表）
- ❌ 前端（`src/pages`、`src/components`、`src/contexts`…）
- ❌ 后端 / Agent（`server/**`）
- ❌ `src/data/demoPatients.js`（**只读**）与三个人物设定
- ❌ `package.json`（未加依赖、未加脚本）

---

## 3. 数据库中实际写入的表与行数

| 表 | 行数 | 内容 |
|---|---|---|
| `patients` | 3 | 张建国 / 李秀英 / 王建军 |
| `patient_contacts` | 3 | 紧急联系人（含 `authorized` 红线字段） |
| `patient_conditions` | 9 | 3 主诊断 + 6 合并症条目（每人 3 条） |
| `patient_lifestyle` | 3 | 生活画像 + 9 项行为标签 JSON |
| `patient_targets` | 3 | 个体化控制目标（演示阈值唯一来源） |
| `medications` | 4 | 1 + 2 + 1（王建军为「暂无长期用药」占位行，原样保留） |
| `doctors` | 1 | 李医生｜主任医师 · 全科 |
| `doctor_patient_relations` | 3 | 李医生 ↔ 三位患者 |
| `badge_definitions` | 2 | 初次记录 / 连续记录（目录） |
| `badges` | 6 | 每位患者 2 枚（引用 `badge_definitions`） |
| `daily_health_records` | 21 | 每位患者 7 天宽表（`2026-09-08 ~ 2026-09-14`） |
| `lab_results` | 1 | 李秀英 HbA1c 7.8%（`2026-07-14`） |
| `metric_definitions` | 18 | Step 1 初始化结果，未改动 |

**未写入（无源数据，符合 Step 2 边界）**：`assessments`→无；细表 `blood_pressure_readings` / `blood_glucose_readings`（源无「一天多测」原始数据）；事件类 `alerts` / `reminders` / `doctor_notes` / `medication_logs` / `agent_runs` / `vision_records` / `prescriptions`（源中未持久化）。

---

## 4. 字段映射对照（demoPatients → 数据库）

| 源字段 | 目标表.列 | 说明 |
|---|---|---|
| `profile.name/gender/username/phone/occupation/height/elderlyMode/voiceEnabled` | `patients.*` | `height` 唯一归本表 |
| `profile.age` | —— | **不落库**，由 `birth_date` 现算 |
| `profile.age` → 冻结派生 | `patients.birth_date` | Step 0.1 §8.1 冻结值（见 §4.1） |
| `profile.emergencyContact.*` | `patient_contacts` | `authorized` = 红线字段 |
| `medical.primaryDisease/ diseaseGrade/diseaseDuration/ riskStratification/riskStratificationBasis/ organDamage` | `patient_conditions`（`is_primary=1`） | `duration_text` 载病程 |
| `medical.secondaryDiseases` | `patient_conditions`（`is_primary=0`，逐条） | 供 `disease_types` 还原 |
| `medical.comorbidities` | `patient_conditions.comorbidities`（JSON） | 保留详细文本 |
| `medical.demoThreshold.{systolic,diastolic,fastingGlucose,bmi,waist}` | `patient_targets.{systolic_target,diastolic_target,fasting_glucose_target,bmi_target,waist_target}` | 演示阈值唯一来源 |
| `medical.targetBasis / controlTarget / demoThresholdNote` | `patient_targets.basis`（JSON 承载） | ⚠ 无独立列，见 §6 |
| `medical.hba1c + hba1cLastTestMonthsAgo` | `lab_results`（`item_name='HbA1c'`） | 结构化，供 R-BG-4 |
| `lifestyle.diet/exercise/sleep/biggestDifficulty/motivation/aiStyle/tags` | `patient_lifestyle.*` | tags 为 9 项 JSON |
| `medications[]` | `medications` | 药名/剂量/时间/频次/备注 |
| `healthRecords[].systolic/diastolic/bloodSugar/weight/heartRate/steps/exerciseMinutes/sleepHours/moodScore/notes` | `daily_health_records.*` | `bloodSugar → fasting_glucose` |
| `profile.waist` | `daily_health_records.waist`（**仅最新一行**） | 源无逐日腰围，见 §6 |
| `badges[]` | `badges` + `badge_definitions` | 见 §4.2 |
| 医生（`DoctorPage` 常量） | `doctors` + `doctor_patient_relations` | 李医生 |
| `initialPoints` | —— | 无 P0 承载表（P1），见 §6 |

### 4.1 birth_date 冻结值（Step 0.1 §8.1）
| patient_id | 姓名 | 原 age | birth_date | 2026 现算 age |
|---|---|---|---|---|
| `patient_1` | 张建国 | 68 | `1958-03-12` | 68 ✅ |
| `patient_2` | 李秀英 | 65 | `1961-06-08` | 65 ✅ |
| `patient_3` | 王建军 | 62 | `1964-01-25` | 62 ✅ |

### 4.2 勋章目录映射
| 源 `badges[].type` | `badge_definitions.badge_key` | `badge_def_id` | 显示名 / 图标 / 分值 |
|---|---|---|---|
| 初次记录 | `first_record` | `badgedef_first_record` | 迈出第一步 / ⭐ / 10 |
| 连续记录 | `week_streak`（语义=连续 7 天） | `badgedef_week_streak` | 坚持不懈 / 📊 / 30 |

---

## 5. 验收结果

### 5.1 结构 / 完整性断言（13 项全过 ✅）
| 检查 | 结果 |
|---|---|
| 患者数 = 3 / 医生数 = 1 / 勋章目录 = 2 | ✅ |
| 每患者：联系人 1 · 主诊断 1 · 画像 1 · 目标 1 · 医患关系 1 · 用药 ≥1 | ✅ |
| 每患者 7 天记录、日期连续、末日 = `2026-09-14` | ✅ |
| 每患者勋章 2 枚 | ✅ |
| height 归 `patients`、`patients` 无 waist 列、waist 归 `daily_health_records` | ✅ |
| waist 仅出现在最新一行（不臆造逐日腰围） | ✅ |
| `PRAGMA foreign_key_check` 违规 = 0；`integrity_check = ok` | ✅ |

### 5.2 规则引擎复算（用数据库数据重放，复现原演示结论）
| 患者 | 命中规则 | 最高等级 | 关键数值 | 断言 |
|---|---|---|---|---|
| 张建国 | R-BP-2, R-WT-1/4/5 | **预警** | 血压达标率 **42.9%**、+30 mmHg | ✅ R-BP-2 命中、R-BP-3 未命中 |
| 李秀英 | R-BG-3, R-BG-2, R-WT-1/4/5 | **预警** | 空腹血糖达标率 **57.1%**、极差 1.4 | ✅ R-BG-2/3 命中、R-BG-1 未命中 |
| 王建军 | R-WT-2/3/4/5, R-WT-1 | 关注 | 7 天净减 **−1.2 kg**、单日反弹 +0.6 | ✅ R-WT-2/3/4/5 命中 |

> 说明：`expectedRules` 中的 `R-BP-4`（授权后通知紧急联系人）由工具层 `raise_alert` 触发，不属 `evaluateClinicalRules` 输出，故不在本表列出。
> 结论：**数据库中的数据 = 原演示数据**，规则/达标率/趋势口径完全一致（未改动任何算法）。

---

## 6. 待确认事项（Step 2 未擅自决定，留待 Step 3/4）

1. **`controlTarget` / `demoThresholdNote` 无独立列**：这两个字段被运行时代码使用（登录页示范卡 `focus`、规则引擎 `thresholdNote`、医生端展示），但冻结的 22 表中 `patient_targets` 仅有 `basis` 一个叙述列。已**无损**承载于 `patient_targets.basis`（JSON：`{basis, controlTarget, demoThresholdNote}`）。
   → 请确认：Step 3 由 API 归一读出，**还是**需要为二者补列（补列属改结构，需你批准）。
2. **`waist` 仅灌最新一行**：源文件只有单值 `profile.waist`，无逐日腰围。为不臆造 6 个数据点，只在最新一天写入（`getPatientProfile.latestMeasurements.waist` 可正常读出；腰围趋势图为单点）。
   → 若希望 7 天腰围为一条平线（= 单值复制），请示下；否则维持现状。
3. **`initialPoints`（190/220/160）无 P0 承载表**：`point_transactions` / `user_levels` 属 P1（Step 1 明确不建）。按 Step 0.1 §8.2，勋章页等级改由 `badges.points` 现算（当前 10+30=40）。
   → 请注意：这会改变等级显示（原 190 分 → 等级 2「健康学徒」；新口径 40 分 → 等级 1）。若需保留原等级观感，需另行商定。
4. **`diagnosed_at` / `authorized_at` / `effective_from` 留空**：源文件无此三项数据，未臆造，一律 NULL（`duration_text` 已承载病程信息）。
5. **细表与事件表**（血压/血糖明细、预警、提醒等）本次未灌：源文件无对应原始数据，将在 Step 6 动态录入时产生。

---

## 7. 下一步（Step 3，未启动）

建立后端 `dataProvider`，至少实现并**真正查询 SQLite**（不读 `demoPatients.js` / `localStorage` / 前端内存）：
- `getSeries(patientId, metricKey, days, options)`
- `getDailySnapshot(patientId, date)`
- `getPatientProfile(patientId)`

并落实 Step 0.1 §2 错误模型（`DataProviderError` + 5 code）与 §4 `metricKey` 的来源解析（`default_source` / `available_sources`）。

**本步到此停止，未进入 Step 3。**
