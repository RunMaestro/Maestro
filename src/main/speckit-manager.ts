/**
 * Spec Kit Manager
 *
 * Manages bundled spec-kit prompts with support for:
 * - Loading bundled prompts from src/prompts/speckit/
 * - Fetching updates from GitHub's spec-kit repository
 * - User customization with ability to reset to defaults
 *
 * The common load/save/reset/getBySlash logic lives in spec-command-manager.ts.
 * This module provides the SpecKit specific configuration and the GitHub release
 * ZIP refresh strategy.
 */

import { logger } from './utils/logger';
import {
	createSpecCommandManager,
	SpecCommand,
	SpecCommandDefinition,
	SpecMetadata,
} from './spec-command-manager';

const LOG_CONTEXT = '[SpecKit]';

// All bundled spec-kit commands with their metadata
const SPECKIT_COMMANDS: readonly SpecCommandDefinition[] = [
	{
		id: 'help',
		description: 'Learn how to use spec-kit with Maestro',
		isCustom: true,
	},
	{
		id: 'constitution',
		description: 'Create or update the project constitution',
		isCustom: false,
	},
	{
		id: 'specify',
		description: 'Create or update feature specification',
		isCustom: false,
	},
	{
		id: 'clarify',
		description: 'Identify underspecified areas and ask clarification questions',
		isCustom: false,
	},
	{
		id: 'plan',
		description: 'Execute implementation planning workflow',
		isCustom: false,
	},
	{
		id: 'tasks',
		description: 'Generate actionable, dependency-ordered tasks',
		isCustom: false,
	},
	{
		id: 'analyze',
		description: 'Cross-artifact consistency and quality analysis',
		isCustom: false,
	},
	{
		id: 'checklist',
		description: 'Generate custom checklist for feature',
		isCustom: false,
	},
	{
		id: 'taskstoissues',
		description: 'Convert tasks to GitHub issues',
		isCustom: false,
	},
	{
		id: 'implement',
		description: 'Execute tasks using Maestro Auto Run with worktree support',
		isCustom: true,
	},
] as const;

// SpecKit specific public types are aliases over the shared shape.
export type SpecKitCommand = SpecCommand;
export type SpecKitMetadata = SpecMetadata;

const manager = createSpecCommandManager({
	logContext: LOG_CONTEXT,
	filePrefix: 'speckit',
	bundledDirName: 'speckit',
	customizationsFileName: 'speckit-customizations.json',
	userPromptsDirName: 'speckit-prompts',
	commands: SPECKIT_COMMANDS,
	defaultMetadata: {
		lastRefreshed: '2024-01-01T00:00:00Z',
		commitSha: 'bundled',
		sourceVersion: '0.0.90',
		sourceUrl: 'https://github.com/github/spec-kit',
	},
});

/**
 * Get current spec-kit metadata
 */
export const getSpeckitMetadata = (): Promise<SpecKitMetadata> => manager.getMetadata();

/**
 * Get all spec-kit prompts (bundled defaults merged with user customizations)
 */
export const getSpeckitPrompts = (): Promise<SpecKitCommand[]> => manager.getPrompts();

/**
 * Save user's edit to a spec-kit prompt
 */
export const saveSpeckitPrompt = (id: string, content: string): Promise<void> =>
	manager.savePrompt(id, content);

/**
 * Reset a spec-kit prompt to its bundled default
 */
export const resetSpeckitPrompt = (id: string): Promise<string> => manager.resetPrompt(id);

/**
 * Get a single spec-kit command by ID
 */
export const getSpeckitCommand = (id: string): Promise<SpecKitCommand | null> =>
	manager.getCommand(id);

/**
 * Get a spec-kit command by its slash command string (e.g., "/speckit.constitution")
 */
export const getSpeckitCommandBySlash = (slashCommand: string): Promise<SpecKitCommand | null> =>
	manager.getCommandBySlash(slashCommand);

/**
 * Upstream commands to fetch (we skip 'implement' as it's custom)
 */
const UPSTREAM_COMMANDS = [
	'constitution',
	'specify',
	'clarify',
	'plan',
	'tasks',
	'analyze',
	'checklist',
	'taskstoissues',
];

/**
 * Rewrite repo-relative paths in a command template to their installed
 * `.specify/...` project locations. Faithful port of
 * `CommandRegistrar.rewrite_project_relative_paths` in spec-kit's
 * `src/specify_cli/agents.py`.
 */
