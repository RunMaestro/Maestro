/**
 * Agent Dispatch Slash-command IPC Handlers
 *
 * NOTE: Despite the historical "-mcp" suffix on the old filename, this file
 * does NOT register tools with Maestro's MCP server (`src/main/mcp/`).  It
 * registers plain Electron IPC channels (`ipcMain.handle(...)`) that serve
 * renderer slash-command operations.  If/when real agent-dispatch MCP tools
 * are added to `src/main/mcp/`, they must live in a separate file and be
 * gated by `encoreFeatures.agentDispatch` there too.
 *
 * Exposes an in-memory dispatch registry to the renderer for slash-command
 * operations. This layer maintains its own lightweight registry (separate from
 * the full AgentDispatchRuntime) so it is available immediately at app start
 * without waiting for the runtime to initialise.
 *
 * Channels registered:
 *   agentDispatch:listAgents    — list registered agents
 *   agentDispatch:listEligible  — list unclaimed agent-ready work items
 *   agentDispatch:assign        — manually assign a work item to an agent
 *   agentDispatch:release       — release an in-progress item back to agent-ready
 *   agentDispatch:pause         — mark an agent as offline (paused)
 *   agentDispatch:resume        — restore an offline agent to idle
 *   agentDispatch:createSubtask — create a subtask under an existing work item
 *   agentDispatch:status        — combined snapshot for slash commands
 *
 * All eight channels are gated by the `agentDispatch` encore feature flag via
 * `requireEncoreFeature()`.  When the flag is off, callers receive:
 *   { success: false, code: 'FEATURE_DISABLED', feature: 'agentDispatch' }
 */

import { ipcMain } from 'electron';
import type {
	DispatchAgent,
	DispatchWorkItem,
	CreateSubtaskParams,
} from '../../../shared/agent-dispatch-types';
import { generateUUID } from '../../../shared/uuid';
import { logger } from '../../utils/logger';
import { requireEncoreFeature } from '../../utils/requireEncoreFeature';
import type { SettingsStoreInterface } from '../../stores/types';

const LOG_CONTEXT = '[AgentDispatch:SlashCommands]';

// ---------------------------------------------------------------------------
// In-memory registry
// ---------------------------------------------------------------------------

export interface DispatchRegistry {
	agents: Map<string, DispatchAgent>;
	workItems: Map<string, DispatchWorkItem>;
}

/**
 * Exported for direct test access only — do NOT mutate from production code.
 * @internal
 */
export const _dispatchRegistry: DispatchRegistry = {
	agents: new Map(),
	workItems: new Map(),
};

// ---------------------------------------------------------------------------
// Public mutators (used by the agent process lifecycle to keep the registry
// in sync with running sessions)
// ---------------------------------------------------------------------------

export function registerAgent(agent: DispatchAgent): void {
	_dispatchRegistry.agents.set(agent.sessionId, agent);
}

export function unregisterAgent(sessionId: string): void {
	_dispatchRegistry.agents.delete(sessionId);
}

