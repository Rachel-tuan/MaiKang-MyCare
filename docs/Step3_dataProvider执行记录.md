# 第二阶段 · Step 3 · 后端 dataProvider 执行记录

> 项目：迈康 MyCare · 老年慢病多智能体协同健康管理平台
> 依据：`docs/Step0.1_取数契约冻结_v0.1.md`（已批准，唯一冻结依据）
> 上游：Step 1 建库（`data/mycare.db`，P0 22 张表）→ Step 2 灌种子（三位示范患者）
> 本步：**建立后端 dataProvider，实现三个取数契约，全部从 SQLite 现查**
> 日期：2026-09-14
> 状态：✅ 已完成，**未进入 Step 4**

---

## 0. 边界确认（最重要）

| 项 | 状态 |
|---|---|
| 是否新建 / 修改数据库表 | **否**（仍为 P0 22 张，`schema.sql` 未动） |
| 是否执行 DDL | **否** |
| 是否修改前端 | **否** |
| 是否修改 Agent / 编排 / 规则引擎 | **否**（`server/agents/**`、`src/utils/clinicalRules.js` 未动） |
| 是否修改 `src/data/demoPatients.js` | **否**（仅在验证时临时改名、随即还原） |
| 是否新增依赖 / 改 `package.json` | **否**（沿用 Node 内置 `node:sqlite`） |
| 是否读取 `demoPatients.js` 取数 | **否**（静态扫描 + 运行时双重证明，见 §5） |

---

## 1. 已完成内容

按契约 §1 实现三个取数契约 + 统一错误模型，并落在后端 SQLite 查询之上：

| 契约 | 签名 | 落点 |
|---|---|---|
| `getSeries` | `(patientId, metricKey, days=7, options={}) => Promise<SeriesResult>` | `metric_definitions` 解析 + `daily_health_records` / `*_readings` / `lab_results` 现查 |
| `getDailySnapshot` | `(patientId, date=<今天·东八区>) => Promise<SnapshotResult>` | 宽表当日行 + 血压/血糖细表 + 化验 |
| `getPatientProfile` | `(patientId) => Promise<ProfileResult>` | `patients` + 6 张档案子表 + 目标 + 用药 + 医患关系 |
| `toUserProfileView` | `(profile) => object` | 纯函数，`ProfileResult` → 旧 `toUserProfile()` 同形（派生视图，非数据源） |

落实的契约要点：

1. **`patient_id` 唯一规范键**：缺失 → `E_INVALID_ARG`；查不到 → `E_PATIENT_NOT_FOUND`；**无默认患者兜底**。
2. **`metricKey` 必须从 `metric_definitions` 解析**：未注册 → `E_UNKNOWN_METRIC`（无隐式兜底）。
3. **`options.source` 消歧**：未传 → `default_source`；传了必须 ∈ `available_sources`；来源表未建（P1/P2）→ `E_INVALID_ARG` + `detail.reason='source_not_built'`，**不静默回落**。
4. **时间窗口**：含首含尾；`days=7` + `anchorMode='latest'`（锚定该患者该来源最新记录日）；支持 `options.from/to` 覆盖；东八区。
5. **派生值现算不落库**：`age`（由 `birth_date`）、`bmi`（由最新体重+身高）、`stats`（均值/极值/极差/变化/百分比/最小二乘斜率/趋势方向）。
6. **「查无数据」不抛错**：`getSeries → empty:true/stats:null`；`getDailySnapshot → exists:false/values:null`；`getPatientProfile → latestMeasurements:null` / 子表空数组。
7. **统一错误模型**：`DataProviderError`（`code` + `detail` + `httpStatus`），5 个 code 映射 400/404/503/500。

---

## 2. 修改了哪些文件

**新增（本步唯一改动，全部为新增文件，未改动任何既有业务文件）：**

| 文件 | 作用 |
|---|---|
| `server/data/errors.js` | `DataProviderError` + `ERROR_CODES` + `HTTP_STATUS_BY_CODE` + `asDataProviderError` |
| `server/data/db.js` | SQLite 访问层（`openDb/closeDb/all/get/tableExists/tableColumns/listTables/DB_PATH`），零第三方依赖 |
| `server/data/dataProvider.js` | 三契约 + `toUserProfileView` + `todayCST/calcAge` 导出 |
| `scripts/db/verify-dataProvider.mjs` | 只读验证脚本（抽样 + 来源解析 + 错误场景 + 来源证明） |
| `data/step3-dataprovider-record.json` | 机器可读验证记录 |
| `docs/Step3_dataProvider执行记录.md` | 本文档 |

