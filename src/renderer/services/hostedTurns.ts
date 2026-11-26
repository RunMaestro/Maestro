/**
 * Where a hosted agent's AI work goes. A hosted agent draws and behaves like any agent (its Left
 * Bar record, kept in step by `startHostedAgentSync()`); the one difference is that a turn runs on
 * its Federation host instead of over SSH from here. The normal composer, Stop, and tab strip call
 * in here for a record with a `liftedTo` pointer:
 *
 * - `sendHostedTurn()`: the composer's send, with images and this tab's own model, effort,
 *   read-only, and save to History as the sender's `TurnOverrides`, and any context a merge or
 *   session recovery left for the turn. A busy tab queues on the host.
 * - `interruptHostedTurn()`: Stop (the pill, the shortcut, `maestro-cli interrupt`).
 * - `openHostedTab()`, `closeHostedTab()`, `renameHostedTab()`, `starHostedTab()`: the strip.
 * - `startHostedConversation()`: a new tab this machine built (Fork, Summarize & Continue).
 * - `updateHostedTab()`: a tab setting the host must hold before a turn starts (thinking).
 * - `settleHostedWizardTab()`: a wizard that ran here hands its tab name and session to the host.
 * - `startHostedAutoRun()`, `controlHostedAutoRun()`: the Auto Run panel's Run, Stop, and pause
 *   choices. The host runs the loop; its progress draws here as this record's run
 *   (`hostedAgentSync.ts`).
 *
 * Every call goes through `services/peerMirror.ts` (`actOnMirroredAgent()`), which toasts a
 * failure and never queues here: a host that is down refuses at once.
 */

import { joinPath } from '../../shared/formatters';
import { readLiftedTo } from '../../shared/maestro-lib/agents/lift-pointer';
import { DEFAULT_TAB_DEFAULTS } from '../../shared/maestro-lib/agents/rules';
import type { AutoRunControl } from '../../shared/maestro-lib/client/peer-actions';
import type {
	TabPatch,
	TurnOverrides,
	TurnSendReceipt,
} from '../../shared/maestro-lib/client/types';
import type { AgentRecord } from '../../shared/maestro-lib/store/records';
import type { BatchRunConfig } from '../../shared/types';
import { usePeerMirrorStore } from '../stores/peerMirrorStore';
import { notifyToast } from '../stores/notificationStore';
import { useSettingsStore } from '../stores/settingsStore';
import {
	selectSessionById,
	updateAiTab,
	updateSessionWith,
	useSessionStore,
} from '../stores/sessionStore';
import type { AITab, Session, UnifiedTabRef } from '../types';
import { mirrorTab } from '../utils/peerMirrorView';
import { appendBlockToDraft } from '../utils/quoteSelection';
import { insertAiTabAtUnifiedIndex, setActiveTab } from '../utils/tabHelpers';
import { insertAfterActiveInUnifiedTabOrder } from '../utils/unifiedTabOrderUtils';
import {
	actOnMirroredAgent,
	closeMirrorTab,
	interruptMirroredAgent,
	renameMirrorTab,
	reopenMirrorClosedTab,
	sendToMirroredTab,
	starMirrorTab,
} from './peerMirror';
import { requestTabAutoNameForMessage } from './tabAutoNaming';

export interface HostedTarget {
	peerId: string;
	agentId: string;
	/** The host's record, when the mirror holds it. */
	agent?: AgentRecord;
}

/** Where a record's AI work runs, or undefined for an agent that is not hosted. */
/**
 * Whether hosted agents are on (`federationHostedAgents`, Settings > SSH Hosts). Off unless the
 * setting is exactly `true` (opt-in). Off, every lifted record works as its SSH agent: nothing
 * here routes to a host, and the host sync stops.
 */
export function hostingEnabled(): boolean {
	return useSettingsStore.getState().federationHostedAgents === true;
}

export function hostedTargetOf(
	session: { liftedTo?: unknown } | null | undefined
): HostedTarget | undefined {
	if (!hostingEnabled()) return undefined;
	const pointer = session ? readLiftedTo(session.liftedTo) : undefined;
	if (!pointer) return undefined;
	const agent = usePeerMirrorStore
		.getState()
		.peers[pointer.peer]?.agents.find((candidate) => candidate.id === pointer.agentId);
	return { peerId: pointer.peer, agentId: pointer.agentId, ...(agent ? { agent } : {}) };
}

