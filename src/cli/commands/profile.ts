/**
 * `maestro-cli profile` - manage Agent Profiles (Board Phase 1) from the CLI.
 *
 * A Profile is a named override bundle (model / effort / role / extra args)
 * layered on an existing Left Bar agent, stored per-project in
 * `.maestro/profiles.yaml`. These commands keep parity with the
 * `profiles:list/upsert/delete` IPC surface by delegating straight to the SAME
 * storage module the desktop handlers use (`src/main/profiles/profile-storage`,
 * which is Electron-free), so there is no second implementation to drift.
 *
 * Every command needs a project root. It is resolved from a target agent:
 * `profile create` locates it from the `--base` agent (whose project owns the
 * profile); `profile list` / `profile delete` take `--agent`.
 */

import { generateUUID } from '../../shared/uuid';
import { listProfiles, upsertProfile, deleteProfile } from '../../main/profiles/profile-storage';
import {
	resolveProfileSpawnOverrides,
	type AgentProfile,
	type ProfileBaseAgentValues,
} from '../../shared/profiles/types';
import { getSessionById, resolveAgentId } from '../services/storage';
import { getAgentDisplayName } from '../../shared/agentMetadata';
import { formatError, formatSuccess } from '../output/formatter';
import type { SessionInfo } from '../../shared/types';

interface ProfileCommonOptions {
	json?: boolean;
}

interface ProfileListOptions extends ProfileCommonOptions {
	agent: string;
}

interface ProfileCreateOptions extends ProfileCommonOptions {
	base: string;
	name: string;
	model?: string;
	effort?: string;
	role?: string;
	/** When set, create a base-agent-less role that floats to the worker pool. */
	pool?: boolean;
}

interface ProfileDeleteOptions extends ProfileCommonOptions {
	agent: string;
}

interface ProfileShowOptions extends ProfileCommonOptions {
	agent: string;
}

interface ProfileUpdateOptions extends ProfileCommonOptions {
	/** Agent whose project owns the profile (the profile is edited in place). */
	agent: string;
	name?: string;
	model?: string;
	effort?: string;
	/** Role system-prompt (`--role-prompt`, or `--role` for parity with create). */
	rolePrompt?: string;
	role?: string;
	/** Extra CLI args for spawns wearing this role (`--args`). */
	args?: string;
	/** New base agent to pin to (`--base`). Mutually exclusive with `--pool`. */
	base?: string;
	/** Drop the base agent so the role floats to the free worker pool. */
	pool?: boolean;
}

/** Resolve `--agent`/`--base` (id or name) to a session. Throws on missing/not-found. */
function resolveAgentSession(partial: string | undefined): SessionInfo {
	if (!partial || !partial.trim()) {
		throw new Error('An agent is required (--agent <id-or-name>).');
	}
	const id = resolveAgentId(partial);
	const session = getSessionById(id);
	if (!session) throw new Error(`Agent "${partial}" not found.`);
	return session;
}

/** Print an error (JSON or human-readable) and exit non-zero, once, at the
 * command boundary (matches the repo's try/catch-at-boundary convention). */
function reportError(error: unknown, json: boolean | undefined): never {
	const message = error instanceof Error ? error.message : String(error);
	if (json) {
		console.log(JSON.stringify({ type: 'error', error: message }));
	} else {
		console.error(formatError(message));
	}
	process.exit(1);
}