**未改动**：`server/index.js`（未接线，属 Step 4/5）、`server/agents/**`、`src/**`（含 `demoPatients.js`）、`src/database/schema.sql`、`package.json`。

> 说明：Step 3 只「建立 dataProvider」，不接 HTTP 路由、不改前端/Agent 调用（用户明确要求不修改前端、Agent、规则逻辑），故 `server/index.js` 保持原样。

---

## 3. 数据库中实际建立了哪些表

**本步未建任何表**。数据库仍为 Step 1 的 **P0 22 张表**（P1/P2 未建）：

`patients, patient_contacts, patient_conditions, patient_lifestyle, patient_targets, medications, doctors, doctor_patient_relations, metric_definitions, badge_definitions, daily_health_records, blood_pressure_readings, blood_glucose_readings, lab_results, alerts, reminders, doctor_notes, medication_logs, agent_runs, vision_records, prescriptions, badges`

验证脚本运行时：表数量 = **22**；P1/P2（`weight_readings` / `point_transactions` / `user_levels`）**确认不存在**。

> 注：`getSeries(..., {source:'readings'})` 对 `systolic_pressure` 命中的 `blood_pressure_readings` 是 **P0 已建表**，但 Step 2 种子未灌该细表 → 返回 `empty:true`（合法来源、查无数据、不抛错）。只有 `weight` 的 `readings` 指向 P1 的 `weight_readings`（未建）才抛 `source_not_built`。

---

## 4. 三个函数的实际查询结果样例

### 4.1 `getSeries('patient_1', 'systolic_pressure', 7)`

```jsonc
{
  "patientId": "patient_1", "metricKey": "systolic_pressure",
  "resolvedSource": "daily_health_records", "sourceKey": "daily",
  "label": "收缩压", "unit": "mmHg", "direction": "lower", "target": 140,
  "window": { "days": 7, "from": "2026-09-08", "to": "2026-09-14", "anchorMode": "latest" },
  "points": [
    { "date": "2026-09-08", "at": "2026-09-08", "value": 132, "source": "manual", "recordStatus": "valid" },
    { "date": "2026-09-09", "at": "2026-09-09", "value": 136, "source": "manual", "recordStatus": "valid" },
    { "date": "2026-09-10", "at": "2026-09-10", "value": 138, "source": "manual", "recordStatus": "valid" },
    { "date": "2026-09-11", "at": "2026-09-11", "value": 144, "source": "manual", "recordStatus": "valid" },
    { "date": "2026-09-12", "at": "2026-09-12", "value": 152, "source": "manual", "recordStatus": "valid" },
    { "date": "2026-09-13", "at": "2026-09-13", "value": 158, "source": "manual", "recordStatus": "valid" },
    { "date": "2026-09-14", "at": "2026-09-14", "value": 162, "source": "manual", "recordStatus": "valid" }
  ],
  "count": 7, "empty": false,
  "stats": { "first": 132, "latest": 162, "latestDate": "2026-09-14", "min": 132, "max": 162,
             "mean": 146, "range": 30, "change": 30, "pctChange": 22.7, "slope": 5.29, "direction": "rising" }
}
```

### 4.2 `getSeries('patient_1', 'waist', 7)` —— 单点历史，**不伪造 7 天趋势**

```jsonc
{
  "metricKey": "waist", "resolvedSource": "daily_health_records", "sourceKey": "daily",
  "label": "腰围", "unit": "cm", "direction": "lower", "target": null,
  "window": { "days": 7, "from": "2026-09-08", "to": "2026-09-14", "anchorMode": "latest" },
  "points": [ { "date": "2026-09-14", "at": "2026-09-14", "value": 92, "source": "manual", "recordStatus": "valid" } ],
  "count": 1, "empty": false,
  "stats": { "first": 92, "latest": 92, "min": 92, "max": 92, "range": 0, "change": 0, "pctChange": 0, "slope": 0, "direction": "stable" }
}
```

> 与用户 Step 3 冻结项 2 一致：源数据只有最新一条腰围 → **只返回 1 点**，`range/change/slope` 全为 0，**不臆造其余 6 天**。

### 4.3 `getDailySnapshot('patient_2', '2026-09-14')`

