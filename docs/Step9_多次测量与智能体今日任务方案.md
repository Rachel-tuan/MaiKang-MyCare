# Step 9 方案 · 一天多次测量 + 由疾病类型驱动的「今日任务」

> 状态：**待确认**（本文只出方案，未改动任何代码）
> 日期：2026-09-14
> 关联：`docs/Step8_注册落库与动态闭环.md`、`docs/Step0.1_取数契约冻结_v0.1.md`

---

## 一、你的两条意见，我拆成两个独立问题

| # | 你的观察 | 问题的本质 |
|---|---|---|
| ① | 「今日任务」里血压/血糖写死 1 次，应该由智能体按慢病类型设定 | **任务生成层**：任务项与频次目前是 UI 硬编码，与患者疾病无关 |
| ② | 数据库应该能记录一天多次测量 | **取数层**：一天多条明细没有写入通路，也没有进入规则 |

两条意见指向同一个根因：**应用只实现了「一天一条」的窄通路**，而数据库契约其实是按「一天多条」设计的。

---

## 二、关键发现：数据库层其实已经准备好了，不用新建表

这是本次最重要的结论。查库结构与取数契约后确认：

### 2.1 「一天多次测量」的表早就建好了

```
blood_pressure_readings   -- 血压测量明细（一天多测，纯追加）
  measured_at   TEXT  时间锚点（分钟粒度，非「日」）
  systolic / diastolic / pulse
  slot          TEXT  CHECK (晨起 / 上午 / 下午 / 睡前)
  record_status
  INDEX (patient_id, measured_at)      ← 天然按时间追加

blood_glucose_readings    -- 血糖测量明细（必须带 measure_type）
  measured_at   TEXT  时间锚点（分钟粒度）
  value
  measure_type  TEXT NOT NULL CHECK (空腹 / 餐后2h / 随机 / 睡前)
  record_status
  INDEX (patient_id, measured_at)

daily_health_records      -- 每日快照（主干宽表）
  UNIQUE (patient_id, record_date)     ← 一天一行，用于「当日代表值」
```

注意两者的分工：**明细表时间锚点是「分钟」，快照表是「日」**。这正是标准的「明细 + 汇总」两层结构。

### 2.2 指标注册表已把这两张表登记为 `readings` 来源

`metric_definitions` 里（`build-sqlite.mjs` 初始化，18 条）：

| metric_key | 中文 | default_source | available_sources | readings 绑定 |
|---|---|---|---|---|
| `systolic_pressure` | 收缩压 | daily | **daily, readings** | `blood_pressure_readings.systolic @ measured_at` |
| `diastolic_pressure` | 舒张压 | daily | **daily, readings** | `blood_pressure_readings.diastolic @ measured_at` |
| `fasting_glucose` | 空腹血糖 | daily | **daily, readings** | `blood_glucose_readings.value @ measured_at`，filter `measure_type='空腹'` |
| `postprandial_glucose` | 餐后2h血糖 | **readings** | readings | filter `measure_type='餐后2h'` |
| `pulse` | 脉搏 | **readings** | readings | `blood_pressure_readings.pulse @ measured_at` |

**「双来源」在契约层已经成立。**

### 2.3 读取链路已经写了一半

`server/data/dataProvider.js` 的 `getDailySnapshot()` **已经**返回按天聚合的明细：

```js
const details = { blood_pressure: [], blood_glucose: [], weight: [] }
// ...
details.blood_pressure = [...]  // 按 measured_at ASC 排序的当日全部血压
details.blood_glucose  = [...]  // 当日全部血糖（带 measureType）
```

### 2.4 缺的只有三处（这就是要补的全部工作）

| 缺口 | 位置 | 现状 |
|---|---|---|
| **写入通路完全没有** | `patientService.js` | 全项目搜不到一处 `INSERT INTO blood_pressure_readings / blood_glucose_readings`；`upsertDailyRecord()` 只写 `daily_health_records` |
| **列表读取不带明细** | `patientService.getPatientRecords()` | 只 `SELECT * FROM daily_health_records`，不 join readings |
| **前端把明细丢掉** | `HealthDataContext.normalizeRecord()` | 只吃 daily 单行，`details` 未保留 |

**结论：本次不需要新增任何表**，与「不建 P1/P2 表」的红线不冲突。

---

## 三、方案总览

一句话：**补上「明细写入 → 当日汇总 → 规则消费 → 任务生成」这条链路，让 1 天 = N 条明细 + 1 行汇总。**

```
                      ┌─────────────────────────────────────────┐
  用户一天测 3 次  →  │  blood_pressure_readings   （3 行，追加）│
  血压（晨起/午后/  │  blood_glucose_readings    （按 measure_type）│
  睡前）           └──────────────┬──────────────────────────┘
                                  │ 服务端按日汇总（UPSERT）
                                  ▼
                      ┌─────────────────────────────────────────┐
                      │  daily_health_records      （仍 1 行）   │
                      │  唯一键 (patient_id, record_date) 不变    │
                      └──────────────┬──────────────────────────┘
                          ┌──────────┴──────────┐
                          ▼                     ▼
              ┌────────────────────┐   ┌────────────────────────┐
              │ clinicalRules 规则  │   │ buildDailyTasks 任务    │
              │ 7 天窗口现算（不变） │   │ 按疾病类型定次数        │
              └────────┬───────────┘   └───────────┬────────────┘
                       ▼                           ▼
                  alerts 落库               今日任务卡（2/3 次）
                       │                           │
                       └──────────┬────────────────┘
                                  ▼
                        智能体只做措辞与解释
                        （不得修改次数与阈值）
```

