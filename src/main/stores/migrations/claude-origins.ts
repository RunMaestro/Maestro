import * as fs from 'fs';

import type Store from 'electron-store';
import { parseJsonWithBom } from '../../../shared/jsonUtils';

import type {
	AgentSessionOriginInfo,
	AgentSessionOriginsData,
	ClaudeSessionOriginsData,
} from '../types';

/** Target schema version for the agent-keyed Claude origins cutover. */
export const CLAUDE_ORIGINS_SCHEMA_VERSION = 2;
/** Persisted only after the legacy bytes and target data have both validated. */
export const CLAUDE_ORIGINS_MIGRATION_MARKER = 'claudeOriginsV1';
export const CLAUDE_ORIGINS_AGENT_ID = 'claude-code';
const BACKUP_SUFFIX = '.claude-origins-v1.bak';

type ClaudeProjectOrigins = Record<string, Record<string, AgentSessionOriginInfo>>;

export interface ClaudeOriginsMigrationResult {
	status:
		| 'migrated'
		| 'already-current'
		| 'no-legacy-source'
		| 'invalid-legacy'
		| 'invalid-target'
		| 'backup-failed';
	backupPath?: string;
}

export interface ClaudeOriginsMigrationOptions {
	legacyStore: Store<ClaudeSessionOriginsData>;
	targetStore: Store<AgentSessionOriginsData>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeOrigin(value: unknown): AgentSessionOriginInfo | null {
	if (value === 'user' || value === 'auto') {
		return { origin: value };
	}
	if (!isRecord(value)) return null;

	const normalized: AgentSessionOriginInfo = {};
	if (value.origin === 'user' || value.origin === 'auto') {
		normalized.origin = value.origin;
	}
	if (typeof value.sessionName === 'string') {
		normalized.sessionName = value.sessionName;
	}
	if (typeof value.starred === 'boolean') {
		normalized.starred = value.starred;
	}
	if (typeof value.contextUsage === 'number' && Number.isFinite(value.contextUsage)) {
		normalized.contextUsage = value.contextUsage;
	}
	return Object.keys(normalized).length > 0 ? normalized : null;
}

/**
 * Legacy schema: `{ origins: { [projectPath]: { [sessionId]: 'user' | info } } }`.
 * Stale project paths are data, not filesystem inputs, so they survive untouched.
 */
function normalizeLegacyOrigins(value: unknown): ClaudeProjectOrigins | null {
	if (!isRecord(value) || !isRecord(value.origins)) return null;
	const normalized: ClaudeProjectOrigins = {};
	for (const [projectPath, sessions] of Object.entries(value.origins)) {
		if (!isRecord(sessions)) continue;
		const project: Record<string, AgentSessionOriginInfo> = {};
		for (const [sessionId, origin] of Object.entries(sessions)) {
			const info = normalizeOrigin(origin);
			if (info) project[sessionId] = info;
		}
		if (Object.keys(project).length > 0) normalized[projectPath] = project;
	}
	return normalized;
}

/**
 * Target schema: `{ schemaVersion: 2, origins: { 'claude-code': { [projectPath]:
 * { [sessionId]: info } } } }`. The validator deliberately rejects a malformed
 * target rather than risking unrelated providers when the migration writes.
 */
function normalizeTargetOrigins(value: unknown): Record<string, ClaudeProjectOrigins> | null {
	if (!isRecord(value)) return null;
	const normalized: Record<string, ClaudeProjectOrigins> = {};
	for (const [agentId, projects] of Object.entries(value)) {
		if (!isRecord(projects)) return null;
		const agentProjects: ClaudeProjectOrigins = {};
		for (const [projectPath, sessions] of Object.entries(projects)) {
			if (!isRecord(sessions)) return null;
			const project: Record<string, AgentSessionOriginInfo> = {};
			for (const [sessionId, origin] of Object.entries(sessions)) {
				const info = normalizeOrigin(origin);
				if (!info) return null;
				project[sessionId] = info;
			}
			agentProjects[projectPath] = project;
		}
		normalized[agentId] = agentProjects;
	}
	return normalized;
}

function mergeClaudeOrigins(
	legacy: ClaudeProjectOrigins,
	target: ClaudeProjectOrigins
): ClaudeProjectOrigins {
	const merged: ClaudeProjectOrigins = {};
	for (const projectPath of new Set([...Object.keys(legacy), ...Object.keys(target)])) {
		const sessions: Record<string, AgentSessionOriginInfo> = {};
		const legacyProject = legacy[projectPath] ?? {};
		const targetProject = target[projectPath] ?? {};
		for (const sessionId of new Set([
			...Object.keys(legacyProject),
			...Object.keys(targetProject),
		])) {
			const origin = { ...legacyProject[sessionId], ...targetProject[sessionId] };
			if (Object.keys(origin).length > 0) sessions[sessionId] = origin;
		}
		if (Object.keys(sessions).length > 0) merged[projectPath] = sessions;
	}
	return merged;
}

function backupLegacyBytes(legacyPath: string): string | null {
	const backupPath = `${legacyPath}${BACKUP_SUFFIX}`;
	try {
		if (!fs.existsSync(backupPath))
			fs.copyFileSync(legacyPath, backupPath, fs.constants.COPYFILE_EXCL);
		return backupPath;
	} catch {
		return null;
	}
}

/**
 * Converts the old Claude-only file into the agent-keyed target file. The old
 * file is never mutated in this stage; its exact original bytes are copied
 * before the target's single atomic `store` write. Re-running after a crash
 * merges the target over legacy fields and only then marks the cutover current.
 */
export function migrateClaudeOriginsStore({
	legacyStore,
	targetStore,
}: ClaudeOriginsMigrationOptions): ClaudeOriginsMigrationResult {
	const marker = targetStore.get('migrationMarkers')?.[CLAUDE_ORIGINS_MIGRATION_MARKER];
	if (marker === true && targetStore.get('schemaVersion') === CLAUDE_ORIGINS_SCHEMA_VERSION) {
		return { status: 'already-current' };
	}

	const targetOrigins = targetStore.get('origins', {});
	const normalizedTarget = normalizeTargetOrigins(targetOrigins);
	if (!normalizedTarget) return { status: 'invalid-target' };

	const legacyPath = legacyStore.path;
	if (!fs.existsSync(legacyPath)) return { status: 'no-legacy-source' };

	let parsedLegacy: unknown;
	try {
		parsedLegacy = parseJsonWithBom(fs.readFileSync(legacyPath, 'utf8'));
	} catch {
		return { status: 'invalid-legacy' };
	}
	const normalizedLegacy = normalizeLegacyOrigins(parsedLegacy);
	if (!normalizedLegacy) return { status: 'invalid-legacy' };

	const backupPath = backupLegacyBytes(legacyPath);
	if (!backupPath) return { status: 'backup-failed' };

	const mergedClaudeOrigins = mergeClaudeOrigins(
		normalizedLegacy,
		normalizedTarget[CLAUDE_ORIGINS_AGENT_ID] ?? {}
	);
	// electron-store persists assigning `store` atomically, so no target state is
	// visible until the validated conversion, version, and marker move together.
	targetStore.store = {
		...targetStore.store,
		origins: {
			...targetOrigins,
			[CLAUDE_ORIGINS_AGENT_ID]: mergedClaudeOrigins,
		},
		schemaVersion: CLAUDE_ORIGINS_SCHEMA_VERSION,
		migrationMarkers: {
			...targetStore.get('migrationMarkers', {}),
			[CLAUDE_ORIGINS_MIGRATION_MARKER]: true,
		},
	};
	return { status: 'migrated', backupPath };
}

/**
 * Reads both schemas while legacy readers coexist. Target values win per field,
 * which makes duplicate identities deterministic without discarding a legacy
 * field that has not yet been written by the generic API.
 */
export function readClaudeOrigins(
	targetStore: Store<AgentSessionOriginsData>,
	legacyStore: Store<ClaudeSessionOriginsData>
): ClaudeProjectOrigins {
	const target =
		normalizeTargetOrigins(targetStore.get('origins', {}))?.[CLAUDE_ORIGINS_AGENT_ID] ?? {};
	const legacy = normalizeLegacyOrigins({ origins: legacyStore.get('origins', {}) }) ?? {};
	return mergeClaudeOrigins(legacy, target);
}

/** Writes only the target schema after startup migration has validated the old data. */
export function writeClaudeOrigins(
	targetStore: Store<AgentSessionOriginsData>,
	origins: ClaudeProjectOrigins
): void {
	const targetOrigins = targetStore.get('origins', {});
	if (!normalizeTargetOrigins(targetOrigins)) {
		throw new Error('Cannot write Claude origins: target origins schema is malformed');
	}
	targetStore.set('origins', { ...targetOrigins, [CLAUDE_ORIGINS_AGENT_ID]: origins });
}

export type { ClaudeProjectOrigins };
