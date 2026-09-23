# Step 9 实施执行记录

> 范围：把「一天多次测量」与「智能体今日任务」从方案落成代码，并完成验收与回归。
> 口径依据：`docs/Step9_实施方案（确认版）.md`（用户 7 条拍板 + 1 项血糖口径拍板）。
> 执行环境：Windows / Node 22.22.2（`node:sqlite` DatabaseSync）/ React + Vite + antd 5。

---

## 1. 分层模型（本期冻结）

| 层 | 载体 | 粒度 | 写入语义 | 说明 |
|---|---|---|---|---|
| 事实层 | `blood_pressure_readings` / `blood_glucose_readings` / `medication_logs` | 一次测量一条 | **纯追加，永不覆盖** | 作废只打 `record_status='void'`，**不删行** |
| 兼容层 | `daily_health_records` | 一天一行 | UPSERT | 血压/血糖字段为「**保守兼容代表值**」，仅为让既有 `clinicalRules.js` 继续运行 |
| 规则层 | `src/utils/clinicalRules.js` | — | **零改动** | 输入口径未变，规则不感知事实层 |
| 派生视图 | `buildDailyTasks()` 输出 | 当天 | **不落库** | 进度由当日有效 readings/logs 实时派生 |

**红线**：`patient_id` 为唯一身份；AI 不猜阈值、不改任务次数；readings 永远追加；`void` 只标记不删除。

**兼容层取值口径（代码注释已固定）**
- 血压：取当日有效读数中**收缩压最大**的那一条，收缩压/舒张压**成对写入**，不跨条混搭。
- 血糖 `daily.fasting_glucose`：**优先取当日有效「空腹」读数；无空腹读数则取当日有效血糖最高值**（字段语义优先，兼容旧日粒度规则）。

---

## 2. 用户拍板落地对照

| # | 拍板 | 落地位置 | 状态 |
|---|---|---|---|
| ① | 峰值不得定义为真实医学代表值；daily 仅兼容层 | `recomputeDailyCompat()` 注释 + 文档口径 | ✅ |
| ② | 「午后」UI 展示、落库 `slot='下午'` | `SLOT_LABEL_ZH`（UI 映射）+ `slot` CHECK 枚举不变 | ✅ |
| ③ | 王建军主任务=体重管理；合并症给低频关注项 | `DAILY_TASK_RULES.lowFrequency`，标注「Demo 规则，非医学处方」 | ✅ |
| ④ | 任务进度不落库，由当天有效 readings 实时派生 | `buildDailyTasks()` 纯函数；库中无任务/进度表 | ✅ |
| ⑤ | 本期接入服药任务，一药多时段拆多个计划实例 | `splitMedicationTimes()` + `appendMedicationLog()` | ✅ |
| ⑥ | `90/120` 作废不删除 → 标 `record_status='void'` | `scripts/db/repair-invalid-bp.mjs` | ✅ |
| ⑦ | 演示用副本库 + 重置脚本 | `MYCARE_DB_PATH` + `scripts/db/reset-demo.mjs` | ✅ |
| 补 | 血糖兼容值口径（空腹优先，否则取最高） | `recomputeDailyCompat()` + 验收断言 13/14/15 | ✅ |

---

## 3. 代码改动清单

### 后端
- **`server/data/errors.js`**：新增 `E_BP_INVERTED`（400）——收缩压 ≤ 舒张压直接拒收。
- **`server/data/patientService.js`**
  - 新增 `listReadings()` / `getLatestReadings()` / `countWeeklyReadings()` / `recomputeDailyCompat()` / `getDailyTasks()`；
  - 新增 `appendBloodPressureReading()` / `appendBloodGlucoseReading()` / `appendMedicationLog()`；
  - `getPatientRecords()` 增加 `record_status <> 'void'` 过滤（含取最新记录日时排除 void）——修复 void 行仍参与"最新日"判定的隐患；
  - 校验：`SYS_RANGE=[60,300]`、`DIA_RANGE=[30,200]`、`GLUCOSE_RANGE=[1,40]`；`measureType` 必填；slot 枚举校验。
