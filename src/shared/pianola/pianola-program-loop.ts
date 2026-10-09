import { planProgress, type PianolaPlan } from './pianola-tasks';
import type { PianolaProgram, PianolaAsk, PianolaBrief } from './pianola-programs';
import type { PianolaSupervisedTarget } from './storage';
import { generateUUID } from '../uuid';

export type ProgramLoopWakeKind =
	| 'idle-handoff'
	| 'plan-finished'
	| 'task-needs-attention'
	| 'founder-resolution';
interface ProgramLoopWakeIntent {
	id: string;
	kind: ProgramLoopWakeKind;
	detail: string;
	prompt: string;
	planId?: string;
	taskKey?: string;
	resolutionIds: string[];
}

export interface ProgramLoopMemoEntry {
	lastHandoffPlanId?: string;
	lastWakeReason?: string;
	lastWakeAt?: string;
	lastLoggedReason?: string;
	notifiedTaskIds: string[];
	notifiedResolutionIds?: string[];
	pendingWake?: ProgramLoopWakeIntent;
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
		if (
			value.notifiedResolutionIds !== undefined &&
			(!Array.isArray(value.notifiedResolutionIds) ||
				!value.notifiedResolutionIds.every((v) => typeof v === 'string'))
		)
			continue;
		if (value.pendingWake !== undefined) {
			const intent = value.pendingWake as Record<string, unknown> | null;
			if (
				!intent ||
				typeof intent !== 'object' ||
				Array.isArray(intent) ||
				typeof intent.id !== 'string' ||
				!intent.id ||
				!['idle-handoff', 'plan-finished', 'task-needs-attention', 'founder-resolution'].includes(
					intent.kind as string
				) ||
				typeof intent.detail !== 'string' ||
				typeof intent.prompt !== 'string' ||
				(intent.planId !== undefined && typeof intent.planId !== 'string') ||
				(intent.taskKey !== undefined && typeof intent.taskKey !== 'string') ||
				!Array.isArray(intent.resolutionIds) ||
				!intent.resolutionIds.every((v) => typeof v === 'string')
			)
				continue;
		}
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
			...(value.notifiedResolutionIds
				? { notifiedResolutionIds: value.notifiedResolutionIds as string[] }
				: {}),
			...(value.pendingWake
				? { pendingWake: value.pendingWake as unknown as ProgramLoopWakeIntent }
				: {}),
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
	findWake(agentId: string, wakeId: string): Promise<{ success: true; tabId: string } | undefined>;
	wake(
		agentId: string,
		prompt: string
	): Promise<{ success: boolean; tabId?: string; error?: string }>;
	ensureWatch(agentId: string, tabId: string): Promise<void> | void;
	persistMemo(memo: ProgramLoopMemoEntry): Promise<void> | void;
	prompt(kind: ProgramLoopWakeKind, variables: Record<string, string>): string;
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
	const memo: ProgramLoopMemoEntry = {
		...state.memo,
		notifiedTaskIds: [...state.memo.notifiedTaskIds],
		notifiedResolutionIds: [...(state.memo.notifiedResolutionIds ?? [])],
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
	const ensureWatch = async (agentId: string, tabId: string): Promise<void> => {
		if (
			!state.targets.some(
				(target) =>
					target.kind === 'watch' &&
					target.agentId === agentId &&
					(!target.enabled || target.tabId === tabId)
			)
		)
			await deps.ensureWatch(agentId, tabId);
	};
	if (memo.pendingWatch?.tabId) {
		await ensureWatch(memo.pendingWatch.agentId, memo.pendingWatch.tabId);
		ensured = true;
		delete memo.pendingWatch;
		await deps.persistMemo(memo);
	}
	const plans = state.plans
		.filter((plan) => plan.programId === program.id)
		.sort((a, b) => b.createdAt - a.createdAt);
	const active = plans.find((plan) => !planProgress(plan).complete);
	const target =
		active &&
		state.targets.find((target) => target.kind === 'orchestrate' && target.planId === active.id);
	if (
		active &&
		(!target || (target.enabled && target.concurrency !== program.charter.maxConcurrent))
	) {
		await deps.ensureOrchestrate(active, program.charter.maxConcurrent);
		ensured = true;
	}
	if (!program.leadAgentId) return result('no-op (no lead)');
	let intent = memo.pendingWake;
	const receipt = intent ? await deps.findWake(program.leadAgentId, intent.id) : undefined;
	if (!receipt && state.leadSession?.state === 'busy') return result('no-op (busy lead)');
	if (!intent) {
		const resolutions = state.asks.filter(
			(ask) =>
				ask.programId === program.id &&
				ask.status === 'resolved' &&
				ask.resolution &&
				!memo.notifiedResolutionIds!.includes(ask.id + ':' + ask.resolution.resolvedAt)
		);
		let kind: ProgramLoopWakeKind;
		let detail: string;
		const vars: Record<string, string> = {
			PROGRAM_TITLE: program.title,
			PROGRAM_ID: program.id,
			CREATED_AT: String(Date.parse(now)),
			ROOT: program.root,
			ROOT_JSON: JSON.stringify(program.root),
			ROLES: Object.entries(program.roles)
				.map(
					([role, agent]) => role + ': ' + agent.name + ' (' + (agent.agentId ?? 'unassigned') + ')'
				)
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
					!memo.notifiedTaskIds.includes(plan.id + ':' + task.id)
			)
		);
		const task = attentionPlan?.tasks.find(
			(task) =>
				(task.status === 'needs_review' || task.status === 'failed') &&
				!memo.notifiedTaskIds.includes(attentionPlan.id + ':' + task.id)
		);
		if (resolutions.length) {
			kind = 'founder-resolution';
			detail = 'woke lead (founder decision)';
			vars.RESULT = resolutions
				.map((ask) =>
					[
						ask.title + ': ' + ask.resolution!.option,
						ask.resolution!.note,
						'Origin: ' + (ask.agentId ?? 'unspecified') + (ask.tabId ? ' / ' + ask.tabId : ''),
					]
						.filter(Boolean)
						.join('\n')
				)
				.join('\n\n');
		} else if (task) {
			kind = 'task-needs-attention';
			detail = 'woke lead (task ' + task.id + ' ' + task.status + ')';
			vars.TASK_TITLE = task.title;
			vars.TASK_STATUS = task.status;
			vars.TASK_ERROR = task.error ?? 'No error details recorded.';
		} else if (active) {
			return result(ensured ? 'ensured orchestrate target' : 'no-op (active plan)');
		} else if (plans[0] && plans[0].id !== memo.lastHandoffPlanId) {
			kind = 'plan-finished';
			detail = 'woke lead (plan finished ' + plans[0].id + ')';
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
					.map((ask) => ask.title + ': ' + ask.detail)
					.join('\n') || 'No open asks.';
		}
		const id = generateUUID();
		intent = {
			id,
			kind,
			detail,
			prompt: deps.prompt(kind, vars) + '\n\n[Pianola wake ' + id + ']',
			...(kind === 'plan-finished' ? { planId: plans[0].id } : {}),
			...(kind === 'task-needs-attention' && task && attentionPlan
				? { taskKey: attentionPlan.id + ':' + task.id }
				: {}),
			resolutionIds: resolutions.map((ask) => ask.id + ':' + ask.resolution!.resolvedAt),
		};
		memo.pendingWake = intent;
		await deps.persistMemo(memo);
	}
	const wake = receipt ?? (await deps.wake(program.leadAgentId, intent.prompt));
	if (!wake.success) {
		delete memo.pendingWake;
		await deps.persistMemo(memo);
		return result('wake failed (' + intent.kind + ')', false, undefined, wake.error);
	}
	if (!wake.tabId)
		throw new Error('Wake accepted without an addressable tab; receipt recovery required');
	memo.lastWakeReason = intent.kind === 'idle-handoff' ? 'idle' : intent.kind;
	memo.lastWakeAt = now;
	if (intent.planId) memo.lastHandoffPlanId = intent.planId;
	if (intent.taskKey && !memo.notifiedTaskIds.includes(intent.taskKey))
		memo.notifiedTaskIds.push(intent.taskKey);
	memo.notifiedResolutionIds = [
		...new Set([...memo.notifiedResolutionIds!, ...intent.resolutionIds]),
	];
	memo.pendingWatch = { agentId: program.leadAgentId, tabId: wake.tabId };
	delete memo.pendingWake;
	await deps.persistMemo(memo);
	await ensureWatch(program.leadAgentId, wake.tabId);
	delete memo.pendingWatch;
	await deps.persistMemo(memo);
	return result(intent.detail, true, wake.tabId);
}
