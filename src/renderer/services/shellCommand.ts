/**
 * Command mode ("bang commands") for the AI chat.
 *
 * When a composer message starts with `!`, Maestro runs the rest as a shell
 * command instead of sending it to the agent. The command executes in the
 * agent's working directory (on the agent's SSH remote, when it has one) and
 * its output streams into the transcript as a live card.
 *
 * The agent is bypassed entirely: it is never spawned, never written to, and
 * never sees the command or its output.
 *
 * ## Why a synthetic session id
 *
 * `process.runCommand` keys its `data` / `stderr` / `command-exit` events by
 * sessionId. Reusing the agent's real session id would route the shell output
 * into the agent listeners (useAgentDataListener / useAgentStderrListener /
 * useAgentCommandExitListener), which append to the tab through the batched
 * updater and flip session state. So each run gets its own id shaped
 * `{sessionId}-shell-{runId}`: it matches none of those listeners' patterns
 * (no `-ai-` segment, no `-terminal` suffix, no `-batch-` segment) and no
 * session in the store, so they all no-op and this module owns the stream.
 */

import type { Session, LogEntry } from '../types';
import { generateId } from '../utils/ids';
import { updateAiTab, updateSessionWith } from '../stores/sessionStore';
import { SHELL_COMMAND_PREFIX } from '../utils/shellCommandInput';
import { logger } from '../utils/logger';

/** How many entries the composer's recall history keeps. */
const AI_COMMAND_HISTORY_LIMIT = 50;

/**
 * Hard cap on captured output per command. Transcript logs are persisted to
 * the sessions file, so an unbounded producer (`!yes`, a chatty watcher) must
 * not be able to grow it without limit. Output past the cap is dropped and the
 * card is flagged `truncated`.
 */
export const SHELL_COMMAND_OUTPUT_LIMIT = 200_000;

/**
 * Live runs keyed by the output entry's log id, so the card's Stop button can
 * reach the right process without knowing about session ids.
 */
const activeRuns = new Map<string, { runSessionId: string; markCancelled: () => void }>();

/** Build the per-run process id. Exported for tests. */
export function buildShellRunSessionId(sessionId: string, runId: string): string {
	return `${sessionId}-shell-${runId}`;
}

/**
 * Resolve the directory a bang command will run in.
 *
 * Deliberately NOT `shellCwd`: only terminal mode's `cd` moves that, and a bang
 * command is a fresh shell at the agent's own working directory. Exported so
 * the composer's command-mode bar and Tab completion resolve the same place the
 * command will actually run.
 */
export function resolveCommandCwd(session: Session): string {
	const isRemote = !!session.sshRemoteId || !!session.sessionSshRemoteConfig?.enabled;
	if (isRemote) {
		return session.sessionSshRemoteConfig?.workingDirOverride || session.cwd;
	}
	return session.cwd;
}

/** Append a log entry to a tab. */
function appendEntry(sessionId: string, tabId: string, entry: LogEntry): void {
	updateAiTab(sessionId, tabId, (tab) => ({ ...tab, logs: [...tab.logs, entry] }));
}

/** Patch the output entry in place (text append and/or shellCommand fields). */
function patchOutputEntry(
	sessionId: string,
	tabId: string,
	logId: string,
	patch: (entry: LogEntry) => LogEntry
): void {
	updateAiTab(sessionId, tabId, (tab) => {
		const index = tab.logs.findIndex((l) => l.id === logId);
		if (index === -1) return tab;
		const logs = [...tab.logs];
		logs[index] = patch(logs[index]);
		return { ...tab, logs };
	});
}

/**
 * Stop a running bang command. No-op when the run already finished.
 * Returns true when a kill was actually dispatched.
 */
export async function cancelShellCommand(logId: string): Promise<boolean> {
	const run = activeRuns.get(logId);
	if (!run) return false;
	run.markCancelled();
	return window.maestro.process.cancelCommand(run.runSessionId);
}

/** True while the given output entry's command is still running. */
export function isShellCommandRunning(logId: string): boolean {
	return activeRuns.has(logId);
}

export interface RunShellCommandOptions {
	session: Session;
	/** AI tab the `!command` was typed in - where the card lands. */
	tabId: string;
	/** The command, already stripped of its leading `!`. */
	command: string;
}

/**
 * Run a bang command and stream its output into the tab's transcript.
 *
 * Resolves when the command exits (or fails to start). Callers can fire and
 * forget - all user-visible reporting happens through the transcript card.
 */
