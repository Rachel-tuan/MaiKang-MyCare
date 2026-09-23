# 第二阶段 · Step 0 · 取数契约冻结（v1.0）

> 项目：迈康 MyCare · 老年慢病多智能体协同健康管理平台
> 依据：`docs/数据指标说明与设计文档.html` v1.2（已批准进入第二阶段）
> 性质：**冻结接口形状与表清单。本步不建库、不建表、不改任何业务代码。**
> 日期：2026-09-14
> 状态：待确认 → 确认后进入 Step 1（建库）

---

## 0. 本步边界声明

| 项 | 状态 |
|---|---|
| 是否创建数据库 / 执行 DDL | **否** |
| 是否修改前端 / 后端 / Agent 代码 | **否** |
| 是否改动 `demoPatients.js` / 三个人物设定 | **否** |
| 本次新增文件 | 仅本文件（`docs/Step0_取数契约冻结_v1.0.md`） |
| 输出内容 | ① 三个取数契约的完整定义　② 27 张表清单复核结果 |

**冻结含义**：本文件确认后，Step 1–6 一律以本文件的契约形状与表清单为准；如需变更，必须回到本文件先改契约、再改实现。

---

## 1. 三个取数契约（dataProvider）

`dataProvider` 是 **页面与 Agent 唯一的取数入口**，位于后端，直接查询 SQLite。
上层（前端页面 / Agent）只调用这三个函数，不关心底层是宽表还是多表。

统一约定：

- 三个函数均为 **async**（返回 `Promise`）。
- 参数中的患者键一律为 **`patientId`**（对应数据库 `patients.patient_id`，见 §3）。
- 所有返回值都是 **纯数据对象**（可 JSON 序列化），不含类实例、函数或 DB 句柄。
- **派生值（达标率 / 趋势斜率 / 均值等）一律现算，不落库**（与设计文档 §8.3 一致）。

---

### 1.1 `getSeries` —— 取某一指标的时序序列

> 用途：趋势图、规则引擎、Agent 的「近 N 天某指标」诉求。

#### 签名

```js
getSeries(patientId, metricKey, days = 7, options = {}) => Promise<SeriesResult>
```

#### 入参

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `patientId` | string | ✅ | — | 患者关联键，对应 `patients.patient_id` |
| `metricKey` | string | ✅ | — | 指标键，规则见 §4 |
| `days` | number | ✗ | `7` | 相对窗口天数（含首尾），`1 ≤ days ≤ 365` |
| `options.from` | `YYYY-MM-DD` | ✗ | — | 绝对起始日；给定后**覆盖** `days` 的起点 |
| `options.to` | `YYYY-MM-DD` | ✗ | — | 绝对结束日；给定后**覆盖** `days` 的终点 |
| `options.anchorMode` | `'latest' \| 'today'` | ✗ | `'latest'` | 未给 `from/to` 时，窗口末端锚点（见 §5） |
| `options.source` | `'daily' \| 'readings' \| 'lab'` | ✗ | 按 `metricKey` 解析 | 强制限定来源表（消歧用） |
| `options.measureType` | `'空腹' \| '餐后2h' \| '随机' \| '睡前'` | ✗ | — | 仅血糖细表用；不传则不过滤 |
| `options.includeRecordStatus` | string[] | ✗ | `['valid','corrected']` | 参与计算/展示的记录质控状态白名单 |

#### 返回结构 `SeriesResult`

```jsonc
{
  "patientId": "patient_1",
  "metricKey": "systolic_pressure",
  "resolvedSource": "daily_health_records",   // 实际命中的来源表
  "label": "收缩压",
  "unit": "mmHg",
  "direction": "lower",            // lower / higher / range / stable（来自 metric_definitions）
  "target": 140,                   // 个体化目标，来自 patient_targets；无则 null
  "window": {
    "days": 7,
    "from": "2026-09-08",
    "to": "2026-09-14",
    "anchorMode": "latest"
  },
  "points": [                       // 按时间升序（旧 → 新）
    { "date": "2026-09-08", "at": "2026-09-08", "value": 132, "source": "manual", "recordStatus": "valid" }
    // at：日粒度=YYYY-MM-DD；分钟粒度=YYYY-MM-DDTHH:mm:ss+08:00
  ],
  "count": 7,
  "empty": false,
  "stats": {                        // 现算，不落库；count=0 时为 null
    "first": 132, "latest": 162, "latestDate": "2026-09-14",
    "min": 132, "max": 162, "mean": 145.7, "range": 30,
    "change": 30, "pctChange": 22.7,
    "slope": 4.86,                  // 最小二乘斜率（单位/天）
    "direction": "rising"           // rising / falling / stable（现算趋势）
  }
}
```

