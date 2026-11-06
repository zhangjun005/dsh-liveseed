# Harness 依赖与演进评估

日期：2026-11-06。**未来改动均为基于现有接口的工程预估，不是 DeepSeek 路线图。**

## 已观察到的事实

- 本机 CLI：`@deepseek-ai/dsh` 为 `0.2.0-rc.2`；运行时实际解析的 Cordis 为 `4.0.5`，loader 为 `1.0.6`。
- Super-agent 是加载在 Harness 上的 bundle，以 core / app / executor / channel 等结构组合宿主能力，并通过 agent preset 配置不同会话；这支持「扩展上层能力，无需重写整个运行底座」的判断。
- 公开 Super-agent 的依赖基线为 DSH `^0.2.1-alpha.2`，Cordis `4.0.5-alpha.1`。这与本机不是同一验证组合，不能用它的安装要求直接替换本机配置，也不能把两个 Cordis 版本大小当作演进时间线。
- 本机 `sdk-minimal` 默认仅带 Shell；当前主分支文档已包含读图、工作目录工具和自动压缩。默认 bundle 的变化确实存在，但不等于 `apply(ctx)` 已被破坏。
- Session 主分支文档已将若干同步日志读取 API（如 `eventAt`）标为弃用；本机部分插件仍有调用。直接遍历内部日志存在明确迁移风险。
- 官方仍标注 developer preview，可能有破坏兼容性的变更。Super-agent 的边界清晰不能单独证明所有宿主 API 稳定。

## 可能变化与对 LiveSeed 的影响

| 依赖面 | 相对风险预估 | 可能的变化 | 当前策略 |
|---|---|---|---|
| Cordis `name/apply`、依赖注入、生命周期 | 较低 | 配置校验、清理或插件元数据细节 | 同进程独立 Context，真实 loader 与释放验证 |
| bundle / profile / agent preset | 中 | 默认工具、persona、插件 ID、配置树调整 | 自有 bundle，模型桥显式接入，不复制默认树 |
| 工具 schema / 执行协议 | 中 | 输出 schema、取消、并发、权限相关字段 | 当前工具集合为空，并用原生 guard 拒绝调用 |
| 会话入口、事件和 prompt 注入 | 中到高 | 事件类型、scope、输入准入、回放与投影契约 | 集中在适配层，验证原生日志恢复、重试与停止 |
| Web UI 扩展 | 中到高 | sidebar / slot、组件服务和前端构建协议 | 复用官方 main / sidebar.panellist slot 与客户端模块加载协议，浏览器验收 |
| Session 磁盘格式 / 私有模块 | 高 | 存储版本、迁移、内部文件布局和同步访问弃用 | 不直读宿主磁盘、不导入 `lib/*`、`src/*` 私有路径 |
| 独立 SDK 协议 | 本阶段无直接影响 | run、通知、取消语义变化 | 用户已选择宿主内插件，本阶段不引入 SDK 子进程链路 |

判断：预计近期影响更可能集中在**能力组合与宿主适配接口**，不应为猜测中的大改预建一套运行时。采用薄适配层即可；核心业务数据格式和行为规则仍由 LiveSeed 自己拥有，具体方案待讨论。

## 当前实际依赖面

当前运行时 peer 包括 Cordis `4.0.5`、timer `1.1.7` 和 DSH 的 Session、projection、JSONL persistence、checkpoint、agent、AgentLoop、LLM、system-prompt、tools、token-meter、compaction / compaction-basic、webServer、connection 与 default-model，DSH 包均锁定 `0.2.0-rc.2`；前端使用 React `18.3.1` 及官方 UI slot 类型。完整清单以 `package.json` 为准。记忆工具按主线 / 整理线分别受限开放，不依赖 Super-agent，不开放 Shell、联网或通用文件访问。

已发现一个具体版本差异：本机通过 `installModelSelection` 和 `ModelSelectionRef` 为原生 agent 提供模型选择，不能照搬新分支的 `agent.model` 用法。前端必须输出官方模块加载器支持的 CJS factory，普通 ESM 编译产物无法直接作为客户端插件加载。这两处集中在适配层和构建脚本中。

已通过 loader、原生 Session 集成测试与完整 DSH Web 验收；当前完整边界见 [04](04-最小原型与验收.md)。未扩大到其他版本，也未验证真实模型供应商调用。

## 升级时如何判断

1. 记录目标 DSH、Cordis 与实际用到的宿主包版本及发布说明；对照适配层的 import / inject / hooks 清单。
2. 在单独的开发环境检查，而非升级用户现用 DSH；更新开发依赖和锁文件。
3. 运行 `pnpm check`、`pnpm test:browser` 和包内容检查，关注模型桥、Session 恢复、工具拒绝、原生列表 / 搜索隔离和客户端模块加载。
4. 验证后更新兼容声明；涉及自有持久数据时另做迁移与回滚验证。

## 安全边界

随 DSH 常开运行满足当前生命周期前提，不增加系统服务或其他常驻宿主。DSH 关闭时插件也停止；正常重启恢复原生日志。停机期间的主动行为与补处理仍待讨论，当前没有调度器。

**DSH 插件本身不是 OS 沙箱。** 同进程插件仍可以使用 Node 的文件和网络 API，模型能使用哪些能力也受所选 preset 影响。LiveSeed 应通过明确的宿主能力与权限控制接入；不能仅凭「运行在 DSH 中」宣称访问已经隔离。

## 证据

- [Harness 项目状态](https://github.com/deepseek-ai/deepseek-harness#developer-preview)
- [官方插件入门](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/index.zh.md)
- [官方能力分层教程](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/practice/index.zh.md)
- [Session 当前接口](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/session/README.md)
- [sdk-minimal 当前组合](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/sdk-minimal/README.md)
- [Super-agent package.json（固定提交）](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/package.json)
- [Super-agent 插件组合（固定提交）](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/cordis.patch.yml)

主分支文档会变化，以上观察只代表本次检查时的内容；实际开发以锁定宿主和安装包类型声明为准。