export async function runShellCommand(options: RunShellCommandOptions): Promise<void> {
	const { session, tabId, command } = options;

	const runId = generateId();
	const runSessionId = buildShellRunSessionId(session.id, runId);
	const cwd = resolveCommandCwd(session);
	const startedAt = Date.now();

	// One card per run, no separate user-message echo: the card header carries
	// the command, so echoing it first would just duplicate it in the transcript.
	const outputLogId = generateId();
	appendEntry(session.id, tabId, {
		id: outputLogId,
		timestamp: startedAt,
		source: 'stdout',
		text: '',
		shellCommand: {
			command,
			cwd,
			remoteName: session.sshRemote?.name,
			status: 'running',
		},
	});

	// Buffer chunks and flush on a frame so a chatty command doesn't drive one
	// store write (and full transcript re-render) per stdout chunk.
	let pending = '';
	let captured = 0;
	let truncated = false;
	let cancelled = false;
	let flushHandle: number | null = null;
	let flushScheduled = false;

	activeRuns.set(outputLogId, {
		runSessionId,
		markCancelled: () => {
			cancelled = true;
		},
	});

	const flush = (): void => {
		if (!pending) return;
		const chunk = pending;
		pending = '';
		patchOutputEntry(session.id, tabId, outputLogId, (entry) => ({
			...entry,
			text: entry.text + chunk,
			...(truncated &&
				entry.shellCommand && {
					shellCommand: { ...entry.shellCommand, truncated: true },
				}),
		}));
	};

	const scheduleFlush = (): void => {
		if (flushScheduled) return;
		flushScheduled = true;
		flushHandle = window.requestAnimationFrame(() => {
			flushScheduled = false;
			flushHandle = null;
			flush();
		});
	};

	const appendOutput = (sid: string, data: string): void => {
		if (sid !== runSessionId) return;
		if (captured >= SHELL_COMMAND_OUTPUT_LIMIT) {
			truncated = true;
			return;
		}
		let text = data;
		if (captured + text.length > SHELL_COMMAND_OUTPUT_LIMIT) {
			text = text.slice(0, SHELL_COMMAND_OUTPUT_LIMIT - captured);
			truncated = true;
		}
		captured += text.length;
		pending += text;
		scheduleFlush();
	};

	const unsubscribeData = window.maestro.process.onData(appendOutput);
	const unsubscribeStderr = window.maestro.process.onStderr(appendOutput);

	let settle: (() => void) | null = null;
	const finished = new Promise<void>((resolve) => {
		settle = resolve;
	});

	const finish = (exitCode: number): void => {
		if (!activeRuns.has(outputLogId)) return; // Already settled.
		activeRuns.delete(outputLogId);
		unsubscribeData();
		unsubscribeStderr();
		unsubscribeExit();
		if (flushHandle !== null) {
			window.cancelAnimationFrame(flushHandle);
			flushHandle = null;
		}
		flushScheduled = false;
		flush();

		patchOutputEntry(session.id, tabId, outputLogId, (entry) => ({
			...entry,
			...(entry.shellCommand && {
				shellCommand: {
					...entry.shellCommand,
					status: cancelled ? ('cancelled' as const) : ('finished' as const),
					exitCode,
					durationMs: Date.now() - startedAt,
					...(truncated && { truncated: true }),
				},
			}),
		}));
		settle?.();
	};

	const unsubscribeExit = window.maestro.process.onCommandExit((sid, code) => {
		if (sid !== runSessionId) return;
		finish(code);
	});

	let result: { exitCode: number };
	try {
		result = await window.maestro.process.runCommand({
			sessionId: runSessionId,
			command,
			cwd,
			sessionSshRemoteConfig: session.sessionSshRemoteConfig,
		});
	} catch (error) {
		logger.error('[shellCommand] Failed to run command', undefined, error);
		patchOutputEntry(session.id, tabId, outputLogId, (entry) => ({
			...entry,
			text: entry.text + `\nFailed to run command: ${(error as Error).message}`,
		}));
		finish(1);
		return;
	}

	// The `command-exit` event normally settles the card; give it a moment to
	// arrive so any trailing output lands first. The invoke's own exit code is
	// the backstop for the (unexpected) case where the event never shows up.
	await Promise.race([finished, new Promise<void>((r) => window.setTimeout(r, 1000))]);
	if (activeRuns.has(outputLogId)) finish(result.exitCode);
}

/**
 * Record a command in the tab's recall history and run it.
 *
 * Both ways of producing a command land here: typing it in command mode, and
 * accepting one AI command mode proposed. That is deliberate - an accepted
 * suggestion must be indistinguishable from a typed command afterwards, in the
 * transcript and in up-arrow recall alike.
 *
 * The history entry is bang-prefixed because `aiCommandHistory` mixes agent
 * messages and shell commands, and the `!` is what tells them apart on the way
 * back out (up-arrow recall, and the command-mode completion source).
 */
export function dispatchShellCommand(options: RunShellCommandOptions): Promise<void> {
	const { session, tabId, command } = options;
	const historyEntry = `${SHELL_COMMAND_PREFIX}${command}`;

	updateSessionWith(session.id, (s) => ({
		...s,
		aiCommandHistory: [
			...(s.aiCommandHistory || []).filter((c) => c !== historyEntry),
			historyEntry,
		].slice(-AI_COMMAND_HISTORY_LIMIT),
	}));

	return runShellCommand({ session, tabId, command });
}
