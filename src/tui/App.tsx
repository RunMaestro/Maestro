import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Text, useApp, useInput, type Key } from 'ink';
import type {
	AgentRecord,
	ClientResult,
	GroupChatRecord,
	MaestroClient,
	MaestroPaths,
} from '../shared/maestro-lib';
import {
	asThinkingMode,
	isAutoRunActive,
	isGroupChatBusy,
	visibleAiTabsOf,
} from '../shared/maestro-lib';
import { AgentForm } from './agents/AgentForm';
import {
	acceptCompletion,
	agentSshRemoteId,
	backspace as formBackspace,
	cwdCandidates,
	cycleChoice,
	defaultProviderId,
	effectiveName,
	emptyFormContext,
	groupsFromSections,
	initialFormState,
	liveAgentState,
	moveFocus,
	pressEnter,
	submitAgentForm,
	typeText,
	type FormContext,
	type FormState,
} from './agents/form';
import { useFormLookups, useProviderModels } from './agents/useFormLookups';
import {
	ConfirmOverlay,
	GroupPickerOverlay,
	PromptOverlay,
	ProviderPickerOverlay,
} from './agents/ManageOverlays';
import {
	backspacePrompt,
	deleteAgentConfirm,
	deleteGroupChatConfirm,
	deleteGroupConfirm,
	groupChoices,
	manageTargetOf,
	moveGroupCursor,
	movePromptFocus,
	newGroupPrompt,
	pickerStartIndex,
	renameAgentPrompt,
	renameGroupChatPrompt,
	renameGroupPrompt,
	renameTabPrompt,
	submitConfirm,
	submitMoveToGroup,
	submitPrompt,
	typeIntoPrompt,
	type ConfirmState,
	type PromptState,
} from './agents/manage';
import {
	loadProviderChoices,
	providerPickerStart,
	submitProviderSwap,
	type ProviderChoice,
	type ProviderSwapDone,
} from './agents/providerSwap';
import { submitCloseTab, submitNewTab, tabAfterClose } from './agents/tabs';
import { AutoRunView } from './autorun/AutoRunView';
import { resolveEditorCommand, runEditor, type EditorResult } from './autorun/editor';
import { LaunchView } from './autorun/LaunchView';
import {
	backspaceLaunch,
	cycleLaunchField,
	initialLaunchForm,
	launchFields,
	moveLaunchFocus,
	submitLaunch,
	typeIntoLaunch,
	type LaunchFormState,
} from './autorun/launchForm';
import { controlRefusal, submitRunControl, type RunControl } from './autorun/progress';
import { ProgressView } from './autorun/ProgressView';
import type { RunScreen } from './autorun/screen';
import { useAutoRunRuns, useClockNow } from './autorun/useAutoRunRuns';
import {
	backspaceName,
	beginNaming,
	cancelNaming,
	documentsToRun,
	finishAutoRunEdit,
	highlightedDocument,
	moveAutoRunCursor,
	openAutoRunView,
	reloadAutoRunView,
	submitNewDocument,
	toggleDocumentSelection,
	typeIntoName,
	type AutoRunViewState,
} from './autorun/state';
import {
	EMPTY_COMPOSER,
	applyDraftKey,
	composerFrom,
	insertNewline,
	isBlankComposer,
	type ComposerState,
} from './composer/draft';
import {
	acceptMention,
	dismissMentionPicker,
	groupsOfSections,
	initialMentionUi,
	mentionItemsFor,
	resolveMentionPicker,
	stepMentionCursor,
	type MentionPicker,
	type MentionUi,
} from './composer/mentions';
import {
	addConsult,
	consultEntries,
	delegationWarning,
	mergeByTime,
	planMentionSend,
	runConsult,
	runDelegation,
	settleConsult,
	type ConsultsByTab,
	type MentionSendPlan,
} from './composer/consults';
import { GroupChatFormView } from './groupchat/GroupChatFormView';
import { GroupChatListView } from './groupchat/GroupChatListView';
import { GroupChatView } from './groupchat/GroupChatView';
import {
	backspaceChatForm,
	cycleChatChoice,
	highlightedGroupChat,
	initialChatForm,
	liveChatOf,
	moveChatFormFocus,
	moveGroupChatCursor,
	openGroupChatList,
	pressChatFormEnter,
	stopChat,
	submitChatForm,
	submitChatMessage,
	typeIntoChatForm,
	type GroupChatListState,
	type GroupChatScreen,
} from './groupchat/state';
import { useGroupChats } from './groupchat/useGroupChats';
import { mergeLiveTurn } from './composer/liveTurn';
import { ARM_QUIT_NOTICE, decideCtrlC, interruptTurn, submitDraft } from './composer/turns';
import { useTurnStream } from './composer/useTurnStream';
import { HelpOverlay } from './app/HelpOverlay';
import { HistoryView } from './app/HistoryView';
import { moveHistoryCursor, openHistory, type HistoryViewState } from './app/history';
import { Shell } from './app/Shell';
import { TabSwitcher } from './app/TabSwitcher';
import { resolveActiveTab } from './app/ConversationPane';
import {
	buildPaneRows,
	initialCursorKey,
	isSectionCollapsed,
	locateAgent,
	moveCursor,
} from './app/agentRows';
import { useAgentSource, useTabEntries } from './app/useAgentSource';
import { useTerminalSize } from './app/useTerminalSize';
import { useViewState } from './app/useViewState';
import { cyclePane, isAgentsPaneVisible, visiblePanes, type PaneId } from './app/layout';
import { KEYMAP, resolveAction, type KeyAction, type KeyContext } from './keymap';
import { getAtMentionTrigger, type AgentMentionSuggestion } from '../shared/maestro-lib';
import { agentMenuEntries } from './palette/agentMenu';
import { AgentMenuOverlay } from './palette/AgentMenuOverlay';
import { buildPaletteEntries, type PaletteEntry } from './palette/entries';
import { PaletteOverlay } from './palette/PaletteOverlay';
import { rankPaletteEntries } from './palette/rank';
import {
	EMPTY_PALETTE,
	backspacePalette,
	isPaletteBackspace,
	movePaletteCursor,
	paletteTextFor,
	typeIntoPalette,
	type PaletteState,
} from './palette/state';
import { isBackspaceKey, typedTextFor } from './app/textInput';
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
	/** Opens a file in the person's editor and resolves when it closes. Tests pass a stand-in. */
	editFile?: (file: string) => Promise<EditorResult>;
}

/**
 * Time between drawing the "editing" frame and starting the editor. Ink throttles
 * its writes, so a frame still queued would otherwise paint over the editor.
 */
const EDITOR_SETTLE_MS = 100;

/** The overlay on screen, if any. Only one at a time, and Esc closes it. */
type OverlayState =
	| { kind: 'help'; cursor: number }
	| { kind: 'tabs'; agentId: string; cursor: number }
	| { kind: 'history'; history: HistoryViewState }
	| { kind: 'palette'; palette: PaletteState }
	| { kind: 'menu'; cursor: number }
	| { kind: 'autoRun'; view: AutoRunViewState; screen?: RunScreen }
	| { kind: 'groupChats'; list: GroupChatListState; screen?: GroupChatScreen }
	| {
			kind: 'prompt';
			prompt: PromptState;
			submitting: boolean;
			error?: string;
			/** Opened from the group chat list: finishing or leaving it goes back to that list. */
			returnToChats?: boolean;
	  }
	| {
			kind: 'confirm';
			confirm: ConfirmState;
			submitting: boolean;
			error?: string;
			returnToChats?: boolean;
	  }
	| { kind: 'groupPicker'; agentId: string; cursor: number }
	| {
			kind: 'providerPicker';
			agentId: string;
			choices: ProviderChoice[];
			cursor: number;
			submitting: boolean;
			error?: string;
			/** Set once the swap went through: the result stays up until the person closes it. */
			done?: ProviderSwapDone;
	  }
	| {
			kind: 'form';
			mode: 'create' | 'edit';
			/** The agent as the host held it when the form opened; edits are measured against it. */
			baseline?: AgentRecord;
			form: FormState;
			submitting: boolean;
	  };

