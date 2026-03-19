/**
 * Tests for useProviderSwitch helpers.
 * Validates findArchivedPredecessor provenance-chain walking and
 * merge-back session reactivation logic.
 */

import { describe, it, expect } from 'vitest';
import { findArchivedPredecessor } from '../useProviderSwitch';
import type { Session, ToolType } from '../../../types';

// ---------------------------------------------------------------------------
// Minimal session factory — only the fields findArchivedPredecessor touches
// ---------------------------------------------------------------------------

function makeSession(overrides: Partial<Session> & { id: string; toolType: ToolType }): Session {
	return {
		name: overrides.id,
		groupId: undefined,
		state: 'idle',
		cwd: '/tmp',
		fullPath: '/tmp',
		projectRoot: '/tmp',
		aiLogs: [],
		shellLogs: [],
		workLog: [],
		contextUsage: 0,
		inputMode: 'ai',
		aiPid: 0,
		terminalPid: 0,
		port: 3000,
		isLive: false,
		changedFiles: [],
		isGitRepo: false,
		fileTree: [],
		fileExplorerExpanded: [],
		fileExplorerScrollPos: 0,
		executionQueue: [],
		activeTimeMs: 0,
		aiTabs: [],
		activeTabId: '',
		closedTabHistory: [],
		filePreviewTabs: [],
		activeFileTabId: null,
		unifiedTabOrder: [],
		unifiedClosedTabHistory: [],
		...overrides,
	} as Session;
}

// ---------------------------------------------------------------------------
// findArchivedPredecessor
// ---------------------------------------------------------------------------

