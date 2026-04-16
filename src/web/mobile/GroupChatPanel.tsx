/**
 * GroupChatPanel component for Maestro mobile web interface
 *
 * Displays a group chat conversation with participant bar, message bubbles,
 * and input area for multi-agent group chat sessions.
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { ArrowLeft, Square, Send } from 'lucide-react';
import { useThemeColors } from '../components/ThemeProvider';
import { MobileMarkdownRenderer } from './MobileMarkdownRenderer';
import type { GroupChatState, GroupChatMessage } from '../hooks/useWebSocket';
import { formatTimestamp } from '../../shared/formatters';

export interface GroupChatPanelProps {
	/** Current group chat state */
	chatState: GroupChatState;
	/** Send a message to the group */
	onSendMessage: (message: string) => void;
	/** Stop the group chat */
	onStop: () => void;
	/** Navigate back */
	onBack: () => void;
}

const formatTime = (timestamp: number) => formatTimestamp(timestamp, 'smart');

/**
 * Generate a consistent color for a participant based on their ID
 */
function getParticipantColor(id: string): string {
	const hues = [210, 150, 330, 30, 270, 60, 180, 300, 0, 120];
	let hash = 0;
	for (let i = 0; i < id.length; i++) {
		hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0;
	}
	const hue = hues[Math.abs(hash) % hues.length];
	return `hsl(${hue}, 60%, 50%)`;
}

/**
 * GroupChatPanel component
 */
