// Consolidated from current rc sources; per-source hooks and state stay in an unnamed suite.
// Source: src/__tests__/main/stores/defaults.test.ts
// Source: src/__tests__/main/stores/types.test.ts
// Source: src/__tests__/main/stores/usageSnapshotRetention.test.ts
// Source: src/__tests__/main/stores/deferred-session-content.test.ts
// Source: src/__tests__/main/stores/quotaAccountsStore.test.ts
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import {
	getDefaultShell,
	resolveConfiguredShell,
	type ShellSettingsReader,
	SETTINGS_DEFAULTS,
	SESSIONS_DEFAULTS,
	GROUPS_DEFAULTS,
	AGENT_CONFIGS_DEFAULTS,
	WINDOW_STATE_DEFAULTS,
	CLAUDE_SESSION_ORIGINS_DEFAULTS,
	AGENT_SESSION_ORIGINS_DEFAULTS,
} from '../../../main/stores/defaults';
import { MAESTRO_FONT_STACK } from '../../../shared/fontStack';
import { DEFAULT_CUE_HISTORY_RETENTION_DAYS } from '../../../shared/cue/retention';
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
	StoredSession as S2_StoredSession,
} from '../../../main/stores/types';
import {
	partitionSnapshotsByAge,
	SNAPSHOT_RETENTION_MS,
} from '../../../main/stores/usageSnapshotRetention';
import {
	mergeDeferredSessionContent,
	projectWebSession,
	readDeferredContent,
} from '../../../main/stores/deferred-session-content';
import type { StoredSession as S4_StoredSession } from '../../../main/stores/types';
import * as fs from 'fs';
import {
	clearRememberedQuotaAccounts,
	forgetQuotaAccounts,
	getRememberedQuotaAccountKeys,
	getRememberedQuotaAccounts,
	pruneMissingQuotaAccounts,
	rememberQuotaAccounts,
	__resetForTests,
} from '../../../main/stores/quotaAccountsStore';
vi.mock('electron-store', () => {
	return {
		default: class MockStore {
			data: Record<string, unknown>;
			constructor(options: Record<string, unknown>) {
				this.data = { ...((options.defaults as Record<string, unknown>) ?? {}) };
			}
			get(key: string, defaultValue?: unknown): unknown {
				if (Object.prototype.hasOwnProperty.call(this.data, key)) {
					return this.data[key];
				}
				return defaultValue;
			}
			set(key: string, value: unknown): void {
				this.data[key] = value;
			}
		},
	};
});
// Source: src/__tests__/main/stores/defaults.test.ts
describe('', () => {
	describe('stores/defaults', () => {
		describe('resolveConfiguredShell', () => {
			/** Minimal stand-in for the settings store: only the two keys it reads. */
			const reader = (values: Record<string, string>): ShellSettingsReader =>
				({
					get: (key: string, fallback: string) => values[key] ?? fallback,
				}) as ShellSettingsReader;
			it('prefers an explicit custom shell path over the selected shell', () => {
				expect(
					resolveConfiguredShell(
						reader({ defaultShell: 'zsh', customShellPath: '/opt/homebrew/bin/fish' })
					)
				).toBe('/opt/homebrew/bin/fish');
			});
			it('trims the custom path, so a stray space cannot become the shell', () => {
				expect(resolveConfiguredShell(reader({ customShellPath: '  /bin/dash  ' }))).toBe(
					'/bin/dash'
				);
			});
			it('falls back to the selected shell when the custom path is blank', () => {
				expect(
					resolveConfiguredShell(reader({ defaultShell: 'bash', customShellPath: '   ' }))
				).toBe('bash');
			});
			it('falls back to the platform default when nothing is configured', () => {
				expect(resolveConfiguredShell(reader({}))).toBe(getDefaultShell());
			});
		});
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
			it('should have empty shortcuts by default', () => {
				expect(SETTINGS_DEFAULTS.shortcuts).toEqual({});
			});
			it('should have correct default fontSize', () => {
				expect(SETTINGS_DEFAULTS.fontSize).toBe(14);
			});
			it('should have correct default fontFamily', () => {
				// The default must name the family Maestro actually BUNDLES
				// (src/renderer/public/fonts/), and must match what the splash screen
				// paints with before React mounts. When it named Roboto Mono instead,
				// the window visibly changed font the moment React took over.
				expect(SETTINGS_DEFAULTS.fontFamily).toBe(MAESTRO_FONT_STACK);
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
			it('should enable autoResumeOnLimit by default', () => {
				expect(SETTINGS_DEFAULTS.autoResumeOnLimit).toBe(true);
			});
			it('should default autoResumeCheckIntervalHours to 2', () => {
				expect(SETTINGS_DEFAULTS.autoResumeCheckIntervalHours).toBe(2);
			});
			it('should default autoResumeGiveUpDays to 7', () => {
				expect(SETTINGS_DEFAULTS.autoResumeGiveUpDays).toBe(7);
			});
			it("should ship Usage & Stats, Director's Notes, and Cue enabled", () => {
				expect(SETTINGS_DEFAULTS.encoreFeatures).toMatchObject({
					usageStats: true,
					directorNotes: true,
					maestroCue: true,
				});
			});
			// The Cue prune reads this from the store at engine start, so the default
			// has to be present here - not just in the renderer - or a fresh install
			// prunes against `undefined`.
			it('should default cueHistoryRetentionDays to the shared retention constant', () => {
				expect(SETTINGS_DEFAULTS.cueHistoryRetentionDays).toBe(DEFAULT_CUE_HISTORY_RETENTION_DAYS);
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
});
// Source: src/__tests__/main/stores/types.test.ts
describe('', () => {
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
				const session: S2_StoredSession = {
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
				const session: S2_StoredSession = {
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
				const session: S2_StoredSession = {
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
});
// Source: src/__tests__/main/stores/usageSnapshotRetention.test.ts
describe('', () => {
	const NOW = new Date('2026-05-15T12:00:00.000Z').getTime();
	const TTL_MS = 24 * 60 * 60 * 1000;
	function at(ageMs: number) {
		return { sampledAt: new Date(NOW - ageMs).toISOString() };
	}
	describe('partitionSnapshotsByAge', () => {
		it('keeps a fresh snapshot in both maps', () => {
			const fresh = at(60000);
			const result = partitionSnapshotsByAge({ fresh }, NOW, TTL_MS);
			expect(result.live).toEqual({ fresh });
			expect(result.retained).toEqual({ fresh });
			expect(result.prunedAny).toBe(false);
		});
		it('drops an expired snapshot from live but keeps it retained', () => {
			const expired = at(25 * 60 * 60 * 1000);
			const result = partitionSnapshotsByAge({ expired }, NOW, TTL_MS);
			expect(result.live).toEqual({});
			expect(result.retained).toEqual({ expired });
			// Expiry alone must not trigger a write-back: nothing left the file.
			expect(result.prunedAny).toBe(false);
		});
		it('treats a snapshot exactly at the TTL as still live', () => {
			const onTtl = at(TTL_MS);
			const result = partitionSnapshotsByAge({ onTtl }, NOW, TTL_MS);
			expect(result.live).toEqual({ onTtl });
		});
		it('treats a snapshot exactly at the retention edge as still retained', () => {
			const onEdge = at(SNAPSHOT_RETENTION_MS);
			const result = partitionSnapshotsByAge({ onEdge }, NOW, TTL_MS);
			expect(result.retained).toEqual({ onEdge });
			expect(result.prunedAny).toBe(false);
		});
		it('drops a snapshot past retention and flags the write-back', () => {
			const ancient = at(SNAPSHOT_RETENTION_MS + 1);
			const result = partitionSnapshotsByAge({ ancient }, NOW, TTL_MS);
			expect(result.live).toEqual({});
			expect(result.retained).toEqual({});
			expect(result.prunedAny).toBe(true);
		});
		it('drops an unparseable sampledAt so a corrupted record self-heals', () => {
			const result = partitionSnapshotsByAge({ bad: { sampledAt: 'not-a-date' } }, NOW, TTL_MS);
			expect(result.retained).toEqual({});
			expect(result.prunedAny).toBe(true);
		});
		it('partitions a mixed map without cross-contaminating the buckets', () => {
			const fresh = at(60000);
			const expired = at(30 * 60 * 60 * 1000);
			const ancient = at(SNAPSHOT_RETENTION_MS + 60000);
			const result = partitionSnapshotsByAge({ fresh, expired, ancient }, NOW, TTL_MS);
			expect(result.live).toEqual({ fresh });
			expect(result.retained).toEqual({ fresh, expired });
			expect(result.prunedAny).toBe(true);
		});
		it('honors an explicit retention override', () => {
			const old = at(2 * TTL_MS);
			const result = partitionSnapshotsByAge({ old }, NOW, TTL_MS, 3 * TTL_MS);
			expect(result.retained).toEqual({ old });
			expect(partitionSnapshotsByAge({ old }, NOW, TTL_MS, TTL_MS).retained).toEqual({});
		});
		it('defaults retention to 30 days', () => {
			expect(SNAPSHOT_RETENTION_MS).toBe(30 * 24 * 60 * 60 * 1000);
		});
	});
});
// Source: src/__tests__/main/stores/deferred-session-content.test.ts
describe('', () => {
	function storedAgent(overrides: Partial<S4_StoredSession> = {}): S4_StoredSession {
		return {
			id: 'agent-1',
			name: 'Agent',
			toolType: 'claude-code',
			cwd: '/p',
			projectRoot: '/p',
			createdAt: 1000,
			activeTabId: 'tab-a',
			aiTabs: [
				{ id: 'tab-a', logs: [{ id: 'a1', timestamp: 1 }] },
				{ id: 'tab-b', logs: [{ id: 'b1', timestamp: 2 }] },
			],
			snoozedTabs: [{ type: 'ai', tab: { id: 'tab-s', logs: [{ id: 's1', timestamp: 3 }] } }],
			unifiedTabOrder: [
				{ type: 'ai', id: 'tab-a' },
				{ type: 'ai', id: 'tab-b' },
			],
			aiLogs: [{ id: 'legacy-1' }],
			shellLogs: [{ id: 'sh1' }],
			agentCommands: [{ command: '/ship' }],
			aiCommandHistory: ['one'],
			...overrides,
		};
	}
	describe('projectWebSession', () => {
		it('strips every transcript and marks what was left behind, including snoozed tabs', () => {
			const projected = projectWebSession(storedAgent());
			expect(projected.aiTabs.map((t: { logs: unknown[] }) => t.logs)).toEqual([[], []]);
			expect(projected.snoozedTabs[0].tab.logs).toEqual([]);
			expect(projected.aiLogs).toEqual([]);
			expect(projected.shellLogs).toEqual([]);
			expect(projected.agentCommands).toBeUndefined();
			expect(projected.aiCommandHistory).toBeUndefined();
			expect(projected.deferredContent).toEqual({
				tabIds: ['tab-a', 'tab-b', 'tab-s'],
				commands: true,
			});
		});
		it('drops both closed-tab stacks: a browser keeps its own and never writes the host one', () => {
			const projected = projectWebSession(
				storedAgent({
					closedTabHistory: [{ tab: { id: 'old', logs: [] }, index: 0, closedAt: 1 }],
					unifiedClosedTabHistory: [
						{ type: 'ai', tab: { id: 'old', logs: [] }, unifiedIndex: 0, closedAt: 1 },
					],
				})
			);
			expect(projected).not.toHaveProperty('closedTabHistory');
			expect(projected).not.toHaveProperty('unifiedClosedTabHistory');
		});
		it('derives createdAt for a legacy agent from the oldest log it is about to drop', () => {
			const projected = projectWebSession(storedAgent({ createdAt: undefined }));
			expect(projected.createdAt).toBe(1);
		});
	});
	describe('readDeferredContent', () => {
		it('returns a snoozed tab transcript and the command content', () => {
			expect(readDeferredContent(storedAgent(), 'agent-1', 'tab-s', true)).toEqual({
				logs: [{ id: 's1', timestamp: 3 }],
				shellLogs: [{ id: 'sh1' }],
				agentCommands: [{ command: '/ship' }],
				aiCommandHistory: ['one'],
			});
		});
		it('throws for a missing agent or tab rather than answering empty', () => {
			expect(() => readDeferredContent(undefined, 'gone', null, true)).toThrow(/no longer exists/);
			expect(() => readDeferredContent(storedAgent(), 'agent-1', 'gone', false)).toThrow(
				/no longer exists/
			);
		});
	});
	describe('mergeDeferredSessionContent', () => {
		it('passes an unmarked record through untouched', () => {
			const incoming = storedAgent();
			expect(mergeDeferredSessionContent(incoming, undefined)).toBe(incoming);
		});
		it('restores unloaded transcripts and folds in entries the browser appended', () => {
			const stored = storedAgent();
			const incoming = {
				...projectWebSession(stored),
				name: 'Renamed',
				aiTabs: [
					{ id: 'tab-a', logs: [{ id: 'a2', timestamp: 9 }] },
					{ id: 'tab-b', logs: [] },
				],
			};
			const merged = mergeDeferredSessionContent(incoming, stored);
			expect(merged.name).toBe('Renamed');
			expect(merged.aiTabs[0].logs.map((l: { id: string }) => l.id)).toEqual(['a1', 'a2']);
			expect(merged.aiTabs[1].logs.map((l: { id: string }) => l.id)).toEqual(['b1']);
			expect(merged.snoozedTabs[0].tab.logs.map((l: { id: string }) => l.id)).toEqual(['s1']);
			expect(merged.aiLogs).toEqual([{ id: 'legacy-1' }]);
			expect(merged.shellLogs).toEqual([{ id: 'sh1' }]);
			expect(merged.agentCommands).toEqual([{ command: '/ship' }]);
			expect(merged.aiCommandHistory).toEqual(['one']);
			expect(merged.deferredContent).toBeUndefined();
		});
		it('drops a deferred tab another client closed instead of resurrecting it', () => {
			const stored = storedAgent({
				aiTabs: [{ id: 'tab-a', logs: [{ id: 'a1' }] }],
				unifiedTabOrder: [{ type: 'ai', id: 'tab-a' }],
				activeTabId: 'tab-a',
			});
			const incoming = { ...projectWebSession(storedAgent()), activeTabId: 'tab-b' };
			const merged = mergeDeferredSessionContent(incoming, stored);
			expect(merged.aiTabs.map((t: { id: string }) => t.id)).toEqual(['tab-a']);
			expect(merged.unifiedTabOrder).toEqual([{ type: 'ai', id: 'tab-a' }]);
			expect(merged.activeTabId).toBe('tab-a');
		});
		it('refuses a marked record with no stored counterpart', () => {
			expect(() =>
				mergeDeferredSessionContent(projectWebSession(storedAgent()), undefined)
			).toThrow(/invalid deferred content/);
		});
	});
});
// Source: src/__tests__/main/stores/quotaAccountsStore.test.ts
describe('', () => {
	const FROZEN_NOW = new Date('2026-05-15T12:00:00.000Z').getTime();
	describe('quotaAccountsStore', () => {
		beforeEach(() => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date(FROZEN_NOW));
			__resetForTests();
			clearRememberedQuotaAccounts();
		});
		describe('rememberQuotaAccounts', () => {
			it('remembers keys in first-seen order', () => {
				rememberQuotaAccounts('claude-code', ['/Users/test/.claude-a']);
				vi.setSystemTime(new Date(FROZEN_NOW + 1000));
				rememberQuotaAccounts('claude-code', ['/Users/test/.claude-b']);
				expect(getRememberedQuotaAccountKeys('claude-code')).toEqual([
					'/Users/test/.claude-a',
					'/Users/test/.claude-b',
				]);
			});
			it('keeps firstSeenAt and refreshes lastSeenAt on re-remember', () => {
				rememberQuotaAccounts('claude-code', ['/Users/test/.claude-a']);
				vi.setSystemTime(new Date(FROZEN_NOW + 60000));
				rememberQuotaAccounts('claude-code', ['/Users/test/.claude-a']);
				expect(getRememberedQuotaAccounts('claude-code')).toEqual([
					{
						accountKey: '/Users/test/.claude-a',
						firstSeenAt: FROZEN_NOW,
						lastSeenAt: FROZEN_NOW + 60000,
					},
				]);
			});
			it('keeps providers isolated', () => {
				rememberQuotaAccounts('claude-code', ['/Users/test/.claude-a']);
				rememberQuotaAccounts('codex', ['/Users/test/.codex-a']);
				expect(getRememberedQuotaAccountKeys('claude-code')).toEqual(['/Users/test/.claude-a']);
				expect(getRememberedQuotaAccountKeys('codex')).toEqual(['/Users/test/.codex-a']);
				expect(getRememberedQuotaAccountKeys('opencode')).toEqual([]);
			});
			it('ignores empty keys and empty batches', () => {
				rememberQuotaAccounts('claude-code', []);
				rememberQuotaAccounts('claude-code', ['']);
				expect(getRememberedQuotaAccountKeys('claude-code')).toEqual([]);
			});
			it('accepts any iterable, including a Map key view', () => {
				const targets = new Map([
					['/Users/test/.claude-a', 1],
					['/Users/test/.claude-b', 2],
				]);
				rememberQuotaAccounts('claude-code', targets.keys());
				expect(getRememberedQuotaAccountKeys('claude-code')).toEqual([
					'/Users/test/.claude-a',
					'/Users/test/.claude-b',
				]);
			});
		});
		describe('forgetQuotaAccounts', () => {
			it('drops only the named keys', () => {
				rememberQuotaAccounts('claude-code', ['/Users/test/.claude-a', '/Users/test/.claude-b']);
				forgetQuotaAccounts('claude-code', ['/Users/test/.claude-a']);
				expect(getRememberedQuotaAccountKeys('claude-code')).toEqual(['/Users/test/.claude-b']);
			});
			it('is a no-op for unknown keys and unknown providers', () => {
				rememberQuotaAccounts('claude-code', ['/Users/test/.claude-a']);
				forgetQuotaAccounts('claude-code', ['/nope']);
				forgetQuotaAccounts('nobody', ['/nope']);
				expect(getRememberedQuotaAccountKeys('claude-code')).toEqual(['/Users/test/.claude-a']);
			});
		});
		describe('pruneMissingQuotaAccounts', () => {
			it('forgets accounts whose directory is gone and keeps the rest in order', async () => {
				rememberQuotaAccounts('claude-code', [
					'/Users/test/.claude-live',
					'/Users/test/.claude-deleted',
					'/Users/test/.claude-also-live',
				]);
				const access = vi.spyOn(fs.promises, 'access').mockImplementation(async (target) => {
					if (String(target).endsWith('.claude-deleted')) {
						throw Object.assign(new Error('missing'), { code: 'ENOENT' });
					}
				});
				try {
					const surviving = await pruneMissingQuotaAccounts('claude-code');
					expect(surviving).toEqual(['/Users/test/.claude-live', '/Users/test/.claude-also-live']);
				} finally {
					access.mockRestore();
				}
				expect(getRememberedQuotaAccountKeys('claude-code')).toEqual([
					'/Users/test/.claude-live',
					'/Users/test/.claude-also-live',
				]);
			});
			it('keeps an account whose directory is merely unreadable', async () => {
				// An unmounted volume or a permissions blip must not erase the row.
				rememberQuotaAccounts('claude-code', ['/Volumes/keys/.claude-work']);
				const access = vi
					.spyOn(fs.promises, 'access')
					.mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' }));
				try {
					expect(await pruneMissingQuotaAccounts('claude-code')).toEqual([
						'/Volumes/keys/.claude-work',
					]);
				} finally {
					access.mockRestore();
				}
				expect(getRememberedQuotaAccountKeys('claude-code')).toEqual([
					'/Volumes/keys/.claude-work',
				]);
			});
			it('returns an empty list when nothing is remembered', async () => {
				expect(await pruneMissingQuotaAccounts('claude-code')).toEqual([]);
			});
		});
	});
});
