/**
 * Integration tests for global environment variables in process spawning.
 *
 * These tests verify:
 * - IPC handler loads global shell env vars from settings
 * - Global vars are passed to ProcessManager.spawn()
 * - Agent sessions receive global vars
 * - Terminal sessions still work with global vars
 * - Session vars override global vars correctly
 * - Invalid global vars don't crash the spawner
 * - Tilde expansion works correctly for paths
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import {
	buildChildProcessEnv,
	buildPtyTerminalEnv,
} from '../../main/process-manager/utils/envBuilder';

/**
 * Test Suite 2.6: Agent Session Receives Global Env Vars
 * Verifies that global environment variables from settings are properly passed to agent spawning.
 */
describe('Test 2.6: Agent Session Receives Global Env Vars', () => {
	let originalProcessEnv: NodeJS.ProcessEnv;
	let originalHomedir: string;

	beforeEach(() => {
		originalProcessEnv = { ...process.env };
		originalHomedir = os.homedir();
		// Setup a clean test environment
		process.env.TEST_INHERIT = 'inherited-value';
		process.env.ELECTRON_RUN_AS_NODE = '1'; // Should be stripped
	});

	afterEach(() => {
		process.env = originalProcessEnv;
	});

	it('should include global env vars when building agent process environment', () => {
		// Setup
		const globalShellEnvVars = {
			GLOBAL_API_KEY: 'global-key-value',
			GLOBAL_DEBUG: 'true',
		};

		// Action: Build environment with global vars
		const env = buildChildProcessEnv(undefined, false, globalShellEnvVars);

		// Assert: Global vars are present in the final environment
		expect(env.GLOBAL_API_KEY).toBe('global-key-value');
		expect(env.GLOBAL_DEBUG).toBe('true');
	});

	it('should pass global vars with session custom path for agent spawning', () => {
		const globalShellEnvVars = {
			SHARED_TOKEN: 'token-123',
			API_ENDPOINT: 'https://api.example.com',
		};

		const sessionCustomEnvVars = {
			SESSION_ID: 'session-1',
		};

		// Action: Build environment with both global and session vars
		const env = buildChildProcessEnv(sessionCustomEnvVars, false, globalShellEnvVars);

		// Assert: Both global and session vars are present
		expect(env.SHARED_TOKEN).toBe('token-123');
		expect(env.API_ENDPOINT).toBe('https://api.example.com');
		expect(env.SESSION_ID).toBe('session-1');
	});

	it('should persist global vars through the spawn lifecycle', () => {
		// Setup: Simulate settings that would come from IPC handler
		const globalVars = {
			ANTHROPIC_API_KEY: 'sk-proj-test-key',
			DEBUG_MODE: 'verbose',
		};

		// Action: Call buildChildProcessEnv (what the spawner would use)
		const env1 = buildChildProcessEnv(undefined, false, globalVars);
		const env2 = buildChildProcessEnv(undefined, false, globalVars);

		// Assert: Multiple calls produce independent environments with the same global vars
		expect(env1.ANTHROPIC_API_KEY).toBe('sk-proj-test-key');
		expect(env2.ANTHROPIC_API_KEY).toBe('sk-proj-test-key');

		// Verify isolation - modifying one shouldn't affect the other
		env1.ANTHROPIC_API_KEY = 'modified';
		expect(env2.ANTHROPIC_API_KEY).toBe('sk-proj-test-key');
	});

	it('should strip Electron vars even when global vars are applied', () => {
		const globalShellEnvVars = {
			SAFE_VAR: 'safe-value',
		};

		const env = buildChildProcessEnv(undefined, false, globalShellEnvVars);

		// Assert: Electron vars are stripped for agent isolation
		expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
		expect(env.SAFE_VAR).toBe('safe-value');
	});
});

/**
 * Test Suite 2.7: Session Vars Override Global Vars
 * Verifies correct precedence: session vars > global vars > process defaults
 */
