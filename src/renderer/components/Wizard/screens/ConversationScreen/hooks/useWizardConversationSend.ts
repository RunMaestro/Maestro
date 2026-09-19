import { useCallback, type MutableRefObject } from 'react';
import {
	conversationManager,
	createAssistantMessage,
	createUserMessage,
	type ConversationCallbacks,
	type SendMessageResult,
} from '../../../services/conversationManager';
import { getNextFillerPhrase } from '../../../services/fillerPhrases';
import { READY_CONFIDENCE_THRESHOLD } from '../../../services/wizardPrompts';
import { logger } from '../../../../../utils/logger';
import { AUTO_CONTINUE_MESSAGE, containsDeferredResponsePhrase } from '../utils/deferredResponse';
import { fetchExistingDocsForWizard } from '../utils/existingDocs';
import { extractStreamingTextFromChunk } from '../utils/streamingChunks';
import { isStructuredThinkingResponse } from '../utils/thinkingFilters';
import type { SendStateSetters, ToolExecutionEvent, WizardConversationState } from '../types';

interface WizardConversationSendParams {
	state: WizardConversationState;
	inputValue: string;
	showInitialQuestion: boolean;
	initialQuestion: string;
	refs: {
		inputRef: MutableRefObject<HTMLTextAreaElement | null>;
		isSendingRef: MutableRefObject<boolean>;
		initialQuestionAddedRef: MutableRefObject<boolean>;
		autoContinueTriggeredRef: MutableRefObject<boolean>;
		showThinkingRef: MutableRefObject<boolean>;
	};
	setters: SendStateSetters;
	addMessage: (message: ReturnType<typeof createUserMessage>) => void;
	setConfidenceLevel: (level: number) => void;
	setIsReadyToProceed: (ready: boolean) => void;
	setConversationLoading: (loading: boolean) => void;
	setConversationError: (error: string | null) => void;
	announce: (message: string) => void;
	scheduleAutoContinue: (message: string) => void;
}

function appendStreamingChunk(
	chunk: string,
	setStreamingText: SendStateSetters['setStreamingText']
): void {
	const text = extractStreamingTextFromChunk(chunk);
	if (text) {
		setStreamingText((prev) => prev + text);
	}
}

function handleThinkingChunk(
	content: string,
	showThinkingRef: MutableRefObject<boolean>,
	setThinkingContent: SendStateSetters['setThinkingContent']
): void {
	if (!showThinkingRef.current || isStructuredThinkingResponse(content)) {
		return;
	}

	setThinkingContent((prev) => prev + content);
}

function handleToolExecution(
	toolEvent: ToolExecutionEvent,
	showThinkingRef: MutableRefObject<boolean>,
	setToolExecutions: SendStateSetters['setToolExecutions']
): void {
	if (showThinkingRef.current) {
		setToolExecutions((prev) => [...prev, toolEvent]);
	}
}

