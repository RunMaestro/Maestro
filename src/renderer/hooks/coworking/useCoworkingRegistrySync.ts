/**
 * Mirrors *every* Maestro session's terminal-tab state to the main-process
 * coworking registry - not just the focused session.
 *
 * This is what makes the coworking MCP server safe in the privacy sense: each
 * agent's MCP subprocess is bound at handshake to its caller's session id (see
 * coworking-bridge.ts), and tool calls scope to that session only. So the
 * registry needs every session's data resident at all times - otherwise an
 * agent running in the background while the user is focused on a different
 * agent would see "no terminals" for its own session.
 *
 * Strategy: subscribe to the session store, recompute the cross-session payload,
 * and push the full set on any change. Cheap because each push is a small array
 * and we short-circuit on a stable JSON-equality check. When a session is
 * removed from the store, we explicitly call `removeSession` so the registry
 * doesn't carry orphan records forever.
 *
 * Gated on the `coworking` Encore flag - when off we proactively clear every
 * session out of the registry.
 */

import { useEffect, useRef } from 'react';
import { useSessionStore } from '../../stores/sessionStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { getTerminalTabDisplayName } from '../../utils/terminalTabHelpers';
import { captureException } from '../../utils/sentry';
import type { Session } from '../../types';
import { DEFAULT_BROWSER_CONFIRM_POLICY } from '../../../shared/coworkingBrowser';

/** Errors we expect during teardown / pre-init - silently ignore. Anything else
 *  bubbles up to Sentry so we can see real bridge failures in production.
 *  Note: "cannot be cloned" is *not* in this list - that's a structured-clone
 *  bug (caller put something non-serializable in the payload), and we want
 *  Sentry to see it so it gets fixed instead of swallowed. */
function isExpectedTeardownIpcError(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	return /No handler registered|Object has been destroyed/i.test(err.message);
}

function reportIfUnexpected(err: unknown, scope: string): void {
	if (isExpectedTeardownIpcError(err)) return;
	const error = err instanceof Error ? err : new Error(String(err));
	void captureException(error, {
		extra: { scope: `useCoworkingRegistrySync:${scope}` },
	});
	// Surface unexpected failures instead of swallowing them: a silently dropped
	// sync would leave the main-process registry stale. Callers roll back their
	// optimistic cache before this throws so the next effect run still retries.
	throw error;
}

/** Build the per-session record list from a Session, with cwd fallbacks so the
 *  schema-promised `cwd` is never empty when we can avoid it. */
function buildRecords(session: Session) {
	const tabs = session.terminalTabs ?? [];
	return tabs
		.map((t, idx) => ({ tab: t, idx }))
		.filter(({ tab }) => typeof tab.coworkingId === 'number')
		.map(({ tab, idx }) => ({
			id: `term:${tab.coworkingId}`,
			// Prefer the tab's own cwd (kept up to date as the user `cd`s in the shell).
			// Fall back to the session's cwd, then the project root, so agents always
			// get *some* working directory hint instead of "" (which violates the schema
			// description - see PR #948 review notes).
			cwd: tab.cwd || session.cwd || session.projectRoot || '',
			title: getTerminalTabDisplayName(tab, idx),
			tabUuid: tab.id,
			sessionId: session.id,
		}));
}

/** Build the per-session browser-input list from a Session. The registry assigns
 *  the stable `browser:N` id, so we only push raw tab metadata here. Hidden
 *  tabs are pushed WITH their flag (not filtered out) so main can enforce the
 *  exclusion itself: filtering here left a sync-cycle window where a
 *  just-hidden tab was still addressable, and enforcement-by-absence meant
 *  main could never re-check. Hidden tabs also keep their stable browser:N id
 *  across hide/unhide this way. */
export function buildBrowserInputs(session: Session) {
	const tabs = session.browserTabs ?? [];
	return tabs.map((t) => ({
		tabUuid: t.id,
		url: t.url,
		title: t.title,
		favicon: t.favicon ?? undefined,
		canGoBack: t.canGoBack,
		canGoForward: t.canGoForward,
		isLoading: t.isLoading,
		hiddenFromAgent: t.hiddenFromAgent === true ? true : undefined,
	}));
}

