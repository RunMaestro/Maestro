import { planProgress, type PianolaPlan } from './pianola-tasks';
import type { PianolaProgram, PianolaAsk, PianolaBrief } from './pianola-programs';
import type { PianolaSupervisedTarget } from './storage';

export interface ProgramLoopMemoEntry {
	lastHandoffPlanId?: string;
	lastWakeReason?: string;
	lastWakeAt?: string;
	lastLoggedReason?: string;
	notifiedTaskIds: string[];
}
export type ProgramLoopMemo = Record<string, ProgramLoopMemoEntry>;

export function validateProgramLoopMemo(raw: unknown): ProgramLoopMemo {
	const result: ProgramLoopMemo = {};
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return result;
	for (const [id, entry] of Object.entries(raw)) {
		if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
		const value = entry as Record<string, unknown>;
		if (
			!Array.isArray(value.notifiedTaskIds) ||
			!value.notifiedTaskIds.every((v) => typeof v === 'string')
		)
			continue;
		if (value.lastHandoffPlanId !== undefined && typeof value.lastHandoffPlanId !== 'string')
			continue;
		if (value.lastWakeReason !== undefined && typeof value.lastWakeReason !== 'string') continue;
		if (value.lastWakeAt !== undefined && typeof value.lastWakeAt !== 'string') continue;
		if (value.lastLoggedReason !== undefined && typeof value.lastLoggedReason !== 'string')
			continue;
		result[id] = {
			notifiedTaskIds: value.notifiedTaskIds as string[],
			...(value.lastHandoffPlanId ? { lastHandoffPlanId: value.lastHandoffPlanId as string } : {}),
			...(value.lastWakeReason ? { lastWakeReason: value.lastWakeReason as string } : {}),
			...(value.lastWakeAt ? { lastWakeAt: value.lastWakeAt as string } : {}),
			...(value.lastLoggedReason ? { lastLoggedReason: value.lastLoggedReason as string } : {}),
		};
	}
	return result;
}

export interface ProgramLoopState {
	program: PianolaProgram;
	plans: readonly PianolaPlan[];
	asks: readonly PianolaAsk[];
	brief: PianolaBrief;
	targets: readonly PianolaSupervisedTarget[];
	leadSession?: { tabId: string; state: string };
	memo: ProgramLoopMemoEntry;
	now: string;
}

export interface ProgramLoopDeps {
	ensureOrchestrate(plan: PianolaPlan, concurrency: number): Promise<void> | void;
	wake(
		agentId: string,
		prompt: string
	): Promise<{ success: boolean; tabId?: string; error?: string }>;
	ensureWatch(agentId: string, tabId: string): Promise<void> | void;
	prompt(
		kind: 'idle-handoff' | 'plan-finished' | 'task-needs-attention',
		variables: Record<string, string>
	): string;
}

export interface ProgramLoopResult {
	reason: string;
	memo: ProgramLoopMemoEntry;
	dispatched: boolean;
	acted: boolean;
	tabId?: string;
	error?: string;
}

export function shouldLogProgramLoopDecision(
	previous: ProgramLoopMemoEntry | undefined,
	result: ProgramLoopResult
): boolean {
	return result.acted || previous?.lastLoggedReason !== result.reason;
}

