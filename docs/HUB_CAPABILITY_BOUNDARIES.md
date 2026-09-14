# Antigravity Hub 能力边界调查报告

> [!NOTE]
> **调查结论有效，但 §5 的「链路去留」已于后续定型。**
>
> 本报告的 Hub 契约逆向（§1–§4）仍然准确且是当前实现的依据。但 §5 写作时三条链路都还在讨论中；此后**定案为 Hub + Task 双轨**：Chat 轨已彻底删除，Task 轨已完整接线并成为唯一的「带指令执行」通道，Hub 轨保留为完整能力入口。阅读 §5 时请以本说明为准，§6 的待验证事项中第 1、2 条至今仍未实测。

> 调查日期：2026-09
> 调查对象：`agy` v1.2.2（CLI）+ `google.google-antigravity` v1.3.0（VS Code 扩展）
> 调查动因：`agy --hub` 属未公开机制（`agy --help` 中无此参数），需从官方扩展反推真实契约，以判定插件三条链路的去留
> 证据来源：`~/.vscode/extensions/google.google-antigravity-1.3.0/extension.js`（12.2 MB）+ `bridge.js`（1.7 MB）

---

## 0. 核心结论

| 问题 | 结论 |
| :--- | :--- |
| Hub 公布程度 | **未公开**。`agy --help` 无 `--hub` / `--hub-port` / `--app_data_dir`，三个参数均来自扩展逆向 |
| Hub 由谁驱动 | 官方 VS Code 扩展 `google.google-antigravity` 内置的 **Jetski** 服务 |
| 官方如何判就绪 | 监听 stdout 的 `ANTIGRAVITY_OPEN_URL:` 前缀，**不是 HTTP 轮询** |
| 官方如何传工作区 | URL 参数 `workspaceUri`，**不写** `~/.gemini/config/projects/` |
| 官方如何注入上下文 | **protobuf + RPC over WebSocket**（`useWebSocket=true`） |
| 能否用 URL 预填 prompt | **不能**。URL 只能指定路由与工作区，注入上下文必须走 WebSocket RPC |
| 插件能否复用该 RPC | **理论上可以，但代价高**：需实现 protobuf schema + WebSocket 握手，且依赖未公开协议 |

**对三条链路去留的影响**：Hub 轨是唯一能拿到官方完整能力的通道；Chat 轨受 `agy` CLI 的 `stream-json` 能力边界限制（用户已实测并放弃，该轨后续已删除）；Task 轨现为唯一的「带指令执行」通道。**Hub 无法通过 URL 预填 prompt** 这一点，直接决定了「其他命令改为唤起 Hub 执行」的方案不可行——详见 §5。这也正是 Task 轨必须保留的根本原因。

---

## 1. 官方 Hub 启动契约（权威来源）

`extension.js` @ 5287616 处的 `JetskiServer.start()`：

