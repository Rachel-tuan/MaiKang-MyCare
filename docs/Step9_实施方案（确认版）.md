# 迈康 MyCare · Step 9 实施方案（确认版）

> 状态：**待用户确认，尚未修改任何代码**
> 基础：`docs/Step9_多次测量与智能体今日任务方案.md`（初版）+ `docs/Step9_修订要求评审与技术确认清单.md`（评审）+ 用户 2026-09-14 的 7 条拍板
> 边界：不新增数据库表、不新增 P1/P2、不恢复 `demoPatients.js` 作为运行时数据源、不改 `patient_id` 规范、不让前端提交 records/profile/badges 给 Agent、不让 AI 造阈值或定等级、**不覆盖任何历史测量**、不把一天多次测量压成均值后丢弃明细、不为了本功能大规模重写 `clinicalRules`、必须回归 Step 4/5/6 既有验收。

---

## 0. 你的 7 条拍板（本方案的口径来源）

| # | 你的决定 | 本方案如何落地 |
|---|---|---|
| 1 | 峰值**不得**定义成真实医学代表值；daily 仅作兼容层；规则暂保持日粒度 | daily 里的血压/血糖值标记为「保守兼容代表值」，**只喂旧规则、不上屏当真实值**；页面"最新血压"改读 readings 最后一条 |
| 2 | 「午后」UI 展示、落库「下午」 | 展示层映射 `下午 → 午后`；落库严格写 `slot='下午'`（CHECK 枚举不动） |
| 3 | 王建军主任务=体重管理；合并症给**低频关注** | 主诊断出主任务；`空腹血糖受损 / 代谢综合征` 只出每周 1–2 次的低频关注项 |
| 4 | 任务进度**不落库**，由当天有效 readings 实时派生 | `daily_tasks` 是纯派生视图，无对应表、无写入 |
| 5 | 本期接入服药任务；一药多时段**拆成多个实例** | `medications.time`（如 `08:00/18:00`）按 `/` 拆分 → 每个时段一个计划实例；打卡写 `medication_logs` |
| 6 | 90/120 作废，**不删除** | 保留原值，`record_status = 'void'`；读取层补 void 过滤 |
| 7 | 演示用副本库 + 重置脚本 | `MYCARE_DB_PATH` 指向副本库，新增 `reset-demo.mjs` 一键重建 |

---

## 1. 分层模型（本次改动的核心思想）

```
┌─────────────────────────────────────────────────────────────┐
│ 事实层（原始、纯追加、永不覆盖）                              │
│   blood_pressure_readings     一次测量 = 一行（分钟锚点）      │
│   blood_glucose_readings      一次测量 = 一行（必带 measure_type）│
│   medication_logs             一次服药 = 一行（planned_time 锚点）│
└──────────────────────────────┬──────────────────────────────┘
                               │ 每次追加后在同一事务内重算当日
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ 兼容层（日粒度、一天一行、可 UPSERT）                         │
│   daily_health_records     ← 仅为「让既有 clinicalRules 继续跑」 │
│   其中血压/血糖字段 = 当日「保守兼容代表值」，非真实测量值      │
└──────────────────────────────┬──────────────────────────────┘
                               │ 只读，不做任何改动
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ 规则层（唯一裁定者，本期不改）                                │
│   src/utils/clinicalRules.js → 7 天窗口 → alerts 落库         │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ 派生视图（不落库，随时可重算）                                │
│   daily_tasks = buildDailyTasks(疾病 + 规则状态 + readings 计数) │
└─────────────────────────────────────────────────────────────┘
```

**三条不可违反的约束**

1. `*_readings` 永不 UPDATE / DELETE（`void` 是打标记，不是删行）。
2. `daily_health_records` 不得作为"真实测量值"上屏，也不得反过来替代 readings。
3. `daily_tasks` 不落库 —— 它没有表，只有函数。

---

## 2. 写入链路设计

### 2.1 血压追加 `appendBloodPressureReading()`

位置：`server/data/patientService.js`（新增导出）

