# 第二阶段 · Step 6 · 最终验收记录（动态链路验收）

> 项目：迈康 MyCare · 老年慢病多智能体协同健康管理平台
> 依据：`docs/数据指标说明与设计文档.html` §11.2 / §7.3 / §14「第二阶段验收标准（建议）」
> 性质：**最终验收**。仅新增验收脚本与记录；**未建/删表、未改人设、未改 `clinicalRules.js` 判定语义**。
> 日期：2026-09-14
> 结论：`scripts/db/verify-step6.mjs` **45/45 全过**；`vite build` 通过；P0 仍 **22 张**，P1/P2 未建。

---

## 0. 本步边界声明

| 项 | 状态 |
|---|---|
| 是否创建 / 删除数据库表 | **否**（P0 仍 22 张） |
| 是否修改三人物设 / `demoPatients.js` | **否**（仅验收时临时改名 `.bak`，结束后还原，文件内容未变） |
| 是否修改 `clinicalRules.js` 判定语义 | **否**（13 条规则的阈值、达标率、等级一律未动） |
| 是否新增 P1 / P2 表 | **否** |
| 本次新增文件 | `scripts/db/verify-step6.mjs`、`data/step6-verify-record.json`、本文件 |
| 本次修改文件 | `server/data/dataProvider.js`（1 处，见 §6）、`docs/迈康MyCare_项目说明.html`（第 8 章补两处已知边界） |

**验收原则**：全部动态测试在**一次性副本库** `data/_step6-accept.db`（由 `data/mycare.db` 复制、经 `MYCARE_DB_PATH` 注入）上运行；**真实演示库全程只读、零改动**（S4 实测 `size/mtime` 前后一致），副本库验收后删除。

---

## 1. 验收结论

| 项 | 结果 |
|---|---|
| 检查项总数 | **45** |
| 通过 | **45** |
| 失败 | **0** |
| 机器可读记录 | `data/step6-verify-record.json` |
| 真实库是否被改动 | **否**（`unchanged: true`，size 327680，mtime 未变） |

---

## 2. 逐条对照设计文档「第二阶段验收标准」

### 2.1 最高优先级（导师第一验收项）

> 「AI 必须改为从数据库取数，彻底脱离 `demoPatients.js`。验收方法：把 `src/data/demoPatients.js` 改名为 `.bak` 后，『录入 → 规则 → AI → 页面』整条链路仍然可跑通。」

**✅ 通过（A 组）**。验收脚本执行了真实的「改名 → 重启后端 → 跑整条链路 → 还原」全过程：

| 检查项 | 结果 |
|---|---|
| A1 运行时源码（`src` + `server`）**0 处导入** `demoPatients` | ✅ `offenders=none` |
| A2 改名 `.bak` 后后端仍可启动 | ✅ `listening 3041` |
| A3 改名后「登录 → 档案 → 记录 → 趋势 → 晨报 → 协同 → 预警 → 医生端」全链路 | ✅ 全部 `200`，`run_done` 与 `alerts_persisted` 事件齐全 |
| A4 `demoPatients.js` 已还原、内容完整 | ✅ |
| A5 前端构建产物 0 处引用 | ✅ `scanned=1 offenders=none` |

A3 实测链路状态：`{login:200, profile:200, records:200, series:200, briefing:200, orchestrate:200, runDone:true, alertsPersisted:true, alertsRead:200, doctor:200}`

### 2.2 「必须达成（闭环类）」7 条

