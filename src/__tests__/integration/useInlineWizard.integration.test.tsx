import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const conversationMocks = vi.hoisted(() => ({
	startInlineWizardConversation: vi.fn(),
	sendWizardMessage: vi.fn(),
	endInlineWizardConversation: vi.fn(),
}));

const documentGenerationMocks = vi.hoisted(() => ({
	generateInlineDocuments: vi.fn(),
	extractDisplayTextFromChunk: vi.fn(),
}));

vi.mock('../../renderer/services/inlineWizardConversation', async () => {
	const actual = await vi.importActual<
		typeof import('../../renderer/services/inlineWizardConversation')
	>('../../renderer/services/inlineWizardConversation');
	return {
		...actual,
		startInlineWizardConversation: conversationMocks.startInlineWizardConversation,
		sendWizardMessage: conversationMocks.sendWizardMessage,
		endInlineWizardConversation: conversationMocks.endInlineWizardConversation,
	};
});

vi.mock('../../renderer/services/inlineWizardDocumentGeneration', async () => {
	const actual = await vi.importActual<
		typeof import('../../renderer/services/inlineWizardDocumentGeneration')
	>('../../renderer/services/inlineWizardDocumentGeneration');
	return {
		...actual,
		generateInlineDocuments: documentGenerationMocks.generateInlineDocuments,
		extractDisplayTextFromChunk: documentGenerationMocks.extractDisplayTextFromChunk,
	};
});

import {
	type InlineGeneratedDocument,
	type PreviousUIState,
	useInlineWizard,
} from '../../renderer/hooks/batch/useInlineWizard';
import {
	clearCapabilitiesCache,
	DEFAULT_CAPABILITIES,
	setCapabilitiesCache,
} from '../../renderer/hooks/agent/useAgentCapabilities';

const mockMaestro = {
	autorun: {
		listDocs: vi.fn(),
		readDoc: vi.fn(),
		writeDoc: vi.fn(),
	},
	agents: {
		get: vi.fn(),
	},
	history: {
		getFilePath: vi.fn(),
	},
	process: {
		spawn: vi.fn(),
		kill: vi.fn(),
		onData: vi.fn(),
		onExit: vi.fn(),
	},
};

const previousUiState: PreviousUIState = {
	readOnlyMode: false,
	saveToHistory: true,
	showThinking: 'on',
};

function makeConversationSession(config: {
	agentType: string;
	directoryPath: string;
	projectName: string;
	sessionSshRemoteConfig?: {
		enabled: boolean;
		remoteId: string | null;
		workingDirOverride?: string;
	};
	sessionCustomPath?: string;
	sessionCustomArgs?: string;
	sessionCustomEnvVars?: Record<string, string>;
	sessionCustomModel?: string;
}) {
	return {
		sessionId: `conversation-${conversationMocks.startInlineWizardConversation.mock.calls.length + 1}`,
		agentType: config.agentType,
		directoryPath: config.directoryPath,
		projectName: config.projectName,
		systemPrompt: 'mock wizard prompt',
		isActive: true,
		sessionSshRemoteConfig: config.sessionSshRemoteConfig?.enabled
			? config.sessionSshRemoteConfig
			: undefined,
		sessionCustomPath: config.sessionCustomPath,
		sessionCustomArgs: config.sessionCustomArgs,
		sessionCustomEnvVars: config.sessionCustomEnvVars,
		sessionCustomModel: config.sessionCustomModel,
	};
}

