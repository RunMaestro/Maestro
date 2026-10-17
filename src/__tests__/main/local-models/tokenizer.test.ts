/**
 * @file tokenizer.test.ts
 *
 * The Local Models tokenizer loader, run against the real `tokenizer.json` of
 * bge-small-en-v1.5 (fixture pinned to Xenova/bge-small-en-v1.5 at revision
 * ea104dacec62c0de699686887e3f920caeb4f3e3). The ids asserted here are the
 * standard bert-base-uncased vocabulary ids, so a regression in the library or
 * in the truncation layout shows up as a wrong number, not a vague mismatch.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
	clearTokenizerCache,
	createLocalTokenizer,
	loadTokenizer,
	padTokenizedRows,
	TOKENIZER_CONFIG_FILENAME,
	TOKENIZER_FILENAME,
} from '../../../main/local-models/tokenizer';

const FIXTURE_DIR = path.resolve(__dirname, '../../fixtures/tokenizers/bge-small-en-v1.5');

const ids = (values: BigInt64Array | undefined) => Array.from(values ?? [], Number);

describe('loadTokenizer', () => {
	beforeEach(() => clearTokenizerCache());

	it('encodes a known sentence to the WordPiece ids the model was trained on', async () => {
		const tokenizer = await loadTokenizer(FIXTURE_DIR);
		const encoded = tokenizer.encode('How do I rename a tab?');

		expect(ids(encoded.inputIds)).toEqual([
			101, 2129, 2079, 1045, 14916, 14074, 1037, 21628, 1029, 102,
		]);
		expect(ids(encoded.attentionMask)).toEqual(new Array(10).fill(1));
		expect(ids(encoded.tokenTypeIds)).toEqual(new Array(10).fill(0));
		expect(encoded.inputIds).toBeInstanceOf(BigInt64Array);
	});

	it('reads model_max_length from tokenizer_config.json', async () => {
		const tokenizer = await loadTokenizer(FIXTURE_DIR);
		expect(tokenizer.modelMaxLength).toBe(512);
	});

	it('caches per directory and returns the same tokenizer', async () => {
		const first = await loadTokenizer(FIXTURE_DIR);
		const second = await loadTokenizer(FIXTURE_DIR + path.sep);
		expect(second).toBe(first);
		clearTokenizerCache(FIXTURE_DIR);
		expect(await loadTokenizer(FIXTURE_DIR)).not.toBe(first);
	});

	it('works without a tokenizer_config.json and records no window', async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tok-'));
		try {
			await fs.copyFile(
				path.join(FIXTURE_DIR, TOKENIZER_FILENAME),
				path.join(dir, TOKENIZER_FILENAME)
			);
			const tokenizer = await loadTokenizer(dir);
			expect(tokenizer.modelMaxLength).toBeUndefined();
			expect(ids(tokenizer.encode('Hello, World!').inputIds)).toEqual([
				101, 7592, 1010, 2088, 999, 102,
			]);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it('does not cache a failed load, so a repaired install is picked up', async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tok-'));
		try {
			await expect(loadTokenizer(dir)).rejects.toThrow();
			await fs.copyFile(
				path.join(FIXTURE_DIR, TOKENIZER_FILENAME),
				path.join(dir, TOKENIZER_FILENAME)
			);
			await expect(loadTokenizer(dir)).resolves.toBeDefined();
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});

describe('truncation', () => {
	let definition: object;
	let config: Record<string, unknown>;

	beforeEach(async () => {
		definition = JSON.parse(await fs.readFile(path.join(FIXTURE_DIR, TOKENIZER_FILENAME), 'utf8'));
		config = JSON.parse(
			await fs.readFile(path.join(FIXTURE_DIR, TOKENIZER_CONFIG_FILENAME), 'utf8')
		);
	});

	it('shortens the content and keeps the trailing [SEP]', () => {
		const tokenizer = createLocalTokenizer(FIXTURE_DIR, definition, config);
		const encoded = tokenizer.encode('How do I rename a tab?', { maxLength: 5 });
		expect(ids(encoded.inputIds)).toEqual([101, 2129, 2079, 1045, 102]);
		expect(ids(encoded.attentionMask)).toEqual([1, 1, 1, 1, 1]);
		expect(ids(encoded.tokenTypeIds)).toEqual([0, 0, 0, 0, 0]);
	});

	it('returns the full sequence when truncation is off', () => {
		const tokenizer = createLocalTokenizer(FIXTURE_DIR, definition, config);
		const encoded = tokenizer.encode('How do I rename a tab?', { maxLength: 5, truncation: false });
		expect(encoded.inputIds.length).toBe(10);
	});

	it('defaults maxLength to the model window', () => {
		const tokenizer = createLocalTokenizer(FIXTURE_DIR, definition, {
			...config,
			model_max_length: 4,
		});
		expect(ids(tokenizer.encode('Hello, World!').inputIds)).toEqual([101, 7592, 1010, 102]);
	});

	it('treats the transformers "no limit" sentinel as no window', () => {
		const tokenizer = createLocalTokenizer(FIXTURE_DIR, definition, {
			...config,
			model_max_length: 1e30,
		});
		expect(tokenizer.modelMaxLength).toBeUndefined();
		expect(tokenizer.encode('Hello, World!').inputIds.length).toBe(6);
	});

	it('refuses a maxLength with no room left for content', () => {
		const tokenizer = createLocalTokenizer(FIXTURE_DIR, definition, config);
		expect(() => tokenizer.encode('How do I rename a tab?', { maxLength: 2 })).toThrow(/no room/);
	});
});

describe('countTokens', () => {
	it('counts content tokens only, leaving out the special tokens', async () => {
		const tokenizer = await loadTokenizer(FIXTURE_DIR);
		// [CLS] how do i ren ##ame a tab ? [SEP] is 10 ids, 8 of them content.
		expect(tokenizer.countTokens('How do I rename a tab?')).toBe(8);
		expect(tokenizer.countTokens('')).toBe(0);
	});

	it('is not truncated at the model window', async () => {
		const tokenizer = await loadTokenizer(FIXTURE_DIR);
		expect(tokenizer.countTokens('tab '.repeat(900))).toBe(900);
	});

	it('adds up across whitespace, so a chunker can sum sentences', async () => {
		const tokenizer = await loadTokenizer(FIXTURE_DIR);
		const first = 'How do I rename a tab? ';
		const second = 'Hello, World!';
		expect(tokenizer.countTokens(first + second)).toBe(
			tokenizer.countTokens(first) + tokenizer.countTokens(second)
		);
	});
});

describe('batching', () => {
	let definition: object;
	let config: Record<string, unknown>;

	beforeEach(async () => {
		definition = JSON.parse(await fs.readFile(path.join(FIXTURE_DIR, TOKENIZER_FILENAME), 'utf8'));
		config = JSON.parse(
			await fs.readFile(path.join(FIXTURE_DIR, TOKENIZER_CONFIG_FILENAME), 'utf8')
		);
	});

	it('reads the pad id from the configured pad_token', () => {
		const tokenizer = createLocalTokenizer(FIXTURE_DIR, definition, config);
		expect(tokenizer.padTokenId).toBe(0); // [PAD] in the BERT vocabulary
	});

	it('prefers the padding block, and accepts an AddedToken-shaped pad_token', () => {
		const withBlock = createLocalTokenizer(
			FIXTURE_DIR,
			{ ...definition, padding: { pad_id: 7 } },
			config
		);
		expect(withBlock.padTokenId).toBe(7);
		const withObject = createLocalTokenizer(FIXTURE_DIR, definition, {
			...config,
			pad_token: { content: '[SEP]' },
		});
		expect(withObject.padTokenId).toBe(102);
	});

	it('pads every row to the longest on the right, masking the padding out', () => {
		const tokenizer = createLocalTokenizer(FIXTURE_DIR, definition, config);
		const batch = tokenizer.encodeBatch(['Hello, World!', 'How do I rename a tab?']);

		expect(batch.batchSize).toBe(2);
		expect(batch.sequenceLength).toBe(10);
		expect(ids(batch.inputIds)).toEqual([
			101, 7592, 1010, 2088, 999, 102, 0, 0, 0, 0, 101, 2129, 2079, 1045, 14916, 14074, 1037, 21628,
			1029, 102,
		]);
		expect(ids(batch.attentionMask)).toEqual([
			1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
		]);
		expect(ids(batch.tokenTypeIds)).toEqual(new Array(20).fill(0));
	});

	it('truncates each row before padding', () => {
		const tokenizer = createLocalTokenizer(FIXTURE_DIR, definition, config);
		const batch = tokenizer.encodeBatch(['How do I rename a tab?'], { maxLength: 5 });
		expect(ids(batch.inputIds)).toEqual([101, 2129, 2079, 1045, 102]);
	});

	it('refuses an empty batch', () => {
		const tokenizer = createLocalTokenizer(FIXTURE_DIR, definition, config);
		expect(() => tokenizer.encodeBatch([])).toThrow(/empty batch/);
	});
});

describe('windows', () => {
	let definition: object;
	let config: Record<string, unknown>;

	beforeEach(async () => {
		definition = JSON.parse(await fs.readFile(path.join(FIXTURE_DIR, TOKENIZER_FILENAME), 'utf8'));
		config = JSON.parse(
			await fs.readFile(path.join(FIXTURE_DIR, TOKENIZER_CONFIG_FILENAME), 'utf8')
		);
	});

	// "How do I rename a tab?" is 8 content tokens:
	// 2129 2079 1045 14916 14074 1037 21628 1029.

	it('returns one window for a text that fits', () => {
		const tokenizer = createLocalTokenizer(FIXTURE_DIR, definition, config);
		const windows = tokenizer.encodeWindows('How do I rename a tab?', {
			maxLength: 10,
			overlap: 2,
		});
		expect(windows.map((window) => ids(window.inputIds))).toEqual([
			[101, 2129, 2079, 1045, 14916, 14074, 1037, 21628, 1029, 102],
		]);
	});

	it('covers every token in overlapping windows, each wrapped in [CLS] ... [SEP]', () => {
		const tokenizer = createLocalTokenizer(FIXTURE_DIR, definition, config);
		const windows = tokenizer.encodeWindows('How do I rename a tab?', { maxLength: 6, overlap: 1 });

		expect(windows.map((window) => ids(window.inputIds))).toEqual([
			[101, 2129, 2079, 1045, 14916, 102],
			[101, 14916, 14074, 1037, 21628, 102],
			[101, 21628, 1029, 102],
		]);
		for (const window of windows) {
			expect(ids(window.attentionMask).every((value) => value === 1)).toBe(true);
			expect(ids(window.tokenTypeIds)).toEqual(new Array(window.inputIds.length).fill(0));
		}
	});

	it('clamps an overlap that would stop the walk moving forward', () => {
		const tokenizer = createLocalTokenizer(FIXTURE_DIR, definition, config);
		const clamped = tokenizer.encodeWindows('How do I rename a tab?', {
			maxLength: 6,
			overlap: 100,
		});
		const exact = tokenizer.encodeWindows('How do I rename a tab?', { maxLength: 6, overlap: 1 });
		expect(clamped.map((window) => ids(window.inputIds))).toEqual(
			exact.map((window) => ids(window.inputIds))
		);
	});

	it('steps a full window at a time with no overlap', () => {
		const tokenizer = createLocalTokenizer(FIXTURE_DIR, definition, config);
		const windows = tokenizer.encodeWindows('How do I rename a tab?', { maxLength: 6, overlap: 0 });
		expect(windows.map((window) => ids(window.inputIds))).toEqual([
			[101, 2129, 2079, 1045, 14916, 102],
			[101, 14074, 1037, 21628, 1029, 102],
		]);
	});

	it('pads windows into one batch, and refuses an empty one', () => {
		const tokenizer = createLocalTokenizer(FIXTURE_DIR, definition, config);
		const windows = tokenizer.encodeWindows('How do I rename a tab?', { maxLength: 6, overlap: 1 });
		const batch = padTokenizedRows(windows, tokenizer.padTokenId);
		expect(batch.batchSize).toBe(3);
		expect(batch.sequenceLength).toBe(6);
		expect(ids(batch.inputIds).slice(12)).toEqual([101, 21628, 1029, 102, 0, 0]);
		expect(ids(batch.attentionMask).slice(12)).toEqual([1, 1, 1, 1, 0, 0]);
		expect(() => padTokenizedRows([], 0)).toThrow(/empty batch/);
	});
});
