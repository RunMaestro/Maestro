/**
 * @file worktreeSession.test.ts
 * @description Tests for the shared buildWorktreeSession utility
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildWorktreeSession } from '../../../renderer/utils/worktreeSession';
import type { AITab, Session } from '../../../renderer/types';
import { createMockAITab } from '../../helpers/mockTab';

// Mock generateId for deterministic IDs
let idCounter = 0;
vi.mock('../../../renderer/utils/ids', () => ({
	generateId: () => `test-id-${++idCounter}`,
}));

const createMockParentSession = (overrides: Partial<Session> = {}): Session =>
	({
		id: 'parent-1',
		name: 'Parent Agent',
		groupId: 'group-1',
		toolType: 'claude-code',
		state: 'idle',
		cwd: '/projects/main',
		fullPath: '/projects/main',
		projectRoot: '/projects/main',
		inputMode: 'ai',
		customPath: '/usr/local/bin/claude',
		customArgs: ['--verbose'],
		customEnvVars: { KEY: 'val' },
		customEnvVarsDisabled: { PARKED: 'later' },
		customModel: 'opus',
		customContextWindow: 200000,
		contextWindowSource: 'user-edited' as const,
		nudgeMessage: 'Keep going',
		newSessionMessage: 'Init context',
		autoRunFolderPath: '/autorun/docs',
		sessionSshRemoteConfig: undefined,
		...overrides,
	}) as Session;

describe('buildWorktreeSession', () => {
	beforeEach(() => {
		idCounter = 0;
	});

	it('should create a new-model session with correct fields', () => {
		const parent = createMockParentSession();
		const session = buildWorktreeSession({
			parentSession: parent,
			path: '/worktrees/feature-x',
			branch: 'feature-x',
			name: 'feature-x',
			gitBranches: ['main', 'feature-x'],
			defaultSaveToHistory: true,
			defaultShowThinking: 'off',
		});

		expect(session.id).toBe('test-id-1');
		expect(session.parentSessionId).toBe('parent-1');
		expect(session.worktreeBranch).toBe('feature-x');
		expect(session.cwd).toBe('/worktrees/feature-x');
		expect(session.fullPath).toBe('/worktrees/feature-x');
		expect(session.projectRoot).toBe('/worktrees/feature-x');
		expect(session.groupId).toBe('group-1');
		expect(session.toolType).toBe('claude-code');
		expect(session.state).toBe('idle');
		expect(session.isGitRepo).toBe(true);
		expect(session.gitBranches).toEqual(['main', 'feature-x']);
		expect(session.inputMode).toBe('ai');
		// Inherits from parent
		expect(session.customPath).toBe('/usr/local/bin/claude');
		expect(session.customArgs).toEqual(['--verbose']);
		expect(session.customEnvVars).toEqual({ KEY: 'val' });
		// Parked vars come along too, or the worktree agent silently loses the
		// switched-off entries the user is keeping for later.
		expect(session.customEnvVarsDisabled).toEqual({ PARKED: 'later' });
		expect(session.customModel).toBe('opus');
		expect(session.customContextWindow).toBe(200000);
		// Provenance travels with the value (finding AD1): inheriting the number
		// alone would demote the parent's deliberate budget to unknown provenance
		// here, so a provider report would override it in the worktree while still
		// being outranked in the parent.
		expect(session.contextWindowSource).toBe('user-edited');
		expect(session.nudgeMessage).toBe('Keep going');
		expect(session.newSessionMessage).toBe('Init context');
		expect(session.autoRunFolderPath).toBe('/autorun/docs');
	});

	it('should create a legacy session when worktreeParentPath is provided', () => {
		const parent = createMockParentSession({ inputMode: 'terminal' });
		const session = buildWorktreeSession({
			parentSession: parent,
			path: '/worktrees/legacy',
			branch: 'legacy-branch',
			name: 'legacy',
			defaultSaveToHistory: false,
			defaultShowThinking: 'on',
			worktreeParentPath: '/projects',
		});

		expect(session.parentSessionId).toBeUndefined();
		expect(session.worktreeBranch).toBeUndefined();
		expect(session.worktreeParentPath).toBe('/projects');
		expect(session.inputMode).toBe('terminal'); // inherited directly
		expect(session.customContextWindow).toBeUndefined();
		expect(session.contextWindowSource).toBeUndefined();
		expect(session.nudgeMessage).toBeUndefined();
		expect(session.newSessionMessage).toBeUndefined();
		expect(session.autoRunFolderPath).toBeUndefined();
	});

	it('should derive inputMode from toolType for new model', () => {
		const terminalParent = createMockParentSession({ toolType: 'terminal' });
		const session = buildWorktreeSession({
			parentSession: terminalParent,
			path: '/worktrees/term',
			name: 'term',
			defaultSaveToHistory: true,
			defaultShowThinking: 'off',
		});

		expect(session.inputMode).toBe('terminal');
	});

	it('should handle null branch', () => {
		const parent = createMockParentSession();
		const session = buildWorktreeSession({
			parentSession: parent,
			path: '/worktrees/no-branch',
			branch: null,
			name: 'no-branch',
			defaultSaveToHistory: true,
			defaultShowThinking: 'off',
		});

		expect(session.worktreeBranch).toBeUndefined();
	});

	it('should inherit SSH config from parent', () => {
		const sshConfig = { remoteId: 'remote-1', enabled: true, hostAlias: 'dev-server' };
		const parent = createMockParentSession({
			sessionSshRemoteConfig: sshConfig as any,
		});
		const session = buildWorktreeSession({
			parentSession: parent,
			path: '/worktrees/ssh',
			branch: 'ssh-branch',
			name: 'ssh',
			defaultSaveToHistory: true,
			defaultShowThinking: 'off',
		});

		expect(session.sessionSshRemoteConfig).toEqual(sshConfig);
	});

	it('should create initial AI tab with correct settings', () => {
		const parent = createMockParentSession();
		const session = buildWorktreeSession({
			parentSession: parent,
			path: '/worktrees/tabs',
			name: 'tabs',
			defaultSaveToHistory: false,
			defaultShowThinking: 'sticky',
		});

		expect(session.aiTabs).toHaveLength(1);
		const tab = session.aiTabs[0];
		expect(tab.saveToHistory).toBe(false);
		expect(tab.showThinking).toBe('sticky');
		expect(tab.state).toBe('idle');
		expect(tab.logs).toEqual([]);
	});

	it('should not auto-create terminal tabs', () => {
		const parent = createMockParentSession();
		const session = buildWorktreeSession({
			parentSession: parent,
			path: '/worktrees/no-term',
			name: 'no-term',
			defaultSaveToHistory: true,
			defaultShowThinking: 'off',
		});

		expect(session.terminalTabs).toEqual([]);
		expect(session.activeTerminalTabId).toBeNull();
		expect(session.unifiedTabOrder).toHaveLength(1);
		expect(session.unifiedTabOrder[0].type).toBe('ai');
	});

	it.each<{
		account: string;
		selection: Partial<AITab>;
		permission: 'full' | 'readonly' | 'standard';
	}>([
		{
			account: 'a',
			selection: { customModel: 'grok-4.5', customEffort: 'max', permissionMode: 'readonly' },
			permission: 'readonly',
		},
		{ account: 'b', selection: { permissionMode: 'full' }, permission: 'full' },
		{ account: 'a', selection: { readOnlyMode: true }, permission: 'readonly' },
		{ account: 'b', selection: { permissionMode: 'standard' }, permission: 'standard' },
	])(
		'retains Grok account $account and $permission selections without sharing conversation state',
		({ account, selection, permission }) => {
			const selected = createMockAITab({
				id: 'selected',
				agentSessionId: `native-${account}`,
				nativeSessionBinding: { version: 1, state: 'unknown', reason: 'legacy' },
				providerSessions: { codex: { agentSessionId: 'parked-native' } },
				usageStats: {
					inputTokens: 10,
					outputTokens: 5,
					cacheReadInputTokens: 0,
					cacheCreationInputTokens: 0,
					totalCostUsd: 1,
					contextWindow: 500000,
				},
				logs: [{ id: 'old-log', timestamp: 1, source: 'user', text: 'Parent only' }],
				inputValue: 'Unsent parent draft',
				stagedImages: ['parent-image'],
				...selection,
			});
			const parent = createMockParentSession({
				toolType: 'grok',
				customPath: '/opt/Grok CLI/grok',
				customArgs: '--acp',
				customModel: 'grok-composer-2.5-fast',
				customEffort: 'low',
				customEnvVars: { GROK_HOME: `/accounts/${account}`, GROK_AUTH_PATH: '' },
				customEnvVarsDisabled: { GROK_HOME: '/accounts/parked' },
				activeTabId: selected.id,
				agentSessionId: 'legacy-parent-native',
				aiTabs: [
					createMockAITab({ id: 'other', customModel: 'wrong-model', customEffort: 'none' }),
					selected,
				],
			});
			const original = structuredClone(parent);
			const child = buildWorktreeSession({
				parentSession: parent,
				path: '/worktrees/grok',
				branch: 'grok',
				name: 'grok',
				defaultSaveToHistory: true,
				defaultShowThinking: 'off',
			});
			expect(child).toMatchObject({
				toolType: 'grok',
				customPath: '/opt/Grok CLI/grok',
				customArgs: '--acp',
				customModel: 'grok-composer-2.5-fast',
				customEffort: 'low',
				customEnvVars: parent.customEnvVars,
				customEnvVarsDisabled: parent.customEnvVarsDisabled,
				cwd: '/worktrees/grok',
				projectRoot: '/worktrees/grok',
				parentSessionId: parent.id,
			});
			expect(child.id).not.toBe(parent.id);
			expect(child.agentSessionId).toBeUndefined();
			expect(child.aiTabs).toHaveLength(1);
			expect(child.aiTabs[0]).toMatchObject({
				customModel: selected.customModel,
				customEffort: selected.customEffort,
				permissionMode: permission,
				readOnlyMode: permission === 'readonly',
				agentSessionId: null,
				logs: [],
				stagedImages: [],
				inputValue: '',
			});
			expect(child.activeTabId).toBe(child.aiTabs[0].id);
			expect(parent.aiTabs.map((tab) => tab.id)).not.toContain(child.activeTabId);
			expect(child.aiTabs[0].nativeSessionBinding).toBeUndefined();
			expect(child.aiTabs[0].providerSessions).toBeUndefined();
			expect(child.aiTabs[0].usageStats).toBeUndefined();
			expect(child.customEnvVars).not.toBe(parent.customEnvVars);
			expect(child.customEnvVarsDisabled).not.toBe(parent.customEnvVarsDisabled);
			child.customEnvVars!.GROK_HOME = '/accounts/changed';
			child.customEnvVarsDisabled!.GROK_HOME = '/accounts/changed-parked';
			expect(parent).toEqual(original);
		}
	);

	it.each([undefined, {}, { GROK_HOME: '', GROK_AUTH_PATH: ' ' }])(
		'preserves absent, empty and blank Grok environment maps: %j',
		(env) => {
			const parent = createMockParentSession({
				toolType: 'grok',
				customEnvVars: env,
				customEnvVarsDisabled: env,
			});
			const child = buildWorktreeSession({
				parentSession: parent,
				path: '/worktrees/grok',
				name: 'grok',
				defaultSaveToHistory: true,
				defaultShowThinking: 'off',
			});
			expect(child.customEnvVars).toEqual(env);
			expect(child.customEnvVarsDisabled).toEqual(env);
			if (env) {
				expect(child.customEnvVars).not.toBe(env);
				expect(child.customEnvVarsDisabled).not.toBe(env);
			}
			// Legacy parents may not have any tab array.
			expect(child.aiTabs[0]).toMatchObject({ permissionMode: 'full', readOnlyMode: false });
		}
	);

	it.each<{
		label: string;
		config: Session['sessionSshRemoteConfig'];
		runtime?: string;
		expected: Session['sessionSshRemoteConfig'];
	}>([
		{ label: 'local', config: undefined, expected: undefined },
		{
			label: 'enabled override',
			config: { enabled: true, remoteId: 'remote-a', workingDirOverride: '/remote/parent' },
			expected: {
				enabled: true,
				remoteId: 'remote-a',
				workingDirOverride: '/remote/worktrees/grok',
			},
		},
		{
			label: 'explicit disabled',
			config: { enabled: false, remoteId: 'remote-a' },
			runtime: 'stale-remote',
			expected: { enabled: false, remoteId: 'remote-a' },
		},
		{
			label: 'runtime only',
			config: undefined,
			runtime: 'remote-b',
			expected: { enabled: true, remoteId: 'remote-b' },
		},
		{
			label: 'invalid null target',
			config: { enabled: true, remoteId: null },
			runtime: 'stale-remote',
			expected: { enabled: true, remoteId: null },
		},
	])(
		'preserves Grok $label host ownership without mutating the parent',
		({ config, runtime, expected }) => {
			const parent = createMockParentSession({
				toolType: 'grok',
				sessionSshRemoteConfig: config,
				sshRemoteId: runtime,
			});
			const original = structuredClone(parent);
			const child = buildWorktreeSession({
				parentSession: parent,
				path: '/remote/worktrees/grok',
				name: 'grok',
				defaultSaveToHistory: true,
				defaultShowThinking: 'off',
			});
			expect(child.sessionSshRemoteConfig).toEqual(expected);
			expect(child.cwd).toBe('/remote/worktrees/grok');
			expect(child.sshRemoteId).toBeUndefined();
			if (child.sessionSshRemoteConfig) {
				expect(child.sessionSshRemoteConfig).not.toBe(config);
				child.sessionSshRemoteConfig.workingDirOverride = '/remote/changed';
			}
			expect(parent).toEqual(original);
		}
	);
});
