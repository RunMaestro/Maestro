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
	updateSupervisorTargets,
	removeSupervisorTarget,
	readSuggestions,
	writeSuggestions,
	setProfile,
	type RulesLoadResult,
} from '../../pianola/pianola-store-main';
import {
	readPrograms,
	writePrograms,
	readAsks,
	updateAsks,
	readPlans,
	readProgramLoopMemo,
} from '../../pianola/pianola-store-main';
import { readAgentRuns } from '../../../cli/services/agent-run-store';
import { pianolaTaskAgentRunId } from '../../../shared/agent-run';
import {
	briefRunsForPlans,
	derivePianolaBrief,
	type PianolaProgram,
	type PianolaAsk,
	type PianolaAskStatus,
	type PianolaBrief,
} from '../../../shared/pianola/pianola-programs';
import {
	validatePianolaSupervisedTarget,
	type PianolaDecisionRecord,
	type PianolaSupervisedTarget,
	validatePianolaRule,
	type PianolaSuggestionsFile,
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
	const wrappedGetSuggestions = withIpcErrorLogging(
		handlerOpts('getSuggestions'),
		async (): Promise<PianolaSuggestionsFile> => readSuggestions()
	);
	const wrappedApplySuggestion = withIpcErrorLogging(
		handlerOpts('applySuggestion'),
		// Approving a suggestion only writes config: an approved rule is appended to
		// the rules file (still subject to decide() at runtime, so high-risk always
		// escalates), and an approved profile draft is persisted. Nothing here ever
		// auto-answers or bypasses the policy.
		async (raw: unknown): Promise<{ rules: PianolaRule[] }> => {
			if (!isRecord(raw)) throw new Error('InvalidSuggestionPayload');
			let rules = readRulesResult().rules;
			if (raw.rule !== undefined) {
				const rule = validatePianolaRule(raw.rule);
				if (!rule) throw new Error('InvalidSuggestionRule');
				const idx = rules.findIndex((r) => r.id === rule.id);
				const next = idx >= 0 ? rules.map((r, i) => (i === idx ? rule : r)) : [...rules, rule];
				rules = writeRules(next);
				// Best-effort: drop the now-applied proposal from staging so a
				// refresh does not re-surface an already-approved suggestion. A
				// staging-prune failure must never fail the apply (the rule is
				// already persisted above).
				try {
					const staged = readSuggestions();
					writeSuggestions({
						...staged,
						proposals: staged.proposals.filter((p) => p.id !== rule.id),
					});
				} catch {
					// Ignore: staging is advisory; the persisted rule is authoritative.
				}
			}
			if (isRecord(raw.profile) && typeof raw.profile.text === 'string') {
				const projectPath =
					typeof raw.profile.projectPath === 'string' ? raw.profile.projectPath : undefined;
				setProfile({ profile: raw.profile.text, updatedAt: Date.now() }, projectPath);
			}
			return { rules };
		}
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
			updateSupervisorTargets((targets) => {
				if (!targets.some((target) => target.id === id))
					throw new Error('SupervisedTargetNotFound');
				return targets.map((target) => (target.id === id ? { ...target, enabled } : target));
			});
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

	ipcMain.handle('pianola:get-suggestions', async (event): Promise<PianolaSuggestionsFile> => {
		if (!isPianolaEnabled(settingsStore)) throw new Error('PianolaDisabled');
		return wrappedGetSuggestions(event);
	});

	ipcMain.handle(
		'pianola:apply-suggestion',
		async (event, payload: unknown): Promise<{ rules: PianolaRule[] }> => {
			if (!isPianolaEnabled(settingsStore)) throw new Error('PianolaDisabled');
			return wrappedApplySuggestion(event, payload);
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
	ipcMain.handle('pianola:supervise-program', async (_event, programId: unknown): Promise<void> => {
		if (!isPianolaEnabled(settingsStore)) throw new Error('PianolaDisabled');
		if (
			typeof programId !== 'string' ||
			!readPrograms().some((program) => program.id === programId)
		)
			throw new Error('InvalidProgramId');
		updateSupervisorTargets((current) => {
			const existing = current.find(
				(target) => target.kind === 'program' && target.programId === programId
			);
			const target: PianolaSupervisedTarget = {
				id: existing?.id ?? generateUUID(),
				createdAt: existing?.createdAt ?? Date.now(),
				kind: 'program',
				programId,
				enabled: true,
				intervalSeconds: existing?.intervalSeconds ?? 120,
			};
			return existing
				? current.map((entry) => (entry.id === existing.id ? target : entry))
				: [...current, target];
		});
		supervisor.reconcile();
	});
	ipcMain.handle(
		'pianola:set-program-status',
		async (_event, programId: unknown, status: unknown): Promise<void> => {
			if (!isPianolaEnabled(settingsStore)) throw new Error('PianolaDisabled');
			if (typeof programId !== 'string' || (status !== 'active' && status !== 'paused'))
				throw new Error('InvalidProgramStatus');
			const programs = readPrograms();
			if (!programs.some((program) => program.id === programId))
				throw new Error('InvalidProgramId');
			if (programs.find((program) => program.id === programId)!.status !== status)
				writePrograms(
					programs.map((program) =>
						program.id === programId ? { ...program, status, updatedAt: Date.now() } : program
					)
				);
			supervisor.reconcile();
		}
	);
	ipcMain.handle('pianola:get-programs', async (): Promise<PianolaProgram[]> => {
		if (!isPianolaEnabled(settingsStore)) throw new Error('PianolaDisabled');
		return readPrograms();
	});
	ipcMain.handle(
		'pianola:get-asks',
		async (_event, status?: PianolaAskStatus): Promise<PianolaAsk[]> => {
			if (!isPianolaEnabled(settingsStore)) throw new Error('PianolaDisabled');
			if (status !== undefined && !['open', 'resolved', 'dismissed'].includes(status))
				throw new Error('InvalidAskStatus');
			return readAsks().filter((ask) => ask.status === (status ?? 'open'));
		}
	);
	ipcMain.handle(
		'pianola:resolve-ask',
		async (_event, id: unknown, option: unknown, note?: unknown): Promise<PianolaAsk> => {
			if (!isPianolaEnabled(settingsStore)) throw new Error('PianolaDisabled');
			if (
				typeof id !== 'string' ||
				typeof option !== 'string' ||
				!option.trim() ||
				(note !== undefined && typeof note !== 'string')
			)
				throw new Error('InvalidAskResolution');
			let updated: PianolaAsk | undefined;
			updateAsks((asks) => {
				const ask = asks.find((a) => a.id === id && a.status === 'open');
				if (!ask) throw new Error('OpenAskNotFound');
				const now = new Date().toISOString();
				const resolved: PianolaAsk = {
					...ask,
					status: 'resolved',
					updatedAt: now,
					resolution: { option, ...(note === undefined ? {} : { note }), resolvedAt: now },
				};
				updated = resolved;
				return asks.map((a) => (a.id === id ? resolved : a));
			});
			if (!updated) throw new Error('OpenAskNotFound');
			return updated;
		}
	);
	ipcMain.handle('pianola:dismiss-ask', async (_event, id: unknown): Promise<PianolaAsk> => {
		if (!isPianolaEnabled(settingsStore)) throw new Error('PianolaDisabled');
		if (typeof id !== 'string') throw new Error('InvalidAskId');
		let updated: PianolaAsk | undefined;
		updateAsks((asks) => {
			const ask = asks.find((a) => a.id === id && a.status === 'open');
			if (!ask) throw new Error('OpenAskNotFound');
			const dismissed: PianolaAsk = {
				...ask,
				status: 'dismissed',
				updatedAt: new Date().toISOString(),
			};
			updated = dismissed;
			return asks.map((a) => (a.id === id ? dismissed : a));
		});
		if (!updated) throw new Error('OpenAskNotFound');
		return updated;
	});
	ipcMain.handle('pianola:get-brief', async (): Promise<PianolaBrief> => {
		if (!isPianolaEnabled(settingsStore)) throw new Error('PianolaDisabled');
		const plans = readPlans();
		const runs = briefRunsForPlans(plans, readAgentRuns(), pianolaTaskAgentRunId);
		return derivePianolaBrief(
			readPrograms(),
			plans,
			readAsks(),
			readDecisions(),
			runs,
			new Date().toISOString(),
			readSupervisorTargets(),
			readProgramLoopMemo()
		);
	});
}
