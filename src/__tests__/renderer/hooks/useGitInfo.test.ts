import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useGitInfo } from '../../../renderer/hooks/mainPanel/useGitInfo';
import type { Session } from '../../../renderer/types';

// Mock GitStatusContext
const mockGetBranchInfo = vi.fn();
const mockGetFileCount = vi.fn();
const mockRefreshGitStatus = vi.fn();

vi.mock('../../../renderer/contexts/GitStatusContext', () => ({
	useGitBranch: () => ({ getBranchInfo: mockGetBranchInfo }),
	useGitFileStatus: () => ({ getFileCount: mockGetFileCount }),
	useGitDetail: () => ({ refreshGitStatus: mockRefreshGitStatus }),
}));

function makeSession(overrides: Partial<Session> = {}): Session {
	return {
		id: 'session-1',
		name: 'Test',
		cwd: '/test',
		fullPath: '/test',
		toolType: 'claude-code',
		inputMode: 'ai',
		aiTabs: [],
		terminalTabs: [],
		isGitRepo: true,
		bookmarked: false,
		...overrides,
	} as Session;
}

describe('useGitInfo', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockGetBranchInfo.mockReturnValue(null);
		mockGetFileCount.mockReturnValue(0);
	});

	it('returns null gitInfo for null session', () => {
		const { result } = renderHook(() => useGitInfo(null));
		expect(result.current.gitInfo).toBeNull();
	});

	it('returns null gitInfo for non-git repo', () => {
		const session = makeSession({ isGitRepo: false });
		mockGetBranchInfo.mockReturnValue({ branch: 'main', remote: '', behind: 0, ahead: 0 });

		const { result } = renderHook(() => useGitInfo(session));
		expect(result.current.gitInfo).toBeNull();
	});

	it('returns gitInfo for git repo', () => {
		const session = makeSession({ isGitRepo: true });
		mockGetBranchInfo.mockReturnValue({
			branch: 'feature/test',
			remote: 'https://github.com/test/repo.git',
			behind: 2,
			ahead: 3,
		});
		mockGetFileCount.mockReturnValue(5);

		const { result } = renderHook(() => useGitInfo(session));

		expect(result.current.gitInfo).toEqual({
			branch: 'feature/test',
			remote: 'https://github.com/test/repo.git',
			behind: 2,
			ahead: 3,
			uncommittedChanges: 5,
		});
	});

	it('returns empty branch when branchInfo has no branch', () => {
		const session = makeSession({ isGitRepo: true });
		mockGetBranchInfo.mockReturnValue({
			branch: '',
			remote: '',
			behind: 0,
			ahead: 0,
		});

		const { result } = renderHook(() => useGitInfo(session));

		expect(result.current.gitInfo?.branch).toBe('');
	});

	it('exposes refreshGitStatus function', () => {
		const { result } = renderHook(() => useGitInfo(null));
		expect(result.current.refreshGitStatus).toBe(mockRefreshGitStatus);
	});

	it('returns null when branchInfo is null', () => {
		const session = makeSession({ isGitRepo: true });
		mockGetBranchInfo.mockReturnValue(null);

		const { result } = renderHook(() => useGitInfo(session));
		expect(result.current.gitInfo).toBeNull();
	});

	it('calls getBranchInfo with session id', () => {
		const session = makeSession({ id: 'my-session' });
		renderHook(() => useGitInfo(session));
		expect(mockGetBranchInfo).toHaveBeenCalledWith('my-session');
	});

	it('calls getFileCount with session id', () => {
		const session = makeSession({ id: 'my-session' });
		renderHook(() => useGitInfo(session));
		expect(mockGetFileCount).toHaveBeenCalledWith('my-session');
	});
});
