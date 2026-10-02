import { planProgress, type PianolaPlan } from './pianola-tasks';
import type { PianolaDecisionRecord } from './storage';
import type { PianolaSupervisedTarget } from './storage';
import type { ProgramLoopMemo } from './pianola-program-loop';
import type { AgentRun } from '../agent-run/types';

export type PianolaProgramStatus = 'active' | 'paused';
export interface PianolaProgramRole {
	name: string;
	agentId?: string;
	agentType?: string;
	instructions?: string;
	model?: string;
}
export interface PianolaProgramCharter {
	maxConcurrent: number;
	maxAttempts: number;
	validationRequired: boolean;
}
export interface PianolaProgram {
	id: string;
	title: string;
	root: string;
	remoteId?: string;
	/** Env for role agents on the SSH remote (CLI wrapper path, data dir, host as seen there). */
	remoteEnv?: Record<string, string>;
	leadAgentId?: string;
	roles: Record<string, PianolaProgramRole>;
	charter: PianolaProgramCharter;
	status: PianolaProgramStatus;
	createdAt: number;
	updatedAt: number;
}
export type PianolaAskSeverity = 'low' | 'medium' | 'high' | 'critical';
export type PianolaAskStatus = 'open' | 'resolved' | 'dismissed';
export interface PianolaAsk {
	id: string;
	createdAt: string;
	updatedAt: string;
	programId?: string;
	agentId?: string;
	tabId?: string;
	title: string;
	detail: string;
	severity: PianolaAskSeverity;
	requestedAction?: string;
	dedupeKey: string;
	status: PianolaAskStatus;
	resolution?: { option: string; note?: string; resolvedAt: string };
}
export interface PianolaBriefItem {
	kind: 'ask' | 'needs_review' | 'failed' | 'escalation';
	id: string;
	programId?: string;
	programTitle?: string;
	title: string;
	detail?: string;
	severity?: PianolaAskSeverity;
	since: string;
	planId?: string;
	taskId?: string;
	decisionId?: string;
}
export interface PianolaBriefInFlight {
	programId?: string;
	programTitle?: string;
	planId: string;
	planTitle: string;
	taskId: string;
	taskTitle: string;
	status: 'running' | 'fixing';
	agentId?: string;
	tabId?: string;
	since?: string;
}
export interface PianolaBriefVerified {
	programId?: string;
	programTitle?: string;
	planId: string;
	planTitle: string;
	taskId: string;
	taskTitle: string;
	runId?: string;
	checkName: string;
	completedAt: string;
}
export interface PianolaBriefProgram {
	id: string;
	title: string;
	status: PianolaProgramStatus;
	activePlanId?: string;
	activePlanTitle?: string;
	openAsks: number;
	running: number;
	verifiedLast7d: number;
	loop: { supervised: boolean; lastWakeReason?: string; lastWakeAt?: string };
}
export interface PianolaBrief {
	generatedAt: string;
	needsMe: PianolaBriefItem[];
	inFlight: PianolaBriefInFlight[];
	verified: PianolaBriefVerified[];
	programs: PianolaBriefProgram[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);
const optionalString = (value: Record<string, unknown>, key: string): boolean =>
	value[key] === undefined || typeof value[key] === 'string';
const iso = (value: unknown): value is string =>
	typeof value === 'string' && Number.isFinite(Date.parse(value));
export function validatePianolaProgram(raw: unknown): PianolaProgram | null {
	if (
		!isRecord(raw) ||
		typeof raw.id !== 'string' ||
		!raw.id ||
		typeof raw.title !== 'string' ||
		!raw.title ||
		typeof raw.root !== 'string' ||
		!raw.root ||
		!optionalString(raw, 'remoteId') ||
		(raw.remoteEnv !== undefined &&
			(!isRecord(raw.remoteEnv) ||
				Object.values(raw.remoteEnv).some((v) => typeof v !== 'string'))) ||
		!optionalString(raw, 'leadAgentId') ||
		!isRecord(raw.roles) ||
		!isRecord(raw.charter) ||
		(raw.status !== 'active' && raw.status !== 'paused') ||
		typeof raw.createdAt !== 'number' ||
		!Number.isFinite(raw.createdAt) ||
		typeof raw.updatedAt !== 'number' ||
		!Number.isFinite(raw.updatedAt)
	)
		return null;
	const charter = raw.charter;
	if (
		!Number.isInteger(charter.maxConcurrent) ||
		(charter.maxConcurrent as number) < 1 ||
		!Number.isInteger(charter.maxAttempts) ||
		(charter.maxAttempts as number) < 1 ||
		typeof charter.validationRequired !== 'boolean'
	)
		return null;
	for (const role of Object.values(raw.roles)) {
		if (
			!isRecord(role) ||
			typeof role.name !== 'string' ||
			!role.name ||
			!optionalString(role, 'agentId') ||
			!optionalString(role, 'agentType') ||
			!optionalString(role, 'instructions') ||
			!optionalString(role, 'model')
		)
			return null;
	}
	return raw as unknown as PianolaProgram;
}
export function validatePianolaAsk(raw: unknown): PianolaAsk | null {
	if (
		!isRecord(raw) ||
		typeof raw.id !== 'string' ||
		!raw.id ||
		!iso(raw.createdAt) ||
		!iso(raw.updatedAt) ||
		!optionalString(raw, 'programId') ||
		!optionalString(raw, 'agentId') ||
		!optionalString(raw, 'tabId') ||
		typeof raw.title !== 'string' ||
		!raw.title ||
		typeof raw.detail !== 'string' ||
		!['low', 'medium', 'high', 'critical'].includes(raw.severity as string) ||
		!optionalString(raw, 'requestedAction') ||
		typeof raw.dedupeKey !== 'string' ||
		raw.dedupeKey !== `${raw.agentId ?? 'unknown'}:${raw.programId ?? 'global'}` ||
		!['open', 'resolved', 'dismissed'].includes(raw.status as string)
	)
		return null;
	if (
		raw.resolution !== undefined &&
		(!isRecord(raw.resolution) ||
			typeof raw.resolution.option !== 'string' ||
			!optionalString(raw.resolution, 'note') ||
			!iso(raw.resolution.resolvedAt))
	)
		return null;
	return raw as unknown as PianolaAsk;
}
export function dedupeAsk(
	asks: readonly PianolaAsk[],
	incoming: PianolaAsk,
	distinct = false
): { asks: PianolaAsk[]; ask: PianolaAsk } {
	const index = distinct
		? -1
		: asks.findIndex((ask) => ask.status === 'open' && ask.dedupeKey === incoming.dedupeKey);
	if (index < 0) return { asks: [...asks, incoming], ask: incoming };
	const previous = asks[index];
	const levels: PianolaAskSeverity[] = ['low', 'medium', 'high', 'critical'];
	const ask = {
		...previous,
		title: incoming.title,
		detail: incoming.detail,
		requestedAction: incoming.requestedAction,
		updatedAt: incoming.updatedAt,
		severity:
			levels[Math.max(levels.indexOf(previous.severity), levels.indexOf(incoming.severity))],
	};
	const updated = [...asks];
	updated[index] = ask;
	return { asks: updated, ask };
}
export function assertOneActivePlanPerProgram(
	plan: PianolaPlan,
	plans: readonly PianolaPlan[]
): void {
	if (
		plan.programId &&
		plans.some(
			(other) =>
				other.id !== plan.id && other.programId === plan.programId && !planProgress(other).complete
		)
	)
		throw new Error(`Program ${plan.programId} already has an active plan`);
}
export interface PianolaBriefRun {
	id: string;
	completedAt?: string;
	checks: readonly { name: string; status: string }[];
}
export function briefRunsForPlans(
	plans: readonly PianolaPlan[],
	agentRuns: readonly Pick<AgentRun, 'id' | 'checks' | 'updatedAt'>[],
	runIdForTask: (planId: string, taskId: string) => string
): Record<string, PianolaBriefRun> {
	const byId = new Map(agentRuns.map((run) => [run.id, run]));
	const result: Record<string, PianolaBriefRun> = {};
	for (const plan of plans)
		for (const task of plan.tasks) {
			if (task.status !== 'done') continue;
			const run = byId.get(task.runId ?? runIdForTask(plan.id, task.id));
			if (!run) continue;
			const check = run.checks.find(
				(entry) => entry.name === 'independent-validation' && entry.status === 'passed'
			);
			result[plan.id + ':' + task.id] = {
				id: run.id,
				checks: run.checks,
				completedAt: new Date(check?.completedAt ?? run.updatedAt).toISOString(),
			};
		}
	return result;
}
export function derivePianolaBrief(
	programs: readonly PianolaProgram[],
	plans: readonly PianolaPlan[],
	asks: readonly PianolaAsk[],
	decisions: readonly PianolaDecisionRecord[],
	runs: Readonly<Record<string, PianolaBriefRun | undefined>>,
	generatedAt: string = new Date().toISOString(),
	targets: readonly PianolaSupervisedTarget[] = [],
	memo: ProgramLoopMemo = {}
): PianolaBrief {
	const since = Date.parse(generatedAt) - 7 * 86400_000;
	const byId = new Map(programs.map((p) => [p.id, p]));
	const needsMe: PianolaBriefItem[] = asks
		.filter((a) => a.status === 'open')
		.map((a) => ({
			kind: 'ask',
			id: a.id,
			programId: a.programId,
			programTitle: a.programId ? byId.get(a.programId)?.title : undefined,
			title: a.title,
			detail: a.detail,
			severity: a.severity,
			since: a.createdAt,
		}));
	const inFlight: PianolaBriefInFlight[] = [];
	const verified: PianolaBriefVerified[] = [];
	for (const plan of plans)
		for (const task of plan.tasks) {
			const common = {
				programId: plan.programId,
				programTitle: plan.programId ? byId.get(plan.programId)?.title : undefined,
				planId: plan.id,
				planTitle: plan.title,
				taskId: task.id,
				taskTitle: task.title,
			};
			if (task.status === 'needs_review' || task.status === 'failed')
				needsMe.push({
					kind: task.status === 'failed' ? 'failed' : 'needs_review',
					id: `${plan.id}:${task.id}`,
					...common,
					title: task.title,
					detail: task.error,
					since: new Date(plan.createdAt).toISOString(),
				});
			if (task.status === 'running' || task.status === 'fixing')
				inFlight.push({ ...common, status: task.status, agentId: task.agentId, tabId: task.tabId });
			const run = runs[`${plan.id}:${task.id}`];
			if (
				task.status === 'done' &&
				run?.checks.some(
					(check) => check.name === 'independent-validation' && check.status === 'passed'
				)
			)
				verified.push({
					...common,
					runId: run.id,
					checkName: 'independent-validation',
					completedAt: run.completedAt ?? generatedAt,
				});
		}
	for (const decision of decisions)
		if (
			decision.decision.action === 'escalate' &&
			!/handed off/i.test(decision.decision.reason) &&
			Date.parse(decision.timestamp) >= since
		)
			needsMe.push({
				kind: 'escalation',
				id: decision.id,
				decisionId: decision.id,
				title: decision.classification.topic || decision.decision.reason,
				detail: decision.decision.reason,
				since: decision.timestamp,
			});
	return {
		generatedAt,
		needsMe,
		inFlight,
		verified,
		programs: programs.map((program) => {
			const active = plans.find(
				(plan) => plan.programId === program.id && !planProgress(plan).complete
			);
			return {
				id: program.id,
				title: program.title,
				status: program.status,
				loop: {
					supervised: targets.some(
						(target) =>
							target.kind === 'program' && target.programId === program.id && target.enabled
					),
					lastWakeReason: memo[program.id]?.lastWakeReason,
					lastWakeAt: memo[program.id]?.lastWakeAt,
				},
				activePlanId: active?.id,
				activePlanTitle: active?.title,
				openAsks: asks.filter((ask) => ask.status === 'open' && ask.programId === program.id)
					.length,
				running: inFlight.filter((task) => task.programId === program.id).length,
				verifiedLast7d: verified.filter(
					(task) => task.programId === program.id && Date.parse(task.completedAt) >= since
				).length,
			};
		}),
	};
}
