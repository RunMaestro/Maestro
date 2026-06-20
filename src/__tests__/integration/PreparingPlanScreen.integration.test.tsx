import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PreparingPlanScreen } from '../../renderer/components/Wizard/screens/PreparingPlanScreen';
import { logger } from '../../renderer/utils/logger';
import {
	WizardProvider,
	useWizard,
	type GeneratedDocument,
	type WizardContextAPI,
	type WizardMessage,
	type WizardState,
} from '../../renderer/components/Wizard/WizardContext';
import type { CreatedFileInfo } from '../../renderer/components/Wizard/services/phaseGenerator';
import type { Theme } from '../../renderer/types';

const mocks = vi.hoisted(() => ({
	generateDocuments: vi.fn(),
	saveDocuments: vi.fn(),
	isGenerationInProgress: vi.fn(),
	abort: vi.fn(),
	downloadLogs: vi.fn(),
	getNextAustinFact: vi.fn(),
	parseFactWithLinks: vi.fn(),
	openExternal: vi.fn(),
	windowOpen: vi.fn(),
}));

vi.mock('../../renderer/components/Wizard/services/phaseGenerator', () => ({
	phaseGenerator: {
		generateDocuments: (...args: unknown[]) => mocks.generateDocuments(...args),
		saveDocuments: (...args: unknown[]) => mocks.saveDocuments(...args),
		isGenerationInProgress: (...args: unknown[]) => mocks.isGenerationInProgress(...args),
		abort: (...args: unknown[]) => mocks.abort(...args),
	},
	deriveSshRemoteId: (config?: { remoteId?: string }) => config?.remoteId,
	wizardDebugLogger: {
		downloadLogs: (...args: unknown[]) => mocks.downloadLogs(...args),
	},
}));

vi.mock('../../renderer/components/Wizard/services/austinFacts', () => ({
	getNextAustinFact: () => mocks.getNextAustinFact(),
	parseFactWithLinks: (fact: string) => mocks.parseFactWithLinks(fact),
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

const conversationHistory: WizardMessage[] = [
	{
		id: 'msg-1',
		role: 'user',
		content: 'Build the launch plan',
		timestamp: 1,
	},
];

const generatedDocuments: GeneratedDocument[] = [
	{
		filename: 'Phase-01-Setup.md',
		content: '# Phase 1\n\n- [ ] Set up project\n- [ ] Verify launch',
		taskCount: 2,
	},
];

let originalMaestro: typeof window.maestro;

function createdFile(overrides: Partial<CreatedFileInfo> = {}): CreatedFileInfo {
	return {
		filename: 'Phase-01-Setup.md',
		path: '/repo/Auto Run Docs/Initiation/Phase-01-Setup.md',
		size: 1024,
		timestamp: 1,
		description: 'Set up the first project tasks.',
		taskCount: 2,
		...overrides,
	};
}

function PreparingPlanHarness({
	initialState = {},
	onWizard,
}: {
	initialState?: Partial<WizardState>;
	onWizard?: (wizard: WizardContextAPI) => void;
}) {
	const wizard = useWizard();
	const [ready, setReady] = React.useState(false);

	React.useEffect(() => {
		wizard.restoreState({
			currentStep: 'preparing-plan',
			selectedAgent: 'codex',
			directoryPath: '/repo',
			agentName: 'Launch Project',
			conversationHistory,
			generatedDocuments: [],
			generationError: null,
			sessionSshRemoteConfig: undefined,
			...initialState,
		});
		setReady(true);
	}, []);

	React.useEffect(() => {
		onWizard?.(wizard);
	});

	return (
		<>
			<div data-testid="current-step">{wizard.state.currentStep}</div>
			<div data-testid="generation-error">{wizard.state.generationError ?? ''}</div>
			{ready && <PreparingPlanScreen theme={theme} />}
		</>
	);
}

function renderPreparingPlan(
	initialState?: Partial<WizardState>,
	onWizard?: (wizard: WizardContextAPI) => void
) {
	return render(
		<WizardProvider>
			<PreparingPlanHarness initialState={initialState} onWizard={onWizard} />
		</WizardProvider>
	);
}

async function advanceAutoReviewTimer() {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 550));
	});
}

