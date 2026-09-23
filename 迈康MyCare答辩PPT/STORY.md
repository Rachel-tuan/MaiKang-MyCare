# 迈康 MyCare 答辩 PPT · 叙事逻辑（STORY.md）

## ① 用户意图对齐

- **目标受众**：高校学科竞赛 / 结题答辩的评委与指导老师（智能体赛道）。
- **核心目标**：让评委相信——①这是"医学判定交代码、表达交模型"的安全架构，AI 不越权；②13 条规则 + 三层评分 + 医生联动是完整闭环；③456/457 断言可复现、数据真实、口径诚实。
- **PPT 长度**：15 页（封面 1 + 目录 1 + 章节扉页 3 + 正文 8 + 结束 1 + 感谢 1）。
- **视觉调性**：学术严谨 / 蓝白克制 / 证据驱动 / 层次清楚。
- **内容边界**：必讲——定位、六智能体、数据三层、13 规则、四级预警、三层评分、任务覆盖契约、AI 权限边界、验收证据；禁碰——不写"循证医学规则引擎"（阈值是演示规则无指南锚点）、不写假精度数据、不夸大 AI 能力。

## ② 页面布局骨架

**章节划分（3 章，对应 3 个章节扉页）**：

| 章 | 章节名 | 页码区间 | 扉页页码 |
|---|---|---|---|
| 01 | 项目定位与技术架构 | 03–06 | 03 |
| 02 | 规则引擎与评分体系 | 07–10 | 07 |
| 03 | 任务管理、权限边界与验收 | 11–14 | 11 |

**页面清单（15 页）**：

| 页 | 标题 | type | role | rhythm | 版式 |
|---|---|---|---|---|---|
| 01 | 封面 | cover | hero | peak | 居中标题 + 底部信息条 |
| 02 | 目录 | catalog | supporting | valley | 左深蓝栏 + 右条目 |
| 03 | 章节扉页 01 | section | transition | transition | 大数字 + 标题 + 要点 |
| 04 | 项目定位与核心问题 | content | supporting | valley | 左标题右内容（非对称） |
| 05 | 技术栈与六智能体 | content | supporting | valley | 非对称双栏 |
| 06 | 数据三层架构 | content | hero | peak | 左大图右文字（SVG 三层图） |
| 07 | 章节扉页 02 | section | transition | transition | 大数字 + 标题 + 要点 |
| 08 | 13 条确定性规则 | content | supporting | valley | 三栏并列 + 底部锚点 |
| 09 | 四级预警与唯一裁定链 | content | supporting | valley | 左标题右内容（SVG 链路） |
| 10 | 三层评分体系 | content | hero | peak | 巨型数字 + 洞察 |
| 11 | 章节扉页 03 | section | transition | transition | 大数字 + 标题 + 要点 |
| 12 | 今日任务与覆盖契约 | content | supporting | valley | 非对称双栏 |
| 13 | AI 权限边界与写入面 | content | supporting | valley | 左标题右内容 |
| 14 | 系统边界与验收证据 | content | hero | peak | 巨型数字 + 能做/不能做对照 |
| 15 | 总结与感谢 | ending | hero | peak | 居中金句 + 限制与展望 |

**Hero 页**：01（封面）、06（数据三层）、10（三层评分）、14（验收证据）、15（感谢）= 5 页，占比 33%，略高但可接受（答辩高潮密集）。任意两个 Hero 之间至少隔 1 个 supporting 页 ✅。

**rhythm 曲线**：peak(01) → valley(02) → transition(03) → valley(04,05) → peak(06) → transition(07) → valley(08,09) → peak(10) → transition(11) → valley(12,13) → peak(14,15)。连续 valley 不超过 2 页，符合约束。

**版式预算**：非对称版式页 = 04,05,06,08,09,10,12,13,14 = 9 页（60% ≥ 40% ✅）。对称版式 = 02（目录左栏）、15（居中）2 页。

## ③ 页面大纲

### 01 封面
- title: 迈康 MyCare —— 老年慢病多智能体协同健康管理平台
- type: cover / role: hero / rhythm: peak / layout: 居中标题+底部信息条
- visual: 深蓝顶条 + 中央论文式标题（无 L1 图片，封面用排版锚点）
- anti_pattern: 禁止红金、印章、烟花、人物大头照；禁止塞技术标签堆叠
- description: 一句话定位 + 赛事信息 + 学校/团队占位。**把原封面堆叠的 456/457、22表31API 等标签移除，只留一句话定位 + 英文副标。**

### 02 目录
- title: 目录
- type: catalog / role: supporting / rhythm: valley / layout: 左深蓝栏+右条目
- visual: L3 编号方块
- anti_pattern: 禁止圆球编号、书法繁体数字、英文比中文抢眼
- description: 3 章 + 编号 + 一句话摘要。

### 03 章节扉页 01
- title: 项目定位与技术架构
- type: section / role: transition / rhythm: transition / layout: 大数字+标题+要点
- visual: L3 大数字 01
- anti_pattern: 禁止满版蓝红金、PART 02 字样、与封面雷同
- description: 章节 01，要点 3 条。

