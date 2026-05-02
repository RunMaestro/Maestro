/**
 * PM Commands IPC Handler
 *
 * Provides the `pm:loadCommands` channel that loads the /PM mode system prompt
 * and returns it as a single PmCommand object for the renderer's customAICommands path.
 *
 * The renderer maps this onto the builtin:pm-mode dispatch path so that typing `/PM`
 * (with or without trailing text) loads pm-mode-system.md and enters PM mode.
 *
 * The verb-specific prompt files (pm-prd-new.md, pm-epic-decompose.md, etc.) remain on
 * disk as reference content the agent can read mid-conversation but are NOT loaded as
 * separate slash commands.
 */

import { ipcMain } from 'electron';
import fs from 'fs/promises';
import path from 'path';
import { app } from 'electron';
import { logger } from '../../utils/logger';
import { createIpcHandler } from '../../utils/ipcHandler';

const LOG_CONTEXT = '[PMCommands]';

export interface PmCommand {
	/** Slug for the command, e.g. "mode" for the bare /PM entry */
	id: string;
	/** Full slash command string, e.g. "/PM" */
	command: string;
	/** Short description for autocomplete */
	description: string;
	/** Full prompt text (frontmatter stripped) */
	prompt: string;
}

function getPmPromptsDir(): string {
	if (app.isPackaged) {
		// Packaged extraResources mapping: src/prompts/pm → prompts/core/pm
		return path.join(process.resourcesPath, 'prompts', 'core', 'pm');
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
	const filePath = path.join(dir, 'pm-mode-system.md');
	try {
		const raw = await fs.readFile(filePath, 'utf-8');
		const prompt = stripFrontmatter(raw);
		return [
			{
				id: 'mode',
				command: '/PM',
				description: 'Enter PM mode — plan features, run standups, check status, find next work',
				prompt,
			},
		];
	} catch (error) {
		logger.warn(`Failed to load PM mode system prompt: ${error}`, LOG_CONTEXT);
		return [
			{
				id: 'mode',
				command: '/PM',
				description: 'Enter PM mode — plan features, run standups, check status, find next work',
				prompt:
					'# PM Mode\n\nYou are a project manager. Ask the user what they want to work on.\n\n{{ARGS}}',
			},
		];
	}
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