- **`server/index.js`**：新增 3 条路由
  - `POST /api/patients/:patientId/readings`（按 `kind` 分发血压/血糖）
  - `POST /api/patients/:patientId/medication-logs`
  - `GET  /api/patients/:patientId/daily-tasks`

### 前端
- **`src/utils/dailyTasks.js`**（新增）：确定性今日任务生成器，纯函数，前后端共用。`DAILY_TASK_RULES` 冻结频次：
  - 高血压：常态 `[晨起,睡前]` / 血压域达预警 `[晨起,下午,睡前]`
  - 糖尿病：常态 `[空腹,餐后2h]` / 达预警 `[空腹,餐后2h,睡前]`
  - 体重：每日 1 次；运动：30 分钟；步数：个体目标或规则回退 8000
  - 低频关注项（Demo 规则）：空腹血糖受损 → 每周 1 次；代谢综合征 → 每周 2 次
- **`src/services/patientApi.js`**：新增 `getDailyTasks` / `addBloodPressureReading` / `addBloodGlucoseReading` / `addMedicationLog`。
- **`src/contexts/HealthDataContext.jsx`**：新增 `dailyTasks` 状态与 `loadDailyTasks()` / `refreshDailyTasks()` / `appendReading()` / `logMedication()`；`patientId` 变化即清空重算；任一写入后自动重拉任务。
- **`src/pages/HomePage.jsx`**：删除硬编码 `todayTasks`，改为由 `dailyTasks.tasks` 实时映射；展示时段明细（✓/○ + 值）与规则依据；无任务时给空态引导。
- **`src/pages/DataRecordPage.jsx`**：血压/血糖走事实层追加（`appendReading`），步数/体重/心率仍走日粒度；表单三列布局（血压+时段、血糖+measureType、体重）；前端预校验「收缩压 ≤ 舒张压」「血糖缺 measureType」；增加"一天可多次测量"提示与今日血压明细。

### 脚本
- **`scripts/db/build-sqlite.mjs` / `seed-sqlite.mjs`**：`DB_PATH` 支持 `MYCARE_DB_PATH` 覆盖。
- **`scripts/db/reset-demo.mjs`**（新增）：一键重建演示副本库 `data/mycare-demo.db`，**拒绝指向真实库**。
- **`scripts/db/repair-invalid-bp.mjs`**（新增）：向真实库的脏血压行打 `void` 标记（保留原值，**绝不 DELETE**），支持 `--dry-run`。
- **`scripts/db/verify-step4/5/6.mjs`**：`DB_PATH` 支持 `MYCARE_DB_PATH` 覆盖。

---

## 4. 数据修复与副本库

- **真实库 `data/mycare.db`**：`patient_1` 在 `2026-09-14` 的 **`daily_health_records`** 中曾出现 `90/120`（收缩压 < 舒张压，生理不可能）。已用 `repair-invalid-bp.mjs` 先 dry-run 确认、后 apply，标 `record_status='void'`，**原值 90/120 保留**。
  - 该库 `daily_health_records` 现状：`valid` 21 行 + `void` 1 行 = 22 行。（注：`blood_pressure_readings` 事实层本就 0 行，此脏数据落在日粒度兼容层，不在事实层。）