```jsonc
{
  "patientId": "patient_2", "date": "2026-09-14", "exists": true,
  "values": { "systolic_pressure": 130, "diastolic_pressure": 80, "fasting_glucose": 8.3,
              "weight": 66, "waist": 88, "heart_rate": 78, "steps": 5400,
              "exercise_minutes": 40, "sleep_hours": 7, "mood_score": 3, "notes": "" },
  "details": { "blood_pressure": [], "blood_glucose": [], "weight": [] },
  "lab": [],
  "meta": { "source": "manual", "recordStatus": "valid", "createdAt": "2026-09-14T13:20:25", "updatedAt": "2026-09-14T13:20:25" }
}
```

### 4.4 `getPatientProfile('patient_3')`（节选）

```jsonc
{
  "patientId": "patient_3",
  "identity": { "username": "wangjianjun", "name": "王建军", "gender": "男", "birthDate": "1964-01-25",
                "age": 62, "height": 172, "phone": "13800138021",
                "occupation": "退休 / 半退休（原出租车司机）", "elderlyMode": true, "voiceEnabled": true, "isActive": true },
  "latestMeasurements": { "date": "2026-09-14", "weight": 90.8, "waist": 104,
                          "systolicPressure": 136, "diastolicPressure": 84, "fastingGlucose": 6.2, "heartRate": 82 },
  "contacts": [ { "contactId": "contact_patient_3_1", "name": "王小雨", "relation": "女儿",
                  "phone": "13800138022", "authorized": false, "authorizedAt": null } ],
  "conditions": [ { "diseaseName": "肥胖症", "diseaseGrade": "一级（BMI 31.1，28.0–32.4）", "isPrimary": true,
                    "durationText": "超重 10 余年，近期体重持续上升", "riskStratification": "合并代谢综合征",
                    "comorbidities": ["代谢综合征","空腹血糖受损（IFG 6.3 mmol/L）","血脂紊乱（TG 2.4 ↑、HDL-C 0.92 ↓）"],
                    "organDamage": "未见明确靶器官损害；需排查阻塞性睡眠呼吸暂停" },
                  { "diseaseName": "代谢综合征", "isPrimary": false }, { "diseaseName": "空腹血糖受损", "isPrimary": false } ],
  "lifestyle": { "diet": "三餐不规律，晚餐偏多，常吃夜宵", "exercise": "久坐，日均久坐 8 小时以上",
                 "sleep": "打鼾明显，日均约 6.5 小时（需警惕阻塞性睡眠呼吸暂停）",
                 "biggestDifficulty": "容易放弃，难以坚持", "motivation": "想减回年轻时的体重",
                 "aiStyle": "鼓励 + 激励", "tags": { "lateHeavyDinner": true, "irregularMeals": true, "sedentary": true, "snoring": true } },
  "targets": { "bmiTarget": 28, "waistTarget": 90,
               "basis": "《肥胖症诊疗指南 2024 年版》《中国成人超重和肥胖预防控制指南 2021》",
               "controlTarget": "3–6 个月减重 5%–10%（本例 4.6–9.2 kg），每周 0.5–1.0 kg 匀速下降",
               "demoThresholdNote": "中国标准 BMI ≥28.0 为肥胖，男性腰围 ≥90 cm 为中心性肥胖",
               "basisRaw": "{...无损原始 JSON...}" },
  "medications": [ { "medicationId": "med_patient_3_1", "name": "暂无长期用药", "dosage": "—", "isActive": true } ],
  "doctors": [ { "doctorId": "doc_li", "name": "李医生", "title": "主任医师", "department": "全科", "relationId": "rel_doc_li_patient_3" } ],
  "derived": { "bmi": 30.7, "emergencyContact": { "name": "王小雨", "relation": "女儿", "phone": "13800138022", "authorized": false } }
}
```

> 与用户 Step 3 冻结项 1 一致：`controlTarget / demoThresholdNote` **无损**承载于 `patient_targets.basis` JSON，dataProvider 拆出 `basis / controlTarget / demoThresholdNote` 三个文本，并保留 `basisRaw` 原始串；**未新增任何列**。

---

## 5. 三位患者各自的 profile / snapshot / series 验证

