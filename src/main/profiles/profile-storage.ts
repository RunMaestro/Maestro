/**
 * Agent Profiles storage - single owner of `.maestro/profiles.yaml`.
 *
 * Mirrors the Cue config repository convention (`.maestro/cue.yaml`): all
 * filesystem reads/writes for the profiles file flow through this module so
 * path resolution and directory creation live in exactly one place. Uses the
 * shared `js-yaml` helper rather than adding a new dependency.
 *
 * The file format is a single top-level `profiles:` list:
 *
 *   profiles:
 *     - id: 8f3c…
 *       name: Reviewer
 *       baseAgentId: agent-1
 *       model: sonnet
 *       effort: high
 *       appendSystemPrompt: Be adversarial.
 *
 * Load validates each entry via `validateAgentProfile` and skips malformed ones
 * with a logged warning, so one bad entry never blocks the rest.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { MAESTRO_DIR, PROFILES_CONFIG_PATH } from '../../shared/maestro-paths';
import { validateAgentProfile, type AgentProfile } from '../../shared/profiles/types';
import { logger } from '../utils/logger';
import { atomicWriteFileSync, createKeyedWriteQueue } from '../utils/atomic-json-store';

const LOG_CONTEXT = 'Profiles';

/** Absolute path to a project's profiles.yaml (may not exist yet). */
function profilesConfigPath(projectRoot: string): string {
	return path.join(projectRoot, PROFILES_CONFIG_PATH);
}

/**
 * Thrown when profiles.yaml exists but cannot be read or parsed. Mirrors
 * `BoardStorageError`: a missing file is normal and returns `[]`, but a damaged
 * one must fail closed. Returning `[]` here would let the next `saveProfiles`
 * overwrite the file with an empty list and destroy every profile - and because
 * cards resolve their overrides by profile id, it would silently force-block
 * every board card at the same time.
 */
export class ProfileStorageError extends Error {
	readonly filePath: string;

	constructor(filePath: string, cause: unknown) {
		const detail = cause instanceof Error ? cause.message : String(cause);
		super(`Failed to read profiles file ${filePath}: ${detail}`);
		this.name = 'ProfileStorageError';
		this.filePath = filePath;
	}
}

/**
 * Per-file write chain for profiles.yaml, keyed by the absolute file path.
 * Same rationale as the board's queue: the mutations below are synchronous and
 * cannot interleave within a tick, but an async caller doing read -> await ->
 * write can, and would silently drop the other writer's update.
 */
const profileWriteQueue = createKeyedWriteQueue();

/**
 * Run `work` serialized against every other queued mutation for this project's
 * profiles.yaml. Required for callers that read-modify-write across an `await`.
 */
export function enqueueProfileWrite<T>(
	projectRoot: string,
	work: () => T | Promise<T>
): Promise<T> {
	return profileWriteQueue.enqueue(profilesConfigPath(projectRoot), async () => work());
}

/**
 * Notified after every successful profiles.yaml write, with the profiles that
 * were just persisted.
 */
export type ProfilesSavedListener = (projectRoot: string, profiles: AgentProfile[]) => void;

let profilesSavedListener: ProfilesSavedListener | null = null;

/**
 * Register (or clear, with `null`) the post-save hook. Same split as the board's
 * listener: this module is imported by the CLI too, which has no `webContents`,
 * so the broadcast itself lives in the host (`src/main/index.ts` sends
 * `profiles:changed`) and storage only announces that a write happened.
 */
export function setProfilesSavedListener(listener: ProfilesSavedListener | null): void {
	profilesSavedListener = listener;
}

/**
 * Load and validate all profiles for a project.
 *
 * Same three-way split as `loadBoards`: a missing file returns `[]`, a read or
 * parse failure throws {@link ProfileStorageError} so no mutation path can
 * overwrite a damaged file, and a valid file loads with individual malformed
 * entries skipped and logged.
 */
