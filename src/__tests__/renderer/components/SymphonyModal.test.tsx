/**
 * Tests for SymphonyModal pre-flight check dialog
 *
 * Tests the gh CLI verification flow that gates Symphony contribution start:
 * - Loading state while checking gh CLI
 * - Blocking error when gh is not installed
 * - Blocking error when gh is not authenticated
 * - Proceeding to build tools warning when gh is OK
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import type { Session, Theme } from '../../../renderer/types';
import type { AgentCreationDialogProps } from '../../../renderer/components/AgentCreationDialog';
import type {
	ActiveContribution,
	CompletedContribution,
	RegisteredRepository,
	SymphonyIssue,
	SymphonyCategory,
} from '../../../shared/symphony-types';

// ============================================================================
// Mocks
// ============================================================================

const mockRegisterLayer = vi.fn(() => 'layer-123');
const mockUnregisterLayer = vi.fn();
const mockUpdateLayerHandler = vi.fn();

vi.mock('../../../renderer/contexts/LayerStackContext', () => ({
	useLayerStack: () => ({
		registerLayer: mockRegisterLayer,
		unregisterLayer: mockUnregisterLayer,
		updateLayerHandler: mockUpdateLayerHandler,
	}),
}));

vi.mock('../../../renderer/components/AgentCreationDialog', () => ({
	AgentCreationDialog: ({
		isOpen,
		onClose,
		onCreateAgent,
		repo,
		issue,
	}: AgentCreationDialogProps) =>
		isOpen ? (
			<div data-testid="agent-creation-dialog">
				<button type="button" onClick={onClose}>
					Close Agent Dialog
				</button>
				<button
					type="button"
					onClick={() =>
						void onCreateAgent({
							agentType: 'codex',
							customArgs: '--fast',
							customEnvVars: { FEATURE: 'symphony' },
							customPath: '/usr/local/bin/codex',
							issue,
							repo,
							sessionName: 'Symphony Worker',
							workingDirectory: '/tmp/symphony/test-repo',
						})
					}
				>
					Create Agent
				</button>
			</div>
		) : null,
}));

vi.mock('../../../renderer/utils/markdownConfig', () => ({
	REMARK_GFM_PLUGINS: [],
	generateProseStyles: () => '',
	createMarkdownComponents: ({
		onExternalLinkClick,
	}: {
		onExternalLinkClick?: (href: string) => void;
	}) => ({
		a: ({ children, href }: { children: React.ReactNode; href?: string }) => (
			<a
				href={href}
				onClick={(event) => {
					event.preventDefault();
					if (href) onExternalLinkClick?.(href);
				}}
			>
				{children}
			</a>
		),
	}),
}));

vi.mock('../../../renderer/utils/shortcutFormatter', () => ({
	formatShortcutKeys: (keys: string[]) => keys.join('+'),
}));

vi.mock('react-markdown', () => ({
	default: ({
		children,
		components,
	}: {
		children: string;
		components?: { a?: React.ComponentType<{ href?: string; children: React.ReactNode }> };
	}) => {
		const content = String(children);
		const linkMatch = content.match(/\[([^\]]+)\]\(([^)]+)\)/);

		if (linkMatch && components?.a) {
			const Link = components.a;
			return (
				<div>
					<Link href={linkMatch[2]}>{linkMatch[1]}</Link>
				</div>
			);
		}

		return <div>{children}</div>;
	},
}));

vi.mock('remark-gfm', () => ({
	default: () => null,
}));

// Mock lucide-react icons
vi.mock('lucide-react', () => {
	const icon = (name: string) => {
		const Component = ({ className, style, ...props }: Record<string, unknown>) => (
			<svg
				data-testid={`icon-${name}`}
				className={className as string}
				style={style as React.CSSProperties}
				{...props}
			/>
		);
		Component.displayName = name;
		return Component;
	};
	return {
		Music: icon('Music'),
		RefreshCw: icon('RefreshCw'),
		X: icon('X'),
		Search: icon('Search'),
		Loader2: icon('Loader2'),
		ArrowLeft: icon('ArrowLeft'),
		ExternalLink: icon('ExternalLink'),
		GitBranch: icon('GitBranch'),
		GitPullRequest: icon('GitPullRequest'),
		GitMerge: icon('GitMerge'),
		Clock: icon('Clock'),
		Zap: icon('Zap'),
		Play: icon('Play'),
		Pause: icon('Pause'),
		AlertCircle: icon('AlertCircle'),
		CheckCircle: icon('CheckCircle'),
		Trophy: icon('Trophy'),
		Flame: icon('Flame'),
		FileText: icon('FileText'),
		Hash: icon('Hash'),
		ChevronDown: icon('ChevronDown'),
		HelpCircle: icon('HelpCircle'),
		Github: icon('Github'),
		Terminal: icon('Terminal'),
		Lock: icon('Lock'),
		Star: icon('Star'),
	};
});

// Create mock data
const mockRepo: RegisteredRepository = {
	slug: 'test-owner/test-repo',
	name: 'Test Repository',
	description: 'A test repository',
	url: 'https://github.com/test-owner/test-repo',
	category: 'developer-tools' as SymphonyCategory,
	tags: ['test'],
	maintainer: { name: 'Test', url: 'https://github.com/test' },
	isActive: true,
	featured: false,
	addedAt: '2025-01-01',
};

const mockIssue: SymphonyIssue = {
	number: 1,
	title: 'Test Issue',
	body: 'Test body',
	url: 'https://api.github.com/repos/test/repo/issues/1',
	htmlUrl: 'https://github.com/test/repo/issues/1',
	author: 'test',
	createdAt: '2025-01-01',
	updatedAt: '2025-01-01',
	documentPaths: [{ name: 'task.md', path: 'docs/task.md', isExternal: false }],
	status: 'available',
};

// Mock useSymphony hook
const mockSelectRepository = vi.fn();
const mockUseSymphonyReturn = {
	registry: {
		schemaVersion: '1.0' as const,
		lastUpdated: '2025-01-01',
		repositories: [mockRepo],
	},
	repositories: [mockRepo],
	categories: ['developer-tools'] as SymphonyCategory[],
	isLoading: false,
	isRefreshing: false,
	error: null,
	fromCache: false,
	cacheAge: null,
	selectedCategory: 'all' as const,
	setSelectedCategory: vi.fn(),
	searchQuery: '',
	setSearchQuery: vi.fn(),
	filteredRepositories: [mockRepo],
	selectedRepo: mockRepo,
	repoIssues: [mockIssue],
	isLoadingIssues: false,
	selectRepository: mockSelectRepository,
	symphonyState: null,
	activeContributions: [],
	completedContributions: [],
	stats: null,
	refresh: vi.fn(),
	startContribution: vi.fn(),
	cancelContribution: vi.fn(),
	finalizeContribution: vi.fn(),
	issueCounts: null as Record<string, number> | null,
	isLoadingIssueCounts: false,
};

const mockContributorStatsReturn = {
	stats: null,
	recentContributions: [],
	achievements: [],
	isLoading: false,
	refresh: vi.fn(),
	formattedTotalCost: '$0.00',
	formattedTotalTokens: '0',
	formattedTotalTime: '0m',
	uniqueRepos: 0,
	currentStreakWeeks: 0,
	longestStreakWeeks: 0,
};

vi.mock('../../../renderer/hooks/symphony', () => ({
	useSymphony: () => mockUseSymphonyReturn,
	useContributorStats: () => mockContributorStatsReturn,
}));

vi.mock('../../../renderer/hooks/symphony/useContributorStats', () => ({
	useContributorStats: () => mockContributorStatsReturn,
}));

// ============================================================================
// Helpers
// ============================================================================

const testTheme: Theme = {
	id: 'test-theme',
	name: 'Test Theme',
	mode: 'dark',
	colors: {
		bgMain: '#1e1e1e',
		bgSidebar: '#252526',
		bgActivity: '#333333',
		textMain: '#d4d4d4',
		textDim: '#808080',
		accent: '#007acc',
		border: '#404040',
		error: '#f14c4c',
		warning: '#cca700',
		success: '#89d185',
		info: '#3794ff',
		textInverse: '#000000',
	},
};

/**
 * Navigate into the detail view and select the issue so the "Start Symphony"
 * button appears. The component requires:
 * 1. Click a repo tile → showDetailView=true
 * 2. The issue is auto-selected as the first available issue
 */
async function navigateToStartButton() {
	// Click the repo tile to enter detail view
	const repoTile = screen.getByText('Test Repository');
	await act(async () => {
		fireEvent.click(repoTile);
	});

	// Wait for detail view with the issue
	await waitFor(() => {
		expect(screen.getByText('Test Issue')).toBeInTheDocument();
	});

	// Click the issue to select it
	await act(async () => {
		fireEvent.click(screen.getByText('Test Issue'));
	});

	// Wait for Start Symphony button to appear
	await waitFor(() => {
		expect(screen.getByText('Start Symphony')).toBeInTheDocument();
	});
}

function applyMockOverrides<T extends object>(target: T, overrides: Record<string, unknown>) {
	const record = target as Record<string, unknown>;
	const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, record[key]]));

	Object.assign(record, overrides);

	return () => {
		Object.assign(record, previous);
	};
}

async function renderSymphonyModal({
	isOpen = true,
	sessions = [],
}: {
	isOpen?: boolean;
	sessions?: Session[];
} = {}) {
	const SymphonyModal = (await import('../../../renderer/components/SymphonyModal')).default;

	const onClose = vi.fn();
	const onStartContribution = vi.fn();
	const onSelectSession = vi.fn();

	const view = render(
		<SymphonyModal
			theme={testTheme}
			isOpen={isOpen}
			onClose={onClose}
			onStartContribution={onStartContribution}
			sessions={sessions}
			onSelectSession={onSelectSession}
		/>
	);

	return { ...view, onClose, onStartContribution, onSelectSession };
}

