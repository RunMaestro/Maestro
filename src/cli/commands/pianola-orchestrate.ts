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
import {
	appendAgentRunEvent,
	getAgentRun,
	upsertAgentRun,
	findActiveRunBySession,
} from '../services/agent-run-store';
import { MaestroClient } from '../services/maestro-client';
import { runDispatch } from './dispatch';
import {
	runOrchestratorIteration,
	initialOrchestratorState,
	type OrchestratorState,
	type OrchestratorDeps,
	type OrchestratorIterationResult,
	type PianolaTaskLedger,
} from '../../shared/pianola/pianola-orchestrator';
import {
	validatePlan,
	planProgress,
	type PianolaPlan,
	type PianolaTask,
} from '../../shared/pianola/pianola-tasks';
import type { PianolaMessage, PianolaMessageRole } from '../../shared/pianola/types';
import { selectAgentForTask, type AgentCandidate } from '../../shared/pianola/pianola-agent-select';
import { DEFAULT_CAPABILITIES } from '../../shared/types';
import { enrichWithAwaitingInput } from '../../shared/pianola/pianola-awaiting-detector';
import { classifyMessages } from '../../shared/pianola/pianola-classifier';
import { rateRisk } from '../../shared/pianola/pianola-risk';
import { AgentRunSignals } from '../../main/agent-run/signals';
import { pianolaTaskAgentRunId, type AgentRun, type AgentRunStatus } from '../../shared/agent-run';

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

