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
 *
 * The handbook files in docs/pm/handbook/ are appended as absolute paths at the bottom
 * of the loaded prompt so the agent can Read them on demand during a PM conversation.
 *
 * TODO: Switch handbook paths from the hardcoded fork root to
 *   `${activeSession.projectRoot}/docs/pm/handbook/`
 * once the IPC can pass projectRoot through to loadPmCommands.
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

/**
 * Returns the absolute path to the PM handbook directory, or null when not
 * available (packaged builds do not ship the handbook).
 *
 * In development: derives the path relative to __dirname so it works on any
 * checkout regardless of clone location.
 *
 * TODO: Switch to `${activeSession.projectRoot}/docs/pm/handbook/` once
 * projectRoot is threaded through the loadPmCommands IPC call.
 */
function getPmHandbookDir(): string | null {
	if (app.isPackaged) {
		// Handbook files are not included in the packaged app build.
		return null;
	}
	// In dev mode __dirname is dist/main/ipc/handlers — four levels up is the project root.
	return path.join(__dirname, '..', '..', '..', '..', 'docs', 'pm', 'handbook');
}

/** Build the handbook table-of-contents appendix for the /PM system prompt. */
function buildHandbookAppendix(): string {
	const handbookDir = getPmHandbookDir();
	if (!handbookDir) {
		// Handbook not available (packaged build).
		return '';
	}
	const files = [
		'01-prd-creation.md',
		'02-epic-decomposition.md',
		'03-task-breakdown.md',
		'04-github-sync.md',
		'05-dispatch-claim.md',
		'06-review-merge.md',
		'07-status-and-standup.md',
		'08-blocked-and-recovery.md',
		'09-state-source-of-truth.md',
		'10-cheatsheet.md',
	];

	const lines = [
		'',
		'---',
		'',
		'## Handbook (read these as needed mid-conversation)',
		'',
		...files.map((f) => `- ${path.join(handbookDir, f)}`),
	];

	return lines.join('\n');
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
		const basePrompt = stripFrontmatter(raw);
		const prompt = basePrompt + buildHandbookAppendix();
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