/**
 * Tabs `openHostedTab()` opened, by `peer/agent/tab`. The host's answer can reach this machine
 * before its update lists the tab; a send to it in that moment must not open a second one.
 */
const openedHostTabs = new Set<string>();
const hostTabKey = (target: HostedTarget, tabId: string) =>
	`${target.peerId}/${target.agentId}/${tabId}`;

/** Whether `tabId` is one of the host's tabs (a lift keeps tab ids, so most local tabs are). */
export function isHostTab(target: HostedTarget, tabId: string | undefined): boolean {
	if (!tabId) return false;
	return (
		openedHostTabs.has(hostTabKey(target, tabId)) ||
		!!target.agent?.aiTabs?.some((tab) => tab.id === tabId)
	);
}

/** The tab's own composer settings as this sender's overrides for one turn. */
export function hostedTurnOverrides(tab: AITab | undefined): TurnOverrides | undefined {
	if (!tab) return undefined;
	const overrides: TurnOverrides = {};
	if (tab.customModel) overrides.model = tab.customModel;
	if (tab.customEffort) overrides.effort = tab.customEffort;
	if (tab.readOnlyMode !== undefined) overrides.readOnly = tab.readOnlyMode === true;
	if (tab.saveToHistory !== undefined) overrides.saveToHistory = tab.saveToHistory === true;
	return Object.keys(overrides).length > 0 ? overrides : undefined;
}

/** Where a new host tab goes in the strip, and what it carries until the host's update fills it. */
export interface HostedTabPlacement {
	/** Right after this tab, as a local tab created at a position goes. */
	afterTabId?: string;
	/** At this position of the strip: a reopened tab's old slot, as a local reopen restores it. */
	slot?: number;
	/**
	 * Fields only this record holds (a permission mode, a local-only notice in `logs`). The host's
	 * update keeps them: a projection takes the name, session, and state from the host, and merges
	 * local-only log entries with the host's in time order (`mergeHostedLogs()`).
	 */
	fields?: Partial<Omit<AITab, 'id'>>;
	/** Leave the visible tab alone (`maestro-cli tab compact --background`). */
	background?: boolean;
}

/** How `focusHostTab()` places the tab when the placement names no anchor and no slot. */
type HostTabArrival =
	/** A tab the host just made: where a local new tab goes (`newTabPlacement`). */
	| 'new'
	/** A tab coming back from the host: where it already is, else at the end. */
	| 'existing';

/** `list` with `item` moved (or added) right after the first element `isAnchor` matches. */
function placeAfter<T>(
	list: readonly T[],
	item: T,
	isItem: (x: T) => boolean,
	isAnchor: (x: T) => boolean
): T[] {
	const rest = list.filter((x) => !isItem(x));
	const at = rest.findIndex(isAnchor);
	return at === -1 ? [...rest, item] : [...rest.slice(0, at + 1), item, ...rest.slice(at + 1)];
}

/**
 * `session` with `tab` placed in the strip by the rule a local tab of the same kind follows: after
 * an anchor (a fork), at its old slot (a reopen), or where a local new tab goes. The host's update
 * may have appended the tab already; it is moved, never doubled.
 */
function placeHostTab(
	session: Session,
	tab: AITab,
	placement: HostedTabPlacement,
	arrival: HostTabArrival
): Session {
	const isTab = (candidate: AITab) => candidate.id === tab.id;
	const isRef = (ref: UnifiedTabRef) => ref.type === 'ai' && ref.id === tab.id;
	const ref: UnifiedTabRef = { type: 'ai', id: tab.id };
	const { afterTabId, slot } = placement;
	if (afterTabId) {
		return {
			...session,
			aiTabs: placeAfter(session.aiTabs, tab, isTab, (candidate) => candidate.id === afterTabId),
			unifiedTabOrder: placeAfter(
				session.unifiedTabOrder ?? [],
				ref,
				isRef,
				(candidate) => candidate.type === 'ai' && candidate.id === afterTabId
			),
		};
	}
	if (slot !== undefined) return { ...session, ...insertAiTabAtUnifiedIndex(session, tab, slot) };
	const existing = session.aiTabs.some(isTab);
	const aiTabs = existing
		? session.aiTabs.map((candidate) => (isTab(candidate) ? tab : candidate))
		: [...session.aiTabs, tab];
	if (arrival === 'existing' && (session.unifiedTabOrder ?? []).some(isRef)) {
		return { ...session, aiTabs };
	}
	const rest = {
		...session,
		unifiedTabOrder: (session.unifiedTabOrder ?? []).filter((r) => !isRef(r)),
	};
	return {
		...session,
		aiTabs,
		unifiedTabOrder:
			arrival === 'new'
				? insertAfterActiveInUnifiedTabOrder(rest, ref)
				: [...rest.unifiedTabOrder, ref],
	};
}

