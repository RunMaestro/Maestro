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
import { parseMaestroBuiltinCommand } from '../../shared/maestroBuiltinCommands';
import type {
	AutoRunControl,
	HostStopAnswer,
	PeerAgentAction,
} from '../../shared/maestro-lib/client/peer-actions';
import type {
	TabPatch,
	TurnOverrides,
	TurnSendReceipt,
} from '../../shared/maestro-lib/client/types';
import type { AgentRecord, AITabRecord } from '../../shared/maestro-lib/store/records';
import type { BatchRunConfig } from '../../shared/types';
import type { SteeringCommandInput } from '../../shared/autoRunSteeringCommands';
import { usePeerMirrorStore } from '../stores/peerMirrorStore';
import { notifyToast } from '../stores/notificationStore';
import { useSettingsStore } from '../stores/settingsStore';
import {
	selectSessionById,
	updateAiTab,
	updateSessionWith,
	useSessionStore,
} from '../stores/sessionStore';
import type { AITab, ModalSaveOutcome, Session, UnifiedTabRef } from '../types';
import { mirrorTab } from '../utils/peerMirrorView';
import type { HostTabEdit } from '../utils/hostedSession';
import { appendBlockToDraft } from '../utils/quoteSelection';
import { closeTab, insertAiTabAtUnifiedIndex, setActiveTab } from '../utils/tabHelpers';
import { generateId } from '../utils/ids';
import { getRetryEntry } from '../stores/retryStore';
import { insertAfterActiveInUnifiedTabOrder } from '../utils/unifiedTabOrderUtils';
import {
	collectLeafTabRefs,
	normalizeTabGroups,
	removeLeafByTabRef,
	retargetLeafTab,
} from '../utils/panelLayout';
import {
	actOnMirroredAgent,
	actOnMirroredAgentQuietly,
	callMirroredAgentAction,
	closeMirrorTab,
	interruptMirroredAgent,
	renameMirrorTab,
	reopenMirrorClosedTab,
	sendToMirroredTab,
	settleMirroredAnswer,
	steerMirrorAutoRun,
	type MirroredActionAnswer,
	type MirrorSteeringAnswer,
} from './peerMirror';
import { requestTabAutoNameForMessage } from './tabAutoNaming';
import {
	hostedTranscriptBaseline,
	watchHostedHistoryCommand,
	watchHostedTurnSynopsis,
} from './historyEntryToast';

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
 * New Tab on a hosted agent, as a local or SSH agent's New Tab: the tab opens at once. With the
 * host connected it is made there (`openHostedTab()`). With the host not connected it opens here
 * under an id drawn here (`AITab.pendingHostTab`), and is made on the host under that same id when
 * the link is back (`createPendingHostTabs()`) or at its first send, whichever comes first, so a
 * message typed in it is kept like any other. The tab's id, or null when the host refused.
 */
export async function openHostedTabOrHere(
	session: Pick<Session, 'id' | 'liftedTo'>,
	placement: HostedTabPlacement = {}
): Promise<string | null> {
	const target = hostedTargetOf(session);
	if (!target) return null;
	if (usePeerMirrorStore.getState().peers[target.peerId]?.connection === 'connected') {
		return openHostedTab(session, placement);
	}
	const tabId = generateId();
	const saveToHistory = placement.fields?.saveToHistory ?? DEFAULT_TAB_DEFAULTS.saveToHistory;
	const showThinking = placement.fields?.showThinking ?? DEFAULT_TAB_DEFAULTS.showThinking;
	focusHostTab(
		session.id,
		tabId,
		{
			...placement,
			fields: { ...placement.fields, saveToHistory, showThinking, pendingHostTab: true },
		},
		'new'
	);
	return tabId;
}

/** Pending tabs being made on the host now, by `peer/agent/tab`: one request per tab. */
const pendingTabCreations = new Map<string, Promise<string | null>>();
/**
 * Pending tabs closed here while the host was making them, by `peer/agent/tab`: the host's tab is
 * closed as soon as it answers, and is never drawn back meanwhile (`closingHostTabIds()`).
 */
