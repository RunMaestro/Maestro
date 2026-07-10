/**
 * Agent Profiles - shared contracts.
 *
 * A Profile is a named bundle layered on an existing Left Bar agent (the "base
 * agent"). It overrides only the model, reasoning effort, role system-prompt,
 * and optionally extra CLI args - same binary, cwd, customPath, customEnvVars,
 * and SSH config as the base agent. Profiles are the "assignee" primitive the
 * Board (later phases) wires cards to, and are independently useful.
 *
 * ── Spawn override resolution order (profile wins, else base agent) ──────────
 * The spawn path already accepts `customModel`, `customEffort`,
 * `appendSystemPrompt`, and `customArgs` via `SpawnAgentOptions`
 * (src/cli/services/agent-spawner.ts) and the desktop `process:spawn` handler.
 * Profiles invent NO new spawn parameters - they only supply those values.
 * `resolveProfileSpawnOverrides` merges a profile onto its base agent so that
 * each field resolves as: profile override → base agent value → undefined.
 * The result is fed straight into the existing spawn override fields.
 *
 * This module is pure and framework-free (no Electron/React imports) so it can
 * run in main, renderer, and CLI alike.
 */

/**
 * A named override bundle attached to a real base agent by id.
 *
 * Only `id`, `name`, and `baseAgentId` are required. Every override field is
 * optional; an undefined field falls back to the base agent's value at spawn
 * time (see {@link resolveProfileSpawnOverrides}).
 */
export interface AgentProfile {
	/** Stable unique id (UUID). */
	id: string;
	/** Human-facing label shown in the Profiles UI and (later) the Board. */
	name: string;
	/** Id of the real Left Bar agent this profile layers onto. */
	baseAgentId: string;
	/** Model override (e.g. a Claude model id). Falls back to the base agent's model. */
	model?: string;
	/** Reasoning effort override. Falls back to the base agent's effort. */
	effort?: string;
	/** Role system-prompt appended to the agent's system prompt. */
	appendSystemPrompt?: string;
	/** Extra CLI args (space-separated, shell-quote aware). Falls back to the base agent's. */
	customArgs?: string;
}

/**
 * The subset of a base agent's values a profile can fall back to. Kept narrow
 * and structural so callers can pass a full Session/agent object without this
 * shared module importing renderer/main types.
 */
export interface ProfileBaseAgentValues {
	customModel?: string;
	customEffort?: string;
	customArgs?: string;
	/** The base agent's role/system-prompt append, if any. */
	appendSystemPrompt?: string;
}

/**
 * The merged spawn overrides a profile contributes. These map 1:1 onto the
 * existing `SpawnAgentOptions` / `process:spawn` fields - no new params.
 */
export interface ProfileSpawnOverrides {
	customModel?: string;
	customEffort?: string;
	appendSystemPrompt?: string;
	customArgs?: string;
}

/**
 * Merge a profile onto its base agent, producing the spawn overrides. Each
 * field resolves as: profile value → base agent value → undefined. Pure.
 *
 * `baseAgent` may be undefined/null when the base agent can't be resolved; the
 * profile's own values are used with no fallback in that case.
 */
export function resolveProfileSpawnOverrides(
	profile: AgentProfile,
	baseAgent?: ProfileBaseAgentValues | null
): ProfileSpawnOverrides {
	return {
		customModel: profile.model ?? baseAgent?.customModel,
		customEffort: profile.effort ?? baseAgent?.customEffort,
		appendSystemPrompt: profile.appendSystemPrompt ?? baseAgent?.appendSystemPrompt,
		customArgs: profile.customArgs ?? baseAgent?.customArgs,
	};
}

/**
 * Validate an untrusted object as an {@link AgentProfile}. Returns a normalized
 * profile on success, or `null` when the shape is malformed. Used by the YAML
 * storage layer to skip bad entries without throwing (defense in depth), and by
 * IPC handlers before persisting caller input.
 *
 * Rules: `id`, `name`, `baseAgentId` must be non-empty strings. Optional
 * override fields, when present, must be strings (empty/whitespace is dropped so
 * an accidentally-blank field falls back to the base agent rather than blanking
 * it).
 */
export function validateAgentProfile(raw: unknown): AgentProfile | null {
	if (!raw || typeof raw !== 'object') return null;
	const r = raw as Record<string, unknown>;

	const id = typeof r.id === 'string' ? r.id.trim() : '';
	const name = typeof r.name === 'string' ? r.name.trim() : '';
	const baseAgentId = typeof r.baseAgentId === 'string' ? r.baseAgentId.trim() : '';
	if (!id || !name || !baseAgentId) return null;

	const profile: AgentProfile = { id, name, baseAgentId };

	const optionalString = (value: unknown): string | undefined => {
		if (typeof value !== 'string') return undefined;
		const trimmed = value.trim();
		return trimmed.length > 0 ? value : undefined;
	};

	const model = optionalString(r.model);
	if (model !== undefined) profile.model = model;
	const effort = optionalString(r.effort);
	if (effort !== undefined) profile.effort = effort;
	const appendSystemPrompt = optionalString(r.appendSystemPrompt);
	if (appendSystemPrompt !== undefined) profile.appendSystemPrompt = appendSystemPrompt;
	const customArgs = optionalString(r.customArgs);
	if (customArgs !== undefined) profile.customArgs = customArgs;

	return profile;
}