describe('PreparingPlanScreen integration', () => {
	beforeEach(() => {
		originalMaestro = window.maestro;
		mocks.generateDocuments.mockReset();
		mocks.saveDocuments.mockReset();
		mocks.isGenerationInProgress.mockReset();
		mocks.abort.mockReset();
		mocks.downloadLogs.mockReset();
		mocks.getNextAustinFact.mockReset();
		mocks.parseFactWithLinks.mockReset();
		mocks.openExternal.mockReset();
		mocks.windowOpen.mockReset();

		mocks.isGenerationInProgress.mockReturnValue(false);
		mocks.getNextAustinFact.mockReturnValue('Visit [Austin Maps](https://maps.example) soon.');
		mocks.parseFactWithLinks.mockImplementation((fact: string) => {
			const match = fact.match(/^(.*)\[([^\]]+)\]\(([^)]+)\)(.*)$/);
			if (!match) return [{ type: 'text', content: fact }];
			return [
				{ type: 'text', content: match[1] },
				{ type: 'link', text: match[2], url: match[3] },
				{ type: 'text', content: match[4] },
			];
		});
		mocks.openExternal.mockReturnValue(true);
		window.maestro = {
			...window.maestro,
			shell: {
				...window.maestro.shell,
				openExternal: mocks.openExternal,
			},
		};
		vi.spyOn(window, 'open').mockImplementation((url?: string | URL, target?: string) => {
			mocks.windowOpen(url, target);
			return null;
		});
	});

	afterEach(() => {
		cleanup();
		vi.useRealTimers();
		vi.restoreAllMocks();
		window.maestro = originalMaestro;
	});

	it('generates documents, deduplicates created-file updates, saves through SSH, and advances', async () => {
		mocks.generateDocuments.mockImplementation(async (_config, callbacks) => {
			callbacks.onStart?.();
			callbacks.onProgress?.('Drafting task documents...');
			callbacks.onFileCreated?.(
				createdFile({
					description: 'Initial description.',
					taskCount: 1,
				})
			);
			callbacks.onFileCreated?.(
				createdFile({
					description: 'Updated description.',
					size: 2048,
					taskCount: 2,
				})
			);
			callbacks.onFileCreated?.(
				createdFile({
					filename: 'Phase-02-Followup.md',
					path: '/repo/Auto Run Docs/Initiation/Phase-02-Followup.md',
					description: 'Follow-up tasks.',
					taskCount: 0,
				})
			);
			await callbacks.onComplete?.({ success: true, documents: generatedDocuments });
			return { success: true, documents: generatedDocuments };
		});
		mocks.saveDocuments.mockImplementation(async (_directory, _documents, onFileCreated) => {
			onFileCreated(
				createdFile({
					description: 'Saved description.',
					size: 3072,
				})
			);
			return { success: true };
		});

		renderPreparingPlan({
			sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
		});

		await screen.findByText('Work Plans Drafted (2)');
		expect(mocks.generateDocuments).toHaveBeenCalledWith(
			expect.objectContaining({
				agentType: 'codex',
				directoryPath: '/repo',
				projectName: 'Launch Project',
				conversationHistory,
				subfolder: 'Initiation',
				sshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
			}),
			expect.objectContaining({
				onStart: expect.any(Function),
				onProgress: expect.any(Function),
				onFileCreated: expect.any(Function),
				onComplete: expect.any(Function),
				onError: expect.any(Function),
			})
		);
		expect(mocks.saveDocuments).toHaveBeenCalledWith(
			'/repo',
			generatedDocuments,
			expect.any(Function),
			'Initiation',
			'remote-1'
		);
		expect(screen.getByText('2')).toBeInTheDocument();
		expect(screen.getByText('Tasks Planned')).toBeInTheDocument();
		expect(screen.getByText('Saved description.')).toBeInTheDocument();

		await advanceAutoReviewTimer();
		await waitFor(() =>
			expect(screen.getByTestId('current-step')).toHaveTextContent('phase-review')
		);
	});

	it('skips saving documents that are already on disk and uses the default project name', async () => {
		const loggerInfo = vi.spyOn(logger, 'info').mockImplementation(() => {});
		mocks.generateDocuments.mockImplementation(async (_config, callbacks) => {
			await callbacks.onComplete?.({
				success: true,
				documents: generatedDocuments,
				documentsFromDisk: true,
			});
			return { success: true, documents: generatedDocuments, documentsFromDisk: true };
		});

		renderPreparingPlan({ agentName: '' });

		await waitFor(() => {
			expect(loggerInfo).toHaveBeenCalledWith(
				'[PreparingPlanScreen] Documents already on disk, skipping save'
			);
		});
		expect(mocks.generateDocuments.mock.calls[0][0]).toMatchObject({
			projectName: 'My Project',
		});
		expect(mocks.saveDocuments).not.toHaveBeenCalled();

		await advanceAutoReviewTimer();
		await waitFor(() =>
			expect(screen.getByTestId('current-step')).toHaveTextContent('phase-review')
		);
	});

	it('shows save failures, downloads debug logs, retries, and can return to conversation', async () => {
		mocks.generateDocuments
			.mockImplementationOnce(async (_config, callbacks) => {
				await callbacks.onComplete?.({ success: true, documents: generatedDocuments });
				return { success: true, documents: generatedDocuments };
			})
			.mockImplementationOnce(async (_config, callbacks) => {
				await callbacks.onComplete?.({ success: true, documents: generatedDocuments });
				return { success: true, documents: generatedDocuments };
			});
		mocks.saveDocuments
			.mockResolvedValueOnce({ success: false, error: 'Disk is full' })
			.mockResolvedValueOnce({ success: false, error: 'Still full' });

		renderPreparingPlan();

		await screen.findByText('Generation Failed');
		expect(screen.getAllByText('Disk is full').length).toBeGreaterThan(0);

		fireEvent.click(screen.getByRole('button', { name: '(Debug Logs)' }));
		expect(mocks.downloadLogs).toHaveBeenCalledTimes(1);

		fireEvent.click(screen.getByRole('button', { name: 'Try Again' }));
		await waitFor(() => expect(mocks.generateDocuments).toHaveBeenCalledTimes(2));
		await waitFor(() => expect(screen.getAllByText('Still full').length).toBeGreaterThan(0));

		fireEvent.click(screen.getByRole('button', { name: 'Go Back' }));
		await waitFor(() =>
			expect(screen.getByTestId('current-step')).toHaveTextContent('conversation')
		);
	});

	it('handles generator guards, callback errors, thrown errors, and existing generated documents', async () => {
		mocks.isGenerationInProgress.mockReturnValueOnce(true);
		const firstRender = renderPreparingPlan();
		await screen.findByText('Generating Auto Run Documents...');
		expect(mocks.generateDocuments).not.toHaveBeenCalled();
		firstRender.unmount();
		cleanup();

		mocks.isGenerationInProgress.mockReturnValue(false);
		mocks.generateDocuments.mockImplementationOnce(async (_config, callbacks) => {
			callbacks.onError?.('Agent stopped responding');
			return { success: false, error: 'Agent stopped responding' };
		});
		renderPreparingPlan();
		await screen.findByText('Generation Failed');
		expect(screen.getAllByText('Agent stopped responding').length).toBeGreaterThan(0);
		cleanup();

		mocks.generateDocuments.mockRejectedValueOnce('bad failure');
		renderPreparingPlan();
		await screen.findByText('Generation Failed');
		expect(screen.getAllByText('Unknown error occurred').length).toBeGreaterThan(0);
		cleanup();

		renderPreparingPlan({ generatedDocuments });
		await waitFor(() =>
			expect(screen.getByTestId('current-step')).toHaveTextContent('phase-review')
		);
		expect(mocks.saveDocuments).not.toHaveBeenCalled();
	});

	it('updates created-file rows over time and preserves user-controlled expansion', async () => {
		let callbacks: { onFileCreated?: (file: CreatedFileInfo) => void } | undefined;
		mocks.generateDocuments.mockImplementation(async (_config, generationCallbacks) => {
			callbacks = generationCallbacks;
			return new Promise(() => {});
		});

		renderPreparingPlan();
		await waitFor(() => expect(callbacks).toBeDefined());

		act(() => {
			callbacks!.onFileCreated?.(
				createdFile({
					filename: 'Phase-01-Setup.md',
					description: 'First file description.',
					taskCount: 1,
				})
			);
		});
		const firstFileButton = await screen.findByRole('button', { name: /Phase-01-Setup\.md/ });
		expect(screen.getByText('Task Planned')).toBeInTheDocument();
		fireEvent.click(firstFileButton);
		fireEvent.click(firstFileButton);

		act(() => {
			callbacks!.onFileCreated?.(
				createdFile({
					filename: 'Phase-02-Followup.md',
					path: '/repo/Auto Run Docs/Initiation/Phase-02-Followup.md',
					description: 'Second file description.',
				})
			);
		});
		expect(
			await screen.findByRole('button', { name: /Phase-02-Followup\.md/ })
		).toBeInTheDocument();

		act(() => {
			callbacks!.onFileCreated?.(
				createdFile({
					filename: 'Phase-03-Polish.md',
					path: '/repo/Auto Run Docs/Initiation/Phase-03-Polish.md',
					description: 'Third file description.',
				})
			);
		});
		expect(await screen.findByRole('button', { name: /Phase-03-Polish\.md/ })).toBeInTheDocument();
	});

	it('types Austin fact links, opens them through shell, falls back to window.open, and rotates facts', async () => {
		vi.useFakeTimers();
		mocks.getNextAustinFact
			.mockReturnValueOnce('Visit [Austin Maps](https://maps.example) soon.')
			.mockReturnValueOnce('Second Austin fact.');
		mocks.generateDocuments.mockResolvedValue({ success: true });

		renderPreparingPlan();
		await act(async () => {});
		expect(screen.getByText('Austin Facts')).toBeInTheDocument();

		await act(async () => {
			vi.advanceTimersByTime('Visit Aust'.length * 25);
		});
		expect(screen.queryByRole('link', { name: 'Austin Maps' })).not.toBeInTheDocument();

		await act(async () => {
			vi.advanceTimersByTime('in Maps soon.'.length * 25 + 25);
		});
		fireEvent.click(screen.getByRole('link', { name: 'Austin Maps' }));
		expect(mocks.openExternal).toHaveBeenCalledWith('https://maps.example');
		expect(mocks.windowOpen).not.toHaveBeenCalled();

		mocks.openExternal.mockReturnValue(false);
		fireEvent.click(screen.getByRole('link', { name: 'Austin Maps' }));
		expect(mocks.windowOpen).toHaveBeenCalledWith('https://maps.example', '_blank');

		await act(async () => {
			vi.advanceTimersByTime(20000);
		});
		expect(mocks.getNextAustinFact).toHaveBeenCalledTimes(2);
	});
});
