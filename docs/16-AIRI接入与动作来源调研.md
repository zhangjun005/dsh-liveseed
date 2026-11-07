# AIRI 接入与动作来源调研

日期：2026-11-07。状态：本地源码核对及联网调研，建议方案；尚未安装渲染依赖、下载动作素材、转换角色或运行舞台。素材现状与使用边界见 [15](15-本地角色模型检查与MMD适配.md)。

后续修正：针对完整骨架和表情的进一步检查见 [18](18-完整PMX骨架与表情适配方案.md)。本模型有 3 个材质 Morph，AIRI 的通用 Morph 槽与底层默认路径尚不足以保证完整支持；执行器保留候选身份，优先验证具备完整 PMX 求值的 Three 实现，不将本篇的 moeru 依赖建议视为最终选型。

## 接入分工

按用户最新要求，角色应在整个 DSH 网页中常驻，在其他工作区工作时也可见。建议将 Canvas 注册到根级 `shell.overlay` 插槽，由独立 TypeScript 控制器管理 Three.js 场景、相机、加载和逐帧更新。React 负责挂载、设置与生命周期，不为每帧骨骼变化更新 React state。德谬歌聊天面板只承担会话交互，不持有舞台的生命周期。

直接依赖 AIRI 使用的底层 `@moeru/three-mmd`，按需加入 Ammo 物理；参考 / 适配其少量 MMD 加载、材质、Morph、动画和视线逻辑。复制的代码如采用 MIT 源码，应保留相应版权与许可。AIRI 的 `stage-ui-mmd` 本身是带 Vue / Pinia / workspace 依赖的私有包，不能当成独立 React 组件直接安装，也不在 DSH 外再运行一套 AIRI 服务或通过 iframe 借用整套应用。

调研到的 `@moeru/three-mmd-r3f` 当前清单要求 React 19 / R3F 9，而 DSH 项目使用 React 18；本轮建议先采用原生 Three.js Canvas，不升级宿主 React 或嵌入第二份 React。依赖版本需要在实际加载验证时锁定，本地 AIRI 的候选基线为 three-mmd `0.2.0-beta.2`，不是已通过 LiveSeed 兼容性验收的版本声明。

```text
主线回复与有限表现意图
    → 宿主校验与原生 Remote
    → 表现调度器（回复 / 片段 / 取消代际）
    → 动作库 + Morph / 视线控制
    → AnimationMixer + MMD IK / 继承变换 / 物理
    → Three.js Canvas
```

角色模型及贴图继续位于被忽略的本地目录，通过受控资源解析保留相对路径；不复制到可分发的 public / dist，不上传给动作转换网站。语言模型只看到有限语义能力，不接触文件路径、骨骼地址或脚本。只有主线当前有效回复参与表现，整理对话和后台任务不进入表现队列；原生日志继续区分意图与实际播放结果。

## DSH 全局常驻的挂载与生命周期

本机 DSH `0.2.0-rc.2` 的公开 `@deepseek-ai/dsh-client-ui-layout` 类型将 `shell.overlay` 定义为 `kind: list`、`scope: root`。源码注释明确该浮层位于各栏之上、滚动容器之外，默认点击穿透，条目用独立 ID 追加。这是当前版本的直接接口证据，升级仍需复核。

因此每个 DSH 页面只创建一个舞台 / renderer，通过独立条目挂到该插槽。切换普通工作区、主线每日 Session 或整理对话均不重建舞台；切换面板也不释放模型资源。插件停用或页面卸载时才完整清理。这里的常驻范围是 DSH 页面，页面关闭后停止浏览器渲染。

浮层背景透明，默认穿透鼠标；仅显式拖拽把手和操作控件接收输入，避免整个 Canvas 矩形挡住编辑器。位置、尺寸、显示开关放入现有设置的角色分类，跟随 DSH 样式，弹窗保留焦点与点击优先级。这些属于界面设置，不是独立的情绪 / 关系状态。

