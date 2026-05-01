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
 *
 * All handlers are gated by the `agentDispatch` encore feature flag.
 * When the flag is off, every channel returns:
 *   { success: false, code: 'FEATURE_DISABLED', feature: 'agentDispatch' }
 */

import { ipcMain } from 'electron';
import { requireEncoreFeature } from '../../utils/requireEncoreFeature';
import { getWorkGraphItemStore } from '../../work-graph';
import type { WorkItemFilters, WorkItemClaimReleaseInput } from '../../../shared/work-graph-types';
import type { ManualAssignmentInput } from '../../agent-dispatch/dispatch-engine';
import type { AgentDispatchFleetEntry } from '../../../shared/agent-dispatch-types';
import type { AgentDispatchRuntime } from '../../agent-dispatch/runtime';
import type { SettingsStoreInterface } from '../../stores/types';
import { logger } from '../../utils/logger';

const LOG_CONTEXT = '[AgentDispatch]';

export interface AgentDispatchHandlerDependencies {
	getRuntime: () => AgentDispatchRuntime | null;
	settingsStore: SettingsStoreInterface;
}

export function registerAgentDispatchHandlers(deps: AgentDispatchHandlerDependencies): void {
	const workGraph = getWorkGraphItemStore();

	/** Check the agentDispatch encore feature flag. Returns structured error or null. */
	const gate = () => requireEncoreFeature(deps.settingsStore, 'agentDispatch');

	// -------------------------------------------------------------------------
	// agentDispatch:getBoard
	//
	// Returns work-graph items suitable for a kanban board. The caller may pass
	// WorkItemFilters to scope by project, status, tags, etc. Issue #80 owns
	// the UI; this handler returns a stable { items, total } shape that #80 can
	// depend on directly.
	// -------------------------------------------------------------------------
	ipcMain.handle('agentDispatch:getBoard', async (_event, filters?: WorkItemFilters) => {
		const gateError = gate();
		if (gateError) {
			logger.debug('agentDispatch flag off — rejecting getBoard', LOG_CONTEXT);
			return gateError;
		}
		try {
			const result = await workGraph.listItems(filters ?? {});
			return { success: true, data: result };
		} catch (err) {
			logger.error('getBoard error', LOG_CONTEXT, { error: String(err) });
			return { success: false, error: String(err) };
		}
	});

	// -------------------------------------------------------------------------
	// agentDispatch:getFleet
	//
	// Returns all current fleet entries from the in-memory FleetRegistry.
	// -------------------------------------------------------------------------
	ipcMain.handle('agentDispatch:getFleet', async (_event) => {
		const gateError = gate();
		if (gateError) {
			logger.debug('agentDispatch flag off — rejecting getFleet', LOG_CONTEXT);
			return gateError;
		}
		try {
			const runtime = deps.getRuntime();
			const data: AgentDispatchFleetEntry[] = runtime ? runtime.fleetRegistry.getEntries() : [];
			return { success: true, data };
		} catch (err) {
			logger.error('getFleet error', LOG_CONTEXT, { error: String(err) });
			return { success: false, error: String(err) };
		}
	});

	// -------------------------------------------------------------------------
	// agentDispatch:assignManually
	//
	// Delegates to AgentDispatchEngine.assignManually which enforces that
	// userInitiated must be true (the engine throws otherwise).
	// -------------------------------------------------------------------------
	ipcMain.handle('agentDispatch:assignManually', async (_event, input: ManualAssignmentInput) => {
		const gateError = gate();
		if (gateError) {
			logger.debug('agentDispatch flag off — rejecting assignManually', LOG_CONTEXT);
			return gateError;
		}
		try {
			const runtime = deps.getRuntime();
			if (!runtime) throw new Error('Agent Dispatch runtime is not running');
			const data = await runtime.engine.assignManually(input);
			return { success: true, data };
		} catch (err) {
			logger.error('assignManually error', LOG_CONTEXT, { error: String(err) });
			return { success: false, error: String(err) };
		}
	});

	// -------------------------------------------------------------------------
	// agentDispatch:releaseClaim
	//
	// Releases an active claim on a work item via the Work Graph storage layer.
	// -------------------------------------------------------------------------
	ipcMain.handle('agentDispatch:releaseClaim', async (_event, input: WorkItemClaimReleaseInput) => {
		const gateError = gate();
		if (gateError) {
			logger.debug('agentDispatch flag off — rejecting releaseClaim', LOG_CONTEXT);
			return gateError;
		}
		try {
			const data = await workGraph.releaseClaim(input);
			return { success: true, data };
		} catch (err) {
			logger.error('releaseClaim error', LOG_CONTEXT, { error: String(err) });
			return { success: false, error: String(err) };
		}
	});

	// -------------------------------------------------------------------------
	// agentDispatch:pauseAgent
	//
	// Marks an agent as paused in the FleetRegistry so it stops participating
	// in auto-pickup. This is in-memory only; it resets on restart.
	// TODO(#77): Persist pause state via heartbeat / lease recovery once #77 ships.
	// -------------------------------------------------------------------------
	ipcMain.handle('agentDispatch:pauseAgent', async (_event, agentId: string) => {
		const gateError = gate();
		if (gateError) {
			logger.debug('agentDispatch flag off — rejecting pauseAgent', LOG_CONTEXT);
			return gateError;
		}
		try {
			const runtime = deps.getRuntime();
			if (!runtime) throw new Error('Agent Dispatch runtime is not running');
			runtime.fleetRegistry.pause(agentId);
			return { success: true, data: { paused: true } };
		} catch (err) {
			logger.error('pauseAgent error', LOG_CONTEXT, { error: String(err) });
			return { success: false, error: String(err) };
		}
	});

	// -------------------------------------------------------------------------
	// agentDispatch:resumeAgent
	//
	// Clears the in-memory pause flag for an agent, re-enabling auto-pickup.
	// TODO(#77): Persist resume state via heartbeat / lease recovery once #77 ships.
	// -------------------------------------------------------------------------
	ipcMain.handle('agentDispatch:resumeAgent', async (_event, agentId: string) => {
		const gateError = gate();
		if (gateError) {
			logger.debug('agentDispatch flag off — rejecting resumeAgent', LOG_CONTEXT);
			return gateError;
		}
		try {
			const runtime = deps.getRuntime();
			if (!runtime) throw new Error('Agent Dispatch runtime is not running');
			runtime.fleetRegistry.resume(agentId);
			return { success: true, data: { paused: false } };
		} catch (err) {
			logger.error('resumeAgent error', LOG_CONTEXT, { error: String(err) });
			return { success: false, error: String(err) };
		}
	});
}
