// Source: src/__tests__/renderer/hooks/git/useGitCommandRunNotifier.test.tsx
// Source: src/__tests__/renderer/components/GitShortcutActionsBridge.test.tsx
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { vi } from 'vitest';
import { beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { waitFor } from '@testing-library/react';
import { useGitCommandRunNotifier } from '../../../../renderer/hooks/git/useGitCommandRunNotifier';
import { gitService } from '../../../../renderer/services/git';
import { notifyToast } from '../../../../renderer/stores/notificationStore';
import { useGitCommandRunStore } from '../../../../renderer/stores/gitCommandRunStore';
import { gitRunKey } from '../../../../renderer/stores/gitCommandRunStore';
import type { GitRunCommandResult } from '../../../../shared/gitUtils';
import { afterEach } from 'vitest';
import { act } from '@testing-library/react';
import { render } from '@testing-library/react';
import { GitShortcutActionsBridge } from '../../../../renderer/components/GitShortcutActionsBridge';
import { getGitShortcutActions } from '../../../../renderer/services/gitShortcutActions';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import type { Session } from '../../../../renderer/types';
vi.mock('../../../../renderer/services/git', () => ({
	gitService: {
		runCommand: vi.fn(),
		cancelCommand: vi.fn(),
		onCommandOutput: vi.fn(() => vi.fn()),
	},
}));
vi.mock('../../../../renderer/stores/notificationStore', () => ({
	notifyToast: vi.fn(),
}));
const mockRefreshGitStatus = vi.fn().mockResolvedValue(undefined);
vi.mock('../../../../renderer/contexts/GitStatusContext', () => ({
	useGitDetail: () => ({ refreshGitStatus: mockRefreshGitStatus }),
}));
vi.mock('../../../../renderer/hooks/git/useGitAgentActions', () => ({
	useGitAgentActions: (session: Session | null | undefined) => ({
		isGitRepo: Boolean(session?.isGitRepo),
		sessionId: session?.id,
	}),
}));
describe('useGitCommandRunNotifier', () => {
	const TARGET = {
		sessionId: 'session-1',
		operation: 'push' as const,
		cwd: '/test/repo',
		branch: 'main',
	};
	const KEY = gitRunKey(TARGET);

	let settleRun: (result: GitRunCommandResult) => void = () => {};

	describe('useGitCommandRunNotifier', () => {
		beforeEach(() => {
			vi.clearAllMocks();
			useGitCommandRunStore.setState({ runs: {} });
			vi.mocked(gitService.runCommand).mockImplementation(
				() =>
					new Promise<GitRunCommandResult>((resolve) => {
						settleRun = resolve;
					})
			);
		});

		it('toasts and forgets a run that finished off-screen', async () => {
			renderHook(() => useGitCommandRunNotifier(null));
			useGitCommandRunStore.getState().startRun(TARGET);

			settleRun({ success: true, exitCode: 0, cancelled: false });

			await waitFor(() => expect(notifyToast).toHaveBeenCalledTimes(1));
			expect(notifyToast).toHaveBeenCalledWith(
				expect.objectContaining({ color: 'green', title: 'Push complete' })
			);
			expect(mockRefreshGitStatus).toHaveBeenCalled();
			expect(useGitCommandRunStore.getState().runs[KEY]).toBeUndefined();
		});

		it('keeps a failure on screen until the user dismisses it', async () => {
			renderHook(() => useGitCommandRunNotifier(null));
			useGitCommandRunStore.getState().startRun(TARGET);

			settleRun({
				success: false,
				exitCode: 1,
				cancelled: false,
				error: 'rejected: non-fast-forward',
			});

			await waitFor(() => expect(notifyToast).toHaveBeenCalled());
			expect(notifyToast).toHaveBeenCalledWith(
				expect.objectContaining({
					color: 'red',
					title: 'Push failed',
					message: 'rejected: non-fast-forward',
					dismissible: true,
				})
			);
		});

		it('stays quiet when the console is showing that run', async () => {
			renderHook(() => useGitCommandRunNotifier(KEY));
			useGitCommandRunStore.getState().startRun(TARGET);

			settleRun({ success: true, exitCode: 0, cancelled: false });

			// The modal footer already says "Done"; a toast would be noise. Status
			// still refreshes, and the run is kept so the console can render it.
			await waitFor(() => expect(mockRefreshGitStatus).toHaveBeenCalled());
			expect(notifyToast).not.toHaveBeenCalled();
			expect(useGitCommandRunStore.getState().runs[KEY]?.status).toBe('success');
		});

		it('reports a run that settled before it mounted', async () => {
			useGitCommandRunStore.getState().startRun(TARGET);
			settleRun({ success: false, exitCode: 'SIGTERM', cancelled: true });
			await waitFor(() =>
				expect(useGitCommandRunStore.getState().runs[KEY]?.status).toBe('cancelled')
			);

			renderHook(() => useGitCommandRunNotifier(null));

			await waitFor(() => expect(notifyToast).toHaveBeenCalledTimes(1));
			expect(notifyToast).toHaveBeenCalledWith(
				expect.objectContaining({ color: 'yellow', title: 'Push cancelled' })
			);
		});
	});
});
describe('GitShortcutActionsBridge', () => {
	function makeSession(id: string, isGitRepo: boolean): Session {
		return { id, name: id, cwd: `/tmp/${id}`, isGitRepo } as Session;
	}

	describe('GitShortcutActionsBridge', () => {
		beforeEach(() => {
			useSessionStore.setState({
				sessions: [makeSession('a', true), makeSession('b', false)],
				activeSessionId: 'a',
			});
		});

		afterEach(() => {
			useSessionStore.setState({ sessions: [], activeSessionId: undefined });
		});

		it('publishes the active agent actions and renders nothing', () => {
			const { container } = render(<GitShortcutActionsBridge />);

			expect(container.firstChild).toBeNull();
			expect(getGitShortcutActions()).toMatchObject({ isGitRepo: true, sessionId: 'a' });
		});

		it('follows the active agent', () => {
			render(<GitShortcutActionsBridge />);

			act(() => {
				useSessionStore.setState({ activeSessionId: 'b' });
			});

			expect(getGitShortcutActions()).toMatchObject({ isGitRepo: false, sessionId: 'b' });
		});

		it('clears the published actions on unmount', () => {
			const { unmount } = render(<GitShortcutActionsBridge />);
			expect(getGitShortcutActions()).not.toBeNull();

			unmount();

			expect(getGitShortcutActions()).toBeNull();
		});
	});
});