舞台的原生 Remote 订阅须独立于聊天面板的挂载与当前浏览 Session。浏览整理会话或历史主线时，仍只接收德谬歌有效主线的新表现事件；普通工作 Agent 输出和整理输出不直接驱动角色。切日重新绑定有效主线，并用回复 ID / 代际处理取消、去重和迟到结果。当前聊天面板的订阅不能原封不动当成全局舞台实现。

页面可见且角色开启时运行待机；浏览器标签隐藏或用户隐藏角色时暂停渲染 / 物理，恢复时限制帧间隔，不重播积压动作。多个 DSH 标签页仍需保证同一回复仅一个页面持有自动播放权，不能把每页一个 renderer 误当作每个页面都可自动朗读。

联网找到的 `MeteorNOX/DeepSeek-Balance-Whale-Widget` 官方 README 确认其为 DSH Web 右下角常驻、可拖拽的标准 bundle 插件，可参考交互目标。上述挂载方案的依据来自本机公开 API；没有据此宣称用户所指的具体插件一定采用同一内部实现。

## AIRI 已有能力与需要补齐的动作

本地基准 `259b6188a7209a46bd535fa011340486654da8df`：

- `packages/stage-ui-mmd/src/composables/mmd/loader.ts` 使用 MMDLoader / VMDLoader / buildAnimation 加载模型和动作。
- `animation-manager.ts` 有动作注册、单次 / 循环播放、淡入淡出和结束回待机。未注册动作只返回 false；没有 idle clip 时回静止初始姿态，不会自动生成自然待机。
- `constants/actions.ts` 是可配置的情绪 → 动作名称映射，不是对应的动作文件库。
- 原有眨眼、眼神、口型与 Morph 表情逻辑可以参考，但它们不能代替身体手势。

发现一个接入时必须处理的具体冲突：`gaze.ts` 的 `applyBone()` 在每帧以 rest pose 覆写头骨 quaternion，`MMD.vue` 又在动画更新后调用它。因此，包含头骨轨道的点头 / 摇头动画可能被视线覆盖。应采用统一的通道控制权，或将视线作为当前动画姿态上的有界增量；明确动作控制头部期间可暂时仅保留眼睛注视。

运行时只保留一个主更新循环。程序身体动作优先编译为可混合的 AnimationClip，进入同一个 mixer，再由 MMD 运行时处理 IK、继承变换与物理。不要对同一帧同时调用 update() 与 updateWithMixer()；也不能在物理算完后任意改写全身骨骼。

## 动作的四条实际来源

| 路线 | 找到的项目 / 工具 | 对 LiveSeed 的用途与限制 |
|---|---|---|
| 程序动作 | 自有 PMX 动作定义；`avatar-stage` 可作参考 | 基于校准后的骨骼角色和静止姿态生成短关键帧，如呼吸、点头、摇头、小幅歪头和挥手；avatar-stage 面向 GLB，其骨架识别 / ARKit 表情不能直接用于本 PMX |
| VMD 动作 | three-mmd 的 VMDLoader + buildAnimation；AIRI 动作管理器 | 与当前 PMX 路线最直接。仍需验证骨名、IK、初始姿态、动作过渡、体型与服装效果，动作文件自身另有许可 |
| 人形动画重定向 | Quaternius Universal Animation Library；Reze Rig；Blender MMD Tools | 先取得有适当许可的 FBX / GLB 等动作，离线重定向至目标 PMX 并导出 VMD；不能把普通 FBX 直接交给 VMDLoader |
| 自行录制动作 | Reze MiPo（原 MiKaPo） | 可本地运行，通过摄像头 / 视频动捕准备 VMD。适合作为离线动作制作工具；运行中的德谬歌不需要持续开摄像头或常驻动作制作服务 |

具体核对结果：

