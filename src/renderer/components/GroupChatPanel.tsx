/**
 * GroupChatPanel.tsx
 *
 * Main container for the Group Chat view. Composes the header, messages,
 * and input components into a full chat interface. This panel replaces
 * the MainPanel when a group chat is active.
 */

import { useCallback, useEffect, useRef } from 'react';
import type {
	Theme,
	GroupChat,
	GroupChatMessage,
	GroupChatState,
	Group,
	Shortcut,
	QueuedItem,
} from '../types';
import { GroupChatHeader } from './GroupChatHeader';
import { GroupChatMessages, type GroupChatMessagesHandle } from './GroupChatMessages';
import { GroupChatInput } from './GroupChatInput';
import { OutputSearchBar } from './TerminalOutput/components/OutputSearchBar';
import { groupChatOutputSearchKey, groupChatSearchContentRevision } from '../utils/outputSearch';
import { useOutputSearchSlot } from '../hooks/ui/useOutputSearchSlot';
import { useOutputSearchLayer } from '../hooks/ui/useOutputSearchLayer';
import { useOutputSearchMatching } from '../hooks/ui/useOutputSearchMatching';
import { useDebouncedValue } from '../hooks/utils/useThrottle';

interface GroupChatPanelProps {
	theme: Theme;
	groupChat: GroupChat;
	messages: GroupChatMessage[];
	state: GroupChatState;
	/** Total accumulated cost from all participants (including moderator) */
	totalCost?: number;
	/** True if one or more participants don't have cost data (makes total incomplete) */
	costIncomplete?: boolean;
	onSendMessage: (content: string, images?: string[], readOnly?: boolean) => void;
	onStopAll: () => void;
	onRename: () => void;
	onShowInfo: () => void;
	rightPanelOpen: boolean;
	onToggleRightPanel: () => void;
	shortcuts: Record<string, Shortcut>;
	groups?: Group[];
	onDraftChange?: (draft: string, groupChatId: string) => void;
	onOpenPromptComposer?: () => void;
	draftFlushRef?: React.MutableRefObject<(() => void) | null>;
	// Lifted state for sync with PromptComposer
	stagedImages?: string[];
	setStagedImages?: React.Dispatch<React.SetStateAction<string[]>>;
	readOnlyMode?: boolean;
	setReadOnlyMode?: (value: boolean) => void;
	// External ref for focusing from keyboard handler
	inputRef?: React.RefObject<HTMLTextAreaElement>;
	// Image paste handler from App
	handlePaste?: (e: React.ClipboardEvent) => void;
	// Image drop handler from App
	handleDrop?: (e: React.DragEvent) => void;
	// Image lightbox handler
	onOpenLightbox?: (image: string, contextImages?: string[], source?: 'staged' | 'history') => void;
	// Execution queue props
	executionQueue?: QueuedItem[];
	onRemoveQueuedItem?: (itemId: string) => void;
	onReorderQueuedItems?: (fromIndex: number, toIndex: number) => void;
	// Markdown toggle (Cmd+E)
	markdownEditMode?: boolean;
	onToggleMarkdownEditMode?: () => void;
	// Output collapsing
	maxOutputLines?: number;
	// Input send behavior
	enterToSendAI?: boolean;
	setEnterToSendAI?: (value: boolean) => void;
	// Flash notification callback
	showFlashNotification?: (message: string) => void;
	/** Pre-computed participant colors for consistent colors across components */
	participantColors?: Record<string, string>;
	/** Ref to expose scrollToMessage on the messages component */
	messagesRef?: React.RefObject<GroupChatMessagesHandle>;
	/** Whether gh CLI is available for gist publishing */
	ghCliAvailable?: boolean;
	/** Callback to publish a message as a GitHub Gist */
	onPublishMessageGist?: (text: string, messageId?: string) => void;
}

