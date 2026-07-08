import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useConversationAnnouncements } from '../../../../../../renderer/components/Wizard/screens/ConversationScreen/hooks/useConversationAnnouncements';
import { useConversationAutoContinue } from '../../../../../../renderer/components/Wizard/screens/ConversationScreen/hooks/useConversationAutoContinue';
import { useConversationBootstrap } from '../../../../../../renderer/components/Wizard/screens/ConversationScreen/hooks/useConversationBootstrap';
import { useWizardConversationSend } from '../../../../../../renderer/components/Wizard/screens/ConversationScreen/hooks/useWizardConversationSend';
import { AUTO_CONTINUE_MESSAGE } from '../../../../../../renderer/components/Wizard/screens/ConversationScreen/utils/deferredResponse';
import type {
	ConversationRefs,
	SendStateSetters,
	WizardConversationState,
} from '../../../../../../renderer/components/Wizard/screens/ConversationScreen/types';

const conversationMocks = vi.hoisted(() => ({
	startConversation: vi.fn(),
	sendMessage: vi.fn(),
	endConversation: vi.fn(),
	isConversationActive: vi.fn(),
}));

const sentryMocks = vi.hoisted(() => ({
	captureException: vi.fn(),
}));

vi.mock(
	'../../../../../../renderer/components/Wizard/services/conversationManager',
	async (importOriginal) => {
		const actual =
			await importOriginal<
				typeof import('../../../../../../renderer/components/Wizard/services/conversationManager')
			>();

		return {
			...actual,
			conversationManager: conversationMocks,
		};
	}
);

vi.mock('../../../../../../renderer/utils/sentry', () => sentryMocks);

function createState(overrides: Partial<WizardConversationState> = {}): WizardConversationState {
	return {
		selectedAgent: 'claude-code',
		directoryPath: '/project',
		agentName: 'Project',
		conversationHistory: [],
		isConversationLoading: false,
		existingDocsChoice: null,
		sessionSshRemoteConfig: undefined,
		...overrides,
	};
}

function createRefs(): ConversationRefs {
	const input = document.createElement('textarea');
	vi.spyOn(input, 'focus');

	return {
		inputRef: { current: input },
		isSendingRef: { current: false },
		initialQuestionAddedRef: { current: false },
		autoContinueTriggeredRef: { current: false },
		showThinkingRef: { current: true },
	};
}

function createSetters(): SendStateSetters {
	return {
		setInputValue: vi.fn(),
		setShowInitialQuestion: vi.fn(),
		setStreamingText: vi.fn(),
		setFillerPhrase: vi.fn(),
		setDetectedError: vi.fn(),
		setThinkingContent: vi.fn(),
		setToolExecutions: vi.fn(),
		setErrorRetryCount: vi.fn(),
	};
}

function renderSendHook({
	state = createState(),
	inputValue = 'Build a dashboard',
	showInitialQuestion = true,
	refs = createRefs(),
	setters = createSetters(),
	addMessage = vi.fn(),
	setConfidenceLevel = vi.fn(),
	setIsReadyToProceed = vi.fn(),
	setConversationLoading = vi.fn(),
	setConversationError = vi.fn(),
	announce = vi.fn(),
	scheduleAutoContinue = vi.fn(),
}: Partial<{
	state: WizardConversationState;
	inputValue: string;
	showInitialQuestion: boolean;
	refs: ConversationRefs;
	setters: SendStateSetters;
	addMessage: ReturnType<typeof vi.fn>;
	setConfidenceLevel: ReturnType<typeof vi.fn>;
	setIsReadyToProceed: ReturnType<typeof vi.fn>;
	setConversationLoading: ReturnType<typeof vi.fn>;
	setConversationError: ReturnType<typeof vi.fn>;
	announce: ReturnType<typeof vi.fn>;
	scheduleAutoContinue: ReturnType<typeof vi.fn>;
}> = {}) {
	const rendered = renderHook(() =>
		useWizardConversationSend({
			state,
			inputValue,
			showInitialQuestion,
			initialQuestion: 'Initial question?',
			refs,
			setters,
			addMessage,
			setConfidenceLevel,
			setIsReadyToProceed,
			setConversationLoading,
			setConversationError,
			announce,
			scheduleAutoContinue,
		})
	);

	return {
		...rendered,
		state,
		refs,
		setters,
		addMessage,
		setConfidenceLevel,
		setIsReadyToProceed,
		setConversationLoading,
		setConversationError,
		announce,
		scheduleAutoContinue,
	};
}

