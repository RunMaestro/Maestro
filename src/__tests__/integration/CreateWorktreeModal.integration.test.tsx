import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CreateWorktreeModal } from '../../renderer/components/CreateWorktreeModal';
import type { GhCliStatus, Session, Theme } from '../../renderer/types';

const mocks = vi.hoisted(() => ({
	registerLayer: vi.fn(),
	unregisterLayer: vi.fn(),
	updateLayerHandler: vi.fn(),
	checkGhCli: vi.fn(),
	openExternal: vi.fn(),
}));

vi.mock('../../renderer/contexts/LayerStackContext', () => ({
	useLayerStack: () => ({
		registerLayer: mocks.registerLayer,
		unregisterLayer: mocks.unregisterLayer,
		updateLayerHandler: mocks.updateLayerHandler,
	}),
}));

const theme: Theme = {
	id: 'test-theme',
	name: 'Test Theme',
	mode: 'dark',
	colors: {
		bgMain: '#111111',
		bgSidebar: '#222222',
		bgActivity: '#333333',
		textMain: '#ffffff',
		textDim: '#999999',
		accent: '#00aaff',
		accentForeground: '#ffffff',
		border: '#444444',
		error: '#ff5555',
		warning: '#ffaa00',
	},
};

function createSession(overrides: Partial<Session> = {}): Session {
	return {
		id: 'session-1',
		name: 'Parent Session',
		toolType: 'claude-code',
		state: 'idle',
		cwd: '/repo',
		fullPath: '/repo',
		projectRoot: '/repo',
		aiLogs: [],
		shellLogs: [],
		workLog: [],
		contextUsage: 0,
		inputMode: 'ai',
		aiPid: 0,
		terminalPid: 0,
		port: 0,
		isLive: false,
		changedFiles: [],
		isGitRepo: true,
		fileTree: [],
		fileExplorerExpanded: [],
		fileExplorerScrollPos: 0,
		executionQueue: [],
		activeTimeMs: 0,
		aiTabs: [],
		activeTabId: '',
		closedTabHistory: [],
		filePreviewTabs: [],
		activeFileTabId: null,
		unifiedTabOrder: [],
		unifiedClosedTabHistory: [],
		...overrides,
	} as Session;
}

function installMaestroApi() {
	window.maestro.git.checkGhCli = mocks.checkGhCli;
	window.maestro.shell.openExternal = mocks.openExternal;
}

function renderModal(overrides: Partial<React.ComponentProps<typeof CreateWorktreeModal>> = {}) {
	const props: React.ComponentProps<typeof CreateWorktreeModal> = {
		isOpen: true,
		onClose: vi.fn(),
		theme,
		session: createSession({
			worktreeConfig: { basePath: '/repo-worktrees', watchEnabled: true },
		}),
		onCreateWorktree: vi.fn().mockResolvedValue(undefined),
		...overrides,
	};

	return {
		...render(<CreateWorktreeModal {...props} />),
		props,
	};
}

function setGhStatus(status: GhCliStatus) {
	mocks.checkGhCli.mockResolvedValue(status);
}

async function waitForInput() {
	await waitFor(() => {
		expect(screen.getByPlaceholderText('feature-xyz')).toBeInTheDocument();
	});
}

function invokeReactClickHandler(button: HTMLElement) {
	const reactPropsKey = Object.getOwnPropertyNames(button).find((key) =>
		key.startsWith('__reactProps$')
	);
	expect(reactPropsKey).toBeDefined();

	const reactProps = (button as unknown as Record<string, { onClick?: () => void }>)[
		reactPropsKey as string
	];
	expect(reactProps.onClick).toEqual(expect.any(Function));
	reactProps.onClick?.();
}

