import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BatchRunnerModal, DEFAULT_BATCH_PROMPT } from '../../renderer/components/BatchRunnerModal';
import { LayerStackProvider } from '../../renderer/contexts/LayerStackContext';
import { useModalStore } from '../../renderer/stores/modalStore';
import { useSessionStore } from '../../renderer/stores/sessionStore';
import type { BatchRunConfig, Playbook, Session, Theme } from '../../renderer/types';

const theme: Theme = {
	id: 'integration-dark',
	name: 'Integration Dark',
	mode: 'dark',
	colors: {
		bgMain: '#101114',
		bgSidebar: '#20242b',
		bgActivity: '#181b20',
		textMain: '#f4f4f5',
		textDim: '#a1a1aa',
		textInverse: '#111827',
		accent: '#4f8cff',
		accentForeground: '#ffffff',
		border: '#3f3f46',
		error: '#ef4444',
		warning: '#f59e0b',
		success: '#22c55e',
		info: '#38bdf8',
	},
};

const validPrompt = 'For each markdown task, complete every unchecked item like - [ ].';

function createSession(overrides: Partial<Session> = {}): Session {
	return {
		id: 'session-1',
		name: 'Batch Session',
		toolType: 'claude-code',
		state: 'idle',
		cwd: '/workspace/app',
		fullPath: '/workspace/app',
		projectRoot: '/workspace/app',
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
		activeTabId: null,
		closedTabHistory: [],
		...overrides,
	} as Session;
}

function createPlaybook(overrides: Partial<Playbook> = {}): Playbook {
	return {
		id: 'playbook-1',
		name: 'Shipping Flow',
		createdAt: 1,
		updatedAt: 2,
		documents: [
			{ filename: 'doc1', resetOnCompletion: false },
			{ filename: 'missing-doc', resetOnCompletion: true },
		],
		loopEnabled: true,
		maxLoops: 3,
		prompt: validPrompt,
		...overrides,
	};
}

function createProps(overrides: Partial<React.ComponentProps<typeof BatchRunnerModal>> = {}) {
	return {
		theme,
		onClose: vi.fn(),
		onGo: vi.fn(),
		onSave: vi.fn(),
		initialPrompt: validPrompt,
		lastModifiedAt: Date.now(),
		showConfirmation: vi.fn((_message: string, onConfirm: () => void) => onConfirm()),
		folderPath: '/workspace/app/docs',
		presetDocuments: ['todo'],
		allDocuments: ['todo', 'doc1', 'doc2'],
		getDocumentTaskCount: vi.fn(async (filename: string) => {
			if (filename === 'todo') return 2;
			if (filename === 'doc1') return 1;
			if (filename === 'doc2') return 0;
			return 0;
		}),
		onRefreshDocuments: vi.fn().mockResolvedValue(undefined),
		sessionId: 'session-1',
		onOpenMarketplace: vi.fn(),
		...overrides,
	};
}

function renderModal(overrides: Partial<React.ComponentProps<typeof BatchRunnerModal>> = {}) {
	const props = createProps(overrides);
	const result = render(
		<LayerStackProvider>
			<BatchRunnerModal {...props} />
		</LayerStackProvider>
	);
	return { ...result, props };
}

function createDeferred<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

