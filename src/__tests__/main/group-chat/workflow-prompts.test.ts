/**
 * Registration coverage for the workflow planning and execution prompts.
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

describe('workflow prompt registration', () => {
	it.each([
		[
			'group-chat-workflow-planning',
			'group-chat-workflow-planning.md',
			PROMPT_IDS.GROUP_CHAT_WORKFLOW_PLANNING,
		],
		[
			'group-chat-workflow-stage',
			'group-chat-workflow-stage.md',
			PROMPT_IDS.GROUP_CHAT_WORKFLOW_STAGE,
		],
	])('loads %s and exposes it to the Settings inventory', async (promptId, filename, typedId) => {
		const definition = CORE_PROMPTS.find((prompt) => prompt.id === promptId);

		expect(typedId).toBe(promptId);
		expect(definition).toEqual(
			expect.objectContaining({
				id: promptId,
				filename,
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

	it('requires inspection-only stages when workflow planning in read-only mode', () => {
		const definition = CORE_PROMPTS.find(
			(prompt) => prompt.id === PROMPT_IDS.GROUP_CHAT_WORKFLOW_PLANNING
		);
		const promptPath = path.join(__dirname, '../../../prompts', definition!.filename);
		const diskContent = readFileSync(promptPath, 'utf-8');

		expect(diskContent).toContain(
			'every stage must be limited to inspection, analysis, or planning'
		);
		expect(diskContent).toContain('no stage may make file changes while read-only mode is on');
	});
});
