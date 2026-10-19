/**
 * TabWindowRoot - render entry for a tab window.
 *
 * The main process loads the main renderer bundle into an ordinary OS window
 * with `?tabWindow=<windowId>`, and main.tsx mounts this instead of the full
 * app. A tab window holds one agent's popped-out tabs and nothing else: no Left
 * Bar, no Right Bar (TW-2). It is a view. The app window that owns the agent
 * stays its only writer (D1); this window renders what that owner publishes and
 * sends every action back as an intent (D2).
 *
 * So this root mounts only the providers and app-level hosts the tab UI needs,
 * NOT `App.tsx`: no `WindowProvider` (it would believe it is the primary
 * window), no `process:*` listeners, no persistence, no remote integration.
 * The full list and the reason for each is in
 * `docs/agent-guides/TAB-WINDOWS.md` ("Tab window providers and hosts").
 *
 * Layout, top to bottom: `TabWindowHeader` (status dot, agent name, Dock), the
 * shared `TabBar` fed with only this window's tabs, `TabWindowContent`, and,
 * under an AI tab, the composer with its thinking pill (`TabWindowComposer`).
 * Which tabs, and which one is shown, come from this window's registry record
 * (`useTabWindowInfo`). The agent's `Session` comes from the renderer
 * `sessionStore`, which holds only this agent, applied from the owner's patches
 * (`useTabWindowMirror`). Tab shortcuts and chip menus work as in the main
 * window (TW-6, `useTabWindowKeyboard`). Every action that writes the agent is
 * an intent the owner runs (`services/tabWindowIntents.ts` there); the dialogs
 * that confirm one are this window's own (`TabWindowModals`).
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { LayerStackProvider } from '../../contexts/LayerStackContext';
import { useWindowSettingsSync } from '../../hooks/settings/useWindowSettingsSync';
import { useResolvedTheme } from '../../hooks/ui/useResolvedTheme';
import { updateSessionWith, useSessionStore } from '../../stores/sessionStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useModalStore } from '../../stores/modalStore';
import { usePermissionRequestStore } from '../../stores/permissionRequestStore';
import {
	buildTabWindowStripSession,
	buildTabWindowUnifiedTabs,
	focusFieldsForRef,
	moveUnifiedTabToTarget,
} from '../../utils/tabHelpers';
import { resolveTabRefRenameValue } from '../../utils/panelLayout';
import { resolveSnoozeTarget } from '../../utils/snoozeHelpers';
import { getTerminalSessionId } from '../../utils/terminalTabHelpers';
import { sendTabWindowIntent } from '../../services/tabWindowIntentSender';
import { dockTab } from '../../services/tabWindowActions';
import {
	closeAiTabWithConfirm,
	closeFileTabWithConfirm,
	closeTerminalTabWithConfirm,
} from '../../services/tabCloseConfirm';
import {
	excludePreservedRefs,
	getRefsExceptActive,
	getRefsLeftOfActive,
	getRefsRightOfActive,
} from '../../hooks/tabs/internal/unifiedCloseHelpers';
import { isSessionRemote } from '../../utils/sessionHelpers';
import { formatTabWindowTitle, type TabWindowTabRef } from '../../../shared/tabWindowTypes';
import {
	isSameTabRef,
	isSingleTabRef,
	type SingleTabType,
	type UnifiedTabRef,
} from '../../../shared/unifiedTabRef';
import type { Session, Theme, UnifiedTab } from '../../types';
import { ToastContainer } from '../Toast';
import { CenterFlash } from '../CenterFlash';
import { ImageContextMenuHost } from '../ImageContextMenuHost';
import { ZoomViewerHost } from '../ZoomViewer';
import { PermissionPrompt } from '../PermissionPrompt/PermissionPrompt';
import { TabBar } from '../TabBar';
import { TabWindowHeader } from './TabWindowHeader';
import { TabWindowContent } from './TabWindowContent';
import { TabWindowTerminals } from './TabWindowTerminals';
import { TabWindowBrowsers } from './TabWindowBrowsers';
import { TabWindowComposer } from './TabWindowComposer';
import { TabWindowModals } from './TabWindowModals';
import { useTabWindowChatActions } from './useTabWindowChatActions';
import { useTabWindowDraft } from './useTabWindowDraft';
import { useTabWindowFileTabs } from './useTabWindowFileTabs';
import { useTabWindowViewState } from './useTabWindowViewState';
import { useTabWindowInfo } from './useTabWindowInfo';
import { useTabWindowKeyboard } from './useTabWindowKeyboard';
import { useTabWindowMirror } from './useTabWindowMirror';
import { useTabWindowSelection } from './useTabWindowSelection';
import { runTabWindowCall } from './runTabWindowCall';

export interface TabWindowRootProps {
	/** Registry id of this tab window (the `?tabWindow=<id>` query value). */
	windowId: string;
}

