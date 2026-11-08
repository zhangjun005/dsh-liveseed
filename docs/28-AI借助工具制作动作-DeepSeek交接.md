# AI 如何借助工具 K 动作：给 DeepSeek 的操作指南

更新：2026-11-08。实际工作区 `E:\works\LiveSeed`。先读 `AGENTS.md`，本文件是操作交接，不替代用户最新指示。

## 1. 这次接手做什么

目前只继续调整 **胸前收手 `hands-front`**。用户要的是双手胸前比心：手腕再抬一点，掌心朝下，四指弯曲，大拇指向外展开。当前已制作候选，但用户明确认为轮廓不对，**不能视为已经验收**。

另三项仍待办，不能顺手改：侧倾聆听配背手；低头思索/纯头部动作和默认手臂；踮脚前后轻晃。已有挥手、背手、双手托腮、胸前单手等动作有多轮用户校准，不要重制。节奏问题（观感匀速、不生动）明确暂缓。

最新纠正：用户要求手掌/掌背顺应小臂方向，不再强制掌心朝下；四指继续加大弯曲。腕部空间目标维持 `0.20*unit` 高度，只在手腕上将“腕到中指根”方向对齐小臂轴线，保留既有小臂旋转。上一轮额外上转 11.5°已由此替代。四指三节额外弯曲量为 `[0,1.25,1.05]` 弧度（第一节顺应手掌，第二第三节弯曲），拇指外展后随整只手旋转。随后按用户要求，双手再绕世界竖直 Y 轴镜像内转约 47.2°（右手正转、左手负转），只有手腕旋转改变。左右大臂/小臂关键帧逐帧保持不变。随后双腕水平间距由左右各 0.44*unit 增至 0.49*unit，拇指外展略加大；四指弯曲保留。最后再在当前内转基础上，仅绕腕部横轴上转 5°，减小掌轴与竖直线夹角。用户最新指示覆盖本文件中早期“掌心朝下”的描述，仍须实际看轮廓。

## 2. 工具各自负责什么

| 工具 | AI 可以怎样使用 | 本机状态/限制 |
|---|---|---|
| PoPo | 从描述生成 MPL 姿态草稿；也可读取其提示词，自己写 MPL | 源码 `.local/tools/PoPo`；不是自动保证掌向、接触正确的模型适配器 |
| MPL 编译器 | 将 MPL 编译为 VMD，再提取目标姿态或烘焙片段 | `.local/tools/MMD-MPL/cmd/mpl.exe`，已跑通 |
| 本项目制作脚本 | 使用实际 PMX 骨长、方向计算主控制骨旋转，校准模型 | 当前动作实际生产来源，不能谎称是 PoPo 云端生成 |
| Blender + MMD Tools | 载入模型与姿态，读取骨骼/网格、摆姿、拍近景、审校间距 | 已安装且实际导入/渲染成功；不需要 MCP |
| Reze Studio | 可视化选骨、拖动、关键帧与曲线审校、VMD 导入导出 | 可选，当前没有接入；不要为了使用它而重做运行时 |
| DSH 隔离网页 | 验证最终真实渲染、袖口、过渡和归位 | 最终验收依据；Blender 图不能代替这里的验证 |

PoPo/MPL/Reze 源码为 GPL 工具，保持本地离线制作边界，不复制进插件运行时。Blender 的后台制作进程不等于给 DSH 产品新增后台进程。

**姿态是目标，短动作是过程，状态机是调度。** 背手/托腮可形成持续姿态，挥手仍有过程；状态机解决进入、保持、中断、退出和通道让位，不能自动把不自然的姿态变自然。VMD 是可选的离线交换文件，可装一个姿态，也可装完整动画。

## 3. 先保护现状

```powershell
Set-Location E:\works\LiveSeed
git status --short
pnpm build
if ($LASTEXITCODE -ne 0) { throw 'Build failed; stop before authoring' }
$pmx = (Get-ChildItem CharacterModel -Recurse -Filter *.pmx | Select-Object -First 1).FullName
```

工作区有前序未提交改动，不要 reset/clean 或覆盖。`.local/before-heart.json` 是本轮之前接触动作集合的快照；比较时允许 `hands-front` 改变，其他条目应保持一致。

官方模型在 `CharacterModel/`，禁止提交/上传/分发模型、贴图及转换副本。Blender 工程会包含模型数据，只能存 `.local`，真实截图也一样。不要将真实模型放进 `public`、`dist` 或常规 Web 测试输出。

## 4. 正确理解骨架，再调姿

相关代码：

- `scripts/authoring/local-rig.mjs`：载入实际骨架，重建本项目待机基线，提供按实测肢段方向对齐的 `aim`。
- `scripts/authoring/calibrate-contact.mjs`：`reachPalm`、`curlFingers`、`openThumb` 与 `hands-front` 配方。
- `src/client/character/contact.generated.ts`：烘焙产物，不手改大段数组。
- `src/client/character/pose.ts`：运行时恢复基线、叠加动作，再交给原生 MMD 求解。

