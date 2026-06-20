import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useWizard } from '../../WizardContext';
import { getInitialQuestion } from '../../services/wizardPrompts';
import type { WizardError } from '../../services/wizardErrorDetection';
import { wizardDebugLogger } from '../../services/phaseGenerator';
import { getNextFillerPhrase } from '../../services/fillerPhrases';
import { ScreenReaderAnnouncement } from '../../ScreenReaderAnnouncement';
import { TypingIndicator } from '../../shared/TypingIndicator';
import {
	ConfidenceMeter,
	ConversationErrorPanel,
	ConversationInputPanel,
	InitialQuestionBubble,
	MessageBubble,
	ReadyToProceedPanel,
	StreamingResponseBubble,
	ThinkingDisplay,
} from './components';
import {
	useConversationAnnouncements,
	useConversationAutoContinue,
	useConversationBootstrap,
	useConversationScrollFocus,
	useWizardConversationSend,
} from './hooks';
import { getConversationProviderName } from './utils/providerName';
import type {
	ConversationRefs,
	ConversationScreenProps,
	SendStateSetters,
	ToolExecutionEvent,
} from './types';

export function ConversationScreen({
	theme,
	showThinking,
	setShowThinking,
}: ConversationScreenProps): JSX.Element {
	const {
		state,
		addMessage,
		setConfidenceLevel,
		setIsReadyToProceed,
		setConversationLoading,
		setConversationError,
		previousStep,
		nextStep,
	} = useWizard();

	const [inputValue, setInputValue] = useState('');
	const [conversationStarted, setConversationStarted] = useState(false);
	const [showInitialQuestion, setShowInitialQuestion] = useState(
		state.conversationHistory.length === 0
	);
	const [initialQuestion] = useState(() => getInitialQuestion());
	const [errorRetryCount, setErrorRetryCount] = useState(0);
	const [streamingText, setStreamingText] = useState('');
	const [fillerPhrase, setFillerPhrase] = useState('');
	const [detectedError, setDetectedError] = useState<WizardError | null>(null);
	const [thinkingContent, setThinkingContent] = useState('');
	const [toolExecutions, setToolExecutions] = useState<ToolExecutionEvent[]>([]);

	const containerRef = useRef<HTMLDivElement>(null);
	const messagesEndRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLTextAreaElement>(null);
	const isSendingRef = useRef(false);
	const autoContinueTriggeredRef = useRef(false);
	const autoSentInitialMessageRef = useRef(false);
	const initialQuestionAddedRef = useRef(false);
	const showThinkingRef = useRef(showThinking);
	const handleSendMessageRef = useRef<(() => void) | null>(null);

	useEffect(() => {
		showThinkingRef.current = showThinking;
	}, [showThinking]);

	const conversationRefs = useMemo<ConversationRefs>(
		() => ({
			inputRef,
			isSendingRef,
			initialQuestionAddedRef,
			autoContinueTriggeredRef,
			showThinkingRef,
		}),
		[]
	);

	const sendSetters = useMemo<SendStateSetters>(
		() => ({
			setInputValue,
			setShowInitialQuestion,
			setStreamingText,
			setFillerPhrase,
			setDetectedError,
			setThinkingContent,
			setToolExecutions,
			setErrorRetryCount,
		}),
		[]
	);

	const { announcement, announcementKey, announce } = useConversationAnnouncements({
		isReadyToProceed: state.isReadyToProceed,
		confidenceLevel: state.confidenceLevel,
	});

	useConversationScrollFocus({
		messagesEndRef,
		inputRef,
		conversationHistory: state.conversationHistory,
		isConversationLoading: state.isConversationLoading,
	});

	useConversationBootstrap({
		state,
		conversationStarted,
		setConversationStarted,
		setShowInitialQuestion,
		initialQuestionAddedRef,
		setConversationError,
	});

	const scheduleAutoContinue = useConversationAutoContinue({
		inputValue,
		isConversationLoading: state.isConversationLoading,
		isSendingRef,
		setInputValue,
		handleSendMessageRef,
	});

	const { handleSendMessage, sendInitialContinueMessage } = useWizardConversationSend({
		state,
		inputValue,
		showInitialQuestion,
		initialQuestion,
		refs: conversationRefs,
		setters: sendSetters,
		addMessage,
		setConfidenceLevel,
		setIsReadyToProceed,
		setConversationLoading,
		setConversationError,
		announce,
		scheduleAutoContinue,
	});

	useEffect(() => {
		handleSendMessageRef.current = handleSendMessage;
	}, [handleSendMessage]);

	useEffect(() => {
		if (
			conversationStarted &&
			state.existingDocsChoice === 'continue' &&
			!autoSentInitialMessageRef.current &&
			state.conversationHistory.length === 0
		) {
			autoSentInitialMessageRef.current = true;
			const timer = setTimeout(() => {
				sendInitialContinueMessage();
			}, 100);
			return () => clearTimeout(timer);
		}
	}, [
		conversationStarted,
		state.existingDocsChoice,
		state.conversationHistory.length,
		sendInitialContinueMessage,
	]);

	const handleRetry = useCallback(() => {
		setConversationError(null);
		setDetectedError(null);
		inputRef.current?.focus();
	}, [setConversationError]);

	const handleDownloadDebugLogs = useCallback(() => {
		wizardDebugLogger.downloadLogs();
	}, []);

	const handleRequestNewPhrase = useCallback(() => {
		setFillerPhrase(getNextFillerPhrase());
	}, []);

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			if (e.key === 'Escape') {
				e.preventDefault();
				previousStep();
			}
		},
		[previousStep]
	);

	const handleLetsGo = useCallback(() => {
		if (state.isReadyToProceed) {
			nextStep();
		}
	}, [state.isReadyToProceed, nextStep]);

	const providerName = getConversationProviderName(state.selectedAgent);
	const agentName = state.agentName || 'Agent';

	return (
		<div
			ref={containerRef}
			className="flex flex-col flex-1 min-h-0"
			tabIndex={-1}
			onKeyDown={handleKeyDown}
		>
			<ScreenReaderAnnouncement
				message={announcement}
				announceKey={announcementKey}
				politeness="polite"
			/>

			<div
				className="px-6 py-4 border-b"
				style={{
					backgroundColor: theme.colors.bgSidebar,
					borderColor: theme.colors.border,
				}}
			>
				<ConfidenceMeter confidence={state.confidenceLevel} theme={theme} />
			</div>

			<div
				className="flex-1 min-h-0 overflow-y-auto px-6 py-4"
				style={{ backgroundColor: theme.colors.bgMain }}
			>
				{showInitialQuestion && state.conversationHistory.length === 0 && (
					<InitialQuestionBubble
						theme={theme}
						agentName={state.agentName || ''}
						initialQuestion={initialQuestion}
					/>
				)}

				{state.conversationHistory.map((message) => (
					<MessageBubble
						key={message.id}
						message={message}
						theme={theme}
						agentName={agentName}
						providerName={providerName}
					/>
				))}

				{state.isConversationLoading &&
					(streamingText ? (
						<StreamingResponseBubble
							theme={theme}
							agentName={state.agentName || ''}
							streamingText={streamingText}
						/>
					) : showThinking ? (
						<ThinkingDisplay
							theme={theme}
							agentName={agentName}
							thinkingContent={thinkingContent}
							toolExecutions={toolExecutions}
						/>
					) : (
						<TypingIndicator
							theme={theme}
							agentName={agentName}
							fillerPhrase={fillerPhrase}
							onRequestNewPhrase={handleRequestNewPhrase}
						/>
					))}

				{state.conversationError && (
					<ConversationErrorPanel
						theme={theme}
						error={state.conversationError}
						detectedError={detectedError}
						errorRetryCount={errorRetryCount}
						onRetry={handleRetry}
						onGoBack={previousStep}
						onDownloadDebugLogs={handleDownloadDebugLogs}
					/>
				)}

				{state.isReadyToProceed && !state.isConversationLoading && (
					<ReadyToProceedPanel theme={theme} onLetsGo={handleLetsGo} />
				)}

				<div ref={messagesEndRef} />
			</div>

			<ConversationInputPanel
				theme={theme}
				inputRef={inputRef}
				inputValue={inputValue}
				setInputValue={setInputValue}
				isConversationLoading={state.isConversationLoading}
				conversationHistory={state.conversationHistory}
				confidenceLevel={state.confidenceLevel}
				showThinking={showThinking}
				setShowThinking={setShowThinking}
				onSendMessage={handleSendMessage}
			/>

			<style>{`
				@keyframes bounce {
					0%, 100% {
						transform: translateY(0);
					}
					50% {
						transform: translateY(-4px);
					}
				}
				.animate-bounce {
					animation: bounce 0.6s infinite;
				}
			`}</style>
		</div>
	);
}
