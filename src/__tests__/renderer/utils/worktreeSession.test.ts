/**
 * @file worktreeSession.test.ts
 * @description Tests for the shared buildWorktreeSession utility
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildWorktreeSession } from '../../../renderer/utils/worktreeSession';
import type { Session } from '../../../renderer/types';

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
		customModel: 'opus',
		customContextWindow: 200000,
		nudgeMessage: 'Keep going',
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
		expect(session.customModel).toBe('opus');
		expect(session.customContextWindow).toBe(200000);
		expect(session.nudgeMessage).toBe('Keep going');
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
		expect(session.nudgeMessage).toBeUndefined();
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
});