### 控制权

模型有 493 骨，不能凭名字猜控制权限。按 PMX 刚体类型、付与、IK 实测分类：可直接写主控制骨 127 个；脚部 IK 目标 4 个；依赖/物理/IK 链结果骨 362 个不要写。本动作只用躯干、双臂、手腕、手指。`肩+`、`肩C`、`腕+`、`手捩1–3` 等付与输出不可作为直接输入。

袖子已随前臂移动。物理关闭时保持子骨静态局部变换，不能看到粉色内衬就断言“袖子没绑/穿模”。不新增物理、不改袖骨。

### 手掌的两条轴

仅把中指指向目标不够，还必须约束掌面法向。右手在当前 three.js 右手坐标中的测点：

```js
finger = normalize(middleRoot - wrist)
palm = normalize(cross(indexRoot - wrist, littleRoot - wrist))
```

**右手该法向朝掌心，左手需取反。** 前序曾把正负认反，连验证断言也一起错了；必须用带指甲/掌纹的实际图像确认，不只相信自己算的法向。

当前 `reachPalm` 先求肩肘腕位置，再分配小臂轴向旋转，最后对齐手指和掌面。只写主控制骨，不手写继承输出。`curlFingers` 沿跨掌方向弯曲，左右符号不同，可给三节不同弯曲量。

### 拇指不能当作第五根普通手指

本模型链为 `親指０ → 親指１ → 親指２ → 親指先`；另外四指是各自的 `１ → ２ → ３ → 指先`。拇指根的位置与轴向不同，独立处理张开、朝向和弯曲。`openThumb` 目前逐段按实际子骨方向对齐，是候选制作辅助，不是天然正确的解剖求解器；三节朝同一方向可能过直，需要结合近景检查。

**外展**应理解为拇指离开另外四指、形成空隙，不等于简单给世界 X 正负角度。先明确是向掌外、向镜头还是向角色外侧。左右手应镜像语义目标，不直接复用同一欧拉角。

## 5. PoPo/MPL 怎么实际用

```powershell
node scripts/authoring/popo-draft.mjs prepare .local/description.txt .local/popo-request
node scripts/authoring/popo-draft.mjs compile .local/response.mpl .local/popo-output
```

- `prepare` 从本地 PoPo 源码读提示词，生成 `request.json` 和来源信息，不发送请求。
- 需要云端生成时，只走明确配置的制作接口；不要私自读取 DSH 密钥。源码接口使用 `AI_MODEL`、`AI_API_KEY`、`AI_API_BASE_URL`，并非必须使用某个固定微调模型。
- 也可以由 DeepSeek 直接写 MPL；报告必须写“自主编写 MPL 并经编译器验证”，不能写“PoPo 模型生成”。
- `compile` 接受 MPL 文本或 `{"mpl":"..."}`，输出 `draft.vmd` 和 `pose-draft.json`。
- `pose-draft.json` 标记 `uncalibrated`，首帧是 MPL 自身参考，不是本模型待机；不得直接注册为正式动作。
- 当前入口只收上身直接骨和旋转。腿链、物理输出、位移会被拒绝。MPL 编译通过只证明语法/数据成立，不证明手型自然。

已跑通的小试验：`.local/popo-smoke/`；当前比心没有调用 PoPo 云端模型。

## 6. Blender：没有 MCP 也能用

本机程序：`D:/blender-4.2.6-windows-x64/blender.exe`，扩展：`bl_ext.user_default.mmd_tools`。

AI 编写 Python，通过命令行执行即可。编辑器不必显示，运行过程中不保存用户偏好：

```powershell
& 'D:/blender-4.2.6-windows-x64/blender.exe' --background --factory-startup --python .local/review.py -- <参数>
```

关键 API（已实际使用）：

```python
import bpy, addon_utils
addon_utils.enable('bl_ext.user_default.mmd_tools', default_set=False, persistent=False)
bpy.ops.mmd_tools.import_model(
    filepath=pmx, scale=1, types={'MESH', 'ARMATURE', 'MORPHS'},
    rename_bones=False, clean_model=False, remove_doubles=False,
    log_level='ERROR')
arm = next(o for o in bpy.context.scene.objects if o.type == 'ARMATURE')
bpy.ops.object.select_all(action='DESELECT')
arm.select_set(True)
bpy.context.view_layer.objects.active = arm
bpy.ops.mmd_tools.import_vmd(
    directory=vmd_directory, files=[{'name': vmd_filename}],
    margin=0, scale=1, update_scene_settings=False)
assert arm.animation_data and arm.animation_data.action
bpy.context.scene.frame_set(1)
bpy.context.view_layer.update()
```

**已踩过的坑：**这个版本的 VMD 操作符只传 `filepath` 会返回却没有导入动作；必须给 `directory + files`，并断言 Action 存在。不要拿未加载姿态的默认模型截图作为验收。

### 当前可直接复用的本地检查链