#### 错误处理

- `patientId` 缺失/为空 → 抛 `E_INVALID_ARG`
- `metricKey` 未在 `metric_definitions` 注册 → 抛 `E_UNKNOWN_METRIC`
- `days` 非正整数或越界 → 抛 `E_INVALID_ARG`
- 该患者 / 该指标 / 该窗口**查无数据** → **不抛错**，返回 `points: []`、`count: 0`、`empty: true`、`stats: null`
- 数据库不可用 → 抛 `E_DB_UNAVAILABLE`

---

### 1.2 `getDailySnapshot` —— 取「某一天的当日快照」

> 用途：首页「今天的数据」、健康数据页的当日卡片。对应设计文档 §6.1「当日快照」概念。

#### 签名

```js
getDailySnapshot(patientId, date = <今天>) => Promise<SnapshotResult>
```

#### 入参

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `patientId` | string | ✅ | — | 患者关联键 |
| `date` | `YYYY-MM-DD` | ✗ | 系统当天（东八区） | 目标日期 |

#### 返回结构 `SnapshotResult`

```jsonc
{
  "patientId": "patient_1",
  "date": "2026-09-14",
  "exists": true,                  // 是否存在该日的 daily_health_records 行
  "values": {                      // 当日代表值（宽表一行）；exists=false 时为 null
    "systolic_pressure": 162,
    "diastolic_pressure": 98,
    "fasting_glucose": 5.4,
    "weight": 75.0,
    "heart_rate": 82,
    "steps": 5200,
    "exercise_minutes": 20,
    "sleep_hours": 6.0,
    "mood_score": 3,
    "notes": ""
  },
  "details": {                     // 当日「一天多测」的专项细表原始记录
    "blood_pressure": [ { "readingId": "...", "at": "2026-09-14T08:05:00+08:00", "systolic": 162, "diastolic": 98, "pulse": 82, "slot": "晨起", "source": "manual", "recordStatus": "valid" } ],
    "blood_glucose":  [ { "readingId": "...", "at": "2026-09-14T07:30:00+08:00", "value": 5.4, "measureType": "空腹", "source": "manual", "recordStatus": "valid" } ],
    "weight":         []
  },
  "lab": [                         // 当日化验（一般为空，化验为低频）
    { "itemName": "hba1c", "value": 7.8, "unit": "%", "referenceRange": "<7.0", "isAbnormal": true }
  ],
  "meta": { "source": "manual", "recordStatus": "valid", "createdAt": "...", "updatedAt": "..." }
}
```

#### 错误处理

- `patientId` 缺失 → 抛 `E_INVALID_ARG`
- `date` 格式非法 → 抛 `E_INVALID_ARG`
- 患者不存在 → 抛 `E_PATIENT_NOT_FOUND`
- 该日**无任何数据** → **不抛错**：`exists: false`、`values: null`、`details` 三个键为空数组、`lab: []`
- 数据库不可用 → 抛 `E_DB_UNAVAILABLE`

---

### 1.3 `getPatientProfile` —— 取患者完整档案

> 用途：`UserContext` 登录后建档、医生端患者详情、Agent 的 `get_user_profile` 工具。

#### 签名

```js
getPatientProfile(patientId) => Promise<ProfileResult>
```

#### 入参

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `patientId` | string | ✅ | 患者关联键 |

#### 返回结构 `ProfileResult`