/**
 * Show `tabId` on the record, adding a blank tab for it until the host's update fills it in. The
 * host's update may land first (it appends the tab); the placement then moves it into place.
 */
function focusHostTab(
	sessionId: string,
	tabId: string,
	placement: HostedTabPlacement = {},
	arrival: HostTabArrival = 'existing'
): void {
	updateSessionWith(sessionId, (session) => {
		const { afterTabId, slot, fields } = placement;
		const existing = session.aiTabs.find((tab) => tab.id === tabId);
		let next = session;
		if (!existing || afterTabId || slot !== undefined || fields || arrival === 'new') {
			const base = existing ?? mirrorTab({ id: tabId });
			const seededLogs = fields?.logs ?? [];
			const tab: AITab = {
				...base,
				...fields,
				logs: [
					...seededLogs,
					...(base.logs ?? []).filter((log) => !seededLogs.some((s) => s.id === log.id)),
				],
			};
			next = placeHostTab(session, tab, placement, arrival);
		}
		if (placement.background) return next;
		return setActiveTab(next, tabId)?.session ?? next;
	});
}

/**
 * Open a tab on the host and show it, at `placement` when given. Answers the new tab's id, or null
 * when the host refused. The tab starts with Save to History and thinking as `createTab()` starts
 * a local one: what `placement.fields` sets (New Tab passes the user's defaults, a fork its source
 * tab's), else `DEFAULT_TAB_DEFAULTS`. The host's tab is given the same, so the pills show what the
 * host will do.
 */
export async function openHostedTab(
	session: Pick<Session, 'id' | 'liftedTo'>,
	placement: HostedTabPlacement = {}
): Promise<string | null> {
	const target = hostedTargetOf(session);
	if (!target) return null;
	const result = await actOnMirroredAgent(target.peerId, target.agentId, { kind: 'new-tab' });
	if (result?.kind !== 'new-tab') return null;
	openedHostTabs.add(hostTabKey(target, result.tabId));
	const saveToHistory = placement.fields?.saveToHistory ?? DEFAULT_TAB_DEFAULTS.saveToHistory;
	const showThinking = placement.fields?.showThinking ?? DEFAULT_TAB_DEFAULTS.showThinking;
	focusHostTab(
		session.id,
		result.tabId,
		{ ...placement, fields: { ...placement.fields, saveToHistory, showThinking } },
		'new'
	);
	void actOnMirroredAgent(target.peerId, target.agentId, {
		kind: 'update-tab',
		tabId: result.tabId,
		patch: { saveToHistory, thinking: showThinking },
	});
	return result.tabId;
}

/**
 * Reopen a closed tab of a hosted agent on its host (Cmd+Shift+T, Quick Chat), as a local agent
 * reopens one here: the conversation continues on the host. The newest, or the one closed as
 * `tabId`. It shows here at once and the host's update fills it; `placement.background` keeps the
 * view where it is. The tab open now, or null when the host refused (a red toast).
 */
export async function reopenHostedClosedTab(
	session: Pick<Session, 'id' | 'liftedTo'>,
	target: { index?: number; tabId?: string },
	placement?: HostedTabPlacement
): Promise<{ tabId: string; wasDuplicate?: boolean } | null> {
	const host = hostedTargetOf(session);
	if (!host) return null;
	const reopened = await reopenMirrorClosedTab(host.peerId, host.agentId, target);
	if (!reopened) return null;
	openedHostTabs.add(hostTabKey(host, reopened.tabId));
	focusHostTab(session.id, reopened.tabId, placement);
	return reopened;
}

/**
 * A new conversation that starts from what this machine built: a fork of a hosted tab (with a
 * first turn), or a compacted tab (Summarize & Continue, whose summary is its transcript).
 */
export interface HostedConversationStart extends HostedTabPlacement {
	/** The tab's name, on the host too (the host's update would clear a name only held here). */
	name: string;
	/**
	 * The first turn's prompt. The host records it as the tab's first user message. Absent: the
	 * tab opens and waits for the person's first message, as a local compacted tab does.
	 */
	prompt?: string;
}