const NO_TAB_REFS: TabWindowTabRef[] = [];

export function TabWindowRoot({ windowId }: TabWindowRootProps) {
	return (
		<LayerStackProvider>
			<TabWindowShell windowId={windowId} />
		</LayerStackProvider>
	);
}

function TabWindowShell({ windowId }: TabWindowRootProps) {
	// This renderer does not run `useSettings`: load the settings, follow
	// changes made in other windows, and publish the typography here.
	useWindowSettingsSync();
	const theme = useResolvedTheme();

	const { info } = useTabWindowInfo();
	// The owner's patches are this window's only source of the agent (D2).
	useTabWindowMirror(info);
	const agentId = info?.agentId ?? null;
	const session = useSessionStore((s) =>
		agentId ? (s.sessions.find((x) => x.id === agentId) ?? null) : null
	);
	useTabWindowTitle(session?.name);
	usePermissionPromptsForStrip(info?.tabRefs ?? NO_TAB_REFS);

	return (
		<div
			className="flex flex-col h-screen w-screen overflow-hidden"
			style={{ backgroundColor: theme.colors.bgMain, color: theme.colors.textMain }}
			data-testid="tab-window-root"
			data-tab-window-id={windowId}
		>
			{session && info ? (
				<TabWindowBody
					theme={theme}
					session={session}
					tabRefs={info.tabRefs ?? NO_TAB_REFS}
					activeTabRef={info.activeTabRef}
				/>
			) : (
				<TabWindowHeader theme={theme} session={session} />
			)}
			<ToastContainer theme={theme} />
			<CenterFlash theme={theme} />
			<ImageContextMenuHost theme={theme} />
			<ZoomViewerHost theme={theme} />
			<TabWindowModals theme={theme} session={session} />
			{/* Main prompts here for a tab this window shows (permission relay routing). */}
			<PermissionPrompt theme={theme} />
		</div>
	);
}

/**
 * Keep this window's permission prompts to its own tabs. Main prompts a
 * request in the tab window that shows its tab, and moves one still waiting
 * when the tab docks; this forgets the moved one here without answering it.
 */
function usePermissionPromptsForStrip(tabRefs: TabWindowTabRef[]): void {
	useEffect(() => {
		usePermissionRequestStore
			.getState()
			.forget((request) => !tabRefs.some((ref) => ref.type === 'ai' && ref.id === request.tabId));
	}, [tabRefs]);
}

/** Keep the OS title on `<agent name> - Tab Window`, through renames (TW-3). */
function useTabWindowTitle(agentName: string | undefined): void {
	useEffect(() => {
		document.title = formatTabWindowTitle(agentName);
	}, [agentName]);
}

interface TabWindowBodyProps {
	theme: Theme;
	session: Session;
	/** This window's tabs, in its own strip order. */
	tabRefs: TabWindowTabRef[];
	/** The tab main says this window shows; null falls back to the first tab. */
	activeTabRef: TabWindowTabRef | null;
}

