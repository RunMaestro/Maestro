/**
 * Auto Run snapshots for a package main builds on its own.
 *
 * Auto Run's live state exists only in each app window's in-memory
 * `batchStore`. The desktop's Create Debug Package hands it over from the
 * window that was clicked; `maestro-cli support-package` and Feedback's support
 * package are built in main with no renderer in the loop, so main asks every
 * app window for it here, in parallel, with a short budget.
 *
 * Never throws. A missing window, a timeout, and a renderer error are expected
 * failures: they resolve to a typed "unavailable" result whose reason the
 * package records, and they are logged at warn, not sent to Sentry (a renderer
 * error was already reported by the renderer that hit it).
 */

import type { BrowserWindow } from 'electron';
import {
	AUTO_RUN_SNAPSHOT_REQUEST_CHANNEL,
	type AutoRunDebugSnapshot,
	type AutoRunSnapshotReply,
} from '../../shared/debugPackage';
import { requestFromRenderer } from '../web-server/callbacks/remoteRequest';
import { isWebContentsAvailable } from '../utils/safe-send';
import { logger } from '../utils/logger';
import { sanitizeLogMessage } from './collectors/sanitize';

const LOG_CONTEXT = 'DebugPackage';

/** A package build must never stall on a window that does not answer. */
export const AUTO_RUN_SNAPSHOT_TIMEOUT_MS = 3_000;

export type AutoRunSnapshotUnavailableReason = 'no-window' | 'timeout' | 'renderer-error';

export type AutoRunSnapshotResult =
	| {
			available: true;
			snapshots: AutoRunDebugSnapshot[];
			windowsAsked: number;
			windowsAnswered: number;
	  }
	| {
			available: false;
			reason: AutoRunSnapshotUnavailableReason;
			/** A sentence for a human reading the package. */
			detail: string;
			windowsAsked: number;
	  };

/** The window fields this needs; a `RegisteredWindow` satisfies it. */
export interface AutoRunSnapshotWindow {
	id: string;
	browserWindow: BrowserWindow;
}

export interface RequestAutoRunSnapshotsOptions {
	/** The ID of the window that owns an agent, or null. Breaks merge ties. */
	ownerOf?: (sessionId: string) => string | null;
	timeoutMs?: number;
}

const UNAVAILABLE_DETAIL: Record<
	Exclude<AutoRunSnapshotUnavailableReason, 'renderer-error'>,
	string
> = {
	'no-window': 'No Maestro window was open to report Auto Run state.',
	timeout: 'No Maestro window answered the request for Auto Run state in time.',
};

type WindowOutcome =
	| { kind: 'answered'; windowId: string; snapshots: AutoRunDebugSnapshot[] }
	| { kind: 'no-window' }
	| { kind: 'timeout' }
	| { kind: 'renderer-error'; error: string };

/** The fallback `requestFromRenderer` resolves when the window stays silent. */
const NO_REPLY = Symbol('no-reply');

function parseReply(raw: unknown): AutoRunSnapshotReply {
	const reply = raw as Partial<AutoRunSnapshotReply> | null | undefined;
	if (reply?.ok === true && Array.isArray(reply.snapshots)) {
		return { ok: true, snapshots: reply.snapshots };
	}
	if (reply?.ok === false && typeof reply.error === 'string') {
		return { ok: false, error: reply.error };
	}
	return { ok: false, error: 'The window sent a malformed Auto Run snapshot reply.' };
}

async function askWindow(win: AutoRunSnapshotWindow, timeoutMs: number): Promise<WindowOutcome> {
	if (!isWebContentsAvailable(win.browserWindow)) return { kind: 'no-window' };
	const reply = await requestFromRenderer<AutoRunSnapshotReply | typeof NO_REPLY>(
		win.browserWindow,
		AUTO_RUN_SNAPSHOT_REQUEST_CHANNEL,
		{ fallback: NO_REPLY, parse: parseReply, timeoutMs }
	);
	if (reply === NO_REPLY) {
		// `requestFromRenderer` also falls back at once when the send throws,
		// which is a window torn down mid-request.
		return isWebContentsAvailable(win.browserWindow) ? { kind: 'timeout' } : { kind: 'no-window' };
	}
	if (!reply.ok) return { kind: 'renderer-error', error: reply.error };
	return { kind: 'answered', windowId: win.id, snapshots: reply.snapshots };
}

