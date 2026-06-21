import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { AutoRunSetupSheet } from '../../../web/mobile/AutoRunSetupSheet';
import type { AutoRunDocument, Playbook } from '../../../web/hooks/useAutoRun';

const mockColors = {
	bgMain: '#0b0b0d',
	bgSidebar: '#111113',
	bgActivity: '#1c1c1f',
	border: '#27272a',
	textMain: '#e4e4e7',
	textDim: '#a1a1aa',
	accent: '#6366f1',
	accentDim: 'rgba(99, 102, 241, 0.2)',
	accentText: '#a5b4fc',
	success: '#22c55e',
	warning: '#eab308',
	error: '#ef4444',
};

const mockUseAutoRunState = {
	playbooks: [] as Playbook[],
	isLoadingPlaybooks: false,
	loadPlaybooks: vi.fn(),
	createPlaybook: vi.fn(),
	updatePlaybook: vi.fn(),
	deletePlaybook: vi.fn(),
};

vi.mock('../../../web/components/ThemeProvider', () => ({
	useThemeColors: () => mockColors,
}));

vi.mock('../../../web/mobile/constants', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../../web/mobile/constants')>();
	return {
		...actual,
		triggerHaptic: vi.fn(),
		HAPTIC_PATTERNS: { tap: [10], success: [10, 30, 60], error: [60, 30, 10] },
	};
});

vi.mock('../../../web/hooks/useAutoRun', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../../web/hooks/useAutoRun')>();
	return {
		...actual,
		useAutoRun: () => mockUseAutoRunState,
	};
});

vi.mock('../../../web/mobile/AutoRunWorktreeSection', () => ({
	AutoRunWorktreeSection: ({
		onChange,
	}: {
		onChange: (state: { status: string; reason?: string; config?: unknown }) => void;
	}) => (
		<div>
			<button
				type="button"
				onClick={() => onChange({ status: 'enabled-loading', reason: 'Loading branches' })}
			>
				Emit loading worktree
			</button>
			<button
				type="button"
				onClick={() =>
					onChange({
						status: 'enabled-valid',
						config: {
							enabled: true,
							path: '/tmp/worktree',
							branchName: 'auto-run-main-1',
							createPROnCompletion: true,
							prTargetBranch: 'main',
						},
					})
				}
			>
				Emit valid worktree
			</button>
		</div>
	),
}));

const documents: AutoRunDocument[] = [
	{ filename: 'alpha.md', path: 'docs/alpha.md', taskCount: 2, completedCount: 0 },
	{ filename: 'beta.md', path: 'docs/beta.md', taskCount: 1, completedCount: 0 },
	{ filename: 'gamma.md', path: 'docs/gamma.md', taskCount: 3, completedCount: 1 },
];

function renderSheet(overrides: Partial<Parameters<typeof AutoRunSetupSheet>[0]> = {}) {
	const props = {
		sessionId: 'session-1',
		documents,
		onLaunch: vi.fn(),
		onClose: vi.fn(),
		sendRequest: vi.fn(),
		send: vi.fn(),
		currentDocument: 'docs/beta.md',
		...overrides,
	};
	render(<AutoRunSetupSheet {...props} />);
	return props;
}