```
入参：{ patientId, measuredAt, systolic, diastolic, pulse?, slot? }
事务：
  ① INSERT INTO blood_pressure_readings
       (reading_id, patient_id, measured_at, systolic, diastolic, pulse, slot, source, record_status)
     VALUES (randomblob16, ?, ?, ?, ?, ?, ?, 'manual', 'valid')
     —— 纯 INSERT，无 UPSERT、无唯一键约束
  ② 回写兼容层（见 §3）
  ③ INSERT INTO alerts（若规则命中，沿用现有 orchestrator 链路）
返回：{ reading, daily, tasks, evaluation }
```

**录入校验（前后端各一份，后端为准）**

| 校验 | 规则 | 错误码 |
|---|---|---|
| 收缩压 > 舒张压 | 违反 → 拒收 | `E_BP_INVERTED` |
| 数值范围 | 收缩压 60–300 / 舒张压 30–200 | `E_INVALID_ARG` |
| `measured_at` | 必须可被 `datetime()` 解析 | `E_INVALID_ARG` |
| `slot` | 命中 `('晨起','上午','下午','睡前')` 或留空 | `E_INVALID_ARG` |

> 这条校验就是你库里 `90/120` 那条的直接对策 —— 以后新录入不可能再产生舒张压 > 收缩压。

### 2.2 血糖追加 `appendBloodGlucoseReading()`

```
入参：{ patientId, measuredAt, value, measureType }
measureType 必填，枚举 ('空腹','餐后2h','随机','睡前')  ← 表结构 CHECK 要求
事务：① INSERT INTO blood_glucose_readings（纯追加）
      ② 回写兼容层
      ③ alerts
```

### 2.3 服药打卡 `appendMedicationLog()`

```
入参：{ patientId, medicationId, plannedTime, takenAt?, status? }
status 枚举 ('已服','漏服','延迟')，默认 '已服'
事务：INSERT INTO medication_logs
        (log_id, patient_id, medication_id, planned_time, taken_at, status, source, record_status)
      —— planned_time 是单值 NOT NULL，所以"一药多时段"必须在计划侧就拆好（见 §4.4）
```

### 2.4 其它指标（体重/步数/睡眠…）保持不变

仍走既有 `POST /api/patients/:patientId/records` → `upsertDailyRecord`（一天一行、UPSERT 是正确语义）。**本次不为它们引入 readings。**

---

## 3. daily 兼容层回写规则（严格按你的第 1 条）

每次追加 readings 后，在同一事务内重算当日 `daily_health_records`：

| daily 字段 | 取数口径 | 说明 |
|---|---|---|
| `systolic_pressure` / `diastolic_pressure` | 当日 `valid` 血压读数中**收缩压最大**的那一条，成对写入 | 只取同一条的 sys+dia，**绝不跨条混搭** |
| `fasting_glucose` | 当日**空腹**读数；无空腹则取当日血糖最高值 | daily 字段名就是"空腹血糖"，优先空腹才语义一致 |
| `pulse` → `heart_rate` | 与血压成对那一条的 `pulse` | 无则不动 |
| `weight` / `steps` / `waist` / … | **不参与回写** | 保持 `upsertDailyRecord` 的结果 |

**必须写进代码注释与文档的一句话**

> 本值为「为兼容既有日粒度规则而取的保守代表值（血压取当日峰值），**不是**当日真实测量值，**不替代** `*_readings` 中的原始测量。

**上屏口径（对应你的第 1 条后半句）**

| 页面位置 | 数据来源 |
|---|---|
| 首页/记录页「今日血压」 | **readings 当日最后一次** + "今日已测 N 次" |
| 趋势图 | 既有 `daily` 序列（本期不动，避免回归） |
| 规则判定 | `daily` 兼容值（本期不动） |

---

## 4. 今日任务生成器 `buildDailyTasks()`

位置：**`src/utils/dailyTasks.js`（新增）**，与 `clinicalRules.js` 同级，便于前后端共用（`clinicalRules` 已被 server 直接 import，沿用同一模式）。

### 4.1 输入

```
patient      → 主诊断 (patient_conditions.is_primary=1) + 合并症 (comorbidities / 其他 condition 行)
evaluation   → clinicalRules 的既有输出（只读，不重算阈值）
todayReadings→ 当日 valid readings 计数与明细
medications  → active 用药计划（含多时段）
targets      → patient_targets（步数等）
date
```

### 4.2 频次规则表（**本项目 Demo 规则，非医学处方**）

