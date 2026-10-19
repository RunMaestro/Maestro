/**
 * Tab Windows terminal handoff (D5): moving a terminal tab's VIEW between
 * windows without losing or repeating output.
 *
 * The PTY lives here and never moves. What moves is the xterm that shows it,
 * and the scrollback exists only inside a mounted xterm (no copy in main or in
 * the store). So a window that gives up its view hands the scrollback over,
 * and a window that mounts a view replays it.
 *
 * Every window receives every `process:data` chunk, so two windows see the
 * same stream at slightly different times. Main is the one place that orders a
 * cut against that stream: every reply below goes out on the asking window's
 * own channel, in order with the `process:data` it was sent before or after.
 *
 * ```
 * releaser                          main                              claimer
 * unmount: read buffer B,
 *   keep the chunks that come  ->   begin: hold the output from here
 *   after it                   <-   releaseBegun (after every chunk sent before begin)
 * commit(B + those chunks)     ->   text = B + chunks; held output follows it
 *                                   claim  <-  mount: hold live chunks back
 *                                   replay(text + held)  ->  drop every chunk that came
 *                                   stop holding             before the replay, write
 *                                                            the replay, go live
 * ```
 *
 * A move announced by the registry ({@link expectTerminalHandoff}, from
 * pop-out and dock) makes a claim WAIT for the release, because the claimer
 * may mount before the releaser has unmounted. A claim with nothing announced
 * and nothing held answers null at once (an ordinary first mount).
 */

import { ipcMain } from 'electron';
import { getTerminalSessionId, parseTerminalSessionId } from '../shared/terminalSessionId';
import {
	capTerminalHandoff,
	TERMINAL_HANDOFF_MAX_CHARS,
	TERMINAL_HANDOFF_UNCLAIMED_TTL_MS,
	TERMINAL_HANDOFF_WAIT_MS,
} from '../shared/terminalReplay';
import { TAB_WINDOW_CHANNELS } from '../shared/tabWindowTypes';
import type { SingleTabRef } from '../shared/unifiedTabRef';
import { logger } from './utils/logger';

const LOG_CONTEXT = '[TerminalHandoff]';

/** Answers a claim: the replay, or null when there is nothing to replay. */
export type TerminalReplayReply = (text: string | null) => void;

interface Handoff {
	/**
	 * `expected`: a move was announced, the old view still shows the PTY.
	 * `holding`: the old view let go; output is held from here.
	 * `committed`: the old view's scrollback arrived; output is still held.
	 */
	phase: 'expected' | 'holding' | 'committed';
	text: string;
	held: string[];
	heldChars: number;
	waiters: TerminalReplayReply[];
	timer: ReturnType<typeof setTimeout> | null;
}

export interface TerminalHandoffOptions {
	waitMs?: number;
	unclaimedTtlMs?: number;
}

export interface TerminalHandoff {
	/** A move of this PTY's view was announced: a claim waits for its release. */
	expect(processId: string): void;
	/** The old view let go: hold this PTY's output from now on. */
	begin(processId: string): void;
	/** The old view's scrollback. Answers waiting claims, or waits for one. */
	commit(processId: string, text: string): void;
	/** A new view wants the replay. Answers now, or once the release commits. */
	claim(processId: string, reply: TerminalReplayReply): void;
	/** One `process:data` send, at the moment it is sent. */
	noteData(processId: string, data: string): void;
	/** Whether anything is held or announced for this PTY (tests, diagnostics). */
	has(processId: string): boolean;
	/** Drop everything, answering waiting claims with null. */
	clear(): void;
}

