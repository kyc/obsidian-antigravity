# 代码评审报告 (Code Review Report)

> [!WARNING]
> **本文档为历史快照，描述的是一份已不存在的代码状态。**
>
> 评审对象 `d129b722` 当时仍包含 **Chat 轨**（`src/core/AgySession.ts`、`src/ui/ChatView.ts`）。该轨道此后已被彻底删除，插件收敛为 Hub + Task 双轨。因此本文档中所有**行号引用与 Chat 轨符号均已失效**：
>
> | 本文档引用 | 当前状态 |
> | :--- | :--- |
> | `AgySession.ts` / `ChatView.ts` | 文件已删除 |
> | `activateChatView()` | 已删除（`TaskModal` 现直接调用 `taskRunner.runTask()`） |
> | `currentCallbacks`、`currentAssistantBubbleEl` | 已删除 |
> | `startingPromise` | 已重构为 `inFlightStart` + `startMutex` |
> | `.antigravity-composer-input` (`styles.css:288`) | 已删除 |
> | `styles.css` 各条行号 | 已全部漂移 |
>
> 本文档的**结论与修复记录仍然有效**（13 项问题均已闭环，闭环方式见下表）。阅读时请以 §2 的问题描述和 §6 的方法论复盘为参考，不要依赖其中的行号。当前权威架构说明见 [ARCHITECTURE_AND_DEV_NOTES.md](ARCHITECTURE_AND_DEV_NOTES.md)。

> 评审日期：2026-09
> 评审对象：`obsidian-antigravity` @ `d129b722`
> 评审基线：`npm run typecheck` 通过 · `npx eslint src/` 0 error 0 warning · `npm run test` 26 tests / 7 suites 全绿（**当时的数字**；当前为 8 suites / 60 tests）
> 评审方法：先通读 `docs/ARCHITECTURE_AND_DEV_NOTES.md` 与 `README.md` 建立架构意图，再逐文件审阅 14 个源文件；对高影响问题编写临时复现脚本实证，验证后已清理。

---

## 0. 结论摘要

代码整体质量良好：分层清晰（`core` / `ui` / `settings`）、依赖注入到位、ESLint 全绿、测试覆盖 core 与 ui。本次共发现 **13 项问题**，其中 3 项为安全/正确性缺陷（有复现证据），1 项为「文档承诺但功能未接线」的完成度缺口。

**最关键的发现不是 ESLint 能报的任何东西，而是文档承诺与代码实际行为之间的落差**——见 §4.4。

| 级别 | 编号 | 问题 | 证据 | 修复与闭环状态 |
| :--- | :--- | :--- | :--- | :--- |
| 🔴 | 1 | `startHub` 并发竞态 → 返回错误 profile 的 Hub | 实测复现 | **已彻底解决**：`inFlightStart` 合并同 profile 请求，`startMutex` 串行化跨 profile，原子提交状态 |
| 🔴 | 2 | `hubProfile` 路径穿越 → 凭据越界写入 | 实测复现 | **已彻底解决**：`sanitizeProfile` 正则白名单过滤，限制在 `~/.gemini/` 子目录 |
| 🔴 | 3 | 项目 ID 归一化碰撞 → 两个 vault 共用项目文件 | 实测复现 | **已彻底解决**：追加 8 位 SHA256 绝对路径短哈希，消除命名覆盖 |
| 🔴 | 10 | `outline: none` 无 `:focus-visible` 替代 | 代码确证 | **已彻底解决**：为 `.antigravity-task-textarea:focus-visible` 提供 2px 主题外边框与偏移 |
| 🟠 | 4 | 第三条链路（离散任务执行器）从未接线 | 调用图确证 | **已彻底解决**：`TaskModal` + `ResultModal` + `VaultTaskRunner` 全链路接通，基于 `agy --print` |
| 🟠 | 5 | Vault rules 路径：文档说 A、代码写 B | 代码确证 | **已彻底解决**：代码与文档统一为根目录 `AGENTS.md`，增加 `resolveSafeRulesPath` 路径越界拦截 |
| 🟡 | 6 | Chat 轨完成后状态栏残留 | 调用图确证 | **已彻底解决**：Chat 轨移除；Task 轨状态闭环，任务异常 6 秒后自动重置为 `idle` |
| 🟡 | 7 | 会话无持久化，切换标签即丢失 | 代码确证 | **已自然闭环**：废弃脆弱的 CLI 侧边栏，全面依托官方 Hub（自带 SQLite/文件系统多会话持久化） |
| 🟡 | 8 | `loadSettings` 的 `undefined` 覆盖默认值 | 代码确证 | **已彻底解决**：引入纯函数 `validateSettings`，强制运行时字段类型守卫与默认值兜底 |
| 🟡 | 9 | `--effort` 与模型名后缀耦合 | 代码确证 | **已彻底解决**：移除脆弱的子串猜测，只要 `effort !== 'none'` 即显式透传 `--effort` |
| 🟡 | 11 | 触摸目标 28×28 < 44×44 | 代码确证 | **已彻底解决**：旧 Chat 界面移除，模态框与状态栏按钮符合 Obsidian 桌面规范 |
| 🟡 | 12 | 裸 `window` 破坏 popout 兼容 | 代码确证 | **已合规解决**：遵循 `prefer-window-timers` 规范，UI 操作优先绑定 `activeWindow` |
| 🟢 | 13 | Node 模块无 `Platform.isDesktop` 守卫 | 已知妥协，不建议改 | **已知架构决策**：`manifest.json` 已锁定 `"isDesktopOnly": true` |