| 触发 | 任务 | 常态 | 异常时 | 出处 |
|---|---|---|---|---|
| 主诊断 = 高血压 | 血压监测 | 2 次（晨起、睡前） | **3 次**（晨起、午后、睡前） | Demo 规则 |
| 主诊断 = 2 型糖尿病 | 血糖监测 | 2 次（空腹、餐后2h） | **3 次**（空腹、餐后2h、睡前） | Demo 规则 |
| 主诊断 = 肥胖症 | 体重记录 | 1 次 | 1 次 | Demo 规则 |
| 合并症 = 空腹血糖受损（非主诊断） | 血糖关注 | 每周 1 次（低频） | 每周 1 次 | Demo 规则 |
| 合并症 = 代谢综合征（非主诊断） | 血压关注 | 每周 2 次（低频） | 每周 2 次 | Demo 规则 |
| 有 active 用药 | 服药任务 | 按 `medications.time` 时段展开 | 同 | 用药计划 |
| 通用 | 步数目标 | `targets.steps_target ?? 8000` | 同 | patient_targets |

**"异常"判定**：`evaluation` 中该域（bp / bg / wt）最高等级 ∈ {`预警`, `紧急`} → 升级为异常频次。
**只消费、不重算** —— 阈值仍由 `clinicalRules.js` 唯一裁定。

这三个数值集中在 `dailyTasks.js` 顶部的 `DAILY_TASK_RULES` 常量里，便于评委审阅"确定性"。**AI 无权修改。**

### 4.3 输出结构（派生，不落库）

```js
{
  generatedFor: '2026-09-14',
  source: 'rule',                       // 恒定标记：确定性规则产出
  tasks: [
    {
      taskId: 'bp_monitor',
      domain: 'blood_pressure',
      title: '血压监测',
      target: 3, unit: '次', done: 2,
      level: 'warning',                  // 来自 clinicalRules，不由 AI 定
      reason: '主诊断高血压；近期血压域达「预警」→ 3 次',
      slots: [
        { slot: '晨起', label: '晨起', done: true,  latest: '158/96', readingId: '…' },
        { slot: '下午', label: '午后', done: true,  latest: '164/99', readingId: '…' },
        { slot: '睡前', label: '睡前', done: false }
      ]
    },
    {
      taskId: 'med_<id>_0800',
      domain: 'medication',
      title: '服药：苯磺酸氨氯地平片 5mg',
      target: 1, unit: '次', done: 0,
      medicationId: '…', plannedTime: '08:00'
    }
  ]
}
```

### 4.4 进度派生（对应你的第 4 条）

| 任务 | `done` 的计算 |
|---|---|
| 血压监测 | `COUNT(*) FROM blood_pressure_readings WHERE patient_id=? AND date(measured_at)=? AND record_status='valid'` |
| 血糖监测 | 同上，`blood_glucose_readings` |
| 服药实例 | `COUNT(*) FROM medication_logs WHERE patient_id=? AND medication_id=? AND date(planned_time)=? AND status='已服' AND record_status='valid'` |
| 步数/体重 | 当日 `daily_health_records` 对应字段与 target 比较 |

**不写任何进度表。** 任务与测量严格分离：一次测量产生 1 条 readings + 进度 +1，二者通过 patient_id + 日期关联，而不是互相写入。

### 4.5 时段映射（对应你的第 2 条）

| 层 | 晨起 | 午后 | 睡前 |
|---|---|---|---|
| UI 展示 | 晨起 | **午后** | 睡前 |
| 入库 `slot` | `晨起` | **`下午`** | `睡前` |
| 血糖 `measure_type` | `空腹` | `餐后2h` / `随机` | `睡前` |

映射表写在 `dailyTasks.js` 与录入表单共用的常量里，避免两处各写一套。

---

## 5. 前端改造

### 5.1 `HomePage.jsx` —— 删除硬编码任务

- 删除 `const todayTasks = [...]`（第 304 行起）
- 改为从 `GET /api/patients/:id/daily-tasks` 取，经 `HealthDataContext` 透出
- 任务卡支持时段明细：

```
血压监测            2/3 次
✓ 晨起 158/96
✓ 午后 164/99
○ 睡前 待完成
```

### 5.2 `DataRecordPage.jsx` —— 支持同日多次追加

