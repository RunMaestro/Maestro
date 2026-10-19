/**
 * TabWindowContent - the active tab's content in a tab window (TW-2).
 *
 * Reuses the single-tab views the main panel's tiled panes render, never a
 * fork: `TiledAiPane` (the transcript, `TerminalOutput`) for an AI tab and
 * `TiledFilePane` (`FilePreview`) for a file tab. Both take a session and a tab
 * id, so they render a tab that is not the session's active one.
 *
 * The AI transcript's controls come in `chatActions`, the same bundle a tiled
 * pane gets, built by `useTabWindowChatActions`: each one that writes the agent
 * is an intent to the owner (D2). The file pane's come from
 * `useTabWindowFileTabs`: this window renders the file and owns its edits while
 * the tab is popped out, and writes them back (D5). Terminal and browser tabs
 * render nothing here: `TabWindowTerminals` keeps every terminal of the strip
 * mounted above this content, and `TabWindowBrowsers` opens a new webview for
 * each browser tab (D5).
 */

import type { Session, Theme, UnifiedTab } from '../../types';
import {
	PaneMissingTab,
	TiledAiPane,
	TiledFilePane,
	type PaneChatActions,
	type PaneFileActions,
} from '../MainPanel/TiledLayout';

export interface TabWindowContentProps {
	theme: Theme;
	session: Session;
	/** The tab this window shows, or null when its record names no live tab. */
	activeTab: UnifiedTab | null;
	/** The AI transcript's controls (each one that writes the agent is an intent). */
	chatActions: PaneChatActions | null;
	/** The file preview's controls (each one runs on this window's copy of the tab). */
	fileActions: PaneFileActions | null;
}

export function TabWindowContent({
	theme,
	session,
	activeTab,
	chatActions,
	fileActions,
}: TabWindowContentProps) {
	if (!activeTab) return <PaneMissingTab theme={theme} />;
	switch (activeTab.type) {
		case 'ai':
			return (
				<TiledAiPane
					// One transcript view per tab, as the main panel keys its own.
					key={activeTab.id}
					aiTabId={activeTab.id}
					session={session}
					theme={theme}
					isFocused
					actions={chatActions}
				/>
			);
		case 'file':
			return (
				<TiledFilePane
					key={activeTab.id}
					fileTabId={activeTab.id}
					session={session}
					theme={theme}
					actions={fileActions}
				/>
			);
		case 'terminal':
			// Drawn by TabWindowTerminals, which keeps the xterm alive across tab switches.
			return null;
		case 'browser':
			// Drawn by TabWindowBrowsers, which keeps the page alive across tab switches.
			return null;
		default:
			return <PaneMissingTab theme={theme} />;
	}
}
