# Portable KOS workbench

2026-11-24：共享界面入口开始采用卡片库与白板。新增笔记、带来源的摘录、白板布局沿
既有 LibraryService 和 Vault 文件协议保存／同步；不迁移旧资料或工作管理数据。
0.5.0 补齐白板图片／PDF 页预览、分区整体移动、选卡片交给 AI 总结／比较／找矛盾，以及
AI 修改与已认可原文的对照和取舍。Desktop 接普通执行任务，手机先填入普通执行任务草稿。
产品决定、数据格式、审核范围和未完成项见[卡片与白板实现范围](../../docs/kos-cards-and-whiteboards.md)。
下文六区工作台说明属于保留的旧实现，不代表新默认首页。

KOS 的前端与基础能力，供 Umeda Desktop 插件和 iOS 内嵌页共用。对象解析与指标从
KOS Framework 迁移，出处与许可见 [UPSTREAM.md](UPSTREAM.md)。没有 Obsidian、DSH、
独立 Agent 执行器或系统提示词依赖；白板 AI 动作调用宿主公开的普通执行任务能力。

长期方向是 React 富交互界面与独立客户端资料服务协作，继续使用社区组件，不预设全量
Swift 重写。0.2.0 源码已将缓存／队列迁到宿主 `LibraryService`，界面通过 `LibraryClient`
发送领域命令、接收状态投影。0.3.0 追加内容文件、结构化目录／outbox 与本机全文索引；
0.4.0 增加持久移动、书籍派生全文和本机空间统计。
规则见[模块入口](AGENTS.md)、[客户端架构](../../docs/dev-rules/umeda-client-architecture.md)，
差距与验收见[优化路线图](../../docs/umeda-optimization-roadmap.md)。

## 目标分工（2026-11-22，待迁移）

Umeda 是应用和总入口，本包是组合进 Umeda 的现有内容界面。按主人纠正后的定位，KOS
是供接入的 Agent 读取和写入的知识库，存放材料、笔记、研究产物、知识／方法与证据；
不再指一个基于 DSH 的独立知识 Agent 产品。理解、研究、整理与生成由 Agent 完成，
Umeda 提供存取、索引、展示、同步与运行能力。本包 0.4.0 仍含旧解析器与六区工作台，
迁移前保留兼容，不将目标定位描述为已完成的实现。

新增通用工作管理规则进入应用级领域服务，桌面、手机、伙伴和各引擎共用；KOS 页面可
作为视图消费，不能继续独占项目／行动状态。旧 `type: task` 是业务行动，不等于 Cindy
执行任务 Session。迁移需保留文档、未知属性和关系，建立稳定 ID 与唯一写入归属，不
直接删除旧对象或并行维护两套状态。详细边界见[客户端架构](../../docs/dev-rules/umeda-client-architecture.md)。

## 能力与数据

- 今日、行动、输入、知识、审阅与复盘、系统六个区块，以及日程、半年目标、时间进度、活动记录。
- 桌面卡片拖动、缩放、撤销／重做；手机卡片上移／下移。两种布局分别保存在本机。
- 文档目录与索引搜索、分页、快速记录、新建对象、正文与属性编辑、任务完成／安排日期。
  修改 YAML 时保留未知字段、注释、关联及正文；原有文档格式有误时不覆盖原文。
- Markdown、PDF、EPUB 阅读，目录、搜索、划线、批注、摘录、阅读位置和图片附件。
- 草稿先持久化在本机；点击保存后写入本机待同步队列，收到可校验的云端回执后才出队。
  普通文档冲突保留 `.sync-conflict-…` 副本，不静默覆盖。
- 阅读记录写入 `90_系统/umeda/reading/<path-sha256>.json`，按批注 ID、更新时间和删除标记合并，
  通过既有 Vault 同步回到 Mac。已打开的文档、附件和索引可离线使用；首次下载需要网络。