### 04 项目定位与核心问题（左标题右内容）
- type: content / role: supporting / rhythm: valley / layout: 左标题+右内容
- visual: L3 FAIcon 图标列表
- anti_pattern: 禁止等宽四卡横排；禁止把"一句话定位"埋进正文
- description: 左侧色块标题栏放"医学判定交代码·表达交模型"一句话定位；右侧 5 条核心问题（指标看不懂→四级词表；AI 给结论不可信→规则全代码；多次测量覆盖→事实层纯追加；建议没人把关→pending 审核；评分不可解释→三层分离）。**结论：任何涉及数字的环节都不经过大模型。**

### 05 技术栈与六智能体（非对称双栏）
- type: content / role: supporting / rhythm: valley / layout: 非对称双栏 60:40
- visual: SVG 六智能体节点图（宽栏）
- anti_pattern: 禁止 50:50 等分；禁止把智能体做成 6 张等宽卡
- description: 宽栏放"前后端同源"分层结构 + 六个智能体 SVG；窄栏放技术栈清单（React18/Vite5/Node22/sqlite/DeepSeek-flash/qwen3.8-max）。

### 06 数据三层架构（Hero，左大图右文字）
- type: content / role: hero / rhythm: peak / layout: 左大图+右侧文字
- visual: L1 SVG 数据三层架构图（事实层/兼容层/派生层，占左 55%）
- anti_pattern: 禁止纯文字列表；禁止把 NULL≠0 的修复埋在角落
- description: 左 SVG 三层；右强调"事实层纯追加永不覆盖、兼容层 UPSERT、派生层实时计算不落库"+ 底部红字锚点"Step11 关键修复 NULL≠0"。

### 07 章节扉页 02
- title: 规则引擎与评分体系
- type: section / role: transition / rhythm: transition
- description: 章节 02，要点 3 条。

### 08 13 条确定性规则（三栏并列）
- type: content / role: supporting / rhythm: valley / layout: 三栏并列 + 底部锚点
- visual: L3 规则编号方块 + 底部结论条
- anti_pattern: 禁止多张深蓝实色卡；禁止规则文字堆满不留白
- description: 血压 4 条 / 血糖 4 条 / 体重与行为 5 条，三栏分类；底部锚点"clinicalRules.js 唯一判定实现，模型只转述"。

### 09 四级预警与唯一裁定链（左标题右内容）
- type: content / role: supporting / rhythm: valley / layout: 左标题+右内容
- visual: L1 SVG 唯一裁定链（clinicalRules → 晨报/落库/医生端 三路同源）
- anti_pattern: 禁止代码块式文字表达链路；禁止四级词表散落
- description: 左四级产品词表（提示/关注/预警/紧急，落库规则）；右 SVG 裁定链 + 红字锚点"D-2 修复：三级同源 4/4 一致"。

### 10 三层评分体系（Hero，巨型数字+洞察）
- type: content / role: hero / rhythm: peak / layout: 巨型数字+洞察
- visual: L1 巨型数字（100 分满分 / 四维权重 / 六条硬约束）
- anti_pattern: 禁止把权重做成等宽四卡；禁止 L3 角标顶替 L1
- description: 中心巨型"Rule Score 100 分"锚点 + 四维权重（步数30/血压25/血糖25/运动20）+ 三层（L1规则分/L2 AI意见/L3 辅助分）+ 六条硬约束。

### 11 章节扉页 03
- title: 任务管理、权限边界与验收
- type: section / role: transition / rhythm: transition
- description: 章节 03，要点 3 条。

### 12 今日任务与覆盖契约（非对称双栏）
- type: content / role: supporting / rhythm: valley / layout: 非对称双栏
- visual: SVG 提案状态机（宽栏）
- anti_pattern: 禁止上下分栏等分；禁止任务频次做成纯文字堆
- description: 左任务频次表（血压日2次/血糖空腹日1次/体重周2次/运动日步数/用药日核对）；右医生覆盖五条红线 + 提案状态机 pending_review→approved/rejected。

### 13 AI 权限边界与写入面（左标题右内容）
- type: content / role: supporting / rhythm: valley / layout: 左标题+右内容
- visual: L3 FAIcon 盾牌图标列表
- anti_pattern: 禁止把"AI 不能做的 7 件事"堆成无层次列表
- description: 左"AI 只说不做，做必走契约"原则；右 7 条不能做的事 + 写入面白名单（12 表 / 5 契约文件）。

### 14 系统边界与验收证据（Hero，巨型数字+对照）
- type: content / role: hero / rhythm: peak / layout: 巨型数字+对照
- visual: L1 巨型数字 456/457 + 能做/不能做对照
- anti_pattern: 禁止把 8 条能做/8 条不能做做成两张等宽卡
- description: 顶部巨型"456/457 · 99.8%"锚点；下"能做 8 条 / 不能做 8 条"非对称对照；诚实标注 1 条已知失败。

### 15 总结与感谢（Hero，居中金句）
- type: ending / role: hero / rhythm: peak / layout: 居中金句
- visual: L1 居中金句"让 AI 少做，比让 AI 多做更重要"
- anti_pattern: 禁止烟花、金装饰、印章
- description: 金句 + 当前限制（左）+ 后续方向（右）+ 谢谢聆听。