const closedWhilePending = new Set<string>();
/** Pending tabs asked of the host whose answer has not come yet, by `peer/agent/tab`. */
const awaitingHostAnswer = new Set<string>();
/**
 * Pending tabs closed here whose making the host may have done though its answer was lost (a
 * timeout, a dropped link), by `peer/agent/tab`: closed on the host once it lists the tab
 * (`createPendingHostTabs()`), and never drawn meanwhile (`closingHostTabIds()`).
 */
const closeWhenListed = new Set<string>();

/** Whether a refused action may still have been done by the host (its answer was lost). */
function mayHaveBeenDone(answer: MirroredActionAnswer | null): boolean {
	if (!answer || answer.ok || answer.notSent) return false;
	return (
		answer.unknown === true ||
		answer.code === undefined ||
		answer.code === 'host-lost' ||
		answer.code === 'timeout' ||
		answer.code === 'host-unavailable'
	);
}
/**
 * The host tab an older host made under its own id for a pending tab that stays a copy here (a kept
 * message or a retry is keyed on the copy), by the copy's `peer/agent/tab`: the copy's sends go into
 * that tab (`sendHostedTurn()`), never into yet another one.
 */
const copyHostTabs = new Map<string, string>();
/** When making a pending tab last failed, by `peer/agent/tab`: the link-back path waits a while. */
const pendingTabFailedAt = new Map<string, number>();
/** How long the link-back path waits after a failed try before it asks the host again. */
export const PENDING_HOST_TAB_RETRY_MS = 30_000;

/**
 * Make a tab opened here while the host was down (`openHostedTabOrHere()`) on the host, under the
 * id it already has, so its draft, its kept message and its retry stay on it. The host's update
 * then draws it as any host tab (`projectHostedSession()` clears `pendingHostTab`). An older host
 * that answers its own id: the tab here takes that id when nothing on this machine is keyed on it
 * yet (no retry, nothing queued for it); otherwise it stays a copy kept here, and its first send
 * goes to a new host tab as a copy from before the move does. The host's tab id, or null.
 *
 * `quiet`: no red toast on a refusal (the link-back path, which tries again later).
 */
export function createPendingHostTab(
	sessionId: string,
	tabId: string,
	opts: { quiet?: boolean } = {}
): Promise<string | null> {
	const session = selectSessionById(sessionId)(useSessionStore.getState());
	const target = hostedTargetOf(session);
	if (!session || !target) return Promise.resolve(null);
	const key = hostTabKey(target, tabId);
	const inFlight = pendingTabCreations.get(key);
	if (inFlight) return inFlight;
	// The tab as it is when it is asked for: the host's report of it can land before the answer
	// (the client reads the agents again first) and draw the host's blank name and pills over it.
	const asked = session.aiTabs.find((candidate) => candidate.id === tabId);
	const action = { kind: 'new-tab', tabId } as const;
	awaitingHostAnswer.add(key);
	const created = callMirroredAgentAction(target.peerId, target.agentId, action).then((answer) => {
		awaitingHostAnswer.delete(key);
		const result = opts.quiet
			? answer?.ok
				? answer.result
				: null
			: settleMirroredAnswer(action, answer);
		// Closed here while the host made it: told through `closeHostedTab()`, marked by the sync
		// (`closingHostTabIds()`), or gone from the record by any other path (the record itself still
		// here), so the host's tab is closed too.
		const record = selectSessionById(sessionId)(useSessionStore.getState());
		const goneHere = !!record && !record.aiTabs.some((candidate) => candidate.id === tabId);
		const closedHere = closedWhilePending.delete(key) || goneHere;
		if (result?.kind !== 'new-tab') {
			// The host may have made it though its answer was lost: closed there once it lists it.
			if (closedHere && mayHaveBeenDone(answer)) closeWhenListed.add(key);
			if (!closedHere) pendingTabFailedAt.set(key, Date.now());
			return null;
		}
		pendingTabFailedAt.delete(key);
		openedHostTabs.add(hostTabKey(target, result.tabId));
		if (closedHere) {
			// Closed here while it was being made: closed on the host too, and never drawn back.
			if (result.tabId !== tabId) {
				updateSessionWith(sessionId, (current) =>
					current.aiTabs.some((candidate) => candidate.id === result.tabId)
						? (closeTab(current, result.tabId)?.session ?? current)
						: current
				);
			}
			closeHostedTab(session, result.tabId);
			return null;
		}
		const adopted = adoptHostTabId(sessionId, tabId, result.tabId);
		if (!adopted) copyHostTabs.set(key, result.tabId);
		// The host's tab takes what the tab here holds: the adopted tab, or the copy that kept its id
		// (CodeRabbit on #2161), so its pills and name are the user's, not the host's defaults.
		const hostTabId = adopted ?? result.tabId;
		const local = selectSessionById(sessionId)(useSessionStore.getState())?.aiTabs.find(
			(candidate) => candidate.id === (adopted ?? tabId)
		);
		void actOnMirroredAgent(target.peerId, target.agentId, {
			kind: 'update-tab',
			tabId: hostTabId,
			// What the tab holds now: a change made while the host made it is the one that counts
			// (the host's first report keeps a pending tab's own name and pills, projectHostedSession()).
			patch: {
				saveToHistory:
					local?.saveToHistory ?? asked?.saveToHistory ?? DEFAULT_TAB_DEFAULTS.saveToHistory,
				thinking: local?.showThinking ?? asked?.showThinking ?? DEFAULT_TAB_DEFAULTS.showThinking,
			},
		});
		// A name given here while it waited goes too: the host's update takes the name from there.
		const name = local?.name || asked?.name;
		if (name) void renameMirrorTab(target.peerId, target.agentId, hostTabId, name);
		return hostTabId;
	});
	pendingTabCreations.set(key, created);
	const settle = () => {
		if (pendingTabCreations.get(key) === created) pendingTabCreations.delete(key);
	};
	created.then(settle, settle);
	return created;
}

