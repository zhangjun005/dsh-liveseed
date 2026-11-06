# Session、Context 与工作区边界验证

日期：2026-11-06（Asia/Shanghai）。状态：**接口验证完成；产品接入方案尚未冻结**。

## 结论

1. **自有上下文策略可以沿用 Harness 的原生日志、surface 与运行循环。** 已实测合成记忆注入、版本替换、工具续轮、持久化、重新装载和状态投影重建，不需要自写模型调用循环或第二份权威事件日志。
2. **普通共享服务内的专有 Session ID 不等于工作区隔离。** 实测仍进入宿主会话语料列表和全文搜索；没有主动 attach 到某 Workspace 也不能据此认为已隐藏。
3. **归档不适合表达“隐藏但继续生活”。** 实测运行中的 Agent 无法正常归档；本机代码与上游讨论另证归档状态也是每步运行门控的依据。
4. **直接用 `ctx.isolate` 复制整套原生服务在本次组合上未跑通。** 创建第二个 Agent 报 `cannot get property "sessionProjections" without inject`。只将它记为当前组合的兼容障碍，尚未证明是宿主缺陷，也不宣称所有隔离组合都不可行。
5. **同进程内使用两个独立的原生 Context 服务容器，底层隔离可行。** 内层使用相同的 Session、JSONL、投影、AgentLoop 和查询实现；外层会话 registry、Agent registry、持久化列表、语料列表和搜索均看不到内层会话，外层事件监听也未收到内层事件。父容器卸载能够清理内层服务。但这不是完整 DSH / Web 插件部署验收，不自动继承宿主权限和通用工具能力。

因此：**上下文机制可以继续沿用；工作区归属与权限接入仍是架构选型的主要约束。** 暂不因列表隐藏的问题重写 Context，也不把独立 Context 测试容器直接转成产品启动器。

## 方法与复现

- 使用本机已安装的 DSH 包，均通过 `package.json` 导出的公开入口导入；未修改安装文件。
- 在测试进程内组合真实 Cordis、Session、AgentLoop、工具运行时、JSONL 后端、SQLite 查询与 Workspace 服务。
- 模型端使用本地合成适配器，返回固定文本及一次无副作用的工具调用；未接入真实模型、API 密钥或用户会话。
- 实验临时文件位于 `.local/context-probe-*`。每次使用新目录；恢复测试复用同一份 JSONL，并创建新的 Context 与全新的查询索引。
- 当前基线：DSH 及相关核心包 `0.2.0-rc.2`、Cordis `4.0.5`。机器报告保留包版本、公开入口路径与 SHA-256。

```powershell
Set-Location E:\works\LiveSeed
$env:LIVESEED_DSH_ROOT = 'D:\nodejs\npm-global\node_modules\@deepseek-ai\dsh'
pnpm probe:context
```

脚本：`scripts/probes/harness-context.mjs`。

固定的本次报告摘要：`validation/harness-context-2026-11-06.json`。完整合成请求与临时运行报告位于该摘要记录的 `runRoot` 下，不提交运行日志。

## 测试结果：6 项通过，1 项存在阻碍

| 测试 | 实际覆盖 | 结果 |
|---|---|---|
| 原生循环 + 专属上下文 + 工具续轮 | 在 Agent 的 scoped `pre-step` 中注入来源明确的消息；原生执行工具并将成功结果送入下一模型步骤；之后运行普通 Agent，确认专属记忆未串入 | 通过 |
| 上下文版本替换 | v2 通过原生 `surfaceOp.replace` 替换 v1；实际模型请求只看到 v2，日志仍保留 v1 与替换依据 | 通过 |
| 共享 registry 的可见性 | 专有 ID 仍被原生查询服务列举和搜索命中；程序化 Agent 未自动 attach 到 Workspace，但并未因此脱离会话语料 | 通过：证实未隔离 |
| 运行中归档 | 用合成模型屏障保持 Agent 正在运行，调用原生 `archiveSession`，收到 `WorkspaceActiveSessionError` | 通过：证实不能拿归档充当显示开关 |
| 摘要替换、持久化与恢复 | 使用确定性的摘要替换一个旧用户节点；销毁原容器，从 JSONL 恢复；模型 surface 与投影完全一致，原始用户内容仍在日志；继续下一轮，无重复记忆槽位 | 通过 |
| 独立原生服务容器 | 同一进程内内外 registry、存储与查询不交叉，父生命周期清理内层 | 通过：仅服务层实验 |
| 同一事件总线的完整 `ctx.isolate` 组合 | 隔离 sessions、持久化、投影、prompt、LLM、tools、Agent registry、loop 与 query 后创建 Agent | 存在阻碍：依赖注入错误 |

