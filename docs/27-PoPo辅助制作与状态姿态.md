# PoPo 辅助制作与状态姿态

2026-11-08。用户同意引入 PoPo 辅助制作，询问 VMD 与状态机关系，并告知本机已有 Blender。相关依据：docs/21、25、26；本条不授权修改已验收动作或提前处理已暂缓的节奏问题。

## 姿态、动作与状态机

- **目标姿态**：背手、胸前手、双手托腮等可保持的目标，包含骨骼控制集、参考姿态和局部旋转；无需自带固定停留秒数。
- **短动作**：挥手、点头、整理头发中的往复过程，仍需要时间曲线或动作片段。
- **状态机**：决定进入/保持/退出哪个姿态，何时播放短动作、如何处理中断和通道让位。状态机不会自动提供好看的轨迹，也不取代动作素材。
- **VMD**：离线交换格式，可保存单个姿态的关键帧，也能保存完整运动过程；不是必须接入运行时的播放器。目标姿态可以从 VMD 提取，不强制所有状态都播放固定长度动画。

现有手动预览仍按片段播放；本轮未实现或接入状态机，也没有将所有片段自动转换为姿态状态。

## PoPo 接入范围与实际源码

源码下载在被忽略的 `.local/tools/PoPo`，核对 commit `1df3a460148647b9ad1b19a1803b1612d49998a4`。`src/app/api/pose-generate/route.ts` 接收描述、组合提示词，通过配置的 OpenAI 兼容接口生成 MPL。实际接口接受 `AI_MODEL` / `AI_API_KEY` / `AI_API_BASE_URL`，不是必须使用某个内置模型或启动整个网站。

MPL 编译器沿用 `.local/tools/MMD-MPL/cmd/mpl.exe`，源码 commit `2d3b1c7e3429b508443500801e94c41fd47c9f31`。两个上游仓库标示 GPL-3.0，保持为本地制作工具，不作为产品运行时依赖。本项目桥接脚本不复制上游提示词正文；只在制作时从本地检出读取，生成请求和产物均放 `.local`。

新增 `scripts/authoring/popo-draft.mjs`：

```powershell
node scripts/authoring/popo-draft.mjs prepare .local/description.txt .local/draft-request
node scripts/authoring/popo-draft.mjs compile .local/response.mpl .local/draft-output
# compile 也接受 PoPo 接口返回的 {"mpl":"..."} JSON 文件。
```

`prepare` 生成消息请求及提示词来源记录，不发送网络请求。由已明确配置的制作模型返回 MPL，或由当前编码助手直接编写 MPL；不能把后者声称为 PoPo 云端模型生成。未读取 DSH 的密钥，未增加产品生成接口。

`compile` 调用原始 MPL 编译器，产出 VMD，并提取各骨最后关键帧为 `pose-draft.json`。这只是 `uncalibrated` 草稿，首帧参考不等于小昔涟待机，也不直接套用当前运行时的首帧差分。只允许当前上身制作范围的直接输入骨与有限旋转，不接收腿链、物理/付与输出或位移。接触、掌向、左右手镜像仍须按本模型校准并验收，不能根据 MPL 语义名字推定视觉正确。

试验位置 `.local/popo-smoke`：准备请求及自主编写的歪头 MPL → 原编译器 → VMD → 2 骨目标姿态提取已通过。该试验未请求云端模型，未加载正式动作到运行时，未覆盖已验收素材。

## Blender 本机核验

- 可执行文件：`D:/blender-4.2.6-windows-x64/blender.exe`，实测版本 `4.2.6 LTS`。
- 已安装扩展 `bl_ext.user_default.mmd_tools`；在 `--background --factory-startup` 的临时进程中启用成功，PMX 导入和 VMD 导出操作符可用，未保存用户偏好。
- 不依赖 MCP：可通过 Blender 自带 Python 离线载入、摆姿、保存姿态、渲染与导出。MCP 只是可选的交互控制方式。本轮没有导入官方模型到 Blender，没有检验 Blender 到当前网页渲染器的动作往返一致性。
- Blender 仅为制作工具；不会成为 DSH 插件运行时子进程。官方模型和含模型的工程/截图继续只留本地。

Reze 暂不作为必需环节。它的角色是人工/自动辅助的可视化骨骼与曲线编辑器，不负责产品状态机；未来确有审校需要时再接。

## 后续接线

先通过这条入口积累可校准的目标姿态，复用已有掌型/双手位置；之后按 docs/25 实现持续姿态及过渡、局部短动作和调度。PoPo 起稿、模型校准、运行时编排分别验收，不能因编译成功就将生成姿态加入正式动作集合。