/**
 * The id a pending tab has once the host made it: its own when the host took it. Otherwise (an
 * older host) the host's, when nothing here is keyed on the tab yet; else undefined, and the tab
 * stays a copy kept here (no longer pending).
 */
function adoptHostTabId(sessionId: string, tabId: string, hostTabId: string): string | undefined {
	if (hostTabId === tabId) return tabId;
	let adopted: string | undefined;
	updateSessionWith(sessionId, (session) => {
		const keyed =
			getRetryEntry(sessionId, tabId) !== undefined ||
			(session.executionQueue ?? []).some((item) => item.tabId === tabId);
		// The host's report can land first and draw the host's tab beside this one: when this one
		// takes the host's id, it is that tab (its draft and settings kept), so the copy goes.
		const others = keyed ? session.aiTabs : session.aiTabs.filter((tab) => tab.id !== hostTabId);
		const tabs = others.map((tab) =>
			tab.id !== tabId
				? tab
				: keyed
					? { ...tab, pendingHostTab: undefined }
					: { ...tab, id: hostTabId, pendingHostTab: undefined }
		);
		if (keyed) return { ...session, aiTabs: tabs };
		adopted = hostTabId;
		const from = { type: 'ai' as const, id: tabId };
		const to = { type: 'ai' as const, id: hostTabId };
		// The drawn copy goes, its tile too, so the host's id is in one leaf at most: this tab's.
		const tabGroups = (session.tabGroups ?? []).flatMap((group) => {
			const inTile = collectLeafTabRefs(group.layout).some(
				(ref) => ref.type === 'ai' && ref.id === hostTabId
			);
			const without = inTile ? removeLeafByTabRef(group.layout, to) : group.layout;
			if (!without) return [];
			const layout = retargetLeafTab(without, from, to);
			return layout === group.layout ? [group] : [{ ...group, layout }];
		});
		return normalizeTabGroups({
			...session,
			aiTabs: tabs,
			unifiedTabOrder: (session.unifiedTabOrder ?? [])
				.filter((ref) => !(ref.type === 'ai' && ref.id === hostTabId))
				.map((ref) => (ref.type === 'ai' && ref.id === tabId ? { ...ref, id: hostTabId } : ref)),
			activeTabId: session.activeTabId === tabId ? hostTabId : session.activeTabId,
			// A tile that shows the tab keeps showing it under its new id.
			tabGroups,
		});
	});
	return adopted;
}

/** Whether this record's tab `tabId` is the one the host made (`adoptHostTabId()` took its id). */
function hostTabAdopted(sessionId: string, tabId: string): boolean {
	return !!selectSessionById(sessionId)(useSessionStore.getState())?.aiTabs.some(
		(tab) => tab.id === tabId
	);
}

