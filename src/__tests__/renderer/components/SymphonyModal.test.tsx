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
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import type { Theme } from '../../../renderer/types';
import type { RegisteredRepository, SymphonyIssue, SymphonyCategory } from '../../../shared/symphony-types';

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
	AgentCreationDialog: () => <div data-testid="agent-creation-dialog" />,
}));

vi.mock('../../../renderer/utils/markdownConfig', () => ({
	REMARK_GFM_PLUGINS: [],
	generateProseStyles: () => '',
	createMarkdownComponents: () => ({}),
}));

vi.mock('../../../renderer/utils/shortcutFormatter', () => ({
	formatShortcutKeys: (keys: string[]) => keys.join('+'),
}));

vi.mock('react-markdown', () => ({
	default: ({ children }: { children: string }) => <div>{children}</div>,
}));

vi.mock('remark-gfm', () => ({
	default: () => null,
}));

// Mock lucide-react icons
vi.mock('lucide-react', () => {
	const icon = (name: string) => {
		const Component = ({ className, style, ...props }: Record<string, unknown>) => (
			<svg data-testid={`icon-${name}`} className={className as string} style={style as React.CSSProperties} {...props} />
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
});
