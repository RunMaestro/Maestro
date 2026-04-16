/**
 * CueAiChat — Chat interface for AI-assisted YAML configuration.
 *
 * Shows message history, streaming indicator, and input field.
 */

import { Send } from 'lucide-react';
import { Spinner } from '../ui/Spinner';
import { CUE_COLOR } from '../../../shared/cue-pipeline-types';
import type { Theme } from '../../types';
import type { ChatMessage } from '../../hooks/cue/useCueAiChat';

const AI_PLACEHOLDER = 'Describe what you want to automate...';

interface CueAiChatProps {
	theme: Theme;
	chatMessages: ChatMessage[];
	chatInput: string;
	onChatInputChange: (value: string) => void;
	chatBusy: boolean;
	chatEndRef: React.RefObject<HTMLDivElement>;
	onSend: () => void;
	onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
}

export function CueAiChat({
	theme,
	chatMessages,
	chatInput,
	onChatInputChange,
	chatBusy,
	chatEndRef,
	onSend,
	onKeyDown,
}: CueAiChatProps) {
	return (
		<>
			<h3
				className="text-xs font-bold uppercase tracking-wider shrink-0"
				style={{ color: theme.colors.textDim }}
			>
				AI Assist
			</h3>

			{/* Chat history */}
			<div className="flex-1 overflow-y-auto min-h-0 space-y-2" data-testid="ai-chat-history">
				{chatMessages.length === 0 && !chatBusy && (
					<p className="text-xs" style={{ color: theme.colors.textDim }}>
						Describe what you want to automate. The agent will edit the config file and can answer
						questions.
					</p>
				)}
				{chatMessages.map((msg, i) => (
					<div
						key={i}
						className="rounded px-2.5 py-1.5 text-xs whitespace-pre-wrap"
						style={{
							backgroundColor: msg.role === 'user' ? `${CUE_COLOR}15` : theme.colors.bgActivity,
							color: theme.colors.textMain,
						}}
						data-testid={`chat-message-${msg.role}`}
					>
						{msg.text}
					</div>
				))}
				{chatBusy && (
					<div
						className="flex items-center gap-2 px-2.5 py-1.5 text-xs"
						style={{ color: theme.colors.textDim }}
						data-testid="chat-busy-indicator"
					>
						<Spinner size={12} />
						Agent is working...
					</div>
				)}
				<div ref={chatEndRef} />
			</div>

			{/* Chat input */}
			<div className="flex gap-1.5 shrink-0">
				<textarea
					value={chatInput}
					onChange={(e) => onChatInputChange(e.target.value)}
					onKeyDown={onKeyDown}
					placeholder={AI_PLACEHOLDER}
					disabled={chatBusy}
					rows={2}
					className="flex-1 p-2 rounded border bg-transparent outline-none text-xs resize-none disabled:opacity-50"
					style={{
						borderColor: theme.colors.border,
						color: theme.colors.textMain,
					}}
					data-testid="ai-chat-input"
				/>
				<button
					onClick={onSend}
					disabled={!chatInput.trim() || chatBusy}
					className="self-end p-2 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
					style={{
						backgroundColor: chatInput.trim() && !chatBusy ? CUE_COLOR : theme.colors.bgActivity,
						color:
							chatInput.trim() && !chatBusy ? theme.colors.accentForeground : theme.colors.textDim,
					}}
					data-testid="ai-chat-send"
				>
					<Send className="w-3.5 h-3.5" />
				</button>
			</div>
		</>
	);
}
