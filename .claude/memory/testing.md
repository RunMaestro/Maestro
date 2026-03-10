# Testing

## Framework & Config

- **Vitest** with `jsdom` environment. Config: `vitest.config.mts`
- Globals enabled (`describe`, `it`, `expect` without imports)
- Alias: `@` → `./src`
- Timeouts: test 10s, hook 10s, teardown 5s
- Coverage: `v8` provider → `./coverage` (text, json, html)

## Test Location

```
src/__tests__/
├── cli/           # CLI command + service tests
├── main/          # Main process (agents, parsers, IPC handlers, preload)
├── renderer/      # React components, hooks, stores
├── shared/        # Shared utility tests
├── web/           # Web/mobile interface tests
├── integration/   # Real agent workflows (run separately)
├── performance/   # Perf regression tests (run separately)
├── e2e/           # Playwright E2E (run separately)
└── fixtures/      # Test data
```

## Run Commands

```bash
npm run test                # Unit tests only (CI)
npm run test:watch          # Watch mode
npm run test:coverage       # With coverage report
npm run test:integration    # Integration (180s timeout, sequential forks)
npm run test:performance    # Perf tests (30s timeout)
npm run test:e2e            # Playwright E2E (requires build first)
```

## IPC Mocking

`src/__tests__/setup.ts` (880+ lines) mocks the entire `window.maestro` API. Every IPC namespace is pre-mocked with `vi.fn()`. Reset mocks in `beforeEach` if needed.

```typescript
// Access mocks directly
(window.maestro.settings.get as any).mockResolvedValue('dark');
expect(window.maestro.process.spawn).toHaveBeenCalledWith(config);
```

## Key Mock Patterns

- **Lucide icons**: Proxy-based auto-mock (no per-icon mocking needed)
- **React Markdown**: Mocked to simple `<div>` wrapper
- **ResizeObserver/IntersectionObserver**: Stubbed globally
- **`window.matchMedia`**: Returns `matches: false` by default
- **Component rendering**: Wrap in `<LayerStackProvider>` when using modals

## Conventions

- One behavior per test, descriptive name
- `vi.mock()` for module mocking, `vi.spyOn()` for tracking
- Integration tests use `vitest.integration.config.ts` (forked, sequential)
- Tests excluded from ESLint (`src/__tests__/**` in eslint ignore)
- `react-hooks/exhaustive-deps` is OFF — use stable refs pattern
