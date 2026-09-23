-- =============================================================================
-- 迈康 MyCare · SQLite 数据库结构（第二阶段 Step 1 · 冻结版）
-- =============================================================================
-- 依据：docs/Step0.1_取数契约冻结_v0.1.md（已批准）
-- 范围：仅 P0 的 22 张表（不含 P1 weight_readings / point_transactions / user_levels，
--       亦不含 P2 community_activities / user_activity_participations）
-- 数据库：SQLite 3（Node 内置 node:sqlite 驱动）
-- 生成日期：2026-09-14
--
-- 设计要点（与 Step 0.1 一一对应）：
--   · 全库统一患者关联键：patient_id（TEXT）
--   · height 唯一归 patients；waist 唯一归 daily_health_records（随时间测量）
--   · 时序表（共 9 张 P0）必备：patient_id + 时间字段 + source
--       - 测量事实型 5 张另带 record_status（daily_health_records / *_readings / lab_results / medication_logs）
--       - 事件型 4 张不设 record_status（alerts / agent_runs / vision_records / doctor_notes）
--   · 时序表索引一律建在 (patient_id, 时间字段) 上
--   · metric_definitions 采用 default_source + available_sources + source_binding（一行一指标）
--
-- SQLite 风格说明（替换 MySQL 专属语法）：
--   · ENUM        → TEXT + CHECK(...)
--   · JSON        → TEXT（存 JSON 字符串）
--   · DECIMAL     → REAL ; BOOLEAN → INTEGER(0/1) ; DATE/DATETIME/TIMESTAMP → TEXT(ISO 8601)
--   · UUID()      → DEFAULT (lower(hex(randomblob(16))))
--   · ON UPDATE   → 触发器（trg_*_updated_at）
--   · AUTO_INCREMENT / ENGINE 等一律不使用
-- =============================================================================

PRAGMA foreign_keys = ON;

-- -----------------------------------------------------------------------------
-- 第 1 层 · 主数据层（B 基础档案 / C 业务数据 / 元数据）
-- -----------------------------------------------------------------------------

-- 1. patients · 患者主表（全库关联根）
CREATE TABLE IF NOT EXISTS patients (
  patient_id      TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  username        TEXT NOT NULL UNIQUE,
  password_hash   TEXT,                                   -- 示范病例可空串；本阶段不做登录改造
  name            TEXT NOT NULL,
  gender          TEXT NOT NULL CHECK (gender IN ('男','女')),
  birth_date      TEXT CHECK (birth_date IS NULL OR date(birth_date) IS NOT NULL), -- age 由 birth_date 派生，不落库
  height          REAL CHECK (height IS NULL OR height > 0),  -- ★ 身高唯一归属本表（cm）
  phone           TEXT,
  occupation      TEXT,
  elderly_mode    INTEGER NOT NULL DEFAULT 1 CHECK (elderly_mode IN (0,1)),
  voice_enabled   INTEGER NOT NULL DEFAULT 1 CHECK (voice_enabled IN (0,1)),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S','now','localtime')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S','now','localtime')),
  is_active       INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1))
);
CREATE INDEX IF NOT EXISTS idx_patients_active ON patients(is_active);

