# README screenshots

These images are embedded by [`README.md`](../../README.md) and
[`README.zh-CN.md`](../../README.zh-CN.md). Keep both languages referencing the
same file names so the two documents do not drift.

## Current state

| File | Status |
| :--- | :--- |
| `hub-view-dark.png` | Captured from a live vault. |
| `settings-dark.png` | Captured from a live vault. |

The remaining views (task dialog, result dialog) have no screenshots yet. The
README describes them in prose only; add a capture with the naming scheme below
if a change needs one.

All captures so far are **dark theme only**. A reader on a light theme sees the
dark image. If you capture light variants, name them `*-light.png` and pair the
two references with GitHub's theme anchors:

```markdown
![Alt text](docs/images/hub-view-dark.png#gh-dark-mode-only)
![Alt text](docs/images/hub-view-light.png#gh-light-mode-only)
```

## Naming scheme

Use these names so no existing Markdown has to change:

| File | What to capture |
| :--- | :--- |
| `hub-view-{dark,light}.png` | The assistant web hub open in an Obsidian tab, with a response in progress so streaming thinking blocks and tool cards are visible. |
| `settings-{dark,light}.png` | **Settings → Antigravity**, scrolled so the hub, vault rules, and task security groups are all shown. |
| `task-modal-{dark,light}.png` | The task dialog from **Run task on active context**, with a context badge visible and preset chips in view. |
| `result-modal-{dark,light}.png` | A result dialog with rendered Markdown and the copy / append / create-note buttons visible. Capture the default restricted mode, not the unrestricted risk banner. |

Crop to the relevant window or panel rather than including the whole desktop, and
keep the window width consistent across shots so the set reads as one.

## Content rules

- **Use a scratch vault.** Never capture real notes; private titles, folder
  names, and vault paths would end up in a public repository.
- **Redact absolute paths** in the settings panel and the task dialog badge
  (`/home/you/...`), since those show the capture machine's directory layout.
- **No credentials or tokens.** Avoid any view where an OAuth token, profile
  directory listing, or account email could appear.
- Screenshots are reviewed on the same standards as code before a release that
  advertises the UI.

## Placeholder generation

[`scripts/make-placeholder-screenshots.sh`](../../scripts/make-placeholder-screenshots.sh)
regenerates the original placeholder set with ImageMagick. It writes **all eight**
file names and overwrites whatever is present, so do not run it once real
screenshots exist in this directory.
