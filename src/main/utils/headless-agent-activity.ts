import { EventEmitter } from 'node:events';
import type { HeadlessAgentActivity } from '../../shared/headlessAgentActivity';

const runs = new Map<symbol, string>();
const changes = new EventEmitter();
let revision = 0;

/** Native hosts can fence new turns against durable ownership without adding a queue.
 * Only Cue's internal run service supplies an exact reserved run id. */
let admission: (agentId: string, runId?: string) => boolean = () => true;
export function configureAgentAdmission(provider: typeof admission): void {
	admission = provider;
}
export function canStartAgentTurn(agentId: string, runId?: string): boolean {
	return admission(agentId, runId);
}

export function getHeadlessAgentActivity(): HeadlessAgentActivity {
	const counts: Record<string, number> = Object.create(null);
	for (const agentId of runs.values()) counts[agentId] = (counts[agentId] ?? 0) + 1;
	return { revision, counts };
}

export function hasHeadlessAgentActivity(agentId: string): boolean {
	for (const target of runs.values()) if (target === agentId) return true;
	return false;
}

/** Register at the synchronous native start boundary, once per owned turn.
 * Release only after confirmed termination or nonstart; the release is idempotent. */
export function trackHeadlessAgentActivity(agentId: string): () => void {
	const key = Symbol();
	runs.set(key, agentId);
	revision++;
	changes.emit('change');
	return () => {
		if (!runs.delete(key)) return;
		revision++;
		changes.emit('change');
	};
}

export function onHeadlessAgentActivityChange(listener: () => void): () => void {
	changes.on('change', listener);
	return () => {
		changes.off('change', listener);
	};
}

/** Host-only capability. Identity is held in memory, never accepted from transport JSON.
 * Issuance does not reserve capacity: admission is rechecked after async planning,
 * synchronously with registering occupancy at the final native start boundary. */
export interface AgentTurnAdmissionProof {
	readonly agentId: string;
}
const proofs = new WeakMap<
	AgentTurnAdmissionProof,
	{ revoked: boolean; active: boolean; detach?: () => void }
>();

export function issueAgentTurnAdmission(
	agentId: string,
	signal?: AbortSignal
): AgentTurnAdmissionProof {
	if (!agentId.trim()) throw new Error('Explicit originating worker required');
	const proof = Object.freeze({ agentId });
	const onAbort = () => revokeAgentTurnAdmission(proof);
	proofs.set(proof, {
		revoked: !!signal?.aborted,
		active: false,
		detach: () => signal?.removeEventListener('abort', onAbort),
	});
	if (!signal?.aborted) signal?.addEventListener('abort', onAbort, { once: true });
	return proof;
}

/** Revocation fences late preparation/retry. It never releases a running child. */
export function revokeAgentTurnAdmission(proof: AgentTurnAdmissionProof): void {
	const state = proofs.get(proof);
	if (state) {
		state.revoked = true;
		state.detach?.();
	}
}

export function startAdmittedAgentTurn(
	proof: AgentTurnAdmissionProof | undefined,
	agentId: string | undefined
): () => void {
	const state = proof && proofs.get(proof);
	if (!state || state.revoked || state.active || !agentId || proof?.agentId !== agentId)
		throw new Error('Valid host admission proof and originating worker required');
	if (!canStartAgentTurn(agentId))
		throw new Error('Board worker is reserved; wait for its current attempt to settle');
	state.active = true;
	const releaseActivity = trackHeadlessAgentActivity(agentId);
	let released = false;
	return () => {
		if (released) return;
		released = true;
		state.active = false;
		releaseActivity();
	};
}