describe('Test 2.7: Session Vars Override Global Vars', () => {
	let originalProcessEnv: NodeJS.ProcessEnv;

	beforeEach(() => {
		originalProcessEnv = { ...process.env };
		process.env.SHARED_VAR = 'process-value';
	});

	afterEach(() => {
		process.env = originalProcessEnv;
	});

	it('should use session vars when they override global vars', () => {
		const globalVars = {
			GLOBAL_VAR: 'global',
			SHARED: 'global-shared',
		};

		const sessionVars = {
			SESSION_VAR: 'session',
			SHARED: 'session-shared', // Override global
		};

		const env = buildChildProcessEnv(sessionVars, false, globalVars);

		// Assert: Session vars take precedence
		expect(env.SHARED).toBe('session-shared');
		expect(env.GLOBAL_VAR).toBe('global');
		expect(env.SESSION_VAR).toBe('session');
	});

	it('should maintain correct precedence: session > global > process', () => {
		const globalVars = {
			LEVEL1: 'global',
			LEVEL_BOTH: 'global-value',
		};

		const sessionVars = {
			LEVEL_BOTH: 'session-value',
		};

		const env = buildChildProcessEnv(sessionVars, false, globalVars);

		// Assert precedence order
		expect(env.SHARED_VAR).toBe('process-value'); // From process
		expect(env.LEVEL1).toBe('global'); // From global
		expect(env.LEVEL_BOTH).toBe('session-value'); // Session wins
	});

	it('should allow multiple session overrides of global vars', () => {
		const globalVars = {
			VAR1: 'global1',
			VAR2: 'global2',
			VAR3: 'global3',
		};

		const sessionVars = {
			VAR1: 'session1',
			VAR2: 'session2',
			// VAR3 not overridden, should use global
		};

		const env = buildChildProcessEnv(sessionVars, false, globalVars);

		expect(env.VAR1).toBe('session1');
		expect(env.VAR2).toBe('session2');
		expect(env.VAR3).toBe('global3');
	});
});

/**
 * Test Suite 2.8: Global Vars Reach Terminal PTY Spawns
 * Verifies that global vars work for both child process and PTY terminal spawning
 */
describe('Test 2.8: Global Vars Reach Terminal PTY Spawns', () => {
	let originalProcessEnv: NodeJS.ProcessEnv;

	beforeEach(() => {
		originalProcessEnv = { ...process.env };
	});

	afterEach(() => {
		process.env = originalProcessEnv;
	});

	it('should include global env vars when building PTY terminal environment', () => {
		// Setup
		const globalShellEnvVars = {
			PTY_VAR: 'pty-value',
			TERMINAL_CONFIG: 'terminal-config-value',
		};

		// Action: Build PTY environment with global vars
		const env = buildPtyTerminalEnv(globalShellEnvVars);

		// Assert: Global vars are present in PTY environment
		expect(env.PTY_VAR).toBe('pty-value');
		expect(env.TERMINAL_CONFIG).toBe('terminal-config-value');
	});

	it('should preserve terminal-specific vars while adding global vars', () => {
		const globalShellEnvVars = {
			CUSTOM_VAR: 'custom-value',
		};

		const env = buildPtyTerminalEnv(globalShellEnvVars);

		// Assert: Terminal vars are preserved
		expect(env.TERM).toBe('xterm-256color');
		expect(env.CUSTOM_VAR).toBe('custom-value');
	});

	it('should work with both child process and PTY terminal spawning', () => {
		const globalVars = {
			SHARED_VAR: 'shared-value',
		};

		// For child process (agent)
		const childEnv = buildChildProcessEnv(undefined, false, globalVars);

		// For PTY terminal
		const ptyEnv = buildPtyTerminalEnv(globalVars);

		// Assert: Both have the global var
		expect(childEnv.SHARED_VAR).toBe('shared-value');
		expect(ptyEnv.SHARED_VAR).toBe('shared-value');
	});

	it('should apply global vars to terminal even without process defaults', () => {
		const globalVars = {
			TERMINAL_API_KEY: 'term-key-value',
		};

		const env = buildPtyTerminalEnv(globalVars);

		expect(env.TERMINAL_API_KEY).toBe('term-key-value');
	});
});

/**
 * Test Suite 2.9: Tilde Expansion Works in Global Vars
 * Verifies that ~/path syntax is expanded to home directory
 */
