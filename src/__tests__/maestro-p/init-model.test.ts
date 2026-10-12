/**
 * @file init-model.test.ts
 * @description Tests for src/maestro-p/init-model.ts - which transcript row
 * names the model maestro-p's init envelope reports.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
	initModelFromEntry,
	lastModelAttachment,
	resolveInitModel,
	sameModel,
} from '../../maestro-p/init-model';

// Shape captured from a real TUI transcript (claude 2.1.296).
const modelAttachment = (modelId: string) => ({
	type: 'attachment',
	attachment: {
		type: 'model',
		identity: { modelId, marketingName: 'Opus 5.5 (1M context)' },
		text: `The exact model ID is ${modelId}.`,
	},
});

describe('initModelFromEntry', () => {
	it('takes the exact id, [1m] included, from the model attachment', () => {
		expect(initModelFromEntry(modelAttachment('claude-opus-5-5[1m]'))).toEqual({
			model: 'claude-opus-5-5[1m]',
		});
	});

	it('takes the model an assistant row answered with', () => {
		expect(
			initModelFromEntry({ type: 'assistant', message: { model: 'claude-sonnet-5-5' } })
		).toEqual({ model: 'claude-sonnet-5-5' });
	});

	// A limit or API-error notice still ends the wait: the turn is over.
	it('releases init with no model on a synthetic assistant row', () => {
		expect(initModelFromEntry({ type: 'assistant', message: { model: '<synthetic>' } })).toEqual({
			model: null,
		});
	});

	it('releases init with no model on a local slash command output row', () => {
		expect(
			initModelFromEntry({
				type: 'user',
				message: { role: 'user', content: '<local-command-stdout>done</local-command-stdout>' },
			})
		).toEqual({ model: null });
	});

	it('keeps init waiting on the prompt echo and other attachments', () => {
		expect(initModelFromEntry({ type: 'user', message: { role: 'user', content: 'hi' } })).toBe(
			null
		);
		expect(initModelFromEntry({ type: 'attachment', attachment: { type: 'environment' } })).toBe(
			null
		);
		expect(initModelFromEntry(null)).toBe(null);
	});
});

describe('resolveInitModel', () => {
	// A resumed session gets no attachment, and the assistant row drops `[1m]`.
	it('keeps the [1m] id an earlier turn recorded for the same model', () => {
		expect(resolveInitModel('claude-opus-5-5', 'claude-opus-5-5[1m]')).toBe('claude-opus-5-5[1m]');
	});

	it('takes the live model when the session switched models', () => {
		expect(resolveInitModel('claude-sonnet-5-5', 'claude-opus-5-5[1m]')).toBe('claude-sonnet-5-5');
	});

	it('falls back to the recorded id when the trigger named none', () => {
		expect(resolveInitModel(null, 'claude-opus-5-5[1m]')).toBe('claude-opus-5-5[1m]');
		expect(resolveInitModel(null, null)).toBe(null);
	});
});

describe('sameModel', () => {
	it('ignores the window marker and a date suffix', () => {
		expect(sameModel('claude-opus-5-5[1m]', 'claude-opus-5-5')).toBe(true);
		expect(sameModel('claude-haiku-4-5-20251001', 'claude-haiku-4-5')).toBe(true);
		expect(sameModel('claude-opus-5-5', 'claude-sonnet-5-5')).toBe(false);
	});
});

describe('lastModelAttachment', () => {
	let dir: string;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-p-init-model-'));
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('returns the newest model attachment in the transcript', () => {
		const file = path.join(dir, 'session.jsonl');
		fs.writeFileSync(
			file,
			[
				modelAttachment('claude-sonnet-5-5'),
				{ type: 'assistant', message: { model: 'claude-sonnet-5-5' } },
				modelAttachment('claude-opus-5-5[1m]'),
				{ type: 'user', message: { content: 'model' } },
			]
				.map((row) => JSON.stringify(row))
				.join('\n') + '\n'
		);

		expect(lastModelAttachment(file)).toBe('claude-opus-5-5[1m]');
	});

	it('returns null for a transcript with none, or no transcript', () => {
		const file = path.join(dir, 'session.jsonl');
		fs.writeFileSync(file, JSON.stringify({ type: 'user' }) + '\n');

		expect(lastModelAttachment(file)).toBe(null);
		expect(lastModelAttachment(path.join(dir, 'missing.jsonl'))).toBe(null);
	});
});