/**
 * When the soonest pending tab whose making failed may be asked of its host again (its last try
 * plus `PENDING_HOST_TAB_RETRY_MS`), among records whose host is connected: the sync arms a recheck
 * for it, so the tab is made without waiting for another change (CodeRabbit on #2161). A host that
 * is down has no deadline, so an expired one cannot spin while it stays down.
 */
export function nextPendingHostTabRetryAt(sessions: readonly Session[]): number | undefined {
	let soonest: number | undefined;
	for (const session of sessions) {
		const target = hostedTargetOf(session);
		if (!target) continue;
		if (usePeerMirrorStore.getState().peers[target.peerId]?.connection !== 'connected') continue;
		for (const tab of session.aiTabs) {
			if (!tab.pendingHostTab) continue;
			const failedAt = pendingTabFailedAt.get(hostTabKey(target, tab.id));
			if (failedAt === undefined) continue;
			const at = failedAt + PENDING_HOST_TAB_RETRY_MS;
			if (soonest === undefined || at < soonest) soonest = at;
		}
	}
	return soonest;
}

/**
 * Forget what the pending-tab path keeps for a tab, an agent or a peer that is gone (R28): a copy's
 * host tab and a failed try once the tab here is closed, and a close owed to a host tab once no
 * record points at that hosted agent, or the mirror says the agent is gone (its peer removed, or a
 * synced peer no longer lists it). A mirror switched off, or a peer not read yet, says nothing, so
 * an owed close is kept until the host can be told (CodeRabbit on #2164). The sync calls it with
 * every record, after each pass.
 */
export function pruneHostedTabBooks(sessions: readonly Session[]): void {
	const mirror = usePeerMirrorStore.getState();
	const agents = new Set<string>();
	const tabs = new Set<string>();
	for (const session of sessions) {
		const pointer = readLiftedTo(session.liftedTo);
		if (!pointer) continue;
		const peer = mirror.peers[pointer.peer];
		const goneOnHost =
			mirror.enabled &&
			(!peer ||
				(peer.lastSyncAt !== undefined &&
					!peer.agents.some((agent) => agent.id === pointer.agentId)));
		if (goneOnHost) continue;
		const target: HostedTarget = { peerId: pointer.peer, agentId: pointer.agentId };
		agents.add(hostTabKey(target, ''));
		for (const tab of session.aiTabs) tabs.add(hostTabKey(target, tab.id));
	}
	const agentHeld = (key: string) => [...agents].some((prefix) => key.startsWith(prefix));
	for (const key of [...copyHostTabs.keys()]) if (!tabs.has(key)) copyHostTabs.delete(key);
	for (const key of [...pendingTabFailedAt.keys()]) {
		if (!tabs.has(key)) pendingTabFailedAt.delete(key);
	}
	for (const key of [...closeWhenListed]) if (!agentHeld(key)) closeWhenListed.delete(key);
	for (const key of [...pendingHostTabEdits.keys()]) {
		if (!tabs.has(key)) pendingHostTabEdits.delete(key);
	}
}

/** Test-only: how many entries the pending-tab path keeps, by book. */
export function __hostedTabBookSizesForTests(): {
	copies: number;
	failedTries: number;
	closesOwed: number;
	edits: number;
} {
	return {
		copies: copyHostTabs.size,
		failedTries: pendingTabFailedAt.size,
		closesOwed: closeWhenListed.size,
		edits: pendingHostTabEdits.size,
	};
}

/**
 * The link to the host is back: make every pending tab of `session` on the host. A tab whose last
 * try failed waits `PENDING_HOST_TAB_RETRY_MS`, so a host that refuses is not asked on every sync.
 */