- 血压录入：新增「测量时段」选择（晨起 / 午后 / 睡前），提交走 `POST …/readings`，**每次提交新增一条**
- 血糖录入：`measure_type` 必填（空腹 / 餐后2h / 随机 / 睡前），提交走 `POST …/readings`
- 提交成功后页面提示"今日已测 N 次"，并刷新任务进度
- 体重 / 步数 / 睡眠等仍走原 `…/records`（一天一行，UPSERT）

### 5.3 `HealthDataContext.jsx`

新增 `dailyTasks`、`refreshDailyTasks()`、`appendReading()`，并在 `patient_id` 变化时清空（沿用上次修好的"换账号不残留"原则）。

---

## 6. 数据修复：`90/120` 作废（对应你的第 6 条）

**问题**：`patient_1` · `2026-09-14` 的 `daily_health_records` 为 `收缩压 90 / 舒张压 120` —— 生理上不可能，且该行体重/步数与前后 7 天不连贯。

**处置**：
1. **不删除、不改数值**，将该行 `record_status` 置为 `'void'`；
2. 在 `scripts/db/seed-sqlite.mjs` 同步该标记（保证副本库/重置脚本一致）；
3. **补读取层过滤**（⚠️ 这是目前的一个真实隐患）：

```
现状：getPatientRecords() 的 SQL 是 SELECT * FROM daily_health_records（无 record_status 过滤）
      → 即使标了 void，规则仍会读到它
要改：WHERE patient_id=? AND record_date BETWEEN ? AND ? AND record_status <> 'void'
      （另需检查 MAX(record_date) 取"最新日"时是否也要排除 void）
```

`dataProvider` 的指标序列路径已有白名单 `DEFAULT_RECORD_STATUSES = ['valid','corrected']`（自动排除 void ✅），**但 `patientService.getPatientRecords` 这条没有**，必须补齐。

---

## 7. 演示环境：副本库 + 重置脚本（对应你的第 7 条）

- 机制已有：`MYCARE_DB_PATH` 环境变量
- 新增 `scripts/db/reset-demo.mjs`：按 seed 重建 `data/mycare-demo.db`（**不动** `data/mycare.db`）
- 新增演示启动说明：`MYCARE_DB_PATH=data/mycare-demo.db node server/index.js`
- 效果：演示可反复重放，主库零污染；验收记录也落在副本库

---

## 8. API 契约（新增 / 改动）

| 方法 | 路径 | 说明 |
|---|---|---|
| **新增** `GET` | `/api/patients/:patientId/daily-tasks?date=` | 派生今日任务（含进度与时段） |
| **新增** `POST` | `/api/patients/:patientId/readings` | 追加血压/血糖读数（纯 INSERT + 兼容层回写） |
| **新增** `POST` | `/api/patients/:patientId/medication-logs` | 服药打卡 |
| 改动 | `GET /api/patients/:id/records` | SQL 增加 `record_status <> 'void'` |
| 不变 | `POST /api/patients/:id/records` | 体重/步数等仍为 UPSERT |

错误码新增：`E_BP_INVERTED`（400）。其余复用既有 `E_INVALID_ARG / E_PATIENT_NOT_FOUND / E_DB_UNAVAILABLE`。

---

## 9. 验收计划

### 9.1 新增脚本

**`scripts/db/verify-readings.mjs` —— 一天多次不覆盖（本次最核心）**

```
同一患者、同一天依次录入：
  08:00 150/92 → 13:00 158/96 → 20:00 162/98
断言：blood_pressure_readings = 3 行，且逐条字段一致
再录第 4 条：22:00 155/94
断言：4 行；前 3 条逐字段未被修改（不是"只数行数"）
反向断言：daily_health_records 当天仍只有 1 行（兼容层语义正确）

血糖：08:00 空腹 7.1 → 14:00 餐后2h 8.3 → 21:00 睡前 7.8
断言：3 行，measure_type 各自正确
```

**`scripts/db/verify-daily-tasks.mjs` —— 动态任务**

```
张建国（高血压）  → 含血压任务，常态 2 次；构造异常 → 3 次（晨起/午后/睡前）
李秀英（糖尿病）  → 含血糖任务，常态 2 次；异常 → 3 次
王建军（肥胖症）  → 主任务=体重记录；血压/血糖仅低频关注项（每周 1–2 次）
服药任务          → 李秀英 2 种药 → 2+3=5 个实例（按 time 拆分）
AI 不得改次数     → 断言任务 target 来自常量，与任何 LLM 输出无关
```

