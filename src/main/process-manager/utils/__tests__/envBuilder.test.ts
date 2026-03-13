/**
 * Tests for the envBuilder module with global environment variable support.
 *
 * This test suite verifies:
 * - Environment variable precedence (session > global > process)
 * - Global env vars properly merge with process environment
 * - Session-level vars override global vars
 * - Special Electron variables are stripped
 * - Tilde paths (~/) are expanded correctly
 * - Empty and undefined inputs don't break functionality
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildChildProcessEnv, buildPtyTerminalEnv } from '../envBuilder';

describe('envBuilder - Global Environment Variables', () => {
	let originalProcessEnv: NodeJS.ProcessEnv;
	let originalHomedir: string;

	beforeEach(() => {
		// Save original environment
		originalProcessEnv = { ...process.env };
		originalHomedir = os.homedir();

		// Setup test environment
		process.env.TEST_INHERIT_VAR = 'inherited';
		process.env.CUSTOM_API_KEY = 'process-value';
		process.env.ELECTRON_RUN_AS_NODE = '1'; // This should be stripped
		process.env.NODE_ENV = 'test'; // This should be stripped
		process.env.PATH = '/usr/bin:/usr/local/bin';
	});

	afterEach(() => {
		// Restore original environment
		process.env = originalProcessEnv;
	});

	describe('Test 2.1: Global Env Vars Override Process Environment', () => {
		it('should override process environment variables with global vars', () => {
			const globalVars = {
				CUSTOM_API_KEY: 'global-value',
				NEW_GLOBAL_VAR: 'global-new',
			};

			const env = buildChildProcessEnv(undefined, false, globalVars);

			expect(env.CUSTOM_API_KEY).toBe('global-value');
			expect(env.NEW_GLOBAL_VAR).toBe('global-new');
		});

		it('should preserve process vars not in global vars', () => {
			const globalVars = {
				CUSTOM_API_KEY: 'global-value',
			};

			const env = buildChildProcessEnv(undefined, false, globalVars);

			expect(env.TEST_INHERIT_VAR).toBe('inherited');
			expect(env.CUSTOM_API_KEY).toBe('global-value');
		});

		it('should strip Electron variables even when inherited', () => {
			const globalVars = {
				SAFE_VAR: 'safe-value',
			};

			const env = buildChildProcessEnv(undefined, false, globalVars);

			expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
			expect(env.NODE_ENV).toBeUndefined();
			expect(env.SAFE_VAR).toBe('safe-value');
		});
	});

	describe('Test 2.2: Session-Level Vars Override Global Vars', () => {
		it('should give session vars higher priority than global vars', () => {
			const globalVars = {
				API_KEY: 'global',
				DEBUG_MODE: 'off',
			};

			const sessionVars = {
				API_KEY: 'session',
			};

			const env = buildChildProcessEnv(sessionVars, false, globalVars);

			expect(env.API_KEY).toBe('session');
			expect(env.DEBUG_MODE).toBe('off');
		});

		it('should allow session vars to completely override global vars', () => {
			const globalVars = {
				MULTIPLE_VARS: 'global-value-1',
			};

			const sessionVars = {
				MULTIPLE_VARS: 'session-value-2',
			};

			const env = buildChildProcessEnv(sessionVars, false, globalVars);

			expect(env.MULTIPLE_VARS).toBe('session-value-2');
		});

		it('should preserve global vars when not overridden by session vars', () => {
			const globalVars = {
				GLOBAL_ONLY: 'global',
				BOTH: 'global-both',
			};

			const sessionVars = {
				SESSION_ONLY: 'session',
				BOTH: 'session-both',
			};

			const env = buildChildProcessEnv(sessionVars, false, globalVars);

			expect(env.GLOBAL_ONLY).toBe('global');
			expect(env.SESSION_ONLY).toBe('session');
			expect(env.BOTH).toBe('session-both');
		});
	});

	describe("Test 2.3: Agent Config Defaults Don't Break Global Vars", () => {
		it('should apply both agent defaults and global vars together', () => {
			// Simulate agent config having a default NODE_ENV that gets stripped
			process.env.NODE_ENV = 'development'; // This will be stripped
			process.env.AGENT_CONFIG_VAR = 'agent-default';

			const globalVars = {
				API_KEY: 'global',
				ANOTHER_VAR: 'another-value',
			};

			const env = buildChildProcessEnv(undefined, false, globalVars);

			expect(env.API_KEY).toBe('global');
			expect(env.ANOTHER_VAR).toBe('another-value');
			expect(env.NODE_ENV).toBeUndefined(); // Stripped by design
			expect(env.AGENT_CONFIG_VAR).toBe('agent-default'); // Inherited if not stripped
		});

		it('should work with mixed inherited, global, and session vars', () => {
			// Process env has INHERITED_VAR
			process.env.INHERITED_VAR = 'from-process';

			const globalVars = {
				GLOBAL_VAR: 'global',
			};

			const sessionVars = {
				SESSION_VAR: 'session',
			};

			const env = buildChildProcessEnv(sessionVars, false, globalVars);

			expect(env.INHERITED_VAR).toBe('from-process');
			expect(env.GLOBAL_VAR).toBe('global');
			expect(env.SESSION_VAR).toBe('session');
		});
	});

	describe("Test 2.4: Empty Global Vars Don't Break Functionality", () => {
		it('should handle undefined global vars', () => {
			const env = buildChildProcessEnv(undefined, false, undefined);

			expect(env).toBeDefined();
			expect(env.TEST_INHERIT_VAR).toBe('inherited');
		});

		it('should handle empty object global vars', () => {
			const env = buildChildProcessEnv(undefined, false, {});

			expect(env).toBeDefined();
			expect(env.TEST_INHERIT_VAR).toBe('inherited');
		});

		it('should work with undefined session vars and empty global vars', () => {
			const env = buildChildProcessEnv(undefined, false, {});

			expect(env.TEST_INHERIT_VAR).toBe('inherited');
		});

		it('should handle all params as undefined', () => {
			const env = buildChildProcessEnv(undefined, undefined, undefined);

			expect(env).toBeDefined();
			expect(env.TEST_INHERIT_VAR).toBe('inherited');
		});
	});

	describe('Test 2.5: Special Electron Variables Are Preserved or Stripped', () => {
		it('should strip all Electron-related variables', () => {
			process.env.ELECTRON_RUN_AS_NODE = '1';
			process.env.ELECTRON_NO_ASAR = '1';
			process.env.ELECTRON_EXTRA_LAUNCH_ARGS = '--enable-features=something';
			process.env.CLAUDECODE = 'true';
			process.env.CLAUDE_CODE_ENTRYPOINT = '/path/to/entrypoint';
			process.env.CLAUDE_AGENT_SDK_VERSION = '1.0.0';
			process.env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING = 'true';

			const env = buildChildProcessEnv();

			expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
			expect(env.ELECTRON_NO_ASAR).toBeUndefined();
			expect(env.ELECTRON_EXTRA_LAUNCH_ARGS).toBeUndefined();
			expect(env.CLAUDECODE).toBeUndefined();
			expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
			expect(env.CLAUDE_AGENT_SDK_VERSION).toBeUndefined();
			expect(env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING).toBeUndefined();
		});

		it('should preserve non-Electron variables from process env', () => {
			process.env.PATH = '/usr/bin:/usr/local/bin';
			process.env.HOME = '/home/testuser';
			process.env.SHELL = '/bin/bash';

			const env = buildChildProcessEnv();

			expect(env.PATH).toBeDefined();
			expect(env.HOME).toBe('/home/testuser');
			expect(env.SHELL).toBe('/bin/bash');
		});

		it('should allow global vars to override even though Electron vars are stripped', () => {
			process.env.ELECTRON_RUN_AS_NODE = '1';

			const globalVars = {
				API_KEY: 'global-key',
			};

			const env = buildChildProcessEnv(undefined, false, globalVars);

			expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
			expect(env.API_KEY).toBe('global-key');
		});
	});

	describe('Test 2.5a: Tilde Path Expansion in Global Vars', () => {
		it('should expand ~ in global var paths', () => {
			const globalVars = {
				CONFIG_PATH: '~/config/app.json',
				NORMAL_VAR: 'normal-value',
			};

			const env = buildChildProcessEnv(undefined, false, globalVars);

			expect(env.CONFIG_PATH).toBe(path.join(originalHomedir, 'config/app.json'));
			expect(env.NORMAL_VAR).toBe('normal-value');
		});

		it('should expand ~ in session var paths', () => {
			const sessionVars = {
				LOG_PATH: '~/logs/app.log',
			};

			const env = buildChildProcessEnv(sessionVars, false, undefined);

			expect(env.LOG_PATH).toBe(path.join(originalHomedir, 'logs/app.log'));
		});

		it('should not expand ~ in the middle of paths', () => {
			const globalVars = {
				MIDDLE_TILDE: 'path/~middle/file.txt',
			};

			const env = buildChildProcessEnv(undefined, false, globalVars);

			// Should not be expanded since ~ is not at start
			expect(env.MIDDLE_TILDE).toBe('path/~middle/file.txt');
		});
	});

	describe('Test 2.5b: MAESTRO_SESSION_RESUMED Flag', () => {
		it('should set MAESTRO_SESSION_RESUMED when isResuming is true', () => {
			const env = buildChildProcessEnv(undefined, true);

			expect(env.MAESTRO_SESSION_RESUMED).toBe('1');
		});

		it('should not set MAESTRO_SESSION_RESUMED when isResuming is false', () => {
			const env = buildChildProcessEnv(undefined, false);

			expect(env.MAESTRO_SESSION_RESUMED).toBeUndefined();
		});

		it('should not set MAESTRO_SESSION_RESUMED when isResuming is undefined', () => {
			const env = buildChildProcessEnv(undefined, undefined);

			expect(env.MAESTRO_SESSION_RESUMED).toBeUndefined();
		});
	});

	describe('Test 2.5c: PATH Handling', () => {
		it('should set PATH to expanded path', () => {
			const env = buildChildProcessEnv();

			// PATH should be set and not be the original process PATH
			expect(env.PATH).toBeDefined();
			expect(typeof env.PATH).toBe('string');
			// The actual value depends on the system, but it should exist
			expect((env.PATH as string).length).toBeGreaterThan(0);
		});

		it('should include detected Node version manager bins in PATH', () => {
			const originalPlatform = process.platform;
			Object.defineProperty(process, 'platform', { value: 'darwin' });
			const originalNvmDir = process.env.NVM_DIR;
			const tempNvmDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-nvm-'));
			process.env.NVM_DIR = tempNvmDir;
			fs.mkdirSync(path.join(tempNvmDir, 'current', 'bin'), { recursive: true });
			fs.mkdirSync(path.join(tempNvmDir, 'versions', 'node', 'v22.10.0', 'bin'), {
				recursive: true,
			});

			try {
				const env = buildChildProcessEnv();
				const pathParts = env.PATH?.split(path.delimiter) || [];
				const currentBin = path.join(tempNvmDir, 'current', 'bin');
				const versionedBin = path.join(tempNvmDir, 'versions', 'node', 'v22.10.0', 'bin');

				expect(pathParts[0]).toBe(currentBin);
				expect(pathParts).toContain(versionedBin);
				expect(pathParts.indexOf(currentBin)).toBeLessThan(pathParts.indexOf(versionedBin));
			} finally {
				Object.defineProperty(process, 'platform', { value: originalPlatform });
				if (originalNvmDir === undefined) {
					delete process.env.NVM_DIR;
				} else {
					process.env.NVM_DIR = originalNvmDir;
				}
				fs.rmSync(tempNvmDir, { recursive: true, force: true });
			}
		});
	});

	describe('Test 2.6: Complex Precedence Chain', () => {
		it('should handle all three levels of env vars with correct precedence', () => {
			// Inherited from process
			process.env.LEVEL1 = 'inherited';
			process.env.LEVEL_BOTH = 'inherited-value';
			process.env.LEVEL_ALL_THREE = 'inherited-value';

			const globalVars = {
				LEVEL2: 'global',
				LEVEL_BOTH: 'global-value',
				LEVEL_ALL_THREE: 'global-value',
			};

			const sessionVars = {
				LEVEL3: 'session',
				LEVEL_ALL_THREE: 'session-value',
			};

			const env = buildChildProcessEnv(sessionVars, false, globalVars);

			expect(env.LEVEL1).toBe('inherited');
			expect(env.LEVEL2).toBe('global');
			expect(env.LEVEL3).toBe('session');
			expect(env.LEVEL_BOTH).toBe('global-value');
			expect(env.LEVEL_ALL_THREE).toBe('session-value');
		});
	});

	describe('Test 2.7: Real-World Scenarios', () => {
		it('should handle API key scenario', () => {
			const globalVars = {
				ANTHROPIC_API_KEY: 'sk-global-key',
				OPENAI_API_KEY: 'sk-openai-global',
			};

			const sessionVars = {
				ANTHROPIC_API_KEY: 'sk-session-key', // Override for this session
			};

			const env = buildChildProcessEnv(sessionVars, false, globalVars);

			expect(env.ANTHROPIC_API_KEY).toBe('sk-session-key');
			expect(env.OPENAI_API_KEY).toBe('sk-openai-global');
		});

		it('should handle proxy settings', () => {
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

		it('should handle config paths with tilde expansion', () => {
			const globalVars = {
				JEST_CONFIG_PATH: '~/.maestro/jest.config.js',
				APP_CONFIG_DIR: '~/app-configs',
			};

			const env = buildChildProcessEnv(undefined, false, globalVars);

			expect(env.JEST_CONFIG_PATH).toBe(path.join(originalHomedir, '.maestro/jest.config.js'));
			expect(env.APP_CONFIG_DIR).toBe(path.join(originalHomedir, 'app-configs'));
		});
	});

	describe('Test 2.8: PTY Terminal Env Builder', () => {
		it('should apply global shell vars to PTY environment', () => {
			const shellVars = {
				SHELL_VAR: 'shell-value',
			};

			const env = buildPtyTerminalEnv(shellVars);

			expect(env.SHELL_VAR).toBe('shell-value');
		});

		it('should preserve terminal-specific vars like TERM', () => {
			const shellVars = {
				CUSTOM: 'value',
			};

			const env = buildPtyTerminalEnv(shellVars);

			expect(env.TERM).toBe('xterm-256color');
		});

		it('should handle empty shell vars', () => {
			const env = buildPtyTerminalEnv({});

			expect(env.TERM).toBe('xterm-256color');
		});
	});

	describe('Test 2.9: Edge Cases and Special Values', () => {
		it('should handle empty string values', () => {
			const globalVars = {
				EMPTY_VAR: '',
			};

			const env = buildChildProcessEnv(undefined, false, globalVars);

			expect(env.EMPTY_VAR).toBe('');
		});

		it('should handle very long values', () => {
			const longValue = 'x'.repeat(10000);
			const globalVars = {
				LONG_VAR: longValue,
			};

			const env = buildChildProcessEnv(undefined, false, globalVars);

			expect(env.LONG_VAR).toBe(longValue);
		});

		it('should handle special characters in values', () => {
			const globalVars = {
				SPECIAL_CHARS: 'value!@#$%^&*()',
				SPACES: 'value with spaces',
				NEWLINES: 'line1\nline2\nline3',
				QUOTES: 'value with "quotes" and \'apostrophes\'',
			};

			const env = buildChildProcessEnv(undefined, false, globalVars);

			expect(env.SPECIAL_CHARS).toBe('value!@#$%^&*()');
			expect(env.SPACES).toBe('value with spaces');
			expect(env.NEWLINES).toBe('line1\nline2\nline3');
			expect(env.QUOTES).toBe('value with "quotes" and \'apostrophes\'');
		});

		it('should handle keys with special characters', () => {
			const globalVars = {
				VAR_WITH_UNDERSCORE: 'value1',
				'VAR-WITH-DASH': 'value2', // This is unusual but possible
				VAR123: 'value3',
			};

			const env = buildChildProcessEnv(undefined, false, globalVars);

			expect(env.VAR_WITH_UNDERSCORE).toBe('value1');
			expect(env['VAR-WITH-DASH']).toBe('value2');
			expect(env.VAR123).toBe('value3');
		});

		it('should handle null and undefined gracefully', () => {
			// These should not crash
			expect(() => buildChildProcessEnv(undefined, undefined, undefined)).not.toThrow();
			expect(() => buildChildProcessEnv({}, false, {})).not.toThrow();
		});

		it('should handle very large number of variables', () => {
			const globalVars: Record<string, string> = {};
			for (let i = 0; i < 100; i++) {
				globalVars[`VAR_${i}`] = `value_${i}`;
			}

			const env = buildChildProcessEnv(undefined, false, globalVars);

			for (let i = 0; i < 100; i++) {
				expect(env[`VAR_${i}`]).toBe(`value_${i}`);
			}
		});
	});

	describe('Test 2.10: Isolation Between Calls', () => {
		it('should not mutate input objects', () => {
			const globalVars = {
				VAR: 'value',
			};

			const globalVarsCopy = { ...globalVars };

			buildChildProcessEnv(undefined, false, globalVars);

			expect(globalVars).toEqual(globalVarsCopy);
		});

		it('should not share state between calls', () => {
			const env1 = buildChildProcessEnv(undefined, false, { VAR1: 'value1' });
			const env2 = buildChildProcessEnv(undefined, false, { VAR2: 'value2' });

			expect(env1.VAR1).toBe('value1');
			expect(env1.VAR2).toBeUndefined();

			expect(env2.VAR2).toBe('value2');
			expect(env2.VAR1).toBeUndefined();
		});
	});
});
