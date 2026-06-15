import { renderHook, act } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { initialState } from '../../../../../../renderer/components/Wizard/WizardContext/reducer';
import { usePreparingPlanGeneration } from '../../../../../../renderer/components/Wizard/screens/PreparingPlanScreen/hooks';

const sentryMocks = vi.hoisted(() => ({
	captureException: vi.fn(),
	captureMessage: vi.fn(),
}));

const phaseGeneratorMock = vi.hoisted(() => ({
	generateDocuments: vi.fn(),
	saveDocuments: vi.fn(),
	isGenerationInProgress: vi.fn(),
	abort: vi.fn(),
}));

vi.mock('../../../../../../renderer/utils/sentry', () => sentryMocks);

vi.mock('../../../../../../renderer/components/Wizard/services/phaseGenerator', () => ({
	phaseGenerator: phaseGeneratorMock,
	deriveSshRemoteId: vi.fn((config) => (config?.enabled ? config.remoteId : undefined)),
}));

describe('usePreparingPlanGeneration', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(1000);
		phaseGeneratorMock.generateDocuments.mockReset();
		phaseGeneratorMock.saveDocuments.mockReset();
		phaseGeneratorMock.isGenerationInProgress.mockReset();
		phaseGeneratorMock.abort.mockReset();
		phaseGeneratorMock.isGenerationInProgress.mockReturnValue(false);
		phaseGeneratorMock.saveDocuments.mockResolvedValue({ success: true });
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	function renderGeneration(overrides: Partial<typeof initialState> = {}) {
		const params = {
			state: {
				...initialState,
				selectedAgent: 'claude-code' as const,
				agentName: 'Project',
				directoryPath: '/project',
				conversationHistory: [],
				sessionSshRemoteConfig: undefined,
				...overrides,
			},
			setGeneratingDocuments: vi.fn(),
			setGeneratedDocuments: vi.fn(),
			setGenerationError: vi.fn(),
			previousStep: vi.fn(),
			nextStep: vi.fn(),
		};

		return { params, hook: renderHook(() => usePreparingPlanGeneration(params)) };
	}

	it('starts generation on mount, saves documents, records created files, and advances', async () => {
		const documents = [{ filename: 'Phase-01.md', content: '# Plan', taskCount: 2 }];
		phaseGeneratorMock.generateDocuments.mockImplementation(async (_config, callbacks) => {
			callbacks.onStart();
			callbacks.onProgress('Writing plan...');
			callbacks.onFileCreated({
				filename: 'Phase-01.md',
				path: '/project/Phase-01.md',
				size: 10,
				taskCount: 1,
			});
			await callbacks.onComplete({ success: true, documents });
			return { success: true };
		});

		const { params, hook } = renderGeneration({
			sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
		});

		await act(async () => {
			await Promise.resolve();
		});

		expect(phaseGeneratorMock.generateDocuments).toHaveBeenCalledWith(
			expect.objectContaining({
				agentType: 'claude-code',
				directoryPath: '/project',
				projectName: 'Project',
				subfolder: 'Initiation',
				sshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
			}),
			expect.any(Object)
		);
		expect(phaseGeneratorMock.saveDocuments).toHaveBeenCalledWith(
			'/project',
			documents,
			expect.any(Function),
			'Initiation',
			'remote-1'
		);
		expect(params.setGeneratedDocuments).toHaveBeenCalledWith(documents);
		expect(hook.result.current.createdFiles[0].filename).toBe('Phase-01.md');

		act(() => vi.advanceTimersByTime(500));
		expect(params.nextStep).toHaveBeenCalled();
	});

	it('skips save when generation returns documents from disk', async () => {
		const documents = [{ filename: 'Phase-01.md', content: '# Plan', taskCount: 2 }];
		phaseGeneratorMock.generateDocuments.mockImplementation(async (_config, callbacks) => {
			await callbacks.onComplete({ success: true, documents, documentsFromDisk: true });
			return { success: true };
		});

		const { params } = renderGeneration();
		await act(async () => {
			await Promise.resolve();
		});

		expect(phaseGeneratorMock.saveDocuments).not.toHaveBeenCalled();
		expect(params.setGeneratedDocuments).toHaveBeenCalledWith(documents);
		act(() => vi.advanceTimersByTime(500));
		expect(params.nextStep).toHaveBeenCalled();
	});

	it('sets generation error on save failure and process errors', async () => {
		const documents = [{ filename: 'Phase-01.md', content: '# Plan', taskCount: 2 }];
		phaseGeneratorMock.saveDocuments.mockResolvedValueOnce({
			success: false,
			error: 'write failed',
		});
		phaseGeneratorMock.generateDocuments.mockImplementationOnce(async (_config, callbacks) => {
			await callbacks.onComplete({ success: true, documents });
			return { success: true };
		});

		const { params } = renderGeneration();
		await act(async () => {
			await Promise.resolve();
		});
		expect(params.setGenerationError).toHaveBeenCalledWith('write failed');

		phaseGeneratorMock.generateDocuments.mockImplementationOnce(async (_config, callbacks) => {
			callbacks.onError('agent failed');
			return { success: false, error: 'agent failed' };
		});
		const second = renderGeneration();
		await act(async () => {
			await Promise.resolve();
		});
		expect(second.params.setGenerationError).toHaveBeenCalledWith('agent failed');
	});

	it('handles retry, back, existing documents, and abort cleanup', async () => {
		phaseGeneratorMock.generateDocuments.mockResolvedValue({ success: true });
		const { params, hook } = renderGeneration({
			generatedDocuments: [{ filename: 'Phase-01.md', content: '# Plan', taskCount: 1 }],
		});

		expect(params.nextStep).toHaveBeenCalled();

		act(() => hook.result.current.handleGoBack());
		expect(params.setGenerationError).toHaveBeenCalledWith(null);
		expect(params.previousStep).toHaveBeenCalled();

		act(() => hook.result.current.handleRetry());
		expect(params.setGenerationError).toHaveBeenCalledWith(null);

		hook.unmount();
		expect(phaseGeneratorMock.abort).toHaveBeenCalled();
	});
});