Desktop 使用现有插件 Library SQLite（由宿主 worker 执行），插件声明 `library: true` 与
`launch: resident`；iOS 使用 Expo SQLite 与应用根部的生命周期适配。关掉页面不停止仍有
运行条件的宿主服务，iOS 挂起后依靠持久队列在前台恢复。`store.ts` 只是兼容导出；
领域逻辑在 `src/library/`，不依赖 React／DOM／Electron／Expo。旧 IndexedDB／AsyncStorage
按原 key 懒复制，不删除旧记录；SQLite NULL 墓碑防止清除过的草稿再次被旧数据恢复。
目录和队列通过同一事务提交，写入失败不提前发布保存成功或清队。
0.3.0 的 schema 2 按文档和操作存行，正文／附件块／已保存编辑的文本放不可变内容文件，
文件先验证再事务提交引用；原 KV 表和旧来源保留。0.4.0 追加 schema 3 的移动操作、内容
字节登记与书籍分段定位；派生正文仍在不可变文件中，定位只追加新段，视图只接收进度摘要。
偏好、编辑中草稿和离线清单仍用 KV。
附件跨桥仍是 256 KiB Base64，不等于已完成原生文件句柄与整文件流式服务。
手机从 Cloudflare 直接读取云端副本，查看已同步资料无需 Mac 在线。