function createSendCallbacks({
	mode,
	setters,
	refs,
	addMessage,
	setConfidenceLevel,
	setIsReadyToProceed,
	setConversationError,
	announce,
	scheduleAutoContinue,
	markErrorHandled,
}: {
	mode: 'message' | 'continue';
	setters: SendStateSetters;
	refs: WizardConversationSendParams['refs'];
	addMessage: WizardConversationSendParams['addMessage'];
	setConfidenceLevel: (level: number) => void;
	setIsReadyToProceed: (ready: boolean) => void;
	setConversationError: (error: string | null) => void;
	announce: (message: string) => void;
	scheduleAutoContinue: (message: string) => void;
	markErrorHandled?: () => void;
}): ConversationCallbacks {
	return {
		onSending: () => {
			// Loading state is already set before sending.
		},
		onReceiving: () => {
			// Agent is responding.
		},
		onChunk: (chunk) => {
			appendStreamingChunk(chunk, setters.setStreamingText);
		},
		onThinkingChunk: (content) => {
			handleThinkingChunk(content, refs.showThinkingRef, setters.setThinkingContent);
		},
		onToolExecution: (toolEvent) => {
			handleToolExecution(toolEvent, refs.showThinkingRef, setters.setToolExecutions);
		},
		onComplete: (sendResult) => {
			setters.setStreamingText('');
			setters.setThinkingContent('');
			setters.setToolExecutions([]);

			logger.info('[ConversationScreen] onComplete:', undefined, {
				success: sendResult.success,
				hasResponse: !!sendResult.response,
				parseSuccess: sendResult.response?.parseSuccess,
				hasStructured: !!sendResult.response?.structured,
			});

			if (sendResult.success && sendResult.response) {
				addMessage(createAssistantMessage(sendResult.response));

				if (sendResult.response.structured) {
					const newConfidence = sendResult.response.structured.confidence;
					logger.info('[ConversationScreen] Setting confidence to:', undefined, newConfidence);
					setConfidenceLevel(newConfidence);

					const isReady =
						sendResult.response.structured.ready && newConfidence >= READY_CONFIDENCE_THRESHOLD;
					logger.info('[ConversationScreen] isReady:', undefined, [
						isReady,
						'ready flag:',
						sendResult.response.structured.ready,
					]);
					setIsReadyToProceed(isReady);

					if (!isReady) {
						const prefix = mode === 'continue' ? 'Analysis complete' : 'Response received';
						announce(`${prefix}. Project understanding at ${newConfidence}%.`);
					}
				} else {
					logger.info('[ConversationScreen] No structured data in response');
					announce(
						mode === 'continue' ? 'Analysis complete.' : 'Response received from AI assistant.'
					);
				}

				setters.setErrorRetryCount(0);

				if (mode === 'message') {
					const messageContent =
						sendResult.response.structured?.message || sendResult.response.rawText;
					if (
						messageContent &&
						containsDeferredResponsePhrase(messageContent) &&
						!refs.autoContinueTriggeredRef.current
					) {
						logger.info(
							'[ConversationScreen] Detected deferred response phrase, scheduling auto-continue'
						);
						refs.autoContinueTriggeredRef.current = true;
						scheduleAutoContinue(AUTO_CONTINUE_MESSAGE);
					}
				}
			}
		},
		onError: (error) => {
			markErrorHandled?.();
			logger.error('Conversation error:', undefined, error);
			setConversationError(error);
			setters.setDetectedError(null);
			announce(`Error: ${error}. Please try again.`);
			setters.setErrorRetryCount((prev) => prev + 1);
		},
	};
}

function applySendFailure(
	result: SendMessageResult,
	setConversationError: (error: string | null) => void,
	setters: SendStateSetters,
	alreadyHandled: boolean
): void {
	if (alreadyHandled) {
		return;
	}

	if (!result.success && result.error) {
		setConversationError(result.error);
		if (result.detectedError) {
			setters.setDetectedError(result.detectedError);
		}
		setters.setErrorRetryCount((prev) => prev + 1);
	}
}

function resetTransientState(setters: SendStateSetters): void {
	setters.setDetectedError(null);
	setters.setStreamingText('');
	setters.setThinkingContent('');
	setters.setToolExecutions([]);
	setters.setFillerPhrase(getNextFillerPhrase());
}