---

## 四、详细设计

### 4.1 数据层：明细写入 + 当日汇总回写

**新增写入接口**（纯追加，不改唯一键语义）：

```
POST /api/patients/:patientId/readings
body (血压): { kind:'blood_pressure', measuredAt:'2026-09-14T07:20', systolic:158, diastolic:96, pulse:78, slot:'晨起' }
body (血糖): { kind:'blood_glucose',  measuredAt:'2026-09-14T07:20', value:7.2, measureType:'空腹' }
```

**新增读取接口**：

```
GET /api/patients/:patientId/readings?date=YYYY-MM-DD      # 当日明细
GET /api/patients/:patientId/daily-tasks?date=YYYY-MM-DD   # 确定性任务（见 4.3）
```

**当日汇总回写口径 —— 这是最关键的一个决策点，见第六节。**

### 4.2 规则层：让多次测量真正参与判定

现状：`evaluateClinicalRules(patient, records)` 的 `records` 是「一天一行」的数组，7 天窗口现算。

改造后有两种接法（**倾向 A**）：

- **A（推荐）· 规则零改动**：明细先汇总进 daily，规则继续只读 daily。好处是既有 45 项 step6 验收、医生端、趋势图全部不受影响，规则语义（「连续 ≥3 天收缩压 ≥140」）保持「一天一个判定值」的清晰口径。
- **B · 规则直接消费明细**：把 N 条明细展平成序列参与判定。表达力更强（能识别「晨起高、睡前正常」的构型），但会改变规则输入形状，需要重写规则与全部验收，且「连续 3 天」的语义要重新定义。

建议本期走 A，把 B 作为后续增强（例如新增「非杓型血压」这类需要日内构型的规则时再做）。

### 4.3 任务层：由疾病类型驱动的「今日任务」（你的核心诉求）

**新增一个确定性任务生成器**（建议放 `src/utils/dailyTasks.js`，纯函数、可单测）：

```js
buildDailyTasks({ patient, records, readings, today }) → [
  {
    taskKey: 'bp_monitor',
    title: '血压监测',
    target: 2,                    // ← 由疾病类型决定，不是写死 1
    current: 1,                   // ← 由当日 readings 计数得出
    unit: '次',
    slots: ['晨起', '睡前'],       // ← 与 readings.slot 枚举对齐
    done: [ { at:'07:20', slot:'晨起', value:'158/96' } ],
    basis: '家庭血压监测：高血压患者建议晨起服药前、睡前各测 1 次',
    source: 'rule_engine',
  },
  // ...
]
```

**频次表（初版建议，请重点确认第四节末尾的数值）**

| 任务 | 触发条件 | 建议次数 | 依据 |
|---|---|---|---|
| 血压监测 | 高血压（确诊） | **2 次/天**（晨起、睡前） | 家庭血压监测指南：早晚各 1 次 |
| 血压监测 | 高血压 + 风险等级「预警/紧急」 | **3 次/天**（晨起、午后、睡前） | 未达标期需加密监测评估疗效 |
| 血压监测 | 无高血压（高危/健康） | **1 次/周**（不作每日任务） | 无需每日监测 |
| 血糖监测 | 糖尿病（饮食运动控制） | **2 次/天**（空腹、餐后2h） | 口服药/生活方式干预期 |
| 血糖监测 | 糖尿病 + 风险等级「预警/紧急」 | **3 次/天**（空腹、餐后2h、睡前） | 血糖波动需加密 |
| 血糖监测 | 无糖尿病 | 不出现该任务项 | — |
| 步数 | 全部 | 8000 步/天 | 沿用现有默认（后续可接 `patient_targets.steps_target`） |
| 运动时长 | 全部 | 30 分钟/天 | 沿用现有默认 |

> 判定输入必须是**确定性的**：`patient_conditions.disease_name`（注册时已写入）+ `clinicalRules` 的 `highestLevel` + `patient_targets`。
> **注意**：`medications` 表当前 0 行（未持久化），所以「是否用胰岛素」这类更强指征本期拿不到，先不纳入；这属于第六节的待确认项。

**智能体与确定性的分工（沿用项目红线）**

| 环节 | 由谁决定 | 说明 |
|---|---|---|
| 今天要测几次、测哪几项 | **确定性函数** | `buildDailyTasks` 现算，可解释、可复现 |
| 这些任务怎么对老人说 | **智能体** | 结合生活画像给措辞（如「您晚餐偏晚，睡前测压放到 21:00 更准」） |
| 次数能不能改 | **不能** | AI 只表达不裁定，与「AI 不猜阈值/等级」同一条红线 |

