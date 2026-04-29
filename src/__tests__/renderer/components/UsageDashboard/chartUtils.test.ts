/**
 * Tests for chartUtils helpers (UsageDashboard).
 */

import { describe, it, expect } from 'vitest';
import {
	isWorktreeAgent,
	isParentAgent,
	findSessionByStatId,
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
	});
});
