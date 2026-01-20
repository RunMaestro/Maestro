import { describe, it, expect } from 'vitest';

import type {
	BootstrapSettings,
	MaestroSettings,
	SessionsData,
	GroupsData,
	AgentConfigsData,
	WindowState,
	ClaudeSessionOrigin,
	ClaudeSessionOriginInfo,
	ClaudeSessionOriginsData,
	AgentSessionOriginsData,
	StoredSession,
} from '../../../main/stores/types';

/**
 * Type-level tests to ensure type definitions are correct.
 * These tests verify that the types can be used as expected.
 */
describe('stores/types', () => {
	describe('BootstrapSettings', () => {
		it('should allow optional customSyncPath', () => {
			const settings: BootstrapSettings = {};
			expect(settings.customSyncPath).toBeUndefined();
		});

		it('should allow customSyncPath string', () => {
			const settings: BootstrapSettings = {
				customSyncPath: '/Users/test/iCloud/Maestro',
			};
			expect(settings.customSyncPath).toBe('/Users/test/iCloud/Maestro');
		});

		it('should allow legacy iCloudSyncEnabled', () => {
			const settings: BootstrapSettings = {
				iCloudSyncEnabled: true,
			};
			expect(settings.iCloudSyncEnabled).toBe(true);
		});
	});

	describe('MaestroSettings', () => {
		it('should have all required fields', () => {
			const settings: MaestroSettings = {
				activeThemeId: 'dracula',
				llmProvider: 'openrouter',
				modelSlug: 'test-model',
				apiKey: 'test-key',
				shortcuts: { 'ctrl+s': 'save' },
				fontSize: 14,
				fontFamily: 'monospace',
				customFonts: ['CustomFont'],
				logLevel: 'info',
				defaultShell: 'zsh',
				webAuthEnabled: false,
				webAuthToken: null,
				webInterfaceUseCustomPort: false,
				webInterfaceCustomPort: 8080,
				sshRemotes: [],
				defaultSshRemoteId: null,
				installationId: null,
			};

			expect(settings.activeThemeId).toBe('dracula');
			expect(settings.logLevel).toBe('info');
		});

		it('should allow all valid logLevel values', () => {
			const logLevels: Array<'debug' | 'info' | 'warn' | 'error'> = [
				'debug',
				'info',
				'warn',
				'error',
			];

			logLevels.forEach((level) => {
				const settings: Partial<MaestroSettings> = { logLevel: level };
				expect(settings.logLevel).toBe(level);
			});
		});
	});

	describe('StoredSession', () => {
		it('should have required fields', () => {
			const session: StoredSession = {
				id: '1',
				name: 'Test Session',
				toolType: 'claude-code',
				cwd: '/path/to/project',
				projectRoot: '/path/to/project',
			};
			expect(session.id).toBe('1');
			expect(session.toolType).toBe('claude-code');
		});

		it('should allow optional groupId', () => {
			const session: StoredSession = {
				id: '1',
				groupId: 'group-1',
				name: 'Test Session',
				toolType: 'claude-code',
				cwd: '/path/to/project',
				projectRoot: '/path/to/project',
			};
			expect(session.groupId).toBe('group-1');
		});

		it('should allow additional renderer-specific fields', () => {
			const session: StoredSession = {
				id: '1',
				name: 'Test Session',
				toolType: 'claude-code',
				cwd: '/path/to/project',
				projectRoot: '/path/to/project',
				// Additional fields from renderer Session type
				state: 'idle',
				aiLogs: [],
				inputMode: 'ai',
			};
			expect(session.state).toBe('idle');
			expect(session.aiLogs).toEqual([]);
		});
	});

	describe('SessionsData', () => {
		it('should have sessions array with StoredSession items', () => {
			const data: SessionsData = {
				sessions: [
					{
						id: '1',
						name: 'Test',
						toolType: 'claude-code',
						cwd: '/path',
						projectRoot: '/path',
					},
				],
			};
			expect(data.sessions).toHaveLength(1);
			expect(data.sessions[0].id).toBe('1');
		});
	});

	describe('GroupsData', () => {
		it('should have groups array with Group items', () => {
			const data: GroupsData = {
				groups: [{ id: '1', name: 'Group 1', emoji: '📁', collapsed: false }],
			};
			expect(data.groups).toHaveLength(1);
			expect(data.groups[0].emoji).toBe('📁');
		});
	});

	describe('AgentConfigsData', () => {
		it('should support nested config structure', () => {
			const data: AgentConfigsData = {
				configs: {
					'claude-code': {
						customPath: '/usr/local/bin/claude',
						customArgs: ['--verbose'],
					},
					codex: {
						customEnv: { API_KEY: 'test' },
					},
				},
			};

			expect(data.configs['claude-code'].customPath).toBe('/usr/local/bin/claude');
			expect(data.configs['codex'].customEnv.API_KEY).toBe('test');
		});
	});

	describe('WindowState', () => {
		it('should have required fields', () => {
			const state: WindowState = {
				width: 1400,
				height: 900,
				isMaximized: false,
				isFullScreen: false,
			};

			expect(state.width).toBe(1400);
			expect(state.x).toBeUndefined();
		});

		it('should allow optional x and y', () => {
			const state: WindowState = {
				x: 100,
				y: 200,
				width: 1400,
				height: 900,
				isMaximized: false,
				isFullScreen: false,
			};

			expect(state.x).toBe(100);
			expect(state.y).toBe(200);
		});
	});

	describe('ClaudeSessionOrigin', () => {
		it('should allow user or auto values', () => {
			const userOrigin: ClaudeSessionOrigin = 'user';
			const autoOrigin: ClaudeSessionOrigin = 'auto';

			expect(userOrigin).toBe('user');
			expect(autoOrigin).toBe('auto');
		});
	});

	describe('ClaudeSessionOriginInfo', () => {
		it('should have required origin field', () => {
			const info: ClaudeSessionOriginInfo = {
				origin: 'user',
			};
			expect(info.origin).toBe('user');
		});

		it('should allow optional fields', () => {
			const info: ClaudeSessionOriginInfo = {
				origin: 'auto',
				sessionName: 'My Session',
				starred: true,
				contextUsage: 75,
			};

			expect(info.sessionName).toBe('My Session');
			expect(info.starred).toBe(true);
			expect(info.contextUsage).toBe(75);
		});
	});

	describe('ClaudeSessionOriginsData', () => {
		it('should support nested origin structure', () => {
			const data: ClaudeSessionOriginsData = {
				origins: {
					'/path/to/project': {
						'session-1': 'user',
						'session-2': {
							origin: 'auto',
							sessionName: 'Auto Session',
							starred: false,
						},
					},
				},
			};

			expect(data.origins['/path/to/project']['session-1']).toBe('user');
			expect(
				(data.origins['/path/to/project']['session-2'] as ClaudeSessionOriginInfo).sessionName
			).toBe('Auto Session');
		});
	});

	describe('AgentSessionOriginsData', () => {
		it('should support multi-agent nested structure', () => {
			const data: AgentSessionOriginsData = {
				origins: {
					codex: {
						'/path/to/project': {
							'session-1': {
								origin: 'user',
								sessionName: 'Codex Session',
								starred: true,
							},
						},
					},
					opencode: {
						'/another/project': {
							'session-2': {
								origin: 'auto',
							},
						},
					},
				},
			};

			expect(data.origins['codex']['/path/to/project']['session-1'].sessionName).toBe(
				'Codex Session'
			);
			expect(data.origins['opencode']['/another/project']['session-2'].origin).toBe('auto');
		});
	});
});