/** `profile list --agent <id>` - list profiles for the agent's project. */
export async function profileList(options: ProfileListOptions): Promise<void> {
	try {
		const session = resolveAgentSession(options.agent);
		const profiles = listProfiles(session.projectRoot);

		if (options.json) {
			console.log(JSON.stringify(profiles, null, 2));
			return;
		}

		if (profiles.length === 0) {
			console.log('No profiles found.');
			return;
		}

		const lines: string[] = [`Profiles (${profiles.length}):\n`];
		for (const p of profiles) {
			lines.push(`  ${p.name}  [${p.id.slice(0, 8)}]`);
			const bits: string[] = [
				`base: ${p.baseAgentId ? p.baseAgentId.slice(0, 8) : 'pool (any free worker)'}`,
			];
			if (p.model) bits.push(`model: ${p.model}`);
			if (p.effort) bits.push(`effort: ${p.effort}`);
			lines.push(`     ${bits.join('  |  ')}`);
			if (p.appendSystemPrompt) {
				const role = p.appendSystemPrompt.replace(/\s+/g, ' ').trim();
				lines.push(`     role: ${role.length > 80 ? `${role.slice(0, 77)}...` : role}`);
			}
			lines.push('');
		}
		console.log(lines.join('\n'));
	} catch (error) {
		reportError(error, options.json);
	}
}

/**
 * `profile create --base <agentId> --name <n> [--model] [--effort] [--role]`
 * Mints a UUID and upserts into the base agent's project `.maestro/profiles.yaml`.
 */
export async function profileCreate(options: ProfileCreateOptions): Promise<void> {
	try {
		const base = resolveAgentSession(options.base);
		const name = (options.name ?? '').trim();
		if (!name) throw new Error('A profile name is required (--name <name>).');

		const profile: AgentProfile = {
			id: generateUUID(),
			name,
		};
		// `--pool` makes a base-agent-less role that floats to the free worker pool;
		// otherwise the profile pins its overrides to the `--base` agent. Either way
		// `--base` locates the project the profile is stored in.
		if (!options.pool) profile.baseAgentId = base.id;
		if (options.model?.trim()) profile.model = options.model.trim();
		if (options.effort?.trim()) profile.effort = options.effort.trim();
		if (options.role?.trim()) profile.appendSystemPrompt = options.role.trim();

		upsertProfile(base.projectRoot, profile);

		if (options.json) {
			console.log(JSON.stringify(profile, null, 2));
			return;
		}
		const baseName = base.name || getAgentDisplayName(base.toolType);
		console.log(
			formatSuccess(
				`Created profile "${name}" (${profile.id.slice(0, 8)}) on base agent ${baseName}.`
			)
		);
	} catch (error) {
		reportError(error, options.json);
	}
}

/** Find a profile by exact id or id prefix, or throw. */
function locateProfile(projectRoot: string, profileId: string): AgentProfile {
	const profiles = listProfiles(projectRoot);
	const exact = profiles.find((p) => p.id === profileId);
	if (exact) return exact;
	const matches = profiles.filter((p) => p.id.startsWith(profileId));
	if (matches.length === 1) return matches[0];
	if (matches.length > 1) {
		throw new Error(`Profile id "${profileId}" is ambiguous (${matches.length} matches).`);
	}
	throw new Error(`Profile "${profileId}" not found in project.`);
}

/**
 * `profile update <profileId> --agent <id> [--name ...] [--model ...] ...`
 *
 * Edits a profile IN PLACE. The storage layer has always been an upsert; the CLI
 * simply never passed an existing id, so the only way to change a profile was
 * `create`, which minted a fresh UUID and orphaned every board card pointing at
 * the old one. Only the flags actually passed are touched; an explicit empty
 * string (`--model ''`) clears an override so the field falls back to whatever
 * agent runs the role.
 */