export function createPendingHostTabs(session: Session): void {
	const target = hostedTargetOf(session);
	if (!target) return;
	// A tab closed here whose making the host may have done: closed there once it lists it.
	for (const tab of target.agent?.aiTabs ?? []) {
		const key = hostTabKey(target, tab.id);
		if (!closeWhenListed.delete(key)) continue;
		openedHostTabs.add(key);
		closeHostedTab(session, tab.id);
	}
	const now = Date.now();
	for (const tab of session.aiTabs) {
		if (!tab.pendingHostTab || isHostTab(target, tab.id)) continue;
		const failedAt = pendingTabFailedAt.get(hostTabKey(target, tab.id));
		if (failedAt !== undefined && now - failedAt < PENDING_HOST_TAB_RETRY_MS) continue;
		void createPendingHostTab(session.id, tab.id, { quiet: true });
	}
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
		/**
		 * Agent-only text for this one turn: ahead of the message (a released consult's replies,
		 * `QueuedItem.agentContext`) and behind it (the `@mention` notes). The host's transcript
		 * shows `text` alone, as a local transcript does.
		 */
		agentContext?: string;
		agentNotes?: string;
		/** The transcript entry the message already is (`QueuedItem.hostEntryId`): drawn once. */
		entryId?: string;
	} = {}
): Promise<TurnSendReceipt | null> {
	const target = hostedTargetOf(session);
	if (!target) return null;
	const connection = usePeerMirrorStore.getState().peers[target.peerId]?.connection;
	if (!target.agent || (opts.onHostUnavailable && connection !== 'connected')) {
		// Nothing is sent to a host that is not connected, including the steps ahead of the send
		// (a new host tab, merged context): the caller keeps the message for a retry, or it is told.
		// Worded as the outage dialog names the cause (`SshUnreachableModal`).
		const message = `Can't reach the Maestro host on "${target.peerId}"${connection ? ` (${connection})` : ''}. Nothing was sent.`;
		if (opts.onHostUnavailable) {
			opts.onHostUnavailable(message);
			return null;
		}
		notifyToast({ flashWhenToastsOff: true, color: 'red', title: 'Message not sent', message });
		return null;
	}
	const tab = session.aiTabs.find((candidate) => candidate.id === tabId);
	let hostTabId = tabId;
	// The id of this machine's tab the message came from: the pending tab's own, or the host's once
	// this record's tab took it (an older host, nothing keyed on the tab). Its merged context is
	// read and spent there (CodeRabbit on #2161).
	let localTabId = tabId;
	if (tab?.pendingHostTab && tabId && !isHostTab(target, tabId)) {
		// A tab opened here while the host was not connected: made on the host now, under its id.
		hostTabId = (await createPendingHostTab(session.id, tabId)) ?? undefined;
		if (!hostTabId) return null;
		const tabsNow = selectSessionById(session.id)(useSessionStore.getState())?.aiTabs ?? [];
		if (!tabsNow.some((candidate) => candidate.id === tabId)) localTabId = hostTabId;
		if (hostTabId !== tabId && !hostTabAdopted(session.id, hostTabId)) {
			// An older host gave it its own id while this tab holds a kept message: a copy here.
			notifyToast({
				flashWhenToastsOff: true,
				color: 'theme',
				title: 'Sent in a new tab',
				message: `The Maestro host on ${target.peerId} made that tab under its own id, so the message continues in a new tab there.`,
			});
		}
	}
	// The copy of a pending tab an older host made under its own id (the link-back path made it):
	// its message goes into that host tab, as the first send would have.
	const madeForCopy = tabId ? copyHostTabs.get(hostTabKey(target, tabId)) : undefined;
	if (!isHostTab(target, hostTabId) && madeForCopy && isHostTab(target, madeForCopy)) {
		hostTabId = madeForCopy;
		notifyToast({
			flashWhenToastsOff: true,
			color: 'theme',
			title: 'Sent in a new tab',
			message: `The Maestro host on ${target.peerId} made that tab under its own id, so the message continues in a new tab there.`,
		});
	}
	if (!isHostTab(target, hostTabId)) {
		hostTabId = (await openHostedTab(session)) ?? undefined;
		if (!hostTabId) return null;
		notifyToast({
			flashWhenToastsOff: true,
			color: 'theme',
			title: 'Sent in a new tab',
			message: `That conversation is the copy kept from before the move, so it continues in a new tab on ${target.peerId}.`,
		});
	}
	// Merge context, Send to Agent, and session recovery leave context for the tab's next turn. A
	// local send prepends it to the prompt (`takePendingMergedContext()`); the host does the same
	// from its own tab, so it goes there first and the transcript shows only the typed message.
	// Read from the store, not the caller's snapshot: a send that waited behind an earlier one of
	// this tab must not hand over context that send already spent.
	const liveTab = selectSessionById(session.id)(useSessionStore.getState())?.aiTabs.find(
		(candidate) => candidate.id === localTabId
	);
	const mergedContext = (liveTab ?? tab)?.pendingMergedContext;
	if (mergedContext) {
		const handed = await actOnMirroredAgent(target.peerId, target.agentId, {
			kind: 'update-tab',
			tabId: hostTabId as string,
			patch: { mergedContext },
		});
		if (!handed) return null;
	}
	// `/history`: the host saves the entry; the toast a local `/history` raises is raised here.
	const historyCommand =
		!opts.held && parseMaestroBuiltinCommand(text, session.toolType)?.name === '/history';
	const historyBaseline = historyCommand
		? await hostedTranscriptBaseline(target.peerId, target.agentId, hostTabId as string)
		: undefined;
	const receipt = await sendToMirroredTab(
		target.peerId,
		target.agentId,
		hostTabId as string,
		text,
		opts.overrides ? { ...hostedTurnOverrides(tab), ...opts.overrides } : hostedTurnOverrides(tab),
		images,
		opts.held,
		{
			...(opts.agentContext ? { agentContext: opts.agentContext } : {}),
			...(opts.agentNotes ? { agentNotes: opts.agentNotes } : {}),
			...(opts.entryId ? { entryId: opts.entryId } : {}),
		},
		opts.onHostUnavailable
	);
	// Spent here once the host took the turn, as a local send spends it at spawn. A refused send
	// keeps it, so the retry hands it over again (the host's copy is overwritten, not doubled).
	// A message the host had already answered ran nothing now: nothing was spent, nothing to name.
	const ranNow = receipt !== null && receipt.status !== 'answered';
	if (ranNow && mergedContext && localTabId) {
		updateAiTab(session.id, localTabId, (candidate) =>
			candidate.pendingMergedContext === mergedContext
				? { ...candidate, pendingMergedContext: undefined }
				: candidate
		);
	}
	// No baseline (the read before the send failed): no toast rather than an earlier run's.
	if (historyCommand && historyBaseline && receipt?.status === 'ran' && hostTabId) {
		watchHostedHistoryCommand(session.id, target, hostTabId, { baseline: historyBaseline });
	}
	// A turn that saves to History raises the "Synopsis" toast here once the host saved its entry,
	// as a local turn's exit synopsis raises it in the window that runs it (U3).
	// The host's rule: only an explicit "off" records nothing (`createTurnRecorder()`).
	const savesToHistory = (opts.overrides?.saveToHistory ?? tab?.saveToHistory) !== false;
	if (
		savesToHistory &&
		hostTabId &&
		(receipt?.status === 'started' || receipt?.status === 'queued')
	) {
		watchHostedTurnSynopsis(
			session.id,
			target,
			hostTabId,
			receipt.status === 'queued' ? { queuedItemId: receipt.itemId } : {}
		);
	}
	// The tab the message landed in: a kept tab's message opened a new host tab above.
	if (ranNow && opts.nameFrom && hostTabId) {
		requestTabAutoNameForMessage(session, hostTabId, opts.nameFrom.text, opts.nameFrom.label);
	}
	return receipt;
}

