# 02 · MaiBot 核心模块观察（只读侦察）

> 一句话：**MaiBot 把我们前面讨论的「调度器 / 交接文件 / 记忆生命周期」都实现了，只是名字不同**——它的价值不在「拿来用」，在「确认这些设计确实必要，并给出可对齐的词汇表」。
> 观察对象：`E:\otherWork\MaiBot`（main @ `c642954`，v1.3.19，`--depth 1` 浅克隆，2026-10-31）
> 观察方法：**只读**——目录结构、LOC 统计、`AGENTS.md`、若干文件头与类签名；未逐行通读 `runtime.py`（2117 行）等大文件。
> 标记：**✅ 已核实**（读到代码/文档）｜**⚑ 推断**（合理但未验证）

---

## 0 代码量分布（先看重心）

| 模块 | 文件 | 行数 | 说明 |
|---|---|---|---|
| `src/A_memorix` | 139 | **66,348** | 长期记忆与认知增强子系统（上游子树） |
| `src/webui` | 77 | 28,728 | WebUI 后端 |
| `src/plugin_runtime` | 64 | 20,066 | 插件运行时（host/runner/transport/protocol） |
| `src/common` | 128 | 19,667 | 公共库 |
| `src/maisaka` | 77 | 18,659 | **agent 循环 + 调度 + 上下文** |
| `src/chat` | 27 | 12,621 | 聊天流（接收/防抖/心跳/回复） |
| `src/llm_models` | 24 | 10,219 | 模型客户端（openai_compat） |
| `src/services` | 26 | 9,581 | 记忆服务、嵌入、人物事实核验等 |
| `src/config` | 13 | 8,833 | 配置 |
| `src/platform_io` | 14 | 2,733 | 平台驱动/路由 |
| `src/learners` | 9 | 2,677 | 表达/黑话学习 |
| `src/agent` | 12 | 1,423 | planner/provider/history/messaging/acp |

**结论：三分之一代码在记忆上。** 这和 AstrBot（最大块是 IM 平台适配 27.3k）形成鲜明对比：一个是「养角色」的框架，一个是「接平台」的框架。

---

## 1 总体骨架：一个「会话级运行时对象」

启动链：`bot.py` → `src.runtime` → `src.main`。✅

`src/maisaka/runtime.py` 定义 `MaisakaHeartFlowChatting`：**每个 ChatSession 一个实例**，显式状态机：

```python
_STATE_RUNNING / _STATE_WAIT / _STATE_STOP   # running / wait / stop
```

它把下面这些装配在一起（✅ 见 `runtime.py` 的 import 与构造）：

- `MaisakaChatLoopService`（发请求）、`MaisakaReasoningEngine`（跑工具）
- `MessageTurnScheduler` + `IdleBackoffController`（何时说话）
- `focus_mode_manager`（群焦点）
- **9 类工具 provider**：内置 / Agent / Computer / File / 桌面宠 / Todo / MCP / WebSearch / 插件
- 消息历史 + monitor 事件 + display mixin

关键常量（✅ `runtime.py` L88–94）：

| 常量 | 值 | 含义 |
|---|---|---|
| `MAX_INTERNAL_ROUNDS` | 16 | 一次外部触发最多 16 轮内部循环 |
| `CONTEXT_RESTORE_FILL_RATIO` | 0.5 | 恢复上下文时填充一半预算 |
| `CONTEXT_RESTORE_SHORT_RESTART_SECONDS` | 5 min | 短暂重启 |
| `CONTEXT_RESTORE_SHORT_OFFLINE_SECONDS` | 30 min | 短离线 |
| `CONTEXT_RESTORE_LONG_SLEEP_SECONDS` | 6 h | 长睡 |
| `CONTEXT_RESTORE_DAY_SECONDS` | 24 h | 隔天 |

→ **离开多久，决定恢复多少上下文**。这几乎就是「人醒来时记忆恢复」的工程化。

---

## 2 调度层 `turn_trigger`：何时进入内部循环（最值得抄）

`MessageTurnScheduler._evaluate()` 是一条**固定顺序的门控链**，每个门控只返回 `trigger / wait / delay` + 人类可读理由（✅ `turn_trigger/scheduler.py`）：

```
① 消息防抖收齐本批（不足则 delay）
② wait 状态快速续接（快速反应模式）
③ 静默消费（回复频率低时只读不回）
④ @ 强制触发（占用动态门控额度）
⑤ 空闲退避 idle_backoff（越久/积压越多 → 延迟越长）
⑥ 动态门控 DynamicReplyTurnGate（估计回复概率 + 频率）
   → 统一由 schedule_message_turn() 投递或延迟重查
```