/**
 * Start a conversation in a new host tab, as a local fork or compaction starts one in a new tab:
 * the tab opens where `start` places it and takes its name on the host. With a prompt, its first
 * turn runs there with the tab's own model, effort, read-only, and save to History. The new tab's
 * id, or null when the host refused the tab or its first turn (a refusal shows as a toast). A
 * refused first turn leaves the open tab with the prompt as its draft, ready to send again. Null
 * for an agent that is not hosted.
 */
export async function startHostedConversation(
	session: Pick<Session, 'id' | 'liftedTo'>,
	start: HostedConversationStart
): Promise<string | null> {
	const target = hostedTargetOf(session);
	if (!target) return null;
	const tabId = await openHostedTab(session, {
		afterTabId: start.afterTabId,
		fields: { ...start.fields, name: start.name },
		...(start.background ? { background: true } : {}),
	});
	if (!tabId) return null;
	await renameMirrorTab(target.peerId, target.agentId, tabId, start.name);
	if (start.prompt === undefined) return tabId;
	const tab = selectSessionById(session.id)(useSessionStore.getState())?.aiTabs.find(
		(candidate) => candidate.id === tabId
	);
	const receipt = await sendToMirroredTab(
		target.peerId,
		target.agentId,
		tabId,
		start.prompt,
		hostedTurnOverrides(tab)
	);
	if (receipt) return tabId;
	// The host opened the tab but refused its first turn (the refusal is already a toast). Keep
	// the prompt as the tab's draft, so the context is not lost and Enter sends it again. Text the
	// person typed while the send was pending stays too, after the prompt.
	const prompt = start.prompt;
	updateAiTab(session.id, tabId, (current) => ({
		...current,
		inputValue: appendBlockToDraft(prompt, current.inputValue ?? ''),
	}));
	return null;
}

/**
 * Send what the person typed to the host. A tab the host does not have (a conversation kept from
 * before the move) cannot resume there, so the message opens a new host tab. The host's receipt
 * when it took the message (ran, queued, or held), null when it did not; the caller clears the
 * composer on a receipt. A `queued` receipt names the host's queue item (what a steer acts on).
 * `opts.held` is Queue Held: the host queues the message paused, even on an idle tab.
 * `opts.overrides` are a sender's own chips for this one message (a Federation client's
 * `TurnInput.overrides`); they win over the tab's settings, as they do on a local queued item.
 * `opts.nameFrom` is the text the tab is named from once the host took the message, through the
 * namer a local send calls (`requestTabAutoNameForMessage()`), so a hosted tab gets its name from
 * its first message as a local one does. The caller leaves it out where a local send does not name
 * (a matched slash command, a consult's note).
 */
export async function sendHostedTurn(
	session: Session,
	tabId: string | undefined,
	text: string,
	images: readonly string[],
	opts: {
		held?: boolean;
		overrides?: TurnOverrides;
		nameFrom?: { text: string; label?: string };
		/**
		 * Takes a refusal that sent nothing because the host is not connected, instead of the red
		 * toast, so the caller can keep the message for a retry (`keepTurnForHost()`).
		 */
		onHostUnavailable?: (message: string) => void;
	} = {}
): Promise<TurnSendReceipt | null> {
	const target = hostedTargetOf(session);
	if (!target) return null;
	if (!target.agent) {
		const message = `${session.name} runs on peer "${target.peerId}", which is not connected. Nothing was sent.`;
		if (opts.onHostUnavailable) {
			opts.onHostUnavailable(message);
			return null;
		}
		notifyToast({ color: 'red', title: 'Message not sent', message });
		return null;
	}
	const tab = session.aiTabs.find((candidate) => candidate.id === tabId);
	let hostTabId = tabId;
	if (!isHostTab(target, tabId)) {
		hostTabId = (await openHostedTab(session)) ?? undefined;
		if (!hostTabId) return null;
		notifyToast({
			color: 'theme',
			title: 'Sent in a new tab',
			message: `That conversation is the copy kept from before the move, so it continues in a new tab on ${target.peerId}.`,
		});
	}
	// Merge context, Send to Agent, and session recovery leave context for the tab's next turn. A
	// local send prepends it to the prompt (`takePendingMergedContext()`); the host does the same
	// from its own tab, so it goes there first and the transcript shows only the typed message.
	const mergedContext = tab?.pendingMergedContext;
	if (mergedContext) {
		const handed = await actOnMirroredAgent(target.peerId, target.agentId, {
			kind: 'update-tab',
			tabId: hostTabId as string,
			patch: { mergedContext },
		});
		if (!handed) return null;
	}
	const receipt = await sendToMirroredTab(
		target.peerId,
		target.agentId,
		hostTabId as string,
		text,
		opts.overrides ? { ...hostedTurnOverrides(tab), ...opts.overrides } : hostedTurnOverrides(tab),
		images,
		opts.held,
		opts.onHostUnavailable
	);
	// Spent here once the host took the turn, as a local send spends it at spawn. A refused send
	// keeps it, so the retry hands it over again (the host's copy is overwritten, not doubled).
	if (receipt && mergedContext && tabId) {
		updateAiTab(session.id, tabId, (candidate) =>
			candidate.pendingMergedContext === mergedContext
				? { ...candidate, pendingMergedContext: undefined }
				: candidate
		);
	}
	// The tab the message landed in: a kept tab's message opened a new host tab above.
	if (receipt && opts.nameFrom && hostTabId) {
		requestTabAutoNameForMessage(session, hostTabId, opts.nameFrom.text, opts.nameFrom.label);
	}
	return receipt;
}