以下脚本在 `.local`，仅本机存在，换机器需另行提供。它们是针对当前动作的探针，不是已发布的通用工具。

```powershell
# 取约 2 秒的姿态快照，不改正式素材
node --input-type=module -e "import {writeFileSync} from 'node:fs';import {characterClips} from './dist/client/character/clips.js';writeFileSync('.local/heart-blender-pose.json',JSON.stringify(characterClips['hands-front'].frames[60]));"
python .local/export-heart-vmd.py
& 'D:/blender-4.2.6-windows-x64/blender.exe' --background --factory-startup --python .local/heart-blender-review.py -- $pmx .local/heart-review-new
```

产物：`front.png`、`top.png`、`oblique.png`、`bones.json`、`review.blend`。Workbench 灰色图能清晰看轮廓，不作为原材质效果验收。请实际打开图片，正面看两手空隙，顶面看前后错位，斜面看袖口和拇指是否遮挡。

VMD 快照导出需要注意坐标：这里的右手系四元数 `qx,qy,qz,qw` 写入 MMD VMD 时用 `-qx,-qy,qz,qw`；骨名 Shift-JIS。当前私有脚本只写一个静态姿态，无位移/完整时间曲线，**不能直接宣传为通用动画导出器**。

Blender 坐标与 three.js 不同，MMD Tools 还会处理骨轴；不要把 Blender `rotation_quaternion` 原样抄回运行时。若在 Blender 内修姿，需用 MMD Tools 导出 VMD，再走烘焙/坐标核验。尚未证明所有 IK、继承和物理的往返一致性。

## 7. 推荐的调姿顺序

1. 固定目标帧，暂时不改节奏。保留修改前正面/侧面图。
2. 先摆肩肘腕，保证双手高度、左右距离、前后距离；再控制手掌双轴。
3. 做食指轮廓，再配合其余三指，不要机械地全部用同角度。
4. 独立做拇指，检查它与食指之间的空隙、袖口遮挡和左右关系。
5. 看正面轮廓是否读得出“心”，而不是只证明每根骨都动了。避免手指交叉/重叠来假装指尖相接。
6. 视需要用小范围参数候选生成多张图进行比较；只保留选中的候选，不扩大用户授权范围。
7. 再查看入场、保持、退出和中途停止。静态姿态正确不等于过渡路径正确。

参考网页描述的常见双手心形，是食指端靠近形成上沿、拇指端靠近形成下端、手腕保持分开。它帮助理解留白轮廓，但**不覆盖用户要求的掌心朝下版本**。不要直接套别的手势，也不要擅自把物理打开来解决摆姿问题。

参考：[Heart Hands 手势说明](https://handsign.vanillate.id/gestures/heart-hands/)。本次查看了文字说明，未逐帧分析其动画。

## 8. 只生成指定片段，并验证

```powershell
pnpm build
if ($LASTEXITCODE -ne 0) { throw 'Build failed' }
node scripts/authoring/calibrate-contact.mjs $pmx hands-front
if ($LASTEXITCODE -ne 0) { throw 'Authoring failed' }
pnpm build
if ($LASTEXITCODE -ne 0) { throw 'Build failed' }
node --test scripts/testing/character.test.mjs

$env:LIVESEED_DSH_ROOT='D:\nodejs\npm-global\node_modules\@deepseek-ai\dsh'
node .local/heart-probe.mjs
```

制作脚本保留未选中的片段时，读取的是 `dist` 当前数据，所以制作前必须确认构建同步。生成文件用显式 `Record<string, CharacterClip>`，不要退回巨大的 `as const` 字面量类型——增加双手指骨后曾触发 TypeScript 声明序列化长度上限。

私有网页探针启动隔离 DSH/Edge，不修改用户现用 profile；截图只落 `.local/clip-probe-*`。早期版本检查双掌向下；最新 `.local/heart-follow-probe.mjs` 改为检查掌轴与小臂一致，截图正面/侧面/背面和归位。探针只覆盖有限帧，数值通过不等于形状被用户认可。常规 `pnpm test:browser` 必须继续使用空角色目录。

涉及运行时/骨架通道改动时运行 `pnpm check`；单纯本地参数迭代先构建、角色回归、真实截图。既有 tests 已覆盖首尾、连续性、恢复、不漂移等，不为每个新角度写一个只重复实现的测试。

## 9. 给用户的交付内容

- 哪些动作改了、哪些仍待办。
- 实际用了什么工具：PoPo 云端/自主 MPL/脚本调姿/Blender 审校分别说清楚。
- 看过哪些图，数值检查什么，有没有仍不理想的轮廓。
- 更新 docs/26，给出本地证据路径，不把真实模型图片提交。
- 让用户刷新 DSH 并点击“胸前收手”验收；不要提前宣称用户认可。

依赖：`AGENTS.md`、docs/18、21、23、25、26、27，以及上述源码。当前未提交改动较多，未经用户要求不要提交或推送。
