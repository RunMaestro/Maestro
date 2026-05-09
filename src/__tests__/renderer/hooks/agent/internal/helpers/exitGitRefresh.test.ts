import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
	isGitRefMutatingCommand,
	refreshGitRefsAfterTerminalExit,
} from '../../../../../../renderer/hooks/agent/internal/helpers/exitGitRefresh';
import { gitService } from '../../../../../../renderer/services/git';
import type { LogEntry, Session } from '../../../../../../renderer/types';

vi.mock('../../../../../../renderer/services/git', () => ({
	gitService: {
		getBranches: vi.fn(),
		getTags: vi.fn(),
	},
}));

function userLog(text: string): LogEntry {
	return { id: 'log', timestamp: 0, source: 'user', text };
}

type RefreshTarget = Parameters<typeof refreshGitRefsAfterTerminalExit>[0];

function session(overrides: Partial<RefreshTarget> = {}): RefreshTarget {
	return {
		isGitRepo: true,
		cwd: '/repo',
		shellLogs: [],
		sshRemoteId: undefined,
		sessionSshRemoteConfig: undefined,
		...overrides,
	} as RefreshTarget;
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(gitService.getBranches).mockResolvedValue([] as any);
	vi.mocked(gitService.getTags).mockResolvedValue([] as any);
});

describe('isGitRefMutatingCommand', () => {
	it.each([
		['git checkout main', true],
		['  git fetch  ', true],
		['GIT BRANCH -d foo', true],
		['git status', false],
		['ls', false],
		['', false],
	])('classifies %s -> %s', (cmd, expected) => {
		expect(isGitRefMutatingCommand(cmd)).toBe(expected);
	});
});

describe('refreshGitRefsAfterTerminalExit', () => {
	it('returns null when not a git repo', async () => {
		const result = await refreshGitRefsAfterTerminalExit(session({ isGitRepo: false }));
		expect(result).toBeNull();
		expect(gitService.getBranches).not.toHaveBeenCalled();
	});

	it('returns null when last command is not a ref-mutating git command', async () => {
		const result = await refreshGitRefsAfterTerminalExit(session({ shellLogs: [userLog('ls')] }));
		expect(result).toBeNull();
	});

	it('returns null when no user logs exist', async () => {
		const result = await refreshGitRefsAfterTerminalExit(session({ shellLogs: [] }));
		expect(result).toBeNull();
	});

	it('fetches branches and tags in parallel for a git ref-mutating command', async () => {
		vi.mocked(gitService.getBranches).mockResolvedValue(['main', 'feature'] as any);
		vi.mocked(gitService.getTags).mockResolvedValue(['v1.0.0'] as any);
		const result = await refreshGitRefsAfterTerminalExit(
			session({ shellLogs: [userLog('git checkout main')] })
		);
		expect(result).toEqual({ gitBranches: ['main', 'feature'], gitTags: ['v1.0.0'] });
		expect(gitService.getBranches).toHaveBeenCalledWith('/repo', undefined);
		expect(gitService.getTags).toHaveBeenCalledWith('/repo', undefined);
	});

	it('threads sshRemoteId through to gitService when present', async () => {
		await refreshGitRefsAfterTerminalExit(
			session({
				shellLogs: [userLog('git pull')],
				sshRemoteId: 'remote-1',
			})
		);
		expect(gitService.getBranches).toHaveBeenCalledWith('/repo', 'remote-1');
	});

	it('falls back to sessionSshRemoteConfig.remoteId when sshRemoteId is unset', async () => {
		await refreshGitRefsAfterTerminalExit(
			session({
				shellLogs: [userLog('git fetch')],
				sshRemoteId: undefined,
				sessionSshRemoteConfig: {
					enabled: true,
					remoteId: 'remote-2',
				} as Session['sessionSshRemoteConfig'],
			})
		);
		expect(gitService.getBranches).toHaveBeenCalledWith('/repo', 'remote-2');
	});
});
