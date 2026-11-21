/**
 * Integrity checks for the prompt include graph and the progressive-disclosure
 * budget.
 *
 * Both loaders leave an unknown `{{REF:name}}` or `{{INCLUDE:name}}` in place
 * rather than failing, so a typo or a forgotten CORE_PROMPTS entry ships a dead
 * link to every agent with no error anywhere. And prettier pads every markdown
 * table row to its widest cell: one long cell once inflated
 * `_interface-primitives.md` to 117K characters, almost all spaces, which every
 * agent that pulled the routing guide paid for in tokens.
 */

import { describe, expect, test } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { CORE_PROMPTS } from '../../shared/promptDefinitions';

const PROMPTS_DIR = path.join(__dirname, '../../prompts');
const read = (name: string) => readFileSync(path.join(PROMPTS_DIR, name), 'utf-8');
const promptFiles = readdirSync(PROMPTS_DIR).filter((f) => f.endsWith('.md'));
const registered = new Map(CORE_PROMPTS.map((p) => [p.id, p.filename]));

/** Include names start with `_` by convention; `{{REF:name}}` in docs prose does not. */
const DIRECTIVE = /\{\{(?:REF|INCLUDE):(_[a-zA-Z0-9-]+)\}\}/g;

/** Placeholder names prose uses to describe the directive itself (`_maestro-cli` shows `{{REF:_name}}`). */
const DOC_PLACEHOLDERS = new Set(['_name']);

/** Longest line a prompt may carry. Real prose stays well under it; table padding does not. */
const MAX_LINE_LENGTH = 2000;

describe('prompt include graph', () => {
	test('every registered prompt has a file on disk', () => {
		for (const { filename } of CORE_PROMPTS) {
			expect(promptFiles).toContain(filename);
		}
	});

	test('every include file on disk is registered', () => {
		const includes = promptFiles.filter((f) => f.startsWith('_'));
		for (const file of includes) {
			expect(registered.get(file.replace(/\.md$/, ''))).toBe(file);
		}
	});

	test.each(promptFiles)('%s references only registered includes', (file) => {
		for (const [, name] of read(file).matchAll(DIRECTIVE)) {
			if (DOC_PLACEHOLDERS.has(name)) continue;
			expect(registered.has(name), `${file} references unknown include ${name}`).toBe(true);
		}
	});
});

describe('progressive-disclosure budget', () => {
	test.each(promptFiles)('%s has no padded line', (file) => {
		const longest = Math.max(
			...read(file)
				.split('\n')
				.map((line) => line.length)
		);
		expect(longest).toBeLessThanOrEqual(MAX_LINE_LENGTH);
	});

	test('the main system prompt links the split-out includes instead of inlining them', () => {
		const prompt = read('maestro-system-prompt.md');
		for (const name of ['_terminals', '_media-playback', '_interface-primitives']) {
			expect(prompt).toContain(`{{REF:${name}}}`);
			expect(prompt).not.toContain(`{{INCLUDE:${name}}}`);
		}
	});

	test('the Concerto guide is linked only from the gated Concerto section', () => {
		// Concerto is an Encore Feature: a switched-off feature leaves no trace in the base prompt.
		expect(read('maestro-system-prompt.md')).not.toContain('_concerto');
		expect(read('concerto-system.md')).toContain('{{REF:_concerto}}');
		expect(read('concerto-system.md')).not.toContain('{{INCLUDE:_concerto}}');
	});
});

describe('stall avoidance', () => {
	test('the main system prompt does the work before it asks', () => {
		expect(read('maestro-system-prompt.md')).toMatch(/Finish first, ask last/);
	});

	test('the Auto Run executor self-heals and defers before it gates', () => {
		const prompt = read('autorun-default.md');
		const selfHeal = prompt.indexOf('**Self-heal');
		const defer = prompt.indexOf('**Defer');
		const gate = prompt.indexOf('**Gate in place');
		expect(selfHeal).toBeGreaterThan(-1);
		expect(defer).toBeGreaterThan(selfHeal);
		expect(gate).toBeGreaterThan(defer);
	});

	test.each([
		'_autorun-playbooks.md',
		'wizard-document-generation.md',
		'wizard-inline-iterate-generation.md',
	])('%s tells authors to push human steps late', (file) => {
		expect(read(file)).toMatch(/push (it|what remains) late/i);
	});
});

describe('mockups', () => {
	test('the shared chat-rendering include sends static mockups to inline SVG', () => {
		expect(read('_rich-chat-rendering.md')).toMatch(/Inline SVG:.*UI mockups and layout options/);
	});
});
