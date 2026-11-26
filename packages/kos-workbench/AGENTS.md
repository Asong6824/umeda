# KOS 工作台：Agent 工作入口

本文件适用于 `packages/kos-workbench/`；[根规则](../../AGENTS.md)仍然适用。
本包是 Umeda 的共享 React 富内容界面及当前基础逻辑，不是 Obsidian 插件或 Agent harness。

- 修改前读[包说明](README.md)、[产品方向](../../docs/product-rules/umeda-product-direction.md)
  和[客户端架构](../../docs/dev-rules/umeda-client-architecture.md)。
- 对照[优化路线图](../../docs/umeda-optimization-roadmap.md)区分现状与目标。草稿／队列与
  缓存由 `src/library/service.ts` 持有；UI 使用 `LibraryClient`，`store.ts` 保留兼容导出。
  新增功能不再扩散第二套持久化或同步状态机。
- 领域规则与宿主适配不依赖 React 组件；社区组件经适配消费领域命令，不能接管唯一持久数据。
  新组件需验证 Markdown／元数据往返、手机输入与选区、双主题、离线和资源负担。
- Desktop 插件与 iOS 内嵌页共享本包，改桥、网络或保存流程必须核对两端调用者和已有队列。
  页面 dispose、重建、迟到回复和恢复分别验证，不能以窄屏浏览器代替手机实机。
- 构建与验证命令按 README；修改源程序后重新生成 `generated/mobile.ts`，不手改生成文件。
  个人端点与内容不得进入源文件或生成的内嵌 HTML。迁移、协议、原生冷更与插件基座继续
  遵循专项规则，本文不授权修改这些边界或操作生产资料。

- PDF／EPUB 派生文字的生命周期与源资料分开：解析按需在富内容进程执行，已接受的分段、
  定位与完成态由宿主持久保存；部分提取不冒充完整搜索覆盖。不要为新格式把重解析器静态
  导入宿主或首屏。移动队列与已保存编辑必须由同一服务仲裁，未知回执不能当作未执行。

- 2026-11-22 主人纠正后的定位：Umeda 是应用和组合宿主；KOS 是供接入 Agent 读写的
  知识库资源，不再是一套基于 DSH 的独立知识 Agent／业务系统。理解、研究、整理和生成
  由 Agent 完成，Umeda 提供存取、索引、展示、同步与执行设施。旧 Goal／Project／Task
  的业务管理归入 Umeda。现有解析器／看板是迁移前兼容实现，不直接删除；新增通用业务状态与规则不
  留在 KOS 页面或私有工作流内。业务行动不等于 Cindy Session，迁移须先设计身份、关系、
  唯一写入归属与恢复，保留正文、未知字段和证据。详见产品方向与客户端架构的新分层章节。