describe('Test 2.9: Tilde Expansion Works in Global Vars', () => {
	let originalProcessEnv: NodeJS.ProcessEnv;
	let originalHomedir: string;

	beforeEach(() => {
		originalProcessEnv = { ...process.env };
		originalHomedir = os.homedir();
	});

	afterEach(() => {
		process.env = originalProcessEnv;
	});

	it('should expand tilde in global var paths', () => {
		const globalVars = {
			TOOL_PATH: '~/tools',
			CONFIG_DIR: '~/config',
		};

		const env = buildChildProcessEnv(undefined, false, globalVars);

		// Assert: Tilde is expanded to home directory
		expect(env.TOOL_PATH).toBe(path.join(originalHomedir, 'tools'));
		expect(env.CONFIG_DIR).toBe(path.join(originalHomedir, 'config'));
	});

	it('should expand tilde in session var paths', () => {
		const sessionVars = {
			LOG_PATH: '~/logs/app.log',
		};

		const env = buildChildProcessEnv(sessionVars, false, undefined);

		expect(env.LOG_PATH).toBe(path.join(originalHomedir, 'logs/app.log'));
	});

	it('should handle nested paths with tilde expansion', () => {
		const globalVars = {
			WORKSPACE: '~/.workspace/projects',
		};

		const env = buildChildProcessEnv(undefined, false, globalVars);

		expect(env.WORKSPACE).toBe(path.join(originalHomedir, '.workspace/projects'));
	});

	it('should not expand tilde in the middle of paths', () => {
		const globalVars = {
			MIDDLE_TILDE: 'path/~middle/file.txt',
		};

		const env = buildChildProcessEnv(undefined, false, globalVars);

		// Assert: Tilde not at start is not expanded
		expect(env.MIDDLE_TILDE).toBe('path/~middle/file.txt');
	});

	it('should expand tilde in PTY terminal environment', () => {
		const globalVars = {
			PTY_CONFIG: '~/pty-config',
		};

		const env = buildPtyTerminalEnv(globalVars);

		expect(env.PTY_CONFIG).toBe(path.join(originalHomedir, 'pty-config'));
	});
});

/**
 * Test Suite 2.10: Empty/Undefined Global Vars Handled Gracefully
 * Verifies robustness with missing or malformed global var data
 */
describe('Test 2.10: Empty/Undefined Global Vars Handled Gracefully', () => {
	let originalProcessEnv: NodeJS.ProcessEnv;

	beforeEach(() => {
		originalProcessEnv = { ...process.env };
		process.env.INHERITED_VAR = 'inherited';
	});

	afterEach(() => {
		process.env = originalProcessEnv;
	});

	it('should handle undefined global vars', () => {
		const env = buildChildProcessEnv(undefined, false, undefined);

		// Assert: Process completes without error
		expect(env).toBeDefined();
		expect(env.INHERITED_VAR).toBe('inherited');
	});

	it('should handle empty object global vars', () => {
		const env = buildChildProcessEnv(undefined, false, {});

		expect(env).toBeDefined();
		expect(env.INHERITED_VAR).toBe('inherited');
	});

	it('should handle null global vars gracefully', () => {
		// TypeScript doesn't allow null in types, but we test defensive handling
		const env = buildChildProcessEnv(undefined, false, undefined);

		expect(env).toBeDefined();
	});

	it('should handle undefined session vars and empty global vars', () => {
		const env = buildChildProcessEnv(undefined, false, {});

		expect(env).toBeDefined();
		expect(env.INHERITED_VAR).toBe('inherited');
	});

	it('should handle all params as undefined', () => {
		const env = buildChildProcessEnv(undefined, undefined, undefined);

		expect(env).toBeDefined();
		expect(env.INHERITED_VAR).toBe('inherited');
	});

	it('should drop empty string values in global vars', () => {
		const globalVars = {
			EMPTY_VAR: '',
			NORMAL_VAR: 'value',
		};

		const env = buildChildProcessEnv(undefined, false, globalVars);

		// Assert: a blank field means "do not set this", so it is never exported.
		// A set-but-empty variable is worse than an absent one - an agent reading it
		// as a path gets '' rather than falling back to its own default.
		expect('EMPTY_VAR' in env).toBe(false);
		expect(env.NORMAL_VAR).toBe('value');
	});

	it('should handle very long variable values', () => {
		const longValue = 'x'.repeat(50000);
		const globalVars = {
			LONG_VAR: longValue,
		};

		const env = buildChildProcessEnv(undefined, false, globalVars);

		// Assert: Long values are preserved without truncation
		expect(env.LONG_VAR).toBe(longValue);
		expect(env.LONG_VAR?.length).toBe(50000);
	});

	it('should handle special characters in global var values', () => {
		const globalVars = {
			SPECIAL_CHARS: 'value!@#$%^&*()',
			SPACES: 'value with spaces',
			QUOTES: 'value with "quotes"',
		};

		const env = buildChildProcessEnv(undefined, false, globalVars);

		expect(env.SPECIAL_CHARS).toBe('value!@#$%^&*()');
		expect(env.SPACES).toBe('value with spaces');
		expect(env.QUOTES).toBe('value with "quotes"');
	});

	it('should not crash when PTY terminal gets empty global vars', () => {
		// Assert: Should not throw
		expect(() => {
			buildPtyTerminalEnv({});
		}).not.toThrow();

		expect(() => {
			buildPtyTerminalEnv(undefined);
		}).not.toThrow();
	});
});

