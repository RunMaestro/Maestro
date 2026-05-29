import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WorktreeConfigModal } from '../../renderer/components/WorktreeConfigModal';
import { LayerStackProvider } from '../../renderer/contexts/LayerStackContext';
import type { Session, Theme } from '../../renderer/types';

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
		accentForeground: '#ffffff',
		border: '#404040',
		error: '#f14c4c',
		warning: '#cca700',
		success: '#89d185',
		info: '#3794ff',
		textInverse: '#000000',
	},
};

const createSession = (overrides: Partial<Session> = {}): Session => ({
	id: 'session-1',
	name: 'Test Session',
	toolType: 'claude-code',
	state: 'idle',
	cwd: '/repo/project',
	fullPath: '/repo/project',
	projectRoot: '/repo/project',
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
	activeTimeMs: 0,
	executionQueue: [],
	aiTabs: [],
	activeTabId: 'tab-1',
	closedTabHistory: [],
	...overrides,
});

describe('WorktreeConfigModal', () => {
	const onClose = vi.fn();
	const onSaveConfig = vi.fn();
	const onCreateWorktree = vi.fn();
	const onDisableConfig = vi.fn();

	const renderModal = (
		overrides: Partial<React.ComponentProps<typeof WorktreeConfigModal>> = {}
	) => {
		return render(
			<LayerStackProvider>
				<WorktreeConfigModal
					isOpen={true}
					onClose={onClose}
					theme={testTheme}
					session={createSession()}
					onSaveConfig={onSaveConfig}
					onCreateWorktree={onCreateWorktree}
					onDisableConfig={onDisableConfig}
					{...overrides}
				/>
			</LayerStackProvider>
		);
	};

	const getBasePathInput = () => screen.getAllByRole('textbox')[0] as HTMLInputElement;
	const getBranchInput = () => screen.getByPlaceholderText('feature-xyz') as HTMLInputElement;
	const getWatchToggle = () =>
		screen
			.getByText('Watch for new worktrees')
			.parentElement?.parentElement?.querySelector('button') as HTMLButtonElement;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(window.maestro.git.checkGhCli).mockResolvedValue({
			installed: true,
			authenticated: true,
		});
		vi.mocked(window.maestro.fs.readDir).mockResolvedValue([]);
		vi.mocked(window.maestro.dialog.selectFolder).mockResolvedValue(null);
		vi.mocked(window.maestro.shell.openExternal).mockResolvedValue(undefined);
		onCreateWorktree.mockResolvedValue(undefined);
	});

	it('does not render or check GitHub CLI status when closed', () => {
		renderModal({ isOpen: false });

		expect(screen.queryByText('Worktree Configuration')).not.toBeInTheDocument();
		expect(window.maestro.git.checkGhCli).not.toHaveBeenCalled();
	});

	it('loads defaults from the session and closes through the layer stack Escape handler', async () => {
		renderModal();

		expect(await screen.findByText('Worktree Configuration')).toBeInTheDocument();
		expect(getBasePathInput()).toHaveValue('/repo');

		fireEvent.keyDown(window, { key: 'Escape' });

		await waitFor(() => {
			expect(onClose).toHaveBeenCalled();
		});
	});

	it('shows the GitHub CLI warning and opens the install page when gh is missing', async () => {
		vi.mocked(window.maestro.git.checkGhCli).mockResolvedValue({
			installed: false,
			authenticated: false,
		});

		renderModal();

		expect(await screen.findByText('GitHub CLI recommended')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'GitHub CLI' }));

		expect(window.maestro.shell.openExternal).toHaveBeenCalledWith('https://cli.github.com');
	});

	it('falls back to the GitHub CLI warning when gh status cannot be checked', async () => {
		vi.mocked(window.maestro.git.checkGhCli).mockRejectedValue(new Error('gh failed'));

		renderModal();

		expect(await screen.findByText('GitHub CLI recommended')).toBeInTheDocument();
	});

	it('browses for a local base directory', async () => {
		vi.mocked(window.maestro.dialog.selectFolder).mockResolvedValue('/chosen/worktrees');
		renderModal();

		fireEvent.click(screen.getByRole('button', { name: /Browse/i }));

		await waitFor(() => {
			expect(getBasePathInput()).toHaveValue('/chosen/worktrees');
		});
	});

	it('keeps the existing base directory when local browsing is canceled', async () => {
		renderModal();

		fireEvent.click(screen.getByRole('button', { name: /Browse/i }));

		await waitFor(() => {
			expect(window.maestro.dialog.selectFolder).toHaveBeenCalled();
		});
		expect(getBasePathInput()).toHaveValue('/repo');
	});

	it('saves a validated local config with the current watch setting', async () => {
		renderModal();

		fireEvent.change(getBasePathInput(), { target: { value: ' /tmp/worktrees ' } });
		fireEvent.click(getWatchToggle());
		fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));

		await waitFor(() => {
			expect(window.maestro.fs.readDir).toHaveBeenCalledWith('/tmp/worktrees', undefined);
			expect(onSaveConfig).toHaveBeenCalledWith({
				basePath: '/tmp/worktrees',
				watchEnabled: false,
			});
			expect(onClose).toHaveBeenCalled();
		});
	});

	it('reports save failures from the config callback and leaves the modal open', async () => {
		onSaveConfig.mockImplementationOnce(() => {
			throw new Error('save failed');
		});
		renderModal();

		fireEvent.change(getBasePathInput(), { target: { value: '/tmp/worktrees' } });
		fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));

		expect(await screen.findByText('save failed')).toBeInTheDocument();
		expect(onClose).not.toHaveBeenCalled();
	});

	it('uses the fallback validation error for non-Error save failures', async () => {
		onSaveConfig.mockImplementationOnce(() => {
			throw 'save failed';
		});
		renderModal();

		fireEvent.change(getBasePathInput(), { target: { value: '/tmp/worktrees' } });
		fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));

		expect(await screen.findByText('Failed to validate directory')).toBeInTheDocument();
		expect(onClose).not.toHaveBeenCalled();
	});

	it('requires a base directory before saving', async () => {
		renderModal();

		fireEvent.change(getBasePathInput(), { target: { value: '   ' } });
		fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));

		expect(await screen.findByText('Please select a worktree directory')).toBeInTheDocument();
		expect(window.maestro.fs.readDir).not.toHaveBeenCalled();
		expect(onSaveConfig).not.toHaveBeenCalled();
	});

	it('reports a missing local directory without saving', async () => {
		vi.mocked(window.maestro.fs.readDir).mockRejectedValue(new Error('missing'));
		renderModal();

		fireEvent.change(getBasePathInput(), { target: { value: '/missing/worktrees' } });
		fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));

		expect(
			await screen.findByText('Directory not found. Please select a valid directory.')
		).toBeInTheDocument();
		expect(onSaveConfig).not.toHaveBeenCalled();
	});

	it('uses the remote id for remote validation and disables local browsing', async () => {
		const remoteSession = createSession({
			sshRemoteId: 'remote-1',
			worktreeConfig: {
				basePath: '/remote/worktrees',
				watchEnabled: true,
			},
		});
		renderModal({ session: remoteSession });

		expect(await screen.findByText(/Remote session/)).toBeInTheDocument();
		expect(screen.getByRole('button', { name: /Browse/i })).toBeDisabled();

		fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));

		await waitFor(() => {
			expect(window.maestro.fs.readDir).toHaveBeenCalledWith('/remote/worktrees', 'remote-1');
			expect(onSaveConfig).toHaveBeenCalledWith({
				basePath: '/remote/worktrees',
				watchEnabled: true,
			});
		});
		expect(window.maestro.dialog.selectFolder).not.toHaveBeenCalled();
	});

	it('uses session SSH config fallback and reports missing remote directories', async () => {
		vi.mocked(window.maestro.fs.readDir).mockRejectedValue(new Error('missing'));
		const remoteSession = createSession({
			sessionSshRemoteConfig: {
				enabled: true,
				remoteId: 'configured-remote',
			},
			worktreeConfig: {
				basePath: '/remote/missing',
				watchEnabled: false,
			},
		});
		renderModal({ session: remoteSession });

		fireEvent.click(screen.getByRole('button', { name: 'Save Configuration' }));

		expect(
			await screen.findByText('Directory not found on remote server. Please enter a valid path.')
		).toBeInTheDocument();
		expect(window.maestro.fs.readDir).toHaveBeenCalledWith('/remote/missing', 'configured-remote');
		expect(onSaveConfig).not.toHaveBeenCalled();
	});

	it('creates a worktree after saving the current config', async () => {
		renderModal();

		fireEvent.change(getBranchInput(), { target: { value: ' feature/demo ' } });
		fireEvent.click(screen.getByRole('button', { name: /Create/i }));

		await waitFor(() => {
			expect(onSaveConfig).toHaveBeenCalledWith({
				basePath: '/repo',
				watchEnabled: true,
			});
			expect(onCreateWorktree).toHaveBeenCalledWith('feature/demo', '/repo');
			expect(getBranchInput()).toHaveValue('');
		});
	});

	it('requires a base directory before creating a worktree', async () => {
		renderModal();

		fireEvent.change(getBasePathInput(), { target: { value: '   ' } });
		fireEvent.change(getBranchInput(), { target: { value: 'feature/missing-base' } });
		fireEvent.click(screen.getByRole('button', { name: /Create/i }));

		expect(await screen.findByText('Please select a worktree directory first')).toBeInTheDocument();
		expect(onSaveConfig).not.toHaveBeenCalled();
		expect(onCreateWorktree).not.toHaveBeenCalled();
	});

	it('creates a worktree from the branch input Enter key', async () => {
		renderModal();

		fireEvent.change(getBranchInput(), { target: { value: 'feature/enter' } });
		fireEvent.keyDown(getBranchInput(), { key: 'Enter' });

		await waitFor(() => {
			expect(onCreateWorktree).toHaveBeenCalledWith('feature/enter', '/repo');
		});
	});

	it('does not create a worktree when Enter is pressed without a branch name', async () => {
		renderModal();

		await waitFor(() => {
			expect(window.maestro.git.checkGhCli).toHaveBeenCalled();
		});

		fireEvent.keyDown(getBranchInput(), { key: 'Enter' });

		expect(onSaveConfig).not.toHaveBeenCalled();
		expect(onCreateWorktree).not.toHaveBeenCalled();
	});

	it('reports create failures and leaves the modal open', async () => {
		onCreateWorktree.mockRejectedValueOnce(new Error('create failed'));
		renderModal();

		fireEvent.change(getBranchInput(), { target: { value: 'feature/fail' } });
		fireEvent.click(screen.getByRole('button', { name: /Create/i }));

		expect(await screen.findByText('create failed')).toBeInTheDocument();
		expect(onClose).not.toHaveBeenCalled();
	});

	it('uses the fallback create error for non-Error failures', async () => {
		onCreateWorktree.mockRejectedValueOnce('create failed');
		renderModal();

		fireEvent.change(getBranchInput(), { target: { value: 'feature/string-fail' } });
		fireEvent.click(screen.getByRole('button', { name: /Create/i }));

		expect(await screen.findByText('Failed to create worktree')).toBeInTheDocument();
		expect(onClose).not.toHaveBeenCalled();
	});

	it('disables and closes an existing worktree config', async () => {
		renderModal({
			session: createSession({
				worktreeConfig: {
					basePath: '/repo/worktrees',
					watchEnabled: false,
				},
			}),
		});

		await waitFor(() => {
			expect(window.maestro.git.checkGhCli).toHaveBeenCalled();
		});

		fireEvent.click(screen.getByRole('button', { name: 'Disable' }));

		expect(onDisableConfig).toHaveBeenCalled();
		expect(onClose).toHaveBeenCalled();
	});

	it('keeps disable unavailable before a worktree config exists', async () => {
		renderModal();

		await waitFor(() => {
			expect(window.maestro.git.checkGhCli).toHaveBeenCalled();
		});

		expect(screen.getByRole('button', { name: 'Disable' })).toBeDisabled();
	});
});