describe('useInlineWizard integration coverage', () => {
	let consoleLogSpy: ReturnType<typeof vi.spyOn>;
	let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
	let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		(window as unknown as { maestro: typeof mockMaestro }).maestro = mockMaestro;
		vi.clearAllMocks();
		clearCapabilitiesCache();
		setCapabilitiesCache('claude-code', { ...DEFAULT_CAPABILITIES, supportsWizard: true });
		mockMaestro.autorun.listDocs.mockResolvedValue({ success: true, files: [] });
		mockMaestro.autorun.readDoc.mockResolvedValue({
			success: true,
			content: '# Existing\n- [ ] Task',
		});
		mockMaestro.history.getFilePath.mockResolvedValue('/history/session.json');
		mockMaestro.agents.get.mockResolvedValue({ id: 'claude-code', available: true, args: [] });
		conversationMocks.startInlineWizardConversation.mockImplementation(makeConversationSession);
		conversationMocks.sendWizardMessage.mockResolvedValue({
			success: true,
			response: { message: 'Ready to generate.', confidence: 88, ready: true },
			agentSessionId: 'agent-session-1',
		});
		conversationMocks.endInlineWizardConversation.mockResolvedValue(undefined);
		documentGenerationMocks.extractDisplayTextFromChunk.mockReturnValue('streamed text ');
		documentGenerationMocks.generateInlineDocuments.mockResolvedValue({
			success: true,
			documents: [],
			subfolderName: 'Generated-Plan',
			subfolderPath: '/auto/Generated-Plan',
		});
		consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	});

	afterEach(() => {
		consoleLogSpy.mockRestore();
		consoleWarnSpy.mockRestore();
		consoleErrorSpy.mockRestore();
		clearCapabilitiesCache();
	});

	it('loads history and existing document fallbacks when starting iterate mode', async () => {
		mockMaestro.autorun.listDocs.mockResolvedValue({
			success: true,
			files: ['Phase-01-Setup', 'Phase-02-Build', 'Phase-03-Ship'],
		});
		mockMaestro.autorun.readDoc
			.mockResolvedValueOnce({ success: true, content: '# Loaded content' })
			.mockResolvedValueOnce({ success: false })
			.mockRejectedValueOnce(new Error('read failed'));

		const { result } = renderHook(() => useInlineWizard());

		await act(async () => {
			await result.current.startWizard(
				'add login',
				previousUiState,
				'/project',
				'claude-code',
				'Project',
				'tab-docs',
				'session-1',
				'/auto',
				undefined,
				'Conductor profile',
				{
					customPath: '/bin/claude',
					customArgs: '--verbose',
					customEnvVars: { FEATURE: '1' },
					customModel: 'opus',
				}
			);
		});

		expect(mockMaestro.history.getFilePath).toHaveBeenCalledWith('session-1');
		expect(result.current.wizardMode).toBe('iterate');
		expect(result.current.existingDocuments).toHaveLength(3);
		expect(conversationMocks.startInlineWizardConversation).toHaveBeenCalledWith(
			expect.objectContaining({
				mode: 'iterate',
				goal: 'login',
				autoRunFolderPath: '/auto',
				historyFilePath: '/history/session.json',
				conductorProfile: 'Conductor profile',
				sessionCustomPath: '/bin/claude',
				sessionCustomArgs: '--verbose',
				sessionCustomEnvVars: { FEATURE: '1' },
				sessionCustomModel: 'opus',
				existingDocs: [
					expect.objectContaining({ content: '# Loaded content' }),
					expect.objectContaining({ content: '(Failed to load content)' }),
					expect.objectContaining({ content: '(Failed to load content)' }),
				],
			})
		);
	});

	it('handles unavailable history, list failures, unsupported agents, and end/reset cleanup', async () => {
		mockMaestro.history.getFilePath.mockRejectedValueOnce(new Error('missing history'));
		mockMaestro.autorun.listDocs.mockRejectedValueOnce(new Error('missing folder'));
		const { result } = renderHook(() => useInlineWizard());

		await act(async () => {
			await result.current.startWizard(
				undefined,
				previousUiState,
				'/project',
				'claude-code',
				'Project',
				'tab-cleanup',
				'session-1'
			);
		});

		expect(result.current.wizardMode).toBe('new');
		await act(async () => {
			expect(await result.current.endWizard()).toEqual(previousUiState);
		});
		expect(result.current.isWizardActive).toBe(false);

		await act(async () => {
			await result.current.startWizard(
				undefined,
				previousUiState,
				'/project',
				'claude-code',
				'Project',
				'tab-cleanup',
				'session-1'
			);
		});
		conversationMocks.endInlineWizardConversation.mockRejectedValueOnce(new Error('end failed'));
		await act(async () => {
			expect(await result.current.endWizard()).toEqual(previousUiState);
		});
		expect(result.current.isWizardActive).toBe(false);

		setCapabilitiesCache('claude-code', { ...DEFAULT_CAPABILITIES, supportsWizard: false });
		const conversationStartsBeforeUnsupported =
			conversationMocks.startInlineWizardConversation.mock.calls.length;
		await act(async () => {
			await result.current.startWizard(
				undefined,
				previousUiState,
				'/project',
				'claude-code',
				'Project',
				'tab-unsupported'
			);
		});

		expect(result.current.error).toBe('The inline wizard is not supported for this agent type.');
		expect(conversationMocks.startInlineWizardConversation).toHaveBeenCalledTimes(
			conversationStartsBeforeUnsupported
		);

		await act(async () => {
			result.current.reset();
		});
		expect(result.current.isWizardActive).toBe(false);
	});

	it('covers list and initialization failure branches during start', async () => {
		mockMaestro.autorun.listDocs
			.mockResolvedValueOnce({ success: true, files: ['Phase-01'] })
			.mockRejectedValueOnce(new Error('second list failed'));
		const { result } = renderHook(() => useInlineWizard());

		await act(async () => {
			await result.current.startWizard(
				'add reporting',
				previousUiState,
				'/project',
				'claude-code',
				'Project',
				'tab-list-failure',
				'session-1',
				'/auto'
			);
		});
		expect(result.current.wizardMode).toBe('iterate');
		expect(result.current.existingDocuments).toHaveLength(0);

		conversationMocks.startInlineWizardConversation.mockImplementationOnce(() => {
			throw new Error('conversation start failed');
		});
		await act(async () => {
			await result.current.startWizard(
				undefined,
				previousUiState,
				'/project',
				'claude-code',
				'Project',
				'tab-start-failure',
				'session-1',
				'/auto'
			);
		});
		expect(result.current.error).toBe('conversation start failed');
		expect(result.current.wizardMode).toBe('new');
	});

	it('exercises default-tab setters, accessors, retry guard, and reset cleanup', async () => {
		const { result } = renderHook(() => useInlineWizard());

		expect(result.current.getStateForTab('missing')).toBeUndefined();
		expect(result.current.isWizardActiveForTab('missing')).toBe(false);

		await act(async () => {
			result.current.addAssistantMessage('Default tab response');
			result.current.setConfidence(42);
			result.current.setGoal('default goal');
			result.current.setGeneratingDocs(true);
			result.current.setGeneratedDocuments([
				{ filename: 'Phase.md', content: '# Phase', taskCount: 1 },
			]);
			result.current.setExistingDocuments([
				{ name: 'Phase', filename: 'Phase.md', path: '/auto/Phase.md' },
			]);
			result.current.setError('temporary error');
			result.current.clearError();
			result.current.clearConversation();
			await result.current.retryLastMessage();
		});

		expect(result.current.wizardTabId).toBeNull();
		expect(result.current.confidence).toBe(42);
		expect(result.current.conversationHistory).toHaveLength(0);

		await act(async () => {
			await result.current.startWizard(
				undefined,
				previousUiState,
				'/project',
				'claude-code',
				'Project',
				'tab-reset',
				'session-1',
				'/auto'
			);
		});
		conversationMocks.endInlineWizardConversation.mockRejectedValueOnce(new Error('reset cleanup'));
		await act(async () => {
			result.current.reset();
		});
		await Promise.resolve();
		expect(result.current.isWizardActive).toBe(false);
	});

	it('auto-creates ask-mode sessions and records successful assistant responses', async () => {
		mockMaestro.autorun.listDocs.mockResolvedValue({ success: true, files: ['Phase-01'] });
		const callbacks = { onError: vi.fn() };
		const { result } = renderHook(() => useInlineWizard());

		await act(async () => {
			await result.current.startWizard(
				undefined,
				previousUiState,
				'/project',
				'claude-code',
				'Project',
				'tab-ask',
				'session-1',
				'/auto'
			);
		});
		expect(result.current.wizardMode).toBe('ask');

		await act(async () => {
			await result.current.sendMessage(
				'Create a new plan',
				['data:image/png;base64,aW1n'],
				callbacks
			);
		});

		expect(conversationMocks.startInlineWizardConversation).toHaveBeenCalledWith(
			expect.objectContaining({ mode: 'new', autoRunFolderPath: '/auto' })
		);
		expect(conversationMocks.sendWizardMessage).toHaveBeenCalledWith(
			expect.objectContaining({ sessionId: expect.stringMatching(/^conversation-/) }),
			'Create a new plan',
			expect.any(Array),
			callbacks
		);
		expect(callbacks.onError).not.toHaveBeenCalled();
		expect(result.current.wizardMode).toBe('new');
		expect(result.current.agentSessionId).toBe('agent-session-1');
		expect(result.current.conversationHistory.at(-1)).toEqual(
			expect.objectContaining({
				role: 'assistant',
				content: 'Ready to generate.',
				confidence: 88,
				ready: true,
			})
		);
	});

	it('surfaces send-message failures and retries the last failed user message', async () => {
		const callbacks = { onError: vi.fn() };
		const { result } = renderHook(() => useInlineWizard());

		await act(async () => {
			await result.current.sendMessage('orphan message', undefined, callbacks);
		});
		expect(result.current.error).toBe('No active conversation session. Please restart the wizard.');
		expect(callbacks.onError).toHaveBeenCalledWith('No active conversation session');

		conversationMocks.sendWizardMessage
			.mockResolvedValueOnce({ success: false, error: 'agent said no' })
			.mockResolvedValueOnce({
				success: true,
				response: { message: 'Recovered.', confidence: 91, ready: true },
			})
			.mockRejectedValueOnce(new Error('spawn failed'));

		await act(async () => {
			await result.current.startWizard(
				undefined,
				previousUiState,
				'/project',
				'claude-code',
				'Project',
				'tab-send',
				'session-1',
				'/auto'
			);
		});
		await waitFor(() => expect(result.current.wizardTabId).toBe('tab-send'));
		await act(async () => {
			await result.current.sendMessage('try once', undefined, callbacks);
		});
		expect(result.current.error).toBe('agent said no');
		expect(callbacks.onError).toHaveBeenCalledWith('agent said no');

		await act(async () => {
			await result.current.retryLastMessage(callbacks);
		});
		expect(result.current.error).toBeNull();
		expect(result.current.conversationHistory.at(-1)).toEqual(
			expect.objectContaining({ role: 'assistant', content: 'Recovered.' })
		);

		await act(async () => {
			await result.current.sendMessage('throw now', undefined, callbacks);
		});
		expect(result.current.error).toBe('spawn failed');
		expect(callbacks.onError).toHaveBeenCalledWith('spawn failed');
	});

	it('ignores duplicate sends while a response is already pending', async () => {
		let resolveSend!: (value: {
			success: boolean;
			response: { message: string; confidence: number; ready: boolean };
		}) => void;
		conversationMocks.sendWizardMessage.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveSend = resolve;
				})
		);
		const { result } = renderHook(() => useInlineWizard());

		await act(async () => {
			await result.current.startWizard(
				undefined,
				previousUiState,
				'/project',
				'claude-code',
				'Project',
				'tab-pending',
				'session-1',
				'/auto'
			);
		});

		let firstSend: Promise<void>;
		await act(async () => {
			firstSend = result.current.sendMessage('first');
		});
		await waitFor(() => expect(result.current.isWaiting).toBe(true));
		await act(async () => {
			await result.current.sendMessage('second');
		});
		expect(conversationMocks.sendWizardMessage).toHaveBeenCalledTimes(1);

		await act(async () => {
			resolveSend({
				success: true,
				response: { message: 'Done waiting.', confidence: 86, ready: true },
			});
			await firstSend!;
		});
		expect(result.current.isWaiting).toBe(false);
	});

	it('starts a conversation when ask mode is resolved through setMode', async () => {
		mockMaestro.autorun.listDocs.mockResolvedValue({ success: true, files: ['Phase-01'] });
		const { result } = renderHook(() => useInlineWizard());

		await act(async () => {
			await result.current.startWizard(
				undefined,
				previousUiState,
				'/project',
				'claude-code',
				'Project',
				'tab-mode',
				'session-1',
				'/auto'
			);
		});
		await waitFor(() => expect(result.current.wizardMode).toBe('ask'));
		await act(async () => {
			result.current.setMode('iterate');
		});

		expect(result.current.wizardMode).toBe('iterate');
		expect(conversationMocks.startInlineWizardConversation).toHaveBeenCalledWith(
			expect.objectContaining({ mode: 'iterate', autoRunFolderPath: '/auto' })
		);
	});

	it('drives document generation callbacks, state updates, and error branches', async () => {
		const docA: InlineGeneratedDocument = {
			filename: 'Phase-01.md',
			content: '# Phase 1',
			taskCount: 1,
			savedPath: '/auto/Generated/Phase-01.md',
		};
		const docB: InlineGeneratedDocument = {
			filename: 'Phase-02.md',
			content: '# Phase 2',
			taskCount: 2,
			savedPath: '/auto/Generated/Phase-02.md',
		};
		const callbacks = {
			onStart: vi.fn(),
			onProgress: vi.fn(),
			onChunk: vi.fn(),
			onDocumentComplete: vi.fn(),
			onComplete: vi.fn(),
			onError: vi.fn(),
		};
		documentGenerationMocks.generateInlineDocuments.mockImplementationOnce(async (config) => {
			config.callbacks.onStart();
			config.callbacks.onProgress('Saving 1 of 2 document(s)...');
			config.callbacks.onChunk('raw chunk');
			config.callbacks.onDocumentComplete(docA);
			config.callbacks.onComplete([docA]);
			config.callbacks.onError('recoverable stream warning');
			return {
				success: true,
				documents: [docA, docB],
				subfolderName: 'Generated',
				subfolderPath: '/auto/Generated',
			};
		});
		const { result } = renderHook(() => useInlineWizard());

		await act(async () => {
			await result.current.startWizard(
				undefined,
				previousUiState,
				'/project',
				'claude-code',
				'Project',
				'tab-generate',
				'session-1',
				'/auto'
			);
		});
		await waitFor(() => expect(result.current.wizardTabId).toBe('tab-generate'));
		await act(async () => {
			result.current.addAssistantMessage('Ready', 90, true);
			await result.current.generateDocuments(callbacks);
		});

		expect(callbacks.onStart).toHaveBeenCalled();
		expect(callbacks.onProgress).toHaveBeenCalledWith('Saving 1 of 2 document(s)...');
		expect(callbacks.onChunk).toHaveBeenCalledWith('raw chunk');
		expect(callbacks.onDocumentComplete).toHaveBeenCalledWith(docA);
		expect(callbacks.onComplete).toHaveBeenCalledWith([docA]);
		expect(result.current.streamingContent).toBe('streamed text ');
		expect(result.current.generatedDocuments).toEqual([docA, docB]);
		expect(result.current.generationProgress).toEqual({ current: 2, total: 2 });
		expect(result.current.state.subfolderName).toBe('Generated');
		expect(result.current.state.subfolderPath).toBe('/auto/Generated');

		documentGenerationMocks.generateInlineDocuments.mockResolvedValueOnce({
			success: false,
			error: 'generation failed',
		});
		await act(async () => {
			await result.current.generateDocuments(callbacks);
		});
		expect(result.current.error).toBe('generation failed');
		expect(result.current.streamingContent).toBe('');

		documentGenerationMocks.generateInlineDocuments.mockRejectedValueOnce(
			new Error('generator crashed')
		);
		await act(async () => {
			await result.current.generateDocuments(callbacks);
		});
		expect(result.current.error).toBe('generator crashed');
		expect(callbacks.onError).toHaveBeenCalledWith('generator crashed');
	});

	it('validates document generation prerequisites and explicit tab routing', async () => {
		const callbacks = { onError: vi.fn() };
		const { result } = renderHook(() => useInlineWizard());

		await act(async () => {
			await result.current.generateDocuments(callbacks);
		});
		expect(result.current.error).toBe(
			'Cannot generate documents: missing agent type or Auto Run folder path'
		);
		expect(callbacks.onError).toHaveBeenCalledWith(
			'Cannot generate documents: missing agent type or Auto Run folder path'
		);

		await act(async () => {
			await result.current.startWizard(
				undefined,
				previousUiState,
				'/project',
				'claude-code',
				'Project',
				'tab-a',
				'session-1',
				'/auto'
			);
		});
		await waitFor(() => expect(result.current.wizardTabId).toBe('tab-a'));
		await act(async () => {
			await result.current.startWizard(
				undefined,
				previousUiState,
				'/project',
				'claude-code',
				'Project',
				'tab-b',
				'session-1',
				'/auto'
			);
		});
		await waitFor(() => expect(result.current.wizardTabId).toBe('tab-b'));
		await act(async () => {
			await result.current.generateDocuments(callbacks, 'tab-a');
		});

		await waitFor(() => expect(result.current.wizardTabId).toBe('tab-a'));
		expect(documentGenerationMocks.generateInlineDocuments).toHaveBeenCalledWith(
			expect.objectContaining({ autoRunFolderPath: '/auto' })
		);
	});

	it('covers start, history, list, and end fallback branches', async () => {
		const { result } = renderHook(() => useInlineWizard());

		act(() => {
			result.current.reset();
		});
		await act(async () => {
			expect(await result.current.endWizard()).toBeNull();
		});
		act(() => {
			result.current.setMode('new');
		});

		await act(async () => {
			await result.current.startWizard(undefined, undefined, undefined, undefined, undefined);
		});
		expect(result.current.state).toMatchObject({
			agentType: null,
			autoRunFolderPath: null,
			previousUIState: null,
			projectPath: null,
			sessionName: null,
			tabId: 'default',
		});

		mockMaestro.history.getFilePath.mockResolvedValueOnce(null);
		await act(async () => {
			await result.current.startWizard(
				'start fresh',
				undefined,
				undefined,
				'claude-code',
				undefined,
				'tab-start-fallback',
				'session-null-history',
				'/auto'
			);
		});
		expect(conversationMocks.startInlineWizardConversation).toHaveBeenLastCalledWith(
			expect.objectContaining({
				directoryPath: '/auto',
				historyFilePath: undefined,
				projectName: 'Project',
			})
		);

		mockMaestro.autorun.listDocs
			.mockResolvedValueOnce({ success: true, files: ['Phase-01'] })
			.mockResolvedValueOnce({ success: false });
		await act(async () => {
			await result.current.startWizard(
				'add another section',
				previousUiState,
				'/project',
				'claude-code',
				'Project',
				'tab-list-without-files',
				'session-list',
				'/auto'
			);
		});
		expect(result.current.wizardMode).toBe('iterate');
		expect(result.current.existingDocuments).toEqual([]);

		conversationMocks.startInlineWizardConversation.mockImplementationOnce(() => {
			throw 'non-error start failure';
		});
		await act(async () => {
			await result.current.startWizard(
				'start fresh',
				previousUiState,
				'/project',
				'claude-code',
				'Project',
				'tab-non-error-start',
				'session-start',
				'/auto'
			);
		});
		expect(result.current.error).toBe('Failed to initialize wizard');
	});

	it('covers ask-mode direct-send, setMode, and send failure fallbacks', async () => {
		mockMaestro.autorun.listDocs.mockResolvedValue({ success: true, files: ['Phase-01'] });
		const callbacks = { onError: vi.fn() };
		const { result } = renderHook(() => useInlineWizard());

		await act(async () => {
			await result.current.startWizard(
				undefined,
				previousUiState,
				undefined,
				'claude-code',
				undefined,
				'tab-direct-ask',
				undefined,
				'/auto'
			);
		});
		expect(result.current.wizardMode).toBe('ask');

		await act(async () => {
			await result.current.sendMessage('Draft from ask mode', undefined, callbacks);
		});
		expect(conversationMocks.startInlineWizardConversation).toHaveBeenLastCalledWith(
			expect.objectContaining({
				directoryPath: '/auto',
				mode: 'new',
				projectName: 'Project',
			})
		);

		conversationMocks.sendWizardMessage
			.mockResolvedValueOnce({ success: false })
			.mockRejectedValueOnce('non-error send failure');
		await act(async () => {
			await result.current.sendMessage('missing error text', undefined, callbacks);
		});
		expect(result.current.error).toBe('Failed to get response from AI');
		expect(callbacks.onError).toHaveBeenLastCalledWith('Failed to get response from AI');

		await act(async () => {
			await result.current.sendMessage('throw string', undefined, callbacks);
		});
		expect(result.current.error).toBe('Unknown error occurred');
		expect(callbacks.onError).toHaveBeenLastCalledWith('Unknown error occurred');

		await act(async () => {
			result.current.setMode('iterate');
		});
		expect(result.current.wizardMode).toBe('iterate');

		const secondHook = renderHook(() => useInlineWizard());
		await act(async () => {
			await secondHook.result.current.startWizard(
				undefined,
				previousUiState,
				undefined,
				'claude-code',
				undefined,
				'tab-setmode-ask',
				undefined,
				'/auto'
			);
		});
		await act(async () => {
			secondHook.result.current.setMode('new');
		});
		expect(conversationMocks.startInlineWizardConversation).toHaveBeenLastCalledWith(
			expect.objectContaining({
				directoryPath: '/auto',
				mode: 'new',
				projectName: 'Project',
			})
		);
		secondHook.unmount();

		const startsBeforeMissingAgent =
			conversationMocks.startInlineWizardConversation.mock.calls.length;
		const thirdHook = renderHook(() => useInlineWizard());
		await act(async () => {
			await thirdHook.result.current.startWizard(
				undefined,
				previousUiState,
				undefined,
				undefined,
				undefined,
				'tab-setmode-missing-agent',
				undefined,
				'/auto'
			);
		});
		expect(thirdHook.result.current.wizardMode).toBe('ask');
		act(() => {
			thirdHook.result.current.setMode('new');
		});
		expect(conversationMocks.startInlineWizardConversation).toHaveBeenCalledTimes(
			startsBeforeMissingAgent
		);
		thirdHook.unmount();
	});

	it('retries when the failed history no longer contains the user message', async () => {
		conversationMocks.sendWizardMessage
			.mockResolvedValueOnce({ success: false, error: 'first failure' })
			.mockResolvedValueOnce({
				success: true,
				response: { message: 'Retried.', confidence: 90, ready: true },
			});
		const { result } = renderHook(() => useInlineWizard());

		await act(async () => {
			await result.current.startWizard(
				'start fresh',
				previousUiState,
				'/project',
				'claude-code',
				'Project',
				'tab-retry-without-user',
				'session-retry',
				'/auto'
			);
		});
		await act(async () => {
			await result.current.sendMessage('will be retried');
		});
		expect(result.current.error).toBe('first failure');

		act(() => {
			result.current.clearConversation();
			result.current.addAssistantMessage('Assistant-only history');
		});
		await act(async () => {
			await result.current.retryLastMessage();
		});

		const retryCall = conversationMocks.sendWizardMessage.mock.calls.at(-1);
		expect(retryCall?.[1]).toBe('will be retried');
		expect(retryCall?.[2]).toEqual([expect.objectContaining({ role: 'assistant' })]);
		expect(retryCall?.[3]).toBeUndefined();
		expect(result.current.error).toBeNull();
	});

	it('covers document generation progress, result, and thrown fallback branches', async () => {
		const doc: InlineGeneratedDocument = {
			filename: 'Phase-Fallback.md',
			content: '# Fallback',
			taskCount: 1,
		};
		const callbacks = {
			onStart: vi.fn(),
			onProgress: vi.fn(),
			onChunk: vi.fn(),
			onDocumentComplete: vi.fn(),
			onComplete: vi.fn(),
			onError: vi.fn(),
		};
		documentGenerationMocks.extractDisplayTextFromChunk.mockReturnValueOnce('');
		documentGenerationMocks.generateInlineDocuments.mockImplementationOnce(async (config) => {
			config.callbacks.onStart();
			config.callbacks.onProgress('Working without numeric progress');
			config.callbacks.onChunk('chunk without display text');
			config.callbacks.onDocumentComplete(doc);
			config.callbacks.onComplete([doc]);
			return { success: true };
		});
		const { result } = renderHook(() => useInlineWizard());

		await act(async () => {
			await result.current.startWizard(
				'add fallback coverage',
				previousUiState,
				undefined,
				'claude-code',
				undefined,
				'tab-generate-fallback',
				undefined,
				'/auto'
			);
		});
		await act(async () => {
			result.current.addAssistantMessage('Ready for fallback generation', 95, true);
			await result.current.generateDocuments(callbacks);
		});

		expect(documentGenerationMocks.generateInlineDocuments).toHaveBeenLastCalledWith(
			expect.objectContaining({
				directoryPath: '/auto',
				mode: 'iterate',
				projectName: 'Project',
				sessionId: undefined,
			})
		);
		expect(callbacks.onProgress).toHaveBeenCalledWith('Working without numeric progress');
		expect(callbacks.onDocumentComplete).toHaveBeenCalledWith(doc);
		expect(result.current.generatedDocuments).toEqual([]);
		expect(result.current.generationProgress).toEqual({ current: 0, total: 0 });
		expect(result.current.state.subfolderName).toBeNull();
		expect(result.current.state.subfolderPath).toBeNull();

		documentGenerationMocks.generateInlineDocuments.mockResolvedValueOnce({ success: false });
		await act(async () => {
			await result.current.generateDocuments(callbacks);
		});
		expect(result.current.error).toBe('Document generation failed');

		documentGenerationMocks.generateInlineDocuments.mockRejectedValueOnce('non-error generation');
		await act(async () => {
			await result.current.generateDocuments(callbacks);
		});
		expect(result.current.error).toBe('Unknown error during document generation');
		expect(callbacks.onError).toHaveBeenLastCalledWith('Unknown error during document generation');
	});
});
