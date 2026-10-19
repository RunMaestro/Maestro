/**
 * tabWindowPublisher - the owner window's half of the Tab Windows patch stream
 * (D2).
 *
 * The app window that owns an agent is that agent's only writer (D1). While
 * the agent has a tab window, this streams the agent's `Session` to it:
 *   - a snapshot when the tab window attaches (the window shows up in the
 *     registry, or this window starts owning the agent), when the set of popped
 *     tabs changes, and when the tab window asks for one with the
 *     `requestSnapshot` intent (it does on load, so a reloaded window recovers);
 *   - deltas in between, coalesced to one per animation frame or
 *     {@link TAB_WINDOW_PATCH_INTERVAL_MS}, whichever is later.
 *
 * A registry change that only moves the shown tab or reorders the strip sends
 * nothing: the tab window derives both from its own registry record.
 *
 * A snapshot also seeds the tab window's composer: a tab new to the tab window
 * takes the draft this window has for it, including text still in this
 * window's composer and not yet written back to the tab.
 *
 * The patch logic is pure and lives in `src/shared/tabWindowPatch.ts`; this
 * module adds only the transport and the timing. Main relays a patch to the
 * agent's tab window, and only from the agent's CURRENT owner, so a window the
 * agent was just moved out of is refused (D7).
 *
 * Mount once in App.tsx through `useTabWindowPublisher`. A tab window never
 * runs it: it is a view, not a writer.
 */

import type { Session } from '../types';
import { useSessionStore } from '../stores/sessionStore';
import { useTabWindowStore } from '../stores/tabWindowStore';
import { useComposerInputStore } from '../stores/composerInputStore';
import { isWebDesktop } from '../utils/runtimeContext';
import { logger } from '../utils/logger';
import { captureException } from '../utils/sentry';
import { normalizeComposerCommandMode } from '../utils/shellCommandInput';
import {
	buildTabWindowSnapshot,
	diffTabWindowSession,
	type TabWindowPatchOf,
} from '../../shared/tabWindowPatch';
import type { TabWindowInfo, TabWindowTabRef } from '../../shared/tabWindowTypes';
import { tabRefKey } from '../../shared/unifiedTabRef';

/** The least time between two deltas to one tab window. */
export const TAB_WINDOW_PATCH_INTERVAL_MS = 50;

/**
 * How long a due delta waits for its animation frame before it goes anyway. A
 * hidden or minimized window paints no frames, and its tab windows must keep
 * streaming.
 */
export const TAB_WINDOW_FRAME_WAIT_MS = 250;

/** Whether this window owns an agent. */
export type OwnsSession = (sessionId: string) => boolean;

export interface TabWindowPublisher {
	/** Re-check which agents to publish. Call it when ownership changes. */
	sync: () => void;
	/** Stop publishing and drop every scheduled delta. */
	stop: () => void;
}

/** What the publisher keeps for one agent it streams to a tab window. */
interface Channel {
	agentId: string;
	/** The tab window the last snapshot went to. */
	windowId: string;
	/** The popped refs of the last snapshot. Every delta covers exactly these. */
	tabRefs: TabWindowTabRef[];
	/** {@link poppedSetKey} of `tabRefs`, to tell a new set from a reorder. */
	poppedKey: string;
	/** The session the last patch was built from: the `prev` of the next diff. */
	prev: Session;
	/** `seq` of the last patch sent. */
	seq: number;
	/** Cancels the scheduled delta; null when none is scheduled. */
	cancelDelta: (() => void) | null;
}

const LOG_CONTEXT = '[TabWindows]';

const NOOP_PUBLISHER: TabWindowPublisher = { sync: () => {}, stop: () => {} };

/** The popped set as one string: the same refs in any order give the same key. */
function poppedSetKey(tabRefs: readonly TabWindowTabRef[]): string {
	return tabRefs.map(tabRefKey).sort().join('\n');
}

