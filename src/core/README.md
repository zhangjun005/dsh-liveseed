# 产品核心

`protocol.ts` 定义面板协议；`memory/` 实现有来源的记忆记录、版本化状态折叠与召回，依赖的设计文档和实施范围见 [memory/README.md](memory/README.md)。不建立独立数值情绪模块。

该目录不得导入 Cordis / DSH 类型，也不得直接读取宿主的 Session 文件；原生记录、模型调用、能力和生命周期经过 `src/adapters/harness/`。
