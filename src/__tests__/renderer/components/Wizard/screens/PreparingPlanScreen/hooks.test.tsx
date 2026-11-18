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

	function renderGeneration(overrides: Partial<typeof initialState> = {}, reactStrictMode = false) {
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

		return {
			params,
			hook: renderHook(() => usePreparingPlanGeneration(params), { reactStrictMode }),
		};
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
				// The project is the FOLDER, not the agent's name (issue #1225).
				projectName: 'project',
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

	it.each([
		{ customEnvVars: { GROK_HOME: '/accounts/b' }, plannerModel: 'grok-4.5' },
		{ customEnvVars: {}, plannerModel: undefined },
		{ customEnvVars: undefined, plannerModel: 'grok-composer-2.5-fast' },
		{
			customEnvVars: { GROK_HOME: '/accounts/a' },
			plannerModel: undefined,
			sessionSshRemoteConfig: { enabled: true, remoteId: 'grok-host' },
		},
	] satisfies Partial<typeof initialState>[])(
		'retries Grok using current configuration %j',
		async (updated) => {
			phaseGeneratorMock.generateDocuments
				.mockImplementationOnce(async (_config, callbacks) => {
					callbacks.onError('Grok launch refused');
					return { success: false, error: 'Grok launch refused' };
				})
				.mockImplementation(() => new Promise(() => {}));
			const history = [
				{ id: 'user-1', role: 'user' as const, content: 'Build the plan', timestamp: 1 },
			];
			const { params, hook } = renderGeneration({
				selectedAgent: 'grok',
				customPath: '/tools/grok-a',
				customArgs: '--verbose',
				customEnvVars: { GROK_HOME: '/accounts/a' },
				conversationHistory: history,
			});
			await act(async () => {});
			expect(params.setGenerationError).toHaveBeenLastCalledWith('Grok launch refused');
			expect(phaseGeneratorMock.saveDocuments).not.toHaveBeenCalled();
			expect(params.nextStep).not.toHaveBeenCalled();
			const [original, stale] = phaseGeneratorMock.generateDocuments.mock.calls[0];
			expect(original).toMatchObject({
				agentType: 'grok',
				sessionCustomPath: '/tools/grok-a',
				sessionCustomArgs: '--verbose',
				sessionCustomEnvVars: { GROK_HOME: '/accounts/a' },
				model: undefined,
				sshRemoteConfig: undefined,
				conversationHistory: history,
			});
			params.state = {
				...params.state,
				customPath: '/tools/grok-b',
				customArgs: '--debug',
				...updated,
			};
			hook.rerender();
			expect(phaseGeneratorMock.generateDocuments).toHaveBeenCalledTimes(1);
			act(() => hook.result.current.handleRetry());
			const [config, current] = phaseGeneratorMock.generateDocuments.mock.calls[1];
			expect(config).toMatchObject({
				agentType: 'grok',
				sessionCustomPath: '/tools/grok-b',
				sessionCustomArgs: '--debug',
				sessionCustomEnvVars: updated.customEnvVars,
				model: updated.plannerModel,
				sshRemoteConfig: params.state.sessionSshRemoteConfig,
				conversationHistory: history,
			});
			expect(config).not.toHaveProperty('sessionCustomEffort');
			const documents = [{ filename: 'Phase-01.md', content: '# Plan', taskCount: 2 }];
			await act(async () => {
				stale.onProgress('stale progress');
				stale.onError('stale failure');
				await stale.onComplete({ success: true, documents });
			});
			expect(params.setGeneratingDocuments).toHaveBeenLastCalledWith(true);
			expect(params.setGenerationError).toHaveBeenLastCalledWith(null);
			expect(phaseGeneratorMock.saveDocuments).not.toHaveBeenCalled();
			expect(hook.result.current.progressMessage).toBe('Generating Auto Run Documents...');
			await act(async () => {
				await current.onComplete({ success: true, documents });
			});
			expect(phaseGeneratorMock.saveDocuments).toHaveBeenCalledWith(
				'/project',
				documents,
				expect.any(Function),
				'Initiation',
				params.state.sessionSshRemoteConfig?.remoteId
			);
			expect(params.setGeneratedDocuments).toHaveBeenCalledExactlyOnceWith(documents);
			act(() => vi.advanceTimersByTime(500));
			expect(params.nextStep).toHaveBeenCalledTimes(1);
			expect(original.sessionCustomEnvVars).toEqual({ GROK_HOME: '/accounts/a' });
		}
	);

	it('restarts Grok generation after StrictMode cleanup and ignores the obsolete request', async () => {
		let rejectFirst!: (error: Error) => void;
		phaseGeneratorMock.generateDocuments
			.mockImplementationOnce(() => new Promise((_resolve, reject) => (rejectFirst = reject)))
			.mockImplementation(() => new Promise(() => {}));
		const { params, hook } = renderGeneration({ selectedAgent: 'grok' }, true);
		expect(phaseGeneratorMock.abort).toHaveBeenCalledTimes(1);
		expect(phaseGeneratorMock.generateDocuments).toHaveBeenCalledTimes(2);
		const stale = phaseGeneratorMock.generateDocuments.mock.calls[0][1];
		const current = phaseGeneratorMock.generateDocuments.mock.calls[1][1];
		const documents = [{ filename: 'Phase-01.md', content: '# Plan', taskCount: 2 }];
		act(() => current.onProgress('Current generation'));
		const busyCalls = params.setGeneratingDocuments.mock.calls.length;
		const errorCalls = params.setGenerationError.mock.calls.length;
		await act(async () => {
			stale.onStart();
			stale.onProgress('obsolete progress');
			stale.onFileCreated({ filename: 'obsolete.md', path: '/project/obsolete.md', size: 1 });
			stale.onError('obsolete failure');
			await stale.onComplete({ success: true, documents });
			rejectFirst(new Error('obsolete rejection'));
		});
		expect(hook.result.current.progressMessage).toBe('Current generation');
		expect(hook.result.current.createdFiles).toEqual([]);
		expect(params.setGeneratingDocuments).toHaveBeenCalledTimes(busyCalls);
		expect(params.setGenerationError).toHaveBeenCalledTimes(errorCalls);
		expect(params.setGeneratedDocuments).not.toHaveBeenCalled();
		expect(phaseGeneratorMock.saveDocuments).not.toHaveBeenCalled();
		await act(async () => {
			await current.onComplete({ success: true, documents, documentsFromDisk: true });
		});
		expect(params.setGeneratedDocuments).toHaveBeenCalledExactlyOnceWith(documents);
		act(() => vi.advanceTimersByTime(500));
		expect(params.nextStep).toHaveBeenCalledTimes(1);
		hook.unmount();
		expect(phaseGeneratorMock.abort).toHaveBeenCalledTimes(2);
	});

	it('uses replacement completion callbacks on retry without restarting on callback changes', async () => {
		phaseGeneratorMock.generateDocuments
			.mockResolvedValueOnce({ success: false, error: 'retry generation' })
			.mockImplementation(() => new Promise(() => {}));
		const { params, hook } = renderGeneration({ selectedAgent: 'grok' });
		await act(async () => {});
		const original = { ...params };
		params.setGeneratingDocuments = vi.fn();
		params.setGeneratedDocuments = vi.fn();
		params.setGenerationError = vi.fn();
		params.nextStep = vi.fn();
		hook.rerender();
		expect(phaseGeneratorMock.generateDocuments).toHaveBeenCalledTimes(1);
		act(() => hook.result.current.handleRetry());
		expect(phaseGeneratorMock.generateDocuments).toHaveBeenCalledTimes(2);
		const current = phaseGeneratorMock.generateDocuments.mock.calls[1][1];
		const documents = [{ filename: 'Phase-01.md', content: '# Plan', taskCount: 2 }];
		await act(async () => {
			await current.onComplete({ success: true, documents });
		});
		expect(phaseGeneratorMock.saveDocuments).toHaveBeenCalledTimes(1);
		expect(params.setGeneratedDocuments).toHaveBeenCalledExactlyOnceWith(documents);
		expect(params.setGeneratingDocuments.mock.calls).toEqual([[true], [false]]);
		expect(params.setGenerationError).toHaveBeenLastCalledWith(null);
		act(() => vi.advanceTimersByTime(500));
		expect(params.nextStep).toHaveBeenCalledTimes(1);
		expect(original.setGeneratedDocuments).not.toHaveBeenCalled();
		expect(original.nextStep).not.toHaveBeenCalled();
	});

	it.each(['back', 'unmount'] as const)(
		'withholds late Grok save completion after %s',
		async (action) => {
			phaseGeneratorMock.generateDocuments.mockImplementation(() => new Promise(() => {}));
			let finishSave!: (result: { success: boolean }) => void;
			phaseGeneratorMock.saveDocuments.mockImplementation(
				() =>
					new Promise((resolve) => {
						finishSave = resolve;
					})
			);
			const { params, hook } = renderGeneration({ selectedAgent: 'grok' });
			const callbacks = phaseGeneratorMock.generateDocuments.mock.calls[0][1];
			const documents = [{ filename: 'Phase-01.md', content: '# Plan', taskCount: 2 }];
			let completion!: Promise<void>;
			act(() => {
				completion = callbacks.onComplete({ success: true, documents });
			});
			expect(phaseGeneratorMock.saveDocuments).toHaveBeenCalledTimes(1);
			act(() => {
				if (action === 'back') hook.result.current.handleGoBack();
				else hook.unmount();
			});
			const busyCalls = params.setGeneratingDocuments.mock.calls.length;
			const errorCalls = params.setGenerationError.mock.calls.length;
			await act(async () => {
				phaseGeneratorMock.saveDocuments.mock.calls[0][2]({
					filename: 'Phase-01.md',
					path: '/project/Phase-01.md',
					size: 10,
					taskCount: 2,
				});
				callbacks.onError('late error');
				finishSave({ success: true });
				await completion;
				vi.advanceTimersByTime(500);
			});
			expect(phaseGeneratorMock.abort).toHaveBeenCalledTimes(1);
			expect(params.setGeneratedDocuments).not.toHaveBeenCalled();
			expect(params.nextStep).not.toHaveBeenCalled();
			expect(params.setGeneratingDocuments).toHaveBeenCalledTimes(busyCalls);
			expect(params.setGenerationError).toHaveBeenCalledTimes(errorCalls);
			if (action === 'back') expect(hook.result.current.createdFiles).toEqual([]);
		}
	);
});
