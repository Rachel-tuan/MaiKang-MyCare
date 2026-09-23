# 第二阶段 · Step 0.1 · 取数契约冻结（v0.1 · 建库前最终一致性修订）

> 项目：迈康 MyCare · 老年慢病多智能体协同健康管理平台
> 上游依据：`docs/数据指标说明与设计文档.html` v1.2（已批准进入第二阶段）
> 前一版本：`docs/Step0_取数契约冻结_v1.0.md`（本文件 v0.1 **取代** v1.0，为其增量修订）
> 修订性质：**只关闭建库前发现的 3 个歧义，不重新设计、不增加数据库表、不进入 Step 1。**
> 日期：2026-09-14
> 状态：待确认 → 确认后进入 Step 1（建库）

---

## 0. 本步边界声明

| 项 | 状态 |
|---|---|
| 是否创建数据库 / 执行 DDL | **否** |
| 是否修改前端 / 后端 / Agent 代码 | **否** |
| 是否改动 `demoPatients.js` / 三个人物设定 | **否**（仅约定 birth_date 派生规则，不改人设、不改代码） |
| 是否新增数据库表 | **否**（27 张表数量不变） |
| 本次新增文件 | ① 本文件　② `docs/v1.0_to_v0.1_修改清单.md` |
| 冻结含义 | 本文件确认后，Step 1–6 一律以本文件的契约形状与表清单为准；变更须先回到本文件改契约 |

### 0.1 本次修订关闭的 3 个歧义（一句话）

1. **height / waist 归属**：height 归 `patients`（基础档案、相对稳定）；waist 归 `daily_health_records`（随时间变化的健康测量）。同义不双存。
2. **`metric_definitions` 双来源表达**：由「一对多建两行」改为 **一行一指标** + `default_source` + `available_sources`，消歧规则由 `available_sources` 承载。
3. **Q7 冻结**：`birth_date` 派生规则在建表前固定；Step 1 只建 **P0 的 22 张表**；`user_levels` / `point_transactions`（P1）明确延后，Step 1 不得擅自加入。

---

## 1. 三个取数契约（dataProvider）

`dataProvider` 是 **页面与 Agent 唯一的取数入口**，位于后端，直接查询 SQLite。
上层（前端页面 / Agent）只调用这三个函数，不关心底层是宽表还是多表。

统一约定：

- 三个函数均为 **async**（返回 `Promise`）。
- 参数中的患者键一律为 **`patientId`**（对应数据库 `patients.patient_id`，见 §3）。
- 所有返回值都是 **纯数据对象**（可 JSON 序列化），不含类实例、函数或 DB 句柄。
- **派生值（BMI / 达标率 / 趋势斜率 / 均值等）一律现算，不落库。**

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
| `options.source` | `'daily' \| 'readings' \| 'lab'` | ✗ | **该 `metricKey` 的 `default_source`** | 强制限定来源（消歧用）；**必须 ∈ `available_sources`** |
| `options.measureType` | `'空腹' \| '餐后2h' \| '随机' \| '睡前'` | ✗ | — | 仅血糖细表用；在 `source_binding` 过滤之上再收窄 |
| `options.includeRecordStatus` | string[] | ✗ | `['valid','corrected']` | 参与计算/展示的记录质控状态白名单 |

##### `options.source` 解析规则（v0.1 冻结）

```
1. 未传 source            → 使用 metricKey 的 default_source
2. 传了 source            → 必须 ∈ 该 metricKey 的 available_sources
                             ∉ available_sources → 抛 E_INVALID_ARG
3. source ∈ available_sources，但其来源表在当前 Step 尚未建立（P1/P2 表）
                          → 抛 E_INVALID_ARG，detail.reason = 'source_not_built'
4. 解析结果写入返回体的 resolvedSource（取值 daily_health_records / *_readings / lab_results）
```

> 规则 3 的实例：`weight` 的 `available_sources=[daily, readings]`，但 `weight_readings` 属 **P1**，
> Step 1 不建。故 Step 1 阶段 `getSeries(pid,'weight',{source:'readings'})` 抛 `E_INVALID_ARG`
> （`detail.reason='source_not_built'`），**不新建表、不静默回落到 daily**。P1 建成后自动可用。

