/**
 * Isolate a test suite from agent env vars the developer's own shell exports.
 *
 * Agent defaults in `definitions.ts` (`defaultEnvVars`, `batchModeEnvVars`) now
 * override an inherited value (`buildAgentEnvironment`'s layer order), but the
 * spawners and parsers still read these names straight from `process.env` in
 * places, and a test that exercises an inherited value sets it itself. Without
 * isolation an assertion about the DEFAULT can silently become an assertion
 * about whatever the runner's shell happened to export, and it fails on that
 * machine only.
 *
 * This is not hypothetical. Claude Code exports
 * `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=0` into the shells it runs, so the two
 * tests asserting the `'1'` default fail for anyone running the suite from a
 * Maestro terminal or an agent shell, and pass in CI. That reads as a real
 * regression and blocks the pre-push hook on a phantom failure.
 *
 * Call `isolateAgentEnv()` in the body of any `describe` that asserts a DEFAULT
 * env value - it registers its own `beforeEach` / `afterEach`, so it must run at
 * collection time rather than inside another hook. A test that deliberately
 * exercises an inherited value sets the variable inside its own body, after the
 * `beforeEach` has run, so it is unaffected.
 *
 * Usage:
 *
 *   import { isolateAgentEnv } from '../../helpers/agentEnvIsolation';
 *
 *   describe('spawnAgent', () => {
 *     isolateAgentEnv();
 *     ...
 *   });
 */

import { beforeEach, afterEach } from 'vitest';

/**
 * Env vars an agent definition supplies a default for, which the runner's own
 * shell commonly exports too. Keep in sync with `defaultEnvVars`
 * / `batchModeEnvVars` / `readOnlyEnvOverrides` in `src/main/agents/definitions.ts`.
 */
export const SHELL_OVERRIDABLE_AGENT_ENV_KEYS = [
	'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS',
	'OPENCODE_CONFIG_CONTENT',
] as const;

/**
 * Delete every such agent env var before each test in the enclosing
 * suite, so assertions see the agent definition's own default rather than the
 * developer's shell, and restore the real values afterwards.
 */
export function isolateAgentEnv(keys: readonly string[] = SHELL_OVERRIDABLE_AGENT_ENV_KEYS): void {
	const saved = new Map<string, string | undefined>();

	beforeEach(() => {
		saved.clear();
		for (const key of keys) {
			saved.set(key, process.env[key]);
			delete process.env[key];
		}
	});

	afterEach(() => {
		for (const [key, value] of saved) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
		saved.clear();
	});
}