**`scripts/db/verify-demo-closure.mjs` —— 人工演示脚本化（§10 的自动化版）**

**`scripts/db/reset-demo.mjs` —— 副本库重建**

### 9.2 回归底线（必须全绿）

| 项目 | 目标 |
|---|---|
| `verify-step4` | 26/26 |
| `verify-step5` | 28/28 |
| `verify-step6` | 45/45 |
| `verify-ui-routes` | 15/15 |
| `verify-auth-gate` | 16/16 |
| `verify-register-flow` | 25/25 |
| `vite build` | 通过 |

---

## 10. 核心 Demo 剧本（对应你修订要求第十三节）

```
① 张建国 登录（免密示范病例）
② 首页「今日任务」显示：血压监测 2/3（晨起 ✓ 158/96、午后 ✓ 164/99、睡前 ○）
③ 去「数据记录」录入睡前血压 170/105
      → 原有 2 次记录「2 条」→ 新增第 3 次 → blood_pressure_readings 共 3 条（前 2 条原样保留）
      → 任务进度 2/3 → 3/3
④ 刷新首页 → 最新血压 = 170/105（读 readings，不是 daily 峰值 170 的假象）
⑤ 规则重算 → 命中 R-BP-2 / 升级 → alerts 新增一条
⑥ 打开医生端 → 见张建国最新数据与告警
```

演示全程在**副本库**上跑，结束后 `reset-demo.mjs` 一键复原。

---

## 11. 实施顺序（6 步）

| 步 | 内容 | 产出 |
|---|---|---|
| **S1** | 后端：`appendBloodPressureReading` / `appendBloodGlucoseReading` / `appendMedicationLog` + 兼容层回写 + 校验 + 新错误码 | 服务函数 |
| **S2** | 后端：三个新路由 + `getPatientRecords` 补 void 过滤 | API 可用 |
| **S3** | `src/utils/dailyTasks.js`：确定性任务生成器 + 频次常量 | 纯函数 |
| **S4** | 数据修复：seed 标 void + 副本库 & `reset-demo.mjs` | 演示环境 |
| **S5** | 前端：HomePage 动态任务卡 + DataRecordPage 追加录入 + Context | 页面 |
| **S6** | 验收：4 个新脚本 + 6 项回归 + 构建 | 全绿 |

---

## 12. 影响面评估

| 模块 | 影响 | 风险 |
|---|---|---|
| `clinicalRules.js` | **零改动**（输入口径不变） | 低 |
| 趋势图 / 勋章页 | 仍读 daily | 低 |
| 医生端 | 仍读 daily + alerts | 低 |
| `verify-step4/5/6` | 需确认 void 过滤不改变现有断言（现有 seed 无 void 行，预期不影响） | 低 |
| 注册流程 | 不受影响 | 无 |
| 主库 `data/mycare.db` | 只做一次 void 标记 | 低 |

---

## 13. 血糖兼容值口径（已拍板，冻结）

`daily.fasting_glucose` 的取数口径：**当日有有效「空腹」读数时取空腹读数；当日无空腹读数时，取当日有效血糖读数中的最高值。**

代码注释同时固定为：

```text
daily.fasting_glucose 为兼容既有日粒度规则生成的保守兼容代表值：
当日有有效空腹读数时取空腹读数；无空腹读数时取当日有效血糖最高值。
该值不是当日真实唯一测量值，不替代 blood_glucose_readings 原始测量。
```

**UI 约束**：无空腹数据的日期，界面上**不得**把该值标注为「今日空腹血糖」。

---

## 14. 冻结原则（本次写入项目红线）

> 一天可以有 N 次测量。
> 一次测量 = 一条 readings 事实记录。
> readings 永远追加，不覆盖；作废只打 `void` 标记。
> `daily_health_records` 只是日粒度兼容层，不能替代原始测量，其血压/血糖值为保守代表值。
> 今日任务由确定性规则根据疾病与状态动态生成，进度由当天有效 readings 实时派生、不落库。
> Agent 负责解释与个性化表达，不负责创造医学规则。
