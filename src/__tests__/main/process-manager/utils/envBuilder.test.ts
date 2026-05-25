import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STANDARD_UNIX_PATHS } from '../../../../main/process-manager/constants';
import {
	buildChildProcessEnv,
	buildPtyTerminalEnv,
	buildUnixBasePath,
} from '../../../../main/process-manager/utils/envBuilder';
import { buildExpandedPath, detectNodeVersionManagerBinPaths } from '../../../../shared/pathUtils';
import { isWindows } from '../../../../shared/platformDetection';

vi.mock('../../../../shared/pathUtils', () => ({
	buildExpandedPath: vi.fn(() => '/expanded/bin:/usr/bin'),
	detectNodeVersionManagerBinPaths: vi.fn(() => ['/Users/test/.nvm/versions/node/v22/bin']),
}));

vi.mock('../../../../shared/platformDetection', () => ({
	isWindows: vi.fn(() => false),
}));

vi.mock('os', () => ({
	homedir: vi.fn(() => '/Users/test'),
}));

describe('envBuilder', () => {
	const originalEnv = { ...process.env };

	beforeEach(() => {
		vi.clearAllMocks();
		process.env = {
			HOME: '/Users/test',
			USER: 'test',
			SHELL: '/bin/zsh',
			LANG: 'en_GB.UTF-8',
			PATH: '/parent/bin',
			ELECTRON_RUN_AS_NODE: '1',
			ELECTRON_NO_ASAR: '1',
			ELECTRON_EXTRA_LAUNCH_ARGS: '--inspect',
			CLAUDECODE: '1',
			CLAUDE_CODE_ENTRYPOINT: 'ide',
			CLAUDE_AGENT_SDK_VERSION: '1.0.0',
			CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: '1',
			NODE_ENV: 'development',
			MAESTRO_SESSION_RESUMED: 'stale',
		};
		vi.mocked(detectNodeVersionManagerBinPaths).mockReturnValue([
			'/Users/test/.nvm/versions/node/v22/bin',
		]);
		vi.mocked(buildExpandedPath).mockReturnValue('/expanded/bin:/usr/bin');
		vi.mocked(isWindows).mockReturnValue(false);
	});

	afterEach(() => {
		process.env = { ...originalEnv };
	});

	describe('buildUnixBasePath', () => {
		it('prepends detected Node version manager paths', () => {
			expect(buildUnixBasePath()).toBe(
				`/Users/test/.nvm/versions/node/v22/bin:${STANDARD_UNIX_PATHS}`
			);
		});

		it('returns standard paths when no Node version manager paths are detected', () => {
			vi.mocked(detectNodeVersionManagerBinPaths).mockReturnValue([]);

			expect(buildUnixBasePath()).toBe(STANDARD_UNIX_PATHS);
		});
	});

	describe('buildPtyTerminalEnv', () => {
		it('builds a Unix PTY environment without custom shell variables', () => {
			const env = buildPtyTerminalEnv();

			expect(env).toEqual({
				HOME: '/Users/test',
				USER: 'test',
				SHELL: '/bin/zsh',
				TERM: 'xterm-256color',
				LANG: 'en_GB.UTF-8',
				PATH: `/Users/test/.nvm/versions/node/v22/bin:${STANDARD_UNIX_PATHS}`,
			});
		});

		it('builds a minimal Unix PTY environment with LANG fallback and custom literal vars', () => {
			delete process.env.LANG;

			const env = buildPtyTerminalEnv({ WORKSPACE: '/tmp/workspace' });

			expect(env).toEqual({
				HOME: '/Users/test',
				USER: 'test',
				SHELL: '/bin/zsh',
				TERM: 'xterm-256color',
				LANG: 'en_US.UTF-8',
				PATH: `/Users/test/.nvm/versions/node/v22/bin:${STANDARD_UNIX_PATHS}`,
				WORKSPACE: '/tmp/workspace',
			});
		});

		it('inherits the parent environment on Windows and expands custom home-relative vars', () => {
			vi.mocked(isWindows).mockReturnValue(true);

			const env = buildPtyTerminalEnv({ WORKSPACE: '~/workspace' });

			expect(env.PATH).toBe('/parent/bin');
			expect(env.TERM).toBe('xterm-256color');
			expect(env.NODE_ENV).toBe('development');
			expect(env.WORKSPACE).toBe('/Users/test/workspace');
		});
	});

	describe('buildChildProcessEnv', () => {
		it('strips Electron and IDE variables, expands PATH, and applies env precedence', () => {
			const env = buildChildProcessEnv(
				{
					DEBUG: 'session',
					SESSION_WORKSPACE: '~/session',
				},
				true,
				{
					DEBUG: 'global',
					GLOBAL_WORKSPACE: '~/global',
				}
			);

			expect(env.PATH).toBe('/expanded/bin:/usr/bin');
			expect(env.MAESTRO_SESSION_RESUMED).toBe('1');
			expect(env.DEBUG).toBe('session');
			expect(env.GLOBAL_WORKSPACE).toBe('/Users/test/global');
			expect(env.SESSION_WORKSPACE).toBe('/Users/test/session');
			expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
			expect(env.ELECTRON_NO_ASAR).toBeUndefined();
			expect(env.ELECTRON_EXTRA_LAUNCH_ARGS).toBeUndefined();
			expect(env.CLAUDECODE).toBeUndefined();
			expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
			expect(env.CLAUDE_AGENT_SDK_VERSION).toBeUndefined();
			expect(env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING).toBeUndefined();
			expect(env.NODE_ENV).toBeUndefined();
		});

		it('removes stale resume markers for fresh child processes', () => {
			const env = buildChildProcessEnv();

			expect(env.MAESTRO_SESSION_RESUMED).toBeUndefined();
		});
	});
});