/** Stop the host's turn on one tab, or every busy tab without `tabId`. */
export async function interruptHostedTurn(
	session: Pick<Session, 'liftedTo'>,
	tabId?: string
): Promise<void> {
	const target = hostedTargetOf(session);
	if (target) await interruptMirroredAgent(target.peerId, target.agentId, tabId);
}

/**
 * Tabs closed here whose close the host has not reported yet, by `peer/agent/tab`. Until the host's
 * update drops the tab, the sync must not draw it back (`HostedProjectionInput.closing`).
 */
const closingHostTabs = new Set<string>();

/**
 * The tabs of `target` closed here that the host still lists. A close the host has reported (it no
 * longer lists the tab) is settled and forgotten here.
 */
export function closingHostTabIds(target: HostedTarget): Set<string> {
	const prefix = `${target.peerId}/${target.agentId}/`;
	const listed = new Set((target.agent?.aiTabs ?? []).map((tab) => tab.id));
	const closing = new Set<string>();
	for (const key of [...closingHostTabs]) {
		if (!key.startsWith(prefix)) continue;
		const tabId = key.slice(prefix.length);
		if (target.agent && !listed.has(tabId)) closingHostTabs.delete(key);
		else closing.add(tabId);
	}
	return closing;
}

/**
 * Close a host tab too (the local close is the caller's). A kept local tab has none. The tab stays
 * closed here while the host catches up; a close the host refused (a red toast) lets the host's
 * tab show again, because the host still has it.
 */
export function closeHostedTab(session: Pick<Session, 'liftedTo'>, tabId: string): void {
	const target = hostedTargetOf(session);
	if (!target || !isHostTab(target, tabId)) return;
	const key = hostTabKey(target, tabId);
	openedHostTabs.delete(key);
	closingHostTabs.add(key);
	void closeMirrorTab(target.peerId, target.agentId, tabId).then((closed) => {
		if (closed) return;
		closingHostTabs.delete(key);
		// The tab is still on the host: wake the sync so it draws it again.
		usePeerMirrorStore.setState({});
	});
}

/** Rename a host tab too. An empty name clears it. */
export function renameHostedTab(
	session: Pick<Session, 'liftedTo'> | null | undefined,
	tabId: string,
	name: string
): void {
	const target = hostedTargetOf(session);
	if (target && isHostTab(target, tabId)) {
		void renameMirrorTab(target.peerId, target.agentId, tabId, name);
	}
}

/**
 * Push one tab's composer setting to the host too. Model, effort, read-only, and save to History
 * travel with each turn (`hostedTurnOverrides()`); a setting that decides what the host's process
 * streams, such as thinking, has to be on the host's tab before the turn starts.
 */
export function updateHostedTab(
	session: Pick<Session, 'liftedTo'>,
	tabId: string,
	patch: TabPatch
): void {
	const target = hostedTargetOf(session);
	if (target && isHostTab(target, tabId)) {
		void actOnMirroredAgent(target.peerId, target.agentId, { kind: 'update-tab', tabId, patch });
	}
}

/**
 * A wizard that ran here for a hosted tab ends as a local one does: the tab keeps the name the
 * wizard gave it and resumes the wizard's provider session (`flattenWizardIntoTab()`). Both live
 * on the host's tab, which runs the next turn, so push whichever differs there. Reads the tab as
 * the flatten left it in the store; the host's name and session come back on the next sync. A
 * no-op for an agent that is not hosted.
 */
