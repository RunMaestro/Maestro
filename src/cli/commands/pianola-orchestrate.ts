/**
 * Pianola orchestration CLI commands.
 *
 * `pianola plan set|list|show` author and inspect task DAGs, and
 * `pianola orchestrate <planId>` runs the pure orchestration engine
 * (shared/pianola/pianola-orchestrator.ts) to completion. The engine, DAG, and
 * plan store already exist and are tested; this file is the I/O shell only:
 * reading plan JSON, the WebSocket round-trips for run state / history / agent
 * creation / dispatch, and console output. It mirrors pianola.ts (the watcher
 * shell) for the connect/SIGINT/loop/sleep/disconnect structure and the
 * Encore-flag gating, so a headless CLI cannot run autonomous behavior on an
 * install that has not opted in.
 *
 * The Encore gate (ensurePianolaEnabled / pianolaEnabledNow) is replicated here
 * rather than imported because pianola.ts does not export it; the behavior is
 * identical and intentionally kept in lockstep.
 */

import * as fs from 'fs';
import * as path from 'path';
import { readSettingValue } from '../services/storage';
import { readPianolaPlans, getPianolaPlan, upsertPianolaPlan } from '../services/pianola-store';
import { MaestroClient } from '../services/maestro-client';
import { runDispatch } from './dispatch';
import {
	runOrchestratorIteration,
	initialOrchestratorState,
	type OrchestratorState,
	type OrchestratorDeps,
} from '../../shared/pianola/pianola-orchestrator';
import {
	validatePlan,
	planProgress,
	type PianolaPlan,
	type PianolaTask,
} from '../../shared/pianola/pianola-tasks';
import type { PianolaMessage, PianolaMessageRole } from '../../shared/pianola/types';

const DEFAULT_INTERVAL_SECONDS = 5;
const DEFAULT_CONCURRENCY = 3;
const HISTORY_TAIL = 12;
// Memoize the desktop session list for this long so the many getRunState calls
// in one orchestration iteration reuse a single round-trip.
const SESSION_LIST_TTL_MS = 2000;

interface CreateSessionResult {
	success?: boolean;
	sessionId?: string;
	error?: string;
}

interface DesktopSessionEntry {
	tabId: string;
	agentId: string;
	state: 'idle' | 'busy';
}

interface DesktopSessionsList {
	sessions?: DesktopSessionEntry[];
}

interface RawHistoryMessage {
	id: string;
	role: PianolaMessageRole;
	source?: string;
	content: string;
	timestamp: string;
}

interface SessionHistoryResult {
	success?: boolean;
	error?: string;
	messages?: RawHistoryMessage[];
	agentId?: string;
	projectPath?: string;
}

/** Exit with a clear message if the Pianola Encore feature is disabled. */
function ensurePianolaEnabled(json?: boolean): void {
	const flags = readSettingValue('encoreFeatures') as Record<string, unknown> | undefined;
	if (flags?.pianola === true) return;
	const message = 'Pianola is not enabled. Enable it with: maestro-cli encore set pianola on';
	if (json) {
		console.log(JSON.stringify({ success: false, error: message, code: 'PIANOLA_DISABLED' }));
	} else {
		console.error(message);
	}
	process.exit(1);
}

/**
 * Non-throwing Encore check, re-read each iteration so revoking consent in
 * Settings halts an in-flight orchestrate run (the startup guard only runs once).
 */
function pianolaEnabledNow(): boolean {
	const flags = readSettingValue('encoreFeatures') as Record<string, unknown> | undefined;
	return flags?.pianola === true;
}

/** Parse `--interval` as seconds ("5" or "5s"); defaults to 5, minimum 1. */
function parseIntervalSeconds(raw?: string): number {
	if (!raw) return DEFAULT_INTERVAL_SECONDS;
	const match = raw.trim().match(/^(\d+)s?$/i);
	if (!match) return DEFAULT_INTERVAL_SECONDS;
	return Math.max(1, parseInt(match[1], 10));
}

