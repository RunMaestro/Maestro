/**
 * PM Commands IPC Handler
 *
 * Provides the `pm:loadCommands` channel that loads all /PM verb prompts
 * from bundled `src/prompts/pm/pm-*.md` files and returns them as
 * PmCommand objects for the renderer's customAICommands path.
 *
 * This lets the renderer map PM commands into the same Spec-Kit/customAICommand
 * dispatch path instead of the old log-only IPC dispatch block.
 */

import { ipcMain } from 'electron';
import fs from 'fs/promises';
import path from 'path';
import { app } from 'electron';
import { logger } from '../../utils/logger';
import { createIpcHandler } from '../../utils/ipcHandler';

const LOG_CONTEXT = '[PMCommands]';

export interface PmCommand {
	/** Verb-only slug, e.g. "prd-new" or "" for the bare /PM orchestrator */
	id: string;
	/** Full slash command string, e.g. "/PM prd-new" or "/PM" */
	command: string;
	/** Short description for autocomplete */
	description: string;
	/** Full prompt text (frontmatter stripped) */
	prompt: string;
}

/** All /PM verbs and the prompt file that backs each one. */
const PM_VERB_MAP: Array<{ verb: string; file: string; description: string }> = [
	{
		verb: '',
		file: 'pm-orchestrator.md',
		description: 'Start a new feature end-to-end: Conv-PRD → Epic → Tasks → GitHub',
	},
	{
		verb: 'prd-new',
		file: 'pm-prd-new.md',
		description: 'Open the Conversational PRD planner seeded with a name',
	},
	{
		verb: 'prd-edit',
		file: 'pm-prd-edit.md',
		description: 'Open the Conv-PRD modal in edit mode for an existing PRD',
	},
	{
		verb: 'prd-status',
		file: 'pm-prd-status.md',
		description: 'Quick status lookup for a PRD',
	},
	{
		verb: 'prd-parse',
		file: 'pm-prd-parse.md',
		description: 'Convert a PRD into structured Delivery Planner input',
	},
	{
		verb: 'prd-list',
		file: 'pm-prd-list.md',
		description: 'List all PRDs for the current project',
	},
	{
		verb: 'epic-decompose',
		file: 'pm-epic-decompose.md',
		description: 'Decompose a PRD into an epic + tasks via Delivery Planner',
	},
	{
		verb: 'epic-edit',
		file: 'pm-epic-edit.md',
		description: 'Open the Delivery Planner with an epic preloaded for editing',
	},
	{
		verb: 'epic-list',
		file: 'pm-epic-list.md',
		description: 'Show a table of all epics in the Work Graph',
	},
	{
		verb: 'epic-show',
		file: 'pm-epic-show.md',
		description: 'Show full detail for an epic including task list',
	},
	{
		verb: 'epic-sync',
		file: 'pm-epic-sync.md',
		description: 'Push an epic to GitHub via the Delivery Planner sync channel',
	},
	{
		verb: 'epic-start',
		file: 'pm-epic-start.md',
		description: 'Kick the Planning Pipeline for an epic',
	},
	{
		verb: 'issue-start',
		file: 'pm-issue-start.md',
		description: 'Manually claim a task into Agent Dispatch',
	},
	{
		verb: 'issue-show',
		file: 'pm-issue-show.md',
		description: 'Show full detail for a task',
	},
	{
		verb: 'issue-status',
		file: 'pm-issue-status.md',
		description: 'Quick status check for a task',
	},
	{
		verb: 'issue-sync',
		file: 'pm-issue-sync.md',
		description: 'GitHub roundtrip sync for a task',
	},
	{
		verb: 'next',
		file: 'pm-next.md',
		description: 'Show the next eligible work item ready for implementation',
	},
	{
		verb: 'status',
		file: 'pm-status.md',
		description: 'Show a current project board snapshot',
	},
	{
		verb: 'standup',
		file: 'pm-standup.md',
		description: 'Generate a standup summary for the current project',
	},
];

function getPmPromptsDir(): string {
	if (app.isPackaged) {
		return path.join(process.resourcesPath, 'prompts', 'pm');
	}
	return path.join(__dirname, '..', '..', '..', 'src', 'prompts', 'pm');
}

/** Strip YAML/markdown frontmatter if present (lines between leading ---). */
function stripFrontmatter(content: string): string {
	const trimmed = content.trimStart();
	if (!trimmed.startsWith('---')) {
		return content;
	}
	const end = trimmed.indexOf('\n---', 3);
	if (end === -1) {
		return content;
	}
	return trimmed.slice(end + 4).trimStart();
}

async function loadPmCommands(): Promise<PmCommand[]> {
	const dir = getPmPromptsDir();
	const commands: PmCommand[] = [];

	for (const entry of PM_VERB_MAP) {
		const filePath = path.join(dir, entry.file);
		try {
			const raw = await fs.readFile(filePath, 'utf-8');
			const prompt = stripFrontmatter(raw);
			commands.push({
				id: entry.verb === '' ? 'orchestrate' : entry.verb,
				command: entry.verb === '' ? '/PM' : `/PM ${entry.verb}`,
				description: entry.description,
				prompt,
			});
		} catch (error) {
			logger.warn(`Failed to load PM prompt ${entry.file}: ${error}`, LOG_CONTEXT);
			// Still include the entry with a minimal placeholder so autocomplete works
			commands.push({
				id: entry.verb === '' ? 'orchestrate' : entry.verb,
				command: entry.verb === '' ? '/PM' : `/PM ${entry.verb}`,
				description: entry.description,
				prompt: `# /PM ${entry.verb}\n\n{{ARGS}}`,
			});
		}
	}

	return commands;
}

/**
 * Register the pm:loadCommands IPC handler.
 */
export function registerPmCommandsHandlers(): void {
	ipcMain.handle(
		'pm:loadCommands',
		createIpcHandler(
			{ context: LOG_CONTEXT, operation: 'loadCommands', logSuccess: false },
			async () => {
				const commands = await loadPmCommands();
				return { commands };
			}
		)
	);

	logger.debug(`${LOG_CONTEXT} PM commands IPC handler registered`);
}