export function useWizardConversationSend({
	state,
	inputValue,
	showInitialQuestion,
	initialQuestion,
	refs,
	setters,
	addMessage,
	setConfidenceLevel,
	setIsReadyToProceed,
	setConversationLoading,
	setConversationError,
	announce,
	scheduleAutoContinue,
}: WizardConversationSendParams): {
	handleSendMessage: () => Promise<void>;
	sendInitialContinueMessage: () => Promise<void>;
} {
	const handleSendMessage = useCallback(async () => {
		const trimmedInput = inputValue.trim();
		if (!trimmedInput || state.isConversationLoading || refs.isSendingRef.current) {
			return;
		}

		refs.isSendingRef.current = true;

		if (trimmedInput !== AUTO_CONTINUE_MESSAGE) {
			refs.autoContinueTriggeredRef.current = false;
		}

		setters.setInputValue('');
		if (refs.inputRef.current) {
			refs.inputRef.current.style.height = 'auto';
		}
		setConversationError(null);
		resetTransientState(setters);

		if (showInitialQuestion && !refs.initialQuestionAddedRef.current) {
			refs.initialQuestionAddedRef.current = true;
			addMessage({
				role: 'assistant',
				content: initialQuestion,
			});
			setters.setShowInitialQuestion(false);
		}

		addMessage(createUserMessage(trimmedInput));
		setConversationLoading(true);
		announce('Message sent. AI assistant is thinking...');

		try {
			if (!conversationManager.isConversationActive()) {
				if (!state.selectedAgent) {
					setConversationError('No agent selected. Please go back and select an agent.');
					setConversationLoading(false);
					return;
				}
				await conversationManager.startConversation({
					agentType: state.selectedAgent,
					directoryPath: state.directoryPath,
					projectName: state.agentName || 'My Project',
					sshRemoteConfig: state.sessionSshRemoteConfig,
					customPath: state.customPath,
					customArgs: state.customArgs,
					customEnvVars: state.customEnvVars,
					agentConfigValues: state.agentConfigValues,
				});
			}

			let handledByOnError = false;
			const result = await conversationManager.sendMessage(
				trimmedInput,
				state.conversationHistory,
				createSendCallbacks({
					mode: 'message',
					setters,
					refs,
					addMessage,
					setConfidenceLevel,
					setIsReadyToProceed,
					setConversationError,
					announce,
					scheduleAutoContinue,
					markErrorHandled: () => {
						handledByOnError = true;
					},
				})
			);

			applySendFailure(result, setConversationError, setters, handledByOnError);
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
			setConversationError(errorMessage);
			setters.setErrorRetryCount((prev) => prev + 1);
		} finally {
			setConversationLoading(false);
			refs.isSendingRef.current = false;
			refs.inputRef.current?.focus();
		}
	}, [
		inputValue,
		showInitialQuestion,
		state.isConversationLoading,
		state.conversationHistory,
		state.selectedAgent,
		state.directoryPath,
		state.agentName,
		state.sessionSshRemoteConfig,
		state.customPath,
		state.customArgs,
		state.customEnvVars,
		state.agentConfigValues,
		refs,
		setters,
		addMessage,
		initialQuestion,
		setConversationLoading,
		setConversationError,
		setConfidenceLevel,
		setIsReadyToProceed,
		announce,
		scheduleAutoContinue,
	]);

	const sendInitialContinueMessage = useCallback(async () => {
		if (state.isConversationLoading || refs.isSendingRef.current) {
			return;
		}

		refs.isSendingRef.current = true;

		setConversationError(null);
		resetTransientState(setters);

		setters.setShowInitialQuestion(false);
		refs.initialQuestionAddedRef.current = true;

		const continueMessage =
			'Please analyze the existing Auto Run documents and provide a synopsis of the current plan.';
		addMessage(createUserMessage(continueMessage));
		setConversationLoading(true);
		announce('Analyzing existing documents...');

		try {
			if (!conversationManager.isConversationActive()) {
				if (!state.selectedAgent) {
					setConversationError('No agent selected. Please go back and select an agent.');
					setConversationLoading(false);
					return;
				}

				const existingDocs = await fetchExistingDocsForWizard(state.directoryPath, 'continue');

				await conversationManager.startConversation({
					agentType: state.selectedAgent,
					directoryPath: state.directoryPath,
					projectName: state.agentName || 'My Project',
					existingDocs: existingDocs.length > 0 ? existingDocs : undefined,
					sshRemoteConfig: state.sessionSshRemoteConfig,
					customPath: state.customPath,
					customArgs: state.customArgs,
					customEnvVars: state.customEnvVars,
					agentConfigValues: state.agentConfigValues,
				});
			}

			let handledByOnError = false;
			const result = await conversationManager.sendMessage(
				continueMessage,
				[],
				createSendCallbacks({
					mode: 'continue',
					setters,
					refs,
					addMessage,
					setConfidenceLevel,
					setIsReadyToProceed,
					setConversationError,
					announce,
					scheduleAutoContinue,
					markErrorHandled: () => {
						handledByOnError = true;
					},
				})
			);

			applySendFailure(result, setConversationError, setters, handledByOnError);
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
			setConversationError(errorMessage);
			setters.setErrorRetryCount((prev) => prev + 1);
		} finally {
			setConversationLoading(false);
			refs.isSendingRef.current = false;
			refs.inputRef.current?.focus();
		}
	}, [
		state.isConversationLoading,
		state.selectedAgent,
		state.directoryPath,
		state.agentName,
		state.sessionSshRemoteConfig,
		state.customPath,
		state.customArgs,
		state.customEnvVars,
		state.agentConfigValues,
		refs,
		setters,
		addMessage,
		setConversationLoading,
		setConversationError,
		setConfidenceLevel,
		setIsReadyToProceed,
		announce,
		scheduleAutoContinue,
	]);

	return { handleSendMessage, sendInitialContinueMessage };
}