/** Stop the host's turn on one tab, or every busy tab without `tabId`. */
export async function interruptHostedTurn(
	session: Pick<Session, 'liftedTo'>,
	tabId?: string
): Promise<HostStopAnswer | undefined> {
	const target = hostedTargetOf(session);
	return target ? interruptMirroredAgent(target.peerId, target.agentId, tabId) : undefined;
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
export function closingHostTabIds(
	target: HostedTarget,
	local?: Pick<Session, 'aiTabs'>
): Set<string> {
	const prefix = `${target.peerId}/${target.agentId}/`;
	// A pending tab the host is making that left this record by a path that never told the host:
	// marked closed now, before the host's report of it could draw it back.
	if (local) {
		for (const key of awaitingHostAnswer) {
			if (!key.startsWith(prefix)) continue;
			const tabId = key.slice(prefix.length);
			if (!local.aiTabs.some((tab) => tab.id === tabId)) closedWhilePending.add(key);
		}
	}
	const listed = new Set((target.agent?.aiTabs ?? []).map((tab) => tab.id));
	const closing = new Set<string>();
	for (const key of [...closingHostTabs]) {
		if (!key.startsWith(prefix)) continue;
		const tabId = key.slice(prefix.length);
		if (target.agent && !listed.has(tabId)) closingHostTabs.delete(key);
		else closing.add(tabId);
	}
	// A pending tab closed while the host makes it (or may have made it): never drawn when listed.
	for (const key of [...closedWhilePending, ...closeWhenListed]) {
		if (key.startsWith(prefix)) closing.add(key.slice(prefix.length));
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
	if (!target) return;
	const key = hostTabKey(target, tabId);
	if (!isHostTab(target, tabId)) {
		// A tab opened here while the host was down, being made there now: closed once it is.
		if (pendingTabCreations.has(key)) closedWhilePending.add(key);
		return;
	}
	openedHostTabs.delete(key);
	closingHostTabs.add(key);
	void closeMirrorTab(target.peerId, target.agentId, tabId).then((closed) => {
		if (closed) return;
		closingHostTabs.delete(key);
		// The tab is still on the host: wake the sync so it draws it again.
		usePeerMirrorStore.setState({});
	});
}

/** One field of a tab edited here and sent to its host, with the request that sent it. */
interface PendingHostTabField<T> {
	value: T;
	/** The request that sent `value`: only its own answer or wait settles the field. */
	token: number;
	/** That request was answered: the host took it, so its report of `value` is the echo. */
	answered: boolean;
}

interface PendingHostTabEdit {
	name?: PendingHostTabField<string>;
	starred?: PendingHostTabField<boolean>;
}

type HostTabEditField = keyof PendingHostTabEdit;

/**
 * Name and star edits sent to a host that it has not reported back yet, by `peer/agent/tab`. A
 * local tab draws its own edit at once; a hosted tab's next sync drew the host's older value until
 * the host's update landed, so a new name or star blinked back for a frame, each blink a commit of
 * the whole window (L36). A field is kept until the host reports its value after taking its own
 * request (a report before the answer may still be the value from before), the host refuses it
 * (its value stands), or `HOST_TAB_EDIT_ECHO_MS` after the host took it (a host that never reports
 * it must not hide a later change made elsewhere). A newer edit of the same field replaces an older
 * one, and the older request's answer and wait leave the newer one alone.
 */
const pendingHostTabEdits = new Map<string, PendingHostTabEdit>();
let lastHostTabEditToken = 0;

/** How long an edit the host took is drawn while its update is on the way. */
export const HOST_TAB_EDIT_ECHO_MS = 2000;

const sameHostName = (a: string | null | undefined, b: string | null | undefined) =>
	(a || null) === (b || null);

function hostReportsField(
	field: HostTabEditField,
	value: string | boolean,
	host: Pick<AITabRecord, 'name' | 'starred'> | undefined
): boolean {
	if (!host) return false;
	return field === 'name'
		? sameHostName(host.name, value as string)
		: (host.starred === true) === value;
}

/**
 * The edits of `target`'s tabs the host has not reported yet, by tab id, for the sync to draw
 * (`HostedProjectionInput.editing`). An edit the host took and now reports is settled here.
 */
export function hostTabEditsOf(target: HostedTarget): Map<string, HostTabEdit> {
	const prefix = `${target.peerId}/${target.agentId}/`;
	const edits = new Map<string, HostTabEdit>();
	for (const [key, pending] of [...pendingHostTabEdits]) {
		if (!key.startsWith(prefix)) continue;
		const tabId = key.slice(prefix.length);
		const host = target.agent?.aiTabs?.find((tab) => tab.id === tabId);
		const left: PendingHostTabEdit = { ...pending };
		for (const field of ['name', 'starred'] as const) {
			const entry = left[field];
			if (entry?.answered && hostReportsField(field, entry.value, host)) delete left[field];
		}
		if (!left.name && !left.starred) {
			pendingHostTabEdits.delete(key);
			continue;
		}
		pendingHostTabEdits.set(key, left);
		edits.set(tabId, {
			...(left.name ? { name: left.name.value } : {}),
			...(left.starred ? { starred: left.starred.value } : {}),
		});
	}
	return edits;
}

/** Draw `value` for `field` of `key` until its request settles. Returns the request's token. */
function holdHostTabField(
	key: string,
	field: HostTabEditField,
	value: string | boolean,
	answered: boolean
): number {
	const token = ++lastHostTabEditToken;
	pendingHostTabEdits.set(key, {
		...pendingHostTabEdits.get(key),
		[field]: { value, token, answered },
	});
	return token;
}

/** Apply `change` to `field` of `key` when it still holds the request `token`, then wake the sync. */
function settleHostTabField(
	key: string,
	field: HostTabEditField,
	token: number,
	change: 'answered' | 'drop'
): void {
	const pending = pendingHostTabEdits.get(key);
	const entry = pending?.[field];
	if (!pending || !entry || entry.token !== token) return;
	const left: PendingHostTabEdit = { ...pending };
	if (change === 'drop') delete left[field];
	else Object.assign(left, { [field]: { ...entry, answered: true } });
	if (!left.name && !left.starred) pendingHostTabEdits.delete(key);
	else pendingHostTabEdits.set(key, left);
	// The host may already report it, or its own value is drawn again: wake the sync.
	usePeerMirrorStore.setState({});
}

/** End the field's wait `HOST_TAB_EDIT_ECHO_MS` after the host took the request `token`. */
function endHostTabFieldWait(key: string, field: HostTabEditField, token: number): void {
	setTimeout(() => settleHostTabField(key, field, token, 'drop'), HOST_TAB_EDIT_ECHO_MS);
}

/** The host took the request `token`: its report settles the field, or the wait ends it. */
function hostTookTabField(key: string, field: HostTabEditField, token: number): void {
	settleHostTabField(key, field, token, 'answered');
	endHostTabFieldWait(key, field, token);
}

/** Send a tab's name or star to its host, and draw it as edited until the host reports it. */
function sendHostTabEdit(
	target: HostedTarget,
	tabId: string,
	field: HostTabEditField,
	value: string | boolean
): void {
	const key = hostTabKey(target, tabId);
	const token = holdHostTabField(key, field, value, false);
	const action: PeerAgentAction =
		field === 'name'
			? { kind: 'rename-tab', tabId, name: value as string }
			: { kind: 'star-tab', tabId, starred: value === true };
	void actOnMirroredAgent(target.peerId, target.agentId, action).then((result) => {
		if (result === null) settleHostTabField(key, field, token, 'drop');
		else hostTookTabField(key, field, token);
	});
}

/** Rename a host tab too. An empty name clears it. */
export function renameHostedTab(
	session: Pick<Session, 'liftedTo'> | null | undefined,
	tabId: string,
	name: string
): void {
	const target = hostedTargetOf(session);
	if (target && isHostTab(target, tabId)) sendHostTabEdit(target, tabId, 'name', name);
}

/**
 * Rename a host tab and wait for the host's answer, for Rename Tab: a name the host refused keeps
 * the modal open with what the person typed, and the reason in it (no toast). Null for a tab that
 * is not a host's (a local or SSH rename, which is applied here and cannot be refused).
 */
export function renameHostedTabSettled(
	session: Pick<Session, 'liftedTo'> | null | undefined,
	tabId: string,
	name: string
): Promise<ModalSaveOutcome> | null {
	const target = hostedTargetOf(session);
	if (!target || !isHostTab(target, tabId)) return null;
	return actOnMirroredAgentQuietly(target.peerId, target.agentId, {
		kind: 'rename-tab',
		tabId,
		name,
	}).then((answer) => {
		if ('error' in answer) return { saved: false, reason: answer.error };
		// The host took it: this name is drawn until the host reports it, over an auto-name still
		// waiting for its own report.
		// The caller writes the name here next, so the sync need not wake for it.
		const key = hostTabKey(target, tabId);
		endHostTabFieldWait(key, 'name', holdHostTabField(key, 'name', name, true));
		return { saved: true };
	});
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
	if (target && isHostTab(target, tabId)) sendHostTabEdit(target, tabId, 'starred', starred);
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
 * Steer a hosted agent's run on the host that runs it (the Thought Stream's Steer). Undefined for
 * an agent that is not hosted, so the caller steers its own run; otherwise what the host said
 * (`steerMirrorAutoRun()`: no toast, the caller reports a failure).
 */
export function steerHostedAutoRun(
	session: Pick<Session, 'liftedTo'> | null | undefined,
	input: SteeringCommandInput
): Promise<MirrorSteeringAnswer> | undefined {
	const target = hostedTargetOf(session);
	if (!target) return undefined;
	return steerMirrorAutoRun(target.peerId, target.agentId, input);
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
