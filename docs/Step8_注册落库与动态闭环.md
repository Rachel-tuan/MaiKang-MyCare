# Step 8 · 注册落库与动态闭环（新账号不再看到示范数据）

> 触发问题：「我注册了一个账号以后，进来的页面是有数据的，而且是例子的数据，医生后台也都是示例的。
> 感觉不太对，我还是没有体验到这个动态数据库。」

本文件记录根因、边界调整、改动清单与验收证据。

---

## 1. 问题现象与根因

### 现象 A：新注册账号登录后，首页出现**示范病例的晨报**

例如首页显示「指标达到预警等级 / 血压显著偏高 / 今日复测 2 次并联系家庭医生调整用药」——
这些是 `patient_1`（张建国）在 `alerts` 里的内容，却出现在新账号的欢迎语下面。

**根因**：`AgentContext` 的 `briefing`（晨报）是**内存态**，只在 `records.length` 变化时刷新，
换账号时既不刷新也不清空。于是：

```
先进入示范病例 → briefing = patient_1 的晨报（缓存在 Context state）
     ↓ 退出 / 直接注册新账号并登录
新账号 records 为空 → 不触发 refreshBriefing
     ↓
首页继续渲染 patient_1 的晨报  ← 表现为"新账号带着别人的数据进来"
```

另外 `Patient` 身份键变化时，协同运行轨迹、对话历史同样残留，属同一类缺陷。

### 现象 B：注册账号**根本没有落库**，因此永远体验不到动态

`src/utils/accountStore.js` 把注册信息写在浏览器 localStorage（只存用户名 + 加盐哈希 + 档案），
`patients` 表里**没有这一行**。数据库真实状态：

```
patients: patient_1(张建国) / patient_2(李秀英) / patient_3(王建军)   ← 只有 3 位示范病例
```

后果：
- 新账号 `patientId` 查不到 → 前端显示空态（这是 Step 4/5 冻结的设计）；
- 但用户填写的姓名、疾病、身高体重不进入任何数据表；
- 「录入 → 规则引擎 → 预警落库 → 医生端」这条动态链路对新账号**完全不成立** ——
  因为 `upsertDailyRecord` 要求患者存在，否则 404。

### 现象 C：医生端显示 3 位示范病例

医生端按 `doctor_patient_relations` 查 `doc_li` 名下患者，与登录账号无关。
这是**正确行为**，但因为没有新患者进库，看起来就像"永远是示例数据"。

---

## 2. 边界调整（需要明确记录的决策）

Step 4/5 曾冻结一条边界：**「注册不落库」**（不建 P1/P2 表、不改数据契约）。

本次按用户诉求调整为：

> **注册即在 `patients` 建立属于该账号的真实档案**（复用既有 P0 表，**不新增任何表**），
> 新账号从零记录开始，所有趋势 / 评分 / 预警均由用户自己录入的数据产生。

调整后的口径：

| 项目 | 调整前 | 调整后 |
|---|---|---|
| 注册数据落点 | 浏览器 localStorage | 服务端 `patients`（+conditions/lifestyle/contacts/relations） |
| 密码存储 | 前端加盐哈希 | 服务端 `patients.password_hash`（scrypt 加盐），前端不再保存凭据 |
| 新账号初始数据 | 无（且接口 404） | 仅 1 条注册体重记录，其余为空 |
| 一键进入示范病例 | 列出 `patients` 全部 | **只列免密账号**（`password_hash` 为空），即 3 位示范病例 |
| 医生端 | 恒为 3 位示范病例 | 示范病例 + 新注册患者（自动纳入 `doc_li` 名下） |
| 数据契约 | —— | **未变**：不新增表、表名/字段名/枚举均保持原样 |

`patients.password_hash` 字段本就预留（建库注释：「示范病例可空串；本阶段不做登录改造」），
本次只是启用了它 —— 并让它同时承担「示范病例（免密） / 自助注册（需密码）」的天然区分。

---

## 3. 改动清单

### 3.1 后端

| 文件 | 改动 |
|---|---|
| `server/data/errors.js` | 新增业务错误码：`E_USERNAME_TAKEN(409)` / `E_PASSWORD_REQUIRED(401)` / `E_PASSWORD_MISMATCH(401)` / `E_PHONE_MISMATCH(403)` |
| `server/data/patientService.js` | 新增 `registerPatient()`（写患者档案，含疾病诊断 / 生活画像占位 / 紧急联系人 / 医患关系 / 首条体重记录）；新增 `resetPatientPassword()`（用户名 + 手机号双因子）；`resolvePatientForLogin()` 增加 scrypt 密码校验；`listPatientEntries()` 只返回免密示范病例 |
| `server/index.js` | 新增 `POST /api/patients/register`、`POST /api/patients/reset-password`；`/api/patients/login` 接收并透传 `password` |

密码实现：Node 内置 `crypto.scryptSync`，存储格式 `scrypt$<salt>$<derived>`，校验用 `timingSafeEqual`。
**不引入任何第三方依赖**。

### 3.2 前端