```js
const port = Number(configuredPort) || (await this.getAvailableEphemeralPort());
const backendUrl = `http://127.0.0.1:${port}`;
const args = [
    '--hub',
    `--hub-port=${port}`,
    '--app_data_dir=antigravity',      // ← 官方固定用 'antigravity'
];
for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (folder?.uri?.fsPath) args.push(`--add-dir=${folder.uri.fsPath}`);
}
// serverArgs 配置项可追加自定义参数
this.serverProcess = spawn(binaryPath, args, {
    cwd: activeCwd,                     // ← workspaceFolders[0] 或 extensionPath
    env: buildServerEnvironment({ configOverride }),
    stdio: ['ignore', 'pipe', 'pipe'],
});
```

### 与插件实现的对照

| 维度 | 官方扩展 | 本插件 | 评价 |
| :--- | :--- | :--- | :--- |
| 启动参数 | `--hub --hub-port=N --app_data_dir=antigravity --add-dir=<ws>` | 同 + `--project=<id>` + `--agent=<name>` | 插件多两个参数，属合理扩展 |
| `--app_data_dir` | 固定 `antigravity` | 可配置 profile（默认 `antigravity-obsidian`） | **插件是增强**：官方会与 IDE 共享数据，插件做了隔离 |
| 端口分配 | 配置文件 `antigravity.serverPort`，否则临时端口 | 设置项 `hubPort`，否则 `getFreePort()` | 等价 |
| 就绪判定 | **stdout 匹配 `ANTIGRAVITY_OPEN_URL:`** | **HTTP 轮询 `waitForPort(port, 15000)`** | 见 §3，插件方案可行但非官方机制 |
| 工作区传递 | URL 参数 `workspaceUri` | 写 `~/.gemini/config/projects/*.json` + URL `?section=<id>` | **机制完全不同**，见 §2 |

---

## 2. 关键差异：工作区/项目传递机制

这是本次调查最重要的技术发现。

### 2.1 官方路径：`workspaceUri`（无文件副作用）

`extension.js` @ `renderIframe`：

```js
searchParams.set('extensionView', 'true');
searchParams.set('extensionVariant', 'vs-code');
searchParams.set('useWebSocket', 'true');
searchParams.set('hostTheme', hostTheme);
searchParams.set('enableMicrophone', 'false');
searchParams.set('platform', vscode.env.uiKind === vscode.UIKind?.Web ? 'web' : 'electron');
if (workspaceFolder) {
    searchParams.set('workspaceUri', workspaceFolder.uri.toString());
}
```

**官方从不写 `~/.gemini/config/projects/`** —— 全文件 `config/projects` **零命中**。它只把工作区 URI 作为 URL 参数传给前端。

### 2.2 插件路径：手工注册 project 文件 + `?section=`

插件 `ensureVaultProject()` 写入 `~/.gemini/config/projects/obsidian-${cleanName}.json`，再以 `?section=${projectId}` 打开。

### 2.3 两种机制的关系（尚待实测确认）

存在三种可能，**本次未做实测**，需注意：

1. **等价**：`?section=<id>` 与 `workspaceUri` 是前端的两条等效入口，插件方案是官方 CLI 路径的正当用法。
2. **互补**：`section` 用于从 project registry 恢复既有项目，`workspaceUri` 用于首启动注入工作区。
3. **插件方案是变通**：因剔除 `extensionView` 后前端失去 VSCode RPC，只能靠预写 registry + `--project` 让后端自行注册。

插件文档 §3.6 记载「前端 `GM()` 依赖 URL 参数 `?section=${projectId}`，且该 ID 必须预先注册」——说明开发者是**实测得出**该结论的，倾向支持可能性 1 或 3。**建议实测验证**（见 §6）。

### 2.4 附带发现：探测残留需清理

`~/.gemini/config/projects/` 下曾存在本次调查遗留的无效注册文件（指向不存在的路径）：

| 文件 | 内容 | 状态 |
| :--- | :--- | :--- |
| `probe-project.json` | `file:///tmp/agyprobe` | ✅ 已清理 |
| `obsidian-vault.json` | `file:///test/vault` | ✅ 已清理 |
| `obsidian-vault-709105e4.json` | `file:///test/vault` | ✅ 已清理 |
| `obsidian-omarchy-desktop.json` | 无哈希的旧格式 ID | ✅ 已清理 |

清理于 2026-09 完成。**注意**：这些文件的 `id` 字段与文件名不一致（例如 `obsidian-vault.json` 内 `"id": "obsidian-vault"`），说明它们由早期版本直接构造 id 而产生，而非当前 `ensureVaultProject` 的哈希命名。若后续再次运行探测脚本，须复查此目录。

---

## 3. 就绪判定机制差异

| | 官方 | 插件 |
| :--- | :--- | :--- |
| 方式 | 读 stdout，匹配 `ANTIGRAVITY_OPEN_URL:` | `http.get('http://127.0.0.1:port/')` 轮询，间隔 250ms，超时 15s |
| 优势 | 精确、无网络开销、能捕获认证 URL | 无需解析 stdout |
| 风险 | — | 若服务已监听但 SPA 未就绪，可能过早渲染 iframe |

插件方案（`AgyHubManager.waitForPort`）本身**是合理的**，且带进程存活检查（重构后签名已改为命名参数对象 `WaitForPortOptions`）：
```ts
// waitForPort({ port, child, timeoutMs })
if (child && (child.killed || child.exitCode !== null)) {
  throw new Error('Antigravity hub process exited unexpectedly during startup.');
}
```
此设计值得肯定。但**官方 stdout 信号更精确**，且可顺带捕获 `ANTIGRAVITY_OPEN_URL:`（认证 URL）——插件当前未利用该信号，遇认证流程时无法主动引导用户。

---

## 4. 上下文注入机制（决定「能否预填 prompt」）

### 4.1 官方能力

扩展提供 `antigravity.insertSnippet` 命令（"Add Selection to Chat"），实现为：

```js
async addContext(...chunks) {
    const view = await this.ensureMainInstance();
    view.focus();
    const items = expandedChunks.map((chunk) => {
        if (typeof chunk === 'string') {
            return create(TextOrScopeItemSchema, { chunk: { case: 'text', value: chunk } });
        }
        // ... fileLineRange 等结构化上下文
    });
    // → 经 Codeium RPC 发送
}
```

**两条关键事实**：
1. 上下文注入走 **protobuf（`TextOrScopeItemSchema`）+ Codeium RPC**，传输层是 **WebSocket**（对应 URL 参数 `useWebSocket=true`）。
2. 这**不是** URL 参数，无法通过 `iframe.src` 完成。

### 4.2 URL 能做什么、不能做什么

| 能力 | 可否经 URL | 依据 |
| :--- | :--- | :--- |
| 指定工作区 | ✅ `workspaceUri` | `renderIframe` |
| 指定项目/section | ✅ `section` / `targetProjectId` | 插件实测 + 官方 `targetProjectId` |
| 指定主题 | ✅ `hostTheme` | 官方 + 插件均用 |
| 指定路由/会话 | ✅ `c/<conversationId>`、`settings-standalone`、`artifact`、`terminal-standalone` | `targetRoute` 取值 |
| 指定设置页锚点 | ✅ `targetScreen`、`targetWorkspaceUri` | `updateActiveSettings` |
| **预填 prompt** | ❌ | 无对应 URL 参数 |
| **自动发送 prompt** | ❌ | 仅 RPC |
| **注入文件/选区上下文** | ❌ | 仅 RPC（protobuf） |

### 4.3 官方前端路由清单

```
''                          主对话界面
c/<conversationId>          指定会话
settings-standalone         设置页
artifact                    产物预览
terminal-standalone         终端
```

**注意**：`settings-standalone` / `artifact` / `terminal-standalone` 这三个官方路由，插件目前**完全未使用**——是潜在的功能扩展点（如「打开 Hub 设置页」命令）。

---

## 5. 对三条链路去留的影响

> **后续定型**：本节写于三条链路并存时期。定案结果是 **Hub + Task 双轨**——Chat 轨已删除，Task 轨已接线。以下各节保留原始分析以记录判断依据。

### 5.1 Hub 轨（保留）

**能力边界**：
- ✅ 完整官方 UI：思维链、Tool Call 卡片、Artifacts、多 Agent
- ✅ 工作区隔离（通过 `--app_data_dir`，比官方更干净）
- ✅ 主题跟随（`hostTheme`）
- ❌ 无法从插件侧预填 prompt / 注入上下文（除非实现 WebSocket RPC）
- ❌ 不响应 vault CSS Snippets（已知妥协）
- ❌ 跨窗口拖拽会重载（同上）

### 5.2 Chat 轨（已删除）

用户原话：**「plugin 开始是走 chat 路线的，但 chat 因为 agy cli 的天然限制，能力边际非常有限所以放弃了」**

本次调查**佐证了这一判断**：`agy --help` 显示 CLI 的 `stream-json` 模式能力有限（无官方前端的路由/会话管理/Artifacts/多 Agent 协同）。Chat 轨本质是用 CLI 子集重实现官方 SPA 的极简版，上限天然受 CLI 制约。

**修正我此前的错误建议**：我曾建议「先修 Chat 轨的历史持久化」。**该建议是错的**——对一个已决策放弃的轨道做体验优化没有意义。

**最终处置**：`AgySession.ts` 与 `ChatView.ts` 已从代码库删除，相关 CSS 亦已移除。下方 §5.3 描述的「Task 轨转投 Chat 轨」状态不复存在。

### 5.3 Task 轨（已接线）

> **原始记录**：本节写作时 `VaultTaskRunner.runTask()` 仅被测试调用，`ResultModal` 零引用，`TaskModal` 转投 Chat 轨。

**当前状态**：此问题已作为代码评审 §3.1 的完成度缺口被修复。`TaskModal.onSubmit` 现直接调用 `taskRunner.runTask()`，结果经 `ResultModal` 展示。Task 轨是插件唯一的「带指令执行」通道。

**关于「Hub 无法预填 prompt」的约束仍然成立**：§4.2 证实 Hub 只能被打开、无法带上指令。因此 `fix-links` 等一键命令**只能**继续走 `agy --print`（即 Task 轨现状），除非未来实现 Hub 的 WebSocket RPC 注入（§6 待评估）。这条约束是 Task 轨必须保留的根本原因。

---

## 6. 待验证事项

以下问题本次**未实测**，需在实机验证后再定架构：

1. **`?section=` 与 `workspaceUri` 是否等价**
   方法：起 hub 后分别用两种 URL 打开，观察是否都正确加载 vault 工作区。
   影响：若 `workspaceUri` 可用且无需预写 registry，可**大幅简化** `AgyHubManager`（去掉 `ensureVaultProject` / `ensureDefaultProjectId` 及 §2.3 的 ID 碰撞缺陷）。

2. **`useWebSocket=true` + `extensionView=true` 在当前 iframe 下是否真的白屏**
   插件文档 §3.1 称会死锁，但那是早期结论。若可用，则**能拿到官方 RPC 通道**，从而支持 prompt 预填与上下文注入。
   影响：这是「Chat 轨能否被 Hub 完全替代」的决定性实验。

3. **`ANTIGRAVITY_OPEN_URL:` 信号是否可靠**
   方法：起 hub 观察 stdout。
   影响：可替换 `waitForPort` 并支持认证引导。

4. **`settings-standalone` / `artifact` / `terminal-standalone` 路由是否可直接访问**
   影响：可作为低成本功能扩展。

---

## 7. 建议的下一步

**§6.1 与 §6.2 两个实验至今未做**（各约 10 分钟）——它们决定 `AgyHubManager` 能否进一步简化：

1. **若实验 1 成功**（`workspaceUri` 可替代 `?section=`）→ 可移除 `ensureVaultProject` / `ensureDefaultProjectId` 及项目 ID 碰撞风险，`AgyHubManager` 大幅简化。
2. **若实验 2 成功**（`useWebSocket=true` + `extensionView=true` 在 iframe 下可用）→ 可拿到官方 RPC 通道，从而支持 prompt 预填与上下文注入，Task 轨的存在必要性需重新评估。
3. **若实验 3 成功**（`ANTIGRAVITY_OPEN_URL:` 信号可靠）→ 可替换 `waitForPort` 轮询，并支持认证流程引导。

**已完成的修复**：`AgyHubManager` 的三个已确证缺陷（并发竞态、路径穿越、ID 碰撞）均已修复，见 [CODE_REVIEW_2026-09.md](CODE_REVIEW_2026-09.md) §2。

---

## 附：调查方法记录

- `agy --help` 无 `--hub` 相关参数，确认属未公开机制
- 从 `~/.vscode/extensions/google.google-antigravity-1.3.0/` 定位权威来源（v1.3.0）
- 因 `extension.js` 达 12.2 MB 且经 minify，`grep -o` 跨行匹配失效，改用 Node 按字节窗口提取上下文
- 关键词定位：`--hub-port`、`hostTheme`、`targetRoute`、`workspaceUri`、`addContext`、`insertSnippet`
- 交叉验证：`config/projects` 在扩展中零命中 → 证实官方不走 registry 路径
