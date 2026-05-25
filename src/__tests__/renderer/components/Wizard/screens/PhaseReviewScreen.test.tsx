/**
 * @file PhaseReviewScreen.test.tsx
 * @description Focused behavior tests for the wizard phase review screen.
 */

import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PhaseReviewScreen } from '../../../../../renderer/components/Wizard/screens/PhaseReviewScreen';
import {
	WizardProvider,
	useWizard,
	type GeneratedDocument,
	type WizardMessage,
} from '../../../../../renderer/components/Wizard/WizardContext';
import type { Theme } from '../../../../../renderer/types';

const editorMockState = vi.hoisted(() => ({
	lastProps: undefined as any,
}));

vi.mock('lucide-react', () => ({
	Loader2: ({ className }: { className?: string }) => (
		<svg data-testid="loader-icon" className={className} />
	),
	Rocket: ({ className }: { className?: string }) => (
		<svg data-testid="rocket-icon" className={className} />
	),
	Compass: ({ className }: { className?: string }) => (
		<svg data-testid="compass-icon" className={className} />
	),
	X: ({ className }: { className?: string }) => <svg data-testid="x-icon" className={className} />,
}));

vi.mock('../../../../../renderer/components/Wizard/shared/DocumentEditor', () => ({
	DocumentEditor: (props: any) => {
		editorMockState.lastProps = props;
		return (
			<div data-testid="document-editor" data-mode={props.mode}>
				<div data-testid="editor-content">{props.content}</div>
				<div data-testid="editor-stats">{props.statsText}</div>
				<div data-testid="selected-doc">{props.selectedFile}</div>
				<div data-testid="attachment-count">{props.attachments.length}</div>
				<textarea ref={props.textareaRef} aria-label="mock editor textarea" />
				<div ref={props.previewRef} tabIndex={-1} data-testid="mock preview" />
				<button onClick={() => props.onModeChange('edit')}>Editor edit</button>
				<button onClick={() => props.onModeChange('preview')}>Editor preview</button>
				<button onClick={() => props.onContentChange('# Phase 1\n\n- [x] Updated')}>
					Editor change
				</button>
				<button onClick={() => props.onDocumentSelect(1)}>Editor select second</button>
				<button onClick={() => props.onAddAttachment('images/a.png', 'data:image/png;base64,a')}>
					Editor add attachment
				</button>
				<button onClick={() => void props.onRemoveAttachment('images/a.png')}>
					Editor remove attachment
				</button>
				<button onClick={() => props.onDropdownOpenChange(true)}>Editor open dropdown</button>
			</div>
		);
	},
}));

const originalMaestro = window.maestro;

const mockTheme: Theme = {
	id: 'test',
	name: 'Test',
	mode: 'dark',
	colors: {
		bgMain: '#111111',
		bgSidebar: '#1a1a1a',
		bgActivity: '#222222',
		border: '#333333',
		textMain: '#ffffff',
		textDim: '#999999',
		textFaint: '#666666',
		accent: '#4a9eff',
		accentForeground: '#ffffff',
		buttonBg: '#333333',
		buttonHover: '#444444',
		headerBg: '#181818',
		scrollbarTrack: '#111111',
		scrollbarThumb: '#444444',
		success: '#22c55e',
		warning: '#f59e0b',
		error: '#ef4444',
	},
};

const defaultDocuments: GeneratedDocument[] = [
	{
		filename: 'Phase-01-Setup.md',
		content: '# Phase 1\n\n![a.png](images/a.png)\n- [ ] Task 1',
		taskCount: 1,
	},
	{
		filename: 'Phase-02-Build.md',
		content: '# Phase 2\n\n- [ ] Task 2\n- [x] Task 3',
		taskCount: 2,
	},
];

const defaultConversation: WizardMessage[] = [
	{ id: 'u1', role: 'user', content: 'Build it', timestamp: 1 },
	{ id: 'a1', role: 'assistant', content: 'Yes', timestamp: 2 },
	{ id: 'u2', role: 'user', content: 'Make it useful', timestamp: 3 },
];

const setupMaestroMock = () => {
	const maestro = {
		autorun: {
			writeDoc: vi.fn().mockResolvedValue(undefined),
			deleteImage: vi.fn().mockResolvedValue(undefined),
		},
		settings: {
			set: vi.fn().mockResolvedValue(undefined),
		},
	};

	window.maestro = maestro as unknown as typeof window.maestro;
	return maestro;
};

