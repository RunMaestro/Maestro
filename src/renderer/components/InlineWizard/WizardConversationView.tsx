/**
 * WizardConversationView.tsx
 *
 * Scrollable conversation area for the inline wizard that renders WizardMessageBubble
 * components for each message in the wizard's conversation history.
 *
 * Features:
 * - Auto-scroll to bottom on new messages
 * - Typing indicator with filler phrases from fillerPhrases.ts when waiting for AI
 * - Matches the look of the normal AI terminal log view
 * - Streaming text display for real-time response
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import type { Theme } from '../../types';
import { WizardMessageBubble, type WizardMessageBubbleMessage } from './WizardMessageBubble';
import { getNextFillerPhrase } from '../Wizard/services/fillerPhrases';

/**
 * Ready confidence threshold for "Let's Go" button (matches READY_CONFIDENCE_THRESHOLD)
 */
const READY_CONFIDENCE_THRESHOLD = 80;

/**
 * Props for WizardConversationView
 */
export interface WizardConversationViewProps {
	/** Theme for styling */
	theme: Theme;
	/** Conversation history to display */
	conversationHistory: WizardMessageBubbleMessage[];
	/** Whether the AI is currently generating a response */
	isLoading?: boolean;
	/** Streaming text being received from the AI (shown before complete response) */
	streamingText?: string;
	/** Agent name for assistant messages */
	agentName?: string;
	/** Provider name (e.g., "Claude", "OpenCode") for assistant messages */
	providerName?: string;
	/** Optional className for the container */
	className?: string;
	/** Confidence level from AI responses (0-100) */
	confidence?: number;
	/** Whether the AI is ready to proceed with document generation */
	ready?: boolean;
	/** Callback when user clicks the "Let's Go" button to start document generation */
	onLetsGo?: () => void;
	/** Error message to display (if any) */
	error?: string | null;
	/** Callback when user clicks the retry button */
	onRetry?: () => void;
	/** Callback to clear the error */
	onClearError?: () => void;
	/** Whether to show thinking content instead of filler phrases */
	showThinking?: boolean;
	/** Thinking content being streamed from the AI */
	thinkingContent?: string;
	/** Tool execution events during conversation (shows what agent is doing) */
	toolExecutions?: Array<{ toolName: string; state?: unknown; timestamp: number }>;
	/** Whether document generation has started (to hide Let's Go button once generation begins) */
	hasStartedGenerating?: boolean;
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
 * TypingIndicator - Shows when agent is "thinking" with a typewriter effect filler phrase.
 * Rotates to a new phrase every 5 seconds after typing completes.
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

