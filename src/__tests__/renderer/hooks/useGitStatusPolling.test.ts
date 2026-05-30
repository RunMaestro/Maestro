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
import { useGitStatusPolling, getScaledPollInterval } from '../../../renderer/hooks';
import type { Session } from '../../../renderer/types';
import { createMockSession } from '../../helpers/mockSession';
import { gitService } from '../../../renderer/services/git';

vi.mock('../../../renderer/services/git', () => ({
	gitService: {
		getStatus: vi.fn(),
		getNumstat: vi.fn(),
	},
}));

// createMockSession imported from shared helper

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
	});
});
