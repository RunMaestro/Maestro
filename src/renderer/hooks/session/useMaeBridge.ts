/**
 * useMaeBridge — surfaces externally-run omp/`mae` sessions (tracked via the
 * Maestro bridge host) live in the session list. Subscribes to
 * window.maestro.mae and upserts a synthetic Session into useSessionStore.
 *
 * RUNTIME-UNVERIFIED: this is typechecked (tsc) and mirrors the canonical
 * session shape from useSessionCrud, but its live GUI behavior needs the running
 * app. The synthetic session uses aiPid 0 (a normal "not-yet-spawned batch"
 * state) so it renders safely in the list; correct interaction semantics for a
 * process-less external session (e.g. do not spawn a local PTY on message-send)
 * are a documented refinement, not yet implemented.
 *
 * Scope (see Plans/mae-feature-complete-goal.md section 10):
 *   - Subscribes immediately but defers store writes: applies now when
 *     `sessionsLoaded`, else buffers and flushes in arrival order once
 *     restoration completes. Avoids both the clobber race (restoration replaces
 *     the whole array) and dropping events the host replays on connect.
 *   - When a run resumed an existing Maestro session (`maestroSessionId`), the
 *     real row is reused and only its live-state is patched — never overwritten
 *     with synthetic fields. Otherwise a `mae:<ompSessionId>` row is created.
 *   - Live STATUS comes from transcript METADATA only: the extension emits
 *     `{role,usage}` (message) and `{toolName,status}` (tool), consistent with
 *     the metadata-only security model (never raw transcript over the bridge).
 *     The hook maps turn state today; richer status rendering (last tool, usage,
 *     an activity indicator) is renderer work that needs the running app.
 */

import { useEffect, useRef } from 'react';
import type { AITab, Session, ToolType } from '../../types';
import { useSessionStore } from '../../stores/sessionStore';
import { generateId } from '../../utils/ids';
import { parseSessionEnd, parseSessionEvent, parseSessionRegister } from '../../../mae/protocol';

// `mae` is the Maestro-branded omp TUI; its tracked sessions carry the dedicated
// `'mae'` AGENT_ID (display "Maestro TUI"), distinct from the headless `'omp'`
// agent. (Legacy rows may still be `'pi'`; host-mappers stays compatible.)
const MAE_TOOL_TYPE: ToolType = 'mae';

function syntheticSession(
	rowId: string,
	reg: { ompSessionId: string; cwd: string; title?: string }
): Session {
	const tabId = generateId();
	const now = Date.now();
	const tab: AITab = {
		id: tabId,
		agentSessionId: reg.ompSessionId,
		name: null,
		starred: false,
		logs: [],
		inputValue: '',
		stagedImages: [],
		createdAt: now,
		state: 'idle',
		saveToHistory: false,
		showThinking: 'off',
	};
	return {
		id: rowId,
		name: reg.title ?? 'omp session',
		toolType: MAE_TOOL_TYPE,
		state: 'busy',
		cwd: reg.cwd,
		fullPath: reg.cwd,
		projectRoot: reg.cwd,
		createdAt: now,
		isGitRepo: false,
		aiLogs: [],
		shellLogs: [],
		workLog: [],
		contextUsage: 0,
		inputMode: 'ai',
		aiPid: 0,
		terminalPid: 0,
		port: 0,
		isLive: false,
		changedFiles: [],
		fileTree: [],
		fileExplorerExpanded: [],
		fileExplorerScrollPos: 0,
		shellCwd: reg.cwd,
		aiCommandHistory: [],
		shellCommandHistory: [],
		executionQueue: [],
		activeTimeMs: 0,
		aiTabs: [tab],
		activeTabId: tabId,
		closedTabHistory: [],
		filePreviewTabs: [],
		activeFileTabId: null,
		browserTabs: [],
		activeBrowserTabId: null,
		terminalTabs: [],
		activeTerminalTabId: null,
		unifiedTabOrder: [{ type: 'ai' as const, id: tabId }],
		unifiedClosedTabHistory: [],
	};
}

export function useMaeBridge(): void {
	// useSessionRestoration replaces the whole session array on startup. Subscribe
	// immediately (so no `session.register` is missed), but defer store writes
	// until restoration completes: apply now when `sessionsLoaded`, else buffer
	// and flush in arrival order afterwards. This avoids BOTH the clobber race
	// (writing before restoration overwrites our row) and the drop race (gating
	// the subscription would miss events the host replays on connect).
	const sessionsLoaded = useSessionStore((s) => s.sessionsLoaded);
	// omp session id -> Maestro session row id (real id when resumed, else mae:*).
	const rowIdByOmp = useRef<Map<string, string>>(new Map());
	const pending = useRef<Array<() => void>>([]);

	useEffect(() => {
		const mae = window.maestro?.mae;
		if (!mae) return;
		const rowIds = rowIdByOmp.current;

		// Apply a store mutation now if restoration is done, else queue it.
		const apply = (mutate: () => void): void => {
			if (useSessionStore.getState().sessionsLoaded) mutate();
			else pending.current.push(mutate);
		};

		const unsubscribers = [
			mae.onSessionRegistered((payload) => {
				const reg = parseSessionRegister(payload);
				if (!reg) return;
				// Resumed an existing Maestro session -> reuse its row; else new mae row.
				const rowId = reg.maestroSessionId ?? `mae:${reg.ompSessionId}`;
				rowIds.set(reg.ompSessionId, rowId);
				apply(() => {
					const store = useSessionStore.getState();
					if (store.sessions.some((s) => s.id === rowId)) {
						// Never overwrite a real session's fields; only reflect that it is
						// active. `isLive` means "served via Maestro's web interface" here,
						// which an external omp run is not, so we signal via `state` only.
						store.updateSession(rowId, { state: 'busy' });
					} else {
						store.addSession(syntheticSession(rowId, reg));
					}
				});
			}),
			mae.onSessionEvent((payload) => {
				const event = parseSessionEvent(payload);
				if (!event) return;
				const rowId = rowIds.get(event.ompSessionId) ?? `mae:${event.ompSessionId}`;
				// message/tool carry only {role,usage}/{toolName,status} and there is no
				// status event yet, so the only verifiable mapping is the turn state.
				const state =
					event.kind === 'turn_start' ? 'busy' : event.kind === 'turn_end' ? 'idle' : undefined;
				if (state) apply(() => useSessionStore.getState().updateSession(rowId, { state }));
			}),
			mae.onSessionEnded((payload) => {
				const ended = parseSessionEnd(payload);
				if (!ended) return;
				const rowId = rowIds.get(ended.ompSessionId) ?? `mae:${ended.ompSessionId}`;
				// Finalize but KEEP the row in the list (reopenable).
				apply(() => useSessionStore.getState().updateSession(rowId, { state: 'idle' }));
				rowIds.delete(ended.ompSessionId);
			}),
		];
		return () => {
			for (const unsubscribe of unsubscribers) unsubscribe();
		};
	}, []);

	// Flush buffered mutations in arrival order once restoration completes.
	useEffect(() => {
		if (!sessionsLoaded) return;
		const queued = pending.current;
		pending.current = [];
		for (const mutate of queued) mutate();
	}, [sessionsLoaded]);
}
