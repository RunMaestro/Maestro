# Build System & CI/CD

## Tech Stack

| Technology | Version | Purpose |
|------------|---------|---------|
| Electron | 28.x | Desktop app shell |
| React | 18.x | UI framework |
| TypeScript | 5.x | Type safety |
| Vite | 5.x | Bundler (renderer + web) |
| Vitest | 4.x | Test framework |
| Tailwind CSS | 3.x | Utility-first styling |
| Zustand | 5.x | State management |
| node-pty | 1.x | Terminal emulation |
| better-sqlite3 | 12.x | Stats database |
| Fastify | 4.x | Web server (mobile remote) |
| Commander | 14.x | CLI framework |
| React Flow | 11.x | Document graph visualization |
| Recharts | 3.x | Usage dashboard charts |

## Build Sequence

```bash
npm run build
  → build:prompts    # .md → generated TypeScript
  → build:main       # tsc → dist/main (CommonJS)
  → build:preload    # esbuild → dist/main/preload.js
  → build:renderer   # vite → dist/renderer (ESM)
  → build:web        # vite → dist/web
  → build:cli        # esbuild → dist/cli
```

## TypeScript Configs (3 separate)

| Config | Module | Scope |
|--------|--------|-------|
| `tsconfig.main.json` | CommonJS | Main process + shared |
| `tsconfig.json` (root) | ESNext | Renderer + web + shared |
| `tsconfig.cli.json` | CommonJS | CLI + shared + prompts |

## CI Pipeline (`.github/workflows/ci.yml`)

**Job 1: Lint** — prettier check, eslint, tsc (all 3 configs)
**Job 2: Test** — vitest run (unit tests only)

Integration/E2E/performance tests NOT in CI (manual).

## Pre-commit Hooks

Husky + lint-staged:
- `*` → `prettier --write`
- `*.{js,ts,tsx,...}` → `eslint --fix`

Lightweight by design — heavy checks in CI.

## Packaging

```bash
npm run package          # All platforms
npm run package:mac      # macOS (.dmg, .zip) — x64 + arm64
npm run package:win      # Windows (.exe NSIS + portable)
npm run package:linux    # Linux (.AppImage, .deb, .rpm)
```

Output: `release/` directory. Auto-publish via GitHub Actions on tag push.

## Key Build Scripts (`scripts/`)

| Script | Purpose |
|--------|---------|
| `generate-prompts.mjs` | Compile .md prompts to TypeScript |
| `build-preload.mjs` | Bundle preload script with esbuild |
| `build-cli.mjs` | Bundle CLI with sourcemaps |
| `refresh-speckit.mjs` | Sync Spec-Kit prompts from GitHub |
| `refresh-openspec.mjs` | Sync OpenSpec prompts from Fission-AI |
| `set-version.mjs` | Update version across configs |
| `notarize.js` | macOS code signing post-build |

## Environment Flags

- `NODE_ENV=development` — dev mode
- `USE_PROD_DATA=1` — use production data dir in dev
- `MAESTRO_DEMO_DIR=<path>` — demo mode with fresh data
- `VITE_PORT=<port>` — custom dev server port (default 5173)
- `DISABLE_HMR=1` — disable hot module replacement
- `DEBUG_GROUP_CHAT=1` — enable group chat debug logging
