/**
 * ConversationScreen.tsx
 *
 * Third screen of the onboarding wizard - AI-driven conversation
 * for project discovery with confidence meter and structured output parsing.
 *
 * Features:
 * - AI Terminal-like interface for familiarity
 * - Confidence progress bar (0-100%, red to yellow to green)
 * - Conversation display area with message history
 * - Input field at bottom for user responses
 * - "Let's get started!" button when ready=true and confidence>80
 * - Structured output parsing (confidence, ready, message)
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Brain } from 'lucide-react';
import type { Theme } from '../../../types';
import { useWizard, type WizardMessage } from '../WizardContext';
import {
	getConfidenceColor,
	getInitialQuestion,
	READY_CONFIDENCE_THRESHOLD,
	type ExistingDocument,
} from '../services/wizardPrompts';
import {
	conversationManager,
	createUserMessage,
	createAssistantMessage,
} from '../services/conversationManager';
import type { WizardError } from '../services/wizardErrorDetection';
import { AUTO_RUN_FOLDER_NAME, wizardDebugLogger } from '../services/phaseGenerator';
import { getNextFillerPhrase } from '../services/fillerPhrases';
import { ScreenReaderAnnouncement } from '../ScreenReaderAnnouncement';

interface ConversationScreenProps {
	theme: Theme;
	/** Whether to show AI thinking content instead of filler phrases */
	showThinking: boolean;
	/** Callback to toggle thinking display (controlled by parent for global shortcut) */
	setShowThinking: (value: boolean | ((prev: boolean) => boolean)) => void;
}

/**
 * Check if a string contains an emoji
 */
function containsEmoji(str: string): boolean {
	const emojiRegex =
		/[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]|[\u{1F600}-\u{1F64F}]|[\u{1F680}-\u{1F6FF}]|[\u{1F1E0}-\u{1F1FF}]/u;
	return emojiRegex.test(str);
}

/**
 * Format agent name with robot emoji prefix if no emoji present
 */
function formatAgentName(name: string): string {
	if (!name) return '🤖 Agent';
	return containsEmoji(name) ? name : `🤖 ${name}`;
}

/**
 * Format timestamp for display
 */
