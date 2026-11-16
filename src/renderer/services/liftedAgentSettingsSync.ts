/**
 * Federation settings sync, the driver: a lifted agent's settings stay the same here and on its
 * host, whichever side changes them.
 *
 * A lifted agent keeps its local pointer in the Left Bar, and every place a person changes an
 * agent's settings still edits that pointer: Edit Agent, the composer chips (model, effort,
 * read-only, thinking, save to History, Enter to send), the tab name and star, the bookmark, and
 * `maestro-cli update-agent`, which lands in `sessionStore` through the remote config handler.
 * This driver watches `sessionStore` and the peer mirror and hands both records of each lifted
 * agent to `planLiftedSettingsSync()`. A change made here goes to the host through the same
 * `federation:act` call the mirror's own controls use; a change the host reports comes back onto
 * the pointer. One writer: only the lifecycle owner runs it (`useLiftedAgentSettingsSync`).
 *
 * Failures, by kind:
 * - The peer is not connected, or the call dropped: nothing changes here, and the change goes out
 *   when the peer is back (the mirror's connection change runs the sync again).
 * - The host refused (an invalid value, a working directory change while a turn runs): a toast
 *   says why, and the host's value comes back onto the pointer, so the two never disagree.
 *
 * The agreed state (the baseline) is kept per agent in this window's local storage. Without it,
 * as on the first run after an upgrade, the host's record is the baseline: a difference made
 * here is sent and nothing is pulled.
 */

import {
	applyLiftSyncPull,
	planLiftedSettingsSync,
	readLiftSyncBaseline,
	settleLiftSyncBaseline,
	type LiftSyncBaseline,
	type LiftSyncEcho,
	type LiftSyncPlan,
	type LiftSyncPush,
} from '../../shared/maestro-lib/agents/lift-settings-sync';
import { readLiftedTo, type LiftedToPointer } from '../../shared/maestro-lib/agents/lift-pointer';
import type { ClientErrorCode } from '../../shared/maestro-lib/client/types';
import type { AgentRecord } from '../../shared/maestro-lib/store/records';
import type { Session } from '../types';
import { useSessionStore, updateSessionWith } from '../stores/sessionStore';
import { usePeerMirrorStore } from '../stores/peerMirrorStore';
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
		// A damaged entry only costs the baseline: the sync starts over from the host's record.
	}
	return map;
}

function saveBaselines(map: Map<string, LiftSyncBaseline>): void {
	safeStorageSet(STORAGE_KEY, JSON.stringify(Object.fromEntries(map)));
}

/** A failure the sync should retry later, rather than give the host's value back. */
function isTransient(answer: Extract<MirroredActionAnswer, { ok: false }>): boolean {
	// No code: the IPC call itself failed, so the host never saw it.
	return answer.code === undefined || TRANSIENT_CODES.has(answer.code);
}

/** The pushed field ids the host applied before it refused the rest of an `update-agent`. */
function appliedIds(push: LiftSyncPush, answer: Extract<MirroredActionAnswer, { ok: false }>) {
	return (answer.appliedFields ?? []).flatMap((field) => push.fieldIds?.[field] ?? []);
}

/**
 * Start syncing every lifted agent. Answers the stop function. Call once, in the window that owns
 * app-wide side effects.
 */
export function startLiftedAgentSettingsSync(): () => void {
	const baselines = loadBaselines();
	const awaiting = new Map<string, Record<string, LiftSyncEcho>>();
	const inFlight = new Set<string>();
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

	const runAll = () => {
		const { sessions, sessionsReadOk } = useSessionStore.getState();
		// Before the registry is read, an empty list is not "no lifted agents".
		if (disposed || !sessionsReadOk) return;
		const peers = usePeerMirrorStore.getState().peers;
		let pruned = false;
		const lifted = new Set<string>();
		for (const session of sessions) {
			const pointer = readLiftedTo(session.liftedTo);
			if (!pointer) continue;
			lifted.add(session.id);
			if (inFlight.has(session.id)) {
				rerun = true;
				continue;
			}
			const peer = peers[pointer.peer];
			if (peer?.connection !== 'connected') continue;
			const host = peer.agents.find((agent) => agent.id === pointer.agentId);
			if (host) void syncAgent(session, pointer, host);
		}
		for (const agentId of [...baselines.keys()]) {
			if (lifted.has(agentId)) continue;
			baselines.delete(agentId);
			awaiting.delete(agentId);
			pruned = true;
		}
		if (pruned) saveBaselines(baselines);
	};

	const syncAgent = async (session: Session, pointer: LiftedToPointer, host: AgentRecord) => {
		inFlight.add(session.id);
		let again = false;
		try {
			const now = Date.now();
			const echoes = Object.fromEntries(
				Object.entries(awaiting.get(session.id) ?? {}).filter(([, echo]) => echo.until > now)
			);
			const plan = planLiftedSettingsSync({
				local: session as unknown as AgentRecord,
				host,
				baseline: baselines.get(session.id),
				awaiting: echoes,
				now,
			});
			if (plan.pulls) {
				updateSessionWith(
					session.id,
					(current) =>
						applyLiftSyncPull(current as unknown as AgentRecord, plan.pull) as unknown as Session
				);
			}
			const outcome = await sendPushes(session, pointer, plan, echoes);
			again = outcome.refused;
			baselines.set(session.id, outcome.baseline);
			awaiting.set(session.id, echoes);
			saveBaselines(baselines);
		} finally {
			inFlight.delete(session.id);
			if (again || rerun) {
				rerun = false;
				schedule();
			}
		}
	};

	/** Run the plan's host calls in order; stop at the first one the peer could not take. */
	const sendPushes = async (
		session: Session,
		pointer: LiftedToPointer,
		plan: LiftSyncPlan,
		echoes: Record<string, LiftSyncEcho>
	): Promise<{ baseline: LiftSyncBaseline; refused: boolean }> => {
		let baseline = plan.baseline;
		let refused = false;
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
			const answer = await callMirroredAgentAction(pointer.peer, pointer.agentId, push.action);
			if (!answer) break;
			if (answer.ok) {
				baseline = settleLiftSyncBaseline(plan, baseline, push.ids);
				expect(push.ids);
				if (answer.result.kind === 'update-agent' && answer.result.notices?.length) {
					notifyToast({
						color: 'yellow',
						title: `${session.name} changed on ${pointer.peer}`,
						message: answer.result.notices.join('\n'),
					});
				}
				continue;
			}
			if (isTransient(answer)) break;
			// Refused: every pushed field settles at the local value, so next pass the host's value
			// reads as the change and comes back here. What the host did apply waits for its echo.
			refused = true;
			baseline = settleLiftSyncBaseline(plan, baseline, push.ids);
			expect(appliedIds(push, answer));
			notifyToast({
				color: 'red',
				title: `${session.name}: host kept its settings`,
				message: `${answer.error} The agent shows the host's value again.`,
			});
		}
		return { baseline, refused };
	};

	const offSessions = useSessionStore.subscribe((state, previous) => {
		if (state.sessions !== previous.sessions || state.sessionsReadOk !== previous.sessionsReadOk) {
			schedule();
		}
	});
	const offPeers = usePeerMirrorStore.subscribe((state, previous) => {
		if (state.peers !== previous.peers) schedule();
	});
	schedule();

	return () => {
		disposed = true;
		offSessions();
		offPeers();
		if (timer) clearTimeout(timer);
		for (const echoTimer of echoTimers) clearTimeout(echoTimer);
		echoTimers.clear();
	};
}