| # | 验收项 | 结果 | 取证 |
|---|---|---|---|
| 1 | AI 不再读 `demoPatients.js`：改名后链路仍通 | ✅ | §2.1 A3 |
| 2 | 新增第 4 位患者，**不改任何页面代码**，登录后能看到其档案与趋势 | ✅ | B1–B10：仅经 SQL 插入 `赵桂兰`（患者数 3→4），`/api/patients` 自动出现、可登录（`patient_4`，65 岁）、档案/趋势/晨报（score=67，风险=提示）全部可取；页面 0 处引用 `DEMO_PATIENTS`，医生端/登录页名单均走 API |
| 3 | 为其录入新一天的血压，**重新请求 API 或刷新页面即可见**最新趋势与首页数据；且追加后历史值不变 | ✅ | C1–C4：录入 `2026-09-15` 收缩压 186 → 记录数 7→8、窗口末端 09-14→09-15、序列最新值 186；历史日 09-10（126/80/61.9 kg）前后**完全一致** |
| 4 | 13 条规则在真实数据上判定结果与自检脚本**完全一致** | ✅ | D1（`RULE_CATALOG` = 13 条）、D2（三患者复算命中集与达标率数值全等，见 §3.D） |
| 5 | 预警记录刷新页面后**依然存在**，医生端可见 | ✅ | E1（二次请求内容逐字节一致）、E2（医生端 `alertRecords` 含 `ruleId/level/detail`） |
| 6 | 医生端签名一律为「李医生」，**不再出现患者姓名** | ✅ | F1（接口身份 `李医生｜主任医师·全科`）、F2（签名取固定常量 `DOCTOR.name`，未使用患者姓名） |
| 7 | 换一个浏览器登录同一账号，从前端读到的数据与另一浏览器一致 | ✅ | G1：两个独立客户端对 `records / profile / snapshot` 三类接口**逐字节一致**；G2：健康数据不落 `localStorage` |

### 2.3 §7.3「五条可验收判据」

| # | 判据 | 结果 | 取证 |
|---|---|---|---|
| 1 | 追加即可见（无需改码/重建） | ✅ | C2 |
| 2 | 不依赖浏览器本地存储（同一后端 + 同一库一致） | ✅ | G1 + G2（`localStorage` 仅 `user` / `userSettings` 两个身份键，`nonIdentity=[]`，健康类文件 `healthFiles=[]`） |
| 3 | 新增患者不改代码 | ✅ | B1–B10 |
| 4 | 历史可回溯（同一日期值不变） | ✅ | C3（库内值）+ C4（经 API 读到的值） |
| 5 | 下游自动重算（规则命中 → 落库留痕） | ✅ | C5（同日重复提交为「更正当日值」`record_status=corrected`，未提交字段保留）+ C6（新数据触发 `R-BP-3`，`alerts` 新增 1 条） |

### 2.4 口径红线 5 条

| # | 红线 | 结果 | 取证 |
|---|---|---|---|
| 1 | 产品预警等级只用「提示/关注/预警/紧急」，不得出现高危/中危/低危 | ✅ | H1（落库等级集合 = `预警,关注,紧急`）+ H2（输出层 `inAlerts=[]`） |
| 2 | 医学诊断与危险分层属医生侧，不与产品等级混用 | ✅ | H2 输出层**显式排除**医生侧字段 `medical.riskStratification` 后，产品级输出 0 命中；源码命中 25 处**全部**处于「禁止性说明 / 医学侧字段」语境（见 §3.H） |
| 3 | 紧急联系人通知必须「已授权 + 本人确认」双条件 | ✅ | E3（`notifyTargets=["self"]`、`externalBlocked=true`、`confirmed=false`）+ E4（待确认对象仅记录不发送） |
| 4 | 体重变化不得称「脂肪减少」「平台期」 | ✅ | H2 + H3 |
| 5 | 阈值、达标率、等级一律由规则引擎算出，AI 不得改写 | ✅ | H3（落库 `detail` 为确定性依据，如「连续 4 天收缩压 ≥140 mmHg，7 天涨幅 +30 mmHg」）+ I 组 |

---

## 3. 关键取证

### A. 脱离 `demoPatients.js`（最高优先级）

见 §2.1。补充：A1 的静态扫描**只匹配真实导入**（`import/require/dynamic import`），源码注释里出现的「不读取 `demoPatients.js`」说明文字不计为违规——这正是「已退役」的标志，而非引用。

### B. 新增第 4 位患者（只插数据、不改代码）

| 检查项 | 结果 |
|---|---|
| B1 插入行 | `patients` 3→4；contacts / conditions(主+1合并症) / lifestyle / targets / relations / daily 7 天全部插入 |
| B2 登录页示范入口 | `/api/patients` → `patient_1,patient_2,patient_3,patient_4` |
| B3 可登录 | `patient_4` → `赵桂兰` |
| B4 档案齐备 | `age=65`（由 `birth_date` 现算）、疾病 `["原发性高血压","血脂异常"]`、紧急联系人 `赵明`（已授权）、`medical.controlTarget` 存在、`lifestyle.tags.highSalt=true` |
| B5 趋势可取数 | `records=7`，收缩压序列 `count=7`，`latest=127` |
| B6 晨报 | `score=67`，`risk=提示` |
| B7 协同 | `run_done` + `alerts_persisted`（`inserted=0 updated=0`） |
| B8 初始 7 天为正常范围 | 命中集仅「提示」级 → **落库预警 0 条**（这正是设计选择，见 §4） |
| B9 医生端 | 关系表返回 4 人：`patient_1:attention, patient_2:attention, patient_3:good, patient_4:good` |
| B10 名单动态化 | 页面 `demoRefs=[]`；`doctorUsesApi=true`、`loginUsesApi=true` |