每次实际模型调用还检查：请求 `messages` 与当时原生 `deriveMessages()` 完全一致；没有另加请求外的 system 字段；请求数组冻结且不可追加。这里没有私自维护第二套 `messages` 历史。

## 具体承载方式得到的证据

### 上下文

- 初次注入走 `agent/pre-step` 的消息准入，使用 `createUserMessage()` 创建完整、带 ID 与来源的原生消息，再交给循环记录。
- 已有记忆槽位通过日志里的原生替换操作更新；保留 `sourceEventSeqs`。
- 这次投影只从已提交的合成记忆快照推导当前版本、内容和来源位置，未把投影缓存当成事实源。
- 合成摘要测试的是原生 surface 替换与回放机制，**没有验证默认自动压缩算法、记忆检索质量或大规模 token 预算策略**。
- 第三方插件若要增加专有的非模型可见事件类型，仍需单独确认持久格式契约。当前主分支的 `appendPluginRecord` 明确限于仓库内 experimental 包，不能据此设计外部插件的任意事件写入。本次只采用原生消息与真实工具结果，不调用该接口。

### 工作区与会话控制

本机 `dsh-client-ui-workspace` 的 `sessionVisible` 排除 subagent、非当前空会话，以及按筛选模式处理归档集，没有看到专用的插件会话隐藏条件。`dsh-api-session-controller` 的归档门控在每次 `agent/pre-step` 检查同一归档集。

专用 preset 管能力组合，不负责会话列表归属。程序化创建后不 attach 到 Workspace，也不消除它作为“未分组会话”进入列表或搜索的可能。

不借用 subagent 的身份隐藏陪伴会话：该身份还有父子关系、继续运行与路由所有权语义，不能只当 UI 标签使用。

## 联网调查及上游讨论

- [官方 Agent 生命周期](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/agent-lifecycle.md)：模型可见准入、派生请求和工具结果进入同一 Session 流。
- [Session 契约](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/session/README.md)：append-only 日志、surface、投影、回放与持久化边界。
- [状态投影契约](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/session/session-projection/README.md)：状态由事件折叠得到；当前主分支的 handle API 与本机版本有区别，升级需迁移。
- [工作区规则](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/workspace/workspace/README.md)：分组与归档的运行语义。
- [工作区界面](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-workspace/README.md)：分组、平铺、搜索与 subagent 显示规则。
- [上游讨论 #9866](https://github.com/deepseek-ai/deepseek-harness/discussions/9866)：报告了与本次需求直接相同的“隐藏与运行耦合”问题。回复指出可提前返回 `pre-step` 决定绕过下游门控，同时明确指出这会跳过整条后续钩子链。此为讨论中的方案，不是已发布的隐藏 API，也不据此推定回复者身份。

未采用上述提前返回方案：它同时跳过压缩、上下文补充等下游处理，可能漏掉未来新增的策略，无法作为稳妥的默认接入方式。

## 接下来据此决定的边界

| 候选 | 可保留什么 | 还需要解决什么 |
|---|---|---|
| 宿主原生共享服务 + 独立的会话展示 / 所有权扩展点 | 原有工具、权限、会话管理链 | 当前基线没有已验证的“隐藏且可运行”公开扩展点；还要避免普通 Chat 路由接管 |
| 插件拥有的原生服务容器 + 专用面板 | 原生日志格式、投影、循环与持久化；不污染普通语料 | 宿主模型 / 工具 / 权限的显式桥接，配置、热卸载、UI 控制路由和升级维护成本 |
| 完整 `ctx.isolate` 服务组 | 有望在同一 Cordis 服务树内隔离 | 先解决或解释本次依赖注入错误，再验证全套事件与数据边界 |

当前不选择绕过归档门控、不修改宿主安装、不替换整个工作区组件。是否接受维护独立原生服务容器，需结合能力与权限桥接成本再定。

本轮没有运行真实 Web UI、没有验证全客户端列表和导航、没有使用真实模型、没有实现完整记忆系统、没有自动升级宿主。通过的服务层检查不能扩大为这些能力的验收结论。
