/**
 * Integrity checks for the Group Chat moderator prompts.
 *
 * The chat has a moderator-only view that hides every participant message, so
 * the moderator cannot assume the user read what an agent said. A moderator that
 * wrote "answer Q1-Q3" about questions that lived only in a hidden agent reply,
 * or in a plan file, left the user unable to answer. Both prompts must keep
 * telling the moderator to restate what it references. These tests are the
 * tripwire for anyone who trims that section.
 */

import { describe, expect, test } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

const PROMPTS_DIR = path.join(__dirname, '../../prompts');
const read = (name: string) => readFileSync(path.join(PROMPTS_DIR, name), 'utf-8');

describe.each([
	['group-chat-moderator-system.md', read('group-chat-moderator-system.md')],
	['group-chat-moderator-synthesis.md', read('group-chat-moderator-synthesis.md')],
])('%s', (_name, prompt) => {
	test('warns that the user may see only the moderator', () => {
		expect(prompt).toMatch(/moderator-only view/);
	});

	test('requires restating referenced items the user cannot see', () => {
		expect(prompt).toMatch(/Q1-Q3/);
		expect(prompt).toMatch(/spelled out in a message YOU sent/);
	});
});
