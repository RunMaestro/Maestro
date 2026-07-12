import type { AgentConfig } from '../types';

/**
 * Config key an agent uses for its reasoning-effort setting. Claude Code exposes
 * it as `effort`; Codex, Copilot-CLI and Factory Droid expose it as
 * `reasoningEffort`. Everything that reads or writes effort through an agent
 * config object has to pick the right key, so both helpers live here rather than
 * being re-derived at each call site.
 */
export type EffortConfigKey = 'effort' | 'reasoningEffort';

/** The effort key this agent defines, defaulting to `effort` when unknown. */
export function getEffortConfigKey(agent?: AgentConfig | null): EffortConfigKey {
	return agent?.configOptions?.some((opt) => opt.key === 'reasoningEffort')
		? 'reasoningEffort'
		: 'effort';
}

/** Read the effort value out of an agent config object regardless of which key it uses. */
export function readEffortFromConfig(config?: Record<string, unknown> | null): string | undefined {
	const reasoning =
		typeof config?.reasoningEffort === 'string' ? config.reasoningEffort.trim() : '';
	const effort = typeof config?.effort === 'string' ? config.effort.trim() : '';
	return reasoning || effort || undefined;
}
