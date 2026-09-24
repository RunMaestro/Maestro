/**
 * DocumentChatOverlay - the floating chat control on a file preview.
 *
 * A round button pinned bottom-LEFT and the panel it opens, deliberately the
 * mirror image of `TocOverlay` on the right: same size, same corner offsets,
 * same rounded shell, same click-outside and Escape wiring (both owned by
 * `useTocOverlay`, which is the generic open/close plumbing for these floating
 * panels rather than anything table-of-contents specific). One preview surface,
 * two floating controls, and the muscle memory built on one carries to the other.
 *
 * Presentational only: it does not own the conversation. `useDocumentChat` binds
 * it to the AI tab the chat actually lives in, so the panel, the popped-out tab,
 * and a spoken turn are all views of one conversation.
 *
 * The header carries the two controls that are easy to get wrong:
 *   - **Reset** starts a fresh conversation. It reveals the old one rather than
 *     deleting it, so the button can never cost the user a transcript.
 *   - **Pop out** turns the chat into a real tab. It is disabled before the first
 *     message, because there is no conversation to open yet and a button that
 *     silently does nothing teaches people the button does nothing.
 */

import React, { useCallback } from 'react';
import { MessageSquare, PanelRightOpen, RotateCcw } from 'lucide-react';
import type { Theme } from '../../types';
import { EscCloseButton } from '../ui/EscCloseButton';
import { useDocumentChat } from '../../hooks/ui/useDocumentChat';
import { usePersistedChoice } from '../../hooks/ui/usePersistedChoice';
import { getBasename } from '../../../shared/formatters';
import { DocumentChatComposer } from './DocumentChatComposer';
import { DocumentChatMessages } from './DocumentChatMessages';
import {
	DEFAULT_DOCUMENT_CHAT_MODE,
	DOCUMENT_CHAT_MODES,
	DOCUMENT_CHAT_MODE_STORAGE_KEY,
} from './modes';

/**
 * Panel width. Fixed rather than measured: unlike the ToC, whose width is
 * derived from its longest heading, a chat has no content whose length should
 * decide how wide the box is - a reply is as long as it needs to be and wraps.
 */
export const DOCUMENT_CHAT_WIDTH = 340;

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
	const chat = useDocumentChat({ path, sessionId });
	const { value: mode, setValue: setMode } = usePersistedChoice(
		DOCUMENT_CHAT_MODE_STORAGE_KEY,
		DOCUMENT_CHAT_MODES,
		DEFAULT_DOCUMENT_CHAT_MODE
	);

	const documentName = getBasename(path) || path;
	const close = useCallback(() => onOpenChange(false), [onOpenChange]);

	// Popping out replaces this preview with the AI tab, so the panel that was
	// floating over it has nothing left to float over.
	const handlePopOut = useCallback(() => {
		chat.popOut();
		onOpenChange(false);
	}, [chat, onOpenChange]);

	const buttonTitle = shortcutHint
		? `Chat with this document (${shortcutHint})`
		: 'Chat with this document';

	return (
		<>
			<button
				ref={buttonRef}
				type="button"
				data-testid="document-chat-button"
				onClick={() => onOpenChange(!open)}
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
					className="absolute bottom-16 left-4 rounded-lg shadow-xl overflow-hidden z-20 animate-in fade-in slide-in-from-bottom-2 duration-200 flex flex-col select-none"
					style={{
						backgroundColor: theme.colors.bgSidebar,
						border: `1px solid ${theme.colors.border}`,
						maxHeight: 'calc(70vh - 80px)',
						height: 'calc(70vh - 80px)',
						width: `${DOCUMENT_CHAT_WIDTH}px`,
					}}
					onWheel={(e) => e.stopPropagation()}
				>
					<div
						className="px-3 py-2 border-b flex items-center gap-1.5 flex-shrink-0"
						style={{ borderColor: theme.colors.border }}
					>
						<span
							className="text-xs font-medium uppercase tracking-wide truncate"
							style={{ color: theme.colors.textDim }}
							title={path}
						>
							{documentName}
						</span>

						<div className="flex-1" />

						<HeaderButton
							theme={theme}
							testId="document-chat-reset"
							label="Start a fresh chat about this document"
							disabled={!chat.tab}
							onClick={chat.reset}
						>
							<RotateCcw className="w-3.5 h-3.5" />
						</HeaderButton>

						<HeaderButton
							theme={theme}
							testId="document-chat-pop-out"
							label="Open this chat as a tab"
							disabled={!chat.tab}
							onClick={handlePopOut}
						>
							<PanelRightOpen className="w-3.5 h-3.5" />
						</HeaderButton>

						{/* Escape alone strands users on remote desktops and tablets. */}
						<EscCloseButton theme={theme} onClose={close} />
					</div>

					<DocumentChatMessages
						theme={theme}
						messages={chat.messages}
						busy={chat.busy}
						documentName={documentName}
					/>

					<DocumentChatComposer
						theme={theme}
						mode={mode}
						onModeChange={setMode}
						draft={chat.draft}
						onDraftChange={chat.setDraft}
						onSend={chat.send}
						holdThresholdMs={chat.holdThresholdMs}
						voiceEnabled={chat.voiceEnabled}
						voiceActive={chat.voiceActive}
						onStartVoice={chat.startVoice}
						onStopVoice={chat.stopVoice}
					/>
				</div>
			)}
		</>
	);
});

function HeaderButton({
	theme,
	testId,
	label,
	disabled,
	onClick,
	children,
}: {
	theme: Theme;
	testId: string;
	label: string;
	disabled?: boolean;
	onClick: () => void;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			data-testid={testId}
			aria-label={label}
			title={label}
			disabled={disabled}
			onClick={onClick}
			className="p-1 rounded focus:outline-none focus-visible:ring-2 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-white/10 transition-colors"
			style={{ color: theme.colors.textDim }}
		>
			{children}
		</button>
	);
}

export default DocumentChatOverlay;
