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
import {
	validateAgentProfile,
	type AgentProfile,
} from '../../shared/profiles/types';
import { logger } from '../utils/logger';

const LOG_CONTEXT = 'Profiles';

/** Absolute path to a project's profiles.yaml (may not exist yet). */
function profilesConfigPath(projectRoot: string): string {
	return path.join(projectRoot, PROFILES_CONFIG_PATH);
}

/**
 * Load and validate all profiles for a project. Returns an empty array when the
 * file is missing or unparseable. Malformed individual entries are skipped with
 * a logged warning; valid entries are still returned.
 */
export function loadProfiles(projectRoot: string): AgentProfile[] {
	const filePath = profilesConfigPath(projectRoot);
	let raw: string;
	try {
		raw = fs.readFileSync(filePath, 'utf-8');
	} catch {
		// Missing file is the common case (no profiles yet) - not an error.
		return [];
	}

	let parsed: unknown;
	try {
		parsed = yaml.load(raw);
	} catch (err) {
		logger.warn(
			`Failed to parse ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
			LOG_CONTEXT
		);
		return [];
	}

	if (!parsed || typeof parsed !== 'object') {
		return [];
	}

	const list = (parsed as { profiles?: unknown }).profiles;
	if (!Array.isArray(list)) {
		return [];
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
	fs.writeFileSync(filePath, content, 'utf-8');
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