- **`patient_4「赵小川」是真实注册账号**（非测试残留），**全程未删除、未改动**。
- **演示副本库 `data/mycare-demo.db`**：由 `reset-demo.mjs` 从种子源重建，结果 **3 位患者 / 21 行 daily（全 valid）/ 0 行生理不可能血压**。
- 所有验收均在**副本**上执行，真实库全程只读。

---

## 5. 验收结果

| 验收项 | 结果 |
|---|---|
| `verify-readings.mjs`（一天多次测量、追加不覆盖） | **21 / 21** ✅ |
| `verify-daily-tasks.mjs`（动态今日任务） | **26 / 26** ✅ |
| `verify-step4.mjs`（dataProvider 回归） | **26 / 26** ✅ |
| `verify-step5.mjs`（Agent 链路回归） | **28 / 28** ✅ |
| `verify-step6.mjs`（最终验收回归） | **45 / 45** ✅ |
| `verify-ui-routes.mjs`（前端逐路由冒烟） | **15 / 15** ✅ |
| `verify-auth-gate.mjs`（登录注册流程） | **16 / 16** ✅ |
| `verify-register-flow.mjs`（注册落库闭环） | 24 / 25 ⚠️（见第 7 节） |
| `vite build`（生产构建） | 通过 ✅ |

**Step 9 关键断言抽样**
- 同日 3 次血压 = 3 条独立 readings，第 4 次为**新增**而非覆盖；前 3 条逐字段原样保留。
- `daily` 兼容层仍为「一天一行」，其血压值 = 当日收缩压最大那一条（成对写入）。
- 收缩压 ≤ 舒张压被拒（400 `E_BP_INVERTED`），从源头杜绝再产生 `90/120` 类脏数据。
- 血糖兼容值：有「空腹」取空腹（更高「随机」值也顶不掉）；无「空腹」才取当日最高。
- 三位患者任务**按疾病谱分化**：张建国→血压 3 次；李秀英→血糖 3 次 + 5 个服药实例；王建军→体重 + 2 项低频关注。
- 异常升频由确定性规则给出（2 → 3 次），依据可读、可复现，**不涉及 AI 生成**。
- 库中**不存在**任务/进度表 —— 今日任务是派生视图。
- 演示副本库与真实库**全程零改动**。

---

## 6. 验收中发现并修复的问题

1. **`appendMedicationLog` 服药打卡 400（真实缺陷）**
   - 现象：`POST /medication-logs` 返回 400 `E_INVALID_ARG`。
   - 根因：`normalizeDateTime(date, measuredAt, time)` 的第二个入参语义是「完整日期时间」，却被传入了计划侧的 `HH:mm`（`'08:00'`），被判为非法时间。
   - 修复：区分两种口径 —— 含 `T` 的按完整时间串传入，`HH:mm` 走第三个入参。修复后打卡 201，进度 `done=1` 正确派生。

2. **两个验收脚本语法错误（`const line` 重复声明）**
   - 现象：`verify-readings.mjs` / `verify-daily-tasks.mjs` 直接抛 `SyntaxError`。
   - 修复：复用外层已声明的 `line`，删除重复声明。

3. **3000/3001 残留旧服务导致 UI 冒烟 8/15**
   - 现象：登录后每个页面各报 1 条 `404 (Not Found)`，`fatal=1`。
   - 根因：端口上仍是**改造前启动的旧 API 进程**，不含 Step 9 新增路由，前端 `GET /daily-tasks` 全部 404。
   - 修复：终止旧进程，按当前代码重启 API（指向独立冒烟副本库 `_uismoke.db`）与 vite，冒烟恢复 15/15。

---

## 7. 已知遗留

- **`verify-register-flow.mjs` 24/25**：唯一失败项为「医生端患者总数 = 示范 3 位 + 新注册 1 位」，实测 `count=5`。
  - 归因：该脚本**不使用 `MYCARE_DB_PATH`**，而是自建临时库、以**真实库 `data/mycare.db`（4 位患者）为基**，同时把期望值硬编码为 3 + 1。真实注册账号 `patient_4「赵小川」`（须保留）使计数变为 5。
  - 结论：**与 Step 9 无关**，是既有断言的既有脆弱点；脚本对真实库为只读（实测运行前后 `mycare.db` 的 mtime 未变）。
  - 建议：后续让该脚本吃 `MYCARE_DB_PATH`，并把期望改为「示范数 + 既有注册数 + 本次新注册数」动态计算。

---

## 8. 运行方式

```bash
# 1. 重建演示副本库（真实库不动）
node scripts/db/reset-demo.mjs

# 2. Step 9 两项专项验收
node scripts/db/verify-readings.mjs
node scripts/db/verify-daily-tasks.mjs

# 3. 回归（在副本库上）
MYCARE_DB_PATH=data/_regression.db node scripts/db/verify-step4.mjs
MYCARE_DB_PATH=data/_regression.db node scripts/db/verify-step5.mjs
MYCARE_DB_PATH=data/_regression.db node scripts/db/verify-step6.mjs

# 4. 前端冒烟（需先起服务）
MYCARE_DB_PATH=data/_uismoke.db node server/index.js   # API :3001
npm run dev:web                                        # Web  :3000
node scripts/db/verify-ui-routes.mjs

# 5. 生产构建
npm run build
```
