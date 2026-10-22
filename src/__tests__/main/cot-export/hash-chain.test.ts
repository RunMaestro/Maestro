/**
 * Tests for main/cot-export/hash-chain.ts.
 *
 * A log file is never rewritten, so the hash a record gets today is the hash
 * every later reader has to arrive at. These tests pin what the hash covers,
 * and show that any change to a sealed record, however small, shows up.
 */

import { createHash } from 'crypto';
import { describe, it, expect } from 'vitest';
import {
	isLinked,
	readChainLink,
	recomputeHash,
	sealRecord,
	sha256Hex,
} from '../../../main/cot-export/hash-chain';
import { COT_EXPORT_FORMAT_VERSION, COT_GENESIS_HASH } from '../../../shared/cotExport/types';
import type { CotRecord, CotUnsealedRecord } from '../../../shared/cotExport/types';

const HEX_64 = /^[0-9a-f]{64}$/;

const TURN_START: CotUnsealedRecord = {
	v: COT_EXPORT_FORMAT_VERSION,
	kind: 'turn-start',
	agentId: 'agent-1',
	turnId: 'turn-1',
	seq: 0,
	chainSeq: 0,
	ts: '2026-10-10T12:00:00.000Z',
	toolType: 'claude-code',
	origin: 'interactive',
	tabId: 'tab-1',
	cwd: '/work/project',
	prompt: 'List the files.',
	imageCount: 0,
};

const THINKING: CotUnsealedRecord = {
	v: COT_EXPORT_FORMAT_VERSION,
	kind: 'thinking',
	agentId: 'agent-1',
	turnId: 'turn-1',
	seq: 1,
	chainSeq: 1,
	ts: '2026-10-10T12:00:01.000Z',
	text: 'The user wants a listing.',
	providerMessageId: 'msg_1',
	blockIndex: 0,
};

const TOOL_CALL: CotUnsealedRecord = {
	v: COT_EXPORT_FORMAT_VERSION,
	kind: 'tool-call',
	agentId: 'agent-1',
	turnId: 'turn-1',
	seq: 2,
	chainSeq: 2,
	ts: '2026-10-10T12:00:02.000Z',
	toolCallId: 'toolu_1',
	toolName: 'Bash',
	input: { command: 'ls -la', options: { timeout: 5000, flags: ['a', 'l'] } },
};

/** `record` as a reader gets it: written as one line, then parsed. */
function reread(record: CotRecord): CotRecord {
	return JSON.parse(JSON.stringify(record)) as CotRecord;
}

describe('sha256Hex', () => {
	it('gives the known digest of a string, as 64 lowercase hex characters', () => {
		// The SHA-256 test vector for "abc" (FIPS 180-2).
		expect(sha256Hex('abc')).toBe(
			'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
		);
	});

	it('hashes a string as its UTF-8 bytes', () => {
		expect(sha256Hex('café €')).toBe(sha256Hex(Buffer.from('café €', 'utf8')));
	});
});

