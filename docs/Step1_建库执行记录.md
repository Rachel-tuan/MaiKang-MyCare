# 第二阶段 · Step 1 · 建库执行记录（SQLite · P0 22 张表）

> 项目：迈康 MyCare · 老年慢病多智能体协同健康管理平台
> 依据：`docs/Step0.1_取数契约冻结_v0.1.md`（已批准）
> 日期：2026-09-14
> 结论：**已建成 SQLite 数据库（P0 22 张表）＋ 初始化 metric_definitions；未进入 Step 2。**

---

## 1. 已完成内容

| # | 事项 | 结果 |
|---|---|---|
| 1 | 备份旧 MySQL 风格 schema | ✅ `src/database/schema.mysql.legacy.sql` |
| 2 | 重新生成 **兼容 SQLite 的 DDL** | ✅ `src/database/schema.sql`（22 表 + 23 索引 + 3 触发器） |
| 3 | 编写零依赖建库脚本（Node 内置 `node:sqlite`） | ✅ `scripts/db/build-sqlite.mjs` |
| 4 | 生成 SQLite 数据库文件 | ✅ `data/mycare.db`（320 KB） |
| 5 | 初始化 `metric_definitions`（一行一指标） | ✅ 18 条，`default_source ∈ available_sources` 全部通过 |
| 6 | 主键 / 外键 / 唯一约束 / 索引 检查 | ✅ 全部通过（详见 §5、§6） |
| 7 | 时序表铁律（9 张 P0）逐张核对 | ✅ 全部通过（详见 §7） |
| 8 | 同步设计文档 height / waist 旧描述 | ✅ 4 处（详见 §8） |
| 9 | 建库执行记录（机器可读） | ✅ `data/step1-build-record.json` |

> 建库命令（可复现，一条即可重建）：
> ```
> node scripts/db/build-sqlite.mjs
> ```
> 脚本每次运行会**干净重建**（删除旧 `.db` 再建），并重新执行全部检查。

---

## 2. 文件变更清单

**新增**
- `data/mycare.db` —— SQLite 数据库文件（交付物）
- `data/step1-build-record.json` —— 建库执行记录（机器可读，含逐表字段/外键/索引）
- `scripts/db/build-sqlite.mjs` —— 建库 + 校验脚本
- `src/database/schema.mysql.legacy.sql` —— 旧 MySQL 风格 schema 的备份（不再使用）
- `docs/Step1_建库执行记录.md` —— 本文件

**替换（整体重写为 SQLite DDL）**
- `src/database/schema.sql` —— 由 MySQL 风格改为 **SQLite 兼容 DDL**

**按用户许可的文档同步（仅此一处业务外文档）**
- `docs/数据指标说明与设计文档.html` —— height / waist 描述修正 4 处（见 §8）

**明确未改动**
- ❌ 前端（`src/pages`、`src/components`、`src/contexts`…）
- ❌ 后端 / Agent（`server/**`）
- ❌ `src/data/demoPatients.js`
- ❌ 三个人物设定
- ❌ `package.json`（未加依赖、未加脚本）

---

## 3. 数据库文件

| 项 | 值 |
|---|---|
| 路径 | `E:\0000项目备份\APP0\data\mycare.db` |
| 大小 | 327,680 字节（约 320 KB） |
| 驱动 | Node 内置 `node:sqlite`（`DatabaseSync`，**零第三方依赖**） |
| `PRAGMA foreign_keys` | **ON** |
| `PRAGMA integrity_check` | **ok** |
| `PRAGMA foreign_key_check` 违规数 | **0** |

> 选型说明：设计文档建议 `better-sqlite3`/`sqlite3`；本步改用 **Node 22 内置 `node:sqlite`**，
> 目的是**不引入任何 npm 依赖、不改 `package.json`、不动 node_modules**，把 Step 1 的改动面收敛到数据库本身。

---

## 4. 已建立的 22 张 P0 表清单

