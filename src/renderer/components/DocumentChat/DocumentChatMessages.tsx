/**
 * The chat bubble's history.
 *
 * A READING view of the conversation, deliberately not a second transcript
 * renderer: `services/documentChat` has already reduced the tab's log to what
 * you asked and what came back, and the full record - tool cards, thinking,
 * streamed output - is one click away in the popped-out tab. Rebuilding that
 * inside a 320px panel would be a worse copy of something that already exists.
 *
 * It rides `useStickToBottom`, which is the rule for any capped box that fills
 * over time: once the panel hits its height it stops growing, so nothing else is
 * left to follow the tail, and the reader would be stranded on the first screen
 * of a reply while the rest piled up below. Scrolling up releases the pin, which
 * is what makes reading back through a long chat possible at all.
 */

import React from 'react';
import { MessageSquare } from 'lucide-react';
import type { Theme } from '../../types';
import { Markdown } from '../Markdown';
import { useStickToBottom } from '../../hooks/ui/useStickToBottom';
import type { DocumentChatMessage } from '../../services/documentChat';

interface DocumentChatMessagesProps {
	theme: Theme;
	messages: DocumentChatMessage[];
	/** True while the agent is working on this conversation. */
	busy: boolean;
	documentName: string;
}

export const DocumentChatMessages = React.memo(function DocumentChatMessages({
	theme,
	messages,
	busy,
	documentName,
}: DocumentChatMessagesProps) {
	// Keyed on the conversation's length plus its tail so a streaming reply keeps
	// the box pinned as it grows, not only when a new message arrives.
	const scrollRef = useStickToBottom(
		`${messages.length}:${messages[messages.length - 1]?.text.length ?? 0}:${busy}`
	);

	if (messages.length === 0) {
		return (
			<div
				ref={scrollRef}
				data-testid="document-chat-messages"
				className="flex-1 min-h-0 overflow-y-auto flex flex-col items-center justify-center gap-2 px-4 py-6 text-center"
				style={{ overscrollBehavior: 'contain' }}
			>
				<MessageSquare className="w-5 h-5" style={{ color: theme.colors.textDim }} />
				<p className="text-xs leading-relaxed" style={{ color: theme.colors.textDim }}>
					Ask anything about <span style={{ color: theme.colors.textMain }}>{documentName}</span>.
					The agent reads the file first, then answers here.
				</p>
			</div>
		);
	}

	return (
		<div
			ref={scrollRef}
			data-testid="document-chat-messages"
			className="flex-1 min-h-0 overflow-y-auto px-2 py-2 flex flex-col gap-2"
			style={{ overscrollBehavior: 'contain' }}
			onWheel={(e) => e.stopPropagation()}
		>
			{messages.map((message) => (
				<DocumentChatBubble key={message.id} theme={theme} message={message} />
			))}

			{busy && (
				<div
					data-testid="document-chat-thinking"
					className="text-2xs px-2 py-1 self-start animate-pulse"
					style={{ color: theme.colors.textDim }}
				>
					Thinking...
				</div>
			)}
		</div>
	);
});

function DocumentChatBubble({ theme, message }: { theme: Theme; message: DocumentChatMessage }) {
	const isYou = message.kind === 'you';
	const isSystem = message.kind === 'system';

	return (
		<div
			data-testid={`document-chat-message-${message.kind}`}
			// Dimmed while queued: it is the user's message, already theirs, but not
			// yet the agent's. Hiding it would be worse (a chat that swallows what
			// you typed), and drawing it as settled would be a lie.
			title={message.pending ? 'Queued - the agent is busy' : undefined}
			className={`max-w-[92%] rounded-lg px-2.5 py-1.5 text-xs ${isYou ? 'self-end' : 'self-start'} ${message.pending ? 'opacity-60' : ''}`}
			style={{
				backgroundColor: isYou
					? `${theme.colors.accent}22`
					: isSystem
						? `${theme.colors.error}18`
						: theme.colors.bgMain,
				border: `1px solid ${isSystem ? `${theme.colors.error}55` : theme.colors.border}`,
				color: theme.colors.textMain,
			}}
		>
			{isYou || isSystem ? (
				// The user's own words and an error string are plain text. Running them
				// through the markdown pipeline would reformat something they typed.
				<span className="whitespace-pre-wrap break-words">{message.text}</span>
			) : (
				<Markdown
					preset="chat"
					theme={theme}
					content={message.text}
					className="text-xs break-words"
					onCopy={(text) => void navigator.clipboard?.writeText(text)}
				/>
			)}
			{message.streaming && (
				<span className="ml-1 animate-pulse" style={{ color: theme.colors.textDim }}>
					...
				</span>
			)}
		</div>
	);
}

export default DocumentChatMessages;