export function useCoworkingRegistrySync(): void {
	// Subscribe to the full sessions array. The session store updates immutably,
	// so this fires on add/remove/terminal-mutation for any session.
	const sessions = useSessionStore((s) => s.sessions);
	const enabled = useSettingsStore((s) => s.encoreFeatures?.coworking ?? false);
	// Per-agent browser-interaction permission (list of allowed ToolType ids).
	const browserInteractionAgents = useSettingsStore((s) => s.coworkingBrowserInteraction);
	// Per-agent per-call confirm policy, mirrored to main so it can compute the
	// approval requirement for each op itself.
	const browserConfirmPolicies = useSettingsStore((s) => s.coworkingBrowserInteractionConfirm);
	const lastPayloadRef = useRef<string>('');
	const lastSessionIdsRef = useRef<Set<string>>(new Set());
	// Serializes the async sync/clear runs. Without this, two rapid store changes
	// launch overlapping async pushes whose IPC writes can interleave, letting an
	// older run's writes land AFTER a newer run's and leave the registry stale
	// (lastPayloadRef already matches the newer payload, so it never self-heals).
	const runQueueRef = useRef<Promise<void>>(Promise.resolve());
	// Monotonic id bumped once per effect run. The async sync body below can
	// resolve AFTER a newer effect run has already rewritten lastPayloadRef /
	// lastSessionIdsRef synchronously; guarding the failure-path rollback on this
	// id keeps a stale run from stomping that newer state.
	const runIdRef = useRef(0);

	useEffect(() => {
		const runId = ++runIdRef.current;
		// Bail out cleanly when the coworking bridge isn't exposed (e.g. in test
		// harnesses that mock `window.maestro` without the namespace, or in older
		// preload bundles before this PR shipped). The hook is best-effort -
		// without the bridge there's nothing to sync to.
		const bridge = window.maestro?.coworking;
		if (!bridge) {
			lastPayloadRef.current = '';
			lastSessionIdsRef.current = new Set();
			return;
		}

		if (!enabled) {
			// Drop everything we previously pushed. We don't need to emit one big
			// "clear" - calling removeSession per known session is what keeps the
			// registry tidy without us having to add a new RPC.
			const prev = lastSessionIdsRef.current;
			if (prev.size > 0) {
				runQueueRef.current = runQueueRef.current.then(async () => {
					for (const sid of prev) {
						try {
							await bridge.removeSession(sid);
						} catch (err) {
							// Best-effort teardown while disabling the feature: capture
							// unexpected failures but keep clearing the remaining sessions
							// (don't abort the loop on one bad removeSession).
							if (!isExpectedTeardownIpcError(err)) {
								void captureException(err instanceof Error ? err : new Error(String(err)), {
									extra: { scope: 'useCoworkingRegistrySync:disable-clear' },
								});
							}
						}
					}
				});
			}
			lastPayloadRef.current = '';
			lastSessionIdsRef.current = new Set();
			return;
		}

		// Build the cross-session payload.
		const perSession = sessions.map((s) => ({ sessionId: s.id, records: buildRecords(s) }));
		const perSessionBrowsers = sessions.map((s) => ({
			sessionId: s.id,
			inputs: buildBrowserInputs(s),
			interactionEnabled: browserInteractionAgents.includes(s.toolType),
			agentType: s.toolType,
			confirmPolicy: browserConfirmPolicies[s.toolType] ?? DEFAULT_BROWSER_CONFIRM_POLICY,
		}));
		const currentIds = new Set(perSession.map((p) => p.sessionId));

		// Detect sessions that disappeared since the previous run so we can clear
		// them from the registry instead of leaving stale records.
		const removed: string[] = [];
		for (const id of lastSessionIdsRef.current) {
			if (!currentIds.has(id)) removed.push(id);
		}

		// Skip the IPC if nothing has changed since last sync (cheap stringify of small payload).
		const payload = JSON.stringify({ perSession, perSessionBrowsers, removed });
		if (payload === lastPayloadRef.current) return;
		lastPayloadRef.current = payload;
		// Snapshot the session-id set so we can restore it if the async sync batch
		// below fails. Otherwise a failed removeSession drops the removed session
		// from our cache, so the next run won't re-detect it as `removed` and the
		// main registry keeps stale tabs forever.
		const previousSessionIds = lastSessionIdsRef.current;
		lastSessionIdsRef.current = currentIds;

		runQueueRef.current = runQueueRef.current
			.then(async () => {
				try {
					for (const sid of removed) {
						await bridge.removeSession(sid);
					}
					for (const { sessionId, records } of perSession) {
						await bridge.syncSessionTerminals(sessionId, records);
					}
					for (const {
						sessionId,
						inputs,
						interactionEnabled,
						agentType,
						confirmPolicy,
					} of perSessionBrowsers) {
						await bridge.syncSessionBrowsers(
							sessionId,
							inputs,
							interactionEnabled,
							agentType,
							confirmPolicy
						);
					}
				} catch (err) {
					// Roll back the optimistic payload-cache write FIRST so the next effect
					// run retries instead of treating the same payload as already-synced and
					// leaving the main-process registry stale. Then surface the failure
					// (teardown IPC errors stay quiet; anything else re-throws).
					//
					// Guard the rollback: a newer effect run may have already rewritten
					// these refs synchronously while this async push was in flight, so only
					// the latest run may stomp them - otherwise we'd revert newer state.
					if (runIdRef.current === runId) {
						lastPayloadRef.current = '';
						lastSessionIdsRef.current = previousSessionIds;
					}
					reportIfUnexpected(err, 'sync');
				}
				// reportIfUnexpected re-throws (after capturing to Sentry) to surface real
				// failures; swallow it at the queue boundary so one failed run doesn't
				// permanently break the chain for every subsequent sync.
			})
			.catch(() => {});
	}, [enabled, sessions, browserInteractionAgents, browserConfirmPolicies]);
}
