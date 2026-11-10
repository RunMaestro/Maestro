/**
 * Integrity check for the conductor-notes paragraph in src/prompts/autorun-goal.md.
 *
 * The goal runner prepends steering notes to the next iteration prompt inside a
 * block opened by STEERING_BLOCK_START. A goal-mode agent that was never told
 * what that block means can treat it as noise, or rank it below the predecessor
 * handoff. This test is the tripwire for an edit that drops the briefing or
 * drifts from the marker the runner actually writes.
 */

import { describe, expect, test } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { STEERING_BLOCK_START } from '../../shared/autorunSteering';

const PROMPT_PATH = path.join(__dirname, '../../prompts/autorun-goal.md');
// A Windows checkout gives the file CRLF line endings.
const prompt = readFileSync(PROMPT_PATH, 'utf-8').replace(/\r\n/g, '\n');

describe('autorun-goal.md conductor steering notes', () => {
	test('names the block marker the goal runner writes', () => {
		expect(prompt).toContain('**Conductor steering notes.**');
		expect(prompt).toContain(`\`${STEERING_BLOCK_START}\``);
	});

	test('ranks a note above the predecessor handoff', () => {
		expect(prompt).toContain('after the predecessor handoff, so it outranks all of them');
	});

	test('sits inside How Goal-Driven Mode Works', () => {
		const section = prompt.indexOf('## How Goal-Driven Mode Works');
		expect(section).toBeGreaterThan(-1);
		expect(prompt.indexOf('**Conductor steering notes.**')).toBeGreaterThan(section);
	});
});