function isActive(snapshot: AutoRunDebugSnapshot): boolean {
	return snapshot.isRunning || snapshot.isStopping || snapshot.hasError || snapshot.errorPaused;
}

/**
 * One entry per agent. Two windows can both hold one after "Move to Window"
 * (a reset entry in the former owner, the live run in the new one), so an
 * active entry beats an inactive one, then the owning window's entry wins,
 * then the newer `lastActiveTimestamp`.
 */
function mergeSnapshots(
	answers: Array<Extract<WindowOutcome, { kind: 'answered' }>>,
	ownerOf: (sessionId: string) => string | null
): AutoRunDebugSnapshot[] {
	const best = new Map<string, { snapshot: AutoRunDebugSnapshot; windowId: string }>();
	for (const { windowId, snapshots } of answers) {
		for (const snapshot of snapshots) {
			const current = best.get(snapshot.sessionId);
			if (!current || beats(snapshot, windowId, current.snapshot, current.windowId, ownerOf)) {
				best.set(snapshot.sessionId, { snapshot, windowId });
			}
		}
	}
	return [...best.values()].map((entry) => entry.snapshot);
}

function beats(
	candidate: AutoRunDebugSnapshot,
	candidateWindowId: string,
	current: AutoRunDebugSnapshot,
	currentWindowId: string,
	ownerOf: (sessionId: string) => string | null
): boolean {
	const candidateActive = isActive(candidate);
	if (candidateActive !== isActive(current)) return candidateActive;
	const owner = ownerOf(candidate.sessionId);
	if (owner !== null && (candidateWindowId === owner) !== (currentWindowId === owner)) {
		return candidateWindowId === owner;
	}
	return (candidate.lastActiveTimestamp ?? 0) > (current.lastActiveTimestamp ?? 0);
}

/**
 * Ask every app window for its Auto Run snapshots and merge the answers. Pass
 * `windowRegistry.getAppWindows()`: feature windows never mount `App`, so they
 * would never answer. Windows are asked in parallel, so the worst-case wait is
 * one `timeoutMs`, and with no windows there is no wait at all.
 */
export async function requestAutoRunSnapshots(
	windows: readonly AutoRunSnapshotWindow[],
	{
		ownerOf = () => null,
		timeoutMs = AUTO_RUN_SNAPSHOT_TIMEOUT_MS,
	}: RequestAutoRunSnapshotsOptions = {}
): Promise<AutoRunSnapshotResult> {
	const windowsAsked = windows.length;
	const outcomes = await Promise.all(windows.map((win) => askWindow(win, timeoutMs)));
	const answers = outcomes.filter(
		(o): o is Extract<WindowOutcome, { kind: 'answered' }> => o.kind === 'answered'
	);

	if (answers.length > 0) {
		if (answers.length < windowsAsked) {
			logger.warn('Some windows did not report Auto Run state', LOG_CONTEXT, {
				windowsAsked,
				windowsAnswered: answers.length,
			});
		}
		return {
			available: true,
			snapshots: mergeSnapshots(answers, ownerOf),
			windowsAsked,
			windowsAnswered: answers.length,
		};
	}

	const rendererError = outcomes.find(
		(o): o is Extract<WindowOutcome, { kind: 'renderer-error' }> => o.kind === 'renderer-error'
	);
	if (rendererError) {
		const detail = `A Maestro window failed to capture Auto Run state: ${sanitizeLogMessage(rendererError.error)}`;
		logger.warn('Auto Run state unavailable for the package', LOG_CONTEXT, { detail });
		return { available: false, reason: 'renderer-error', detail, windowsAsked };
	}

	const reason = outcomes.some((o) => o.kind === 'timeout') ? 'timeout' : 'no-window';
	logger.warn('Auto Run state unavailable for the package', LOG_CONTEXT, { reason, windowsAsked });
	return { available: false, reason, detail: UNAVAILABLE_DETAIL[reason], windowsAsked };
}
