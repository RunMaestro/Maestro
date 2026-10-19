/**
 * tabWindowMirror - the tab window's half of the Tab Windows patch stream (D2).
 *
 * A tab window is a view (D1). It never handles a `process:*` event, so the
 * owner window's patches are its only source of the agent's state. This
 * applies them, with `applyTabWindowPatch`, to the copy of the agent that this
 * renderer's `sessionStore` holds. The AI tab components then read the store
 * and their props exactly as they do in an app window, unchanged.
 *
 * - The store holds this one agent and nothing else, as its active agent. The
 *   active id is set with `hydrateActiveSessionId`, which persists nothing: the
 *   app's own active agent is not the tab window's to change.
 * - The mirror handed to the apply is the store's CURRENT session plus the
 *   `tabRefs` and `seq` kept here, so a field this window wrote itself (a
 *   scroll position, the composer draft) survives every delta that does not
 *   change it. A per-window field (the draft) also survives a snapshot that
 *   keeps its tab in this window.
 * - A delta that does not apply (no snapshot yet, a gap in `seq`, a splice past
 *   the held end) asks the owner for one snapshot and drops every delta until
 *   a snapshot lands. A snapshot always applies.
 *
 * Started once per tab window by `useTabWindowMirror` (`TabWindowRoot`). The
 * owner's half is `tabWindowPublisher.ts`; the pure logic is
 * `src/shared/tabWindowPatch.ts`.
 */

import type { Session } from '../types';
import { useSessionStore } from '../stores/sessionStore';
import { logger } from '../utils/logger';
import { captureMessage } from '../utils/sentry';
import { requestTabWindowSnapshot } from '../components/TabWindow/requestTabWindowSnapshot';
import {
	applyTabWindowPatch,
	type TabWindowMirror,
	type TabWindowPatchOf,
} from '../../shared/tabWindowPatch';
import type { TabWindowInfo, TabWindowTabRef } from '../../shared/tabWindowTypes';

export interface TabWindowMirrorStream {
	/**
	 * Ask the owner for a fresh snapshot of the agent `info` names. Once asked,
	 * deltas are dropped until a snapshot lands. False when it could not ask:
	 * the record holds no tab to address the request with, there is no tab
	 * windows API, or the stream is stopped.
	 */
	requestSnapshot: (info: TabWindowInfo) => boolean;
	/** Stop applying patches. The store keeps the agent it holds. */
	stop: () => void;
}

/** Where the mirror is in the owner's stream. The session itself is in the store. */
interface StreamPosition {
	agentId: string;
	/** The popped refs of the last snapshot. */
	tabRefs: TabWindowTabRef[];
	/** `seq` of the last patch applied. */
	seq: number;
}

const LOG_CONTEXT = '[TabWindows]';

const NOOP_STREAM: TabWindowMirrorStream = { requestSnapshot: () => false, stop: () => {} };

/** The agent this renderer holds, as `applyTabWindowPatch` takes it. */
function heldMirror(position: StreamPosition | null): TabWindowMirror<Session> | null {
	if (!position) return null;
	const session = useSessionStore.getState().sessions.find((s) => s.id === position.agentId);
	return session ? { session, tabRefs: position.tabRefs, seq: position.seq } : null;
}

/** Make `session` the one agent of this renderer's store, and its active agent. */
function holdOnly(session: Session): void {
	const store = useSessionStore.getState();
	if (store.activeSessionId !== session.id) store.hydrateActiveSessionId(session.id);
	store.setSessions([session]);
}

/**
 * Apply every patch the owner sends to this tab window until the returned
 * stream is stopped. A no-op stream where there are no tab windows (the
 * web-desktop build, TW-13).
 *
 * @param getInfo - This window's registry record, read when a delta does not
 *                  apply: its tab addresses the snapshot request.
 */
export function startTabWindowMirror(getInfo: () => TabWindowInfo | null): TabWindowMirrorStream {
	const api = window.maestro?.tabWindows;
	if (!api) return NOOP_STREAM;

	let position: StreamPosition | null = null;
	// Nothing is held yet, and only a snapshot can start the mirror.
	let awaitingSnapshot = true;
	let stopped = false;

	const requestSnapshot = (info: TabWindowInfo): boolean => {
		if (!requestTabWindowSnapshot(info)) return false;
		awaitingSnapshot = true;
		return true;
	};

	/** Start over from a snapshot: a delta did not fit what this window holds. */
	const resync = (patch: TabWindowPatchOf<Session>) => {
		logger.warn('A session patch did not apply; asking the owner for a snapshot', LOG_CONTEXT, {
			agentId: patch.agentId,
			seq: patch.seq,
			heldSeq: position?.seq,
		});
		// Expected never: main relays one owner's patches in order. Reported so a
		// stream that keeps breaking is seen, then repaired by the snapshot.
		captureMessage('Tab window patch did not apply', {
			level: 'warning',
			extra: { operation: 'tabWindows.applyPatch', seq: patch.seq, heldSeq: position?.seq },
		});
		// Every later delta builds on the one that did not apply, so all of them
		// wait for a snapshot, even when no request can go out yet (no record).
		awaitingSnapshot = true;
		const info = getInfo();
		if (info) requestTabWindowSnapshot(info);
	};

	const offPatches = api.onSessionPatch((wire) => {
		if (stopped) return;
		const patch = wire as TabWindowPatchOf<Session>;
		// Deltas sent before the snapshot this window waits for describe a state
		// it does not hold. The snapshot carries everything they did.
		if (patch.form === 'delta' && awaitingSnapshot) return;
		const held = heldMirror(position);
		const next = applyTabWindowPatch(held, patch);
		if (!next) {
			resync(patch);
			return;
		}
		awaitingSnapshot = false;
		position = { agentId: next.session.id, tabRefs: next.tabRefs, seq: next.seq };
		if (next.session !== held?.session) holdOnly(next.session);
	});

	return {
		requestSnapshot: (info) => !stopped && requestSnapshot(info),
		stop: () => {
			if (stopped) return;
			stopped = true;
			offPatches();
		},
	};
}
