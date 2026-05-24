/**
 * PreparingPlanScreen.test.tsx
 *
 * Rendered coverage for the wizard document-generation screen.
 */

import React from 'react';
import { act, fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PreparingPlanScreen } from '../../../../../renderer/components/Wizard/screens/PreparingPlanScreen';
import {
	WizardProvider,
	useWizard,
	type WizardState,
	type WizardContextAPI,
	type WizardMessage,
	type GeneratedDocument,
} from '../../../../../renderer/components/Wizard/WizardContext';
import type { Theme } from '../../../../../renderer/types';
import type { CreatedFileInfo } from '../../../../../renderer/components/Wizard/services/phaseGenerator';

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

vi.mock('../../../../../renderer/components/Wizard/services/phaseGenerator', () => ({
	phaseGenerator: {
		generateDocuments: (...args: unknown[]) => mocks.generateDocuments(...args),
		saveDocuments: (...args: unknown[]) => mocks.saveDocuments(...args),
		isGenerationInProgress: (...args: unknown[]) => mocks.isGenerationInProgress(...args),
		abort: (...args: unknown[]) => mocks.abort(...args),
	},
	wizardDebugLogger: {
		downloadLogs: (...args: unknown[]) => mocks.downloadLogs(...args),
	},
}));

vi.mock('../../../../../renderer/components/Wizard/services/austinFacts', () => ({
	getNextAustinFact: () => mocks.getNextAustinFact(),
	parseFactWithLinks: (fact: string) => mocks.parseFactWithLinks(fact),
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
		content: '# Phase 1\n\n- [ ] Set up project',
		taskCount: 2,
	},
];

const createdFile = (overrides: Partial<CreatedFileInfo>): CreatedFileInfo => ({
	filename: 'Phase-01-Setup.md',
	path: '/repo/Auto Run Docs/Initiation/Phase-01-Setup.md',
	size: 1024,
	timestamp: 1,
	description: 'Set up the first project tasks.',
	taskCount: 2,
	...overrides,
});

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
			{ready && <PreparingPlanScreen theme={mockTheme} />}
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

describe('PreparingPlanScreen', () => {
	beforeEach(() => {
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
		(window as any).maestro = {
			settings: {
				get: vi.fn(),
				set: vi.fn(),
			},
			shell: {
				openExternal: mocks.openExternal,
			},
		};
		vi.spyOn(window, 'open').mockImplementation(mocks.windowOpen as any);
	});

	afterEach(() => {
		cleanup();
		vi.useRealTimers();
		vi.restoreAllMocks();
		(window as any).maestro = undefined;
	});

	it('generates documents, tracks created files, saves through SSH, and advances', async () => {
		mocks.generateDocuments.mockImplementation(async (_config, callbacks) => {
			callbacks.onStart?.();
			callbacks.onProgress?.('Drafting task documents...');
			callbacks.onChunk?.('partial output');
			callbacks.onActivity?.();
			callbacks.onFileCreated?.(
				createdFile({
					filename: 'Phase-01-Setup.md',
					description: 'Initial description.',
					taskCount: 1,
				})
			);
			callbacks.onFileCreated?.(
				createdFile({
					filename: 'Phase-01-Setup.md',
					description: 'Updated description.',
					size: 2048,
					taskCount: 2,
				})
			);
			callbacks.onFileCreated?.(
				createdFile({
					filename: 'Phase-02-Followup.md',
					path: '/repo/Auto Run Docs/Initiation/Phase-02-Followup.md',
					description: undefined,
					taskCount: 0,
				})
			);
			await callbacks.onComplete?.({ success: true, documents: generatedDocuments });
			return { success: true, documents: generatedDocuments };
		});
		mocks.saveDocuments.mockImplementation(async (_directory, _documents, onFileCreated) => {
			onFileCreated(
				createdFile({
					filename: 'Phase-01-Setup.md',
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
			{
				agentType: 'codex',
				directoryPath: '/repo',
				projectName: 'Launch Project',
				conversationHistory,
				subfolder: 'Initiation',
				sshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
			},
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

		await waitFor(() => {
			expect(screen.getByTestId('current-step')).toHaveTextContent('phase-review');
		});
	});

	it('skips saving when generated documents already came from disk', async () => {
		const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		mocks.generateDocuments.mockImplementation(async (_config, callbacks) => {
			await callbacks.onComplete?.({
				success: true,
				documents: generatedDocuments,
				documentsFromDisk: true,
			});
			return { success: true, documents: generatedDocuments, documentsFromDisk: true };
		});

		renderPreparingPlan();

		await waitFor(() => {
			expect(logSpy).toHaveBeenCalledWith(
				'[PreparingPlanScreen] Documents already on disk, skipping save'
			);
		});
		expect(mocks.saveDocuments).not.toHaveBeenCalled();
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 550));
		});
		await waitFor(() => {
			expect(screen.getByTestId('current-step')).toHaveTextContent('phase-review');
		});
	});

	it('uses zero task announcements for documents already read from disk', async () => {
		const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		mocks.generateDocuments.mockImplementation(async (_config, callbacks) => {
			await callbacks.onComplete?.({
				success: true,
				documents: [],
				documentsFromDisk: true,
			});
			return { success: true, documents: [], documentsFromDisk: true };
		});

		renderPreparingPlan();

		await waitFor(() => {
			expect(mocks.generateDocuments).toHaveBeenCalledTimes(1);
		});
		expect(logSpy).toHaveBeenCalledWith(
			'[PreparingPlanScreen] Documents already on disk, skipping save'
		);
		expect(mocks.saveDocuments).not.toHaveBeenCalled();
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 550));
		});
		await waitFor(() => {
			expect(screen.getByTestId('current-step')).toHaveTextContent('phase-review');
		});
	});

	it('saves empty document lists with enabled SSH configs that have no remote ID', async () => {
		mocks.generateDocuments.mockImplementation(async (_config, callbacks) => {
			await callbacks.onComplete?.({ success: true, documents: [] });
			return { success: true, documents: [] };
		});
		mocks.saveDocuments.mockResolvedValue({ success: true });

		renderPreparingPlan({
			sessionSshRemoteConfig: { enabled: true, remoteId: null },
		});

		await waitFor(() => {
			expect(mocks.saveDocuments).toHaveBeenCalledWith(
				'/repo',
				[],
				expect.any(Function),
				'Initiation',
				undefined
			);
		});
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 550));
		});
		await waitFor(() => {
			expect(screen.getByTestId('current-step')).toHaveTextContent('phase-review');
		});
	});

	it('shows save errors, downloads debug logs, and retries generation', async () => {
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
			.mockResolvedValueOnce({ success: true });

		renderPreparingPlan();

		await screen.findByText('Generation Failed');
		expect(screen.getAllByText('Disk is full').length).toBeGreaterThan(0);

		fireEvent.click(screen.getByRole('button', { name: '(Debug Logs)' }));
		expect(mocks.downloadLogs).toHaveBeenCalledTimes(1);

		fireEvent.click(screen.getByRole('button', { name: 'Try Again' }));
		await waitFor(() => {
			expect(mocks.generateDocuments).toHaveBeenCalledTimes(2);
		});
	});

	it('goes back to the conversation step from a generation error', async () => {
		mocks.generateDocuments.mockImplementation(async (_config, callbacks) => {
			await callbacks.onComplete?.({ success: true, documents: generatedDocuments });
			return { success: true, documents: generatedDocuments };
		});
		mocks.saveDocuments.mockResolvedValue({ success: false, error: 'Disk is full' });

		renderPreparingPlan();

		await screen.findByText('Generation Failed');
		fireEvent.click(screen.getByRole('button', { name: 'Go Back' }));

		await waitFor(() => {
			expect(screen.getByTestId('current-step')).toHaveTextContent('conversation');
		});
	});

	it('uses default project names and fallback save errors', async () => {
		mocks.generateDocuments.mockImplementation(async (_config, callbacks) => {
			await callbacks.onComplete?.({ success: true, documents: generatedDocuments });
			return { success: true, documents: generatedDocuments };
		});
		mocks.saveDocuments.mockResolvedValue({ success: false });

		renderPreparingPlan({ agentName: '' });

		await screen.findByText('Generation Failed');
		expect(mocks.generateDocuments.mock.calls[0][0]).toMatchObject({
			projectName: 'My Project',
		});
		expect(screen.getAllByText('Failed to save documents').length).toBeGreaterThan(0);
	});

	it('ignores successful completion callbacks that do not include documents', async () => {
		mocks.generateDocuments.mockImplementation(async (_config, callbacks) => {
			await callbacks.onComplete?.({ success: true });
			return { success: true };
		});

		renderPreparingPlan();

		await waitFor(() => {
			expect(mocks.generateDocuments).toHaveBeenCalledTimes(1);
		});
		expect(mocks.saveDocuments).not.toHaveBeenCalled();
		expect(screen.getByTestId('generation-error')).toHaveTextContent('');
	});

	it('shows generator callback errors and returned errors', async () => {
		mocks.generateDocuments.mockImplementation(async (_config, callbacks) => {
			callbacks.onError?.('Agent stopped responding');
			return { success: false, error: 'Agent stopped responding' };
		});

		renderPreparingPlan();

		await screen.findByText('Generation Failed');
		expect(screen.getAllByText('Agent stopped responding').length).toBeGreaterThan(0);
	});

	it('shows thrown non-Error generation failures', async () => {
		mocks.generateDocuments.mockRejectedValue('bad failure');

		renderPreparingPlan();

		await screen.findByText('Generation Failed');
		expect(screen.getAllByText('Unknown error occurred').length).toBeGreaterThan(0);
	});

	it('shows thrown Error generation failures', async () => {
		mocks.generateDocuments.mockRejectedValue(new Error('Generator exploded'));

		renderPreparingPlan();

		await screen.findByText('Generation Failed');
		expect(screen.getAllByText('Generator exploded').length).toBeGreaterThan(0);
	});

	it('does not start a new generation while another generation is in progress', async () => {
		mocks.isGenerationInProgress.mockReturnValue(true);

		renderPreparingPlan();

		await screen.findByText('Generating Auto Run Documents...');
		expect(mocks.generateDocuments).not.toHaveBeenCalled();
	});

	it('auto-advances without generating when documents already exist', async () => {
		renderPreparingPlan({ generatedDocuments });

		await waitFor(() => {
			expect(screen.getByTestId('current-step')).toHaveTextContent('phase-review');
		});
		expect(mocks.generateDocuments).not.toHaveBeenCalled();
		expect(mocks.saveDocuments).not.toHaveBeenCalled();
	});

	it('does not restart generation when documents are cleared after generation has started', async () => {
		let wizardApi: WizardContextAPI | undefined;
		mocks.generateDocuments.mockImplementation(() => new Promise(() => {}));

		renderPreparingPlan(undefined, (wizard) => {
			wizardApi = wizard;
		});

		await waitFor(() => {
			expect(mocks.generateDocuments).toHaveBeenCalledTimes(1);
		});

		await act(async () => {
			wizardApi!.setGeneratedDocuments(generatedDocuments);
		});
		await waitFor(() => {
			expect(screen.getByTestId('current-step')).toHaveTextContent('phase-review');
		});

		await act(async () => {
			wizardApi!.restoreState({
				currentStep: 'preparing-plan',
				generatedDocuments: [],
			});
		});

		await waitFor(() => {
			expect(screen.getByTestId('current-step')).toHaveTextContent('preparing-plan');
		});
		expect(mocks.generateDocuments).toHaveBeenCalledTimes(1);
		expect(mocks.saveDocuments).not.toHaveBeenCalled();
	});

	it('updates created file expansion when files arrive and users toggle rows', async () => {
		let callbacks:
			| {
					onFileCreated?: (file: CreatedFileInfo) => void;
			  }
			| undefined;
		mocks.generateDocuments.mockImplementation(async (_config, generationCallbacks) => {
			callbacks = generationCallbacks;
			return new Promise(() => {});
		});

		renderPreparingPlan();
		await waitFor(() => {
			expect(callbacks).toBeDefined();
		});

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
		const secondFileButton = await screen.findByRole('button', {
			name: /Phase-02-Followup\.md/,
		});
		expect(secondFileButton).toBeInTheDocument();

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

	it('updates elapsed time while generation remains in progress', async () => {
		vi.useFakeTimers();
		mocks.generateDocuments.mockImplementation(() => new Promise(() => {}));

		renderPreparingPlan();
		await act(async () => {});

		expect(screen.getByText('Generating Auto Run Documents...')).toBeInTheDocument();
		await act(async () => {
			vi.advanceTimersByTime(1000);
		});

		expect(screen.getByText(/Elapsed:/)).toBeInTheDocument();
	});

	it('opens fully typed Austin fact links through the shell bridge', async () => {
		vi.useFakeTimers();
		mocks.generateDocuments.mockResolvedValue({ success: true });

		renderPreparingPlan();
		await act(async () => {});
		expect(screen.getByText('Austin Facts')).toBeInTheDocument();

		await act(async () => {
			vi.advanceTimersByTime('Visit Austin Maps soon.'.length * 25 + 25);
		});

		const link = screen.getByRole('link', { name: 'Austin Maps' });
		fireEvent.click(link);

		expect(mocks.openExternal).toHaveBeenCalledWith('https://maps.example');
		expect(mocks.windowOpen).not.toHaveBeenCalled();
	});

	it('renders partially typed fact links as text and rotates completed facts', async () => {
		vi.useFakeTimers();
		mocks.getNextAustinFact
			.mockReturnValueOnce('Visit [Austin Maps](https://maps.example) soon.')
			.mockReturnValueOnce('Second Austin fact.');
		mocks.generateDocuments.mockResolvedValue({ success: true });

		renderPreparingPlan();
		await act(async () => {});

		await act(async () => {
			vi.advanceTimersByTime('Visit Aust'.length * 25);
		});
		expect(screen.queryByRole('link', { name: 'Austin Maps' })).not.toBeInTheDocument();

		await act(async () => {
			vi.advanceTimersByTime(25 * 20);
		});
		expect(screen.getByRole('link', { name: 'Austin Maps' })).toBeInTheDocument();

		await act(async () => {
			vi.advanceTimersByTime(20000);
		});
		expect(mocks.getNextAustinFact).toHaveBeenCalledTimes(2);
	});

	it('ignores unexpected Austin fact segment types without crashing', async () => {
		mocks.parseFactWithLinks.mockReturnValue([{ type: 'unknown', content: 'Hidden' }]);
		mocks.generateDocuments.mockResolvedValue({ success: true });

		renderPreparingPlan();

		await screen.findByText('Austin Facts');
		expect(screen.queryByText('Hidden')).not.toBeInTheDocument();
	});

	it('falls back to window.open when the shell bridge does not open a fact link', async () => {
		vi.useFakeTimers();
		mocks.openExternal.mockReturnValue(false);
		mocks.generateDocuments.mockResolvedValue({ success: true });

		renderPreparingPlan();
		await act(async () => {});
		expect(screen.getByText('Austin Facts')).toBeInTheDocument();

		await act(async () => {
			vi.advanceTimersByTime('Visit Austin Maps soon.'.length * 25 + 25);
		});

		fireEvent.click(screen.getByRole('link', { name: 'Austin Maps' }));

		expect(mocks.openExternal).toHaveBeenCalledWith('https://maps.example');
		expect(mocks.windowOpen).toHaveBeenCalledWith('https://maps.example', '_blank');
	});
});
