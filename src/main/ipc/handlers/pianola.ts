/**
 * Pianola IPC Handlers
 *
 * Exposes the Pianola rules CRUD and the decision audit log to the renderer.
 * Thin transport that delegates to the main-process store
 * (src/main/pianola/pianola-store-main.ts), which reads/writes the same files
 * the CLI watcher uses.
 *
 * Gated at the handler on `encoreFeatures.pianola`. Pianola can auto-send
 * messages to agents, so when the Encore flag is off every channel throws
 * `'PianolaDisabled'` rather than returning empty data - the renderer needs to
 * distinguish "feature off" from "no rules / no decisions yet". The gate runs
 * OUTSIDE withIpcErrorLogging so the sentinel is not logged as an unexpected
 * IPC failure.
 */

import { ipcMain } from 'electron';
import { withIpcErrorLogging, type CreateHandlerOptions } from '../../utils/ipcHandler';
import {
	readRulesResult,
	writeRules,
	readDecisions,
	readSupervisorTargets,
	upsertSupervisorTarget,
	removeSupervisorTarget,
	type RulesLoadResult,
} from '../../pianola/pianola-store-main';
import {
	validatePianolaSupervisedTarget,
	type PianolaDecisionRecord,
	type PianolaSupervisedTarget,
} from '../../../shared/pianola/storage';
import type { PianolaRule } from '../../../shared/pianola/types';
import type { PianolaSupervisor, PianolaSupervisorHealth } from '../../pianola/pianola-supervisor';
import { generateUUID } from '../../../shared/uuid';

const LOG_CONTEXT = '[Pianola]';

