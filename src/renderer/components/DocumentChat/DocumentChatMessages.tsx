/** Compact conversation view, including the reasoning selected in the composer. */

import React from 'react';
import type { Theme } from '../../types';
import { displayImageSrc } from '../../utils/sessionImageSrc';
import { openZoomViewer } from '../ZoomViewer';
import { ChatUserMessage } from '../ui/ChatSurface';
import { Markdown } from '../Markdown';
import { useStickToBottom } from '../../hooks/ui/useStickToBottom';
import type { DocumentChatMessage } from '../../services/documentChat';

interface DocumentChatMessagesProps {
	theme: Theme;
	messages: DocumentChatMessage[];
	fontScale?: number;
	/** A manually sized panel gives the transcript all remaining height. */
	fillHeight?: boolean;
}

export const DocumentChatMessages = React.memo(function DocumentChatMessages({
	theme,
	messages,
	fontScale = 1,
	fillHeight = false,
}: DocumentChatMessagesProps) {
	// Keyed on the conversation's length plus its tail so a streaming reply keeps
	// the box pinned as it grows, not only when a new message arrives.
	const scrollRef = useStickToBottom(
		`${messages.length}:${messages[messages.length - 1]?.text.length ?? 0}`
	);

	if (messages.length === 0) return null;

	return (
		<div
			ref={scrollRef}
			data-testid="document-chat-messages"
			className={`min-h-0 overflow-y-auto px-5 pb-3 flex flex-col gap-4 ${fillHeight ? 'flex-1' : ''}`}
			style={{
				overscrollBehavior: 'contain',
				maxHeight: fillHeight ? undefined : 'min(64vh, 640px)',
				fontSize: `${0.875 * fontScale}rem`,
			}}
			onWheel={(e) => e.stopPropagation()}
		>
			{messages.map((message) => (
				<DocumentChatBubble key={message.id} theme={theme} message={message} />
			))}
		</div>
	);
});

function DocumentChatBubble({ theme, message }: { theme: Theme; message: DocumentChatMessage }) {
	const isYou = message.kind === 'you';
	const isSystem = message.kind === 'system';
	const isThinking = message.kind === 'thinking';

	if (isYou) {
		return (
			<ChatUserMessage
				theme={theme}
				data-testid="document-chat-message-you"
				title={message.pending ? 'Queued - the agent is busy' : undefined}
				className={`self-end ${message.pending ? 'opacity-60' : ''}`}
			>
				{message.images && (
					<div className="flex gap-2 flex-wrap mb-2">
						{message.images.map((image, index) => (
							<button
								type="button"
								key={`${message.id}-${index}`}
								aria-label={`Open image ${index + 1}`}
								onClick={(event) => {
									const img = event.currentTarget.querySelector('img');
									if (img) openZoomViewer(img, `Image ${index + 1}`);
								}}
							>
								<img
									src={displayImageSrc(image)}
									alt={`Attachment ${index + 1}`}
									className="max-h-24 rounded-lg"
								/>
							</button>
						))}
					</div>
				)}
				{message.text}
				{message.pending && (
					<div className="mt-1 text-xs" style={{ color: theme.colors.warning }}>
						Queued
					</div>
				)}
			</ChatUserMessage>
		);
	}

	return (
		<div
			data-testid={`document-chat-message-${message.kind}`}
			title={message.pending ? 'Queued - the agent is busy' : undefined}
			className={`w-full min-w-0 select-text ${isThinking ? 'italic' : ''}`}
			style={{
				color: isSystem
					? theme.colors.error
					: isThinking
						? theme.colors.textDim
						: theme.colors.textMain,
			}}
		>
			{isSystem ? (
				// Keep error strings literal, including paths and command output.
				<span className="whitespace-pre-wrap break-words">{message.text}</span>
			) : (
				<Markdown
					preset="chat"
					theme={theme}
					content={message.text}
					className="text-[inherit] break-words"
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