function TabWindowBody({ theme, session, tabRefs, activeTabRef }: TabWindowBodyProps) {
	const colorBlindMode = useSettingsStore((s) => s.colorBlindMode);
	const tabWindows = window.maestro.tabWindows;
	const agentId = session.id;

	// Which tab shows. A selection shows at once and the record catches up.
	const { activeTabRef: shownRef, selectTab } = useTabWindowSelection(agentId, activeTabRef);

	// Only this window's tabs, in its own order (never the owner's strip).
	const unifiedTabs = useMemo(
		() => buildTabWindowUnifiedTabs(session, tabRefs),
		[session, tabRefs]
	);
	const aiTabs = useMemo(
		() => unifiedTabs.flatMap((tab) => (tab.type === 'ai' ? [tab.data] : [])),
		[unifiedTabs]
	);
	const activeTab: UnifiedTab | null = useMemo(() => {
		const find = (ref: TabWindowTabRef | null) =>
			ref ? (unifiedTabs.find((tab) => isSameTabRef(tab, ref)) ?? null) : null;
		// A pending selection whose tab just left falls back to the record.
		return find(shownRef) ?? find(activeTabRef ?? tabRefs[0] ?? null);
	}, [shownRef, activeTabRef, tabRefs, unifiedTabs]);

	// The agent as this window sees it: its active pointers name this window's
	// tab, never the owner's (the owner's active AI tab is not in this strip).
	const viewSession = useMemo<Session>(() => {
		const focused = activeTab ? { ...session, ...focusFieldsForRef(session, activeTab) } : session;
		const activeAiInStrip = aiTabs.some((tab) => tab.id === focused.activeTabId);
		return activeAiInStrip ? focused : { ...focused, activeTabId: aiTabs[0]?.id ?? '' };
	}, [session, activeTab, aiTabs]);
	// The store's copy of the agent points at the same tabs. The active pointers
	// are per-window fields the owner's patches never write, and the shared
	// composer and transcript code reads them from the store (the active tab is
	// what a send, a Stop, or a link click acts on).
	useShownTabInStore(viewSession);
	// The same agent narrowed to this strip: what the shared tab math (keyboard
	// navigation, reorder, bulk-close pickers) runs on, so it walks these chips only.
	const stripSession = useMemo(
		() => buildTabWindowStripSession(viewSession, tabRefs),
		[viewSession, tabRefs]
	);
	const refOf = useCallback(
		(id: string): TabWindowTabRef | null => {
			const tab = unifiedTabs.find((t) => t.id === id);
			return tab && tab.type !== 'group' ? { type: tab.type, id: tab.id } : null;
		},
		[unifiedTabs]
	);

	// Closing is a real close through the owner's close path (D7). What it would
	// lose is confirmed here first, by the same rules the owner's chips use.
	const closeTab = useCallback(
		(type: SingleTabType, id: string) => {
			const close = () => sendTabWindowIntent({ kind: 'closeTab', agentId, tabRef: { type, id } });
			const current = useSessionStore.getState().sessions.find((s) => s.id === agentId);
			if (type === 'ai') {
				closeAiTabWithConfirm(
					current?.aiTabs.find((t) => t.id === id),
					close
				);
			} else if (type === 'file') {
				closeFileTabWithConfirm(
					current?.filePreviewTabs.find((t) => t.id === id),
					close
				);
			} else if (type === 'terminal') {
				closeTerminalTabWithConfirm(getTerminalSessionId(agentId, id), close);
			} else {
				close();
			}
		},
		[agentId]
	);
	// The shown AI tab: its draft, its transcript's actions, its composer, its view state.
	const shownAiTab = activeTab?.type === 'ai' ? activeTab.data : null;
	// Its draft lives here while it is popped out, and is written back to the owner (D2).
	const { flushDraft } = useTabWindowDraft(agentId, shownAiTab?.id ?? null);
	// This window renders its file tabs and owns their edits while they are here (D5).
	const { fileActions, flushFileTabs } = useTabWindowFileTabs(
		agentId,
		tabRefs,
		activeTab?.type === 'file' ? activeTab.id : null,
		closeTab
	);
	const activeRef: TabWindowTabRef | null =
		activeTab && activeTab.type !== 'group' ? { type: activeTab.type, id: activeTab.id } : null;
	// The two ways out of TW-11 that dock one tab: the header's Dock button and
	// the chip menu's "Dock to Main Window" (and its shortcut).
	const dockTabRef = useCallback(
		(ref: TabWindowTabRef) => {
			// The owner shows a docked tab with the draft and the file edits it holds
			// for it, so those go first: main relays this window's messages in order.
			flushDraft();
			flushFileTabs();
			void runTabWindowCall(
				'dock',
				() => dockTab(agentId, ref),
				(result) => (result.docked ? null : result.error)
			);
		},
		[agentId, flushDraft, flushFileTabs]
	);
	const dockActiveTab = useCallback(() => {
		if (activeRef) dockTabRef(activeRef);
	}, [activeRef, dockTabRef]);

	// Tab shortcuts: the main window's entries, scoped to this strip (TW-6).
	useTabWindowKeyboard({
		stripSession,
		activeTabRef: activeRef,
		onSelectTab: selectTab,
		onCloseTab: closeTab,
		onDockTab: dockTabRef,
	});

	// Chip menus. Each is the intent the owner runs with its own handler
	// (phase 5); the refs are picked here by the same helpers the owner strip
	// uses, on the narrowed session, so "Close Others" means this strip.
	const starTab = useCallback(
		(id: string, starred: boolean) => {
			tabWindows.sendIntent({ kind: 'starTab', agentId, tabRef: { type: 'ai', id }, starred });
		},
		[tabWindows, agentId]
	);
	const markTabUnread = useCallback(
		(id: string) => {
			tabWindows.sendIntent({ kind: 'markUnread', agentId, tabRef: { type: 'ai', id } });
		},
		[tabWindows, agentId]
	);
	const reorderTab = useCallback(
		(sourceTabId: string, targetTabId: string) => {
			const source = refOf(sourceTabId);
			const moved = moveUnifiedTabToTarget(stripSession, sourceTabId, targetTabId);
			if (!source || moved === stripSession) return;
			tabWindows.sendIntent({
				kind: 'reorderTabs',
				agentId,
				tabRef: source,
				tabRefs: moved.unifiedTabOrder.filter(isSingleTabRef),
			});
		},
		[tabWindows, agentId, refOf, stripSession]
	);
	const closeTabsBy = useCallback(
		(pick: (session: Session, pivotTabId?: string) => UnifiedTabRef[], pivotTabId?: string) => {
			const pivot = pivotTabId ? refOf(pivotTabId) : activeRef;
			const tabRefsToClose = excludePreservedRefs(
				stripSession,
				pick(stripSession, pivot?.id)
			).filter(isSingleTabRef);
			if (!pivot || tabRefsToClose.length === 0) return;
			tabWindows.sendIntent({ kind: 'closeTabs', agentId, tabRef: pivot, tabRefs: tabRefsToClose });
		},
		[tabWindows, agentId, refOf, activeRef, stripSession]
	);
	// Rename and snooze open this window's own dialogs (TabWindowModals), which
	// send the `renameTab` / `snoozeTab` intent once the user confirms.
	const requestRename = useCallback(
		(id: string) => {
			const ref = refOf(id);
			const initialName = ref ? resolveTabRefRenameValue(session, ref) : null;
			if (initialName === null) return;
			useModalStore.getState().openModal('renameTab', { tabId: id, initialName });
		},
		[refOf, session]
	);
	const requestSnooze = useCallback(
		(id: string) => {
			const target = resolveSnoozeTarget(session, id);
			if (target) useModalStore.getState().openModal('snoozeTab', target);
		},
		[session]
	);
	const summarizeAndContinue = useCallback(
		(id: string) => {
			tabWindows.sendIntent({ kind: 'summarizeAndContinue', agentId, tabRef: { type: 'ai', id } });
		},
		[tabWindows, agentId]
	);

	const composerInputRef = useRef<HTMLTextAreaElement>(null);
	const chatActions = useTabWindowChatActions(
		viewSession,
		shownAiTab?.id ?? viewSession.activeTabId,
		composerInputRef
	);
	useTabWindowViewState(agentId, shownAiTab?.id ?? null);

	return (
		<>
			<TabWindowHeader
				theme={theme}
				session={session}
				onDock={activeRef ? dockActiveTab : undefined}
			/>
			<TabBar
				tabs={aiTabs}
				activeTabId={viewSession.activeTabId}
				theme={theme}
				sessionId={agentId}
				sessionAgentSessionId={session.agentSessionId}
				unifiedTabs={unifiedTabs}
				activeFileTabId={viewSession.activeFileTabId}
				activeBrowserTabId={viewSession.activeBrowserTabId}
				activeTerminalTabId={viewSession.activeTerminalTabId}
				inputMode={viewSession.inputMode}
				onTabSelect={(id) => selectTab('ai', id)}
				onFileTabSelect={(id) => selectTab('file', id)}
				onBrowserTabSelect={(id) => selectTab('browser', id)}
				onTerminalTabSelect={(id) => selectTab('terminal', id)}
				onTabClose={(id) => closeTab('ai', id)}
				onFileTabClose={(id) => closeTab('file', id)}
				onBrowserTabClose={(id) => closeTab('browser', id)}
				onTerminalTabClose={(id) => closeTab('terminal', id)}
				onTabStar={starTab}
				onTabMarkUnread={markTabUnread}
				onRequestRename={requestRename}
				onFileTabRename={requestRename}
				onBrowserTabRename={requestRename}
				onSnooze={requestSnooze}
				onTabWindowMove={dockTabRef}
				onSummarizeAndContinue={summarizeAndContinue}
				onUnifiedTabReorder={reorderTab}
				onCloseOtherTabs={(pivot) => closeTabsBy(getRefsExceptActive, pivot)}
				onCloseTabsLeft={(pivot) => closeTabsBy(getRefsLeftOfActive, pivot)}
				onCloseTabsRight={(pivot) => closeTabsBy(getRefsRightOfActive, pivot)}
				colorBlindMode={colorBlindMode}
				sshRemote={isSessionRemote(session)}
			/>
			<div className="flex-1 min-h-0 flex flex-col relative">
				<TabWindowContent
					theme={theme}
					session={viewSession}
					activeTab={activeTab}
					chatActions={chatActions}
					fileActions={fileActions}
				/>
				<TabWindowTerminals
					theme={theme}
					session={viewSession}
					tabRefs={tabRefs}
					shownTabId={activeTab?.type === 'terminal' ? activeTab.id : null}
				/>
				<TabWindowBrowsers
					theme={theme}
					session={viewSession}
					tabRefs={tabRefs}
					shownTabId={activeTab?.type === 'browser' ? activeTab.id : null}
				/>
			</div>
			{/* Where the composer sits in an app window, and like it, under an AI tab only. */}
			{shownAiTab && (
				<div className="shrink-0" data-testid="tab-window-composer">
					<TabWindowComposer
						theme={theme}
						session={viewSession}
						tab={shownAiTab}
						tabRefs={tabRefs}
						inputRef={composerInputRef}
						onSelectTab={selectTab}
						flushDraft={flushDraft}
					/>
				</div>
			)}
		</>
	);
}

/** The focus fields of a session, the per-window pointers the shown tab sets. */
const FOCUS_FIELDS = [
	'activeTabId',
	'activeFileTabId',
	'activeBrowserTabId',
	'activeTerminalTabId',
	'activeGroupId',
	'inputMode',
] as const;

/**
 * Write the shown tab's focus pointers into this window's copy of the agent
 * whenever they differ, so code that reads the store's active agent and its
 * active tab (the composer's keyboard handler, the send menu, the lightbox,
 * services acting on "the shown tab") sees this window's tab, never the
 * owner's. These are per-window fields: an owner patch never writes them.
 */
function useShownTabInStore(viewSession: Session): void {
	useEffect(() => {
		const stored = useSessionStore.getState().sessions.find((s) => s.id === viewSession.id);
		if (!stored || FOCUS_FIELDS.every((field) => stored[field] === viewSession[field])) return;
		updateSessionWith(viewSession.id, (s) => {
			const next = { ...s };
			for (const field of FOCUS_FIELDS) {
				(next as Record<string, unknown>)[field] = viewSession[field];
			}
			return next;
		});
	}, [viewSession]);
}
