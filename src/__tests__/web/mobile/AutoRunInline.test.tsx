/**
 * Tests for AutoRunInline empty-state Docs Overview CTAs.
 *
 * @file src/web/mobile/AutoRunInline.tsx
 *
 * Covers Gap 3 from the AutoRun mobile/web parity follow-up: the empty
 * state must surface BOTH "Create document" and "Browse Playbook Exchange"
 * as co-equal CTAs so mobile users have a path to discover existing
 * playbooks (not just create blank docs).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import React from 'react';
import { AutoRunInline } from '../../../web/mobile/AutoRunInline';
import type { AutoRunState } from '../../../web/hooks/useWebSocket';

type MockDocument = {
	filename: string;
	path: string;
	taskCount: number;
	completedCount: number;
	folder?: string;
};

const autoRunMock = vi.hoisted(() => ({
	documents: [] as MockDocument[],
	isLoadingDocs: false,
	loadDocuments: vi.fn().mockResolvedValue(undefined),
	saveDocumentContent: vi.fn().mockResolvedValue(true),
	resetDocumentTasks: vi.fn().mockResolvedValue(true),
	stopAutoRun: vi.fn().mockResolvedValue(true),
}));

vi.mock('../../../web/components/ThemeProvider', () => ({
	useThemeColors: () => ({
		bgMain: '#0b0b0d',
		bgSidebar: '#111113',
		bgActivity: '#1c1c1f',
		border: '#27272a',
		textMain: '#e4e4e7',
		textDim: '#a1a1aa',
		accent: '#6366f1',
		accentForeground: '#ffffff',
		accentDim: 'rgba(99, 102, 241, 0.2)',
		accentText: '#a5b4fc',
		success: '#22c55e',
		warning: '#eab308',
		error: '#ef4444',
	}),
}));

// MarkdownRenderer pulls in remark/rehype which is not relevant to the empty
// state and slows the test boot down considerably.
vi.mock('../../../web/mobile/MobileMarkdownRenderer', () => ({
	MobileMarkdownRenderer: ({ content }: { content: string }) => (
		<div data-testid="markdown-renderer">
			{content.split('\n').map((line, index) => {
				const task = line.match(/^\s*[-*]\s*\[( |x)\]\s*(.*)$/i);
				if (!task) return <div key={index}>{line}</div>;
				return (
					<label key={index}>
						<input type="checkbox" defaultChecked={task[1].toLowerCase() === 'x'} readOnly />
						{task[2]}
					</label>
				);
			})}
		</div>
	),
}));

vi.mock('../../../web/mobile/AutoRunIndicator', () => ({
	AutoRunIndicator: ({
		onResume,
		onSkipDocument,
		onAbort,
	}: {
		onResume?: () => void;
		onSkipDocument?: () => void;
		onAbort?: () => void;
	}) => (
		<div data-testid="auto-run-indicator">
			{onResume && <button onClick={onResume}>Resume after error</button>}
			{onSkipDocument && <button onClick={onSkipDocument}>Skip document</button>}
			{onAbort && <button onClick={onAbort}>Abort run</button>}
		</div>
	),
}));

vi.mock('../../../web/hooks/useAutoRun', () => ({
	useAutoRun: () => autoRunMock,
}));

const doc = (overrides: Partial<MockDocument> = {}): MockDocument => ({
	filename: 'daily',
	path: 'daily',
	taskCount: 2,
	completedCount: 1,
	...overrides,
});

function resetAutoRunMock() {
	autoRunMock.documents = [];
	autoRunMock.isLoadingDocs = false;
	autoRunMock.loadDocuments.mockReset().mockResolvedValue(undefined);
	autoRunMock.saveDocumentContent.mockReset().mockResolvedValue(true);
	autoRunMock.resetDocumentTasks.mockReset().mockResolvedValue(true);
	autoRunMock.stopAutoRun.mockReset().mockResolvedValue(true);
}

function createProps(
	overrides: Partial<React.ComponentProps<typeof AutoRunInline>> = {},
	contentByFilename: Record<string, string> = {}
) {
	return {
		sessionId: 'session-1',
		autoRunState: null,
		sendRequest: vi
			.fn()
			.mockImplementation(async (_type: string, payload: { filename: string }) => ({
				content: contentByFilename[payload.filename] ?? '',
			})),
		send: vi.fn(),
		onOpenSetup: vi.fn(),
		...overrides,
	};
}

async function renderWithDocument(
	content: string,
	overrides: Partial<React.ComponentProps<typeof AutoRunInline>> = {}
) {
	autoRunMock.documents = [doc()];
	const props = createProps(overrides, { 'daily.md': content });
	render(<AutoRunInline {...props} />);
	await waitFor(() =>
		expect(props.sendRequest).toHaveBeenCalledWith('get_auto_run_document', {
			sessionId: 'session-1',
			filename: 'daily.md',
		})
	);
	await waitFor(() => expect(screen.queryByText('Loading document...')).not.toBeInTheDocument());
	return props;
}

describe('AutoRunInline — empty-state Docs Overview CTAs', () => {
	beforeEach(() => {
		resetAutoRunMock();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('renders the "+ Create document" CTA in the empty state', () => {
		render(<AutoRunInline {...createProps()} />);
		expect(screen.getByRole('button', { name: /Create document/i })).toBeInTheDocument();
	});

	it('hides the "Browse Playbook Exchange" CTA when onOpenMarketplace is omitted', () => {
		render(<AutoRunInline {...createProps()} />);
		expect(
			screen.queryByRole('button', { name: /Browse Playbook Exchange/i })
		).not.toBeInTheDocument();
	});

	it('renders the "Browse Playbook Exchange" CTA when onOpenMarketplace is provided', () => {
		const onOpenMarketplace = vi.fn();
		render(<AutoRunInline {...createProps({ onOpenMarketplace })} />);
		expect(screen.getByRole('button', { name: /Browse Playbook Exchange/i })).toBeInTheDocument();
	});

	it('invokes onOpenMarketplace when the CTA is clicked', () => {
		const onOpenMarketplace = vi.fn();
		render(<AutoRunInline {...createProps({ onOpenMarketplace })} />);
		fireEvent.click(screen.getByRole('button', { name: /Browse Playbook Exchange/i }));
		expect(onOpenMarketplace).toHaveBeenCalledTimes(1);
	});

	it('shows loading state and opens help from the empty toolbar', async () => {
		autoRunMock.isLoadingDocs = true;
		const onOpenSetup = vi.fn();
		const { rerender } = render(<AutoRunInline {...createProps({ onOpenSetup })} />);

		expect(screen.getByText('Loading documents...')).toBeInTheDocument();

		autoRunMock.isLoadingDocs = false;
		rerender(<AutoRunInline {...createProps({ onOpenSetup })} />);
		fireEvent.click(screen.getByRole('button', { name: 'Open Auto Run help' }));

		expect(screen.getByRole('dialog')).toHaveTextContent('Auto Run — quick reference');
		expect(screen.getByText('Document selector')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Close help' }));
		await waitFor(() =>
			expect(screen.queryByText('Auto Run — quick reference')).not.toBeInTheDocument()
		);
	});

	it('normalizes a created document name, reloads docs, and selects the new document', async () => {
		const props = createProps({}, { 'loop/step-1.md': '' });
		render(<AutoRunInline {...props} />);

		fireEvent.click(screen.getByRole('button', { name: /Create document/i }));
		fireEvent.change(screen.getByPlaceholderText('my-tasks'), {
			target: { value: 'loop/step-1' },
		});
		fireEvent.click(screen.getByRole('button', { name: 'Create' }));

		await waitFor(() =>
			expect(autoRunMock.saveDocumentContent).toHaveBeenCalledWith(
				'session-1',
				'loop/step-1.md',
				''
			)
		);
		expect(autoRunMock.loadDocuments).toHaveBeenCalledWith('session-1');
		await waitFor(() =>
			expect(props.sendRequest).toHaveBeenCalledWith('get_auto_run_document', {
				sessionId: 'session-1',
				filename: 'loop/step-1.md',
			})
		);
	});

	it('blocks duplicate document names and reports create failures', async () => {
		autoRunMock.documents = [doc()];
		autoRunMock.saveDocumentContent.mockResolvedValueOnce(false);
		const props = createProps();
		render(<AutoRunInline {...props} />);
		await waitFor(() => expect(props.sendRequest).toHaveBeenCalled());

		fireEvent.click(screen.getByRole('button', { name: 'Create new document' }));
		fireEvent.change(screen.getByPlaceholderText('my-tasks'), { target: { value: 'daily.md' } });
		expect(screen.getByText('A document with this name already exists.')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
		expect(autoRunMock.saveDocumentContent).not.toHaveBeenCalled();

		fireEvent.change(screen.getByPlaceholderText('my-tasks'), { target: { value: 'weekly' } });
		fireEvent.click(screen.getByRole('button', { name: 'Create' }));

		await waitFor(() => expect(screen.getByText('Could not create document')).toBeInTheDocument());
		expect(autoRunMock.saveDocumentContent).toHaveBeenCalledWith('session-1', 'weekly.md', '');
	});
});

describe('AutoRunInline — document workflows', () => {
	beforeEach(() => {
		resetAutoRunMock();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('auto-selects the first document and loads its content', async () => {
		const onSelectedDocumentChange = vi.fn();
		await renderWithDocument('- [x] Done\n- [ ] Todo', { onSelectedDocumentChange });

		expect(onSelectedDocumentChange).toHaveBeenLastCalledWith('daily');
		expect(screen.getByTestId('markdown-renderer')).toHaveTextContent('Done');
		expect(document.body).toHaveTextContent('1');
		expect(document.body).toHaveTextContent('of');
		expect(document.body).toHaveTextContent('2');
		expect(document.body).toHaveTextContent('tasks');
	});

	it('edits and saves the selected document', async () => {
		await renderWithDocument('Initial draft');

		fireEvent.click(screen.getByRole('button', { name: /Edit/i }));
		const textarea = screen.getByPlaceholderText('Capture notes and tasks in Markdown.');
		fireEvent.change(textarea, { target: { value: 'Initial draft\nUpdated' } });
		fireEvent.click(screen.getByRole('button', { name: 'Save' }));

		await waitFor(() =>
			expect(autoRunMock.saveDocumentContent).toHaveBeenCalledWith(
				'session-1',
				'daily.md',
				'Initial draft\nUpdated'
			)
		);
		expect(autoRunMock.loadDocuments).toHaveBeenCalledWith('session-1');
	});

	it('reports document load and save failures without clearing the editor', async () => {
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
		autoRunMock.documents = [doc()];
		const props = createProps({
			sendRequest: vi.fn().mockRejectedValueOnce(new Error('load failed')),
		});
		const failedView = render(<AutoRunInline {...props} />);

		await waitFor(() => expect(screen.getByText('Failed to load document')).toBeInTheDocument());
		expect(consoleError).toHaveBeenCalled();
		failedView.unmount();

		const saveProps = await renderWithDocument('Initial draft');
		autoRunMock.saveDocumentContent.mockResolvedValueOnce(false);
		fireEvent.click(screen.getByRole('button', { name: /Edit/i }));
		fireEvent.change(screen.getByPlaceholderText('Capture notes and tasks in Markdown.'), {
			target: { value: 'Initial draft\nUnsaved' },
		});
		fireEvent.click(screen.getByRole('button', { name: 'Save' }));

		await waitFor(() => expect(screen.getByText('Save failed')).toBeInTheDocument());
		expect(autoRunMock.saveDocumentContent).toHaveBeenCalledWith(
			saveProps.sessionId,
			'daily.md',
			'Initial draft\nUnsaved'
		);
	});

	it('supports undo, redo, and revert while editing dirty content', async () => {
		await renderWithDocument('Initial draft');

		fireEvent.click(screen.getByRole('button', { name: /Edit/i }));
		const textarea = screen.getByPlaceholderText('Capture notes and tasks in Markdown.');
		fireEvent.change(textarea, { target: { value: 'Changed draft' } });

		fireEvent.click(screen.getByTitle('Undo (Cmd+Z)'));
		expect(textarea).toHaveValue('Initial draft');

		fireEvent.click(screen.getByTitle('Redo (Shift+Cmd+Z)'));
		expect(textarea).toHaveValue('Changed draft');

		fireEvent.click(screen.getByText('Revert'));
		expect(textarea).toHaveValue('Initial draft');
		expect(screen.queryByText('Revert')).not.toBeInTheDocument();
	});

	it('resets completed tasks through the server fallback when direct save fails', async () => {
		vi.spyOn(window, 'confirm').mockReturnValue(true);
		autoRunMock.saveDocumentContent.mockResolvedValueOnce(false);
		autoRunMock.resetDocumentTasks.mockResolvedValueOnce(true);
		await renderWithDocument('- [x] Done\n- [ ] Todo');

		fireEvent.click(screen.getByLabelText('Reset completed tasks'));

		await waitFor(() =>
			expect(autoRunMock.saveDocumentContent).toHaveBeenCalledWith(
				'session-1',
				'daily.md',
				'- [ ] Done\n- [ ] Todo'
			)
		);
		expect(autoRunMock.resetDocumentTasks).toHaveBeenCalledWith('session-1', 'daily.md');
	});

	it('reports reset failures when both reset paths fail', async () => {
		vi.spyOn(window, 'confirm').mockReturnValue(true);
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
		autoRunMock.saveDocumentContent.mockRejectedValueOnce(new Error('save reset failed'));
		await renderWithDocument('- [x] Done\n- [ ] Todo');

		fireEvent.click(screen.getByLabelText('Reset completed tasks'));

		await waitFor(() => expect(screen.getByText('Reset failed')).toBeInTheDocument());
		expect(consoleError).toHaveBeenCalled();
	});

	it('opens search, reports matches, and advances through them', async () => {
		await renderWithDocument('alpha\nbeta\nalpha');

		fireEvent.click(screen.getByRole('button', { name: /Search/i }));
		fireEvent.change(screen.getByPlaceholderText('Find in document...'), {
			target: { value: 'alpha' },
		});

		expect(screen.getByText('1/2')).toBeInTheDocument();
		fireEvent.click(screen.getByLabelText('Next match'));
		await waitFor(() => expect(screen.getByText('2/2')).toBeInTheDocument());
		fireEvent.click(screen.getByLabelText('Previous match'));
		await waitFor(() => expect(screen.getByText('1/2')).toBeInTheDocument());
	});

	it('uses edit-mode keyboard shortcuts for search, save, undo, and redo', async () => {
		await renderWithDocument('alpha\nbeta');

		fireEvent.click(screen.getByRole('button', { name: /Edit/i }));
		const textarea = screen.getByPlaceholderText('Capture notes and tasks in Markdown.');
		textarea.focus();
		fireEvent.change(textarea, { target: { value: 'alpha\nbeta\ngamma' } });

		fireEvent.keyDown(textarea, { key: 'f', metaKey: true });
		expect(screen.getByPlaceholderText('Find in document...')).toBeInTheDocument();
		fireEvent.change(screen.getByPlaceholderText('Find in document...'), {
			target: { value: 'beta' },
		});
		fireEvent.keyDown(screen.getByPlaceholderText('Find in document...'), { key: 'Enter' });

		fireEvent.keyDown(textarea, { key: 'z', metaKey: true });
		expect(textarea).toHaveValue('alpha\nbeta');
		fireEvent.keyDown(textarea, { key: 'z', metaKey: true, shiftKey: true });
		expect(textarea).toHaveValue('alpha\nbeta\ngamma');

		fireEvent.keyDown(textarea, { key: 's', metaKey: true });
		await waitFor(() =>
			expect(autoRunMock.saveDocumentContent).toHaveBeenCalledWith(
				'session-1',
				'daily.md',
				'alpha\nbeta\ngamma'
			)
		);
	});

	it('refreshes and switches documents through the selector, respecting dirty confirmation', async () => {
		autoRunMock.documents = [
			doc({ filename: 'daily', path: 'daily', taskCount: 2, completedCount: 2 }),
			doc({
				filename: 'other',
				path: 'folder/other',
				folder: 'folder',
				taskCount: 1,
				completedCount: 0,
			}),
		];
		const confirm = vi.spyOn(window, 'confirm');
		const props = createProps(
			{},
			{
				'daily.md': 'Daily draft',
				'folder/other.md': 'Other draft',
			}
		);
		render(<AutoRunInline {...props} />);
		await waitFor(() =>
			expect(props.sendRequest).toHaveBeenCalledWith('get_auto_run_document', {
				sessionId: 'session-1',
				filename: 'daily.md',
			})
		);

		autoRunMock.loadDocuments.mockClear();
		fireEvent.click(screen.getByLabelText('Refresh document list'));
		expect(autoRunMock.loadDocuments).toHaveBeenCalledWith('session-1');

		fireEvent.click(screen.getByRole('button', { name: /Edit/i }));
		fireEvent.change(screen.getByPlaceholderText('Capture notes and tasks in Markdown.'), {
			target: { value: 'Dirty daily draft' },
		});

		fireEvent.click(screen.getByText('daily.md'));
		const listbox = screen.getByRole('listbox');
		fireEvent.click(within(listbox).getByText('folder'));
		confirm.mockReturnValueOnce(false);
		fireEvent.click(within(listbox).getByText('other.md'));
		expect(props.sendRequest).not.toHaveBeenCalledWith('get_auto_run_document', {
			sessionId: 'session-1',
			filename: 'folder/other.md',
		});

		confirm.mockReturnValueOnce(true);
		fireEvent.click(within(listbox).getByText('other.md'));
		await waitFor(() =>
			expect(props.sendRequest).toHaveBeenCalledWith('get_auto_run_document', {
				sessionId: 'session-1',
				filename: 'folder/other.md',
			})
		);
	});

	it('opens setup, folder picker, expand, and error-pause recovery actions', async () => {
		const onOpenSetup = vi.fn();
		const onOpenFolderPicker = vi.fn();
		const onExpandDocument = vi.fn();
		const onResumeAfterError = vi.fn();
		const onSkipAfterError = vi.fn();
		const onAbortAfterError = vi.fn();
		const errorPausedState: AutoRunState = {
			isRunning: false,
			errorPaused: true,
			totalTasks: 3,
			completedTasks: 1,
			currentTaskIndex: 1,
		};
		await renderWithDocument('- [ ] Todo', {
			autoRunState: errorPausedState,
			onOpenSetup,
			onOpenFolderPicker,
			onExpandDocument,
			onResumeAfterError,
			onSkipAfterError,
			onAbortAfterError,
		});

		fireEvent.click(screen.getByRole('button', { name: 'Configure and launch Auto Run' }));
		fireEvent.click(screen.getByRole('button', { name: 'Open PlayBooks setup' }));
		fireEvent.click(screen.getByLabelText('Change Auto Run folder'));
		fireEvent.click(screen.getByText('Expand'));
		fireEvent.click(screen.getByText('Resume after error'));
		fireEvent.click(screen.getByText('Skip document'));
		fireEvent.click(screen.getByText('Abort run'));

		expect(onOpenSetup).toHaveBeenCalledTimes(2);
		expect(onOpenFolderPicker).toHaveBeenCalledTimes(1);
		expect(onExpandDocument).toHaveBeenCalledWith('daily');
		expect(onResumeAfterError).toHaveBeenCalledTimes(1);
		expect(onSkipAfterError).toHaveBeenCalledTimes(1);
		expect(onAbortAfterError).toHaveBeenCalledTimes(1);
	});

	it('stops a running Auto Run and keeps editing locked', async () => {
		const runningState: AutoRunState = {
			isRunning: true,
			totalTasks: 2,
			completedTasks: 1,
			currentTaskIndex: 1,
		};
		await renderWithDocument('- [ ] Todo', { autoRunState: runningState });

		fireEvent.click(screen.getByRole('button', { name: 'Stop Auto Run' }));
		expect(autoRunMock.stopAutoRun).toHaveBeenCalledWith('session-1');
		expect(screen.getByRole('button', { name: /Edit/i })).toBeDisabled();
	});

	it('auto-saves preview task checkbox toggles', async () => {
		await renderWithDocument('- [ ] Todo\n- [x] Done');

		fireEvent.click(screen.getByLabelText('Todo'));

		await waitFor(() =>
			expect(autoRunMock.saveDocumentContent).toHaveBeenCalledWith(
				'session-1',
				'daily.md',
				'- [x] Todo\n- [x] Done'
			)
		);
	});

	it('leaves locked preview checkboxes unchanged while Auto Run is active', async () => {
		const runningState: AutoRunState = {
			isRunning: true,
			totalTasks: 1,
			completedTasks: 0,
			currentTaskIndex: 0,
		};
		await renderWithDocument('- [ ] Todo', { autoRunState: runningState });

		fireEvent.click(screen.getByLabelText('Todo'));

		expect(autoRunMock.saveDocumentContent).not.toHaveBeenCalled();
	});
});
