import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorktreeActionsHost } from '../../../renderer/components/WorktreeActions';
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useModalStore } from '../../../renderer/stores/modalStore';
import { useWorktreeCleanupStore } from '../../../renderer/stores/worktreeCleanupStore';
import { openUiSurface } from '../../../renderer/utils/openUiSurface';
import { buildGitWorktreeCommands } from '../../../renderer/components/QuickActionsModal/commands/gitWorktreeCommands';
import { createMockSession } from '../../helpers/mockSession';
import { mockTheme } from '../../helpers/mockTheme';

const state = vi.hoisted(() => ({ snapshot: undefined as any, stale: false, refresh: vi.fn() }));
vi.mock('../../../renderer/hooks/worktree/useWorktreePullRequest', () => ({
	useWorktreePullRequest: () => ({ ...state, loading: false }),
}));
const target = { id: 'journal', sessionId: 'absent-child', path: '/removed/child' };
const listRecoveries = vi.fn();
const complete = vi.fn();
const cancel = vi.fn();
const prepare = vi.fn();
const remove = vi.fn();
const merge = vi.fn();
const preflight = vi.fn();

function renderHost() {
	return render(
		<LayerStackProvider>
			<WorktreeActionsHost theme={mockTheme} />
		</LayerStackProvider>
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	useModalStore.getState().closeModal('worktreeActions');
	useModalStore.getState().closeModal('worktreePRDetails');
	useSessionStore.setState({ sessions: [], activeSessionId: '' });
	useWorktreeCleanupStore.setState({
		runs: {},
		recoveries: [],
		recoveryRuns: {},
		recoveryError: undefined,
	});
	state.snapshot = undefined;
	state.stale = false;
	listRecoveries.mockResolvedValue([]);
	window.maestro.git.getWorktreeRetirementRecoveries = listRecoveries;
	window.maestro.git.completeWorktreeRetirementRecovery = complete;
	window.maestro.git.cancelWorktreeRetirementRecovery = cancel;
	window.maestro.git.prepareWorktreeRetirement = prepare;
	window.maestro.git.removeWorktreeRetirement = remove;
	window.maestro.git.mergeWorktreePullRequest = merge;
	window.maestro.git.preflightWorktreePullRequestMerge = preflight;
});
afterEach(() => useModalStore.getState().closeModal('worktreeActions'));