支持 `vault-library-v1` 时，文档使用稳定 ID，移动后保留路径别名，阅读记录／草稿从旧路径
兼容恢复；目录筛选中可查看回收站，阅读器可查看历史原文并条件恢复。恢复创建新版本，
不删旧历史；并发更新或有待同步修改时拒绝覆盖。历史索引按 128 项分批补齐，不全库扫描返回。
同路径重建与外部文件移动的身份歧义不能靠内容哈希猜测。2026-11-22 的源码已提供共同
helper `knowledge` 工具：三个引擎可离线搜索、读取和条件写入 Mac 托管镜像，沿原同步链路
传播，不依赖本页开启。该入口尚未归并页面的书籍派生索引，也不提供移动后的稳定引用解析；
范围与待办见[客户端架构](../../docs/dev-rules/umeda-client-architecture.md#agent-知识资源入口2026-11-22源码)。

## 构建与验证

```sh
pnpm --filter @cindy/kos-workbench typecheck
pnpm --filter @cindy/kos-workbench test
pnpm --filter @cindy/kos-workbench build
node packages/kos-workbench/prepare-plugin.mjs --relay-url=https://YOUR-RELAY.example
```

`build` 生成忽略的 `dist/` 及提交入库的 `generated/mobile.ts`。后者是 iOS 内嵌 HTML，
只含程序与开源许可，不含用户内容或端点。修改前端后必须重新 build，再构建 iOS。
`prepare-plugin` 调用本仓真实 Forge `packGhostDir` 校验器，产出 `.cindy`；不安装、不发布。
插件宿主能力按当前仓库公开契约验证，未修改插件基座。0.5.0 已通过 Forge MCP 校验打包；
未安装，运行中客户端的版本／源码对应关系尚未确认。实际安装仍走 Desktop 既有文件
安装与权限确认；示例端点校验包不能代替配置了实际资料服务的正式包。
Desktop CSP 禁止内联启动脚本，宿主模式由随包 `main.tsx` 识别协议初始化；不能靠 HTML
内联设置启动变量。预览也禁止内联脚本，实际 Mac 插件另做宿主验收。
插件网络配置只进入本机生成的 `dist/`，不能提交个人端点或主机配置。
为同一后端换域名时，打包可显式传 `--previous-relay-url=https://PREVIOUS-RELAY.example`，
保留原 IndexedDB／SQLite 的作用域和草稿；实际网络仍只请求 `--relay-url`。
此参数只适用于已核验为同一后端的地址，不能合并不同资料库的数据。

界面端到端检查使用隔离 Electron 配置、合成资料与实际 CloudVault，绝不向个人云端写测试文件：

```sh
PORT=55482 pnpm --filter @cindy/kos-workbench exec tsx scripts/preview.ts
# 在另一个终端运行；输出截图位于系统临时目录，也可设置 KOS_QA_OUTPUT。
node packages/kos-workbench/scripts/browser-smoke.mjs
node packages/kos-workbench/scripts/whiteboard-smoke.mjs
node packages/kos-workbench/scripts/library-storage-smoke.mjs
```

浏览器预览走真实 `LibraryClient → dispatchLibrary → LibraryService → CloudVault`，只用合成资料。
检查覆盖离线编辑重开与重连、PDF 批注、EPUB 排版与字号、图片附件、双主题和窄屏溢出。
SQLite smoke 用生产手机适配器的 SQL 和真实 Node SQLite 验证旧记录复制、事务失败、
路由代次失效回滚、NULL 墓碑与重开；不代替 Expo 原生驱动的真机验收。
单元测试通过真实 `WorkbenchStore → CloudVault` 生产入口覆盖持久队列、冲突与阅读记录合并；
测试文件本机单跑约 2.7 秒。手机实机验收须另外执行，浏览器窄屏不代表 iPhone 已验证。

## 协议与范围

需要个人 Worker 的 `vault-files-v1` 和增量 `vault-index-v1`。旧索引分页最多 40 项，支持
`vault-index-batch-v1` 时按下节字节预算批量读取；索引只含
原始 frontmatter 与正文开头摘要；属性解析和业务规则留在客户端共享模块。正文按需下载，附件通过
256 KiB Base64 分段传输，最终校验完整 SHA-256。索引补全不改变原文件版本或哈希。
超过索引属性范围的文档会列入系统检查，仍可打开原文，不把它当成完整解析结果。

当前编辑器、全文检索与文本离线下载上限 240 KiB；附件沿用 Vault 的 32 MiB 限制，图片预览限 8 MiB。
资料库可主动批量下载文本、逐项保留离线、取消保留并续作；取消不删除缓存，也不会自动下载所有附件。
搜索已下载完整文本及本机待同步编辑，显示覆盖范围和片段；较长查询走 FTS5 trigram，
1–2 字子串查询保留扫描路径。PDF／EPUB 可逐本建立全文索引，页／章节定位随片段返回；
只搜索当前哈希已完成的索引。富内容进程按需提取，宿主持久保存；关闭页面／主动停止保留
已提交部分，重新进入可继续，未完成不计完整覆盖。原书、提取文字各限 32 MiB、最多 5000 段；
单段最多 128 KiB。扫描版 PDF 无 OCR，图片中的文字不可检索。索引只在本机，不上传到云端。
移动／重命名先持久落盘；联网先保存编辑再执行条件移动，冲突明确显示，不覆盖已有目标。
已发出移动但回执不确定时暂拒新保存，编辑草稿不丢；撤销请求不保证撤销已执行的云端移动。
空间页只报告本版已登记的内容对象并按哈希去重，不自动清理；旧数据库、原目录、未登记或
失败遗留的物理文件不在此统计中，不将其当作系统总占用。
界面已有中文与英文，其他语言暂回退英文。
自主规划、自动整库提炼、模型结果质量优化，以及旧 Obsidian 插件专属功能不在本阶段。
白板 AI 动作只提交主人明确选中的文本来源，不自动遍历整库；真实模型与插件安装权限流程
尚需运行环境验收，合成端到端检查不能替代它们。

## 同步提速（0.1.1）

索引读取使用 512 KiB 字节预算，旧 Worker 自动沿用原分页。无变化时保持同一目录快照，
不重写目录缓存；保存回执的正文与元数据持久化后再清除待同步项，断在回执和目录重读之间也可离线恢复。
通知在刷新途中到达时合并为一次后续检查，不丢弃已经保存的新编辑。

0.1.1 的桌面页面曾用 20 秒长轮询；0.2.0 的资料服务由宿主运行，每 30 秒对账、失败退避至
5 分钟，并合并变更提示。Mac 文件监听继续独立运行；iOS 的既有 Device Link 提示直接唤醒
资料服务，恢复前台也会对账。页面不再另起重复轮询；旧非宿主页面保留原兼容实现。
Mac 本地文件监听独立于工作台页面，监听事件只唤醒原有哈希校验与条件写入流程。

PDF／EPUB 及其 worker 随包保留，但在首次打开对应内容时才执行；桌面从本机 `reader.js`
加载，手机从内嵌惰性资源加载，不依赖 CDN。初始执行脚本体积与实际首屏耗时分别验证。
