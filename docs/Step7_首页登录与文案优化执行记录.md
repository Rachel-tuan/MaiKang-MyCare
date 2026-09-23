# Step 7 · 控制台告警清理 / 登录注册闭环 / 首页功能说明 / 「处方」→「建议」执行记录

- **执行日期**：2026-09-14
- **范围**：`src/`（页面与上下文）、`scripts/db/`（验收脚本）；**未改动数据库结构、`clinicalRules.js` 判定逻辑与患者人设**
- **状态**：四项任务全部完成并复验

---

## 一、任务与结论总览

| # | 任务 | 结论 |
|---|---|---|
| 1 | 清理控制台告警 | 三类已知缺陷级告警全部归零（`non-boolean attribute` / `Tabs.TabPane` / `Card bodyStyle`） |
| 2 | 登录注册逻辑：先注册后才能登录 + 三个实体 | 闭环成立，未注册账号被明确拒绝且不回落到任何默认患者 |
| 3 | 首页功能说明 | 5 句说明置于「一键进入示范病例」上方，覆盖适用人群 / 指标 / 判定 / 激励 / 效果 |
| 4 | 「处方」改为「建议」 | 全部界面文案已替换；数据库契约标识按约定保持不变 |

---

## 二、任务 1 · 控制台告警清理

| 告警 | 根因 | 修复 |
|---|---|---|
| `Received true for non-boolean attribute` | `BottomNavigation.jsx` 把自定义布尔 prop `active` 透传到了 DOM 节点上的 styled 组件 | styled-components v6 瞬态 prop 规范：`props.active` → `props.$active`，调用处 `active={...}` → `$active={...}` |
| `[antd: Tabs] Tabs.TabPane is deprecated` | `BadgePage` / `DataRecordPage` / `DoctorPage` 仍使用旧版 `<Tabs><TabPane/></Tabs>` 组合式 API | 统一改为 `items={[...]}` 数据驱动 API，并删除 `const { TabPane } = Tabs` |
| `[antd: Card] bodyStyle is deprecated` | `AgentCenterPage.jsx` 使用已废弃的 `bodyStyle` | 改为 `styles={{ body: { paddingTop: 8 } }}` |

**验收锚点**：`verify-ui-routes.mjs` 新增断言「全站 0 命中已知缺陷类告警」，防止后续退化。

---

## 三、任务 2 · 登录注册逻辑（先注册，后才能登录）

### 3.1 分层设计

```
LoginPage（表单 / 页签 / 实体弹窗）
   └─ UserContext.login / register        ← 身份判定与顺序编排
        ├─ patientApi.loginPatient         ← ① 后端演示库（三位示范病例 + 演示用户名）
        └─ utils/accountStore.js           ← ② 本机注册表（自定义账号，仅存凭据）
```

### 3.2 新增 `src/utils/accountStore.js`（本机注册表）

| 项 | 设计 |
|---|---|
| 存储位置 | `localStorage['mycare_accounts']`，与健康数据**物理隔离** |
| 存储内容 | 用户名、随机盐、**加盐哈希后的密码**、注册时填写的档案；**不含明文密码，不含任何健康数据** |
| 哈希算法 | 优先 WebCrypto `SHA-256`；非安全上下文自动退化为内置 FNV-1a 变体并标记 `algo` |
| 用户名归一 | 大小写不敏感 + 去首尾空格，避免同人多账号 |
| 对外能力 | `isRegistered` / `saveAccount` / `verifyAccount` / `resetPassword` / `listRegisteredUsernames` |

### 3.3 登录顺序（`UserContext.login`）

1. **示范病例一键进入**（`patientId`）→ 后端演示库，免注册；
2. 输入**用户名** → 先查后端演示库（三位示范病例的用户名可直接登录）；
3. 后端返回 `E_PATIENT_NOT_FOUND` → 回落本机注册表：
   - 未注册 → `E_ACCOUNT_NOT_FOUND`，提示「**该账号尚未注册，请先注册后再登录**」；
   - 密码不符 → 「密码错误，请重新输入」。

> **三条路径均不回落默认患者**，`patient_id` 仍是唯一身份键。

### 3.4 注册不自动登录（关键约束）

`UserContext.register` 只写入本机注册表，**不设置登录态**。`LoginPage.handleRegister` 在注册成功后：

1. 提示「注册成功！请使用新账号登录」；
2. 自动切回「登录」页签；
3. 回填刚注册的用户名，密码留空由用户输入。

即：**注册 → 切登录页签 → 手动登录**，强制满足「先注册，后才能登录」。

