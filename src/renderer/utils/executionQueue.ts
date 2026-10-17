/**
 * Helpers for the per-session AI execution queue, centralizing the rules for
 * user-paused items and connection-held items.
 *
 * A queued item with `paused: true` is held by the user: it stays in the queue
 * (preserving its position) but is invisible to dispatch. Auto-run, on-exit
 * dequeue, interrupt/kill re-dispatch, batch progression, and the manual
 * "process next" action all run the first *non-paused* item instead of blindly
 * taking index 0. A connection hold is an ordering barrier: later items cannot
 * overtake a prompt whose delivery state is still unknown. A consult hold
 * (`awaitingConsult`) is the same barrier scoped to one tab: that tab's turn is
 * not finished until the agents it consulted have replied.
 */

import type {
	AITab,
	LogEntry,
	QueuedItem,
	QueuedItemEditPatch,
	Session,
	SessionState,
} from '../types';
import { generateId } from './ids';
import { isAutoModel } from '../../shared/autoModel';
import {
	STEERING_TOO_LONG_DETAIL,
	startsWithTuiCommandPrefix,
	steeringTextTooLong,
} from '../../shared/chatSteering';
import { resolveCodexTransport } from '../../shared/codexTransport';
import { isSessionRemote } from './sessionHelpers';
import {
	getBusyTabs,
	getTabDisplayName,
	markTabRunningQueuedItem,
	markTabRunningTurn,
	resolveQueuedItemTarget,
} from './tabHelpers';

/**
 * Apply an edit-modal patch to one queued item, returning the resulting queue.
 *
 * Both save paths route through here - the inline chat list edits the ACTIVE
 * agent (App.tsx) while the Execution Queue browser edits any agent by id
 * (useQueueHandlers) - so the two cannot drift on what an edit actually
 * writes. They already had: one of them dropped `turnSettings` on the floor,
 * silently discarding the model/effort the user had just picked.
 *
 * `turnSettings` is assigned, not merged. The modal always sends the complete
 * settings it was displaying, so clearing a picker back to "Default" has to
 * clear the stored field rather than leave the previous value behind.
 *
 * The model router's answer (`turnSettings.route`, on an item queued on the
 * Auto model) is an answer about the item's TEXT. When the text changed it is
 * dropped, so the edited message is routed for what it now says when it is
 * dispatched, and never launched on a decision made about other words. It is
 * dropped too when the edit took the item off Auto: an answer means nothing on
 * a named model.
 *
 * `crossAgent` is optional and carries the two `@mention` flags, re-derived by
 * the caller from the EDITED text. It is a parameter rather than something this
 * function works out for itself because deriving it needs `planCrossAgentMentions`,
 * which reads the session store - a dependency a pure queue utility must not take
 * on. Callers that can resolve a mention pass it; the rest omit it and leave the
 * item's existing flags alone.
 */
export function applyQueuedItemEdit(
	queue: QueuedItem[],
	itemId: string,
	patch: QueuedItemEditPatch,
	crossAgent?: { crossAgentMention: boolean; crossAgentOnly: boolean }
): QueuedItem[] {
	return queue.map((item) => {
		if (item.id !== itemId) return item;
		let turnSettings = patch.turnSettings;
		if (turnSettings?.route && (item.text !== patch.text || !isAutoModel(turnSettings.model))) {
			const { route: _staleRoute, ...withoutRoute } = turnSettings;
			turnSettings = withoutRoute;
		}
		return {
			...item,
			text: patch.text,
			images: patch.images,
			turnSettings,
			...(crossAgent ?? {}),
		};
	});
}

/**
 * A queued item is runnable when neither the user, the bridge, nor a pending
 * cross-agent consult holds it.
 */
export function isRunnableQueueItem(item: QueuedItem): boolean {
	return !item.paused && !item.waitingForConnection && !item.awaitingConsult;
}

/**
 * Whether a consult hold is still waiting on `tabId`'s behalf. A held turn has
 * not finished yet, so anything new for that tab - a typed message included -
 * must queue behind it rather than run ahead of the reply.
 */
export function hasConsultHoldForTab(queue: QueuedItem[], tabId: string | undefined): boolean {
	if (!tabId) return false;
	return queue.some((item) => !!item.awaitingConsult && item.tabId === tabId);
}

/**
 * Remove `tabId`'s consult hold, for a turn that never started (its spawn
 * failed or collided). With no answer underway there is nothing to finish, and
 * a hold left behind would later deliver a continuation for a message the agent
 * never received. Returns the queue unchanged (same reference) when there is
 * no hold to drop.
 */
export function dropConsultHold(queue: QueuedItem[], tabId: string | undefined): QueuedItem[] {
	if (!tabId || !queue.some((item) => item.awaitingConsult && item.tabId === tabId)) return queue;
	return queue.filter((item) => !(item.awaitingConsult && item.tabId === tabId));
}

/**
 * Walk the queue in order and return the index of the first item that would
 * actually run, or -1. The ONE place the dispatch order is decided:
 *
 * - a connection hold is a barrier for the whole queue (delivery state unknown);
 * - a consult hold is a barrier for ITS TAB only: that tab's turn is not done
 *   until the reply lands, while other tabs carry on;
 * - a paused item is simply skipped.
 */
function firstRunnableQueueIndex(queue: QueuedItem[]): number {
	const consultBlockedTabs = new Set<string>();
	for (let index = 0; index < queue.length; index += 1) {
		const item = queue[index];
		if (item.waitingForConnection) return -1;
		if (item.awaitingConsult) {
			consultBlockedTabs.add(item.tabId);
			continue;
		}
		if (consultBlockedTabs.has(item.tabId)) continue;
		if (item.paused) continue;
		return index;
	}
	return -1;
}

