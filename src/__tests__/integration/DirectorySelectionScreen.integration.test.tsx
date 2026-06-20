import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LayerStackProvider } from '../../renderer/contexts/LayerStackContext';
import { DirectorySelectionScreen } from '../../renderer/components/Wizard/screens/DirectorySelectionScreen';
import {
	WizardProvider,
	useWizard,
	type WizardState,
} from '../../renderer/components/Wizard/WizardContext';
import { PLAYBOOKS_DIR } from '../../shared/maestro-paths';
import type { Theme } from '../../renderer/types';

const mocks = vi.hoisted(() => ({
	agentsGet: vi.fn(),
	readDir: vi.fn(),
	isRepo: vi.fn(),
	selectFolder: vi.fn(),
	listDocs: vi.fn(),
	deleteFolder: vi.fn(),
	getConfigs: vi.fn(),
}));

const theme: Theme = {
	id: 'custom',
	name: 'Integration Dark',
	mode: 'dark',
	colors: {
		bgMain: '#101010',
		bgSidebar: '#181818',
		bgActivity: '#242424',
		border: '#334155',
		textMain: '#f8fafc',
		textDim: '#94a3b8',
		accent: '#38bdf8',
		accentDim: '#0e7490',
		accentText: '#38bdf8',
		accentForeground: '#ffffff',
		success: '#22c55e',
		warning: '#f59e0b',
		error: '#ef4444',
	},
};

let originalMaestro: typeof window.maestro;

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
			{ready && <DirectorySelectionScreen theme={theme} />}
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