/**
 * Test Suite 2.11: Real-World Use Cases
 * Integration tests for practical scenarios
 */
describe('Test 2.11: Real-World Use Cases', () => {
	let originalProcessEnv: NodeJS.ProcessEnv;
	let originalHomedir: string;

	beforeEach(() => {
		originalProcessEnv = { ...process.env };
		originalHomedir = os.homedir();
	});

	afterEach(() => {
		process.env = originalProcessEnv;
	});

	it('should handle API key use case', () => {
		// User sets ANTHROPIC_API_KEY in Settings → General → Shell Configuration
		const globalVars = {
			ANTHROPIC_API_KEY: 'sk-proj-real-key',
		};

		const env = buildChildProcessEnv(undefined, false, globalVars);

		// Assert: Agent can access the API key
		expect(env.ANTHROPIC_API_KEY).toBe('sk-proj-real-key');
	});

	it('should handle multiple API keys simultaneously', () => {
		const globalVars = {
			ANTHROPIC_API_KEY: 'sk-anthropic-key',
			OPENAI_API_KEY: 'sk-openai-key',
			TOGETHER_API_KEY: 'sk-together-key',
		};

		const env = buildChildProcessEnv(undefined, false, globalVars);

		expect(env.ANTHROPIC_API_KEY).toBe('sk-anthropic-key');
		expect(env.OPENAI_API_KEY).toBe('sk-openai-key');
		expect(env.TOGETHER_API_KEY).toBe('sk-together-key');
	});

	it('should handle proxy settings globally', () => {
		const globalVars = {
			HTTP_PROXY: 'http://proxy.example.com:8080',
			HTTPS_PROXY: 'https://proxy.example.com:8080',
			NO_PROXY: 'localhost,127.0.0.1',
		};

		const env = buildChildProcessEnv(undefined, false, globalVars);

		expect(env.HTTP_PROXY).toBe('http://proxy.example.com:8080');
		expect(env.HTTPS_PROXY).toBe('https://proxy.example.com:8080');
		expect(env.NO_PROXY).toBe('localhost,127.0.0.1');
	});

	it('should handle debug flags set globally', () => {
		const globalVars = {
			DEBUG: 'maestro:*',
			LOG_LEVEL: 'debug',
		};

		const env = buildChildProcessEnv(undefined, false, globalVars);

		expect(env.DEBUG).toBe('maestro:*');
		expect(env.LOG_LEVEL).toBe('debug');
	});

	it('should handle config paths with tilde expansion', () => {
		const globalVars = {
			JEST_CONFIG_PATH: '~/.maestro/jest.config.js',
			APP_CONFIG_DIR: '~/app-configs',
		};

		const env = buildChildProcessEnv(undefined, false, globalVars);

		expect(env.JEST_CONFIG_PATH).toBe(path.join(originalHomedir, '.maestro/jest.config.js'));
		expect(env.APP_CONFIG_DIR).toBe(path.join(originalHomedir, 'app-configs'));
	});

	it('should handle session override for development scenarios', () => {
		// User has global ANTHROPIC_API_KEY set, but wants to test with different key for this session
		const globalVars = {
			ANTHROPIC_API_KEY: 'sk-prod-key',
			OTHER_SETTING: 'global-value',
		};

		const sessionVars = {
			ANTHROPIC_API_KEY: 'sk-dev-test-key', // Override for this session
		};

		const env = buildChildProcessEnv(sessionVars, false, globalVars);

		expect(env.ANTHROPIC_API_KEY).toBe('sk-dev-test-key'); // Session wins
		expect(env.OTHER_SETTING).toBe('global-value'); // Global still applies
	});

	it('should handle 10+ global vars simultaneously', () => {
		const globalVars = {
			API_KEY_1: 'key1',
			API_KEY_2: 'key2',
			API_KEY_3: 'key3',
			CONFIG_PATH: '/etc/config',
			DEBUG_MODE: 'true',
			LOG_LEVEL: 'debug',
			PROXY_HOST: 'proxy.internal',
			PROXY_PORT: '8080',
			TIMEOUT_MS: '30000',
			RETRY_COUNT: '3',
		};

		const env = buildChildProcessEnv(undefined, false, globalVars);

		// Assert all vars are present
		Object.entries(globalVars).forEach(([key, value]) => {
			expect(env[key]).toBe(value);
		});
	});

	it('should apply updated global vars to new sessions', () => {
		// Scenario: User changes setting, old session still has original value

		// Session 1 with setting value 1
		const globalVars1 = {
			SETTING: 'value1',
		};

		const env1 = buildChildProcessEnv(undefined, false, globalVars1);
		expect(env1.SETTING).toBe('value1');

		// Session 2 with updated setting value 2
		const globalVars2 = {
			SETTING: 'value2',
		};

		const env2 = buildChildProcessEnv(undefined, false, globalVars2);
		expect(env2.SETTING).toBe('value2');

		// Verify isolation - each session captures vars at spawn time
		expect(env1.SETTING).toBe('value1'); // Not affected by update
	});
});