describe('sealRecord', () => {
	it('sets prevHash and a hash, and keeps every other field', () => {
		const sealed = sealRecord(TURN_START, COT_GENESIS_HASH);

		expect(sealed).toEqual({ ...TURN_START, prevHash: COT_GENESIS_HASH, hash: sealed.hash });
		expect(sealed.hash).toMatch(HEX_64);
	});

	it('does not change the record it was given', () => {
		const before = JSON.stringify(TOOL_CALL);

		sealRecord(TOOL_CALL, COT_GENESIS_HASH);

		expect(JSON.stringify(TOOL_CALL)).toBe(before);
		expect(TOOL_CALL).not.toHaveProperty('hash');
		expect(TOOL_CALL).not.toHaveProperty('prevHash');
	});

	it('hashes prevHash, a newline, and the canonical JSON of the record without its hash', () => {
		const unsealed: CotUnsealedRecord = {
			v: COT_EXPORT_FORMAT_VERSION,
			kind: 'capture-gap',
			agentId: 'agent-1',
			turnId: 'turn-1',
			seq: 0,
			chainSeq: 0,
			ts: '2026-10-10T12:00:00.000Z',
			reason: 'write-failed:ENOSPC',
			droppedRecords: 2,
		};

		// Written out by hand, not built with canonicalJson, so this fails if
		// either the canonical form or the layout of the hash input ever moves.
		// Every log already on disk depends on both.
		const canonical =
			'{"agentId":"agent-1","chainSeq":0,"droppedRecords":2,"kind":"capture-gap",' +
			`"prevHash":"${COT_GENESIS_HASH}","reason":"write-failed:ENOSPC","seq":0,` +
			'"ts":"2026-10-10T12:00:00.000Z","turnId":"turn-1","v":1}';
		const expected = createHash('sha256')
			.update(`${COT_GENESIS_HASH}\n${canonical}`, 'utf8')
			.digest('hex');

		expect(sealRecord(unsealed, COT_GENESIS_HASH).hash).toBe(expected);
		expect(expected).toBe('2f12bb496e0481311c9ab20aeb3a3be45ebc0f66c2a092d6bb394cdf078917de');
	});

	it('gives the same record a different hash after a different predecessor', () => {
		const afterGenesis = sealRecord(THINKING, COT_GENESIS_HASH);
		const afterAnother = sealRecord(THINKING, 'a'.repeat(64));

		expect(afterAnother.hash).not.toBe(afterGenesis.hash);
	});

	it('gives the same hash whatever order the fields were built in', () => {
		const reversed = Object.fromEntries(Object.entries(TOOL_CALL).reverse()) as CotUnsealedRecord;

		expect(sealRecord(reversed, COT_GENESIS_HASH).hash).toBe(
			sealRecord(TOOL_CALL, COT_GENESIS_HASH).hash
		);
	});

	it('treats an optional field set to undefined as a field that is not there', () => {
		// The line on disk has no such field either way, so the two must seal to
		// one hash or the record would fail when it is read back.
		const { tabId: _tabId, ...withoutTab } = TURN_START as Extract<
			CotUnsealedRecord,
			{ kind: 'turn-start' }
		>;
		const withUndefinedTab: CotUnsealedRecord = { ...withoutTab, tabId: undefined };

		expect(sealRecord(withUndefinedTab, COT_GENESIS_HASH).hash).toBe(
			sealRecord(withoutTab, COT_GENESIS_HASH).hash
		);
	});

	it('seals a record that was already sealed to the same result as its unsealed form', () => {
		const stale = sealRecord(THINKING, 'b'.repeat(64));

		expect(sealRecord(stale, COT_GENESIS_HASH)).toEqual(sealRecord(THINKING, COT_GENESIS_HASH));
	});

	it('throws on a value that has no JSON form, and does not seal it as something else', () => {
		const badUsage: CotUnsealedRecord = {
			v: COT_EXPORT_FORMAT_VERSION,
			kind: 'usage',
			agentId: 'agent-1',
			turnId: 'turn-1',
			seq: 3,
			chainSeq: 3,
			ts: '2026-10-10T12:00:03.000Z',
			usage: {
				inputTokens: 10,
				outputTokens: 20,
				cacheReadInputTokens: 0,
				cacheCreationInputTokens: 0,
				totalCostUsd: NaN,
				contextWindow: 200000,
			},
		};

		expect(() => sealRecord(badUsage, COT_GENESIS_HASH)).toThrow(TypeError);
	});
});

