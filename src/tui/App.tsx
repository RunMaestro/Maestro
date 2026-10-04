import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useApp, useInput, type Key } from 'ink';
import type { AgentRecord, ClientResult, MaestroClient, MaestroPaths } from '../shared/maestro-lib';
import { asThinkingMode, visibleAiTabsOf } from '../shared/maestro-lib';
import { AgentForm } from './agents/AgentForm';
import {
	acceptCompletion,
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
import { useFormLookups } from './agents/useFormLookups';
import {
	ConfirmOverlay,
	GroupPickerOverlay,
	PromptOverlay,
	ProviderPickerOverlay,
} from './agents/ManageOverlays';
import {
	backspacePrompt,
	deleteAgentConfirm,
	deleteGroupConfirm,
	groupChoices,
	manageTargetOf,
	moveGroupCursor,
	movePromptFocus,
	newGroupPrompt,
	pickerStartIndex,
	renameAgentPrompt,
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
import {
	EMPTY_COMPOSER,
	backspace as composerBackspace,
	composerTextFor,
	deleteToLineStart,
	insertNewline,
	insertText,
	isBlankComposer,
	moveLeft,
	moveRight,
	moveToLineEnd,
	moveToLineStart,
	moveVertical,
	type ComposerState,
} from './composer/draft';
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
}

/** The overlay on screen, if any. Only one at a time, and Esc closes it. */
type OverlayState =
	| { kind: 'help'; cursor: number }
	| { kind: 'tabs'; agentId: string; cursor: number }
	| { kind: 'history'; history: HistoryViewState }
	| { kind: 'palette'; palette: PaletteState }
	| { kind: 'menu'; cursor: number }
	| { kind: 'prompt'; prompt: PromptState; submitting: boolean; error?: string }
	| { kind: 'confirm'; confirm: ConfirmState; submitting: boolean; error?: string }
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

export function App({ paths, client }: AppProps): React.ReactElement {
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
	// One line of news for the status bar (read-only refusals, a saved agent). The next key clears it.
	const [notice, setNotice] = useState<string | undefined>(undefined);
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
	const activeEntries = useMemo(
		() => mergeLiveTurn(storedEntries, stream.turn, thinkingMode),
		[storedEntries, stream.turn, thinkingMode]
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
			void settleOverlay('confirm', (client) => submitConfirm(client, current.confirm));
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

	/** Sends the open tab's draft. Cleared at once so a second Enter cannot send it twice; a refusal puts it back. */
	const sendDraft = async () => {
		const target = composerTargetRef.current;
		if (!target) {
			if (requireClient()) setNotice('Select an agent with a tab to send a message.');
			return;
		}
		const text = draftsRef.current[target.key] ?? EMPTY_COMPOSER;
		if (isBlankComposer(text)) return;
		setDraft(target.key, () => EMPTY_COMPOSER);
		const outcome = await submitDraft(target.client, target.agentId, target.tabId, text);
		if (outcome.status === 'failed') {
			// Back in the box, unless the person has started something new in the meantime.
			setDraft(target.key, (now) => (now.text === '' ? text : now));
			setNotice(outcome.message);
			return;
		}
		if (outcome.status === 'sent' && outcome.queued) {
			setNotice(outcome.notice);
			refreshQueueRef.current();
		}
	};

	/**
	 * Stops the shown tab's running turn. From the `Ctrl-C` key it also arms the
	 * quit window: a second press within a second quits, running turn or not.
	 */
	const interrupt = async (viaKey: boolean) => {
		const now = Date.now();
		const decision = viaKey
			? decideCtrlC({ now, lastAt: lastCtrlCRef.current, running: turnRunningRef.current })
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
		const edit = (change: (state: ComposerState) => ComposerState) => setDraft(target.key, change);
		if (isBackspaceKey(key)) edit(composerBackspace);
		else if (key.leftArrow) edit(moveLeft);
		else if (key.rightArrow) edit(moveRight);
		else if (key.upArrow) edit((state) => moveVertical(state, -1));
		else if (key.downArrow) edit((state) => moveVertical(state, 1));
		else if (key.ctrl) {
			if (input === 'a') edit(moveToLineStart);
			else if (input === 'e') edit(moveToLineEnd);
			else if (input === 'u') edit(deleteToLineStart);
		} else {
			const text = composerTextFor(input, key);
			if (text) edit((state) => insertText(state, text));
		}
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
				void submitForm();
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
			case 'confirm':
				submitConfirmOverlay();
				return;
			case 'choicePrev':
			case 'choiceNext': {
				const ctx = formContextRef.current;
				if (current?.kind !== 'form' || !ctx) return;
				const delta = action === 'choiceNext' ? 1 : -1;
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

	useInput((input, key) => {
		setNotice(undefined);
		const current = overlayRef.current;
		const context: KeyContext = current ? current.kind : composerHasKeys() ? 'composer' : 'main';
		const action = resolveAction(context, input, key);
		if (action) {
			runAction(action, current, true);
			return;
		}
		if (context === 'composer') {
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
		if (current?.kind === 'palette') {
			if (isPaletteBackspace(key)) {
				setOverlay({ kind: 'palette', palette: backspacePalette(current.palette) });
				return;
			}
			const text = paletteTextFor(input, key);
			if (text) setOverlay({ kind: 'palette', palette: typeIntoPalette(current.palette, text) });
		}
	});

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
				composerKey ? { state: draft, running: turnRunning, queued: stream.queued } : undefined
			}
			overlay={renderOverlay}
			agentsPaneOverride={agentsPaneOverride}
			agentsPaneWidth={view.agentsPaneWidth}
			problems={data.problems}
			notice={notice}
		/>
	);
}