| # | 表名 | 中文名 | 数据层 | 主键 | 列数 | 时序 | 优先级 |
|---|---|---|---|---|---|---|---|
| 1 | `patients` | 患者主表 | B | `patient_id` | 14 | 否 | P0 |
| 2 | `patient_contacts` | 紧急联系人 | B | `contact_id` | 8 | 否 | P0 |
| 3 | `patient_conditions` | 疾病诊断 | B | `condition_id` | 12 | 否 | P0 |
| 4 | `patient_lifestyle` | 生活画像 | B | `patient_id` | 9 | 否 | P0 |
| 5 | `patient_targets` | 个体化控制目标 | B | `target_id` | 14 | 否 | P0 |
| 6 | `medications` | 长期用药计划 | C | `medication_id` | 9 | 否 | P0 |
| 7 | `doctors` | 医生主表 | B | `doctor_id` | 11 | 否 | P0 |
| 8 | `doctor_patient_relations` | 医患关系 | C | `relation_id` | 5 | 否 | P0 |
| 9 | `metric_definitions` | 指标注册表 | 元数据 | `metric_key` | 9 | 否 | P0 |
| 10 | `badge_definitions` | 勋章目录表 | 元数据 | `badge_def_id` | 10 | 否 | P0 |
| 11 | `daily_health_records` | 每日健康快照（主干宽表） | A | `record_id` | 18 | 是(日) | P0 |
| 12 | `blood_pressure_readings` | 血压测量明细 | A | `reading_id` | 10 | 是(分) | P0 |
| 13 | `blood_glucose_readings` | 血糖测量明细 | A | `reading_id` | 8 | 是(分) | P0 |
| 14 | `lab_results` | 化验结果 | A | `lab_id` | 11 | 是(日) | P0 |
| 15 | `alerts` | 预警记录 | D | `alert_id` | 13 | 是(秒) | P0 |
| 16 | `reminders` | 提醒 | C | `reminder_id` | 9 | 否 | P0 |
| 17 | `doctor_notes` | 医生备注 | C | `note_id` | 9 | 是(秒) | P0 |
| 18 | `medication_logs` | 服药记录 | C | `log_id` | 9 | 是(分) | P0 |
| 19 | `agent_runs` | 智能体运行记录 | D | `run_id` | 8 | 是(秒) | P0 |
| 20 | `vision_records` | 图像识别记录 | D | `vision_id` | 8 | 是(秒) | P0 |
| 21 | `prescriptions` | 健康处方 | C | `prescription_id` | 10 | 否 | P0 |
| 22 | `badges` | 勋章记录 | C | `badge_id` | 6 | 否 | P0 |

**计数核对**：表数量 **22 / 22** ✅　缺失表：无 ✅　多余表：无 ✅
**P1/P2 误入检查**：`weight_readings` / `point_transactions` / `user_levels` / `community_activities` / `user_activity_participations` **均未创建** ✅
（`weight_readings` 属 P1，其中 `weight` 指标的 readings 来源按 Step 0.1 §1.1 规则返回 `E_INVALID_ARG / source_not_built`）

---

## 5. 主键 / 外键 / 唯一约束 检查结果

### 5.1 主键（22/22 全部有主键）

- 单列 `TEXT` 主键，默认值 `lower(hex(randomblob(16)))`（SQLite 原生，替代 MySQL `UUID()`）。
- `patient_lifestyle` 以 `patient_id` 为 **PK+FK**（一对一）；`metric_definitions` 以 `metric_key` 为 PK（**一行一指标**）。

### 5.2 外键（共 **23 条**，全部通过 `PRAGMA foreign_key_check` 校验）

| 子表 | 外键 | 级联 |
|---|---|---|
| `patient_contacts` | `patient_id → patients.patient_id` | ON DELETE CASCADE |
| `patient_conditions` | `patient_id → patients.patient_id` | CASCADE |
| `patient_lifestyle` | `patient_id → patients.patient_id` | CASCADE |
| `patient_targets` | `patient_id → patients.patient_id`；`set_by → doctors.doctor_id` | CASCADE；SET NULL |
| `medications` | `patient_id → patients.patient_id` | CASCADE |
| `doctor_patient_relations` | `doctor_id → doctors.doctor_id`；`patient_id → patients.patient_id` | CASCADE；CASCADE |
| `daily_health_records` | `patient_id → patients.patient_id` | CASCADE |
| `blood_pressure_readings` | `patient_id → patients.patient_id` | CASCADE |
| `blood_glucose_readings` | `patient_id → patients.patient_id` | CASCADE |
| `lab_results` | `patient_id → patients.patient_id` | CASCADE |
| `alerts` | `patient_id → patients.patient_id` | CASCADE |
| `reminders` | `patient_id → patients.patient_id` | CASCADE |
| `doctor_notes` | `doctor_id → doctors.doctor_id`；`patient_id → patients.patient_id` | CASCADE；CASCADE |
| `medication_logs` | `patient_id → patients.patient_id`；`medication_id → medications.medication_id` | CASCADE；SET NULL |
| `agent_runs` | `patient_id → patients.patient_id` | CASCADE |
| `vision_records` | `patient_id → patients.patient_id` | CASCADE |
| `prescriptions` | `patient_id → patients.patient_id` | CASCADE |
| `badges` | `patient_id → patients.patient_id`；`badge_def_id → badge_definitions.badge_def_id` | CASCADE；RESTRICT |