const createDeferred = <T,>() => {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
};

function PhaseReviewHarness({
	documents = defaultDocuments,
	conversation = defaultConversation,
	onLaunchSession = vi.fn().mockResolvedValue(undefined),
	onWizardComplete,
	wizardStartTime,
	initialDocumentIndex = 0,
}: {
	documents?: GeneratedDocument[];
	conversation?: WizardMessage[];
	onLaunchSession?: (wantsTour: boolean) => Promise<void>;
	onWizardComplete?: (
		durationMs: number,
		conversationExchanges: number,
		phasesGenerated: number,
		tasksGenerated: number
	) => void;
	wizardStartTime?: number;
	initialDocumentIndex?: number;
}) {
	const {
		setDirectoryPath,
		setConversationHistory,
		setGeneratedDocuments,
		setCurrentDocumentIndex,
		goToStep,
	} = useWizard();
	const [ready, setReady] = React.useState(false);

	React.useEffect(() => {
		setDirectoryPath('/repo');
		setConversationHistory(conversation);
		setGeneratedDocuments(documents);
		setCurrentDocumentIndex(initialDocumentIndex);
		goToStep('phase-review');
		setReady(true);
	}, [
		conversation,
		documents,
		goToStep,
		initialDocumentIndex,
		setConversationHistory,
		setCurrentDocumentIndex,
		setDirectoryPath,
		setGeneratedDocuments,
	]);

	return ready ? (
		<PhaseReviewScreen
			theme={mockTheme}
			onLaunchSession={onLaunchSession}
			onWizardComplete={onWizardComplete}
			wizardStartTime={wizardStartTime}
		/>
	) : null;
}

const renderPhaseReview = (props: React.ComponentProps<typeof PhaseReviewHarness> = {}) =>
	render(
		<WizardProvider>
			<PhaseReviewHarness {...props} />
		</WizardProvider>
	);

