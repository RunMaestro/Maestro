/**
 * Federation settings sync, the driver: every hosted agent's settings follow its host, and a
 * change made here reaches the host, which broadcasts it to every conductor.
 *
 * The host owns a hosted agent's settings (`lift-settings-sync.ts`). The peer mirror loads its
 * agents on connect and folds in every change the host broadcasts afterwards; this driver watches
 * the mirror and the two local copies a conductor can edit:
 *
 * - The pointer a lift left (`sessionStore`). Edit Agent, the bookmark, and `maestro-cli
 *   update-agent` (through the remote config handler) still edit it. A change made there is sent;
 *   a change made on the host is written onto it.
 * - Pending edits on a mirrored agent (`hostedAgentSettingsStore.pending`), saved from the
 *   mirror's settings editor (`saveHostedAgentSettings()`). They go out at once when the peer is
 *   connected, and wait for it otherwise.
 *
 * A field both sides changed, or one that differs on the first sync of an agent, is a conflict:
 * nothing moves until the person picks the host's value, theirs, or a merge
 * (`FederationSettingsConflictsModal`, `maestro-cli federation conflicts`). A host that refuses a
 * change keeps its value, and it comes back here with a toast. A peer that is down holds every
 * change for later; the connection coming back runs the sync again.
 *
 * One writer: only the lifecycle owner runs it (`useLiftedAgentSettingsSync`). The pointer's
 * agreed state (the baseline) is kept per agent in this window's local storage.
 */

import {
	applyLiftSyncPull,
	buildLiftPeerIdMap,
	describeFederationFields,
	fromStored,
	liftSyncAgentValues,
	liftSyncPendingIds,
	overlaySyncValues,
	planLiftedSettingsSync,
	readLiftSyncBaseline,
	settleLiftSyncBaseline,
	toStored,
	type LiftPeerIdMap,
	type LiftSyncBaseline,
	type LiftSyncEcho,
	type LiftSyncPlan,
	type LiftSyncPush,
} from '../../shared/maestro-lib/agents/lift-settings-sync';
import { readLiftedTo, type LiftedToPointer } from '../../shared/maestro-lib/agents/lift-pointer';
import { mirrorKey, type MirroredPeer } from '../../shared/maestro-lib/client/peer-mirror';
import type { ClientErrorCode } from '../../shared/maestro-lib/client/types';
import type {
	HostedSettingsConflictSummary,
	HostedSettingsReply,
	HostedSettingsRequest,
} from '../../shared/federationCommands';
import type { AgentRecord } from '../../shared/maestro-lib/store/records';
import type { Session } from '../types';
import { useSessionStore, updateSessionWith } from '../stores/sessionStore';
import { usePeerMirrorStore } from '../stores/peerMirrorStore';
import {
	useHostedAgentSettingsStore,
	type PendingHostedEdit,
} from '../stores/hostedAgentSettingsStore';
import { notifyToast } from '../stores/notificationStore';
import { safeStorageGet, safeStorageSet } from '../utils/safeLocalStorage';
import { callMirroredAgentAction, type MirroredActionAnswer } from './peerMirror';

const STORAGE_KEY = 'maestro:federation:lifted-settings-baseline:v1';
/** Coalesces a burst of store changes (a modal saving many fields) into one pass. */
const RUN_DELAY_MS = 250;
/** How long a sent value may take to come back in the host's record before the host's wins. */
const ECHO_WAIT_MS = 30_000;
/** Failures that say nothing about the value: the change is sent again once the peer is back. */
const TRANSIENT_CODES: ReadonlySet<ClientErrorCode> = new Set([
	'host-unavailable',
	'host-lost',
	'timeout',
	'unauthorized',
]);

type FailedAnswer = Extract<MirroredActionAnswer, { ok: false }>;

/** The baselines of the running sync, so a field's pending state reads what the sync agreed. */
let liveBaselines: Map<string, LiftSyncBaseline> | undefined;

