import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { GitWorktreeSection } from '../../../renderer/components/GitWorktreeSection';
import type { GhCliStatus, Theme, WorktreeValidationState } from '../../../renderer/types';

const mocks = vi.hoisted(() => ({
	openExternal: vi.fn(),
	selectFolder: vi.fn(),
}));

vi.mock('lucide-react', () => {
	const Icon = ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<svg data-testid="icon" className={className} style={style} />
	);
	return {
		GitBranch: Icon,
		AlertTriangle: Icon,
		Loader2: Icon,
		ChevronDown: Icon,
	};
});

const theme: Theme = {
	id: 'test',
	name: 'Test',
	mode: 'dark',
	colors: {
		bgMain: '#101010',
		bgSidebar: '#151515',
		bgActivity: '#202020',
		textMain: '#f5f5f5',
		textDim: '#999999',
		accent: '#3b82f6',
		accentDim: '#1d4ed8',
		accentText: '#ffffff',
		accentForeground: '#000000',
		border: '#333333',
		error: '#ef4444',
		warning: '#f59e0b',
		success: '#22c55e',
	},
};

const idleValidation: WorktreeValidationState = {
	checking: false,
	exists: false,
	isWorktree: false,
	branchMismatch: false,
	sameRepo: true,
};

const ghReady: GhCliStatus = {
	installed: true,
	authenticated: true,
};

function createProps(
	overrides: Partial<React.ComponentProps<typeof GitWorktreeSection>> = {}
): React.ComponentProps<typeof GitWorktreeSection> {
	return {
		theme,
		worktreeEnabled: false,
		setWorktreeEnabled: vi.fn(),
		worktreeBaseDir: '/worktrees',
		setWorktreeBaseDir: vi.fn(),
		computedWorktreePath: '',
		branchName: 'feature/test',
		setBranchName: vi.fn(),
		createPROnCompletion: false,
		setCreatePROnCompletion: vi.fn(),
		prTargetBranch: 'main',
		setPrTargetBranch: vi.fn(),
		worktreeValidation: idleValidation,
		availableBranches: ['main', 'develop', 'release'],
		ghCliStatus: ghReady,
		...overrides,
	};
}

function renderSection(overrides: Partial<React.ComponentProps<typeof GitWorktreeSection>> = {}) {
	const props = createProps(overrides);
	return {
		...render(<GitWorktreeSection {...props} />),
		props,
	};
}