> 说明：B10 的 `fixtureRefs=[{DoctorPage.jsx, count:2}]` 指医生端「医生备注」的**会话内演示初值**（含 `patient_1` / `patient_2` 字面量）。它是备注内容而非名单来源、不落库、不参与名单渲染，故单独统计、不计为违规。

### C. 新增一天数据 → 追加不覆盖 + 下游重算

| 检查项 | 实测 |
|---|---|
| C1 追加 | `2026-09-15` 收缩压 186 → `created=true` |
| C2 重新请求即见 | 记录数 **7→8**；窗口末端 **2026-09-14 → 2026-09-15**；序列最新值 **186** |
| C3 追加不覆盖（库内） | 09-10 = `126 / 80 / 61.9`，前后完全一致 |
| C4 历史可回溯（API） | 09-10 经 API 读到的值 = `126/80`（前后一致） |
| C5 同日重复提交 | 行数 1→1（不新增）；提交 `systolic=181` 后 `diastolic=100`、`heart_rate=88` 保留；`record_status=corrected` |
| C6 下游自动重算 | 触发 `R-BP-3` → `alerts` 新增 1 条（`inserted=1`） |

### D. 13 条规则口径一致（复算结果）

| 患者 | 命中规则 | BP 达标 | BG 达标 | 体重净变化 |
|---|---|---|---|---|
| 张建国 `patient_1` | `R-BP-2` (+`R-WT-1/4/5`) | **42.9%** | — | −0.2 kg |
| 李秀英 `patient_2` | `R-BG-3`, `R-BG-2` (+`R-WT-1/4/5`) | — | **57.1%** | −0.2 kg |
| 王建军 `patient_3` | `R-WT-2`, `R-WT-3` (+`R-WT-1/4/5`) | — | — | **−1.2 kg** |

与 `scripts/db/seed-sqlite.mjs` 的自检期望值（`42.9 / 57.1 / -1.2`、`R-BP-2` 命中且 `R-BP-3` 未命中、`R-BG-1` 未命中等）**完全一致**。

### E. 预警落库：刷新仍在 + 医生端可见 + 只记录不外发

- E1：两次请求 `/api/patients/patient_1/alerts` 内容**逐字节一致** → 预警来自 `alerts` 表，而非会话内存。
- E2：医生端 `alertRecords` 含 `ruleId / level / detail`。
- E3：全部预警 `notifyTargets=["self"]`、`externalBlocked=true`、`confirmed=false`。
- E4：`pendingNotify` 至少含 1 个待确认对象（紧急级为 `["family","doctor"]`），仅记录不发送。
- 本次验收共落库 **5 条**：`patient_1 → R-BP-2`、`patient_2 → R-BG-3 / R-BG-2`、`patient_3 → R-WT-3`、`patient_4 → R-BP-3`。

### F. 医生端签名固定

- F1：接口身份 = `李医生｜主任医师·全科`。
- F2：静态扫描 `{ hasFixedDoctorConst: true, signsWithConstant: true, signsWithUserName: false }`。

### G. 跨客户端一致 + 不依赖 `localStorage`

- G1：`records / profile / snapshot` 三类接口在两个独立客户端间**逐字节一致**（`records=true, profile=true, snapshot=true`）。
- G2：`localStorage` 仅出现身份键 `user` / `userSettings`；`nonIdentity=[]`；健康类页面（HealthDataContext / DataRecordPage / PrescriptionPage / BadgePage / HomePage）**0 次使用**。

### H. 红线扫描

- H1：落库等级集合 = `预警, 关注, 紧急`，全部属产品词表。
- H2：源码命中 **25 处**「高危/中危/低危/脂肪减少/平台期」，逐行判定后**全部**位于「禁止性说明」或「医学侧字段」语境（如 `严禁`/`不得`/`不使用`/`不存在`、`riskStratification` 医学分层字段），**违规 = 0**；输出层 `inAlerts=[]`、`inDoctor=[]`。
- H3：落库依据为确定性文本（例：「连续 4 天收缩压 ≥140 mmHg，7 天涨幅 +30 mmHg」）。