function formatTimestamp(timestamp: number): string {
	const date = new Date(timestamp);
	return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * Patterns that indicate the AI said it will do something asynchronously.
 * This is a UX problem because the wizard can't actually support async operations -
 * each message is a single turn. If the AI says "let me research this", the user
 * is left waiting with no indication that they need to respond.
 */
const DEFERRED_RESPONSE_PATTERNS = [
	/let me (?:research|investigate|look into|think about|analyze|examine|check|explore)/i,
	/give me a (?:moment|minute|second)/i,
	/i(?:'ll| will) (?:look into|research|investigate|get back|check)/i,
	/(?:researching|investigating|looking into) (?:this|that|it)/i,
	/let me (?:take a )?(?:closer )?look/i,
];

/**
 * Check if a message contains phrases that imply deferred/async work.
 * The wizard can't actually support this - we need to auto-continue.
 */
function containsDeferredResponsePhrase(message: string): boolean {
	return DEFERRED_RESPONSE_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * ConfidenceMeter - Horizontal progress bar with gradient fill
 */
function ConfidenceMeter({ confidence, theme }: { confidence: number; theme: Theme }): JSX.Element {
	const clampedConfidence = Math.max(0, Math.min(100, confidence));
	const confidenceColor = getConfidenceColor(clampedConfidence);

	return (
		<div className="w-full">
			<div className="flex items-center justify-between mb-2">
				<span className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
					Project Understanding Confidence
				</span>
				<span className="text-sm font-bold" style={{ color: confidenceColor }}>
					{clampedConfidence}%
				</span>
			</div>
			<div
				className="w-full h-2 rounded-full overflow-hidden"
				style={{ backgroundColor: theme.colors.border }}
			>
				<div
					className="h-full rounded-full transition-all duration-500 ease-out"
					style={{
						width: `${clampedConfidence}%`,
						backgroundColor: confidenceColor,
						boxShadow: `0 0 8px ${confidenceColor}40`,
					}}
				/>
			</div>
			{clampedConfidence >= READY_CONFIDENCE_THRESHOLD && (
				<p className="text-xs mt-1 text-center" style={{ color: theme.colors.success }}>
					Ready to create your Playbook!
				</p>
			)}
		</div>
	);
}

/**
 * MessageBubble - Individual conversation message display
 */
function MessageBubble({
	message,
	theme,
	agentName,
	providerName,
}: {
	message: WizardMessage;
	theme: Theme;
	agentName: string;
	providerName?: string;
}): JSX.Element {
	const isUser = message.role === 'user';
	const isSystem = message.role === 'system';

	return (
		<div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-4`}>
			<div
				className={`max-w-[80%] rounded-lg px-4 py-3 ${
					isUser ? 'rounded-br-none' : 'rounded-bl-none'
				}`}
				style={{
					backgroundColor: isUser
						? theme.colors.accent
						: isSystem
							? `${theme.colors.warning}20`
							: theme.colors.bgActivity,
					color: isUser ? theme.colors.accentForeground : theme.colors.textMain,
				}}
			>
				{/* Role indicator for non-user messages */}
				{!isUser && (
					<div
						className="text-xs font-medium mb-2 flex items-center justify-between"
						style={{ color: isSystem ? theme.colors.warning : theme.colors.accent }}
					>
						<div className="flex items-center gap-2">
							<span>{isSystem ? '🎼 System' : formatAgentName(agentName)}</span>
							{message.confidence !== undefined && (
								<span
									className="text-xs px-1.5 py-0.5 rounded"
									style={{
										backgroundColor: `${getConfidenceColor(message.confidence)}20`,
										color: getConfidenceColor(message.confidence),
									}}
								>
									{message.confidence}% confident
								</span>
							)}
						</div>
						{providerName && !isSystem && (
							<span
								className="text-xs px-2 py-0.5 rounded-full"
								style={{
									backgroundColor: `${theme.colors.accent}15`,
									color: theme.colors.accent,
									border: `1px solid ${theme.colors.accent}30`,
								}}
							>
								{providerName}
							</span>
						)}
					</div>
				)}

				{/* Message content */}
				<div className="text-sm break-words wizard-markdown">
					{isUser ? (
						<span className="whitespace-pre-wrap">{message.content}</span>
					) : (
						<ReactMarkdown
							remarkPlugins={[remarkGfm]}
							components={{
								// Style markdown elements to match theme
								p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
								ul: ({ children }) => <ul className="list-disc ml-4 mb-2">{children}</ul>,
								ol: ({ children }) => <ol className="list-decimal ml-4 mb-2">{children}</ol>,
								li: ({ children }) => <li className="mb-1">{children}</li>,
								strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
								em: ({ children }) => <em className="italic">{children}</em>,
								code: ({ children, className }) => {
									const isInline = !className;
									return isInline ? (
										<code
											className="px-1 py-0.5 rounded text-xs font-mono"
											style={{ backgroundColor: `${theme.colors.bgMain}80` }}
										>
											{children}
										</code>
									) : (
										<code className={className}>{children}</code>
									);
								},
								pre: ({ children }) => (
									<pre
										className="p-2 rounded text-xs font-mono overflow-x-auto mb-2"
										style={{ backgroundColor: theme.colors.bgMain }}
									>
										{children}
									</pre>
								),
								a: ({ href, children }) => (
									<button
										type="button"
										className="underline"
										style={{ color: theme.colors.accent }}
										onClick={() => href && window.maestro.shell.openExternal(href)}
									>
										{children}
									</button>
								),
								h1: ({ children }) => <h1 className="text-lg font-bold mb-2">{children}</h1>,
								h2: ({ children }) => <h2 className="text-base font-bold mb-2">{children}</h2>,
								h3: ({ children }) => <h3 className="text-sm font-bold mb-1">{children}</h3>,
								blockquote: ({ children }) => (
									<blockquote
										className="border-l-2 pl-2 mb-2 italic"
										style={{ borderColor: theme.colors.border }}
									>
										{children}
									</blockquote>
								),
							}}
						>
							{message.content}
						</ReactMarkdown>
					)}
				</div>

				{/* Timestamp */}
				<div
					className="text-xs mt-1 text-right opacity-60"
					style={{ color: isUser ? theme.colors.accentForeground : theme.colors.textDim }}
				>
					{formatTimestamp(message.timestamp)}
				</div>
			</div>
		</div>
	);
}

/**
 * TypingIndicator - Shows when agent is "thinking" with a typewriter effect filler phrase
 * Rotates to a new phrase every 5 seconds after typing completes
 */
function TypingIndicator({
	theme,
	agentName,
	fillerPhrase,
	onRequestNewPhrase,
}: {
	theme: Theme;
	agentName: string;
	fillerPhrase: string;
	onRequestNewPhrase: () => void;
}): JSX.Element {
	const [displayedText, setDisplayedText] = useState('');
	const [isTypingComplete, setIsTypingComplete] = useState(false);

	// Typewriter effect
	useEffect(() => {
		const text = fillerPhrase || 'Thinking...';
		let currentIndex = 0;
		setDisplayedText('');
		setIsTypingComplete(false);

		const typeInterval = setInterval(() => {
			if (currentIndex < text.length) {
				setDisplayedText(text.slice(0, currentIndex + 1));
				currentIndex++;
			} else {
				setIsTypingComplete(true);
				clearInterval(typeInterval);
			}
		}, 30); // 30ms per character for a natural typing speed

		return () => clearInterval(typeInterval);
	}, [fillerPhrase]);

	// Rotate to new phrase 5 seconds after typing completes
	useEffect(() => {
		if (!isTypingComplete) return;

		const rotateTimer = setTimeout(() => {
			onRequestNewPhrase();
		}, 5000);

		return () => clearTimeout(rotateTimer);
	}, [isTypingComplete, onRequestNewPhrase]);

	return (
		<div className="flex justify-start mb-4">
			<div
				className="rounded-lg rounded-bl-none px-4 py-3"
				style={{ backgroundColor: theme.colors.bgActivity }}
			>
				<div className="text-xs font-medium mb-2" style={{ color: theme.colors.accent }}>
					{formatAgentName(agentName)}
				</div>
				<div className="text-sm" style={{ color: theme.colors.textMain }}>
					<span className="italic" style={{ color: theme.colors.textDim }}>
						{displayedText}
					</span>
					<span
						className={`ml-1 inline-flex items-center gap-0.5 ${isTypingComplete ? 'opacity-100' : 'opacity-50'}`}
					>
						<span
							className="w-1.5 h-1.5 rounded-full animate-bounce inline-block"
							style={{
								backgroundColor: theme.colors.accent,
								animationDelay: '0ms',
							}}
						/>
						<span
							className="w-1.5 h-1.5 rounded-full animate-bounce inline-block"
							style={{
								backgroundColor: theme.colors.accent,
								animationDelay: '150ms',
							}}
						/>
						<span
							className="w-1.5 h-1.5 rounded-full animate-bounce inline-block"
							style={{
								backgroundColor: theme.colors.accent,
								animationDelay: '300ms',
							}}
						/>
					</span>
				</div>
			</div>
		</div>
	);
}

/**
 * Safely convert a value to a string for rendering.
 * Returns the string if it's already a string, otherwise null.
 * This prevents objects from being passed to React as children.
 */
function safeString(value: unknown): string | null {
	return typeof value === 'string' ? value : null;
}

/**
 * Extract a descriptive detail string from tool input.
 * Looks for common properties like command, pattern, file_path, query.
 * Only returns actual strings - objects are safely ignored to prevent React errors.
 */
function getToolDetail(input: unknown): string | null {
	if (!input || typeof input !== 'object') return null;
	const inputObj = input as Record<string, unknown>;
	// Check common tool input properties in order of preference
	// Use safeString to ensure we only return actual strings, not objects
	return (
		safeString(inputObj.command) ||
		safeString(inputObj.pattern) ||
		safeString(inputObj.file_path) ||
		safeString(inputObj.query) ||
		safeString(inputObj.path) ||
		null
	);
}

/**
 * ToolExecutionEntry - Individual tool execution item in thinking display
 */
function ToolExecutionEntry({
	tool,
	theme,
}: {
	tool: { toolName: string; state?: unknown; timestamp: number };
	theme: Theme;
}): JSX.Element {
	const state = tool.state as { status?: string; input?: unknown } | undefined;
	const status = state?.status || 'running';
	const toolDetail = getToolDetail(state?.input);

	return (
		<div
			className="flex items-start gap-2 py-1 text-xs font-mono"
			style={{ color: theme.colors.textDim }}
		>
			<span
				className="px-1.5 py-0.5 rounded text-[10px] shrink-0"
				style={{
					backgroundColor:
						status === 'complete' ? `${theme.colors.success}30` : `${theme.colors.accent}30`,
					color: status === 'complete' ? theme.colors.success : theme.colors.accent,
				}}
			>
				{tool.toolName}
			</span>
			{status === 'complete' ? (
				<span className="shrink-0 pt-0.5" style={{ color: theme.colors.success }}>
					✓
				</span>
			) : (
				<span className="animate-pulse shrink-0 pt-0.5" style={{ color: theme.colors.warning }}>
					●
				</span>
			)}
			{toolDetail && (
				<span
					className="opacity-70 break-all whitespace-pre-wrap"
					style={{ color: theme.colors.textMain }}
				>
					{toolDetail}
				</span>
			)}
		</div>
	);
}

/**
 * ThinkingDisplay - Shows AI thinking content when showThinking is enabled.
 * Displays raw thinking content and tool executions similar to the normal AI terminal.
 */
function ThinkingDisplay({
	theme,
	agentName,
	thinkingContent,
	toolExecutions,
}: {
	theme: Theme;
	agentName: string;
	thinkingContent: string;
	toolExecutions: Array<{ toolName: string; state?: unknown; timestamp: number }>;
}): JSX.Element {
	return (
		<div className="flex justify-start mb-4" data-testid="wizard-thinking-display">
			<div
				className="max-w-[80%] rounded-lg rounded-bl-none px-4 py-3 border-l-2"
				style={{
					backgroundColor: theme.colors.bgActivity,
					borderColor: theme.colors.accent,
				}}
			>
				<div className="flex items-center gap-2 mb-2">
					<span className="text-xs font-medium" style={{ color: theme.colors.accent }}>
						{formatAgentName(agentName)}
					</span>
					<span
						className="text-[10px] px-1.5 py-0.5 rounded"
						style={{
							backgroundColor: `${theme.colors.accent}30`,
							color: theme.colors.accent,
						}}
					>
						thinking
					</span>
				</div>

				{/* Tool executions - show what agent is doing */}
				{toolExecutions.length > 0 && (
					<div className="mb-2 border-b pb-2" style={{ borderColor: `${theme.colors.border}60` }}>
						{toolExecutions.map((tool, idx) => (
							<ToolExecutionEntry
								key={`${tool.toolName}-${tool.timestamp}-${idx}`}
								tool={tool}
								theme={theme}
							/>
						))}
					</div>
				)}

				{/* Thinking content or fallback */}
				<div
					className="text-sm whitespace-pre-wrap font-mono"
					style={{ color: theme.colors.textDim, opacity: 0.85 }}
					data-testid="thinking-display-content"
				>
					{thinkingContent || (toolExecutions.length === 0 ? 'Reasoning...' : '')}
					<span className="animate-pulse ml-1" data-testid="thinking-cursor">
						▊
					</span>
				</div>
			</div>
		</div>
	);
}

/**
 * ConversationScreen - Project discovery conversation
 */
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

	// Local state
	const [inputValue, setInputValue] = useState('');
	const [conversationStarted, setConversationStarted] = useState(false);
	// Only show initial question if history is empty (prevents showing twice when resumed)
	const [showInitialQuestion, setShowInitialQuestion] = useState(
		state.conversationHistory.length === 0
	);
	// Store initial question once to prevent it changing on re-renders
	const [initialQuestion] = useState(() => getInitialQuestion());
	const [errorRetryCount, setErrorRetryCount] = useState(0);
	// Track if we've auto-sent the initial message for continue mode
	const [autoSentInitialMessage, setAutoSentInitialMessage] = useState(false);
	const [streamingText, setStreamingText] = useState('');
	const [fillerPhrase, setFillerPhrase] = useState('');
	// Track detected provider error for showing recovery hints
	const [detectedError, setDetectedError] = useState<WizardError | null>(null);
	// Accumulated thinking content when showThinking is enabled (showThinking prop controls display)
	const [thinkingContent, setThinkingContent] = useState('');
	// Tool execution events for showThinking display (shows what agent is doing)
	const [toolExecutions, setToolExecutions] = useState<
		Array<{ toolName: string; state?: unknown; timestamp: number }>
	>([]);

	// Screen reader announcement state
	const [announcement, setAnnouncement] = useState('');
	const [announcementKey, setAnnouncementKey] = useState(0);

	// Pending auto-continue message (when AI says "let me research this")
	const [pendingAutoContinue, setPendingAutoContinue] = useState<string | null>(null);

	// Track previous ready state to avoid duplicate announcements
	const prevReadyRef = useRef(state.isReadyToProceed);

	// Ref to prevent double-adding the initial question (React StrictMode protection)
	const initialQuestionAddedRef = useRef(false);

	// Ref to track current showThinking state for use inside callbacks
	// This allows the onThinkingChunk callback to always be registered but only accumulate when enabled
	const showThinkingRef = useRef(showThinking);
	useEffect(() => {
		showThinkingRef.current = showThinking;
	}, [showThinking]);

	// Refs
	const containerRef = useRef<HTMLDivElement>(null);
	const messagesEndRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLTextAreaElement>(null);
	// Immediate send guard to prevent race conditions from rapid clicking
	const isSendingRef = useRef(false);
	// Track if we've already triggered auto-continue for the current exchange
	// This prevents infinite loops if the AI keeps saying "let me research"
	const autoContinueTriggeredRef = useRef(false);

	// Scroll to bottom when messages change
	const scrollToBottom = useCallback(() => {
		messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
	}, []);

	useEffect(() => {
		scrollToBottom();
	}, [state.conversationHistory, state.isConversationLoading, scrollToBottom]);

	// Focus input on mount
	useEffect(() => {
		inputRef.current?.focus();
	}, []);

	// Handle pending auto-continue (when AI says "let me research this")
	// We set the input and call handleSendMessage after a delay
	useEffect(() => {
		if (pendingAutoContinue && !state.isConversationLoading && !isSendingRef.current) {
			const message = pendingAutoContinue;
			setPendingAutoContinue(null);

			// Small delay to let the UI update and show the AI's response
			const timeoutId = setTimeout(() => {
				// Set the input value first so handleSendMessage picks it up
				setInputValue(message);
			}, 800);

			return () => clearTimeout(timeoutId);
		}
	}, [pendingAutoContinue, state.isConversationLoading]);

	// Store handleSendMessage in a ref so we can call it from the effect
	const handleSendMessageRef = useRef<(() => void) | null>(null);

	// Effect to trigger send when input is set to the auto-continue message
	useEffect(() => {
		if (
			inputValue === 'Please proceed with your analysis.' &&
			!state.isConversationLoading &&
			!isSendingRef.current &&
			handleSendMessageRef.current
		) {
			handleSendMessageRef.current();
		}
	}, [inputValue, state.isConversationLoading]);

	// Initialize conversation manager when entering this screen
	useEffect(() => {
		let mounted = true;

		async function fetchExistingDocs(): Promise<ExistingDocument[]> {
			// Only fetch if user chose to continue with existing docs
			if (state.existingDocsChoice !== 'continue') {
				return [];
			}

			try {
				const autoRunPath = `${state.directoryPath}/${AUTO_RUN_FOLDER_NAME}`;
				const listResult = await window.maestro.autorun.listDocs(autoRunPath);

				if (!listResult.success || !listResult.files || listResult.files.length === 0) {
					return [];
				}

				// Fetch content of each document
				const docs: ExistingDocument[] = [];
				for (const filename of listResult.files) {
					try {
						const readResult = await window.maestro.autorun.readDoc(autoRunPath, filename);
						if (readResult.success && readResult.content) {
							docs.push({
								filename,
								content: readResult.content,
							});
						}
					} catch (err) {
						console.warn(`Failed to read existing doc ${filename}:`, err);
					}
				}

				return docs;
			} catch (error) {
				console.warn('Failed to fetch existing docs:', error);
				return [];
			}
		}

		async function initConversation() {
			if (!state.selectedAgent || !state.directoryPath) {
				return;
			}

			try {
				// Fetch existing docs if continuing from previous session
				const existingDocs = await fetchExistingDocs();

				await conversationManager.startConversation({
					agentType: state.selectedAgent,
					directoryPath: state.directoryPath,
					projectName: state.agentName || 'My Project',
					existingDocs: existingDocs.length > 0 ? existingDocs : undefined,
				});

				if (mounted) {
					setConversationStarted(true);
				}
			} catch (error) {
				console.error('Failed to initialize conversation:', error);
				if (mounted) {
					setConversationError('Failed to initialize conversation. Please try again.');
				}
			}
		}

		// Only initialize if we haven't started yet and have no messages
		if (!conversationStarted && state.conversationHistory.length === 0) {
			initConversation();
		} else {
			// Resume from existing state - don't show initial question if history exists
			setConversationStarted(true);
			if (state.conversationHistory.length > 0) {
				setShowInitialQuestion(false);
				initialQuestionAddedRef.current = true; // Already in history
			}
		}

		return () => {
			mounted = false;
		};
	}, [
		state.selectedAgent,
		state.directoryPath,
		state.agentName,
		state.conversationHistory.length,
		state.existingDocsChoice,
		conversationStarted,
		setConversationError,
	]);

	// Cleanup conversation when unmounting (only if wizard is closing, not navigating between steps)
	// We track if the wizard is still open via the state - if it's closed, we clean up
	useEffect(() => {
		return () => {
			// Clean up the conversation manager to release resources
			// This ensures agent processes are properly terminated when leaving the wizard
			conversationManager.endConversation();
		};
	}, []);

	// Announce when ready to proceed status changes
	useEffect(() => {
		if (state.isReadyToProceed && !prevReadyRef.current) {
			setAnnouncement(
				`Confidence level ${state.confidenceLevel}%. Ready to proceed! You can now create your Playbook.`
			);
			setAnnouncementKey((prev) => prev + 1);
		}
		prevReadyRef.current = state.isReadyToProceed;
	}, [state.isReadyToProceed, state.confidenceLevel]);

	/**
	 * Handle sending a message to the agent
	 */
	const handleSendMessage = useCallback(async () => {
		const trimmedInput = inputValue.trim();
		// Double-check both state and ref to prevent race conditions from rapid clicking
		if (!trimmedInput || state.isConversationLoading || isSendingRef.current) {
			return;
		}

		// Set immediate guard before any async work
		isSendingRef.current = true;

		// Reset auto-continue flag if this is a user-initiated message (not auto-continue)
		// This allows auto-continue to trigger again for the next exchange if needed
		if (trimmedInput !== 'Please proceed with your analysis.') {
			autoContinueTriggeredRef.current = false;
		}

		// Clear input immediately and reset textarea height
		setInputValue('');
		if (inputRef.current) {
			inputRef.current.style.height = 'auto';
		}
		setConversationError(null);
		setDetectedError(null);
		setStreamingText('');
		setThinkingContent(''); // Clear previous thinking content
		setToolExecutions([]); // Clear previous tool executions
		setFillerPhrase(getNextFillerPhrase());

		// If this is the first message, add the initial question to history first
		// so the conversation makes sense in the history
		// Use ref to prevent double-adding (React StrictMode can double-invoke)
		if (showInitialQuestion && !initialQuestionAddedRef.current) {
			initialQuestionAddedRef.current = true;
			addMessage({
				role: 'assistant',
				content: initialQuestion,
			});
			// Hide the direct JSX render immediately - the message is now in history
			setShowInitialQuestion(false);
		}

		// Add user message to history
		addMessage(createUserMessage(trimmedInput));

		// Set loading state
		setConversationLoading(true);

		// Announce that AI is thinking
		setAnnouncement('Message sent. AI assistant is thinking...');
		setAnnouncementKey((prev) => prev + 1);

		try {
			// Re-initialize conversation if needed
			if (!conversationManager.isConversationActive()) {
				// Safety check: selectedAgent should always be set at this point
				// but we guard against null to prevent crashes
				if (!state.selectedAgent) {
					setConversationError('No agent selected. Please go back and select an agent.');
					setConversationLoading(false);
					return;
				}
				await conversationManager.startConversation({
					agentType: state.selectedAgent,
					directoryPath: state.directoryPath,
					projectName: state.agentName || 'My Project',
				});
			}

			// Send message and wait for response
			const result = await conversationManager.sendMessage(
				trimmedInput,
				state.conversationHistory,
				{
					onSending: () => {
						// Already set loading state
					},
					onReceiving: () => {
						// Agent is responding
					},
					onChunk: (chunk) => {
						// Show streaming response - extract text from stream-json format
						// Claude Code with --include-partial-messages outputs:
						// - stream_event with event.type === 'content_block_delta' and event.delta.text
						// - assistant message with message.content[].text (complete message)
						try {
							const lines = chunk.split('\n').filter((line) => line.trim());
							for (const line of lines) {
								try {
									const msg = JSON.parse(line);

									// Handle stream_event with content_block_delta (real-time streaming)
									if (
										msg.type === 'stream_event' &&
										msg.event?.type === 'content_block_delta' &&
										msg.event?.delta?.text
									) {
										setStreamingText((prev) => prev + msg.event.delta.text);
									}
									// Note: We intentionally skip the 'assistant' message type here
									// because it contains the complete message, not incremental updates.
									// The final text will be added via onComplete callback.
								} catch {
									// Ignore non-JSON lines
								}
							}
						} catch {
							// Ignore parse errors
						}
					},
					// Thinking content comes via the dedicated onThinkingChunk callback
					// This receives parsed thinking content from process-manager's thinking-chunk event
					// IMPORTANT: Always register the callback so we capture thinking even if toggled on mid-response
					// Use ref to check current showThinking state inside callback
					// Skip JSON-looking content (the structured response) to avoid brief flash of JSON
					onThinkingChunk: (content) => {
						if (showThinkingRef.current) {
							// Don't accumulate JSON responses - they're the final answer, not thinking
							const trimmed = content.trim();
							if (
								trimmed.startsWith('{"') &&
								(trimmed.includes('"confidence"') || trimmed.includes('"message"'))
							) {
								return; // Skip structured response JSON
							}
							setThinkingContent((prev) => prev + content);
						}
					},
					// Tool execution events show what the agent is doing (Read, Write, etc.)
					// These are crucial for showThinking mode since batch mode doesn't stream assistant messages
					onToolExecution: (toolEvent) => {
						if (showThinkingRef.current) {
							setToolExecutions((prev) => [...prev, toolEvent]);
						}
					},
					onComplete: (sendResult) => {
						// Clear streaming text, thinking content, and tool executions when response is complete
						setStreamingText('');
						setThinkingContent('');
						setToolExecutions([]);

						console.log('[ConversationScreen] onComplete:', {
							success: sendResult.success,
							hasResponse: !!sendResult.response,
							parseSuccess: sendResult.response?.parseSuccess,
							hasStructured: !!sendResult.response?.structured,
						});

						if (sendResult.success && sendResult.response) {
							// Add assistant response to history
							addMessage(createAssistantMessage(sendResult.response));

							// Update confidence level
							if (sendResult.response.structured) {
								const newConfidence = sendResult.response.structured.confidence;
								console.log('[ConversationScreen] Setting confidence to:', newConfidence);
								setConfidenceLevel(newConfidence);

								const isReady =
									sendResult.response.structured.ready &&
									newConfidence >= READY_CONFIDENCE_THRESHOLD;
								console.log(
									'[ConversationScreen] isReady:',
									isReady,
									'ready flag:',
									sendResult.response.structured.ready
								);
								setIsReadyToProceed(isReady);

								// Announce response received with confidence (ready state will be announced by effect)
								if (!isReady) {
									setAnnouncement(`Response received. Project understanding at ${newConfidence}%.`);
									setAnnouncementKey((prev) => prev + 1);
								}
							} else {
								// No structured data - just announce response received
								console.log('[ConversationScreen] No structured data in response');
								setAnnouncement('Response received from AI assistant.');
								setAnnouncementKey((prev) => prev + 1);
							}

							// Reset error retry count on success
							setErrorRetryCount(0);

							// Check if the AI said something that implies async work (e.g., "let me research this")
							// The wizard can't support async operations - each message is a single turn.
							// If we detect this pattern and haven't already auto-continued, schedule a follow-up.
							const messageContent =
								sendResult.response.structured?.message || sendResult.response.rawText;
							if (
								messageContent &&
								containsDeferredResponsePhrase(messageContent) &&
								!autoContinueTriggeredRef.current
							) {
								console.log(
									'[ConversationScreen] Detected deferred response phrase, scheduling auto-continue'
								);
								autoContinueTriggeredRef.current = true;
								// Set pending auto-continue - an effect will handle actually sending
								setPendingAutoContinue('Please proceed with your analysis.');
							}
						}
					},
					onError: (error) => {
						console.error('Conversation error:', error);
						setConversationError(error);
						setErrorRetryCount((prev) => prev + 1);
						// Announce error
						setAnnouncement(`Error: ${error}. Please try again.`);
						setAnnouncementKey((prev) => prev + 1);
					},
				}
			);

			// Handle non-callback completion path
			if (!result.success && result.error) {
				setConversationError(result.error);
				if (result.detectedError) {
					setDetectedError(result.detectedError);
				}
				setErrorRetryCount((prev) => prev + 1);
			}
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
			setConversationError(errorMessage);
			setErrorRetryCount((prev) => prev + 1);
		} finally {
			setConversationLoading(false);
			// Reset the immediate send guard
			isSendingRef.current = false;
			// Refocus input
			inputRef.current?.focus();
		}
	}, [
		inputValue,
		showInitialQuestion,
		state.isConversationLoading,
		state.conversationHistory,
		state.selectedAgent,
		state.directoryPath,
		state.agentName,
		addMessage,
		setConversationLoading,
		setConversationError,
		setConfidenceLevel,
		setIsReadyToProceed,
	]);

	// Keep ref updated with current handleSendMessage for auto-continue effect
	useEffect(() => {
		handleSendMessageRef.current = handleSendMessage;
	}, [handleSendMessage]);

	/**
	 * Auto-send initial message when continuing with existing docs
	 * This triggers the AI to analyze the docs and provide a synopsis
	 */
	const sendInitialContinueMessage = useCallback(async () => {
		if (state.isConversationLoading || isSendingRef.current) {
			return;
		}

		// Set immediate guard before any async work
		isSendingRef.current = true;

		setConversationError(null);
		setDetectedError(null);
		setStreamingText('');
		setThinkingContent(''); // Clear previous thinking content
		setToolExecutions([]); // Clear previous tool executions
		setFillerPhrase(getNextFillerPhrase());

		// Don't show the normal initial question for continue mode
		setShowInitialQuestion(false);
		initialQuestionAddedRef.current = true;

		// Add user message to history - asking for analysis
		const continueMessage =
			'Please analyze the existing Auto Run documents and provide a synopsis of the current plan.';
		addMessage(createUserMessage(continueMessage));

		// Set loading state
		setConversationLoading(true);

		// Announce that AI is analyzing
		setAnnouncement('Analyzing existing documents...');
		setAnnouncementKey((prev) => prev + 1);

		try {
			// Re-initialize conversation if needed
			if (!conversationManager.isConversationActive()) {
				if (!state.selectedAgent) {
					setConversationError('No agent selected. Please go back and select an agent.');
					setConversationLoading(false);
					return;
				}

				// Fetch existing docs for the system prompt
				const autoRunPath = `${state.directoryPath}/${AUTO_RUN_FOLDER_NAME}`;
				const listResult = await window.maestro.autorun.listDocs(autoRunPath);
				const existingDocs: ExistingDocument[] = [];

				if (listResult.success && listResult.files) {
					for (const filename of listResult.files) {
						try {
							const readResult = await window.maestro.autorun.readDoc(autoRunPath, filename);
							if (readResult.success && readResult.content) {
								existingDocs.push({ filename, content: readResult.content });
							}
						} catch (err) {
							console.warn(`Failed to read doc ${filename}:`, err);
						}
					}
				}

				await conversationManager.startConversation({
					agentType: state.selectedAgent,
					directoryPath: state.directoryPath,
					projectName: state.agentName || 'My Project',
					existingDocs: existingDocs.length > 0 ? existingDocs : undefined,
				});
			}

			// Send message and wait for response
			const result = await conversationManager.sendMessage(
				continueMessage,
				[], // Empty history since this is the first message
				{
					onChunk: (chunk) => {
						try {
							const lines = chunk.split('\n').filter((line) => line.trim());
							for (const line of lines) {
								try {
									const msg = JSON.parse(line);
									if (
										msg.type === 'stream_event' &&
										msg.event?.type === 'content_block_delta' &&
										msg.event?.delta?.text
									) {
										setStreamingText((prev) => prev + msg.event.delta.text);
									}
								} catch {
									// Ignore non-JSON lines
								}
							}
						} catch {
							// Ignore parse errors
						}
					},
					// Thinking content callback - always register, check ref inside
					// Skip JSON-looking content (the structured response) to avoid brief flash of JSON
					onThinkingChunk: (content) => {
						if (showThinkingRef.current) {
							// Don't accumulate JSON responses - they're the final answer, not thinking
							const trimmed = content.trim();
							if (
								trimmed.startsWith('{"') &&
								(trimmed.includes('"confidence"') || trimmed.includes('"message"'))
							) {
								return; // Skip structured response JSON
							}
							setThinkingContent((prev) => prev + content);
						}
					},
					// Tool execution callback - shows what agent is doing
					onToolExecution: (toolEvent) => {
						if (showThinkingRef.current) {
							setToolExecutions((prev) => [...prev, toolEvent]);
						}
					},
					onComplete: (sendResult) => {
						setStreamingText('');
						setThinkingContent('');
						setToolExecutions([]);

						if (sendResult.success && sendResult.response) {
							addMessage(createAssistantMessage(sendResult.response));

							if (sendResult.response.structured) {
								const newConfidence = sendResult.response.structured.confidence;
								setConfidenceLevel(newConfidence);

								const isReady =
									sendResult.response.structured.ready &&
									newConfidence >= READY_CONFIDENCE_THRESHOLD;
								setIsReadyToProceed(isReady);

								if (!isReady) {
									setAnnouncement(`Analysis complete. Project understanding at ${newConfidence}%.`);
									setAnnouncementKey((prev) => prev + 1);
								}
							} else {
								setAnnouncement('Analysis complete.');
								setAnnouncementKey((prev) => prev + 1);
							}

							setErrorRetryCount(0);
						}
					},
					onError: (error) => {
						console.error('Conversation error:', error);
						setConversationError(error);
						setErrorRetryCount((prev) => prev + 1);
						setAnnouncement(`Error: ${error}. Please try again.`);
						setAnnouncementKey((prev) => prev + 1);
					},
				}
			);

			if (!result.success && result.error) {
				setConversationError(result.error);
				if (result.detectedError) {
					setDetectedError(result.detectedError);
				}
				setErrorRetryCount((prev) => prev + 1);
			}
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
			setConversationError(errorMessage);
			setErrorRetryCount((prev) => prev + 1);
		} finally {
			setConversationLoading(false);
			isSendingRef.current = false;
			inputRef.current?.focus();
		}
	}, [
		state.isConversationLoading,
		state.selectedAgent,
		state.directoryPath,
		state.agentName,
		addMessage,
		setConversationLoading,
		setConversationError,
		setConfidenceLevel,
		setIsReadyToProceed,
	]);

	// Auto-trigger initial message when continuing with existing docs
	useEffect(() => {
		if (
			conversationStarted &&
			state.existingDocsChoice === 'continue' &&
			!autoSentInitialMessage &&
			state.conversationHistory.length === 0
		) {
			setAutoSentInitialMessage(true);
			// Small delay to ensure conversation manager is ready
			const timer = setTimeout(() => {
				sendInitialContinueMessage();
			}, 100);
			return () => clearTimeout(timer);
		}
	}, [
		conversationStarted,
		state.existingDocsChoice,
		autoSentInitialMessage,
		state.conversationHistory.length,
		sendInitialContinueMessage,
	]);

	/**
	 * Handle retry after error
	 */
	const handleRetry = useCallback(() => {
		setConversationError(null);
		setDetectedError(null);
		inputRef.current?.focus();
	}, [setConversationError]);

	/**
	 * Handle debug log download
	 */
	const handleDownloadDebugLogs = useCallback(() => {
		wizardDebugLogger.downloadLogs();
	}, []);

	/**
	 * Handle request for new filler phrase (called every 5 seconds while waiting)
	 */
	const handleRequestNewPhrase = useCallback(() => {
		setFillerPhrase(getNextFillerPhrase());
	}, []);

	/**
	 * Handle keyboard events at container level
	 * Note: Cmd+Enter is handled by the textarea directly to avoid double-firing
	 * Note: Cmd+Shift+K is handled at the MaestroWizard level to work from anywhere in modal
	 */
	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			// Escape to go back to previous step
			if (e.key === 'Escape') {
				e.preventDefault();
				previousStep();
			}
		},
		[previousStep]
	);

	/**
	 * Handle "Let's Get Started" button click
	 */
	const handleLetsGo = useCallback(() => {
		if (state.isReadyToProceed) {
			nextStep();
		}
	}, [state.isReadyToProceed, nextStep]);

	return (
		<div
			ref={containerRef}
			className="flex flex-col flex-1 min-h-0"
			tabIndex={-1}
			onKeyDown={handleKeyDown}
		>
			{/* Screen reader announcements */}
			<ScreenReaderAnnouncement
				message={announcement}
				announceKey={announcementKey}
				politeness="polite"
			/>

			{/* Confidence Meter Header */}
			<div
				className="px-6 py-4 border-b"
				style={{
					backgroundColor: theme.colors.bgSidebar,
					borderColor: theme.colors.border,
				}}
			>
				<ConfidenceMeter confidence={state.confidenceLevel} theme={theme} />
			</div>

			{/* Conversation Area */}
			<div
				className="flex-1 min-h-0 overflow-y-auto px-6 py-4"
				style={{ backgroundColor: theme.colors.bgMain }}
			>
				{/* Initial Question (shown before first interaction) */}
				{showInitialQuestion && state.conversationHistory.length === 0 && (
					<div className="flex justify-start mb-4">
						<div
							className="max-w-[80%] rounded-lg rounded-bl-none px-4 py-3"
							style={{ backgroundColor: theme.colors.bgActivity }}
						>
							<div className="text-xs font-medium mb-2" style={{ color: theme.colors.accent }}>
								{formatAgentName(state.agentName || '')}
							</div>
							<div className="text-sm" style={{ color: theme.colors.textMain }}>
								{initialQuestion}
							</div>
						</div>
					</div>
				)}

				{/* Conversation History */}
				{state.conversationHistory.map((message) => (
					<MessageBubble
						key={message.id}
						message={message}
						theme={theme}
						agentName={state.agentName || 'Agent'}
						providerName={
							state.selectedAgent === 'claude-code'
								? 'Claude'
								: state.selectedAgent === 'opencode'
									? 'OpenCode'
									: state.selectedAgent === 'codex'
										? 'Codex'
										: state.selectedAgent || undefined
						}
					/>
				))}

				{/* Streaming Response, Thinking Display, or Typing Indicator */}
				{state.isConversationLoading &&
					(streamingText ? (
						<div className="flex justify-start mb-4">
							<div
								className="max-w-[80%] rounded-lg rounded-bl-none px-4 py-3"
								style={{ backgroundColor: theme.colors.bgActivity }}
							>
								<div className="text-xs font-medium mb-2" style={{ color: theme.colors.accent }}>
									{formatAgentName(state.agentName || '')}
								</div>
								<div
									className="text-sm whitespace-pre-wrap"
									style={{ color: theme.colors.textMain }}
								>
									{streamingText}
									<span className="animate-pulse">▊</span>
								</div>
							</div>
						</div>
					) : showThinking && (thinkingContent || toolExecutions.length > 0) ? (
						// Show thinking content and/or tool executions when enabled and we have content
						<ThinkingDisplay
							theme={theme}
							agentName={state.agentName || 'Agent'}
							thinkingContent={thinkingContent}
							toolExecutions={toolExecutions}
						/>
					) : showThinking ? (
						// Show minimal thinking display when enabled but no content yet
						<ThinkingDisplay
							theme={theme}
							agentName={state.agentName || 'Agent'}
							thinkingContent=""
							toolExecutions={[]}
						/>
					) : (
						// Show filler phrase typing indicator
						<TypingIndicator
							theme={theme}
							agentName={state.agentName || 'Agent'}
							fillerPhrase={fillerPhrase}
							onRequestNewPhrase={handleRequestNewPhrase}
						/>
					))}

				{/* Error Message */}
				{state.conversationError && (
					<div
						className="mx-auto max-w-md mb-4 p-4 rounded-lg"
						style={{
							backgroundColor: `${theme.colors.error}15`,
							border: `1px solid ${theme.colors.error}40`,
						}}
					>
						{/* Error Title */}
						{detectedError && (
							<p className="text-sm font-semibold mb-1" style={{ color: theme.colors.error }}>
								{detectedError.title}
							</p>
						)}
						{/* Error Message */}
						<p
							className="text-sm mb-2"
							style={{ color: detectedError ? theme.colors.textMain : theme.colors.error }}
						>
							{detectedError ? detectedError.message : state.conversationError}
						</p>
						{/* Recovery Hint */}
						{detectedError && (
							<p className="text-xs mb-3 opacity-80" style={{ color: theme.colors.textDim }}>
								{detectedError.recoveryHint}
							</p>
						)}
						{/* Action Button */}
						<div className="flex justify-center gap-2">
							<button
								onClick={handleRetry}
								className="px-4 py-1.5 rounded text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-offset-1"
								style={{
									backgroundColor: theme.colors.error,
									color: 'white',
									['--tw-ring-color' as any]: theme.colors.error,
									['--tw-ring-offset-color' as any]: theme.colors.bgMain,
								}}
							>
								{detectedError && !detectedError.canRetry
									? 'Dismiss'
									: errorRetryCount > 2
										? 'Try Again'
										: 'Dismiss'}
							</button>
							{/* Go Back button for non-recoverable errors */}
							{detectedError && !detectedError.canRetry && (
								<button
									onClick={previousStep}
									className="px-4 py-1.5 rounded text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-offset-1"
									style={{
										backgroundColor: theme.colors.bgSidebar,
										color: theme.colors.textMain,
										border: `1px solid ${theme.colors.border}`,
										['--tw-ring-color' as any]: theme.colors.accent,
										['--tw-ring-offset-color' as any]: theme.colors.bgMain,
									}}
								>
									Go Back
								</button>
							)}
						</div>
						{/* Debug logs download link */}
						<button
							onClick={handleDownloadDebugLogs}
							className="mt-3 text-xs underline hover:opacity-80 transition-opacity cursor-pointer"
							style={{ color: theme.colors.textDim }}
						>
							(Debug Logs)
						</button>
					</div>
				)}

				{/* Ready to Proceed Message */}
				{state.isReadyToProceed && !state.isConversationLoading && (
					<div
						className="mx-auto max-w-md mb-4 p-4 rounded-lg text-center"
						style={{
							backgroundColor: `${theme.colors.success}15`,
							border: `1px solid ${theme.colors.success}40`,
						}}
					>
						<p className="text-sm font-medium mb-3" style={{ color: theme.colors.success }}>
							I think I have a good understanding of your project. Ready to create your Playbook?
						</p>
						<button
							onClick={handleLetsGo}
							className="px-6 py-2.5 rounded-lg text-sm font-bold transition-all hover:scale-105 focus:outline-none focus:ring-2 focus:ring-offset-2"
							style={{
								backgroundColor: theme.colors.success,
								color: theme.colors.bgMain,
								boxShadow: `0 4px 12px ${theme.colors.success}40`,
								['--tw-ring-color' as any]: theme.colors.success,
								['--tw-ring-offset-color' as any]: theme.colors.bgMain,
							}}
						>
							Let's Get Started!
						</button>
						<p className="text-xs mt-3" style={{ color: theme.colors.textDim }}>
							Or continue chatting below to add more details
						</p>
					</div>
				)}

				{/* Scroll anchor */}
				<div ref={messagesEndRef} />
			</div>

			{/* Input Area */}
			<div
				className="px-6 py-4 border-t"
				style={{
					backgroundColor: theme.colors.bgSidebar,
					borderColor: theme.colors.border,
				}}
			>
				{/* "Your turn" indicator - shows when AI responded and waiting for user */}
				{!state.isConversationLoading &&
					state.conversationHistory.length > 0 &&
					state.conversationHistory[state.conversationHistory.length - 1].role === 'assistant' &&
					state.confidenceLevel < READY_CONFIDENCE_THRESHOLD && (
						<div
							className="flex items-center gap-2 mb-2 text-xs"
							style={{ color: theme.colors.accent }}
						>
							<span
								className="w-2 h-2 rounded-full animate-pulse"
								style={{ backgroundColor: theme.colors.accent }}
							/>
							<span>Your turn — continue the conversation</span>
						</div>
					)}
				<div className="flex gap-3">
					<div className="flex-1 relative flex items-center">
						<textarea
							ref={inputRef}
							value={inputValue}
							onChange={(e) => setInputValue(e.target.value)}
							onKeyDown={(e) => {
								// Cmd+Enter (Mac) or Ctrl+Enter (Windows) to send
								if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
									e.preventDefault();
									handleSendMessage();
								}
								// Plain Enter adds newline (default textarea behavior)
							}}
							placeholder="Describe your project..."
							disabled={state.isConversationLoading}
							rows={1}
							className="w-full px-4 py-3 rounded-lg border resize-none outline-none transition-all"
							style={{
								backgroundColor: theme.colors.bgMain,
								borderColor: theme.colors.border,
								color: theme.colors.textMain,
								maxHeight: '120px',
								lineHeight: '1.5',
								minHeight: '48px',
							}}
							onInput={(e) => {
								// Auto-resize textarea - start at natural height, grow as needed
								const target = e.target as HTMLTextAreaElement;
								target.style.height = 'auto';
								target.style.height = `${Math.min(target.scrollHeight, 120)}px`;
							}}
						/>
					</div>
					<button
						onClick={handleSendMessage}
						disabled={!inputValue.trim() || state.isConversationLoading}
						className="px-4 rounded-lg font-medium transition-all flex items-center gap-2 shrink-0 self-end focus:outline-none focus:ring-2 focus:ring-offset-2"
						style={{
							backgroundColor:
								inputValue.trim() && !state.isConversationLoading
									? theme.colors.accent
									: theme.colors.border,
							color:
								inputValue.trim() && !state.isConversationLoading
									? theme.colors.accentForeground
									: theme.colors.textDim,
							cursor: inputValue.trim() && !state.isConversationLoading ? 'pointer' : 'not-allowed',
							height: '48px',
							['--tw-ring-color' as any]: theme.colors.accent,
							['--tw-ring-offset-color' as any]: theme.colors.bgSidebar,
						}}
					>
						{state.isConversationLoading ? (
							<div
								className="w-4 h-4 border-2 border-t-transparent rounded-full animate-spin"
								style={{ borderColor: 'currentColor', borderTopColor: 'transparent' }}
							/>
						) : (
							<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
								<path
									strokeLinecap="round"
									strokeLinejoin="round"
									strokeWidth={2}
									d="M5 10l7-7m0 0l7 7m-7-7v18"
								/>
							</svg>
						)}
						Send
					</button>
				</div>

				{/* Controls and keyboard hints */}
				<div className="mt-4 flex justify-center gap-6 items-center">
					{/* Show Thinking toggle with keyboard shortcut */}
					<span className="text-xs flex items-center gap-1" style={{ color: theme.colors.textDim }}>
						<kbd
							className="px-1.5 py-0.5 rounded text-xs"
							style={{ backgroundColor: theme.colors.border }}
						>
							⌘⇧K
						</kbd>
						<button
							onClick={() => setShowThinking(!showThinking)}
							className={`flex items-center gap-1 px-2 py-1 rounded hover:bg-white/5 transition-opacity focus:outline-none focus:ring-2 focus:ring-offset-1 ${
								showThinking ? 'opacity-100' : 'opacity-50 hover:opacity-100'
							}`}
							title={showThinking ? 'Hide AI thinking (show filler messages)' : 'Show AI thinking'}
							style={
								showThinking
									? {
											color: theme.colors.accent,
											['--tw-ring-color' as any]: theme.colors.accent,
											['--tw-ring-offset-color' as any]: theme.colors.bgSidebar,
										}
									: {
											color: theme.colors.textDim,
											['--tw-ring-color' as any]: theme.colors.accent,
											['--tw-ring-offset-color' as any]: theme.colors.bgSidebar,
										}
							}
						>
							<Brain className="w-3 h-3" />
							<span>Thinking</span>
						</button>
					</span>
					<span className="text-xs flex items-center gap-1" style={{ color: theme.colors.textDim }}>
						<kbd
							className="px-1.5 py-0.5 rounded text-xs"
							style={{ backgroundColor: theme.colors.border }}
						>
							⌘+Enter
						</kbd>
						Send
					</span>
					<span className="text-xs flex items-center gap-1" style={{ color: theme.colors.textDim }}>
						<kbd
							className="px-1.5 py-0.5 rounded text-xs"
							style={{ backgroundColor: theme.colors.border }}
						>
							Enter
						</kbd>
						New line
					</span>
					<span className="text-xs flex items-center gap-1" style={{ color: theme.colors.textDim }}>
						<kbd
							className="px-1.5 py-0.5 rounded text-xs"
							style={{ backgroundColor: theme.colors.border }}
						>
							Esc
						</kbd>
						Exit Wizard
					</span>
				</div>
			</div>

			{/* Bounce animation style */}
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