```jsonc
{
  "patientId": "patient_1",
  "identity": {
    "username": "zhangjianguo",
    "name": "张建国",
    "gender": "男",
    "birthDate": "1958-03-12",
    "age": 68,                     // 由 birthDate 现算（不落库）
    "height": 170,
    "waist": 92,
    "phone": "13800138001",
    "occupation": "退休（原机械厂工人）",
    "elderlyMode": true,
    "voiceEnabled": true,
    "isActive": true
  },
  "contacts": [
    { "contactId": "...", "name": "张伟", "relation": "儿子", "phone": "13800138002", "authorized": true, "authorizedAt": "..." }
  ],
  "conditions": [
    { "conditionId": "...", "diseaseName": "原发性高血压", "diseaseGrade": "2 级", "isPrimary": true,
      "diagnosedAt": "2023-05-01", "durationText": "确诊 3 年",
      "riskStratification": "中危", "riskBasis": "...", "comorbidities": ["超重","中心性肥胖"], "organDamage": "无（……）" }
  ],
  "lifestyle": {
    "diet": "口味偏咸，日均食盐约 10 g，爱吃腌菜",
    "exercise": "偶尔散步，无固定运动习惯",
    "sleep": "入睡偏晚，日均约 6 小时",
    "biggestDifficulty": "担心血压控制不住",
    "motivation": "怕给子女添麻烦",
    "aiStyle": "安抚 + 警示",
    "tags": { "highSalt": true, "pickledFood": true, "refinedStaple": false, "fastEating": false,
              "lowVegetable": false, "lateHeavyDinner": false, "irregularMeals": false, "sedentary": false, "snoring": false }
  },
  "targets": {
    "systolicTarget": 140, "diastolicTarget": 90,
    "fastingGlucoseTarget": null, "hba1cTarget": null,
    "bmiTarget": null, "waistTarget": null, "stepsTarget": null,
    "weightChangeTarget": null,
    "basis": "《中国老年高血压管理指南 2023》：65–79 岁先降至 < 140/90……",
    "effectiveFrom": "2026-09-01", "setBy": null
  },
  "medications": [
    { "medicationId": "...", "name": "苯磺酸氨氯地平片", "dosage": "5 mg", "time": "08:00", "frequency": "每日 1 次", "note": "晨服……", "isActive": true }
  ],
  "doctors": [
    { "doctorId": "doc_li", "name": "李医生", "title": "主任医师", "department": "全科", "relationId": "..." }
  ],
  "derived": { "bmi": 26.0, "emergencyContact": { "name": "张伟", "relation": "儿子", "phone": "13800138002", "authorized": true } }
}
```

> **兼容说明**：Step 3 会在此基础上提供一个纯函数 `toUserProfileView(profile)`，
> 把 `ProfileResult` 还原成现有 `demoPatients.js → toUserProfile()` 的同形对象，
> 使前端 `UserContext` / 页面与 Agent 的 `context.user` 字段**无需大改**。
> 该还原结果属派生视图，**不是**数据源。

#### 错误处理

- `patientId` 缺失 → 抛 `E_INVALID_ARG`
- 患者不存在 → 抛 `E_PATIENT_NOT_FOUND`
- 数据库不可用 → 抛 `E_DB_UNAVAILABLE`
- 关联子表（contacts / conditions / …）为空 → 返回空数组，**不抛错**

---

## 2. 统一错误模型

所有 dataProvider 抛出的错误都是 `DataProviderError` 实例：

```js
class DataProviderError extends Error {
  code      // 见下表
  detail    // 可选：出错时被查询的 patientId / metricKey / sql 片段
}
```

| code | 触发场景 | Step 3 的 HTTP 映射 |
|---|---|---|
| `E_INVALID_ARG` | 入参缺失 / 非法（patientId 空、days 越界、date 非法） | `400` |
| `E_PATIENT_NOT_FOUND` | `patients` 无该 `patient_id` | `404` |
| `E_UNKNOWN_METRIC` | `metricKey` 未注册 | `400` |
| `E_DB_UNAVAILABLE` | SQLite 打开 / 查询失败 | `503` |
| `E_INTERNAL` | 其它未预期错误 | `500` |

**「查无数据」不是错误**（`getSeries.empty` / `getDailySnapshot.exists=false`），
避免前端把「还没记录」误报成故障。

---

## 3. `patient_id` 传递方式（冻结）

1. **唯一键名**：`patient_id`。数据库主键、外键、API 参数、Agent 入参**一律**用 `patient_id`。
2. **取值空间**：string。示范病例为 `patient_1` / `patient_2` / `patient_3`。
   > 现存 `demoPatients.js` 中 `id: 'patient_1'`，`toUserProfile()` 输出 `user_id: patient.id`——
   > 即 **`user_id` 的取值本来就等于 `patient_id`**，第二阶段只需改键名，不改值，历史数据零迁移。