实现要点（✅ `turn_trigger/gates.py`）：

- `estimate_reply_probability(...)`：估计「这条该不该回」；
- **虚拟轮次** `_round_message_ids`：只按本轮次内到达的消息估计，避免积压旧消息重复计数；
- `record_reply()` / `record_forced_turn()`：实际回复次数与 @ 强制触发都计入频率控制；
- 注释交代了边界：*「拟合数据只覆盖群聊；私聊里每条消息都是对麦麦说的，不设门控」*。

三个内建工具就是动作原语：`stop`（不发言）/ `wait`（稍后再判）/ `reply`（发言）。

> **洞察**：这是「说话时机调度器」，与 OS 调度器同构，但它是**独立、可解释、可调参、可测**的门控链——**不把「要不要说话」交给 LLM 决定**。

---

## 3 循环层：请求、工具、打断

- `chat_loop_service.py`（1615 行，✅）：一步请求 = 组装 `ContextItem` + 工具定义 → `LLMServiceClient` → 返回 `ChatResponse`。**`ChatResponse` 自带 `prompt_tokens / completion_tokens / total_tokens / selected_history_count / tool_count / duration_ms`**——token 计量贯穿全链路。
- `reasoning_engine.py`（2194 行，✅ 头部）：工具执行循环、工具结果压缩（`condense_tool_result`）、回复补充（`reply_supplement`）、上下文摘要注入、黑话引用、图像记忆注入。
- `PlannerInterruptController`（✅ `runtime.py` L97–127）：planner 请求可被新消息**打断**（同一次请求只打断一次）。
- `mode_policy.py`：连续 `wait` 的提醒策略（`build_consecutive_wait_reminders`）。
- 请求类型分派（✅ `chat_loop_service.py` L79–93）：`planner / sub_agent / expression_selector / emotion`，其中 `expression_selector` 用 `fast_model`（快模型）——**已经存在「小模型做快判断」的分层**。

---

## 4 上下文层：类型化消息 + 结构化滚动状态（≈ 交接文件）

`maisaka/context/messages.py`（34 KB）把上下文消息**分类型**，而不是裸 dict（✅）：

`SessionBackedMessage`（真实消息）/ `ToolResultMessage` / `ToolResultMediaMessage` / `ReferenceMessage` / `InternalContextMessage` / `ModelOutputContextMessage` / `ContentContextMessage` / `ContextSummaryMessage`

`context/compaction.py` 的 `ConversationState` 就是我们说的「交接文件」（✅ 全文）：

```python
class ConversationState(BaseModel):
    model_config = ConfigDict(extra="forbid")   # 字段缺失或格式错误 → 拒绝提交压缩
    topics:     List[str]   # 当前话题
    background: List[str]   # 关键背景
    progress:   List[str]   # 进展与结论
    pending:    List[str]   # 未完事项      ← 即我们说的 open-loop
    agreements: List[str]   # 对话约定
```

配套细节（✅）：

| 机制 | 位置 | 说明 |
|---|---|---|
| 常驻内部参考 | `ContextSummaryMessage(display_prefix="【上下文状态摘要-内部参考】")` | **不伪装成用户消息、不占近期消息条数** |
| 保底原文 | `context/post_processor.py` `MIN_RETAINED_CHAT_MESSAGES` | 近期原文不压 |
| 分节 token 计量 | `context/usage.py` `measure_request_sections()` / `ContextSectionUsage` | **上下文预算是分节算的** |
| 清空标记 | `context/clear_context.py` `select_messages_after_latest_clear_marker` | `/clear` 之后的消息才进上下文 |

> **洞察**：这比我们设想的「整段摘要」先进——它是**结构化字段 + 严格校验 + 滚动更新**，而且 `pending` 字段天然承载 open-loop。

---

## 5 记忆层 `A_memorix`：独立上游项目，被子树同步进来

- ✅ `src/A_memorix/MODIFICATION_POLICY.md`：本目录是上游 `https://github.com/A-Dawn/A_memorix.git`（`MaiBot_branch`）的**同步子树**；`core/`、`scripts/`、`plugin.py` 等**必须先改上游**，MaiBot 仓库只维护接入层（`src/services/memory_service.py`、`src/webui/routers/memory.py`、`config/a_memorix.toml`、`data/a-memorix/`、`pytests/A_memorix_test/`）。
- ✅ `src/A_memorix/README.md`（v2.0.0）：定位「长期记忆与认知增强子系统」；统一入口 = 宿主侧 `host_service.py` + `core/runtime/sdk_memory_kernel.py`；元数据 schema `v26`。

