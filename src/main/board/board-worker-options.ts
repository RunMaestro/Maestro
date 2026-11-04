import type Database from 'better-sqlite3';
import { readBoardWorkerOptions } from '../../shared/board/worker-options';
import {
	resolveProfileSpawnOverrides,
	validateAgentProfile,
	type ProfileBaseAgentValues,
} from '../../shared/profiles/types';
import { listBoardWorkers } from './board-workspace-storage';

/** Resolve only an explicit card reference. Role grants never choose a default profile. */
export function resolveBoardWorkerExecution(
	db: Database.Database,
	agentId: string,
	card: Record<string, unknown>,
	baseValues: ProfileBaseAgentValues = {}
) {
	const worker = listBoardWorkers(db).find((entry) => entry.agentId === agentId);
	if (
		!worker ||
		!readBoardWorkerOptions(
			Object.fromEntries(Object.entries(baseValues).filter(([, value]) => value !== undefined))
		)
	)
		return null;
	const local = readBoardWorkerOptions(
		Object.prototype.hasOwnProperty.call(worker.payload, 'executionOptions')
			? worker.payload.executionOptions
			: {}
	);
	if (!local) return null;
	const legacy = card.assigneeProfileId
		? { namespace: card.profileNamespace, profileId: card.assigneeProfileId }
		: undefined;
	const role = card.role as { namespace: string; profileId: string } | undefined;
	if (
		role &&
		legacy &&
		(role.profileId !== legacy.profileId ||
			(legacy.namespace !== undefined && role.namespace !== legacy.namespace))
	)
		return null;
	const ref = role ?? legacy;
	let inherited;
	if (ref) {
		if (typeof ref.namespace !== 'string' || typeof ref.profileId !== 'string') return null;
		const row = db
			.prepare(
				'SELECT payload_json, source_key FROM profiles WHERE profile_namespace = ? AND id = ?'
			)
			.get(ref.namespace, ref.profileId) as
			| { payload_json: string; source_key: string }
			| undefined;
		if (!row) return null;
		const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
		const profile = validateAgentProfile(payload);
		if (
			!profile ||
			profile.id !== ref.profileId ||
			(profile.baseAgentId && profile.baseAgentId !== agentId)
		)
			return null;
		inherited = { ...ref, sourceKey: row.source_key, payload, profile };
	}
	return {
		profile: inherited?.payload,
		overrides: {
			...(inherited ? resolveProfileSpawnOverrides(inherited.profile, baseValues) : baseValues),
			...local,
		},
		provenance: {
			worker,
			baseValues,
			legacyProfile: inherited,
			cardReferences: {
				role: card.role,
				assigneeProfileId: card.assigneeProfileId,
				profileNamespace: card.profileNamespace,
			},
			precedence: 'worker > explicit-card-profile > agent' as const,
		},
	};
}