/** Release bridge holds after main process ownership is known. */
export function releaseConnectionHeldQueueItems(queue: QueuedItem[]): QueuedItem[] {
	if (!queue.some((item) => item.waitingForConnection)) return queue;
	return queue.map(({ waitingForConnection: _waiting, ...item }) => item);
}

/** The first item that would actually run, or undefined if all are held/empty. */
export function nextRunnableQueueItem(queue: QueuedItem[]): QueuedItem | undefined {
	const index = firstRunnableQueueIndex(queue);
	return index >= 0 ? queue[index] : undefined;
}

/** Whether the queue has at least one item that would run (not all held). */
export function hasRunnableQueueItem(queue: QueuedItem[]): boolean {
	return nextRunnableQueueItem(queue) !== undefined;
}

/**
 * Remove the first runnable (non-paused) item from the queue, preserving the
 * order of everything else (including any paused items ahead of it). Returns
 * the dequeued item plus the remaining queue. When nothing is runnable, `item`
 * is null and `remaining` is the queue unchanged.
 */
export function takeNextRunnableQueueItem(queue: QueuedItem[]): {
	item: QueuedItem | null;
	remaining: QueuedItem[];
} {
	const index = firstRunnableQueueIndex(queue);
	if (index < 0) return { item: null, remaining: queue };
	return {
		item: queue[index],
		remaining: [...queue.slice(0, index), ...queue.slice(index + 1)],
	};
}

/**
 * Whether a message submitted right now would have work ahead of it in this
 * agent's order: a tab mid-turn (including a closed-but-still-thinking orphan),
 * or an item already waiting in the queue.
 *
 * This is the ORDERING question, deliberately separate from the fuller
 * queue-vs-dispatch decision in `useInputProcessing`, which also weighs
 * read-only parallelism and forced-parallel overrides. Those only matter to
 * something that spawns a local turn. A cross-agent mention-only message spawns
 * nothing, so the single thing that decides whether it waits is whether the user
 * put work in front of it.
 *
 * `autoRunActive` comes from the batch store rather than the session (Auto Run
 * runs in isolation and never marks the agent busy), so callers pass it in.
 */
export function hasWorkAheadOfNewMessage(
	session: Session,
	opts: { autoRunActive?: boolean } = {}
): boolean {
	if (opts.autoRunActive) return true;
	if (getBusyTabs(session, { includeOrphans: true }).length > 0) return true;
	return (session.executionQueue ?? []).some(
		(item) => item.waitingForConnection || !!item.awaitingConsult || isRunnableQueueItem(item)
	);
}

/**
 * Release the busy state a dequeue took, without re-queueing anything: the
 * inverse of {@link applyQueuedItemDispatch}'s state half.
 *
 * The agent only returns to idle when no OTHER tab is still working - a
 * multi-tab agent can have a turn running elsewhere, and blanking the session
 * state would strand its thinking pill.
 *
 * Used wherever a dequeued item ends without a process to close it out: a
 * dispatch that threw before spawning, and a cross-agent mention-only item,
 * which fires its consult and by design never spawns a local turn.
 */
export function applyQueuedItemRelease(session: Session, tabId: string | undefined): Session {
	const releaseTab = <T extends { id: string; state?: string; thinkingStartTime?: number }>(
		tab: T
	): T => (tab.id === tabId ? { ...tab, state: 'idle', thinkingStartTime: undefined } : tab);

	const aiTabs = session.aiTabs.map(releaseTab);
	const orphans = session.orphanedThinkingTabs?.map(releaseTab);
	const stillWorking =
		aiTabs.some((tab) => tab.state === 'busy') || !!orphans?.some((tab) => tab.state === 'busy');

	return {
		...session,
		aiTabs,
		...(orphans && { orphanedThinkingTabs: orphans }),
		...(stillWorking
			? {}
			: {
					state: 'idle' as SessionState,
					busySource: undefined,
					thinkingStartTime: undefined,
				}),
	};
}

/**
 * The state transition for a dequeued item whose dispatch THREW before the
 * agent process ever spawned: the exact inverse of
 * {@link applyQueuedItemDispatch}.
 *
 * This is the one place that decides what happens to a prompt that was taken
 * out of the queue and then failed to send, because the alternative - each
 * dispatch site writing its own recovery - is what lost a user's work. Five of
 * the eight sites had no recovery at all (the process-exit drain and the batch
 * drain rejected into nothing; Stop and force-kill logged and moved on), so a
 * spawn collision silently destroyed the message: the queue no longer held it,
 * the transcript showed a card for it, and no model had ever seen it.
 *
 * Three things happen together, and they only make sense together:
 *
 * 1. **The tab is released.** Dispatch marked it busy; nothing is running.
 * 2. **The card is removed.** The user-visible entry is appended BEFORE the
 *    spawn, so a failed dispatch leaves a card for a prompt that was never
 *    delivered. Matching is by `queuedItemId`, not by text, so an identical
 *    message the user genuinely sent earlier is untouched.
 * 3. **The item goes back to the head of the queue** - so it keeps its place
 *    ahead of everything queued behind it - unless it is already there. The
 *    idempotence matters: `retryStore.holdFailedItemInQueue` parks the failed
 *    turn in the queue for the life of an outage, and a second copy would
 *    double-send the prompt when the outage cleared.
 *
 * `hold` decides whether the item comes back runnable. A spawn collision (the
 * tab's previous process has not exited yet) is transient and self-correcting,
 * so the item stays runnable and the next drain trigger sends it a moment
 * later (bounded by {@link noteSpawnCollision}, since an old process that never
 * releases its key would otherwise collide forever). Any OTHER failure would
 * fail again the same way on the next tick, so
 * the item comes back `paused`: still there, still editable, still one click
 * from Force Send, but not spinning the queue against a wall.
 */
