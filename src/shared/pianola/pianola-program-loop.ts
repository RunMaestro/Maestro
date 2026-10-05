import { planProgress, type PianolaPlan } from './pianola-tasks';
import type { PianolaProgram, PianolaAsk, PianolaBrief } from './pianola-programs';
import type { PianolaSupervisedTarget } from './storage';

export interface ProgramLoopMemoEntry {
	lastHandoffPlanId?: string;
	lastWakeReason?: string;
	lastWakeAt?: string;
	lastLoggedReason?: string;
	notifiedTaskIds: string[];
	pendingWatch?: { agentId: string; tabId?: string };
}
export type ProgramLoopMemo = Record<string, ProgramLoopMemoEntry>;

export function validateProgramLoopMemo(raw: unknown): ProgramLoopMemo {
	const result: ProgramLoopMemo = Object.create(null);
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
		if (value.pendingWatch !== undefined) {
			const watch = value.pendingWatch as Record<string, unknown> | null;
			if (
				!watch ||
				typeof watch !== 'object' ||
				Array.isArray(watch) ||
				typeof watch.agentId !== 'string' ||
				(watch.tabId !== undefined && typeof watch.tabId !== 'string')
			)
				continue;
		}
		result[id] = {
			notifiedTaskIds: value.notifiedTaskIds as string[],
			...(value.lastHandoffPlanId ? { lastHandoffPlanId: value.lastHandoffPlanId as string } : {}),
			...(value.lastWakeReason ? { lastWakeReason: value.lastWakeReason as string } : {}),
			...(value.lastWakeAt ? { lastWakeAt: value.lastWakeAt as string } : {}),
			...(value.lastLoggedReason ? { lastLoggedReason: value.lastLoggedReason as string } : {}),
			...(value.pendingWatch
				? { pendingWatch: value.pendingWatch as ProgramLoopMemoEntry['pendingWatch'] }
				: {}),
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
	persistMemo(memo: ProgramLoopMemoEntry): Promise<void> | void;
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
	return result.acted || (!!result.error && previous?.lastLoggedReason !== result.reason);
}

export async function runProgramLoopTick(
	state: ProgramLoopState,
	deps: ProgramLoopDeps
): Promise<ProgramLoopResult> {
	const { program, now } = state;
	let memo: ProgramLoopMemoEntry = {
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
	if (memo.pendingWatch?.tabId) {
		const { agentId, tabId } = memo.pendingWatch;
		if (
			!state.targets.some(
				(target) =>
					target.kind === 'watch' &&
					target.agentId === agentId &&
					(!target.enabled || target.tabId === tabId)
			)
		) {
			await deps.ensureWatch(agentId, tabId);
			ensured = true;
		}
		delete memo.pendingWatch;
		await deps.persistMemo(memo);
	}
	const plans = state.plans
		.filter((plan) => plan.programId === program.id)
		.sort((a, b) => b.createdAt - a.createdAt);
	const active = plans.find((plan) => !planProgress(plan).complete);
	if (
		active &&
		!state.targets.some((target) => target.kind === 'orchestrate' && target.planId === active.id)
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
	const attentionPlan = plans.find((plan) =>
		plan.tasks.some(
			(task) =>
				(task.status === 'needs_review' || task.status === 'failed') &&
				!memo.notifiedTaskIds.includes(`${plan.id}:${task.id}`)
		)
	);
	const task = attentionPlan?.tasks.find(
		(task) =>
			(task.status === 'needs_review' || task.status === 'failed') &&
			!memo.notifiedTaskIds.includes(`${attentionPlan.id}:${task.id}`)
	);
	if (task) {
		kind = 'task-needs-attention';
		detail = `woke lead (task ${task.id} ${task.status})`;
		vars.TASK_TITLE = task.title;
		vars.TASK_STATUS = task.status;
		vars.TASK_ERROR = task.error ?? 'No error details recorded.';
	} else if (active) {
		return result(ensured ? 'ensured orchestrate target' : 'no-op (active plan)');
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
	const prompt = deps.prompt(kind, vars);
	const previousMemo = memo;
	memo = {
		...memo,
		notifiedTaskIds: [...memo.notifiedTaskIds],
		pendingWatch: { agentId: program.leadAgentId },
	};
	memo.lastWakeReason = kind === 'idle-handoff' ? 'idle' : kind;
	memo.lastWakeAt = now;
	if (kind === 'plan-finished') memo.lastHandoffPlanId = plans[0].id;
	if (kind === 'task-needs-attention' && attentionPlan && task)
		memo.notifiedTaskIds.push(`${attentionPlan.id}:${task.id}`);
	await deps.persistMemo(memo);
	let wake: Awaited<ReturnType<ProgramLoopDeps['wake']>>;
	try {
		wake = await deps.wake(program.leadAgentId, prompt);
	} catch (error) {
		memo = previousMemo;
		await deps.persistMemo(memo);
		throw error;
	}
	if (!wake.success) {
		memo = previousMemo;
		await deps.persistMemo(memo);
		return result(`wake failed (${kind})`, false, undefined, wake.error);
	}
	const tabId = wake.tabId;
	memo.pendingWatch = { agentId: program.leadAgentId, ...(tabId ? { tabId } : {}) };
	await deps.persistMemo(memo);
	const disabledWatch = state.targets.some(
		(target) => target.kind === 'watch' && target.agentId === program.leadAgentId && !target.enabled
	);
	if (
		!disabledWatch &&
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
	delete memo.pendingWatch;
	await deps.persistMemo(memo);
	return result(detail, true, tabId);
}