export function GroupChatPanel({ chatState, onSendMessage, onStop, onBack }: GroupChatPanelProps) {
	const colors = useThemeColors();
	const [inputValue, setInputValue] = useState('');
	const messagesEndRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);

	// Auto-scroll to bottom when new messages arrive
	useEffect(() => {
		messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
	}, [chatState.messages.length]);

	const handleSend = useCallback(() => {
		const trimmed = inputValue.trim();
		if (!trimmed || !chatState.isActive) return;
		onSendMessage(trimmed);
		setInputValue('');
		inputRef.current?.focus();
	}, [inputValue, chatState.isActive, onSendMessage]);

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				handleSend();
			}
		},
		[handleSend]
	);

	const currentTurnParticipant = chatState.currentTurn
		? chatState.participants.find((p) => p.sessionId === chatState.currentTurn)
		: null;

	return (
		<div
			style={{
				position: 'fixed',
				top: 0,
				left: 0,
				right: 0,
				bottom: 0,
				zIndex: 200,
				backgroundColor: colors.bgMain,
				display: 'flex',
				flexDirection: 'column',
				animation: 'slideUp 0.25s ease-out',
			}}
		>
			{/* Header */}
			<div
				style={{
					display: 'flex',
					alignItems: 'center',
					gap: 8,
					padding: '0 12px',
					minHeight: 56,
					borderBottom: `1px solid ${colors.border}`,
					flexShrink: 0,
					paddingTop: 'max(0px, env(safe-area-inset-top))',
				}}
			>
				<button
					onClick={onBack}
					style={{
						background: 'none',
						border: 'none',
						color: colors.textMain,
						cursor: 'pointer',
						padding: 8,
						display: 'flex',
						alignItems: 'center',
					}}
					aria-label="Back"
				>
					<ArrowLeft size={20} />
				</button>

				<div style={{ flex: 1, minWidth: 0 }}>
					<div
						style={{
							fontSize: 15,
							fontWeight: 600,
							color: colors.textMain,
							whiteSpace: 'nowrap',
							overflow: 'hidden',
							textOverflow: 'ellipsis',
						}}
					>
						{chatState.topic}
					</div>
					<div style={{ fontSize: 11, color: colors.textDim }}>
						{chatState.participants.length} participants
					</div>
				</div>

				{chatState.isActive && (
					<button
						onClick={onStop}
						style={{
							background: 'none',
							border: `1px solid ${colors.error}`,
							color: colors.error,
							cursor: 'pointer',
							padding: '6px 12px',
							borderRadius: 6,
							fontSize: 12,
							fontWeight: 500,
							display: 'flex',
							alignItems: 'center',
							gap: 4,
						}}
						aria-label="Stop chat"
					>
						<Square size={12} />
						Stop
					</button>
				)}
			</div>

			{/* Participant bar */}
			<div
				style={{
					display: 'flex',
					gap: 8,
					padding: '8px 12px',
					overflowX: 'auto',
					flexShrink: 0,
					borderBottom: `1px solid ${colors.border}`,
					WebkitOverflowScrolling: 'touch',
				}}
			>
				{chatState.participants.map((participant) => {
					const isCurrentTurn = chatState.currentTurn === participant.sessionId;
					const participantColor = getParticipantColor(participant.sessionId);

					return (
						<div
							key={participant.sessionId}
							style={{
								display: 'flex',
								alignItems: 'center',
								gap: 6,
								padding: '4px 10px',
								borderRadius: 16,
								backgroundColor: isCurrentTurn ? `${colors.accent}20` : `${colors.textDim}10`,
								border: isCurrentTurn ? `1.5px solid ${colors.accent}` : '1.5px solid transparent',
								flexShrink: 0,
								transition: 'all 0.2s ease',
								animation: isCurrentTurn ? 'pulse 2s infinite' : undefined,
							}}
						>
							<div
								style={{
									width: 8,
									height: 8,
									borderRadius: '50%',
									backgroundColor: participantColor,
									flexShrink: 0,
								}}
							/>
							<span
								style={{
									fontSize: 12,
									color: colors.textMain,
									whiteSpace: 'nowrap',
								}}
							>
								{participant.name}
							</span>
						</div>
					);
				})}
			</div>

			{/* Chat ended banner */}
			{!chatState.isActive && (
				<div
					style={{
						padding: '8px 16px',
						backgroundColor: `${colors.warning}15`,
						borderBottom: `1px solid ${colors.border}`,
						textAlign: 'center',
						fontSize: 13,
						color: colors.warning,
						fontWeight: 500,
						flexShrink: 0,
					}}
				>
					Chat ended
				</div>
			)}

			{/* Messages area */}
			<div
				style={{
					flex: 1,
					overflowY: 'auto',
					padding: 12,
					display: 'flex',
					flexDirection: 'column',
					gap: 12,
					WebkitOverflowScrolling: 'touch',
				}}
			>
				{chatState.messages.length === 0 && (
					<div
						style={{
							textAlign: 'center',
							color: colors.textDim,
							fontSize: 13,
							padding: '40px 16px',
						}}
					>
						No messages yet. Start the conversation!
					</div>
				)}

				{chatState.messages.map((message) => (
					<MessageBubble key={message.id} message={message} colors={colors} />
				))}

				{/* Thinking indicator */}
				{chatState.isActive && currentTurnParticipant && (
					<div
						style={{
							display: 'flex',
							alignItems: 'center',
							gap: 8,
							padding: '8px 12px',
							alignSelf: 'flex-start',
							maxWidth: '90%',
						}}
					>
						<div
							style={{
								width: 28,
								height: 28,
								borderRadius: '50%',
								backgroundColor: getParticipantColor(currentTurnParticipant.sessionId),
								display: 'flex',
								alignItems: 'center',
								justifyContent: 'center',
								fontSize: 12,
								fontWeight: 600,
								color: '#fff',
								flexShrink: 0,
							}}
						>
							{currentTurnParticipant.name.charAt(0).toUpperCase()}
						</div>
						<div
							style={{
								fontSize: 13,
								color: colors.textDim,
								fontStyle: 'italic',
								animation: 'pulse 1.5s infinite',
							}}
						>
							{currentTurnParticipant.name} is thinking...
						</div>
					</div>
				)}

				<div ref={messagesEndRef} />
			</div>

			{/* Input area */}
			<div
				style={{
					display: 'flex',
					gap: 8,
					padding: '10px 12px',
					borderTop: `1px solid ${colors.border}`,
					flexShrink: 0,
					paddingBottom: 'max(10px, env(safe-area-inset-bottom))',
					backgroundColor: colors.bgMain,
				}}
			>
				<input
					ref={inputRef}
					type="text"
					value={inputValue}
					onChange={(e) => setInputValue(e.target.value)}
					onKeyDown={handleKeyDown}
					placeholder="Send a message to the group..."
					disabled={!chatState.isActive}
					style={{
						flex: 1,
						padding: '10px 14px',
						borderRadius: 8,
						border: `1px solid ${colors.border}`,
						backgroundColor: chatState.isActive ? colors.bgSidebar : `${colors.textDim}10`,
						color: colors.textMain,
						fontSize: 14,
						outline: 'none',
						opacity: chatState.isActive ? 1 : 0.5,
					}}
				/>
				<button
					onClick={handleSend}
					disabled={!chatState.isActive || !inputValue.trim()}
					style={{
						width: 44,
						height: 44,
						borderRadius: 8,
						border: 'none',
						backgroundColor:
							chatState.isActive && inputValue.trim() ? colors.accent : `${colors.textDim}20`,
						color: chatState.isActive && inputValue.trim() ? '#fff' : colors.textDim,
						cursor: chatState.isActive && inputValue.trim() ? 'pointer' : 'default',
						display: 'flex',
						alignItems: 'center',
						justifyContent: 'center',
						transition: 'all 0.15s ease',
						flexShrink: 0,
					}}
					aria-label="Send message"
				>
					<Send size={18} />
				</button>
			</div>

			{/* Pulse animation for current turn indicator */}
			<style>{`
				@keyframes pulse {
					0%, 100% { opacity: 1; }
					50% { opacity: 0.6; }
				}
			`}</style>
		</div>
	);
}

