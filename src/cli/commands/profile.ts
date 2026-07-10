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
import {
	listProfiles,
	upsertProfile,
	deleteProfile,
} from '../../main/profiles/profile-storage';
import { type AgentProfile } from '../../shared/profiles/types';
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
}

interface ProfileDeleteOptions extends ProfileCommonOptions {
	agent: string;
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
			const bits: string[] = [`base: ${p.baseAgentId.slice(0, 8)}`];
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
			baseAgentId: base.id,
		};
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

/** `profile delete <profileId> --agent <id>` - remove a profile by id. */
export async function profileDelete(profileId: string, options: ProfileDeleteOptions): Promise<void> {
	try {
		const session = resolveAgentSession(options.agent);
		const before = listProfiles(session.projectRoot);
		const target = before.find((p) => p.id === profileId || p.id.startsWith(profileId));
		if (!target) throw new Error(`Profile "${profileId}" not found in project.`);
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