### 能力 ↔ 我们之前的设想

| A_memorix 能力（✅ README） | 我们之前的设想 |
|---|---|
| **双路检索：向量 + 图谱关系联合召回**（模式 `search/time/hybrid/episode/aggregate`） | 我们只想到「向量 + 关键词」，**漏了知识图谱** |
| 写入幂等（`external_id`）+ 段落/关系联合写入 + Episode pending 队列 | 「准入控制 / 写入去重」 |
| **人物画像**：自动快照 + 手动 override | 「关系地基」 |
| `maintain_memory(action=reinforce/protect/restore/freeze/recycle_bin)` | **「分级 / 提升 / 降级 / 归档」** |
| `memory_v5_admin`: `restore/reinforce/weaken/remember_forever/forget` | **「衰减 + 永久记住 + 遗忘」** |
| 可分享**记忆包**格式（`docs/memory_bundle_format.md`） | 「交接文件导出」 |
| 调优 profile（`memory_tuning_admin`） | 「调度参数化」 |
| 导入/迁移（`memory_import_admin`，含 LPMM openie、temporal backfill、maibot migration） | 未考虑 |

### 生命周期动作 = MLFQ 的词汇表

`reinforce`（强化）/ `protect`（保护·限时）/ `freeze`（冻结）/ `restore`（恢复）/ `weaken`（衰减）/ `remember_forever`（永久）/ `forget`（遗忘）/ `recycle_bin`（回收站）

→ **你说的「多级队列」，在这个生态里已有一份带测试的显式实现**（`pytests/A_memorix_test/test_memory_lifecycle_policy.py`、`test_person_memory_writeback.py`、`test_selected_memory_correction.py`、`test_memory_graph_search_kernel.py`）。

**⚠️ 许可证**：`src/A_memorix/` 含 `LICENSE` + `LICENSE-MAIBOT-GPL.md`，上游为 GPL 系；MaiBot 主体 GPL-3.0。**传染性 copyleft**——本地自用无碍，嵌入我们 MIT 仓库则不行。

---

## 6 人格层：它怎么「学像一个人」

| 模块 | 作用 | 对应我们的问题 |
|---|---|---|
| `src/person_info`（501 行）+ `services/person_fact_verifier.py` + `person_fact_reverification.py` | **人物事实核验**：把你说的与「已核实事实」分开 | **记忆可信度 / 防投毒**，已有实现 |
| `maisaka/memory/person_profile.py`（9.9 KB） | 人物画像 | 「关系地基」 |
| `maisaka/memory/heuristic_injector.py`（16.5 KB） | **启发式注入**（非纯检索） | 与我们「纯语义检索不可靠」的结论一致 |
| `maisaka/memory/image_injector.py` | 图像记忆注入 | — |
| `learners/{expression_learner, jargon_learner, jargon_miner}` | 从对话里学**表达方式 / 黑话** | **「腔调」可以靠学习 + 注入，而不是微调** |

> **洞察**：MaiBot 的人格不靠 LoRA，靠「学习器采集 + 启发式注入 + 事实核验」。这给「德谬歌的腔调」提供了第二条路。

---

## 7 支撑模块（评测与调试价值高）

| 模块 | 作用 | 为什么重要 |
|---|---|---|
| `monitor/`（`events.py` 28 KB + `event_store.py` 14 KB） | 事件流：`emit_message_ingested/sent/updated`、`emit_flow_step`、`emit_planner_snapshot` | 全链路可回放 → 评测时能复盘「她为什么这么说」 |
| `display/`（`prompt_cli_renderer.py` 43 KB + `runtime_mixin.py` 31 KB） | 把发给模型的完整 prompt 渲染出来 | **审计「我们到底喂了什么」**，比看输出更有用 |
| `plugin_runtime/`（20 KB） | hook 体系（`HookSpec`/`HookSpecRegistry`/`hook_payloads`）、工具提供、配置组件 | 将来做插件时的参照 |
| `focus/`（`group_runtime.py` 44 KB + `context.py` 13 KB） | 群聊焦点运行时 | 单人场景用不上 |
| `attention_drift.py` | 注意力漂移 | 「走神」的真实感 |
| `computer/` `mcp_module/` `web_search/` | 工具类能力 | 我们不需要