#### 返回结构 `SeriesResult`

```jsonc
{
  "patientId": "patient_1",
  "metricKey": "systolic_pressure",
  "resolvedSource": "daily_health_records",   // 实际命中的来源表（由 default_source / options.source 解析）
  "sourceKey": "daily",                       // v0.1 新增：解析结果的来源枚举（daily/readings/lab）
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

> `sourceKey` 与 `resolvedSource` 同时返回：前者供上层做来源判断（枚举稳定），后者供调试/展示（物理表名）。

#### 错误处理

- `patientId` 缺失/为空 → 抛 `E_INVALID_ARG`
- `metricKey` 未在 `metric_definitions` 注册 → 抛 `E_UNKNOWN_METRIC`
- `options.source` ∉ `available_sources`，或来源表未建 → 抛 `E_INVALID_ARG`（后者 `detail.reason='source_not_built'`）
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
    "waist": 92,                   // v0.1：waist 归宽表，随日快照返回
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

### 1.3 `getPatientProfile` —— 取患者完整档案（v0.1 已改：height 归 identity，waist 移出 identity）

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
  "identity": {                    // 全部来自 patients（基础档案，相对稳定）
    "username": "zhangjianguo",
    "name": "张建国",
    "gender": "男",
    "birthDate": "1958-03-12",     // 由 age 派生规则生成（见 §8.1），入库字段
    "age": 68,                     // 由 birthDate 现算（不落库）
    "height": 170,                 // ★ v0.1：height 唯一归属 patients，此处读取 patients.height
    "phone": "13800138001",
    "occupation": "退休（原机械厂工人）",
    "elderlyMode": true,
    "voiceEnabled": true,
    "isActive": true
    // ★ v0.1：identity 中不再出现 waist（waist 归 daily_health_records，见 latestMeasurements）
  },
  "latestMeasurements": {          // ★ v0.1 新增：来自 daily_health_records 最新一行（读透视图，非档案字段）
    "date": "2026-09-14",          // 该行的 record_date
    "weight": 75.0,
    "waist": 92,
    "systolicPressure": 162,
    "diastolicPressure": 98,
    "fastingGlucose": 5.4,
    "heartRate": 82
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
    // 注：waistTarget 属「控制目标」，与 waist 测量值语义不同，仍归 patient_targets（不构成重复存储）
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

#### height / waist 归属（v0.1 冻结）

| 字段 | 唯一归属 | 语义 | 在 ProfileResult 中的位置 |
|---|---|---|---|
| `height` | **`patients`** | 基础档案，相对稳定（一次性录入） | `identity.height`（读 `patients.height`） |
| `waist` | **`daily_health_records`** | 随时间变化的健康测量（R-WT-3 驱动） | `latestMeasurements.waist`（读最新一行，**不**进 identity） |
| `bmi` | 无表（**派生**） | `体重(kg) / 身高(m)²`，现算 | `derived.bmi` |
| `waistTarget` | `patient_targets` | 控制目标值，非测量值 | `targets.waistTarget` |

> **同义不双存铁律**：`height` 只出现在 `patients`；`waist` 只出现在 `daily_health_records`；
> 两处均不得复用同义字段。`waistTarget` / `bmiTarget` 属目标语义，不视为重复。

> **兼容说明**：Step 3 提供纯函数 `toUserProfileView(profile)`，把 `ProfileResult` 还原成现有
> `demoPatients.js → toUserProfile()` 的同形对象。映射关系（**派生视图，不是数据源**）：
> `height ← identity.height`；`weight ← latestMeasurements.weight`；`waist ← latestMeasurements.waist`；
> `bmi ← derived.bmi`；`age ← identity.age`。

#### 错误处理

- `patientId` 缺失 → 抛 `E_INVALID_ARG`
- 患者不存在 → 抛 `E_PATIENT_NOT_FOUND`
- 数据库不可用 → 抛 `E_DB_UNAVAILABLE`
- 关联子表（contacts / conditions / …）为空 → 返回空数组，**不抛错**
- `daily_health_records` 无任何记录 → `latestMeasurements: null`（**不抛错**）

---

## 2. 统一错误模型

所有 dataProvider 抛出的错误都是 `DataProviderError` 实例：

```js
class DataProviderError extends Error {
  code      // 见下表
  detail    // 可选：出错时被查询的 patientId / metricKey / source / reason
}
```

| code | 触发场景 | Step 3 的 HTTP 映射 |
|---|---|---|
| `E_INVALID_ARG` | 入参缺失/非法（patientId 空、days 越界、date 非法、**source ∉ available_sources**、**source 表未建**） | `400` |
| `E_PATIENT_NOT_FOUND` | `patients` 无该 `patient_id` | `404` |
| `E_UNKNOWN_METRIC` | `metricKey` 未注册 | `400` |
| `E_DB_UNAVAILABLE` | SQLite 打开 / 查询失败 | `503` |
| `E_INTERNAL` | 其它未预期错误 | `500` |

**「查无数据」不是错误**（`getSeries.empty` / `getDailySnapshot.exists=false` / `latestMeasurements=null`）。

---

## 3. `patient_id` 传递方式（冻结，v0.1 无变化）

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
4. **兼容别名**：入站层可接受 `user_id` 作为兼容别名，在入口处**一次性**映射为 `patient_id`；进入 dataProvider 后只认 `patient_id`。
5. **严格性**：`patient_id` 必填且必须能查到患者；缺失 → `E_INVALID_ARG`，查不到 → `E_PATIENT_NOT_FOUND`。不做「找不到就回落默认患者」的兜底。
6. **信任边界**：前端**只允许**上传 `patient_id`（及 `goal` / 用户输入的自然语言）。

---

## 4. `metricKey` 与 `metric_definitions` 注册模型（v0.1 已改：一行一指标 + 双来源）

### 4.1 命名规则（不变）

- 一律 **小写 `snake_case`**。
- 与 `daily_health_records` 列名同名者直接复用（如 `systolic_pressure`）。
- 化验项以其规范短键命名（如 `hba1c`）。
- 权威注册处：**`metric_definitions` 表**（P0）。
- **未注册的 `metricKey` 直接抛 `E_UNKNOWN_METRIC`**——不在代码里隐式兜底。

### 4.2 `metric_definitions` 表结构（v0.1 冻结）

| 列 | 类型 | 说明 |
|---|---|---|
| `metric_key` | TEXT **PK** | 指标键，唯一。**一行一指标，禁止重复建两行** |
| `name_zh` | TEXT | 中文名 |
| `unit` | TEXT | 单位 |
| `direction` | TEXT | `lower` / `higher` / `range` / `stable` |
| `default_source` | TEXT | **默认来源**：`daily` / `readings` / `lab`（未指定 source 时命中） |
| `available_sources` | TEXT(JSON) | **可用来源全集**（数组，有序，`default_source` 必须 ∈ 此数组） |
| `source_binding` | TEXT(JSON) | **每来源的解析细节**：`{ daily:{table,value_column,time_column,filter?}, readings:{…}, lab:{…} }` |
| `applies_to` | TEXT | 适用人群 |
| `created_at` | TIMESTAMP | 审计 |

> `source_binding` 取代 v1.0 的单值 `source_table` / `value_column` / `time_column`——因为一个 `metric_key`
> 可能来自多张表、且各表列名不同（如 `systolic_pressure`：daily 表列名 `systolic_pressure`，readings 表列名 `systolic`）。
> 这是**同表内的字段扩展**，不新增表；一行即可完整描述多来源解析。

**来源枚举 → 物理表**：

| source 枚举 | 物理表 | 时间列 | 粒度 |
|---|---|---|---|
| `daily` | `daily_health_records` | `record_date` | 日 |
| `readings` | `*_readings`（blood_pressure / blood_glucose / weight） | `measured_at` | 分 |
| `lab` | `lab_results` | `test_date` | 日 |

### 4.3 指标全集（v0.1 冻结 · 每指标一行）

**双来源指标（v0.1 明确消歧，各只一行）**

| metricKey | 中文名 | 单位 | direction | `default_source` | `available_sources` |
|---|---|---|---|---|---|
| `systolic_pressure` | 收缩压 | mmHg | lower | `daily` | `[daily, readings]` |
| `diastolic_pressure` | 舒张压 | mmHg | lower | `daily` | `[daily, readings]` |
| `fasting_glucose` | 空腹血糖 | mmol/L | lower | `daily` | `[daily, readings]` |
| `weight` | 体重 | kg | stable | `daily` | `[daily, readings]` |

> 双来源解析：未传 `options.source` → 命中 `daily`（宽表当日代表值）；
> 传 `source='readings'` → 命中细表逐次测量（`weight` 的 readings 为 P1，Step 1 未建 → `E_INVALID_ARG / source_not_built`）。

**单来源指标**

| metricKey | 中文名 | 单位 | direction | `default_source` | `available_sources` | 备注 |
|---|---|---|---|---|---|---|
| `heart_rate` | 静息心率 | 次/分 | range | `daily` | `[daily]` | |
| `steps` | 步数 | 步 | higher | `daily` | `[daily]` | |
| `exercise_minutes` | 运动时长 | 分钟 | higher | `daily` | `[daily]` | |
| `sleep_hours` | 睡眠时长 | 小时 | higher | `daily` | `[daily]` | |
| `mood_score` | 心情评分 | 1–5 | higher | `daily` | `[daily]` | |
| `waist` | 腰围 | cm | lower | `daily` | `[daily]` | ★ v0.1 新增注册（waist 归宽表） |
| `pulse` | 脉搏 | 次/分 | range | `readings` | `[readings]` | blood_pressure_readings.pulse |
| `postprandial_glucose` | 餐后 2h 血糖 | mmol/L | lower | `readings` | `[readings]` | 过滤 `measure_type='餐后2h'` |
| `body_fat` | 体脂率 | % | lower | `readings` | `[readings]` | weight_readings（P1，延后） |
| `hba1c` | 糖化血红蛋白 | % | lower | `lab` | `[lab]` | item_name=HbA1c |
| `tg` | 甘油三酯 | mmol/L | lower | `lab` | `[lab]` | |
| `hdl_c` | 高密度脂蛋白胆固醇 | mmol/L | higher | `lab` | `[lab]` | |
| `ldl_c` | 低密度脂蛋白胆固醇 | mmol/L | lower | `lab` | `[lab]` | |
| `urine_microalbumin` | 尿微量白蛋白 | mg/L | lower | `lab` | `[lab]` | |

**血糖细表过滤（写入 `source_binding.readings.filter`）**

- `fasting_glucose` → `{ measure_type: '空腹' }`
- `postprandial_glucose` → `{ measure_type: '餐后2h' }`
- `options.measureType` 在此过滤之上**再收窄**（不覆盖）。

**派生指标（不入库、不注册为 metricKey，由上层现算）**
`bmi`、`age`、健康评分、达标率、趋势斜率、连续异常天数、控制状态、产品预警等级。

### 4.4 唯一性不变式（v0.1 冻结，Step 1 需以约束保证）

```sql
-- metric_definitions 一行一指标
PRIMARY KEY (metric_key)
-- 应用层断言：default_source ∈ available_sources（建库后用注册校验脚本或 SELECT 校验）
```

> 不允许同一 `metric_key` 出现两行；不得再用「A 类一行 + B 类一行」表达双来源。

### 4.5 别名兼容表（Step 4/5 迁移期用，非新增指标）

| 现存别名 | → 规范 `metricKey` |
|---|---|
| `blood_sugar` / `bloodSugar` / `glucose` | `fasting_glucose` |
| `systolic` | `systolic_pressure` |
| `diastolic` | `diastolic_pressure` |
| `heartRate` | `heart_rate` |
| `exerciseMinutes` | `exercise_minutes` |
| `sleepHours` | `sleep_hours` |
| `moodScore` | `mood_score` |

---

## 5. 时间范围（冻结，v0.1 无变化）

### 5.1 取值优先级

```
显式 from/to  >  days + anchorMode  >  默认（days=7, anchorMode='latest'）
```

### 5.2 窗口定义

- 窗口**含首含尾**。
- 未给 `from/to` 时：`to = 锚点日`，`from = to − (days − 1) 天`。
- 锚点日 `anchorMode`：`'latest'`（默认，取该患者该指标**最新一条记录的日期**）；`'today'`（系统当天东八区）。

### 5.3 为什么默认锚定「最新记录日」

| 理由 | 说明 |
|---|---|
| ① 与现有规则引擎语义一致 | `server/agents/tools.js` 的 `recentRecords()` 以「最后一条记录的日期」为锚点，默认锚定最新记录日 **规则行为零变化** |
| ② 演示可复现、不会「过期」 | 锚定系统当天会让种子 7 天窗口随日历滑出；锚定最新记录日则任何日期打开都能看到完整曲线 |
| ③ 满足「动态增长」验收项 H | 新增更晚日期的记录后，末端前移，曲线增长、规则重算 |

### 5.4 时区与格式

- 时区固定 **东八区（Asia/Shanghai）**。
- 日期格式 **`YYYY-MM-DD`**；时刻格式 **ISO 8601 带偏移**（`YYYY-MM-DDTHH:mm:ss+08:00`）。
- `record_date`（日）/ `measured_at`（分）/ `test_date`（日，化验）语义**不可互换**；
  `created_at` 是**记录发生时刻，不是测量时刻**。

---

## 6. 27 张表清单复核（v0.1：数量与优先级不变，仅调整字段归属）

### 6.1 冻结清单复核结果

✅ 与设计文档 §13.2 逐行一致：**27 张 = 启用 25 + 预留 2**；P0/P1/P2 = **22 / 3 / 2**。

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
| 时序表：测量事实型 + 事件型 | **6 + 5 = 11** ✅ |
| 清单行号 | **1–27 连续** ✅ |

### 6.3 height / waist 字段归属裁定（v0.1 新增 · 关系到 Step 1 DDL）

| 表 | 字段 | v1.0 状态 | v0.1 裁定 |
|---|---|---|---|
| `patients` | `height` | 有 | **保留**（唯一归属，基础档案） |
| `patients` | `waist` | 有 | **移除**（改为随时间测量） |
| `daily_health_records` | `waist` | 无 | **新增列**（唯一归属，随时间测量，随日快照返回） |

> ⚠️ 该调整仅涉及**两个表的列增删**，**不新增表**：27 张表数量不变。
> ⚠️ 上游设计文档 `数据指标说明与设计文档.html` §6.2 目前把 `height`/`waist` 并列写在 `patients`，
> 与本节裁定冲突——**需同步**（见 §10 待同步项）。本步不擅自改设计文档 HTML。

### 6.4 与现存 `src/database/schema.sql` 的对照

现存 `schema.sql` 只有 **10 张表**，且为 MySQL 风格 DDL（`ENUM`/`JSON`/`ON UPDATE`/`UUID()`），**与 SQLite 不兼容**，Step 1 需整体重写。

| 现存 10 张 | 去向 |
|---|---|
| `users` | ➜ `patients` + 拆出 `patient_contacts` / `patient_conditions` / `patient_lifestyle` / `patient_targets` |
| `health_records` | ➜ `daily_health_records`（`blood_sugar`→`fasting_glucose`；新增 `source`/`record_status`/`waist`） |
| `prescriptions` | ➜ 保留（新增 `created_by`） |
| `badges` | ➜ 保留 + 新增 `badge_definitions` |
| `doctor_notes` | ➜ 保留（`user_id`→`patient_id`，新增 `source`） |
| `doctors` / `doctor_patient_relations` | ➜ 保留（关系表 `user_id`→`patient_id`） |
| `user_levels` / `community_activities` / `user_activity_participations` | ➜ 保留（P1 / P2） |

**新增表 17 张** = `patient_contacts`、`patient_conditions`、`patient_lifestyle`、`patient_targets`、`medications`、`metric_definitions`、`badge_definitions`、`blood_pressure_readings`、`blood_glucose_readings`、`weight_readings`、`lab_results`、`alerts`、`reminders`、`medication_logs`、`agent_runs`、`vision_records`、`point_transactions`。
**复核结论**：`10（2 重命名 + 8 保留）+ 17（新增）= 27` ✅，无擅自增删。

---

## 7. 与后续 Step 的衔接

| Step | 依赖本契约的哪一部分 |
|---|---|
| Step 1 建库 | §6 表清单（**仅 P0 的 22 张**）、§6.3 height/waist 列归属、§5 时间语义、§4.2/4.3 `metric_definitions` 结构与内容 |
| Step 2 导种子 | §3 `patient_id` 取值、§8.1 birth_date 派生规则、§1.3 `ProfileResult` 拆表映射 |
| Step 3 dataProvider | §1 三函数签名与返回结构、§2 错误模型、§3 传递方式、§4 metricKey/来源解析、§5 时间范围 |
| Step 4 前端改造 | §1.2 `getDailySnapshot`（含 waist）、§1.3 `ProfileResult` + `toUserProfileView`、§4.5 别名表 |
| Step 5 Agent 改造 | §3 的 `{ patient_id, goal }`、§1.1/§1.3 作为工具取数来源 |
| Step 6 验收 | §5.3 理由 ③（新增记录后窗口前移）、全文「重新请求 API 或刷新页面」口径 |

---

## 8. Q7 冻结（v0.1 已关闭）

### 8.1 `birth_date` 派生规则（建表前固定）

- **事实**：`demoPatients.js` 只给 `age`，无 `birth_date`；设计文档要求存 `birth_date`、`age` 派生。
- **冻结规则**：以 **2026 年** 为基准年，按 `birthYear = 2026 − age`，并取一个**当年已过**的月日，
  使 2026 年现算年龄等于原设定；三人**人设不变**（姓名/性别/疾病/目标/生活方式均不动）。
- **三人冻结值**：

| patient_id | 姓名 | 原 `age` | 冻结 `birth_date` | 2026 现算 age |
|---|---|---|---|---|
| `patient_1` | 张建国 | 68 | `1958-03-12` | 68 ✅ |
| `patient_2` | 李秀英 | 65 | `1961-06-08` | 65 ✅ |
| `patient_3` | 王建军 | 62 | `1964-01-25` | 62 ✅ |

> `age` 始终**派生**（`getPatientProfile.identity.age` 现算），不落库；日后跨年自然增长属正常。

### 8.2 P1 / P2 表处理

- **Step 1 明确只建立 P0 的 22 张表**（清单见 §6.1 优先级列为 P0 者）。
- `user_levels` / `point_transactions`（P1）**继续延后**，Step 1 **不得擅自加入**。
- 勋章页的「等级 / 积分」在 Step 4 由 `badges.points` **现算**（可行，无需 P1 表）。
- `weight_readings`（P1）Step 1 不建；`weight` 的 readings 来源在 Step 1 阶段不可用（见 §1.1 规则 3）。

### 8.3 其它已知风险（记录，不改）

1. **登录态**：`patients.password_hash` 保留但允许空串；三个示范病例走「示范病例入口」直接给 `patient_id`，本阶段不做登录改造。
2. **`demoPatients.js` 退役时机**：Step 5 完成后，`src/data/demoPatients.js` 应可临时改名 `.bak` 而系统仍可运行（Step 6 验收 I）。

---

## 9. 确认项（v0.1）

| # | 确认项 | 冻结内容 |
|---|---|---|
| Q1 | 三个契约签名 | `getSeries(patientId, metricKey, days=7, options)` / `getDailySnapshot(patientId, date=今天)` / `getPatientProfile(patientId)` |
| Q2 | 错误模型 | `DataProviderError` + 5 个 code；「查无数据」不抛错 |
| Q3 | `patient_id` 传递 | 唯一键名 `patient_id`；入站可收 `user_id` 别名并一次归一；必填严格 |
| Q4 | `metricKey` 注册模型 | **一行一指标** + `default_source` + `available_sources`（+`source_binding`）；4 个双来源指标默认 `daily`；`source ∉ available_sources` → `E_INVALID_ARG` |
| Q5 | 时间范围 | 含首含尾；默认 `days=7` + `anchorMode='latest'`；东八区 |
| Q6 | 27 张表清单 | 逐行核对无误；`10 + 17 = 27`；P0/P1/P2 = 22/3/2 |
| **Q7** | **height/waist 归属 + birth_date + P1 延后** | **已关闭**：height→patients；waist→daily_health_records；birth_date 冻结值见 §8.1；Step 1 只建 P0 22 张 |

---

## 10. 最终一致性检查（v0.1）

| 检查项 | 结论 |
|---|---|
| `patient_id` | ✅ 唯一键名，值 `patient_1/2/3`；主键/外键/API/Agent 全一致；`user_id` 仅一次归一 |
| `height` / `waist` | ✅ 唯一归属已裁定：height→`patients`；waist→`daily_health_records`；无同义双存；BMI 派生 |
| `metric_key` / `source_table` / `default_source` / `available_sources` | ✅ 旧 `source_table` 废止，改为 `default_source` + `available_sources`（+`source_binding`）；**一行一指标**；4 个双来源指标 default 均为 `daily` |
| 时间字段 | ✅ `record_date`(日) / `measured_at`(分) / `test_date`(日) / `created_at`(记录时刻) 语义不混用 |
| P0 / P1 / P2 | ✅ **22 / 3 / 2**；Step 1 仅建 P0 |
| 27 张表数量 | ✅ 27（5 层 5+6+11+3+2；时序 6+5）；无新增/删除表 |
| `getSeries` 返回结构 | ✅ 新增 `sourceKey`；`resolvedSource` 由 default/source 解析；空数据不抛错 |
| `getDailySnapshot` 返回结构 | ✅ `values` 含 `waist`；空数据 `exists=false` |
| `getPatientProfile` 返回结构 | ✅ `identity.height` 读 patients；`waist` 移入 `latestMeasurements`；`derived.bmi` 现算 |

### 待同步项（本步未改，需你确认）

- **设计文档 HTML 需同步 2 处**（`docs/数据指标说明与设计文档.html`）：
  1. §6.2 `patients` 表：移除 `waist`，保留 `height`；
  2. §6.2 `daily_health_records` 表：新增 `waist` 列。
  > 本步只做契约冻结，**未改动该 HTML**；是否同步请确认（可与 Step 1 一并处理）。

---

## 11. 3 个问题已关闭（结论）

| # | 问题 | 关闭结论 |
|---|---|---|
| **1** | height / waist 到底归哪张表？ | **已关闭**：`height` 唯一归 `patients`（基础档案）；`waist` 唯一归 `daily_health_records`（随时间测量）。`getPatientProfile.identity.height` 从 `patients` 读取；waist 从最新一行读出放入 `latestMeasurements`（不进 identity）。同一语义不再双存；BMI 仍派生、不入库。 |
| **2** | `metric_definitions` 如何表达双来源？ | **已关闭**：模型改为 **一行一指标** + `default_source` + `available_sources`（+`source_binding`）。`systolic_pressure`/`diastolic_pressure`/`fasting_glucose`/`weight` 四者均 `default_source=daily`、`available_sources=[daily, readings]`。`getSeries` 未指定 source 命中 `default_source`；指定 source 必须 ∈ `available_sources`，否则 `E_INVALID_ARG`；**同一 metric_key 不得重复建两行**。 |
| **3** | Q7（birth_date / P1 表）如何冻结？ | **已关闭**：`birth_date` 派生规则与三人冻结值见 §8.1；Step 1 **只建 P0 的 22 张表**；`user_levels`/`point_transactions`（P1）明确延后，Step 1 **不得擅自加入**；三人人设不变。 |

---

## 12. 边界确认（本次执行）

- ✅ **仍未创建数据库**
- ✅ **仍未执行任何 DDL**
- ✅ **未修改任何业务代码**（前端 / 后端 / Agent / `demoPatients.js` 均未改）
- ✅ 未新增 / 删除数据库表（27 张不变）
- ✅ 本次仅新增两份文档：本文件 + `docs/v1.0_to_v0.1_修改清单.md`

---

*本文件为 Step 0.1 唯一交付物（取代 v1.0）。完成后停止，不进入 Step 1。*
