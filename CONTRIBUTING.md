# Contributing to Obsidian Antigravity

Thank you for your interest in contributing to Obsidian Antigravity! We welcome bug reports, feature suggestions, documentation enhancements, and pull requests.

## Development Setup

1. **Clone the repository**:
   ```bash
   git clone https://github.com/kyc/obsidian-antigravity.git
   cd obsidian-antigravity
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Local development & watch mode**:
   ```bash
   npm run dev
   ```

4. **Verify quality gates**:
   Before submitting changes, ensure all tests, type checks, and lints pass:
   ```bash
   npm run typecheck && npm test && npm run build && npm run lint
   ```

## Code Quality & Standards

- **Strict Type Safety**: All TypeScript code must compile without errors under `strict: true`. Avoid `any` types and unnecessary type assertions.
- **ESLint & Sentence Case**: We enforce `eslint-plugin-obsidianmd` with `recommendedWithLocalesEn`. All English UI strings and locale modules must strictly adhere to sentence case.
- **Unit Tests**: Add Jest unit tests under `tests/unit/` mirroring `src/` files whenever introducing new logic or fixing bugs.
- **No Fluff & Zero Overhead**: The plugin maintains zero runtime external dependencies beyond `cross-spawn`.

## Screenshots

The READMEs embed screenshots from `docs/images/`, so both `README.md` and
`README.zh-CN.md` must reference the same file names.

If you change a view's layout or styling, refresh the affected screenshot. See
[docs/images/README.md](docs/images/README.md) for the naming scheme, capture
checklist, and content rules on avoiding real vault content and private paths.

## Pull Request Guidelines

1. Create a feature branch from `main`:
   ```bash
   git checkout -b feat/your-feature-name
   ```
2. Commit your changes following [Conventional Commits](https://www.conventionalcommits.org/):
   - `feat:` for new capabilities
   - `fix:` for bug fixes
   - `docs:` for documentation updates
   - `test:` for test additions/improvements
   - `refactor:` for internal restructuring
3. Ensure the test suite passes 100%.
4. Open a pull request against `main` with a clear description of the problem solved.