export function applyQueuedItemDispatchFailure(
	session: Session,
	item: QueuedItem,
	opts: { hold: boolean }
): Session {
	const released = applyQueuedItemRelease(session, item.tabId);

	const stripCard = <T extends { id: string; logs: LogEntry[] }>(tab: T): T =>
		tab.logs.some((log) => log.queuedItemId === item.id)
			? { ...tab, logs: tab.logs.filter((log) => log.queuedItemId !== item.id) }
			: tab;

	const aiTabs = released.aiTabs.map(stripCard);
	const orphans = released.orphanedThinkingTabs?.map(stripCard);

	// A message that @mentions another agent placed a consult hold when it
	// dispatched. Its turn never started, so that hold has nothing to finish -
	// and the restored item places a fresh one when it dispatches again.
	const queue = item.crossAgentMention
		? dropConsultHold(released.executionQueue ?? [], item.tabId)
		: (released.executionQueue ?? []);
	const restored: QueuedItem = opts.hold ? { ...item, paused: true } : item;
	const executionQueue = queue.some((i) => i.id === item.id)
		? queue.map((i) => (i.id === item.id ? restored : i))
		: [restored, ...queue];

	return {
		...released,
		aiTabs,
		...(orphans && { orphanedThinkingTabs: orphans }),
		executionQueue,
	};
}

/**
 * How many spawn collisions a queued item may hit before it is treated as a
 * real failure (held, with an error frame) instead of a transient one.
 */
export const SPAWN_COLLISION_MAX_ATTEMPTS = 6;

/** First back-off after a collision; doubles per attempt (1s, 2s, 4s, ...). */
export const SPAWN_COLLISION_BASE_DELAY_MS = 1000;

/**
 * Spawn collisions per queued item id. Module state on purpose: it is timing
 * bookkeeping for a retry in flight, not part of the item, so it must not be
 * persisted with the queue or survive a restart (a restart frees every key).
 */
const spawnCollisions = new Map<string, { count: number; retryAt: number }>();

/**
 * Record that dispatching `itemId` was refused because its tab's previous
 * process still owns the process key, and return how many times that has now
 * happened.
 *
 * {@link applyQueuedItemDispatchFailure} treats a collision as transient and
 * returns the item runnable, which is right when the old process is a moment
 * from exiting (Stop dispatches the next item before the interrupted child is
 * gone). It is wrong when the old entry never clears: the refused dispatch
 * restores the very queue state that triggers the next drain, so the queue
 * re-dispatched into the same refusal on every render, about 14 times a second,
 * and the tab sat on "Thinking... 0m 0s" forever. Counting bounds that: the
 * drain waits out a doubling back-off, and after
 * {@link SPAWN_COLLISION_MAX_ATTEMPTS} the caller holds the item instead.
 */
export function noteSpawnCollision(itemId: string, now: number = Date.now()): number {
	const count = (spawnCollisions.get(itemId)?.count ?? 0) + 1;
	const delay = SPAWN_COLLISION_BASE_DELAY_MS * 2 ** (count - 1);
	spawnCollisions.set(itemId, { count, retryAt: now + delay });
	return count;
}

/**
 * Milliseconds until a collided item may be dispatched again by the drain
 * poll, or 0 when it is free to go. Only the poll honours this: a real process
 * exit, Stop, and Force Send are edges that prove (or override) the old owner
 * being gone, so they dispatch regardless.
 */
export function spawnCollisionCooldownMs(itemId: string, now: number = Date.now()): number {
	const entry = spawnCollisions.get(itemId);
	return entry ? Math.max(0, entry.retryAt - now) : 0;
}

/** Forget an item's collisions: it dispatched, or it was held for the user. */
export function clearSpawnCollision(itemId: string): void {
	spawnCollisions.delete(itemId);
}

/** Test-only: drop all collision bookkeeping. */
export function resetSpawnCollisionsForTest(): void {
	spawnCollisions.clear();
}

/**
 * Move a queued item to a new position and return the resulting queue.
 *
 * `fromIndex`/`toIndex` follow Array.splice semantics (remove at fromIndex,
 * insert at toIndex). When `tabId` is given, the indices address only that tab's
 * items as shown in the filtered inline chat list: those items are reordered
 * among themselves and written back to their original slots, so queued items
 * belonging to other tabs keep their absolute positions. Without `tabId` the
 * whole queue is reordered. Out-of-range or no-op moves return the queue
 * unchanged (same reference).
 */
export function reorderQueueItem(
	queue: QueuedItem[],
	fromIndex: number,
	toIndex: number,
	tabId?: string
): QueuedItem[] {
	if (!tabId) {
		const len = queue.length;
		if (
			fromIndex === toIndex ||
			fromIndex < 0 ||
			fromIndex >= len ||
			toIndex < 0 ||
			toIndex >= len
		) {
			return queue;
		}
		const next = [...queue];
		const [removed] = next.splice(fromIndex, 1);
		next.splice(toIndex, 0, removed);
		return next;
	}

	// Tab-scoped reorder: collect this tab's items and the slots they occupy.
	const slots: number[] = [];
	const items: QueuedItem[] = [];
	queue.forEach((item, i) => {
		if (item.tabId === tabId) {
			slots.push(i);
			items.push(item);
		}
	});
	const len = items.length;
	if (fromIndex === toIndex || fromIndex < 0 || fromIndex >= len || toIndex < 0 || toIndex >= len) {
		return queue;
	}
	const reordered = [...items];
	const [removed] = reordered.splice(fromIndex, 1);
	reordered.splice(toIndex, 0, removed);
	const next = [...queue];
	slots.forEach((pos, idx) => {
		next[pos] = reordered[idx];
	});
	return next;
}

