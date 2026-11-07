# 整理 Session 指定与界面设置

2026-11-07，按用户澄清：指定的是**承担整理工作的长期 Session**，不是待整理的聊天来源。

## 三个入口与字号

右上角由上到下放置三个圆形按钮：聊天、记忆整理、设置。聊天展开日期列表；记忆整理展开自己的 Session 列表，可以打开任意本域会话并继续对话，也可以新建会话而不自动指定。列表上的“整理任务”标记只说明后台任务投递目标，当前查看项另外高亮。点击任意会话不会改写任务指针。

设置使用 DSH 原生公开 `Modal`，沿用原生遮罩、焦点管理、Escape 和关闭行为。弹窗参考原生设置的 800px 桌面布局：标题栏、左侧分类导航、右侧分组设置行；窄屏分类转为横向。`src/client/settings-dialog.tsx` 用分类数据组织真实内容，目前只有记忆整理，后续功能可增加分类而不叠加到会话菜单。

设置里选择候选后仍需点击“指定”；另有“新建并指定”。修改配置保持当前查看的实际 Session，即使当前查看的是另一个整理会话，也不会跳到新承担者。显式 `corner-shape: round` 保证三个悬浮按钮为正圆形。

正文使用宿主 `--dsh-content-font-size`，标签使用 `--dsh-content-font-size-secondary`，行高使用内容字号增量；原生 Markdown 和 InputBar 保持上游字号实现。DSH 的 ThemeRuntime 设置入口负责写偏好，原生 layout presenter 发布 CSS 变量；插件消费这些变量，不维护第二份字号偏好或写死正文 14px。菜单仍按宿主普通控件字号，不把“会话内容字号”设置扩大为整个应用缩放。

设置中同时显示 `soul.md` 和 `narrative.md` 的绝对路径，由宿主从实际 `stateDir` 解析后经 `catalog.filePaths` 返回。展示为可选择、复制的普通文本，不提供路径指定、文件选择、编辑或打开文件功能；未导入 soul 时也保留其预期位置。路径信息不进入模型 Context。

## 长期 Session 与人工指定

- 默认仍为 `liveseed-memory`；按天换段、任务批次和压缩均不自动更换整理 Session。
- 允许用户新建独立整理会话，并指定其中一个承担自动增量整理 / 反思任务。其他会话仍可继续用户维护对话，不需要先指定。所有模型任务串行执行，不并行启动多条整理执行线。
- 候选登记和当前指针写入既有原生审计 Session。新会话首次实际执行任务 / 对话时物化为原生 Session，后续执行恢复同一日志；旧 Session 保留，不 fork、不拼接原始日志。
- 记忆域、版本、narrative、chapter 和已处理来源共用既有审计事实，不因指定变化清空或复制数据库。每个任务记录承担者 `workerSessionId`；旧日志中未记录该字段的任务归属于原默认 Session。
- 维护对话按实际会话分开回看与续写，已登记的非指定会话也可接收维护消息。调度优先处理所有会话的维护对话，再处理指定会话的自动任务；旧会话未完成的自动任务保留原归属，重新指定后可继续。已有任务承接的来源 / 意图不重复建任务。
- 正在运行的整理拒绝切换，可等结束或停止后再指定。比较 `expectedSessionId` 拒绝过期页面误覆盖。发送、草稿和停止绑定实际查看 / 运行 Session；指定变化不会把消息、草稿或取消操作转投其他会话。执行句柄按任务的实际 Session 按需恢复并释放，任务投递指针单独从审计恢复。
- 候选属于本产品私有整理域，不开放宿主普通工作区、主线或审计 Session 的 Agent 接管；整理模型继续只有记忆域窄工具，不继承普通工作 Agent 的权限。

## 新增 Remote 契约

沿用 `remote.liveseed`、Typert 严格 schema、原生 Gateway / WebSocket、现有认证和错误信封。

| 方法 / 字段 | 内容 |
|---|---|
| `catalog().memorySessions` | `{id,title,active,running}[]`，独立会话列表；active 代表自动任务指定，running 代表该会话正在执行任务 / 对话 |
| `catalog().memorySessionId` | 当前自动任务投递的整理 Session ID，与前端正在查看的会话无关 |
| `createMemorySession({requestId,title})` | UUID 幂等创建本域会话，返回 `{sessionId}`；不会自动指定，也不要求指定后才能对话 |
| `selectMemorySession({sessionId,expectedSessionId})` | 显式指定已登记候选；拒绝忙碌、未知身份和过期比较值，返回 `{sessionId}` |
| `follow/snapshot({sessionId:'memory'})` | 跟随当前整理指针的逻辑入口；帧携带实际 Session ID，切换后整份视图替换 |
| `send/stop({sessionId:实际ID,...})` | 维护消息 / 停止绑定实际会话；非指定会话仍可对话，不改变后台任务目标；已接受回执可确认 |

界面“新建并指定”依次调用两个新增接口；失败保留原承担者和可重试的创建请求 ID。其他后续前端或开发 chat 可以通过上述契约接入，不需要改记忆调度内部实现。

实现位于 `src/adapters/harness/remote-contract.ts`、`remote.ts`、`runtime.ts`、`memory.ts`、核心记忆 fold，以及 `src/client/panel.tsx` / `settings-dialog.tsx`。依赖 [12 内容层级与权限](12-Context内容层级与主线记忆权限.md)、[13 原生输入与通信](13-专属会话导航与原生通信.md)，不改变主线权限和记忆提交语义。

## 验证

原生集成覆盖创建幂等、忙碌 / 过期 / 非法身份拒绝、逻辑流切换、旧回执确认、任务归属、重启恢复、非指定会话续聊，以及通过原生 persistence 核验维护对话 / 自动任务确实写入各自指定的 Session。隔离浏览器从原生设置页面将字号 14 调到 18，检查用户消息、助手 Markdown 和原生输入实际均为 18px，同时检查三个按钮的圆形与上下位置、原生设置弹窗与移动端布局、会话导航 / 草稿独立、非指定会话续聊、新建而不指定、显式指定和重启恢复。合成模型测试，不请求真实 API。
