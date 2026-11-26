# Desktop：Agent 工作入口

本文件适用于 `apps/desktop/`；[根 AGENTS](../../AGENTS.md) 的跨仓、数据、授权、
插件兼容、协议与交付规则仍然适用。本文只维护模块触发条件，专题正文继续使用同一正本。
代码、共享判据与测试入口见[仓库地图](../../docs/dev-rules/repo-map.md#按用户行为定位)。

## 开发与进程边界

- 修改 Umeda 资料库、`main/vault-sync/`、KOS 宿主或其存储与生命周期前，先读
  [Umeda 客户端架构](../../docs/dev-rules/umeda-client-architecture.md)；区分托管目录同步、
  插件常驻资料服务与页面投影，不把页面重建等同于宿主服务重建。
- Agent 读写 Umeda 知识库沿 `main/vault-sync/knowledge.ts` 与共享 helper `knowledge` 类进入。
  当前仅操作本机托管镜像；更新必须带内容哈希，保留旧版并沿既有同步传播，不另造同步队列，
  不把 `local_saved` 当成云端或手机已收到。PDF／EPUB 页面派生索引尚未与此入口归并。
- Umeda 工作检查点沿 `main/work-records/` 与 helper `work` 类进入，保存应用级工作说明，
  不放进 KOS 或原生 Agent 配置目录。修订不可变，按 owner／任务／清空代次隔离；自述与
  宿主 Git 观察分开。换引擎复用 `sessionAgentSwitchHandler`，不得另建任务执行状态机。
- Umeda 业务目标／项目／任务沿 `main/work-management/host.ts` 与数据库命名事务
  `umedaWork.execute` 进入，各引擎共用 Profile DB。按主人提示读写，不在消息、项目打开或
  引擎切换时自动查询和注入背景；批量进度更新必须原子、校验版本并保留幂等回执。
  业务记录不随执行 Session 清空而删除，不自动迁入旧 KOS，不另建执行队列。
  桌面 `/work`（工作管理）的人工操作经窄 preload IPC 与 Agent 共用
  `main/work-management/service.ts`；人工来源标为 user，不能伪造执行 Session。
  变更通知只推 owner stamp 让页面重读，不携带业务正文或触发模型；账号切换与对象切换须丢弃迟到结果。
- 启动、调试或验证 Desktop 时，必须先读[Desktop 开发](../../docs/dev-rules/desktop-development.md)。
- 修改 Desktop Renderer、preload、BrowserWindow、WebView、IPC、CSP、导航或 Electron
  特权能力前，必须先读[Electron 安全与进程边界](../../docs/dev-rules/electron-security-and-process-boundaries.md)。
- 新增或修改 Desktop 独立窗口、辅助窗口或弹出型 `BrowserWindow` 前，必须遵守
  [Electron 安全与进程边界](../../docs/dev-rules/electron-security-and-process-boundaries.md)的「独立辅助窗口统一生命周期
  基线」：复用既有控制器／基础设施，不得另造平行的预热、就绪握手、隐藏复用与崩溃恢复
  状态机。
- 修改 Desktop 数据库 schema、migration、companion script 或运行期数据库访问前，必须
  先读[数据库与迁移](../../docs/dev-rules/database-and-migrations.md)。

## 界面与渠道

- 改完 Desktop renderer 界面（组件、样式、布局、文案、深浅色、多语言）后自检，先运行
  `pnpm ui:check --changed --theme all` 并查看输出的 `overview.png`，无需为此启动完整
  Desktop；输出中 `UNCOVERED` 的文件未被验证。发 PR 时运行 `pnpm ui:check:publish`，把输出的
  带图内容写进「UI 变化」。按改动类型选择验证方式见
  [Desktop 开发](../../docs/dev-rules/desktop-development.md)「按改动选择验证方式」。
- 修改个人 IM 渠道（`src/main/im/**`）或官方 hook（`src/main/hook-control/**`）的
  找/建任务、命令、排队与插话、输入拼装、事件观察、交互、收尾或停止逻辑前，必须先读
  [IM 轮次流程](../../docs/dev-rules/im-turn-flow.md)（入口账本、状态清单、不变量与迁移批次）。