describe('BatchRunnerModal integration', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, 'log').mockImplementation(() => {});
		useSessionStore.setState({
			sessions: [createSession()],
			activeSessionId: 'session-1',
			sessionsLoaded: true,
		});

		vi.mocked(window.maestro.playbooks.list).mockResolvedValue({
			success: true,
			playbooks: [],
		});
		vi.mocked(window.maestro.playbooks.create).mockResolvedValue({
			success: true,
			playbook: createPlaybook({ id: 'created-playbook', name: 'Saved Flow' }),
		});
		vi.mocked(window.maestro.playbooks.update).mockResolvedValue({
			success: true,
			playbook: createPlaybook(),
		});
		vi.mocked(window.maestro.playbooks.delete).mockResolvedValue({ success: true });
		vi.mocked(window.maestro.playbooks.export).mockResolvedValue({ success: true });
		vi.mocked(window.maestro.playbooks.import).mockResolvedValue({
			success: true,
			playbook: createPlaybook({ id: 'imported-playbook', name: 'Imported Flow' }),
		});
		vi.mocked(window.maestro.logger.log).mockClear();
	});

	afterEach(() => {
		cleanup();
		useSessionStore.setState({ sessions: [], activeSessionId: null });
		useModalStore.setState({ modals: new Map() });
		vi.restoreAllMocks();
	});

	it('renders task counts, prompt controls, worktree entry, and close confirmation', async () => {
		const { props } = renderModal();

		expect(screen.getByRole('dialog', { name: 'Maestro Auto Run' })).toBeInTheDocument();
		expect(await screen.findByText('2')).toBeInTheDocument();
		expect(screen.getByText('todo.md')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: /Playbook Exchange/ })).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: /Playbook Exchange/ }));
		expect(props.onOpenMarketplace).toHaveBeenCalledOnce();

		fireEvent.click(screen.getByRole('button', { name: /Template Variables/ }));
		expect(screen.getByText('{{DOCUMENT_NAME}}')).toBeInTheDocument();

		const prompt = screen.getByPlaceholderText('Enter the system prompt for auto-run...');
		fireEvent.change(prompt, { target: { value: `${validPrompt}\nExtra instruction.` } });
		expect(screen.getByText('CUSTOMIZED')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		expect(props.onSave).toHaveBeenCalledWith(`${validPrompt}\nExtra instruction.`);

		fireEvent.change(prompt, { target: { value: '' } });
		expect(
			screen.getByText('Agent prompt cannot be empty. Reset to default or provide a prompt.')
		).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Go' })).toBeDisabled();

		fireEvent.change(prompt, { target: { value: 'No task reference here.' } });
		expect(screen.getByText(/Agent prompt must reference Markdown tasks/)).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
		expect(props.showConfirmation).toHaveBeenCalledWith(
			'You have unsaved changes to your Auto Run configuration. Close without saving?',
			expect.any(Function)
		);
		expect(props.onClose).toHaveBeenCalledOnce();
	});

	it('adds documents through the real selector, configures loops, and starts a run', async () => {
		const onGo = vi.fn<[], void>();
		const { props } = renderModal({ onGo });

		await screen.findByText('todo.md');
		fireEvent.click(screen.getByRole('button', { name: /Add Docs/ }));
		fireEvent.click(screen.getByText('doc1.md'));
		fireEvent.click(screen.getByRole('button', { name: /Add 2 files/ }));

		expect(screen.getByText('doc1.md')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Loop' }));
		fireEvent.click(screen.getByRole('button', { name: 'max' }));
		fireEvent.change(screen.getByRole('slider'), { target: { value: '4' } });

		fireEvent.click(screen.getByRole('button', { name: 'Go' }));

		expect(props.onSave).toHaveBeenCalledWith(validPrompt);
		expect(onGo).toHaveBeenCalledWith(
			expect.objectContaining({
				prompt: validPrompt,
				loopEnabled: true,
				maxLoops: 4,
			}) satisfies Partial<BatchRunConfig>
		);
		const config = onGo.mock.calls[0][0] as BatchRunConfig;
		expect(config.documents.map((doc) => doc.filename)).toEqual(['todo', 'doc1']);
		expect(window.maestro.logger.log).toHaveBeenCalledWith(
			'info',
			'Go button clicked',
			'BatchRunnerModal',
			{ documentsCount: 2 }
		);
		expect(props.onClose).toHaveBeenCalledOnce();
	});

	it('loads, exports, deletes, imports, and saves playbooks through real child modals', async () => {
		const playbook = createPlaybook();
		vi.mocked(window.maestro.playbooks.list).mockResolvedValue({
			success: true,
			playbooks: [playbook],
		});
		const { props } = renderModal();

		fireEvent.click(await screen.findByRole('button', { name: /Load Playbook/ }));
		fireEvent.click(screen.getByText('Shipping Flow'));
		expect(screen.getByText('missing-doc.md')).toBeInTheDocument();
		expect(
			screen.getByText('1 document no longer exists in the folder and will be skipped')
		).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: /Shipping Flow/ }));
		fireEvent.click(screen.getByTitle('Export playbook'));
		await waitFor(() => {
			expect(window.maestro.playbooks.export).toHaveBeenCalledWith(
				'session-1',
				'playbook-1',
				'/workspace/app/docs'
			);
		});

		fireEvent.click(screen.getByTitle('Delete playbook'));
		expect(screen.getByRole('dialog', { name: 'Delete Playbook' })).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
		await waitFor(() => {
			expect(window.maestro.playbooks.delete).toHaveBeenCalledWith('session-1', 'playbook-1');
		});

		cleanup();
		const savedRender = renderModal();
		fireEvent.click(await screen.findByRole('button', { name: /Add Docs/ }));
		fireEvent.click(screen.getByRole('button', { name: 'Select All' }));
		fireEvent.click(screen.getByRole('button', { name: /Add 3 files/ }));
		fireEvent.click(screen.getByRole('button', { name: 'Save as Playbook' }));
		const saveDialog = screen.getByRole('dialog', { name: 'Save as Playbook' });
		fireEvent.change(within(saveDialog).getByLabelText('Playbook Name'), {
			target: { value: 'Saved Flow' },
		});
		fireEvent.click(within(saveDialog).getByRole('button', { name: 'Save' }));
		await waitFor(() => {
			expect(window.maestro.playbooks.create).toHaveBeenCalledWith(
				'session-1',
				expect.objectContaining({
					name: 'Saved Flow',
					documents: expect.arrayContaining([
						expect.objectContaining({ filename: 'todo' }),
						expect.objectContaining({ filename: 'doc1' }),
					]),
					prompt: validPrompt,
				})
			);
		});

		fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
		expect(savedRender.props.onClose).toHaveBeenCalled();
	});

	it('opens the real prompt composer and closes from the layer stack Escape handler', async () => {
		const { props } = renderModal();

		await screen.findByText('2 tasks');
		fireEvent.click(screen.getByTitle('Expand editor'));
		expect(screen.getByText('Agent Prompt Editor')).toBeInTheDocument();
		const composerTextarea = screen.getByPlaceholderText(
			'Enter your agent prompt... (type {{ for variables)'
		);
		fireEvent.change(composerTextarea, { target: { value: `${validPrompt}\nComposer edit.` } });
		fireEvent.click(screen.getByTitle('Close (Escape)'));
		expect(screen.getByPlaceholderText('Enter the system prompt for auto-run...')).toHaveValue(
			`${validPrompt}\nComposer edit.`
		);

		fireEvent.keyDown(window, { key: 'Escape' });
		await waitFor(() => {
			expect(props.showConfirmation).toHaveBeenCalledWith(
				'You have unsaved changes to your Auto Run configuration. Close without saving?',
				expect.any(Function)
			);
		});
	});

	it('keeps the modal open while async worktree preparation fails', async () => {
		const onGo = vi.fn().mockRejectedValue(new Error('worktree failed'));
		useSessionStore.setState({
			sessions: [
				createSession(),
				createSession({
					id: 'child-worktree',
					name: 'Feature Child',
					parentSessionId: 'session-1',
					cwd: '/workspace/app-worktrees/feature',
					projectRoot: '/workspace/app',
				}),
			],
			activeSessionId: 'session-1',
		});
		const { props } = renderModal({ onGo });

		await screen.findByText('todo.md');
		await act(async () => {
			fireEvent.click(screen.getByRole('button', { name: /Dispatch to a separate worktree/ }));
		});
		await waitFor(() => expect(window.maestro.git.branch).toHaveBeenCalled());

		await act(async () => {
			fireEvent.click(screen.getByRole('button', { name: 'Go' }));
		});
		await waitFor(() => {
			expect(onGo).toHaveBeenCalledWith(expect.objectContaining({ prompt: validPrompt }));
		});
		expect(screen.getByRole('dialog', { name: 'Maestro Auto Run' })).toBeInTheDocument();
	});

	it('covers date formatting, reset confirmation, and tab insertion', async () => {
		const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
		const { props, rerender } = renderModal({ lastModifiedAt: oneDayAgo });
		expect(await screen.findByText(/Last modified yesterday at/)).toBeInTheDocument();
		await screen.findByText('2');

		const threeDaysAgo = Date.now() - 3 * 24 * 60 * 60 * 1000;
		rerender(
			<LayerStackProvider>
				<BatchRunnerModal {...props} lastModifiedAt={threeDaysAgo} />
			</LayerStackProvider>
		);
		expect(await screen.findByText(/Last modified 3 days ago/)).toBeInTheDocument();

		const olderDate = Date.now() - 9 * 24 * 60 * 60 * 1000;
		rerender(
			<LayerStackProvider>
				<BatchRunnerModal {...props} lastModifiedAt={olderDate} />
			</LayerStackProvider>
		);
		expect(await screen.findByText(/Last modified/)).toBeInTheDocument();

		await act(async () => {
			fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
		});
		expect(props.showConfirmation).toHaveBeenCalledWith(
			'Reset the prompt to the default? Your customizations will be lost.',
			expect.any(Function)
		);
		expect(screen.getByPlaceholderText('Enter the system prompt for auto-run...')).toHaveValue(
			DEFAULT_BATCH_PROMPT
		);

		const originalRaf = window.requestAnimationFrame;
		Object.defineProperty(window, 'requestAnimationFrame', {
			configurable: true,
			value: vi.fn((callback: FrameRequestCallback) => {
				callback(0);
				return 1;
			}),
		});
		const prompt = screen.getByPlaceholderText('Enter the system prompt for auto-run...');
		await act(async () => {
			fireEvent.change(prompt, { target: { value: 'abc' } });
		});
		const textarea = prompt as HTMLTextAreaElement;
		textarea.selectionStart = 1;
		textarea.selectionEnd = 2;
		await act(async () => {
			fireEvent.keyDown(textarea, { key: 'Tab' });
		});
		expect(prompt).toHaveValue('a\tc');
		await act(async () => {
			fireEvent.keyDown(textarea, { key: 'Enter' });
		});
		Object.defineProperty(window, 'requestAnimationFrame', {
			configurable: true,
			value: originalRaf,
		});
	});

	it('closes directly when there are no unsaved configuration changes', async () => {
		const cleanRender = renderModal({ initialPrompt: undefined, presetDocuments: [] });
		await screen.findByText('No documents selected');
		await act(async () => {
			fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
		});
		expect(cleanRender.props.showConfirmation).not.toHaveBeenCalled();
		expect(cleanRender.props.onClose).toHaveBeenCalledOnce();
	});

	it('covers empty initial documents, task count failures, no-task state, and worktree config open', async () => {
		renderModal({ presetDocuments: [] });
		expect(await screen.findByText('No documents selected')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Go' })).toHaveAttribute(
			'title',
			'No documents selected'
		);

		fireEvent.click(screen.getByRole('button', { name: /Configure/ }));
		expect(useModalStore.getState().isOpen('worktreeConfig')).toBe(true);
		cleanup();
		useModalStore.setState({ modals: new Map() });

		renderModal({
			presetDocuments: ['doc2'],
			allDocuments: ['doc2'],
			getDocumentTaskCount: vi.fn().mockRejectedValue(new Error('count failed')),
		});
		expect(await screen.findByText('0')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Go' })).toHaveAttribute(
			'title',
			'No unchecked tasks in documents'
		);
	});

	it('covers playbook import, save-as-new cancellation, delete escape, and all-missing disable reason', async () => {
		vi.mocked(window.maestro.playbooks.list).mockResolvedValue({
			success: true,
			playbooks: [
				createPlaybook({
					documents: [{ filename: 'missing-doc', resetOnCompletion: true }],
				}),
			],
		});
		renderModal({ allDocuments: [], presetDocuments: [] });

		fireEvent.click(await screen.findByRole('button', { name: /Load Playbook/ }));
		fireEvent.click(screen.getByText('Shipping Flow'));
		expect(await screen.findByText('missing-doc.md')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Go' })).toHaveAttribute(
			'title',
			'All selected documents are missing'
		);

		fireEvent.click(screen.getByRole('button', { name: /Shipping Flow/ }));
		fireEvent.click(screen.getByRole('button', { name: /Import Playbook/ }));
		await waitFor(() => {
			expect(window.maestro.playbooks.import).toHaveBeenCalledWith(
				'session-1',
				'/workspace/app/docs'
			);
		});

		fireEvent.click(screen.getByRole('button', { name: /Imported Flow/ }));
		fireEvent.click(screen.getAllByTitle('Delete playbook')[0]);
		expect(screen.getByRole('dialog', { name: 'Delete Playbook' })).toBeInTheDocument();
		fireEvent.keyDown(window, { key: 'Escape' });
		await waitFor(() => {
			expect(screen.queryByRole('dialog', { name: 'Delete Playbook' })).not.toBeInTheDocument();
		});

		fireEvent.change(screen.getByPlaceholderText('Enter the system prompt for auto-run...'), {
			target: { value: `${validPrompt}\nModified loaded playbook.` },
		});
		const updateDeferred = createDeferred<{ success: true; playbook: Playbook }>();
		vi.mocked(window.maestro.playbooks.update).mockReturnValueOnce(updateDeferred.promise);
		fireEvent.click(screen.getByRole('button', { name: 'Save Update' }));
		expect(screen.getByRole('button', { name: /Saving/ })).toBeDisabled();
		await act(async () => {
			updateDeferred.resolve({
				success: true,
				playbook: createPlaybook({ id: 'imported-playbook' }),
			});
			await updateDeferred.promise;
		});
		await waitFor(() => {
			expect(window.maestro.playbooks.update).toHaveBeenCalledWith(
				'session-1',
				'imported-playbook',
				expect.objectContaining({ prompt: `${validPrompt}\nModified loaded playbook.` })
			);
		});

		fireEvent.change(screen.getByPlaceholderText('Enter the system prompt for auto-run...'), {
			target: { value: `${validPrompt}\nModified loaded playbook again.` },
		});
		fireEvent.click(screen.getByRole('button', { name: 'Save as New' }));
		const saveDialog = screen.getByRole('dialog', { name: 'Save as Playbook' });
		fireEvent.click(within(saveDialog).getByRole('button', { name: 'Cancel' }));
		expect(screen.queryByRole('dialog', { name: 'Save as Playbook' })).not.toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'Save as New' }));
		expect(screen.getByRole('dialog', { name: 'Save as Playbook' })).toBeInTheDocument();
		fireEvent.keyDown(window, { key: 'Escape' });
		await waitFor(() => {
			expect(screen.queryByRole('dialog', { name: 'Save as Playbook' })).not.toBeInTheDocument();
		});
	});

	it('shows preparing state and closes after successful async worktree preparation', async () => {
		const deferred = createDeferred<void>();
		const onGo = vi.fn(() => deferred.promise);
		useSessionStore.setState({
			sessions: [
				createSession({
					worktreeConfig: { basePath: '/workspace/worktrees', watchEnabled: true },
				}),
			],
			activeSessionId: 'session-1',
		});
		const { props } = renderModal({ onGo });

		await screen.findByText('todo.md');
		await act(async () => {
			fireEvent.click(screen.getByRole('button', { name: /Dispatch to a separate worktree/ }));
		});
		await waitFor(() => expect(window.maestro.git.branch).toHaveBeenCalled());

		await act(async () => {
			fireEvent.click(screen.getByRole('button', { name: 'Go' }));
		});
		expect(screen.getByRole('button', { name: /Preparing Worktree/ })).toBeDisabled();

		await act(async () => {
			deferred.resolve();
			await deferred.promise;
		});
		await waitFor(() => {
			expect(props.onClose).toHaveBeenCalledOnce();
		});
		expect(screen.getByRole('button', { name: 'Go' })).toBeInTheDocument();
	});
});