| 患者 | name | age（现算） | height | bmi（现算） | latestMeasurements | snapshot | SBP series | FPG series | waist series |
|---|---|---|---|---|---|---|---|---|---|
| patient_1 | 张建国 | 68 | 170 | 26.0 | 2026-09-14, 75.0kg/92cm | exists=true, SBP 162 | n=7 `[132…162]` slope **5.29 rising** | n=7 mean 5.5 | **n=1 [92]** |
| patient_2 | 李秀英 | 65 | 158 | 26.4 | 2026-09-14, 66.0kg/88cm | exists=true, SBP 130 | n=7 `[132,130,134,136,128,134,130]` stable | n=7 mean 7.8, target **7.8** | **n=1 [88]** |
| patient_3 | 王建军 | 62 | 172 | 30.7 | 2026-09-14, 90.8kg/104cm | exists=true, SBP 136 | n=7 slope −0.25 stable | n=7 mean 6.2 | **n=1 [104]** |

验证结论：

- ✅ 三人 `profile` 均完整：联系人 1 / 诊断（1 主 + N 副）/ 画像 / 目标 / 用药 / 医生关系齐备；`age` 与 Step 0.1 冻结值一致（68/65/62）。
- ✅ 三人 `snapshot` at 2026-09-14 均 `exists:true`，宽表 10 项指标 + waist 全部读出；细表/当日化验为空（种子未灌，正确）。
- ✅ 三人 `series` 窗口均为 2026-09-08~2026-09-14（`anchorMode:'latest'`），7 点。
- ✅ 规则复现口径与 Step 2 一致：张建国收缩压**单调上行 +30 mmHg**（趋势恶化信号）；李秀英血糖均值 7.8（阈值 7.8）；王建军体重净降。
- ⚠️ **一处预期差异**：`patient_3.derived.bmi = 30.7`，而 `demoPatients.js` 静态写 31.1。原因是 **BMI 按契约现算**（用**最新**体重 90.8kg / 172cm²），而源文件静态值基于初始体重 92.0kg。此为**派生值现算的应有行为**，不修改人设、不落库。
- ✅ `height` 只出现在 `identity.height`；`waist` 只出现在 `latestMeasurements.waist`（`identity` 中无 waist）——归属铁律落地。

---

## 6. source 解析及错误场景测试

### 6.1 source 解析（契约 §1.1 规则 1–4）

| 用例 | 调用 | 结果 |
|---|---|---|
| 默认来源 | `getSeries(p1,'systolic_pressure')` | `sourceKey='daily'`, `resolvedSource='daily_health_records'`, count 7 ✅ |
| 合法细表来源（表已建、无数据） | `getSeries(p1,'systolic_pressure',7,{source:'readings'})` | `sourceKey='readings'`, `resolvedSource='blood_pressure_readings'`, **count 0 / empty true（不抛错）** ✅ |
| P1 来源未建 | `getSeries(p1,'weight',7,{source:'readings'})` | **`E_INVALID_ARG`**，`detail.reason='source_not_built'`，`detail.table='weight_readings'` ✅ 不静默回落 |
| 来源不在 available_sources | `getSeries(p1,'systolic_pressure',7,{source:'lab'})` | **`E_INVALID_ARG`**，`detail.availableSources=['daily','readings']` ✅ |

错误样例原文：

```jsonc
// weight + readings（P1 未建）
{ "code": "E_INVALID_ARG",
  "message": "来源 \"readings\" 的物理表 weight_readings 尚未建立（P1/P2 延后）；不静默回落到 default_source",
  "detail": { "metricKey": "weight", "source": "readings", "table": "weight_readings", "reason": "source_not_built" } }

// systolic_pressure + lab（非法来源）
{ "code": "E_INVALID_ARG", "message": "来源 \"lab\" 不属于指标 systolic_pressure 的 available_sources [daily, readings]",
  "detail": { "metricKey": "systolic_pressure", "requestedSource": "lab", "availableSources": ["daily","readings"] } }
```

### 6.2 错误场景（5 类 code + 两类「查无数据不抛错」）

| # | 场景 | 期望 | 实测 |
|---|---|---|---|
| e1 | `getSeries('', 'systolic_pressure')` | `E_INVALID_ARG` | ✅ |
| e2 | `getPatientProfile('patient_999')` | `E_PATIENT_NOT_FOUND` | ✅ |
| e3 | `getSeries(p1,'not_a_metric')` | `E_UNKNOWN_METRIC` | ✅ |
| e4 | `getSeries(p1,'weight',0)` | `E_INVALID_ARG`（days 越界） | ✅ |
| e5 | `getDailySnapshot(p1,'2026/09/14')` | `E_INVALID_ARG`（date 非法） | ✅ |
| e6 | 空窗口 `from=2030-01-01,to=2030-01-07` | **不抛错**：`count:0/empty:true/stats:null` | ✅ |
| e7 | 无数据日 `getDailySnapshot(p1,'2026-01-01')` | **不抛错**：`exists:false/values:null` | ✅ |

