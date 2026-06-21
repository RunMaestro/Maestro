/**
 * @file PhaseReviewScreen.integration.test.tsx
 * @description Integration coverage for the wizard phase review screen and shared document editor.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PhaseReviewScreen } from '../../renderer/components/Wizard/screens/PhaseReviewScreen';
import {
	WizardProvider,
	useWizard,
	type GeneratedDocument,
	type WizardContextAPI,
	type WizardMessage,
	type WizardState,
} from '../../renderer/components/Wizard/WizardContext';
import { useSettingsStore } from '../../renderer/stores/settingsStore';
import { logger } from '../../renderer/utils/logger';
import { PLAYBOOKS_DIR } from '../../shared/maestro-paths';
import type { Theme } from '../../renderer/types';

const theme: Theme = {
	id: 'integration-dark',
	name: 'Integration Dark',
	mode: 'dark',
	colors: {
		bgMain: '#101114',
		bgSidebar: '#171a20',
		bgActivity: '#20242c',
		border: '#3f4654',
		textMain: '#f8fafc',
		textDim: '#94a3b8',
		accent: '#38bdf8',
		accentDim: '#38bdf820',
		accentText: '#f472b6',
		accentForeground: '#ffffff',
		success: '#22c55e',
		warning: '#f59e0b',
		error: '#ef4444',
	},
};

const generatedDocuments: GeneratedDocument[] = [
	{
		filename: 'Phase-01-Setup.md',
		content: '# Phase 1\n\nSee the [launch guide](https://example.com/launch).\n\n- [ ] Task 1',
		taskCount: 1,
	},
	{
		filename: 'Phase-02-Build.md',
		content: '# Phase 2\n\n- [ ] Task 2\n- [x] Task 3',
		taskCount: 2,
	},
];

const conversationHistory: WizardMessage[] = [
	{ id: 'u1', role: 'user', content: 'Build it', timestamp: 1 },
	{ id: 'a1', role: 'assistant', content: 'Ready', timestamp: 2 },
	{ id: 'u2', role: 'user', content: 'Make it testable', timestamp: 3 },
];

const playbooksPath = `/repo/${PLAYBOOKS_DIR}`;

function PhaseReviewHarness({
	initialState = {},
	onLaunchSession = vi.fn().mockResolvedValue(undefined),
	onWizardComplete,
	wizardStartTime,
	onWizard,
}: {
	initialState?: Partial<WizardState>;
	onLaunchSession?: (wantsTour: boolean) => Promise<void>;
	onWizardComplete?: (
		durationMs: number,
		conversationExchanges: number,
		phasesGenerated: number,
		tasksGenerated: number
	) => void;
	wizardStartTime?: number;
	onWizard?: (wizard: WizardContextAPI) => void;
}) {
	const wizard = useWizard();
	const [ready, setReady] = React.useState(false);

	React.useEffect(() => {
		wizard.restoreState({
			currentStep: 'phase-review',
			isOpen: true,
			selectedAgent: 'codex',
			agentName: 'Launch Project',
			directoryPath: '/repo',
			conversationHistory,
			generatedDocuments,
			currentDocumentIndex: 0,
			...initialState,
		});
		setReady(true);
	}, []);

	React.useEffect(() => {
		onWizard?.(wizard);
	});

	return ready ? (
		<PhaseReviewScreen
			theme={theme}
			onLaunchSession={onLaunchSession}
			onWizardComplete={onWizardComplete}
			wizardStartTime={wizardStartTime}
		/>
	) : null;
}

function renderPhaseReview(props: React.ComponentProps<typeof PhaseReviewHarness> = {}) {
	return render(
		<WizardProvider>
			<PhaseReviewHarness {...props} />
		</WizardProvider>
	);
}

function getEditorTextarea() {
	return screen.getByPlaceholderText(
		'Your task document will appear here...'
	) as HTMLTextAreaElement;
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((innerResolve) => {
		resolve = innerResolve;
	});
	return { promise, resolve };
}

describe('PhaseReviewScreen integration', () => {
	beforeEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
		useSettingsStore.setState({ bionifyReadingMode: false });

		vi.mocked(window.maestro.autorun.writeDoc).mockResolvedValue({ success: true });
		Object.assign(window.maestro.autorun, {
			saveImage: vi.fn().mockResolvedValue({
				success: true,
				relativePath: 'images/pasted-image.png',
			}),
			deleteImage: vi.fn().mockResolvedValue({ success: true }),
		});
		vi.mocked(window.maestro.shell.openExternal).mockResolvedValue(undefined);
	});

	afterEach(() => {
		cleanup();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('renders reviewed documents, opens preview links, switches documents, and handles keyboard navigation', async () => {
		renderPhaseReview();

		expect(await screen.findByText(/2 Playbooks ready with 3 tasks total/)).toBeInTheDocument();
		expect(
			screen.getByText('3 total tasks - 2 documents - 1 tasks in this document')
		).toBeInTheDocument();
		expect(screen.getByRole('heading', { name: 'Phase 1' })).toBeInTheDocument();

		fireEvent.click(screen.getByRole('link', { name: 'launch guide' }));
		expect(window.maestro.shell.openExternal).toHaveBeenCalledWith('https://example.com/launch');

		fireEvent.click(screen.getByRole('button', { name: /Phase-01-Setup\.md/i }));
		fireEvent.click(screen.getByRole('button', { name: /Phase-02-Build\.md/i }));
		await screen.findByRole('heading', { name: 'Phase 2' });
		expect(
			screen.getByText('3 total tasks - 2 documents - 2 tasks in this document')
		).toBeInTheDocument();

		fireEvent.keyDown(window, { key: '[', metaKey: true, shiftKey: true });
		await screen.findByRole('heading', { name: 'Phase 1' });

		fireEvent.keyDown(window, { key: ']', metaKey: true, shiftKey: true });
		await screen.findByRole('heading', { name: 'Phase 2' });

		fireEvent.keyDown(window, { key: 'e', ctrlKey: true });
		expect(getEditorTextarea()).toHaveValue(generatedDocuments[1].content);

		fireEvent.keyDown(window, { key: 'e', ctrlKey: true });
		await screen.findByRole('heading', { name: 'Phase 2' });

		fireEvent.click(screen.getByRole('button', { name: /Phase-02-Build\.md/i }));
		expect(screen.getByRole('button', { name: /Phase-01-Setup\.md/i })).toBeInTheDocument();
		fireEvent.keyDown(window, { key: 'Escape' });
		await waitFor(() => {
			expect(screen.queryByRole('button', { name: /Phase-01-Setup\.md/i })).not.toBeInTheDocument();
		});
	});

	it('renders single-document no-task stats from the fallback document', async () => {
		renderPhaseReview({
			initialState: {
				generatedDocuments: [
					{
						filename: 'Solo.md',
						content: '# Solo plan\n\nNo checklist yet.',
						taskCount: 0,
					},
				],
				currentDocumentIndex: 99,
			},
		});

		expect(await screen.findByRole('heading', { name: 'Solo plan' })).toBeInTheDocument();
		expect(screen.getByText('0 tasks ready to run')).toBeInTheDocument();
	});

	it('edits with keyboard helpers and auto-saves through the real document editor', async () => {
		renderPhaseReview();

		fireEvent.click(await screen.findByRole('button', { name: /^Edit$/i }));
		vi.useFakeTimers();
		let textarea = getEditorTextarea();
		fireEvent.change(textarea, { target: { value: '# Phase 1\n\n- [ ] Edited task' } });
		await act(async () => {
			await vi.advanceTimersByTimeAsync(2000);
		});
		expect(window.maestro.autorun.writeDoc).toHaveBeenCalledWith(
			playbooksPath,
			'Phase-01-Setup.md',
			'# Phase 1\n\n- [ ] Edited task'
		);
		vi.useRealTimers();

		textarea = getEditorTextarea();
		textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
		fireEvent.keyDown(textarea, { key: 'Enter' });
		expect(getEditorTextarea().value).toContain('- [ ] Edited task\n- [ ] ');

		textarea = getEditorTextarea();
		textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
		fireEvent.keyDown(textarea, { key: 'l', metaKey: true });
		expect(getEditorTextarea().value).toContain('\n- [ ] ');
	});

	it('queues pending auto-save content while a save is already in flight', async () => {
		const firstSave = deferred<{ success: boolean }>();
		vi.mocked(window.maestro.autorun.writeDoc)
			.mockReturnValueOnce(firstSave.promise)
			.mockResolvedValue({ success: true });
		renderPhaseReview();

		fireEvent.click(await screen.findByRole('button', { name: /^Edit$/i }));
		vi.useFakeTimers();
		fireEvent.change(getEditorTextarea(), {
			target: { value: '# Phase 1\n\n- [ ] First save' },
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(2000);
		});
		expect(window.maestro.autorun.writeDoc).toHaveBeenCalledTimes(1);

		fireEvent.change(getEditorTextarea(), {
			target: { value: '# Phase 1\n\n- [ ] Pending save' },
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(2000);
		});
		expect(window.maestro.autorun.writeDoc).toHaveBeenCalledTimes(1);

		await act(async () => {
			firstSave.resolve({ success: true });
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		});
		expect(window.maestro.autorun.writeDoc).toHaveBeenCalledTimes(2);
		expect(window.maestro.autorun.writeDoc).toHaveBeenLastCalledWith(
			playbooksPath,
			'Phase-01-Setup.md',
			'# Phase 1\n\n- [ ] Pending save'
		);
	});

	it('reports initial and pending auto-save failures', async () => {
		const loggerError = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
		vi.mocked(window.maestro.autorun.writeDoc).mockRejectedValueOnce(new Error('autosave failed'));
		renderPhaseReview();

		fireEvent.click(await screen.findByRole('button', { name: /^Edit$/i }));
		vi.useFakeTimers();
		fireEvent.change(getEditorTextarea(), {
			target: { value: '# Phase 1\n\n- [ ] Failing save' },
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(2000);
			await Promise.resolve();
		});
		expect(loggerError).toHaveBeenCalledWith('Auto-save failed:', undefined, expect.any(Error));

		cleanup();
		vi.useRealTimers();
		loggerError.mockClear();
		const firstSave = deferred<{ success: boolean }>();
		vi.mocked(window.maestro.autorun.writeDoc)
			.mockReset()
			.mockReturnValueOnce(firstSave.promise)
			.mockRejectedValueOnce(new Error('pending autosave failed'));
		renderPhaseReview();
		fireEvent.click(await screen.findByRole('button', { name: /^Edit$/i }));
		vi.useFakeTimers();
		fireEvent.change(getEditorTextarea(), {
			target: { value: '# Phase 1\n\n- [ ] First pending failure save' },
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(2000);
		});
		fireEvent.change(getEditorTextarea(), {
			target: { value: '# Phase 1\n\n- [ ] Pending failure save' },
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(2000);
		});
		await act(async () => {
			firstSave.resolve({ success: true });
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		});
		expect(loggerError).toHaveBeenCalledWith(
			'Auto-save (pending) failed:',
			undefined,
			expect.any(Error)
		);
	});

	it('adds pasted image attachments and removes their markdown references', async () => {
		renderPhaseReview();
		fireEvent.click(await screen.findByRole('button', { name: /^Edit$/i }));
		const textarea = getEditorTextarea();
		textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
		const imageFile = new File(['image-bytes'], 'pasted.png', { type: 'image/png' });

		fireEvent.paste(textarea, {
			clipboardData: {
				items: [
					{
						type: 'image/png',
						getAsFile: () => imageFile,
					},
				],
				getData: () => '',
			},
		});

		await waitFor(() =>
			expect(window.maestro.autorun.saveImage).toHaveBeenCalledWith(
				playbooksPath,
				'Phase-01-Setup',
				expect.any(String),
				'png'
			)
		);
		await waitFor(() => expect(getEditorTextarea().value).toContain('images/pasted-image.png'));
		expect(screen.getByText('Attached Images (1)')).toBeInTheDocument();

		fireEvent.click(screen.getByTitle('Remove image'));
		await waitFor(() =>
			expect(window.maestro.autorun.deleteImage).toHaveBeenCalledWith(
				playbooksPath,
				'pasted-image.png'
			)
		);
		expect(getEditorTextarea().value).not.toContain('images/pasted-image.png');
	});

	it('saves dirty content, records analytics, reports launch errors, and supports clean launch', async () => {
		const onWizardComplete = vi.fn();
		const onLaunchSession = vi
			.fn()
			.mockRejectedValueOnce(new Error('launch failed'))
			.mockResolvedValueOnce(undefined);
		vi.spyOn(Date, 'now').mockReturnValue(9000);

		renderPhaseReview({ onLaunchSession, onWizardComplete, wizardStartTime: 5000 });

		fireEvent.click(await screen.findByRole('button', { name: /^Edit$/i }));
		fireEvent.change(getEditorTextarea(), {
			target: { value: '# Phase 1\n\n- [x] Launch this plan' },
		});
		fireEvent.click(screen.getByRole('button', { name: /walk me through/i }));

		await screen.findByText('launch failed');
		expect(window.maestro.autorun.writeDoc).toHaveBeenCalledWith(
			playbooksPath,
			'Phase-01-Setup.md',
			'# Phase 1\n\n- [x] Launch this plan'
		);
		expect(onWizardComplete).toHaveBeenCalledWith(4000, 2, 2, 3);
		expect(onLaunchSession).toHaveBeenCalledWith(true);

		fireEvent.click(screen.getByText('launch failed').parentElement!.querySelector('button')!);
		expect(screen.queryByText('launch failed')).not.toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: /ready to go/i }));
		await waitFor(() => expect(onLaunchSession).toHaveBeenCalledWith(false));
	});

	it('moves focus between launch buttons and activates them with Enter', async () => {
		const onLaunchSession = vi.fn().mockResolvedValue(undefined);
		renderPhaseReview({ onLaunchSession });
		const readyButton = await screen.findByRole('button', { name: /ready to go/i });
		const tourButton = screen.getByRole('button', { name: /walk me through/i });

		readyButton.focus();
		fireEvent.keyDown(readyButton, { key: 'Tab' });
		expect(tourButton).toHaveFocus();
		fireEvent.keyDown(tourButton, { key: 'Tab', shiftKey: true });
		expect(readyButton).toHaveFocus();
		fireEvent.keyDown(readyButton, { key: 'Enter' });
		await waitFor(() => expect(onLaunchSession).toHaveBeenCalledWith(false));

		cleanup();

		const onTourLaunch = vi.fn().mockResolvedValue(undefined);
		renderPhaseReview({ onLaunchSession: onTourLaunch });
		const secondTourButton = await screen.findByRole('button', { name: /walk me through/i });
		secondTourButton.focus();
		fireEvent.keyDown(secondTourButton, { key: 'Enter' });
		await waitFor(() => expect(onTourLaunch).toHaveBeenCalledWith(true));
	});

	it('redirects when no documents exist', async () => {
		const wizardSnapshots: WizardState[] = [];
		renderPhaseReview({
			initialState: { generatedDocuments: [], currentDocumentIndex: 0 },
			onWizard: (wizard) => wizardSnapshots.push(wizard.state),
		});

		expect(await screen.findByText('Redirecting...')).toBeInTheDocument();
		await waitFor(() => {
			expect(wizardSnapshots.at(-1)?.currentStep).toBe('preparing-plan');
		});
	});
});
