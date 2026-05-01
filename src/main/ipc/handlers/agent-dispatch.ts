/**
 * Agent Dispatch IPC Handlers
 *
 * Exposes the Agent Dispatch runtime (fleet registry + assignment engine) to
 * the renderer via strongly-typed IPC channels.
 *
 * Channel conventions:
 *   agentDispatch:getBoard        → kanban-ready work items from Work Graph
 *   agentDispatch:getFleet        → current fleet entries from FleetRegistry
 *   agentDispatch:assignManually  → manual claim via AgentDispatchEngine
 *   agentDispatch:releaseClaim    → release a work item claim via WorkGraphStorage
 *   agentDispatch:pauseAgent      → pause auto-pickup for an agent
 *   agentDispatch:resumeAgent     → resume auto-pickup for an agent
 *
 * Pause/resume are implemented through FleetRegistry.pause()/resume() which
 * flip a local in-memory pause flag. They do NOT persist across restarts.
 * TODO(#77): Wire pause state to heartbeat / lease recovery when #77 ships.
 */

import { ipcMain } from 'electron';
import { createIpcDataHandler } from '../../utils/ipcHandler';
import { getWorkGraphItemStore } from '../../work-graph';
import type { WorkItemFilters, WorkItemClaimReleaseInput } from '../../../shared/work-graph-types';
import type { ManualAssignmentInput } from '../../agent-dispatch/dispatch-engine';
import type { AgentDispatchFleetEntry } from '../../../shared/agent-dispatch-types';
import type { AgentDispatchRuntime } from '../../agent-dispatch/runtime';

const LOG_CONTEXT = '[AgentDispatch]';

export interface AgentDispatchHandlerDependencies {
	getRuntime: () => AgentDispatchRuntime | null;
}

export function registerAgentDispatchHandlers(deps: AgentDispatchHandlerDependencies): void {
	const workGraph = getWorkGraphItemStore();

	// -------------------------------------------------------------------------
	// agentDispatch:getBoard
	//
	// Returns work-graph items suitable for a kanban board. The caller may pass
	// WorkItemFilters to scope by project, status, tags, etc. Issue #80 owns
	// the UI; this handler returns a stable { items, total } shape that #80 can
	// depend on directly.
	// -------------------------------------------------------------------------
	ipcMain.handle(
		'agentDispatch:getBoard',
		createIpcDataHandler(
			{ context: LOG_CONTEXT, operation: 'getBoard', logSuccess: false },
			(filters?: WorkItemFilters) => workGraph.listItems(filters ?? {})
		)
	);

	// -------------------------------------------------------------------------
	// agentDispatch:getFleet
	//
	// Returns all current fleet entries from the in-memory FleetRegistry.
	// -------------------------------------------------------------------------
	ipcMain.handle(
		'agentDispatch:getFleet',
		createIpcDataHandler(
			{ context: LOG_CONTEXT, operation: 'getFleet', logSuccess: false },
			async (): Promise<AgentDispatchFleetEntry[]> => {
				const runtime = deps.getRuntime();
				if (!runtime) {
					return [];
				}
				return runtime.fleetRegistry.getEntries();
			}
		)
	);

	// -------------------------------------------------------------------------
	// agentDispatch:assignManually
	//
	// Delegates to AgentDispatchEngine.assignManually which enforces that
	// userInitiated must be true (the engine throws otherwise).
	// -------------------------------------------------------------------------
	ipcMain.handle(
		'agentDispatch:assignManually',
		createIpcDataHandler(
			{ context: LOG_CONTEXT, operation: 'assignManually' },
			async (input: ManualAssignmentInput) => {
				const runtime = deps.getRuntime();
				if (!runtime) {
					throw new Error('Agent Dispatch runtime is not running');
				}
				return runtime.engine.assignManually(input);
			}
		)
	);

	// -------------------------------------------------------------------------
	// agentDispatch:releaseClaim
	//
	// Releases an active claim on a work item via the Work Graph storage layer.
	// -------------------------------------------------------------------------
	ipcMain.handle(
		'agentDispatch:releaseClaim',
		createIpcDataHandler(
			{ context: LOG_CONTEXT, operation: 'releaseClaim' },
			(input: WorkItemClaimReleaseInput) => workGraph.releaseClaim(input)
		)
	);

	// -------------------------------------------------------------------------
	// agentDispatch:pauseAgent
	//
	// Marks an agent as paused in the FleetRegistry so it stops participating
	// in auto-pickup. This is in-memory only; it resets on restart.
	// TODO(#77): Persist pause state via heartbeat / lease recovery once #77 ships.
	// -------------------------------------------------------------------------
	ipcMain.handle(
		'agentDispatch:pauseAgent',
		createIpcDataHandler(
			{ context: LOG_CONTEXT, operation: 'pauseAgent' },
			async (agentId: string): Promise<{ paused: boolean }> => {
				const runtime = deps.getRuntime();
				if (!runtime) {
					throw new Error('Agent Dispatch runtime is not running');
				}
				runtime.fleetRegistry.pause(agentId);
				return { paused: true };
			}
		)
	);

	// -------------------------------------------------------------------------
	// agentDispatch:resumeAgent
	//
	// Clears the in-memory pause flag for an agent, re-enabling auto-pickup.
	// TODO(#77): Persist resume state via heartbeat / lease recovery once #77 ships.
	// -------------------------------------------------------------------------
	ipcMain.handle(
		'agentDispatch:resumeAgent',
		createIpcDataHandler(
			{ context: LOG_CONTEXT, operation: 'resumeAgent' },
			async (agentId: string): Promise<{ paused: boolean }> => {
				const runtime = deps.getRuntime();
				if (!runtime) {
					throw new Error('Agent Dispatch runtime is not running');
				}
				runtime.fleetRegistry.resume(agentId);
				return { paused: false };
			}
		)
	);
}
