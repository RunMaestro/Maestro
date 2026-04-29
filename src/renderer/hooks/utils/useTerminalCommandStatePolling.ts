/**
 * useTerminalCommandStatePolling — Periodic foreground-command snapshot poll
 *
 * Every `intervalMs` (default 5s), enumerates active terminal sessions via
 * `process.getActiveProcesses` and queries `process.getTerminalCommandState`
 * for each one. The IPC handler internally prefers the live shell-integration
 * state and falls back to a `ps`-based child-process probe when no OSC events
 * have arrived (shells without integration, integration disabled, or before
 * the first prompt fires) — so a single poll path covers both code paths.
 *
 * Snapshot dispatch:
 *   - `currentCwd`              → `Session.shellCwd`            (immediate)
 *   - `currentCommand` + `commandRunning`
 *                               → `Session.terminalTabs[]`     (via
 *                                 `updateTerminalTabCommand`, only when the
 *                                 polled session has a populated terminalTabs
 *                                 array — the per-tab terminal UI is a future
 *                                 task; today this is a reference-equality
 *                                 no-op for sessions without terminalTabs)
 *
 * The same session-ID parsing as `onTerminalCwd` / `onTerminalCommandState`
 * is used so the future `${id}-terminal-${tabId}` shape works without
 * re-touching this hook.
 */

import { useEffect } from 'react';
import { useSessionStore } from '../../stores/sessionStore';
import { updateTerminalTabCommand } from '../../utils/terminalTabHelpers';

/** Default polling interval (5s, matches Phase 7 of the terminal-persistence plan). */
export const DEFAULT_TERMINAL_POLL_INTERVAL_MS = 5000;

interface ActiveProcessInfo {
	sessionId: string;
	isTerminal: boolean;
}

/**
 * Parse a process-manager session ID into the owning Maestro session ID
 * and (when present) the per-tab ID.
 *
 * Returns `null` for non-terminal session IDs.
 */
function parseTerminalSessionId(
	sessionId: string
): { actualSessionId: string; tabId: string | null } | null {
	const tabbedMatch = sessionId.match(/^(.+)-terminal-(.+)$/);
	if (tabbedMatch) {
		return { actualSessionId: tabbedMatch[1], tabId: tabbedMatch[2] };
	}
	if (sessionId.endsWith('-terminal')) {
		return { actualSessionId: sessionId.slice(0, -'-terminal'.length), tabId: null };
	}
	return null;
}

/**
 * Apply a `getTerminalCommandState` snapshot to the renderer's session state.
 *
 * Pure-ish (touches `useSessionStore`); exported for testability so the
 * dispatch logic can be exercised without spinning up the polling timer.
 */
export function applyTerminalCommandSnapshot(
	sessionId: string,
	snapshot: {
		currentCommand?: string;
		commandRunning: boolean;
		currentCwd?: string;
	}
): void {
	const parsed = parseTerminalSessionId(sessionId);
	if (!parsed) return;

	const { actualSessionId, tabId } = parsed;

	useSessionStore.getState().setSessions((prev) =>
		prev.map((s) => {
			if (s.id !== actualSessionId) return s;

			let next = s;

			// shellCwd update — match the `onTerminalCwd` listener's behavior so
			// reference equality is preserved on no-ops.
			if (snapshot.currentCwd !== undefined && s.shellCwd !== snapshot.currentCwd) {
				next = { ...next, shellCwd: snapshot.currentCwd };
			}

			// Per-tab command/commandRunning update — only meaningful when the
			// session has a populated `terminalTabs` array AND the snapshot is
			// scoped to a specific tab. `updateTerminalTabCommand` returns the
			// same session reference when no change is needed.
			if (tabId !== null) {
				next = updateTerminalTabCommand(
					next,
					tabId,
					snapshot.currentCommand,
					snapshot.commandRunning
				);
			}

			return next;
		})
	);
}

/**
 * Mount the periodic terminal command-state poll. Call once from App.tsx.
 *
 * Polls every `intervalMs` (default 5s) until unmounted. A new tick will not
 * start while the previous one is still in flight — guarded by a local
 * `inFlight` flag so a slow `ps` invocation can't stack up overlapping polls.
 *
 * Failures from `getActiveProcesses` or `getTerminalCommandState` are logged
 * via `window.maestro.logger.log` and otherwise swallowed: this is a
 * best-effort fallback and a transient IPC blip should not crash the renderer.
 */
export function useTerminalCommandStatePolling(
	intervalMs: number = DEFAULT_TERMINAL_POLL_INTERVAL_MS
): void {
	useEffect(() => {
		let cancelled = false;
		let inFlight = false;

		const tick = async () => {
			if (cancelled || inFlight) return;
			inFlight = true;
			try {
				const processes: ActiveProcessInfo[] =
					(await window.maestro.process.getActiveProcesses()) ?? [];
				if (cancelled) return;

				const terminalIds = processes.filter((p) => p.isTerminal).map((p) => p.sessionId);

				// Issue queries in parallel — the handler is cheap (in-memory read
				// for shell-integration sessions, single `ps`/`wmic` call for the
				// fallback path) and terminal counts are small in practice.
				const snapshots = await Promise.all(
					terminalIds.map(async (sid) => {
						try {
							const snap = await window.maestro.process.getTerminalCommandState(sid);
							return { sid, snap };
						} catch (err) {
							window.maestro.logger.log(
								'debug',
								`getTerminalCommandState failed for ${sid}: ${String(err)}`,
								'useTerminalCommandStatePolling'
							);
							return { sid, snap: null as null };
						}
					})
				);
				if (cancelled) return;

				for (const { sid, snap } of snapshots) {
					if (!snap) continue;
					applyTerminalCommandSnapshot(sid, snap);
				}
			} catch (err) {
				window.maestro.logger.log(
					'debug',
					`terminal command-state poll failed: ${String(err)}`,
					'useTerminalCommandStatePolling'
				);
			} finally {
				inFlight = false;
			}
		};

		const handle = setInterval(() => {
			void tick();
		}, intervalMs);

		return () => {
			cancelled = true;
			clearInterval(handle);
		};
	}, [intervalMs]);
}
