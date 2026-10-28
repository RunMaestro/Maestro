/**
 * Tests for CreatePRModal.
 *
 * Two things matter here and they are independent.
 *
 * The form is a VIEW over prCreationStore: `gh pr create` can take a while, and
 * until the request moved to the store, dismissing this form threw away the PR's
 * outcome (and any error) with it.
 *
 * And Create Pull Request is reachable by right-clicking any Left Bar row, so the
 * agent whose branch the PR opens from is frequently not the highlighted one. Only
 * `cwd` and the branch reach this component, so the agent name has to be threaded
 * in from the host (`AppWorktreeModals`).
 *
 * A third: "Draft with local model" fills the title and description and stops.
 * It must never create the pull request, and it must not exist while the Git
 * drafts task is off, which is the default.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CreatePRModal } from '../../../renderer/components/CreatePRModal';
import { usePRCreationStore, prRunKey } from '../../../renderer/stores/prCreationStore';
import { mockTheme } from '../../helpers/mockTheme';

// Escape/layer registration is not what these tests are about.
vi.mock('../../../renderer/hooks/ui/useModalLayer', () => ({
	useModalLayer: vi.fn(),
}));

const WORKTREE = '/test/worktree';
const KEY = prRunKey(WORKTREE);

const createPR = vi.fn();
const checkGhCli = vi.fn();
const status = vi.fn();
const taskReadiness = vi.fn();
const draftPullRequest = vi.fn();

const GIT_DRAFTS_OFF = {
	taskId: 'git-drafts',
	label: 'Git drafts',
	needs: 'text-gen',
	assignment: { type: 'off' },
	state: 'off',
	detail: 'Git drafts is off.',
};
const GIT_DRAFTS_READY = {
	...GIT_DRAFTS_OFF,
	assignment: { type: 'local', modelId: 'qwen3-1.7b-instruct-q4km' },
	state: 'ready',
	detail: 'Runs Qwen3 1.7B Instruct (Q4_K_M) on this machine.',
};

function renderModal(overrides: Partial<React.ComponentProps<typeof CreatePRModal>> = {}) {
	const props = {
		isOpen: true,
		onClose: vi.fn(),
		theme: mockTheme,
		worktreePath: WORKTREE,
		worktreeBranch: 'visual-polish',
		sessionId: 'session-1',
		availableBranches: ['main', 'visual-polish'],
		...overrides,
	};
	return { ...render(<CreatePRModal {...props} />), props };
}

async function clickCreatePR() {
	const button = await screen.findByRole('button', { name: /create pr/i });
	await waitFor(() => expect(button).toBeEnabled());
	fireEvent.click(button);
}

describe('CreatePRModal', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		usePRCreationStore.setState({ runs: {} });
		// Never resolves: every test here is about the in-flight window.
		createPR.mockImplementation(() => new Promise(() => {}));
		checkGhCli.mockResolvedValue({ installed: true, authenticated: true });
		status.mockResolvedValue({ stdout: '' });
		taskReadiness.mockResolvedValue([GIT_DRAFTS_OFF]);
		(globalThis as unknown as { window: { maestro: unknown } }).window.maestro = {
			git: { createPR, checkGhCli, status },
			localModels: { taskReadiness, draftPullRequest },
		};
	});

	it('offers no draft button while Git drafts is off', async () => {
		renderModal();

		await screen.findByRole('button', { name: /create pr/i });
		await waitFor(() => expect(taskReadiness).toHaveBeenCalledWith('git-drafts'));
		expect(screen.queryByTestId('pr-draft-button')).not.toBeInTheDocument();
	});

	it('fills the title and description from a draft without creating the PR', async () => {
		taskReadiness.mockResolvedValue([GIT_DRAFTS_READY]);
		draftPullRequest.mockResolvedValue({
			success: true,
			title: 'Polish the tab strip',
			body: 'Tightens spacing.\n\n- Align the close button\n- Fix the active ring',
			baseBranch: 'main',
			commitCount: 3,
			truncated: false,
		});
		renderModal();

		fireEvent.click(await screen.findByTestId('pr-draft-button'));

		expect(await screen.findByDisplayValue('Polish the tab strip')).toBeInTheDocument();
		const description = screen.getByPlaceholderText('Add a description...') as HTMLTextAreaElement;
		expect(description.value).toBe(
			'Tightens spacing.\n\n- Align the close button\n- Fix the active ring'
		);
		// The body is four lines, so the box grows to show all of it for review.
		expect(description.rows).toBe(4);
		expect(draftPullRequest).toHaveBeenCalledWith({ cwd: WORKTREE, baseBranch: 'main' });
		// Filling is all it does: the request is still the user's to send.
		expect(createPR).not.toHaveBeenCalled();
		expect(usePRCreationStore.getState().runs[KEY]).toBeUndefined();

		await clickCreatePR();
		expect(createPR).toHaveBeenCalledWith(
			WORKTREE,
			'main',
			'Polish the tab strip',
			'Tightens spacing.\n\n- Align the close button\n- Fix the active ring'
		);
	});

	it('drafts against the target branch that is picked', async () => {
		taskReadiness.mockResolvedValue([GIT_DRAFTS_READY]);
		draftPullRequest.mockResolvedValue({
			success: false,
			status: 'no-changes',
			error: 'nothing to draft from',
		});
		renderModal({ availableBranches: ['main', 'rc'] });

		fireEvent.change(await screen.findByRole('combobox'), { target: { value: 'rc' } });
		fireEvent.click(await screen.findByTestId('pr-draft-button'));

		await waitFor(() =>
			expect(draftPullRequest).toHaveBeenCalledWith({ cwd: WORKTREE, baseBranch: 'rc' })
		);
		expect(await screen.findByTestId('pr-draft-error')).toHaveTextContent('nothing to draft from');
		// A failed draft leaves the branch-derived title alone.
		expect(screen.getByDisplayValue('visual polish')).toBeInTheDocument();
	});

	it('locks the draft button while the pull request is being created', async () => {
		taskReadiness.mockResolvedValue([GIT_DRAFTS_READY]);
		renderModal();
		await screen.findByTestId('pr-draft-button');

		await clickCreatePR();

		expect(screen.getByTestId('pr-draft-button')).toBeDisabled();
	});

	it('hands the request to the store instead of holding it', async () => {
		renderModal();
		await clickCreatePR();

		expect(createPR).toHaveBeenCalledWith(WORKTREE, 'main', 'visual polish', '');
		expect(usePRCreationStore.getState().runs[KEY]?.status).toBe('running');
	});

	it('offers Run in Background while the request is in flight', async () => {
		renderModal();
		await clickCreatePR();

		expect(screen.getByText('Creating...')).toBeInTheDocument();
		const close = screen.getByTestId('create-pr-close');
		expect(close).toHaveTextContent('Run in Background');
		// Closing is the whole point: it must not cancel the request.
		fireEvent.click(close);
		expect(usePRCreationStore.getState().runs[KEY]?.status).toBe('running');
	});

	it('re-attaches to the running request rather than resetting the form', async () => {
		const first = renderModal();
		await clickCreatePR();
		first.unmount();

		renderModal();

		// The branch-derived title would be "visual polish"; what matters is that
		// the submitted values and the spinner come back, not a fresh form.
		expect(await screen.findByText('Creating...')).toBeInTheDocument();
		expect(screen.getByDisplayValue('visual polish')).toBeDisabled();
		expect(createPR).toHaveBeenCalledTimes(1);
	});

	it('shows why the last attempt failed when it is reopened', async () => {
		usePRCreationStore.setState({
			runs: {
				[KEY]: {
					key: KEY,
					sessionId: 'session-1',
					worktreePath: WORKTREE,
					sourceBranch: 'visual-polish',
					targetBranch: 'main',
					title: 'visual polish',
					description: '',
					status: 'failed',
					error: 'no commits between main and visual-polish',
					announced: true,
				},
			},
		});
		renderModal();

		expect(
			await screen.findByText('no commits between main and visual-polish')
		).toBeInTheDocument();
		// And it can be retried from there.
		await clickCreatePR();
		expect(createPR).toHaveBeenCalledTimes(1);
	});
});

function renderHeaderModal(agentName?: string) {
	render(
		<CreatePRModal
			isOpen
			onClose={vi.fn()}
			theme={mockTheme}
			worktreePath="/repo"
			worktreeBranch="fix/crash"
			availableBranches={['main', 'rc']}
			agentName={agentName}
		/>
	);
}

describe('CreatePRModal header', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		window.maestro.git.checkGhCli = vi
			.fn()
			.mockResolvedValue({ installed: true, authenticated: true });
	});

	it('names the agent the PR is opened from', () => {
		renderHeaderModal('Sonoma-Fix');

		expect(screen.getByTestId('modal-subtitle')).toHaveTextContent('Sonoma-Fix');
	});

	it('keeps the heading the bare action', () => {
		// The name must not fold into the heading: that is what an aria-label and
		// a title-derived persisted size would pick up.
		renderHeaderModal('Sonoma-Fix');

		const heading = screen.getByRole('heading');
		expect(heading).toHaveTextContent('Create Pull Request');
		expect(heading).not.toHaveTextContent('Sonoma-Fix');
	});

	it('renders no subtitle when no agent name was threaded through', () => {
		renderHeaderModal(undefined);

		expect(screen.queryByTestId('modal-subtitle')).not.toBeInTheDocument();
	});
});