function loadBaselines(): Map<string, LiftSyncBaseline> {
	const map = new Map<string, LiftSyncBaseline>();
	const raw = safeStorageGet(STORAGE_KEY);
	if (!raw) return map;
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!parsed || typeof parsed !== 'object') return map;
		for (const [agentId, value] of Object.entries(parsed as Record<string, unknown>)) {
			const baseline = readLiftSyncBaseline(value);
			if (baseline) map.set(agentId, baseline);
		}
	} catch {
		// A damaged entry only costs the baseline: the next pass compares the two records afresh.
	}
	return map;
}

function saveBaselines(map: Map<string, LiftSyncBaseline>): void {
	safeStorageSet(STORAGE_KEY, JSON.stringify(Object.fromEntries(map)));
}

/** A failure the sync should retry later, rather than give the host's value back. */
function isTransient(answer: FailedAnswer): boolean {
	// No code: the IPC call itself failed, so the host never saw it.
	return answer.code === undefined || TRANSIENT_CODES.has(answer.code);
}

/** The pushed field ids the host applied before it refused the rest of an `update-agent`. */
function appliedIds(push: LiftSyncPush, answer: FailedAnswer): string[] {
	return (answer.appliedFields ?? []).flatMap((field) => push.fieldIds?.[field] ?? []);
}

/** The field ids a pull writes, in the ids the plan uses. */
function pulledIds(plan: LiftSyncPlan): string[] {
	return [
		...Object.keys(plan.pull.agent),
		...Object.keys(plan.pull.env).map((key) => `env:${key}`),
	];
}

/** The mirrored agent and its peer a `mirrorKey()` names, while the peer is connected. */
function connectedHostAgent(
	peers: Readonly<Record<string, MirroredPeer>>,
	key: string
): { peer: MirroredPeer; host: AgentRecord } | undefined {
	for (const peer of Object.values(peers)) {
		if (peer.connection !== 'connected') continue;
		const host = peer.agents.find((agent) => mirrorKey(peer.peerId, agent.id) === key);
		if (host) return { peer, host };
	}
	return undefined;
}

/**
 * How this machine's agents name the agents of one host: every local agent lifted to `peerId`,
 * and the agents its mirror holds. Peer rows on a pointer are compared and sent through it.
 */
export function liftPeerIdMapFor(peerId: string): LiftPeerIdMap {
	const peer = usePeerMirrorStore.getState().peers[peerId];
	return buildLiftPeerIdMap(
		useSessionStore.getState().sessions as unknown as AgentRecord[],
		peerId,
		(peer?.agents ?? []).map((agent) => agent.id)
	);
}

/** The sync field ids of one hosted agent that wait: on the host (pending) or on a person. */
export interface HostedFieldState {
	pendingIds: string[];
	conflictIds: string[];
}

/**
 * What waits for one hosted agent (`mirrorKey()` of its host agent): the edits this machine made
 * that the host has not taken, and the fields in conflict. The settings badge and `maestro-cli
 * show agent --json` both read this.
 */
export function hostedFieldState(peerId: string, agentId: string): HostedFieldState {
	const key = mirrorKey(peerId, agentId);
	const store = useHostedAgentSettingsStore.getState();
	const resolved = store.resolutions[key] ?? {};
	const conflictIds = (store.conflicts[key]?.conflicts ?? [])
		.map((conflict) => conflict.id)
		.filter((id) => !resolved[id]);
	const pointer = liftedPointerFor(peerId, agentId);
	if (pointer) {
		const baseline = (liveBaselines ?? loadBaselines()).get(pointer.id);
		const pendingIds = liftSyncPendingIds(
			pointer as unknown as AgentRecord,
			baseline,
			liftPeerIdMapFor(peerId)
		).filter((id) => !conflictIds.includes(id));
		return { pendingIds, conflictIds };
	}
	return { pendingIds: Object.keys(store.pending[key]?.values ?? {}), conflictIds };
}

