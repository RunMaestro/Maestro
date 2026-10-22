/**
 * QuickChatTabPicker - choose the tab the next Quick Chat message goes to.
 *
 * A chat stays in the tab its first message found. This is how the user moves
 * it: to another of the agent's tabs, to a new tab, or back to letting Maestro
 * find one ("Any tab"). The picker opens on the row in effect, and the two fixed
 * rows come first, so from Any tab, Cmd+T, Up, Enter starts a new tab without a
 * search.
 */

import { useMemo } from 'react';
import type {
	QuickChatNextTarget,
	QuickChatTabChoice,
	QuickChatTabOption,
} from '../../shared/quickChat';
import { QuickChatPicker, type QuickChatPickerItem } from './QuickChatPicker';
import type { Theme } from '../types';

/** Row ids for the two fixed rows; a tab's row id is `tab:<id>`. */
const NEW_TAB_ROW = 'new';
const ANY_TAB_ROW = 'auto';
const TAB_ROW_PREFIX = 'tab:';

/** The choice a picked row stands for. */
export function tabChoiceFromPickerId(pickerId: string): QuickChatTabChoice {
	if (pickerId === NEW_TAB_ROW) return { kind: 'new' };
	if (pickerId === ANY_TAB_ROW) return { kind: 'auto' };
	return { kind: 'tab', tabId: pickerId.slice(TAB_ROW_PREFIX.length) };
}

/** The row for where the next message goes now, checked and selected first. */
function currentRowId(next: QuickChatNextTarget): string {
	if (next.kind === 'tab') return `${TAB_ROW_PREFIX}${next.tabId}`;
	return next.kind === 'new' ? NEW_TAB_ROW : ANY_TAB_ROW;
}

interface QuickChatTabPickerProps {
	theme: Theme;
	tabs: QuickChatTabOption[];
	next: QuickChatNextTarget;
	/** Called with a row id; turn it into a choice with tabChoiceFromPickerId. */
	onPick: (pickerId: string) => void;
	/** Close without picking. */
	onClose: () => void;
}

export function QuickChatTabPicker({
	theme,
	tabs,
	next,
	onPick,
	onClose,
}: QuickChatTabPickerProps) {
	const items = useMemo<QuickChatPickerItem[]>(
		() => [
			{ id: NEW_TAB_ROW, name: 'New tab', detail: 'Start a fresh conversation' },
			{ id: ANY_TAB_ROW, name: 'Any tab', detail: 'Maestro finds the one that fits' },
			...tabs.map((tab) => ({
				id: `${TAB_ROW_PREFIX}${tab.id}`,
				name: tab.name,
				detail: [tab.inChat ? 'this chat' : '', tab.busy ? 'working' : '']
					.filter(Boolean)
					.join(' - '),
			})),
		],
		[tabs]
	);
	return (
		<QuickChatPicker
			theme={theme}
			items={items}
			currentId={currentRowId(next)}
			onPick={onPick}
			onClose={onClose}
			placeholder="Send the next message to..."
			listLabel="Tabs"
			emptyText="No tabs"
			noMatchText={(query) => `No tab matches "${query}"`}
			testIdPrefix="quick-chat-tab"
		/>
	);
}
