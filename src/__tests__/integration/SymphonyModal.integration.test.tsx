import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SymphonyModal } from '../../renderer/components/SymphonyModal';
import { LayerStackProvider } from '../../renderer/contexts/LayerStackContext';
import type { Theme, Session } from '../../renderer/types';
import type {
	ActiveContribution,
	CompletedContribution,
	ContributorStats,
	RegisteredRepository,
	SymphonyIssue,
	SymphonyState,
} from '../../shared/symphony-types';

vi.mock('../../renderer/components/AgentCreationDialog', () => ({
	AgentCreationDialog: (props: Record<string, any>) => {
		if (!props.isOpen) return null;
		return (
			<div role="dialog" aria-label="Agent creation">
				<p>Create agent for {props.issue.title}</p>
				<button type="button" onClick={props.onClose}>
					Close Agent Dialog
				</button>
				<button
					type="button"
					onClick={() =>
						props.onCreateAgent({
							agentType: 'claude-code',
							customArgs: '--dangerously-skip-permissions',
							customEnvVars: { SYMPHONY: 'true' },
							customPath: '/bin/claude',
							issue: props.issue,
							repo: props.repo,
							sessionName: `Symphony ${props.issue.number}`,
							workingDirectory: '/tmp/symphony-work',
						})
					}
				>
					Create Symphony Agent
				</button>
			</div>
		);
	},
}));

const theme: Theme = {
	id: 'custom',
	name: 'Integration Dark',
	mode: 'dark',
	colors: {
		bgMain: '#101114',
		bgSidebar: '#20242b',
		bgActivity: '#181b20',
		border: '#3f3f46',
		textMain: '#f4f4f5',
		textDim: '#a1a1aa',
		accent: '#4f8cff',
		accentDim: '#1d4ed8',
		accentText: '#4f8cff',
		accentForeground: '#ffffff',
		success: '#22c55e',
		warning: '#f59e0b',
		error: '#ef4444',
	},
};

const repo: RegisteredRepository = {
	addedAt: '2026-01-01T00:00:00.000Z',
	category: 'developer-tools',
	description: 'Agent orchestration tools',
	featured: true,
	isActive: true,
	maintainer: { name: 'RunMaestro', url: 'https://github.com/RunMaestro' },
	name: 'Maestro Core',
	slug: 'RunMaestro/Maestro',
	stars: 12_450,
	tags: ['agents', 'testing'],
	url: 'https://github.com/RunMaestro/Maestro',
};

const inactiveRepo: RegisteredRepository = {
	...repo,
	isActive: false,
	name: 'Inactive Repo',
	slug: 'RunMaestro/inactive',
};

const secondRepo: RegisteredRepository = {
	...repo,
	category: 'documentation',
	description: 'Documentation tasks',
	featured: false,
	maintainer: { name: 'Docs Team' },
	name: 'Docs Kit',
	slug: 'RunMaestro/docs-kit',
	stars: 25,
	tags: ['docs'],
	url: 'https://github.com/RunMaestro/docs-kit',
};

const availableIssue: SymphonyIssue = {
	author: 'maintainer',
	body: '- docs/plan.md',
	createdAt: '2026-02-01T00:00:00.000Z',
	documentPaths: [
		{
			isExternal: true,
			name: 'plan.md',
			path: 'https://example.com/plan.md',
		},
		{
			isExternal: false,
			name: 'local.md',
			path: 'docs/local.md',
		},
	],
	htmlUrl: 'https://github.com/RunMaestro/Maestro/issues/42',
	labels: [{ color: '0e8a16', name: 'good first issue' }],
	number: 42,
	status: 'available',
	title: 'Add integration coverage',
	updatedAt: '2026-02-02T00:00:00.000Z',
	url: 'https://api.github.com/repos/RunMaestro/Maestro/issues/42',
};

const blockedIssue: SymphonyIssue = {
	...availableIssue,
	documentPaths: [{ isExternal: false, name: 'blocked.md', path: 'docs/blocked.md' }],
	labels: [{ color: 'b60205', name: 'blocking' }],
	number: 43,
	title: 'Blocked by upstream API',
};

const inProgressIssue: SymphonyIssue = {
	...availableIssue,
	claimedByPr: {
		author: 'ada',
		isDraft: true,
		number: 77,
		url: 'https://github.com/RunMaestro/Maestro/pull/77',
	},
	documentPaths: [{ isExternal: false, name: 'claimed.md', path: 'docs/claimed.md' }],
	number: 44,
	status: 'in_progress',
	title: 'Already claimed',
};

const stats: ContributorStats = {
	estimatedCostDonated: 42.25,
	repositoriesContributed: [
		'RunMaestro/Maestro',
		'RunMaestro/docs-kit',
		'RunMaestro/cli',
		'RunMaestro/web',
		'RunMaestro/mobile',
	],
	totalContributions: 12,
	totalDocumentsProcessed: 21,
	totalIssuesResolved: 9,
	totalMerged: 4,
	totalTasksCompleted: 1250,
	totalTimeSpent: 7_200_000,
	totalTokensUsed: 11_500_000,
	uniqueMaintainersHelped: 3,
	currentStreak: 2,
	longestStreak: 8,
	firstContributionAt: '2025-01-15T00:00:00.000Z',
	lastContributionAt: '2026-02-03T00:00:00.000Z',
};

const activeContribution: ActiveContribution = {
	agentType: 'claude-code',
	branchName: 'symphony/issue-42',
	draftPrNumber: 88,
	draftPrUrl: 'https://github.com/RunMaestro/Maestro/pull/88',
	id: 'contribution-1',
	issueNumber: 42,
	issueTitle: 'Add integration coverage',
	localPath: '/tmp/maestro',
	progress: {
		completedDocuments: 1,
		completedTasks: 3,
		currentDocument: 'plan.md',
		totalDocuments: 2,
		totalTasks: 6,
	},
	repoName: 'Maestro Core',
	repoSlug: 'RunMaestro/Maestro',
	sessionId: 'session-1',
	startedAt: '2026-02-01T00:00:00.000Z',
	status: 'ready_for_review',
	timeSpent: 3_700_000,
	tokenUsage: {
		estimatedCost: 3.5,
		inputTokens: 12_000,
		outputTokens: 4_000,
	},
};

