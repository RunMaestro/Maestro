/**
 * @file system-one-guide.test.ts
 * @description The registry of the System One guide: its topics, its recipes,
 * and the core prompts they are registered as.
 *
 * Properties worth protecting:
 *
 *   - **One declaration.** A topic declared in the registry is a registered
 *     core prompt with a file on disk, and a guide file on disk is a declared
 *     topic. Neither can exist without the other.
 *   - **A name is what an agent types**, so it is one lowercase word, used once.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

import {
	DEFAULT_SYSTEM_ONE_GUIDE_TOPIC,
	SYSTEM_ONE_EXAMPLES,
	SYSTEM_ONE_EXAMPLES_ALL,
	SYSTEM_ONE_GUIDE_PROMPT_CATEGORY,
	SYSTEM_ONE_GUIDE_TOPICS,
	findSystemOneExample,
	findSystemOneGuideTopic,
	systemOneExamplePromptId,
	systemOneGuidePromptDefinitions,
	systemOneGuidePromptId,
} from '../../../shared/local-models/system-one-guide';
import { CORE_PROMPTS, getPromptFilename } from '../../../shared/promptDefinitions';

const PROMPTS_DIR = path.resolve(__dirname, '../../../prompts');

describe('the System One guide registry', () => {
	it('declares the ten topics and the six recipes the playbook names', () => {
		expect(SYSTEM_ONE_GUIDE_TOPICS.map((entry) => entry.name)).toEqual([
			'when',
			'questions',
			'noul',
			'choice',
			'score',
			'state',
			'confidence',
			'patterns',
			'pitfalls',
			'limits',
		]);
		expect(SYSTEM_ONE_EXAMPLES.map((entry) => entry.name)).toEqual([
			'gutcheck',
			'triage',
			'rank',
			'verify',
			'screen',
			'dedupe',
		]);
	});

	it('names each entry with one lowercase word, used once, and gives it a title', () => {
		for (const entries of [SYSTEM_ONE_GUIDE_TOPICS, SYSTEM_ONE_EXAMPLES]) {
			const names = entries.map((entry) => entry.name);
			expect(new Set(names).size).toBe(names.length);
			for (const entry of entries) {
				expect(entry.name, entry.name).toMatch(/^[a-z]+$/);
				expect(entry.title.trim().length, entry.name).toBeGreaterThan(10);
			}
		}
	});

	it('prints the playbook by default, and keeps "all" for every recipe', () => {
		expect(findSystemOneGuideTopic(DEFAULT_SYSTEM_ONE_GUIDE_TOPIC)?.name).toBe('when');
		expect(findSystemOneExample(SYSTEM_ONE_EXAMPLES_ALL)).toBeUndefined();
	});

	it('finds a topic and a recipe by the word an agent typed', () => {
		expect(findSystemOneGuideTopic(' Pitfalls ')?.name).toBe('pitfalls');
		expect(findSystemOneGuideTopic('gutcheck')).toBeUndefined();
		expect(findSystemOneExample('DEDUPE')?.name).toBe('dedupe');
		expect(findSystemOneExample('pitfalls')).toBeUndefined();
		expect(findSystemOneExample('')).toBeUndefined();
	});

	it('registers one core prompt per topic and per recipe, each with its file', () => {
		const definitions = systemOneGuidePromptDefinitions();
		expect(definitions).toHaveLength(SYSTEM_ONE_GUIDE_TOPICS.length + SYSTEM_ONE_EXAMPLES.length);
		const ids = [
			...SYSTEM_ONE_GUIDE_TOPICS.map((entry) => systemOneGuidePromptId(entry.name)),
			...SYSTEM_ONE_EXAMPLES.map((entry) => systemOneExamplePromptId(entry.name)),
		];
		expect(definitions.map((definition) => definition.id)).toEqual(ids);
		for (const id of ids) {
			const registered = CORE_PROMPTS.filter((prompt) => prompt.id === id);
			expect(registered, id).toHaveLength(1);
			expect(registered[0].category).toBe(SYSTEM_ONE_GUIDE_PROMPT_CATEGORY);
			expect(registered[0].description).toContain('maestro-cli s1 ');
			expect(getPromptFilename(id)).toBe(`${id}.md`);
			expect(fs.existsSync(path.join(PROMPTS_DIR, `${id}.md`)), id).toBe(true);
		}
	});

	it('says in each description which command prints the prompt', () => {
		const described = (id: string) => CORE_PROMPTS.find((prompt) => prompt.id === id)?.description;
		expect(described('system-one-guide-when')).toContain('`maestro-cli s1 guide`');
		expect(described('system-one-guide-limits')).toContain('`maestro-cli s1 guide limits`');
		expect(described('system-one-example-dedupe')).toContain('`maestro-cli s1 examples dedupe`');
	});

	it('leaves no guide file on disk that the registry does not declare', () => {
		const declared = new Set(
			systemOneGuidePromptDefinitions().map((definition) => definition.filename)
		);
		const onDisk = fs
			.readdirSync(PROMPTS_DIR)
			.filter((name) => /^system-one-(guide|example)-.+\.md$/.test(name));
		expect(onDisk.sort()).toEqual([...declared].sort());
	});
});