function isDocumentHidden(): boolean {
	return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

/**
 * `session` with this window's live composer draft on the popped AI tab it
 * belongs to. The composer writes its draft back to the tab only after a
 * typing pause (`useInputSync`), and it lets go of a tab that pops out only
 * after the snapshot that pops it has gone out. Without this, a tab popped
 * out while the user types would seed the tab window with the text from
 * before the last pause. The store is not written: the composer's own
 * write-back lands the same text there.
 *
 * Only the seed reads it. The tab window keeps its own draft for a tab it
 * already holds, whatever a snapshot says (`applyTabWindowPatch`).
 */
function withLiveComposerDraft(session: Session, tabRefs: readonly TabWindowTabRef[]): Session {
	const { aiValueTabId, aiValue, aiCommandMode } = useComposerInputStore.getState();
	if (!aiValueTabId || !tabRefs.some((ref) => ref.type === 'ai' && ref.id === aiValueTabId)) {
		return session;
	}
	const index = session.aiTabs.findIndex((tab) => tab.id === aiValueTabId);
	const tab = session.aiTabs[index];
	if (
		!tab ||
		(tab.inputValue === aiValue && normalizeComposerCommandMode(tab.commandMode) === aiCommandMode)
	) {
		return session;
	}
	const aiTabs = session.aiTabs.slice();
	aiTabs[index] = { ...tab, inputValue: aiValue, commandMode: aiCommandMode };
	return { ...session, aiTabs };
}

/**
 * Run `run` once both the next animation frame and
 * {@link TAB_WINDOW_PATCH_INTERVAL_MS} have passed, whichever is later.
 * Returns a function that cancels it.
 *
 * A hidden window paints no frames, so it waits for the interval only, and a
 * frame that has not come {@link TAB_WINDOW_FRAME_WAIT_MS} after the interval
 * (the window hid while it waited) is not waited for any longer.
 */
function scheduleAfterFrameAndInterval(run: () => void): () => void {
	let frame: number | null = null;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let framed = isDocumentHidden();
	let elapsed = false;
	const cancel = () => {
		if (frame !== null) cancelAnimationFrame(frame);
		if (timer !== null) clearTimeout(timer);
		frame = null;
		timer = null;
	};
	const finish = () => {
		cancel();
		run();
	};
	if (!framed) {
		frame = requestAnimationFrame(() => {
			frame = null;
			framed = true;
			if (elapsed) finish();
		});
	}
	timer = setTimeout(() => {
		timer = null;
		elapsed = true;
		if (framed) finish();
		else timer = setTimeout(finish, TAB_WINDOW_FRAME_WAIT_MS);
	}, TAB_WINDOW_PATCH_INTERVAL_MS);
	return cancel;
}

/**
 * Stream every owned agent that has a tab window to it until the returned
 * publisher is stopped. A no-op publisher where there are no tab windows (the
 * web-desktop build, TW-13).
 *
 * @param ownsSession - Whether this window owns an agent, read on every pass.
 *                      Omit outside a window-scoped app (every agent is owned).
 */
export function startTabWindowPublisher(ownsSession?: OwnsSession): TabWindowPublisher {
	const api = window.maestro?.tabWindows;
	if (!api || isWebDesktop()) return NOOP_PUBLISHER;

	const channels = new Map<string, Channel>();
	let stopped = false;

	const owns = (agentId: string) => !ownsSession || ownsSession(agentId);

	const send = (patch: TabWindowPatchOf<Session>) => {
		try {
			api.sendSessionPatch(patch);
		} catch (error) {
			// Expected never: a session is plain data. Reported, and never thrown
			// into the store write that triggered the pass.
			logger.error('Could not send a session patch', LOG_CONTEXT, error);
			captureException(error instanceof Error ? error : new Error(String(error)), {
				extra: { operation: 'tabWindows.sendSessionPatch', form: patch.form },
			});
		}
	};

	const dropDelta = (channel: Channel) => {
		channel.cancelDelta?.();
		channel.cancelDelta = null;
	};

	/** Send `session` whole for `win`, replacing any delta still waiting. */
	const sendSnapshot = (win: TabWindowInfo, session: Session) => {
		const existing = channels.get(win.agentId);
		if (existing) dropDelta(existing);
		const channel: Channel = {
			agentId: win.agentId,
			windowId: win.windowId,
			tabRefs: win.tabRefs,
			poppedKey: poppedSetKey(win.tabRefs),
			prev: session,
			seq: existing ? existing.seq + 1 : 0,
			cancelDelta: null,
		};
		channels.set(win.agentId, channel);
		send({
			form: 'snapshot',
			agentId: win.agentId,
			seq: channel.seq,
			tabRefs: win.tabRefs,
			// `prev` stays the stored session: a draft never rides a delta.
			session: buildTabWindowSnapshot(withLiveComposerDraft(session, win.tabRefs), win.tabRefs),
		});
	};

	const findSession = (agentId: string): Session | undefined =>
		useSessionStore.getState().sessions.find((s) => s.id === agentId);

	/** Send what changed since the last patch, if the tab window receives any of it. */
	const flushDelta = (channel: Channel) => {
		channel.cancelDelta = null;
		if (channels.get(channel.agentId) !== channel) return;
		const session = findSession(channel.agentId);
		if (!session) return;
		const changes = diffTabWindowSession(channel.prev, session, channel.tabRefs);
		channel.prev = session;
		if (!changes) return;
		channel.seq += 1;
		send({ form: 'delta', agentId: channel.agentId, seq: channel.seq, ...changes });
	};

	/** The tab windows this window publishes to, by agent, with each agent's session. */
	const collectTargets = () => {
		const { sessions } = useSessionStore.getState();
		const targets = new Map<string, { win: TabWindowInfo; session: Session }>();
		for (const win of useTabWindowStore.getState().windows) {
			if (win.tabRefs.length === 0 || targets.has(win.agentId) || !owns(win.agentId)) continue;
			const session = sessions.find((s) => s.id === win.agentId);
			if (session) targets.set(win.agentId, { win, session });
		}
		return targets;
	};

	/**
	 * One pass: attach new targets with a snapshot, re-snapshot a target whose
	 * tab window or popped set changed, schedule a delta for a target whose
	 * session changed, and drop channels that are no longer targets (the tab
	 * window closed, the agent left this window, or the agent was removed).
	 */
	const sync = () => {
		if (stopped) return;
		const targets = collectTargets();
		for (const [agentId, channel] of channels) {
			if (targets.has(agentId)) continue;
			dropDelta(channel);
			channels.delete(agentId);
		}
		for (const [agentId, { win, session }] of targets) {
			const channel = channels.get(agentId);
			if (
				!channel ||
				channel.windowId !== win.windowId ||
				channel.poppedKey !== poppedSetKey(win.tabRefs)
			) {
				sendSnapshot(win, session);
			} else if (session !== channel.prev && !channel.cancelDelta) {
				channel.cancelDelta = scheduleAfterFrameAndInterval(() => flushDelta(channel));
			}
		}
	};

	/** Answer a tab window that asked to start over (on load, or after a gap). */
	const resendSnapshot = (agentId: string) => {
		if (stopped || !channels.has(agentId)) {
			// Not attached yet: the attach snapshot follows once this window owns
			// the agent, holds its session, and sees its tab window.
			logger.debug(`Snapshot request for an agent not published here: ${agentId}`, LOG_CONTEXT);
			return;
		}
		const target = collectTargets().get(agentId);
		if (target) sendSnapshot(target.win, target.session);
	};

	// A pass may run inside another store write, so it must never throw into it.
	const safeSync = () => {
		try {
			sync();
		} catch (error) {
			logger.error('Tab window publisher pass failed', LOG_CONTEXT, error);
			captureException(error instanceof Error ? error : new Error(String(error)), {
				extra: { operation: 'tabWindowPublisher.sync' },
			});
		}
	};

	const offSessions = useSessionStore.subscribe((state, previous) => {
		if (state.sessions !== previous.sessions) safeSync();
	});
	const offWindows = useTabWindowStore.subscribe((state, previous) => {
		if (state.windows !== previous.windows) safeSync();
	});
	// Main relays an intent only from the agent's own tab window, and only to
	// the agent's current owner. Every other kind is the intent dispatcher's.
	const offIntents = api.onIntent((intent) => {
		if (intent.kind === 'requestSnapshot') resendSnapshot(intent.agentId);
	});
	safeSync();

	return {
		sync: safeSync,
		stop: () => {
			if (stopped) return;
			stopped = true;
			offSessions();
			offWindows();
			offIntents();
			for (const channel of channels.values()) dropDelta(channel);
			channels.clear();
		},
	};
}