### 3.5 三个实体（均为可交互弹窗，不是占位文案）

| 实体 | 入口 | 内容与能力 |
|---|---|---|
| **用户协议** | 注册页同意勾选框内链接、页脚链接 | 五章正文；其中「二、账号规则」明确写入示范病例免注册、其余账号须先注册后登录 |
| **隐私政策** | 注册页同意勾选框内链接、页脚链接 | 六章正文；说明信息收集范围、**加盐哈希存储**、外发双条件保护、用户权利 |
| **忘记密码？** | 登录表单右侧链接 | 可提交的**自助重置表单**：注册用户名 + 注册手机号 + 新密码 + 确认；校验通过后重置本机账号密码并回填登录用户名 |

另：注册表单中的「用户协议 / 隐私政策」同意勾选框为**必填**，未勾选无法提交。

---

## 四、任务 3 · 首页功能说明

位置：登录页「**一键进入示范病例**」标题**上方**（`FeatureIntro` 区块，位于示范入口之前，实测 `compareDocumentPosition` 校验通过）。

正文共 5 句，覆盖四个必需要素：

1. **适用人群**：需要长期居家管理的老年慢病人群，高血压、糖尿病、超重肥胖等患者及家属；
2. **管理指标**：血压、空腹血糖、体重与腰围、步数、运动时长、睡眠、长期用药；
3. **判定方式**：全部数值与预警等级由内置循证规则引擎（13 条确定性规则）统一计算，AI 只做解读表达，不改写阈值 / 等级 / 达标率；

> **注（2026-09-16 口径收紧，本条已废止）**：上面的「内置循证规则引擎（13 条确定性规则）」**已改**为「内置**确定性健康规则引擎**（13 条**演示**规则）」。原因见 `Step11_Final_Logic_Audit_v2.md` 的 B 类结论：算法层阈值**没有外部指南文件锚点**，「循证规则引擎」属于易被要求逐条举证的强表述。同步收紧的还有页脚、登录页特性列表与健康建议页共 4 处；「医学指南参考 / 循证理念」仅保留为**项目背景**（示范病例的个体化控制目标引自 5 部指南）。
4. **激励与提醒**：连续记录天数与健康勋章、异常趋势自动预警、外部通知须本人授权确认后才发送；
5. **预期效果**：血压血糖稳定在个体化目标范围、改善体重与运动习惯、形成可持续自我管理闭环。

---

## 五、任务 4 · 「处方」→「建议」

### 5.1 已替换的界面文案（节选）

| 位置 | 修改前 | 修改后 |
|---|---|---|
| 底部导航 `BottomNavigation.jsx` | 处方 | **建议** |
| `App.jsx` 页面切换播报 | 健康处方 | **健康建议** |
| `PrescriptionPage.jsx` 标题 | 个性化健康处方 | **个性化健康建议** |
| 同上 · 主按钮 | 生成处方 | **生成健康建议** |
| 同上 · 分区标题 | 运动处方 / 饮食处方 | **运动建议 / 饮食建议** |
| 同上 · 提示语 | 暂无健康处方 | **暂无健康建议** |
| `HomePage.jsx` 快捷操作 | 生成处方 | **生成建议** |
| `PrescriptionPage.jsx` 卡片 | 您的健康处方 | **您的健康建议** |
| `ProfilePage.jsx` 菜单项 | 健康处方 | **健康建议** |
| `AgentResultPanel.jsx` | 运动处方 | **运动建议** |
| `clinicalRules.js` 规则 action | 低盐饮食处方 | **低盐饮食建议** |
| `server/agents/*`（orchestrator / registry / tools / mock） | 处方 | **建议** |

### 5.2 按约定**保持不变**的数据契约标识

以下属**数据契约**而非界面文案，按要求原样保留：

- 表名 `prescriptions`、字段 `prescription_id` / `is_active`；
- `note_type` 字段及其 `CHECK (note_type IN ('建议','警告','表扬','处方调整'))` 枚举（含「处方调整」）；
- `src/models/index.js`、`src/database/schema.sql` 中说明该枚举来源的注释；
- 前端路由 path `/prescription` 与代码内变量名（`PrescriptionRules` / `generatePrescription` 等内部标识）。

> 依据：Step 6 验收 H2 已判定「红线措辞仅允许出现在禁止性说明与医学侧字段」。上述残留均为契约层，**对用户不可见**。

---

## 六、验收结果

### 6.1 前端页面冒烟（`verify-ui-routes.mjs`）