/** The lifted local agent that points at a host agent, if this machine holds one. */
export function liftedPointerFor(peerId: string, agentId: string): Session | undefined {
	return useSessionStore.getState().sessions.find((session) => {
		const pointer = readLiftedTo(session.liftedTo);
		return pointer?.peer === peerId && pointer.agentId === agentId;
	});
}

let scheduleSync: (() => void) | undefined;

/** Run a sync pass soon (after a resolution or a save). A no-op while the sync is not running. */
export function requestHostedSettingsSync(): void {
	scheduleSync?.();
}

/**
 * Save what the person set in the settings editor of a mirrored agent. The edit lands where this
 * machine keeps its copy of that agent: the lifted pointer when there is one, else the pending
 * edits. The sync then sends it (or holds it while the peer is down).
 */
export function saveHostedAgentSettings(
	peerId: string,
	host: AgentRecord,
	edited: AgentRecord
): void {
	const before = liftSyncAgentValues(host);
	const after = liftSyncAgentValues(edited);
	const ids = new Set([...Object.keys(before), ...Object.keys(after)]);
	const changed = [...ids].filter((id) => before[id] !== after[id]);

	const pointer = liftedPointerFor(peerId, host.id);
	if (pointer) {
		if (changed.length > 0) {
			const agent: Record<string, string | number | boolean | undefined> = {};
			const env: Record<string, string | undefined> = {};
			for (const id of changed) {
				if (id.startsWith('env:')) {
					const value = after[id];
					env[id.slice(4)] = typeof value === 'string' ? value : undefined;
				} else {
					agent[id] = after[id];
				}
			}
			// The editor names peers by the host's ids; the pointer keeps this machine's.
			const peerIds = liftPeerIdMapFor(peerId);
			updateSessionWith(
				pointer.id,
				(session) =>
					applyLiftSyncPull(
						session as unknown as AgentRecord,
						{ agent, env, tabs: {} },
						peerIds
					) as unknown as Session
			);
		}
		requestHostedSettingsSync();
		return;
	}

	const key = mirrorKey(peerId, host.id);
	const store = useHostedAgentSettingsStore.getState();
	const existing = store.pending[key];
	const values = { ...(existing?.values ?? {}) };
	const base = { ...(existing?.base ?? {}) };
	for (const id of ids) {
		if (before[id] === after[id]) continue;
		values[id] = toStored(after[id]);
		if (!(id in base)) base[id] = toStored(before[id]);
	}
	// A field set back to the host's value is no edit any more.
	for (const id of Object.keys(values)) {
		if (fromStored(values[id]) === before[id] && after[id] === before[id]) {
			delete values[id];
			delete base[id];
		}
	}
	const envKeys = Object.keys(values)
		.filter((id) => id.startsWith('env:'))
		.map((id) => id.slice(4));
	store.setPending(key, { values, base, envKeys });
	requestHostedSettingsSync();
}

/** The conflicts waiting for a person, as the CLI and the modal list them. */
export function listHostedSettingsConflicts(): HostedSettingsConflictSummary[] {
	const { conflicts, resolutions } = useHostedAgentSettingsStore.getState();
	return Object.entries(conflicts).map(([key, set]) => ({
		agent: key,
		peerId: set.peerId,
		agentId: set.agentId,
		agentName: set.agentName,
		// A field already settled here is no longer asked about; the next pass sends it.
		conflicts: set.conflicts.filter((conflict) => !resolutions[key]?.[conflict.id]),
	}));
}

/** `peer:agentId` (a `mirrorKey()`) back to its two parts, or undefined when it is not one. */
function parseMirrorKey(key: string): { peerId: string; agentId: string } | undefined {
	// An agent id holds no colon; a peer id might.
	const at = key.lastIndexOf(':');
	if (at <= 0 || at === key.length - 1) return undefined;
	return { peerId: key.slice(0, at), agentId: key.slice(at + 1) };
}