const failedContribution: ActiveContribution = {
	...activeContribution,
	draftPrNumber: undefined,
	draftPrUrl: undefined,
	error: 'Build failed',
	id: 'contribution-2',
	issueNumber: 43,
	issueTitle: 'Fix failed task',
	progress: {
		completedDocuments: 0,
		completedTasks: 0,
		totalDocuments: 0,
		totalTasks: 0,
	},
	sessionId: 'missing-session',
	status: 'failed',
	timeSpent: 45_000,
};

const mergedContribution: CompletedContribution = {
	completedAt: '2026-02-05T00:00:00.000Z',
	documentsProcessed: 2,
	id: 'completed-1',
	issueNumber: 50,
	issueTitle: 'Merged contribution',
	prNumber: 90,
	prUrl: 'https://github.com/RunMaestro/Maestro/pull/90',
	repoName: 'Maestro Core',
	repoSlug: 'RunMaestro/Maestro',
	startedAt: '2026-02-04T00:00:00.000Z',
	tasksCompleted: 9,
	timeSpent: 60_000,
	tokenUsage: { inputTokens: 500_000, outputTokens: 166_000, totalCost: 8.25 },
	wasMerged: true,
};

const closedContribution: CompletedContribution = {
	...mergedContribution,
	id: 'completed-2',
	issueNumber: 51,
	issueTitle: 'Closed contribution',
	prNumber: 91,
	prUrl: 'https://github.com/RunMaestro/Maestro/pull/91',
	wasClosed: true,
	wasMerged: false,
};

const openContribution: CompletedContribution = {
	...mergedContribution,
	id: 'completed-3',
	issueNumber: 52,
	issueTitle: 'Open contribution',
	merged: false,
	prNumber: 92,
	prUrl: 'https://github.com/RunMaestro/Maestro/pull/92',
	wasMerged: false,
};

const sessions = [
	{
		id: 'session-1',
		name: 'Symphony runner',
		status: 'running',
		type: 'claude-code',
		createdAt: Date.now(),
		updatedAt: Date.now(),
		messages: [],
		cwd: '/tmp/maestro',
	} as Session,
];

function createState(overrides: Partial<SymphonyState> = {}): SymphonyState {
	return {
		active: [],
		history: [],
		stats,
		...overrides,
	};
}

function configureBridge(
	state: SymphonyState = createState(),
	overrides: Record<string, any> = {}
) {
	const symphony = window.maestro.symphony as Record<string, any>;

	symphony.getRegistry = vi.fn().mockResolvedValue({
		cacheAge: 61_000,
		fromCache: true,
		registry: {
			lastUpdated: '2026-01-01T00:00:00.000Z',
			repositories: [repo, secondRepo, inactiveRepo],
			schemaVersion: '1.0',
		},
		success: true,
	});
	symphony.getIssueCounts = vi.fn().mockResolvedValue({
		counts: {
			[repo.slug]: 3,
			[secondRepo.slug]: 0,
		},
		fromCache: false,
		success: true,
	});
	symphony.getIssues = vi.fn().mockResolvedValue({
		fromCache: false,
		issues: [inProgressIssue, availableIssue, blockedIssue],
		success: true,
	});
	symphony.getState = vi.fn().mockResolvedValue({
		state,
		success: true,
	});
	symphony.getStats = vi.fn().mockResolvedValue({
		stats,
		success: true,
	});
	symphony.getCompleted = vi.fn().mockResolvedValue({
		contributions: state.history,
		success: true,
	});
	symphony.onUpdated = vi.fn().mockReturnValue(() => {});
	symphony.checkPRStatuses = vi.fn().mockResolvedValue({
		checked: 2,
		closed: 1,
		merged: 1,
		success: true,
	});
	symphony.syncContribution = vi.fn().mockResolvedValue({
		message: 'Contribution synced',
		success: true,
	});
	symphony.cloneRepo = vi.fn().mockResolvedValue({ success: true });
	symphony.startContribution = vi.fn().mockResolvedValue({
		autoRunPath: '/tmp/symphony-work/.maestro/autorun',
		branchName: 'symphony/issue-42',
		draftPrNumber: 93,
		draftPrUrl: 'https://github.com/RunMaestro/Maestro/pull/93',
		success: true,
	});
	symphony.complete = vi.fn().mockResolvedValue({
		prUrl: 'https://github.com/RunMaestro/Maestro/pull/88',
		success: true,
	});
	symphony.fetchDocumentContent = vi.fn().mockResolvedValue({
		content: '# Plan\n\n[External](https://example.com/task)',
		success: true,
	});
	Object.assign(symphony, overrides);

	window.maestro.git.checkGhCli = vi.fn().mockResolvedValue({
		authenticated: true,
		installed: true,
	});
	window.maestro.shell.openExternal = vi.fn().mockResolvedValue(undefined);
}

function renderModal(
	props: Partial<ComponentProps<typeof SymphonyModal>> = {},
	state: SymphonyState = createState(),
	bridgeOverrides: Record<string, any> = {}
) {
	configureBridge(state, bridgeOverrides);
	const onClose = vi.fn();
	const onStartContribution = vi.fn();
	const onSelectSession = vi.fn();

	render(
		<LayerStackProvider>
			<SymphonyModal
				theme={theme}
				isOpen
				onClose={onClose}
				onStartContribution={onStartContribution}
				sessions={sessions}
				onSelectSession={onSelectSession}
				{...props}
			/>
		</LayerStackProvider>
	);

	return { onClose, onSelectSession, onStartContribution };
}

async function openRepoDetail() {
	fireEvent.click(await screen.findByRole('button', { name: /Maestro Core/i }));
	await waitFor(() => expect(window.maestro.symphony.getIssues).toHaveBeenCalledWith(repo.slug));
	await screen.findAllByTitle('View repository on GitHub');
}