export function upsertWorkItem(item: DispatchWorkItem): void {
	_dispatchRegistry.workItems.set(item.id, item);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type IpcResult<T> = ({ success: true } & T) | { success: false; error: string };

function ok<T>(data: T): { success: true } & T {
	return { success: true, ...data } as { success: true } & T;
}

function err(message: string): { success: false; error: string } {
	return { success: false, error: message };
}

// ---------------------------------------------------------------------------
// Handler registration
// ---------------------------------------------------------------------------

/** @deprecated Use `AgentDispatchSlashCommandHandlerDependencies` — the "Mcp" name was historical. */
export type AgentDispatchMcpHandlerDependencies = AgentDispatchSlashCommandHandlerDependencies;

export interface AgentDispatchSlashCommandHandlerDependencies {
	settingsStore: SettingsStoreInterface;
}

export function registerAgentDispatchSlashCommandHandlers(
	deps?: AgentDispatchSlashCommandHandlerDependencies
): void {
	/** Check the agentDispatch encore feature flag. Returns structured error or null. */
	const gate = () => (deps ? requireEncoreFeature(deps.settingsStore, 'agentDispatch') : null);

	// -----------------------------------------------------------------------
	// agentDispatch:listAgents
	// -----------------------------------------------------------------------
	ipcMain.handle('agentDispatch:listAgents', () => {
		const gateError = gate();
		if (gateError) return gateError;
		const agents = [..._dispatchRegistry.agents.values()];
		return ok({ agents });
	});

	// -----------------------------------------------------------------------
	// agentDispatch:listEligible
	// Unclaimed, agent-ready items (status === 'agent-ready', no claimedBySessionId)
	// -----------------------------------------------------------------------
	ipcMain.handle('agentDispatch:listEligible', () => {
		const gateError = gate();
		if (gateError) return gateError;
		const items = [..._dispatchRegistry.workItems.values()].filter(
			(item) => item.status === 'agent-ready' && !item.claimedBySessionId
		);
		return ok({ items });
	});

	// -----------------------------------------------------------------------
	// agentDispatch:assign
	// Claim a work item for an agent. Validates item status and agent idle state.
	// -----------------------------------------------------------------------
	ipcMain.handle(
		'agentDispatch:assign',
		(
			_event,
			params: { itemId: string; sessionId: string }
		): IpcResult<{ item: DispatchWorkItem }> => {
			const gateError = gate();
			if (gateError) return gateError;
			const item = _dispatchRegistry.workItems.get(params.itemId);
			if (!item) {
				return err(`Work item ${params.itemId} not found`);
			}
			if (item.status !== 'agent-ready') {
				return err(`Work item ${params.itemId} is not agent-ready (status: ${item.status})`);
			}
			if (item.claimedBySessionId) {
				return err(`Work item ${params.itemId} is already claimed by ${item.claimedBySessionId}`);
			}

			const agent = _dispatchRegistry.agents.get(params.sessionId);
			if (!agent) {
				return err(`Agent ${params.sessionId} not found`);
			}
			if (agent.availability !== 'idle') {
				return err(`Agent ${params.sessionId} is not idle (availability: ${agent.availability})`);
			}

			const updatedItem: DispatchWorkItem = {
				...item,
				status: 'in-progress',
				claimedBySessionId: params.sessionId,
				claimedAt: new Date().toISOString(),
			};
			_dispatchRegistry.workItems.set(updatedItem.id, updatedItem);

			const updatedAgent: DispatchAgent = {
				...agent,
				availability: 'busy',
				currentWorkItemId: updatedItem.id,
			};
			_dispatchRegistry.agents.set(updatedAgent.sessionId, updatedAgent);

			return ok({ item: updatedItem });
		}
	);

	// -----------------------------------------------------------------------
	// agentDispatch:release
	// Release an in-progress item back to agent-ready and free the agent.
	// -----------------------------------------------------------------------
	ipcMain.handle(
		'agentDispatch:release',
		(_event, params: { itemId: string }): IpcResult<{ item: DispatchWorkItem }> => {
			const gateError = gate();
			if (gateError) return gateError;
			const item = _dispatchRegistry.workItems.get(params.itemId);
			if (!item) {
				return err(`Work item ${params.itemId} not found`);
			}
			if (item.status !== 'in-progress') {
				return err(`Work item ${params.itemId} is not in-progress (status: ${item.status})`);
			}

			// Free the claiming agent if it is still registered
			if (item.claimedBySessionId) {
				const agent = _dispatchRegistry.agents.get(item.claimedBySessionId);
				if (agent) {
					const updatedAgent: DispatchAgent = {
						...agent,
						availability: 'idle',
						currentWorkItemId: undefined,
					};
					_dispatchRegistry.agents.set(updatedAgent.sessionId, updatedAgent);
				}
			}

			const updatedItem: DispatchWorkItem = {
				...item,
				status: 'agent-ready',
				claimedBySessionId: undefined,
				claimedAt: undefined,
			};
			_dispatchRegistry.workItems.set(updatedItem.id, updatedItem);

			return ok({ item: updatedItem });
		}
	);

	// -----------------------------------------------------------------------
	// agentDispatch:pause
	// Mark an agent as offline (paused), preventing auto-pickup.
	// -----------------------------------------------------------------------
	ipcMain.handle(
		'agentDispatch:pause',
		(_event, params: { sessionId: string }): IpcResult<{ agent: DispatchAgent }> => {
			const gateError = gate();
			if (gateError) return gateError;
			const agent = _dispatchRegistry.agents.get(params.sessionId);
			if (!agent) {
				return err(`Agent ${params.sessionId} not found`);
			}

			const updatedAgent: DispatchAgent = { ...agent, availability: 'offline' };
			_dispatchRegistry.agents.set(updatedAgent.sessionId, updatedAgent);
			return ok({ agent: updatedAgent });
		}
	);

	// -----------------------------------------------------------------------
	// agentDispatch:resume
	// Restore a paused (offline) agent to idle.
	// -----------------------------------------------------------------------
	ipcMain.handle(
		'agentDispatch:resume',
		(_event, params: { sessionId: string }): IpcResult<{ agent: DispatchAgent }> => {
			const gateError = gate();
			if (gateError) return gateError;
			const agent = _dispatchRegistry.agents.get(params.sessionId);
			if (!agent) {
				return err(`Agent ${params.sessionId} not found`);
			}
			if (agent.availability !== 'offline') {
				return err(`Agent ${params.sessionId} is not paused (availability: ${agent.availability})`);
			}

			const updatedAgent: DispatchAgent = { ...agent, availability: 'idle' };
			_dispatchRegistry.agents.set(updatedAgent.sessionId, updatedAgent);
			return ok({ agent: updatedAgent });
		}
	);

	// -----------------------------------------------------------------------
	// agentDispatch:createSubtask
	// Create a new agent-ready subtask under an existing parent work item.
	// -----------------------------------------------------------------------
	ipcMain.handle(
		'agentDispatch:createSubtask',
		(_event, params: CreateSubtaskParams): IpcResult<{ item: DispatchWorkItem }> => {
			const gateError = gate();
			if (gateError) return gateError;
			if (!_dispatchRegistry.workItems.has(params.parentId)) {
				return err(`Parent work item ${params.parentId} not found`);
			}

			const newItem: DispatchWorkItem = {
				id: generateUUID(),
				title: params.title,
				status: 'agent-ready',
				parentId: params.parentId,
				dependsOn: params.dependsOn ?? [],
			};
			_dispatchRegistry.workItems.set(newItem.id, newItem);
			return ok({ item: newItem });
		}
	);

	// -----------------------------------------------------------------------
	// agentDispatch:status
	// Combined snapshot for slash commands and MCP status checks.
	// -----------------------------------------------------------------------
	ipcMain.handle('agentDispatch:status', () => {
		const gateError = gate();
		if (gateError) return gateError;
		const agents = [..._dispatchRegistry.agents.values()];
		const eligible = [..._dispatchRegistry.workItems.values()].filter(
			(item) => item.status === 'agent-ready' && !item.claimedBySessionId
		);
		const inProgress = [..._dispatchRegistry.workItems.values()].filter(
			(item) => item.status === 'in-progress'
		);
		return ok({ agents, eligible, inProgress });
	});

	logger.info('Agent Dispatch slash-command IPC handlers registered', LOG_CONTEXT);
}

/**
 * Backward-compat alias — the old export name had "Mcp" in it which was
 * misleading (this file registers IPC channels, not MCP tools).
 * @deprecated Import `registerAgentDispatchSlashCommandHandlers` directly.
 */
export {
	registerAgentDispatchSlashCommandHandlers as registerAgentDispatchMcpHandlers,
	registerAgentDispatchSlashCommandHandlers as registerAgentDispatchHandlers,
};