describe('DirectorySelectionScreen integration', () => {
	beforeEach(() => {
		originalMaestro = window.maestro;
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

		window.maestro = {
			...window.maestro,
			agents: {
				...window.maestro.agents,
				get: mocks.agentsGet,
			},
			fs: {
				...window.maestro.fs,
				readDir: mocks.readDir,
			},
			git: {
				...window.maestro.git,
				isRepo: mocks.isRepo,
			},
			dialog: {
				...window.maestro.dialog,
				selectFolder: mocks.selectFolder,
			},
			autorun: {
				...window.maestro.autorun,
				listDocs: mocks.listDocs,
				deleteFolder: mocks.deleteFolder,
			},
			sshRemote: {
				...window.maestro.sshRemote,
				getConfigs: mocks.getConfigs,
			},
		};
	});

	afterEach(() => {
		cleanup();
		vi.useRealTimers();
		vi.restoreAllMocks();
		window.maestro = originalMaestro;
	});

	it('renders selected-agent YOLO flags and the no-agent fallback', async () => {
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

		const secondRender = renderDirectory({ selectedAgent: 'opencode' });
		expect(await screen.findByText('opencode --yolo')).toBeInTheDocument();

		secondRender.unmount();
		cleanup();
		mocks.agentsGet.mockClear();
		renderDirectory({ selectedAgent: null, agentName: '' });

		expect(await screen.findByText("Howdy, I'm your agent")).toBeInTheDocument();
		expect(mocks.agentsGet).not.toHaveBeenCalled();
	});

	it('validates remote paths with the SSH remote id and skips browse controls', async () => {
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
				expect(mocks.listDocs).toHaveBeenCalledWith(`/srv/app/${PLAYBOOKS_DIR}`, 'remote-1');
			},
			{ timeout: 1500 }
		);
		expect(await screen.findByText('Git Repository Detected')).toBeInTheDocument();
	});

	it('debounces typed validation, skips existing-doc checks after a choice, and clears on unmount', async () => {
		renderDirectory({ existingDocsChoice: 'continue' });

		const input = await screen.findByLabelText('Project Directory');
		vi.useFakeTimers();
		fireEvent.change(input, { target: { value: '/first' } });
		fireEvent.change(input, { target: { value: '/second' } });

		await act(async () => {
			await vi.advanceTimersByTimeAsync(800);
		});

		expect(mocks.readDir).toHaveBeenCalledTimes(1);
		expect(mocks.readDir).toHaveBeenCalledWith('/second', undefined);
		expect(mocks.isRepo).toHaveBeenCalledWith('/second', undefined);
		expect(mocks.listDocs).not.toHaveBeenCalled();

		fireEvent.change(input, { target: { value: '' } });
		expect(screen.getByTestId('directory-path')).toHaveTextContent('');
		expect(screen.queryByRole('button', { name: 'Continue' })).not.toBeInTheDocument();

		vi.useRealTimers();
		cleanup();
		mocks.readDir.mockClear();
		const rendered = renderDirectory();
		const pendingInput = await screen.findByLabelText('Project Directory');
		vi.useFakeTimers();
		fireEvent.change(pendingInput, { target: { value: '/pending' } });
		rendered.unmount();

		await act(async () => {
			await vi.advanceTimersByTimeAsync(800);
		});
		expect(mocks.readDir).not.toHaveBeenCalled();
	});

	it('selects folders, detects regular directories and existing docs, and focuses Continue', async () => {
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
		expect(mocks.listDocs).toHaveBeenCalledWith(`/picked/${PLAYBOOKS_DIR}`, undefined);
		expect(screen.getByTestId('existing-docs-count')).toHaveTextContent('1');

		await waitFor(() => {
			expect(screen.getByRole('button', { name: 'Continue' })).toHaveFocus();
		});
	});

	it('shows expected errors for browse, missing directory, git validation, and SSH host lookup failures', async () => {
		const browseError = new Error('dialog unavailable');
		const missingDirError = new Error('ENOENT');
		const gitError = new Error('git failed');
		const sshError = new Error('ssh store offline');

		mocks.selectFolder.mockRejectedValueOnce(browseError);
		const browseRender = renderDirectory();
		fireEvent.click(await screen.findByRole('button', { name: /browse/i }));

		expect(await screen.findAllByText('Failed to open folder picker')).not.toHaveLength(0);
		expect(window.maestro.logger.log).toHaveBeenCalledWith(
			'error',
			'Browse failed:',
			undefined,
			browseError
		);
		browseRender.unmount();
		cleanup();

		mocks.selectFolder.mockResolvedValueOnce('/missing');
		mocks.readDir.mockRejectedValueOnce(missingDirError);
		const missingRender = renderDirectory();
		fireEvent.click(await screen.findByRole('button', { name: /browse/i }));

		expect(
			await screen.findAllByText('Directory not found. Please check the path exists.')
		).not.toHaveLength(0);
		expect(window.maestro.logger.log).toHaveBeenCalledWith(
			'error',
			'Directory does not exist:',
			undefined,
			missingDirError
		);
		missingRender.unmount();
		cleanup();

		mocks.selectFolder.mockResolvedValueOnce('/repo');
		mocks.readDir.mockResolvedValueOnce([{ name: '.git', isDirectory: true }]);
		mocks.isRepo.mockRejectedValueOnce(gitError);
		const gitRender = renderDirectory();
		fireEvent.click(await screen.findByRole('button', { name: /browse/i }));

		expect(
			await screen.findAllByText('Unable to access this directory. Please check the path exists.')
		).not.toHaveLength(0);
		expect(window.maestro.logger.log).toHaveBeenCalledWith(
			'error',
			'Directory validation error:',
			undefined,
			gitError
		);
		gitRender.unmount();
		cleanup();

		mocks.getConfigs.mockRejectedValueOnce(sshError);
		renderDirectory({
			sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
		});

		expect(
			await screen.findByPlaceholderText('Enter path on remote host (e.g., /home/user/project)')
		).toBeInTheDocument();
		await waitFor(() => {
			expect(window.maestro.logger.log).toHaveBeenCalledWith(
				'error',
				'Failed to load SSH remote config:',
				undefined,
				sshError
			);
		});
	});

	it('handles existing-doc choices for continue, start fresh, cancel, and lookup failures', async () => {
		mocks.listDocs.mockResolvedValueOnce({
			success: true,
			files: [{ name: 'Phase-01.md' }, { name: 'Phase-02.md' }],
		});

		const continueRender = renderDirectory({ directoryPath: '/repo' });
		fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));

		expect(await screen.findByRole('dialog')).toHaveAccessibleName(
			'Existing Auto Run Documents Found'
		);
		expect(screen.getByText('2 playbook documents')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: /continue building on existing plan/i }));

		await waitFor(() => {
			expect(screen.getByTestId('current-step')).toHaveTextContent('conversation');
			expect(screen.getByTestId('existing-docs-choice')).toHaveTextContent('continue');
		});
		continueRender.unmount();
		cleanup();

		mocks.listDocs.mockResolvedValueOnce({ success: true, files: [{ name: 'Phase-01.md' }] });
		const freshRender = renderDirectory({ directoryPath: '/repo' });
		fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
		fireEvent.click(await screen.findByRole('button', { name: /delete & start fresh/i }));

		await waitFor(() => {
			expect(mocks.deleteFolder).toHaveBeenCalledWith('/repo');
			expect(screen.getByTestId('current-step')).toHaveTextContent('conversation');
			expect(screen.getByTestId('existing-docs-choice')).toHaveTextContent('fresh');
			expect(screen.getByTestId('existing-docs-count')).toHaveTextContent('0');
		});
		freshRender.unmount();
		cleanup();

		mocks.listDocs.mockResolvedValueOnce({ success: true, files: [{ name: 'Phase-01.md' }] });
		const cancelRender = renderDirectory({ directoryPath: '/repo' });
		fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
		fireEvent.click(
			await screen.findByRole('button', { name: /cancel and choose a different directory/i })
		);

		const input = screen.getByLabelText('Project Directory');
		expect(input).toHaveValue('');
		expect(input).toHaveFocus();
		expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
		cancelRender.unmount();
		cleanup();

		mocks.listDocs.mockRejectedValueOnce(
			new Error(`ENOENT: no such file or directory, scandir /repo/${PLAYBOOKS_DIR}`)
		);
		renderDirectory({ directoryPath: '/repo' });
		fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));

		await waitFor(() => {
			expect(screen.getByTestId('current-step')).toHaveTextContent('conversation');
		});
	});

	it('uses keyboard Enter and Escape for browse, proceed, blocked validation, and previous-step flow', async () => {
		mocks.selectFolder.mockResolvedValueOnce('/picked');
		const firstRender = renderDirectory();
		const browseButton = await screen.findByRole('button', { name: /browse/i });
		browseButton.focus();
		let container = screen.getByText('Where Should We Work?').closest('div[tabindex]');

		fireEvent.keyDown(container!, { key: 'Enter' });
		await waitFor(() => {
			expect(mocks.selectFolder).toHaveBeenCalledTimes(1);
			expect(screen.getByDisplayValue('/picked')).toBeInTheDocument();
		});
		firstRender.unmount();
		cleanup();
		mocks.listDocs.mockClear();

		let resolveReadDir: ((value: { name: string; isDirectory: boolean }[]) => void) | undefined;
		mocks.readDir.mockReturnValueOnce(
			new Promise((resolve) => {
				resolveReadDir = resolve;
			})
		);
		const validatingRender = renderDirectory();
		const input = await screen.findByLabelText('Project Directory');
		vi.useFakeTimers();
		fireEvent.change(input, { target: { value: '/repo' } });

		await act(async () => {
			await vi.advanceTimersByTimeAsync(800);
		});

		expect(screen.getByText('Validating directory...')).toBeInTheDocument();
		container = screen.getByText('Where Should We Work?').closest('div[tabindex]');
		fireEvent.keyDown(container!, { key: 'Enter' });
		expect(screen.getByTestId('current-step')).toHaveTextContent('directory-selection');
		expect(mocks.listDocs).not.toHaveBeenCalled();

		await act(async () => {
			resolveReadDir?.([{ name: 'README.md', isDirectory: false }]);
			await Promise.resolve();
		});
		validatingRender.unmount();
		cleanup();
		vi.useRealTimers();

		const validRender = renderDirectory({ directoryPath: '/repo' });
		container = (await screen.findByText('Where Should We Work?')).closest('div[tabindex]');
		fireEvent.keyDown(container!, { key: 'Enter' });
		await waitFor(() => {
			expect(screen.getByTestId('current-step')).toHaveTextContent('conversation');
		});
		validRender.unmount();
		cleanup();

		renderDirectory();
		container = (await screen.findByText('Where Should We Work?')).closest('div[tabindex]');
		fireEvent.keyDown(container!, { key: 'Escape' });
		expect(screen.getByTestId('current-step')).toHaveTextContent('agent-selection');
	});
});
