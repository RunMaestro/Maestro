/**
 * These directives are the only ones in the family that CHANGE the user's
 * repository, so the first thing proved here is the negative: drawing a message
 * that contains one must not push, commit, or open a PR. Everything after that
 * is the same question from the other side - when the user does press, does the
 * thing that happens match the words on the button?
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { mockTheme } from '../../../helpers/mockTheme';

const gitActions = {
	isGitRepo: true,
	branch: 'feat-x',
	push: vi.fn(),
	createPR: vi.fn(),
	switchBranch: vi.fn(),
	pull: vi.fn(),
	viewLog: vi.fn(),
	viewDiff: vi.fn(),
	configureWorktrees: vi.fn(),
	pushRunning: false,
	pullRunning: false,
	prRunning: false,
	canCreatePR: true,
	canConfigureWorktrees: true,
	ahead: 0,
	behind: 0,
	changes: { fileCount: 0, additions: 0, deletions: 0, modified: 0 },
};

const openModal = vi.fn();
const commitAll = vi
	.fn()
	.mockResolvedValue({ success: true, committed: true, commitHash: 'abc1234' });
const notifyToast = vi.fn();

vi.mock('../../../../renderer/hooks/git/useGitAgentActions', () => ({
	useGitAgentActions: () => gitActions,
	resolveGitCwd: (session: { cwd: string }) => session.cwd,
	resolveGitSshRemoteId: () => undefined,
}));

vi.mock('../../../../renderer/stores/sessionStore', () => ({
	selectSessionById: (id: string) => (state: { sessions: Array<{ id: string }> }) =>
		state.sessions.find((session) => session.id === id),
	useSessionStore: (selector: (state: unknown) => unknown) =>
		selector({ sessions: [{ id: 'session-1', cwd: '/repo', isGitRepo: true }] }),
}));

vi.mock('../../../../renderer/stores/modalStore', () => ({
	useModalStore: { getState: () => ({ openModal }) },
}));

vi.mock('../../../../renderer/services/git', () => ({ gitService: { commitAll } }));
vi.mock('../../../../renderer/stores/notificationStore', () => ({ notifyToast }));

const { GitActionCard, describeGitDirective } =
	await import('../../../../renderer/components/Markdown/components/GitActionCard');

type CardProps = Parameters<typeof GitActionCard>[0];

function renderCard(overrides: Partial<CardProps> = {}) {
	render(
		<GitActionCard
			name="git-push"
			attributes={{}}
			sessionId="session-1"
			theme={mockTheme}
			{...overrides}
		/>
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	gitActions.pushRunning = false;
	gitActions.prRunning = false;
});

describe('describeGitDirective', () => {
	it('names the remote and branch a push would target', () => {
		const plan = describeGitDirective('git-push', { remote: 'upstream', branch: 'main' }, 'main');
		expect(plan.label).toBe('Push to upstream/main');
		expect(plan.command).toBe('git push upstream main');
	});

	it('falls back to the live branch only when the directive named none', () => {
		expect(describeGitDirective('git-push', {}, 'feat-x').command).toBe('git push origin feat-x');
		// The agent named a branch for a reason. Retargeting a push at whatever
		// happens to be checked out is the worst kind of wrong.
		expect(describeGitDirective('git-push', { branch: 'release' }, 'feat-x').command).toBe(
			'git push origin release'
		);
	});

	it('offers no button for a push the runner could not aim', () => {
		// THE mismatch this guards. The runner takes no remote and no branch: it
		// pushes whatever is checked out. So a card printing `git push upstream
		// release` over a click that pushes `feat-x` is the exact lie the command
		// line exists to prevent - it keeps the command and loses the button.
		const wrongBranch = describeGitDirective('git-push', { branch: 'release' }, 'feat-x');
		expect(wrongBranch.surface).toBe('none');
		expect(wrongBranch.note).toContain('feat-x');

		const wrongRemote = describeGitDirective('git-push', { remote: 'upstream' }, 'feat-x');
		expect(wrongRemote.surface).toBe('none');
		expect(wrongRemote.note).toContain('upstream');

		// Unverified is not the same as matching: with no live branch read yet,
		// there is nothing to prove the named one is checked out.
		expect(describeGitDirective('git-push', { branch: 'feat-x' }).surface).toBe('none');

		// The two honored shapes: no target at all, and a target that IS the live
		// state.
		expect(describeGitDirective('git-push', {}, 'feat-x').surface).toBe('push');
		expect(
			describeGitDirective('git-push', { remote: 'origin', branch: 'feat-x' }, 'feat-x').surface
		).toBe('push');
	});

	it('keeps a PR title in the label rather than in a flag nothing passes', () => {
		const plan = describeGitDirective('git-create-pr', { isDraft: 'true', title: 'Add parser' });
		// The form owns the title and cannot open a draft, so neither reaches `gh`.
		// The suggestion stays readable on the control; the command stays true.
		expect(plan.label).toBe('Create draft pull request: Add parser');
		expect(plan.command).toBe('gh pr create');
		expect(plan.surface).toBe('createPR');
	});

	it('will not build half a command when the directive named no target', () => {
		// A fragment on screen reads as a promise nothing can keep.
		expect(describeGitDirective('git-create-branch', {}).command).toBeNull();
		expect(describeGitDirective('git-commit', {}).command).toBeNull();
		// And a commit with no message has nothing to commit WITH, so it offers
		// no button rather than inventing one.
		expect(describeGitDirective('git-commit', {}).surface).toBe('none');
	});

	it('leaves a stage with no surface, since Maestro has no staging one', () => {
		const plan = describeGitDirective('git-stage', { paths: 'src/a.ts' });
		expect(plan.command).toBe('git add src/a.ts');
		expect(plan.surface).toBe('none');
	});
});

describe('GitActionCard', () => {
	it('touches nothing at all when it is merely rendered', () => {
		// THE assertion. A transcript holding a `::git-push` is drawn while the
		// message streams, on every theme change, and again in the History panel
		// weeks later.
		renderCard({ name: 'git-push', attributes: { branch: 'feat-x' } });
		renderCard({ name: 'git-create-pr', attributes: {} });
		renderCard({ name: 'git-commit', attributes: { message: 'Fix it' } });

		expect(gitActions.push).not.toHaveBeenCalled();
		expect(gitActions.createPR).not.toHaveBeenCalled();
		expect(gitActions.switchBranch).not.toHaveBeenCalled();
		expect(commitAll).not.toHaveBeenCalled();
		expect(openModal).not.toHaveBeenCalled();
	});

	it('shows the command before anything is pressed', () => {
		renderCard({ name: 'git-push', attributes: { branch: 'feat-x' } });

		expect(screen.getByTestId('codex-git-action-button')).toHaveTextContent(
			'Push to origin/feat-x'
		);
		expect(screen.getByTestId('codex-git-action-command')).toHaveTextContent(
			'git push origin feat-x'
		);
	});

	it('pushes through the agent own git surface on click', () => {
		renderCard({ name: 'git-push', attributes: { branch: 'feat-x' } });

		fireEvent.click(screen.getByTestId('codex-git-action-button'));

		// The runner modal, which is where a push from the branch pill lands too.
		expect(gitActions.push).toHaveBeenCalledTimes(1);
	});

	it('opens the PR form on click and goes quiet while one is already running', () => {
		renderCard({ name: 'git-create-pr', attributes: {} });
		fireEvent.click(screen.getByTestId('codex-git-action-button'));
		expect(gitActions.createPR).toHaveBeenCalledTimes(1);

		gitActions.prRunning = true;
		renderCard({ name: 'git-create-pr', attributes: {} });
		const buttons = screen.getAllByTestId('codex-git-action-button');
		expect(buttons[buttons.length - 1]).toBeDisabled();
	});

	it('renders a create-branch as the command, since nothing here creates one', () => {
		// The branch switcher SWITCHES. Wiring this to it would hand the user a
		// picker that cannot contain the branch they just asked for.
		renderCard({ name: 'git-create-branch', attributes: { name: 'feat/y' } });

		expect(screen.getByTestId('codex-git-action-command')).toHaveTextContent(
			'git checkout -b feat/y'
		);
		expect(screen.queryByTestId('codex-git-action-button')).toBeNull();
		expect(screen.getByTestId('codex-git-action-note')).toHaveTextContent('does not create');
		expect(gitActions.switchBranch).not.toHaveBeenCalled();
	});

	it('says why a push it cannot aim has nothing to press', () => {
		renderCard({ name: 'git-push', attributes: { branch: 'release' } });

		expect(screen.queryByTestId('codex-git-action-button')).toBeNull();
		expect(screen.getByTestId('codex-git-action-command')).toHaveTextContent(
			'git push origin release'
		);
		expect(screen.getByTestId('codex-git-action-note')).toHaveTextContent('feat-x');
	});

	it('asks before it commits, and commits only after the confirmation runs', () => {
		renderCard({ name: 'git-commit', attributes: { message: 'Fix the parser' } });

		fireEvent.click(screen.getByTestId('codex-git-action-button'));

		// The click opens the dialog. Nothing has been committed yet.
		expect(commitAll).not.toHaveBeenCalled();
		expect(openModal).toHaveBeenCalledWith('confirm', expect.objectContaining({}));
		const [, data] = openModal.mock.calls[0] as [
			string,
			{ message: string; onConfirm: () => void },
		];
		expect(data.message).toContain('git commit -a -m "Fix the parser"');
		expect(data.message).toContain('/repo');

		data.onConfirm();
		expect(commitAll).toHaveBeenCalledWith('/repo', 'Fix the parser', undefined);
	});

	it('renders a stage as the command it suggests, with nothing to press', () => {
		renderCard({ name: 'git-stage', attributes: { paths: 'src/a.ts' } });

		expect(screen.queryByTestId('codex-git-action-button')).toBeNull();
		expect(screen.getByTestId('codex-git-action-command')).toHaveTextContent('git add src/a.ts');
		expect(screen.getByTestId('codex-git-action')).toHaveAttribute('data-git-surface', 'none');
		// Nothing to explain: a stage never had a click in it, so there is no
		// thwarted target to report.
		expect(screen.queryByTestId('codex-git-action-note')).toBeNull();
	});

	it('offers no button when the agent has no repository', () => {
		gitActions.isGitRepo = false;
		renderCard({ name: 'git-push', attributes: { branch: 'feat-x' } });
		gitActions.isGitRepo = true;

		expect(screen.queryByTestId('codex-git-action-button')).toBeNull();
		expect(screen.getByTestId('codex-git-action')).toHaveTextContent('Push to origin/feat-x');
	});
});