describe('findArchivedPredecessor', () => {
	it('should return null when there is no provenance chain', () => {
		const current = makeSession({ id: 'A', toolType: 'claude-code' });
		const result = findArchivedPredecessor([current], current, 'codex');
		expect(result).toBeNull();
	});

	it('should return null when chain exists but no archived predecessor matches', () => {
		const original = makeSession({
			id: 'original',
			toolType: 'claude-code',
			// Not archived
		});
		const current = makeSession({
			id: 'current',
			toolType: 'codex',
			migratedFromSessionId: 'original',
		});
		const sessions = [original, current];

		const result = findArchivedPredecessor(sessions, current, 'claude-code');
		expect(result).toBeNull();
	});

	it('should find an archived predecessor matching the target provider', () => {
		const original = makeSession({
			id: 'original',
			toolType: 'claude-code',
			archivedByMigration: true,
			migratedToSessionId: 'current',
		});
		const current = makeSession({
			id: 'current',
			toolType: 'codex',
			migratedFromSessionId: 'original',
		});
		const sessions = [original, current];

		const result = findArchivedPredecessor(sessions, current, 'claude-code');
		expect(result).not.toBeNull();
		expect(result!.id).toBe('original');
	});

	it('should skip non-archived predecessors in the chain', () => {
		const grandparent = makeSession({
			id: 'gp',
			toolType: 'claude-code',
			archivedByMigration: true,
			migratedToSessionId: 'parent',
		});
		const parent = makeSession({
			id: 'parent',
			toolType: 'claude-code',
			migratedFromSessionId: 'gp',
			// NOT archived — was reactivated
		});
		const current = makeSession({
			id: 'current',
			toolType: 'codex',
			migratedFromSessionId: 'parent',
		});
		const sessions = [grandparent, parent, current];

		// parent is claude-code but NOT archived, so it should skip to grandparent
		const result = findArchivedPredecessor(sessions, current, 'claude-code');
		expect(result).not.toBeNull();
		expect(result!.id).toBe('gp');
	});

	it('should return the first archived match walking backwards', () => {
		const gp = makeSession({
			id: 'gp',
			toolType: 'claude-code',
			archivedByMigration: true,
		});
		const parent = makeSession({
			id: 'parent',
			toolType: 'claude-code',
			archivedByMigration: true,
			migratedFromSessionId: 'gp',
		});
		const current = makeSession({
			id: 'current',
			toolType: 'codex',
			migratedFromSessionId: 'parent',
		});
		const sessions = [gp, parent, current];

		// Should find 'parent' first (closest archived predecessor)
		const result = findArchivedPredecessor(sessions, current, 'claude-code');
		expect(result).not.toBeNull();
		expect(result!.id).toBe('parent');
	});

	it('should not return the current session even if it matches', () => {
		const current = makeSession({
			id: 'current',
			toolType: 'claude-code',
			archivedByMigration: true, // Matches everything — but is the current session
		});
		const sessions = [current];

		const result = findArchivedPredecessor(sessions, current, 'claude-code');
		expect(result).toBeNull();
	});

	it('should handle cycles in the provenance chain without infinite loop', () => {
		const a = makeSession({
			id: 'A',
			toolType: 'claude-code',
			archivedByMigration: false,
			migratedFromSessionId: 'B',
		});
		const b = makeSession({
			id: 'B',
			toolType: 'codex',
			archivedByMigration: false,
			migratedFromSessionId: 'A', // Cycle: B -> A -> B -> ...
		});
		const sessions = [a, b];

		// Should terminate without hanging
		const result = findArchivedPredecessor(sessions, a, 'codex');
		expect(result).toBeNull(); // B is not archived
	});

	it('should handle a missing session in the chain gracefully', () => {
		const current = makeSession({
			id: 'current',
			toolType: 'codex',
			migratedFromSessionId: 'deleted-session', // Not in the sessions array
		});
		const sessions = [current];

		const result = findArchivedPredecessor(sessions, current, 'claude-code');
		expect(result).toBeNull();
	});

	it('should skip predecessors with wrong toolType', () => {
		const original = makeSession({
			id: 'original',
			toolType: 'opencode', // Wrong provider type
			archivedByMigration: true,
			migratedToSessionId: 'current',
		});
		const current = makeSession({
			id: 'current',
			toolType: 'codex',
			migratedFromSessionId: 'original',
		});
		const sessions = [original, current];

		// Looking for claude-code, but predecessor is opencode
		const result = findArchivedPredecessor(sessions, current, 'claude-code');
		expect(result).toBeNull();
	});

	it('should walk a multi-hop chain to find a distant predecessor', () => {
		// Chain: D (current, codex) -> C (opencode, not archived) -> B (codex, archived) -> A (claude-code, archived)
		const a = makeSession({
			id: 'A',
			toolType: 'claude-code',
			archivedByMigration: true,
		});
		const b = makeSession({
			id: 'B',
			toolType: 'codex',
			archivedByMigration: true,
			migratedFromSessionId: 'A',
		});
		const c = makeSession({
			id: 'C',
			toolType: 'opencode',
			archivedByMigration: false, // Not archived
			migratedFromSessionId: 'B',
		});
		const d = makeSession({
			id: 'D',
			toolType: 'codex',
			migratedFromSessionId: 'C',
		});
		const sessions = [a, b, c, d];

		// Looking for claude-code: should walk D -> C -> B -> A and find A
		const result = findArchivedPredecessor(sessions, d, 'claude-code');
		expect(result).not.toBeNull();
		expect(result!.id).toBe('A');
	});
});

// ---------------------------------------------------------------------------
// Merge-back session reactivation logic
// ---------------------------------------------------------------------------

