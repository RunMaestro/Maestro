/**
 * The renderer half of the Tab Windows terminal handoff (D5). The protocol and
 * why it is exact are in `src/main/terminal-handoff.ts`.
 *
 * A terminal tab's PTY never moves; its view does. When a view of a PTY goes
 * away because the tab moved to another window (popped out, docked, or its tab
 * window closed), the view hands its scrollback over ({@link releaseTerminalView},
 * {@link releaseRegisteredTerminalViews}). Every view of a PTY that mounts asks
 * for that scrollback before it writes live output ({@link claimTerminalReplay}).
 * `XTerminal` calls all of these through its `handoff` prop; `TerminalView`
 * decides when a view releases.
 *
 * A no-op where there is no tab windows API (the web-desktop build, TW-13):
 * a claim answers null at once, so the view goes live as before.
 */

import { TERMINAL_HANDOFF_WAIT_MS, buildTerminalReplay } from '../../shared/terminalReplay';
import { logger } from '../utils/logger';

/** What a mounted view hands over. */
export interface TerminalViewCapture {
	/** `XTerminalHandle.getBuffer()`: the scrollback and the screen, as plain lines. */
	buffer: string;
	/** Output already handed to xterm that it has not parsed yet (xterm parses on a timer). */
	unparsed: readonly string[];
}

/**
 * A claim that main never answers (a main process without the handoff
 * handlers) must not hold a view's output back forever. Longer than main's own
 * wait, so a slow release still lands.
 */
export const TERMINAL_CLAIM_TIMEOUT_MS = TERMINAL_HANDOFF_WAIT_MS + 2000;

/** How long a release waits for main's answer before it commits anyway. */
export const TERMINAL_RELEASE_TIMEOUT_MS = 2000;

type ReplayListener = (text: string | null) => void;

/**
 * Claims in flight, per PTY. Every view of one PTY in this window shares the
 * claim: React StrictMode mounts a view twice, and the first mount's claim is
 * the one main answers, so it must reach the second mount.
 */
const pendingClaims = new Map<string, Set<ReplayListener>>();

/**
 * Ask for the scrollback the previous view of `processId` handed over.
 * `onReplay` gets it, or null when there is nothing to replay; it is called
 * exactly once, on the IPC message itself, so the caller can tell the live
 * chunks main sent before the answer (inside the replay) from those after it.
 * Returns a cancel function.
 */
export function claimTerminalReplay(processId: string, onReplay: ReplayListener): () => void {
	const api = window.maestro?.tabWindows;
	if (!api?.claimTerminalReplay || !api.onTerminalReplay) {
		onReplay(null);
		return () => {};
	}
	let claim = pendingClaims.get(processId);
	if (!claim) {
		const listeners = new Set<ReplayListener>();
		claim = listeners;
		pendingClaims.set(processId, listeners);
		const answer = (text: string | null) => {
			off();
			clearTimeout(timer);
			if (pendingClaims.get(processId) === listeners) pendingClaims.delete(processId);
			for (const listener of [...listeners]) listener(text);
		};
		const off = api.onTerminalReplay((id, text) => {
			if (id === processId) answer(typeof text === 'string' ? text : null);
		});
		const timer = setTimeout(() => {
			logger.warn('[TerminalHandoff] No replay answer; showing live output only', undefined, {
				processId,
			});
			answer(null);
		}, TERMINAL_CLAIM_TIMEOUT_MS);
		api.claimTerminalReplay(processId);
	}
	const listeners = claim;
	listeners.add(onReplay);
	return () => {
		listeners.delete(onReplay);
	};
}

/**
 * Hand a view's scrollback over as the view goes away (two phases, exact).
 * Main starts holding the PTY's output when it gets the release; the chunks
 * this window receives before main's answer were sent before that, so they
 * join the capture, and the commit carries everything up to the cut.
 */
export function releaseTerminalView(processId: string, capture: TerminalViewCapture): void {
	const api = window.maestro?.tabWindows;
	if (!api?.beginTerminalRelease || !api.onTerminalReleaseBegun || !api.commitTerminalRelease) {
		return;
	}
	const tail = [...capture.unparsed];
	let done = false;
	const finish = () => {
		if (done) return;
		done = true;
		clearTimeout(timer);
		offData();
		offBegun();
		api.commitTerminalRelease(processId, buildTerminalReplay(capture.buffer, tail));
	};
	const offData = window.maestro.process.onData((id, data) => {
		if (id === processId) tail.push(data);
	});
	const offBegun = api.onTerminalReleaseBegun((id) => {
		if (id === processId) finish();
	});
	const timer = setTimeout(finish, TERMINAL_RELEASE_TIMEOUT_MS);
	api.beginTerminalRelease(processId);
}

/** Views that hand their scrollback over when this window unloads. */
const unloadCaptures = new Map<string, () => TerminalViewCapture>();

/**
 * Register a view that releases when the window unloads (a tab window that
 * closes docks its tabs, and its React tree never unmounts). Returns the
 * unregister function; call it when the view unmounts.
 */
export function registerTerminalViewForUnload(
	processId: string,
	capture: () => TerminalViewCapture
): () => void {
	unloadCaptures.set(processId, capture);
	return () => {
		if (unloadCaptures.get(processId) === capture) unloadCaptures.delete(processId);
	};
}

/**
 * Hand every registered view's scrollback over now, in one phase: the window
 * is going away and will not see main's answer. Output that main sent but this
 * window had not received yet is lost, a few milliseconds at most. Bind it to
 * `beforeunload`.
 */
export function releaseRegisteredTerminalViews(): void {
	const api = window.maestro?.tabWindows;
	if (!api?.commitTerminalRelease) return;
	for (const [processId, capture] of unloadCaptures) {
		const { buffer, unparsed } = capture();
		api.commitTerminalRelease(processId, buildTerminalReplay(buffer, unparsed));
	}
	unloadCaptures.clear();
}

/** Test seam: forget claims and registrations between tests. */
export function resetTerminalHandoffForTests(): void {
	pendingClaims.clear();
	unloadCaptures.clear();
}
