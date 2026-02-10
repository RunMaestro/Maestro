import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
	getDefaultShell,
	SETTINGS_DEFAULTS,
	SESSIONS_DEFAULTS,
	GROUPS_DEFAULTS,
	AGENT_CONFIGS_DEFAULTS,
	WINDOW_STATE_DEFAULTS,
	CLAUDE_SESSION_ORIGINS_DEFAULTS,
	AGENT_SESSION_ORIGINS_DEFAULTS,
} from '../../../main/stores/defaults';

describe('stores/defaults', () => {
	describe('getDefaultShell', () => {
		const originalPlatform = process.platform;
		const originalShell = process.env.SHELL;

		afterEach(() => {
			// Restore original values
			Object.defineProperty(process, 'platform', { value: originalPlatform });
			process.env.SHELL = originalShell;
		});

		it('should return powershell on Windows', () => {
			Object.defineProperty(process, 'platform', { value: 'win32' });

			expect(getDefaultShell()).toBe('powershell');
		});

		it('should return zsh when SHELL is /bin/zsh', () => {
			Object.defineProperty(process, 'platform', { value: 'darwin' });
			process.env.SHELL = '/bin/zsh';

			expect(getDefaultShell()).toBe('zsh');
		});

		it('should return bash when SHELL is /bin/bash', () => {
			Object.defineProperty(process, 'platform', { value: 'linux' });
			process.env.SHELL = '/bin/bash';

			expect(getDefaultShell()).toBe('bash');
		});

		it('should return fish when SHELL is /usr/bin/fish', () => {
			Object.defineProperty(process, 'platform', { value: 'darwin' });
			process.env.SHELL = '/usr/bin/fish';

			expect(getDefaultShell()).toBe('fish');
		});

		it('should return sh when SHELL is /bin/sh', () => {
			Object.defineProperty(process, 'platform', { value: 'linux' });
			process.env.SHELL = '/bin/sh';

			expect(getDefaultShell()).toBe('sh');
		});

		it('should return tcsh when SHELL is /bin/tcsh', () => {
			Object.defineProperty(process, 'platform', { value: 'darwin' });
			process.env.SHELL = '/bin/tcsh';

			expect(getDefaultShell()).toBe('tcsh');
		});

		it('should return bash when SHELL is an unsupported shell', () => {
			Object.defineProperty(process, 'platform', { value: 'linux' });
			process.env.SHELL = '/bin/unsupported';

			expect(getDefaultShell()).toBe('bash');
		});

		it('should return bash when SHELL is not set', () => {
			Object.defineProperty(process, 'platform', { value: 'linux' });
			delete process.env.SHELL;

			expect(getDefaultShell()).toBe('bash');
		});

		it('should handle full path with nested directories', () => {
			Object.defineProperty(process, 'platform', { value: 'darwin' });
			process.env.SHELL = '/opt/homebrew/bin/zsh';

			expect(getDefaultShell()).toBe('zsh');
		});
	});

	describe('SETTINGS_DEFAULTS', () => {
		it('should have correct default theme', () => {
			expect(SETTINGS_DEFAULTS.activeThemeId).toBe('dracula');
		});

		it('should have correct default llmProvider', () => {
			expect(SETTINGS_DEFAULTS.llmProvider).toBe('openrouter');
		});

		it('should have correct default modelSlug', () => {
			expect(SETTINGS_DEFAULTS.modelSlug).toBe('anthropic/claude-3.5-sonnet');
		});

		it('should have empty apiKey by default', () => {
			expect(SETTINGS_DEFAULTS.apiKey).toBe('');
		});

		it('should have empty shortcuts by default', () => {
			expect(SETTINGS_DEFAULTS.shortcuts).toEqual({});
		});

		it('should have correct default fontSize', () => {
			expect(SETTINGS_DEFAULTS.fontSize).toBe(14);
		});

		it('should have correct default fontFamily', () => {
			expect(SETTINGS_DEFAULTS.fontFamily).toBe('Roboto Mono, Menlo, "Courier New", monospace');
		});

		it('should have empty customFonts by default', () => {
			expect(SETTINGS_DEFAULTS.customFonts).toEqual([]);
		});

		it('should have info as default logLevel', () => {
			expect(SETTINGS_DEFAULTS.logLevel).toBe('info');
		});

		it('should have webAuthEnabled disabled by default', () => {
			expect(SETTINGS_DEFAULTS.webAuthEnabled).toBe(false);
		});

		it('should have null webAuthToken by default', () => {
			expect(SETTINGS_DEFAULTS.webAuthToken).toBeNull();
		});

		it('should have webInterfaceUseCustomPort disabled by default', () => {
			expect(SETTINGS_DEFAULTS.webInterfaceUseCustomPort).toBe(false);
		});

		it('should have 8080 as default webInterfaceCustomPort', () => {
			expect(SETTINGS_DEFAULTS.webInterfaceCustomPort).toBe(8080);
		});

		it('should have empty sshRemotes by default', () => {
			expect(SETTINGS_DEFAULTS.sshRemotes).toEqual([]);
		});

		it('should have null defaultSshRemoteId by default', () => {
			expect(SETTINGS_DEFAULTS.defaultSshRemoteId).toBeNull();
		});

		it('should have null installationId by default', () => {
			expect(SETTINGS_DEFAULTS.installationId).toBeNull();
		});
	});

	describe('SESSIONS_DEFAULTS', () => {
		it('should have empty sessions array', () => {
			expect(SESSIONS_DEFAULTS.sessions).toEqual([]);
		});
	});

	describe('GROUPS_DEFAULTS', () => {
		it('should have empty groups array', () => {
			expect(GROUPS_DEFAULTS.groups).toEqual([]);
		});
	});

	describe('AGENT_CONFIGS_DEFAULTS', () => {
		it('should have empty configs object', () => {
			expect(AGENT_CONFIGS_DEFAULTS.configs).toEqual({});
		});
	});

	describe('WINDOW_STATE_DEFAULTS', () => {
		it('should have correct default width', () => {
			expect(WINDOW_STATE_DEFAULTS.width).toBe(1400);
		});

		it('should have correct default height', () => {
			expect(WINDOW_STATE_DEFAULTS.height).toBe(900);
		});

		it('should have isMaximized false by default', () => {
			expect(WINDOW_STATE_DEFAULTS.isMaximized).toBe(false);
		});

		it('should have isFullScreen false by default', () => {
			expect(WINDOW_STATE_DEFAULTS.isFullScreen).toBe(false);
		});

		it('should not have x/y position by default', () => {
			expect(WINDOW_STATE_DEFAULTS.x).toBeUndefined();
			expect(WINDOW_STATE_DEFAULTS.y).toBeUndefined();
		});

		it('should include default multiWindowState metadata', () => {
			expect(WINDOW_STATE_DEFAULTS.multiWindowState).toEqual(
				expect.objectContaining({
					primaryWindowId: 'primary',
					windows: [
						expect.objectContaining({
							id: 'primary',
							sessionIds: [],
							leftPanelCollapsed: false,
							rightPanelCollapsed: false,
						}),
					],
				})
			);
		});
	});

	describe('CLAUDE_SESSION_ORIGINS_DEFAULTS', () => {
		it('should have empty origins object', () => {
			expect(CLAUDE_SESSION_ORIGINS_DEFAULTS.origins).toEqual({});
		});
	});

	describe('AGENT_SESSION_ORIGINS_DEFAULTS', () => {
		it('should have empty origins object', () => {
			expect(AGENT_SESSION_ORIGINS_DEFAULTS.origins).toEqual({});
		});
	});
});
