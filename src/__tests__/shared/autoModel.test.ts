/**
 * @file autoModel.test.ts
 *
 * `isTurnModelName`: whether a string can be one turn's model as a caller
 * typed it (`maestro-cli send --model`, the WS message `plugins_send_agent`).
 * The value becomes a launch argument, so the check is what keeps a flag or a
 * control character from reaching a harness.
 */

import { describe, it, expect } from 'vitest';

import { AUTO_MODEL, isAutoModel, isTurnModelName } from '../../shared/autoModel';

describe('isTurnModelName', () => {
	it.each([
		'sonnet',
		'opus',
		'gpt-6.1-sol',
		'claude-haiku-4-5-20251001',
		'qwen3:latest',
		'openrouter/anthropic/claude-sonnet-4.5',
		'claude-opus-4-5[1m]',
		'us.anthropic.claude-sonnet-4-5-v1:0',
		'x',
		'7',
	])('accepts the model name %j', (name) => {
		expect(isTurnModelName(name)).toBe(true);
	});

	it('accepts the word auto, in any case', () => {
		for (const word of [AUTO_MODEL, 'Auto', 'AUTO']) {
			expect(isTurnModelName(word)).toBe(true);
			expect(isAutoModel(word)).toBe(true);
		}
	});

	it('accepts a name with a space inside it', () => {
		expect(isTurnModelName('my local model')).toBe(true);
	});

	it.each(['-x', '--model', '-', '--dangerously-skip-permissions'])(
		'refuses %j: it would be read as a flag',
		(value) => {
			expect(isTurnModelName(value)).toBe(false);
		}
	);

	it('allows a hyphen anywhere but the start', () => {
		expect(isTurnModelName('a-b')).toBe(true);
		expect(isTurnModelName('a-')).toBe(true);
	});

	it('refuses an empty string and one that is only space', () => {
		expect(isTurnModelName('')).toBe(false);
		expect(isTurnModelName(' ')).toBe(false);
		expect(isTurnModelName('\t')).toBe(false);
	});

	it.each([' sonnet', 'sonnet ', '\tsonnet', 'sonnet\t', ' sonnet '])(
		'refuses %j: a name has no surrounding space',
		(value) => {
			expect(isTurnModelName(value)).toBe(false);
		}
	);

	it.each([
		['a line break', 'son\nnet'],
		['a trailing line break', 'sonnet\n'],
		['a carriage return', 'son\rnet'],
		['a tab inside', 'son\tnet'],
		['a NUL', 'son\x00net'],
		['an escape', 'son\x1bnet'],
		['a DEL', 'son\x7fnet'],
	])('refuses a name with %s', (_what, value) => {
		expect(isTurnModelName(value)).toBe(false);
	});

	it('holds a name to 200 characters', () => {
		expect(isTurnModelName('m'.repeat(200))).toBe(true);
		expect(isTurnModelName('m'.repeat(201))).toBe(false);
	});
});