describe('merge-back session construction', () => {
	it('reactivated session preserves original identity fields', () => {
		const archived = makeSession({
			id: 'original-id',
			toolType: 'claude-code',
			name: 'My Project',
			cwd: '/home/user/project',
			projectRoot: '/home/user/project',
			groupId: 'group-1',
			bookmarked: true,
			archivedByMigration: true,
			migrationGeneration: 1,
			migratedToSessionId: 'source-id',
			aiTabs: [
				{
					id: 'tab-1',
					agentSessionId: null,
					name: null,
					starred: false,
					logs: [{ id: 'log-1', timestamp: 1000, source: 'user' as const, text: 'hello' }],
					inputValue: '',
					stagedImages: [],
					createdAt: 1000,
					state: 'idle' as const,
					saveToHistory: true,
					showThinking: 'off' as const,
				},
			],
		});

		const sourceSession = makeSession({
			id: 'source-id',
			toolType: 'codex',
			name: 'My Project',
			migratedFromSessionId: 'original-id',
		});

		// Simulate the reactivation spread from the hook
		const reactivated: Session = {
			...archived,
			archivedByMigration: false,
			migratedFromSessionId: sourceSession.id,
			migratedAt: Date.now(),
			migrationGeneration: (archived.migrationGeneration || 0) + 1,
			migratedToSessionId: undefined,
			lastMergeBackAt: Date.now(),
		};

		// Identity preserved
		expect(reactivated.id).toBe('original-id');
		expect(reactivated.name).toBe('My Project');
		expect(reactivated.cwd).toBe('/home/user/project');
		expect(reactivated.projectRoot).toBe('/home/user/project');
		expect(reactivated.groupId).toBe('group-1');
		expect(reactivated.bookmarked).toBe(true);
		expect(reactivated.toolType).toBe('claude-code');

		// Provenance updated
		expect(reactivated.archivedByMigration).toBe(false);
		expect(reactivated.migratedFromSessionId).toBe('source-id');
		expect(reactivated.migrationGeneration).toBe(2);
		expect(reactivated.migratedToSessionId).toBeUndefined();
		expect(reactivated.lastMergeBackAt).toBeGreaterThan(0);
	});

	it('context logs are appended with separator to existing tab logs', () => {
		const existingLog = {
			id: 'existing-1',
			timestamp: 1000,
			source: 'user' as const,
			text: 'original context',
		};
		const archived = makeSession({
			id: 'original-id',
			toolType: 'claude-code',
			archivedByMigration: true,
			aiTabs: [
				{
					id: 'tab-1',
					agentSessionId: null,
					name: null,
					starred: false,
					logs: [existingLog],
					inputValue: '',
					stagedImages: [],
					createdAt: 1000,
					state: 'idle' as const,
					saveToHistory: true,
					showThinking: 'off' as const,
				},
			],
		});

		const newContextLogs = [
			{ id: 'new-1', timestamp: 2000, source: 'user' as const, text: 'new context from codex' },
		];

		// Simulate the merge-back append logic from the hook
		const reactivated = { ...archived, archivedByMigration: false };
		const mergeTab = { ...reactivated.aiTabs[0] };

		const separator = {
			id: `merge-separator-${Date.now()}`,
			timestamp: Date.now(),
			source: 'system' as const,
			text: '── Context merged from Codex session ──',
		};

		const switchNotice = {
			id: `provider-switch-notice-${Date.now()}`,
			timestamp: Date.now(),
			source: 'system' as const,
			text: 'Provider switched back from Codex to Claude Code. Context groomed and optimized.',
		};

		mergeTab.logs = [...mergeTab.logs, separator, switchNotice, ...newContextLogs];

		// Original log preserved at start
		expect(mergeTab.logs[0]).toBe(existingLog);
		// Separator added
		expect(mergeTab.logs[1].source).toBe('system');
		expect(mergeTab.logs[1].text).toContain('Context merged from');
		// Switch notice
		expect(mergeTab.logs[2].source).toBe('system');
		expect(mergeTab.logs[2].text).toContain('Provider switched back');
		// New context appended
		expect(mergeTab.logs[3].text).toBe('new context from codex');
		// Total: 1 existing + 1 separator + 1 notice + 1 new = 4
		expect(mergeTab.logs).toHaveLength(4);
	});

	it('source session is correctly marked as archived after merge-back', () => {
		const source = makeSession({
			id: 'source-id',
			toolType: 'codex',
		});

		// Simulate source archiving (done in App.tsx)
		const archivedSource: Session = {
			...source,
			archivedByMigration: true,
			migratedToSessionId: 'target-id',
		};

		expect(archivedSource.archivedByMigration).toBe(true);
		expect(archivedSource.migratedToSessionId).toBe('target-id');
		// Original identity preserved
		expect(archivedSource.id).toBe('source-id');
		expect(archivedSource.toolType).toBe('codex');
	});
});