### 5.3 唯一约束（关键 5 项全部通过）

| 表 | 约束 | 结果 |
|---|---|---|
| `patients` | `username` UNIQUE | ✅ |
| `doctors` | `username` UNIQUE | ✅ |
| `badge_definitions` | `badge_key` UNIQUE | ✅ |
| `daily_health_records` | `UNIQUE(patient_id, record_date)`（一天一条，重复提交走 UPSERT） | ✅ |
| `doctor_patient_relations` | `UNIQUE(doctor_id, patient_id)`（医患绑定唯一） | ✅ |
| `patient_lifestyle` | `PK(patient_id)`（一对一） | ✅ |

---

## 6. 索引检查结果（共 **23 个 CREATE INDEX**，含 9 张时序表的 `(patient_id, 时间字段)` 组合索引）

| 索引 | 表 | 列 |
|---|---|---|
| `idx_patients_active` | patients | (is_active) |
| `idx_contacts_patient` | patient_contacts | (patient_id) |
| `idx_conditions_patient` | patient_conditions | (patient_id) |
| `idx_targets_patient` | patient_targets | (patient_id) |
| `idx_medications_patient` | medications | (patient_id) |
| `idx_relations_patient` | doctor_patient_relations | (patient_id) |
| `idx_metric_default_source` | metric_definitions | (default_source) |
| **`idx_daily_patient_date`** | daily_health_records | **(patient_id, record_date)** |
| **`idx_bp_patient_time`** | blood_pressure_readings | **(patient_id, measured_at)** |
| **`idx_bg_patient_time`** | blood_glucose_readings | **(patient_id, measured_at)** |
| **`idx_lab_patient_date`** | lab_results | **(patient_id, test_date)** |
| `idx_lab_patient_item` | lab_results | (patient_id, item_name) |
| **`idx_alerts_patient_time`** | alerts | **(patient_id, created_at)** |
| `idx_alerts_level` | alerts | (level) |
| `idx_reminders_patient` | reminders | (patient_id) |
| **`idx_doctor_notes_patient_time`** | doctor_notes | **(patient_id, created_at)** |
| `idx_doctor_notes_read` | doctor_notes | (patient_id, is_read) |
| **`idx_med_logs_patient_time`** | medication_logs | **(patient_id, planned_time)** |
| **`idx_agent_runs_patient_time`** | agent_runs | **(patient_id, created_at)** |
| **`idx_vision_patient_time`** | vision_records | **(patient_id, created_at)** |
| `idx_prescriptions_patient_active` | prescriptions | (patient_id, is_active) |
| `idx_badges_patient` | badges | (patient_id) |
| `idx_badges_patient_date` | badges | (patient_id, earned_date) |

> 铁律 ②（索引必须建在 `(patient_id, 时间字段)`）——9 张 P0 时序表**全部命中**（粗体行）。

---

## 7. 时序表铁律核对（9 张 P0 时序表）

