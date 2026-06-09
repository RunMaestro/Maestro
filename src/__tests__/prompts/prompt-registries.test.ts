import { describe, expect, it } from 'vitest';
import {
	applyPrompt,
	archivePrompt,
	getOpenSpecCommand,
	getOpenSpecCommandBySlash,
	getOpenSpecMetadata,
	helpPrompt as openspecHelpPrompt,
	implementPrompt as openspecImplementPrompt,
	openspecCommands,
	proposalPrompt,
} from '../../prompts/openspec';
import {
	analyzePrompt,
	checklistPrompt,
	clarifyPrompt,
	constitutionPrompt,
	getSpeckitCommand,
	getSpeckitCommandBySlash,
	getSpeckitMetadata,
	helpPrompt as speckitHelpPrompt,
	implementPrompt as speckitImplementPrompt,
	planPrompt,
	speckitCommands,
	specifyPrompt,
	tasksPrompt,
	tasksToIssuesPrompt,
} from '../../prompts/speckit';

describe('bundled prompt registries', () => {
	it('registers OpenSpec commands with prompts, custom flags, and lookup helpers', () => {
		expect(openspecCommands.map((command) => command.id)).toEqual([
			'help',
			'proposal',
			'apply',
			'archive',
			'implement',
		]);
		expect(openspecCommands.map((command) => command.command)).toEqual([
			'/openspec.help',
			'/openspec.proposal',
			'/openspec.apply',
			'/openspec.archive',
			'/openspec.implement',
		]);

		expect(getOpenSpecCommand('proposal')).toEqual(
			expect.objectContaining({
				id: 'proposal',
				command: '/openspec.proposal',
				prompt: proposalPrompt,
				isCustom: false,
			})
		);
		expect(getOpenSpecCommandBySlash('/openspec.implement')).toEqual(
			expect.objectContaining({
				id: 'implement',
				prompt: openspecImplementPrompt,
				isCustom: true,
			})
		);
		expect(getOpenSpecCommand('missing')).toBeUndefined();
		expect(getOpenSpecCommandBySlash('/openspec.missing')).toBeUndefined();
		for (const prompt of [
			openspecHelpPrompt,
			proposalPrompt,
			applyPrompt,
			archivePrompt,
			openspecImplementPrompt,
		]) {
			expect(prompt.trim().length).toBeGreaterThan(20);
		}
	});

	it('exposes OpenSpec metadata from the bundled manifest', () => {
		expect(getOpenSpecMetadata()).toEqual(
			expect.objectContaining({
				lastRefreshed: expect.any(String),
				commitSha: expect.any(String),
				sourceVersion: expect.any(String),
				sourceUrl: expect.stringContaining('OpenSpec'),
			})
		);
	});

	it('registers spec-kit commands with prompts, custom flags, and lookup helpers', () => {
		expect(speckitCommands.map((command) => command.id)).toEqual([
			'help',
			'constitution',
			'specify',
			'clarify',
			'plan',
			'tasks',
			'analyze',
			'checklist',
			'taskstoissues',
			'implement',
		]);
		expect(speckitCommands.map((command) => command.command)).toContain('/speckit.plan');

		expect(getSpeckitCommand('tasks')).toEqual(
			expect.objectContaining({
				id: 'tasks',
				command: '/speckit.tasks',
				prompt: tasksPrompt,
				isCustom: false,
			})
		);
		expect(getSpeckitCommandBySlash('/speckit.implement')).toEqual(
			expect.objectContaining({
				id: 'implement',
				prompt: speckitImplementPrompt,
				isCustom: true,
			})
		);
		expect(getSpeckitCommand('missing')).toBeUndefined();
		expect(getSpeckitCommandBySlash('/speckit.missing')).toBeUndefined();
		for (const prompt of [
			speckitHelpPrompt,
			constitutionPrompt,
			specifyPrompt,
			clarifyPrompt,
			planPrompt,
			tasksPrompt,
			analyzePrompt,
			checklistPrompt,
			tasksToIssuesPrompt,
			speckitImplementPrompt,
		]) {
			expect(prompt.trim().length).toBeGreaterThan(20);
		}
	});

	it('exposes spec-kit metadata from the bundled manifest', () => {
		expect(getSpeckitMetadata()).toEqual(
			expect.objectContaining({
				lastRefreshed: expect.any(String),
				commitSha: expect.any(String),
				sourceVersion: expect.any(String),
				sourceUrl: expect.stringContaining('spec-kit'),
			})
		);
	});
});
