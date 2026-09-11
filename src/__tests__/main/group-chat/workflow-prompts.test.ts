/**
 * Registration coverage for the workflow-planning prompt.
 *
 * Keeps the shared prompt inventory, typed ID catalog, on-disk asset, and
 * production prompt loader in sync so the prompt remains customizable in
 * Settings and available to the Group Chat moderator.
 */

import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { CORE_PROMPTS, PROMPT_IDS } from '../../../shared/promptDefinitions';

vi.mock('electron', () => ({
	app: {
		getPath: vi.fn().mockReturnValue('/mock/userData'),
		isPackaged: false,
	},
}));

vi.mock('../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

describe('workflow planning prompt registration', () => {
	it('loads the registered prompt and exposes it to the Settings inventory', async () => {
		const promptId = 'group-chat-workflow-planning';
		const definition = CORE_PROMPTS.find((prompt) => prompt.id === promptId);

		expect(PROMPT_IDS.GROUP_CHAT_WORKFLOW_PLANNING).toBe(promptId);
		expect(definition).toEqual(
			expect.objectContaining({
				id: promptId,
				filename: 'group-chat-workflow-planning.md',
				category: expect.any(String),
			})
		);
		expect(definition?.category).not.toBe('');

		const promptPath = path.join(__dirname, '../../../prompts', definition!.filename);
		const diskContent = readFileSync(promptPath, 'utf-8');
		expect(diskContent).not.toBe('');

		const { getAllPrompts, getPrompt, initializePrompts } =
			await import('../../../main/prompt-manager');
		await initializePrompts();

		expect(getPrompt(promptId)).toBe(diskContent);
		expect(getAllPrompts()).toContainEqual(
			expect.objectContaining({
				id: promptId,
				filename: definition!.filename,
				category: definition!.category,
				content: diskContent,
			})
		);
	});
});
