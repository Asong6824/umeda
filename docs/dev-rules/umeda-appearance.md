# Umeda 外观配置：通过配置逐步尝试

个人 Umeda 的最终风格尚未确定，按主人的要求逐步尝试。不新增前端方案选择器或方案偏好
存储；资料、Agent、账号、包 ID、凭证和协议继续使用各自的原有入口。
后续事项见[路线图](../umeda-optimization-roadmap.md#代码驱动的外观方案2026-11-23首批实施)。

## 唯一配置入口与生成

修改 `packages/design-tokens/src/umeda-appearance.json`：

- `$extensions["com.umeda.appearance"].active` 选择当前方案，当前为 `editorial`；改回
  `original` 即恢复原有 Cindy 默认，改成 `minimal` 可采用已接入的简洁形象及其配色／尺寸设置。
- `editorial`（2026-11-26 主人决定）颜色取自主人个人网站的色板与用法（`color-system.md`）：
  页面与侧栏底 `#F0EEE7`，表单／浮层 stone-50 `#F8F6F4`，正文 `#141413`、次级 `#68645D`
  用实色；边框 stone-600 18%，悬停 stone-200 42%，选中 stone-300 78%（约 `#D8D2C5`，比底色
  更深）；焦点环 blue-500 45%，链接 blue-700。网站覆盖不到的部分在其色板上补充：主按钮用
  编辑蓝（浅色 blue-700 底配 stone-50 字，悬停／按下 blue-800／900；深色 blue-400 底配墨色
  字）；文字层级补 stone-700（说明）、stone-500（三级）、stone-400（占位）；深色以网站主墨
  `#141413` 为底、向米纸色提亮得到卡片与浮层，文字 stone-100，次要 stone-300／stone-400。
  浅色搜索命中底调为 `#FFCB3D`／当前项 `#F5961A`，保证在米纸底上可见。状态色、错误红、
  品牌启动红、代码高亮与登录皮不在本方案内。
- 同一扩展下的 `schemes` 描述每套方案。`original` 不覆盖原有默认，`minimal` 是可继续
  修改的样板；可以新增稳定 ID 并使用已有的 `illustrated`／`typographic` 形象资源组。
- 本文件的 `reference.umeda` 保存试验数值，`semantic.umeda` 描述其角色；各方案字段
  引用这些或既有 DTCG Token 的完整路径，不在组件里再写一套颜色或尺寸。

修改后使用仓库锁定的 pnpm 执行 `pnpm --filter @cindy/design-tokens generate`，再完整
重启／构建客户端。生成与校验的通用入口见 [Token README](../../packages/design-tokens/README.md)。
生成器输出 `packages/maker-shared/src/generated/appearanceSchemes.ts`；共享的
`appearanceScheme.ts` 只提供类型和读取接口，不再手动编辑当前方案常量或生成文件。
配置是随代码构建的输入，不在运行期加载任意脚本或远程主题。

## 已接入的配置字段

| 字段 | 内容与消费入口 |
| --- | --- |
| `brandStyle` | 选择首页字标／头像、加载字标、分享角色图及手机应用内启动占位的资源组 |
| `desktop.colors.light/dark` | 现有桌面语义颜色 ID 到 DTCG 色值 Token 的映射，进入 ThemeService；旧 `*-hsl` 变量由对应颜色自动派生，不独立配置 |
| `desktop.foundations` | 已登记的 CSS 基础变量名（不加 `--`），包括字体栈、文字字号／行高、圆角、间距、字重和动效；进入现有 CSS/Tailwind 消费链 |
| `desktop.fontSizes` | `uiSize`／`codeSize`／`terminalSize` 的系统默认字号；继续遵循现有字号范围和用户显式覆盖 |
| `mobile.colors.light/dark` | ThemeColors 中的字符串角色，进入现有色板、ThemeProvider、导航和组件；登录专用嵌套色板保留原有契约 |
| `mobile.spacing/radius` | 现有间距／圆角角色到 DTCG dimension Token 的映射 |
| `mobile.typeScale/lineHeight` | 现有文字角色的字号／行高；组件及 `textStyles` 使用解析后的值 |
| `mobile.motionDuration` | 现有动效时长角色到 DTCG duration Token 的映射 |
| `mobile.fontFamily/codeFontFamily` | 已安装／已打包的 UI 字体与代码字体；原生字体使用一个 family 名称 |

方案只记录需要改变的字段，其余继承平台原有默认。两种模式的颜色角色必须成对配置；
未知字段、缺模式、错误类型、非法引用等在生成时失败。颜色绑定使用具体 DTCG 色值，
不引用会构成 CSS 自循环的变量别名。原有 Cindy Token ID、内置主题数值和用户主题文件保留。

桌面默认 Cindy 配色承载方案颜色；用户选用其他内置配色时保留该配色。本地主题明确提供的
颜色、首页图标／字标和 radius 优先，未提供的角色可继承方案。字体偏好仍由现有宿主保存，
配置改变未自定义的系统默认；恢复默认继续删除原有 override，不把方案复制进用户设置。
自定义头像、用户壁纸和显示模式不被重写。

## 两端适配与边界

Desktop 的 `renderer/appearance/brandAssets.ts` 集中语义素材；ThemeService 将方案颜色与
基础变量接入现有主题，`applyFontSettings` 在配置的文字尺度上落实原有用户缩放。
Mobile 的 `src/theme/appearance.ts` 将方案覆盖合入原有色板和尺寸阶梯，样式缓存按实际色板
身份区分，避免同一浅深模式更换配置后复用旧样式。AppText／TextInput 提供默认 UI 字体，
显式字体优先，嵌套文字继续继承外围代码字体。

原有 Cindy 色板继续独立保留；冻结测试通过同一个生产解析入口核对 `original` 方案与
原快照，新方案另测实际覆盖结果，不刷新或削弱旧快照。Mobile 基础默认值仍在原 `tokens.ts`，
只有个人方案覆盖进入 DTCG 生成链，不能称为整个 Mobile 设计源已迁移。

配置作用于已消费这些 Token 的界面。固定几何、第三方组件内部样式、任意页面布局结构、
登录形象、其他头像、系统图标、小组件和原生启动画面仍需按对应模块逐项适配。
新增原生字体资源需要另走冷构建；仅选择已有字体不增加原生依赖。

## 验证记录

2026-11-23 首批品牌接入：7 项定向测试、6 个浅深色组件场景通过。首次广泛检查
194 个场景中 192 个通过；群聊 `body-answer` 两种模式因缺 AuthProvider 失败，
对照 HEAD 修改前同样失败。截断缺 title、远程连接翻译缺失等告警按原报告保留。

配置化批次：生成器从隔离临时仓副本中读取修改后的配置，验证当前方案、同源的两端颜色、
手机行高进入生成结果，并拒绝不完整的浅深色配对；已验证生成稳定与过期检测。
桌面覆盖主题 CSS、原主题不变、本地覆盖优先、移除旧方案变量、配置字号与用户字体；
手机覆盖色板／尺寸合并、缓存更新及 UI／显式／嵌套代码字体。
本轮最终验证：

- Desktop 定向测试合计 73 项、Mobile 39 项通过；覆盖原有 Cindy 主题、本地主题不变、
  偏好存储／preload，以及配置色板、字号、样式缓存和字体继承。新字体组件测试文件
  单独运行 0.90 秒；生成流水线的既有集成文件本次运行 48.57 秒，生成领域未另增测试文件。
- design-tokens 的 47 项检查按全包及失败后的定向复核通过；其中生产生成集成验证 7 项
  单独运行通过。生成新鲜度检查、包类型检查、Desktop／Mobile 改动核心模块定向类型检查、
  文档合同 10 项和 test-hygiene 通过。没有扩大既有门禁豁免或更新 Cindy 色值快照。
- `appearance-brand` 的两套形象／配色及加载字标 × Light／Dark 共 6 个场景通过，已查看
  overview，使用真实 Button／Input 等组件验证呈现，未替换产品模块。
- 变更扫描的 default 场景矩阵为 250/262 通过，未覆盖文件为空。失败中的 IM 默认模型、
  协议路径与中转服务分别缺 AuthProvider 或模拟宿主方法，定向 HEAD 对照在修改前也失败。
  邮件阅读、PR 浮层和归档场景曾报 iframe 沙箱日志错误；定向前后对照复核通过（邮件两种
  模式，其余抽样浅色），记录为广泛运行的不稳定结果，不将原矩阵改记为通过。

共享包全量类型检查曾被原有 `interaction.test.ts` 重复导入阻断；手机全量检查在 4 GiB 堆下
报现有资料模块缺 `expo-sqlite`／`@cindy/device-link` 等解析及衍生类型错误。Desktop 全量
类型检查未重跑，不把定向模块检查称为整仓通过。iOS 编译、签名、安装、原生启动与真机
浅深色效果待有 Xcode 后集中验证；桌面截图与手机 JS 层检查不代替真机结论。