/**
 * Whether a queued item can take part in a merge. Only plain messages qualify:
 * a command has no prompt body to join, a leading-`@mention` message is
 * answered by another agent rather than this one, and a consult hold is a turn
 * already underway.
 */
function isMergeableQueueItem(item: QueuedItem): boolean {
	return item.type === 'message' && !item.crossAgentOnly && !item.awaitingConsult;
}

/**
 * The item a "merge into the message above" would fold `itemId` into: the
 * nearest EARLIER item for the same tab, since that is the card drawn directly
 * above it in the tab's queue. Null when there is none, or when either side is
 * not a plain message (see {@link isMergeableQueueItem}).
 */
export function findQueuedMergeTarget(queue: QueuedItem[], itemId: string): QueuedItem | null {
	const index = queue.findIndex((i) => i.id === itemId);
	if (index <= 0) return null;
	const item = queue[index];
	if (!isMergeableQueueItem(item)) return null;
	for (let i = index - 1; i >= 0; i--) {
		if (queue[i].tabId !== item.tabId) continue;
		return isMergeableQueueItem(queue[i]) ? queue[i] : null;
	}
	return null;
}

/**
 * Fold queued message `itemId` into the message above it (see
 * {@link findQueuedMergeTarget}) and return the resulting queue. The target
 * keeps its id, place, hold state, and frozen model/effort, since it is the
 * turn that runs first; the merged item's text is appended after a blank line
 * and its images after the target's. A mention in either message survives, as
 * dispatch re-plans the consult from the merged text. Returns null when the item
 * cannot be merged.
 */
export function mergeQueuedItemIntoPrevious(
	queue: QueuedItem[],
	itemId: string
): { queue: QueuedItem[]; targetId: string } | null {
	const target = findQueuedMergeTarget(queue, itemId);
	const item = queue.find((i) => i.id === itemId);
	if (!target || !item) return null;
	// Exactly one blank line between the two, so the second reads as its own
	// paragraph: trailing whitespace of the first and leading blank lines of the
	// second are dropped (the second's own indentation is kept).
	const text = [target.text?.replace(/\s+$/, ''), item.text?.replace(/^(\s*\n)+/, '')]
		.filter((t) => t && t.trim())
		.join('\n\n');
	const images = [...(target.images ?? []), ...(item.images ?? [])];
	const merged: QueuedItem = {
		...target,
		text,
		images: images.length > 0 ? images : undefined,
		crossAgentMention: target.crossAgentMention || item.crossAgentMention || undefined,
	};
	return {
		queue: queue.filter((i) => i.id !== itemId).map((i) => (i.id === target.id ? merged : i)),
		targetId: target.id,
	};
}

/**
 * The label to show for a queued item's target tab.
 *
 * `item.tabName` is a SNAPSHOT frozen when the item was queued, so an item
 * queued into a brand-new tab keeps reading "New" forever - including after
 * auto-naming gave that tab a real title, and even next to a LATER item on the
 * same tab that does carry the name. The queue is exactly where the user decides
 * what to reorder, so two entries for one tab must not look like two tabs.
 *
 * Resolution mirrors {@link resolveQueuedItemTarget}: the live tab first, then a
 * closed-but-still-draining orphan, and only then the snapshot - which by that
 * point is the last thing we ever knew about a tab that is gone.
 */
export function resolveQueuedItemTabName(
	session: Session,
	item: Pick<QueuedItem, 'tabId' | 'tabName'>
): string | undefined {
	if (item.tabId) {
		const tab =
			session.aiTabs?.find((t) => t.id === item.tabId) ??
			session.orphanedThinkingTabs?.find((t) => t.id === item.tabId);
		if (tab) return getTabDisplayName(tab);
	}
	return item.tabName;
}

// ============================================================================
// Force Send - dispatching one specific queued item out of turn
// ============================================================================

/** Minimal identity of a tab that is mid-turn, for Force Send copy. */
export interface BusyTabSummary {
	id: string;
	displayName: string;
}

export interface QueueBusyContext {
	/** The item's own target tab is already running a turn. */
	targetTabBusy: boolean;
	/** Other tabs in the same agent that are mid-turn right now. */
	otherBusyTabs: BusyTabSummary[];
}

/**
 * Busy-state snapshot for one queued item: whether its own tab is mid-turn, and
 * which OTHER tabs of the same agent are. Both Force Send surfaces (the inline
 * chat list and the Execution Queue browser) derive eligibility from this, so
 * they cannot drift on what "safe to send right now" means.
 */
export function getQueueBusyContext(
	session: Session,
	item: Pick<QueuedItem, 'tabId'>
): QueueBusyContext {
	const tabs = session.aiTabs ?? [];
	const targetTab = tabs.find((t) => t.id === item.tabId);
	return {
		targetTabBusy: targetTab?.state === 'busy',
		otherBusyTabs: tabs
			.filter((t) => t.id !== item.tabId && t.state === 'busy')
			.map((t) => ({ id: t.id, displayName: getTabDisplayName(t) })),
	};
}

/** Why a queued item cannot be force sent right now. */
export type ForceSendBlockedReason =
	| 'no-target-tab'
	| 'target-tab-busy'
	| 'needs-forced-parallel'
	| 'awaiting-consult';

export interface ForceSendEligibility extends QueueBusyContext {
	/** Sending now means running alongside another tab's in-flight turn. */
	requiresParallel: boolean;
	canForce: boolean;
	blockedReason?: ForceSendBlockedReason;
}

/**
 * Whether a queued item can be dispatched out of turn, and what that would mean.
 *
 * A tab runs at most one turn at a time, so an item whose own tab is busy can
 * never be forced. Sending while a *different* tab of the same agent is working
 * breaks the sequential-per-agent rule that keeps two turns off the same files,
 * so that case stays gated behind the Forced Parallel Execution setting. Every
 * other case (jumping the queue order, releasing a held item) is always allowed.
 */