> **闭环验证**：截至 2026-09-14，全套测试全绿，`npm run lint` 实现 0 错误 0 警告，代码审查问题已全部闭环。（当时数字为 7 suites / 46 tests，现为 8 suites / 60 tests；另于 2026-09 追加修复了 `VaultTaskRunner` 与 `AgyProcess` 的定时器句柄泄漏问题。）

---

## 1. 架构意图（评判前提）

评审前先建立对设计思路的理解，避免用通用规则误判刻意的架构决策。

### 1.1 双轨交互架构

| 轨道 | 通道 | 定位 | 关键文件 |
| :--- | :--- | :--- | :--- |
| **Chat 轨** | 常驻 `agy` 进程 + NDJSON `stream-json` 双向管道 | 高频日常笔记操作；原生、轻量、融入主题 | `AgySession.ts` / `ChatView.ts` |
| **Hub 轨** | `agy --hub` 守护进程 + `<iframe>` 内嵌官方 Angular SPA | 复杂多 Agent、思维链、Artifacts | `AgyHubManager.ts` / `HubView.ts` |
| **Task 轨** | 单次 `agy` 进程（文档 §2.3 设计） | MOC / 双链 / Frontmatter 离散任务 | `VaultTaskRunner.ts` / `TaskModal.ts` |

### 1.2 关键认知（决定了多处问题的定性）

- **Hub 是官方打包的 Angular SPA**，模型选择器与推理强度由 SPA 自身管理。`--model` / `--effort` 是 **Chat 轨专有**的 CLI 参数，Hub 轨不传这些参数是**正确设计**，不是缺陷。
  > 评审过程中曾误判此处为「model/effort 不作用于 Hub」的缺陷，经澄清后**已撤回**。参见 §6 复盘。
- **三项不可调和的架构妥协**（文档 §7.2）：桌面锁定、Vault 外文件访问、iframe 与原生 UI 契约脱节。这些是已知取舍，不应作为缺陷重复计分。

### 1.3 Hub 轨逆向工程成果（文档 §3，予以肯定）

规避 `extensionView` 桥接白屏、Profile 数据隔离、OAuth 凭据自动同步、破解 `/onboarding` 路由守卫死循环、根除 "No Project"、CLI 参数命名一致性——六项均为对 agy 未公开机制的硬核逆向，含金量高。

---

## 2. 🔴 安全与正确性缺陷

### 2.1 `startHub` 并发竞态 → 返回错误 profile 的 Hub

**位置**：`src/core/AgyHubManager.ts:176-186`

profile 对账逻辑排在 `startingPromise` 检查**之前**：

```ts
if (this.hubProcess && this.currentProfile !== profile) {
  this.stopHub();                    // ← 第二次调用会杀掉第一次的进程
}
if (this.startingPromise) {
  return this.startingPromise;       // ← 但对账已污染状态
}
```

**复现**（并发调用 `startHub(A)` 与 `startHub(B)`）：

```
SPAWNED PROFILES: ["--app_data_dir=profile-A"]
currentProfile: profile-A
RESULT p1: http://127.0.0.1:1234/?section=obsidian-vault
RESULT p2: http://127.0.0.1:1234/?section=obsidian-vault   ← 期望 profile-B
```

只有 profile-A 被拉起，但 profile-B 的调用**静默拿到 profile-A 的 URL**。

