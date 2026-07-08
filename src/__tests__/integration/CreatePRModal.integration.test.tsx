import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CreatePRModal } from '../../renderer/components/CreatePRModal';
import type { GhCliStatus, Theme } from '../../renderer/types';

const mocks = vi.hoisted(() => ({
	registerLayer: vi.fn(),
	unregisterLayer: vi.fn(),
	updateLayerHandler: vi.fn(),
	checkGhCli: vi.fn(),
	status: vi.fn(),
	createPR: vi.fn(),
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

function installMaestroApi() {
	window.maestro.git.checkGhCli = mocks.checkGhCli;
	window.maestro.git.status = mocks.status;
	window.maestro.git.createPR = mocks.createPR;
	window.maestro.shell.openExternal = mocks.openExternal;
}

function renderModal(overrides: Partial<React.ComponentProps<typeof CreatePRModal>> = {}) {
	const props: React.ComponentProps<typeof CreatePRModal> = {
		isOpen: true,
		onClose: vi.fn(),
		theme,
		worktreePath: '/repo/worktrees/feature',
		worktreeBranch: 'feat-add-login',
		availableBranches: ['develop', 'main'],
		onPRCreated: vi.fn(),
		...overrides,
	};

	return {
		...render(<CreatePRModal {...props} />),
		props,
	};
}

async function waitForAuthenticatedForm() {
	await waitFor(() => {
		expect(screen.getByPlaceholderText('PR title...')).toBeInTheDocument();
	});
}

function setGhStatus(status: GhCliStatus) {
	mocks.checkGhCli.mockResolvedValue(status);
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

describe('CreatePRModal', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.registerLayer.mockReturnValue('create-pr-layer');
		setGhStatus({ installed: true, authenticated: true });
		mocks.status.mockResolvedValue({ stdout: '' });
		mocks.createPR.mockResolvedValue({
			success: true,
			prUrl: 'https://github.com/acme/maestro/pull/42',
		});
		installMaestroApi();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('does not render or register a layer when closed', () => {
		renderModal({ isOpen: false });

		expect(screen.queryByText('Create Pull Request')).not.toBeInTheDocument();
		expect(mocks.registerLayer).not.toHaveBeenCalled();
	});

	it('registers with the layer stack, shows loading, initializes title, target, and plural change warning', async () => {
		let resolveGh: (status: GhCliStatus) => void = () => {};
		mocks.checkGhCli.mockReturnValue(
			new Promise<GhCliStatus>((resolve) => {
				resolveGh = resolve;
			})
		);
		mocks.status.mockResolvedValue({ stdout: ' M src/app.ts\n?? src/new.ts\n' });
		const { props, unmount } = renderModal();

		expect(screen.getByText('Checking GitHub CLI...')).toBeInTheDocument();
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

		resolveGh({ installed: true, authenticated: true });
		await waitForAuthenticatedForm();

		expect(screen.getByPlaceholderText('PR title...')).toHaveValue('feat: add login');
		expect(screen.getByRole('combobox')).toHaveValue('main');
		expect(screen.getByText('2 uncommitted changes')).toBeInTheDocument();
		expect(mocks.checkGhCli).toHaveBeenCalled();
		expect(mocks.status).toHaveBeenCalledWith('/repo/worktrees/feature');

		unmount();
		expect(mocks.unregisterLayer).toHaveBeenCalledWith('create-pr-layer');
	});

	it('falls back to master or the first available target branch', async () => {
		const { unmount } = renderModal({ availableBranches: ['master', 'release'] });
		await waitForAuthenticatedForm();
		expect(screen.getByRole('combobox')).toHaveValue('master');
		unmount();

		renderModal({ availableBranches: ['release'] });
		await waitForAuthenticatedForm();
		expect(screen.getByRole('combobox')).toHaveValue('release');
	});

	it('uses the raw branch name when title normalization is empty and handles no target branches', async () => {
		renderModal({ worktreeBranch: '--__', availableBranches: [] });
		await waitForAuthenticatedForm();

		expect(screen.getByPlaceholderText('PR title...')).toHaveValue('--__');
		expect(screen.getByRole('combobox').querySelectorAll('option')).toHaveLength(0);
	});

	it('shows GitHub CLI install and auth guidance states', async () => {
		setGhStatus({ installed: false, authenticated: false });
		const { unmount } = renderModal();

		await waitFor(() => {
			expect(screen.getByText('GitHub CLI not installed')).toBeInTheDocument();
		});
		fireEvent.click(screen.getByRole('button', { name: 'GitHub CLI' }));
		expect(mocks.openExternal).toHaveBeenCalledWith('https://cli.github.com');
		unmount();

		setGhStatus({ installed: true, authenticated: false });
		renderModal();
		await waitFor(() => {
			expect(screen.getByText('GitHub CLI not authenticated')).toBeInTheDocument();
		});
		expect(screen.getByText('gh auth login')).toBeInTheDocument();
	});

	it('does not create a pull request when the defensive auth guard blocks submission', async () => {
		setGhStatus({ installed: true, authenticated: false });
		renderModal();

		await waitFor(() => {
			expect(screen.getByText('GitHub CLI not authenticated')).toBeInTheDocument();
		});

		const createButton = screen.getByRole('button', { name: /Create PR/i });
		expect(createButton).toBeDisabled();
		// Native click events are suppressed while disabled; invoke the handler to prove the guard.
		invokeReactClickHandler(createButton);
		expect(mocks.createPR).not.toHaveBeenCalled();
	});

	it('treats failed status checks as clean and failed gh checks as unavailable', async () => {
		mocks.checkGhCli.mockRejectedValue(new Error('gh missing'));
		mocks.status.mockRejectedValue(new Error('status failed'));

		renderModal();

		await waitFor(() => {
			expect(screen.getByText('GitHub CLI not installed')).toBeInTheDocument();
		});
		expect(screen.queryByText(/uncommitted change/)).not.toBeInTheDocument();
	});

	it('creates a pull request with edited form values and reports details', async () => {
		const { props } = renderModal({
			worktreeBranch: 'fix-critical-bug',
			availableBranches: ['main', 'release'],
		});
		await waitForAuthenticatedForm();

		fireEvent.change(screen.getByRole('combobox'), { target: { value: 'release' } });
		fireEvent.change(screen.getByPlaceholderText('PR title...'), {
			target: { value: 'Fix critical bug' },
		});
		fireEvent.change(screen.getByPlaceholderText('Add a description...'), {
			target: { value: 'Detailed release notes' },
		});
		fireEvent.click(screen.getByRole('button', { name: /Create PR/i }));

		await waitFor(() => {
			expect(mocks.createPR).toHaveBeenCalledWith(
				'/repo/worktrees/feature',
				'release',
				'Fix critical bug',
				'Detailed release notes'
			);
			expect(props.onPRCreated).toHaveBeenCalledWith({
				url: 'https://github.com/acme/maestro/pull/42',
				title: 'Fix critical bug',
				description: 'Detailed release notes',
				sourceBranch: 'fix-critical-bug',
				targetBranch: 'release',
			});
			expect(props.onClose).toHaveBeenCalled();
		});
	});

	it('keeps create disabled without a title and shows singular uncommitted-change copy', async () => {
		mocks.status.mockResolvedValue({ stdout: ' M src/app.ts\n' });
		renderModal();
		await waitForAuthenticatedForm();

		expect(screen.getByText('1 uncommitted change')).toBeInTheDocument();
		fireEvent.change(screen.getByPlaceholderText('PR title...'), { target: { value: '   ' } });
		expect(screen.getByRole('button', { name: /Create PR/i })).toBeDisabled();
	});

	it('renders PR and generic links in create failures and opens them externally', async () => {
		mocks.createPR.mockResolvedValue({
			success: false,
			error:
				'PR already exists: https://github.com/acme/maestro/pull/99 See https://example.com/help',
		});
		renderModal();
		await waitForAuthenticatedForm();

		fireEvent.click(screen.getByRole('button', { name: /Create PR/i }));

		await waitFor(() => {
			expect(screen.getByRole('button', { name: /PR #99/i })).toBeInTheDocument();
			expect(screen.getByRole('button', { name: /View PR/i })).toBeInTheDocument();
		});
		fireEvent.click(screen.getByRole('button', { name: /PR #99/i }));
		fireEvent.click(screen.getByRole('button', { name: /View PR/i }));
		expect(mocks.openExternal).toHaveBeenCalledWith('https://github.com/acme/maestro/pull/99');
		expect(mocks.openExternal).toHaveBeenCalledWith('https://example.com/help');
	});

	it('shows default failure messages for unsuccessful and thrown PR creation', async () => {
		mocks.createPR.mockResolvedValueOnce({ success: false });
		const { unmount } = renderModal();
		await waitForAuthenticatedForm();

		fireEvent.click(screen.getByRole('button', { name: /Create PR/i }));
		await waitFor(() => {
			expect(screen.getByText('Failed to create PR')).toBeInTheDocument();
		});
		unmount();

		mocks.createPR.mockRejectedValueOnce(new Error('network down'));
		renderModal();
		await waitForAuthenticatedForm();

		fireEvent.click(screen.getByRole('button', { name: /Create PR/i }));
		await waitFor(() => {
			expect(screen.getByText('network down')).toBeInTheDocument();
		});
	});

	it('shows a fallback error when PR creation rejects with a non-error value', async () => {
		mocks.createPR.mockRejectedValue('boom');
		renderModal();
		await waitForAuthenticatedForm();

		fireEvent.click(screen.getByRole('button', { name: /Create PR/i }));
		await waitFor(() => {
			expect(screen.getByText('Failed to create PR')).toBeInTheDocument();
		});
	});
});