	// Typewriter effect using requestAnimationFrame for smoother animation
	useEffect(() => {
		const text = fillerPhrase || 'Thinking...';
		let currentIndex = 0;
		let lastTime = 0;
		const charDelay = 30; // 30ms per character for a natural typing speed
		let rafId: number;

		setDisplayedText('');
		setIsTypingComplete(false);

		function tick(timestamp: number) {
			if (!lastTime) lastTime = timestamp;
			const elapsed = timestamp - lastTime;

			if (elapsed >= charDelay) {
				if (currentIndex < text.length) {
					currentIndex++;
					setDisplayedText(text.slice(0, currentIndex));
					lastTime = timestamp;
					rafId = requestAnimationFrame(tick);
				} else {
					setIsTypingComplete(true);
				}
			} else {
				rafId = requestAnimationFrame(tick);
			}
		}

		rafId = requestAnimationFrame(tick);

		return () => cancelAnimationFrame(rafId);
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
		<div className="flex justify-start mb-4" data-testid="wizard-typing-indicator">
			<div
				className="max-w-[80%] rounded-lg rounded-bl-none px-4 py-3"
				style={{ backgroundColor: theme.colors.bgActivity }}
			>
				<div className="text-xs font-medium mb-2" style={{ color: theme.colors.accent }}>
					{formatAgentName(agentName)}
				</div>
				<div className="text-sm" style={{ color: theme.colors.textMain }}>
					<span
						className="italic"
						style={{ color: theme.colors.textDim }}
						data-testid="typing-indicator-text"
					>
						{displayedText}
					</span>
					<span
						className={`ml-1 inline-flex items-center gap-0.5 ${isTypingComplete ? 'opacity-100' : 'opacity-50'}`}
						data-testid="typing-indicator-dots"
					>
						<span
							className="w-1.5 h-1.5 rounded-full inline-block"
							style={{
								backgroundColor: theme.colors.accent,
								animation: 'wizard-typing-bounce 0.6s infinite',
								animationDelay: '0ms',
							}}
						/>
						<span
							className="w-1.5 h-1.5 rounded-full inline-block"
							style={{
								backgroundColor: theme.colors.accent,
								animation: 'wizard-typing-bounce 0.6s infinite',
								animationDelay: '150ms',
							}}
						/>
						<span
							className="w-1.5 h-1.5 rounded-full inline-block"
							style={{
								backgroundColor: theme.colors.accent,
								animation: 'wizard-typing-bounce 0.6s infinite',
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
	toolExecutions = [],
}: {
	theme: Theme;
	agentName: string;
	thinkingContent: string;
	toolExecutions?: Array<{ toolName: string; state?: unknown; timestamp: number }>;
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
 * StreamingResponse - Shows streaming text from the AI as it arrives
 */
function StreamingResponse({
	theme,
	agentName,
	streamingText,
}: {
	theme: Theme;
	agentName: string;
	streamingText: string;
}): JSX.Element {
	return (
		<div className="flex justify-start mb-4" data-testid="wizard-streaming-response">
			<div
				className="max-w-[80%] rounded-lg rounded-bl-none px-4 py-3"
				style={{ backgroundColor: theme.colors.bgActivity }}
			>
				<div className="text-xs font-medium mb-2" style={{ color: theme.colors.accent }}>
					{formatAgentName(agentName)}
				</div>
				<div
					className="text-sm whitespace-pre-wrap"
					style={{ color: theme.colors.textMain }}
					data-testid="streaming-response-text"
				>
					{streamingText}
					<span className="animate-pulse" data-testid="streaming-cursor">
						▊
					</span>
				</div>
			</div>
		</div>
	);
}

/**
 * Get a user-friendly error message from a raw error string.
 * Maps technical errors to helpful messages.
 */
function getUserFriendlyErrorMessage(error: string): { title: string; description: string } {
	const lowerError = error.toLowerCase();

	// Network/timeout errors
	if (lowerError.includes('timeout') || lowerError.includes('timed out')) {
		return {
			title: 'Response Timeout',
			description:
				'The AI agent took too long to respond. This can happen with complex requests or network issues.',
		};
	}

	// Agent not available errors
	if (lowerError.includes('not available') || lowerError.includes('not found')) {
		return {
			title: 'Agent Not Available',
			description:
				'The AI agent could not be started. Please check that it is properly installed and configured.',
		};
	}

	// Session errors
	if (
		lowerError.includes('session') &&
		(lowerError.includes('not active') || lowerError.includes('no active'))
	) {
		return {
			title: 'Session Error',
			description: 'The wizard session is no longer active. Please restart the wizard.',
		};
	}

	// Failed to spawn errors
	if (lowerError.includes('failed to spawn')) {
		return {
			title: 'Failed to Start Agent',
			description: 'Could not start the AI agent. Please check your configuration and try again.',
		};
	}

	// Exit code errors
	if (lowerError.includes('exited with code')) {
		return {
			title: 'Agent Error',
			description: 'The AI agent encountered an error and stopped unexpectedly.',
		};
	}

	// Parse errors
	if (lowerError.includes('parse') || lowerError.includes('failed to parse')) {
		return {
			title: 'Response Error',
			description:
				'Could not understand the response from the AI. Please try rephrasing your message.',
		};
	}

	// Default generic error
	return {
		title: 'Something Went Wrong',
		description: error || 'An unexpected error occurred. Please try again.',
	};
}

/**
 * ErrorDisplay - Shows error messages with a retry button
 */
function ErrorDisplay({
	theme,
	error,
	onRetry,
	onDismiss,
}: {
	theme: Theme;
	error: string;
	onRetry?: () => void;
	onDismiss?: () => void;
}): JSX.Element {
	const { title, description } = getUserFriendlyErrorMessage(error);

	return (
		<div className="flex justify-center mb-4" data-testid="wizard-error-display">
			<div
				className="max-w-md w-full rounded-lg px-4 py-4"
				style={{
					backgroundColor: `${theme.colors.error}15`,
					border: `1px solid ${theme.colors.error}40`,
				}}
			>
				{/* Error header with icon */}
				<div className="flex items-start gap-3">
					<div
						className="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center"
						style={{ backgroundColor: `${theme.colors.error}20` }}
					>
						<span style={{ color: theme.colors.error, fontSize: '16px' }}>⚠️</span>
					</div>
					<div className="flex-1 min-w-0">
						<h4
							className="text-sm font-semibold mb-1"
							style={{ color: theme.colors.error }}
							data-testid="error-title"
						>
							{title}
						</h4>
						<p
							className="text-xs mb-3"
							style={{ color: theme.colors.textMain, opacity: 0.9 }}
							data-testid="error-description"
						>
							{description}
						</p>

						{/* Action buttons */}
						<div className="flex items-center gap-2">
							{onRetry && (
								<button
									onClick={onRetry}
									className="px-3 py-1.5 rounded text-xs font-medium transition-all hover:scale-105"
									style={{
										backgroundColor: theme.colors.error,
										color: 'white',
									}}
									data-testid="error-retry-button"
								>
									Try Again
								</button>
							)}
							{onDismiss && (
								<button
									onClick={onDismiss}
									className="px-3 py-1.5 rounded text-xs font-medium transition-colors hover:opacity-80"
									style={{
										backgroundColor: 'transparent',
										color: theme.colors.textDim,
										border: `1px solid ${theme.colors.border}`,
									}}
									data-testid="error-dismiss-button"
								>
									Dismiss
								</button>
							)}
						</div>
					</div>
				</div>

				{/* Technical details (collapsed by default, can be expanded for debugging) */}
				<details className="mt-3">
					<summary
						className="text-[10px] cursor-pointer select-none"
						style={{ color: theme.colors.textDim }}
					>
						Technical details
					</summary>
					<pre
						className="mt-2 text-[10px] p-2 rounded overflow-x-auto whitespace-pre-wrap"
						style={{
							backgroundColor: theme.colors.bgActivity,
							color: theme.colors.textDim,
						}}
						data-testid="error-technical-details"
					>
						{error}
					</pre>
				</details>
			</div>
		</div>
	);
}

/**
 * WizardConversationView - Scrollable conversation area for the inline wizard
 */
export function WizardConversationView({
	theme,
	conversationHistory,
	isLoading = false,
	streamingText = '',
	agentName = 'Agent',
	providerName,
	className = '',
	confidence = 0,
	ready = false,
	onLetsGo,
	error = null,
	onRetry,
	onClearError,
	showThinking = false,
	thinkingContent = '',
	toolExecutions = [],
	hasStartedGenerating = false,
}: WizardConversationViewProps): JSX.Element {
	const containerRef = useRef<HTMLDivElement>(null);
	const messagesEndRef = useRef<HTMLDivElement>(null);
	const [fillerPhrase, setFillerPhrase] = useState(() => getNextFillerPhrase());

	// Auto-scroll to bottom on new messages or when loading state changes
	const scrollToBottom = useCallback(() => {
		messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
	}, []);

	useEffect(() => {
		scrollToBottom();
	}, [
		conversationHistory,
		isLoading,
		streamingText,
		thinkingContent,
		toolExecutions,
		error,
		scrollToBottom,
	]);

	// Get a new filler phrase when requested by the TypingIndicator
	const handleRequestNewPhrase = useCallback(() => {
		setFillerPhrase(getNextFillerPhrase());
	}, []);

	// Reset filler phrase when loading starts
	useEffect(() => {
		if (isLoading && !streamingText) {
			setFillerPhrase(getNextFillerPhrase());
		}
	}, [isLoading, streamingText]);

	return (
		<div
			ref={containerRef}
			className={`flex-1 min-h-0 overflow-y-auto px-6 py-4 ${className}`}
			style={{ backgroundColor: theme.colors.bgMain }}
			data-testid="wizard-conversation-view"
		>
			{/* Empty state - informative introduction similar to Group Chat */}
			{conversationHistory.length === 0 && !isLoading && (
				<div
					className="flex items-center justify-center h-full px-6"
					data-testid="wizard-conversation-empty"
				>
					<div className="text-center max-w-lg space-y-4">
						{/* Wizard badge */}
						<div className="flex justify-center mb-4">
							<span
								className="text-[10px] font-semibold tracking-wide uppercase px-3 py-1 rounded-full"
								style={{
									backgroundColor: `${theme.colors.accent}20`,
									color: theme.colors.accent,
									border: `1px solid ${theme.colors.accent}40`,
								}}
							>
								🧙 Project Wizard
							</span>
						</div>

						{/* Main description */}
						<div className="space-y-3">
							<p className="text-sm" style={{ color: theme.colors.textMain }}>
								The wizard will help you create an{' '}
								<span style={{ color: theme.colors.accent, fontWeight: 500 }}>
									Auto Run Playbook
								</span>{' '}
								for your project.
							</p>

							<p className="text-sm" style={{ color: theme.colors.textDim }}>
								Through a short conversation, I&apos;ll learn about your project goals, current
								state, and what you want to accomplish.
							</p>
						</div>

						{/* Expected outputs */}
						<div
							className="mt-6 p-4 rounded-lg text-left"
							style={{
								backgroundColor: theme.colors.bgActivity,
								border: `1px solid ${theme.colors.border}`,
							}}
						>
							<p
								className="text-[10px] font-semibold tracking-wide uppercase mb-3"
								style={{ color: theme.colors.textDim }}
							>
								What You&apos;ll Get
							</p>
							<ul className="space-y-2 text-sm" style={{ color: theme.colors.textMain }}>
								<li className="flex items-start gap-2">
									<span style={{ color: theme.colors.success }}>✓</span>
									<span>Phased markdown documents with actionable tasks</span>
								</li>
								<li className="flex items-start gap-2">
									<span style={{ color: theme.colors.success }}>✓</span>
									<span>Auto Run-ready checkboxes the AI can execute</span>
								</li>
								<li className="flex items-start gap-2">
									<span style={{ color: theme.colors.success }}>✓</span>
									<span>A clear roadmap tailored to your project</span>
								</li>
							</ul>
						</div>

						{/* Hint */}
						<p className="text-xs mt-4" style={{ color: theme.colors.textDim }}>
							Press <span style={{ color: theme.colors.accent }}>Escape</span> at any time to exit
							the wizard
						</p>
					</div>
				</div>
			)}

			{/* Conversation History */}
			{conversationHistory.map((message) => (
				<WizardMessageBubble
					key={message.id}
					message={message}
					theme={theme}
					agentName={agentName}
					providerName={providerName}
				/>
			))}

			{/* Streaming Response, Thinking Display, or Typing Indicator */}
			{isLoading &&
				!error &&
				(streamingText ? (
					<StreamingResponse theme={theme} agentName={agentName} streamingText={streamingText} />
				) : showThinking && (thinkingContent || toolExecutions.length > 0) ? (
					// When showThinking is enabled and we have thinking content or tool executions, show it
					<ThinkingDisplay
						theme={theme}
						agentName={agentName}
						thinkingContent={thinkingContent}
						toolExecutions={toolExecutions}
					/>
				) : showThinking ? (
					// When showThinking is enabled but no content yet, show minimal thinking display
					<ThinkingDisplay
						theme={theme}
						agentName={agentName}
						thinkingContent=""
						toolExecutions={[]}
					/>
				) : (
					// Otherwise show the filler phrase typing indicator
					<TypingIndicator
						theme={theme}
						agentName={agentName}
						fillerPhrase={fillerPhrase}
						onRequestNewPhrase={handleRequestNewPhrase}
					/>
				))}

			{/* Error Display - shown when there's an error */}
			{error && !isLoading && (
				<ErrorDisplay theme={theme} error={error} onRetry={onRetry} onDismiss={onClearError} />
			)}

			{/* "Let's Go" Action Button - shown when ready and confidence threshold met, but NOT after generation has started */}
			{ready &&
				confidence >= READY_CONFIDENCE_THRESHOLD &&
				!isLoading &&
				!hasStartedGenerating &&
				onLetsGo && (
					<div
						className="mx-auto max-w-md mb-4 p-4 rounded-lg text-center"
						style={{
							backgroundColor: `${theme.colors.success}15`,
							border: `1px solid ${theme.colors.success}40`,
						}}
						data-testid="wizard-lets-go-container"
					>
						<p className="text-sm font-medium mb-3" style={{ color: theme.colors.success }}>
							I think I have a good understanding of your project. Ready to create your Playbook?
						</p>
						<button
							onClick={onLetsGo}
							className="px-6 py-2.5 rounded-lg text-sm font-bold transition-all hover:scale-105"
							style={{
								backgroundColor: theme.colors.success,
								color: theme.colors.bgMain,
								boxShadow: `0 4px 12px ${theme.colors.success}40`,
							}}
							data-testid="wizard-lets-go-button"
						>
							Let's create your Playbook! 🚀
						</button>
						<p className="text-xs mt-3" style={{ color: theme.colors.textDim }}>
							Or continue chatting below to add more details
						</p>
					</div>
				)}

			{/* Scroll anchor */}
			<div ref={messagesEndRef} data-testid="wizard-scroll-anchor" />

			{/* Bounce animation for typing indicator dots */}
			<style>{`
        @keyframes wizard-typing-bounce {
          0%, 100% {
            transform: translateY(0);
          }
          50% {
            transform: translateY(-4px);
          }
        }
      `}</style>
		</div>
	);
}
