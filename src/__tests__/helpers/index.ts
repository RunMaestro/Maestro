/**
 * Barrel export for shared test helpers.
 *
 * Import from here in tests to avoid duplicating factory definitions
 * across many test files.
 */

export { isolateAgentEnv, SHELL_OVERRIDABLE_AGENT_ENV_KEYS } from './agentEnvIsolation';
export { createMockAITab, createMockFileTab } from './mockTab';
export { createMockSession } from './mockSession';
export { installLocalStorageMock } from './mockLocalStorage';
export { markdownEditorModuleMock } from './mockMarkdownEditor';

// NOT re-exported: `./nodeSqlite`. It imports `node:sqlite` at module scope, and
// the suite runs under `environment: 'jsdom'`, where vite refuses to bundle a
// Node built-in. Re-exporting it from this barrel dragged that import into every
// jsdom test file that pulls anything from here, and those files failed to LOAD -
// which vitest reports as failed FILES with a passing TEST count, so CI read
// "37,268 passed" while it was red. The one suite that needs real SQLite
// (`main/cue/cue-history-query.test.ts`) imports `./nodeSqlite` directly and
// declares `@vitest-environment node`. Keep it that way.