3. **传输通道**：
   | 场景 | 传法 |
   |---|---|
   | GET（如 `/api/patients/:id/series`） | URL 路径或 query：`?patient_id=` |
   | POST / SSE（编排、对话、录入） | JSON body 字段 `patient_id` |
   | Agent 调用编排 | body `{ patient_id, goal }`（**只有这两个必填**） |
4. **兼容别名**：入站层（API handler）可接受 `user_id` 作为**兼容别名**，在**入口处一次性**
   映射为 `patient_id`；进入 dataProvider 之后**只认 `patient_id`**。别名映射只做一次，不做链式传播。
5. **严格性**：`patient_id` 必填且必须能查到患者；**缺失 → `E_INVALID_ARG`，查不到 → `E_PATIENT_NOT_FOUND`**。
   dataProvider **不做**「找不到就回落到默认患者」的兜底（兜底只允许存在于登录页 UI）。
6. **信任边界**：前端**只允许**上传 `patient_id`（及 `goal` / 用户输入的自然语言）。
   所有 `records` / `badges` / `profile` 一律由**服务端按 `patient_id` 现查**，前端不得再上传健康数据快照。

---

## 4. `metricKey` 规则（冻结）

### 4.1 命名规则

- 一律 **小写 `snake_case`**。
- 与 `daily_health_records` 列名同名者直接复用（如 `systolic_pressure`）。
- 化验项以其规范短键命名（如 `hba1c`）。
- 权威注册处：**`metric_definitions` 表**（P0 表，Step 1 建立）。每个 `metric_key` 声明
  `名称 / 单位 / 方向(direction) / 适用人群 / 来源(source_table) / 值列(value_column) / 时间列(time_column)`。
- **未注册的 `metricKey` 直接抛 `E_UNKNOWN_METRIC`**——不在代码里隐式兜底。

### 4.2 指标全集（本次冻结的注册内容）

**A 类 · 日指标**（来源 `daily_health_records`，时间列 `record_date`，日粒度）

| metricKey | 中文名 | 单位 | direction |
|---|---|---|---|
| `systolic_pressure` | 收缩压 | mmHg | lower |
| `diastolic_pressure` | 舒张压 | mmHg | lower |
| `fasting_glucose` | 空腹血糖 | mmol/L | lower |
| `weight` | 体重 | kg | stable |
| `heart_rate` | 静息心率 | 次/分 | range |
| `steps` | 步数 | 步 | higher |
| `exercise_minutes` | 运动时长 | 分钟 | higher |
| `sleep_hours` | 睡眠时长 | 小时 | higher |
| `mood_score` | 心情评分 | 1–5 | higher |

**B 类 · 细表指标**（来源 `*_readings`，时间列 `measured_at`，分钟粒度）

| metricKey | 来源表 | 值列 | 备注 |
|---|---|---|---|
| `systolic_pressure` | `blood_pressure_readings` | `systolic` | 需 `options.source='readings'` 消歧 |
| `diastolic_pressure` | `blood_pressure_readings` | `diastolic` | 同上 |
| `pulse` | `blood_pressure_readings` | `pulse` | — |
| `fasting_glucose` | `blood_glucose_readings` | `value` | 需 `measureType='空腹'` |
| `postprandial_glucose` | `blood_glucose_readings` | `value` | `measureType='餐后2h'` |
| `weight` | `weight_readings` | `weight` | P1 表；宽表已够时可缓建 |
| `body_fat` | `weight_readings` | `body_fat` | P1 表 |

> 消歧规则：A 类与 B 类存在同名键（`systolic_pressure` / `diastolic_pressure` / `fasting_glucose` / `weight`）。
> **默认命中 A 类（宽表）**；调用方如需细表序列，必须显式传 `options.source='readings'`。

**C 类 · 化验指标**（来源 `lab_results`，时间列 `test_date`，日粒度，按 `item_name` 过滤）

| metricKey | 对应 `item_name` |
|---|---|
| `hba1c` | HbA1c |
| `tg` | 甘油三酯 |
| `hdl_c` | 高密度脂蛋白胆固醇 |
| `ldl_c` | 低密度脂蛋白胆固醇 |
| `urine_microalbumin` | 尿微量白蛋白 |