describe('independent worktree actions', () => {
	it.each(['complete', 'cancel'] as const)(
		'reaches startup %s recovery from a surviving parent without a child',
		async (action) => {
			const parent = createMockSession({ id: 'parent', isGitRepo: true });
			useSessionStore.setState({ sessions: [parent], activeSessionId: parent.id });
			listRecoveries.mockResolvedValueOnce([target]).mockResolvedValue([]);
			complete.mockResolvedValue({ status: 'removed' });
			cancel.mockResolvedValue({ ok: true });
			expect(openUiSurface('worktree-actions')).toEqual({ ok: true });
			renderHost();
			fireEvent.click(
				await screen.findByRole('button', {
					name:
						action === 'complete' ? 'Complete removed checkout recovery' : 'Keep present checkout',
				})
			);
			await screen.findByText(
				action === 'complete'
					? /Recovery complete\. Saved chat/
					: /Recovery cancelled\. The checkout/
			);
			expect(action === 'complete' ? complete : cancel).toHaveBeenCalledExactlyOnceWith('journal');
			expect(prepare).not.toHaveBeenCalled();
			expect(remove).not.toHaveBeenCalled();
			expect(merge).not.toHaveBeenCalled();
			expect(useModalStore.getState().isOpen('worktreePRDetails')).toBe(false);
			fireEvent.click(screen.getByRole('button', { name: 'Close modal' }));
			expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
		}
	);

	it('has a palette route and recovery with no registered agents', async () => {
		const close = vi.fn();
		const commands = buildGitWorktreeCommands({
			activeSession: undefined,
			sessions: [],
			gitActions: {} as any,
			setQuickActionOpen: close,
			shortcuts: {},
			gitService: { getRemoteBrowserUrl: vi.fn() },
			notifyToast: vi.fn(),
			openUrl: vi.fn(),
			logger: { error: vi.fn() },
		});
		commands.find((entry) => entry.id === 'worktreeActions')!.action();
		renderHost();
		await screen.findByText('No startup cleanup recoveries.');
		expect(close).toHaveBeenCalledWith(false);
		expect(
			screen.getByRole('dialog', { name: 'Worktree Actions and Recovery' })
		).toBeInTheDocument();
		fireEvent.keyDown(document, { key: 'Escape' });
		await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
	});

	it('parks a running merge when closed and shows its outcome on reopen', async () => {
		const child = createMockSession({
			id: 'child',
			isGitRepo: true,
			parentSessionId: 'parent',
			worktreeBranch: 'feat/x',
		});
		useSessionStore.setState({ sessions: [child], activeSessionId: child.id });
		const pr = {
			identity: { repository: { owner: 'a', name: 'b' }, number: 42 },
			headRepository: { owner: 'a', name: 'b' },
			headBranch: 'feat/x',
			headSha: 'abc123abc123',
			baseBranch: 'rc',
			state: 'OPEN',
		};
		state.snapshot = {
			discovery: { status: 'found', pullRequest: pr },
			divergence: { status: 'equal' },
		};
		preflight.mockResolvedValue({
			status: 'ready',
			allowedMethods: ['squash'],
			queueRequired: false,
		});
		let finish!: (value: unknown) => void;
		merge.mockReturnValueOnce(
			new Promise((resolve) => {
				finish = resolve;
			})
		);
		openUiSurface('worktree-actions');
		renderHost();
		await screen.findByText('No startup cleanup recoveries.');
		fireEvent.click(screen.getByRole('button', { name: 'Check merge readiness' }));
		fireEvent.click(await screen.findByRole('button', { name: 'Merge pull request' }));
		expect(merge).toHaveBeenCalledOnce();
		fireEvent.click(screen.getByRole('button', { name: 'Close modal' }));
		expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
		await act(async () => finish({ status: 'unknown', message: 'Merge reply unavailable' }));
		act(() => {
			openUiSurface('worktree-actions');
		});
		expect(screen.getByRole('dialog')).toHaveTextContent('Merge reply unavailable');
		expect(
			screen.getByRole('button', { name: 'Check merge readiness' }).closest('div.select-none')
		).toBeInTheDocument();
		expect(merge).toHaveBeenCalledOnce();
	});

	it('pins merge to the selected worktree, preserves readiness gating and refresh', async () => {
		const child = createMockSession({
			id: 'child',
			name: 'Child',
			parentSessionId: 'parent',
			worktreeBranch: 'feat/x',
			cwd: '/repo/child',
			isGitRepo: true,
		});
		const other = createMockSession({ id: 'other' });
		useSessionStore.setState({ sessions: [child, other], activeSessionId: child.id });
		const pr = {
			identity: { repository: { owner: 'a', name: 'b' }, number: 42 },
			headRepository: { owner: 'a', name: 'b' },
			headBranch: 'feat/x',
			headSha: 'abc123abc123',
			baseBranch: 'rc',
			state: 'OPEN',
		};
		state.snapshot = {
			discovery: { status: 'found', pullRequest: pr },
			divergence: { status: 'equal' },
		};
		preflight.mockResolvedValue({ status: 'unavailable', message: 'Test preflight' });
		openUiSurface('worktree-actions');
		renderHost();
		await screen.findByText('No startup cleanup recoveries.');
		expect(prepare).not.toHaveBeenCalled();
		expect(merge).not.toHaveBeenCalled();
		act(() => useSessionStore.setState({ activeSessionId: other.id }));
		fireEvent.click(screen.getByRole('button', { name: 'Check merge readiness' }));
		await screen.findByText('Test preflight');
		expect(preflight).toHaveBeenCalledWith(
			expect.objectContaining({
				worktreePath: '/repo/child',
				target: expect.objectContaining({ identity: pr.identity, headSha: pr.headSha }),
			})
		);
		state.stale = true;
		act(() => useSessionStore.setState({ sessions: [{ ...child }, other] }));
		expect(screen.getByRole('button', { name: 'Check merge readiness' })).toBeDisabled();
		state.stale = false;
		state.snapshot.divergence = { status: 'different' };
		act(() => useSessionStore.setState({ sessions: [{ ...child }, other] }));
		expect(screen.getByRole('button', { name: 'Check merge readiness' })).toBeDisabled();
		fireEvent.click(screen.getByRole('button', { name: 'Refresh PR status' }));
		expect(state.refresh).toHaveBeenCalledOnce();
		expect(merge).not.toHaveBeenCalled();
	});
});