/** Parse `--concurrency`; defaults to 3, minimum 1. */
function parseConcurrency(raw?: string): number {
	if (!raw) return DEFAULT_CONCURRENCY;
	const parsed = parseInt(raw.trim(), 10);
	if (isNaN(parsed)) return DEFAULT_CONCURRENCY;
	return Math.max(1, parsed);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One-line progress summary shared by list, show, and the orchestrate loop. */
function progressLine(plan: PianolaPlan): string {
	const pr = planProgress(plan);
	return `${pr.done}/${pr.total} done, ${pr.running} running, ${pr.pending} pending, ${pr.blocked} blocked, ${pr.failed} failed`;
}

/** Build a red, sticky desktop toast for a failed task, with click-to-jump. */
function buildTaskFailedToastCommand(task: PianolaTask): Record<string, unknown> {
	const payload: Record<string, unknown> = {
		type: 'notify_toast',
		title: 'Pianola',
		message: `Task failed: ${task.title}`,
		color: 'red',
		dismissible: true,
		sourceAgent: 'Pianola',
	};
	if (task.agentId) {
		payload.sessionId = task.agentId;
		if (task.tabId) payload.tabId = task.tabId;
		payload.clickAction = {
			kind: 'jump-session',
			sessionId: task.agentId,
			tabId: task.tabId,
		};
	}
	return payload;
}

/** Read plan JSON from --file (resolved) or piped stdin. Mirrors pianolaSetProfile. */
function readPlanInput(options: { file?: string }, fail: (message: string) => never): string {
	if (options.file) {
		try {
			return fs.readFileSync(path.resolve(options.file), 'utf-8');
		} catch (error) {
			return fail(
				`Could not read --file: ${error instanceof Error ? error.message : String(error)}`
			);
		}
	}
	if (process.stdin.isTTY) {
		return fail('Provide the plan via --file <path> or piped stdin');
	}
	try {
		return fs.readFileSync(0, 'utf-8');
	} catch {
		return fail('Could not read the plan from stdin; use --file <path> instead');
	}
}

export interface PianolaPlanSetOptions {
	file?: string;
	json?: boolean;
}

/**
 * Author a plan: read its JSON from --file or stdin, validate it via the pure
 * validatePlan, and persist it. Validation errors are reported and exit 1 rather
 * than writing a broken plan the orchestrator could not run.
 */
export function pianolaPlanSet(options: PianolaPlanSetOptions): void {
	ensurePianolaEnabled(options.json);

	const fail = (message: string): never => {
		if (options.json) console.log(JSON.stringify({ success: false, error: message }));
		else console.error(message);
		process.exit(1);
	};

	const raw = readPlanInput(options, fail);

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		return fail(
			`Plan is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
		);
	}

	const { plan, errors } = validatePlan(parsed);
	if (!plan) {
		if (options.json) {
			console.log(JSON.stringify({ success: false, errors }));
		} else {
			console.error('Plan is invalid:');
			for (const e of errors) console.error(`  - ${e}`);
		}
		process.exit(1);
		return;
	}

	upsertPianolaPlan(plan);
	if (options.json) {
		console.log(JSON.stringify({ success: true, planId: plan.id, taskCount: plan.tasks.length }));
	} else {
		console.log(`Saved Pianola plan ${plan.id} (${plan.tasks.length} task(s)).`);
	}
}

export interface PianolaPlanListOptions {
	json?: boolean;
}

/** List saved plans with a one-line progress summary each. */
export function pianolaPlanList(options: PianolaPlanListOptions): void {
	ensurePianolaEnabled(options.json);
	const plans = readPianolaPlans();
	if (options.json) {
		console.log(
			JSON.stringify({
				plans: plans.map((p) => ({ id: p.id, title: p.title, progress: planProgress(p) })),
			})
		);
		return;
	}
	if (plans.length === 0) {
		console.log('No Pianola plans saved.');
		return;
	}
	console.log('Pianola plans:');
	for (const plan of plans) {
		console.log(`  ${plan.id}  ${plan.title}  [${progressLine(plan)}]`);
	}
}

export interface PianolaPlanShowOptions {
	json?: boolean;
}

/** Show one plan's tasks (id, status, dependsOn, title), or the JSON plan + progress. */
export function pianolaPlanShow(planId: string, options: PianolaPlanShowOptions): void {
	ensurePianolaEnabled(options.json);
	const plan = getPianolaPlan(planId);
	if (!plan) {
		const message = `No Pianola plan with id "${planId}".`;
		if (options.json) console.log(JSON.stringify({ success: false, error: message }));
		else console.error(message);
		process.exit(1);
		return;
	}
	if (options.json) {
		console.log(JSON.stringify({ success: true, plan, progress: planProgress(plan) }));
		return;
	}
	console.log(`Plan ${plan.id}: ${plan.title}`);
	console.log(`  ${progressLine(plan)}`);
	console.log('Tasks:');
	for (const task of plan.tasks) {
		const deps = task.dependsOn.length > 0 ? ` depends on [${task.dependsOn.join(', ')}]` : '';
		console.log(`  ${task.status.padEnd(8)} ${task.id}  ${task.title}${deps}`);
	}
}

export interface PianolaOrchestrateOptions {
	interval?: string;
	concurrency?: string;
	once?: boolean;
	json?: boolean;
}

/**
 * Run the pure orchestration engine against a saved plan. Loads the plan, opens
 * one MaestroClient, and ticks runOrchestratorIteration: each iteration polls
 * running tasks for completion, dispatches newly-ready work up to the concurrency
 * limit, persists the plan, and reports progress. Stops when the plan is done,
 * on --once, on SIGINT, or when Pianola is disabled mid-run.
 */
export async function pianolaOrchestrate(
	planId: string,
	options: PianolaOrchestrateOptions
): Promise<void> {
	ensurePianolaEnabled(options.json);

	const plan = getPianolaPlan(planId);
	if (!plan) {
		const message = `No Pianola plan with id "${planId}". Save one first with: pianola plan set --file <plan.json>`;
		if (options.json) console.log(JSON.stringify({ success: false, error: message }));
		else console.error(message);
		process.exit(1);
		return;
	}

	const intervalMs = parseIntervalSeconds(options.interval) * 1000;
	const concurrencyLimit = parseConcurrency(options.concurrency);
	const once = !!options.once;

	let stopped = false;
	const onSignal = (): void => {
		stopped = true;
	};
	process.on('SIGINT', onSignal);

	const client = new MaestroClient();
	try {
		await client.connect();
	} catch (error) {
		process.off('SIGINT', onSignal);
		const message = error instanceof Error ? error.message : String(error);
		console.error(`[orchestrator] could not connect to Maestro: ${message}`);
		process.exit(1);
		return;
	}

	// Short-lived cache so all getRunState calls in one iteration share one
	// list_desktop_sessions round-trip instead of hammering the desktop.
	let sessionsCache: { at: number; entries: DesktopSessionEntry[] } | null = null;
	const listDesktopSessions = async (): Promise<DesktopSessionEntry[]> => {
		const now = Date.now();
		if (sessionsCache && now - sessionsCache.at < SESSION_LIST_TTL_MS) {
			return sessionsCache.entries;
		}
		const result = await client.sendCommand<DesktopSessionsList>(
			{ type: 'list_desktop_sessions' },
			'desktop_sessions_list'
		);
		const entries = result.sessions ?? [];
		sessionsCache = { at: now, entries };
		return entries;
	};

	const deps: OrchestratorDeps = {
		getRunState: async (task) => {
			if (!task.tabId) return 'idle';
			const entries = await listDesktopSessions();
			const entry = entries.find((e) => e.tabId === task.tabId);
			if (!entry) return 'idle';
			return entry.state === 'busy' ? 'busy' : 'idle';
		},
		getRecentMessages: async (task) => {
			if (!task.tabId) return [];
			const result = await client.sendCommand<SessionHistoryResult>(
				{ type: 'get_session_history', tabId: task.tabId, tail: HISTORY_TAIL },
				'session_history_result'
			);
			const messages = result.messages ?? [];
			return messages.map(
				(m): PianolaMessage => ({
					id: m.id,
					role: m.role,
					source: m.source ?? '',
					content: m.content,
					timestamp: m.timestamp,
				})
			);
		},
		ensureAgent: async (task) => {
			if (task.agentId) return { agentId: task.agentId };
			const result = await client.sendCommand<CreateSessionResult>(
				{
					type: 'create_session',
					name: task.title,
					toolType: task.agentType || 'claude-code',
					cwd: task.cwd || process.cwd(),
				},
				'create_session_result'
			);
			if (!result.success || !result.sessionId) {
				return { error: result.error ?? 'create_session did not return a sessionId' };
			}
			return { agentId: result.sessionId };
		},
		dispatch: async (task, agentId) => {
			const res = await runDispatch(agentId, task.prompt, {});
			return { success: !!res.success, tabId: res.sessionId ?? undefined, error: res.error };
		},
		persist: (p) => {
			upsertPianolaPlan(p);
		},
		log: (line) => console.log(line),
		notify: async (event) => {
			try {
				await client.sendCommand(buildTaskFailedToastCommand(event.task), 'notify_toast_result');
			} catch {
				// A failed toast must never break autonomous orchestration.
			}
		},
	};

	let state: OrchestratorState = initialOrchestratorState(plan);

	if (!once) {
		console.log(
			`[orchestrator] running plan ${plan.id} every ${intervalMs / 1000}s, concurrency ${concurrencyLimit}. Ctrl+C to stop.`
		);
	}

	try {
		for (;;) {
			// Re-check consent each iteration: if Pianola was toggled off in Settings,
			// stop acting immediately rather than running until the process is killed.
			if (!pianolaEnabledNow()) {
				console.error('[orchestrator] Pianola disabled in Settings; stopping.');
				break;
			}

			const result = await runOrchestratorIteration(state, deps, { concurrencyLimit });
			state = result.state;
			console.log(`[orchestrator] ${progressLine(state.plan)}`);

			if (result.done) {
				const pr = result.progress;
				if (options.json) {
					console.log(JSON.stringify({ success: true, done: true, progress: pr }));
				} else {
					console.log(
						`[orchestrator] plan ${state.plan.id} complete: ${pr.done}/${pr.total} done, ${pr.failed} failed, ${pr.blocked} blocked.`
					);
				}
				break;
			}

			if (once || stopped) break;
			await sleep(intervalMs);
		}
	} finally {
		process.off('SIGINT', onSignal);
		client.disconnect();
	}
}
