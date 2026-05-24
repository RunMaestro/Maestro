/**
 * DirectorySelectionScreen.test.tsx
 *
 * Rendered behavior coverage for wizard project directory selection.
 */

import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DirectorySelectionScreen } from '../../../../../renderer/components/Wizard/screens/DirectorySelectionScreen';
import {
	WizardProvider,
	useWizard,
	type WizardState,
} from '../../../../../renderer/components/Wizard/WizardContext';
import { LayerStackProvider } from '../../../../../renderer/contexts/LayerStackContext';
import type { Theme } from '../../../../../renderer/types';

const mocks = vi.hoisted(() => ({
	agentsGet: vi.fn(),
	readDir: vi.fn(),
	isRepo: vi.fn(),
	selectFolder: vi.fn(),
	listDocs: vi.fn(),
	deleteFolder: vi.fn(),
	getConfigs: vi.fn(),
}));

const mockTheme: Theme = {
	id: 'test-dark',
	name: 'Test Dark',
	mode: 'dark',
	colors: {
		bgMain: '#1a1a1a',
		bgSidebar: '#252525',
		bgActivity: '#2a2a2a',
		border: '#333333',
		textMain: '#ffffff',
		textDim: '#888888',
		textFaint: '#555555',
		accent: '#4a9eff',
		accentForeground: '#ffffff',
		buttonBg: '#333333',
		buttonHover: '#444444',
		headerBg: '#202020',
		scrollbarTrack: '#1a1a1a',
		scrollbarThumb: '#444444',
		success: '#22c55e',
		warning: '#f59e0b',
		error: '#ef4444',
	},
};

function DirectoryHarness({ initialState = {} }: { initialState?: Partial<WizardState> }) {
	const wizard = useWizard();
	const [ready, setReady] = React.useState(false);

	React.useEffect(() => {
		wizard.restoreState({
			currentStep: 'directory-selection',
			isOpen: true,
			selectedAgent: 'codex',
			agentName: 'Launch Project',
			directoryPath: '',
			isGitRepo: false,
			directoryError: null,
			hasExistingAutoRunDocs: false,
			existingDocsCount: 0,
			existingDocsChoice: null,
			sessionSshRemoteConfig: undefined,
			...initialState,
		});
		setReady(true);
	}, []);

	return (
		<>
			<div data-testid="current-step">{wizard.state.currentStep}</div>
			<div data-testid="directory-path">{wizard.state.directoryPath}</div>
			<div data-testid="directory-error">{wizard.state.directoryError ?? ''}</div>
			<div data-testid="existing-docs-choice">{wizard.state.existingDocsChoice ?? ''}</div>
			<div data-testid="existing-docs-count">{wizard.state.existingDocsCount}</div>
			{ready && <DirectorySelectionScreen theme={mockTheme} />}
		</>
	);
}

function renderDirectory(initialState?: Partial<WizardState>) {
	return render(
		<LayerStackProvider>
			<WizardProvider>
				<DirectoryHarness initialState={initialState} />
			</WizardProvider>
		</LayerStackProvider>
	);
}

