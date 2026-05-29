/**
 * @file useGitStatusPolling.test.ts
 * @description Unit tests for the useGitStatusPolling hook
 *
 * Tests cover:
 * - Clearing stale git status data when no git repos remain
 * - Polling when the document is hidden and pauseWhenHidden is disabled
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useGitStatusPolling, getScaledPollInterval } from '../../renderer/hooks';
import type { Session } from '../../renderer/types';
import { gitService } from '../../renderer/services/git';

const activityBusState = vi.hoisted(() => ({
	handlers: [] as Array<() => void>,
	unsubscribe: vi.fn(),
}));

vi.mock('../../renderer/services/git', () => ({
	gitService: {
		getStatus: vi.fn(),
		getNumstat: vi.fn(),
	},
}));

vi.mock('../../renderer/utils/activityBus', () => ({
	subscribeToActivity: vi.fn((handler: () => void) => {
		activityBusState.handlers.push(handler);
		return activityBusState.unsubscribe;
	}),
}));

const createMockSession = (overrides: Partial<Session> = {}): Session => ({
	id: 'session-1',
	name: 'Test Session',
	toolType: 'claude-code',
	state: 'idle',
	cwd: '/test/project',
	fullPath: '/test/project',
	projectRoot: '/test/project',
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
	executionQueue: [],
	activeTimeMs: 0,
	aiTabs: [],
	activeTabId: 'tab-1',
	closedTabHistory: [],
	...overrides,
});

const setDocumentHidden = (hidden: boolean) => {
	Object.defineProperty(document, 'hidden', {
		configurable: true,
		value: hidden,
	});
};

describe('useGitStatusPolling', () => {
	let originalGit: typeof window.maestro.git | undefined;

	beforeEach(() => {
		vi.clearAllMocks();
		activityBusState.handlers = [];
		setDocumentHidden(false);
		originalGit = window.maestro.git as typeof window.maestro.git | undefined;
		window.maestro = {
			...window.maestro,
			git: {
				...window.maestro.git,
				info: vi.fn().mockResolvedValue({
					branch: 'main',
					remote: 'origin',
					ahead: 0,
					behind: 0,
				}),
			},
		};
	});

	afterEach(() => {
		vi.useRealTimers();
		setDocumentHidden(false);
		if (originalGit) {
			window.maestro.git = originalGit;
		} else {
			delete (window.maestro as { git?: unknown }).git;
		}
	});

	it('clears git status map when no git sessions remain', async () => {
		vi.mocked(gitService.getStatus).mockResolvedValue({
			files: [{ path: 'README.md', status: 'M' }],
			branch: 'main',
		});

		const initialSessions = [createMockSession({ id: 'git-session', isGitRepo: true })];

		const { result, rerender } = renderHook(({ sessions }) => useGitStatusPolling(sessions), {
			initialProps: { sessions: initialSessions },
		});

		await waitFor(() => {
			expect(result.current.gitStatusMap.get('git-session')?.fileCount).toBe(1);
		});

		rerender({ sessions: [createMockSession({ id: 'git-session', isGitRepo: false })] });

		await act(async () => {
			await result.current.refreshGitStatus();
		});

		expect(result.current.gitStatusMap.size).toBe(0);
		expect(gitService.getStatus).toHaveBeenCalledTimes(1);
	});

	it('polls even when document is hidden if pauseWhenHidden is false', async () => {
		setDocumentHidden(true);

		vi.mocked(gitService.getStatus).mockResolvedValue({
			files: [],
			branch: 'main',
		});

		const sessions = [createMockSession({ id: 'git-session', isGitRepo: true })];

		renderHook(() => useGitStatusPolling(sessions, { pauseWhenHidden: false, pollInterval: 5000 }));

		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
		});
		expect(gitService.getStatus).toHaveBeenCalledTimes(1);
	});

	it('skips polling when the document is hidden and pauseWhenHidden is enabled', async () => {
		setDocumentHidden(true);

		const sessions = [createMockSession({ id: 'git-session', isGitRepo: true })];
		const { result } = renderHook(() => useGitStatusPolling(sessions));

		await act(async () => {
			await result.current.refreshGitStatus();
		});

		expect(gitService.getStatus).not.toHaveBeenCalled();
		expect(window.maestro.git.info).not.toHaveBeenCalled();
		expect(result.current.gitStatusMap.size).toBe(0);
	});

	it('keeps an already-empty git status map empty when no git sessions exist', async () => {
		const sessions = [createMockSession({ id: 'plain-session', isGitRepo: false })];
		const { result } = renderHook(() => useGitStatusPolling(sessions));

		await act(async () => {
			await result.current.refreshGitStatus();
		});

		expect(result.current.gitStatusMap.size).toBe(0);
		expect(gitService.getStatus).not.toHaveBeenCalled();
	});

	it('fetches active-session git info, numstat details, and SSH context', async () => {
		vi.mocked(window.maestro.git.info).mockResolvedValue({
			branch: 'feature/coverage',
			remote: 'git@github.com:RunMaestro/Maestro.git',
			behind: 2,
			ahead: 3,
		});
		vi.mocked(gitService.getStatus).mockResolvedValue({
			files: [
				{ path: 'src/changed.ts', status: ' M' },
				{ path: 'src/renamed.ts', status: 'R ' },
				{ path: 'docs/new.md', status: '??' },
			],
			branch: 'feature/coverage',
		});
		vi.mocked(gitService.getNumstat).mockResolvedValue({
			files: [
				{ path: 'src/changed.ts', additions: 5, deletions: 2 },
				{ path: 'src/renamed.ts', additions: 1, deletions: 1 },
			],
		});

		const sessions = [
			createMockSession({
				id: 'active-git',
				isGitRepo: true,
				inputMode: 'terminal',
				shellCwd: '/terminal/cwd',
				sessionSshRemoteConfig: {
					enabled: true,
					remoteId: 'session-remote',
				},
			}),
		];
		const { result } = renderHook(() =>
			useGitStatusPolling(sessions, { activeSessionId: 'active-git' })
		);

		await waitFor(() => {
			expect(result.current.gitStatusMap.get('active-git')?.fileChanges).toHaveLength(3);
		});

		expect(window.maestro.git.info).toHaveBeenCalledWith('/terminal/cwd', 'session-remote');
		expect(gitService.getStatus).toHaveBeenCalledWith('/terminal/cwd', 'session-remote');
		expect(gitService.getNumstat).toHaveBeenCalledWith('/terminal/cwd', 'session-remote');

		const status = result.current.gitStatusMap.get('active-git');
		expect(status).toMatchObject({
			fileCount: 3,
			branch: 'feature/coverage',
			remote: 'git@github.com:RunMaestro/Maestro.git',
			behind: 2,
			ahead: 3,
			totalAdditions: 6,
			totalDeletions: 3,
			modifiedCount: 2,
		});
		expect(status?.fileChanges).toEqual([
			{
				path: 'src/changed.ts',
				status: 'M',
				additions: 5,
				deletions: 2,
				modified: true,
			},
			{
				path: 'src/renamed.ts',
				status: 'R',
				additions: 1,
				deletions: 1,
				modified: true,
			},
			{
				path: 'docs/new.md',
				status: '??',
				additions: 0,
				deletions: 0,
				modified: false,
			},
		]);
	});

	it('uses cwd for terminal-mode git sessions when shell cwd is missing', async () => {
		vi.mocked(gitService.getStatus).mockResolvedValue({
			files: [],
			branch: 'main',
		});

		const sessions = [
			createMockSession({
				id: 'terminal-git',
				isGitRepo: true,
				inputMode: 'terminal',
				cwd: '/repo/default',
				shellCwd: undefined,
			}),
		];
		const { result } = renderHook(() => useGitStatusPolling(sessions));

		await act(async () => {
			await result.current.refreshGitStatus();
		});

		expect(gitService.getStatus).toHaveBeenCalledWith('/repo/default', undefined);
	});

	it('drops only sessions whose git status fetch fails', async () => {
		vi.mocked(gitService.getStatus)
			.mockResolvedValueOnce({ files: [{ path: 'ok.ts', status: 'M' }], branch: 'main' })
			.mockRejectedValueOnce(new Error('git failed'));

		const sessions = [
			createMockSession({ id: 'ok', isGitRepo: true }),
			createMockSession({ id: 'broken', cwd: '/broken', isGitRepo: true }),
		];
		const { result } = renderHook(() => useGitStatusPolling(sessions));

		await waitFor(() => {
			expect(result.current.gitStatusMap.size).toBe(1);
		});

		expect(result.current.gitStatusMap.has('ok')).toBe(true);
		expect(result.current.gitStatusMap.has('broken')).toBe(false);
	});

	it('replaces same-sized status maps when the git session id changes', async () => {
		vi.mocked(gitService.getStatus)
			.mockResolvedValueOnce({ files: [{ path: 'a.ts', status: 'M' }], branch: 'main' })
			.mockResolvedValueOnce({ files: [{ path: 'b.ts', status: 'M' }], branch: 'main' });

		const { result, rerender } = renderHook(({ sessions }) => useGitStatusPolling(sessions), {
			initialProps: {
				sessions: [createMockSession({ id: 'git-a', isGitRepo: true })],
			},
		});

		await waitFor(() => {
			expect(result.current.gitStatusMap.has('git-a')).toBe(true);
		});

		rerender({ sessions: [createMockSession({ id: 'git-b', isGitRepo: true })] });
		await act(async () => {
			await result.current.refreshGitStatus();
		});

		expect(result.current.gitStatusMap.has('git-a')).toBe(false);
		expect(result.current.gitStatusMap.get('git-b')?.fileCount).toBe(1);
	});

	it('stops polling after inactivity', () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
		vi.mocked(gitService.getStatus).mockResolvedValue({
			files: [],
			branch: 'main',
		});

		const sessions = [createMockSession({ id: 'git-session', isGitRepo: true })];
		const { unmount } = renderHook(() =>
			useGitStatusPolling(sessions, {
				inactivityTimeout: 50,
				pauseWhenHidden: false,
				pollInterval: 100,
			})
		);

		expect(gitService.getStatus).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(1);

		act(() => {
			vi.setSystemTime(new Date('2026-01-01T00:00:00.100Z'));
			vi.advanceTimersByTime(100);
		});
		expect(vi.getTimerCount()).toBe(0);
		unmount();
	});

	it('handles a stale inactivity tick after the interval was already cleared', () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
		vi.mocked(gitService.getStatus).mockResolvedValue({
			files: [],
			branch: 'main',
		});
		const intervalCallbacks: Array<() => void> = [];
		const setIntervalSpy = vi.spyOn(globalThis, 'setInterval').mockImplementation((callback) => {
			intervalCallbacks.push(callback as () => void);
			return 1 as ReturnType<typeof setInterval>;
		});
		const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => {});

		const sessions = [createMockSession({ id: 'git-session', isGitRepo: true })];
		const { unmount } = renderHook(() =>
			useGitStatusPolling(sessions, {
				inactivityTimeout: 50,
				pollInterval: 100,
			})
		);

		act(() => {
			vi.setSystemTime(new Date('2026-01-01T00:00:00.100Z'));
			intervalCallbacks[0]();
			intervalCallbacks[0]();
		});

		expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
		unmount();
		setIntervalSpy.mockRestore();
		clearIntervalSpy.mockRestore();
	});

	it('continues polling while activity is within the inactivity timeout', () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
		vi.mocked(gitService.getStatus).mockResolvedValue({
			files: [],
			branch: 'main',
		});

		const sessions = [createMockSession({ id: 'git-session', isGitRepo: true })];
		const { unmount } = renderHook(() =>
			useGitStatusPolling(sessions, {
				inactivityTimeout: 1000,
				pauseWhenHidden: false,
				pollInterval: 100,
			})
		);

		expect(gitService.getStatus).toHaveBeenCalledTimes(1);
		act(() => {
			vi.setSystemTime(new Date('2026-01-01T00:00:00.100Z'));
			vi.advanceTimersByTime(100);
		});

		expect(gitService.getStatus).toHaveBeenCalledTimes(2);
		expect(vi.getTimerCount()).toBe(1);
		unmount();
	});

	it('restarts polling when activity resumes after inactivity stopped the interval', () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
		vi.mocked(gitService.getStatus).mockResolvedValue({
			files: [],
			branch: 'main',
		});

		const sessions = [createMockSession({ id: 'git-session', isGitRepo: true })];
		const { unmount } = renderHook(() =>
			useGitStatusPolling(sessions, {
				inactivityTimeout: 50,
				pauseWhenHidden: false,
				pollInterval: 100,
			})
		);

		expect(gitService.getStatus).toHaveBeenCalledTimes(1);
		act(() => {
			vi.setSystemTime(new Date('2026-01-01T00:00:00.100Z'));
			vi.advanceTimersByTime(100);
		});
		expect(vi.getTimerCount()).toBe(0);

		act(() => {
			activityBusState.handlers[0]();
			vi.advanceTimersByTime(100);
		});

		expect(gitService.getStatus).toHaveBeenCalledTimes(2);
		expect(vi.getTimerCount()).toBe(1);
		unmount();
	});

	it('debounces activity updates and clears replaced activity timers', () => {
		vi.useFakeTimers();
		vi.mocked(gitService.getStatus).mockResolvedValue({
			files: [],
			branch: 'main',
		});
		const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

		const sessions = [createMockSession({ id: 'git-session', isGitRepo: true })];
		const { unmount } = renderHook(() =>
			useGitStatusPolling(sessions, { pauseWhenHidden: false, pollInterval: 1000 })
		);

		act(() => {
			activityBusState.handlers[0]();
			activityBusState.handlers[0]();
		});
		expect(clearTimeoutSpy).toHaveBeenCalled();
		act(() => {
			vi.advanceTimersByTime(100);
		});

		expect(vi.getTimerCount()).toBe(1);
		unmount();
		clearTimeoutSpy.mockRestore();
	});

	it('cleans up pending activity debounce timers on unmount', () => {
		vi.useFakeTimers();
		vi.mocked(gitService.getStatus).mockResolvedValue({
			files: [],
			branch: 'main',
		});
		const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

		const sessions = [createMockSession({ id: 'git-session', isGitRepo: true })];
		const { unmount } = renderHook(() =>
			useGitStatusPolling(sessions, { pauseWhenHidden: false, pollInterval: 1000 })
		);

		act(() => {
			activityBusState.handlers[0]();
		});
		unmount();

		expect(activityBusState.unsubscribe).toHaveBeenCalled();
		expect(clearTimeoutSpy).toHaveBeenCalled();
		clearTimeoutSpy.mockRestore();
	});

	it('stops and restarts polling on visibility changes', async () => {
		vi.mocked(gitService.getStatus).mockResolvedValue({
			files: [],
			branch: 'main',
		});
		const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

		const sessions = [createMockSession({ id: 'git-session', isGitRepo: true })];
		renderHook(() => useGitStatusPolling(sessions, { pollInterval: 1000 }));

		await waitFor(() => {
			expect(gitService.getStatus).toHaveBeenCalledTimes(1);
		});

		act(() => {
			setDocumentHidden(true);
			document.dispatchEvent(new Event('visibilitychange'));
		});
		expect(clearIntervalSpy).toHaveBeenCalled();

		act(() => {
			setDocumentHidden(false);
			document.dispatchEvent(new Event('visibilitychange'));
		});

		await waitFor(() => {
			expect(gitService.getStatus).toHaveBeenCalledTimes(2);
		});
		clearIntervalSpy.mockRestore();
	});

	it('ignores visible visibility events when an interval is already running', async () => {
		vi.mocked(gitService.getStatus).mockResolvedValue({
			files: [],
			branch: 'main',
		});

		const sessions = [createMockSession({ id: 'git-session', isGitRepo: true })];
		renderHook(() => useGitStatusPolling(sessions, { pollInterval: 1000 }));

		await waitFor(() => {
			expect(gitService.getStatus).toHaveBeenCalledTimes(1);
		});

		act(() => {
			setDocumentHidden(false);
			document.dispatchEvent(new Event('visibilitychange'));
		});

		expect(gitService.getStatus).toHaveBeenCalledTimes(1);
	});

	it('handles hidden visibility events when polling never started', () => {
		setDocumentHidden(true);
		vi.mocked(gitService.getStatus).mockResolvedValue({
			files: [],
			branch: 'main',
		});
		const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

		const sessions = [createMockSession({ id: 'git-session', isGitRepo: true })];
		renderHook(() => useGitStatusPolling(sessions));

		act(() => {
			document.dispatchEvent(new Event('visibilitychange'));
		});

		expect(gitService.getStatus).not.toHaveBeenCalled();
		expect(clearIntervalSpy).not.toHaveBeenCalled();
		clearIntervalSpy.mockRestore();
	});

	it('does not restart polling on visible events after inactivity made the hook inactive', () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
		vi.mocked(gitService.getStatus).mockResolvedValue({
			files: [],
			branch: 'main',
		});

		const sessions = [createMockSession({ id: 'git-session', isGitRepo: true })];
		const { unmount } = renderHook(() =>
			useGitStatusPolling(sessions, {
				inactivityTimeout: 50,
				pollInterval: 100,
			})
		);

		expect(gitService.getStatus).toHaveBeenCalledTimes(1);
		act(() => {
			vi.setSystemTime(new Date('2026-01-01T00:00:00.100Z'));
			vi.advanceTimersByTime(100);
		});
		expect(vi.getTimerCount()).toBe(0);

		act(() => {
			setDocumentHidden(false);
			document.dispatchEvent(new Event('visibilitychange'));
		});

		expect(gitService.getStatus).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
		unmount();
	});

	it('does not restart polling from activity while hidden', () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
		vi.mocked(gitService.getStatus).mockResolvedValue({
			files: [],
			branch: 'main',
		});

		const sessions = [createMockSession({ id: 'git-session', isGitRepo: true })];
		const { unmount } = renderHook(() =>
			useGitStatusPolling(sessions, {
				inactivityTimeout: 50,
				pollInterval: 100,
			})
		);

		act(() => {
			vi.setSystemTime(new Date('2026-01-01T00:00:00.100Z'));
			vi.advanceTimersByTime(100);
		});
		expect(vi.getTimerCount()).toBe(0);

		act(() => {
			setDocumentHidden(true);
			activityBusState.handlers[0]();
			vi.advanceTimersByTime(100);
		});

		expect(gitService.getStatus).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
		unmount();
	});

	it('restarts polling when git session count crosses a scaled interval threshold', async () => {
		vi.mocked(gitService.getStatus).mockResolvedValue({
			files: [],
			branch: 'main',
		});
		const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

		const threeSessions = [1, 2, 3].map((index) =>
			createMockSession({ id: `git-${index}`, isGitRepo: true })
		);
		const fourSessions = [1, 2, 3, 4].map((index) =>
			createMockSession({ id: `git-${index}`, isGitRepo: true })
		);
		const { rerender } = renderHook(({ sessions }) => useGitStatusPolling(sessions), {
			initialProps: { sessions: threeSessions },
		});

		await waitFor(() => {
			expect(gitService.getStatus).toHaveBeenCalledTimes(3);
		});

		rerender({ sessions: fourSessions });

		await waitFor(() => {
			expect(gitService.getStatus).toHaveBeenCalledTimes(7);
		});
		expect(clearIntervalSpy).toHaveBeenCalled();
		clearIntervalSpy.mockRestore();
	});

	it('does not restart scaled polling while hidden when the interval is active', async () => {
		vi.mocked(gitService.getStatus).mockResolvedValue({
			files: [],
			branch: 'main',
		});
		const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
		const threeSessions = [1, 2, 3].map((index) =>
			createMockSession({ id: `git-${index}`, isGitRepo: true })
		);
		const fourSessions = [1, 2, 3, 4].map((index) =>
			createMockSession({ id: `git-${index}`, isGitRepo: true })
		);

		const { rerender } = renderHook(({ sessions }) => useGitStatusPolling(sessions), {
			initialProps: { sessions: threeSessions },
		});

		await waitFor(() => {
			expect(gitService.getStatus).toHaveBeenCalledTimes(3);
		});

		setDocumentHidden(true);
		rerender({ sessions: fourSessions });

		expect(clearIntervalSpy).toHaveBeenCalled();
		expect(gitService.getStatus).toHaveBeenCalledTimes(3);
		clearIntervalSpy.mockRestore();
	});

	it('does not restart scaled polling while hidden when no interval exists', () => {
		setDocumentHidden(true);
		vi.mocked(gitService.getStatus).mockResolvedValue({
			files: [],
			branch: 'main',
		});
		const threeSessions = [1, 2, 3].map((index) =>
			createMockSession({ id: `git-${index}`, isGitRepo: true })
		);
		const fourSessions = [1, 2, 3, 4].map((index) =>
			createMockSession({ id: `git-${index}`, isGitRepo: true })
		);

		const { rerender } = renderHook(({ sessions }) => useGitStatusPolling(sessions), {
			initialProps: { sessions: threeSessions },
		});

		rerender({ sessions: fourSessions });

		expect(gitService.getStatus).not.toHaveBeenCalled();
	});

	describe('getScaledPollInterval', () => {
		it('returns default 30s for 1-3 git sessions', () => {
			expect(getScaledPollInterval(30000, 1)).toBe(30000);
			expect(getScaledPollInterval(30000, 2)).toBe(30000);
			expect(getScaledPollInterval(30000, 3)).toBe(30000);
		});

		it('returns 45s for 4-7 git sessions', () => {
			expect(getScaledPollInterval(30000, 4)).toBe(45000);
			expect(getScaledPollInterval(30000, 7)).toBe(45000);
		});

		it('returns 60s for 8-12 git sessions', () => {
			expect(getScaledPollInterval(30000, 8)).toBe(60000);
			expect(getScaledPollInterval(30000, 12)).toBe(60000);
		});

		it('returns 90s for 13+ git sessions', () => {
			expect(getScaledPollInterval(30000, 13)).toBe(90000);
			expect(getScaledPollInterval(30000, 50)).toBe(90000);
		});

		it('does not scale custom (non-default) poll intervals', () => {
			// A user-configured interval of 10s should not be scaled
			expect(getScaledPollInterval(10000, 10)).toBe(10000);
			expect(getScaledPollInterval(60000, 20)).toBe(60000);
		});

		it('returns 30s for zero git sessions', () => {
			expect(getScaledPollInterval(30000, 0)).toBe(30000);
		});

		it('falls back to the maximum interval for malformed git session counts', () => {
			expect(getScaledPollInterval(30000, Number.NaN)).toBe(90000);
		});
	});
});
