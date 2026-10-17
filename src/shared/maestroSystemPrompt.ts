/**
 * The Maestro system prompt assembler (pure, bundle-safe).
 *
 * Every Maestro-spawned agent gets the same system prompt: the
 * `maestro-system-prompt` template, then any role sections (the Pianola manager
 * instructions), then one section per core feature that is ready for the agent
 * (`coreSystemPromptSectionsFor`: System One), then one section per enabled
 * first-party plugin that declares a `systemPromptSection` (see
 * `FirstPartyPluginDefinition`). Three builders resolve the inputs in their own
 * process and hand them here:
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
import type { SystemOneAgentAccess } from './local-models/system-one-agent';
import {
	SYSTEM_ONE_SYSTEM_PROMPT_ID,
	isSystemOneAdvertised,
	systemOnePromptVariables,
} from './local-models/system-one-prompt';
import { FIRST_PARTY_PLUGIN_DEFINITIONS, type FirstPartyEncoreFlag } from './plugins/first-party';
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
 *
 * A `requiresReady` section also needs its flag in `readyFlags`: the builder
 * names the features whose setup it has confirmed is complete. Leaving the list
 * out drops every such section, so a builder that cannot tell never advertises
 * a tool that may not work.
 */
export function systemPromptSectionsFor(
	encoreFeatures: unknown,
	opts: { isSsh: boolean; readyFlags?: readonly FirstPartyEncoreFlag[] }
): SystemPromptSectionRef[] {
	const flags = resolveEncoreFeatures(encoreFeatures);
	const refs: SystemPromptSectionRef[] = [];
	for (const def of FIRST_PARTY_PLUGIN_DEFINITIONS) {
		const section = def.systemPromptSection;
		if (!section) continue;
		if (!flags[def.encoreFlag]) continue;
		if (section.localOnly && opts.isSsh) continue;
		if (section.requiresReady && !opts.readyFlags?.includes(def.encoreFlag)) continue;
		refs.push({ pluginId: def.id, promptId: section.promptId });
	}
	return refs;
}

/** A core section to load: which core feature asked, and the core prompt holding its text. */
export interface CoreSystemPromptSectionRef {
	featureId: 'system-one';
	promptId: string;
}

/**
 * What a builder knows about the core features that add a section. Core
 * features are not Encore Features: no flag switches them, so each is gated on
 * a fact the builder resolved for the agent being spawned.
 */
export interface CoreSystemPromptInput {
	/** True for an SSH remote agent, whose shell cannot reach this desktop. */
	isSsh: boolean;
	/**
	 * `getSystemOneAgentAccess()` for the agent being spawned. Leave it out when
	 * the builder could not ask: no answer drops the section, so an agent is
	 * never told about a tool that may refuse it.
	 */
	systemOne?: SystemOneAgentAccess | null;
}

/**
 * The core sections an agent spawned right now should carry.
 *
 * System One: present only while a request from this agent would be answered
 * (an engine is chosen, set up and has passed its Test; "Let agents use System
 * One" is on; the agent is not switched off in its own settings; the day's
 * budget is not spent), and never for an SSH remote agent. The gate is asked on
 * every spawn, so switching System One off removes the section from the next
 * one.
 */
export function coreSystemPromptSectionsFor(
	input: CoreSystemPromptInput
): CoreSystemPromptSectionRef[] {
	const refs: CoreSystemPromptSectionRef[] = [];
	if (isSystemOneAdvertised(input.systemOne, { isSsh: input.isSsh })) {
		refs.push({ featureId: 'system-one', promptId: SYSTEM_ONE_SYSTEM_PROMPT_ID });
	}
	return refs;
}

/**
 * The template context the core sections read, decided on the same input as
 * {@link coreSystemPromptSectionsFor}: a builder spreads this into its context
 * so a section and the variables it names cannot come from two answers.
 */
export function coreSystemPromptContext(
	input: CoreSystemPromptInput
): Pick<TemplateContext, 'systemOne'> {
	return isSystemOneAdvertised(input.systemOne, { isSsh: input.isSsh })
		? { systemOne: systemOnePromptVariables(input.systemOne) }
		: {};
}

export interface AssembleMaestroSystemPromptInput {
	/** The `maestro-system-prompt` template text (customizations already applied). */
	template: string;
	/** One context for the base template AND every section. */
	context: TemplateContext;
	/** Role-specific additions (e.g. the Pianola manager prompt). Appended first. */
	roleSections?: ReadonlyArray<string | null | undefined>;
	/** Core section texts, in `coreSystemPromptSectionsFor` order. Appended after the role sections. */
	coreSections?: ReadonlyArray<string | null | undefined>;
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
	for (const section of [
		...(input.roleSections ?? []),
		...(input.coreSections ?? []),
		...(input.pluginSections ?? []),
	]) {
		if (!section || !section.trim()) continue;
		const substituted = substituteTemplateVariables(section, context);
		if (substituted.trim()) parts.push(substituted);
	}
	return parts.join(MAESTRO_SYSTEM_PROMPT_SECTION_SEPARATOR);
}