**D 类 · 派生指标（不入库、不注册为 metricKey，由上层现算）**
`bmi`、`age`、健康评分、达标率、趋势斜率、连续异常天数、控制状态、产品预警等级。

### 4.3 别名兼容表（Step 4/5 迁移期用，非新增指标）

现行代码中存在「视图风格」键名，入站层做一次归一：

| 现存别名 | → 规范 `metricKey` |
|---|---|
| `blood_sugar` / `bloodSugar` / `glucose` | `fasting_glucose` |
| `systolic` | `systolic_pressure` |
| `diastolic` | `diastolic_pressure` |
| `heartRate` | `heart_rate` |
| `exerciseMinutes` | `exercise_minutes` |
| `sleepHours` | `sleep_hours` |
| `moodScore` | `mood_score` |

> 归一后，`src/utils/clinicalRules.js` 的 `FIELD_KEYS`、`src/contexts/HealthDataContext.jsx` 的
> `normalizeRecord` 均可收敛为「只认规范键」，但**这一步在 Step 4/5 再做**，Step 0 不动。

---

## 5. 时间范围（冻结）

### 5.1 取值优先级

```
显式 from/to  >  days + anchorMode  >  默认（days=7, anchorMode='latest'）
```

### 5.2 窗口定义

- 窗口**含首含尾**（`from` 与 `to` 两天都计入）。
- 未给 `from/to` 时：`to = 锚点日`，`from = to − (days − 1) 天`。
- 锚点日 `anchorMode`：
  - **`'latest'`（默认）** —— 取该患者该指标**最新一条记录的日期**为末端。
  - `'today'` —— 取**系统当天（东八区）**为末端。

### 5.3 为什么默认锚定「最新记录日」而不是「今天」

| 理由 | 说明 |
|---|---|
| ① 与现有规则引擎语义一致 | `server/agents/tools.js` 的 `recentRecords()` 正是以「最后一条记录的日期」为锚点。默认锚定最新记录日，**规则行为零变化**，避免 Step 3/5 引入回归。 |
| ② 演示可复现、不会「过期」 | 若锚定系统当天，则种子数据的 7 天窗口会随日历推移而逐渐滑出，演示数据「过期变空」。锚定最新记录日则任何日期打开都能看到完整曲线。 |
| ③ 仍满足「动态增长」验收项 H | 新增一条日期更晚的记录后，末端随之前移，曲线自然增长、规则随之重算。 |

> 需要「以日历今天为准」的场景（如首页当日快照），用 `getDailySnapshot(patientId)`：其 `date` 默认即系统当天。

### 5.4 时区与格式

- 时区固定 **东八区（Asia/Shanghai）**，全链路统一。
- 日期格式固定 **`YYYY-MM-DD`**；时刻格式固定 **ISO 8601 带偏移**（`YYYY-MM-DDTHH:mm:ss+08:00`）。
- `record_date`（日）与 `measured_at`（分）语义不可互换；`created_at` 是**记录发生时刻，不是测量时刻**。

---

## 6. 27 张表清单复核（逐行核对，不增不减）

### 6.1 冻结清单复核结果

✅ 与设计文档 §13.2 逐行一致：**27 张 = 启用 25 + 预留 2**。

