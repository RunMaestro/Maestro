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
 * A named override bundle: a *role* (model / effort / role-prompt / args).
 *
 * Only `id` and `name` are required. `baseAgentId` is OPTIONAL (Board Phase 6):
 * when set, the profile pins its overrides to that specific Left Bar agent (the
 * classic "layer on a base agent" case, and the Board dispatches the card to
 * exactly that agent). When ABSENT, the profile is a pure role that the Board
 * floats to any FREE opt-in worker in the project pool, layering the role's
 * overrides on whichever agent picks it up. Every override field is optional; an
 * undefined field falls back to the running agent's value at spawn time (see
 * {@link resolveProfileSpawnOverrides}).
 */
export interface AgentProfile {
	/** Stable unique id (UUID). */
	id: string;
	/** Human-facing label shown in the Profiles UI and the Board. */
	name: string;
	/**
	 * Id of the Left Bar agent this profile pins to. OPTIONAL: when absent, the
	 * role floats to the free worker pool instead of a fixed agent.
	 */
	baseAgentId?: string;
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
 * Rules: `id` and `name` must be non-empty strings. `baseAgentId` is optional
 * (a pinned profile has it, a pool role omits it). Optional override fields,
 * when present, must be strings - a present non-string (`model: 42`,
 * `baseAgentId: {}`) rejects the WHOLE profile rather than being silently
 * dropped, because a dropped override runs the card with the wrong
 * model/effort/role and nobody finds out. Only an absent field (or YAML `null`,
 * which is how an empty `model:` line parses) and a blank/whitespace string
 * normalize to "not set" (so an accidentally-blank field falls back to the
 * running agent rather than blanking it).
 */
export function validateAgentProfile(raw: unknown): AgentProfile | null {
	if (!raw || typeof raw !== 'object') return null;
	const r = raw as Record<string, unknown>;

	const id = typeof r.id === 'string' ? r.id.trim() : '';
	const name = typeof r.name === 'string' ? r.name.trim() : '';
	if (!id || !name) return null;

	const profile: AgentProfile = { id, name };

	/** Sentinel distinguishing "present but not a string" from "absent/blank". */
	const MALFORMED = Symbol('malformed');
	const optionalString = (value: unknown): string | undefined | typeof MALFORMED => {
		if (value === undefined || value === null) return undefined;
		if (typeof value !== 'string') return MALFORMED;
		const trimmed = value.trim();
		return trimmed.length > 0 ? value : undefined;
	};

	const baseAgentId = optionalString(r.baseAgentId);
	if (baseAgentId === MALFORMED) return null;
	if (baseAgentId !== undefined) profile.baseAgentId = baseAgentId.trim();

	const model = optionalString(r.model);
	if (model === MALFORMED) return null;
	if (model !== undefined) profile.model = model;
	const effort = optionalString(r.effort);
	if (effort === MALFORMED) return null;
	if (effort !== undefined) profile.effort = effort;
	const appendSystemPrompt = optionalString(r.appendSystemPrompt);
	if (appendSystemPrompt === MALFORMED) return null;
	if (appendSystemPrompt !== undefined) profile.appendSystemPrompt = appendSystemPrompt;
	const customArgs = optionalString(r.customArgs);
	if (customArgs === MALFORMED) return null;
	if (customArgs !== undefined) profile.customArgs = customArgs;

	return profile;
}
