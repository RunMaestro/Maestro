import React, { RefObject } from 'react';
import { Loader2 } from 'lucide-react';
import { Spinner } from '../../ui/Spinner';
import type { Theme } from '../../../types';
import type { SessionMessage } from '../../../hooks/agent/useSessionViewer';
import { SessionMessageBubble } from './SessionMessageBubble';

interface SessionMessagesViewProps {
	messages: SessionMessage[];
	messagesLoading: boolean;
	hasMoreMessages: boolean;
	theme: Theme;
	messagesContainerRef: RefObject<HTMLDivElement>;
	onScroll: React.UIEventHandler<HTMLDivElement>;
	onKeyDown: React.KeyboardEventHandler<HTMLDivElement>;
	handleLoadMore: () => void;
}

export const SessionMessagesView = React.memo(function SessionMessagesView({
	messages,
	messagesLoading,
	hasMoreMessages,
	theme,
	messagesContainerRef,
	onScroll,
	onKeyDown,
	handleLoadMore,
}: SessionMessagesViewProps) {
	return (
		<div
			ref={messagesContainerRef}
			className="flex-1 overflow-y-auto p-6 space-y-4 outline-none scrollbar-thin"
			onScroll={onScroll}
			onKeyDown={onKeyDown}
			tabIndex={0}
			role="region"
			aria-label="Session messages"
		>
			{hasMoreMessages && (
				<div className="text-center py-2">
					{messagesLoading ? (
						<Loader2
							className="w-5 h-5 animate-spin mx-auto"
							style={{ color: theme.colors.textDim }}
						/>
					) : (
						<button
							onClick={handleLoadMore}
							className="text-sm hover:underline"
							style={{ color: theme.colors.accent }}
						>
							Load earlier messages...
						</button>
					)}
				</div>
			)}

			{messages.map((msg, idx) => (
				<SessionMessageBubble key={msg.uuid || idx} message={msg} index={idx} theme={theme} />
			))}

			{messagesLoading && messages.length === 0 && (
				<div className="flex items-center justify-center py-8">
					<Spinner size={24} color={theme.colors.textDim} />
				</div>
			)}
		</div>
	);
});