---

## 7. 明确证明 `demoPatients.js` 已不再作为取数来源

三重证明（详见 `data/step3-dataprovider-record.json` → `proof`）：

1. **静态扫描**：扫描 `server/data/*.js` 全部文件，**无任何 `import/require/路径引用` 指向 `demoPatients`**（`staticNoDemoPatientsRef = true`）。
2. **运行时改名**：把 `src/data/demoPatients.js` 临时改名为 `demoPatients.js.bak` 后，`getSeries('patient_1','systolic_pressure')` 仍返回 `count:7`、`latest:162`，`getPatientProfile('patient_1')` 仍返回「张建国」——**dataProvider 不依赖该文件**；随后已还原（`restored=true`，文件完好）。
3. **写库→读库→回滚**：在事务内向 `daily_health_records` 追加 `patient_1 / 2026-09-15 / SBP 170`，同一连接内重新取数：
   - 默认 7 天窗口：`windowTo 09-14 → 09-15`，`latest 162 → 170`（**末端前移，锚定最新**）；
   - 显式窗口 09-08~09-15：`count 7 → 8`（**历史追加、不覆盖**）；
   - `ROLLBACK` 后恢复 `count:7 / latest:162 / windowTo:2026-09-14`。
   → 证明**数据确实来自 SQLite**，且**新增记录会真实改变取数结果**。

---

## 8. 当前验收结果

验证脚本 `node scripts/db/verify-dataProvider.mjs`：**26 / 26 全部通过 ✅**（`allPass=true`）

```
✅ profileThreePatients    ✅ snapshotThreePatients   ✅ seriesSevenPoints
✅ defaultAnchorLatest     ✅ waistSinglePoint        ✅ bmiDerived
✅ ageDerived              ✅ heightOnlyIdentity      ✅ sourceDefaultDaily
✅ sourceReadingsValidEmpty ✅ sourceNotBuiltThrows   ✅ invalidSourceThrows
✅ missingPatientIdThrows  ✅ unknownPatientThrows    ✅ unknownMetricThrows
✅ badDaysThrows           ✅ badDateThrows           ✅ emptyWindowNoThrow
✅ noSnapshotNoThrow       ✅ staticNoDemoPatientsRef ✅ renameProof
✅ renameRestored          ✅ dbRoundtripGrew         ✅ dbRoundtripRolledBack
✅ p0Count22               ✅ p1p2Absent
```

复现命令：`node scripts/db/verify-dataProvider.mjs`（只读；仅 D3 在事务内写入并即时回滚）。

---

## 9. 明确确认：Step 3 没有修改业务逻辑

- ✅ **未改前端**（`src/pages/**`、`src/contexts/**`、`src/components/**` 均未动）
- ✅ **未改 Agent / 编排 / 规则**（`server/agents/**`、`server/index.js`、`src/utils/clinicalRules.js` 未动）
- ✅ **未改 `demoPatients.js` 与三人设**（仅验证时临时改名并还原）
- ✅ **未新增/删除表、未改 DDL**（仍 P0 22 张）
- ✅ 本步仅新增 4 个文件（3 个 `server/data/*.js` + 1 个验证脚本）与 2 份产物（记录 JSON + 本 MD）

---

## 10. 下一步准备做什么

**Step 4：逐步把前端页面从 `localStorage` / `demoPatients.js` 改为 API 取数。** 优先保证：登录后患者身份正确、首页、健康数据趋势、健康处方、勋章、医生端患者数据可从数据库正常读取。

> 衔接说明（本步未做，留待 Step 4/5）：
> 1. `server/index.js` 尚未挂载 dataProvider 的 HTTP 路由（Step 3 只建 provider，未接线，符合「不改后端调用」的边界）；
> 2. `metric_definitions` 未注册 `bmi`（派生指标，不入库、不注册），Step 4 若 UI 需要 BMI 由 `getPatientProfile().derived.bmi` 现算提供；
> 3. `badge` 积分/等级：`badges.points` 可用，但原 `initialPoints`（190/220/160）按用户 Step 3 冻结项 3 **暂不作为运行时数据、也不伪造为 40/等级 1**——待 P1 `point_transactions/user_levels` 建成后再启用。

**本步到此停止，未进入 Step 4。**