function rewriteProjectRelativePaths(text: string): string {
	if (!text) return text;
	for (const [oldPath, newPath] of [
		['../../memory/', '.specify/memory/'],
		['../../scripts/', '.specify/scripts/'],
		['../../templates/', '.specify/templates/'],
	] as const) {
		text = text.split(oldPath).join(newPath);
	}
	// Only rewrite top-level style references so extension-local paths like
	// ".specify/extensions/<ext>/scripts/..." remain intact.
	text = text.replace(/(^|[\s`"'(])(?:\.?\/)?memory\//gm, '$1.specify/memory/');
	text = text.replace(/(^|[\s`"'(])(?:\.?\/)?scripts\//gm, '$1.specify/scripts/');
	text = text.replace(/(^|[\s`"'(])(?:\.?\/)?templates\//gm, '$1.specify/templates/');
	return text
		.split('.specify/.specify/')
		.join('.specify/')
		.split('.specify.specify/')
		.join('.specify/');
}

/**
 * Turn a raw `templates/commands/<cmd>.md` source from spec-kit into the
 * agent-ready Claude command body. This is a faithful port of
 * `IntegrationBase.process_template` in spec-kit's
 * `src/specify_cli/integrations/base.py`, specialized for the Claude (bash)
 * integration. Spec-kit stopped publishing pre-rendered template ZIPs as
 * release assets, so we now apply the same substitutions it would.
 */
function processSpeckitTemplate(content: string): string {
	const scriptType = 'sh';
	const argPlaceholder = '$ARGUMENTS';
	const contextFile = 'CLAUDE.md';
	const agentName = 'claude';

	// 1. Extract the script command from the `scripts:` frontmatter block.
	let scriptCommand = '';
	let inScripts = false;
	for (const line of content.split('\n')) {
		if (line.trim() === 'scripts:') {
			inScripts = true;
			continue;
		}
		if (inScripts && line && !/^\s/.test(line)) inScripts = false;
		if (inScripts) {
			const m = line.match(new RegExp(`^\\s*${scriptType}:\\s*(.+)$`));
			if (m) {
				scriptCommand = m[1].trim();
				break;
			}
		}
	}

	// 2. Replace {SCRIPT} with the extracted script command.
	if (scriptCommand) content = content.split('{SCRIPT}').join(scriptCommand);

	// 3. Strip the `scripts:` section out of the frontmatter.
	const out: string[] = [];
	let inFrontmatter = false;
	let skipSection = false;
	let dashCount = 0;
	for (const line of content.split(/(?<=\n)/)) {
		const stripped = line.replace(/[\r\n]+$/, '');
		if (stripped === '---') {
			dashCount += 1;
			inFrontmatter = dashCount === 1;
			skipSection = false;
			out.push(line);
			continue;
		}
		if (inFrontmatter) {
			if (stripped === 'scripts:') {
				skipSection = true;
				continue;
			}
			if (skipSection) {
				if (/^\s/.test(line)) continue;
				skipSection = false;
			}
		}
		out.push(line);
	}
	content = out.join('');

	// 4-6. Placeholder substitutions.
	content = content.split('{ARGS}').join(argPlaceholder).split('$ARGUMENTS').join(argPlaceholder);
	content = content.split('__AGENT__').join(agentName).split('__CONTEXT_FILE__').join(contextFile);

	// 7. Rewrite repo-relative paths to their installed locations.
	content = rewriteProjectRelativePaths(content);

	// 8. Replace __SPECKIT_COMMAND_<NAME>__ with the slash invocation.
	content = content.replace(
		/__SPECKIT_COMMAND_([A-Z][A-Z0-9_]*)__/g,
		(_m, name: string) => '/speckit.' + name.toLowerCase().split('_').join('.')
	);

	return content;
}

/**
 * Fetch a raw text file from GitHub.
 */
async function fetchRaw(url: string): Promise<string> {
	const res = await fetch(url, { headers: { 'User-Agent': 'Maestro-SpecKit-Refresher' } });
	if (!res.ok) {
		throw new Error(`HTTP ${res.status} fetching ${url}`);
	}
	return res.text();
}

/**
 * Fetch latest prompts from GitHub spec-kit repository.
 *
 * Spec-kit no longer ships pre-rendered command ZIPs as release assets; the
 * command templates live at `templates/commands/<cmd>.md` in the repo and are
 * rendered per-agent at install time. We fetch the raw templates at the latest
 * release tag and apply the same substitutions spec-kit would for Claude.
 * Updates all upstream commands except our custom 'implement'.
 */
export async function refreshSpeckitPrompts(): Promise<SpecKitMetadata> {
	logger.info('Refreshing spec-kit prompts from GitHub...', LOG_CONTEXT);

	// Get the latest release tag for versioning and as the fetch ref.
	const releaseResponse = await fetch(
		'https://api.github.com/repos/github/spec-kit/releases/latest',
		{ headers: { 'User-Agent': 'Maestro-SpecKit-Refresher' } }
	);
	if (!releaseResponse.ok) {
		throw new Error(`Failed to fetch release info: ${releaseResponse.statusText}`);
	}
	const releaseInfo = (await releaseResponse.json()) as { tag_name: string };
	const version = releaseInfo.tag_name;

	const refreshedPrompts = [];
	for (const cmd of UPSTREAM_COMMANDS) {
		const url = `https://raw.githubusercontent.com/github/spec-kit/${version}/templates/commands/${cmd}.md`;
		const raw = await fetchRaw(url);
		refreshedPrompts.push({ id: cmd, content: processSpeckitTemplate(raw) });
	}

	const newMetadata: SpecKitMetadata = {
		lastRefreshed: new Date().toISOString(),
		commitSha: version,
		sourceVersion: version.replace(/^v/, ''),
		sourceUrl: 'https://github.com/github/spec-kit',
	};
	await manager.commitRefresh(refreshedPrompts, newMetadata);
	for (const { id } of refreshedPrompts) {
		logger.info(`Updated: speckit.${id}.md`, LOG_CONTEXT);
	}

	logger.info(`Refreshed spec-kit prompts to ${version}`, LOG_CONTEXT);

	return newMetadata;
}