| # | 表名 | 中文名 | 数据层 | 主键 | 时序 | 优先级 |
|---|---|---|---|---|---|---|
| 1 | `patients` | 患者主表 | B | `patient_id` | 否 | P0 |
| 2 | `patient_contacts` | 紧急联系人 | B | `contact_id` | 否 | P0 |
| 3 | `patient_conditions` | 疾病诊断 | B | `condition_id` | 否 | P0 |
| 4 | `patient_lifestyle` | 生活画像 | B | `patient_id` | 否 | P0 |
| 5 | `patient_targets` | 个体化控制目标 | B | `target_id` | 否 | P0 |
| 6 | `medications` | 长期用药计划 | C | `medication_id` | 否 | P0 |
| 7 | `doctors` | 医生主表 | B | `doctor_id` | 否 | P0 |
| 8 | `doctor_patient_relations` | 医患关系 | C | `relation_id` | 否 | P0 |
| 9 | `metric_definitions` | 指标注册表 | 元数据 | `metric_key` | 否 | P0 |
| 10 | `badge_definitions` | 勋章目录表 | 元数据 | `badge_def_id` | 否 | P0 |
| 11 | `daily_health_records` | 每日健康快照（**主干宽表**） | A | `record_id` | 是(日) | P0 |
| 12 | `blood_pressure_readings` | 血压测量明细 | A | `reading_id` | 是(分) | P0 |
| 13 | `blood_glucose_readings` | 血糖测量明细 | A | `reading_id` | 是(分) | P0 |
| 14 | `lab_results` | 化验结果 | A | `lab_id` | 是(日) | P0 |
| 15 | `alerts` | 预警记录 | D | `alert_id` | 是(秒) | P0 |
| 16 | `reminders` | 提醒 | C | `reminder_id` | 否 | P0 |
| 17 | `doctor_notes` | 医生备注 | C | `note_id` | 是(秒) | P0 |
| 18 | `medication_logs` | 服药记录 | C | `log_id` | 是(分) | P0 |
| 19 | `agent_runs` | 智能体运行记录 | D | `run_id` | 是(秒) | P0 |
| 20 | `vision_records` | 图像识别记录 | D | `vision_id` | 是(秒) | P0 |
| 21 | `prescriptions` | 健康处方 | C | `prescription_id` | 否 | P0 |
| 22 | `badges` | 勋章记录 | C | `badge_id` | 否 | P0 |
| 23 | `weight_readings` | 体重测量明细 | A | `reading_id` | 是(分) | P1 |
| 24 | `point_transactions` | 积分流水 | C | `txn_id` | 是(秒) | P1 |
| 25 | `user_levels` | 等级 | C | `patient_id` | 否 | P1 |
| 26 | `community_activities` | 社区活动 | C | `activity_id` | 否 | P2 |
| 27 | `user_activity_participations` | 活动参与 | C | `participation_id` | 否 | P2 |

### 6.2 计数三方闭合自检

| 口径 | 结果 |
|---|---|
| 优先级：P0 + P1 + P2 | **22 + 3 + 2 = 27** ✅ |
| 四层：A + B + C + D + 元数据 | **5 + 6 + 11 + 3 + 2 = 27** ✅ |
| 时序表：测量事实型 + 事件型 | **6 + 5 = 11**（§8.1） ✅ |
| 冻结清单行号 | **1–27 连续** ✅ |

### 6.3 与现存 `src/database/schema.sql` 的对照（**关键：确认无遗漏、无重复**）

现存 `schema.sql` 只有 **10 张表**，且为 MySQL 风格 DDL（`ENUM` / `JSON` / `ON UPDATE` / `UUID()`），**与 SQLite 不兼容**。
本次冻结 **不是新增 27 张，而是在既有 10 张基础上升级**，逐张对应如下（**无一张被静默丢弃**）：

| 现存 10 张 | 去向 | 说明 |
|---|---|---|
| `users` | ➜ `patients` + 拆出 `patient_contacts` / `patient_conditions` / `patient_lifestyle` / `patient_targets` | **重命名 + 拆表**（原一行大宽档 → 主表 + 4 张关联表） |
| `health_records` | ➜ `daily_health_records` | **重命名**（列名微调：`blood_sugar`→`fasting_glucose`，新增 `source`/`record_status`） |
| `prescriptions` | ➜ `prescriptions` | 保留；新增 `created_by` 列 |
| `badges` | ➜ `badges` + 新增 `badge_definitions` | 保留；勋章枚举抽到目录表 |
| `doctor_notes` | ➜ `doctor_notes` | 保留；`user_id`→`patient_id`，新增 `source` |
| `doctors` | ➜ `doctors` | 保留 |
| `doctor_patient_relations` | ➜ `doctor_patient_relations` | 保留；`user_id`→`patient_id` |
| `user_levels` | ➜ `user_levels` | 保留（P1） |
| `community_activities` | ➜ `community_activities` | 保留（P2） |
| `user_activity_participations` | ➜ `user_activity_participations` | 保留（P2） |