export function getForceSendEligibility(
	session: Session,
	item: Pick<QueuedItem, 'tabId' | 'awaitingConsult'>,
	opts: { forcedParallelEnabled: boolean }
): ForceSendEligibility {
	const busy = getQueueBusyContext(session, item);
	const requiresParallel = busy.otherBusyTabs.length > 0;
	// A consult hold has nothing to send yet: its text is the reply, which has not
	// arrived. Forcing it would hand the agent an empty continuation.
	const blockedReason: ForceSendBlockedReason | undefined = item.awaitingConsult
		? 'awaiting-consult'
		: !resolveQueuedItemTarget(session, item)
			? 'no-target-tab'
			: busy.targetTabBusy
				? 'target-tab-busy'
				: requiresParallel && !opts.forcedParallelEnabled
					? 'needs-forced-parallel'
					: undefined;
	return { ...busy, requiresParallel, canForce: !blockedReason, blockedReason };
}

/**
 * Whether a Force Send control should be RENDERED at all, given its eligibility.
 *
 * Separate from {@link ForceSendEligibility.canForce}, which decides whether the
 * control is enabled. Two of the three blocked reasons are dead ends the user
 * cannot act on from the card: an item with no tab left to run on could never be
 * sent, and an item whose own tab is already mid-turn is simply waiting its turn
 * - a tab runs one turn at a time, so the wait resolves itself and offering
 * "Force Send" there reads as a control that refuses to work. Only
 * `needs-forced-parallel` stays visible (dimmed), because clicking it opens
 * ForcedParallelRequiredModal, which links straight to the setting that unlocks it.
 *
 * Both Force Send surfaces (the inline QUEUED card and the Execution Queue
 * browser) call this, so they cannot drift on when the button exists.
 */
export function shouldOfferForceSend(
	eligibility: ForceSendEligibility | null | undefined
): boolean {
	if (!eligibility) return false;
	return (
		eligibility.blockedReason !== 'no-target-tab' &&
		eligibility.blockedReason !== 'target-tab-busy' &&
		eligibility.blockedReason !== 'awaiting-consult'
	);
}

/**
 * The tooltip a Force Send control shows, given its eligibility.
 *
 * Both surfaces that offer Force Send - the Execution Queue modal and the
 * inline QUEUED card in the AI chat - must say the same thing about the same
 * state, so the copy lives with the decision rather than beside each button. A
 * blocked button whose tooltip does not explain the block is just a dead
 * control, which is the failure this whole path is fixing.
 */
export function getForceSendTitle(eligibility: ForceSendEligibility): string {
	const otherBusyCount = eligibility.otherBusyTabs.length;
	switch (eligibility.blockedReason) {
		case 'target-tab-busy':
			return 'This tab is already working - the message runs when the current turn finishes';
		case 'needs-forced-parallel':
			return 'Another tab in this agent is working. Forced Parallel Execution is off - click to turn it on in Settings.';
		case 'no-target-tab':
			return 'This message has no tab left to run on';
		case 'awaiting-consult':
			return 'Waiting for the consulted agent to reply - this runs as soon as it does';
		default:
			return eligibility.requiresParallel
				? `Send now, running in parallel with ${otherBusyCount} other working tab${otherBusyCount === 1 ? '' : 's'}`
				: 'Send this message now, ahead of the rest of the queue';
	}
}

/** Why a queued message cannot be steered into the running turn right now. */
export type SteerBlockedReason =
	| 'no-target-tab'
	| 'tab-not-working'
	| 'not-claude'
	| 'codex-exec'
	| 'api-token-source'
	| 'nothing-to-type'
	| 'has-images'
	| 'awaiting-consult'
	| 'cross-agent-mention'
	| 'has-agent-context'
	| 'too-long'
	| 'paused'
	| 'waiting-for-connection'
	| 'ssh-remote'
	| 'steer-in-flight'
	| 'tui-command-prefix'
	| 'read-only';

export interface SteerEligibility {
	canSteer: boolean;
	blockedReason?: SteerBlockedReason;
}

function findQueueTargetTab(session: Session, tabId: string): AITab | undefined {
	return (
		session.aiTabs?.find((tab) => tab.id === tabId) ??
		session.orphanedThinkingTabs?.find((tab) => tab.id === tabId)
	);
}

/**
 * Whether `item` would run read-only if dispatched now. Mirrors the dispatch rule
 * in agentStore.processQueuedItem: the item's own flag, or the target tab's
 * current read-only setting.
 */
function queuedItemWantsReadOnly(
	session: Session,
	tabId: string,
	item: Pick<QueuedItem, 'readOnlyMode'>
): boolean {
	const tab = findQueueTargetTab(session, tabId);
	return (
		item.readOnlyMode === true || tab?.readOnlyMode === true || tab?.permissionMode === 'readonly'
	);
}

/**
 * Whether the turn running on `tabId` is KNOWN to be read-only, read from the
 * user entry that started it (stamped `readOnly` at send). Unknown counts as not
 * read-only: the cost is a Steer button that is not offered, never a message run
 * with more access than the user gave it.
 */
function runningTurnIsReadOnly(session: Session, tabId: string): boolean {
	const logs = findQueueTargetTab(session, tabId)?.logs ?? [];
	for (let i = logs.length - 1; i >= 0; i -= 1) {
		if (logs[i].source === 'user') return logs[i].readOnly === true;
	}
	return false;
}

