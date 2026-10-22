/**
 * Integrity check for the steering rule in src/prompts/maestro-system-prompt.md.
 *
 * A steer reaches the agent inside its running turn. Maestro keeps only the
 * turn's final reply in the transcript; text written between tool calls is a
 * live preview that is dropped when the turn ends. An agent that answers a steer
 * only in that narration looks, to the user, like it ignored the steer. This
 * test is the tripwire for an edit that drops the rule.
 */

import { describe, expect, test } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

const PROMPT_PATH = path.join(__dirname, '../../prompts/maestro-system-prompt.md');
// A Windows checkout gives the file CRLF line endings.
const prompt = readFileSync(PROMPT_PATH, 'utf-8').replace(/\r\n/g, '\n');

describe('maestro-system-prompt.md steering rule', () => {
	test('tells the agent to answer mid-turn messages in its final reply', () => {
		expect(prompt).toContain('**Messages sent while you work:**');
		expect(prompt).toContain('Answer every such message in your final reply');
	});

	test('says why: narration between tool calls is not kept', () => {
		expect(prompt).toContain('Maestro does not keep it in the transcript');
	});
});