**新增表：17 张** = `patient_contacts`、`patient_conditions`、`patient_lifestyle`、`patient_targets`、`medications`、
`metric_definitions`、`badge_definitions`、`blood_pressure_readings`、`blood_glucose_readings`、`weight_readings`、
`lab_results`、`alerts`、`reminders`、`medication_logs`、`agent_runs`、`vision_records`、`point_transactions`。

**复核结论**：`10（现存，2 重命名 + 8 保留） + 17（新增） = 27` ✅　与冻结清单完全一致，**无擅自增删**。

---

## 7. 与后续 Step 的衔接（本步只冻结、不执行）

| Step | 依赖本契约的哪一部分 |
|---|---|
| Step 1 建库 | §6 表清单（仅建 P0 的 22 张）、§5 时间语义（时序表时间列）、§4 `metric_definitions` 内容 |
| Step 2 导种子 | §3 `patient_id` 取值（`patient_1/2/3`）、§1.3 `ProfileResult` 的拆表映射 |
| Step 3 dataProvider | §1 三个函数的签名与返回结构、§2 错误模型、§3 传递方式、§4 metricKey、§5 时间范围 |
| Step 4 前端改造 | §1.2 `getDailySnapshot`、§1.3 `ProfileResult` + `toUserProfileView`、§4.3 别名表 |
| Step 5 Agent 改造 | §3 的 `{ patient_id, goal }` 入参、§1.1/§1.3 作为工具取数来源 |
| Step 6 验收 | §5.3 理由 ③（新增记录后窗口前移）、全文「重新请求 API 或刷新页面」口径 |

---

## 8. 已知风险 / 需确认事项（不擅自决定，仅提示）

1. **`patients` 表不存 `password_hash` 之外的登录态**：现 `users.password_hash` 在拆表后归 `patients`。
   三个示范病例当前无真实口令（登录走「示范病例入口」直接给 `patient_id`）。Step 1 保留该列但允许空串，
   不引入登录改造（登录改造不在第二阶段范围内）。
2. **`age` 入库形式**：设计文档要求年龄由 `birth_date` 派生。但 `demoPatients.js` 只给了 `age`（无生日）。
   Step 2 导入时需**由 `age` 反推一个 `birth_date`**（取当年生日已过，保证现算年龄等于原设定），
   以同时满足「不改变人物设定」与「派生不入库」。**此点为 Step 2 的实施细节，Step 0 先记录，不改设定。**
3. **P1 的 `user_levels` / `point_transactions` 影响勋章页等级展示**：
   若 Step 1 只建 P0 的 22 张，则勋章页的「等级/积分」需在 Step 4 由 `badges.points` 现算（可行）。
   是否**顺手建这 2 张 P1 表**（结构不冲突）请确认——**改动冻结表清单的事，我不擅自做。**
4. **`weight_readings`（P1）**：宽表已能覆盖「一天一个代表值」，Step 1 可不建；
   但设计文档把体重列为「一天只保留代表值」的典型，若需同日复测再启用。

---

## 9. Step 0 冻结确认项（请逐条确认）

| # | 确认项 | 冻结内容 |
|---|---|---|
| Q1 | 三个契约签名 | `getSeries(patientId, metricKey, days=7, options)` / `getDailySnapshot(patientId, date=今天)` / `getPatientProfile(patientId)` |
| Q2 | 错误模型 | `DataProviderError` + 5 个 code；「查无数据」不抛错 |
| Q3 | `patient_id` 传递 | 唯一键名 `patient_id`；入站可收 `user_id` 别名并一次归一；必填严格 |
| Q4 | `metricKey` 规则 | 小写 snake_case + `metric_definitions` 注册 + 别名表；A/B/C 三类来源与消歧规则 |
| Q5 | 时间范围 | 含首含尾；默认 `days=7` + `anchorMode='latest'`（锚定最新记录日）；东八区 |
| Q6 | 27 张表清单 | 逐行核对无误；`10 + 17 = 27`；P0/P1/P2 = 22/3/2 |
| Q7 | §8 的风险 2、3 处理方式 | 待你拍板（birth_date 反推；是否顺手建 2 张 P1 表） |

> **确认 Q1–Q6 后即进入 Step 1（建 SQLite + P0 的 22 张表）。Q7 可与 Step 1 并行决定。**

---

*本文件为 Step 0 唯一交付物。未创建数据库、未执行 DDL、未修改任何业务代码。*
