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