export function settleHostedWizardTab(sessionId: string, tabId: string): void {
	const session = selectSessionById(sessionId)(useSessionStore.getState());
	const target = hostedTargetOf(session);
	if (!session || !target) return;
	const tab = session.aiTabs.find((candidate) => candidate.id === tabId);
	const hostTab = target.agent?.aiTabs?.find((candidate) => candidate.id === tabId);
	if (!tab || !hostTab) return;
	if (tab.name && tab.name !== hostTab.name) {
		void renameMirrorTab(target.peerId, target.agentId, tabId, tab.name);
	}
	if (tab.agentSessionId && tab.agentSessionId !== hostTab.agentSessionId) {
		void actOnMirroredAgent(target.peerId, target.agentId, {
			kind: 'update-tab',
			tabId,
			patch: { agentSessionId: tab.agentSessionId },
		});
	}
}

/** Star or unstar a host tab too. */
export function starHostedTab(
	session: Pick<Session, 'liftedTo'>,
	tabId: string,
	starred: boolean
): void {
	const target = hostedTargetOf(session);
	if (target && isHostTab(target, tabId)) {
		void starMirrorTab(target.peerId, target.agentId, tabId, starred);
	}
}

/**
 * Start an Auto Run on the host: the Auto Run panel's Run for a hosted agent. The host runs the
 * loop, as it does for `maestro-cli auto-run`, over the same documents (the folder the panel
 * reads on the host's machine over SSH), prompt, loop, model, and effort. True when the host took it;
 * a refusal shows as a toast. A no-op (false) for an agent that is not hosted.
 *
 * Not carried: a worktree, the task selection mode, and the auto-resume policy. The host runs the
 * documents in its own checkout, in order, with its own auto-resume settings.
 */
export async function startHostedAutoRun(
	session: Pick<Session, 'name' | 'liftedTo' | 'autoRunFolderPath'>,
	config: BatchRunConfig,
	folderPath: string
): Promise<boolean> {
	const target = hostedTargetOf(session);
	if (!target) return false;
	const goal = config.goalConfig;
	if (goal) {
		const result = await actOnMirroredAgent(target.peerId, target.agentId, {
			kind: 'goal-run',
			launch: {
				goal: goal.goal,
				...(goal.exitCriteria.trim() ? { exitCriteria: goal.exitCriteria } : {}),
				maxIterations: goal.maxIterations,
				...(config.model ? { model: config.model } : {}),
				...(config.effort ? { effort: config.effort } : {}),
			},
		});
		return result?.kind === 'goal-run';
	}
	// The documents were listed from `folderPath`, the folder the panel reads on the host's machine
	// over SSH, so each is named by its full path under it. The host's own folder is only a fallback:
	// it can lag a folder chosen here (the settings sync keeps one outside the working directory
	// behind), and a document outside it is refused by the host instead of running the wrong file.
	const hostFolder =
		folderPath || session.autoRunFolderPath || target.agent?.autoRunFolderPath || '';
	const result = await actOnMirroredAgent(target.peerId, target.agentId, {
		kind: 'auto-run',
		launch: {
			documents: config.documents.map((document) => ({
				file: joinPath(hostFolder, `${document.filename}.md`),
				...(document.resetOnCompletion ? { resetOnCompletion: true } : {}),
			})),
			...(config.loopEnabled ? { loop: true } : {}),
			...(config.loopEnabled && typeof config.maxLoops === 'number'
				? { maxLoops: config.maxLoops }
				: {}),
			...(config.model ? { model: config.model } : {}),
			...(config.effort ? { effort: config.effort } : {}),
			...(config.prompt.trim() ? { prompt: config.prompt } : {}),
			...(config.ignoreModelHints ? { ignoreModelHints: true } : {}),
		},
	});
	return result?.kind === 'auto-run';
}

/**
 * Stop a hosted agent's run, or answer its pause, on the host that runs it. A refusal shows as a
 * toast. False for an agent that is not hosted, so the caller acts on its own run instead.
 */
export function controlHostedAutoRun(
	session: Pick<Session, 'liftedTo'> | null | undefined,
	control: AutoRunControl
): boolean {
	const target = hostedTargetOf(session);
	if (!target) return false;
	void actOnMirroredAgent(target.peerId, target.agentId, { kind: 'auto-run-control', control });
	return true;
}
