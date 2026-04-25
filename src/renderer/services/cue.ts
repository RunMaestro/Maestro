/**
 * Cue IPC service
 *
 * Wraps all window.maestro.cue.* IPC calls with consistent error handling via
 * createIpcMethod. Read methods return a safe default on failure; write methods
 * rethrow so callers can handle or report errors.
 */

import type {
	CueSettings,
	CueSessionStatus,
	CueGraphSession,
	CueRunResult,
} from '../../shared/cue/contracts';
import type { CueLogPayload } from '../../shared/cue-log-types';
import { createIpcMethod } from './ipcWrapper';

export const cueService = {
	// ── Read methods (return default on error) ────────────────────────────────

	async getSettings(): Promise<CueSettings> {
		return createIpcMethod({
			call: () => window.maestro.cue.getSettings(),
			errorContext: 'Cue getSettings',
			defaultValue: {} as CueSettings,
		});
	},

	async getStatus(): Promise<CueSessionStatus[]> {
		return createIpcMethod({
			call: () => window.maestro.cue.getStatus(),
			errorContext: 'Cue getStatus',
			defaultValue: [],
		});
	},

	async getGraphData(): Promise<CueGraphSession[]> {
		return createIpcMethod({
			call: () => window.maestro.cue.getGraphData(),
			errorContext: 'Cue getGraphData',
			defaultValue: [],
		});
	},

	async getActiveRuns(): Promise<CueRunResult[]> {
		return createIpcMethod({
			call: () => window.maestro.cue.getActiveRuns(),
			errorContext: 'Cue getActiveRuns',
			defaultValue: [],
		});
	},

	async getActivityLog(limit?: number): Promise<CueRunResult[]> {
		return createIpcMethod({
			call: () => window.maestro.cue.getActivityLog(limit),
			errorContext: 'Cue getActivityLog',
			defaultValue: [],
		});
	},

	async getQueueStatus(): Promise<Record<string, number>> {
		return createIpcMethod({
			call: () => window.maestro.cue.getQueueStatus(),
			errorContext: 'Cue getQueueStatus',
			defaultValue: {},
		});
	},

	async getMetrics(): Promise<import('../../main/cue/cue-metrics').CueMetrics | null> {
		return createIpcMethod({
			call: () => window.maestro.cue.getMetrics(),
			errorContext: 'Cue getMetrics',
			defaultValue: null,
		});
	},

	async getFanInHealth(): Promise<import('../../main/cue/cue-fan-in-tracker').FanInHealthEntry[]> {
		return createIpcMethod({
			call: () => window.maestro.cue.getFanInHealth(),
			errorContext: 'Cue getFanInHealth',
			defaultValue: [],
		});
	},

	async readYaml(projectRoot: string): Promise<string | null> {
		// rethrow (instead of swallow + null) so callers can distinguish two
		// outcomes that the IPC handler models distinctly:
		//   - resolves to null  → file does not exist (handler returned null)
		//   - throws            → IPC / fs read failure
		// The previous defaultValue: null collapsed both into "null" and made
		// callers like CueYamlEditor silently fall back to a template even on
		// transport errors. Existing call sites already cope with throws via
		// outer try/catch (CueYamlEditor) or the write-back verification path
		// in handleSave (which is now strictly more informative — the IPC
		// error message propagates instead of "did not persist").
		return createIpcMethod({
			call: () => window.maestro.cue.readYaml(projectRoot),
			errorContext: 'Cue readYaml',
			rethrow: true,
		});
	},

	async loadPipelineLayout(): Promise<Record<string, unknown> | null> {
		return createIpcMethod({
			call: () => window.maestro.cue.loadPipelineLayout(),
			errorContext: 'Cue loadPipelineLayout',
			defaultValue: null,
		});
	},

	async validateYaml(content: string): Promise<{ valid: boolean; errors: string[] }> {
		// rethrow on IPC failure (instead of swallowing as `{ valid: true }`).
		// The previous default was actively dangerous: a transport failure
		// would surface as "yaml is valid, save freely" — exactly the wrong
		// fallback. Callers (CueYamlEditor) already catch the rejection and
		// gate Save by setting isValid=false + a meaningful error.
		return createIpcMethod({
			call: () => window.maestro.cue.validateYaml(content),
			errorContext: 'Cue validateYaml',
			rethrow: true,
		});
	},

	// ── Write methods (rethrow on error) ──────────────────────────────────────

	async enable(): Promise<void> {
		return createIpcMethod({
			call: () => window.maestro.cue.enable(),
			errorContext: 'Cue enable',
			rethrow: true,
		});
	},

	async disable(): Promise<void> {
		return createIpcMethod({
			call: () => window.maestro.cue.disable(),
			errorContext: 'Cue disable',
			rethrow: true,
		});
	},

	async stopRun(runId: string): Promise<boolean> {
		return createIpcMethod({
			call: () => window.maestro.cue.stopRun(runId),
			errorContext: 'Cue stopRun',
			rethrow: true,
		});
	},

	async stopAll(): Promise<void> {
		return createIpcMethod({
			call: () => window.maestro.cue.stopAll(),
			errorContext: 'Cue stopAll',
			rethrow: true,
		});
	},

	async triggerSubscription(
		subscriptionName: string,
		prompt?: string,
		sourceAgentId?: string
	): Promise<boolean> {
		return createIpcMethod({
			call: () => window.maestro.cue.triggerSubscription(subscriptionName, prompt, sourceAgentId),
			errorContext: 'Cue triggerSubscription',
			rethrow: true,
		});
	},

	async refreshSession(sessionId: string, projectRoot: string): Promise<void> {
		return createIpcMethod({
			call: () => window.maestro.cue.refreshSession(sessionId, projectRoot),
			errorContext: 'Cue refreshSession',
			rethrow: true,
		});
	},

	async removeSession(sessionId: string): Promise<void> {
		return createIpcMethod({
			call: () => window.maestro.cue.removeSession(sessionId),
			errorContext: 'Cue removeSession',
			rethrow: true,
		});
	},

	async writeYaml(
		projectRoot: string,
		content: string,
		promptFiles?: Record<string, string>
	): Promise<void> {
		return createIpcMethod({
			call: () => window.maestro.cue.writeYaml(projectRoot, content, promptFiles),
			errorContext: 'Cue writeYaml',
			rethrow: true,
		});
	},

	async deleteYaml(projectRoot: string): Promise<boolean> {
		return createIpcMethod({
			call: () => window.maestro.cue.deleteYaml(projectRoot),
			errorContext: 'Cue deleteYaml',
			rethrow: true,
		});
	},

	async savePipelineLayout(layout: Record<string, unknown>): Promise<void> {
		return createIpcMethod({
			call: () => window.maestro.cue.savePipelineLayout(layout),
			errorContext: 'Cue savePipelineLayout',
			rethrow: true,
		});
	},

	// ── Event passthrough ─────────────────────────────────────────────────────

	onActivityUpdate(callback: (data: CueLogPayload) => void): () => void {
		return window.maestro.cue.onActivityUpdate(callback);
	},
};