```
PASS  0 后端登录接口可用                              status=200 name=张建国
PASS  1 登录页渲染                                    rootLen=16418 exceptions=0
PASS  2 登录页文案正确
PASS  3 登录页示范病例入口来自 API（3 位患者）
PASS  4 登录态写入 localStorage（仅身份）              user 长度=1531
PASS  / 首页 / /agents / /prescription / /data-record / /badges / /doctor / /profile  渲染正常（fatal=0）
PASS  5 全部 src 文件使用的 React API 均已导入
PASS  6 全站无已知缺陷类告警（non-boolean attribute / Tabs.TabPane / Card bodyStyle）   none
==== 前端页面冒烟验收：14/14 通过 ====
```

### 6.2 登录注册闭环（`verify-auth-gate.mjs`，新增）

```
PASS  1 登录页渲染，示范病例入口来自接口（3 位）
PASS  2 功能说明位于「一键进入示范病例」上方，且覆盖适用人群 / 指标 / 效果   （说明 319 字）
PASS  3 「用户协议」为实体（可打开，含服务说明与账号规则）                   577 字
PASS  4 「隐私政策」为实体（可打开，含信息收集与加盐哈希说明）               638 字
PASS  5 「忘记密码？」为实体（可打开，含可提交的重置表单）
PASS  6 未注册账号登录被拒绝，且不回落到任何默认患者     toast=该账号尚未注册，请先注册后再登录
PASS  7 注册成功写入本机注册表，且注册后**不自动登录**   注册表条数=1 回填=verify_****
PASS  8 已注册账号 + 错误密码 → 提示密码错误，且不进入应用
PASS  9 已注册账号 + 正确密码 → 登录成功进入首页          身份 isRegistered=true
PASS 10 三位示范病例免注册可一键进入（例外入口不受「先注册」限制）
PASS 11 全流程无未捕获异常
==== 登录注册流程验收：11/11 通过 ====
```

### 6.3 后端回归（未受影响）

| 脚本 | 结果 |
|---|---|
| `verify-step4.mjs` | **26/26 通过** |
| `verify-step5.mjs` | **28/28 通过** |
| `verify-step6.mjs` | **45/45 通过**（P0 仍 22 张表，P1/P2 未建） |
| `vite build` | 通过（3866 modules，19.95s） |

其中 Step 6 的 `G2`（健康数据不落 localStorage）身份键白名单已包含 `mycare_accounts`，本次新增的注册表不构成越界。

### 6.4 落库文案核对

`GET /api/patients/patient_1/alerts` 返回的 `action` 字段已为新措辞：

```
"action": "生成风险工单、建议近期复诊、低盐饮食建议"
```

---

## 七、脚本变更说明

| 脚本 | 状态 |
|---|---|
| `scripts/db/verify-ui-routes.mjs` | 保留，新增 check 6（已知缺陷类告警断言） |
| `scripts/db/verify-auth-gate.mjs` | **新增**，登录注册闭环端到端验收（11 项） |
| `scripts/db/verify-auth-flow.mjs` | **已删除（被上者取代）** |

**删除原因**：旧脚本用**未限定作用域**的选择器取输入框与按钮。antd Tabs 会把所有页签面板都挂在 DOM 中（非活动面板仅隐藏），导致旧脚本写入隐藏面板的输入框、并可能点到「登录」**页签**而不是提交按钮 —— 提交根本没发生，于是产出 4 项**假失败**（toast 为空、路径停在 `/login`，与实际功能表现相反）。新脚本改为：全部选择器限定在 `.ant-tabs-tabpane-active` 内、按 `Form.Item` 的 label 文案精确定位输入框、用 `form button[type=submit]` 提交、并用 `MutationObserver` 持续收集 toast（antd `message` 3 秒即消失，采样式读取必漏）。修复后同一套功能断言 11/11 通过，证实旧脚本的 4 项失败为工具缺陷而非功能缺陷。

---

## 八、遗留与边界（非阻塞）

1. 自定义注册账号按既定边界**不落示范库**（不新增 P1/P2 表），因此其健康数据接口返回 `E_PATIENT_NOT_FOUND`，前端显示空态 —— 这是设计选择，不是缺陷。
2. 本机注册表存于浏览器 `localStorage`，**换设备 / 清缓存后需重新注册**；演示场景下可接受，若后续需要跨设备账号体系，须建 P1 用户表并迁移。
3. `reminders`（用药提醒）与 `agent_runs`（协同轨迹）仍为**表已建、未持久化**，与 Step 5/6 结论一致，本次未改变。
4. 生产构建单包 1.7 MB（gzip 527 KB）触发 chunk 体积提示，属性能优化项，不影响功能与验收。