describe('ConversationScreen hooks', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		conversationMocks.startConversation.mockResolvedValue('wizard-session');
		conversationMocks.isConversationActive.mockReturnValue(true);
		conversationMocks.sendMessage.mockResolvedValue({ success: true });
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe('useConversationAnnouncements', () => {
		it('announces explicit messages and ready transitions', () => {
			const { result, rerender } = renderHook(
				({ ready, confidence }) =>
					useConversationAnnouncements({
						isReadyToProceed: ready,
						confidenceLevel: confidence,
					}),
				{ initialProps: { ready: false, confidence: 40 } }
			);

			act(() => result.current.announce('Message sent'));
			expect(result.current.announcement).toBe('Message sent');
			expect(result.current.announcementKey).toBe(1);

			rerender({ ready: true, confidence: 85 });
			expect(result.current.announcement).toBe(
				'Confidence level 85%. Ready to proceed! You can now create your Playbook.'
			);
			expect(result.current.announcementKey).toBe(2);

			rerender({ ready: true, confidence: 90 });
			expect(result.current.announcementKey).toBe(2);
		});
	});

	describe('useConversationAutoContinue', () => {
		it('delays setting the auto-continue input and then sends it', () => {
			vi.useFakeTimers();
			const setInputValue = vi.fn();
			const handleSend = vi.fn();
			const isSendingRef = { current: false };
			const handleSendMessageRef = { current: handleSend };

			const { result, rerender } = renderHook(
				({ inputValue }) =>
					useConversationAutoContinue({
						inputValue,
						isConversationLoading: false,
						isSendingRef,
						setInputValue,
						handleSendMessageRef,
					}),
				{ initialProps: { inputValue: '' } }
			);

			act(() => result.current(AUTO_CONTINUE_MESSAGE));
			rerender({ inputValue: '' });
			act(() => vi.advanceTimersByTime(799));
			expect(setInputValue).not.toHaveBeenCalled();

			act(() => vi.advanceTimersByTime(1));
			expect(setInputValue).toHaveBeenCalledWith(AUTO_CONTINUE_MESSAGE);

			rerender({ inputValue: AUTO_CONTINUE_MESSAGE });
			act(() => vi.advanceTimersByTime(0));
			expect(handleSend).toHaveBeenCalledTimes(1);
		});

		it('does not send while already sending', () => {
			const handleSend = vi.fn();
			renderHook(() =>
				useConversationAutoContinue({
					inputValue: AUTO_CONTINUE_MESSAGE,
					isConversationLoading: false,
					isSendingRef: { current: true },
					setInputValue: vi.fn(),
					handleSendMessageRef: { current: handleSend },
				})
			);

			expect(handleSend).not.toHaveBeenCalled();
		});

		it('does not schedule input while conversation is loading', () => {
			vi.useFakeTimers();
			const setInputValue = vi.fn();
			const { result } = renderHook(() =>
				useConversationAutoContinue({
					inputValue: '',
					isConversationLoading: true,
					isSendingRef: { current: false },
					setInputValue,
					handleSendMessageRef: { current: vi.fn() },
				})
			);

			act(() => result.current(AUTO_CONTINUE_MESSAGE));
			act(() => vi.advanceTimersByTime(800));

			expect(setInputValue).not.toHaveBeenCalled();
		});
	});

	describe('useConversationBootstrap', () => {
		it('starts a fresh conversation and cleans it up on unmount', async () => {
			const setConversationStarted = vi.fn();
			const { unmount } = renderHook(() =>
				useConversationBootstrap({
					state: createState(),
					conversationStarted: false,
					setConversationStarted,
					setShowInitialQuestion: vi.fn(),
					initialQuestionAddedRef: { current: false },
					setConversationError: vi.fn(),
				})
			);

			await waitFor(() => expect(conversationMocks.startConversation).toHaveBeenCalled());
			expect(conversationMocks.startConversation).toHaveBeenCalledWith({
				agentType: 'claude-code',
				directoryPath: '/project',
				projectName: 'Project',
				existingDocs: undefined,
				sshRemoteConfig: undefined,
			});
			expect(setConversationStarted).toHaveBeenCalledWith(true);

			unmount();
			expect(conversationMocks.endConversation).toHaveBeenCalledTimes(1);
		});

		it('resumes existing history without restarting the manager', () => {
			const initialQuestionAddedRef = { current: false };
			const setConversationStarted = vi.fn();
			const setShowInitialQuestion = vi.fn();

			renderHook(() =>
				useConversationBootstrap({
					state: createState({
						conversationHistory: [{ id: 'm1', role: 'assistant', content: 'Hi', timestamp: 1 }],
					}),
					conversationStarted: false,
					setConversationStarted,
					setShowInitialQuestion,
					initialQuestionAddedRef,
					setConversationError: vi.fn(),
				})
			);

			expect(conversationMocks.startConversation).not.toHaveBeenCalled();
			expect(setConversationStarted).toHaveBeenCalledWith(true);
			expect(setShowInitialQuestion).toHaveBeenCalledWith(false);
			expect(initialQuestionAddedRef.current).toBe(true);
		});

		it('surfaces initialization failures', async () => {
			const error = new Error('spawn failed');
			conversationMocks.startConversation.mockRejectedValueOnce(error);
			const setConversationError = vi.fn();

			renderHook(() =>
				useConversationBootstrap({
					state: createState(),
					conversationStarted: false,
					setConversationStarted: vi.fn(),
					setShowInitialQuestion: vi.fn(),
					initialQuestionAddedRef: { current: false },
					setConversationError,
				})
			);

			await waitFor(() =>
				expect(setConversationError).toHaveBeenCalledWith(
					'Failed to initialize conversation. Please try again.'
				)
			);
			expect(sentryMocks.captureException).toHaveBeenCalledWith(error, {
				level: 'error',
				tags: { area: 'conversation_bootstrap' },
				extra: {
					mounted: true,
					selectedAgent: 'claude-code',
					directoryPath: '/project',
					agentName: 'Project',
					existingDocsChoice: null,
					conversationHistoryLength: 0,
					hasSshRemoteConfig: false,
					sshRemoteId: null,
				},
			});
		});
	});

	describe('useWizardConversationSend', () => {
		it('sends a normal message, streams callbacks, and marks ready', async () => {
			const response = {
				structured: { confidence: 85, ready: true, message: 'Ready' },
				rawText: 'Ready',
				parseSuccess: true,
			};
			conversationMocks.sendMessage.mockImplementation(async (_message, _history, callbacks) => {
				callbacks.onChunk?.(
					'{"type":"stream_event","event":{"type":"content_block_delta","delta":{"text":"Hi"}}}'
				);
				callbacks.onThinkingChunk?.('thinking');
				callbacks.onThinkingChunk?.('{"confidence":85,"message":"Ready"}');
				callbacks.onToolExecution?.({ toolName: 'Read', timestamp: 1 });
				callbacks.onComplete?.({ success: true, response });
				return { success: true, response };
			});

			const hook = renderSendHook();

			await act(async () => {
				await hook.result.current.handleSendMessage();
			});

			expect(hook.setters.setInputValue).toHaveBeenCalledWith('');
			expect(hook.setters.setShowInitialQuestion).toHaveBeenCalledWith(false);
			expect(hook.addMessage).toHaveBeenCalledWith({
				role: 'assistant',
				content: 'Initial question?',
			});
			expect(hook.addMessage).toHaveBeenCalledWith({
				role: 'user',
				content: 'Build a dashboard',
			});
			expect(hook.setters.setStreamingText).toHaveBeenCalledWith(expect.any(Function));
			expect(hook.setters.setThinkingContent).toHaveBeenCalledWith(expect.any(Function));
			expect(hook.setters.setToolExecutions).toHaveBeenCalledWith(expect.any(Function));
			expect(hook.setConfidenceLevel).toHaveBeenCalledWith(85);
			expect(hook.setIsReadyToProceed).toHaveBeenCalledWith(true);
			expect(hook.setConversationLoading).toHaveBeenNthCalledWith(1, true);
			expect(hook.setConversationLoading).toHaveBeenLastCalledWith(false);
			expect(hook.refs.inputRef.current?.focus).toHaveBeenCalled();
		});

		it('prevents duplicate sends with the immediate guard', async () => {
			const refs = createRefs();
			refs.isSendingRef.current = true;
			const hook = renderSendHook({ refs });

			await act(async () => {
				await hook.result.current.handleSendMessage();
			});

			expect(conversationMocks.sendMessage).not.toHaveBeenCalled();
		});

		it('schedules auto-continue once for deferred assistant responses', async () => {
			const response = {
				structured: {
					confidence: 50,
					ready: false,
					message: 'Let me research this for you.',
				},
				rawText: 'Let me research this for you.',
				parseSuccess: true,
			};
			conversationMocks.sendMessage.mockImplementation(async (_message, _history, callbacks) => {
				callbacks.onComplete?.({ success: true, response });
				return { success: true, response };
			});

			const hook = renderSendHook({ showInitialQuestion: false });

			await act(async () => {
				await hook.result.current.handleSendMessage();
			});

			expect(hook.scheduleAutoContinue).toHaveBeenCalledWith(AUTO_CONTINUE_MESSAGE);
			expect(hook.refs.autoContinueTriggeredRef.current).toBe(true);
		});

		it('propagates detected send failures', async () => {
			const detectedError = {
				type: 'rate_limited' as const,
				title: 'Rate limited',
				message: 'Slow down',
				recoveryHint: 'Try later',
				canRetry: true,
			};
			conversationMocks.sendMessage.mockResolvedValue({
				success: false,
				error: 'Failed',
				detectedError,
			});
			const hook = renderSendHook({ showInitialQuestion: false });

			await act(async () => {
				await hook.result.current.handleSendMessage();
			});

			expect(hook.setConversationError).toHaveBeenCalledWith('Failed');
			expect(hook.setters.setDetectedError).toHaveBeenCalledWith(detectedError);
			expect(hook.setters.setErrorRetryCount).toHaveBeenCalledWith(expect.any(Function));
		});

		it('propagates callback errors and announcements', async () => {
			conversationMocks.sendMessage.mockImplementation(async (_message, _history, callbacks) => {
				callbacks.onError?.('Callback failed');
				return { success: false, error: 'Callback failed' };
			});
			const hook = renderSendHook({ showInitialQuestion: false });

			await act(async () => {
				await hook.result.current.handleSendMessage();
			});

			expect(hook.setConversationError).toHaveBeenCalledWith('Callback failed');
			expect(hook.announce).toHaveBeenCalledWith('Error: Callback failed. Please try again.');
			expect(hook.setters.setErrorRetryCount).toHaveBeenCalledTimes(1);
		});

		it('ignores thinking and tool callbacks while thinking display is off', async () => {
			conversationMocks.sendMessage.mockImplementation(async (_message, _history, callbacks) => {
				callbacks.onThinkingChunk?.('hidden thinking');
				callbacks.onToolExecution?.({ toolName: 'Read', timestamp: 1 });
				return { success: true };
			});
			const refs = createRefs();
			refs.showThinkingRef.current = false;
			const setters = createSetters();
			const hook = renderSendHook({ refs, setters, showInitialQuestion: false });

			await act(async () => {
				await hook.result.current.handleSendMessage();
			});

			expect(setters.setThinkingContent).toHaveBeenCalledWith('');
			expect(setters.setThinkingContent).not.toHaveBeenCalledWith(expect.any(Function));
			expect(setters.setToolExecutions).toHaveBeenCalledWith([]);
			expect(setters.setToolExecutions).not.toHaveBeenCalledWith(expect.any(Function));
		});

		it('auto-sends existing-doc analysis with empty history', async () => {
			conversationMocks.sendMessage.mockResolvedValue({ success: true });
			const hook = renderSendHook({ inputValue: '', showInitialQuestion: true });

			await act(async () => {
				await hook.result.current.sendInitialContinueMessage();
			});

			expect(hook.setters.setShowInitialQuestion).toHaveBeenCalledWith(false);
			expect(hook.refs.initialQuestionAddedRef.current).toBe(true);
			expect(hook.addMessage).toHaveBeenCalledWith({
				role: 'user',
				content:
					'Please analyze the existing Auto Run documents and provide a synopsis of the current plan.',
			});
			expect(conversationMocks.sendMessage).toHaveBeenCalledWith(
				expect.stringContaining('Please analyze the existing Auto Run documents'),
				[],
				expect.any(Object)
			);
			expect(hook.announce).toHaveBeenCalledWith('Analyzing existing documents...');
		});

		it('starts the conversation if a send arrives after manager cleanup', async () => {
			conversationMocks.isConversationActive.mockReturnValue(false);
			conversationMocks.sendMessage.mockResolvedValue({ success: true });
			const hook = renderSendHook({ showInitialQuestion: false });

			await act(async () => {
				await hook.result.current.handleSendMessage();
			});

			expect(conversationMocks.startConversation).toHaveBeenCalledWith({
				agentType: 'claude-code',
				directoryPath: '/project',
				projectName: 'Project',
				sshRemoteConfig: undefined,
			});
		});
	});
});
