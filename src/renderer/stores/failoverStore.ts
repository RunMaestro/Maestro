/**
 * failoverStore - Provider Failover runtime state (renderer).
 *
 * Tracks which endpoint each agent is currently running on and drives the swap.
 * The persisted half of the feature (the endpoint list itself) lives on the
 * Session record as `failoverConfig`; this store owns only the volatile "which
 * one is live right now" part, mirrored into the main process so spawns pick it
 * up (see `main/process-manager/failover-overlay.ts`).
 *
 * Deliberately not persisted, matching the retry engine: a closed app should not
 * silently resume routing prompts to a backup provider. Every agent starts each
 * app run on its primary.
 *
 * Ordering matters. `switchToNextEndpoint` awaits the main-process overlay write
 * BEFORE returning, so the caller can spawn immediately afterwards and know the
 * new env is already in place. Callers must not fire a retry without awaiting.
 */

import { create } from 'zustand';

import {
	failoverArmed,
	findEndpoint,
	selectNextEndpoint,
	shouldReturnToPrimary,
	type FailoverConfig,
	type FailoverEndpoint,
	type FailoverState,
} from '../../shared/providerFailover';
import { logger } from '../utils/logger';
import { useSessionStore, selectSessionById } from './sessionStore';

interface FailoverStoreState {
	/** Live endpoint per agent, keyed by bare session id. Absent = on primary. */
	states: Record<string, FailoverState>;
	/** Internal setter - callers use the exported functions below. */
	setState: (sessionId: string, state: FailoverState | null) => void;
}

export const useFailoverStore = create<FailoverStoreState>()((set) => ({
	states: {},
	setState: (sessionId, state) =>
		set((prev) => {
			const next = { ...prev.states };
			if (state) next[sessionId] = state;
			else delete next[sessionId];
			return { states: next };
		}),
}));

/** Read an agent's persisted failover config, if any. */
function configFor(sessionId: string): FailoverConfig | undefined {
	const session = selectSessionById(sessionId)(useSessionStore.getState());
	return session?.failoverConfig;
}

/**
 * Push the live endpoint's env to the main process. Resolves once main has the
 * overlay, so the next spawn is guaranteed to see it.
 */
async function pushOverlay(sessionId: string, endpoint: FailoverEndpoint | null): Promise<void> {
	await window.maestro.process.setFailoverOverlay(
		sessionId,
		endpoint ? endpoint.env : null,
		endpoint?.model
	);
}

/**
 * Move an agent onto its next untried backup endpoint.
 *
 * Returns the endpoint that is now live, or `null` when failover is disarmed,
 * unconfigured, or every endpoint has already been tried in this outage - in
 * which case the caller should fall back to plain wait-and-retry.
 */
export async function switchToNextEndpoint(sessionId: string): Promise<FailoverEndpoint | null> {
	const config = configFor(sessionId);
	if (!failoverArmed(config)) return null;

	const current = useFailoverStore.getState().states[sessionId];
	const next = selectNextEndpoint(config, current);
	if (!next) {
		logger.info('[failover] All endpoints exhausted; staying put', undefined, { sessionId });
		return null;
	}

	// Write the overlay BEFORE recording the switch locally: if the IPC throws, the
	// store still reflects the endpoint actually in force in main, and the caller's
	// retry proceeds on the current endpoint rather than a phantom one.
	await pushOverlay(sessionId, next);

	useFailoverStore.getState().setState(sessionId, {
		endpointId: next.id,
		since: Date.now(),
		exhausted: [...(current?.exhausted ?? []), next.id],
	});
	logger.info('[failover] Switched to backup endpoint', undefined, {
		sessionId,
		endpointId: next.id,
		label: next.label,
	});
	return next;
}

/**
 * Return an agent to its primary provider and reset the outage's exhausted list,
 * so a future outage can walk the backup endpoints again from the top. No-op when
 * the agent is already on primary.
 */
export async function returnToPrimary(sessionId: string): Promise<void> {
	const current = useFailoverStore.getState().states[sessionId];
	if (!current?.endpointId) return;
	await pushOverlay(sessionId, null);
	useFailoverStore.getState().setState(sessionId, null);
	logger.info('[failover] Returned to primary provider', undefined, {
		sessionId,
		wasEndpointId: current.endpointId,
	});
}

/**
 * Lazy fail-back probe. If the agent has sat on a backup longer than its
 * configured dwell time, put it back on the primary so the NEXT turn re-tests the
 * real provider. If the primary is still down, the normal failover path moves it
 * off again on the resulting error.
 *
 * Lazy by design: probing on a background timer would burn quota on an idle agent
 * just to discover the window hasn't reopened yet.
 *
 * @returns true when the agent was moved back to primary.
 */
export async function maybeReturnToPrimary(sessionId: string, now = Date.now()): Promise<boolean> {
	const current = useFailoverStore.getState().states[sessionId];
	if (!shouldReturnToPrimary(configFor(sessionId), current, now)) return false;
	logger.info('[failover] Dwell time elapsed; probing primary again', undefined, { sessionId });
	await returnToPrimary(sessionId);
	return true;
}

/** The endpoint an agent is currently running on, or undefined when on primary. */
export function getActiveEndpoint(sessionId: string): FailoverEndpoint | undefined {
	const state = useFailoverStore.getState().states[sessionId];
	return findEndpoint(configFor(sessionId), state?.endpointId);
}

/**
 * Reactive: the label of the backup endpoint an agent is running on, or null when
 * it is on its primary. Drives the "running on <backup>" banner. Returns a
 * primitive so subscribers only re-render when the endpoint actually changes.
 */
export function useActiveEndpointLabel(sessionId: string): string | null {
	const endpointId = useFailoverStore((s) => s.states[sessionId]?.endpointId ?? null);
	const label = useSessionStore((s) => {
		if (!endpointId) return null;
		const session = selectSessionById(sessionId)(s);
		return session?.failoverConfig?.endpoints?.find((e) => e.id === endpointId)?.label ?? null;
	});
	return label;
}

/**
 * Drop all failover state (renderer + main). Used when an agent is deleted or the
 * user disarms failover, so a stale pin can't outlive its config.
 */
export async function clearFailover(sessionId: string): Promise<void> {
	if (!useFailoverStore.getState().states[sessionId]) return;
	await pushOverlay(sessionId, null);
	useFailoverStore.getState().setState(sessionId, null);
}
