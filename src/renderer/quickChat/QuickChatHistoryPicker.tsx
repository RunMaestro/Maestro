/**
 * QuickChatHistoryPicker - bring back a recent chat. A QuickChatPicker over the
 * recent chats list (newest first), opened by the History button and Cmd+Y.
 * Picking one returns the window to it: its agent, its tab, and its thread.
 *
 * A row is the chat's first message; its agent, how many messages it has, and
 * when it was last active show beside it. Everything the user sent in the chat,
 * its agent, and its tab's name match too, so a word from a later message finds it.
 */

import { useEffect, useMemo, useState } from 'react';
import type { QuickChatRecentSummary } from '../../shared/quickChat';
import { formatRelativeTime } from '../../shared/formatters';
import { QuickChatPicker, type QuickChatPickerItem } from './QuickChatPicker';
import type { Theme } from '../types';

interface QuickChatHistoryPickerProps {
	theme: Theme;
	/** The chat in the window now, checked and selected first. */
	currentChatId: string | null;
	onPick: (chatId: string) => void;
	/** Close without picking. */
	onClose: () => void;
}

export function recentChatItem(recent: QuickChatRecentSummary): QuickChatPickerItem {
	const messages = `${recent.messageCount} message${recent.messageCount === 1 ? '' : 's'}`;
	return {
		id: recent.id,
		name: recent.title,
		detail: [recent.agentName, messages, formatRelativeTime(recent.updatedAt)]
			.filter(Boolean)
			.join(' - '),
		extras: [recent.agentName, recent.tabName ?? undefined, recent.searchText],
	};
}

export function QuickChatHistoryPicker({
	theme,
	currentChatId,
	onPick,
	onClose,
}: QuickChatHistoryPickerProps) {
	const [recents, setRecents] = useState<QuickChatRecentSummary[] | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let live = true;
		window.maestro.quickChat
			.getRecents()
			.then((list) => {
				if (live) setRecents(list);
			})
			.catch((err: unknown) => {
				if (!live) return;
				setRecents([]);
				setError(err instanceof Error ? err.message : String(err));
			});
		return () => {
			live = false;
		};
	}, []);

	const items = useMemo(() => (recents ?? []).map(recentChatItem), [recents]);
	return (
		<QuickChatPicker
			theme={theme}
			items={items}
			currentId={currentChatId}
			onPick={onPick}
			onClose={onClose}
			placeholder="Search recent chats..."
			listLabel="Recent chats"
			emptyText={
				recents === null
					? 'Loading recent chats...'
					: error
						? `Could not read recent chats: ${error}`
						: 'No recent chats yet'
			}
			noMatchText={(query) => `No recent chat matches "${query}"`}
			testIdPrefix="quick-chat-history"
		/>
	);
}
