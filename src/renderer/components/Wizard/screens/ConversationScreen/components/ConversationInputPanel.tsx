import type {
	CSSProperties,
	Dispatch,
	KeyboardEvent,
	MutableRefObject,
	SetStateAction,
} from 'react';
import { Brain } from 'lucide-react';
import type { Theme } from '../../../../../types';
import { READY_CONFIDENCE_THRESHOLD } from '../../../services/wizardPrompts';
import type { WizardMessage } from '../../../WizardContext';
import { formatShortcutKeys } from '../../../../../utils/shortcutFormatter';

const MAX_TEXTAREA_HEIGHT = 120;

export function ConversationInputPanel({
	theme,
	inputRef,
	inputValue,
	setInputValue,
	isConversationLoading,
	conversationHistory,
	confidenceLevel,
	showThinking,
	setShowThinking,
	onSendMessage,
}: {
	theme: Theme;
	inputRef: MutableRefObject<HTMLTextAreaElement | null>;
	inputValue: string;
	setInputValue: Dispatch<SetStateAction<string>>;
	isConversationLoading: boolean;
	conversationHistory: WizardMessage[];
	confidenceLevel: number;
	showThinking: boolean;
	setShowThinking: Dispatch<SetStateAction<boolean>>;
	onSendMessage: () => void;
}): JSX.Element {
	const canSend = !!inputValue.trim() && !isConversationLoading;
	const lastMessage = conversationHistory[conversationHistory.length - 1];
	const shouldShowYourTurn =
		!isConversationLoading &&
		conversationHistory.length > 0 &&
		lastMessage?.role === 'assistant' &&
		confidenceLevel < READY_CONFIDENCE_THRESHOLD;

	const handleTextareaKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
			e.preventDefault();
			onSendMessage();
		}
	};

	return (
		<div
			className="px-6 py-4 border-t"
			style={{
				backgroundColor: theme.colors.bgSidebar,
				borderColor: theme.colors.border,
			}}
		>
			{shouldShowYourTurn && (
				<div
					className="flex items-center gap-2 mb-2 text-xs"
					style={{ color: theme.colors.accent }}
				>
					<span
						className="w-2 h-2 rounded-full animate-pulse"
						style={{ backgroundColor: theme.colors.accent }}
					/>
					<span>Your turn - continue the conversation</span>
				</div>
			)}
			<div className="flex gap-3">
				<div className="flex-1 relative flex items-center">
					<textarea
						ref={inputRef}
						value={inputValue}
						onChange={(e) => setInputValue(e.target.value)}
						onKeyDown={handleTextareaKeyDown}
						placeholder="Describe your project..."
						disabled={isConversationLoading}
						rows={1}
						className="w-full px-4 py-3 rounded-lg border resize-none outline-none transition-all"
						style={{
							backgroundColor: theme.colors.bgMain,
							borderColor: theme.colors.border,
							color: theme.colors.textMain,
							maxHeight: `${MAX_TEXTAREA_HEIGHT}px`,
							lineHeight: '1.5',
							minHeight: '48px',
						}}
						onInput={(e) => {
							const target = e.target as HTMLTextAreaElement;
							target.style.height = 'auto';
							target.style.height = `${Math.min(target.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`;
						}}
					/>
				</div>
				<button
					onClick={onSendMessage}
					disabled={!canSend}
					className="px-4 rounded-lg font-medium transition-all flex items-center gap-2 shrink-0 self-end focus:outline-none focus:ring-2 focus:ring-offset-2"
					style={
						{
							backgroundColor: canSend ? theme.colors.accent : theme.colors.border,
							color: canSend ? theme.colors.accentForeground : theme.colors.textDim,
							cursor: canSend ? 'pointer' : 'not-allowed',
							height: '48px',
							'--tw-ring-color': theme.colors.accent,
							'--tw-ring-offset-color': theme.colors.bgSidebar,
						} as CSSProperties
					}
				>
					{isConversationLoading ? (
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

			<div className="mt-4 flex justify-center gap-6 items-center">
				<span className="text-xs flex items-center gap-1" style={{ color: theme.colors.textDim }}>
					<kbd
						className="px-1.5 py-0.5 rounded text-xs"
						style={{ backgroundColor: theme.colors.border }}
					>
						{formatShortcutKeys(['Meta', 'Shift', 'k'])}
					</kbd>
					<button
						onClick={() => setShowThinking(!showThinking)}
						className={`flex items-center gap-1 px-2 py-1 rounded hover:bg-white/5 transition-opacity focus:outline-none focus:ring-2 focus:ring-offset-1 ${
							showThinking ? 'opacity-100' : 'opacity-50 hover:opacity-100'
						}`}
						title={showThinking ? 'Hide AI thinking (show filler messages)' : 'Show AI thinking'}
						style={
							{
								color: showThinking ? theme.colors.accent : theme.colors.textDim,
								'--tw-ring-color': theme.colors.accent,
								'--tw-ring-offset-color': theme.colors.bgSidebar,
							} as CSSProperties
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
						{formatShortcutKeys(['Meta', 'Enter'])}
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
	);
}
