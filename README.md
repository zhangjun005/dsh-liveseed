# LiveSeed · 德谬歌

运行在 DeepSeek Harness 内的陪伴 AI 插件。已实现原生对话、记忆模块首版、主线按天分段、L0–L4 Context、独立整理对话与重启恢复。

插件在现有 DSH 进程内持有独立的原生 Cordis Context，复用 Harness 的 Session、上下文和持久化服务。Session 日志是唯一事实源，面板记录是可重建投影。专有会话不注册到宿主普通工作区，独立入口不会生成工作区会话条目。

主线仅开放主动只读回想、重要 / 临时保护意图与简短理解提交；整理线维护已授权记忆域。文件、Shell 和普通工作区控制能力均未开放。早期对话原型记录见 [最小原型与验收](docs/04-最小原型与验收.md)。

当前记忆实现、依赖的设计 Markdown、调度默认值与验收范围统一记录在 [记忆模块目录说明](src/core/memory/README.md)。原始设计见 [记忆模块](docs/05-记忆模块讨论稿.md)。[网页角色展示与驱动](docs/06-网页角色展示与驱动方案.md) 继续搁置。

记忆的运行时机、取舍与 context 压缩联动见 [补充方案](docs/07-记忆取舍与上下文压缩.md)。视觉角色模块当前搁置，仅保留接口边界。

主线按天安全换段、有限交接和跨段回执恢复已实现，见 [分段方案](docs/08-长期身份与Session分段.md)。整理模型始终使用同一个长期私有 Session。已确认内容与保留项见 [决策清单](docs/09-决策状态与未决项.md)。

状态依赖 Context，用户可通过输入框下方“整理记忆”与整理线对话，模型复用宿主路由。工作 prompt 后 15 秒主动表达尚未接入，见 [接入与行为方案](docs/10-Context状态与工作输入触发.md)。

soul、真实叙事与消息的续接式组织，以及可选动作协议的参考，见 [Context 与表现协议讨论](docs/11-叙事续接式Context与表现协议.md)。

L0–L4、两类思考记录及主线窄记忆权限见 [层级与权限方案](docs/12-Context内容层级与主线记忆权限.md)。soul 初始材料仍可留空，整理器只能记录修改候选，不能自动改写底层人物材料。

L1 积累的自我与关系叙事渲染为私有 `stateDir/narrative.md`，可从原生接受记录重建；空模板见 [templates/narrative.md](templates/narrative.md)。初始人物材料可放 `stateDir/soul.md`，导入会保留版本与来源。

## 本地开发

验证基线：DSH `0.2.0-rc.2`、Cordis `4.0.5`、Node.js `22.23.3`、pnpm `11.25.0`。兼容声明只覆盖已验证组合。

```powershell
Set-Location E:\works\LiveSeed
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check` 包含类型检查、服务端与客户端构建、真实 loader 加载 / 卸载检查，以及原生 Session 集成测试。测试使用合成模型，覆盖持久化重试、停止、恢复、故障恢复和工具隔离，不消耗真实模型额度。

完整 DSH Web 验收：

```powershell
$env:LIVESEED_DSH_ROOT = 'D:\nodejs\npm-global\node_modules\@deepseek-ai\dsh'
pnpm test:browser
```

该脚本自动启动并关闭隔离开发宿主，使用临时 `DSH_HOME`、临时端口和合成模型；不会修改现用 profile。默认使用已安装的 Microsoft Edge；可用 `LIVESEED_BROWSER` 指定浏览器可执行文件。结果写入被 Git 忽略的 `.local/web-acceptance-*`。原始日志可能包含开发宿主登录地址。

`pnpm dev` 只监视 TypeScript 编译；修改前端后需执行 `pnpm build` 重新生成 DSH 客户端模块。

## 在 DSH 中加载

先执行 `pnpm build`。本地覆盖层 `examples/local.cordis.patch.yml` 指向本仓库绝对入口，并将原生日志存入 `E:/works/LiveSeed/data/liveseed`。

手动创建开发 Web profile：

```powershell
dsh --profile liveseed-dev --from-default-profile web --patch E:/works/LiveSeed/examples/local.cordis.patch.yml --port 3081 --no-open
```

`--from-default-profile web` 只在首次创建该 profile 时使用；后续启动去掉此参数。选定一个未占用端口。测试宿主与日常使用的宿主相互独立；产品本身仍为宿主内插件。

打开 DSH 后点击「德谬歌」入口。默认使用 DSH 当前默认模型；也可以在插件配置中同时指定 `provider` 和 `model`。模型凭据继续由宿主管理。未配置模型时可以查看历史，发送会提示先配置模型。

整理模型可用 `memoryProvider` / `memoryModel` 绑定宿主已有 DeepSeek 路由；省略则沿用宿主默认模型，因此应先在宿主选择 DeepSeek。调用与主线使用不同的私有 Context 和 Session。默认 8 条话语来源或空闲 60 秒合批，参数及能力边界见模块说明。

包分发使用 `pnpm pack --pack-destination .local/releases`。根目录 `cordis.patch.yml` 默认禁用插件：在目标 profile 安装后，设置绝对路径 `stateDir` 再启用。包加载与本地覆盖层不要重复启用，也不要让两个实例同时使用同一 `stateDir`。本次没有安装到现用 DSH。

## 目录

```text
src/core/protocol.ts          与宿主无关的面板协议
src/core/memory/              记忆 schema、提交折叠、召回与设计依赖清单
src/adapters/harness/         原生运行服务、模型桥、HTTP 与日志投影
src/client/index.tsx          专属面板
scripts/build-client.mjs      DSH 客户端模块打包
scripts/testing/              合成模型、集成测试与隔离 Web 验收
scripts/probes/               前期接口实验，不是产品启动器
examples/                    开发与验收覆盖层
docs/                        已确认前提、架构验证与历史材料
```

从 [项目起点](docs/00-项目起点.md)、[依赖评估](docs/01-Harness依赖与演进评估.md) 和 [记忆模块实现](src/core/memory/README.md) 开始阅读。早期初始化、接口实验与最小原型验收保留各自阶段的结论；当前记忆实现以模块说明为准。
