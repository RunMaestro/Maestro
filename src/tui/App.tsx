import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useApp, useInput } from 'ink';
import type { MaestroClient, MaestroPaths } from '../shared/maestro-lib';
import { visibleAiTabsOf } from '../shared/maestro-lib';
import { HelpOverlay } from './app/HelpOverlay';
import { HistoryView } from './app/HistoryView';
import { moveHistoryCursor, openHistory, type HistoryViewState } from './app/history';
import { Shell } from './app/Shell';
import { TabSwitcher } from './app/TabSwitcher';
import { resolveActiveTab } from './app/ConversationPane';
import { buildPaneRows, initialCursorKey, moveCursor, isSectionCollapsed } from './app/agentRows';
import { useAgentSource, useTabEntries } from './app/useAgentSource';
import { useTerminalSize } from './app/useTerminalSize';
import { useViewState } from './app/useViewState';
import { cyclePane, isAgentsPaneVisible, visiblePanes, type PaneId } from './app/layout';
import { resolveAction, type KeyContext } from './keymap';
import { tuiStateFilePath } from './store/view-state';

export interface AppProps {
	paths: Pick<
		MaestroPaths,
		| 'userDataDir'
		| 'sessionsFile'
		| 'groupsFile'
		| 'settingsFile'
		| 'agentConfigsFile'
		| 'historyDir'
	>;
	/**
	 * The client for the running desktop. With one, the TUI attaches to the host
	 * and follows it live; without, or when no desktop answers, it reads the store
	 * files and stays read-only.
	 */
	client?: MaestroClient;
}

/** The overlay on screen, if any. Only one at a time, and Esc closes it. */
type OverlayState =
	| { kind: 'help' }
	| { kind: 'tabs'; agentId: string; cursor: number }
	| { kind: 'history'; history: HistoryViewState };

