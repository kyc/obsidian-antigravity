# Obsidian Antigravity Plugin

A lightweight, dedicated Obsidian plugin that embeds Google Antigravity (`agy`) directly into your Obsidian vault as an autonomous knowledge organization and assistant tool.

Independent of multi-provider chat frameworks, this plugin gives you direct access to Antigravity's agentic filesystem manipulation, code execution, and reasoning power tailored specifically for Obsidian note-taking.

---

## Highlights

- **Task-Driven Vault Management**: Trigger refactoring, link fixing, tag cleanup, and Map of Content (MOC) generation via commands or hotkeys without conversational UI bloat.
- **Embedded Web Hub View**: Optionally open an Obsidian tab powered by `agy --hub` for Google's full official Web UI (streaming thinking blocks, tool cards, multi-agent artifacts).
- **Obsidian Context Awareness**: Automatically extracts active note paths, editor text selections, and folder structures into agent instructions.
- **Status Bar & Process Safety**: Real-time status indicator, dynamic spinner, and instant click-to-cancel controls.
- **Vault Rules Enforcement**: Automatically creates and injects `AGENTS.md` ensuring Antigravity strictly respects Obsidian conventions (`[[Wikilinks]]`, YAML frontmatter).
- **Permission & Execution Safety**: Background tasks run in restricted approval mode by default. Autonomous tool execution (`--dangerously-skip-permissions`) is strictly gated behind an explicit setting, a confirmation modal, and persistent risk banners on results.

---

## Commands

All commands follow Obsidian's sentence case standard:

| Command | ID | Description |
| :--- | :--- | :--- |
| `Run task on active context` | `run-task` | Opens the task modal with context badge (selection/note/vault) and one-click action presets. |
| `Fix wikilinks in active note` | `fix-links` | Audits and fixes broken links; links references to existing vault notes. |
| `Audit and clean frontmatter in active note` | `audit-frontmatter` | Validates and cleans YAML tags, aliases, and metadata. |
| `Build map of content (MOC) for current folder` | `build-folder-moc` | Scans current folder and generates or updates a structured `_MOC.md` index note. |
| `Open assistant web hub view` | `open-hub` | Opens the embedded Webview tab running the official Antigravity Web Hub. |
| `Stop current task` | `stop-task` | Cancels any currently executing background `agy` process. |

---

## Configuration

In **Settings > Antigravity**:

1. **Antigravity binary path**: Auto-detects `agy` in `~/.local/bin`, `/usr/local/bin`, or user PATH. Provides a **Verify binary** button to test execution.
2. **Default model**: Select model ID passed to `agy` (e.g. `gemini-3.8-flash`, `gemini-3.8-pro`, `gemini-3.8-flash-high`, `gemini-3.8-pro-high`).
3. **Reasoning effort**: Configure reasoning intensity (`none`, `low`, `medium`, `high`).
4. **Default agent**: Specify default agent persona (default: `omarchy-vault`).
5. **Assistant hub**:
   - **Hub profile name**: Data directory under `~/.gemini/` (default: `antigravity-obsidian`) isolating chats and projects from Antigravity IDE and standalone CLI.
   - **Hub port**: Port for the local hub HTTP server (default `0` for dynamic free port).
   - **Auto-start hub server**: Start the Antigravity hub daemon automatically when Obsidian loads.
6. **Vault rules**:
   - **Maintain vault rules file**: Automatically create and inject rules file for Obsidian conventions.
   - **Vault rules relative path**: Relative path from vault root (default: `AGENTS.md`).
7. **Vault tasks & security**:
   - **Allow unrestricted tasks**: Allows `--dangerously-skip-permissions` to auto-approve tool execution for background tasks. Requires explicit confirmation on first run. When disabled, dangerous operations are blocked in headless mode.

---

## Security & Privacy Disclosures

To ensure full transparency and compliance with Obsidian community guidelines:

- **Desktop-Only**: The plugin requires Node.js child processes and is declared `"isDesktopOnly": true` in `manifest.json`.
- **Sandbox Profile Isolation**: The Hub daemon runs with `--app_data_dir=antigravity-obsidian`, preventing database locks, session collisions, or credential contamination with your primary Antigravity IDE.
- **External Configuration Access**: To bootstrap the official Angular SPA without requiring manual browser re-login, the plugin accesses `~/.gemini/` exclusively to copy OAuth credentials with `0600` permissions and register workspace JSON links.
- **Path Sanitization**: All profile names, rules paths, and prompt context paths are strictly validated against path traversal (`../`) attacks.

---

## Development

```bash
npm run typecheck    # Check TypeScript types
npm run lint         # Lint source files with eslint-plugin-obsidianmd
npm test             # Run Jest unit test suite (7 suites, 46 tests)
npm run build        # Production bundle to main.js and sync to vault
npm run dev          # Watch mode with automatic rebuild
```

The full validation pipeline is:

```bash
npm run typecheck && npm test && npm run build && npm run lint
```
