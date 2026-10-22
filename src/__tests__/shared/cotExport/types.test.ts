/**
 * Tests for shared/cotExport/types.ts.
 *
 * The module is types and constants, so there is little to run. What is worth
 * pinning is the part that ends up on disk: a log file is never rewritten, so
 * a constant that drifts makes every existing log read as broken.
 */

import { describe, it, expect } from 'vitest';
import {
	COT_EXPORT_FORMAT_VERSION,
	COT_GENESIS_CHAIN_SEQ,
	COT_GENESIS_HASH,
	COT_TOOL_OUTPUT_CAP_BYTES,
} from '../../../shared/cotExport/types';
import type {
	CotChainState,
	CotRecord,
	CotRecordBase,
	CotRecordKind,
	CotUnsealedRecord,
} from '../../../shared/cotExport/types';

const SAMPLE_HASH = 'a'.repeat(64);

/** The fields every record shares, for the record at position `seq`. */
function base(seq: number): Omit<CotRecordBase, 'kind'> {
	return {
		v: COT_EXPORT_FORMAT_VERSION,
		agentId: 'agent-1',
		turnId: 'turn-1',
		seq,
		chainSeq: seq,
		ts: '2026-10-10T12:00:00.000Z',
		prevHash: seq === 0 ? COT_GENESIS_HASH : SAMPLE_HASH,
		hash: SAMPLE_HASH,
	};
}

/**
 * One record of every kind. Keyed by kind so a kind added to the union without
 * a sample here fails to compile.
 */
const SAMPLES: { [K in CotRecordKind]: Extract<CotRecord, { kind: K }> } = {
	'turn-start': {
		...base(0),
		kind: 'turn-start',
		toolType: 'claude-code',
		origin: 'interactive',
		tabId: 'tab-1',
		cwd: '/work/project',
		prompt: 'List the files.',
		imageCount: 0,
	},
	thinking: {
		...base(1),
		kind: 'thinking',
		text: 'The user wants a listing.',
		providerMessageId: 'msg_1',
		blockIndex: 0,
	},
	'redacted-thinking': {
		...base(2),
		kind: 'redacted-thinking',
		byteLength: 512,
		sha256: SAMPLE_HASH,
		providerMessageId: 'msg_1',
	},
	text: {
		...base(3),
		kind: 'text',
		text: 'Here are the files.',
		providerMessageId: 'msg_1',
		blockIndex: 2,
	},
	'tool-call': {
		...base(4),
		kind: 'tool-call',
		toolCallId: 'toolu_1',
		toolName: 'Bash',
		input: { command: 'ls' },
	},
	'tool-result': {
		...base(5),
		kind: 'tool-result',
		toolCallId: 'toolu_1',
		status: 'completed',
		output: 'a.txt\nb.txt',
		outputSha256: SAMPLE_HASH,
	},
	usage: {
		...base(6),
		kind: 'usage',
		usage: {
			inputTokens: 10,
			outputTokens: 20,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
			totalCostUsd: 0.01,
			contextWindow: 200000,
		},
	},
	'turn-end': {
		...base(7),
		kind: 'turn-end',
		exitCode: 0,
		durationMs: 1500,
		recordCount: 8,
	},
	'capture-gap': {
		...base(8),
		kind: 'capture-gap',
		reason: 'write-failed:ENOSPC',
		droppedRecords: 2,
	},
};

/**
 * Reads a field only its own kind has. The `never` in the default branch is
 * the proof that `kind` narrows the union and that every kind is handled.
 */
function payloadField(record: CotRecord): unknown {
	switch (record.kind) {
		case 'turn-start':
			return record.prompt;
		case 'thinking':
			return record.text;
		case 'redacted-thinking':
			return record.byteLength;
		case 'text':
			return record.text;
		case 'tool-call':
			return record.toolName;
		case 'tool-result':
			return record.outputSha256;
		case 'usage':
			return record.usage.inputTokens;
		case 'turn-end':
			return record.recordCount;
		case 'capture-gap':
			return record.reason;
		default: {
			const unreachable: never = record;
			return unreachable;
		}
	}
}

describe('cotExport record format', () => {
	describe('constants', () => {
		it('pins the format version', () => {
			expect(COT_EXPORT_FORMAT_VERSION).toBe(1);
		});

		it('uses a genesis hash the width of a SHA-256 hex digest', () => {
			expect(COT_GENESIS_HASH).toMatch(/^0{64}$/);
		});

		it('starts an empty chain one step before position 0', () => {
			const empty: CotChainState = {
				folder: '/logs/agent-1',
				head: COT_GENESIS_HASH,
				chainSeq: COT_GENESIS_CHAIN_SEQ,
			};
			expect(empty.chainSeq + 1).toBe(0);
		});

		it('caps a stored tool output at 256 KiB', () => {
			expect(COT_TOOL_OUTPUT_CAP_BYTES).toBe(262144);
		});
	});

	describe('records', () => {
		const kinds = Object.keys(SAMPLES) as CotRecordKind[];

		it('has a sample filed under its own kind for all nine kinds', () => {
			expect(kinds).toHaveLength(9);
			for (const kind of kinds) {
				expect(SAMPLES[kind].kind).toBe(kind);
			}
		});

		it('narrows to the payload of each kind', () => {
			expect(payloadField(SAMPLES['turn-start'])).toBe('List the files.');
			expect(payloadField(SAMPLES['redacted-thinking'])).toBe(512);
			expect(payloadField(SAMPLES['tool-call'])).toBe('Bash');
			expect(payloadField(SAMPLES['turn-end'])).toBe(8);
			expect(payloadField(SAMPLES['capture-gap'])).toBe('write-failed:ENOSPC');
		});

		it('is plain JSON, so a line read back equals the record written', () => {
			for (const kind of kinds) {
				const record: CotRecord = SAMPLES[kind];
				expect(JSON.parse(JSON.stringify(record))).toEqual(record);
			}
		});

		it('can name the subagent on every kind a subagent produces', () => {
			// Typed as records, so a kind that loses the field stops compiling.
			const fromSubagent: CotRecord[] = [
				{ ...SAMPLES.thinking, parentToolCallId: 'toolu_task' },
				{ ...SAMPLES['redacted-thinking'], parentToolCallId: 'toolu_task' },
				{ ...SAMPLES.text, parentToolCallId: 'toolu_task' },
				{ ...SAMPLES['tool-call'], parentToolCallId: 'toolu_task' },
				{ ...SAMPLES['tool-result'], parentToolCallId: 'toolu_task' },
			];

			for (const record of fromSubagent) {
				expect(JSON.parse(JSON.stringify(record))).toEqual(record);
			}
			// The agent's own blocks do not carry it.
			expect(SAMPLES.text).not.toHaveProperty('parentToolCallId');
		});

		it('keeps its payload fields when the hash fields are taken off', () => {
			const { prevHash, hash, ...rest } = SAMPLES['tool-call'];
			const unsealed: CotUnsealedRecord = rest;
			const resealed: CotRecord = { ...unsealed, prevHash, hash };

			expect(unsealed).not.toHaveProperty('hash');
			expect(unsealed).not.toHaveProperty('prevHash');
			expect(unsealed.kind).toBe('tool-call');
			expect(resealed).toEqual(SAMPLES['tool-call']);
		});
	});
});
