# Obsidian Antigravity

将 Google Antigravity 的 `agy` CLI 接入 Obsidian 库的插件，让 Agent 能够阅读、整理和维护你的笔记。

本插件不把 Antigravity 包装成聊天界面，而是把它拆解为**独立的一次性任务**，外加一个**可选的嵌入式 Web 视图**。它建立在 Antigravity 的 Agent 文件系统操作能力之上，而非多供应商聊天框架。

[English](README.md) | 简体中文

---

## 前置要求

- **仅支持桌面端。** 插件需要以子进程方式运行 `agy`，因此无法在移动端使用。
- **必须已安装并完成认证的 `agy` CLI。** 插件不附带、也不会为你安装它。如果可执行文件不在标准位置，请在设置中手动指定路径。

---

## 安装

### 从社区插件市场安装

尚未上架。请暂用下方的手动安装方式。

### 手动安装

1. 从 [最新 Release](https://github.com/kyc/obsidian-antigravity/releases) 下载 `main.js`、`manifest.json` 和 `styles.css`。
2. 创建目录 `<你的库>/.obsidian/plugins/antigravity/`。
3. 将三个文件放入该目录。
4. 在 Obsidian 中，于 **设置 → 第三方插件** 里启用本插件。

### 从源码构建

```bash
git clone https://github.com/kyc/obsidian-antigravity.git
cd obsidian-antigravity
npm install
npm run build
```

`npm run build` 会将打包产物输出为仓库根目录的 `main.js`。若设置了 `OBSIDIAN_PLUGIN_PATH`，还会额外把三个插件文件镜像到该目录——这在对照实际库测试时很有用。未设置该变量时会跳过同步；同步失败仅给出警告，不会导致构建失败。

---

## 功能特性

- **独立库任务** —— 通过命令面板触发重构、链接审计、Frontmatter 清理与 MOC 生成，无需对话界面。
- **嵌入式 Web Hub** —— 可选择打开一个运行 `agy --hub` 的标签页，在 Obsidian 内直接使用完整的 Antigravity Web UI（流式思考块、工具卡片、多 Agent 产物）。
- **库上下文感知** —— 自动提取当前笔记路径、编辑器选中文本或所在文件夹，并传递给 Agent。
- **状态栏控制** —— 实时状态指示器与动态加载动画，点击即可取消运行中的任务。
- **库规范规则** —— 自动创建并注入 `AGENTS.md`，确保 Agent 遵循 Obsidian 约定，例如 `[[双链]]` 与 YAML Frontmatter。
- **权限门控** —— 后台任务默认运行于受限审批模式。无限制自主执行需依次通过设置开关、确认弹窗，且结果面板会持续显示风险横幅。

---

## 命令

所有命令均可从命令面板调用，并可绑定快捷键。命令名称遵循 Obsidian 的句式大小写规范。

| 命令 | ID | 说明 |
| :--- | :--- | :--- |
| 打开 Assistant Web Hub 视图 | `open-hub` | 打开运行 Antigravity Web Hub 的嵌入式 Web 视图标签页。 |
| 在当前上下文中运行任务 | `run-task` | 打开任务对话框，含上下文标识（选中文本 / 笔记 / 库）与操作预设。 |
| 修复当前笔记中的双链 | `fix-links` | 审计双链，修复失效链接，并为未链接的已有笔记引用提供建议。 |
| 审查并清理当前笔记中的 Frontmatter | `audit-frontmatter` | 校验并规范 YAML 标签、别名与元数据，同时保留自定义字段。 |
| 为当前文件夹生成内容地图 (MOC) | `build-folder-moc` | 扫描该文件夹，创建或更新 `_MOC.md` 索引笔记。 |
| 停止当前任务 | `stop-task` | 取消正在运行的 `agy` 进程。 |

功能区图标用于打开 Hub。右键点击该图标，或按住 <kbd>Alt</kbd> 点击，可唤出包含任务与停止操作的菜单。

---

## 配置

位于 **设置 → Antigravity**。

**界面语言** —— 插件界面语言。可选自动（跟随 Obsidian）、English、简体中文、繁體中文。

**Antigravity 可执行文件路径** —— `agy` 可执行文件的位置。留空时，插件会依次搜索 `~/.local/bin`、`/usr/local/bin`、`/usr/bin` 以及 `PATH`。**验证可执行文件** 按钮会运行 `agy --version` 以确认插件能够执行它。

**默认模型** —— 传递给 `agy` 的模型 ID。可选值：`gemini-3.8-flash-high`、`gemini-3.8-flash-medium`、`gemini-3.8-flash-low`、`gemini-3.7-flash-high`、`gemini-3.1-pro-high`、`gemini-3.1-pro-low`、`claude-sonnet-4-6`。

**思考强度** —— 通过 `--effort` 传递的推理强度：`none`（目录默认）、`low`、`medium`、`high`。

**默认 Agent** —— 通过 `--agent` 传递的 Agent 人格，默认为 `omarchy-vault`。

### Assistant Hub

- **Hub 配置目录名** —— `~/.gemini/` 下的数据目录，默认为 `antigravity-obsidian`。用于将 Hub 的会话与项目同 Antigravity IDE 及独立 CLI 隔离。
- **Hub 端口** —— 本地 Hub HTTP 服务的端口。设为 `0` 时动态分配空闲端口。
- **自动启动 Hub 服务** —— 在 Obsidian 启动时自动运行 Hub 后台服务。

### 库规范规则

- **维护库规范规则文件** —— 自动创建并注入描述 Obsidian 约定的规则文件。
- **库规则相对路径** —— 相对于库根目录的路径，默认 `AGENTS.md`。解析后超出库范围的路径会回退至 `AGENTS.md`。

### 库任务与安全

- **允许无限制执行任务** —— 传递 `--dangerously-skip-permissions` 以自动批准工具调用。首次使用需显式确认。禁用时，无头模式下的危险操作会被拦截，并以 `denied_actions` 形式回报。

---

## 安全与隐私

- **仅限桌面端** —— 依赖 Node.js 子进程，已在 `manifest.json` 中声明 `"isDesktopOnly": true`。
- **配置目录隔离** —— Hub 后台服务以 `--app_data_dir=antigravity-obsidian` 运行，因此不会与主 Antigravity IDE 中的会话发生状态冲突。
- **对 `~/.gemini/` 的访问** —— 为免去二次交互式登录即可启动 Antigravity Web UI，插件会读取 `~/.gemini/`，以复制 OAuth 凭据（以 `0600` 权限写入）并为你的库注册 workspace JSON 链接。
- **无外部网络请求** —— 插件自身不发起任何对外请求。其唯一的 HTTP 调用是针对 `127.0.0.1` 的本地回环健康检查，用于探测 Hub 是否已开始监听。所有模型流量均由 `agy` 进程处理。
- **路径校验** —— 配置目录名与规则路径均经过路径穿越（`../`）清洗。写入提示词的上下文路径会被解析并限制在库范围内。
- **任务权限** —— 任务默认受限运行，插件不会静默自动批准工具调用。

---

## 开发

```bash
npm run dev          # 监听模式，自动重新构建
npm run build        # 生产构建输出 main.js 并同步至库
npm run typecheck    # 检查 TypeScript 类型
npm test             # 运行 Jest 单元测试（8 个套件，60 个测试）
npm run lint         # 使用 eslint-plugin-obsidianmd 检查源码
```

完整验证流水线（CI 在每次 push 与 pull request 时同样执行）：

```bash
npm run typecheck && npm test && npm run build && npm run lint
```

单元测试在 `tests/unit/` 下与 `src/` 目录结构镜像对应。提交规范与代码标准请参见 [CONTRIBUTING.md](CONTRIBUTING.md)。

更多文档：

- [架构与开发笔记](docs/ARCHITECTURE_AND_DEV_NOTES.md)
- [Hub 能力边界](docs/HUB_CAPABILITY_BOUNDARIES.md)
- [代码审查记录](docs/CODE_REVIEW_2026-09.md)

---

## 许可证

[MIT](LICENSE)