export function GroupChatPanel({
	theme,
	groupChat,
	messages,
	state,
	totalCost,
	costIncomplete,
	onSendMessage,
	onStopAll,
	onRename,
	onShowInfo,
	rightPanelOpen,
	onToggleRightPanel,
	shortcuts,
	groups,
	onDraftChange,
	onOpenPromptComposer,
	draftFlushRef,
	stagedImages,
	setStagedImages,
	readOnlyMode,
	setReadOnlyMode,
	inputRef,
	handlePaste,
	handleDrop,
	onOpenLightbox,
	executionQueue,
	onRemoveQueuedItem,
	onReorderQueuedItems,
	markdownEditMode,
	onToggleMarkdownEditMode,
	maxOutputLines,
	enterToSendAI,
	setEnterToSendAI,
	showFlashNotification,
	participantColors,
	messagesRef,
	ghCliAvailable,
	onPublishMessageGist,
}: GroupChatPanelProps): JSX.Element {
	const searchKey = groupChatOutputSearchKey(groupChat.id);
	const {
		outputSearchOpen,
		outputSearchQuery,
		outputSearchRegex,
		setOutputSearchQuery,
		setOutputSearchRegex,
		clearOutputSearch,
	} = useOutputSearchSlot(searchKey);

	const messagesScrollRef = useRef<HTMLDivElement | null>(null);
	const debouncedSearchQuery = useDebouncedValue(outputSearchQuery, 150);

	const closeSearch = useCallback(() => {
		clearOutputSearch();
		inputRef?.current?.focus();
	}, [clearOutputSearch, inputRef]);

	useOutputSearchLayer({
		open: outputSearchOpen,
		onEscape: closeSearch,
		ariaLabel: 'Group Chat Search',
	});

	const { currentMatchIndex, totalMatches, regexError, goToNextMatch, goToPrevMatch } =
		useOutputSearchMatching({
			containerRef: messagesScrollRef,
			outputSearchOpen,
			outputSearchRegex,
			debouncedSearchQuery,
			contentRevision: groupChatSearchContentRevision(
				messages,
				debouncedSearchQuery,
				outputSearchOpen
			),
		});

	// Leaving this group chat (unmount or switch to another id) must clear the
	// slot so re-entry does not restore a stale open bar + query.
	useEffect(() => {
		return () => {
			clearOutputSearch();
		};
	}, [searchKey, clearOutputSearch]);

	return (
		<div className="flex flex-col h-full" style={{ backgroundColor: theme.colors.bgMain }}>
			<GroupChatHeader
				theme={theme}
				name={groupChat.name}
				participantCount={groupChat.participants.length}
				totalCost={totalCost}
				costIncomplete={costIncomplete}
				state={state}
				onStopAll={onStopAll}
				onRename={onRename}
				onShowInfo={onShowInfo}
				rightPanelOpen={rightPanelOpen}
				onToggleRightPanel={onToggleRightPanel}
				shortcuts={shortcuts}
			/>

			{/* Same Custom Highlight styles as TerminalOutput - ::highlight is document-global,
			    but TerminalOutput is unmounted while a group chat is active. */}
			{outputSearchOpen && (
				<style>{`
					::highlight(terminal-search-all) {
						background-color: ${theme.colors.warning};
						color: ${theme.mode === 'light' ? '#fff' : '#000'};
					}
					::highlight(terminal-search-current) {
						background-color: ${theme.colors.accent};
						color: #fff;
					}
				`}</style>
			)}

			{outputSearchOpen && (
				<OutputSearchBar
					theme={theme}
					outputSearchQuery={outputSearchQuery}
					outputSearchRegex={outputSearchRegex}
					regexError={regexError}
					currentMatchIndex={currentMatchIndex}
					totalMatches={totalMatches}
					setOutputSearchQuery={setOutputSearchQuery}
					setOutputSearchRegex={setOutputSearchRegex}
					goToNextMatch={goToNextMatch}
					goToPrevMatch={goToPrevMatch}
					onClose={closeSearch}
				/>
			)}

			<GroupChatMessages
				ref={messagesRef}
				theme={theme}
				messages={messages}
				chatId={groupChat.id}
				participants={groupChat.participants}
				state={state}
				markdownEditMode={markdownEditMode}
				onToggleMarkdownEditMode={onToggleMarkdownEditMode}
				maxOutputLines={maxOutputLines}
				participantColors={participantColors}
				onOpenLightbox={onOpenLightbox}
				ghCliAvailable={ghCliAvailable}
				onPublishGist={onPublishMessageGist}
				searchActive={outputSearchOpen}
				scrollContainerRef={messagesScrollRef}
			/>

			<GroupChatInput
				theme={theme}
				state={state}
				onSend={onSendMessage}
				participants={groupChat.participants}
				groups={groups}
				groupChatId={groupChat.id}
				draftMessage={groupChat.draftMessage}
				onDraftChange={onDraftChange}
				onOpenPromptComposer={onOpenPromptComposer}
				draftFlushRef={draftFlushRef}
				stagedImages={stagedImages}
				setStagedImages={setStagedImages}
				readOnlyMode={readOnlyMode}
				setReadOnlyMode={setReadOnlyMode}
				inputRef={inputRef}
				handlePaste={handlePaste}
				handleDrop={handleDrop}
				onOpenLightbox={onOpenLightbox}
				executionQueue={executionQueue}
				onRemoveQueuedItem={onRemoveQueuedItem}
				onReorderQueuedItems={onReorderQueuedItems}
				enterToSendAI={enterToSendAI}
				setEnterToSendAI={setEnterToSendAI}
				showFlashNotification={showFlashNotification}
				shortcuts={shortcuts}
			/>
		</div>
	);
}