| 文件 | 改动 |
|---|---|
| `src/services/patientApi.js` | 新增 `registerPatient()` / `resetPassword()`；`loginPatient` 支持 `password` |
| `src/contexts/UserContext.jsx` | `register()` 改为调用后端建档案；`login()` 统一走后端并携带密码；新增 `resetPassword()`；删除 `buildRegisteredProfile` 本地档案构造 |
| `src/pages/LoginPage.jsx` | 找回密码改为后端双因子重置；注册成功提示说明「新档案从零开始」；用户协议 / 隐私政策文案同步（凭据改为服务端 scrypt 存储） |
| `src/contexts/AgentContext.jsx` | **修复现象 A**：新增「身份切换清空内存态」`useEffect`，`patientId` 变化时重置 `briefing / run / chats / orbOpen`；晨报刷新依赖由「记录条数」改为「整份 records」，同日 UPSERT 也能重算 |
| `src/pages/HomePage.jsx` | 新增空白档案引导卡：尚无血压/血糖/步数记录时，展示「档案已建立 → 录入 → 规则现算 → 预警落库 → 医生端可见」三步说明 |
| `src/utils/accountStore.js` | **删除**（账号体系已迁至服务端，本地注册表退役） |

### 3.3 验收脚本

| 文件 | 说明 |
|---|---|
| `scripts/db/verify-register-flow.mjs`（新增） | 纯服务端闭环验收：注册 → 密码校验 → 录入 → 规则命中 → alerts 落库 → 医生端可见 → 找回密码。在副本库运行 |
| `scripts/db/verify-auth-gate.mjs`（更新） | 浏览器端验收适配注册落库；新增「新账号首页不残留示范病例晨报」回归断言；脚本结束自动删除验收患者 |
| `scripts/db/verify-ui-routes.mjs` | 未改，复跑确认无回归 |

---

## 4. 验收证据

| 验收项 | 结果 |
|---|---|
| 注册闭环（服务端，`verify-register-flow.mjs`） | **25 / 25 通过** |
| 登录注册流程（真实浏览器，`verify-auth-gate.mjs`） | **16 / 16 通过** |
| 前端页面冒烟（8 路由，`verify-ui-routes.mjs`） | **14 / 14 通过**，已知缺陷类告警 0 |
| 后端回归 Step 4 / 5 / 6 | **26/26、28/28、45/45** |
| 生产构建 `vite build` | 通过（3865 modules） |

关键断言（新账号链路）：

```
✅ 注册写入服务端患者库：可解析出独立 patient_id（patient_4，非示范病例）
✅ 未携带密码 → 拒绝 E_PASSWORD_REQUIRED
✅ 密码错误 → 拒绝 E_PASSWORD_MISMATCH
✅ 未注册用户名 → E_PATIENT_NOT_FOUND（不回落默认患者）
✅ 新账号初始只有注册体重 1 条记录、0 条预警
✅ 录入 7 天血压 → 确定性规则命中 R-BP-2（血压连续升高）
✅ 命中结果写入 alerts 表，且只记录不外发（externalBlocked=true / confirmed=false）
✅ 医生端出现该患者（示范 3 位 + 新注册 1 位），并带落库预警明细
✅ 新账号首页显示「档案已建立、从第一条数据开始」引导
✅ 新账号首页**不残留**上一位（示范病例）的晨报数据
✅ 三位示范病例仍可免密一键进入
```

数据库（主库）验收后状态保持不变：`patients` 3 位、`daily_health_records` 21 条、`alerts` 4 条。

---

## 5. 怎么体验「动态数据库」

1. 登录页 → **注册**页签 → 填写姓名 / 用户名 / 密码 / 手机号 / 年龄 / 身高 / 体重 / 慢病 → 勾选协议 → 注册
2. 切回**登录**页签，用刚注册的账号登录（示范病例免密，注册账号必须输密码）
3. 首页会显示：*「你的健康档案已建立，现在从第一条数据开始」*，档案 ID 即数据库中的 `patient_id`
4. 进入**数据记录** → 选择日期 → 录入血压 / 血糖 / 步数 → 保存（写 `daily_health_records`）
   - 连录 7 天、收缩压从 132 升到 162，即可复现 `R-BP-2 血压连续升高`
5. 首页点**一键启动多智能体协同**（或进入智能体中心）→ 运行结束后 `alerts` 落库
6. 打开**医生端** → 该患者出现在李医生名下的患者列表，并带有落库预警明细
7. 全程可用 sqlite 直接核对：`patients` / `daily_health_records` / `alerts` 三张表随操作增长

---

## 6. 已知边界与注意事项

- **验收脚本会写库再清理**：`verify-auth-gate.mjs` 会真实注册一位 `verify_xxxxxx` 患者，
  跑完自动删除（外键 CASCADE 带走关联行）。若中途异常退出可能残留，重跑 `seed-sqlite.mjs` 可复位。
- **找回密码依赖注册手机号**：未填手机号的账号无法自助重置（接口会明确返回原因）。
- **仍未落库的表**（Step 5 冻结结论不变）：`prescriptions` / `reminders` / `agent_runs` /
  `medication_logs` / `doctor_notes` / `vision_records` 等仍是「表已建、按设计未持久化」。
  当前真正闭环落库的是：`daily_health_records`（录入）与 `alerts`（规则命中）。
- **医生端账号**：医生端仍是固定的 `doc_li` 视角，尚无医生登录体系。