describe('recomputeHash', () => {
	it('gives the hash the record was sealed with', () => {
		for (const unsealed of [TURN_START, THINKING, TOOL_CALL]) {
			const sealed = sealRecord(unsealed, COT_GENESIS_HASH);

			expect(recomputeHash(sealed)).toBe(sealed.hash);
		}
	});

	it('gives the same hash for a record read back from its line', () => {
		const sealed = sealRecord(TOOL_CALL, COT_GENESIS_HASH);

		expect(recomputeHash(reread(sealed))).toBe(sealed.hash);
	});

	it('gives the same hash for a line whose keys were written in another order', () => {
		const sealed = sealRecord(TOOL_CALL, COT_GENESIS_HASH);
		const reordered = Object.fromEntries(Object.entries(sealed).reverse()) as CotRecord;

		expect(recomputeHash(reread(reordered))).toBe(sealed.hash);
	});

	it('changes when one character of a sealed record changes', () => {
		const sealed = sealRecord(THINKING, COT_GENESIS_HASH) as Extract<
			CotRecord,
			{ kind: 'thinking' }
		>;
		const edited: CotRecord = { ...sealed, text: 'The user wants a listing!' };

		expect(edited.text).toHaveLength(sealed.text.length);
		expect(recomputeHash(edited)).not.toBe(sealed.hash);
	});

	/** The parsed line of a sealed `tool-call`, loose enough to edit any part of. */
	interface EditableLine {
		[field: string]: unknown;
		input: { command: string; options: { timeout: number; flags: string[] } };
	}

	it.each<[string, (line: EditableLine) => void]>([
		['its position within the turn', (line) => (line.seq = 3)],
		['its position in the chain', (line) => (line.chainSeq = 3)],
		['its timestamp', (line) => (line.ts = '2026-10-10T12:00:02.001Z')],
		['its agent id', (line) => (line.agentId = 'agent-2')],
		['its turn id', (line) => (line.turnId = 'turn-2')],
		['its kind', (line) => (line.kind = 'tool-result')],
		['its prevHash', (line) => (line.prevHash = 'c'.repeat(64))],
		['a value deep inside its tool input', (line) => (line.input.options.timeout = 5001)],
		['the order of an array inside its tool input', (line) => line.input.options.flags.reverse()],
		['an added field', (line) => (line.extra = true)],
		['a removed field', (line) => delete line.toolCallId],
	])('changes when %s is edited', (_what, edit) => {
		const sealed = sealRecord(TOOL_CALL, COT_GENESIS_HASH);
		const line = reread(sealed) as unknown as EditableLine;

		edit(line);

		expect(recomputeHash(line as unknown as CotRecord)).not.toBe(sealed.hash);
	});

	it('does not read the stored hash, so a changed hash shows as a mismatch', () => {
		const sealed = sealRecord(THINKING, COT_GENESIS_HASH);
		const forged: CotRecord = { ...sealed, hash: 'f'.repeat(64) };

		expect(recomputeHash(forged)).toBe(sealed.hash);
		expect(recomputeHash(forged)).not.toBe(forged.hash);
	});
});

describe('isLinked', () => {
	it('links the first record of a chain to COT_GENESIS_HASH', () => {
		const first = sealRecord(TURN_START, COT_GENESIS_HASH);

		expect(first.prevHash).toBe(COT_GENESIS_HASH);
		expect(isLinked(first, COT_GENESIS_HASH)).toBe(true);
	});

	it('links each record to the hash of the one before it', () => {
		const first = sealRecord(TURN_START, COT_GENESIS_HASH);
		const second = sealRecord(THINKING, first.hash);
		const third = sealRecord(TOOL_CALL, second.hash);

		expect(isLinked(second, first.hash)).toBe(true);
		expect(isLinked(third, second.hash)).toBe(true);
	});

	it('does not link a record to any other hash', () => {
		const first = sealRecord(TURN_START, COT_GENESIS_HASH);
		const second = sealRecord(THINKING, first.hash);
		const third = sealRecord(TOOL_CALL, second.hash);

		// A record removed from between two others.
		expect(isLinked(third, first.hash)).toBe(false);
		// A record moved to the front of the chain.
		expect(isLinked(second, COT_GENESIS_HASH)).toBe(false);
	});

	it('breaks the link to the next record when an edited record is sealed again', () => {
		const first = sealRecord(TURN_START, COT_GENESIS_HASH);
		const second = sealRecord(THINKING, first.hash);

		// Someone rewrites the prompt and seals the record again, so the edited
		// record passes its own hash check.
		const rewritten = sealRecord({ ...TURN_START, prompt: 'Delete the files.' }, COT_GENESIS_HASH);

		expect(recomputeHash(rewritten)).toBe(rewritten.hash);
		expect(isLinked(second, rewritten.hash)).toBe(false);
	});

	it('needs only the prevHash of a record', () => {
		expect(isLinked({ prevHash: 'd'.repeat(64) }, 'd'.repeat(64))).toBe(true);
		expect(isLinked({ prevHash: 'd'.repeat(64) }, 'D'.repeat(64))).toBe(false);
	});
});