/**
 * Answer `maestro-cli federation conflicts|resolve` and the field states `show agent` reads
 * (asked by main through the window). A
 * resolution is the one the modal's buttons record, so the next sync pass carries it out.
 */
export function answerHostedSettingsRequest(request: HostedSettingsRequest): HostedSettingsReply {
	if (request.action === 'fields') {
		const target = parseMirrorKey(request.agent);
		if (!target) {
			return {
				success: false,
				error: `Name the hosted agent as peer:agent, not "${request.agent}".`,
			};
		}
		return {
			success: true,
			fields: describeFederationFields(hostedFieldState(target.peerId, target.agentId)),
		};
	}
	if (request.action === 'resolve') {
		const store = useHostedAgentSettingsStore.getState();
		const set = store.conflicts[request.agent];
		if (!set) {
			return { success: false, error: `No settings conflict for ${request.agent}.` };
		}
		const conflict = set.conflicts.find((entry) => entry.id === request.field);
		if (!conflict) {
			const fields = set.conflicts.map((entry) => entry.id).join(', ');
			return {
				success: false,
				error: `${request.agent} has no conflict on "${request.field}". Fields waiting: ${fields}.`,
			};
		}
		if (request.resolution.take === 'value' && !conflict.mergeable) {
			return {
				success: false,
				error: `${conflict.label} is not free text: take host or local instead.`,
			};
		}
		store.resolve(request.agent, request.field, request.resolution);
		requestHostedSettingsSync();
	}
	return { success: true, conflicts: listHostedSettingsConflicts() };
}

/**
 * Start syncing every hosted agent this machine edits. Answers the stop function. Call once, in
 * the window that owns app-wide side effects.
 */