function createActiveContribution(overrides: Partial<ActiveContribution> = {}): ActiveContribution {
	return {
		id: 'active-1',
		repoSlug: 'test-owner/test-repo',
		repoName: 'Test Repository',
		issueNumber: 42,
		issueTitle: 'Ready for review issue',
		localPath: '/tmp/test-repo',
		branchName: 'maestro/issue-42',
		draftPrNumber: 12,
		draftPrUrl: 'https://github.com/test-owner/test-repo/pull/12',
		startedAt: '2025-01-01T00:00:00Z',
		status: 'ready_for_review',
		progress: {
			totalDocuments: 2,
			completedDocuments: 1,
			currentDocument: 'docs/task.md',
			totalTasks: 4,
			completedTasks: 3,
		},
		tokenUsage: {
			inputTokens: 2300,
			outputTokens: 1700,
			estimatedCost: 1.25,
		},
		timeSpent: 65_000,
		sessionId: 'session-1',
		agentType: 'codex',
		...overrides,
	};
}

function createCompletedContribution(
	overrides: Partial<CompletedContribution> = {}
): CompletedContribution {
	return {
		id: 'completed-1',
		repoSlug: 'test-owner/test-repo',
		repoName: 'Test Repository',
		issueNumber: 52,
		issueTitle: 'Completed issue',
		startedAt: '2025-01-01T00:00:00Z',
		completedAt: '2025-01-02T00:00:00Z',
		prUrl: 'https://github.com/test-owner/test-repo/pull/52',
		prNumber: 52,
		tokenUsage: {
			inputTokens: 1200,
			outputTokens: 300,
			totalCost: 0.75,
		},
		timeSpent: 120_000,
		documentsProcessed: 2,
		tasksCompleted: 5,
		wasMerged: true,
		...overrides,
	};
}

function createIssue(overrides: Partial<SymphonyIssue> = {}): SymphonyIssue {
	return {
		number: 101,
		title: 'Document-rich issue',
		body: 'Issue body',
		url: 'https://api.github.com/repos/test/repo/issues/101',
		htmlUrl: 'https://github.com/test/repo/issues/101',
		author: 'maintainer',
		createdAt: '2025-01-01',
		updatedAt: '2025-01-02',
		documentPaths: [
			{ name: 'local.md', path: 'docs/local.md', isExternal: false },
			{ name: 'remote.md', path: 'https://example.com/remote.md', isExternal: true },
		],
		labels: [],
		status: 'available',
		...overrides,
	};
}

// ============================================================================
// Tests
// ============================================================================