-- 2. patient_contacts · 紧急联系人（1:N，authorized 为合规红线字段）
CREATE TABLE IF NOT EXISTS patient_contacts (
  contact_id      TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  patient_id      TEXT NOT NULL,
  contact_name    TEXT NOT NULL,
  relation        TEXT,
  contact_phone   TEXT,
  authorized      INTEGER NOT NULL DEFAULT 0 CHECK (authorized IN (0,1)),  -- 红线：可否对外通知
  authorized_at   TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S','now','localtime')),
  FOREIGN KEY (patient_id) REFERENCES patients(patient_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_contacts_patient ON patient_contacts(patient_id);

-- 3. patient_conditions · 疾病诊断（1:N）
CREATE TABLE IF NOT EXISTS patient_conditions (
  condition_id        TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  patient_id          TEXT NOT NULL,
  disease_name        TEXT NOT NULL,                       -- 中文规范病名
  disease_grade       TEXT,
  is_primary          INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0,1)),
  diagnosed_at        TEXT CHECK (diagnosed_at IS NULL OR date(diagnosed_at) IS NOT NULL),
  duration_text       TEXT,
  risk_stratification TEXT,                                -- 医学侧心血管危险分层（非产品预警等级）
  risk_basis          TEXT,
  comorbidities       TEXT,                                -- JSON 数组
  organ_damage        TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S','now','localtime')),
  FOREIGN KEY (patient_id) REFERENCES patients(patient_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_conditions_patient ON patient_conditions(patient_id);

-- 4. patient_lifestyle · 生活画像（1:1）
CREATE TABLE IF NOT EXISTS patient_lifestyle (
  patient_id          TEXT PRIMARY KEY,
  diet                TEXT,
  exercise            TEXT,
  sleep               TEXT,
  biggest_difficulty  TEXT,
  motivation          TEXT,
  ai_style            TEXT,
  tags                TEXT,                                -- JSON：9 项行为标签
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S','now','localtime')),
  FOREIGN KEY (patient_id) REFERENCES patients(patient_id) ON DELETE CASCADE
);

-- 5. patient_targets · 个体化控制目标（1:N，带生效期）
CREATE TABLE IF NOT EXISTS patient_targets (
  target_id             TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  patient_id            TEXT NOT NULL,
  systolic_target       INTEGER,
  diastolic_target      INTEGER,
  fasting_glucose_target REAL,
  hba1c_target          REAL,
  bmi_target            REAL,
  waist_target          INTEGER,
  steps_target          INTEGER,
  weight_change_target  REAL,
  basis                 TEXT,
  effective_from        TEXT CHECK (effective_from IS NULL OR date(effective_from) IS NOT NULL),
  set_by                TEXT,                              -- FK → doctors.doctor_id（可空）
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S','now','localtime')),
  FOREIGN KEY (patient_id) REFERENCES patients(patient_id) ON DELETE CASCADE,
  FOREIGN KEY (set_by) REFERENCES doctors(doctor_id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_targets_patient ON patient_targets(patient_id);

-- 6. doctors · 医生主表（签名来源）
CREATE TABLE IF NOT EXISTS doctors (
  doctor_id       TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  username        TEXT NOT NULL UNIQUE,
  password_hash   TEXT,
  name            TEXT NOT NULL,
  title           TEXT,
  department      TEXT,
  phone           TEXT,
  email           TEXT,
  license_number  TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S','now','localtime')),
  is_active       INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1))
);

-- 7. medications · 长期用药计划（1:N）
CREATE TABLE IF NOT EXISTS medications (
  medication_id   TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  patient_id      TEXT NOT NULL,
  name            TEXT NOT NULL,
  dosage          TEXT,
  time            TEXT,                                    -- 服药时间（如 08:00）
  frequency       TEXT,
  note            TEXT,
  is_active       INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S','now','localtime')),
  FOREIGN KEY (patient_id) REFERENCES patients(patient_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_medications_patient ON medications(patient_id);

-- 8. doctor_patient_relations · 医患关系（1 医生 : N 患者，唯一键 (doctor_id, patient_id)）
CREATE TABLE IF NOT EXISTS doctor_patient_relations (
  relation_id     TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  doctor_id       TEXT NOT NULL,
  patient_id      TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S','now','localtime')),
  is_active       INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  FOREIGN KEY (doctor_id) REFERENCES doctors(doctor_id) ON DELETE CASCADE,
  FOREIGN KEY (patient_id) REFERENCES patients(patient_id) ON DELETE CASCADE,
  UNIQUE (doctor_id, patient_id)
);
CREATE INDEX IF NOT EXISTS idx_relations_patient ON doctor_patient_relations(patient_id);

-- 9. metric_definitions · 指标注册表（元数据 · 一行一指标）
--    double-source 指标用 default_source + available_sources + source_binding 承载
CREATE TABLE IF NOT EXISTS metric_definitions (
  metric_key        TEXT PRIMARY KEY,                       -- 小写 snake_case，唯一
  name_zh           TEXT NOT NULL,
  unit              TEXT,
  direction         TEXT NOT NULL CHECK (direction IN ('lower','higher','range','stable')),
  default_source    TEXT NOT NULL CHECK (default_source IN ('daily','readings','lab')),
  available_sources TEXT NOT NULL,                          -- JSON 数组；default_source 必须 ∈ 此数组
  source_binding    TEXT NOT NULL,                          -- JSON：每来源 { table, value_column, time_column, filter?, built? }
  applies_to        TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S','now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_metric_default_source ON metric_definitions(default_source);

-- 10. badge_definitions · 勋章目录表（元数据 · 统一勋章 id 与显示名）
CREATE TABLE IF NOT EXISTS badge_definitions (
  badge_def_id    TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  badge_key       TEXT NOT NULL UNIQUE,                     -- 目录 id（如 first_record / week_streak）
  badge_type      TEXT,
  badge_name      TEXT NOT NULL,
  description     TEXT,
  icon            TEXT,
  default_points  INTEGER NOT NULL DEFAULT 10,
  level           INTEGER NOT NULL DEFAULT 1,
  threshold       TEXT,                                     -- JSON：达成门槛
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S','now','localtime'))
);

-- -----------------------------------------------------------------------------
-- 第 2 层 · 时序数据层（A 健康指标）
-- -----------------------------------------------------------------------------

-- 11. daily_health_records · 每日健康快照（主干宽表）
--     测量事实型 → 带 record_status；唯一键 (patient_id, record_date)，重复提交走 UPSERT
CREATE TABLE IF NOT EXISTS daily_health_records (
  record_id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  patient_id         TEXT NOT NULL,
  record_date        TEXT NOT NULL CHECK (date(record_date) IS NOT NULL),  -- 时间锚点（日）
  steps              INTEGER,
  systolic_pressure  INTEGER,
  diastolic_pressure INTEGER,
  fasting_glucose    REAL,
  weight             REAL,
  waist              INTEGER,                              -- ★ 腰围唯一归属本表（cm，随时间测量）
  heart_rate         INTEGER,
  exercise_minutes   INTEGER,
  sleep_hours        REAL,
  mood_score         INTEGER CHECK (mood_score IS NULL OR (mood_score >= 1 AND mood_score <= 5)),
  notes              TEXT,
  source             TEXT NOT NULL DEFAULT 'manual'
                     CHECK (source IN ('manual','device','vision','import','agent','rule_engine','system','orchestrator','doctor')),
  record_status      TEXT NOT NULL DEFAULT 'valid'
                     CHECK (record_status IN ('draft','valid','corrected','void')),
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S','now','localtime')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S','now','localtime')),
  FOREIGN KEY (patient_id) REFERENCES patients(patient_id) ON DELETE CASCADE,
  UNIQUE (patient_id, record_date)
);
CREATE INDEX IF NOT EXISTS idx_daily_patient_date ON daily_health_records(patient_id, record_date);

-- 12. blood_pressure_readings · 血压测量明细（一天多测，纯追加）
CREATE TABLE IF NOT EXISTS blood_pressure_readings (
  reading_id    TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  patient_id    TEXT NOT NULL,
  measured_at   TEXT NOT NULL CHECK (datetime(measured_at) IS NOT NULL),  -- 时间锚点（分钟）
  systolic      INTEGER,
  diastolic     INTEGER,
  pulse         INTEGER,
  slot          TEXT CHECK (slot IS NULL OR slot IN ('晨起','上午','下午','睡前')),
  source        TEXT NOT NULL DEFAULT 'manual'
                CHECK (source IN ('manual','device','vision','import','agent','rule_engine','system','orchestrator','doctor')),
  record_status TEXT NOT NULL DEFAULT 'valid'
                CHECK (record_status IN ('draft','valid','corrected','void')),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S','now','localtime')),
  FOREIGN KEY (patient_id) REFERENCES patients(patient_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_bp_patient_time ON blood_pressure_readings(patient_id, measured_at);

-- 13. blood_glucose_readings · 血糖测量明细（必须带 measure_type）
CREATE TABLE IF NOT EXISTS blood_glucose_readings (
  reading_id    TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  patient_id    TEXT NOT NULL,
  measured_at   TEXT NOT NULL CHECK (datetime(measured_at) IS NOT NULL),  -- 时间锚点（分钟）
  value         REAL,
  measure_type  TEXT NOT NULL CHECK (measure_type IN ('空腹','餐后2h','随机','睡前')),
  source        TEXT NOT NULL DEFAULT 'manual'
                CHECK (source IN ('manual','device','vision','import','agent','rule_engine','system','orchestrator','doctor')),
  record_status TEXT NOT NULL DEFAULT 'valid'
                CHECK (record_status IN ('draft','valid','corrected','void')),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S','now','localtime')),
  FOREIGN KEY (patient_id) REFERENCES patients(patient_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_bg_patient_time ON blood_glucose_readings(patient_id, measured_at);

-- 14. lab_results · 化验结果（低频，item_name 区分指标）
CREATE TABLE IF NOT EXISTS lab_results (
  lab_id           TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  patient_id       TEXT NOT NULL,
  test_date        TEXT NOT NULL CHECK (date(test_date) IS NOT NULL),      -- 时间锚点（日）
  item_name        TEXT NOT NULL,                          -- HbA1c / TG / HDL-C / LDL-C / 尿微量白蛋白…
  value            REAL,
  unit             TEXT,
  reference_range  TEXT,
  is_abnormal      INTEGER CHECK (is_abnormal IS NULL OR is_abnormal IN (0,1)),
  source           TEXT NOT NULL DEFAULT 'manual'
                   CHECK (source IN ('manual','device','vision','import','agent','rule_engine','system','orchestrator','doctor')),
  record_status    TEXT NOT NULL DEFAULT 'valid'
                   CHECK (record_status IN ('draft','valid','corrected','void')),
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S','now','localtime')),
  FOREIGN KEY (patient_id) REFERENCES patients(patient_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_lab_patient_date ON lab_results(patient_id, test_date);
CREATE INDEX IF NOT EXISTS idx_lab_patient_item ON lab_results(patient_id, item_name);

-- -----------------------------------------------------------------------------
-- 第 3 层 · 事件数据层（D AI 系统数据 / C 业务数据）
-- 事件型表「只增不改」→ 不设 record_status
-- -----------------------------------------------------------------------------

-- 15. alerts · 预警记录（事件型）
CREATE TABLE IF NOT EXISTS alerts (
  alert_id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  patient_id        TEXT NOT NULL,
  level             TEXT NOT NULL CHECK (level IN ('提示','关注','预警','紧急')),
  title             TEXT,
  detail            TEXT,
  action            TEXT,
  notify_targets    TEXT,                                  -- JSON
  pending_notify    TEXT,                                  -- JSON
  external_blocked  INTEGER NOT NULL DEFAULT 0 CHECK (external_blocked IN (0,1)),
  confirmed         INTEGER NOT NULL DEFAULT 0 CHECK (confirmed IN (0,1)),
  rule_id           TEXT,                                  -- 命中规则（如 R-BP-2）
  source            TEXT NOT NULL DEFAULT 'rule_engine'
                    CHECK (source IN ('manual','device','vision','import','agent','rule_engine','system','orchestrator','doctor')),
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S','now','localtime')),  -- 时间锚点（秒）
  FOREIGN KEY (patient_id) REFERENCES patients(patient_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_alerts_patient_time ON alerts(patient_id, created_at);
CREATE INDEX IF NOT EXISTS idx_alerts_level ON alerts(level);

-- 16. reminders · 提醒（C 业务数据）
CREATE TABLE IF NOT EXISTS reminders (
  reminder_id   TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  patient_id    TEXT NOT NULL,
  text          TEXT NOT NULL,
  time          TEXT,
  repeat_rule   TEXT NOT NULL DEFAULT 'daily' CHECK (repeat_rule IN ('once','daily','weekly')),
  tip           TEXT,
  source        TEXT NOT NULL DEFAULT 'system'
                CHECK (source IN ('manual','device','vision','import','agent','rule_engine','system','orchestrator','doctor')),
  is_active     INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S','now','localtime')),
  FOREIGN KEY (patient_id) REFERENCES patients(patient_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_reminders_patient ON reminders(patient_id);

-- 17. doctor_notes · 医生备注（事件型 · 签名取 doctors.name）
CREATE TABLE IF NOT EXISTS doctor_notes (
  note_id     TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  doctor_id   TEXT NOT NULL,
  patient_id  TEXT NOT NULL,
  content     TEXT NOT NULL,
  note_type   TEXT NOT NULL DEFAULT '建议' CHECK (note_type IN ('建议','警告','表扬','处方调整')),
  priority    TEXT NOT NULL DEFAULT '中' CHECK (priority IN ('低','中','高','紧急')),
  is_read     INTEGER NOT NULL DEFAULT 0 CHECK (is_read IN (0,1)),
  source      TEXT NOT NULL DEFAULT 'doctor'
              CHECK (source IN ('manual','device','vision','import','agent','rule_engine','system','orchestrator','doctor')),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S','now','localtime')),  -- 时间锚点（秒）
  FOREIGN KEY (doctor_id) REFERENCES doctors(doctor_id) ON DELETE CASCADE,
  FOREIGN KEY (patient_id) REFERENCES patients(patient_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_doctor_notes_patient_time ON doctor_notes(patient_id, created_at);
CREATE INDEX IF NOT EXISTS idx_doctor_notes_read ON doctor_notes(patient_id, is_read);

-- 18. medication_logs · 服药记录（测量事实型 → 带 record_status；status≠record_status）
CREATE TABLE IF NOT EXISTS medication_logs (
  log_id         TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  patient_id     TEXT NOT NULL,
  medication_id  TEXT,
  planned_time   TEXT NOT NULL CHECK (datetime(planned_time) IS NOT NULL),  -- 时间锚点（分钟）
  taken_at       TEXT CHECK (taken_at IS NULL OR datetime(taken_at) IS NOT NULL),
  status         TEXT NOT NULL DEFAULT '已服' CHECK (status IN ('已服','漏服','延迟')),  -- 依从性业务状态
  source         TEXT NOT NULL DEFAULT 'manual'
                 CHECK (source IN ('manual','device','vision','import','agent','rule_engine','system','orchestrator','doctor')),
  record_status  TEXT NOT NULL DEFAULT 'valid'
                 CHECK (record_status IN ('draft','valid','corrected','void')),  -- 记录质控状态
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S','now','localtime')),
  FOREIGN KEY (patient_id) REFERENCES patients(patient_id) ON DELETE CASCADE,
  FOREIGN KEY (medication_id) REFERENCES medications(medication_id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_med_logs_patient_time ON medication_logs(patient_id, planned_time);

-- 19. agent_runs · 智能体运行记录（事件型）
CREATE TABLE IF NOT EXISTS agent_runs (
  run_id       TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  patient_id   TEXT NOT NULL,
  goal         TEXT,
  model        TEXT,
  events       TEXT,                                       -- JSON：推理轨迹 / 工具调用
  duration_ms  INTEGER,
  source       TEXT NOT NULL DEFAULT 'orchestrator'
               CHECK (source IN ('manual','device','vision','import','agent','rule_engine','system','orchestrator','doctor')),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S','now','localtime')),  -- 时间锚点（秒）
  FOREIGN KEY (patient_id) REFERENCES patients(patient_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_agent_runs_patient_time ON agent_runs(patient_id, created_at);

-- 20. vision_records · 图像识别记录（事件型）
CREATE TABLE IF NOT EXISTS vision_records (
  vision_id    TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  patient_id   TEXT NOT NULL,
  doc_type     TEXT CHECK (doc_type IS NULL OR doc_type IN ('药盒','化验单','报告')),
  ocr_text     TEXT,
  result       TEXT,                                       -- JSON
  mode         TEXT,
  source       TEXT NOT NULL DEFAULT 'vision'
               CHECK (source IN ('manual','device','vision','import','agent','rule_engine','system','orchestrator','doctor')),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S','now','localtime')),  -- 时间锚点（秒）
  FOREIGN KEY (patient_id) REFERENCES patients(patient_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_vision_patient_time ON vision_records(patient_id, created_at);

-- -----------------------------------------------------------------------------
-- 第 4 层 · 处方 / 干预层（C 业务数据）
-- -----------------------------------------------------------------------------

-- 21. prescriptions · 健康处方（1:N，仅一条 is_active）
CREATE TABLE IF NOT EXISTS prescriptions (
  prescription_id       TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  patient_id            TEXT NOT NULL,
  exercise_plan         TEXT,                              -- JSON
  diet_plan             TEXT,                              -- JSON
  medication_reminders  TEXT,                              -- JSON
  target_goals          TEXT,                              -- JSON
  generated_date        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S','now','localtime')),
  is_active             INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  doctor_modified       INTEGER NOT NULL DEFAULT 0 CHECK (doctor_modified IN (0,1)),
  created_by            TEXT NOT NULL DEFAULT 'agent' CHECK (created_by IN ('agent','doctor')),
  FOREIGN KEY (patient_id) REFERENCES patients(patient_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_prescriptions_patient_active ON prescriptions(patient_id, is_active);

-- -----------------------------------------------------------------------------
-- 第 5 层 · 激励层（C 业务数据）
-- -----------------------------------------------------------------------------

-- 22. badges · 勋章记录（只引用 badge_def_id，不再自存枚举）
CREATE TABLE IF NOT EXISTS badges (
  badge_id      TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  patient_id    TEXT NOT NULL,
  badge_def_id  TEXT NOT NULL,
  earned_date   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S','now','localtime')),
  level         INTEGER NOT NULL DEFAULT 1,
  points        INTEGER NOT NULL DEFAULT 10,
  FOREIGN KEY (patient_id) REFERENCES patients(patient_id) ON DELETE CASCADE,
  FOREIGN KEY (badge_def_id) REFERENCES badge_definitions(badge_def_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_badges_patient ON badges(patient_id);
CREATE INDEX IF NOT EXISTS idx_badges_patient_date ON badges(patient_id, earned_date);

-- -----------------------------------------------------------------------------
-- updated_at 自动维护（替代 MySQL 的 ON UPDATE CURRENT_TIMESTAMP）
-- -----------------------------------------------------------------------------
CREATE TRIGGER IF NOT EXISTS trg_patients_updated_at
AFTER UPDATE ON patients FOR EACH ROW
BEGIN
  UPDATE patients SET updated_at = strftime('%Y-%m-%dT%H:%M:%S','now','localtime')
  WHERE patient_id = OLD.patient_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_daily_updated_at
AFTER UPDATE ON daily_health_records FOR EACH ROW
BEGIN
  UPDATE daily_health_records SET updated_at = strftime('%Y-%m-%dT%H:%M:%S','now','localtime')
  WHERE record_id = OLD.record_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_lifestyle_updated_at
AFTER UPDATE ON patient_lifestyle FOR EACH ROW
BEGIN
  UPDATE patient_lifestyle SET updated_at = strftime('%Y-%m-%dT%H:%M:%S','now','localtime')
  WHERE patient_id = OLD.patient_id;
END;