/** Snapshot returned by every supervisor channel: persisted targets + live health. */
export interface PianolaSupervisorSnapshot {
	targets: PianolaSupervisedTarget[];
	health: PianolaSupervisorHealth[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const handlerOpts = (operation: string): Pick<CreateHandlerOptions, 'context' | 'operation'> => ({
	context: LOG_CONTEXT,
	operation,
});

/**
 * Dependencies for Pianola handlers. Only the settings store is needed, for the
 * Encore gate.
 */
export interface PianolaHandlerDependencies {
	settingsStore: {
		get: (key: string) => unknown;
	};
	/** The desktop supervised daemon; supervisor channels drive its reconcile. */
	supervisor: PianolaSupervisor;
}

/**
 * Returns true only when `encoreFeatures.pianola` is explicitly enabled. Read on
 * every call so a toggle change takes effect without an app restart.
 */
function isPianolaEnabled(settingsStore: { get: (key: string) => unknown }): boolean {
	const ef = (settingsStore.get('encoreFeatures') ?? {}) as Record<string, unknown>;
	return ef.pianola === true;
}

/**
 * Register the Pianola IPC handlers.
 */
export function registerPianolaHandlers(deps: PianolaHandlerDependencies): void {
	const { settingsStore, supervisor } = deps;

	/** Current persisted targets + live health, returned by every supervisor channel. */
	const snapshot = (): PianolaSupervisorSnapshot => ({
		targets: readSupervisorTargets(),
		health: supervisor.getHealth(),
	});

	const wrappedGetRules = withIpcErrorLogging(
		handlerOpts('getRules'),
		// Returns { rules, malformed } so the UI can warn before overwriting a
		// corrupt hand-edited file rather than silently showing "no rules".
		async (): Promise<RulesLoadResult> => readRulesResult()
	);
	const wrappedSaveRules = withIpcErrorLogging(
		handlerOpts('saveRules'),
		// writeRules validates the untrusted payload at the persistence boundary.
		async (rules: unknown): Promise<PianolaRule[]> => writeRules(rules)
	);
	const wrappedGetDecisions = withIpcErrorLogging(
		handlerOpts('getDecisions'),
		async (limit?: number): Promise<PianolaDecisionRecord[]> => readDecisions(limit)
	);

	const wrappedSupervisorList = withIpcErrorLogging(
		handlerOpts('supervisorList'),
		async (): Promise<PianolaSupervisorSnapshot> => snapshot()
	);
	const wrappedSupervisorAdd = withIpcErrorLogging(
		handlerOpts('supervisorAdd'),
		// Validate the untrusted target at this boundary; fill id/createdAt/enabled
		// when the caller omits them, then upsert and reconcile so the new child
		// spawns without waiting for the file-watch debounce.
		async (raw: unknown): Promise<PianolaSupervisorSnapshot> => {
			const candidate: Record<string, unknown> = isRecord(raw) ? { ...raw } : {};
			if (typeof candidate.id !== 'string' || candidate.id.length === 0) {
				candidate.id = generateUUID();
			}
			if (typeof candidate.createdAt !== 'number') candidate.createdAt = Date.now();
			if (candidate.enabled === undefined) candidate.enabled = true;
			const target = validatePianolaSupervisedTarget(candidate);
			if (!target) throw new Error('InvalidSupervisedTarget');
			upsertSupervisorTarget(target);
			supervisor.reconcile();
			return snapshot();
		}
	);
	const wrappedSupervisorSetEnabled = withIpcErrorLogging(
		handlerOpts('supervisorSetEnabled'),
		async (id: unknown, enabled: unknown): Promise<PianolaSupervisorSnapshot> => {
			if (typeof id !== 'string' || id.length === 0) throw new Error('InvalidTargetId');
			if (typeof enabled !== 'boolean') throw new Error('InvalidEnabledFlag');
			const current = readSupervisorTargets().find((t) => t.id === id);
			if (!current) throw new Error('SupervisedTargetNotFound');
			upsertSupervisorTarget({ ...current, enabled });
			supervisor.reconcile();
			return snapshot();
		}
	);
	const wrappedSupervisorRemove = withIpcErrorLogging(
		handlerOpts('supervisorRemove'),
		async (id: unknown): Promise<PianolaSupervisorSnapshot> => {
			if (typeof id !== 'string' || id.length === 0) throw new Error('InvalidTargetId');
			removeSupervisorTarget(id);
			supervisor.reconcile();
			return snapshot();
		}
	);

	ipcMain.handle('pianola:get-rules', async (event): Promise<RulesLoadResult> => {
		if (!isPianolaEnabled(settingsStore)) throw new Error('PianolaDisabled');
		return wrappedGetRules(event);
	});

	ipcMain.handle('pianola:save-rules', async (event, rules: unknown): Promise<PianolaRule[]> => {
		if (!isPianolaEnabled(settingsStore)) throw new Error('PianolaDisabled');
		return wrappedSaveRules(event, rules);
	});

	ipcMain.handle(
		'pianola:get-decisions',
		async (event, limit?: number): Promise<PianolaDecisionRecord[]> => {
			if (!isPianolaEnabled(settingsStore)) throw new Error('PianolaDisabled');
			return wrappedGetDecisions(event, limit);
		}
	);

	ipcMain.handle('pianola:supervisor-list', async (event): Promise<PianolaSupervisorSnapshot> => {
		if (!isPianolaEnabled(settingsStore)) throw new Error('PianolaDisabled');
		return wrappedSupervisorList(event);
	});

	ipcMain.handle(
		'pianola:supervisor-add',
		async (event, target: unknown): Promise<PianolaSupervisorSnapshot> => {
			if (!isPianolaEnabled(settingsStore)) throw new Error('PianolaDisabled');
			return wrappedSupervisorAdd(event, target);
		}
	);

	ipcMain.handle(
		'pianola:supervisor-set-enabled',
		async (event, id: unknown, enabled: unknown): Promise<PianolaSupervisorSnapshot> => {
			if (!isPianolaEnabled(settingsStore)) throw new Error('PianolaDisabled');
			return wrappedSupervisorSetEnabled(event, id, enabled);
		}
	);

	ipcMain.handle(
		'pianola:supervisor-remove',
		async (event, id: unknown): Promise<PianolaSupervisorSnapshot> => {
			if (!isPianolaEnabled(settingsStore)) throw new Error('PianolaDisabled');
			return wrappedSupervisorRemove(event, id);
		}
	);
}