describe('AutoRunSetupSheet', () => {
	beforeEach(() => {
		mockUseAutoRunState.playbooks = [];
		mockUseAutoRunState.isLoadingPlaybooks = false;
		mockUseAutoRunState.loadPlaybooks = vi.fn().mockResolvedValue(undefined);
		mockUseAutoRunState.createPlaybook = vi.fn().mockResolvedValue({
			id: 'saved',
			name: 'Saved Flow',
			createdAt: 1,
			updatedAt: 1,
			documents: [{ filename: 'docs/beta.md', resetOnCompletion: false }],
			loopEnabled: false,
			maxLoops: null,
			prompt: '',
		});
		mockUseAutoRunState.updatePlaybook = vi.fn().mockResolvedValue({
			id: 'pb-1',
			name: 'Daily Flow',
			createdAt: 1,
			updatedAt: 2,
			documents: [{ filename: 'docs/beta.md', resetOnCompletion: false }],
			loopEnabled: true,
			maxLoops: 4,
			prompt: 'updated',
		});
		mockUseAutoRunState.deletePlaybook = vi.fn().mockResolvedValue(true);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	it('launches the selected document with prompt, template variable, and loop settings', async () => {
		const { onLaunch } = renderSheet();

		expect(mockUseAutoRunState.loadPlaybooks).toHaveBeenCalledWith('session-1');
		expect(screen.getByText('beta.md')).toBeInTheDocument();

		fireEvent.change(screen.getByPlaceholderText('Additional instructions for the agent...'), {
			target: { value: 'Run review' },
		});
		fireEvent.click(screen.getByText('Show template variables'));
		fireEvent.click(screen.getByTitle('Insert {{AGENT_DEEP_LINK}}'));
		fireEvent.click(screen.getByRole('switch', { name: 'Loop on completion' }));
		fireEvent.change(screen.getByDisplayValue('3'), { target: { value: '5' } });
		fireEvent.click(screen.getByRole('button', { name: 'Launch Auto Run' }));

		expect(onLaunch).toHaveBeenCalledWith({
			documents: [{ filename: 'docs/beta.md' }],
			prompt: 'Run review {{AGENT_DEEP_LINK}}',
			loopEnabled: true,
			maxLoops: 5,
		});
	});

	it('adds and removes documents before launch', () => {
		const { onLaunch } = renderSheet();

		fireEvent.click(screen.getByText('Add documents'));
		fireEvent.click(screen.getByRole('button', { name: 'Add alpha.md' }));
		fireEvent.click(screen.getByRole('button', { name: 'Add gamma.md' }));
		fireEvent.click(screen.getByRole('button', { name: 'Remove alpha.md' }));
		fireEvent.click(screen.getByRole('button', { name: 'Launch Auto Run' }));

		expect(onLaunch).toHaveBeenCalledWith({
			documents: [{ filename: 'docs/beta.md' }, { filename: 'docs/gamma.md' }],
			prompt: undefined,
			loopEnabled: undefined,
			maxLoops: undefined,
		});
	});

	it('blocks launch while worktree config is loading and includes valid worktree config', () => {
		const { onLaunch } = renderSheet({
			isGitRepo: true,
			worktreeBasePath: '/tmp/worktrees',
			loadGitBranches: vi.fn(),
			loadWorktrees: vi.fn(),
		});

		fireEvent.click(screen.getByText('Emit loading worktree'));
		fireEvent.click(screen.getByRole('button', { name: 'Launch Auto Run' }));
		expect(onLaunch).not.toHaveBeenCalled();
		expect(screen.getByRole('button', { name: 'Launch Auto Run' })).toBeDisabled();

		fireEvent.click(screen.getByText('Emit valid worktree'));
		fireEvent.click(screen.getByRole('button', { name: 'Launch Auto Run' }));

		expect(onLaunch).toHaveBeenCalledWith(
			expect.objectContaining({
				worktree: expect.objectContaining({
					path: '/tmp/worktree',
					branchName: 'auto-run-main-1',
					createPROnCompletion: true,
				}),
			})
		);
	});

	it('creates a playbook through the in-sheet name prompt', async () => {
		renderSheet();

		fireEvent.click(screen.getByRole('button', { name: 'Save current configuration as playbook' }));
		expect(screen.getByLabelText('Name this playbook')).toBeInTheDocument();
		fireEvent.change(screen.getByPlaceholderText('Playbook name'), {
			target: { value: 'Morning run' },
		});
		fireEvent.click(screen.getByRole('button', { name: 'Save' }));

		await waitFor(() =>
			expect(mockUseAutoRunState.createPlaybook).toHaveBeenCalledWith('session-1', {
				name: 'Morning run',
				documents: [{ filename: 'docs/beta.md', resetOnCompletion: false }],
				loopEnabled: false,
				maxLoops: null,
				prompt: '',
			})
		);
	});

	it('loads, updates, and deletes an existing playbook', async () => {
		mockUseAutoRunState.playbooks = [
			{
				id: 'pb-1',
				name: 'Daily Flow',
				createdAt: 1,
				updatedAt: 1,
				documents: [
					{ filename: 'docs/alpha.md', resetOnCompletion: false },
					{ filename: 'missing.md', resetOnCompletion: false },
				],
				loopEnabled: true,
				maxLoops: 4,
				prompt: 'Use context',
			},
		];

		renderSheet();

		fireEvent.click(screen.getByRole('button', { name: 'Load playbook Daily Flow' }));
		expect(screen.getByDisplayValue('Use context')).toBeInTheDocument();
		expect(screen.getByDisplayValue('4')).toBeInTheDocument();
		expect(screen.queryByText('missing.md')).not.toBeInTheDocument();

		fireEvent.change(screen.getByPlaceholderText('Additional instructions for the agent...'), {
			target: { value: 'Use context carefully' },
		});
		fireEvent.click(screen.getByRole('button', { name: 'Update playbook Daily Flow' }));
		fireEvent.click(screen.getByRole('button', { name: 'Update' }));

		await waitFor(() =>
			expect(mockUseAutoRunState.updatePlaybook).toHaveBeenCalledWith(
				'session-1',
				'pb-1',
				expect.objectContaining({
					name: 'Daily Flow',
					documents: [{ filename: 'docs/alpha.md', resetOnCompletion: false }],
					loopEnabled: true,
					maxLoops: 4,
					prompt: 'Use context carefully',
				})
			)
		);

		mockUseAutoRunState.deletePlaybook.mockResolvedValueOnce(false);
		fireEvent.click(screen.getByRole('button', { name: 'Delete playbook Daily Flow' }));
		expect(screen.getByLabelText('Delete playbook')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

		await waitFor(() =>
			expect(mockUseAutoRunState.deletePlaybook).toHaveBeenCalledWith('session-1', 'pb-1')
		);
		expect(screen.getByRole('alert')).toHaveTextContent('Failed to delete "Daily Flow".');
	});

	it('closes after Escape and delayed sheet animation', () => {
		vi.useFakeTimers();
		const { onClose } = renderSheet();

		fireEvent.keyDown(document, { key: 'Escape' });
		expect(onClose).not.toHaveBeenCalled();

		act(() => {
			vi.advanceTimersByTime(300);
		});
		expect(onClose).toHaveBeenCalledTimes(1);
	});
});