/**
 * Individual message bubble component
 */
function MessageBubble({
	message,
	colors,
}: {
	message: GroupChatMessage;
	colors: ReturnType<typeof useThemeColors>;
}) {
	const isUser = message.role === 'user';
	const participantColor = getParticipantColor(message.participantId);

	return (
		<div
			style={{
				display: 'flex',
				flexDirection: 'column',
				alignItems: isUser ? 'flex-end' : 'flex-start',
				maxWidth: '90%',
				alignSelf: isUser ? 'flex-end' : 'flex-start',
			}}
		>
			{/* Participant header */}
			<div
				style={{
					display: 'flex',
					alignItems: 'center',
					gap: 6,
					marginBottom: 4,
					flexDirection: isUser ? 'row-reverse' : 'row',
				}}
			>
				<div
					style={{
						width: 24,
						height: 24,
						borderRadius: '50%',
						backgroundColor: participantColor,
						display: 'flex',
						alignItems: 'center',
						justifyContent: 'center',
						fontSize: 11,
						fontWeight: 600,
						color: '#fff',
						flexShrink: 0,
					}}
				>
					{message.participantName.charAt(0).toUpperCase()}
				</div>
				<span style={{ fontSize: 11, color: colors.textDim, fontWeight: 500 }}>
					{message.participantName}
				</span>
				<span style={{ fontSize: 10, color: colors.textDim }}>{formatTime(message.timestamp)}</span>
			</div>

			{/* Message content */}
			<div
				style={{
					padding: '8px 12px',
					borderRadius: 12,
					backgroundColor: isUser ? `${colors.accent}18` : `${colors.textDim}10`,
					borderTopRightRadius: isUser ? 4 : 12,
					borderTopLeftRadius: isUser ? 12 : 4,
				}}
			>
				<MobileMarkdownRenderer content={message.content} fontSize={13} />
			</div>
		</div>
	);
}

export default GroupChatPanel;