1. **Reze Rig** 原仓库名 `Mixamo-MMD`，当前地址为 `AmyangXYZ/reze-rig`。官方 README 给出了本地 `scripts/fbx2vmd.ts` 批处理入口，支持 `--target-pmx` 测量目标骨架、`--in-place` 去除平面位移、以及脚部 IK 等选项。适合作为离线候选工具，不需要把昔涟上传在线站点；本模型尚未实测重定向效果。
2. **Quaternius** 官方动画库标示 CC0，提供 FBX / GLB / Blend，下载页区分免费 Standard 与付费 Pro / Source。不能将完整库的 120+ / 130+ 宣传数量理解为全部免费或全部适合陪伴手势。需要查看实际包内清单，优先选原地、轻柔、日常动作，再校准与裁剪。
3. **Blender MMD Tools** 官方扩展支持 PMX 和 VMD 导入 / 导出，可用于本地修正和烘焙。它提供编辑与导出能力，不意味着任意骨架的动画会自动完成高质量重定向。
4. **Reze MiPo** 原名 MiKaPo，官方 README 提供本地运行方式与 VMD 输出。其浏览器/WebGPU/MediaPipe 方案适合制作素材；作者的性能描述不是本机测试结果，代码和动作 / 模型 / 视频素材的许可也应分别处理。

## FBX 从哪里来，如何准备

Reze Rig 是动作重定向 / 转换工具，不生成源动作。输入应是带人形骨架和动画轨道的 FBX；仅把昔涟 PMX 转成静态 FBX 不会得到点头、挥手等动作，也不需要为了这条路线先转换角色模型。

建议采用以下离线资产流程：

1. 从 Quaternius 等许可明确的动作库取得带源骨架的动画 FBX，先检查免费包实际提供哪些动作；使用通用源人形，不上传昔涟。当前尚未下载，不能承诺某个具体招呼动作就在免费包内。
2. 枚举源文件的片段与骨名，选择合适的原地待机 / 手势；必要时在本地 Blender 中裁剪、调整幅度、烘焙并按动作分别导出 FBX，保留源骨架及正确的参考姿态。
3. 用 Reze Rig 本地 CLI，指定 `--target-pmx` 为当前昔涟 PMX，将源动作重定向为 VMD。`--in-place` 可用于去除平面位移；`--bind-ref` 必须选源骨架适用的参考文件，不能为不同来源盲用同一 Idle。
4. 在实际 PMX 和目标运行时中逐个检查手臂、头部、脚部 IK、服装和起止姿态；需要时用 Blender MMD Tools 修正 / 烘焙 VMD，再注册成有限语义动作。转换成功只说明生成了文件，不能代替视觉验收。

具体源码限制：截至本次检查，`scripts/fbx2vmd.ts` 对多片段 FBX 警告后只转换 `clips[0]`。不能把一个含很多动作的 FBX 直接批转并声称已得到完整动作库；先拆成单片段文件，或在独立工具副本中明确增加逐片段导出。其输出按 basename 扁平写入，同名输入也需避免覆盖。CLI 编译后的默认参考文件使用相对脚本位置，离线封装时应明确传入正确的参考路径并验证，不照抄临时输出路径后假定所有资源可找到。

基础呼吸、点头、歪头、小幅挥手可直接在校准后的 PMX 骨骼上生成 AnimationClip，无需制作 FBX。若在 Blender 中直接针对 PMX 制作动作，也可以由 MMD Tools 导出 VMD，跳过 FBX / Reze Rig。运行中的 DSH 只加载 PMX、贴图与最终动作，不运行转换器。所有与本角色关联的转换 / 烘焙文件继续保存在被忽略的本地资产目录。

## 建议首版采用混合动作库

先实现能够独立工作的少量基础动作：轻微呼吸 / 待机、小幅点头、摇头、歪头、轻挥手、回到中立姿态。基础动作通过程序生成和这份 PMX 的骨骼映射来准备，不依赖找到恰好合适的第三方 VMD。