describe('CreateWorktreeModal', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useRealTimers();
		mocks.registerLayer.mockReturnValue('create-worktree-layer');
		setGhStatus({ installed: true, authenticated: true });
		installMaestroApi();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it('does not render or register a layer when closed', () => {
		renderModal({ isOpen: false });

		expect(screen.queryByText('Create New Worktree')).not.toBeInTheDocument();
		expect(mocks.registerLayer).not.toHaveBeenCalled();
	});

	it('registers with the layer stack, focuses the branch input, and shows configured path preview', async () => {
		const { props, unmount } = renderModal();

		expect(mocks.registerLayer).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'modal',
				blocksLowerLayers: true,
				capturesFocus: true,
				focusTrap: 'lenient',
				onEscape: expect.any(Function),
			})
		);
		mocks.registerLayer.mock.calls[0][0].onEscape();
		expect(props.onClose).toHaveBeenCalled();

		await waitForInput();
		expect(screen.getByText('Will be created at: /repo-worktrees/...')).toBeInTheDocument();

		fireEvent.change(screen.getByPlaceholderText('feature-xyz'), {
			target: { value: 'feature/login' },
		});
		expect(
			screen.getByText('Will be created at: /repo-worktrees/feature/login')
		).toBeInTheDocument();

		await waitFor(() => {
			expect(screen.getByPlaceholderText('feature-xyz')).toHaveFocus();
		});

		unmount();
		expect(mocks.unregisterLayer).toHaveBeenCalledWith('create-worktree-layer');
	});

	it('shows GH CLI and missing worktree directory warnings and opens the installer link', async () => {
		setGhStatus({ installed: false, authenticated: false });
		renderModal({ session: createSession({ worktreeConfig: undefined }) });

		await waitFor(() => {
			expect(screen.getByText('GitHub CLI recommended')).toBeInTheDocument();
		});
		expect(screen.getByText('No worktree directory configured')).toBeInTheDocument();
		expect(screen.queryByText(/Will be created at:/)).not.toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'GitHub CLI' }));
		expect(mocks.openExternal).toHaveBeenCalledWith('https://cli.github.com');
	});

	it('treats failed GH CLI checks as not installed', async () => {
		mocks.checkGhCli.mockRejectedValue(new Error('gh unavailable'));
		renderModal();

		await waitFor(() => {
			expect(screen.getByText('GitHub CLI recommended')).toBeInTheDocument();
		});
	});

	it('validates blank branch names and sanitizes branch input before creation', async () => {
		const { props } = renderModal();
		await waitForInput();

		const createButton = screen.getByRole('button', { name: 'Create' });
		expect(createButton).toBeDisabled();
		await act(async () => {
			invokeReactClickHandler(createButton);
		});
		expect(await screen.findByText('Please enter a valid branch name')).toBeInTheDocument();
		expect(props.onCreateWorktree).not.toHaveBeenCalled();

		fireEvent.change(screen.getByPlaceholderText('feature-xyz'), {
			target: { value: 'feature with spaces!' },
		});
		expect(screen.getByPlaceholderText('feature-xyz')).toHaveValue('feature-with-spaces!');
		expect(props.onCreateWorktree).not.toHaveBeenCalled();
	});

	it('creates a sanitized branch from the selected base, disables controls while pending, and closes on success', async () => {
		let resolveCreate: () => void = () => {};
		const onCreateWorktree = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					resolveCreate = resolve;
				})
		);
		const { props } = renderModal({ onCreateWorktree });
		await waitForInput();

		fireEvent.change(screen.getByPlaceholderText('feature-xyz'), {
			target: { value: '  feature/new-ui  ' },
		});
		fireEvent.click(screen.getByRole('button', { name: 'Create' }));

		await waitFor(() => {
			expect(onCreateWorktree).toHaveBeenCalledWith('feature/new-ui-', 'main');
			expect(screen.getByText('Creating...').closest('button')).toBeDisabled();
		});
		expect(screen.getByPlaceholderText('feature-xyz')).toBeDisabled();
		expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();

		fireEvent.keyDown(screen.getByPlaceholderText('feature-xyz'), { key: 'Enter' });
		expect(onCreateWorktree).toHaveBeenCalledTimes(1);

		resolveCreate();
		await waitFor(() => {
			expect(props.onClose).toHaveBeenCalled();
		});
	});

	it('creates from Enter only when the branch name is valid and not already creating', async () => {
		const { props } = renderModal();
		await waitForInput();

		fireEvent.keyDown(screen.getByPlaceholderText('feature-xyz'), { key: 'Enter' });
		fireEvent.change(screen.getByPlaceholderText('feature-xyz'), {
			target: { value: 'feature/key-submit' },
		});
		fireEvent.keyDown(screen.getByPlaceholderText('feature-xyz'), { key: 'Escape' });
		expect(props.onCreateWorktree).not.toHaveBeenCalled();

		fireEvent.keyDown(screen.getByPlaceholderText('feature-xyz'), { key: 'Enter' });

		await waitFor(() => {
			expect(props.onCreateWorktree).toHaveBeenCalledWith('feature/key-submit', 'main');
			expect(props.onClose).toHaveBeenCalled();
		});
	});

	it('shows explicit and fallback creation errors and keeps the modal open', async () => {
		const onCreateWorktree = vi.fn().mockRejectedValueOnce(new Error('branch already exists'));
		const { props, unmount } = renderModal({ onCreateWorktree });
		await waitForInput();

		fireEvent.change(screen.getByPlaceholderText('feature-xyz'), {
			target: { value: 'feature/duplicate' },
		});
		fireEvent.click(screen.getByRole('button', { name: 'Create' }));

		await waitFor(() => {
			expect(screen.getByText('branch already exists')).toBeInTheDocument();
		});
		expect(props.onClose).not.toHaveBeenCalled();
		unmount();

		const fallbackCreate = vi.fn().mockRejectedValue('boom');
		renderModal({ onCreateWorktree: fallbackCreate });
		await waitForInput();
		fireEvent.change(screen.getByPlaceholderText('feature-xyz'), {
			target: { value: 'feature/fallback' },
		});
		fireEvent.click(screen.getByRole('button', { name: 'Create' }));

		await waitFor(() => {
			expect(screen.getByText('Failed to create worktree')).toBeInTheDocument();
		});
	});

	it('closes from backdrop and close controls', async () => {
		const { props, unmount } = renderModal();
		await waitForInput();

		fireEvent.click(screen.getByRole('button', { name: 'Close' }));
		expect(props.onClose).toHaveBeenCalledTimes(1);
		unmount();

		const second = renderModal();
		await waitForInput();
		fireEvent.click(document.querySelector('.absolute.inset-0.bg-black\\/60') as HTMLElement);
		expect(second.props.onClose).toHaveBeenCalledTimes(1);
	});
});
