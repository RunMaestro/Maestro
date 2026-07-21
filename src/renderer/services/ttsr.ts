/**
 * Renderer-side TTSR rule management.
 *
 * A thin wrapper over `window.maestro.ttsr.*` so components never poke the
 * bridge directly, plus the one piece of real logic on this side: composing the
 * prompt that hands rule authoring to the agent (see {@link buildRuleAuthoringPrompt}).
 *
 * Everything is project-scoped. Rules live in each project's `.maestro/rules/`,
 * so every call names the project root it acts on - normally the `cwd` of the
 * agent the user is looking at.
 */

import { TTSR_RULES_DIR } from '../../shared/maestro-paths';
import type { TtsrProjectSettings, TtsrRuleListResult, TtsrRuleValidation } from '../types';
import { logger } from '../utils/logger';

/** True when the preload exposes rule management (older preloads, some web builds). */
export function isTtsrRuleApiAvailable(): boolean {
	return typeof window.maestro?.ttsr?.listRules === 'function';
}

export const ttsrService = {
	listRules: (projectRoot: string): Promise<TtsrRuleListResult> =>
		window.maestro.ttsr.listRules(projectRoot),

	readRule: (projectRoot: string, path: string): Promise<string | null> =>
		window.maestro.ttsr.readRule(projectRoot, path),

	writeRule: (projectRoot: string, path: string, content: string): Promise<{ path: string }> =>
		window.maestro.ttsr.writeRule(projectRoot, path, content),

	deleteRule: (projectRoot: string, path: string): Promise<{ deleted: boolean }> =>
		window.maestro.ttsr.deleteRule(projectRoot, path),

	validateRule: (content: string, path?: string): Promise<TtsrRuleValidation> =>
		window.maestro.ttsr.validateRule(content, path),

	readProjectSettings: (projectRoot: string): Promise<TtsrProjectSettings> =>
		window.maestro.ttsr.readProjectSettings(projectRoot),

	writeProjectSettings: (
		projectRoot: string,
		settings: Partial<TtsrProjectSettings>
	): Promise<{ path: string }> => window.maestro.ttsr.writeProjectSettings(projectRoot, settings),
};

/**
 * The rule-authoring brief, with the user's request folded in.
 *
 * Rule files are just markdown, and the agent already has file-writing tools -
 * so authoring needs no generation pipeline, only a prompt that teaches the
 * schema and its per-agent limits. The agent then writes the file itself, the
 * rule-file watcher notices, and the list refreshes. That also means the user
 * can iterate conversationally ("make it narrower", "it is firing too often")
 * instead of round-tripping through a form.
 *
 * Falls back to a compact inline brief when the prompt file cannot be read, so
 * the button still does something useful on a broken install.
 */
export async function buildRuleAuthoringPrompt(request: string): Promise<string> {
	const instruction = request.trim();

	try {
		const result = await window.maestro.prompts.get('ttsr-rule-authoring');
		if (result.success && result.content) {
			return result.content
				.replace(/\{\{TTSR_RULES_DIR\}\}/g, TTSR_RULES_DIR)
				.replace(/\{\{USER_REQUEST\}\}/g, instruction);
		}
		logger.warn('[TTSR] Rule authoring prompt unavailable, using fallback', undefined, {
			error: result.error,
		});
	} catch (error) {
		logger.warn('[TTSR] Failed to load rule authoring prompt', undefined, error);
	}

	return [
		`Write a Time-Traveling Stream Rule under \`${TTSR_RULES_DIR}/\` as a markdown file with YAML frontmatter.`,
		'',
		'Fields: `description`, `condition` (list of JS regexes), `scope` (one or more of',
		'`text`, `thinking`, `tool:edit`, `tool:write`, `tool:bash`), optional `globs`',
		'(only narrows `tool:edit`/`tool:write`), `interruptMode`',
		'(`always`|`never`|`prose-only`|`tool-only`), `repeatMode` (`once`|`after-gap`),',
		'`repeatGap`. The markdown body is the message injected back into the agent.',
		'',
		'Use `tool:bash` for forbidden commands and `tool:write`/`tool:edit` for file',
		'content. Matching is corrective, not preventive: the action may already have',
		'happened when the rule fires.',
		'',
		`The request: ${instruction}`,
	].join('\n');
}