export function startLiftedAgentSettingsSync(): () => void {
	const baselines = loadBaselines();
	liveBaselines = baselines;
	const awaiting = new Map<string, Record<string, LiftSyncEcho>>();
	const inFlight = new Set<string>();
	/** Conflict ids already announced per target, so a toast is raised once per new conflict. */
	const announced = new Map<string, Set<string>>();
	let rerun = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const echoTimers = new Set<ReturnType<typeof setTimeout>>();
	let disposed = false;

	const schedule = () => {
		if (disposed || timer) return;
		timer = setTimeout(() => {
			timer = undefined;
			runAll();
		}, RUN_DELAY_MS);
	};
	scheduleSync = schedule;

	const runAll = () => {
		const { sessions, sessionsReadOk } = useSessionStore.getState();
		// Before the registry is read, an empty list is not "no lifted agents".
		if (disposed || !sessionsReadOk) return;
		const peers = usePeerMirrorStore.getState().peers;
		const hosted = useHostedAgentSettingsStore.getState();
		const targets = new Set<string>();
		const lifted = new Set<string>();
		for (const session of sessions) {
			const pointer = readLiftedTo(session.liftedTo);
			if (!pointer) continue;
			lifted.add(session.id);
			const key = mirrorKey(pointer.peer, pointer.agentId);
			targets.add(key);
			if (inFlight.has(key)) {
				rerun = true;
				continue;
			}
			const peer = peers[pointer.peer];
			if (peer?.connection !== 'connected') continue;
			const host = peer.agents.find((agent) => agent.id === pointer.agentId);
			if (host) void syncPointer(session, pointer, host);
		}
		for (const [key, edit] of Object.entries(hosted.pending)) {
			if (targets.has(key)) continue;
			targets.add(key);
			if (inFlight.has(key)) {
				rerun = true;
				continue;
			}
			const found = connectedHostAgent(peers, key);
			if (found) void syncPending(key, found.peer, found.host, edit);
		}
		// Conflicts of an agent nothing here edits any more have nothing left to settle.
		for (const key of Object.keys(hosted.conflicts)) {
			if (!targets.has(key)) hosted.setConflicts(key, null);
		}
		let pruned = false;
		for (const agentId of [...baselines.keys()]) {
			if (lifted.has(agentId)) continue;
			baselines.delete(agentId);
			pruned = true;
		}
		if (pruned) saveBaselines(baselines);
	};

	const reportConflicts = (key: string, peerId: string, host: AgentRecord, plan: LiftSyncPlan) => {
		const store = useHostedAgentSettingsStore.getState();
		store.setConflicts(
			key,
			plan.conflicts.length > 0
				? { peerId, agentId: host.id, agentName: host.name, conflicts: plan.conflicts }
				: null
		);
		const seen = announced.get(key) ?? new Set<string>();
		const fresh = plan.conflicts.filter((conflict) => !seen.has(conflict.id));
		announced.set(key, new Set(plan.conflicts.map((conflict) => conflict.id)));
		if (fresh.length === 0) return;
		const firstSync = fresh.every((conflict) => conflict.firstSync);
		notifyToast({
			color: 'yellow',
			title: `${host.name}: settings differ from ${peerId}`,
			message: `${fresh.map((conflict) => conflict.label).join(', ')} ${
				firstSync ? 'differ from the host.' : 'changed here and on the host.'
			} Click to choose which to keep.`,
			onClick: () => useHostedAgentSettingsStore.getState().setConflictsOpen(true),
		});
	};

	const syncPointer = async (
		session: Session,
		pointer: LiftedToPointer,
		host: AgentRecord
	): Promise<void> => {
		const key = mirrorKey(pointer.peer, pointer.agentId);
		inFlight.add(key);
		let again = false;
		try {
			const now = Date.now();
			const echoes = liveEchoes(key, now);
			const resolutions = useHostedAgentSettingsStore.getState().resolutions[key];
			// The pointer names peers by this machine's ids; the host's ids are compared and sent.
			const peerIds = liftPeerIdMapFor(pointer.peer);
			const plan = planLiftedSettingsSync({
				local: session as unknown as AgentRecord,
				host,
				peerIds,
				baseline: baselines.get(session.id),
				awaiting: echoes,
				resolutions,
				now,
			});
			reportConflicts(key, pointer.peer, host, plan);
			if (plan.pulls) {
				updateSessionWith(
					session.id,
					(current) =>
						applyLiftSyncPull(
							current as unknown as AgentRecord,
							plan.pull,
							peerIds
						) as unknown as Session
				);
			}
			const outcome = await sendPushes(session.name, pointer.peer, pointer.agentId, plan, echoes);
			again = outcome.refused;
			// A merged value is pulled AND pushed: its pick stays until the host has taken it.
			const settled = [
				...outcome.settledIds,
				...pulledIds(plan).filter((id) => !(id in plan.pushed)),
			];
			useHostedAgentSettingsStore.getState().clearResolutions(key, settled);
			baselines.set(session.id, outcome.baseline);
			awaiting.set(key, echoes);
			saveBaselines(baselines);
		} finally {
			inFlight.delete(key);
			if (again || rerun) {
				rerun = false;
				schedule();
			}
		}
	};

	const syncPending = async (
		key: string,
		peer: MirroredPeer,
		host: AgentRecord,
		edit: PendingHostedEdit
	): Promise<void> => {
		inFlight.add(key);
		let again = false;
		try {
			const resolutions = useHostedAgentSettingsStore.getState().resolutions[key];
			const plan = planLiftedSettingsSync({
				local: overlaySyncValues(host, edit.values),
				host,
				baseline: { values: edit.base, envKeys: edit.envKeys },
				resolutions,
				now: Date.now(),
			});
			reportConflicts(key, peer.peerId, host, plan);
			const outcome = await sendPushes(host.name, peer.peerId, host.id, plan, {});
			again = outcome.refused;
			// What the host took, refused, or already holds is no pending edit any more.
			const done = new Set([
				...outcome.settledIds,
				...pulledIds(plan).filter((id) => !(id in plan.pushed)),
			]);
			const hostValues = liftSyncAgentValues(host);
			for (const id of Object.keys(edit.values)) {
				if (fromStored(edit.values[id]) === hostValues[id]) done.add(id);
			}
			const store = useHostedAgentSettingsStore.getState();
			store.clearResolutions(key, [...done]);
			const current = store.pending[key];
			if (current) {
				const values = { ...current.values };
				const base = { ...current.base };
				for (const id of done) {
					// An edit made again while this pass ran is newer than what it sent: keep it.
					if (values[id] !== edit.values[id]) continue;
					delete values[id];
					delete base[id];
				}
				store.setPending(key, { values, base, envKeys: current.envKeys });
			}
		} finally {
			inFlight.delete(key);
			if (again || rerun) {
				rerun = false;
				schedule();
			}
		}
	};

	const liveEchoes = (key: string, now: number): Record<string, LiftSyncEcho> =>
		Object.fromEntries(
			Object.entries(awaiting.get(key) ?? {}).filter(([, echo]) => echo.until > now)
		);

	/** Run the plan's host calls in order; stop at the first one the peer could not take. */
	const sendPushes = async (
		agentName: string,
		peerId: string,
		hostAgentId: string,
		plan: LiftSyncPlan,
		echoes: Record<string, LiftSyncEcho>
	): Promise<{ baseline: LiftSyncBaseline; refused: boolean; settledIds: string[] }> => {
		let baseline = plan.baseline;
		let refused = false;
		const settledIds: string[] = [];
		const expect = (ids: readonly string[]) => {
			const until = Date.now() + ECHO_WAIT_MS;
			for (const id of ids) {
				const entry = plan.pushed[id];
				if (entry) echoes[id] = { before: entry.host, until };
			}
			if (ids.length > 0) {
				// If the host's record never changes, the wait ends and the host's value is read again.
				const echoTimer = setTimeout(() => {
					echoTimers.delete(echoTimer);
					schedule();
				}, ECHO_WAIT_MS + RUN_DELAY_MS);
				echoTimers.add(echoTimer);
			}
		};
		for (const push of plan.pushes) {
			const answer = await callMirroredAgentAction(peerId, hostAgentId, push.action);
			if (!answer) break;
			if (answer.ok) {
				baseline = settleLiftSyncBaseline(plan, baseline, push.ids);
				settledIds.push(...push.ids);
				expect(push.ids);
				if (answer.result.kind === 'update-agent' && answer.result.notices?.length) {
					notifyToast({
						color: 'yellow',
						title: `${agentName} changed on ${peerId}`,
						message: answer.result.notices.join('\n'),
					});
				}
				continue;
			}
			if (isTransient(answer)) break;
			// Refused: every pushed field settles at the value sent, so next pass the host's value
			// reads as the change and comes back here. What the host did apply waits for its echo.
			refused = true;
			baseline = settleLiftSyncBaseline(plan, baseline, push.ids);
			settledIds.push(...push.ids);
			expect(appliedIds(push, answer));
			notifyToast({
				color: 'red',
				title: `${agentName}: host kept its settings`,
				message: `${answer.error} The agent shows the host's value again.`,
			});
		}
		return { baseline, refused, settledIds };
	};

	const offSessions = useSessionStore.subscribe((state, previous) => {
		if (state.sessions !== previous.sessions || state.sessionsReadOk !== previous.sessionsReadOk) {
			schedule();
		}
	});
	const offPeers = usePeerMirrorStore.subscribe((state, previous) => {
		if (state.peers !== previous.peers) schedule();
	});
	const offHosted = useHostedAgentSettingsStore.subscribe((state, previous) => {
		if (state.pending !== previous.pending || state.resolutions !== previous.resolutions) {
			schedule();
		}
	});
	schedule();

	return () => {
		disposed = true;
		if (scheduleSync === schedule) scheduleSync = undefined;
		if (liveBaselines === baselines) liveBaselines = undefined;
		offSessions();
		offPeers();
		offHosted();
		if (timer) clearTimeout(timer);
		for (const echoTimer of echoTimers) clearTimeout(echoTimer);
		echoTimers.clear();
	};
}