/**
 * Whether a queued message can be STEERED into the turn already running on its
 * tab, rather than waiting for that turn to finish.
 *
 * The inverse of {@link getForceSendEligibility} on the one condition that
 * matters: Force Send needs the target tab IDLE (a tab runs one turn at a time),
 * while steering needs it BUSY, because there has to be a turn in flight to steer.
 * The two are mutually exclusive by construction, which is what lets a queued card
 * offer exactly one of them.
 *
 * Only a Claude turn on the INTERACTIVE token source can be steered, and that is a
 * hard physical limit rather than a policy: `claude --print` closes stdin and holds
 * no writable PTY for the length of the turn, so there is nothing to type into.
 * See src/shared/chatSteering.ts. The one other steerable provider is a Codex agent
 * opted into the app-server transport (`turn/steer`); see
 * docs/agent-guides/CODEX-APP-SERVER.md.
 *
 * `dynamic` mode is the interesting case and the reason this reads
 * `session.claudeInteractive.mode` rather than the configured token mode. A dynamic
 * agent starts interactive and falls back to API when usage crosses the limit
 * threshold, so the CONFIGURED value cannot say which shape the turn in flight
 * actually has - only the RESOLVED value can, and the spawner writes it there after
 * every spawn. Two limits on that, both deliberate rather than overlooked: it is
 * recorded per AGENT, so with two tabs spawned in different modes it describes the
 * most recent spawn; and it is absent until an agent has spawned at least once.
 *
 * Neither is worth guessing around, because this predicate decides whether to SHOW
 * a control, and the truth is established at the moment it is used: maestro-p opens
 * a steering channel only for a local interactive turn, so a steer against a turn
 * that is really on API finds nothing listening and comes back `refused` with
 * `not-running`, leaving the message queued. Being wrong here costs a button that
 * declines with a reason; being wrong the other way hides a working feature.
 */
export function getSteerEligibility(
	session: Session,
	item: Pick<
		QueuedItem,
		| 'tabId'
		| 'text'
		| 'images'
		| 'awaitingConsult'
		| 'crossAgentMention'
		| 'agentContext'
		| 'paused'
		| 'waitingForConnection'
		| 'readOnlyMode'
	>
): SteerEligibility {
	const target = resolveQueuedItemTarget(session, item);
	if (!target) {
		return { canSteer: false, blockedReason: 'no-target-tab' };
	}
	// Busy-ness comes from the SAME helper Force Send reads, so the two controls
	// cannot disagree about whether a tab is mid-turn - which would let a card offer
	// both, or neither.
	if (!getQueueBusyContext(session, item).targetTabBusy) {
		return { canSteer: false, blockedReason: 'tab-not-working' };
	}
	// The turn runs on another host: a Claude TUI there has no local socket, and an
	// SSH Codex turn always runs on exec. Main would refuse every attempt, so the
	// button would be a control that can only decline.
	if (isSessionRemote(session)) return { canSteer: false, blockedReason: 'ssh-remote' };
	if (session.toolType === 'codex') {
		// A Codex turn is steerable only on the opt-in app-server transport, which
		// accepts `turn/steer` while a turn runs. `codex exec` (the default) accepts
		// nothing once the turn has started. An app-server agent can still run a
		// given turn on exec (SSH, images); main answers that steer `refused` with
		// `not-running`, so the routing is not re-derived here.
		if (resolveCodexTransport(session) !== 'app-server') {
			return { canSteer: false, blockedReason: 'codex-exec' };
		}
	} else if (session.toolType !== 'claude-code') {
		return { canSteer: false, blockedReason: 'not-claude' };
	} else if (session.claudeInteractive?.mode !== 'interactive') {
		return { canSteer: false, blockedReason: 'api-token-source' };
	}
	// Steering TYPES text into the composer, so an item with nothing to type has
	// nothing to steer with.
	if (!item.text?.trim()) return { canSteer: false, blockedReason: 'nothing-to-type' };
	// A paused item is held on purpose: by the user, or by the steer path itself
	// after an unconfirmed delivery (where steering it again types it twice). The
	// card's play button is the way out, not Steer.
	if (item.paused) return { canSteer: false, blockedReason: 'paused' };
	// Steering a Claude turn TYPES into its TUI, where a leading `/` opens the
	// slash-command menu (Enter would run `/clear` or `/compact` mid-turn) and a
	// leading `!` switches the editor to bash mode. Neither is the message the user
	// queued, so it waits and dispatches normally. Codex receives `turn/steer` as
	// plain input, so it is unaffected.
	if (session.toolType === 'claude-code' && startsWithTuiCommandPrefix(item.text)) {
		return { canSteer: false, blockedReason: 'tui-command-prefix' };
	}
	if (item.waitingForConnection) {
		return { canSteer: false, blockedReason: 'waiting-for-connection' };
	}
	// Steering types into a process spawned with the permissions of the turn
	// ALREADY running; nothing re-applies the queued message's own. A read-only
	// message dispatched normally spawns read-only, so steering it into a turn
	// that started with full access would run it with access the user took away.
	// Allowed only when the running turn is known to be read-only too.
	if (
		queuedItemWantsReadOnly(session, target.tabId, item) &&
		!runningTurnIsReadOnly(session, target.tabId)
	) {
		return { canSteer: false, blockedReason: 'read-only' };
	}
	// An item carrying images cannot be steered without LOSING them. Images reach a
	// maestro-p turn as `@/path` mentions translated from a stream-json envelope on
	// stdin (see stream-json-input.ts), and stdin is long closed by the time a turn is
	// running - there is no way to attach a file to a turn already in flight. Typing
	// the text alone would silently discard what the user attached, so the item stays
	// queued and sends intact when the turn ends.
	if (item.images?.length) return { canSteer: false, blockedReason: 'has-images' };
	// The three below are items whose dispatch does MORE than send their text, so
	// typing the text into the running turn would quietly drop the rest. A consult
	// hold has nothing to type yet: its text is a placeholder until the reply lands.
	if (item.awaitingConsult) return { canSteer: false, blockedReason: 'awaiting-consult' };
	// A queued `@mention` fires its consult when processQueuedItem dispatches it.
	// Steering bypasses that path, so the mention would reach claude as plain text
	// and the mentioned agent would never be asked.
	if (item.crossAgentMention) return { canSteer: false, blockedReason: 'cross-agent-mention' };
	// A released hold carries the consult's replies in agentContext, which only the
	// spawn prepends. Typing the visible text alone would lose the replies.
	if (item.agentContext) return { canSteer: false, blockedReason: 'has-agent-context' };
	// Over the per-frame cap maestro-p accepts; it would be refused, so it waits and
	// sends normally instead. Same predicate as the client and server.
	if (steeringTextTooLong(item.text)) return { canSteer: false, blockedReason: 'too-long' };
	return { canSteer: true };
}