| 时序表 | 类型 | 时间锚点 | patient_id | source | record_status | 索引(patient_id,时间) | 结论 |
|---|---|---|---|---|---|---|---|
| `daily_health_records` | 测量事实型 | `record_date`(日) | ✅ | ✅ | ✅ 必带 | ✅ | ✅ |
| `blood_pressure_readings` | 测量事实型 | `measured_at`(分) | ✅ | ✅ | ✅ 必带 | ✅ | ✅ |
| `blood_glucose_readings` | 测量事实型 | `measured_at`(分) | ✅ | ✅ | ✅ 必带 | ✅ | ✅ |
| `lab_results` | 测量事实型 | `test_date`(日) | ✅ | ✅ | ✅ 必带 | ✅ | ✅ |
| `medication_logs` | 测量事实型 | `planned_time`(分) | ✅ | ✅ | ✅ 必带 | ✅ | ✅ |
| `alerts` | 事件型 | `created_at`(秒) | ✅ | ✅ | ✗ 不设（合规） | ✅ | ✅ |
| `doctor_notes` | 事件型 | `created_at`(秒) | ✅ | ✅ | ✗ 不设（合规） | ✅ | ✅ |
| `agent_runs` | 事件型 | `created_at`(秒) | ✅ | ✅ | ✗ 不设（合规） | ✅ | ✅ |
| `vision_records` | 事件型 | `created_at`(秒) | ✅ | ✅ | ✗ 不设（合规） | ✅ | ✅ |

**计数**：P0 时序 9 张 = 测量事实型 5（带 `record_status`）+ 事件型 4（不设）= 与 Step 0.1 §8 一致 ✅
（全库时序 11 张 = 上述 9 张 + P1 的 `weight_readings` / `point_transactions`，后两者本期不建）

`source` 取值域（所有时序表 `CHECK` 约束）：`manual / device / vision / import / agent / rule_engine / system / orchestrator / doctor`
`record_status` 取值域：`draft / valid / corrected / void`（默认 `valid`）

---

## 8. 设计文档 height / waist 同步（用户许可范围内，共 4 处）

| # | 位置 | 修订前 | 修订后 |
|---|---|---|---|
| 1 | §3 ① 基本身份信息（patients 档案字段表） | 含 `waist` 行 | 删除 `waist` 行，`height` 标注「★唯一归属本表」，并补一条 `Step 0.1 修订` 说明框 |
| 2 | §6.2 `patients` 表卡 | `height` / `waist`（DECIMAL / INT，身高、腰围） | 仅 `height`（REAL），注明「腰围已移至 `daily_health_records`」 |
| 3 | §6.2 `daily_health_records` 表卡 | 无 `waist` | 新增 `waist`（INT，cm）行，标注「★ 腰围唯一归属本表」 |
| 4 | §2.2 四层归属映射（A 层行） | 「身高 · 体重 · BMI · 腰围」 | 「体重 · 腰围 · BMI（身高归 B 层 `patients`）」，备注补「BMI 派生·不落库」 |

> 其余 `waist` 出现处（`waist_target` 目标字段、指标清单「腰围 · 每周~每月 · R-WT-3」、原始数据清单）**本就与 Step 0.1 一致，未改**。

---

## 9. `metric_definitions` 初始化结果（18 条 · 一行一指标）

| metric_key | 中文名 | 单位 | direction | default_source | available_sources | source_binding 关键点 |
|---|---|---|---|---|---|---|
| `systolic_pressure` | 收缩压 | mmHg | lower | **daily** | [daily, readings] | readings→blood_pressure_readings.systolic |
| `diastolic_pressure` | 舒张压 | mmHg | lower | **daily** | [daily, readings] | readings→blood_pressure_readings.diastolic |
| `fasting_glucose` | 空腹血糖 | mmol/L | lower | **daily** | [daily, readings] | readings 过滤 `measure_type='空腹'` |
| `weight` | 体重 | kg | stable | **daily** | [daily, readings] | readings→weight_readings（**P1，未建**，`built:false`） |
| `heart_rate` | 静息心率 | 次/分 | range | daily | [daily] | — |
| `steps` | 步数 | 步 | higher | daily | [daily] | — |
| `exercise_minutes` | 运动时长 | 分钟 | higher | daily | [daily] | — |
| `sleep_hours` | 睡眠时长 | 小时 | higher | daily | [daily] | — |
| `mood_score` | 心情评分 | 1–5 | higher | daily | [daily] | — |
| `waist` | 腰围 | cm | lower | daily | [daily] | ★ Step 0.1 新增注册 |
| `pulse` | 脉搏 | 次/分 | range | readings | [readings] | blood_pressure_readings.pulse |
| `postprandial_glucose` | 餐后 2h 血糖 | mmol/L | lower | readings | [readings] | 过滤 `measure_type='餐后2h'` |
| `body_fat` | 体脂率 | % | lower | readings | [readings] | weight_readings（**P1，未建**，`built:false`） |
| `hba1c` | 糖化血红蛋白 | % | lower | lab | [lab] | 过滤 `item_name='HbA1c'` |
| `tg` | 甘油三酯 | mmol/L | lower | lab | [lab] | 过滤 `item_name='TG'` |
| `hdl_c` | 高密度脂蛋白胆固醇 | mmol/L | higher | lab | [lab] | 过滤 `item_name='HDL-C'` |
| `ldl_c` | 低密度脂蛋白胆固醇 | mmol/L | lower | lab | [lab] | 过滤 `item_name='LDL-C'` |
| `urine_microalbumin` | 尿微量白蛋白 | mg/L | lower | lab | [lab] | 过滤 `item_name='尿微量白蛋白'` |