describe('DirectorySelectionScreen', () => {
	beforeEach(() => {
		mocks.agentsGet.mockReset();
		mocks.readDir.mockReset();
		mocks.isRepo.mockReset();
		mocks.selectFolder.mockReset();
		mocks.listDocs.mockReset();
		mocks.deleteFolder.mockReset();
		mocks.getConfigs.mockReset();

		mocks.agentsGet.mockResolvedValue({
			id: 'codex',
			name: 'Codex',
			binaryName: 'codex',
			args: [],
		});
		mocks.readDir.mockResolvedValue([{ name: 'README.md', isDirectory: false }]);
		mocks.isRepo.mockResolvedValue(true);
		mocks.selectFolder.mockResolvedValue(null);
		mocks.listDocs.mockResolvedValue({ success: true, files: [] });
		mocks.deleteFolder.mockResolvedValue({ success: true });
		mocks.getConfigs.mockResolvedValue({ success: true, configs: [] });

		(window as any).maestro = {
			agents: {
				get: mocks.agentsGet,
			},
			fs: {
				readDir: mocks.readDir,
			},
			git: {
				isRepo: mocks.isRepo,
			},
			dialog: {
				selectFolder: mocks.selectFolder,
			},
			autorun: {
				listDocs: mocks.listDocs,
				deleteFolder: mocks.deleteFolder,
			},
			sshRemote: {
				getConfigs: mocks.getConfigs,
			},
			settings: {
				get: vi.fn(),
				set: vi.fn(),
			},
		};
	});

	afterEach(() => {
		cleanup();
		vi.useRealTimers();
		vi.restoreAllMocks();
		(window as any).maestro = undefined;
	});

	it('renders dedicated and args-derived YOLO flags from the selected agent config', async () => {
		mocks.agentsGet.mockResolvedValueOnce({
			id: 'codex',
			name: 'Codex',
			binaryName: 'codex',
			yoloModeArgs: ['--dangerously-bypass-approvals'],
		});

		const firstRender = renderDirectory();

		expect(await screen.findByText('codex --dangerously-bypass-approvals')).toBeInTheDocument();

		firstRender.unmount();
		cleanup();
		mocks.agentsGet.mockResolvedValueOnce({
			id: 'opencode',
			name: 'OpenCode',
			command: 'opencode',
			args: ['run', '--yolo'],
		});

		renderDirectory({ selectedAgent: 'opencode' });

		expect(await screen.findByText('opencode --yolo')).toBeInTheDocument();
	});

	it('logs selected-agent config failures without blocking directory entry', async () => {
		const error = new Error('agent registry unavailable');
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
		mocks.agentsGet.mockRejectedValueOnce(error);

		renderDirectory();

		expect(await screen.findByLabelText('Project Directory')).toBeInTheDocument();
		await waitFor(() => {
			expect(consoleError).toHaveBeenCalledWith('Failed to fetch agent config:', error);
		});
	});

	it('omits the YOLO command badge when the selected agent has no args configured', async () => {
		mocks.agentsGet.mockResolvedValueOnce({
			id: 'codex',
			name: 'Codex',
			binaryName: 'codex',
		});

		renderDirectory();

		expect(await screen.findByLabelText('Project Directory')).toBeInTheDocument();
		expect(screen.queryByText(/codex --/)).not.toBeInTheDocument();
	});

	it('uses the fallback greeting and skips config loading when no agent is selected', async () => {
		renderDirectory({
			selectedAgent: null,
			agentName: '',
		});

		expect(await screen.findByText("Howdy, I'm your agent")).toBeInTheDocument();
		expect(mocks.agentsGet).not.toHaveBeenCalled();
	});

	it('uses the generic agent prefix for args-derived YOLO flags and ignores null configs', async () => {
		mocks.agentsGet.mockResolvedValueOnce({
			id: 'custom',
			name: 'Custom',
			args: ['--yes'],
		});

		const firstRender = renderDirectory({ selectedAgent: 'custom' });

		expect(await screen.findByText('agent --yes')).toBeInTheDocument();

		firstRender.unmount();
		cleanup();
		mocks.agentsGet.mockResolvedValueOnce(null);

		renderDirectory();

		expect(await screen.findByLabelText('Project Directory')).toBeInTheDocument();
		expect(screen.queryByText(/agent --yes/)).not.toBeInTheDocument();
	});

	it('loads the SSH remote host name, hides browse, and validates remote paths with the remote id', async () => {
		mocks.getConfigs.mockResolvedValueOnce({
			success: true,
			configs: [{ id: 'remote-1', name: 'Prod Box', host: 'prod.example.com' }],
		});

		renderDirectory({
			sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
		});

		const input = await screen.findByPlaceholderText(
			'Enter path on Prod Box (e.g., /home/user/project)'
		);
		expect(screen.queryByRole('button', { name: /browse/i })).not.toBeInTheDocument();

		fireEvent.change(input, { target: { value: '/srv/app' } });

		await waitFor(
			() => {
				expect(mocks.readDir).toHaveBeenCalledWith('/srv/app', 'remote-1');
				expect(mocks.isRepo).toHaveBeenCalledWith('/srv/app', 'remote-1');
				expect(mocks.listDocs).toHaveBeenCalledWith('/srv/app/Auto Run Docs', 'remote-1');
			},
			{ timeout: 1500 }
		);
	});

	it('uses SSH host fallback names and keeps the generic placeholder for unsuccessful lookups', async () => {
		mocks.getConfigs.mockResolvedValueOnce({
			success: true,
			configs: [{ id: 'remote-1', host: 'host.example.com' }],
		});

		const firstRender = renderDirectory({
			sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
		});

		expect(
			await screen.findByPlaceholderText(
				'Enter path on host.example.com (e.g., /home/user/project)'
			)
		).toBeInTheDocument();

		firstRender.unmount();
		cleanup();
		mocks.getConfigs.mockResolvedValueOnce({ success: false });

		renderDirectory({
			sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
		});

		expect(
			await screen.findByPlaceholderText('Enter path on remote host (e.g., /home/user/project)')
		).toBeInTheDocument();
	});

	it('keeps the generic remote placeholder when the selected SSH config is absent', async () => {
		mocks.getConfigs.mockResolvedValueOnce({
			success: true,
			configs: [{ id: 'remote-2', name: 'Other Host', host: 'other.example.com' }],
		});

		renderDirectory({
			sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
		});

		expect(
			await screen.findByPlaceholderText('Enter path on remote host (e.g., /home/user/project)')
		).toBeInTheDocument();
	});

	it('logs SSH host lookup failures and falls back to the generic remote placeholder', async () => {
		const error = new Error('ssh store offline');
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
		mocks.getConfigs.mockRejectedValueOnce(error);

		renderDirectory({
			sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
		});

		expect(
			await screen.findByPlaceholderText('Enter path on remote host (e.g., /home/user/project)')
		).toBeInTheDocument();
		await waitFor(() => {
			expect(consoleError).toHaveBeenCalledWith('Failed to load SSH remote config:', error);
		});
	});

	it('debounces typed path validation and clears pending validation when the path changes', async () => {
		renderDirectory();

		const input = await screen.findByLabelText('Project Directory');
		vi.useFakeTimers();
		fireEvent.change(input, { target: { value: '/first' } });
		fireEvent.change(input, { target: { value: '/second' } });

		await act(async () => {
			await vi.advanceTimersByTimeAsync(800);
		});

		expect(mocks.readDir).toHaveBeenCalledTimes(1);
		expect(mocks.readDir).toHaveBeenCalledWith('/second', undefined);

		fireEvent.change(input, { target: { value: '' } });

		expect(screen.getByTestId('directory-path')).toHaveTextContent('');
		expect(screen.getByTestId('directory-error')).toHaveTextContent('');
		expect(screen.queryByRole('button', { name: 'Continue' })).not.toBeInTheDocument();
	});

	it('skips validation-time existing-doc checks after the user already chose how to handle them', async () => {
		renderDirectory({ existingDocsChoice: 'continue' });

		const input = await screen.findByLabelText('Project Directory');
		vi.useFakeTimers();
		fireEvent.change(input, { target: { value: '/repo' } });

		await act(async () => {
			await vi.advanceTimersByTimeAsync(800);
		});

		expect(mocks.readDir).toHaveBeenCalledWith('/repo', undefined);
		expect(mocks.isRepo).toHaveBeenCalledWith('/repo', undefined);
		expect(mocks.listDocs).not.toHaveBeenCalled();
	});

	it('clears pending debounced validation when unmounted', async () => {
		const rendered = renderDirectory();

		const input = await screen.findByLabelText('Project Directory');
		vi.useFakeTimers();
		fireEvent.change(input, { target: { value: '/pending' } });

		rendered.unmount();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(800);
		});

		expect(mocks.readDir).not.toHaveBeenCalled();
	});

	it('selects a folder, validates regular directories, detects existing docs, and focuses Continue', async () => {
		mocks.selectFolder.mockResolvedValueOnce('/picked');
		mocks.isRepo.mockResolvedValueOnce(false);
		mocks.listDocs.mockResolvedValueOnce({
			success: true,
			files: [{ name: 'Phase-01.md' }],
		});

		renderDirectory();

		fireEvent.click(await screen.findByRole('button', { name: /browse/i }));

		expect(await screen.findByDisplayValue('/picked')).toBeInTheDocument();
		expect(await screen.findByText('Regular Directory')).toBeInTheDocument();
		expect(mocks.listDocs).toHaveBeenCalledWith('/picked/Auto Run Docs', undefined);
		expect(screen.getByTestId('existing-docs-count')).toHaveTextContent('1');

		await waitFor(() => {
			expect(screen.getByRole('button', { name: 'Continue' })).toHaveFocus();
		});
	});

	it('keeps a valid directory when the validation-time existing-docs lookup fails', async () => {
		mocks.selectFolder.mockResolvedValueOnce('/repo');
		mocks.listDocs.mockRejectedValueOnce(new Error('Auto Run Docs unavailable'));

		renderDirectory();

		fireEvent.click(await screen.findByRole('button', { name: /browse/i }));

		expect(await screen.findByText('Git Repository Detected')).toBeInTheDocument();
		expect(screen.getByTestId('existing-docs-count')).toHaveTextContent('0');
		expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();
	});

	it('leaves the directory unchanged when browse is cancelled', async () => {
		mocks.selectFolder.mockResolvedValueOnce(null);

		renderDirectory();

		fireEvent.click(await screen.findByRole('button', { name: /browse/i }));

		await waitFor(() => {
			expect(mocks.selectFolder).toHaveBeenCalledTimes(1);
		});
		expect(screen.getByTestId('directory-path')).toHaveTextContent('');
		expect(mocks.readDir).not.toHaveBeenCalled();
	});

	it('shows expected errors for failed browse, missing directories, and git validation failures', async () => {
		const browseError = new Error('dialog unavailable');
		const missingDirError = new Error('ENOENT');
		const gitError = new Error('git failed');
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

		mocks.selectFolder.mockRejectedValueOnce(browseError);
		const browseRender = renderDirectory();
		fireEvent.click(await screen.findByRole('button', { name: /browse/i }));

		expect(await screen.findAllByText('Failed to open folder picker')).not.toHaveLength(0);
		expect(consoleError).toHaveBeenCalledWith('Browse failed:', browseError);
		browseRender.unmount();
		cleanup();

		mocks.selectFolder.mockResolvedValueOnce('/missing');
		mocks.readDir.mockRejectedValueOnce(missingDirError);
		const missingRender = renderDirectory();
		fireEvent.click(await screen.findByRole('button', { name: /browse/i }));

		expect(
			await screen.findAllByText('Directory not found. Please check the path exists.')
		).not.toHaveLength(0);
		expect(consoleError).toHaveBeenCalledWith('Directory does not exist:', missingDirError);
		missingRender.unmount();
		cleanup();

		mocks.selectFolder.mockResolvedValueOnce('/repo');
		mocks.readDir.mockResolvedValueOnce([{ name: '.git', isDirectory: true }]);
		mocks.isRepo.mockRejectedValueOnce(gitError);
		renderDirectory();
		fireEvent.click(await screen.findByRole('button', { name: /browse/i }));

		expect(
			await screen.findAllByText('Unable to access this directory. Please check the path exists.')
		).not.toHaveLength(0);
		expect(consoleError).toHaveBeenCalledWith('Directory validation error:', gitError);
	});

	it('proceeds directly when existing documents were already handled', async () => {
		renderDirectory({
			directoryPath: '/repo',
			existingDocsChoice: 'continue',
		});

		fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));

		await waitFor(() => {
			expect(screen.getByTestId('current-step')).toHaveTextContent('conversation');
		});
		expect(mocks.listDocs).not.toHaveBeenCalled();
	});

	it('opens the existing-docs modal and continues with the existing plan', async () => {
		mocks.listDocs.mockResolvedValueOnce({
			success: true,
			files: [{ name: 'Phase-01.md' }, { name: 'Phase-02.md' }],
		});

		renderDirectory({ directoryPath: '/repo' });

		fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));

		expect(await screen.findByRole('dialog')).toHaveAccessibleName(
			'Existing Auto Run Documents Found'
		);
		expect(screen.getByText('2 Auto Run documents')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: /continue building on existing plan/i }));

		await waitFor(() => {
			expect(screen.getByTestId('current-step')).toHaveTextContent('conversation');
			expect(screen.getByTestId('existing-docs-choice')).toHaveTextContent('continue');
		});
	});

	it('deletes existing docs when starting fresh from the modal', async () => {
		mocks.listDocs.mockResolvedValueOnce({
			success: true,
			files: [{ name: 'Phase-01.md' }],
		});

		renderDirectory({ directoryPath: '/repo' });

		fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
		fireEvent.click(await screen.findByRole('button', { name: /delete & start fresh/i }));

		await waitFor(() => {
			expect(mocks.deleteFolder).toHaveBeenCalledWith('/repo');
			expect(screen.getByTestId('current-step')).toHaveTextContent('conversation');
			expect(screen.getByTestId('existing-docs-choice')).toHaveTextContent('fresh');
			expect(screen.getByTestId('existing-docs-count')).toHaveTextContent('0');
		});
	});

	it('cancels the existing-docs modal and returns focus to an empty directory input', async () => {
		mocks.listDocs.mockResolvedValueOnce({
			success: true,
			files: [{ name: 'Phase-01.md' }],
		});

		renderDirectory({ directoryPath: '/repo' });

		fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
		fireEvent.click(
			await screen.findByRole('button', { name: /cancel and choose a different directory/i })
		);

		const input = screen.getByLabelText('Project Directory');
		expect(input).toHaveValue('');
		expect(input).toHaveFocus();
		expect(screen.getByTestId('existing-docs-count')).toHaveTextContent('0');
		expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
	});

	it('continues when existing-doc lookup fails during navigation', async () => {
		mocks.listDocs.mockRejectedValueOnce(new Error('Auto Run Docs inaccessible'));

		renderDirectory({ directoryPath: '/repo' });

		fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));

		await waitFor(() => {
			expect(screen.getByTestId('current-step')).toHaveTextContent('conversation');
		});
	});

	it('continues when existing-doc lookup returns an unsuccessful result', async () => {
		mocks.listDocs.mockResolvedValueOnce({ success: false, error: 'unavailable' });

		renderDirectory({ directoryPath: '/repo' });

		fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));

		await waitFor(() => {
			expect(screen.getByTestId('current-step')).toHaveTextContent('conversation');
		});
	});

	it('uses Enter on the focused browse button to open the folder picker', async () => {
		mocks.selectFolder.mockResolvedValueOnce('/picked');

		renderDirectory();

		const browseButton = await screen.findByRole('button', { name: /browse/i });
		browseButton.focus();
		const container = screen.getByText('Where Should We Work?').closest('div[tabindex]');

		fireEvent.keyDown(container!, { key: 'Enter' });

		await waitFor(() => {
			expect(mocks.selectFolder).toHaveBeenCalledTimes(1);
			expect(screen.getByDisplayValue('/picked')).toBeInTheDocument();
		});
	});

	it('ignores repeated Enter while browse is already opening', async () => {
		let resolveFolder: ((value: string | null) => void) | undefined;
		mocks.selectFolder.mockReturnValueOnce(
			new Promise((resolve) => {
				resolveFolder = resolve;
			})
		);

		renderDirectory();

		const browseButton = await screen.findByRole('button', { name: /browse/i });
		const container = screen.getByText('Where Should We Work?').closest('div[tabindex]');
		browseButton.focus();

		fireEvent.keyDown(container!, { key: 'Enter' });

		await waitFor(() => {
			expect(browseButton).toBeDisabled();
		});

		fireEvent.keyDown(container!, { key: 'Enter' });

		expect(mocks.selectFolder).toHaveBeenCalledTimes(1);

		await act(async () => {
			resolveFolder?.(null);
			await Promise.resolve();
		});
		expect(mocks.readDir).not.toHaveBeenCalled();
	});

	it('uses Enter on a valid directory to proceed and Escape to return to the previous step', async () => {
		const firstRender = renderDirectory({ directoryPath: '/repo' });

		let container = (await screen.findByText('Where Should We Work?')).closest('div[tabindex]');
		fireEvent.keyDown(container!, { key: 'Enter' });

		await waitFor(() => {
			expect(screen.getByTestId('current-step')).toHaveTextContent('conversation');
		});

		firstRender.unmount();
		cleanup();
		renderDirectory();

		container = (await screen.findByText('Where Should We Work?')).closest('div[tabindex]');
		fireEvent.keyDown(container!, { key: 'Escape' });

		expect(screen.getByTestId('current-step')).toHaveTextContent('agent-selection');
	});

	it('does not proceed on Enter while validation is still running', async () => {
		let resolveReadDir: ((value: { name: string; isDirectory: boolean }[]) => void) | undefined;
		mocks.readDir.mockReturnValueOnce(
			new Promise((resolve) => {
				resolveReadDir = resolve;
			})
		);

		renderDirectory();

		const input = await screen.findByLabelText('Project Directory');
		vi.useFakeTimers();
		fireEvent.change(input, { target: { value: '/repo' } });

		await act(async () => {
			await vi.advanceTimersByTimeAsync(800);
		});

		expect(screen.getByText('Validating directory...')).toBeInTheDocument();

		const container = screen.getByText('Where Should We Work?').closest('div[tabindex]');
		fireEvent.keyDown(container!, { key: 'Enter' });

		expect(screen.getByTestId('current-step')).toHaveTextContent('directory-selection');
		expect(mocks.listDocs).not.toHaveBeenCalled();

		await act(async () => {
			resolveReadDir?.([{ name: 'README.md', isDirectory: false }]);
			await Promise.resolve();
		});
	});

	it('does not proceed on Enter while the directory is invalid', async () => {
		renderDirectory({
			directoryPath: '/repo',
			directoryError: 'Directory not found. Please check the path exists.',
		});

		const container = (await screen.findByText('Where Should We Work?')).closest('div[tabindex]');

		fireEvent.keyDown(container!, { key: 'Enter' });

		expect(screen.getByTestId('current-step')).toHaveTextContent('directory-selection');
		expect(mocks.listDocs).not.toHaveBeenCalled();
	});

	it('treats whitespace-only folder selections as an empty path validation reset', async () => {
		mocks.selectFolder.mockResolvedValueOnce('   ');

		renderDirectory({
			directoryError: 'Previous error',
			isGitRepo: true,
			hasExistingAutoRunDocs: true,
			existingDocsCount: 3,
		});

		fireEvent.click(await screen.findByRole('button', { name: /browse/i }));

		await waitFor(() => {
			expect(screen.getByTestId('directory-error')).toHaveTextContent('');
			expect(screen.getByTestId('existing-docs-count')).toHaveTextContent('0');
		});
		expect(mocks.readDir).not.toHaveBeenCalled();
	});
});