export function loadProfiles(projectRoot: string): AgentProfile[] {
	const filePath = profilesConfigPath(projectRoot);
	let raw: string;
	try {
		raw = fs.readFileSync(filePath, 'utf-8');
	} catch (err) {
		// Missing file is the common case (no profiles yet) - not an error.
		if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
			return [];
		}
		throw new ProfileStorageError(filePath, err);
	}

	let parsed: unknown;
	try {
		parsed = yaml.load(raw);
	} catch (err) {
		logger.warn(
			`Failed to parse ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
			LOG_CONTEXT
		);
		throw new ProfileStorageError(filePath, err);
	}

	// An empty file legitimately means "no profiles yet".
	if (parsed === null || parsed === undefined) {
		return [];
	}
	if (typeof parsed !== 'object') {
		throw new ProfileStorageError(filePath, new Error('expected a mapping at the top level'));
	}

	const list = (parsed as { profiles?: unknown }).profiles;
	if (list === undefined || list === null) {
		return [];
	}
	if (!Array.isArray(list)) {
		throw new ProfileStorageError(filePath, new Error('`profiles` is present but is not a list'));
	}

	const profiles: AgentProfile[] = [];
	const seenIds = new Set<string>();
	for (const entry of list) {
		const profile = validateAgentProfile(entry);
		if (!profile) {
			logger.warn(`Skipping malformed profile entry in ${filePath}`, LOG_CONTEXT);
			continue;
		}
		if (seenIds.has(profile.id)) {
			logger.warn(`Skipping duplicate profile id "${profile.id}" in ${filePath}`, LOG_CONTEXT);
			continue;
		}
		seenIds.add(profile.id);
		profiles.push(profile);
	}
	return profiles;
}

/** Alias for {@link loadProfiles} - the public "list" verb used by IPC callers. */
export function listProfiles(projectRoot: string): AgentProfile[] {
	return loadProfiles(projectRoot);
}

/**
 * Persist the given profiles to a project's `.maestro/profiles.yaml`, creating
 * `.maestro/` if needed. Invalid entries are dropped before writing so the file
 * on disk always round-trips cleanly. Returns the absolute path written.
 */
export function saveProfiles(projectRoot: string, profiles: AgentProfile[]): string {
	const maestroDir = path.join(projectRoot, MAESTRO_DIR);
	if (!fs.existsSync(maestroDir)) {
		fs.mkdirSync(maestroDir, { recursive: true });
	}
	const filePath = profilesConfigPath(projectRoot);
	const valid = profiles
		.map((p) => validateAgentProfile(p))
		.filter((p): p is AgentProfile => p !== null);
	const content = yaml.dump({ profiles: valid }, { lineWidth: -1 });
	// Atomic (temp file + rename): a crash mid-write leaves the previous
	// profiles.yaml intact instead of a truncated file that would load as empty.
	atomicWriteFileSync(filePath, content);
	// Announce the write so the host can push `profiles:changed` to open windows.
	// Advisory only: a listener that throws must never fail the write that already
	// landed on disk.
	if (profilesSavedListener) {
		try {
			profilesSavedListener(projectRoot, valid);
		} catch (err) {
			logger.warn(
				`Profiles saved listener threw: ${err instanceof Error ? err.message : String(err)}`,
				LOG_CONTEXT
			);
		}
	}
	return filePath;
}

/**
 * Insert a new profile or replace an existing one with the same id. Validates
 * the profile and throws if it is malformed (IPC callers surface the error).
 * Returns the full updated list.
 */
export function upsertProfile(projectRoot: string, profile: AgentProfile): AgentProfile[] {
	const validated = validateAgentProfile(profile);
	if (!validated) {
		throw new Error('upsertProfile: invalid profile shape');
	}
	const existing = loadProfiles(projectRoot);
	const index = existing.findIndex((p) => p.id === validated.id);
	if (index >= 0) {
		existing[index] = validated;
	} else {
		existing.push(validated);
	}
	saveProfiles(projectRoot, existing);
	return existing;
}

/**
 * Delete the profile with the given id. Returns the updated list. A no-op (and
 * no write) when no profile matches.
 */
export function deleteProfile(projectRoot: string, profileId: string): AgentProfile[] {
	const existing = loadProfiles(projectRoot);
	const filtered = existing.filter((p) => p.id !== profileId);
	if (filtered.length !== existing.length) {
		saveProfiles(projectRoot, filtered);
	}
	return filtered;
}