**影响**：直接击穿文档 §3.3 的 Profile 隔离承诺。用户切换 profile 后重开 Hub，连接到的是旧 profile 的数据目录，可能导致会话串扰——正是 §3.3 踩坑记录想要避免的问题。

**修复方向**：将 `startingPromise` 检查前置；promise 需携带其 profile，不匹配时串行等待或复用后再判断。

**回归测试建议**：并发以不同 profile 调用，断言 spawn 参数与返回 URL 的 profile 一致。

---

### 2.2 `hubProfile` 路径穿越 → 凭据越界写入

**位置**：`src/core/AgyHubManager.ts:14-15, 48-49`

`path.join(homeDir, '.gemini', profile)` 对用户自由输入的 `hubProfile` 无任何校验。该值来自设置面板文本框（`AntigravitySettingTab.ts:87-94`）且会被持久化。

**复现**（profile 为逃逸到 home 之外的相对路径）：

```
*** TOKEN WRITTEN OUTSIDE PROFILE: /tmp/victim-XyvAz2/antigravity-oauth-token mode 600
state file outside profile: true
```

`ensureProfileAuth` 把 OAuth 凭据复制到了 `~/.gemini` 之外，`ensureProfileOnboarding` 同样越界写 `antigravity_state.pbtxt`。

**影响**：违反文档 §6.3「安全与隔离承诺」。更严重的是，它使文档 §7.2 第 2 条的对外披露（"仅访问 `~/.gemini/` 下的三类文件"）不再成立——插件实际可写任意目录。

**修复方向**：校验 profile 仅含 `[A-Za-z0-9_-]`；断言 `path.resolve(targetDir)` 仍在 `~/.gemini` 之下，否则拒绝并给出 `Notice`。

**回归测试建议**：传入 `../` 形式的 profile，断言抛错或拒绝执行且未产生越界文件。

---

### 2.3 项目 ID 归一化碰撞 → 两个 vault 共用项目文件

**位置**：`src/core/AgyHubManager.ts:101-103`

```ts
const cleanName = projectName.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
```

该映射是有损的，不同 vault 会产生相同 ID。

**复现**：

```
id  = obsidian-my-vault-         (来自 /home/alice/My Vault!)
id2 = obsidian-my-vault-         (来自 /home/bob/My-Vault-)
same file? true
```

**影响**：两个不同 vault 映射到同一个 `~/.gemini/config/projects/obsidian-my-vault-.json`，后者覆盖前者；`default_project_id.txt` 同样串号。导致文档 §3.6 的 `?section=${projectId}` 指向错误 workspace，Hub 打开的是他人的 vault 路径。

**修复方向**：归一化结果追加 vault 绝对路径的短哈希（如 sha256 前 8 位）以保证唯一性。

---

### 2.4 `outline: none` 无 `:focus-visible` 替代

**位置**：`styles.css:288`

`.antigravity-composer-input` 移除了焦点轮廓，且全文件 `:focus-visible` **零命中**。这是键盘可达性的硬性要求。

**注意**：此项与文档 §7.2 第 3 条的 iframe 妥协**无关**——`ChatView` 是纯原生 DOM，不受 Hub iframe 限制，属可修范围。

**修复**：

```css
.antigravity-composer-input:focus-visible {
  outline: 2px solid var(--interactive-accent);
  outline-offset: 1px;
}
```

---

## 3. 🟠 功能完成度缺口

### 3.1 第三条链路（离散任务执行器）从未接线 —— 本次评审最重要发现

文档 §2.3 明确将 `TaskModal` + `VaultTaskRunner` 列为独立链路，`README.md:11` 亦宣传 "Task-Driven Vault Management"。但实际调用图如下：

**`TaskModal` 的唯一引用**是 `src/main.ts:105`，其回调走的是 **Chat 轨**：

```ts
new TaskModal(this.app, ctx, (res) => {
  void this.activateChatView(res.prompt);   // ← 进的是 Chat 轨，不是 Task 轨
}).open();
```

**`VaultTaskRunner.runTask()` 的调用点只在测试中**：

```
tests/unit/core/VaultTaskRunner.test.ts:36
tests/unit/core/VaultTaskRunner.test.ts:85
```

**连带的死逻辑**：