export async function runProgramLoopTick(
	state: ProgramLoopState,
	deps: ProgramLoopDeps
): Promise<ProgramLoopResult> {
	const { program, now } = state;
	const memo: ProgramLoopMemoEntry = {
		...state.memo,
		notifiedTaskIds: [...state.memo.notifiedTaskIds],
	};
	let ensured = false;
	const result = (
		reason: string,
		dispatched = false,
		tabId?: string,
		error?: string
	): ProgramLoopResult => ({
		reason: 'program-loop: ' + program.id + ' ' + reason,
		memo,
		dispatched,
		acted: ensured || dispatched,
		tabId,
		error,
	});
	if (program.status !== 'active') return result('no-op (paused)');
	const plans = state.plans
		.filter((plan) => plan.programId === program.id)
		.sort((a, b) => b.createdAt - a.createdAt);
	const active = plans.find((plan) => !planProgress(plan).complete);
	if (
		active &&
		!state.targets.some(
			(target) => target.kind === 'orchestrate' && target.planId === active.id && target.enabled
		)
	) {
		await deps.ensureOrchestrate(active, program.charter.maxConcurrent);
		ensured = true;
	}
	let kind: 'idle-handoff' | 'plan-finished' | 'task-needs-attention';
	let detail: string;
	const vars: Record<string, string> = {
		PROGRAM_TITLE: program.title,
		PROGRAM_ID: program.id,
		CREATED_AT: String(Date.parse(now)),
		ROOT: program.root,
		ROOT_JSON: JSON.stringify(program.root),
		ROLES: Object.entries(program.roles)
			.map(([role, agent]) => `${role}: ${agent.name} (${agent.agentId ?? 'unassigned'})`)
			.join('\n'),
		RESULT: '',
		TASK_TITLE: '',
		TASK_STATUS: '',
		TASK_ERROR: '',
	};
	if (active) {
		const task = active.tasks.find(
			(entry) =>
				(entry.status === 'needs_review' || entry.status === 'failed') &&
				!memo.notifiedTaskIds.includes(`${active.id}:${entry.id}`)
		);
		if (!task) return result(ensured ? 'ensured orchestrate target' : 'no-op (active plan)');
		kind = 'task-needs-attention';
		detail = `woke lead (task ${task.id} ${task.status})`;
		vars.TASK_TITLE = task.title;
		vars.TASK_STATUS = task.status;
		vars.TASK_ERROR = task.error ?? 'No error details recorded.';
	} else if (plans[0] && plans[0].id !== memo.lastHandoffPlanId) {
		kind = 'plan-finished';
		detail = `woke lead (plan finished ${plans[0].id})`;
		const progress = planProgress(plans[0]);
		const verified = state.brief.verified.filter((task) => task.planId === plans[0].id);
		vars.RESULT =
			plans[0].title +
			': ' +
			progress.done +
			' done, ' +
			progress.failed +
			' failed, ' +
			plans[0].tasks.filter((task) => task.status === 'skipped').length +
			' skipped. Verified: ' +
			(verified.map((task) => task.taskTitle).join(', ') || 'none') +
			'.';
	} else {
		if (memo.lastWakeAt && Date.parse(now) - Date.parse(memo.lastWakeAt) < 60 * 60_000)
			return result('no-op (idle backoff)');
		kind = 'idle-handoff';
		detail = 'woke lead (idle)';
		vars.RESULT =
			state.asks
				.filter((ask) => ask.status === 'open' && ask.programId === program.id)
				.map((ask) => `${ask.title}: ${ask.detail}`)
				.join('\n') || 'No open asks.';
	}
	if (!program.leadAgentId) return result('no-op (no lead)');
	if (state.leadSession?.state === 'busy') return result('no-op (busy lead)');
	const wake = await deps.wake(program.leadAgentId, deps.prompt(kind, vars));
	if (!wake.success) return result(`wake failed (${kind})`, false, undefined, wake.error);
	const tabId = wake.tabId;
	if (
		tabId &&
		!state.targets.some(
			(target) =>
				target.kind === 'watch' &&
				target.agentId === program.leadAgentId &&
				target.tabId === tabId &&
				target.enabled
		)
	)
		await deps.ensureWatch(program.leadAgentId, tabId);
	memo.lastWakeReason = kind === 'idle-handoff' ? 'idle' : kind;
	memo.lastWakeAt = now;
	if (kind === 'plan-finished') memo.lastHandoffPlanId = plans[0].id;
	if (kind === 'task-needs-attention' && active) {
		const task = active.tasks.find(
			(entry) =>
				(entry.status === 'needs_review' || entry.status === 'failed') &&
				!memo.notifiedTaskIds.includes(`${active.id}:${entry.id}`)
		);
		if (task) memo.notifiedTaskIds.push(`${active.id}:${task.id}`);
	}
	return result(detail, true, tabId);
}