export function createTerminalHandoff(options: TerminalHandoffOptions = {}): TerminalHandoff {
	const waitMs = options.waitMs ?? TERMINAL_HANDOFF_WAIT_MS;
	const unclaimedTtlMs = options.unclaimedTtlMs ?? TERMINAL_HANDOFF_UNCLAIMED_TTL_MS;
	const handoffs = new Map<string, Handoff>();

	const settle = (processId: string, text: string | null) => {
		const handoff = handoffs.get(processId);
		if (!handoff) return;
		handoffs.delete(processId);
		if (handoff.timer) clearTimeout(handoff.timer);
		for (const reply of handoff.waiters) reply(text);
	};

	const arm = (processId: string, handoff: Handoff, ms: number) => {
		if (handoff.timer) clearTimeout(handoff.timer);
		handoff.timer = setTimeout(() => {
			if (handoffs.get(processId) !== handoff) return;
			logger.debug(`Handoff of ${processId} expired in phase ${handoff.phase}`, LOG_CONTEXT);
			settle(processId, null);
		}, ms);
	};

	/** A fresh record, keeping the claims that already wait on this PTY. */
	const replace = (processId: string, phase: Handoff['phase']): Handoff => {
		const previous = handoffs.get(processId);
		if (previous?.timer) clearTimeout(previous.timer);
		const handoff: Handoff = {
			phase,
			text: '',
			held: [],
			heldChars: 0,
			waiters: previous?.waiters ?? [],
			timer: null,
		};
		handoffs.set(processId, handoff);
		return handoff;
	};

	const replay = (handoff: Handoff) => capTerminalHandoff(handoff.text + handoff.held.join(''));

	return {
		expect(processId) {
			// Anything held from an earlier move is stale once a new one starts.
			arm(processId, replace(processId, 'expected'), waitMs);
		},
		begin(processId) {
			const current = handoffs.get(processId);
			const handoff =
				current && current.phase === 'expected' ? current : replace(processId, 'holding');
			handoff.phase = 'holding';
			arm(processId, handoff, waitMs);
		},
		commit(processId, text) {
			// A release with no begin (a window closing) holds output from now.
			const current = handoffs.get(processId);
			const handoff =
				current && current.phase !== 'committed' ? current : replace(processId, 'committed');
			handoff.phase = 'committed';
			handoff.text = typeof text === 'string' ? text : '';
			if (handoff.waiters.length > 0) {
				settle(processId, replay(handoff));
				return;
			}
			arm(processId, handoff, unclaimedTtlMs);
		},
		claim(processId, reply) {
			const handoff = handoffs.get(processId);
			if (!handoff) {
				reply(null);
				return;
			}
			if (handoff.phase === 'committed') {
				handoff.waiters.push(reply);
				settle(processId, replay(handoff));
				return;
			}
			handoff.waiters.push(reply);
		},
		noteData(processId, data) {
			const handoff = handoffs.get(processId);
			// While a move is only announced, the old view still writes the output.
			if (!handoff || handoff.phase === 'expected') return;
			handoff.held.push(data);
			handoff.heldChars += data.length;
			if (handoff.heldChars > TERMINAL_HANDOFF_MAX_CHARS) {
				const kept = capTerminalHandoff(handoff.held.join(''));
				handoff.held = [kept];
				handoff.heldChars = kept.length;
			}
		},
		has(processId) {
			return handoffs.has(processId);
		},
		clear() {
			for (const processId of [...handoffs.keys()]) settle(processId, null);
		},
	};
}

/** The app's one handoff, shared by the IPC handlers, the data listener, and the registry callers. */
export const terminalHandoff = createTerminalHandoff();

/**
 * Announce that a terminal tab's view is moving to another window (pop-out,
 * dock, a tab window closing). A no-op for every other tab type.
 */
export function expectTerminalHandoff(agentId: string, tabRef: SingleTabRef): void {
	if (tabRef.type !== 'terminal') return;
	terminalHandoff.expect(getTerminalSessionId(agentId, tabRef.id));
}

/** A terminal PTY's process id, or null for anything else a renderer sends. */
function asTerminalProcessId(value: unknown): string | null {
	return typeof value === 'string' && parseTerminalSessionId(value) ? value : null;
}

/** Send to one renderer, unless it went away meanwhile. */
function sendTo(sender: Electron.WebContents, channel: string, ...args: unknown[]): void {
	if (!sender.isDestroyed()) sender.send(channel, ...args);
}

/**
 * Register the handoff channels. Replies go on the asking window's own
 * webContents, the channel its `process:data` arrives on, which is what orders
 * them against the output stream. Not on the web-desktop bridge (TW-13).
 */
export function registerTerminalHandoffHandlers(handoff: TerminalHandoff = terminalHandoff): void {
	ipcMain.on(TAB_WINDOW_CHANNELS.terminalRelease, (event, value: unknown) => {
		const processId = asTerminalProcessId(value);
		if (!processId) return;
		handoff.begin(processId);
		sendTo(event.sender, TAB_WINDOW_CHANNELS.terminalReleaseBegun, processId);
	});
	ipcMain.on(TAB_WINDOW_CHANNELS.terminalCommit, (_event, value: unknown, text: unknown) => {
		const processId = asTerminalProcessId(value);
		if (!processId) return;
		handoff.commit(processId, typeof text === 'string' ? text : '');
	});
	ipcMain.on(TAB_WINDOW_CHANNELS.terminalClaim, (event, value: unknown) => {
		const processId = asTerminalProcessId(value);
		if (!processId) return;
		const sender = event.sender;
		handoff.claim(processId, (text) =>
			sendTo(sender, TAB_WINDOW_CHANNELS.terminalReplay, processId, text)
		);
	});
}