export function App({ paths, client, editFile = runEditor }: AppProps): React.ReactElement {
	const { exit } = useApp();
	const size = useTerminalSize();

	const source = useAgentSource(paths, client);
	const data = source.data;
	const dataRef = useRef(data);
	dataRef.current = data;
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
	// Every run on the host, folded as it goes, so a screen opened halfway through a run is whole.
	const autoRunsByAgent = useAutoRunRuns(source.client);
	const runsRef = useRef(autoRunsByAgent);
	runsRef.current = autoRunsByAgent;
	// Every group chat on the host, folded as events arrive, so a chat opened mid-round is whole.
	const groupChatStore = useGroupChats(source.client);
	const chatsLiveRef = useRef(groupChatStore);
	chatsLiveRef.current = groupChatStore;
	const chatScreen =
		overlay?.kind === 'groupChats' && overlay.screen?.kind === 'chat' ? overlay.screen : undefined;
	const openChatRecord: GroupChatRecord | undefined =
		chatScreen && overlay?.kind === 'groupChats'
			? (groupChatStore.live[chatScreen.chatId]?.chat ??
				overlay.list.chats.find((chat) => chat.id === chatScreen.chatId))
			: undefined;
	const openChatRecordRef = useRef(openChatRecord);
	openChatRecordRef.current = openChatRecord;
	const liveChatOfListed = (listed: GroupChatRecord) =>
		liveChatOf(listed, groupChatStore.live[listed.id]?.chat);
	// What the launch form reads off the host while it is open: the agent's provider's models.
	const launchScreen =
		overlay?.kind === 'autoRun' && overlay.screen?.kind === 'launch' ? overlay.screen : undefined;
	const launchAgent = launchScreen
		? data.agents.find((candidate) => candidate.id === launchScreen.form.agentId)
		: undefined;
	const launchModels = useProviderModels(
		source.client,
		launchAgent !== undefined,
		launchAgent?.toolType ?? '',
		agentSshRemoteId(launchAgent)
	);
	const launchContextRef = useRef<{ agent: AgentRecord; models: string[] } | undefined>(undefined);
	launchContextRef.current = launchAgent ? { agent: launchAgent, models: launchModels } : undefined;
	// The run clock moves only while the progress screen shows a run that is going.
	const progressScreen =
		overlay?.kind === 'autoRun' && overlay.screen?.kind === 'progress' ? overlay.screen : undefined;
	const clockNow = useClockNow(
		progressScreen !== undefined && isAutoRunActive(autoRunsByAgent[progressScreen.agentId])
	);
	// One line of news for the status bar (read-only refusals, a saved agent). The next key clears it.
	const [notice, setNotice] = useState<string | undefined>(undefined);
	// The file open in the person's editor. While set, the App draws one fixed line and reads no keys.
	const [editing, setEditing] = useState<string | undefined>(undefined);
	const editFileRef = useRef(editFile);
	editFileRef.current = editFile;
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
	const storedEntries = useTabEntries(source, cursorAgent?.id, activeTab);
	const stream = useTurnStream(source.client, cursorAgent?.id, activeTab?.id);
	const thinkingMode = asThinkingMode(activeTab?.showThinking) ?? 'off';
	// The turn on screen is the one the stream is following; before it has seen one, the tab's own state.
	const turnRunning = stream.turn ? stream.turn.running : activeTab?.state === 'busy';
	// What the person asked other agents from this tab: answered inline, kept in memory (XM-2).
	const [consults, setConsultsState] = useState<ConsultsByTab>({});
	const consultsRef = useRef<ConsultsByTab>({});
	const updateConsults = (change: (all: ConsultsByTab) => ConsultsByTab) => {
		consultsRef.current = change(consultsRef.current);
		setConsultsState(consultsRef.current);
	};
	const consultSeqRef = useRef(0);
	const tabConsults =
		cursorAgent && activeTab ? consults[`${cursorAgent.id}:${activeTab.id}`] : undefined;
	const activeEntries = useMemo(
		() =>
			mergeByTime(
				mergeLiveTurn(storedEntries, stream.turn, thinkingMode),
				consultEntries(tabConsults ?? [])
			),
		[storedEntries, stream.turn, thinkingMode, tabConsults]
	);

	// Drafts are per tab, so switching away from a half-written message does not lose it. Held in a
	// ref as well as state for the reason the cursor is: a paste or a held key outruns React.
	const draftsRef = useRef<Record<string, ComposerState>>({});
	const [, setDraftVersion] = useState(0);
	const composerTargetRef = useRef<
		{ client: MaestroClient; agentId: string; tabId: string; key: string } | undefined
	>(undefined);
	composerTargetRef.current =
		source.client && cursorAgent && activeTab
			? {
					client: source.client,
					agentId: cursorAgent.id,
					tabId: activeTab.id,
					key: `${cursorAgent.id}:${activeTab.id}`,
				}
			: undefined;
	const turnRunningRef = useRef(turnRunning);
	turnRunningRef.current = turnRunning;
	const refreshQueueRef = useRef(stream.refreshQueue);
	refreshQueueRef.current = stream.refreshQueue;
	const lastCtrlCRef = useRef<number | undefined>(undefined);
	const composerKey = composerTargetRef.current?.key;
	const draft = composerKey ? (draftsRef.current[composerKey] ?? EMPTY_COMPOSER) : EMPTY_COMPOSER;

	const setDraft = (key: string, change: (state: ComposerState) => ComposerState) => {
		draftsRef.current = {
			...draftsRef.current,
			[key]: change(draftsRef.current[key] ?? EMPTY_COMPOSER),
		};
		setDraftVersion((version) => version + 1);
	};

	/** The composer owns the keyboard while the Conversation pane has focus and messages can be sent. */
	const composerHasKeys = (): boolean => {
		if (!composerTargetRef.current) return false;
		const visible = isAgentsPaneVisible(columnsRef.current, agentsPaneOverrideRef.current);
		return !visible || focusRef.current === 'conversation';
	};

	// The `@` agent picker is derived from the draft each time it is asked for, never stored, so a
	// paste or a held key cannot leave it describing text that is gone (XM-1). Its own state is the
	// highlighted row and the `@` Esc closed.
	const mentionUiRef = useRef<MentionUi>(initialMentionUi(''));
	const mentionItemsRef = useRef<{
		agents: unknown;
		sections: unknown;
		agentId: string;
		items: AgentMentionSuggestion[];
	}>();
	const getMentionItems = (agentId: string): AgentMentionSuggestion[] => {
		const latest = dataRef.current;
		const cached = mentionItemsRef.current;
		if (
			cached &&
			cached.agents === latest.agents &&
			cached.sections === latest.sections &&
			cached.agentId === agentId
		)
			return cached.items;
		const items = mentionItemsFor(latest.agents, latest.sections, agentId);
		mentionItemsRef.current = {
			agents: latest.agents,
			sections: latest.sections,
			agentId,
			items,
		};
		return items;
	};
	const mentionUiFor = (key: string): MentionUi =>
		mentionUiRef.current.key === key ? mentionUiRef.current : initialMentionUi(key);
	const setMentionUi = (next: MentionUi) => {
		mentionUiRef.current = next;
		setDraftVersion((version) => version + 1);
	};
	const currentMentionPicker = (): MentionPicker | undefined => {
		const target = composerTargetRef.current;
		if (!target || !composerHasKeys()) return undefined;
		const current = draftsRef.current[target.key] ?? EMPTY_COMPOSER;
		// Most drafts carry no `@`: skip building the roster for them.
		if (!current.text.includes('@')) return undefined;
		return resolveMentionPicker(current, getMentionItems(target.agentId), mentionUiFor(target.key));
	};
	const mentionPicker = composerKey ? currentMentionPicker() : undefined;

	// A delegation hands another agent work it can act on, so it takes two presses: the first says
	// what it grants and arms, the second (same draft) sends (XM-3).
	const delegationArmRef = useRef<{ key: string; text: string; warning: string } | undefined>(
		undefined
	);
	const delegationWarningNow =
		composerKey && delegationArmRef.current?.key === composerKey
			? delegationArmRef.current.warning
			: undefined;

	const paletteEntries = useMemo(() => buildPaletteEntries(data.agents), [data.agents]);
	const paletteEntriesRef = useRef(paletteEntries);
	paletteEntriesRef.current = paletteEntries;
	const menuEntries = useMemo(() => agentMenuEntries(), []);

	// The agent form: what the host reports while it is open, and the context the form rules read.
	const formOverlay = overlay?.kind === 'form' ? overlay : undefined;
	const lookups = useFormLookups(
		source.client,
		formOverlay !== undefined,
		formOverlay?.form.values.provider ?? '',
		formOverlay?.form.values.ssh ?? ''
	);
	const formContext: FormContext | undefined = formOverlay
		? {
				mode: formOverlay.mode,
				// Values come from the snapshot the form opened on; only the live state decides whether a move is blocked.
				agent: formOverlay.baseline
					? {
							...formOverlay.baseline,
							...liveAgentState(data.agents.find((a) => a.id === formOverlay.baseline?.id)),
						}
					: undefined,
				agents: data.agents,
				groups: groupsFromSections(data.sections),
				providers: lookups.providers,
				sshRemotes: lookups.sshRemotes,
				models: lookups.models,
			}
		: undefined;
	const formContextRef = useRef(formContext);
	formContextRef.current = formContext;

	const updateForm = (change: (form: FormState) => FormState) => {
		const current = overlayRef.current;
		if (current?.kind === 'form') setOverlay({ ...current, form: change(current.form) });
	};

	// A new agent starts on the best installed provider, once the host has said which are installed.
	const formProvider = formOverlay?.form.values.provider;
	const formMode = formOverlay?.mode;
	useEffect(() => {
		if (formMode !== 'create' || formProvider !== '') return;
		const id = defaultProviderId({ providers: lookups.providers });
		if (id) {
			updateForm((form) => ({ ...form, values: { ...form.values, provider: id } }));
		}
	}, [formMode, formProvider, lookups.providers]);

	// After a create, the Agents cursor goes to the new agent once the host's event brings it in.
	// A move waits for the host to show the agent in its new group (`groupId`, null for ungrouped),
	// or the cursor would land on the old row a moment before it disappears.
	const pendingRevealRef = useRef<{ agentId: string; groupId?: string | null } | undefined>(
		undefined
	);
	useEffect(() => {
		const pending = pendingRevealRef.current;
		if (!pending) return;
		if (pending.groupId !== undefined) {
			const landed = data.agents.find((a) => a.id === pending.agentId);
			if (!landed || (landed.groupId ?? null) !== pending.groupId) return;
		}
		if (revealAgent(pending.agentId)) pendingRevealRef.current = undefined;
	}, [data.sections]);

	/** Puts the Agents cursor on an agent, unfolding the section it hides in. */
	const revealAgent = (agentId: string): boolean => {
		const found = locateAgent(data.sections, rowsRef.current, agentId);
		if (!found) return false;
		const { unfoldSectionKey } = found;
		if (unfoldSectionKey !== undefined) {
			setView((state) => ({
				...state,
				collapsedSections: { ...state.collapsedSections, [unfoldSectionKey]: false },
			}));
		}
		cursorRef.current = found.cursorKey;
		setCursorKey(found.cursorKey);
		return true;
	};

	const runPaletteEntry = (entry: PaletteEntry) => {
		setOverlay(undefined);
		const { target } = entry;
		switch (target.kind) {
			case 'action':
				// The overlay is gone, so the action runs as it would from the main view.
				runAction(target.action, undefined);
				return;
			case 'agent':
				// Like Enter on the row: the conversation follows the cursor and takes focus.
				if (revealAgent(target.agentId)) setFocusedPane('conversation');
				return;
			case 'tab': {
				if (!revealAgent(target.agentId)) return;
				setView((state) => ({
					...state,
					activeTabByAgent: { ...state.activeTabByAgent, [target.agentId]: target.tabId },
				}));
				setFocusedPane('conversation');
				return;
			}
		}
	};

	/** The form is a client feature: without a desktop attached the TUI is read-only. */
	const openForm = async (mode: 'create' | 'edit', agentId?: string) => {
		const client = source.client;
		if (!client) {
			setNotice('No desktop attached: the TUI is read-only until one is running.');
			return;
		}
		if (mode === 'create') {
			setOverlay({
				kind: 'form',
				mode,
				form: initialFormState(emptyFormContext('create')),
				submitting: false,
			});
			return;
		}
		if (!agentId) return;
		// Read fresh: the form opens on the host's values, not on a copy that may be a poll old.
		const fresh = await client.agents.get(agentId);
		const baseline = fresh.ok ? fresh.value : dataRef.current.agents.find((a) => a.id === agentId);
		if (!baseline) {
			setNotice(fresh.ok ? 'That agent is gone.' : fresh.error.message);
			return;
		}
		setOverlay({
			kind: 'form',
			mode,
			baseline,
			form: initialFormState({ ...emptyFormContext('edit'), agent: baseline }),
			submitting: false,
		});
	};

	const submitForm = async () => {
		const current = overlayRef.current;
		const ctx = formContextRef.current;
		const client = source.client;
		if (current?.kind !== 'form' || current.submitting || !ctx || !client) return;
		// Named before the save: afterwards the new agent is in the list, and a folder default would collide with it.
		const name = effectiveName(ctx, current.form);
		setOverlay({ ...current, submitting: true });
		const result = await submitAgentForm(client, ctx, current.form);
		const latest = overlayRef.current;
		// Esc while the save was in flight: the host still got it, but there is no form to report to.
		if (latest?.kind !== 'form') return;
		if (!result.ok) {
			setOverlay({
				...latest,
				submitting: false,
				form: { ...latest.form, error: result.error.message },
			});
			return;
		}
		if (ctx.mode === 'create') pendingRevealRef.current = { agentId: result.value.agentId };
		setOverlay(undefined);
		setNotice(`${ctx.mode === 'create' ? 'Created' : 'Saved'} ${name}.`);
	};

	/** Agent and group changes go through the client: without a desktop attached the TUI is read-only. */
	const requireClient = (): MaestroClient | undefined => {
		if (!source.client)
			setNotice('No desktop attached: the TUI is read-only until one is running.');
		return source.client;
	};

	const cursorTarget = () =>
		manageTargetOf(rowsRef.current.find((row) => row.key === cursorRef.current));

	/**
	 * Sends what a prompt or a confirmation holds. A refusal stays on the overlay
	 * with its reason; success closes it and leaves one line for the status bar.
	 */
	const settleOverlay = async (
		kind: 'prompt' | 'confirm',
		send: (client: MaestroClient) => Promise<ClientResult<string>>
	) => {
		const current = overlayRef.current;
		const client = source.client;
		if (current?.kind !== kind || current.submitting || !client) return;
		setOverlay({ ...current, submitting: true, error: undefined } as OverlayState);
		const result = await send(client);
		const latest = overlayRef.current;
		const stillOpen = latest?.kind === kind;
		if (!result.ok) {
			// Esc while the call was in flight: the host still got it, but there is no overlay to report to.
			if (stillOpen) {
				setOverlay({ ...latest, submitting: false, error: result.error.message } as OverlayState);
			} else {
				setNotice(result.error.message);
			}
			return;
		}
		if (stillOpen && (latest as { returnToChats?: boolean }).returnToChats) {
			// Opened from the group chat list: go back to it, with the answer under it.
			void openGroupChats({ message: result.value });
			return;
		}
		if (stillOpen) setOverlay(undefined);
		setNotice(result.value);
	};

	const submitPromptOverlay = () => {
		const current = overlayRef.current;
		if (current?.kind === 'prompt') {
			void settleOverlay('prompt', (client) => submitPrompt(client, current.prompt));
		}
	};

	const submitConfirmOverlay = () => {
		const current = overlayRef.current;
		if (current?.kind === 'confirm') {
			const { confirm } = current;
			void settleOverlay('confirm', async (client) => {
				const result = await submitConfirm(client, confirm);
				if (result.ok && confirm.kind === 'deleteGroupChat') {
					chatsLiveRef.current.drop(confirm.chatId);
				}
				return result;
			});
		}
	};

	const submitGroupPicker = async (current: Extract<OverlayState, { kind: 'groupPicker' }>) => {
		const client = source.client;
		const agent = dataRef.current.agents.find((candidate) => candidate.id === current.agentId);
		setOverlay(undefined);
		if (!client || !agent) return;
		const choices = groupChoices(groupsFromSections(dataRef.current.sections));
		const target = choices[current.cursor];
		if (target && target.groupId !== (agent.groupId ?? null)) {
			pendingRevealRef.current = { agentId: agent.id, groupId: target.groupId };
		}
		const result = await submitMoveToGroup(client, agent, choices, current.cursor);
		if (!result.ok) pendingRevealRef.current = undefined;
		setNotice(result.ok ? result.value : result.error.message);
	};

	/** Asks the host which providers are installed where the agent runs, then opens the picker on them. */
	const openProviderPicker = async (agent: AgentRecord) => {
		const client = requireClient();
		if (!client) return;
		const loaded = await loadProviderChoices(client, agent);
		if (!loaded.ok) {
			setNotice(loaded.error.message);
			return;
		}
		setOverlay({
			kind: 'providerPicker',
			agentId: agent.id,
			choices: loaded.value,
			cursor: providerPickerStart(loaded.value),
			submitting: false,
		});
	};

	const submitProviderPicker = async (
		current: Extract<OverlayState, { kind: 'providerPicker' }>
	) => {
		const client = source.client;
		const agent = dataRef.current.agents.find((candidate) => candidate.id === current.agentId);
		if (current.done) {
			setOverlay(undefined);
			return;
		}
		if (!client || !agent || current.submitting || current.choices.length === 0) return;
		setOverlay({ ...current, submitting: true, error: undefined });
		const result = await submitProviderSwap(client, agent, current.choices, current.cursor);
		const latest = overlayRef.current;
		// Esc while the swap was in flight: the host still got it, so say so where the person will see it.
		const stillOpen = latest?.kind === 'providerPicker';
		if (!result.ok) {
			if (stillOpen) setOverlay({ ...latest, submitting: false, error: result.error.message });
			else setNotice(result.error.message);
			return;
		}
		if (stillOpen) setOverlay({ ...latest, submitting: false, done: result.value });
		else setNotice(result.value.summary);
	};

	const agentById = (id: string) => dataRef.current.agents.find((candidate) => candidate.id === id);

	const openAutoRun = (agent: AgentRecord, naming = false) =>
		setOverlay({ kind: 'autoRun', view: openAutoRunView(paths, agent, { naming }) });

	/** The list the Auto Run screens sit over: the one already open for this agent, else a fresh read. */
	const autoRunListFor = (agent: AgentRecord, current: OverlayState | undefined) =>
		current?.kind === 'autoRun' && current.view.agentId === agent.id
			? current.view
			: openAutoRunView(paths, agent);

	/** Opens the form that configures a run: the picked documents, or a goal. */
	const openLaunch = (
		agent: AgentRecord,
		mode: 'spec' | 'goal',
		current: OverlayState | undefined
	) => {
		if (!requireClient()) return;
		const view = autoRunListFor(agent, current);
		const documents = mode === 'spec' ? documentsToRun(view) : [];
		if (mode === 'spec' && documents.length === 0) {
			setOverlay({ kind: 'autoRun', view });
			setNotice(view.problem ?? 'No document to run. Press n to create one.');
			return;
		}
		setOverlay({
			kind: 'autoRun',
			view,
			screen: {
				kind: 'launch',
				form: initialLaunchForm(mode, agent, documents),
				submitting: false,
			},
		});
	};

	/** Opens the progress of the agent's run. */
	const openProgress = (agent: AgentRecord, current: OverlayState | undefined) => {
		if (!requireClient()) return;
		setOverlay({
			kind: 'autoRun',
			view: autoRunListFor(agent, current),
			screen: { kind: 'progress', agentId: agent.id },
		});
	};

	const updateLaunch = (change: (form: LaunchFormState) => LaunchFormState) => {
		const latest = overlayRef.current;
		if (latest?.kind !== 'autoRun' || latest.screen?.kind !== 'launch') return;
		setOverlay({
			...latest,
			screen: { ...latest.screen, form: change(latest.screen.form), error: undefined },
		});
	};

	/** The fields of the open launch form, which depend on the agent's provider and its models. */
	const launchFieldsNow = (form: LaunchFormState) => {
		const context = launchContextRef.current;
		return context ? launchFields(form, context.agent, { models: context.models }) : [];
	};

	const submitLaunchScreen = async () => {
		const client = source.client;
		const current = overlayRef.current;
		if (!client || current?.kind !== 'autoRun' || current.screen?.kind !== 'launch') return;
		const { screen } = current;
		const agent = dataRef.current.agents.find((candidate) => candidate.id === screen.form.agentId);
		if (!agent || screen.submitting) return;
		setOverlay({ ...current, screen: { ...screen, submitting: true, error: undefined } });
		const result = await submitLaunch(client, agent, screen.form);
		const latest = overlayRef.current;
		// Esc while the host was answering: the run may still have started, so say so where the person will see it.
		const form =
			latest?.kind === 'autoRun' && latest.screen?.kind === 'launch' ? latest : undefined;
		if (!result.ok) {
			if (form?.screen?.kind === 'launch') {
				setOverlay({
					...form,
					screen: { ...form.screen, submitting: false, error: result.error.message },
				});
			} else setNotice(result.error.message);
			return;
		}
		if (form) {
			setOverlay({
				...form,
				screen: { kind: 'progress', agentId: agent.id, message: result.value.message },
			});
		} else setNotice(result.value.message);
	};

	/** Sends one control to the window that owns the run, and shows the answer on the progress screen. */
	const runProgressControl = async (control: RunControl) => {
		const client = source.client;
		const current = overlayRef.current;
		if (!client || current?.kind !== 'autoRun' || current.screen?.kind !== 'progress') return;
		const { screen } = current;
		const agent = dataRef.current.agents.find((candidate) => candidate.id === screen.agentId);
		if (!agent || screen.busy) return;
		const refusal = controlRefusal(runsRef.current[agent.id], control);
		if (refusal) {
			setOverlay({ ...current, screen: { ...screen, message: undefined, error: refusal } });
			return;
		}
		setOverlay({
			...current,
			screen: { ...screen, busy: `Sending ${control}`, message: undefined, error: undefined },
		});
		const result = await submitRunControl(client, agent, control);
		const latest = overlayRef.current;
		const progress =
			latest?.kind === 'autoRun' && latest.screen?.kind === 'progress' ? latest : undefined;
		if (!progress || progress.screen?.kind !== 'progress') {
			setNotice(result.ok ? result.value : result.error.message);
			return;
		}
		setOverlay({
			...progress,
			screen: {
				...progress.screen,
				busy: undefined,
				message: result.ok ? result.value : undefined,
				error: result.ok ? undefined : result.error.message,
			},
		});
	};

	/**
	 * Reads the chats off the host and shows the list. `creating` puts the create form up over it,
	 * `cursorOn` keeps the cursor on a chat across a reload, and `message` is the line the list opens with.
	 */
	const openGroupChats = async (
		options: { creating?: boolean; cursorOn?: string; message?: string } = {}
	) => {
		const client = requireClient();
		if (!client) return;
		const listed = await client.groupChats.list();
		if (!listed.ok) {
			setNotice(listed.error.message);
			return;
		}
		setOverlay({
			kind: 'groupChats',
			list: openGroupChatList(listed.value, options),
			...(options.creating
				? { screen: { kind: 'create', form: initialChatForm(), submitting: false } as const }
				: {}),
		});
	};

	/** Reads one chat fresh and folds it into the live store, so events that landed during the read are kept. */
	const readChat = async (client: MaestroClient, chatId: string) => {
		const readAt = Date.now();
		const read = await client.groupChats.get(chatId);
		if (read.ok) chatsLiveRef.current.seed(read.value, readAt);
		return read;
	};

	/** Opens a chat. `refreshList` re-reads the list too: a chat that was just created is not in the one held. */
	const openChat = async (chatId: string, refreshList = false) => {
		const client = requireClient();
		if (!client) return;
		const [read, listed] = await Promise.all([
			readChat(client, chatId),
			refreshList ? client.groupChats.list() : Promise.resolve(undefined),
		]);
		if (!read.ok) {
			setNotice(read.error.message);
			return;
		}
		const held = overlayRef.current;
		const list =
			listed?.ok === true
				? openGroupChatList(listed.value, { cursorOn: chatId })
				: held?.kind === 'groupChats'
					? held.list
					: openGroupChatList([read.value], { cursorOn: chatId });
		setOverlay({
			kind: 'groupChats',
			list,
			screen: { kind: 'chat', chatId, draft: EMPTY_COMPOSER },
		});
	};

	// A connection that could not resume missed pushes: read the open chat again.
	const openChatId = chatScreen?.chatId;
	const openChatStale = openChatId ? groupChatStore.live[openChatId]?.stale === true : false;
	useEffect(() => {
		const client = source.client;
		if (!openChatStale || !openChatId || !client) return;
		void readChat(client, openChatId).then((read) => {
			if (!read.ok) setNotice(read.error.message);
		});
	}, [openChatStale, openChatId]);

	/** Changes the open chat screen. Does nothing when the person has left it for another chat or none. */
	const updateChatScreen = (
		chatId: string,
		change: (screen: Extract<GroupChatScreen, { kind: 'chat' }>) => GroupChatScreen
	) => {
		const latest = overlayRef.current;
		if (
			latest?.kind !== 'groupChats' ||
			latest.screen?.kind !== 'chat' ||
			latest.screen.chatId !== chatId
		) {
			return;
		}
		setOverlay({ ...latest, screen: change(latest.screen) });
	};

	const updateChatForm = (
		change: (form: ReturnType<typeof initialChatForm>) => ReturnType<typeof initialChatForm>
	) => {
		const latest = overlayRef.current;
		if (latest?.kind !== 'groupChats' || latest.screen?.kind !== 'create') return;
		setOverlay({ ...latest, screen: { ...latest.screen, form: change(latest.screen.form) } });
	};

	const submitChatCreate = async () => {
		const client = source.client;
		const current = overlayRef.current;
		if (!client || current?.kind !== 'groupChats' || current.screen?.kind !== 'create') return;
		const { screen } = current;
		if (screen.submitting) return;
		setOverlay({
			...current,
			screen: { ...screen, submitting: true, form: { ...screen.form, error: undefined } },
		});
		const result = await submitChatForm(client, screen.form);
		const latest = overlayRef.current;
		const form =
			latest?.kind === 'groupChats' && latest.screen?.kind === 'create' ? latest : undefined;
		if (!result.ok) {
			// Esc while the host was answering: the chat may exist, so say so where the person will see it.
			if (form?.screen?.kind === 'create') {
				setOverlay({
					...form,
					screen: {
						...form.screen,
						submitting: false,
						form: { ...form.screen.form, error: result.error.message },
					},
				});
			} else setNotice(result.error.message);
			return;
		}
		if (form) await openChat(result.value.chatId, true);
		else setNotice(`Created group chat ${screen.form.name.trim()}.`);
	};

	/** Sends the open chat's draft. Cleared at once so a second Enter cannot send it twice; a refusal puts it back. */
	const sendChatDraft = async () => {
		const client = source.client;
		const current = overlayRef.current;
		const chat = openChatRecordRef.current;
		if (!client || !chat || current?.kind !== 'groupChats' || current.screen?.kind !== 'chat') {
			return;
		}
		const draft = current.screen.draft;
		if (isBlankComposer(draft)) return;
		if (isGroupChatBusy(chat)) {
			updateChatScreen(chat.id, (screen) => ({
				...screen,
				message: undefined,
				error: 'The chat is working. Wait for the round to end, or stop it, then send.',
			}));
			return;
		}
		updateChatScreen(chat.id, (screen) => ({
			...screen,
			draft: EMPTY_COMPOSER,
			error: undefined,
			message: undefined,
		}));
		const outcome = await submitChatMessage(client, chat, draft);
		if (outcome.status === 'failed' || outcome.status === 'busy') {
			// Back in the box, unless the person has started something new in the meantime.
			updateChatScreen(chat.id, (screen) => ({
				...screen,
				draft: screen.draft.text === '' ? draft : screen.draft,
				error: outcome.message,
			}));
		}
	};

	/** GC-3: stops the open chat's moderator and participants, and shows the answer under the log. */
	const stopOpenChat = async () => {
		const client = source.client;
		const chat = openChatRecordRef.current;
		const current = overlayRef.current;
		if (!client || !chat || current?.kind !== 'groupChats' || current.screen?.kind !== 'chat') {
			return;
		}
		updateChatScreen(chat.id, (screen) => ({
			...screen,
			busy: 'Stopping...',
			message: undefined,
			error: undefined,
		}));
		const result = await stopChat(client, chat);
		updateChatScreen(chat.id, (screen) => ({
			...screen,
			busy: undefined,
			message: result.ok ? result.value : undefined,
			error: result.ok ? undefined : result.error.message,
		}));
	};

	/** Enter in the name box writes the template and opens it; Enter on a row opens that document. */
	const openAutoRunDocument = (current: Extract<OverlayState, { kind: 'autoRun' }>) => {
		if (current.view.naming) {
			const outcome = submitNewDocument(current.view);
			setOverlay({ ...current, view: outcome.view });
			if (outcome.edit) setEditing(outcome.edit);
			return;
		}
		const document = highlightedDocument(current.view);
		if (document) setEditing(document.file);
		else setNotice('No document to edit. Press n to create one.');
	};

	/** The tab a tab action means: the highlighted one in the tab switcher, else the one on screen. */
	const tabTarget = (current: OverlayState | undefined) => {
		const owner = cursorAgentRef.current;
		if (!owner) return undefined;
		const tabs = visibleAiTabsOf(owner);
		const tab =
			current?.kind === 'tabs'
				? tabs[current.cursor]
				: resolveActiveTab(tabs, view.activeTabByAgent[owner.id], owner);
		return tab ? { agent: owner, tab, tabs } : undefined;
	};

	/** Shows a tab in the Conversation pane. TUI-local: the desktop's own active tab stays put (CO-4). */
	const showTab = (agentId: string, tabId: string) =>
		setView((state) => ({
			...state,
			activeTabByAgent: { ...state.activeTabByAgent, [agentId]: tabId },
		}));

	const createTab = async (client: MaestroClient, owner: AgentRecord) => {
		const result = await submitNewTab(client, owner);
		if (!result.ok) {
			setNotice(result.error.message);
			return;
		}
		showTab(owner.id, result.value.tabId);
		setNotice(result.value.notice);
	};

	const closeTab = async (
		client: MaestroClient,
		target: NonNullable<ReturnType<typeof tabTarget>>,
		switcherCursor: number | undefined
	) => {
		const { agent: owner, tab, tabs } = target;
		const wasShown = tab.id === activeTabIdFor(owner);
		const next = tabAfterClose(tabs, tab.id);
		const result = await submitCloseTab(client, owner, tab);
		if (!result.ok) {
			setNotice(result.error.message);
			return;
		}
		if (wasShown && next) showTab(owner.id, next.id);
		// The switcher stays open for more closes; keep its cursor on a row that exists.
		const latest = overlayRef.current;
		if (switcherCursor !== undefined && latest?.kind === 'tabs') {
			setOverlay({ ...latest, cursor: Math.max(0, Math.min(switcherCursor, tabs.length - 2)) });
		}
		setNotice(result.value);
	};

	/**
	 * Asks every agent the message names, in the background on each, and shows the answers inline
	 * under the consulted agent's name. `message` is set when the person's own line is not already in
	 * the transcript (a message only the consulted agents receive).
	 */
	const startConsults = (
		target: NonNullable<typeof composerTargetRef.current>,
		plan: MentionSendPlan,
		message: string | undefined
	) => {
		const at = Date.now();
		for (const consulted of plan.targets) {
			consultSeqRef.current += 1;
			const id = `consult-${consultSeqRef.current}`;
			updateConsults((all) =>
				addConsult(all, target.key, {
					id,
					agentId: consulted.id,
					agentName: consulted.name,
					status: 'asking',
					text: '',
					at,
					message,
				})
			);
			void runConsult(
				target.client,
				{ agentId: target.agentId, tabId: target.tabId },
				consulted,
				plan.question
			).then((settled) => updateConsults((all) => settleConsult(all, target.key, id, settled)));
		}
	};

	/** What a draft's mentions mean here, or undefined when it names no other agent. */
	const mentionPlanOf = (text: string, agentId: string): MentionSendPlan | undefined =>
		planMentionSend(
			text,
			dataRef.current.agents,
			groupsOfSections(dataRef.current.sections),
			agentId
		);

	/** Sends the open tab's draft. Cleared at once so a second Enter cannot send it twice; a refusal puts it back. */
	const sendDraft = async () => {
		const target = composerTargetRef.current;
		if (!target) {
			if (requireClient()) setNotice('Select an agent with a tab to send a message.');
			return;
		}
		const text = draftsRef.current[target.key] ?? EMPTY_COMPOSER;
		if (isBlankComposer(text)) return;
		// `@agent` in the message consults that agent (XM-2): read-only, in the background, answered inline.
		const plan = mentionPlanOf(text.text, target.agentId);
		if (plan && plan.question === '') {
			setNotice(`Say what to ask ${plan.targets.map((consulted) => consulted.name).join(', ')}.`);
			return;
		}
		setDraft(target.key, () => EMPTY_COMPOSER);
		if (plan?.suppressLocal) {
			// Addressed only to the consulted agents: this agent does not get the message.
			startConsults(target, plan, text.text.trimEnd());
			return;
		}
		const outcome = await submitDraft(
			target.client,
			target.agentId,
			target.tabId,
			// This agent gets the message with each consulted name quoted, so the desktop does not consult them again.
			plan ? composerFrom(plan.localText) : text
		);
		if (outcome.status === 'failed') {
			// Back in the box, unless the person has started something new in the meantime.
			setDraft(target.key, (now) => (now.text === '' ? text : now));
			setNotice(outcome.message);
			return;
		}
		if (plan) startConsults(target, plan, undefined);
		if (outcome.status === 'sent' && outcome.queued) {
			setNotice(outcome.notice);
			refreshQueueRef.current();
		}
	};

	/** Ctrl-D: hand the message to the mentioned agents as work. The first press says what that grants. */
	const delegateDraft = async () => {
		const target = composerTargetRef.current;
		if (!target) {
			requireClient();
			return;
		}
		const text = draftsRef.current[target.key] ?? EMPTY_COMPOSER;
		const plan = isBlankComposer(text) ? undefined : mentionPlanOf(text.text, target.agentId);
		if (!plan) {
			setNotice('Write a message that names an agent with @ to delegate it.');
			return;
		}
		if (plan.question === '') {
			setNotice('Say what the agent should do.');
			return;
		}
		const armed = delegationArmRef.current;
		if (!armed || armed.key !== target.key || armed.text !== text.text) {
			const warning = delegationWarning(plan.targets);
			delegationArmRef.current = { key: target.key, text: text.text, warning };
			setNotice(warning);
			setDraftVersion((version) => version + 1);
			return;
		}
		delegationArmRef.current = undefined;
		setDraft(target.key, () => EMPTY_COMPOSER);
		const sourceName =
			dataRef.current.agents.find((a) => a.id === target.agentId)?.name ?? 'an agent';
		const at = Date.now();
		for (const delegate of plan.targets) {
			consultSeqRef.current += 1;
			const id = `consult-${consultSeqRef.current}`;
			updateConsults((all) =>
				addConsult(all, target.key, {
					id,
					agentId: delegate.id,
					agentName: delegate.name,
					status: 'asking',
					text: '',
					at,
					message: text.text.trimEnd(),
				})
			);
			void runDelegation(target.client, sourceName, delegate, plan.question).then((settled) =>
				updateConsults((all) => settleConsult(all, target.key, id, settled))
			);
		}
	};

	/**
	 * Stops the shown tab's running turn. From the `Ctrl-C` key it also arms the
	 * quit window: a second press within a second quits, running turn or not.
	 */
	const interrupt = async (viaKey: boolean) => {
		const now = Date.now();
		// On an open group chat the turn in question is the chat's round, not the agent behind it.
		const inChat =
			overlayRef.current?.kind === 'groupChats' && overlayRef.current.screen?.kind === 'chat';
		const chatRunning =
			inChat &&
			openChatRecordRef.current !== undefined &&
			isGroupChatBusy(openChatRecordRef.current);
		const decision = viaKey
			? decideCtrlC({
					now,
					lastAt: lastCtrlCRef.current,
					running: inChat ? chatRunning : turnRunningRef.current,
				})
			: 'interrupt';
		if (decision === 'quit') {
			exit();
			return;
		}
		if (viaKey) lastCtrlCRef.current = now;
		if (decision === 'arm-quit') {
			setNotice(ARM_QUIT_NOTICE);
			return;
		}
		if (inChat) {
			await stopOpenChat();
			return;
		}
		const target = composerTargetRef.current;
		if (!target) {
			requireClient();
			return;
		}
		const result = await interruptTurn(target.client, target.agentId, target.tabId);
		setNotice(result.ok ? result.value : result.error.message);
	};

	/** Keys no binding claimed, while the composer owns the keyboard: editing the draft. */
	const editComposer = (input: string, key: Key) => {
		const target = composerTargetRef.current;
		if (!target) return;
		setDraft(target.key, (state) => {
			const next = applyDraftKey(state, input, key);
			// Esc closed the picker for one `@`; once that `@` is gone, the next one opens it again.
			if (
				mentionUiRef.current.dismissedAt !== undefined &&
				!getAtMentionTrigger(next.text, next.cursor)
			) {
				mentionUiRef.current = initialMentionUi(target.key);
			}
			return next;
		});
	};

	const runAction = (action: KeyAction, current: OverlayState | undefined, viaKey = false) => {
		const visible = isAgentsPaneVisible(columnsRef.current, agentsPaneOverrideRef.current);
		const focus: PaneId = visible ? focusRef.current : 'conversation';
		const agent = cursorAgentRef.current;

		switch (action) {
			case 'quit':
				exit();
				return;
			case 'send':
				void sendDraft();
				return;
			case 'acceptMention': {
				const target = composerTargetRef.current;
				const picker = currentMentionPicker();
				if (!target || !picker) return;
				setDraft(target.key, (state) => acceptMention(state, picker));
				setMentionUi(initialMentionUi(target.key));
				return;
			}
			case 'dismissMention': {
				const picker = currentMentionPicker();
				const target = composerTargetRef.current;
				if (picker && target) setMentionUi(dismissMentionPicker(mentionUiFor(target.key), picker));
				return;
			}
			case 'delegate':
				void delegateDraft();
				return;
			case 'newline': {
				const target = composerTargetRef.current;
				if (target) setDraft(target.key, insertNewline);
				return;
			}
			case 'interrupt':
				void interrupt(viaKey);
				return;
			case 'blurComposer':
				// With the Agents pane hidden there is nowhere else for focus to go.
				if (visible) setFocusedPane('agents');
				return;
			case 'help':
				setOverlay(current?.kind === 'help' ? undefined : { kind: 'help', cursor: 0 });
				return;
			case 'palette':
				setOverlay(
					current?.kind === 'palette' ? undefined : { kind: 'palette', palette: EMPTY_PALETTE }
				);
				return;
			case 'agentMenu':
				if (agent) setOverlay({ kind: 'menu', cursor: 0 });
				return;
			case 'newAgent':
				openForm('create');
				return;
			case 'editAgent':
				if (agent) void openForm('edit', agent.id);
				return;
			case 'submitForm':
				if (current?.kind === 'groupChats') void submitChatCreate();
				else void submitForm();
				return;
			case 'newTab': {
				const client = requireClient();
				if (!client || !agent) return;
				if (current?.kind === 'tabs') setOverlay(undefined);
				void createTab(client, agent);
				return;
			}
			case 'renameTab': {
				if (!requireClient()) return;
				const target = tabTarget(current);
				if (!target) {
					setNotice('This agent has no tab to rename.');
					return;
				}
				setOverlay({
					kind: 'prompt',
					prompt: renameTabPrompt(target.agent, target.tab),
					submitting: false,
				});
				return;
			}
			case 'closeTab': {
				const client = requireClient();
				if (!client) return;
				const target = tabTarget(current);
				if (!target) {
					setNotice('This agent has no tab to close.');
					return;
				}
				void closeTab(client, target, current?.kind === 'tabs' ? current.cursor : undefined);
				return;
			}
			case 'newGroup':
				if (requireClient()) {
					setOverlay({ kind: 'prompt', prompt: newGroupPrompt(), submitting: false });
				}
				return;
			case 'rename': {
				if (!requireClient()) return;
				const target = cursorTarget();
				if (target.kind === 'none') {
					setNotice(target.reason);
					return;
				}
				setOverlay({
					kind: 'prompt',
					prompt:
						target.kind === 'agent' ? renameAgentPrompt(target.agent) : renameGroupPrompt(target),
					submitting: false,
				});
				return;
			}
			case 'deleteItem': {
				if (!requireClient()) return;
				const target = cursorTarget();
				if (target.kind === 'none') {
					setNotice(target.reason);
					return;
				}
				setOverlay({
					kind: 'confirm',
					confirm:
						target.kind === 'agent' ? deleteAgentConfirm(target.agent) : deleteGroupConfirm(target),
					submitting: false,
				});
				return;
			}
			case 'moveToGroup': {
				if (!requireClient()) return;
				const target = cursorTarget();
				if (target.kind !== 'agent') {
					setNotice('Select an agent to move.');
					return;
				}
				const choices = groupChoices(groupsFromSections(data.sections));
				setOverlay({
					kind: 'groupPicker',
					agentId: target.agent.id,
					cursor: pickerStartIndex(choices, target.agent),
				});
				return;
			}
			case 'switchProvider': {
				if (!requireClient()) return;
				const target = cursorTarget();
				if (target.kind !== 'agent') {
					setNotice('Select an agent to change its provider.');
					return;
				}
				void openProviderPicker(target.agent);
				return;
			}
			case 'autoRun':
				if (agent) openAutoRun(agent);
				else setNotice('Select an agent to see its Auto Run documents.');
				return;
			case 'newDocument':
				// From the palette or the menu there is no list yet: open it, with the name box up.
				if (current?.kind === 'autoRun') {
					if (current.view.canCreate) setOverlay({ ...current, view: beginNaming(current.view) });
					else setNotice('A document cannot be created for this agent here.');
				} else if (agent) openAutoRun(agent, true);
				else setNotice('Select an agent to create an Auto Run document.');
				return;
			case 'reloadDocuments':
				if (current?.kind === 'autoRun') {
					setOverlay({ ...current, view: reloadAutoRunView(current.view) });
				} else if (agent) openAutoRun(agent);
				return;
			case 'toggleDocument':
				if (current?.kind === 'autoRun') {
					setOverlay({ ...current, view: toggleDocumentSelection(current.view) });
				} else if (agent) openAutoRun(agent);
				return;
			case 'startRun':
			case 'startGoalRun': {
				const owner = current?.kind === 'autoRun' ? agentById(current.view.agentId) : agent;
				if (!owner) {
					setNotice('Select an agent to start an Auto Run.');
					return;
				}
				openLaunch(owner, action === 'startRun' ? 'spec' : 'goal', current);
				return;
			}
			case 'watchRun':
			case 'stopRun':
			case 'resumeRun':
			case 'skipDocument':
			case 'abortRun': {
				// A control means something only on the progress screen; from anywhere else it opens that screen.
				if (current?.kind === 'autoRun' && current.screen?.kind === 'progress') {
					if (action === 'stopRun') void runProgressControl('stop');
					else if (action === 'resumeRun') void runProgressControl('resume');
					else if (action === 'skipDocument') void runProgressControl('skip');
					else if (action === 'abortRun') void runProgressControl('abort');
					return;
				}
				const owner = current?.kind === 'autoRun' ? agentById(current.view.agentId) : agent;
				if (owner) openProgress(owner, current);
				else setNotice('Select an agent to watch its Auto Run.');
				return;
			}
			case 'groupChats':
				void openGroupChats();
				return;
			case 'newGroupChat':
				// From the palette there is no list yet: open it, with the form up.
				if (current?.kind === 'groupChats') {
					setOverlay({
						...current,
						screen: { kind: 'create', form: initialChatForm(), submitting: false },
					});
				} else void openGroupChats({ creating: true });
				return;
			case 'renameGroupChat':
			case 'deleteGroupChat':
			case 'reloadGroupChats':
			case 'stopGroupChat':
			case 'sendGroupChat': {
				// A group chat key means something only on its own screens; from anywhere else it opens the list.
				if (current?.kind !== 'groupChats') {
					void openGroupChats();
					return;
				}
				if (action === 'stopGroupChat') {
					void stopOpenChat();
					return;
				}
				if (action === 'sendGroupChat') {
					void sendChatDraft();
					return;
				}
				const chat = highlightedGroupChat(current.list);
				if (action === 'reloadGroupChats') {
					void openGroupChats({ cursorOn: chat?.id });
					return;
				}
				if (!chat) {
					setNotice('No group chat is highlighted.');
					return;
				}
				if (action === 'renameGroupChat') {
					setOverlay({
						kind: 'prompt',
						prompt: renameGroupChatPrompt(chat),
						submitting: false,
						returnToChats: true,
					});
				} else {
					setOverlay({
						kind: 'confirm',
						confirm: deleteGroupChatConfirm(liveChatOfListed(chat)),
						submitting: false,
						returnToChats: true,
					});
				}
				return;
			}
			case 'confirm':
				submitConfirmOverlay();
				return;
			case 'choicePrev':
			case 'choiceNext': {
				const delta = action === 'choiceNext' ? 1 : -1;
				if (current?.kind === 'groupChats') {
					updateChatForm((form) => cycleChatChoice(data.agents, form, delta));
					return;
				}
				if (current?.kind === 'autoRun' && current.screen?.kind === 'launch') {
					updateLaunch((form) => cycleLaunchField(form, launchFieldsNow(form), delta));
					return;
				}
				const ctx = formContextRef.current;
				if (current?.kind !== 'form' || !ctx) return;
				// Right on Directory takes the top completion; every other choice field steps.
				updateForm((state) =>
					state.focus === 'cwd'
						? delta > 0
							? acceptCompletion(state, cwdCandidates(state.values.cwd, state.values.ssh !== ''))
							: state
						: cycleChoice(ctx, state, delta)
				);
				return;
			}
			case 'closeOverlay':
				// Esc on a group chat screen goes back to the list under it.
				if (current?.kind === 'groupChats' && current.screen) {
					setOverlay({ kind: 'groupChats', list: current.list });
					return;
				}
				// A rename or delete opened from the group chat list goes back to it.
				if ((current?.kind === 'prompt' || current?.kind === 'confirm') && current.returnToChats) {
					void openGroupChats();
					return;
				}
				// Esc in the name box puts the box away and keeps the list.
				if (current?.kind === 'autoRun' && current.view.naming) {
					setOverlay({ ...current, view: cancelNaming(current.view) });
					return;
				}
				// Esc on a run screen goes back to the document list under it.
				if (current?.kind === 'autoRun' && current.screen) {
					setOverlay({ kind: 'autoRun', view: current.view });
					return;
				}
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
				const picker = current ? undefined : currentMentionPicker();
				const composerTarget = composerTargetRef.current;
				if (picker && composerTarget) {
					setMentionUi(stepMentionCursor(mentionUiFor(composerTarget.key), picker, delta));
					return;
				}
				if (current?.kind === 'help') {
					setOverlay({ ...current, cursor: moveGroupCursor(current.cursor, delta, KEYMAP.length) });
				} else if (current?.kind === 'history') {
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
				} else if (current?.kind === 'palette') {
					const count = rankPaletteEntries(paletteEntriesRef.current, current.palette.query).length;
					setOverlay({
						kind: 'palette',
						palette: movePaletteCursor(current.palette, delta, count),
					});
				} else if (current?.kind === 'form') {
					const ctx = formContextRef.current;
					if (ctx) updateForm((form) => moveFocus(ctx, form, delta));
				} else if (current?.kind === 'prompt') {
					setOverlay({ ...current, prompt: movePromptFocus(current.prompt, delta) });
				} else if (current?.kind === 'groupPicker') {
					const count = groupChoices(groupsFromSections(data.sections)).length;
					setOverlay({ ...current, cursor: moveGroupCursor(current.cursor, delta, count) });
				} else if (current?.kind === 'groupChats') {
					if (current.screen?.kind === 'create') {
						updateChatForm((form) => moveChatFormFocus(data.agents, form, delta));
					} else if (!current.screen) {
						setOverlay({ ...current, list: moveGroupChatCursor(current.list, delta) });
					}
				} else if (current?.kind === 'autoRun' && current.screen?.kind === 'launch') {
					updateLaunch((form) => moveLaunchFocus(form, launchFieldsNow(form), delta));
				} else if (current?.kind === 'autoRun' && current.screen) {
					// The progress screen has no cursor: its keys are its controls.
				} else if (current?.kind === 'autoRun') {
					setOverlay({ ...current, view: moveAutoRunCursor(current.view, delta) });
				} else if (current?.kind === 'providerPicker') {
					if (!current.done) {
						setOverlay({
							...current,
							cursor: moveGroupCursor(current.cursor, delta, current.choices.length),
						});
					}
				} else if (current?.kind === 'menu') {
					setOverlay({
						kind: 'menu',
						cursor: Math.min(
							Math.max(0, menuEntries.length - 1),
							Math.max(0, current.cursor + delta)
						),
					});
				} else if (focus === 'agents') {
					moveBy(delta);
				}
				return;
			}
			case 'open': {
				if (current?.kind === 'form') {
					const ctx = formContextRef.current;
					if (!ctx) return;
					const result = pressEnter(ctx, current.form);
					setOverlay({ ...current, form: result.state });
					if (result.submit) void submitForm();
					return;
				}
				if (current?.kind === 'prompt') {
					submitPromptOverlay();
					return;
				}
				if (current?.kind === 'groupPicker') {
					void submitGroupPicker(current);
					return;
				}
				if (current?.kind === 'providerPicker') {
					void submitProviderPicker(current);
					return;
				}
				if (current?.kind === 'groupChats') {
					if (current.screen?.kind === 'create') {
						updateChatForm((form) => pressChatFormEnter(data.agents, form));
						return;
					}
					const chat = highlightedGroupChat(current.list);
					if (chat) void openChat(chat.id);
					else setNotice('No group chat to open. Press n to create one.');
					return;
				}
				if (current?.kind === 'autoRun' && current.screen?.kind === 'launch') {
					void submitLaunchScreen();
					return;
				}
				if (current?.kind === 'autoRun') {
					openAutoRunDocument(current);
					return;
				}
				if (current?.kind === 'palette') {
					const results = rankPaletteEntries(paletteEntriesRef.current, current.palette.query);
					const picked = results[current.palette.cursor];
					if (picked) runPaletteEntry(picked.entry);
					return;
				}
				if (current?.kind === 'menu') {
					const picked = menuEntries[current.cursor];
					setOverlay(undefined);
					if (picked) runAction(picked.action, undefined);
					return;
				}
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
	};

	useInput(
		(input, key) => {
			setNotice(undefined);
			const current = overlayRef.current;
			const context: KeyContext = current
				? current.kind === 'groupChats'
					? current.screen?.kind === 'create'
						? 'groupChatForm'
						: current.screen?.kind === 'chat'
							? 'groupChat'
							: 'groupChats'
					: current.kind === 'autoRun'
						? current.screen?.kind === 'launch'
							? 'autoRunLaunch'
							: current.screen?.kind === 'progress'
								? 'autoRunProgress'
								: current.view.naming
									? 'autoRunName'
									: 'autoRun'
						: current.kind
				: composerHasKeys()
					? currentMentionPicker()
						? 'composerMention'
						: 'composer'
					: 'main';
			const action = resolveAction(context, input, key);
			// A delegation is armed by one press of its key and sent by the next; anything else disarms it.
			if (action !== 'delegate' && delegationArmRef.current) {
				delegationArmRef.current = undefined;
				setDraftVersion((version) => version + 1);
			}
			if (action) {
				runAction(action, current, true);
				return;
			}
			if (context === 'composer' || context === 'composerMention') {
				editComposer(input, key);
				return;
			}
			// The palette, the agent form, and the prompts are the overlays with text boxes: what no binding claims is typing.
			if (current?.kind === 'form') {
				const ctx = formContextRef.current;
				if (!ctx) return;
				if (isBackspaceKey(key)) updateForm((form) => formBackspace(ctx, form));
				else {
					const text = typedTextFor(input, key);
					if (text) updateForm((form) => typeText(ctx, form, text));
				}
				return;
			}
			if (current?.kind === 'prompt') {
				if (isBackspaceKey(key)) {
					setOverlay({ ...current, prompt: backspacePrompt(current.prompt) });
					return;
				}
				const text = typedTextFor(input, key);
				if (text) setOverlay({ ...current, prompt: typeIntoPrompt(current.prompt, text) });
				return;
			}
			if (current?.kind === 'groupChats' && current.screen?.kind === 'create') {
				if (isBackspaceKey(key)) updateChatForm(backspaceChatForm);
				else {
					const text = typedTextFor(input, key);
					if (text) updateChatForm((form) => typeIntoChatForm(form, text));
				}
				return;
			}
			if (current?.kind === 'groupChats' && current.screen?.kind === 'chat') {
				const { chatId } = current.screen;
				updateChatScreen(chatId, (screen) => ({
					...screen,
					draft: applyDraftKey(screen.draft, input, key),
				}));
				return;
			}
			if (current?.kind === 'autoRun' && current.screen?.kind === 'launch') {
				if (isBackspaceKey(key)) {
					updateLaunch((form) => backspaceLaunch(form, launchFieldsNow(form)));
					return;
				}
				const text = typedTextFor(input, key);
				if (text) updateLaunch((form) => typeIntoLaunch(form, launchFieldsNow(form), text));
				return;
			}
			if (current?.kind === 'autoRun' && !current.screen && current.view.naming) {
				if (isBackspaceKey(key)) {
					setOverlay({ ...current, view: backspaceName(current.view) });
					return;
				}
				const text = typedTextFor(input, key);
				if (text) setOverlay({ ...current, view: typeIntoName(current.view, text) });
				return;
			}
			if (current?.kind === 'palette') {
				if (isPaletteBackspace(key)) {
					setOverlay({ kind: 'palette', palette: backspacePalette(current.palette) });
					return;
				}
				const text = paletteTextFor(input, key);
				if (text) setOverlay({ kind: 'palette', palette: typeIntoPalette(current.palette, text) });
			}
			// Off while the editor owns the terminal: Ink then stops reading stdin and leaves raw mode.
		},
		{ isActive: editing === undefined }
	);

	// Runs after Ink has let go of the keyboard (this effect is declared after `useInput`'s).
	useEffect(() => {
		if (editing === undefined) return;
		let live = true;
		const timer = setTimeout(async () => {
			const result = await editFileRef.current(editing);
			if (!live) return;
			const latest = overlayRef.current;
			if (latest?.kind === 'autoRun') {
				setOverlay({ ...latest, view: finishAutoRunEdit(latest.view, editing, result) });
			} else if (!result.ok) {
				setNotice(result.message);
			}
			setEditing(undefined);
		}, EDITOR_SETTLE_MS);
		return () => {
			live = false;
			clearTimeout(timer);
		};
	}, [editing]);

	const renderOverlay = overlay
		? ({ width, height }: { width: number; height: number }) => {
				switch (overlay.kind) {
					case 'help':
						return <HelpOverlay cursor={overlay.cursor} width={width} height={height} />;
					case 'palette':
						return (
							<PaletteOverlay
								query={overlay.palette.query}
								results={rankPaletteEntries(paletteEntries, overlay.palette.query)}
								cursor={overlay.palette.cursor}
								width={width}
								height={height}
							/>
						);
					case 'form':
						return formContext ? (
							<AgentForm
								context={formContext}
								state={overlay.form}
								submitting={overlay.submitting}
								loading={lookups.loading}
								width={width}
								height={height}
							/>
						) : null;
					case 'menu':
						return cursorAgent ? (
							<AgentMenuOverlay
								agent={cursorAgent}
								entries={menuEntries}
								cursor={overlay.cursor}
								width={width}
								height={height}
							/>
						) : null;
					case 'prompt':
						return (
							<PromptOverlay
								prompt={overlay.prompt}
								submitting={overlay.submitting}
								error={overlay.error}
								width={width}
								height={height}
							/>
						);
					case 'confirm':
						return (
							<ConfirmOverlay
								confirm={overlay.confirm}
								submitting={overlay.submitting}
								error={overlay.error}
								width={width}
								height={height}
							/>
						);
					case 'groupPicker': {
						const picked = data.agents.find((a) => a.id === overlay.agentId);
						if (!picked) return null;
						const choices = groupChoices(groupsFromSections(data.sections));
						return (
							<GroupPickerOverlay
								agentName={picked.name}
								choices={choices}
								cursor={overlay.cursor}
								currentIndex={pickerStartIndex(choices, picked)}
								width={width}
								height={height}
							/>
						);
					}
					case 'providerPicker': {
						const picked = data.agents.find((a) => a.id === overlay.agentId);
						if (!picked) return null;
						return (
							<ProviderPickerOverlay
								agentName={picked.name}
								choices={overlay.choices}
								cursor={overlay.cursor}
								submitting={overlay.submitting}
								error={overlay.error}
								done={overlay.done}
								width={width}
								height={height}
							/>
						);
					}
					case 'autoRun': {
						const picked = data.agents.find((a) => a.id === overlay.view.agentId);
						if (!picked) return null;
						if (overlay.screen?.kind === 'launch') {
							return (
								<LaunchView
									agent={picked}
									form={overlay.screen.form}
									lookups={{ models: launchModels }}
									submitting={overlay.screen.submitting}
									error={overlay.screen.error}
									width={width}
									height={height}
								/>
							);
						}
						if (overlay.screen?.kind === 'progress') {
							return (
								<ProgressView
									agent={picked}
									run={autoRunsByAgent[picked.id]}
									now={clockNow}
									busy={overlay.screen.busy}
									message={overlay.screen.message}
									error={overlay.screen.error}
									width={width}
									height={height}
								/>
							);
						}
						return (
							<AutoRunView
								agent={picked}
								state={overlay.view}
								run={autoRunsByAgent[picked.id]}
								width={width}
								height={height}
							/>
						);
					}
					case 'groupChats': {
						if (overlay.screen?.kind === 'create') {
							return (
								<GroupChatFormView
									agents={data.agents}
									form={overlay.screen.form}
									submitting={overlay.screen.submitting}
									width={width}
									height={height}
								/>
							);
						}
						if (overlay.screen?.kind === 'chat') {
							return openChatRecord ? (
								<GroupChatView
									chat={openChatRecord}
									draft={overlay.screen.draft}
									busy={overlay.screen.busy}
									message={overlay.screen.message}
									error={overlay.screen.error}
									width={width}
									height={height}
								/>
							) : null;
						}
						return (
							<GroupChatListView
								state={overlay.list}
								liveOf={liveChatOfListed}
								width={width}
								height={height}
							/>
						);
					}
					case 'history':
						return cursorAgent ? (
							<HistoryView
								agent={cursorAgent}
								state={overlay.history}
								width={width}
								height={height}
							/>
						) : null;
					case 'tabs':
						return cursorAgent ? (
							<TabSwitcher
								agent={cursorAgent}
								tabs={visibleAiTabsOf(cursorAgent)}
								cursor={overlay.cursor}
								activeTabId={activeTabIdFor(cursorAgent)}
								width={width}
								height={height}
							/>
						) : null;
				}
			}
		: undefined;

	if (editing !== undefined) {
		return (
			<Text>
				Editing {editing} in {resolveEditorCommand()}. Save and quit to come back.
			</Text>
		);
	}

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
			composer={
				composerKey
					? {
							state: draft,
							running: turnRunning,
							queued: stream.queued,
							mentions: mentionPicker,
							header: delegationWarningNow,
						}
					: undefined
			}
			overlay={renderOverlay}
			agentsPaneOverride={agentsPaneOverride}
			agentsPaneWidth={view.agentsPaneWidth}
			problems={data.problems}
			notice={notice}
		/>
	);
}