| 位置 | 现象 |
| :--- | :--- |
| `main.ts:175, 297` | `this.taskRunner.running` 恒为 `false`，"Stop current task" 与菜单停止项的条件**永远不成立** |
| `main.ts:55` | `VaultTaskRunner` 的 `onStatusChange` 回调从未触发，`StatusBarItem` 的 running/error 态实际只由 `AgySession` 驱动 |
| `src/ui/ResultModal.ts` | 全文件 79 行，**零引用**；本应是 Task 轨的结果展示组件 |

**定性**：这是「已设计、已实现、但未接线」的半成品，**不是冗余代码**。修复方向是**接线**而非删除——`TaskModal.onSubmit` 应调用 `taskRunner.runTask()` 并用 `ResultModal` 展示结果。这也解释了为何 README 承诺的「无对话负担的快捷模态框」与实际体验（转投聊天侧栏）不符。

---

### 3.2 Vault rules 路径：文档说 A、代码写 B

**位置**：`src/types.ts:22` vs `README.md:15,40` / `AntigravitySettingTab.ts:119`

| 来源 | 声称路径 |
| :--- | :--- |
| `types.ts:22`（实际生效） | `AGENTS.md`（vault 根目录） |
| `README.md:15, 40` | `.antigravity/AGENTS.md` |
| `AntigravitySettingTab.ts:119` | `.antigravity/AGENTS.md` |
| `docs §4.3` | 「Vault 根目录 `AGENTS.md` / `GEMINI.md`（自动注入）」 |

按文档 §4.3 的 Prompt 三层叠加原理，工作区层规则**本就应该**位于 vault 根目录——因此**代码是对的，README 与设置面板描述是错的**。

**但仍有实际风险**：默认值会在用户 vault 根目录静默创建 `AGENTS.md`。`ensureVaultRules`（`VaultContext.ts:55-67`）只判断文件是否存在、不检查内容，对已有同名文件的用户存在覆盖风险。

**修复方向**：统一为 `.antigravity/AGENTS.md` 并同步全部文档；或明确接受根目录方案但补充覆盖保护（存在但非本插件生成时不写入）。

---

## 4. 🟡 体验与健壮性

### 4.1 Chat 轨完成后状态栏残留

`main.ts:55` 的 `statusBar.update` 仅接在 `taskRunner` 的 `onStatusChange` 上。由于 Task 轨未接线（§3.1），`AgySession` 完成后**从不复位状态栏**——若曾进入 error 态会永久停留。与 §3.1 同源，接线后一并解决。

### 4.2 会话无持久化，切换标签即丢失

`AgySession` / `ChatView` 无任何 `loadData` / `saveData` / sessionId 机制。且 `ChatView.messages` 数组只在 `appendUserMessage` 中 push，**从不用于重绘**（`renderMessagesArea` 仅判断 `length === 0`）——该数组除占内存外无实际作用，叶子重建后历史全丢。

另：`ChatView.ts:25` 的 `currentAssistantBubbleEl` 被赋值/清空但**从不读取**（`tsc --noUnusedLocals` 报 TS6133）。

考虑到 §2.1 定位是「日常连续问答」，历史丢失属体验硬伤。建议持久化至 workspace state。

### 4.3 `loadSettings` 的 `undefined` 覆盖默认值

`main.ts:217`：

```ts
this.settings = Object.assign({}, DEFAULT_SETTINGS, (await this.loadData()) as Partial<...>);
```

`Object.assign` 不跳过 `undefined`。旧版本持久化数据缺少新增字段时，会以 `undefined` **覆盖**默认值。例如新增 `enableVaultRules` 后，老用户实际拿到 `undefined` 而非默认的 `true`。

**修复方向**：逐字段合并，或过滤掉 `undefined` 的键。

### 4.4 `--effort` 与模型名后缀耦合

`AgySession.ts:121` 与 `VaultTaskRunner.ts:66`：

```ts
if (effort && effort !== 'none' && !model.includes(`-${effort}`)) {
  args.push('--effort', effort);
}
```

用字符串包含判断去重。副作用：任何名称恰好含 `-low` / `-high` 的模型都会意外吞掉该 flag。两轨均在使用，建议改为显式白名单或让设置项联动。

### 4.5 触摸目标小于 44×44

`styles.css:299-301` 的发送/停止按钮为 `28×28`；头部 `clickable-icon` 按钮同样偏小。桌面端不致命，但无障碍规范明确要求 ≥ 44×44。

### 4.6 裸 `window` 破坏 popout 兼容

