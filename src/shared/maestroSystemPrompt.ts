/**
 * The Maestro system prompt assembler (pure, bundle-safe).
 *
 * Every Maestro-spawned agent gets the same system prompt: the
 * `maestro-system-prompt` template, then any role sections (the Pianola manager
 * instructions), then one section per enabled first-party plugin that declares
 * a `systemPromptSection` (see `FirstPartyPluginDefinition`). Three builders
 * resolve the inputs in their own process and hand them here:
 *
 * - renderer: `prepareMaestroSystemPrompt` (src/renderer/utils/spawnHelpers.ts)
 * - CLI: `prepareMaestroSystemPromptCli` (src/cli/services/system-prompt.ts)
 * - main: `buildMaestroSystemPromptForSession` (src/main/utils/maestro-system-prompt.ts),
 *   used by Cue runs and Group Chat
 *
 * Inputs are already-resolved strings, so nothing here touches IPC, disk, or
 * Node built-ins. Keeping the ordering, separator, and per-section
 * substitution in one place is what stops the three builders from drifting.
 */

import { resolveEncoreFeatures } from './encoreFeatureDefaults';
import { FIRST_PARTY_PLUGIN_DEFINITIONS } from './plugins/first-party';
import { substituteTemplateVariables, type TemplateContext } from './templateVariables';

/** Separator placed between the base prompt and each appended section. */
export const MAESTRO_SYSTEM_PROMPT_SECTION_SEPARATOR = '\n\n---\n\n';

/** A plugin section to load: which plugin asked, and the core prompt holding its text. */
export interface SystemPromptSectionRef {
	pluginId: string;
	promptId: string;
}

/**
 * The plugin sections every agent spawned right now should carry.
 *
 * Derived from `FIRST_PARTY_PLUGIN_DEFINITIONS`: a plugin contributes when its
 * Encore flag is on and it declares a `systemPromptSection`. `localOnly`
 * sections are dropped for SSH-remote agents, whose shell cannot reach paths on
 * the Maestro machine. `encoreFeatures` is whatever the caller has (the raw
 * settings value is fine): it goes through `resolveEncoreFeatures`, so a key
 * that was never persisted falls back to its default instead of reading as off.
 */
export function systemPromptSectionsFor(
	encoreFeatures: unknown,
	opts: { isSsh: boolean }
): SystemPromptSectionRef[] {
	const flags = resolveEncoreFeatures(encoreFeatures);
	const refs: SystemPromptSectionRef[] = [];
	for (const def of FIRST_PARTY_PLUGIN_DEFINITIONS) {
		const section = def.systemPromptSection;
		if (!section) continue;
		if (!flags[def.encoreFlag]) continue;
		if (section.localOnly && opts.isSsh) continue;
		refs.push({ pluginId: def.id, promptId: section.promptId });
	}
	return refs;
}

export interface AssembleMaestroSystemPromptInput {
	/** The `maestro-system-prompt` template text (customizations already applied). */
	template: string;
	/** One context for the base template AND every section. */
	context: TemplateContext;
	/** Role-specific additions (e.g. the Pianola manager prompt). Appended first. */
	roleSections?: ReadonlyArray<string | null | undefined>;
	/** Plugin section texts, in `systemPromptSectionsFor` order. Appended last. */
	pluginSections?: ReadonlyArray<string | null | undefined>;
}

/**
 * Substitute the template and every section with the same context, then join
 * them with `MAESTRO_SYSTEM_PROMPT_SECTION_SEPARATOR`. Missing or blank
 * sections are skipped, so a section whose prompt failed to load (or that the
 * user emptied in Maestro Prompts) leaves no stray separator behind.
 */
export function assembleMaestroSystemPrompt(input: AssembleMaestroSystemPromptInput): string {
	const { template, context } = input;
	const parts = [substituteTemplateVariables(template, context)];
	for (const section of [...(input.roleSections ?? []), ...(input.pluginSections ?? [])]) {
		if (!section || !section.trim()) continue;
		const substituted = substituteTemplateVariables(section, context);
		if (substituted.trim()) parts.push(substituted);
	}
	return parts.join(MAESTRO_SYSTEM_PROMPT_SECTION_SEPARATOR);
}
