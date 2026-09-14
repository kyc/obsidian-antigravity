# AGENTS.md — Obsidian Antigravity Plugin

## Project Overview

Obsidian Antigravity is a dedicated, lightweight Obsidian plugin integrating Google Antigravity (`agy`) directly into Obsidian for autonomous vault management and an embedded Assistant Web Hub view.

The plugin is completely decoupled from legacy multi-provider frameworks, focusing exclusively on Antigravity's agentic filesystem manipulation, code execution, and reasoning capabilities tailored for Obsidian note-taking.

## Commands

```bash
npm run typecheck    # Verify TypeScript types
npm run lint         # Lint codebase with eslint-plugin-obsidianmd
npm test         # Run Jest unit test suite (8 suites, 60 tests)
npm run build        # Production bundle to main.js (mirrors to vault only if OBSIDIAN_PLUGIN_PATH is set)
npm run dev          # Watch mode with automatic rebuild
```

The standard full verification pipeline is:

```bash
npm run typecheck && npm test && npm run build && npm run lint
```

Unit tests mirror `src/` under `tests/unit/`.

## Architecture & Code Map

| File / Directory | Responsibility |
| --- | --- |
| `src/main.ts` | Plugin entrypoint, lifecycle, command registrations, ribbon menu, view registrations. |
| `src/i18n/` | Internationalization subsystem (`getLanguage()` detection, type-safe catalogs for `en`, `zh-cn`, `zh-tw`). |
| `src/core/AgyProcess.ts` | Process execution wrapper for `agy` CLI using `cross-spawn`. |
| `src/core/AgyResolver.ts` | Resolution and verification of `agy` binary across system and local paths. |
| `src/core/AgyHubManager.ts` | Hub daemon manager (`agy --hub`), free port allocation, profile isolation, concurrency serialization, OAuth token sync, onboarding pre-seeding, and project registration. |
| `src/core/VaultContext.ts` | Obsidian vault context extractor (active note, selection, folder), path traversal sanitization, and vault rules maintenance. |
| `src/core/VaultTaskRunner.ts` | Discrete task execution runner (`agy --print`), active run lifecycle isolation, progress streaming, and permission mode control. |
| `src/ui/HubView.ts` | Embedded Webview tab (`ItemView`) with native leaf actions (`refresh-cw`, `external-link`) embedding the Antigravity Hub SPA. |
| `src/ui/StatusBarItem.ts` | Real-time status indicator, spinner, and click-to-cancel interaction. |
| `src/ui/TaskModal.ts` | Task execution dialog with context badge and action presets. |
| `src/ui/ConfirmModal.ts` | Confirmation dialog for dangerous actions (unrestricted autonomous execution). |
| `src/ui/ResultModal.ts` | Task execution output dialog with Markdown rendering, risk banner, copy, append, and create-note actions. |
| `src/settings/AntigravitySettingTab.ts` | Declarative plugin settings panel (1.13+ `getSettingDefinitions`). |
| `src/types.ts` | Core types, interfaces, default settings contracts, and `validateSettings` runtime schema validator. |
| `styles.css` | Stylesheet compiled alongside `main.js`. |

## Key Invariants & Design Decisions

1. **Profile Isolation & Concurrency Safety**:
   - The Hub daemon runs with `--app_data_dir=${hubProfile}` (default: `antigravity-obsidian`) to prevent state collisions with Antigravity IDE or standalone CLI sessions.
   - Profile names are strictly sanitized against path traversal using `/^[a-zA-Z0-9_-]+$/`.
   - Concurrent startup calls for the same profile are coalesced via `inFlightStart`, while cross-profile transitions are serialized via `startMutex`.
   - Credentials (`antigravity-oauth-token`) are synced to the profile directory with strict `0600` permissions.
   - Onboarding state (`agent_onboarding_completed: AGENT_ONBOARDING_STATE_COMPLETED`) is pre-seeded in `antigravity_state.pbtxt` to prevent route guard redirection to `/onboarding`.

2. **Project Auto-Registration & Collision Resistance**:
   - Vault projects are registered under `~/.gemini/config/projects/obsidian-${cleanName}-${hash}.json` linking `file://${vaultPath}`.
   - The 8-character SHA256 path hash guarantees distinct project configurations for different vaults with identical folder names.
   - Hub URLs explicitly specify `?section=${projectId}&hostTheme=${theme}` to ensure the correct workspace is loaded on boot.

3. **Task Execution & Permission Safety Gating**:
   - Discrete tasks execute via official `agy --print <prompt> --output-format stream-json --add-dir <vaultPath>`.
   - By default, tasks run in restricted approval mode (no `--dangerously-skip-permissions`). Headless execution auto-blocks dangerous commands/file deletions and reports `denied_actions`.
   - Autonomous execution requires enabling `allowUnrestrictedTasks`, passing an explicit `ConfirmModal` security warning, and displays a persistent warning banner on `ResultModal`.
   - Run lifecycles are bound to unique `runId` instances (`ActiveTaskRun`), preventing delayed `'exit'` events from corrupting consecutive tasks.

4. **Path Traversal Defense in Depth**:
   - Vault rules paths (`customRulesPath`) are validated via `resolveSafeRulesPath`, enforcing that the resolved path is strictly inside the vault boundary (`startsWith(vaultPath + path.sep)`). Traversal attempts fall back to `AGENTS.md` with an Obsidian `Notice`.
   - Prompt context paths (`filePath`, `folderPath`) are sanitized via `sanitizeContextPath` before string formatting.

5. **Strict Runtime Settings Validation**:
   - `validateSettings(raw)` sanitizes all persisted state on boot, guarding against manual corruption in `data.json` and falling back to typed defaults for invalid ports, profiles, or enums.

6. **Native Obsidian UI & Community Standards**:
   - 100% sentence case compliance across all UI strings, menus, and commands.
   - Declarative settings implementation via `getSettingDefinitions()` for Obsidian 1.13+ compatibility.
   - All styles scoped to CSS variables without `!important` or `:has()` selectors; `:focus-visible` focus outlines for accessibility.
   - No production logging: zero `console.*` calls in `src/`.

7. **Comprehensive Internationalization (i18n)**:
   - Native language detection via Obsidian `getLanguage()` with fallback to English.
   - Type-safe string catalog with parameter interpolation (`t(key, vars)`).
   - Dedicated locale definitions for English (`en`), Simplified Chinese (`zh-cn`), and Traditional Chinese (`zh-tw`).
   - Linted under `recommendedWithLocalesEn` with `obsidianmd/ui/sentence-case-locale-module` ensuring strict sentence-case compliance.

## Reference Documentation

- Detailed architecture, reverse engineering findings, and historical decisions are documented in [docs/ARCHITECTURE_AND_DEV_NOTES.md](./docs/ARCHITECTURE_AND_DEV_NOTES.md).
- Investigation of official Antigravity Hub contracts is documented in [docs/HUB_CAPABILITY_BOUNDARIES.md](./docs/HUB_CAPABILITY_BOUNDARIES.md).
- Historical audit and resolution tracking is documented in [docs/CODE_REVIEW_2026-09.md](./docs/CODE_REVIEW_2026-09.md).