### I. 设计选择取证：命中集 ⊋ 持久化集

见 §4（这是本步的**裁定一**）。

### J. 已知未持久化能力

见 §5（这是本步的**裁定二**）。

---

## 4. 【裁定一】告警落库的等级范围：只落 关注/预警/紧急，**不落 提示** —— 这是设计选择，不是遗漏

### 4.1 结论先行

`clinicalRules` 的**全部命中结果**与 `alerts` 表的**持久化结果并非一一对应**。这是**有意的口径设计**，在本步正式确认为验收结论的一部分：

| 维度 | 内容 |
|---|---|
| 入库等级 | `PERSIST_LEVELS = ['emergency','alert','watch']`（紧急 / 预警 / 关注） |
| 不入库等级 | `info`（提示） |
| 依据 | 与既有医生端「健康预警」语义（`emergency/alert/watch`）保持一致；「提示」级多为正向激励（记录达成、减重进展、运动达标、勋章进度）或单次轻微异常，入库会造成噪声、淹没真正需要医生关注的项 |
| 实现位置 | `server/data/alertService.js`（`PERSIST_LEVELS`）；写入时 `level = ALERT_LEVEL[r.level].label`、`detail = r.basis`、`rule_id = r.ruleId` |

### 4.2 实测证据（I 组，可复现）

以第 4 位患者（新增 09-15、收缩压 186 之后）为例，后端装配层重放结果：

| 项 | 值 |
|---|---|
| `clinicalRules` 命中集 | `R-BP-3:紧急`、`R-BP-1:提示`、`R-WT-1:提示`、`R-WT-5:提示`（**4 条**） |
| 其中可持久化（`emergency/alert/watch`） | `R-BP-3` |
| 其中仅「提示」级 | `R-BP-1`、`R-WT-1`、`R-WT-5` |
| `alerts` 表实际持久化 | `R-BP-3`（**1 条**） |
| 校验 | ✅ `persisted == matchedPersistable` 且 `|persisted| < |matched|`；差集**恰好全部为「提示」级** |

对应检查项：`I1`（`PERSIST_LEVELS` 精确为 `emergency/alert/watch`）、`I2`（命中集 ⊋ 持久化集）、`I3`（未持久化项恰好都是 `info` 级）。

### 4.3 为什么这不是「漏掉」

- 若为遗漏，则 `persisted` 与 `matchedPersistable` 会出现**不一致**；实测两者完全相等。
- 差异项**恰好**是 `info` 级，且**每一次运行都可复现**——差异可解释、可预测。
- 提示级信息并未丢失：它仍在 `clinicalRules` 的命中结果中，供晨报 / 协同 / 对话等**会话内表达**使用，只是**不写库**。落库的目标是「需要留痕与复核的告警」，不是「全量事件日志」。

> **答辩口径建议**：被问到「为什么 alerts 里没有提示级」时，回答：**「这是设计选择——`alerts` 只承载需要留痕与医生复核的关注/预警/紧急；提示级属正向反馈，仅参与会话表达。判定本身由 `clinicalRules` 统一产出，未做删改。」**

### 4.4 如需变更

若后续要求「全量命中都落库」，只需把 `PERSIST_LEVELS` 扩为 `['info','watch','alert','emergency']`——**一处常量**即可，且不影响判定语义。**本步未擅自变更。**

---

## 5. 【裁定二】已知未持久化能力（清单）

本阶段明确闭环为：**`patient_id → dataProvider → Agent → 确定性规则 → alerts 落库 → 医生/患者端读取`**。除 `alerts` 外，下列**事件 / 明细类表已建结构但本阶段未写入数据**（J 组实测均为 0 行），**属已知未持久化能力，不代表系统已完成全量事件留痕**：