export interface DesktopSessionEntry {
	tabId: string;
	sessionId: string;
	agentId: string;
	toolType: string;
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

/** F8 (ISC-8.12/8.13): the reactive fix/merge loop is gated on autopilot, read
 *  fresh each iteration so revoking it stops auto-actions immediately. With it
 *  off, Pianola behaves exactly as the current supervisor (no auto-fix/merge). */
function autopilotEnabledNow(): boolean {
	const flags = readSettingValue('encoreFeatures') as Record<string, unknown> | undefined;
	return flags?.pianola === true && flags?.autopilot === true;
}

/** Project a captured AgentRun into the engine's ledger view (F8 / ISC-8.3). */
function ledgerForTask(planId: string, task: PianolaTask): PianolaTaskLedger | undefined {
	const runId = resolvePianolaRunId(planId, task);
	const run = getAgentRun(runId);
	if (!run) return undefined;
	const openFindings = run.reviews.filter((r) => r.status === 'open');
	const openCriticalOrHigh = openFindings.filter(
		(r) => r.severity === 'critical' || r.severity === 'high'
	).length;
	const checks = run.checks ?? [];
	const checksPassed = checks.length === 0 ? undefined : checks.every((c) => c.status === 'passed');
	return {
		runId: run.id,
		checksPassed,
		openCriticalOrHighFindings: openCriticalOrHigh,
		openFindings: openFindings.length,
		pullRequestUrl: run.pullRequest?.url,
		merged: run.merge?.status === 'merged',
	};
}

/** Append an audit-before-action ledger event for an autonomous F8 action
 *  (ISC-8.9): the record is written BEFORE the action is attempted, so an
 *  auto-fix or auto-merge always leaves a trail even if the action then fails. */
function auditAgentRunAction(
	runId: string | undefined,
	action: string,
	detail: Record<string, unknown>
): void {
	if (!runId) return;
	const now = Date.now();
	try {
		appendAgentRunEvent({
			id: `evt_${runId}_audit_${action}_${now}`,
			runId,
			timestamp: now,
			type: 'audit',
			message: `autonomous ${action}`,
			data: { action, ...detail },
		});
	} catch {
		// Audit is best-effort; never break the orchestration loop on a log failure.
	}
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

export function resolveExistingPianolaAgentType(
	task: Pick<PianolaTask, 'agentId' | 'agentType'>,
	sessions: readonly DesktopSessionEntry[]
): string | undefined {
	if (task.agentType) return task.agentType;
	if (!task.agentId) return undefined;
	return sessions.find((session) => session.sessionId === task.agentId)?.toolType;
}

function campaignIdForPianolaPlan(planId: string): string {
	return `pianola:${planId}`;
}

function taskRunStatus(task: PianolaTask, fallback: AgentRunStatus): AgentRunStatus {
	if (task.status === 'done') return 'completed';
	if (task.status === 'failed' || task.status === 'blocked') return 'failed';
	if (task.status === 'running') return 'running';
	return fallback;
}

function resolvePianolaRunId(planId: string, task: PianolaTask): string {
	// F8 (ISC-8.1/8.2): bind to the REAL captured run when one exists (the task
	// already carries a runId, or the desktop capture recorded one for this
	// session), so the task and its run are one record. Fall back to the
	// deterministic projection id only for a pure-CLI task with no captured run.
	if (task.runId) return task.runId;
	const captured = task.agentId ? findActiveRunBySession(task.agentId) : undefined;
	return captured?.id ?? pianolaTaskAgentRunId(planId, task.id);
}

function upsertPianolaTaskRun(
	planId: string,
	task: PianolaTask,
	status: AgentRunStatus,
	eventType: string
): void {
	const runId = resolvePianolaRunId(planId, task);
	const now = Date.now();
	const existing = getAgentRun(runId);
	const run: AgentRun = {
		...(existing ?? {
			id: runId,
			createdAt: now,
			provider: task.agentType ?? 'unknown',
			status,
			artifacts: [],
			touchedFiles: [],
			checks: [],
			reviews: [],
		}),
		id: runId,
		createdAt: existing?.createdAt ?? now,
		updatedAt: now,
		provider: existing?.provider ?? task.agentType ?? 'unknown',
		status,
		agentId: task.agentId,
		agentName: task.title,
		sessionId: task.agentId,
		tabId: task.tabId,
		cwd: task.cwd,
		prompt: task.prompt,
		source: campaignIdForPianolaPlan(planId),
		metadata: {
			...(existing?.metadata ?? {}),
			pianola: {
				planId,
				taskId: task.id,
				taskStatus: task.status,
			},
		},
	};
	upsertAgentRun(run);
	appendAgentRunEvent({
		id: `evt_${runId}_${eventType}_${now}`,
		runId,
		timestamp: now,
		type: eventType,
		status,
		message: task.title,
		data: { planId, taskId: task.id },
	});
}

function recordPianolaAgentRunProgress(
	result: OrchestratorIterationResult,
	signals: AgentRunSignals
): void {
	const plan = result.state.plan;
	const tasksById = new Map(plan.tasks.map((task) => [task.id, task]));
	for (const taskId of result.dispatchedTaskIds) {
		const task = tasksById.get(taskId);
		if (task) upsertPianolaTaskRun(plan.id, task, 'running', 'pianola.dispatched');
	}
	for (const taskId of result.completedTaskIds) {
		const task = tasksById.get(taskId);
		if (task)
			upsertPianolaTaskRun(plan.id, task, taskRunStatus(task, 'completed'), 'pianola.completed');
	}
	for (const taskId of result.failedTaskIds) {
		const task = tasksById.get(taskId);
		if (task) upsertPianolaTaskRun(plan.id, task, taskRunStatus(task, 'failed'), 'pianola.failed');
	}
	// F5/F8 (ISC-5.8): mirror engine-side needs_review routing onto the run
	// ledger through the guarded producer. The guard only fires when the run
	// really carries >=1 open finding (a checks-only needs_review task leaves
	// the run untouched, per the anti-signal), and it is idempotent for a run
	// already parked in needs_review - so calling it every tick is safe.
	for (const task of plan.tasks) {
		if (task.status === 'needs_review' && task.runId) signals.markNeedsReview(task.runId);
	}
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

	// Short-lived per-tab transcript cache so getRunState (awaiting-input check)
	// and getRecentMessages share one get_session_history round-trip per tick.
	const historyCache = new Map<string, { at: number; messages: PianolaMessage[] }>();
	const getHistory = async (tabId: string): Promise<PianolaMessage[]> => {
		const now = Date.now();
		const cached = historyCache.get(tabId);
		if (cached && now - cached.at < SESSION_LIST_TTL_MS) return cached.messages;
		const result = await client.sendCommand<SessionHistoryResult>(
			{ type: 'get_session_history', tabId, tail: HISTORY_TAIL },
			'session_history_result'
		);
		const messages = (result.messages ?? []).map(
			(m): PianolaMessage => ({
				id: m.id,
				role: m.role,
				source: m.source ?? '',
				content: m.content,
				timestamp: m.timestamp,
			})
		);
		historyCache.set(tabId, { at: now, messages });
		return messages;
	};

	const signals = new AgentRunSignals({
		getAgentRun,
		findActiveRunBySession,
		upsertAgentRun,
		appendAgentRunEvent,
		// Surface producer failures: an autonomous loop must not swallow store
		// I/O errors invisibly (the class already guards; this makes it loud).
		log: (level, message) => console.error(`[orchestrator] agent-run signal ${level}: ${message}`),
	});

	const deps: OrchestratorDeps = {
		getRunState: async (task) => {
			if (!task.tabId) return 'idle';
			const entries = await listDesktopSessions();
			const entry = entries.find((e) => e.tabId === task.tabId);
			if (!entry) return 'idle';
			if (entry.state === 'busy') {
				if (task.agentId) signals.markWorking(task.agentId);
				return 'busy';
			}
			// The desktop collapses waiting_input to idle, so before treating idle as
			// a completion signal, check whether the agent is actually awaiting the
			// user. If so report waiting_input - the detector then keeps the task
			// running instead of marking it done and launching dependents on an
			// unanswered question.
			const messages = await getHistory(task.tabId);
			const classification = classifyMessages(enrichWithAwaitingInput(messages));
			if (classification.kind !== 'none') {
				// F5/F8 (ISC-5.2/5.7): reflect the awaiting-input signal on the run.
				if (task.agentId) signals.markWaiting(task.agentId);
				return 'waiting_input';
			}
			return 'idle';
		},
		getRecentMessages: async (task) => {
			if (!task.tabId) return [];
			return getHistory(task.tabId);
		},
		ensureAgent: async (task) => {
			if (task.agentId) {
				let agentType = task.agentType;
				if (!agentType) {
					try {
						agentType = resolveExistingPianolaAgentType(task, await listDesktopSessions());
					} catch {
						// Preserve the pre-existing short-circuit behavior if the live session
						// list is temporarily unavailable; the next tick can enrich it.
					}
				}
				return {
					agentId: task.agentId,
					...(agentType ? { agentType } : {}),
				};
			}
			// Capability/load-aware selection: pick a ready, least-loaded tool type
			// from the live session pool instead of always spawning the default
			// agent. One candidate per distinct live tool type (present in the pool
			// means runnable, status 'ok'); load is this plan's tasks currently
			// running on that type; a type counts as busy only when every one of its
			// sessions is mid-turn. Selection creates a FRESH session of the chosen
			// type (no cross-task reuse, so task transcripts never bleed together).
			let toolType = task.agentType;
			if (!toolType) {
				const sessions = await listDesktopSessions();
				const running: Record<string, number> = {};
				for (const t of state.plan.tasks) {
					if (t.status === 'running' && t.agentType) {
						running[t.agentType] = (running[t.agentType] ?? 0) + 1;
					}
				}
				const pool = new Map<string, { total: number; busy: number }>();
				for (const s of sessions) {
					const e = pool.get(s.toolType) ?? { total: 0, busy: 0 };
					e.total += 1;
					if (s.state === 'busy') e.busy += 1;
					pool.set(s.toolType, e);
				}
				const candidates: AgentCandidate[] = [...pool.entries()].map(([type, e]) => ({
					agentId: type,
					capabilities: DEFAULT_CAPABILITIES,
					status: 'ok',
					busy: e.total > 0 && e.busy === e.total,
					inFlight: running[type] ?? 0,
				}));
				const selection = selectAgentForTask(task, candidates);
				if ('agentId' in selection) {
					toolType = selection.agentId;
				} else {
					// No reusable ready tool type in the live pool (cold start = empty pool,
					// or every live type is mid-turn). Create a fresh default session rather
					// than returning { error } / leaving the task pending: on a cold start the
					// pool is empty until WE create the first session, so failing here would
					// deadlock the plan (no session would ever appear). A freshly created
					// session is never itself "busy", and total parallelism is already bounded
					// by options.concurrencyLimit in the dispatch loop. Noted for observability.
					console.log(`[orchestrator] ${selection.escalate}; defaulting to claude-code`);
					toolType = 'claude-code';
				}
			}

			const result = await client.sendCommand<CreateSessionResult>(
				{
					type: 'create_session',
					name: task.title,
					toolType: toolType || 'claude-code',
					cwd: task.cwd || process.cwd(),
				},
				'create_session_result'
			);
			if (!result.success || !result.sessionId) {
				return { error: result.error ?? 'create_session did not return a sessionId' };
			}
			return { agentId: result.sessionId, agentType: toolType || 'claude-code' };
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
		reactiveEnabled: () => autopilotEnabledNow(),
		getRunLedger: async (task) => ledgerForTask(plan.id, task),
		dispatchFix: async (task, ledger) => {
			// Gated + audited: only auto-fix when autopilot is on this iteration.
			if (!autopilotEnabledNow()) return { success: false, error: 'autopilot off' };
			const fixPrompt = `The previous run left ${ledger.openFindings ?? 0} open review finding(s) and/or failing checks. Address them, then stop.`;
			const agentId = task.agentId;
			if (!agentId) return { success: false, error: 'no agent bound' };
			auditAgentRunAction(ledger.runId, 'auto-fix', {
				taskId: task.id,
				openFindings: ledger.openFindings ?? 0,
				checksPassed: ledger.checksPassed,
				attempt: (task.fixAttempts ?? 0) + 1,
			});
			try {
				const res = await runDispatch(agentId, fixPrompt, {});
				// F5/F8 (ISC-5.9): a REAL dispatch just happened - reflect it on the run
				// through the guarded producer. The dispatch object is the evidence; on
				// a failed dispatch nothing is written (the task also stays needs_review).
				if (res.success && ledger.runId) {
					signals.markFixing(ledger.runId, {
						agentId,
						reason: `auto-fix attempt ${(task.fixAttempts ?? 0) + 1}`,
					});
				}
				return { success: !!res.success, error: res.error };
			} catch (error) {
				return { success: false, error: String(error) };
			}
		},
		requestMerge: async (task, ledger) => {
			// Gated + risk-rated + audited (ISC-8.9/8.10/8.14): never auto-merge when
			// autopilot is off, only when the run is fully green (checks passed AND
			// zero open findings of ANY severity), and never when the merge action
			// rates high-risk (high-risk-always-escalates).
			if (!autopilotEnabledNow()) return { merged: false, error: 'autopilot off' };
			if (ledger.checksPassed !== true || (ledger.openFindings ?? 0) > 0) {
				return { merged: false, error: 'not green (needs passing checks + zero open findings)' };
			}
			const risk = rateRisk(`merge branch for task ${task.title}: ${task.prompt}`);
			if (risk === 'high') {
				deps.log(`[orchestrator] task "${task.id}" merge escalated (high risk), not auto-merging`);
				return { merged: false, error: 'high risk: escalated to user' };
			}
			auditAgentRunAction(ledger.runId, 'auto-merge', { taskId: task.id, risk });
			// No git-merge execution path is reachable from the control plane today
			// (git.ts exposes status/diff/commit/createPR but no branch merge). Record
			// an honest 'skipped' merge outcome on the run rather than fabricating a
			// merge or sending a command with no handler. When a merge path lands,
			// this is the single site to wire it to.
			if (ledger.runId) {
				const run = getAgentRun(ledger.runId);
				if (run) {
					upsertAgentRun({
						...run,
						updatedAt: Date.now(),
						merge: {
							status: 'skipped',
							error:
								'No git-merge path reachable from the AgentRun control plane; merge not attempted.',
							metadata: { requestedAt: Date.now(), risk },
						},
					});
				}
			}
			return { merged: false, error: 'merge path not available (recorded skipped)' };
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

			let result: OrchestratorIterationResult;
			try {
				result = await runOrchestratorIteration(state, deps, { concurrencyLimit });
			} catch (error) {
				// A transient failure (e.g. a WS sendCommand timeout) must not tear down
				// the whole run. Mirror the watcher: log and keep orchestrating - the next
				// tick re-polls and re-dispatches from the persisted plan.
				const message = error instanceof Error ? error.message : String(error);
				console.error(`[orchestrator] iteration error: ${message}`);
				if (once || stopped) break;
				await sleep(intervalMs);
				continue;
			}
			recordPianolaAgentRunProgress(result, signals);
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