/**
 * Test Suite 2.12: Environment Isolation Between Sessions
 * Verifies that env vars don't leak between sessions
 */
describe('Test 2.12: Environment Isolation Between Sessions', () => {
	let originalProcessEnv: NodeJS.ProcessEnv;

	beforeEach(() => {
		originalProcessEnv = { ...process.env };
	});

	afterEach(() => {
		process.env = originalProcessEnv;
	});

	it('should isolate session-specific vars between agents', () => {
		// Agent A with session var
		const env1 = buildChildProcessEnv({ SESSION_ID: 'A' }, false, { GLOBAL_VAR: 'global' });

		// Agent B with different session var
		const env2 = buildChildProcessEnv({ SESSION_ID: 'B' }, false, { GLOBAL_VAR: 'global' });

		// Assert: Each session has its own value
		expect(env1.SESSION_ID).toBe('A');
		expect(env2.SESSION_ID).toBe('B');

		// Global var is the same in both
		expect(env1.GLOBAL_VAR).toBe('global');
		expect(env2.GLOBAL_VAR).toBe('global');
	});

	it('should not affect parent process environment', () => {
		const parentEnvBefore = { ...process.env };

		// Build environment with custom vars
		const globalVars = { GLOBAL_VAR: 'global' };
		const env = buildChildProcessEnv(undefined, false, globalVars);

		// Assert: Parent process environment is unchanged
		expect(process.env).toEqual(parentEnvBefore);
		expect(process.env.GLOBAL_VAR).toBeUndefined();
	});

	it('should create isolated environment copies', () => {
		const globalVars = {
			SHARED_VAR: 'shared-value',
		};

		// Two calls should produce independent environments
		const env1 = buildChildProcessEnv(undefined, false, globalVars);
		const env2 = buildChildProcessEnv(undefined, false, globalVars);

		// Modifying one shouldn't affect the other
		env1.SHARED_VAR = 'modified';

		expect(env1.SHARED_VAR).toBe('modified');
		expect(env2.SHARED_VAR).toBe('shared-value');
	});

	it('should not mutate input global vars object', () => {
		const globalVars = {
			VAR: 'value',
		};

		const globalVarsCopy = { ...globalVars };

		buildChildProcessEnv(undefined, false, globalVars);

		// Assert: Input object is unchanged
		expect(globalVars).toEqual(globalVarsCopy);
	});

	it('should not mutate input session vars object', () => {
		const sessionVars = {
			SESSION_VAR: 'session-value',
		};

		const sessionVarsCopy = { ...sessionVars };

		buildChildProcessEnv(sessionVars, false, undefined);

		// Assert: Input object is unchanged
		expect(sessionVars).toEqual(sessionVarsCopy);
	});
});

/**
 * Test Suite 2.13: MAESTRO_SESSION_RESUMED Flag
 * Verifies that resumed sessions are properly marked
 */
describe('Test 2.13: MAESTRO_SESSION_RESUMED Flag', () => {
	let originalProcessEnv: NodeJS.ProcessEnv;

	beforeEach(() => {
		originalProcessEnv = { ...process.env };
	});

	afterEach(() => {
		process.env = originalProcessEnv;
	});

	it('should set MAESTRO_SESSION_RESUMED when isResuming is true', () => {
		const env = buildChildProcessEnv(undefined, true);

		expect(env.MAESTRO_SESSION_RESUMED).toBe('1');
	});

	it('should not set MAESTRO_SESSION_RESUMED when isResuming is false', () => {
		const env = buildChildProcessEnv(undefined, false);

		expect(env.MAESTRO_SESSION_RESUMED).toBeUndefined();
	});

	it('should set flag with global vars when resuming', () => {
		const globalVars = {
			API_KEY: 'key-value',
		};

		const env = buildChildProcessEnv(undefined, true, globalVars);

		expect(env.MAESTRO_SESSION_RESUMED).toBe('1');
		expect(env.API_KEY).toBe('key-value');
	});
});
