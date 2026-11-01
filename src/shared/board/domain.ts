/** Pure global Board capture rules. Registry snapshots are supplied by the host. */
import { isAbsolutePath } from '../formatters';
import type { AgentProfile } from '../profiles/types';
import type { BoardCaptureOptions, BoardRoleRef, BoardStartMode } from './types';

export interface BoardCaptureContext {
	agents: readonly { id: string; groupId?: string | null }[];
	groups: readonly { id: string }[];
	profiles: readonly { namespace: string; profile: AgentProfile }[];
	defaultStartMode: BoardStartMode;
	/** True only for a host-verified human policy action. */
	canRelaxStartPolicy: boolean;
}

export type BoardCaptureError =
	| 'invalid-options'
	| 'invalid-scope'
	| 'invalid-pin'
	| 'invalid-role'
	| 'pin-outside-scope'
	| 'pin-role-conflict'
	| 'invalid-repository'
	| 'invalid-repository-path'
	| 'invalid-start-mode'
	| 'unauthorized-start-mode'
	| 'invalid-kind';

export type BoardCaptureResult =
	| { ok: true; options: BoardCaptureOptions; effectiveStartMode: BoardStartMode }
	| { ok: false; errors: BoardCaptureError[] };

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonBlank(value: unknown): value is string {
	return typeof value === 'string' && value.trim().length > 0 && !value.includes('\0');
}

/** Migration preserves explicit nulls for unresolved bindings. For validation
 * only, treat an unchanged stored null as missing; public capture still rejects
 * new null input and persistence keeps the original bytes. */
export function persistedCaptureInput(
	input: BoardCaptureOptions,
	stored: Record<string, unknown>
): BoardCaptureOptions {
	const result = { ...input } as Record<string, unknown>;
	for (const field of ['executionScope', 'profileNamespace', 'repositoryId', 'workingDirectory']) {
		if (stored[field] === null && result[field] === null) delete result[field];
	}
	return result;
}

/** Reject malformed or contradictory input while retaining missing/deleted references for repair. */
export function validateCapture(raw: unknown, context: BoardCaptureContext): BoardCaptureResult {
	if (!record(raw)) return { ok: false, errors: ['invalid-options'] };
	const errors: BoardCaptureError[] = [];

	const options: BoardCaptureOptions = { ...raw };
	if (raw.profileNamespace !== undefined && raw.role === undefined) {
		if (nonBlank(raw.profileNamespace) && nonBlank(raw.assigneeProfileId))
			options.role = { namespace: raw.profileNamespace, profileId: raw.assigneeProfileId };
		else errors.push('invalid-role');
	} else if (
		raw.role !== undefined &&
		((raw.assigneeProfileId !== undefined &&
			(!record(raw.role) || raw.assigneeProfileId !== raw.role.profileId)) ||
			(raw.profileNamespace !== undefined &&
				(!record(raw.role) || raw.profileNamespace !== raw.role.namespace)))
	)
		errors.push('invalid-role');

	if (raw.kind !== undefined) {
		if (
			raw.kind === 'work' ||
			raw.kind === 'review' ||
			raw.kind === 'test' ||
			raw.kind === 'documentation'
		)
			options.kind = raw.kind;
		else errors.push('invalid-kind');
	}
	if (raw.executionScope !== undefined) {
		const scope = raw.executionScope;
		if (
			record(scope) &&
			scope.kind === 'agent' &&
			nonBlank(scope.agentId) &&
			!('groupId' in scope)
		) {
			options.executionScope = { ...scope, kind: 'agent', agentId: scope.agentId };
		} else if (
			record(scope) &&
			scope.kind === 'group' &&
			nonBlank(scope.groupId) &&
			!('agentId' in scope)
		) {
			options.executionScope = { ...scope, kind: 'group', groupId: scope.groupId };
		} else errors.push('invalid-scope');
	}
	if (raw.assigneeAgentId !== undefined) {
		if (nonBlank(raw.assigneeAgentId)) options.assigneeAgentId = raw.assigneeAgentId;
		else errors.push('invalid-pin');
	}
	if (raw.role !== undefined) {
		if (record(raw.role) && nonBlank(raw.role.namespace) && nonBlank(raw.role.profileId)) {
			options.role = { ...raw.role, namespace: raw.role.namespace, profileId: raw.role.profileId };
		} else errors.push('invalid-role');
	}
	if (raw.repositoryId !== undefined) {
		if (nonBlank(raw.repositoryId)) options.repositoryId = raw.repositoryId;
		else errors.push('invalid-repository');
	}
	if (raw.workingDirectory !== undefined) {
		if (nonBlank(raw.workingDirectory) && isAbsolutePath(raw.workingDirectory))
			options.workingDirectory = raw.workingDirectory;
		else errors.push('invalid-repository-path');
	}
	if (raw.startModeOverride !== undefined) {
		if (raw.startModeOverride === 'approval' || raw.startModeOverride === 'direct')
			options.startModeOverride = raw.startModeOverride;
		else errors.push('invalid-start-mode');
	}
	if (
		options.startModeOverride === 'direct' &&
		context.defaultStartMode === 'approval' &&
		!context.canRelaxStartPolicy
	)
		errors.push('unauthorized-start-mode');

	const profile = options.role && findProfile(options.role, context);
	const pin = options.assigneeAgentId;
	if (pin && profile?.baseAgentId && pin !== profile.baseAgentId) errors.push('pin-role-conflict');
	const scope = options.executionScope;
	for (const candidate of new Set([pin, profile?.baseAgentId].filter((id): id is string => !!id))) {
		if (scope?.kind === 'agent' && candidate !== scope.agentId) {
			if (!errors.includes('pin-outside-scope')) errors.push('pin-outside-scope');
		} else if (
			scope?.kind === 'group' &&
			context.groups.some((group) => group.id === scope.groupId)
		) {
			const agent = context.agents.find((entry) => entry.id === candidate);
			if (agent && agent.groupId !== scope.groupId && !errors.includes('pin-outside-scope'))
				errors.push('pin-outside-scope');
		}
	}
	return errors.length
		? { ok: false, errors }
		: {
				ok: true,
				options,
				effectiveStartMode: options.startModeOverride ?? context.defaultStartMode,
			};
}