`AgyProcess.ts:50`、`AgyHubManager.ts:307`、`TaskModal.ts:101` 使用裸 `window.setTimeout`。`HubView.ts:65,153` 使用 `typeof activeWindow !== 'undefined' ? activeWindow : window` 运行时兜底——桌面端 `activeWindow` 必然存在，该兜底只是掩盖问题。

文档 §7.2 第 3 条承认 iframe 跨窗口会重载，但 `AgyHubManager` / `TaskModal` 的定时器与 iframe 无关，属可修范围。

### 4.7 Node 模块无 `Platform.isDesktop` 守卫（🟢 不建议修改）

`src/` 全量 import `child_process` / `fs` / `os` / `net` / `http` 且无守卫。因 `manifest.json` 已锁定 `"isDesktopOnly": true`（文档 §7.2 第 1 条的明确妥协）而安全，ESLint 亦未报错。**记录为已知妥协，不建议改动。**

---

## 5. 值得肯定

- **Hub 逆向工程**（文档 §3.1–3.7）：规避 `extensionView` 白屏、破解 `/onboarding` 路由守卫死循环等六项突破，均为对未公开机制的逆向，技术价值高。
- **`AgyResolver`**：`FsOperations` 依赖注入设计干净，跨平台分支（win32 / POSIX 可执行位检查）考虑周全。
- **`waitForPort`**：带超时与进程存活双重检查，启动失败明确报错而非挂死（文档 §7.2 第 4 条的落实）。
- **`abort()` 的健壮性**：置空 `currentCallbacks`，经实证迟到的 `result` 事件不会二次触发 `onTurnComplete`（done 恒调用 1 次）——此细节极易写错。
- **凭据权限**：`0600` / `0700` 设置正确（问题仅在 §2.2 的路径校验缺失）。
- **工程规范**：声明式 `getSettingDefinitions()` 已按 1.13 迁移，ESLint 全绿，测试覆盖 core 与 ui。

---

## 6. 评审过程复盘（方法论修正记录）

本轮评审纠正了两处此前的判断错误，记录以备后续参考：

### 6.1 误判「model/effort 不作用于 Hub」

**原判断**：Hub 启动未传 `--model` / `--effort`，判定为设置项脱节。
**实际**：Hub 是官方打包的 Angular SPA，模型由 SPA 自身管理；`--model` / `--effort` 是 Chat 轨专有参数。`startHub()` 不传这些参数是**正确设计**。
**结论**：**已撤回**。文档 §7.2 第 3 行（第 181 行）已写明双轨架构，属评审者读到后仍混淆链路。

### 6.2 误判 `VaultTaskRunner` / `ResultModal` 为死代码

**原判断**：生产代码未调用 `runTask()`，判定为冗余，建议删除。
**修正**：二者是文档 §2.3 描述、代码已实现、但**从未接线**的半成品。性质是**功能未完成**，修复方向应为**接线**而非删除——方向完全相反。

### 6.3 共同根因

两处错误的共同根因是：**先看代码、后补架构意图**，以通用规则匹配代替设计理解。

本轮改为先通读 184 行架构文档再动手，§3.1（第三条链路未接线）、§3.2（rules 路径不一致）、§4.1（状态栏残留）这些真正重要的发现才浮出水面——**它们都不是 ESLint 能报的问题，恰恰是文档承诺与代码实际之间的落差**。

**后续评审建议**：任何涉及「某配置项/某模块是否有用」的判断，须先确认文档中该模块的设计定位，不可仅凭调用图下结论。

---

## 7. 修复优先级建议

### 第一梯队：安全与正确性（均有复现证据，不涉及架构妥协）

1. **§2.1 竞态** + **§2.2 路径穿越** + **§2.3 ID 碰撞** —— 三者同属 `AgyHubManager`，可在单个 PR 内解决，均需补集成测试。
2. **§2.4 焦点可见性** —— 单条 CSS 规则，可随任一次提交附带。

### 第二梯队：功能完成度（决定 README 承诺是否成立）

3. **§3.1 接线第三条链路**，连带修复 §4.1 状态栏残留。
4. **§3.2 rules 路径统一**，同步 README 与设置面板文案。

### 第三梯队：体验与规范

5. §4.2 历史持久化、§4.3 设置合并、§4.4 `--effort` 耦合
6. §4.5 触摸目标、§4.6 popout 兼容

### 仅文档澄清

7. §4.7 Node 守卫（已知妥协，不建议改）

---

*报告生成：基于对 14 个源文件、全部测试与文档的通读，以及对 3 项高影响问题的实证复现（临时脚本验证后已清理，工作区保持干净）。*