/**
 * Whether a Steer control should be RENDERED at all, given its eligibility.
 *
 * Same split as {@link shouldOfferForceSend}, for the same reason, and here EVERY
 * blocked reason hides the control rather than dimming it. None of them is
 * something the user can act on from a queued card: a tab that is not working has
 * no turn to steer (and will start this very message shortly), a non-Claude agent
 * can never steer, a Codex agent on `codex exec` cannot be reached mid-turn (the
 * transport is an agent setting, not something to flip from a queued card), and an
 * API-source turn has no PTY. A dimmed button whose
 * tooltip amounts to "not right now" is exactly the dead control the Force Send
 * work was fixing.
 *
 * So there is no `visible-but-disabled` case today. Keep this function anyway:
 * it is the seam a future reason with an actionable remedy (the way
 * `needs-forced-parallel` names a setting) would hook into, and both surfaces
 * already call it.
 */
export function shouldOfferSteer(eligibility: SteerEligibility | null | undefined): boolean {
	return !!eligibility?.canSteer;
}

/**
 * Why a steer was declined, as a sentence for the user. A Record rather than a
 * switch so a new {@link SteerBlockedReason} fails to compile until it is worded.
 *
 * The Steer button never needs this: it is hidden for every blocked reason (see
 * {@link shouldOfferSteer}). A keyboard steer has no control to hide, so it has
 * to say why nothing happened.
 */
const STEER_BLOCKED_DETAILS: Record<SteerBlockedReason, string> = {
	'no-target-tab': 'The tab this message was queued on is gone.',
	'tab-not-working': 'No turn is running on this tab, so there is nothing to steer.',
	'not-claude': 'This provider cannot take a message while a turn is running.',
	'codex-exec':
		'This Codex agent runs on the exec transport. Set Codex Transport to app server to steer it.',
	'api-token-source':
		'This turn is running on the API token source, which takes no input until it ends.',
	'nothing-to-type': 'The message has no text to steer with.',
	'has-images': 'Images cannot be attached to a turn that is already running.',
	'awaiting-consult': 'The message is waiting on a consult reply.',
	'cross-agent-mention': 'An @mention only reaches the other agent on a normal send.',
	'has-agent-context': 'The message carries consult replies that only a normal send delivers.',
	'too-long': `${STEERING_TOO_LONG_DETAIL[0].toUpperCase()}${STEERING_TOO_LONG_DETAIL.slice(1)}.`,
	paused: 'The message is paused. Resume it from its queued card.',
	'waiting-for-connection': 'The message is waiting for the agent to reconnect.',
	'ssh-remote': 'A turn on an SSH remote cannot be steered.',
	'steer-in-flight': 'A steer for this message is already waiting for an answer.',
	'tui-command-prefix':
		'A message that starts with / or ! would run as a command in the running turn.',
	'read-only': 'The message is read-only and the running turn is not.',
};

const STEER_BLOCKED_FALLBACK = 'The running turn cannot take this message right now.';

/**
 * The sentence for one blocked reason. Takes a string because the reason crosses
 * a process boundary as one (`QueueSteerResult.blockedReason`).
 */
export function describeSteerBlocked(reason: string | undefined): string {
	return reason && Object.prototype.hasOwnProperty.call(STEER_BLOCKED_DETAILS, reason)
		? STEER_BLOCKED_DETAILS[reason as SteerBlockedReason]
		: STEER_BLOCKED_FALLBACK;
}

/**
 * State transition for dispatching ONE specific queued item now: drop it from the
 * queue, mark its target tab busy (which appends the user-visible log entry), and
 * put the agent in the busy/ai state. Returns the session untouched when the item
 * is already gone or has no tab left to run on.
 *
 * The target is resolved orphan-aware, so an item queued on a since-closed tab
 * still lands on that tab's background transcript rather than the active one.
 */
export function applyQueuedItemDispatch(session: Session, item: QueuedItem): Session {
	if (!session.executionQueue?.some((i) => i.id === item.id)) return session;
	const target = resolveQueuedItemTarget(session, item);
	if (!target) return session;

	const aiTabs = session.aiTabs.map((tab) =>
		tab.id === target.tabId ? markTabRunningQueuedItem(tab, item, session) : tab
	);
	const orphans =
		target.location === 'orphan' && session.orphanedThinkingTabs
			? session.orphanedThinkingTabs.map((tab) =>
					tab.id === target.tabId ? markTabRunningQueuedItem(tab, item, session) : tab
				)
			: session.orphanedThinkingTabs;

	return {
		...session,
		state: 'busy' as SessionState,
		busySource: 'ai',
		thinkingStartTime: Date.now(),
		currentCycleTokens: 0,
		currentCycleBytes: 0,
		executionQueue: session.executionQueue.filter((i) => i.id !== item.id),
		aiTabs,
		...(orphans !== session.orphanedThinkingTabs && { orphanedThinkingTabs: orphans }),
	};
}