describe('SymphonyModal', () => {
	let checkGhCliMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.clearAllMocks();
		checkGhCliMock = vi.fn();
		window.maestro.git.checkGhCli = checkGhCliMock;
		mockSelectRepository.mockResolvedValue(undefined);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	describe('Pre-flight gh CLI check', () => {
		it('shows loading state while checking gh CLI', async () => {
			let resolveGh!: (value: { installed: boolean; authenticated: boolean }) => void;
			checkGhCliMock.mockReturnValue(
				new Promise((resolve) => {
					resolveGh = resolve;
				})
			);

			const SymphonyModal = (await import('../../../renderer/components/SymphonyModal')).default;

			render(
				<SymphonyModal
					theme={testTheme}
					isOpen={true}
					onClose={vi.fn()}
					onStartContribution={vi.fn()}
					sessions={[]}
					onSelectSession={vi.fn()}
				/>
			);

			await navigateToStartButton();

			await act(async () => {
				fireEvent.click(screen.getByText('Start Symphony'));
			});

			expect(screen.getByText('Checking prerequisites…')).toBeInTheDocument();

			// Clean up
			await act(async () => {
				resolveGh({ installed: true, authenticated: true });
			});
		});

		it('blocks when gh CLI is not installed', async () => {
			checkGhCliMock.mockResolvedValue({ installed: false, authenticated: false });

			const SymphonyModal = (await import('../../../renderer/components/SymphonyModal')).default;

			render(
				<SymphonyModal
					theme={testTheme}
					isOpen={true}
					onClose={vi.fn()}
					onStartContribution={vi.fn()}
					sessions={[]}
					onSelectSession={vi.fn()}
				/>
			);

			await navigateToStartButton();

			await act(async () => {
				fireEvent.click(screen.getByText('Start Symphony'));
			});

			await waitFor(() => {
				expect(screen.getByText('GitHub CLI Required')).toBeInTheDocument();
			});

			expect(screen.getByText('cli.github.com')).toBeInTheDocument();
			expect(screen.queryByText('I Have the Build Tools')).not.toBeInTheDocument();
			expect(screen.getByText('Close')).toBeInTheDocument();
		});

		it('blocks when gh CLI is not authenticated', async () => {
			checkGhCliMock.mockResolvedValue({ installed: true, authenticated: false });

			const SymphonyModal = (await import('../../../renderer/components/SymphonyModal')).default;

			render(
				<SymphonyModal
					theme={testTheme}
					isOpen={true}
					onClose={vi.fn()}
					onStartContribution={vi.fn()}
					sessions={[]}
					onSelectSession={vi.fn()}
				/>
			);

			await navigateToStartButton();

			await act(async () => {
				fireEvent.click(screen.getByText('Start Symphony'));
			});

			await waitFor(() => {
				expect(screen.getByText('GitHub CLI Not Authenticated')).toBeInTheDocument();
			});

			expect(screen.getByText('gh auth login')).toBeInTheDocument();
			expect(screen.queryByText('I Have the Build Tools')).not.toBeInTheDocument();
			expect(screen.getByText('Close')).toBeInTheDocument();

			await act(async () => {
				fireEvent.click(screen.getByText('Close'));
			});
			expect(screen.queryByText('GitHub CLI Not Authenticated')).not.toBeInTheDocument();
		});

		it('shows build tools warning with gh checkmark when gh is OK', async () => {
			checkGhCliMock.mockResolvedValue({ installed: true, authenticated: true });

			const SymphonyModal = (await import('../../../renderer/components/SymphonyModal')).default;

			render(
				<SymphonyModal
					theme={testTheme}
					isOpen={true}
					onClose={vi.fn()}
					onStartContribution={vi.fn()}
					sessions={[]}
					onSelectSession={vi.fn()}
				/>
			);

			await navigateToStartButton();

			await act(async () => {
				fireEvent.click(screen.getByText('Start Symphony'));
			});

			await waitFor(() => {
				expect(screen.getByText('GitHub CLI authenticated')).toBeInTheDocument();
			});

			expect(screen.getByText('Build Tools Required')).toBeInTheDocument();
			expect(screen.getByText('I Have the Build Tools')).toBeInTheDocument();
		});

		it('dismisses authenticated pre-flight checks from cancel controls and backdrop', async () => {
			checkGhCliMock.mockResolvedValue({ installed: true, authenticated: true });

			await renderSymphonyModal();
			await navigateToStartButton();

			await act(async () => {
				fireEvent.click(screen.getByText('Start Symphony'));
			});
			expect(await screen.findByText('Build Tools Required')).toBeInTheDocument();

			await act(async () => {
				fireEvent.click(screen.getByText('Cancel'));
			});
			expect(screen.queryByText('Build Tools Required')).not.toBeInTheDocument();

			await act(async () => {
				fireEvent.click(screen.getByText('Start Symphony'));
			});
			expect(await screen.findByText('Build Tools Required')).toBeInTheDocument();

			await act(async () => {
				fireEvent.click(screen.getByLabelText('Close pre-flight check dialog'));
			});
			expect(screen.queryByText('Build Tools Required')).not.toBeInTheDocument();
		});

		it('creates an agent after pre-flight confirmation', async () => {
			checkGhCliMock.mockResolvedValue({ installed: true, authenticated: true });
			const startContribution = vi.fn().mockResolvedValue({
				success: true,
				contributionId: 'contribution-99',
				autoRunPath: 'docs/task.md',
				branchName: 'symphony/issue-1',
				draftPrNumber: 99,
				draftPrUrl: 'https://github.com/test-owner/test-repo/pull/99',
			});
			const restore = applyMockOverrides(mockUseSymphonyReturn, { startContribution });

			try {
				const { onStartContribution } = await renderSymphonyModal();

				await navigateToStartButton();

				await act(async () => {
					fireEvent.click(screen.getByText('Start Symphony'));
				});
				await screen.findByText('GitHub CLI authenticated');

				await act(async () => {
					fireEvent.click(screen.getByText('I Have the Build Tools'));
				});

				expect(await screen.findByTestId('agent-creation-dialog')).toBeInTheDocument();

				await act(async () => {
					fireEvent.click(screen.getByText('Close Agent Dialog'));
				});

				expect(screen.queryByTestId('agent-creation-dialog')).not.toBeInTheDocument();

				await act(async () => {
					fireEvent.click(screen.getByText('Start Symphony'));
				});
				await screen.findByText('GitHub CLI authenticated');

				await act(async () => {
					fireEvent.click(screen.getByText('I Have the Build Tools'));
				});
				await act(async () => {
					fireEvent.click(await screen.findByText('Create Agent'));
				});

				await waitFor(() => {
					expect(startContribution).toHaveBeenCalledWith(
						mockRepo,
						mockIssue,
						'codex',
						'',
						'/tmp/symphony/test-repo'
					);
				});
				expect(onStartContribution).toHaveBeenCalledWith({
					contributionId: 'contribution-99',
					localPath: '/tmp/symphony/test-repo',
					autoRunPath: 'docs/task.md',
					branchName: 'symphony/issue-1',
					draftPrNumber: 99,
					draftPrUrl: 'https://github.com/test-owner/test-repo/pull/99',
					agentType: 'codex',
					sessionName: 'Symphony Worker',
					repo: mockRepo,
					issue: mockIssue,
					customPath: '/usr/local/bin/codex',
					customArgs: '--fast',
					customEnvVars: { FEATURE: 'symphony' },
				});
			} finally {
				restore();
			}
		});

		it('keeps the agent dialog open when contribution startup fails', async () => {
			checkGhCliMock.mockResolvedValue({ installed: true, authenticated: true });
			const startContribution = vi.fn().mockResolvedValue({
				success: false,
				error: 'Clone failed',
			});
			const restore = applyMockOverrides(mockUseSymphonyReturn, { startContribution });

			try {
				const { onStartContribution } = await renderSymphonyModal();

				await navigateToStartButton();

				await act(async () => {
					fireEvent.click(screen.getByText('Start Symphony'));
				});
				await screen.findByText('GitHub CLI authenticated');

				await act(async () => {
					fireEvent.click(screen.getByText('I Have the Build Tools'));
				});
				await act(async () => {
					fireEvent.click(await screen.findByText('Create Agent'));
				});

				await waitFor(() => {
					expect(startContribution).toHaveBeenCalledWith(
						mockRepo,
						mockIssue,
						'codex',
						'',
						'/tmp/symphony/test-repo'
					);
				});
				expect(onStartContribution).not.toHaveBeenCalled();
				expect(screen.getByTestId('agent-creation-dialog')).toBeInTheDocument();
			} finally {
				restore();
			}
		});

		it('shows starting state and keeps the agent dialog open for default startup failures', async () => {
			checkGhCliMock.mockResolvedValue({ installed: true, authenticated: true });
			let resolveStart!: (value: { success: boolean }) => void;
			const startContribution = vi.fn().mockReturnValue(
				new Promise((resolve) => {
					resolveStart = resolve;
				})
			);
			const restore = applyMockOverrides(mockUseSymphonyReturn, { startContribution });

			try {
				await renderSymphonyModal();

				await navigateToStartButton();

				await act(async () => {
					fireEvent.click(screen.getByText('Start Symphony'));
				});
				await screen.findByText('GitHub CLI authenticated');

				await act(async () => {
					fireEvent.click(screen.getByText('I Have the Build Tools'));
				});
				await act(async () => {
					fireEvent.click(await screen.findByText('Create Agent'));
				});

				expect(screen.getByText('Starting...')).toBeInTheDocument();

				await act(async () => {
					resolveStart({ success: false });
				});

				await waitFor(() => expect(screen.queryByText('Starting...')).not.toBeInTheDocument());
				expect(screen.getByTestId('agent-creation-dialog')).toBeInTheDocument();
			} finally {
				restore();
			}
		});

		it('dismisses dialog when Close is clicked on gh error', async () => {
			checkGhCliMock.mockResolvedValue({ installed: false, authenticated: false });

			const SymphonyModal = (await import('../../../renderer/components/SymphonyModal')).default;

			render(
				<SymphonyModal
					theme={testTheme}
					isOpen={true}
					onClose={vi.fn()}
					onStartContribution={vi.fn()}
					sessions={[]}
					onSelectSession={vi.fn()}
				/>
			);

			await navigateToStartButton();

			await act(async () => {
				fireEvent.click(screen.getByText('Start Symphony'));
			});

			await waitFor(() => {
				expect(screen.getByText('GitHub CLI Required')).toBeInTheDocument();
			});

			await act(async () => {
				fireEvent.click(screen.getByText('Close'));
			});

			expect(screen.queryByText('GitHub CLI Required')).not.toBeInTheDocument();
		});

		it('treats gh CLI check failure as not installed', async () => {
			checkGhCliMock.mockRejectedValue(new Error('IPC failed'));

			const SymphonyModal = (await import('../../../renderer/components/SymphonyModal')).default;

			render(
				<SymphonyModal
					theme={testTheme}
					isOpen={true}
					onClose={vi.fn()}
					onStartContribution={vi.fn()}
					sessions={[]}
					onSelectSession={vi.fn()}
				/>
			);

			await navigateToStartButton();

			await act(async () => {
				fireEvent.click(screen.getByText('Start Symphony'));
			});

			await waitFor(() => {
				expect(screen.getByText('GitHub CLI Required')).toBeInTheDocument();
			});
		});
	});

	describe('Modal shell', () => {
		it('does not render when closed', async () => {
			await renderSymphonyModal({ isOpen: false });

			expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
			expect(screen.queryByText('Maestro Symphony')).not.toBeInTheDocument();
		});

		it('shows cached project data, disables refresh while refreshing, and toggles help', async () => {
			const restore = applyMockOverrides(mockUseSymphonyReturn, {
				cacheAge: 65_000,
				fromCache: true,
				isRefreshing: true,
				refresh: vi.fn(),
			});

			try {
				await renderSymphonyModal();

				expect(screen.getByText('Cached 1m ago')).toBeInTheDocument();
				expect(screen.getByTitle('Refresh')).toBeDisabled();
				expect(screen.getByTestId('icon-RefreshCw')).toHaveClass('animate-spin');

				await act(async () => {
					fireEvent.click(screen.getByLabelText('Help'));
				});

				expect(screen.getByRole('heading', { name: 'About Maestro Symphony' })).toBeInTheDocument();
				expect(screen.getByText('docs.runmaestro.ai/symphony')).toBeInTheDocument();

				await act(async () => {
					fireEvent.click(screen.getByText('Close'));
				});

				expect(
					screen.queryByRole('heading', { name: 'About Maestro Symphony' })
				).not.toBeInTheDocument();
			} finally {
				restore();
			}
		});

		it('opens Symphony docs links and updates project filters', async () => {
			const setSearchQuery = vi.fn();
			const setSelectedCategory = vi.fn();
			const restore = applyMockOverrides(mockUseSymphonyReturn, {
				cacheAge: 7_200_000,
				fromCache: true,
				setSearchQuery,
				setSelectedCategory,
			});
			vi.mocked(window.maestro.shell.openExternal).mockResolvedValue(undefined);

			try {
				await renderSymphonyModal();

				expect(screen.getByText('Cached 2h ago')).toBeInTheDocument();

				await act(async () => {
					fireEvent.click(screen.getByLabelText('Help'));
				});
				await act(async () => {
					fireEvent.click(screen.getByText('docs.runmaestro.ai/symphony'));
				});

				expect(window.maestro.shell.openExternal).toHaveBeenCalledWith(
					'https://docs.runmaestro.ai/symphony'
				);
				expect(
					screen.queryByRole('heading', { name: 'About Maestro Symphony' })
				).not.toBeInTheDocument();

				await act(async () => {
					fireEvent.click(screen.getByText('Register Your Project'));
				});
				expect(window.maestro.shell.openExternal).toHaveBeenCalledWith(
					'https://docs.runmaestro.ai/symphony'
				);

				await act(async () => {
					fireEvent.change(screen.getByPlaceholderText('Search repositories...'), {
						target: { value: 'cli' },
					});
				});
				expect(setSearchQuery).toHaveBeenCalledWith('cli');

				await act(async () => {
					fireEvent.click(screen.getAllByRole('button', { name: /Developer Tools/ })[0]);
				});
				expect(setSelectedCategory).toHaveBeenCalledWith('developer-tools');

				await act(async () => {
					fireEvent.click(screen.getByRole('button', { name: 'All' }));
				});
				expect(setSelectedCategory).toHaveBeenCalledWith('all');
			} finally {
				restore();
			}
		});

		it('renders just-now cached data and repository loading skeletons', async () => {
			const restore = applyMockOverrides(mockUseSymphonyReturn, {
				cacheAge: 30_000,
				fromCache: true,
				isLoading: true,
			});

			try {
				await renderSymphonyModal();

				expect(screen.getByText('Cached just now')).toBeInTheDocument();
				expect(document.body.querySelectorAll('[class*="animate-pulse"]')).toHaveLength(6);
				expect(screen.queryByText('Test Repository')).not.toBeInTheDocument();
			} finally {
				restore();
			}
		});

		it('renders zero-age cached data as just now', async () => {
			const restore = applyMockOverrides(mockUseSymphonyReturn, {
				cacheAge: 0,
				fromCache: true,
			});

			try {
				await renderSymphonyModal();

				expect(screen.getByText('Cached just now')).toBeInTheDocument();
			} finally {
				restore();
			}
		});

		it('renders repository tile fallbacks for unknown categories and issue counts', async () => {
			const noIssuesRepo: RegisteredRepository = {
				...mockRepo,
				slug: 'test-owner/no-issues',
				name: 'No Issues Repository',
				category: 'unknown-category' as SymphonyCategory,
				stars: undefined,
			};
			const oneIssueRepo: RegisteredRepository = {
				...mockRepo,
				slug: 'test-owner/one-issue',
				name: 'One Issue Repository',
				stars: 1,
			};
			const filteredRepositories = [noIssuesRepo, oneIssueRepo];
			const restore = applyMockOverrides(mockUseSymphonyReturn, {
				filteredRepositories,
				repositories: filteredRepositories,
				issueCounts: {
					[noIssuesRepo.slug]: 0,
					[oneIssueRepo.slug]: 1,
				},
			});

			try {
				await renderSymphonyModal();

				const noIssuesTile = screen.getByText('No Issues Repository').closest('button');
				expect(screen.getByText('unknown-category')).toBeInTheDocument();
				expect(within(noIssuesTile as HTMLElement).getByText('No Issues')).toBeInTheDocument();
				expect(
					within(noIssuesTile as HTMLElement).queryByTestId('icon-Star')
				).not.toBeInTheDocument();
				expect(noIssuesTile).toHaveStyle({ opacity: '0.45' });
				expect(screen.getByText('View 1 Issue')).toBeInTheDocument();
			} finally {
				restore();
			}
		});

		it('renders selected custom categories, plural issue counts, and empty project details', async () => {
			const customRepo: RegisteredRepository = {
				...mockRepo,
				slug: 'test-owner/custom',
				name: 'Custom Repository',
				description: 'Custom category repository',
				category: 'custom-tools' as SymphonyCategory,
				maintainer: { name: 'No Link Maintainer' },
				tags: [],
			};
			const restore = applyMockOverrides(mockUseSymphonyReturn, {
				categories: ['custom-tools'] as SymphonyCategory[],
				selectedCategory: 'custom-tools',
				filteredRepositories: [customRepo],
				repositories: [customRepo],
				selectedRepo: customRepo,
				repoIssues: [],
				issueCounts: { [customRepo.slug]: 2 },
				isLoadingIssueCounts: true,
			});

			try {
				await renderSymphonyModal();

				expect(screen.getAllByText('custom-tools').length).toBeGreaterThan(0);
				expect(screen.getByText('View 2 Issues')).toBeInTheDocument();
				expect(screen.getByTestId('icon-Loader2')).toHaveClass('animate-spin');

				await act(async () => {
					fireEvent.click(screen.getByText('Custom Repository'));
				});

				expect(await screen.findByText('Maestro Symphony: Custom Repository')).toBeInTheDocument();
				expect(screen.getByText('No Link Maintainer')).toBeInTheDocument();
				expect(screen.getByText('No issues with runmaestro.ai label')).toBeInTheDocument();
				expect(screen.getByText('No outstanding work for this project')).toBeInTheDocument();
			} finally {
				restore();
			}
		});

		it('refreshes project data from the header control', async () => {
			const refresh = vi.fn();
			const restore = applyMockOverrides(mockUseSymphonyReturn, { refresh });

			try {
				await renderSymphonyModal();

				await act(async () => {
					fireEvent.click(screen.getByTitle('Refresh'));
				});

				expect(refresh).toHaveBeenCalledWith(true);
			} finally {
				restore();
			}
		});

		it('routes layer-stack Escape through help, detail, and close states', async () => {
			const { onClose } = await renderSymphonyModal();
			const onEscape = mockRegisterLayer.mock.calls.at(-1)?.[0].onEscape as () => void;

			await act(async () => {
				fireEvent.click(screen.getByLabelText('Help'));
			});
			expect(screen.getByRole('heading', { name: 'About Maestro Symphony' })).toBeInTheDocument();

			await act(async () => {
				onEscape();
			});
			expect(
				screen.queryByRole('heading', { name: 'About Maestro Symphony' })
			).not.toBeInTheDocument();
			expect(onClose).not.toHaveBeenCalled();

			await act(async () => {
				fireEvent.click(screen.getByText('Test Repository'));
			});
			expect(await screen.findByText('Maestro Symphony: Test Repository')).toBeInTheDocument();

			await act(async () => {
				onEscape();
			});
			expect(screen.queryByText('Maestro Symphony: Test Repository')).not.toBeInTheDocument();
			expect(mockSelectRepository).toHaveBeenLastCalledWith(null);
			expect(onClose).not.toHaveBeenCalled();

			await act(async () => {
				onEscape();
			});
			expect(onClose).toHaveBeenCalledTimes(1);
		});

		it('supports project keyboard shortcuts for search focus, tab cycling, and selection', async () => {
			await renderSymphonyModal();

			await act(async () => {
				fireEvent.keyDown(window, { key: '/' });
			});
			expect(screen.getByPlaceholderText('Search repositories...')).toHaveFocus();

			await act(async () => {
				fireEvent.keyDown(window, { key: ']', metaKey: true, shiftKey: true });
			});
			expect(screen.getByText('No active contributions')).toBeInTheDocument();

			await act(async () => {
				fireEvent.keyDown(window, { key: '[', metaKey: true, shiftKey: true });
			});
			expect(screen.getByText('Test Repository')).toBeInTheDocument();

			await act(async () => {
				fireEvent.click(screen.getByRole('button', { name: 'Stats' }));
			});
			await act(async () => {
				fireEvent.keyDown(window, { key: ']', metaKey: true, shiftKey: true });
			});
			expect(screen.getByText('Test Repository')).toBeInTheDocument();

			await act(async () => {
				fireEvent.keyDown(window, { key: 'Enter' });
			});
			expect(mockSelectRepository).toHaveBeenCalledWith(mockRepo);
		});

		it('supports repository grid arrow navigation and search escape focus recovery', async () => {
			const secondRepo = { ...mockRepo, slug: 'test-owner/second', name: 'Second Repository' };
			const thirdRepo = { ...mockRepo, slug: 'test-owner/third', name: 'Third Repository' };
			const fourthRepo = { ...mockRepo, slug: 'test-owner/fourth', name: 'Fourth Repository' };
			const filteredRepositories = [mockRepo, secondRepo, thirdRepo, fourthRepo];
			const restore = applyMockOverrides(mockUseSymphonyReturn, {
				filteredRepositories,
				repositories: filteredRepositories,
			});

			try {
				await renderSymphonyModal();
				const searchInput = screen.getByPlaceholderText('Search repositories...');
				const grid = screen.getByRole('grid', { name: 'Repository tiles' });

				await act(async () => {
					fireEvent.keyDown(window, { key: '/' });
				});
				await waitFor(() => expect(searchInput).toHaveFocus());

				await act(async () => {
					fireEvent.keyDown(searchInput, { key: 'Escape' });
				});
				await waitFor(() => expect(grid).toHaveFocus());

				await act(async () => {
					fireEvent.keyDown(searchInput, { key: 'ArrowDown' });
				});
				await waitFor(() => expect(grid).toHaveFocus());

				await act(async () => {
					fireEvent.keyDown(grid, { key: 'ArrowDown' });
				});

				await act(async () => {
					fireEvent.keyDown(searchInput, { key: 'a' });
				});
				expect(mockSelectRepository).not.toHaveBeenCalled();

				await act(async () => {
					fireEvent.keyDown(window, { key: 'ArrowLeft' });
				});
				await act(async () => {
					fireEvent.keyDown(window, { key: 'ArrowUp' });
				});
				await act(async () => {
					fireEvent.keyDown(window, { key: 'ArrowRight' });
				});
				await act(async () => {
					fireEvent.keyDown(window, { key: 'Enter' });
				});

				expect(mockSelectRepository).toHaveBeenCalledWith(secondRepo);
			} finally {
				restore();
			}
		});

		it('ignores repository grid keys when the project list is empty', async () => {
			const restore = applyMockOverrides(mockUseSymphonyReturn, {
				filteredRepositories: [],
				repositories: [],
			});

			try {
				await renderSymphonyModal();

				await act(async () => {
					fireEvent.keyDown(window, { key: 'ArrowRight' });
					fireEvent.keyDown(window, { key: 'Enter' });
				});

				expect(mockSelectRepository).not.toHaveBeenCalled();
				expect(screen.getByText('No repositories available')).toBeInTheDocument();
			} finally {
				restore();
			}
		});

		it('ignores Enter when a stale tile selection no longer points at a repository', async () => {
			const secondRepo = { ...mockRepo, slug: 'test-owner/second', name: 'Second Repository' };
			const thirdRepo = { ...mockRepo, slug: 'test-owner/third', name: 'Third Repository' };
			const fourthRepo = { ...mockRepo, slug: 'test-owner/fourth', name: 'Fourth Repository' };
			const filteredRepositories = [mockRepo, secondRepo, thirdRepo, fourthRepo];
			const restore = applyMockOverrides(mockUseSymphonyReturn, {
				filteredRepositories,
				repositories: filteredRepositories,
			});
			const SymphonyModal = (await import('../../../renderer/components/SymphonyModal')).default;
			const props = {
				theme: testTheme,
				isOpen: true,
				onClose: vi.fn(),
				onStartContribution: vi.fn(),
				sessions: [] as Session[],
				onSelectSession: vi.fn(),
			};

			try {
				const view = render(<SymphonyModal {...props} />);

				await act(async () => {
					fireEvent.keyDown(window, { key: 'ArrowDown' });
				});

				Object.assign(mockUseSymphonyReturn, {
					filteredRepositories: [mockRepo],
					repositories: [mockRepo],
				});
				view.rerender(<SymphonyModal {...props} />);
				mockSelectRepository.mockClear();

				await act(async () => {
					fireEvent.keyDown(window, { key: 'Enter' });
				});

				expect(mockSelectRepository).not.toHaveBeenCalled();
			} finally {
				restore();
			}
		});

		it('shows project error retry and empty search states', async () => {
			const refresh = vi.fn();
			let restore = applyMockOverrides(mockUseSymphonyReturn, {
				error: 'Registry unavailable',
				refresh,
			});

			try {
				const { unmount } = await renderSymphonyModal();

				expect(screen.getByText('Registry unavailable')).toBeInTheDocument();
				await act(async () => {
					fireEvent.click(screen.getByText('Retry'));
				});
				expect(refresh).toHaveBeenCalledWith(true);
				unmount();
			} finally {
				restore();
			}

			restore = applyMockOverrides(mockUseSymphonyReturn, {
				filteredRepositories: [],
				searchQuery: 'missing',
			});

			try {
				await renderSymphonyModal();
				expect(screen.getByText('No repositories match your search')).toBeInTheDocument();
			} finally {
				restore();
			}
		});
	});

	describe('Tabs', () => {
		it('shows active contribution count in the tab label without leaving projects', async () => {
			const restore = applyMockOverrides(mockUseSymphonyReturn, {
				activeContributions: [{ id: 'active-1' }],
			});

			try {
				await renderSymphonyModal();

				expect(screen.getByRole('button', { name: 'Active (1)' })).toBeInTheDocument();
			} finally {
				restore();
			}
		});

		it('renders the active, history, and stats tab empty states', async () => {
			await renderSymphonyModal();

			await act(async () => {
				fireEvent.click(screen.getByRole('button', { name: 'Active' }));
			});

			expect(screen.getByText('No active contributions')).toBeInTheDocument();
			expect(screen.getByText('Start a contribution from the Projects tab')).toBeInTheDocument();

			await act(async () => {
				fireEvent.click(screen.getByRole('button', { name: 'History' }));
			});

			expect(screen.getByText('No completed contributions')).toBeInTheDocument();
			expect(screen.getByText('Your contribution history will appear here')).toBeInTheDocument();

			await act(async () => {
				fireEvent.click(screen.getByRole('button', { name: 'Stats' }));
			});

			expect(screen.getByText('Tokens Donated')).toBeInTheDocument();
			expect(screen.getByText('Time Contributed')).toBeInTheDocument();
			expect(screen.getByText('Achievements')).toBeInTheDocument();
		});

		it('returns from the active empty state to the project browser', async () => {
			await renderSymphonyModal();

			await act(async () => {
				fireEvent.click(screen.getByRole('button', { name: 'Active' }));
			});
			expect(screen.getByText('No active contributions')).toBeInTheDocument();

			await act(async () => {
				fireEvent.click(screen.getByText('Browse Projects'));
			});
			expect(screen.getByText('Test Repository')).toBeInTheDocument();
		});

		it('renders active contribution cards and wires their controls', async () => {
			const finalizeContribution = vi.fn().mockResolvedValue({ success: true });
			const syncContribution = vi.fn().mockResolvedValue({ message: 'Contribution synced' });
			const restore = applyMockOverrides(mockUseSymphonyReturn, {
				activeContributions: [
					createActiveContribution({ timeSpent: 12_000 }),
					createActiveContribution({
						id: 'active-2',
						draftPrNumber: undefined,
						draftPrUrl: undefined,
						error: 'Auto Run paused on failing task',
						issueNumber: 43,
						issueTitle: 'Paused issue',
						progress: {
							totalDocuments: 0,
							completedDocuments: 0,
							totalTasks: 0,
							completedTasks: 0,
						},
						sessionId: 'missing-session',
						status: 'failed',
						timeSpent: 3_720_000,
					}),
				],
				finalizeContribution,
			});
			const previousSyncContribution = (window.maestro.symphony as Record<string, unknown>)
				.syncContribution;
			(window.maestro.symphony as Record<string, unknown>).syncContribution = syncContribution;
			vi.mocked(window.maestro.shell.openExternal).mockResolvedValue(undefined);

			try {
				const { onClose, onSelectSession } = await renderSymphonyModal({
					sessions: [
						{
							id: 'session-1',
							name: 'Symphony Worker',
						} as Session,
					],
				});

				await act(async () => {
					fireEvent.click(screen.getByRole('button', { name: 'Active (2)' }));
				});

				expect(screen.getByText('2 active contributions')).toBeInTheDocument();
				expect(screen.getByText('Ready for review issue')).toBeInTheDocument();
				expect(screen.getByText('Symphony Worker')).toBeInTheDocument();
				expect(screen.getByText('Draft PR #12')).toBeInTheDocument();
				expect(screen.getByText('1 / 2 documents')).toBeInTheDocument();
				expect(screen.getByText('12s')).toBeInTheDocument();
				expect(screen.getByText('1h 2m')).toBeInTheDocument();
				expect(screen.getByText('Current: docs/task.md')).toBeInTheDocument();
				expect(screen.getAllByText('In: 2K')).toHaveLength(2);
				expect(screen.getAllByText('$1.25')).toHaveLength(2);
				expect(screen.getByText('PR will be created on first commit')).toBeInTheDocument();
				expect(screen.getByText('Auto Run paused on failing task')).toBeInTheDocument();

				await act(async () => {
					fireEvent.click(screen.getByText('Symphony Worker'));
				});

				expect(onSelectSession).toHaveBeenCalledWith('session-1');
				expect(onClose).toHaveBeenCalled();

				await act(async () => {
					fireEvent.click(screen.getByText('Draft PR #12'));
				});

				expect(window.maestro.shell.openExternal).toHaveBeenCalledWith(
					'https://github.com/test-owner/test-repo/pull/12'
				);

				await act(async () => {
					fireEvent.click(screen.getAllByTitle('Sync status with GitHub')[0]);
				});

				expect(syncContribution).toHaveBeenCalledWith('active-1');
				expect(await screen.findByText('Contribution synced')).toBeInTheDocument();

				await act(async () => {
					fireEvent.click(screen.getByText('Finalize PR'));
				});

				expect(finalizeContribution).toHaveBeenCalledWith('active-1');
			} finally {
				restore();
				(window.maestro.symphony as Record<string, unknown>).syncContribution =
					previousSyncContribution;
			}
		});

		it('renders fallback status text for unknown active contribution statuses', async () => {
			const restore = applyMockOverrides(mockUseSymphonyReturn, {
				activeContributions: [
					createActiveContribution({
						id: 'active-unknown-status',
						issueNumber: 44,
						issueTitle: 'Unknown status issue',
						status: 'waiting_on_maintainer' as any,
					}),
				],
			});

			try {
				await renderSymphonyModal();

				await act(async () => {
					fireEvent.click(screen.getByRole('button', { name: 'Active (1)' }));
				});

				expect(screen.getByText('Unknown status issue')).toBeInTheDocument();
				expect(screen.getByText('waiting_on_maintainer')).toBeInTheDocument();
			} finally {
				restore();
			}
		});

		it('reports contribution sync failures locally', async () => {
			vi.useFakeTimers();
			const syncFailure = new Error('GitHub unavailable');
			const syncContribution = vi.fn().mockRejectedValue(syncFailure);
			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
			const restore = applyMockOverrides(mockUseSymphonyReturn, {
				activeContributions: [createActiveContribution()],
			});
			const previousSyncContribution = (window.maestro.symphony as Record<string, unknown>)
				.syncContribution;
			(window.maestro.symphony as Record<string, unknown>).syncContribution = syncContribution;

			try {
				await renderSymphonyModal();

				await act(async () => {
					fireEvent.click(screen.getByRole('button', { name: 'Active (1)' }));
				});

				await act(async () => {
					fireEvent.click(screen.getByTitle('Sync status with GitHub'));
					await Promise.resolve();
				});

				expect(syncContribution).toHaveBeenCalledWith('active-1');
				expect(screen.getByText('Sync failed')).toBeInTheDocument();
				expect(consoleError).toHaveBeenCalledWith('Failed to sync contribution:', syncFailure);

				act(() => {
					vi.advanceTimersByTime(5_000);
				});
				expect(screen.queryByText('Sync failed')).not.toBeInTheDocument();
			} finally {
				consoleError.mockRestore();
				restore();
				(window.maestro.symphony as Record<string, unknown>).syncContribution =
					previousSyncContribution;
				vi.useRealTimers();
			}
		});

		it('shows syncing state and ignores empty sync responses', async () => {
			let resolveSync!: (value: Record<string, never>) => void;
			const syncContribution = vi.fn().mockReturnValue(
				new Promise<Record<string, never>>((resolve) => {
					resolveSync = resolve;
				})
			);
			const restore = applyMockOverrides(mockUseSymphonyReturn, {
				activeContributions: [createActiveContribution()],
			});
			const previousSyncContribution = (window.maestro.symphony as Record<string, unknown>)
				.syncContribution;
			(window.maestro.symphony as Record<string, unknown>).syncContribution = syncContribution;

			try {
				await renderSymphonyModal();

				await act(async () => {
					fireEvent.click(screen.getByRole('button', { name: 'Active (1)' }));
				});

				const syncButton = screen.getByTitle('Sync status with GitHub');
				await act(async () => {
					fireEvent.click(syncButton);
				});

				expect(syncButton).toBeDisabled();
				expect(within(syncButton).getByTestId('icon-RefreshCw')).toHaveClass('animate-spin');

				await act(async () => {
					resolveSync({});
				});

				await waitFor(() => expect(syncButton).not.toBeDisabled());
				expect(screen.queryByText('Contribution synced')).not.toBeInTheDocument();
			} finally {
				restore();
				(window.maestro.symphony as Record<string, unknown>).syncContribution =
					previousSyncContribution;
			}
		});

		it('clears transient sync and PR status messages after their timeout', async () => {
			vi.useFakeTimers();
			const syncContribution = vi.fn().mockResolvedValue({ message: 'Contribution synced' });
			const checkPRStatuses = vi
				.fn()
				.mockResolvedValue({ success: true, checked: 2, merged: 0, closed: 0 });
			const restore = applyMockOverrides(mockUseSymphonyReturn, {
				activeContributions: [createActiveContribution()],
			});
			const previousSyncContribution = (window.maestro.symphony as Record<string, unknown>)
				.syncContribution;
			const previousCheckPRStatuses = (window.maestro.symphony as Record<string, unknown>)
				.checkPRStatuses;
			(window.maestro.symphony as Record<string, unknown>).syncContribution = syncContribution;
			(window.maestro.symphony as Record<string, unknown>).checkPRStatuses = checkPRStatuses;

			try {
				await renderSymphonyModal();

				await act(async () => {
					fireEvent.click(screen.getByRole('button', { name: 'Active (1)' }));
				});

				await act(async () => {
					fireEvent.click(screen.getByTitle('Sync status with GitHub'));
				});
				await act(async () => {
					await Promise.resolve();
				});
				expect(screen.getByText('Contribution synced')).toBeInTheDocument();

				act(() => {
					vi.advanceTimersByTime(5_000);
				});
				expect(screen.queryByText('Contribution synced')).not.toBeInTheDocument();

				await act(async () => {
					fireEvent.click(screen.getByText('Check PR Status'));
				});
				await act(async () => {
					await Promise.resolve();
				});
				expect(screen.getByText('All PRs up to date')).toBeInTheDocument();

				act(() => {
					vi.advanceTimersByTime(5_000);
				});
				expect(screen.queryByText('All PRs up to date')).not.toBeInTheDocument();
			} finally {
				restore();
				(window.maestro.symphony as Record<string, unknown>).syncContribution =
					previousSyncContribution;
				(window.maestro.symphony as Record<string, unknown>).checkPRStatuses =
					previousCheckPRStatuses;
				vi.useRealTimers();
			}
		});

		it('renders completed contribution cards and opens their pull requests', async () => {
			const restoreSymphony = applyMockOverrides(mockUseSymphonyReturn, {
				completedContributions: [
					createCompletedContribution(),
					createCompletedContribution({
						id: 'completed-2',
						issueNumber: 53,
						issueTitle: 'Legacy merged issue',
						merged: true,
						prNumber: 53,
						prUrl: 'https://github.com/test-owner/test-repo/pull/53',
						tokenUsage: {
							inputTokens: 450,
							outputTokens: 450,
							totalCost: 0.4,
						},
						wasMerged: undefined,
					}),
					createCompletedContribution({
						id: 'completed-3',
						issueNumber: 54,
						issueTitle: 'Closed issue',
						prNumber: 54,
						prUrl: 'https://github.com/test-owner/test-repo/pull/54',
						wasClosed: true,
						wasMerged: false,
					}),
					createCompletedContribution({
						id: 'completed-4',
						issueNumber: 55,
						issueTitle: 'Open review issue',
						prNumber: 55,
						prUrl: 'https://github.com/test-owner/test-repo/pull/55',
						wasMerged: false,
					}),
					createCompletedContribution({
						id: 'completed-5',
						issueNumber: 56,
						issueTitle: 'No merge metadata issue',
						prNumber: 56,
						prUrl: 'https://github.com/test-owner/test-repo/pull/56',
						wasMerged: undefined,
						merged: undefined,
					}),
				],
			});
			const restoreStats = applyMockOverrides(mockContributorStatsReturn, {
				stats: {
					totalContributions: 5,
					totalMerged: 2,
					totalTasksCompleted: 20,
				},
				formattedTotalCost: '$2.30',
				formattedTotalTokens: '4.2K',
			});
			vi.mocked(window.maestro.shell.openExternal).mockResolvedValue(undefined);

			try {
				await renderSymphonyModal();

				await act(async () => {
					fireEvent.click(screen.getByRole('button', { name: 'History' }));
				});

				expect(screen.getByText('Completed issue')).toBeInTheDocument();
				expect(screen.getByText('Legacy merged issue')).toBeInTheDocument();
				expect(screen.getByText('Closed issue')).toBeInTheDocument();
				expect(screen.getByText('Open review issue')).toBeInTheDocument();
				expect(screen.getByText('No merge metadata issue')).toBeInTheDocument();
				expect(screen.getAllByText('Merged')).toHaveLength(3);
				expect(screen.getByText('Closed')).toBeInTheDocument();
				expect(screen.getAllByText('Open')).toHaveLength(2);
				expect(screen.getAllByText('1.5K')).toHaveLength(4);
				expect(screen.getByText('900')).toBeInTheDocument();
				expect(screen.getAllByText('$0.75')).toHaveLength(4);
				expect(screen.getByText('PRs Created')).toBeInTheDocument();
				expect(screen.getByText('4.2K')).toBeInTheDocument();
				expect(screen.getByText('$2.30')).toBeInTheDocument();

				await act(async () => {
					fireEvent.click(screen.getByText('PR #54'));
				});

				expect(window.maestro.shell.openExternal).toHaveBeenCalledWith(
					'https://github.com/test-owner/test-repo/pull/54'
				);
			} finally {
				restoreSymphony();
				restoreStats();
			}
		});

		it('previews issue documents and shows blocked issue sections', async () => {
			const fetchDocumentContent = vi
				.fn()
				.mockResolvedValue({ success: true, content: '# Remote document' });
			const richIssue = createIssue();
			const blockedIssue = createIssue({
				number: 102,
				title: 'Blocked issue',
				labels: [{ name: 'blocking', color: 'd73a4a', description: 'Blocked' }],
			});
			const inProgressIssue = createIssue({
				number: 103,
				title: 'Already claimed issue',
				claimedByPr: {
					number: 77,
					url: 'https://github.com/test/repo/pull/77',
					author: 'alice',
					isDraft: true,
				},
				status: 'in_progress',
			});
			const claimedReviewIssue = createIssue({
				number: 104,
				title: 'Claimed review issue',
				claimedByPr: {
					number: 78,
					url: 'https://github.com/test/repo/pull/78',
					author: 'bob',
					isDraft: false,
				},
				status: 'in_progress',
			});
			const restore = applyMockOverrides(mockUseSymphonyReturn, {
				repoIssues: [richIssue, blockedIssue, inProgressIssue, claimedReviewIssue],
			});
			const previousFetchDocumentContent = (window.maestro.symphony as Record<string, unknown>)
				.fetchDocumentContent;
			(window.maestro.symphony as Record<string, unknown>).fetchDocumentContent =
				fetchDocumentContent;
			vi.mocked(window.maestro.shell.openExternal).mockResolvedValue(undefined);

			try {
				await renderSymphonyModal();

				await act(async () => {
					fireEvent.click(screen.getByText('Test Repository'));
				});

				expect(await screen.findByText('In Progress (2)')).toBeInTheDocument();
				expect(screen.getByText('Blocked (1)')).toBeInTheDocument();

				await act(async () => {
					const claimedPrButtons = screen.getAllByRole('button', {
						name: /Draft PR #77 by @alice/i,
					});
					fireEvent.click(claimedPrButtons[claimedPrButtons.length - 1]);
				});

				expect(window.maestro.shell.openExternal).toHaveBeenCalledWith(
					'https://github.com/test/repo/pull/77'
				);

				await act(async () => {
					const claimedPrButtons = screen.getAllByRole('button', {
						name: /PR #78 by @bob/i,
					});
					fireEvent.click(claimedPrButtons[claimedPrButtons.length - 1]);
				});

				expect(window.maestro.shell.openExternal).toHaveBeenCalledWith(
					'https://github.com/test/repo/pull/78'
				);

				const blockedCard = screen.getByRole('button', { name: /Blocked issue/ });
				await act(async () => {
					fireEvent.keyDown(within(blockedCard).getByText('Blocked issue'), { key: 'Enter' });
				});
				expect(screen.getAllByText('Blocked issue')).toHaveLength(1);

				await act(async () => {
					fireEvent.keyDown(blockedCard, { key: 'Enter' });
				});
				expect(screen.getAllByText('Blocked issue')).toHaveLength(2);

				await act(async () => {
					fireEvent.keyDown(blockedCard, { key: ' ' });
				});
				expect(screen.getAllByText('Blocked issue')).toHaveLength(2);

				await act(async () => {
					fireEvent.keyDown(blockedCard, { key: 'Escape' });
				});
				expect(screen.getAllByText('Blocked issue')).toHaveLength(2);

				await act(async () => {
					fireEvent.click(screen.getByText('Document-rich issue'));
				});

				expect(await screen.findByText(/This document is located at/)).toBeInTheDocument();

				await act(async () => {
					fireEvent.click(screen.getByText('local.md'));
				});

				expect(screen.getByText('remote.md')).toBeInTheDocument();

				await act(async () => {
					fireEvent.click(screen.getByText('remote.md'));
				});

				expect(fetchDocumentContent).toHaveBeenCalledWith('https://example.com/remote.md');
				expect(await screen.findByText('# Remote document')).toBeInTheDocument();

				await act(async () => {
					fireEvent.click(screen.getByText('View Issue'));
				});

				expect(window.maestro.shell.openExternal).toHaveBeenCalledWith(
					'https://github.com/test/repo/issues/101'
				);
			} finally {
				restore();
				(window.maestro.symphony as Record<string, unknown>).fetchDocumentContent =
					previousFetchDocumentContent;
			}
		});

		it('renders all-worked and blocked-only issue list states', async () => {
			const inProgressOnly = createIssue({
				number: 105,
				title: 'Only active issue',
				status: 'in_progress',
			});
			const blockedOnly = createIssue({
				number: 106,
				title: 'Only blocked issue',
				labels: [{ name: 'blocking', color: 'd73a4a', description: 'Blocked' }],
			});
			const restore = applyMockOverrides(mockUseSymphonyReturn, {
				repoIssues: [inProgressOnly],
			});

			try {
				await renderSymphonyModal();

				await act(async () => {
					fireEvent.click(screen.getByText('Test Repository'));
				});

				expect(
					await screen.findByText('All issues are currently being worked on')
				).toBeInTheDocument();

				restore();
				const restoreBlocked = applyMockOverrides(mockUseSymphonyReturn, {
					repoIssues: [blockedOnly],
				});

				try {
					await act(async () => {
						fireEvent.click(screen.getByTitle('Back (Esc)'));
					});
					await act(async () => {
						fireEvent.click(screen.getByText('Test Repository'));
					});

					expect(await screen.findByText('Blocked (1)')).toBeInTheDocument();
					expect(
						screen.queryByText('All issues are currently being worked on')
					).not.toBeInTheDocument();
				} finally {
					restoreBlocked();
				}
			} finally {
				restore();
			}
		});

		it('wraps document keyboard navigation and labels issues without documents', async () => {
			const fetchDocumentContent = vi
				.fn()
				.mockResolvedValue({ success: true, content: '# Preview' });
			const emptyDocumentIssue = createIssue({
				number: 107,
				title: 'Empty document issue',
				documentPaths: [],
			});
			const wrappedDocumentIssue = createIssue({
				number: 108,
				title: 'Wrapped document issue',
				documentPaths: [
					{ name: 'first.md', path: 'https://example.com/first.md', isExternal: true },
					{ name: 'second.md', path: 'https://example.com/second.md', isExternal: true },
					{ name: 'third.md', path: 'https://example.com/third.md', isExternal: true },
				],
			});
			const restore = applyMockOverrides(mockUseSymphonyReturn, {
				repoIssues: [emptyDocumentIssue, wrappedDocumentIssue],
			});
			const previousFetchDocumentContent = (window.maestro.symphony as Record<string, unknown>)
				.fetchDocumentContent;
			(window.maestro.symphony as Record<string, unknown>).fetchDocumentContent =
				fetchDocumentContent;

			try {
				await renderSymphonyModal();

				await act(async () => {
					fireEvent.click(screen.getByText('Test Repository'));
				});
				await act(async () => {
					fireEvent.click(screen.getByText('Wrapped document issue'));
				});

				await waitFor(() =>
					expect(fetchDocumentContent).toHaveBeenLastCalledWith('https://example.com/first.md')
				);

				await act(async () => {
					fireEvent.keyDown(window, { metaKey: true, shiftKey: true, key: '[' });
				});
				await waitFor(() =>
					expect(fetchDocumentContent).toHaveBeenLastCalledWith('https://example.com/third.md')
				);

				await act(async () => {
					fireEvent.keyDown(window, { metaKey: true, shiftKey: true, key: ']' });
				});
				await waitFor(() =>
					expect(fetchDocumentContent).toHaveBeenLastCalledWith('https://example.com/first.md')
				);

				await act(async () => {
					fireEvent.keyDown(window, { metaKey: true, shiftKey: true, key: ']' });
				});
				await waitFor(() =>
					expect(fetchDocumentContent).toHaveBeenLastCalledWith('https://example.com/second.md')
				);

				await act(async () => {
					fireEvent.click(screen.getByRole('button', { name: 'Projects' }));
				});
				await act(async () => {
					fireEvent.click(screen.getByText('Empty document issue'));
				});

				expect(screen.getByRole('button', { name: 'Select document' })).toBeInTheDocument();
			} finally {
				restore();
				(window.maestro.symphony as Record<string, unknown>).fetchDocumentContent =
					previousFetchDocumentContent;
			}
		});

		it('renders issue loading skeletons in the repository detail view', async () => {
			const restore = applyMockOverrides(mockUseSymphonyReturn, {
				isLoadingIssues: true,
				repoIssues: [],
			});

			try {
				await renderSymphonyModal();

				await act(async () => {
					fireEvent.click(screen.getByText('Test Repository'));
				});

				expect(await screen.findByText('Maestro Symphony: Test Repository')).toBeInTheDocument();
				expect(document.body.querySelectorAll('[class*="animate-pulse"]')).toHaveLength(3);
				expect(screen.getByText('Select an issue to see details')).toBeInTheDocument();
			} finally {
				restore();
			}
		});

		it('opens detail view external links, markdown links, and closes document dropdown outside', async () => {
			const fetchDocumentContent = vi
				.fn()
				.mockResolvedValue({ success: true, content: '[Read docs](https://example.com/docs)' });
			const restore = applyMockOverrides(mockUseSymphonyReturn, {
				repoIssues: [createIssue()],
			});
			const previousFetchDocumentContent = (window.maestro.symphony as Record<string, unknown>)
				.fetchDocumentContent;
			(window.maestro.symphony as Record<string, unknown>).fetchDocumentContent =
				fetchDocumentContent;
			vi.mocked(window.maestro.shell.openExternal).mockResolvedValue(undefined);

			try {
				await renderSymphonyModal();

				await act(async () => {
					fireEvent.click(screen.getByText('Test Repository'));
				});
				expect(await screen.findByText('Maestro Symphony: Test Repository')).toBeInTheDocument();

				await act(async () => {
					fireEvent.click(screen.getByTitle('View repository on GitHub'));
				});
				expect(window.maestro.shell.openExternal).toHaveBeenCalledWith(mockRepo.url);

				await act(async () => {
					fireEvent.click(screen.getByRole('button', { name: /^Test$/ }));
				});
				expect(window.maestro.shell.openExternal).toHaveBeenCalledWith('https://github.com/test');

				const issueCard = screen.getByRole('button', { name: /Document-rich issue/ });
				await act(async () => {
					fireEvent.keyDown(issueCard, { key: 'Enter' });
				});
				expect(await screen.findByText('Start Symphony')).toBeInTheDocument();

				const getExactTextButton = (text: string) => {
					const button = screen
						.getAllByRole('button')
						.find((candidate) => candidate.textContent?.trim() === text);
					expect(button).toBeDefined();
					return button as HTMLElement;
				};

				await act(async () => {
					fireEvent.click(getExactTextButton('local.md'));
				});
				expect(screen.getByRole('button', { name: 'remote.md' })).toBeInTheDocument();

				await act(async () => {
					fireEvent.mouseDown(screen.getByRole('button', { name: 'remote.md' }));
				});
				expect(screen.getByRole('button', { name: 'remote.md' })).toBeInTheDocument();

				await act(async () => {
					fireEvent.mouseDown(document.body);
				});
				expect(screen.queryByRole('button', { name: 'remote.md' })).not.toBeInTheDocument();

				await act(async () => {
					fireEvent.click(getExactTextButton('local.md'));
				});
				await act(async () => {
					fireEvent.click(getExactTextButton('remote.md'));
				});

				expect(fetchDocumentContent).toHaveBeenCalledWith('https://example.com/remote.md');
				await act(async () => {
					fireEvent.click(await screen.findByRole('link', { name: 'Read docs' }));
				});
				expect(window.maestro.shell.openExternal).toHaveBeenCalledWith('https://example.com/docs');

				await act(async () => {
					fireEvent.keyDown(window, { key: ']', metaKey: true, shiftKey: true });
				});
				await act(async () => {
					fireEvent.click(screen.getByRole('button', { name: 'Projects' }));
				});
				expect(await screen.findByText(/docs\/local\.md/)).toBeInTheDocument();
			} finally {
				restore();
				(window.maestro.symphony as Record<string, unknown>).fetchDocumentContent =
					previousFetchDocumentContent;
			}
		});

		it('reports failed document previews and supports keyboard document navigation', async () => {
			const previewIssue = createIssue({
				documentPaths: [
					{ name: 'local.md', path: 'docs/local.md', isExternal: false },
					{ name: 'forbidden.md', path: 'https://example.com/forbidden.md', isExternal: true },
					{ name: 'throws.md', path: 'https://example.com/throws.md', isExternal: true },
				],
			});
			const fetchDocumentContent = vi
				.fn()
				.mockResolvedValueOnce({ success: false, error: 'Forbidden' })
				.mockRejectedValueOnce(new Error('Network down'))
				.mockResolvedValueOnce({ success: true, content: '# Recovered document' });
			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
			const restore = applyMockOverrides(mockUseSymphonyReturn, {
				repoIssues: [previewIssue],
			});
			const previousFetchDocumentContent = (window.maestro.symphony as Record<string, unknown>)
				.fetchDocumentContent;
			(window.maestro.symphony as Record<string, unknown>).fetchDocumentContent =
				fetchDocumentContent;

			try {
				await renderSymphonyModal();

				await act(async () => {
					fireEvent.click(screen.getByText('Test Repository'));
				});
				await act(async () => {
					fireEvent.click(screen.getByText('Document-rich issue'));
				});

				expect(await screen.findByText(/docs\/local\.md/)).toBeInTheDocument();

				await act(async () => {
					fireEvent.click(screen.getByRole('button', { name: 'local.md' }));
				});
				await act(async () => {
					fireEvent.click(screen.getByRole('button', { name: 'forbidden.md' }));
				});

				expect(fetchDocumentContent).toHaveBeenCalledWith('https://example.com/forbidden.md');
				expect(await screen.findByText(/Failed to load document: Forbidden/)).toBeInTheDocument();

				await act(async () => {
					fireEvent.click(screen.getByRole('button', { name: 'forbidden.md' }));
				});
				await act(async () => {
					fireEvent.click(screen.getByRole('button', { name: 'throws.md' }));
				});

				expect(fetchDocumentContent).toHaveBeenCalledWith('https://example.com/throws.md');
				expect(
					await screen.findByText(/Failed to load document: Network down/)
				).toBeInTheDocument();
				expect(consoleError).toHaveBeenCalledWith('Failed to fetch document:', expect.any(Error));

				await act(async () => {
					fireEvent.keyDown(window, { metaKey: true, shiftKey: true, key: '[' });
				});

				expect(fetchDocumentContent).toHaveBeenLastCalledWith('https://example.com/forbidden.md');
			} finally {
				consoleError.mockRestore();
				restore();
				(window.maestro.symphony as Record<string, unknown>).fetchDocumentContent =
					previousFetchDocumentContent;
			}
		});

		it('shows document loading and unknown document failure messages', async () => {
			let resolveFetch!: (value: { success: boolean; content?: string; error?: string }) => void;
			const previewIssue = createIssue({
				documentPaths: [
					{ name: 'local.md', path: 'docs/local.md', isExternal: false },
					{ name: 'pending.md', path: 'https://example.com/pending.md', isExternal: true },
					{ name: 'no-error.md', path: 'https://example.com/no-error.md', isExternal: true },
					{
						name: 'string-error.md',
						path: 'https://example.com/string-error.md',
						isExternal: true,
					},
					{ name: 'anchor.md', path: 'https://example.com/anchor.md', isExternal: true },
				],
			});
			const fetchDocumentContent = vi
				.fn()
				.mockReturnValueOnce(
					new Promise((resolve) => {
						resolveFetch = resolve;
					})
				)
				.mockResolvedValueOnce({ success: false })
				.mockRejectedValueOnce('plain network failure')
				.mockResolvedValueOnce({ success: true, content: '[Jump](#section)' });
			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
			const restore = applyMockOverrides(mockUseSymphonyReturn, {
				repoIssues: [previewIssue],
			});
			const previousFetchDocumentContent = (window.maestro.symphony as Record<string, unknown>)
				.fetchDocumentContent;
			(window.maestro.symphony as Record<string, unknown>).fetchDocumentContent =
				fetchDocumentContent;
			vi.mocked(window.maestro.shell.openExternal).mockResolvedValue(undefined);

			try {
				await renderSymphonyModal();

				await act(async () => {
					fireEvent.click(screen.getByText('Test Repository'));
				});
				await act(async () => {
					fireEvent.click(screen.getByText('Document-rich issue'));
				});

				await act(async () => {
					fireEvent.click(screen.getByRole('button', { name: 'local.md' }));
				});
				await act(async () => {
					fireEvent.click(screen.getByRole('button', { name: 'pending.md' }));
				});

				expect(screen.getByTestId('icon-Loader2')).toHaveClass('animate-spin');

				await act(async () => {
					resolveFetch({ success: false });
				});
				expect(
					await screen.findByText(/Failed to load document: Unknown error/)
				).toBeInTheDocument();

				await act(async () => {
					fireEvent.click(screen.getByRole('button', { name: 'pending.md' }));
				});
				await act(async () => {
					fireEvent.click(screen.getByRole('button', { name: 'no-error.md' }));
				});
				expect(
					await screen.findByText(/Failed to load document: Unknown error/)
				).toBeInTheDocument();

				await act(async () => {
					fireEvent.click(screen.getByRole('button', { name: 'no-error.md' }));
				});
				await act(async () => {
					fireEvent.click(screen.getByRole('button', { name: 'string-error.md' }));
				});
				expect(
					await screen.findByText(/Failed to load document: Unknown error/)
				).toBeInTheDocument();
				expect(consoleError).toHaveBeenCalledWith(
					'Failed to fetch document:',
					'plain network failure'
				);

				await act(async () => {
					fireEvent.click(screen.getByRole('button', { name: 'string-error.md' }));
				});
				await act(async () => {
					fireEvent.click(screen.getByRole('button', { name: 'anchor.md' }));
				});
				await act(async () => {
					fireEvent.click(await screen.findByRole('link', { name: 'Jump' }));
				});
				expect(window.maestro.shell.openExternal).not.toHaveBeenCalledWith('#section');
			} finally {
				consoleError.mockRestore();
				restore();
				(window.maestro.symphony as Record<string, unknown>).fetchDocumentContent =
					previousFetchDocumentContent;
			}
		});

		it('reports merged and closed pull requests from the status check', async () => {
			const checkPRStatuses = vi
				.fn()
				.mockResolvedValue({ success: true, checked: 4, merged: 2, closed: 2 });
			const previousCheckPRStatuses = (window.maestro.symphony as Record<string, unknown>)
				.checkPRStatuses;
			(window.maestro.symphony as Record<string, unknown>).checkPRStatuses = checkPRStatuses;

			try {
				await renderSymphonyModal();

				await act(async () => {
					fireEvent.click(screen.getByRole('button', { name: 'Active' }));
				});

				await act(async () => {
					fireEvent.click(screen.getByText('Check PR Status'));
				});

				expect(checkPRStatuses).toHaveBeenCalledTimes(1);
				expect(await screen.findByText('2 PRs merged, 2 PRs closed')).toBeInTheDocument();
			} finally {
				(window.maestro.symphony as Record<string, unknown>).checkPRStatuses =
					previousCheckPRStatuses;
			}
		});

		it('reports singular PR status counts while the status check is pending', async () => {
			let resolveCheck!: (value: {
				success: boolean;
				checked: number;
				merged: number;
				closed: number;
			}) => void;
			const checkPRStatuses = vi.fn().mockReturnValue(
				new Promise((resolve) => {
					resolveCheck = resolve;
				})
			);
			const previousCheckPRStatuses = (window.maestro.symphony as Record<string, unknown>)
				.checkPRStatuses;
			(window.maestro.symphony as Record<string, unknown>).checkPRStatuses = checkPRStatuses;

			try {
				await renderSymphonyModal();

				await act(async () => {
					fireEvent.click(screen.getByRole('button', { name: 'Active' }));
				});

				const checkButton = screen
					.getByText('Check PR Status')
					.closest('button') as HTMLButtonElement;
				await act(async () => {
					fireEvent.click(checkButton);
				});

				expect(checkButton).toBeDisabled();
				expect(within(checkButton).getByTestId('icon-RefreshCw')).toHaveClass('animate-spin');

				await act(async () => {
					resolveCheck({ success: true, checked: 2, merged: 1, closed: 1 });
				});

				expect(await screen.findByText('1 PR merged, 1 PR closed')).toBeInTheDocument();
			} finally {
				(window.maestro.symphony as Record<string, unknown>).checkPRStatuses =
					previousCheckPRStatuses;
			}
		});

		it('reports up-to-date statuses when merge counters are omitted', async () => {
			const checkPRStatuses = vi.fn().mockResolvedValue({ success: true, checked: 1 });
			const previousCheckPRStatuses = (window.maestro.symphony as Record<string, unknown>)
				.checkPRStatuses;
			(window.maestro.symphony as Record<string, unknown>).checkPRStatuses = checkPRStatuses;

			try {
				await renderSymphonyModal();

				await act(async () => {
					fireEvent.click(screen.getByRole('button', { name: 'Active' }));
				});

				await act(async () => {
					fireEvent.click(screen.getByText('Check PR Status'));
				});

				expect(await screen.findByText('All PRs up to date')).toBeInTheDocument();
			} finally {
				(window.maestro.symphony as Record<string, unknown>).checkPRStatuses =
					previousCheckPRStatuses;
			}
		});

		it('reports when checked pull requests are already up to date', async () => {
			const checkPRStatuses = vi
				.fn()
				.mockResolvedValue({ success: true, checked: 2, merged: 0, closed: 0 });
			const previousCheckPRStatuses = (window.maestro.symphony as Record<string, unknown>)
				.checkPRStatuses;
			(window.maestro.symphony as Record<string, unknown>).checkPRStatuses = checkPRStatuses;

			try {
				await renderSymphonyModal();

				await act(async () => {
					fireEvent.click(screen.getByRole('button', { name: 'Active' }));
				});

				await act(async () => {
					fireEvent.click(screen.getByText('Check PR Status'));
				});

				expect(await screen.findByText('All PRs up to date')).toBeInTheDocument();
			} finally {
				(window.maestro.symphony as Record<string, unknown>).checkPRStatuses =
					previousCheckPRStatuses;
			}
		});

		it('reports when there are no pull requests to check', async () => {
			const checkPRStatuses = vi.fn().mockResolvedValue({ success: true });
			const previousCheckPRStatuses = (window.maestro.symphony as Record<string, unknown>)
				.checkPRStatuses;
			(window.maestro.symphony as Record<string, unknown>).checkPRStatuses = checkPRStatuses;

			try {
				await renderSymphonyModal();

				await act(async () => {
					fireEvent.click(screen.getByRole('button', { name: 'Active' }));
				});

				await act(async () => {
					fireEvent.click(screen.getByText('Check PR Status'));
				});

				expect(await screen.findByText('No PRs to check')).toBeInTheDocument();
			} finally {
				(window.maestro.symphony as Record<string, unknown>).checkPRStatuses =
					previousCheckPRStatuses;
			}
		});

		it('reports status check failures', async () => {
			vi.useFakeTimers();
			const checkPRStatuses = vi.fn().mockRejectedValue(new Error('GitHub unavailable'));
			const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
			const previousCheckPRStatuses = (window.maestro.symphony as Record<string, unknown>)
				.checkPRStatuses;
			(window.maestro.symphony as Record<string, unknown>).checkPRStatuses = checkPRStatuses;

			try {
				await renderSymphonyModal();

				await act(async () => {
					fireEvent.click(screen.getByRole('button', { name: 'Active' }));
				});

				await act(async () => {
					fireEvent.click(screen.getByText('Check PR Status'));
					await Promise.resolve();
				});

				expect(screen.getByText('Failed to check statuses')).toBeInTheDocument();
				expect(errorSpy).toHaveBeenCalledWith('Failed to check PR statuses:', expect.any(Error));

				act(() => {
					vi.advanceTimersByTime(5_000);
				});
				expect(screen.queryByText('Failed to check statuses')).not.toBeInTheDocument();
			} finally {
				errorSpy.mockRestore();
				(window.maestro.symphony as Record<string, unknown>).checkPRStatuses =
					previousCheckPRStatuses;
				vi.useRealTimers();
			}
		});

		it('renders earned and locked achievement cards with progress', async () => {
			const restore = applyMockOverrides(mockContributorStatsReturn, {
				achievements: [
					{
						id: 'earned-achievement',
						title: 'Merged Melody',
						description: 'Have a contribution merged',
						icon: '🎼',
						earned: true,
						earnedAt: '2025-01-02T00:00:00Z',
					},
					{
						id: 'locked-progress-achievement',
						title: 'Virtuoso',
						description: 'Complete 1000 tasks across all contributions',
						icon: '🏆',
						earned: false,
						progress: 42,
					},
					{
						id: 'locked-plain-achievement',
						title: 'Early Adopter',
						description: 'Join Symphony in its first month',
						icon: '🌟',
						earned: false,
					},
				],
				currentStreakWeeks: 3,
				formattedTotalCost: '$9.99',
				formattedTotalTime: '2h',
				formattedTotalTokens: '12.3K',
				longestStreakWeeks: 5,
				uniqueRepos: 4,
			});

			try {
				await renderSymphonyModal();

				await act(async () => {
					fireEvent.click(screen.getByRole('button', { name: 'Stats' }));
				});

				expect(screen.getByText('12.3K')).toBeInTheDocument();
				expect(screen.getByText('Worth $9.99')).toBeInTheDocument();
				expect(screen.getByText('2h')).toBeInTheDocument();
				expect(screen.getByText('4 repositories')).toBeInTheDocument();
				expect(screen.getByText('3 weeks')).toBeInTheDocument();
				expect(screen.getByText('Best: 5 weeks')).toBeInTheDocument();
				expect(screen.getByText('Merged Melody')).toBeInTheDocument();
				expect(screen.getByText('Virtuoso')).toBeInTheDocument();
				expect(screen.getByText('Early Adopter')).toBeInTheDocument();
				expect(screen.getByText('🎼')).toBeInTheDocument();
				expect(screen.getByText('🏆')).toBeInTheDocument();
				expect(screen.getByTestId('icon-CheckCircle')).toBeInTheDocument();
			} finally {
				restore();
			}
		});
	});
});
