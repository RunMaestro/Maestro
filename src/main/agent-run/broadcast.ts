/**
 * AgentRun live-push broadcaster (F3).
 *
 * A single main-process sink that fans every store write out to the renderer
 * (`agentRun:updated` / `agentRun:eventAppended`) and to web clients. The
 * capture service, the IPC handlers, and the CLI-origin store watcher all call
 * these after a write so the dashboard reflects changes without a manual
 * refresh (ISC-3.1, ISC-3.8).
 *
 * The concrete transport is injected once at startup via `setAgentRunSink` so
 * this module stays decoupled from the BrowserWindow / web-server lifetimes and
 * degrades to a no-op before the window exists or after it is gone.
 */

import type { AgentRun, AgentRunEvent } from '../../shared/agent-run';

export interface AgentRunSink {
	runUpdated: (run: AgentRun) => void;
	eventAppended: (event: AgentRunEvent) => void;
}

let sink: AgentRunSink | undefined;

export function setAgentRunSink(next: AgentRunSink | undefined): void {
	sink = next;
}

export function broadcastRunUpdated(run: AgentRun): void {
	try {
		sink?.runUpdated(run);
	} catch {
		// The renderer/web transport may be tearing down; a push failure must
		// never propagate into a store write path.
	}
}

export function broadcastEventAppended(event: AgentRunEvent): void {
	try {
		sink?.eventAppended(event);
	} catch {
		// See broadcastRunUpdated.
	}
}
