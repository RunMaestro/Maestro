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
import { useGitStatusPolling } from '../../../renderer/hooks';
import type { Session } from '../../../renderer/types';
import { gitService } from '../../../renderer/services/git';

vi.mock('../../../renderer/services/git', () => ({
	gitService: {
		getStatus: vi.fn(),
		getNumstat: vi.fn(),
	},
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
	beforeEach(() => {
		vi.clearAllMocks();
		setDocumentHidden(false);
	});

	afterEach(() => {
		setDocumentHidden(false);
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

		await waitFor(() => {
			expect(gitService.getStatus).toHaveBeenCalledTimes(1);
		});
	});
});
