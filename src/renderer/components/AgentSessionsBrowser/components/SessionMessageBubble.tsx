import React from 'react';
import type { Theme } from '../../../types';
import type { SessionMessage } from '../../../hooks/agent/useSessionViewer';
import { ToolCallCard } from '../../ToolCallCard';
import { formatRelativeTime } from '../../../utils/formatters';

interface SessionMessageBubbleProps {
	message: SessionMessage;
	index: number;
	theme: Theme;
}

export const SessionMessageBubble = React.memo(function SessionMessageBubble({
	message,
	index,
	theme,
}: SessionMessageBubbleProps) {
	const isUser = message.type === 'user';
	const isToolCall = message.toolUse && message.toolUse.length > 0;

	return (
		<div key={message.uuid || index} className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
			{isToolCall ? (
				<div className="max-w-[85%]">
					<ToolCallCard
						theme={theme}
						toolUse={message.toolUse}
						timestamp={formatRelativeTime(message.timestamp)}
						defaultExpanded={false}
					/>
				</div>
			) : (
				<div
					className="max-w-[75%] rounded-lg px-4 py-3 text-sm"
					style={{
						backgroundColor: isUser ? theme.colors.accent : theme.colors.bgActivity,
						color: isUser ? (theme.mode === 'light' ? '#fff' : '#000') : theme.colors.textMain,
					}}
				>
					<div className="whitespace-pre-wrap break-words">{message.content || '[No content]'}</div>
					<div
						className="text-[10px] mt-2 opacity-60"
						style={{
							color: isUser ? (theme.mode === 'light' ? '#fff' : '#000') : theme.colors.textDim,
						}}
					>
						{formatRelativeTime(message.timestamp)}
					</div>
				</div>
			)}
		</div>
	);
});