describe('PhaseReviewScreen', () => {
	beforeEach(() => {
		editorMockState.lastProps = undefined;
		setupMaestroMock();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		window.maestro = originalMaestro;
	});

	it('redirects back when no generated documents are available', async () => {
		renderPhaseReview({ documents: [] });

		expect(await screen.findByText('Redirecting...')).toBeInTheDocument();
		expect(screen.queryByTestId('document-editor')).not.toBeInTheDocument();
	});

	it('announces ready documents and passes multi-document stats to the editor', async () => {
		renderPhaseReview();

		expect(await screen.findByTestId('document-editor')).toBeInTheDocument();
		expect(screen.getByText(/2 Playbooks ready with 3 tasks total/)).toBeInTheDocument();
		expect(screen.getByTestId('editor-stats')).toHaveTextContent(
			'3 total tasks • 2 documents • 1 tasks in this document'
		);
		expect(screen.getByTestId('selected-doc')).toHaveTextContent('Phase-01-Setup');
	});

	it('uses singular stats text when there is only one generated document', async () => {
		renderPhaseReview({ documents: [defaultDocuments[0]] });

		expect(await screen.findByTestId('editor-stats')).toHaveTextContent('1 tasks ready to run');
	});

	it('uses zero-task stats text when the document contains no task markers', async () => {
		renderPhaseReview({
			documents: [{ filename: 'Notes.md', content: '# Notes only', taskCount: 0 }],
		});

		expect(await screen.findByTestId('editor-stats')).toHaveTextContent('0 tasks ready to run');
	});

	it('falls back to the first generated document for an out-of-range document index', async () => {
		renderPhaseReview({ initialDocumentIndex: 99 });

		expect(await screen.findByTestId('selected-doc')).toHaveTextContent('Phase-01-Setup');
		expect(screen.getByTestId('editor-content')).toHaveTextContent('# Phase 1');
	});

	it('handles empty content in a selected non-Phase-1 document', async () => {
		renderPhaseReview({
			documents: [defaultDocuments[0], { filename: 'Empty.md', content: '', taskCount: 0 }],
			initialDocumentIndex: 1,
		});

		expect(await screen.findByTestId('selected-doc')).toHaveTextContent('Empty');
		expect(editorMockState.lastProps.content).toBe('');
	});

	it('switches documents from editor callbacks and keyboard shortcuts', async () => {
		renderPhaseReview();
		await screen.findByTestId('document-editor');

		fireEvent.click(screen.getByText('Editor select second'));

		await waitFor(() => {
			expect(screen.getByTestId('selected-doc')).toHaveTextContent('Phase-02-Build');
			expect(screen.getByTestId('editor-content')).toHaveTextContent('# Phase 2');
		});

		fireEvent.keyDown(window, { key: '[', metaKey: true, shiftKey: true });

		await waitFor(() => {
			expect(screen.getByTestId('selected-doc')).toHaveTextContent('Phase-01-Setup');
		});

		fireEvent.keyDown(window, { key: ']', metaKey: true, shiftKey: true });

		await waitFor(() => {
			expect(screen.getByTestId('selected-doc')).toHaveTextContent('Phase-02-Build');
		});
	});

	it('wraps to the final document from the first document and ignores unrelated cycle keys', async () => {
		renderPhaseReview();
		await screen.findByTestId('document-editor');

		fireEvent.keyDown(window, { key: '[', metaKey: true, shiftKey: true });

		await waitFor(() => {
			expect(screen.getByTestId('selected-doc')).toHaveTextContent('Phase-02-Build');
		});

		fireEvent.keyDown(window, { key: 'x', metaKey: true, shiftKey: true });
		expect(screen.getByTestId('selected-doc')).toHaveTextContent('Phase-02-Build');
	});

	it('toggles editor mode from global keyboard shortcuts and closes the dropdown on Escape', async () => {
		renderPhaseReview();
		await screen.findByTestId('document-editor');
		await act(async () => {
			await Promise.resolve();
		});

		fireEvent.keyDown(window, { key: 'e', ctrlKey: true });

		await waitFor(() => {
			expect(screen.getByTestId('document-editor')).toHaveAttribute('data-mode', 'edit');
		});

		fireEvent.keyDown(window, { key: 'e', ctrlKey: true });

		await waitFor(() => {
			expect(screen.getByTestId('document-editor')).toHaveAttribute('data-mode', 'preview');
		});

		fireEvent.click(screen.getByText('Editor preview'));

		await waitFor(() => {
			expect(screen.getByTestId('document-editor')).toHaveAttribute('data-mode', 'preview');
		});

		fireEvent.click(screen.getByText('Editor open dropdown'));

		await waitFor(() => {
			expect(editorMockState.lastProps.isDropdownOpen).toBe(true);
		});

		fireEvent.keyDown(window, { key: 'Escape' });

		await waitFor(() => {
			expect(editorMockState.lastProps.isDropdownOpen).toBe(false);
		});
	});

	it('auto-saves edited Phase 1 content after the debounce delay', async () => {
		const maestro = setupMaestroMock();
		renderPhaseReview();
		await screen.findByTestId('document-editor');
		vi.useFakeTimers();

		fireEvent.click(screen.getByText('Editor change'));

		await act(async () => {
			vi.advanceTimersByTime(2000);
			await Promise.resolve();
		});

		expect(maestro.autorun.writeDoc).toHaveBeenCalledWith(
			'/repo/Auto Run Docs',
			'Phase-01-Setup.md',
			'# Phase 1\n\n- [x] Updated'
		);
	});

	it('auto-saves edited non-Phase-1 document content without updating Phase 1 text', async () => {
		const maestro = setupMaestroMock();
		renderPhaseReview({ initialDocumentIndex: 1 });
		await screen.findByTestId('document-editor');
		vi.useFakeTimers();

		act(() => {
			editorMockState.lastProps.onContentChange('# Phase 2\n\n- [x] Updated second doc');
		});

		await act(async () => {
			vi.advanceTimersByTime(2000);
			await Promise.resolve();
		});

		expect(maestro.autorun.writeDoc).toHaveBeenCalledWith(
			'/repo/Auto Run Docs',
			'Phase-02-Build.md',
			'# Phase 2\n\n- [x] Updated second doc'
		);
		expect(screen.getByTestId('editor-content')).toHaveTextContent('Updated second doc');
	});

	it('clears a pending auto-save timer when the screen unmounts', async () => {
		const maestro = setupMaestroMock();
		const { unmount } = renderPhaseReview();
		await screen.findByTestId('document-editor');
		vi.useFakeTimers();

		fireEvent.click(screen.getByText('Editor change'));
		unmount();

		await act(async () => {
			vi.advanceTimersByTime(2000);
			await Promise.resolve();
		});

		expect(maestro.autorun.writeDoc).not.toHaveBeenCalled();
	});

	it('reports auto-save failures', async () => {
		const maestro = setupMaestroMock();
		const saveError = new Error('disk full');
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
		maestro.autorun.writeDoc.mockRejectedValueOnce(saveError);
		renderPhaseReview();
		await screen.findByTestId('document-editor');
		vi.useFakeTimers();

		fireEvent.click(screen.getByText('Editor change'));

		await act(async () => {
			vi.advanceTimersByTime(2000);
			await Promise.resolve();
		});

		expect(consoleError).toHaveBeenCalledWith('Auto-save failed:', saveError);
	});

	it('queues the latest edit while an auto-save is already in progress', async () => {
		const maestro = setupMaestroMock();
		const firstSave = createDeferred<void>();
		maestro.autorun.writeDoc
			.mockReturnValueOnce(firstSave.promise)
			.mockResolvedValueOnce(undefined);
		renderPhaseReview();
		await screen.findByTestId('document-editor');
		vi.useFakeTimers();

		act(() => {
			editorMockState.lastProps.onContentChange('# Phase 1\n\n- [ ] First edit');
		});
		await act(async () => {
			vi.advanceTimersByTime(2000);
			await Promise.resolve();
		});

		expect(maestro.autorun.writeDoc).toHaveBeenCalledTimes(1);

		act(() => {
			editorMockState.lastProps.onContentChange('# Phase 1\n\n- [ ] Queued edit');
		});
		await act(async () => {
			vi.advanceTimersByTime(2000);
			await Promise.resolve();
		});

		expect(maestro.autorun.writeDoc).toHaveBeenCalledTimes(1);

		await act(async () => {
			firstSave.resolve(undefined);
			await Promise.resolve();
			await Promise.resolve();
		});

		expect(maestro.autorun.writeDoc).toHaveBeenNthCalledWith(
			2,
			'/repo/Auto Run Docs',
			'Phase-01-Setup.md',
			'# Phase 1\n\n- [ ] Queued edit'
		);
	});

	it('reports pending auto-save failures after the active save completes', async () => {
		const maestro = setupMaestroMock();
		const firstSave = createDeferred<void>();
		const pendingError = new Error('pending disk full');
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
		maestro.autorun.writeDoc
			.mockReturnValueOnce(firstSave.promise)
			.mockRejectedValueOnce(pendingError);
		renderPhaseReview();
		await screen.findByTestId('document-editor');
		vi.useFakeTimers();

		act(() => {
			editorMockState.lastProps.onContentChange('# Phase 1\n\n- [ ] First edit');
		});
		await act(async () => {
			vi.advanceTimersByTime(2000);
			await Promise.resolve();
		});

		act(() => {
			editorMockState.lastProps.onContentChange('# Phase 1\n\n- [ ] Queued edit');
		});
		await act(async () => {
			vi.advanceTimersByTime(2000);
			await Promise.resolve();
		});

		await act(async () => {
			firstSave.resolve(undefined);
			await Promise.resolve();
			await Promise.resolve();
		});

		expect(maestro.autorun.writeDoc).toHaveBeenCalledTimes(2);
		expect(consoleError).toHaveBeenCalledWith('Auto-save (pending) failed:', pendingError);
	});

	it('saves pending non-Phase-1 edits after the active save completes', async () => {
		const maestro = setupMaestroMock();
		const firstSave = createDeferred<void>();
		maestro.autorun.writeDoc
			.mockReturnValueOnce(firstSave.promise)
			.mockResolvedValueOnce(undefined);
		renderPhaseReview({ initialDocumentIndex: 1 });
		await screen.findByTestId('document-editor');
		vi.useFakeTimers();

		act(() => {
			editorMockState.lastProps.onContentChange('# Phase 2\n\n- [ ] First edit');
		});
		await act(async () => {
			vi.advanceTimersByTime(2000);
			await Promise.resolve();
		});

		act(() => {
			editorMockState.lastProps.onContentChange('# Phase 2\n\n- [x] Pending second edit');
		});
		await act(async () => {
			vi.advanceTimersByTime(2000);
			await Promise.resolve();
		});

		await act(async () => {
			firstSave.resolve(undefined);
			await Promise.resolve();
			await Promise.resolve();
		});

		expect(maestro.autorun.writeDoc).toHaveBeenNthCalledWith(
			2,
			'/repo/Auto Run Docs',
			'Phase-02-Build.md',
			'# Phase 2\n\n- [x] Pending second edit'
		);
	});

	it('removes attachments from disk and strips their markdown reference', async () => {
		const maestro = setupMaestroMock();
		renderPhaseReview();
		await screen.findByTestId('document-editor');

		fireEvent.click(screen.getByText('Editor add attachment'));
		expect(screen.getByTestId('attachment-count')).toHaveTextContent('1');

		fireEvent.click(screen.getByText('Editor remove attachment'));

		await waitFor(() => {
			expect(maestro.autorun.deleteImage).toHaveBeenCalledWith(
				'/repo/Auto Run Docs',
				'images/a.png'
			);
			expect(screen.getByTestId('editor-content')).not.toHaveTextContent('![a.png](images/a.png)');
		});
	});

	it('removes trailing-slash attachment paths without filename segments', async () => {
		const maestro = setupMaestroMock();
		renderPhaseReview();
		await screen.findByTestId('document-editor');

		act(() => {
			editorMockState.lastProps.onAddAttachment('images/', 'data:image/png;base64,a');
		});
		expect(screen.getByTestId('attachment-count')).toHaveTextContent('1');

		await act(async () => {
			await editorMockState.lastProps.onRemoveAttachment('images/');
		});

		expect(maestro.autorun.deleteImage).toHaveBeenCalledWith('/repo/Auto Run Docs', 'images/');
	});

	it('saves dirty content, records analytics, and launches with the selected tour mode', async () => {
		const maestro = setupMaestroMock();
		const onLaunchSession = vi.fn().mockResolvedValue(undefined);
		const onWizardComplete = vi.fn();
		vi.spyOn(Date, 'now').mockReturnValue(9000);
		renderPhaseReview({ onLaunchSession, onWizardComplete, wizardStartTime: 5000 });
		await screen.findByTestId('document-editor');

		fireEvent.click(screen.getByText('Editor change'));
		fireEvent.click(screen.getByRole('button', { name: /walk me through/i }));

		await waitFor(() => {
			expect(onLaunchSession).toHaveBeenCalledWith(true);
		});
		expect(maestro.autorun.writeDoc).toHaveBeenCalledWith(
			'/repo/Auto Run Docs',
			'Phase-01-Setup.md',
			'# Phase 1\n\n- [x] Updated'
		);
		expect(onWizardComplete).toHaveBeenCalledWith(4000, 2, 2, 3);
		expect(screen.getByRole('button', { name: /launching/i })).toBeDisabled();
	});

	it('launches clean content and records zero duration when no start time is provided', async () => {
		const maestro = setupMaestroMock();
		const onLaunchSession = vi.fn().mockResolvedValue(undefined);
		const onWizardComplete = vi.fn();
		renderPhaseReview({ onLaunchSession, onWizardComplete });
		await screen.findByTestId('document-editor');

		fireEvent.click(screen.getByRole('button', { name: /ready to go/i }));

		await waitFor(() => {
			expect(onLaunchSession).toHaveBeenCalledWith(false);
		});
		expect(maestro.autorun.writeDoc).not.toHaveBeenCalled();
		expect(onWizardComplete).toHaveBeenCalledWith(0, 2, 2, 3);
	});

	it('saves dirty non-Phase-1 content before launching', async () => {
		const maestro = setupMaestroMock();
		const onLaunchSession = vi.fn().mockResolvedValue(undefined);
		renderPhaseReview({ onLaunchSession, initialDocumentIndex: 1 });
		await screen.findByTestId('document-editor');

		act(() => {
			editorMockState.lastProps.onContentChange('# Phase 2\n\n- [x] Launch this');
		});
		fireEvent.click(screen.getByRole('button', { name: /ready to go/i }));

		await waitFor(() => {
			expect(onLaunchSession).toHaveBeenCalledWith(false);
		});
		expect(maestro.autorun.writeDoc).toHaveBeenCalledWith(
			'/repo/Auto Run Docs',
			'Phase-02-Build.md',
			'# Phase 2\n\n- [x] Launch this'
		);
	});

	it('does not duplicate the final launch save when the debounce timer fires later', async () => {
		const maestro = setupMaestroMock();
		const onLaunchSession = vi.fn().mockResolvedValue(undefined);
		renderPhaseReview({ onLaunchSession });
		await screen.findByTestId('document-editor');
		vi.useFakeTimers();

		fireEvent.click(screen.getByText('Editor change'));
		await act(async () => {
			fireEvent.click(screen.getByRole('button', { name: /ready to go/i }));
			await Promise.resolve();
			await Promise.resolve();
		});
		expect(onLaunchSession).toHaveBeenCalledWith(false);

		await act(async () => {
			vi.advanceTimersByTime(2000);
			await Promise.resolve();
		});

		expect(maestro.autorun.writeDoc).toHaveBeenCalledTimes(1);
	});

	it('handles Tab focus movement and Enter activation for launch buttons', async () => {
		const onLaunchSession = vi.fn().mockResolvedValue(undefined);
		renderPhaseReview({ onLaunchSession });
		await screen.findByTestId('document-editor');
		const container = document.querySelector('[tabindex="-1"]') as HTMLElement;
		const readyButton = screen.getByRole('button', { name: /ready to go/i });
		const tourButton = screen.getByRole('button', { name: /walk me through/i });

		readyButton.focus();
		fireEvent.keyDown(container, { key: 'Tab' });
		expect(tourButton).toHaveFocus();

		fireEvent.keyDown(container, { key: 'Tab', shiftKey: true });
		expect(readyButton).toHaveFocus();

		fireEvent.keyDown(container, { key: 'Enter' });

		await waitFor(() => {
			expect(onLaunchSession).toHaveBeenCalledWith(false);
		});
	});

	it('ignores inactive Tab and Enter keyboard paths', async () => {
		const onLaunchSession = vi.fn().mockResolvedValue(undefined);
		renderPhaseReview({ onLaunchSession });
		await screen.findByTestId('document-editor');
		const container = document.querySelector('[tabindex="-1"]') as HTMLElement;
		const readyButton = screen.getByRole('button', { name: /ready to go/i });
		const tourButton = screen.getByRole('button', { name: /walk me through/i });

		readyButton.focus();
		fireEvent.keyDown(container, { key: 'Tab', shiftKey: true });
		expect(readyButton).toHaveFocus();

		tourButton.focus();
		fireEvent.keyDown(container, { key: 'Tab' });
		expect(tourButton).toHaveFocus();

		container.focus();
		fireEvent.keyDown(container, { key: 'Enter' });
		expect(onLaunchSession).not.toHaveBeenCalled();
	});

	it('activates the guided tour launch button with Enter when it has focus', async () => {
		const onLaunchSession = vi.fn().mockResolvedValue(undefined);
		renderPhaseReview({ onLaunchSession });
		await screen.findByTestId('document-editor');
		const container = document.querySelector('[tabindex="-1"]') as HTMLElement;
		const tourButton = screen.getByRole('button', { name: /walk me through/i });

		tourButton.focus();
		fireEvent.keyDown(container, { key: 'Enter' });

		await waitFor(() => {
			expect(onLaunchSession).toHaveBeenCalledWith(true);
		});
	});

	it('shows and dismisses launch errors while re-enabling launch buttons', async () => {
		const onLaunchSession = vi.fn().mockRejectedValue(new Error('launch denied'));
		renderPhaseReview({ onLaunchSession });
		await screen.findByTestId('document-editor');

		fireEvent.click(screen.getByRole('button', { name: /ready to go/i }));

		expect(await screen.findByText('launch denied')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: /ready to go/i })).not.toBeDisabled();

		const dismissButton = screen.getByTestId('x-icon').closest('button');
		expect(dismissButton).toBeInTheDocument();
		fireEvent.click(dismissButton!);

		await waitFor(() => {
			expect(screen.queryByText('launch denied')).not.toBeInTheDocument();
		});
	});

	it('shows the generic launch error for non-Error failures', async () => {
		const onLaunchSession = vi.fn().mockRejectedValue('denied');
		renderPhaseReview({ onLaunchSession });
		await screen.findByTestId('document-editor');

		fireEvent.click(screen.getByRole('button', { name: /ready to go/i }));

		expect(await screen.findByText('Failed to launch session')).toBeInTheDocument();
	});
});