function findProfile(role: BoardRoleRef, context: BoardCaptureContext): AgentProfile | undefined {
	return context.profiles.find(
		(entry) => entry.namespace === role.namespace && entry.profile.id === role.profileId
	)?.profile;
}

export type BoardCaptureWaitReason =
	| 'review-artifact-unresolved'
	| 'scope-conflict'
	| 'missing-scope'
	| 'target-missing'
	| 'group-missing'
	| 'role-missing'
	| 'repository-unresolved'
	| 'repository-unknown';

/** Capture readiness only; dispatch must additionally check membership, workers and all runtime gates. */
export function evaluateCaptureReadiness(
	options: BoardCaptureOptions,
	context: BoardCaptureContext & { repositoryIds: readonly string[] }
): BoardCaptureWaitReason[] {
	const reasons: BoardCaptureWaitReason[] = [];
	const validation = validateCapture(options, { ...context, canRelaxStartPolicy: true });
	if (!validation.ok) reasons.push('scope-conflict');
	else options = validation.options;
	const scope = options.executionScope;
	if (!scope) reasons.push('missing-scope');
	else if (scope.kind === 'agent' && !context.agents.some((agent) => agent.id === scope.agentId))
		reasons.push('target-missing');
	else if (scope.kind === 'group' && !context.groups.some((group) => group.id === scope.groupId))
		reasons.push('group-missing');
	if (
		options.assigneeAgentId &&
		!context.agents.some((agent) => agent.id === options.assigneeAgentId) &&
		!reasons.includes('target-missing')
	)
		reasons.push('target-missing');
	if (
		(options.role && !findProfile(options.role, context)) ||
		(!options.role &&
			(options as BoardCaptureOptions & { assigneeProfileId?: string }).assigneeProfileId)
	)
		reasons.push('role-missing');
	const rolePin = options.role && findProfile(options.role, context)?.baseAgentId;
	if (
		rolePin &&
		!context.agents.some((agent) => agent.id === rolePin) &&
		!reasons.includes('target-missing')
	)
		reasons.push('target-missing');
	if (
		!options.repositoryId ||
		!options.workingDirectory ||
		!context.repositoryIds.includes(options.repositoryId)
	)
		reasons.push('repository-unresolved');
	return reasons;
}

export type BoardWorkerWaitReason =
	| BoardCaptureWaitReason
	| 'worker-outside-scope'
	| 'worker-unregistered'
	| 'worker-disabled'
	| 'worker-paused'
	| 'worker-role-mismatch'
	| 'worker-repository-mismatch';

/** A read-only host observation; only Cue can turn it into a fenced claim. */
export type BoardReadinessReason =
	| BoardWorkerWaitReason
	| 'emptyEligibleWorkers'
	| 'approval-required'
	| 'held'
	| 'worker-busy'
	| 'worker-dormant'
	| 'worker-location-mismatch'
	| 'occupancy-unknown'
	| 'runtime-unknown'
	| 'runtime-unavailable'
	| 'awaiting-cue';

/** Recheck the selected worker against CURRENT membership and Board-owned access.
 * A failed pin/role/scope never substitutes another worker. Runtime availability
 * and durable reservation checks belong to the host transaction. */
export function evaluateClaimWorker(
	options: BoardCaptureOptions,
	workerAgentId: string,
	context: BoardCaptureContext & {
		repositoryIds: readonly string[];
		workers: readonly {
			agentId: string;
			enabled: boolean;
			paused: boolean;
			roleRefs: readonly BoardRoleRef[];
			allowedRepositoryIds: readonly string[];
		}[];
	}
): BoardWorkerWaitReason | null {
	const reason = evaluateCaptureReadiness(options, context)[0];
	if (reason) return reason;
	const normalized = validateCapture(options, { ...context, canRelaxStartPolicy: true });
	if (!normalized.ok) return 'scope-conflict';
	options = normalized.options;
	const agent = context.agents.find((entry) => entry.id === workerAgentId);
	if (!agent) return 'target-missing';
	const scope = options.executionScope!;
	const rolePin = options.role && findProfile(options.role, context)?.baseAgentId;
	if (
		(scope.kind === 'agent' && scope.agentId !== workerAgentId) ||
		(scope.kind === 'group' && agent.groupId !== scope.groupId) ||
		(options.assigneeAgentId && options.assigneeAgentId !== workerAgentId) ||
		(rolePin && rolePin !== workerAgentId)
	)
		return 'worker-outside-scope';
	const worker = context.workers.find((entry) => entry.agentId === workerAgentId);
	if (!worker) return 'worker-unregistered';
	if (!worker.enabled) return 'worker-disabled';
	if (worker.paused) return 'worker-paused';
	if (
		options.role &&
		!worker.roleRefs.some(
			(role) =>
				role?.namespace === options.role!.namespace && role.profileId === options.role!.profileId
		)
	)
		return 'worker-role-mismatch';
	if (!worker.allowedRepositoryIds.includes(options.repositoryId!))
		return 'worker-repository-mismatch';
	return null;
}