---

## 8 对我们方案的三处修正

### 修正一：调度要拆成两套，不是一个 MLFQ
MaiBot 分得很清楚：
- **说话时机** → `turn_trigger` 门控链（每轮决定进不进入循环）
- **记忆生命周期** → `A_memorix` 的 `maintain_memory` / `v5_admin` 动作

我们之前把两者混成一个 MLFQ，是概念上的偷懒。**正确做法：两个调度器，各自可调参、各自可测。**

### 修正二：交接文件直接借 schema
`ConversationState(topics / background / progress / pending / agreements)` + `extra="forbid"` 严格校验 + 作为「常驻内部参考、不占近期消息条数」——这比我们自己发明可靠。`pending` 承载 open-loop。

### 修正三：「先自写记忆包」要重新评估——三条路
| 路线 | 内容 | 代价 | 我的倾向 |
|---|---|---|---|
| (a) **复用 A_memorix 当后端** | 独立 SDK：`host_service.py` + `sdk_memory_kernel.py`，有 QUICK_START/CONFIG_REFERENCE | **GPL 传染** + 体量重（66k 行、schema v26、导入/调优/运维全套） | ⚑ 待验证独立运行性 |
| (b) **只借设计自写轻量版** | ConversationState 格式 + 生命周期动作词汇 + 门控链 | 自己写代码，但可控、MIT、几十 KB | **当前倾向** |
| (c) **直接用 MaiBot 写人格/配置** | 少写代码 | GPL + 被体量与定位绑住 | 不倾向 |

判据：**(a) 是否成立，取决于「A_memorix 能否脱离主程序独立跑」**——只读 `QUICK_START.md` + `CONFIG_REFERENCE.md` 就能判断。

---

## 9 待核实清单（下一步只读即可）

| # | 问题 | 看哪里 |
|---|---|---|
| 1 | A_memorix 能否独立部署运行？依赖什么宿主接口？ | `A_memorix/QUICK_START.md`、`CONFIG_REFERENCE.md`、`host_service.py` |
| 2 | `estimate_reply_probability` 的概率模型是什么（规则？小模型？拟合参数？） | `turn_trigger/reply_likelihood.py`（3.6 KB） |
| 3 | 启发式注入的打分规则是什么 | `memory/heuristic_injector.py`（16.5 KB） |
| 4 | 时间衰减恢复（5min/30min/6h/24h）具体怎么改上下文 | `runtime.py` 的 context restore 段落 |
| 5 | 事实核验的「可信度」怎么建模 | `services/person_fact_verifier.py` |
| 6 | GPL 边界：以「独立进程 + HTTP」调用是否足以隔离 | 许可证文本 + `LICENSE-MAIBOT-GPL.md` |

---

## 10 证据索引

| 文件 | 内容 |
|---|---|
| `bot.py` / `src/runtime.py` / `src/main.py` | 启动链 |
| `src/maisaka/runtime.py` L88–94, L97–127, L130–150 | 常量、打断控制器、会话运行时 |
| `src/maisaka/turn_trigger/{scheduler,gates,idle_backoff,reply_likelihood}.py` | 门控链与概率估计 |
| `src/maisaka/{chat_loop_service,reasoning_engine}.py` | 请求/工具循环、token 计量 |
| `src/maisaka/context/{messages,compaction,usage,post_processor,clear_context}.py` | 类型化上下文、滚动状态、预算 |
| `src/A_memorix/{README,MODIFICATION_POLICY}.md`、`core/runtime/sdk_memory_kernel.py` | 记忆子系统契约与入口 |
| `src/A_memorix/pytests` 对应测试 | 生命周期/写回/纠正/图检索的既有测试 |
| `src/services/{person_fact_verifier,memory_service}.py` | 事实核验与接入层 |
| `src/learners/*` | 表达/黑话学习 |

---

## 附：与 AstrBot 的定位差异（详见 `01-想法记录` §7）

| | AstrBot | MaiBot |
|---|---|---|
| 最大代码块 | IM 平台适配 27.3k | **记忆 66.3k** |
| 控制流 | 9 段固定管道 | **循环 + 触发器（调度链）** |
| 交接文件 | 上下文压缩（摘要） | **ConversationState 结构化状态** |
| 记忆 | 会话历史 + 知识库 | **独立记忆内核（向量+图谱+生命周期）** |
| 许可证 | AGPL-3.0 | GPL-3.0 |