export function App({ paths, client }: AppProps): React.ReactElement {
	const { exit } = useApp();
	const size = useTerminalSize();

	const source = useAgentSource(paths, client);
	const data = source.data;
	const [view, setView] = useViewState(tuiStateFilePath(paths.userDataDir));
	// The user's toggle for the Agents pane. Not persisted: whether it fits depends on the window.
	const [agentsPaneOverride, setAgentsPaneOverride] = useState<boolean | undefined>(undefined);
	// Tool calls are one line each until the user asks for the detail. Not persisted.
	const [expandTools, setExpandTools] = useState(false);

	// Focus and the overlay live in refs as well as state, for the reason the cursor does.
	const [focusedPane, setFocusedPaneState] = useState<PaneId>('agents');
	const focusRef = useRef<PaneId>('agents');
	const setFocusedPane = (pane: PaneId) => {
		focusRef.current = pane;
		setFocusedPaneState(pane);
	};
	const [overlay, setOverlayState] = useState<OverlayState | undefined>(undefined);
	const overlayRef = useRef<OverlayState | undefined>(undefined);
	const setOverlay = (next: OverlayState | undefined) => {
		overlayRef.current = next;
		setOverlayState(next);
	};
	const agentsPaneOverrideRef = useRef(agentsPaneOverride);
	agentsPaneOverrideRef.current = agentsPaneOverride;
	const columnsRef = useRef(size.columns);
	columnsRef.current = size.columns;

	const rows = useMemo(
		() => buildPaneRows(data.sections, view.collapsedSections),
		[data.sections, view.collapsedSections]
	);
	// The cursor lives in a ref as well as in state: keys arrive faster than React
	// renders (a held `j`), and a handler reading only state would act on a stale
	// cursor and drop moves.
	const cursorRef = useRef(initialCursorKey(rows, view.selectedAgentId));
	const rowsRef = useRef(rows);
	rowsRef.current = rows;
	const [, setCursorKey] = useState(cursorRef.current);
	// A fold can remove the row the cursor stood on; fall back to the first row.
	const cursorRow = rows.find((row) => row.key === cursorRef.current) ?? rows[0];
	cursorRef.current = cursorRow?.key;

	const moveBy = (delta: number) => {
		cursorRef.current = moveCursor(rowsRef.current, cursorRef.current, delta);
		setCursorKey(cursorRef.current);
	};

	// Remember which agent the cursor is on. Standing on a group header leaves it as it was.
	const cursorAgentId = cursorRow?.kind === 'agent' ? cursorRow.agent.id : undefined;
	useEffect(() => {
		if (cursorAgentId === undefined) return;
		setView((current) =>
			current.selectedAgentId === cursorAgentId
				? current
				: { ...current, selectedAgentId: cursorAgentId }
		);
	}, [cursorAgentId, setView]);

	const cursorAgent = cursorRow?.kind === 'agent' ? cursorRow.agent : undefined;
	const cursorAgentRef = useRef(cursorAgent);
	cursorAgentRef.current = cursorAgent;

	const agentsVisible = isAgentsPaneVisible(size.columns, agentsPaneOverride);
	// A hidden pane cannot hold focus.
	const effectiveFocus: PaneId = agentsVisible ? focusedPane : 'conversation';

	const activeTabIdFor = (agent: typeof cursorAgent) =>
		agent
			? resolveActiveTab(visibleAiTabsOf(agent), view.activeTabByAgent[agent.id], agent)?.id
			: undefined;

	const activeTab = cursorAgent
		? resolveActiveTab(
				visibleAiTabsOf(cursorAgent),
				view.activeTabByAgent[cursorAgent.id],
				cursorAgent
			)
		: undefined;
	const activeEntries = useTabEntries(source, cursorAgent?.id, activeTab);

	useInput((input, key) => {
		const current = overlayRef.current;
		const context: KeyContext = current ? current.kind : 'main';
		const action = resolveAction(context, input, key);
		if (!action) return;

		const visible = isAgentsPaneVisible(columnsRef.current, agentsPaneOverrideRef.current);
		const focus: PaneId = visible ? focusRef.current : 'conversation';
		const agent = cursorAgentRef.current;

		switch (action) {
			case 'quit':
				exit();
				return;
			case 'help':
				setOverlay(current?.kind === 'help' ? undefined : { kind: 'help' });
				return;
			case 'closeOverlay':
				setOverlay(undefined);
				return;
			case 'nextPane':
			case 'prevPane':
				setFocusedPane(cyclePane(visiblePanes(visible), focus, action === 'nextPane' ? 1 : -1));
				return;
			case 'toggleToolCalls':
				setExpandTools((expanded) => !expanded);
				return;
			case 'toggleAgentsPane':
				setAgentsPaneOverride(!visible);
				// Showing the list is a request to use it.
				if (!visible) setFocusedPane('agents');
				return;
			case 'tabSwitcher': {
				if (!agent) return;
				const tabs = visibleAiTabsOf(agent);
				if (tabs.length === 0) return;
				const activeId = resolveActiveTab(tabs, view.activeTabByAgent[agent.id], agent)?.id;
				setOverlay({
					kind: 'tabs',
					agentId: agent.id,
					cursor: Math.max(
						0,
						tabs.findIndex((tab) => tab.id === activeId)
					),
				});
				return;
			}
			case 'history':
				if (agent) setOverlay({ kind: 'history', history: openHistory(paths, agent.id) });
				return;
			case 'moveDown':
			case 'moveUp': {
				const delta = action === 'moveDown' ? 1 : -1;
				if (current?.kind === 'history') {
					setOverlay({
						kind: 'history',
						history: moveHistoryCursor(paths, current.history, delta),
					});
				} else if (current?.kind === 'tabs') {
					const count = agent ? visibleAiTabsOf(agent).length : 0;
					setOverlay({
						...current,
						cursor: Math.min(Math.max(0, count - 1), Math.max(0, current.cursor + delta)),
					});
				} else if (focus === 'agents') {
					moveBy(delta);
				}
				return;
			}
			case 'open': {
				if (current?.kind === 'tabs') {
					const tab = agent ? visibleAiTabsOf(agent)[current.cursor] : undefined;
					if (agent && tab) {
						setView((state) => ({
							...state,
							activeTabByAgent: { ...state.activeTabByAgent, [agent.id]: tab.id },
						}));
					}
					setOverlay(undefined);
					return;
				}
				if (focus !== 'agents') return;
				const row = rowsRef.current.find((candidate) => candidate.key === cursorRef.current);
				if (row?.kind === 'agent') {
					// The Conversation pane already follows the cursor; opening moves focus into it.
					setFocusedPane('conversation');
					return;
				}
				if (row?.kind !== 'section') return;
				const { section } = row;
				setView((state) => ({
					...state,
					collapsedSections: {
						...state.collapsedSections,
						[section.key]: !isSectionCollapsed(section, state.collapsedSections),
					},
				}));
				return;
			}
		}
	});

	const renderOverlay = overlay
		? ({ width, height }: { width: number; height: number }) =>
				overlay.kind === 'help' ? (
					<HelpOverlay width={width} height={height} />
				) : overlay.kind === 'history' ? (
					cursorAgent ? (
						<HistoryView
							agent={cursorAgent}
							state={overlay.history}
							width={width}
							height={height}
						/>
					) : null
				) : cursorAgent ? (
					<TabSwitcher
						agent={cursorAgent}
						tabs={visibleAiTabsOf(cursorAgent)}
						cursor={overlay.cursor}
						activeTabId={activeTabIdFor(cursorAgent)}
						width={width}
						height={height}
					/>
				) : null
		: undefined;

	return (
		<Shell
			size={size}
			userDataDir={paths.userDataDir}
			hostLabel={source.hostLabel}
			rows={rows}
			cursorKey={cursorRow?.key}
			agent={cursorAgent}
			activeTabId={activeTabIdFor(cursorAgent)}
			entries={activeEntries}
			focusedPane={effectiveFocus}
			expandTools={expandTools}
			overlay={renderOverlay}
			agentsPaneOverride={agentsPaneOverride}
			agentsPaneWidth={view.agentsPaneWidth}
			problems={data.problems}
		/>
	);
}