describe('readChainLink', () => {
	it('reads the chain fields of a sealed record back from its line', () => {
		const first = sealRecord(TURN_START, COT_GENESIS_HASH);
		const second = sealRecord(THINKING, first.hash);
		expect(readChainLink(JSON.stringify(second))).toEqual({
			chainSeq: 1,
			prevHash: first.hash,
			hash: second.hash,
			intact: true,
		});
	});

	it('reads the same link whatever order the keys were written in', () => {
		const sealed = sealRecord(TOOL_CALL, COT_GENESIS_HASH);
		const reversed = Object.fromEntries(Object.entries(sealed).reverse());
		expect(readChainLink(JSON.stringify(reversed))).toEqual(readChainLink(JSON.stringify(sealed)));
	});

	it('marks a record whose content was changed after it was sealed', () => {
		const sealed = sealRecord(TURN_START, COT_GENESIS_HASH);
		const edited = JSON.stringify(sealed).replace('List the files.', 'Delete the files.');
		expect(readChainLink(edited)).toEqual({
			chainSeq: 0,
			prevHash: COT_GENESIS_HASH,
			hash: sealed.hash,
			intact: false,
		});
	});

	it('marks a record whose hash was replaced', () => {
		const sealed = sealRecord(TURN_START, COT_GENESIS_HASH);
		const link = readChainLink(JSON.stringify({ ...sealed, hash: 'e'.repeat(64) }));
		expect(link).toMatchObject({ hash: 'e'.repeat(64), intact: false });
	});

	it('gives null for a line that is not a record', () => {
		const sealed = sealRecord(TURN_START, COT_GENESIS_HASH);
		const line = JSON.stringify(sealed);
		// Blank, cut short, and JSON that is not an object.
		expect(readChainLink('')).toBeNull();
		expect(readChainLink('   ')).toBeNull();
		expect(readChainLink(line.slice(0, 40))).toBeNull();
		expect(readChainLink('null')).toBeNull();
		expect(readChainLink('42')).toBeNull();
		expect(readChainLink('"text"')).toBeNull();
		expect(readChainLink(JSON.stringify([sealed]))).toBeNull();
		// An object without usable chain fields.
		expect(readChainLink('{}')).toBeNull();
		expect(readChainLink(JSON.stringify({ ...sealed, chainSeq: '0' }))).toBeNull();
		expect(readChainLink(JSON.stringify({ ...sealed, chainSeq: 0.5 }))).toBeNull();
		expect(readChainLink(JSON.stringify({ ...sealed, prevHash: undefined }))).toBeNull();
		expect(readChainLink(JSON.stringify({ ...sealed, hash: 7 }))).toBeNull();
	});

	it('does not throw for a number that JSON reads as infinite', () => {
		const sealed = sealRecord(TURN_START, COT_GENESIS_HASH);
		const line = JSON.stringify(sealed).replace('"imageCount":0', '"imageCount":1e999');
		expect(readChainLink(line)).toMatchObject({ chainSeq: 0, intact: false });
	});
});
