/**
 * Which provider generates a Director's Notes synopsis.
 *
 * Two modes, and the wire carries both in one field:
 *
 * - `'auto'` (the default) means "whichever supported provider is installed",
 *   resolved at generation time against live agent detection. A conductor who
 *   never opens Settings still gets a synopsis, and an account whose OAuth went
 *   stale is not a dead end as long as a second provider is present.
 * - A concrete `ToolType` means the conductor picked that one deliberately, and
 *   it is used even when it is unavailable (so the error names the provider they
 *   chose rather than silently running somewhere else).
 *
 * `DirectorNotesSettings` keeps the two apart: `autoSelectProvider` is the mode
 * and `provider` remembers the manual pick, so toggling auto off restores the
 * provider the user last chose instead of resetting to the first in the list.
 */

import type { ToolType } from './types';

/** Sentinel the renderer, CLI, and web surfaces send for "pick one for me". */
export const AUTO_SYNOPSIS_PROVIDER = 'auto';

/** What a caller may put in the `provider` field of a synopsis request. */
export type SynopsisProviderChoice = ToolType | typeof AUTO_SYNOPSIS_PROVIDER;

/**
 * Preference order for auto-selection, most-preferred first.
 *
 * Mirrors the wizard's `AGENT_TILES` order, which is the order the rest of the
 * app presents providers in. Kept here rather than imported from the wizard
 * because the main process resolves this and cannot import renderer modules.
 * `terminal` and the unsupported agents are deliberately absent: a synopsis is a
 * one-shot batch prompt, and only these providers are wired for it.
 */
export const SYNOPSIS_PROVIDER_PREFERENCE: readonly ToolType[] = [
	'claude-code',
	'codex',
	'opencode',
	'factory-droid',
	'copilot-cli',
];

/** True when a stored or wire value means "auto-select". */
export function isAutoSynopsisProvider(
	value: string | undefined | null
): value is typeof AUTO_SYNOPSIS_PROVIDER {
	return value === AUTO_SYNOPSIS_PROVIDER;
}

/**
 * First provider from `SYNOPSIS_PROVIDER_PREFERENCE` present in `availableIds`,
 * or null when none of them is installed.
 */
export function pickFirstAvailableProvider(availableIds: Iterable<string>): ToolType | null {
	const available = new Set(availableIds);
	return SYNOPSIS_PROVIDER_PREFERENCE.find((id) => available.has(id)) ?? null;
}

/**
 * The `provider` value to send for a given settings state. Auto mode sends the
 * sentinel; manual mode sends the remembered pick.
 */
export function synopsisProviderChoice(settings: {
	provider: ToolType;
	autoSelectProvider?: boolean;
}): SynopsisProviderChoice {
	return settings.autoSelectProvider === false ? settings.provider : AUTO_SYNOPSIS_PROVIDER;
}
