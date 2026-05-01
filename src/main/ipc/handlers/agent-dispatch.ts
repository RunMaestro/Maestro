/**
 * Agent Dispatch IPC Handlers
 *
 * Exposes the Agent Dispatch runtime (fleet registry + assignment engine) to
 * the renderer via strongly-typed IPC channels.
 *
 * Channel conventions:
 *   agentDispatch:getBoard        → in-memory claim state (GitHub-backed, #444)
 *   agentDispatch:getFleet        → current fleet entries from FleetRegistry
 *   agentDispatch:assignManually  → manual claim via AgentDispatchEngine
 *   agentDispatch:releaseClaim    → release a claim on GitHub via ClaimTracker
 *   agentDispatch:pauseAgent      → pause auto-pickup for an agent
 *   agentDispatch:resumeAgent     → resume auto-pickup for an agent
 *
 * Claim events pushed to renderer:
 *   agentDispatch:claimStarted    → { projectPath, role, issueNumber, issueTitle, claimedAt }
 *   agentDispatch:claimEnded      → { projectPath, role }
 *
 * #444: work-graph SQLite removed. Board data now comes from the in-memory
 * ClaimTracker, which is populated by DispatchEngine on claim/release.
 *
 * Pause/resume are implemented through FleetRegistry.pause()/resume() which
 * flip a local in-memory pause flag. They do NOT persist across restarts.
 *
 * All handlers are gated by the `agentDispatch` encore feature flag.
 * When the flag is off, every channel returns:
 *   { success: false, code: 'FEATURE_DISABLED', feature: 'agentDispatch' }
 */

import { ipcMain, type BrowserWindow } from 'electron';
import { requireEncoreFeature } from '../../utils/requireEncoreFeature';
import type { ManualAssignmentInput } from '../../agent-dispatch/dispatch-engine';
import type { AgentDispatchFleetEntry } from '../../../shared/agent-dispatch-types';
import type { AgentDispatchRuntime } from '../../agent-dispatch/runtime';
import type { SettingsStoreInterface } from '../../stores/types';
import { logger } from '../../utils/logger';
import { getClaimTracker } from '../../agent-dispatch/claim-tracker';
import { getGithubClient } from '../../agent-dispatch/github-client';
import { auditLog } from '../../agent-dispatch/dispatch-audit-log';

const LOG_CONTEXT = '[AgentDispatch]';

export interface AgentDispatchHandlerDependencies {
	getRuntime: () => AgentDispatchRuntime | null;
	settingsStore: SettingsStoreInterface;
}

export interface AgentDispatchClaimStartedEvent {
	projectPath: string;
	role: string;
	issueNumber: number;
	issueTitle: string;
	claimedAt: string;
}

export interface AgentDispatchClaimEndedEvent {
	projectPath: string;
	role: string;
}

/** Emit claim-started event to all renderer windows. */
export function emitClaimStarted(
	getWindow: () => BrowserWindow | null,
	event: AgentDispatchClaimStartedEvent
): void {
	const win = getWindow();
	if (win && !win.isDestroyed()) {
		win.webContents.send('agentDispatch:claimStarted', event);
	}
}

/** Emit claim-ended event to all renderer windows. */
export function emitClaimEnded(
	getWindow: () => BrowserWindow | null,
	event: AgentDispatchClaimEndedEvent
): void {
	const win = getWindow();
	if (win && !win.isDestroyed()) {
		win.webContents.send('agentDispatch:claimEnded', event);
	}
}

export function registerAgentDispatchHandlers(deps: AgentDispatchHandlerDependencies): void {
	/** Check the agentDispatch encore feature flag. Returns structured error or null. */
	const gate = () => requireEncoreFeature(deps.settingsStore, 'agentDispatch');

	// -------------------------------------------------------------------------
	// agentDispatch:getBoard
	//
	// Returns in-memory claim state as a board-shaped response.
	// #444: no longer queries work-graph SQLite — uses ClaimTracker instead.
	// The renderer subscribes to claimStarted/Ended events for live updates and
	// only calls getBoard for initial hydration.
	// -------------------------------------------------------------------------
	ipcMain.handle('agentDispatch:getBoard', async (_event) => {
		const gateError = gate();
		if (gateError) {
			logger.debug('agentDispatch flag off — rejecting getBoard', LOG_CONTEXT);
			return gateError;
		}
		try {
			const claims = getClaimTracker().getAll();
			// Shape: { items: ClaimInfo[], total: number } — matches board expectation
			return { success: true, data: { items: claims, total: claims.length } };
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
	// Releases an active claim: clears AI Assigned Slot on GitHub and removes
	// from the in-memory ClaimTracker.
	// #444: no longer touches work-graph SQLite.
	// -------------------------------------------------------------------------
	ipcMain.handle(
		'agentDispatch:releaseClaim',
		async (_event, input: { projectItemId: string; agentSessionId: string; role: string }) => {
			const gateError = gate();
			if (gateError) {
				logger.debug('agentDispatch flag off — rejecting releaseClaim', LOG_CONTEXT);
				return gateError;
			}
			try {
				const tracker = getClaimTracker();
				const claim = tracker.getByProjectItemId(input.projectItemId);
				if (!claim) {
					return {
						success: false,
						error: `No active claim for projectItemId: ${input.projectItemId}`,
					};
				}
				const client = getGithubClient();
				await client.setItemFieldValue(
					claim.projectId,
					claim.projectItemId,
					'AI Assigned Slot',
					''
				);
				await client.setItemFieldValue(
					claim.projectId,
					claim.projectItemId,
					'AI Status',
					'Tasks Ready'
				);
				tracker.removeClaim(claim.agentSessionId, claim.role);
				auditLog('release', {
					actor: input.agentSessionId ?? 'user',
					workItemId: claim.projectItemId,
					reason: 'manual release via IPC',
				});
				return { success: true, data: { released: true, projectItemId: input.projectItemId } };
			} catch (err) {
				logger.error('releaseClaim error', LOG_CONTEXT, { error: String(err) });
				return { success: false, error: String(err) };
			}
		}
	);

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