| 能力 | 表 | 表是否存在 | 当前行数 | 现状说明 |
|---|---|---|---|---|
| 用药提醒 | `reminders` | ✅ | **0** | 会话内存实现，未持久化 |
| 协同轨迹存档 | `agent_runs` | ✅ | **0** | 未写运行存档 |
| 服药记录 | `medication_logs` | ✅ | **0** | 未启用 |
| 医生备注 | `doctor_notes` | ✅ | **0** | 会话内状态（Step 4 已确认「暂不持久化」，不为凑功能破坏数据库契约） |
| 图像识别记录 | `vision_records` | ✅ | **0** | 未启用 |
| 健康处方 | `prescriptions` | ✅ | **0** | 页面处方为即时生成，未落库 |
| 血压明细 | `blood_pressure_readings` | ✅ | **0** | 「一天多测」细表未启用（宽表已存当日代表值） |
| 血糖明细 | `blood_glucose_readings` | ✅ | **0** | 同上 |

**本阶段唯一落库的事件表为 `alerts`**（J4 实测 `alerts rows=5`）。

> **答辩口径建议**：被问到「事件留痕是否完整」时，回答：**「本阶段的留痕闭环只覆盖 `alerts`（预警），这是 Step 5 明确的范围；`reminders` / `agent_runs` 等表已建、按计划延后启用，属已知未持久化能力。」**

**延后原因（不阻塞验收）**：本阶段验收目标是「数据是活的」（可追加、可检索、下游可消费）。`alerts` 已完整验证该闭环；其余事件表启用属功能扩展，不影响当前结论。

---

## 6. 验收中发现并修正的一处非确定性（已披露）

| 项 | 内容 |
|---|---|
| 现象 | `GET /api/patients/:id/profile` 两次请求返回**不完全一致**，差异键为 `view.created_at` |
| 根因 | `server/data/dataProvider.js` 的兼容视图 `toUserProfileView()` 末尾注入了 `created_at: new Date().toISOString()`（沿用旧 `toUserProfile()` 形状）。它是**请求时刻戳、不是数据**：同一患者两次请求会得到不同毫秒 |
| 影响 | 直接冲击验收标准第 7 条「换浏览器读到**同一份数据**」——数据其实相同，但字节不等，无法作为硬证据 |
| 处置 | **移除该字段**（`server/data/dataProvider.js` 1 处）。该字段**全仓库无任何消费方**（`src` 中 0 处读取 `user.created_at`），移除不改任何数据语义 |
| 复验 | 修后 G1 三类接口 `records/profile/snapshot` 均**逐字节一致**；真实库未被触碰 |
| 边界说明 | 派生视图属**我们自己的兼容层**（非契约、非表），不涉及 `demoPatients.js` 与三个人设 |

---

## 7. 未通过项 / 遗留

- **未通过项：0。**
- 遗留（不阻塞本步，已在 §5 记录）：`reminders` / `agent_runs` / `medication_logs` / `doctor_notes` / `vision_records` / `prescriptions` / 血压·血糖明细表未启用。
- 遗留（Step 4 已确认的功能边界）：① 自定义注册用户不落示范库，其数据接口返回 `E_PATIENT_NOT_FOUND`（前端空态）；② 医生备注不落 `doctor_notes`。
- 非运行时残留：`scripts/{screenshots,demo-video,selftest,verify-demo-data}.mjs` 与 `scripts/db/seed-sqlite.mjs` 仍以 `demoPatients.js` 作为**种子 / 夹具来源**（离线脚本，非运行时；Step 4 已记录）。

---

## 8. 产物清单

| 文件 | 类型 | 说明 |
|---|---|---|
| `scripts/db/verify-step6.mjs` | 新增 | Step 6 最终验收脚本（A–J + S 共 45 项；副本库隔离、改名测试、清理自愈） |
| `data/step6-verify-record.json` | 新增 | 机器可读验收记录（含 45 项明细、规则复算、设计选择与未持久化清单） |
| `docs/Step6_最终验收记录.md` | 新增 | 本文件 |
| `server/data/dataProvider.js` | 修改 | 移除派生视图中非确定性的 `created_at`（§6） |
| `docs/迈康MyCare_项目说明.html` | 修改 | 第 8 章「实现边界与待办」补两处已知边界（落库等级范围 + 未持久化能力清单） |

**复现命令**：`node scripts/db/verify-step6.mjs`（自动起停隔离端口 3041、自动清理副本库与还原改名）。

---

*本文件为 Step 6 最终验收的唯一交付记录。验收未建/删表、未改人设、未改 `clinicalRules.js` 判定语义；真实演示库 `data/mycare.db` 全程只读。*