async function expectRepositoryDetailHeading(repoName: string) {
	expect(await screen.findByText('Maestro Symphony:')).toBeInTheDocument();
	expect(
		await screen.findByRole('button', { name: new RegExp(repoName, 'i') })
	).toBeInTheDocument();
}

describe('SymphonyModal integration', () => {
	let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		vi.clearAllMocks();
		consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	});

	afterEach(() => {
		cleanup();
		consoleErrorSpy.mockRestore();
	});

	it('loads projects, filters repositories, opens help links, and supports keyboard navigation', async () => {
		const { onClose } = renderModal();

		expect(await screen.findByRole('button', { name: /Maestro Core/i })).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: /Inactive Repo/i })).not.toBeInTheDocument();
		expect(screen.getByText('Cached 1m ago')).toBeInTheDocument();
		expect(await screen.findByText('View 3 Issues')).toBeInTheDocument();
		expect(await screen.findByText('No Issues')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'Help' }));
		expect(screen.getByText('About Maestro Symphony')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'docs.runmaestro.ai/symphony' }));
		expect(window.maestro.shell.openExternal).toHaveBeenCalledWith(
			'https://docs.runmaestro.ai/symphony?theme=dracula'
		);

		fireEvent.click(screen.getByTitle('Register your project for Symphony contributions'));
		expect(window.maestro.shell.openExternal).toHaveBeenCalledWith(
			'https://docs.runmaestro.ai/symphony?theme=dracula'
		);

		fireEvent.change(screen.getByPlaceholderText('Search repositories...'), {
			target: { value: 'docs' },
		});
		expect(screen.getByRole('button', { name: /Docs Kit/i })).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: /Maestro Core/i })).not.toBeInTheDocument();

		fireEvent.change(screen.getByPlaceholderText('Search repositories...'), {
			target: { value: 'missing' },
		});
		expect(screen.getByText('No repositories match your search')).toBeInTheDocument();

		fireEvent.change(screen.getByPlaceholderText('Search repositories...'), {
			target: { value: '' },
		});
		fireEvent.click(screen.getAllByText('Documentation')[0].closest('button')!);
		expect(screen.getByRole('button', { name: /Docs Kit/i })).toBeInTheDocument();

		fireEvent.keyDown(window, { key: ']', metaKey: true, shiftKey: true });
		expect(screen.getByText('0 active contributions')).toBeInTheDocument();
		fireEvent.keyDown(window, { key: '[', metaKey: true, shiftKey: true });
		expect(screen.getByPlaceholderText('Search repositories...')).toBeInTheDocument();

		fireEvent.click(screen.getByTitle('Refresh'));
		await waitFor(() => expect(window.maestro.symphony.checkPRStatuses).toHaveBeenCalled());

		fireEvent.click(screen.getByTitle('Close (Esc)'));
		expect(onClose).toHaveBeenCalled();
	});

	it('renders cached registry age labels from immediate, sub-minute, and hourly cache metadata', async () => {
		const registry = {
			lastUpdated: '2026-01-01T00:00:00.000Z',
			repositories: [repo],
			schemaVersion: '1.0',
		};

		renderModal({}, createState(), {
			getRegistry: vi.fn().mockResolvedValue({
				cacheAge: null,
				fromCache: true,
				registry,
				success: true,
			}),
		});
		expect(await screen.findByText('Cached just now')).toBeInTheDocument();
		cleanup();

		renderModal({}, createState(), {
			getRegistry: vi.fn().mockResolvedValue({
				cacheAge: 15_000,
				fromCache: true,
				registry,
				success: true,
			}),
		});
		expect(await screen.findByText('Cached just now')).toBeInTheDocument();
		cleanup();

		renderModal({}, createState(), {
			getRegistry: vi.fn().mockResolvedValue({
				cacheAge: 2 * 60 * 60 * 1000,
				fromCache: true,
				registry,
				success: true,
			}),
		});
		expect(await screen.findByText('Cached 2h ago')).toBeInTheDocument();
	});

	it('renders repository details, previews documents, opens GitHub links, and starts a contribution', async () => {
		const { onStartContribution } = renderModal();
		await openRepoDetail();

		fireEvent.click(screen.getAllByTitle('View repository on GitHub')[0]);
		expect(window.maestro.shell.openExternal).toHaveBeenCalledWith(repo.url);

		fireEvent.click(screen.getByRole('button', { name: /RunMaestro/i }));
		expect(window.maestro.shell.openExternal).toHaveBeenCalledWith(repo.maintainer.url);

		fireEvent.click(screen.getAllByRole('button', { name: /Draft PR #77 by @ada/i }).at(-1)!);
		expect(window.maestro.shell.openExternal).toHaveBeenCalledWith(
			inProgressIssue.claimedByPr?.url
		);

		fireEvent.click(screen.getByText('Add integration coverage'));
		await waitFor(() =>
			expect(window.maestro.symphony.fetchDocumentContent).toHaveBeenCalledWith(
				'https://example.com/plan.md'
			)
		);
		expect(await screen.findByRole('heading', { name: 'Plan' })).toBeInTheDocument();

		fireEvent.click(screen.getByTitle('View issue on GitHub'));
		expect(window.maestro.shell.openExternal).toHaveBeenCalledWith(availableIssue.htmlUrl);

		fireEvent.click(screen.getAllByRole('button', { name: /plan.md/i }).at(-1)!);
		fireEvent.click(screen.getByRole('button', { name: 'local.md' }));
		expect(await screen.findByText(/This document is located at/)).toBeInTheDocument();
		expect(screen.getByText('docs/local.md')).toBeInTheDocument();

		fireEvent.keyDown(window, { key: '[', metaKey: true, shiftKey: true });
		await waitFor(() =>
			expect(window.maestro.symphony.fetchDocumentContent).toHaveBeenLastCalledWith(
				'https://example.com/plan.md'
			)
		);
		fireEvent.keyDown(window, { key: ']', metaKey: true, shiftKey: true });
		await screen.findByText('Blocked by upstream API');

		fireEvent.click(screen.getByText('Blocked by upstream API'));
		expect(screen.getByText(/Blocked by a dependency/)).toBeInTheDocument();
		expect(screen.getByRole('button', { name: /Start Symphony/i })).toBeDisabled();

		fireEvent.click(screen.getByText('Add integration coverage'));
		fireEvent.click(screen.getByRole('button', { name: /Start Symphony/i }));
		expect(await screen.findByText('GitHub CLI authenticated')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'I Have the Build Tools' }));
		fireEvent.click(await screen.findByRole('button', { name: 'Create Symphony Agent' }));

		await waitFor(() =>
			expect(window.maestro.symphony.cloneRepo).toHaveBeenCalledWith({
				localPath: '/tmp/symphony-work',
				repoUrl: repo.url,
			})
		);
		expect(window.maestro.symphony.startContribution).toHaveBeenCalledWith(
			expect.objectContaining({
				documentPaths: availableIssue.documentPaths,
				issueNumber: availableIssue.number,
				localPath: '/tmp/symphony-work',
				repoSlug: repo.slug,
			})
		);
		expect(onStartContribution).toHaveBeenCalledWith(
			expect.objectContaining({
				agentType: 'claude-code',
				autoRunPath: '/tmp/symphony-work/.maestro/autorun',
				branchName: 'symphony/issue-42',
				customEnvVars: { SYMPHONY: 'true' },
				customPath: '/bin/claude',
				draftPrNumber: 93,
				issue: availableIssue,
				localPath: '/tmp/symphony-work',
				repo,
				sessionName: 'Symphony 42',
			})
		);
	});

	it('handles active contributions, PR status checks, sync, navigation, and finalize actions', async () => {
		const { onClose, onSelectSession } = renderModal(
			{},
			createState({ active: [activeContribution, failedContribution] })
		);

		fireEvent.click(await screen.findByRole('button', { name: /Active \(2\)/i }));
		expect(screen.getByText('2 active contributions')).toBeInTheDocument();
		expect(screen.getByText('Ready for Review')).toBeInTheDocument();
		expect(screen.getByText('Failed')).toBeInTheDocument();
		expect(screen.getByText('Build failed')).toBeInTheDocument();
		expect(screen.getByText('PR will be created on first commit')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: /Draft PR #88/i }));
		expect(window.maestro.shell.openExternal).toHaveBeenCalledWith(activeContribution.draftPrUrl);

		fireEvent.click(screen.getByTitle('Go to session: Symphony runner'));
		expect(onSelectSession).toHaveBeenCalledWith('session-1');
		expect(onClose).toHaveBeenCalled();

		fireEvent.click(screen.getAllByTitle('Sync status with GitHub')[0]);
		await waitFor(() =>
			expect(window.maestro.symphony.syncContribution).toHaveBeenCalledWith(activeContribution.id)
		);
		expect(await screen.findByText('Contribution synced')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: /Check PR Status/i }));
		await waitFor(() => expect(screen.getByText('1 PR merged, 1 PR closed')).toBeInTheDocument());

		fireEvent.click(screen.getByRole('button', { name: /Finalize PR/i }));
		await waitFor(() =>
			expect(window.maestro.symphony.complete).toHaveBeenCalledWith({
				contributionId: activeContribution.id,
				stats: {
					documentsProcessed: 1,
					estimatedCost: 3.5,
					inputTokens: 12_000,
					outputTokens: 4_000,
					tasksCompleted: 3,
					timeSpentMs: 3_700_000,
				},
			})
		);
	});

	it('renders history summaries, completed states, PR links, stats cards, and achievements', async () => {
		renderModal(
			{},
			createState({ history: [mergedContribution, closedContribution, openContribution] })
		);

		fireEvent.click(await screen.findByRole('button', { name: 'History' }));
		expect(screen.getByText('PRs Created')).toBeInTheDocument();
		expect(screen.getByText('Merged contribution')).toBeInTheDocument();
		expect(screen.getByText('Closed contribution')).toBeInTheDocument();
		expect(screen.getByText('Open contribution')).toBeInTheDocument();
		expect(screen.getAllByText('Merged').length).toBeGreaterThan(0);
		expect(screen.getAllByText('Closed').length).toBeGreaterThan(0);
		expect(screen.getAllByText('Open').length).toBeGreaterThan(0);
		expect(screen.getAllByText('666.0K').length).toBeGreaterThan(0);

		fireEvent.click(screen.getByRole('button', { name: /PR #90/i }));
		expect(window.maestro.shell.openExternal).toHaveBeenCalledWith(mergedContribution.prUrl);

		fireEvent.click(screen.getByRole('button', { name: 'Stats' }));
		expect(await screen.findByText('Tokens Donated')).toBeInTheDocument();
		expect(screen.getByText('11.5M')).toBeInTheDocument();
		expect(screen.getByText('Worth $42.25')).toBeInTheDocument();
		expect(screen.getByText('2h 0m')).toBeInTheDocument();
		expect(screen.getByText('5 repositories')).toBeInTheDocument();
		expect(screen.getByText('2 weeks')).toBeInTheDocument();
		expect(screen.getByText('Best: 8 weeks')).toBeInTheDocument();
		expect(screen.getByText('First Steps')).toBeInTheDocument();
		expect(screen.getByText('Token Millionaire')).toBeInTheDocument();
		expect(screen.getByText('Early Adopter')).toBeInTheDocument();
	});

	it('shows loading, error, empty, and pre-flight failure states without starting work', async () => {
		const symphony = window.maestro.symphony as Record<string, any>;
		configureBridge(createState());
		symphony.getRegistry = vi.fn().mockRejectedValue(new Error('registry unavailable'));
		render(
			<LayerStackProvider>
				<SymphonyModal
					theme={theme}
					isOpen
					onClose={vi.fn()}
					onStartContribution={vi.fn()}
					sessions={[]}
					onSelectSession={vi.fn()}
				/>
			</LayerStackProvider>
		);

		expect(await screen.findByText('registry unavailable')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
		await waitFor(() => expect(symphony.getRegistry).toHaveBeenCalledWith(true));
		cleanup();

		configureBridge(createState());
		symphony.getRegistry = vi.fn().mockResolvedValue({
			fromCache: false,
			registry: {
				lastUpdated: '2026-01-01T00:00:00.000Z',
				repositories: [],
				schemaVersion: '1.0',
			},
			success: true,
		});
		render(
			<LayerStackProvider>
				<SymphonyModal
					theme={theme}
					isOpen
					onClose={vi.fn()}
					onStartContribution={vi.fn()}
					sessions={[]}
					onSelectSession={vi.fn()}
				/>
			</LayerStackProvider>
		);

		expect(await screen.findByText('No repositories available')).toBeInTheDocument();
		cleanup();

		configureBridge(createState());
		window.maestro.git.checkGhCli = vi.fn().mockResolvedValue({
			authenticated: false,
			installed: false,
		});
		render(
			<LayerStackProvider>
				<SymphonyModal
					theme={theme}
					isOpen
					onClose={vi.fn()}
					onStartContribution={vi.fn()}
					sessions={[]}
					onSelectSession={vi.fn()}
				/>
			</LayerStackProvider>
		);
		await openRepoDetail();
		fireEvent.click(screen.getByText('Add integration coverage'));
		fireEvent.click(screen.getByRole('button', { name: /Start Symphony/i }));

		expect(await screen.findByText('GitHub CLI Required')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Close' }));
		expect(screen.queryByText('GitHub CLI Required')).not.toBeInTheDocument();

		window.maestro.git.checkGhCli = vi.fn().mockResolvedValue({
			authenticated: false,
			installed: true,
		});
		fireEvent.click(screen.getByRole('button', { name: /Start Symphony/i }));
		expect(await screen.findByText('GitHub CLI Not Authenticated')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Close' }));
		expect(window.maestro.symphony.cloneRepo).not.toHaveBeenCalled();
	});

	it('covers keyboard issue selection, document preview failures, and preview link handling', async () => {
		renderModal();
		await openRepoDetail();

		fireEvent.keyDown(window, { key: ']', metaKey: true, shiftKey: true });
		fireEvent.keyDown(window, { key: '[', metaKey: true, shiftKey: true });

		fireEvent.keyDown(screen.getByText('Add integration coverage').closest('[role="button"]')!, {
			key: 'Enter',
		});
		await waitFor(() =>
			expect(window.maestro.symphony.fetchDocumentContent).toHaveBeenCalledWith(
				'https://example.com/plan.md'
			)
		);

		fireEvent.click(await screen.findByRole('link', { name: 'External' }));
		expect(window.maestro.shell.openExternal).toHaveBeenCalledWith('https://example.com/task');

		fireEvent.click(screen.getByRole('button', { name: 'plan.md' }));
		fireEvent.click(screen.getByRole('button', { name: 'local.md' }));
		expect(await screen.findByText(/This document is located at/)).toBeInTheDocument();

		const selectPlanDocument = () => {
			fireEvent.click(screen.getByRole('button', { name: 'local.md' }));
			fireEvent.click(screen.getAllByRole('button', { name: 'plan.md' }).at(-1)!);
		};
		const selectLocalDocument = () => {
			fireEvent.click(screen.getByRole('button', { name: 'plan.md' }));
			fireEvent.click(screen.getByRole('button', { name: 'local.md' }));
		};

		window.maestro.symphony.fetchDocumentContent = vi.fn().mockResolvedValue({
			error: 'document missing',
			success: false,
		});
		selectPlanDocument();
		expect(await screen.findByText(/document missing/)).toBeInTheDocument();

		selectLocalDocument();
		expect(await screen.findByText(/This document is located at/)).toBeInTheDocument();
		window.maestro.symphony.fetchDocumentContent = vi.fn().mockResolvedValue({
			success: false,
		});
		selectPlanDocument();
		expect(await screen.findByText(/Unknown error/)).toBeInTheDocument();

		selectLocalDocument();
		expect(await screen.findByText(/This document is located at/)).toBeInTheDocument();
		window.maestro.symphony.fetchDocumentContent = vi
			.fn()
			.mockRejectedValue(new Error('network down'));
		selectPlanDocument();
		expect(await screen.findByText(/network down/)).toBeInTheDocument();

		selectLocalDocument();
		expect(await screen.findByText(/This document is located at/)).toBeInTheDocument();
		window.maestro.symphony.fetchDocumentContent = vi.fn().mockRejectedValue('offline');
		selectPlanDocument();
		expect(await screen.findByText(/Unknown error/)).toBeInTheDocument();

		fireEvent.mouseDown(document.body);
	});

	it('handles alternate PR status and sync failures from the active tab', async () => {
		renderModal({}, createState({ active: [activeContribution] }));

		fireEvent.click(await screen.findByRole('button', { name: /Active \(1\)/i }));

		window.maestro.symphony.syncContribution = vi.fn().mockRejectedValue(new Error('sync failed'));
		fireEvent.click(screen.getByTitle('Sync status with GitHub'));
		expect(await screen.findByText('Sync failed')).toBeInTheDocument();

		window.maestro.symphony.checkPRStatuses = vi.fn().mockResolvedValue({
			checked: 2,
			closed: 0,
			merged: 0,
			success: true,
		});
		fireEvent.click(screen.getByRole('button', { name: /Check PR Status/i }));
		expect(await screen.findByText('All PRs up to date')).toBeInTheDocument();

		window.maestro.symphony.checkPRStatuses = vi.fn().mockResolvedValue({
			checked: 0,
			closed: 0,
			merged: 0,
			success: true,
		});
		fireEvent.click(screen.getByRole('button', { name: /Check PR Status/i }));
		expect(await screen.findByText('No PRs to check')).toBeInTheDocument();

		window.maestro.symphony.checkPRStatuses = vi.fn().mockResolvedValue({
			checked: 4,
			closed: 2,
			merged: 2,
			success: true,
		});
		fireEvent.click(screen.getByRole('button', { name: /Check PR Status/i }));
		expect(await screen.findByText('2 PRs merged, 2 PRs closed')).toBeInTheDocument();

		window.maestro.symphony.checkPRStatuses = vi.fn().mockRejectedValue(new Error('rate limited'));
		fireEvent.click(screen.getByRole('button', { name: /Check PR Status/i }));
		expect(await screen.findByText('Failed to check statuses')).toBeInTheDocument();
	});

	it('navigates empty active state, category reset, help close, and closed modal guard paths', async () => {
		renderModal({ isOpen: false });
		expect(screen.queryByText('Maestro Symphony')).not.toBeInTheDocument();
		cleanup();

		renderModal();
		expect(await screen.findByRole('button', { name: /Maestro Core/i })).toBeInTheDocument();

		fireEvent.click(screen.getAllByText('Documentation')[0].closest('button')!);
		expect(screen.getByRole('button', { name: /Docs Kit/i })).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'All' }));
		expect(screen.getByRole('button', { name: /Maestro Core/i })).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'Help' }));
		expect(screen.getByText('About Maestro Symphony')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Close' }));
		expect(screen.queryByText('About Maestro Symphony')).not.toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'Active' }));
		fireEvent.click(screen.getByRole('button', { name: 'Browse Projects' }));
		expect(screen.getByPlaceholderText('Search repositories...')).toBeInTheDocument();
	});

	it('routes Escape through help, detail, and modal layers while supporting project keyboard navigation', async () => {
		const nativeAddEventListener = window.addEventListener.bind(window);
		const keydownHandlers: EventListener[] = [];
		const addEventListenerSpy = vi
			.spyOn(window, 'addEventListener')
			.mockImplementation((type, listener, options) => {
				if (type === 'keydown' && typeof listener === 'function') {
					keydownHandlers.push(listener as EventListener);
				}
				return nativeAddEventListener(type, listener, options);
			});
		const { onClose } = renderModal();
		addEventListenerSpy.mockRestore();
		const searchInput = await screen.findByPlaceholderText('Search repositories...');

		fireEvent.keyDown(window, { key: '/' });
		expect(searchInput).toHaveFocus();
		const preventDefault = vi.fn();
		const blurSpy = vi.spyOn(searchInput, 'blur');
		keydownHandlers.slice(1).forEach((handler) =>
			handler({
				key: 'Escape',
				preventDefault,
				stopPropagation: vi.fn(),
				target: searchInput,
			} as unknown as KeyboardEvent)
		);
		expect(preventDefault).toHaveBeenCalled();
		expect(blurSpy).toHaveBeenCalled();

		fireEvent.keyDown(window, { key: 'ArrowDown' });
		fireEvent.keyDown(window, { key: 'ArrowRight' });
		fireEvent.keyDown(window, { key: 'ArrowLeft' });
		fireEvent.keyDown(window, { key: 'ArrowUp' });
		fireEvent.keyDown(window, { key: 'Enter' });
		await expectRepositoryDetailHeading('Maestro Core');

		fireEvent.keyDown(window, { key: 'Escape' });
		expect(await screen.findByRole('button', { name: /Maestro Core/i })).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'Help' }));
		expect(screen.getByText('About Maestro Symphony')).toBeInTheDocument();
		fireEvent.keyDown(window, { key: 'Escape' });
		expect(screen.queryByText('About Maestro Symphony')).not.toBeInTheDocument();

		fireEvent.change(screen.getByPlaceholderText('Search repositories...'), {
			target: { value: 'missing' },
		});
		fireEvent.keyDown(window, { key: 'ArrowRight' });
		expect(screen.getByText('No repositories match your search')).toBeInTheDocument();

		fireEvent.keyDown(window, { key: 'Escape' });
		expect(onClose).toHaveBeenCalled();
	});

	it('keeps search typing in the input and moves focus to the repository grid on arrow navigation', async () => {
		renderModal();
		const searchInput = await screen.findByPlaceholderText('Search repositories...');

		searchInput.focus();
		fireEvent.keyDown(searchInput, { key: 'a' });
		expect(screen.queryByText('Maestro Symphony: Maestro Core')).not.toBeInTheDocument();

		fireEvent.keyDown(searchInput, { key: 'ArrowDown' });
		await waitFor(() =>
			expect(screen.getByRole('grid', { name: 'Repository tiles' })).toHaveFocus()
		);
	});

	it('renders fallback repository metadata, loading issue skeletons, and empty detail states', async () => {
		let resolveIssues: (value: {
			fromCache: boolean;
			issues: SymphonyIssue[];
			success: boolean;
		}) => void = () => {};
		const mysteryRepo: RegisteredRepository = {
			...repo,
			category: 'unknown-category',
			maintainer: { name: 'Mystery Maintainer' },
			name: 'Mystery Box',
			slug: 'RunMaestro/mystery-box',
			stars: undefined,
			tags: undefined,
		};

		renderModal({}, createState(), {
			getRegistry: vi.fn().mockResolvedValue({
				cacheAge: 0,
				fromCache: false,
				registry: {
					lastUpdated: '2026-01-01T00:00:00.000Z',
					repositories: [mysteryRepo],
					schemaVersion: '1.0',
				},
				success: true,
			}),
			getIssueCounts: vi.fn().mockResolvedValue({
				counts: { [mysteryRepo.slug]: 1 },
				fromCache: false,
				success: true,
			}),
			getIssues: vi.fn(
				() =>
					new Promise((resolve) => {
						resolveIssues = resolve;
					})
			),
		});

		expect(await screen.findByRole('button', { name: /Mystery Box/i })).toBeInTheDocument();
		expect(screen.getAllByText('unknown-category').length).toBeGreaterThan(0);
		expect(await screen.findByText('View 1 Issue')).toBeInTheDocument();

		const mysteryButton = screen.getByRole('button', { name: /Mystery Box/i });
		fireEvent.click(mysteryButton);
		resolveIssues({ fromCache: false, issues: [], success: true });
		await expectRepositoryDetailHeading('Mystery Box');
		expect(await screen.findByText('No issues with runmaestro.ai label')).toBeInTheDocument();
		expect(screen.getByText('No outstanding work for this project')).toBeInTheDocument();
	});

	it('renders the in-progress-only issue state when no available or blocked issues remain', async () => {
		renderModal({}, createState(), {
			getIssues: vi.fn().mockResolvedValue({
				fromCache: false,
				issues: [inProgressIssue],
				success: true,
			}),
		});

		await openRepoDetail();

		expect(screen.getByText('In Progress (1)')).toBeInTheDocument();
		expect(screen.getByText('All issues are currently being worked on')).toBeInTheDocument();
	});

	it('covers issue keyboard guards, non-draft claims, and document navigation fallbacks', async () => {
		const multiDocIssue: SymphonyIssue = {
			...availableIssue,
			documentPaths: [
				{ isExternal: true, name: 'doc-a.md', path: 'https://example.com/doc-a.md' },
				{ isExternal: true, name: 'doc-b.md', path: 'https://example.com/doc-b.md' },
				{ isExternal: true, name: 'doc-c.md', path: 'https://example.com/doc-c.md' },
			],
			number: 45,
			title: 'Multi document task',
		};
		const noDocIssue: SymphonyIssue = {
			...availableIssue,
			documentPaths: [],
			number: 46,
			title: 'No document task',
		};
		const nonDraftClaimedIssue: SymphonyIssue = {
			...inProgressIssue,
			claimedByPr: {
				author: 'ada',
				isDraft: false,
				number: 78,
				url: 'https://github.com/RunMaestro/Maestro/pull/78',
			},
			number: 47,
			title: 'Claimed without draft',
		};

		renderModal({}, createState(), {
			getIssues: vi.fn().mockResolvedValue({
				fromCache: false,
				issues: [multiDocIssue, noDocIssue, nonDraftClaimedIssue],
				success: true,
			}),
			fetchDocumentContent: vi.fn().mockResolvedValue({
				content: '# Remote Doc\n\n[Relative](docs/local.md)',
				success: true,
			}),
		});

		await openRepoDetail();
		expect(screen.getAllByRole('button', { name: /PR #78 by @ada/i }).length).toBeGreaterThan(0);
		expect(screen.getByText('...and 1 more')).toBeInTheDocument();

		fireEvent.keyDown(screen.getByText('Multi document task'), { key: 'Enter' });
		expect(screen.queryByText('Remote Doc')).not.toBeInTheDocument();

		fireEvent.keyDown(screen.getByText('Multi document task').closest('[role="button"]')!, {
			key: 'ArrowLeft',
		});
		expect(screen.queryByText('Remote Doc')).not.toBeInTheDocument();

		fireEvent.keyDown(screen.getByText('Multi document task').closest('[role="button"]')!, {
			key: ' ',
		});
		expect(await screen.findByRole('heading', { name: 'Remote Doc' })).toBeInTheDocument();

		const externalCallsBeforeRelativeLink = (
			window.maestro.shell.openExternal as ReturnType<typeof vi.fn>
		).mock.calls.length;
		fireEvent.click(await screen.findByRole('link', { name: 'Relative' }));
		expect(window.maestro.shell.openExternal).toHaveBeenCalledTimes(
			externalCallsBeforeRelativeLink
		);

		fireEvent.click(screen.getByRole('button', { name: 'doc-a.md' }));
		fireEvent.mouseDown(screen.getAllByRole('button', { name: 'doc-a.md' }).at(-1)!);
		expect(screen.getAllByRole('button', { name: 'doc-a.md' }).length).toBeGreaterThan(1);
		fireEvent.click(screen.getByRole('button', { name: 'doc-c.md' }));
		await waitFor(() =>
			expect(window.maestro.symphony.fetchDocumentContent).toHaveBeenLastCalledWith(
				'https://example.com/doc-c.md'
			)
		);

		fireEvent.keyDown(window, { key: ']', ctrlKey: true, shiftKey: true });
		await waitFor(() =>
			expect(window.maestro.symphony.fetchDocumentContent).toHaveBeenLastCalledWith(
				'https://example.com/doc-a.md'
			)
		);
		const callsBeforeIgnoredDocShortcut = (
			window.maestro.symphony.fetchDocumentContent as ReturnType<typeof vi.fn>
		).mock.calls.length;
		fireEvent.keyDown(window, { key: 'a', ctrlKey: true, shiftKey: true });
		expect(window.maestro.symphony.fetchDocumentContent).toHaveBeenCalledTimes(
			callsBeforeIgnoredDocShortcut
		);
		fireEvent.keyDown(window, { key: '[', ctrlKey: true, shiftKey: true });

		fireEvent.click(screen.getByText('No document task'));
		expect(screen.getByText('Select document')).toBeInTheDocument();
	});

	it('clears transient PR status failures and handles omitted PR check counts', async () => {
		renderModal({}, createState({ active: [activeContribution] }));
		fireEvent.click(await screen.findByRole('button', { name: /Active \(1\)/i }));

		vi.useFakeTimers();
		try {
			window.maestro.symphony.syncContribution = vi
				.fn()
				.mockRejectedValue(new Error('sync failed'));
			fireEvent.click(screen.getByTitle('Sync status with GitHub'));
			await act(async () => {});
			expect(screen.getByText('Sync failed')).toBeInTheDocument();
			act(() => vi.advanceTimersByTime(5000));
			expect(screen.queryByText('Sync failed')).not.toBeInTheDocument();

			window.maestro.symphony.checkPRStatuses = vi
				.fn()
				.mockRejectedValue(new Error('rate limited'));
			fireEvent.click(screen.getByRole('button', { name: /Check PR Status/i }));
			await act(async () => {});
			expect(screen.getByText('Failed to check statuses')).toBeInTheDocument();
			act(() => vi.advanceTimersByTime(5000));
			expect(screen.queryByText('Failed to check statuses')).not.toBeInTheDocument();

			window.maestro.symphony.checkPRStatuses = vi.fn().mockResolvedValue({
				success: true,
			});
			fireEvent.click(screen.getByRole('button', { name: /Check PR Status/i }));
			await act(async () => {});
			expect(screen.getByText('No PRs to check')).toBeInTheDocument();
		} finally {
			vi.useRealTimers();
		}
	});

	it('renders status, sync, history, and achievement fallback states', async () => {
		const unusualContribution: ActiveContribution = {
			...activeContribution,
			draftPrNumber: undefined,
			draftPrUrl: undefined,
			id: 'contribution-unusual',
			progress: {
				completedDocuments: 1,
				completedTasks: 1,
				totalDocuments: 2,
				totalTasks: 2,
			},
			status: 'reviewing' as ActiveContribution['status'],
			timeSpent: 120_000,
			tokenUsage: undefined,
		};
		const legacyMerged: CompletedContribution = {
			...mergedContribution,
			id: 'legacy-merged',
			issueTitle: 'Legacy merged',
			merged: true,
			tokenUsage: { inputTokens: 40, outputTokens: 30, totalCost: 0.01 },
			wasMerged: undefined,
		};
		const legacyOpen: CompletedContribution = {
			...mergedContribution,
			id: 'legacy-open',
			issueTitle: 'Legacy open',
			merged: undefined,
			tokenUsage: { inputTokens: 10, outputTokens: 20, totalCost: 0.02 },
			wasMerged: undefined,
		};
		const lowStats: ContributorStats = {
			...stats,
			currentStreak: 0,
			estimatedCostDonated: 0.25,
			firstContributionAt: undefined,
			longestStreak: 1,
			repositoriesContributed: [],
			totalContributions: 1,
			totalMerged: 0,
			totalTasksCompleted: 2,
			totalTimeSpent: 30_000,
			totalTokensUsed: 500,
		};

		renderModal(
			{},
			createState({
				active: [unusualContribution],
				history: [legacyMerged, legacyOpen],
			}),
			{
				checkPRStatuses: vi.fn().mockResolvedValue({
					checked: 1,
					success: true,
				}),
				getCompleted: vi.fn().mockResolvedValue({
					contributions: [legacyMerged, legacyOpen],
					success: true,
				}),
				getStats: vi.fn().mockResolvedValue({
					stats: lowStats,
					success: true,
				}),
				syncContribution: vi.fn().mockResolvedValue({
					success: true,
				}),
			}
		);

		fireEvent.click(await screen.findByRole('button', { name: /Active \(1\)/i }));
		expect(screen.getByText('reviewing')).toBeInTheDocument();
		expect(screen.getByText('1 / 2 documents')).toBeInTheDocument();
		expect(screen.getByText('2m')).toBeInTheDocument();
		fireEvent.click(screen.getByTitle('Sync status with GitHub'));
		await waitFor(() =>
			expect(window.maestro.symphony.syncContribution).toHaveBeenCalledWith(unusualContribution.id)
		);

		fireEvent.click(screen.getByRole('button', { name: /Check PR Status/i }));
		expect(await screen.findByText('All PRs up to date')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'History' }));
		expect(await screen.findByText('Legacy merged')).toBeInTheDocument();
		expect(screen.getByText('Legacy open')).toBeInTheDocument();
		expect(screen.getByText('70')).toBeInTheDocument();
		expect(screen.getByText('30')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'Stats' }));
		expect(await screen.findByText('500')).toBeInTheDocument();
		expect(screen.getByText('Worth $0.25')).toBeInTheDocument();
		expect(screen.getByText('30s')).toBeInTheDocument();
		expect(screen.getByText('0 repositories')).toBeInTheDocument();
		expect(screen.getByText('Best: 1 weeks')).toBeInTheDocument();
		expect(screen.getByText('Harmony Seeker')).toBeInTheDocument();

		cleanup();
		renderModal({}, createState({ history: [] }), {
			getCompleted: vi.fn().mockResolvedValue({
				contributions: [],
				success: true,
			}),
			getStats: vi.fn().mockResolvedValue({
				stats: lowStats,
				success: true,
			}),
		});
		fireEvent.click(await screen.findByRole('button', { name: 'History' }));
		expect(screen.getByText('No completed contributions')).toBeInTheDocument();
	});

	it('handles pre-flight dismissal, agent dialog close, start failures, and rejected gh checks', async () => {
		const { onStartContribution } = renderModal();
		await openRepoDetail();
		fireEvent.click(screen.getByText('Add integration coverage'));

		fireEvent.click(screen.getByRole('button', { name: /Start Symphony/i }));
		expect(await screen.findByText('GitHub CLI authenticated')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
		expect(screen.queryByText('GitHub CLI authenticated')).not.toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: /Start Symphony/i }));
		expect(await screen.findByText('GitHub CLI authenticated')).toBeInTheDocument();
		fireEvent.click(screen.getByLabelText('Close pre-flight check dialog'));
		expect(screen.queryByText('GitHub CLI authenticated')).not.toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: /Start Symphony/i }));
		fireEvent.click(await screen.findByRole('button', { name: 'I Have the Build Tools' }));
		fireEvent.click(screen.getByRole('button', { name: 'Close Agent Dialog' }));
		expect(screen.queryByRole('dialog', { name: 'Agent creation' })).not.toBeInTheDocument();

		window.maestro.symphony.startContribution = vi.fn().mockResolvedValue({
			error: 'branch exists',
			success: false,
		});
		fireEvent.click(screen.getByRole('button', { name: /Start Symphony/i }));
		fireEvent.click(await screen.findByRole('button', { name: 'I Have the Build Tools' }));
		fireEvent.click(await screen.findByRole('button', { name: 'Create Symphony Agent' }));
		await waitFor(() => expect(window.maestro.symphony.startContribution).toHaveBeenCalled());
		expect(onStartContribution).not.toHaveBeenCalled();

		window.maestro.symphony.startContribution = vi.fn().mockResolvedValue({
			success: false,
		});
		fireEvent.click(screen.getByRole('button', { name: 'Create Symphony Agent' }));
		await waitFor(() => expect(window.maestro.symphony.startContribution).toHaveBeenCalled());
		expect(onStartContribution).not.toHaveBeenCalled();

		cleanup();
		renderModal();
		window.maestro.git.checkGhCli = vi.fn().mockRejectedValue(new Error('gh crashed'));
		await openRepoDetail();
		fireEvent.click(screen.getByText('Add integration coverage'));
		fireEvent.click(screen.getByRole('button', { name: /Start Symphony/i }));
		expect(await screen.findByText('GitHub CLI Required')).toBeInTheDocument();
	});
});