随后用经过本地校准的 VMD 补充更自然的招呼、鞠躬或对话手势。每个动作定义语义 ID、必要骨骼、影响部位、结束姿态、时长范围和可用幅度 / 速度范围。同一语义可以有多个经过验收的变体，但不能随机播放无关动作或把动作数量当作质量。

调度器分别管理身体基础层、手势层、头部 / 视线、表情和口型。动作覆盖对应骨骼通道，口型只跟随实际音频；动作结束或中断后平滑回到待机。多个入口不能直接写同一骨骼，角色不具备的动作不向主模型宣称可用。

## HAST-SEC 与生成式运动的位置

进一步按用户提出的上身为主、保留下身小摆动需求复核后，HAST-SEC 不应只作为参数设计参考：其基础行为切换、局部轨道覆盖 / 混合、过渡与脚部接触处理均值得采用。建议在 AIRI / three-mmd 执行器之上适配这些表现控制机制，详见 [17 上身动作与 HAST 行为控制复核](17-上身动作与HAST行为控制复核.md)。

现有 VRM 控制器和 53 骨骼学习资源不能直接用于本 PMX，仍需参考姿态、坐标、骨骼与约束适配；完整求解器单独验证，避免与 MMD IK / 物理重复争写。HAST 原有主动聊天触发不移植，继续遵循普通工作 prompt 后 15 秒的门控。其源码另有非商业学习研究许可，不按 AIRI 的 MIT 范围处理。本轮尚未复制代码 / 权重或接入运行。

同时检索了 MDM / DiP 等文本到运动研究实现。它们需要独立推理环境，生成的运动仍需适配目标骨架与约束，不等于输出可直接用于此 PMX 的动作。本轮建议将其保留为未来离线动作制作来源，不作为每次聊天的必要运行依赖；也不因此给产品增加常驻 Python / 运动模型进程。

## 首轮验证顺序

1. 根级浮层中加载本地 PMX + 完整贴图，验证切换工作区 / 会话不卸载或重复创建、点击穿透与设置弹窗优先级；验证表情和基础骨骼，先建立物理关闭的基线，再分级启用物理并测量开销。
2. 原地待机 + 一个程序点头，检验视线不会抹掉动作、没有逐帧积累旋转、结束和取消能归位。
3. 一个来源明确的 VMD，经实际 PMX 重定向 / 校准后检验手臂、脚 IK、裙摆和动作过渡。
4. 接入主线表现意图，验证流式分段、重复事件、迟到结果、停止与重连；历史回复不重新播放，整理不会误触发表现。

## 调研来源

- [AIRI MMD 固定版本](https://github.com/moeru-ai/airi/tree/259b6188a7209a46bd535fa011340486654da8df/packages/stage-ui-mmd)
- [DSH 小鲸鱼常驻挂件](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget)
- [three-mmd 官方 README](https://github.com/moeru-ai/three-mmd)
- [three-mmd React 包当前 peer 清单](https://github.com/moeru-ai/three-mmd/blob/main/packages/three-mmd-r3f/package.json)
- [Reze Rig 与本地批处理](https://github.com/AmyangXYZ/reze-rig)
- [Reze Rig 当前批处理源码与多片段限制](https://github.com/AmyangXYZ/reze-rig/blob/main/scripts/fbx2vmd.ts)
- [Quaternius Universal Animation Library](https://quaternius.itch.io/universal-animation-library)
- [Quaternius Universal Animation Library 2](https://quaternius.com/packs/universalanimationlibrary2.html)
- [Blender 官方扩展：MMD Tools](https://extensions.blender.org/add-ons/mmd-tools/)
- [Reze MiPo](https://github.com/AmyangXYZ/reze-mipo)
- [avatar-stage](https://github.com/rana-jatin/avatar-stage)
- [MDM / DiP 官方实现](https://github.com/GuyTevet/motion-diffusion-model)
