/**
 * Document chat anchored above the preview's bottom-left chat icon. Starts as a compact composer
 * and grows with the conversation, using Quick Chat's shared presentation.
 * Conversation state stays in the bound AI tab across closing the panel and restarting the app.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { MessageSquare } from 'lucide-react';
import type { Theme } from '../../types';
import { EscCloseButton } from '../ui/EscCloseButton';
import { HeaderActionButton } from '../ui/HeaderActionButton';
import { useDocumentChat } from '../../hooks/ui/useDocumentChat';
import { useFontScale } from '../../hooks/ui/useFontScale';
import { getBasename, formatRelativeTime } from '../../../shared/formatters';
import { DocumentChatComposer } from './DocumentChatComposer';
import { DocumentChatMessages } from './DocumentChatMessages';
import { QuickChatPicker } from '../../quickChat/QuickChatPicker';

export interface DocumentChatOverlayProps {
	theme: Theme;
	/** Absolute path of the document, as the owning agent sees it. */
	path: string;
	/** Agent the chat belongs to. Defaults to the active one. */
	sessionId?: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** Ref for the toggle button - `useTocOverlay` needs it for click-outside. */
	buttonRef: React.RefObject<HTMLButtonElement>;
	/** Ref for the panel - `useTocOverlay` needs it for click-outside. */
	overlayRef: React.RefObject<HTMLDivElement>;
	/** Chord that toggles the panel, rendered as a hint on the button. */
	shortcutHint?: string;
}

export const DocumentChatOverlay = React.memo(function DocumentChatOverlay({
	theme,
	path,
	sessionId,
	open,
	onOpenChange,
	buttonRef,
	overlayRef,
	shortcutHint,
}: DocumentChatOverlayProps) {
	const [historyOpen, setHistoryOpen] = useState(false);
	const chat = useDocumentChat({ path, sessionId, includeHistory: open && historyOpen });
	const fontScale = useFontScale('documentChat.fontScale');
	const documentName = getBasename(path) || path;
	const close = useCallback(() => onOpenChange(false), [onOpenChange]);
	useEffect(() => {
		if (!open) chat.stopVoice();
	}, [open, chat.stopVoice]);
	useEffect(() => chat.stopVoice, [chat.stopVoice]);

	const buttonTitle = shortcutHint
		? `Chat with this document (${shortcutHint})`
		: 'Chat with this document';

	return (
		<>
			<button
				ref={buttonRef}
				type="button"
				data-testid="document-chat-button"
				onClick={() => (open ? close() : onOpenChange(true))}
				aria-label={buttonTitle}
				aria-expanded={open}
				className="absolute bottom-4 left-4 p-2.5 rounded-full shadow-lg transition-all duration-200 hover:scale-105 z-10"
				style={{
					backgroundColor: open ? theme.colors.accent : theme.colors.bgSidebar,
					color: open ? theme.colors.accentForeground : theme.colors.textMain,
					border: `1px solid ${theme.colors.border}`,
				}}
				title={buttonTitle}
			>
				<MessageSquare className="w-5 h-5" />
				{/* A live conversation the panel is not showing is worth a mark: the
				    dot is the only way a closed panel can say a reply arrived. */}
				{!open && chat.messages.length > 0 && (
					<span
						data-testid="document-chat-activity-dot"
						className={`absolute top-1 right-1 w-2 h-2 rounded-full ${chat.busy ? 'animate-pulse' : ''}`}
						style={{ backgroundColor: chat.busy ? theme.colors.warning : theme.colors.accent }}
					/>
				)}
			</button>

			{open && (
				<div
					ref={overlayRef}
					data-testid="document-chat-panel"
					className="absolute bottom-16 left-4 z-20 min-h-0 rounded-[20px] shadow-2xl overflow-hidden flex flex-col select-none origin-bottom-left animate-in fade-in slide-in-from-bottom-2 duration-200"
					style={{
						width: 'calc(100% - 2rem)',
						maxWidth: '36rem',
						maxHeight: 'calc(100% - 6rem)',
						backgroundColor: theme.colors.bgMain,
						border: `1px solid ${theme.colors.border}`,
					}}
					onWheel={(e) => e.stopPropagation()}
				>
					<div className="px-4 pt-3 pb-2 flex items-center gap-2 shrink-0">
						<span
							className="min-w-0 text-sm font-medium truncate"
							style={{ color: theme.colors.textDim }}
							title={path}
						>
							{documentName}
						</span>

						<div className="flex-1" />

						<HeaderActionButton
							theme={theme}
							variant="ghost"
							onClick={chat.popOut}
							disabled={!chat.tab}
						>
							Open in tab
						</HeaderActionButton>

						<EscCloseButton
							theme={theme}
							onClose={close}
							testId="document-chat-close"
							className="rounded-full"
							style={{
								backgroundColor: theme.colors.bgActivity,
								border: `1px solid ${theme.colors.border}`,
							}}
						/>
					</div>

					{historyOpen && (
						<div className="min-h-0 overflow-y-auto">
							<QuickChatPicker
								theme={theme}
								items={chat.history.map(({ tab, messages }) => {
									const first = messages.find((m) => m.kind === 'you');
									return {
										id: tab.id,
										name: first?.text ?? tab.name ?? documentName,
										detail: formatRelativeTime(tab.logs.at(-1)?.timestamp ?? tab.createdAt),
										extras: messages.map((m) => m.text),
									};
								})}
								currentId={chat.tab?.id ?? null}
								onPick={(tabId) => {
									chat.restore(tabId);
									setHistoryOpen(false);
								}}
								onClose={() => setHistoryOpen(false)}
								placeholder="Search document chats..."
								listLabel="Document chats"
								emptyText="No document chats yet"
								noMatchText={(query) => `No chat matches "${query}"`}
								testIdPrefix="document-chat-history"
							/>
						</div>
					)}
					{chat.voiceError && (
						<div role="alert" className="px-5 pb-2 text-sm" style={{ color: theme.colors.error }}>
							{chat.voiceError}
						</div>
					)}
					<DocumentChatMessages
						theme={theme}
						messages={chat.messages}
						busy={chat.busy}
						fontScale={fontScale.fontScale}
					/>

					<div className="px-3 pb-3 shrink-0">
						<DocumentChatComposer
							theme={theme}
							fontScale={fontScale}
							draft={chat.draft}
							onDraftChange={chat.setDraft}
							onSend={chat.send}
							chat={chat}
							onHistory={() => setHistoryOpen((value) => !value)}
							holdThresholdMs={chat.holdThresholdMs}
							voiceEnabled={chat.voiceEnabled}
							voiceActive={chat.voiceActive}
							onStartVoice={chat.startVoice}
							onReleaseVoice={chat.releaseVoice}
							onStopVoice={chat.stopVoice}
						/>
					</div>
				</div>
			)}
		</>
	);
});

export default DocumentChatOverlay;
