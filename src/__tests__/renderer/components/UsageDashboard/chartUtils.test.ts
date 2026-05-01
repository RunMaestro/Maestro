/**
 * Tests for chartUtils helpers (UsageDashboard).
 */

import { describe, it, expect } from 'vitest';
import {
	isWorktreeAgent,
	isParentAgent,
	findSessionByStatId,
	prettifyAgentType,
	resolveAgentDisplayName,
	buildNameMap,
} from '../../../../renderer/components/UsageDashboard/chartUtils';
import type { Session } from '../../../../renderer/types';

let idCounter = 0;
function makeSession(overrides: Partial<Session> = {}): Session {
	idCounter++;
	return {
		id: `s${idCounter}`,
		name: `Session ${idCounter}`,
		toolType: 'claude-code',
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
		port: 0,
		isLive: false,
		changedFiles: [],
		isGitRepo: false,
		fileTree: [],
		fileExplorerExpanded: [],
		fileExplorerScrollPos: 0,
		createdAt: 0,
		...overrides,
	} as Session;
}

describe('chartUtils', () => {
	describe('isWorktreeAgent', () => {
		it('returns true when parentSessionId is set', () => {
			const session = makeSession({ parentSessionId: 'parent-id' });
			expect(isWorktreeAgent(session)).toBe(true);
		});

		it('returns false when parentSessionId is undefined', () => {
			const session = makeSession();
			expect(isWorktreeAgent(session)).toBe(false);
		});

		it('returns false when parentSessionId is an empty string', () => {
			const session = makeSession({ parentSessionId: '' });
			expect(isWorktreeAgent(session)).toBe(false);
		});
	});

	describe('isParentAgent', () => {
		it('returns true when worktreeConfig is set', () => {
			const session = makeSession({
				worktreeConfig: { basePath: '/tmp/wt', watchEnabled: true },
			});
			expect(isParentAgent(session)).toBe(true);
		});

		it('returns false when worktreeConfig is undefined', () => {
			const session = makeSession();
			expect(isParentAgent(session)).toBe(false);
		});

		it('does not flag worktree children as parents', () => {
			const session = makeSession({ parentSessionId: 'p1' });
			expect(isParentAgent(session)).toBe(false);
		});
	});

	describe('findSessionByStatId', () => {
		it('returns the session whose id is a prefix of the stat id', () => {
			const a = makeSession({ id: 'sess-aaa' });
			const b = makeSession({ id: 'sess-bbb' });
			expect(findSessionByStatId('sess-bbb-ai-tab1', [a, b])).toBe(b);
		});

		it('matches when stat id equals session id exactly', () => {
			const a = makeSession({ id: 'exact-match' });
			expect(findSessionByStatId('exact-match', [a])).toBe(a);
		});

		it('returns undefined when no session matches', () => {
			const a = makeSession({ id: 'sess-aaa' });
			expect(findSessionByStatId('unrelated-id', [a])).toBeUndefined();
		});

		it('returns undefined for an empty or missing sessions list', () => {
			expect(findSessionByStatId('any-id', undefined)).toBeUndefined();
			expect(findSessionByStatId('any-id', [])).toBeUndefined();
		});

		it('does not mis-match when one session id is a prefix of another (delimited)', () => {
			const sess1 = makeSession({ id: 'sess-1' });
			const sess10 = makeSession({ id: 'sess-10' });
			// Stats key for the longer id should resolve to the longer session
			// regardless of array order.
			expect(findSessionByStatId('sess-10-ai-tab1', [sess1, sess10])).toBe(sess10);
			expect(findSessionByStatId('sess-10-ai-tab1', [sess10, sess1])).toBe(sess10);
			// And for the shorter id with a suffix, the shorter one wins.
			expect(findSessionByStatId('sess-1-ai-tab1', [sess1, sess10])).toBe(sess1);
		});

		it('prefers exact match even when a longer id starts with the same string', () => {
			const sess1 = makeSession({ id: 'sess-1' });
			const sess10 = makeSession({ id: 'sess-10' });
			expect(findSessionByStatId('sess-1', [sess1, sess10])).toBe(sess1);
			expect(findSessionByStatId('sess-10', [sess1, sess10])).toBe(sess10);
		});
	});

	describe('prettifyAgentType', () => {
		it('returns the canonical display name for known agent ids', () => {
			expect(prettifyAgentType('claude-code')).toBe('Claude Code');
			expect(prettifyAgentType('factory-droid')).toBe('Factory Droid');
			expect(prettifyAgentType('opencode')).toBe('OpenCode');
		});

		it('falls back to splitting on hyphens and capitalizing each word', () => {
			expect(prettifyAgentType('my-custom-agent')).toBe('My Custom Agent');
			expect(prettifyAgentType('single')).toBe('Single');
		});

		it('handles empty strings without crashing', () => {
			expect(prettifyAgentType('')).toBe('');
		});
	});

	describe('resolveAgentDisplayName', () => {
		it('matches by session id (with stat suffix) and returns the user name', () => {
			const session = makeSession({ id: 'sess-aaa', name: 'Backend API' });
			expect(resolveAgentDisplayName('sess-aaa-ai-tab1', [session])).toEqual({
				name: 'Backend API',
				isWorktree: false,
			});
		});

		it('flags worktree children via isWorktree', () => {
			const session = makeSession({
				id: 'sess-aaa',
				name: 'Frontend WT',
				parentSessionId: 'parent-id',
			});
			expect(resolveAgentDisplayName('sess-aaa', [session])).toEqual({
				name: 'Frontend WT',
				isWorktree: true,
			});
		});

		it('returns the single matching session name when key is a toolType', () => {
			const session = makeSession({ id: 'sess-bbb', name: 'My Project', toolType: 'codex' });
			expect(resolveAgentDisplayName('codex', [session])).toEqual({
				name: 'My Project',
				isWorktree: false,
			});
		});

		it('returns the prettified type when multiple sessions share the toolType', () => {
			const a = makeSession({ id: 'sess-aaa', name: 'A', toolType: 'claude-code' });
			const b = makeSession({ id: 'sess-bbb', name: 'B', toolType: 'claude-code' });
			expect(resolveAgentDisplayName('claude-code', [a, b])).toEqual({
				name: 'Claude Code',
				isWorktree: false,
			});
		});

		it('falls back to prettifying the key when no session matches', () => {
			expect(resolveAgentDisplayName('claude-code', [])).toEqual({
				name: 'Claude Code',
				isWorktree: false,
			});
			expect(resolveAgentDisplayName('my-custom-thing', undefined)).toEqual({
				name: 'My Custom Thing',
				isWorktree: false,
			});
		});

		it('uses the prettified toolType when a matched session has no name', () => {
			const session = makeSession({ id: 'sess-aaa', name: '', toolType: 'claude-code' });
			expect(resolveAgentDisplayName('sess-aaa', [session])).toEqual({
				name: 'Claude Code',
				isWorktree: false,
			});
		});
	});

	describe('buildNameMap', () => {
		it('resolves each key to its display name and worktree flag', () => {
			const a = makeSession({ id: 'sess-aaa', name: 'Backend' });
			const b = makeSession({ id: 'sess-bbb', name: 'Frontend', parentSessionId: 'p1' });
			const map = buildNameMap(['sess-aaa', 'sess-bbb', 'claude-code'], [a, b]);
			expect(map.get('sess-aaa')).toEqual({ name: 'Backend', isWorktree: false });
			expect(map.get('sess-bbb')).toEqual({ name: 'Frontend', isWorktree: true });
			expect(map.get('claude-code')).toEqual({ name: 'Claude Code', isWorktree: false });
		});

		it('disambiguates collisions with " (2)", " (3)" suffixes in input order', () => {
			const a = makeSession({ id: 'sess-aaa', name: 'API' });
			const b = makeSession({ id: 'sess-bbb', name: 'API' });
			const c = makeSession({ id: 'sess-ccc', name: 'API' });
			const map = buildNameMap(['sess-aaa', 'sess-bbb', 'sess-ccc'], [a, b, c]);
			expect(map.get('sess-aaa')?.name).toBe('API');
			expect(map.get('sess-bbb')?.name).toBe('API (2)');
			expect(map.get('sess-ccc')?.name).toBe('API (3)');
		});

		it('disambiguates collisions across resolution sources (session vs prettified type)', () => {
			const a = makeSession({ id: 'sess-aaa', name: 'Claude Code' });
			const map = buildNameMap(['sess-aaa', 'claude-code'], [a]);
			expect(map.get('sess-aaa')?.name).toBe('Claude Code');
			expect(map.get('claude-code')?.name).toBe('Claude Code (2)');
		});

		it('handles empty input lists', () => {
			expect(buildNameMap([], [])).toEqual(new Map());
		});

		it('returns one entry per key even if keys repeat', () => {
			const a = makeSession({ id: 'sess-aaa', name: 'Backend' });
			const map = buildNameMap(['sess-aaa', 'sess-aaa'], [a]);
			expect(map.size).toBe(1);
			expect(map.get('sess-aaa')?.name).toBe('Backend');
		});
	});
});
