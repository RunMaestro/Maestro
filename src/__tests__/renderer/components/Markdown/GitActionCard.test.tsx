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
		expect(describeGitDirective('git-push', { remote: 'upstream', branch: 'main' })).toEqual({
			label: 'Push to upstream/main',
			command: 'git push upstream main',
			surface: 'push',
		});
	});

	it('falls back to the live branch only when the directive named none', () => {
		expect(describeGitDirective('git-push', {}, 'feat-x').command).toBe('git push origin feat-x');
		// The agent named a branch for a reason. Retargeting a push at whatever
		// happens to be checked out is the worst kind of wrong.
		expect(describeGitDirective('git-push', { branch: 'release' }, 'feat-x').command).toBe(
			'git push origin release'
		);
	});

	it('carries a draft PR through to both the label and the command', () => {
		const plan = describeGitDirective('git-create-pr', { isDraft: 'true', title: 'Add parser' });
		expect(plan.label).toBe('Create draft pull request');
		expect(plan.command).toBe('gh pr create --draft --title "Add parser"');
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

	it('opens the branch switcher for a create-branch', () => {
		renderCard({ name: 'git-create-branch', attributes: { name: 'feat/y' } });

		expect(screen.getByTestId('codex-git-action-command')).toHaveTextContent(
			'git checkout -b feat/y'
		);
		fireEvent.click(screen.getByTestId('codex-git-action-button'));
		expect(gitActions.switchBranch).toHaveBeenCalledTimes(1);
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
	});

	it('offers no button when the agent has no repository', () => {
		gitActions.isGitRepo = false;
		renderCard({ name: 'git-push', attributes: { branch: 'feat-x' } });
		gitActions.isGitRepo = true;

		expect(screen.queryByTestId('codex-git-action-button')).toBeNull();
		expect(screen.getByTestId('codex-git-action')).toHaveTextContent('Push to origin/feat-x');
	});
});