**初始化校验**：
- 条数 **18 / 18** ✅
- 每个 `metric_key` **恰一行**（PK 保证）✅
- 每条 `default_source ∈ available_sources` **全部通过** ✅
- 双来源指标 4 个（`systolic_pressure` / `diastolic_pressure` / `fasting_glucose` / `weight`）均 `default_source=daily` ✅
- `badge_definitions` **仅建结构、暂不灌数据**（勋章目录内容随 Step 2/4 处理）

---

## 10. MySQL → SQLite 语法转换对照（未直接复制旧 DDL）

| MySQL 语法 | SQLite 处理 |
|---|---|
| `ENUM('a','b')` | `TEXT` + `CHECK (col IN ('a','b'))` |
| `JSON` | `TEXT`（存 JSON 字符串） |
| `DECIMAL(p,s)` | `REAL` |
| `BOOLEAN` | `INTEGER` + `CHECK (col IN (0,1))` |
| `DATE / DATETIME / TIMESTAMP` | `TEXT`（ISO 8601）+ `CHECK (date(..)/datetime(..) IS NOT NULL)` 格式守卫 |
| `PRIMARY KEY DEFAULT (UUID())` | `TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16))))` |
| `ON UPDATE CURRENT_TIMESTAMP` | 触发器 `trg_patients_updated_at` / `trg_daily_updated_at` / `trg_lifestyle_updated_at` |
| `FOREIGN KEY ... ON DELETE CASCADE` | 原样保留（SQLite 支持） |
| `UNIQUE KEY name (...)` | 表内 `UNIQUE (...)`（生成自动索引） |
| `CREATE INDEX ... ON t(...)` | 原样保留 |
| `ENGINE=InnoDB / CHARSET` 等 | 不使用 |

---

## 11. 明确确认：Step 1 没有修改业务逻辑

- ✅ **未修改前端代码**（`src/pages`、`src/components`、`src/contexts`、`src/services` 等一字未动）
- ✅ **未修改后端 / Agent 代码**（`server/**` 一字未动，未接入数据库、未改 dataProvider）
- ✅ **未修改 `src/data/demoPatients.js`**，三个人物设定不变
- ✅ **未加 npm 依赖、未改 `package.json`、未动 node_modules**
- ✅ 唯一被改写的是 **`src/database/schema.sql`（原设计草稿，无代码引用）**，及用户许可的 `docs/数据指标说明与设计文档.html` 4 处 height/waist 描述
- ✅ 本步**只建库、只初始化元数据**；**未导入任何患者数据**（那是 Step 2）

---

## 12. 下一步（Step 2 · 待指令，不提前执行）

1. 把三位示范患者（张建国 / 李秀英 / 王建军）按 `patient_id = patient_1/2/3` 完整 Seed 进库：
   - `patients`（含 `birth_date` 冻结值 `1958-03-12` / `1961-06-08` / `1964-01-25`、`height`）
   - `patient_contacts` / `patient_conditions` / `patient_lifestyle` / `patient_targets` / `medications`
   - `doctors`（李医生）+ `doctor_patient_relations`
   - 时序数据 `daily_health_records` / `blood_pressure_readings` / `blood_glucose_readings` / `lab_results`
2. 校验：三位患者经 `patient_id` 正确关联、原 `demoPatients.js` 的有效数据完成映射、人设不变。

> **本步到此停止，不进入 Step 2。**