export async function profileUpdate(
	profileId: string,
	options: ProfileUpdateOptions
): Promise<void> {
	try {
		const session = resolveAgentSession(options.agent);
		const existing = locateProfile(session.projectRoot, profileId);
		if (options.pool && options.base) {
			throw new Error('--pool and --base are mutually exclusive.');
		}

		const next: AgentProfile = { ...existing };
		let changed = false;

		if (options.name !== undefined) {
			const name = options.name.trim();
			if (!name) throw new Error('--name cannot be empty.');
			next.name = name;
			changed = true;
		}
		const applyOverride = (
			key: 'model' | 'effort' | 'appendSystemPrompt' | 'customArgs',
			raw: string
		) => {
			const value = raw.trim();
			if (value) next[key] = value;
			else delete next[key];
			changed = true;
		};
		if (options.model !== undefined) applyOverride('model', options.model);
		if (options.effort !== undefined) applyOverride('effort', options.effort);
		// `--role-prompt` is the documented spelling; `--role` matches `profile create`.
		const rolePrompt = options.rolePrompt ?? options.role;
		if (rolePrompt !== undefined) applyOverride('appendSystemPrompt', rolePrompt);
		if (options.args !== undefined) applyOverride('customArgs', options.args);
		if (options.pool) {
			delete next.baseAgentId;
			changed = true;
		} else if (options.base !== undefined) {
			next.baseAgentId = resolveAgentSession(options.base).id;
			changed = true;
		}

		if (!changed) {
			throw new Error(
				'Nothing to update. Pass at least one of --name, --model, --effort, ' +
					'--role-prompt, --args, --base, --pool.'
			);
		}

		upsertProfile(session.projectRoot, next);

		if (options.json) {
			console.log(JSON.stringify(next, null, 2));
			return;
		}
		console.log(formatSuccess(`Updated profile "${next.name}" (${next.id.slice(0, 8)}).`));
	} catch (error) {
		reportError(error, options.json);
	}
}

/**
 * `profile show <profileId> --agent <id>` - print a profile and the spawn
 * overrides it actually resolves to once layered on its base agent (a pool role
 * with no base agent resolves to its own values only).
 */
export async function profileShow(profileId: string, options: ProfileShowOptions): Promise<void> {
	try {
		const session = resolveAgentSession(options.agent);
		const profile = locateProfile(session.projectRoot, profileId);

		const base = profile.baseAgentId ? getSessionById(profile.baseAgentId) : undefined;
		const baseValues: ProfileBaseAgentValues | undefined = base
			? {
					customModel: base.customModel,
					customEffort: base.customEffort,
					customArgs: base.customArgs,
					appendSystemPrompt: (base as unknown as { appendSystemPrompt?: string })
						.appendSystemPrompt,
				}
			: undefined;
		const resolved = resolveProfileSpawnOverrides(profile, baseValues);

		if (options.json) {
			console.log(JSON.stringify({ profile, resolved }, null, 2));
			return;
		}

		const lines: string[] = [`${profile.name}  [${profile.id}]`];
		lines.push(
			`  base: ${
				profile.baseAgentId
					? `${base?.name ?? profile.baseAgentId}${base ? '' : ' (agent not found)'}`
					: 'pool (any free worker)'
			}`
		);
		lines.push('');
		lines.push('  Resolved spawn overrides (profile value, else base agent):');
		lines.push(`    model:  ${resolved.customModel ?? '(agent default)'}`);
		lines.push(`    effort: ${resolved.customEffort ?? '(agent default)'}`);
		lines.push(`    args:   ${resolved.customArgs ?? '(agent default)'}`);
		if (resolved.appendSystemPrompt) {
			lines.push('');
			lines.push('  Role prompt:');
			for (const line of resolved.appendSystemPrompt.split('\n')) lines.push(`    ${line}`);
		}
		console.log(lines.join('\n'));
	} catch (error) {
		reportError(error, options.json);
	}
}

/** `profile delete <profileId> --agent <id>` - remove a profile by id. */
export async function profileDelete(
	profileId: string,
	options: ProfileDeleteOptions
): Promise<void> {
	try {
		const session = resolveAgentSession(options.agent);
		const target = locateProfile(session.projectRoot, profileId);
		const after = deleteProfile(session.projectRoot, target.id);

		if (options.json) {
			console.log(JSON.stringify({ deleted: target.id, remaining: after.length }, null, 2));
			return;
		}
		console.log(formatSuccess(`Deleted profile "${target.name}" (${target.id.slice(0, 8)}).`));
	} catch (error) {
		reportError(error, options.json);
	}
}
