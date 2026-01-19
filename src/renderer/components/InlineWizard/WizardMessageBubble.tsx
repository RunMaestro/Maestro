/**
 * WizardMessageBubble.tsx
 *
 * Message bubble component for the inline wizard conversation.
 * Reuses styling patterns from ConversationScreen.tsx MessageBubble.
 *
 * Features:
 * - User messages: right-aligned with accent color background
 * - Assistant messages: left-aligned with bgActivity background
 * - System messages: left-aligned with warning-tinted background
 * - Timestamp display in bottom-right
 * - Markdown rendering with ReactMarkdown + remarkGfm
 * - Confidence badge for assistant messages (when confidence is available)
 */

import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Theme } from '../../types';
import { getConfidenceColor } from '../Wizard/services/wizardPrompts';

/**
 * Message structure for wizard conversations
 */
export interface WizardMessageBubbleMessage {
	id: string;
	role: 'user' | 'assistant' | 'system';
	content: string;
	timestamp: number;
	/** Parsed confidence from assistant responses */
	confidence?: number;
	/** Parsed ready flag from assistant responses */
	ready?: boolean;
}

export interface WizardMessageBubbleProps {
	/** The message to display */
	message: WizardMessageBubbleMessage;
	/** Theme for styling */
	theme: Theme;
	/** Agent name for assistant messages */
	agentName?: string;
	/** Provider name (e.g., "Claude", "OpenCode") for assistant messages */
	providerName?: string;
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
 * WizardMessageBubble - Individual conversation message display for inline wizard
 *
 * Memoized to prevent unnecessary re-renders when parent state changes
 * (e.g., new messages added, isLoading updates, confidence changes).
 * Only re-renders when the message itself or styling props change.
 */
export const WizardMessageBubble = React.memo(function WizardMessageBubble({
	message,
	theme,
	agentName = 'Agent',
	providerName,
}: WizardMessageBubbleProps): JSX.Element {
	const isUser = message.role === 'user';
	const isSystem = message.role === 'system';

	return (
		<div
			className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-4`}
			data-testid={`wizard-message-bubble-${message.role}`}
		>
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
							<span data-testid="message-sender">
								{isSystem ? '🎼 System' : formatAgentName(agentName)}
							</span>
							{message.confidence !== undefined && (
								<span
									className="text-xs px-1.5 py-0.5 rounded"
									style={{
										backgroundColor: `${getConfidenceColor(message.confidence)}20`,
										color: getConfidenceColor(message.confidence),
									}}
									data-testid="confidence-badge"
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
								data-testid="provider-badge"
							>
								{providerName}
							</span>
						)}
					</div>
				)}

				{/* Message content */}
				<div className="text-sm break-words wizard-markdown" data-testid="message-content">
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
					style={{
						color: isUser ? theme.colors.accentForeground : theme.colors.textDim,
					}}
					data-testid="message-timestamp"
				>
					{formatTimestamp(message.timestamp)}
				</div>
			</div>
		</div>
	);
});