describe('GitWorktreeSection', () => {
	const originalMaestro = window.maestro;

	beforeEach(() => {
		vi.clearAllMocks();
		mocks.selectFolder.mockResolvedValue('/selected/worktrees');
		window.maestro = {
			...window.maestro,
			dialog: { ...window.maestro?.dialog, selectFolder: mocks.selectFolder },
			shell: { ...window.maestro?.shell, openExternal: mocks.openExternal },
		};
	});

	afterEach(() => {
		cleanup();
		window.maestro = originalMaestro;
	});

	it('renders disabled and loading GitHub CLI states', () => {
		const setWorktreeEnabled = vi.fn();
		const { rerender } = renderSection({
			ghCliStatus: { installed: false, authenticated: false },
			setWorktreeEnabled,
		});

		const toggle = screen.getByText('Enable Worktree').closest('button')!;
		expect(toggle).toBeDisabled();
		fireEvent.click(toggle);
		expect(setWorktreeEnabled).not.toHaveBeenCalled();

		expect(screen.getByText(/Install/)).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'GitHub CLI' }));
		expect(mocks.openExternal).toHaveBeenCalledWith('https://cli.github.com');

		rerender(
			<GitWorktreeSection
				{...createProps({ ghCliStatus: null, setWorktreeEnabled })}
				ghCliStatus={null}
			/>
		);
		expect(screen.getByText('Checking GitHub CLI...')).toBeInTheDocument();
	});

	it('renders installed inactive toggle styling and enables worktrees', () => {
		const setWorktreeEnabled = vi.fn();
		renderSection({ worktreeEnabled: false, setWorktreeEnabled });

		const toggle = screen.getByRole('button', { name: 'Enable Worktree' });
		expect(toggle).toHaveClass('border-border');
		expect(toggle).toHaveClass('hover:bg-white/5');

		fireEvent.click(toggle);

		expect(setWorktreeEnabled).toHaveBeenCalledWith(true);
	});

	it('toggles worktree mode, edits local fields, browses, and selects PR target branches', async () => {
		const setWorktreeEnabled = vi.fn();
		const setWorktreeBaseDir = vi.fn();
		const setBranchName = vi.fn();
		const setCreatePROnCompletion = vi.fn();
		const setPrTargetBranch = vi.fn();
		renderSection({
			worktreeEnabled: true,
			computedWorktreePath: '/worktrees/feature-test',
			createPROnCompletion: true,
			setWorktreeEnabled,
			setWorktreeBaseDir,
			setBranchName,
			setCreatePROnCompletion,
			setPrTargetBranch,
		});

		fireEvent.click(screen.getByText('Enable Worktree').closest('button')!);
		expect(setWorktreeEnabled).toHaveBeenCalledWith(false);

		fireEvent.change(screen.getByPlaceholderText('/path/to/worktrees'), {
			target: { value: '/tmp/worktrees' },
		});
		expect(setWorktreeBaseDir).toHaveBeenCalledWith('/tmp/worktrees');

		fireEvent.change(screen.getByPlaceholderText('feature-xyz'), {
			target: { value: 'feature/next' },
		});
		expect(setBranchName).toHaveBeenCalledWith('feature/next');

		expect(screen.getByDisplayValue('/worktrees/feature-test')).toBeInTheDocument();

		fireEvent.click(screen.getByTitle('Browse for directory'));
		await waitFor(() => {
			expect(setWorktreeBaseDir).toHaveBeenCalledWith('/selected/worktrees');
		});

		fireEvent.click(screen.getByText('Create PR on completion').closest('button')!);
		expect(setCreatePROnCompletion).toHaveBeenCalledWith(false);

		fireEvent.click(screen.getByTitle('Select target branch for PR'));
		expect(screen.getByRole('button', { name: 'develop' })).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'develop' }));
		expect(setPrTargetBranch).toHaveBeenCalledWith('develop');
		expect(screen.queryByRole('button', { name: 'release' })).not.toBeInTheDocument();
	});

	it('keeps the base directory unchanged when local folder browsing is cancelled', async () => {
		const setWorktreeBaseDir = vi.fn();
		mocks.selectFolder.mockResolvedValueOnce(null);

		renderSection({
			worktreeEnabled: true,
			setWorktreeBaseDir,
		});

		fireEvent.click(screen.getByTitle('Browse for directory'));

		await waitFor(() => {
			expect(mocks.selectFolder).toHaveBeenCalled();
		});
		expect(setWorktreeBaseDir).not.toHaveBeenCalled();
	});

	it('renders remote browse guard and unauthenticated PR warning', () => {
		renderSection({
			worktreeEnabled: true,
			sshRemoteId: 'remote-1',
			ghCliStatus: { installed: true, authenticated: false },
		});

		expect(screen.getByPlaceholderText('/home/user/worktrees')).toBeInTheDocument();
		expect(
			screen.getByText('Path on the remote server where worktrees will be created')
		).toBeInTheDocument();

		const browseButton = screen.getByTitle('Browse is not available for remote sessions');
		expect(browseButton).toBeDisabled();
		fireEvent.click(browseButton);
		expect(mocks.selectFolder).not.toHaveBeenCalled();

		expect(screen.getByText('gh auth login')).toBeInTheDocument();
		expect(screen.queryByText('Create PR on completion')).not.toBeInTheDocument();
	});

	it('renders validation checking, existing, mismatch, uncommitted, and wrong-repo states', () => {
		const { rerender } = renderSection({
			worktreeEnabled: true,
			worktreeValidation: { ...idleValidation, checking: true },
		});
		expect(screen.getByText('Checking worktree...')).toBeInTheDocument();

		rerender(
			<GitWorktreeSection
				{...createProps()}
				worktreeEnabled
				worktreeValidation={{
					...idleValidation,
					exists: true,
					isWorktree: true,
					currentBranch: 'feature/test',
					sameRepo: true,
				}}
			/>
		);
		expect(screen.getByText('Existing worktree on branch "feature/test"')).toBeInTheDocument();

		rerender(
			<GitWorktreeSection
				{...createProps()}
				worktreeEnabled
				branchName="feature/new"
				worktreeValidation={{
					...idleValidation,
					exists: true,
					isWorktree: true,
					currentBranch: 'old-branch',
					branchMismatch: true,
					sameRepo: true,
				}}
			/>
		);
		expect(screen.getByText('Worktree exists with branch "old-branch"')).toBeInTheDocument();
		expect(screen.getByText('Will checkout to "feature/new"')).toBeInTheDocument();

		rerender(
			<GitWorktreeSection
				{...createProps()}
				worktreeEnabled
				branchName="feature/new"
				worktreeValidation={{
					...idleValidation,
					exists: true,
					isWorktree: true,
					currentBranch: 'old-branch',
					branchMismatch: true,
					sameRepo: true,
					hasUncommittedChanges: true,
				}}
			/>
		);
		expect(screen.getByText('(uncommitted changes will block checkout)')).toBeInTheDocument();

		rerender(
			<GitWorktreeSection
				{...createProps()}
				worktreeEnabled
				worktreeValidation={{
					...idleValidation,
					exists: true,
					isWorktree: true,
					sameRepo: false,
				}}
			/>
		);
		expect(
			screen.getByText(/This path contains a worktree for a different repository/)
		).toBeInTheDocument();
	});

	it('keeps branch dropdown closed when there are no available branches and closes on outside click', () => {
		const { rerender } = renderSection({
			worktreeEnabled: true,
			availableBranches: [],
		});

		fireEvent.click(screen.getByTitle('Select target branch for PR'));
		expect(screen.queryByRole('button', { name: 'develop' })).not.toBeInTheDocument();

		rerender(
			<GitWorktreeSection
				{...createProps()}
				worktreeEnabled
				availableBranches={['main', 'develop']}
			/>
		);
		expect(screen.getByRole('button', { name: 'develop' })).toBeInTheDocument();

		fireEvent.mouseDown(document.body);
		expect(screen.queryByRole('button', { name: 'develop' })).not.toBeInTheDocument();
	});
});