// ============================================================================
// Replaying a turn the provider refused - not a queue dispatch
// ============================================================================

/**
 * Is this queued item the same ask as `item`?
 *
 * Used to stop a re-authentication replay from running a prompt the user has
 * ALREADY re-sent by hand. Both copies exist for one reason: the failed turn was
 * invisible, so the user resent it while the resume had the same prompt
 * snapshotted. Running both spends two full turns on one question and lands two
 * sets of edits in the repo.
 *
 * Compared on what the user actually typed - target tab, kind, text/command, and
 * attachment count - NOT on `id`, which is freshly generated per send and would
 * make every duplicate look distinct. The user's own copy is the one that wins:
 * it is visible, it is theirs, and the queue already owns its ordering.
 */
export function isSameQueuedPrompt(a: QueuedItem, b: QueuedItem): boolean {
	if (a.tabId !== b.tabId) return false;
	if (a.type !== b.type) return false;
	if ((a.text ?? '').trim() !== (b.text ?? '').trim()) return false;
	if ((a.command ?? '') !== (b.command ?? '')) return false;
	if ((a.commandArgs ?? '') !== (b.commandArgs ?? '')) return false;
	return (a.images?.length ?? 0) === (b.images?.length ?? 0);
}

/** The queued item that already carries this prompt, if the user re-sent it. */
export function findQueuedDuplicate(
	session: Pick<Session, 'executionQueue'>,
	item: QueuedItem
): QueuedItem | undefined {
	return session.executionQueue?.find((queued) => isSameQueuedPrompt(queued, item));
}

/** Why a replay was not dispatched. See {@link applyReplayDispatch}. */
export type ReplayBlockedReason = 'no-target-tab' | 'target-tab-busy' | 'already-queued';

export interface ReplayDispatchResult {
	/** The session to commit. Unchanged from the input when `blocked` is set. */
	session: Session;
	/** Set when nothing was dispatched - the caller must not spawn. */
	blocked?: ReplayBlockedReason;
}

/**
 * State transition for REPLAYING a turn that already failed: mark its target tab
 * busy and note in the transcript that the prompt went back out.
 *
 * Distinct from {@link applyQueuedItemDispatch} in two ways, both because the
 * item is not in the queue: nothing is dequeued, and no user bubble is appended
 * (the original send already wrote one - see {@link markTabRunningTurn}).
 *
 * Blocks rather than dispatching when:
 *  - the tab is gone (nothing to run on);
 *  - the tab is already mid-turn - a second spawn on one tab key makes the main
 *    process KILL the live one, so a replay must never race a running turn;
 *  - the user has already re-sent this exact prompt, which is queued and will
 *    drain on its own.
 */
export function applyReplayDispatch(
	session: Session,
	item: QueuedItem,
	noteText: string
): ReplayDispatchResult {
	const duplicate = findQueuedDuplicate(session, item);
	if (duplicate) return { session, blocked: 'already-queued' };

	const target = resolveQueuedItemTarget(session, item);
	if (!target) return { session, blocked: 'no-target-tab' };

	const targetTab =
		session.aiTabs.find((t) => t.id === target.tabId) ??
		session.orphanedThinkingTabs?.find((t) => t.id === target.tabId);
	if (targetTab?.state === 'busy') return { session, blocked: 'target-tab-busy' };

	const note: LogEntry = {
		id: generateId(),
		timestamp: Date.now(),
		source: 'system',
		text: noteText,
	};
	const running = applyResendRunning(session, item, (tab) => ({
		...tab,
		logs: [...tab.logs, note],
	}));
	return running ? { session: running } : { session, blocked: 'no-target-tab' };
}

/**
 * Put the agent and the target tab of a turn that is being SENT AGAIN into the
 * running state. Returns null when the item has no tab left to run on.
 *
 * Nothing is dequeued and no user bubble is appended: the original send already
 * wrote one (see {@link markTabRunningTurn}). Shared by the two resend paths, the
 * re-authentication replay ({@link applyReplayDispatch}) and Agent Resilience's
 * auto-retry (`retryStore.fireRetry`). `processQueuedItem` marks nothing busy -
 * its callers do - so a resend that skips this runs as a GHOST TURN: the provider
 * is working while the tab reads idle, the Thinking pill never lists it, and the
 * last thing on screen is whatever the failed attempt printed before it died.
 *
 * `decorateTab` runs on the target tab after it is marked running, for a caller
 * that also writes to the transcript.
 */
export function applyResendRunning(
	session: Session,
	item: QueuedItem,
	decorateTab: (tab: Session['aiTabs'][number]) => Session['aiTabs'][number] = (tab) => tab
): Session | null {
	const target = resolveQueuedItemTarget(session, item);
	if (!target) return null;

	const markRunning = (tab: Session['aiTabs'][number]) =>
		decorateTab(markTabRunningTurn(tab, item, session));

	const aiTabs = session.aiTabs.map((tab) => (tab.id === target.tabId ? markRunning(tab) : tab));
	const orphans =
		target.location === 'orphan' && session.orphanedThinkingTabs
			? session.orphanedThinkingTabs.map((tab) =>
					tab.id === target.tabId ? markRunning(tab) : tab
				)
			: session.orphanedThinkingTabs;

	return {
		...session,
		state: 'busy' as SessionState,
		busySource: 'ai',
		thinkingStartTime: Date.now(),
		currentCycleTokens: 0,
		currentCycleBytes: 0,
		aiTabs,
		...(orphans !== session.orphanedThinkingTabs && { orphanedThinkingTabs: orphans }),
	};
}