落库方式：`reminders`（提醒时段）与 `agent_runs`（AI 的解释轨迹）——这两张表当前都「已建未持久化」，本期是否顺势接上，见第六节。

### 4.4 前端

- `HomePage.jsx`：删掉硬编码的 `todayTasks` 数组，改从 context 取 `dailyTasks`
- 任务卡进度语义从「0/1 次」变为「1/2 次」，并显示已完成的时段（晨起 158/96 ✓）
- `DataRecordPage.jsx`：录入表单从「一天一条」扩展为「可追加上午/下午/睡前多次」，血糖必须选 `measure_type`
- `HealthDataContext`：`normalizeRecord` 保留 `details`，新增 `getTodayReadings()`

---

## 五、影响面与风险

| 项 | 评估 |
|---|---|
| 新增表 | **0 张**（复用既有 22 张 P0 表） |
| `daily_health_records` 唯一键 | **不变**，一天多测不会多出 daily 行 → 既有验收的行数断言应继续成立 |
| 既有规则语义 | 走 A 方案则**不变**（仍读 daily 的当日代表值） |
| 医生端 / 趋势图 | 读 daily，**不受影响** |
| step4/5/6 验收 | 预期全绿，但**必须实跑回归**确认 |
| 兼容性 | 老数据（无明细）照常工作；明细为空时 `details` 为 `[]`，任务卡的 `current` 退化为「当日 daily 值是否存在」 |

---

## 六、需要你拍板的 4 个决策点

### 决策 1 · 当日「代表值」怎么定？（最关键，影响规则与医生端）

一天测了 3 次（如 158 / 146 / 132），写进 `daily_health_records.systolic_pressure` 的应该是哪个？

| 选项 | 口径 | 优点 | 缺点 |
|---|---|---|---|
| **A（推荐）** | **当日多次均值**（→ 145） | 符合高血压诊断「多次测量取平均」的医学口径；规则与医生端无需改动 | 当日仅 1 次测量时等同该次值 |
| B | 当日最后一次（→ 132） | 语义最简单，代表「最新状态」 | 丢失日内信息，晨峰高血压容易被低估 |
| C | 不回写 daily，规则直接读明细 | 语义最纯粹 | 改动面最大，需重写规则与全部验收（见 4.2 方案 B） |

### 决策 2 · 频次表的数值是否认可？

就是 4.3 节那张表。请重点看三处：
- 高血压「**2 次**（晨起/睡前）」，预警及以上加到 **3 次**
- 糖尿病「**2 次**（空腹/餐后2h）」，预警及以上加到 **3 次**（加睡前）
- 无该慢病时，对应任务项**整项不出现**（而不是显示「0 次」）

### 决策 3 · 血糖录入是否强制选类型？

`blood_glucose_readings.measure_type` 是 `NOT NULL`，枚举为 空腹 / 餐后2h / 随机 / 睡前。
建议：**录入表单必须选**（下拉，默认「空腹」）；不选则前端拦截。这样 `fasting_glucose` 与 `postprandial_glucose` 两个指标才有正确来源。

### 决策 4 · 是否顺手把 `reminders` / `agent_runs` 接上？

- `reminders`：把「今天 2 次血压」写成本日提醒落库 → 刷新后仍在，演示「动态落库」更完整
- `agent_runs`：把智能体本次协同的轨迹落库

这两张表在 Step 5 被定为「表已建、按设计未持久化」。本期**可以顺手接上**（工作量不大，且能让评委看到更多真实落库），也可以**继续保持边界**。请你定。

---

## 七、实施顺序（确认后执行，每步可独立验收）

| 步 | 内容 | 验收 |
|---|---|---|
| 1 | 后端：明细写入接口 + 当日汇总回写 + 列表带明细 | 新脚本 `verify-multi-reading.mjs` |
| 2 | 规则与评分：确认多次测量经汇总后正确进规则 | step4/5/6 回归 |
| 3 | 任务层：`buildDailyTasks` 确定性频次表 + context 暴露 | 任务数断言（高血压 2 / 糖尿病 3 / 无慢病不出现） |
| 4 | 前端：首页任务卡改造 + 录入页支持多次追加 | UI 冒烟 + 人工核对 |
| 5 | 智能体：把确定性任务注入 planner，AI 只措辞 | 断言 AI 输出次数与确定性结果一致 |
| 6 | 文档 + 记忆 + 生产构建 | `vite build` |

**回归底线（不可放宽）**：step4 26/26、step5 28/28、step6 45/45、UI 冒烟 15/15，主库验收后仍为「patients 3 / daily 21」不变。

---

## 八、一句话总结

数据库的「一天多次测量」**不是要新建能力，而是打通一条已建好却断着的一半链路**（表在、契约在、读取半成品在，缺写入与消费）；「今日任务」则要从 UI 硬编码改为**确定性规则定次数、智能体定措辞**，这样高血压患者看到「血压 2 次（晨起/睡前）」、糖尿病患者看到「血糖 3 次（空腹/餐后2h/睡前）」，每一种慢病各不一样。
