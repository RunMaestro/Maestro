/**
 * @file pianola-store-main.test.ts
 * @description Tests for the Pianola main-process store (rules read/write +
 * decision log). Uses a temp MAESTRO_USER_DATA dir so reads/writes are isolated,
 * and mocks electron's `app` (unused on this path but imported by the module).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('electron', () => ({
	app: { getPath: () => os.tmpdir() },
}));

import {
	readRules,
	readRulesResult,
	writeRules,
	appendDecision,
	readDecisions,
} from '../../../main/pianola/pianola-store-main';
import {
	PIANOLA_RULES_FILENAME,
	PIANOLA_DECISIONS_FILENAME,
	PIANOLA_DECISIONS_MAX_RECORDS,
	PIANOLA_DECISIONS_COMPACT_BYTES,
	type PianolaDecisionRecord,
} from '../../../shared/pianola/storage';
import type { PianolaRule } from '../../../shared/pianola/types';

let tmpDir: string;
let prevEnv: string | undefined;

beforeEach(() => {
	prevEnv = process.env.MAESTRO_USER_DATA;
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pianola-main-'));
	process.env.MAESTRO_USER_DATA = tmpDir;
});

afterEach(() => {
	if (prevEnv === undefined) delete process.env.MAESTRO_USER_DATA;
	else process.env.MAESTRO_USER_DATA = prevEnv;
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

function autoAnswerRule(id: string): PianolaRule {
	return {
		id,
		enabled: true,
		scope: 'global',
		match: { maxRisk: 'low' },
		action: 'auto_answer',
		answer: 'Use tabs.',
		priority: 1,
		createdAt: 1,
		updatedAt: 1,
	};
}

function decisionRecord(id: string): PianolaDecisionRecord {
	return {
		id,
		timestamp: '2026-01-01T00:00:00.000Z',
		tabId: 'tab-1',
		agentId: 'agent-1',
		classification: {
			kind: 'question',
			risk: 'low',
			topic: 'tabs',
			confidence: 'medium',
			evidence: { messageId: 'm1', reason: 'test', structured: false },
		},
		decision: { action: 'escalate', matchedRuleId: null, reason: 'default' },
		dispatched: false,
		dryRun: true,
	};
}

describe('rules read/write', () => {
	it('returns [] when no rules file exists', () => {
		expect(readRules()).toEqual([]);
	});

	it('round-trips rules through writeRules/readRules', () => {
		writeRules([autoAnswerRule('r1'), autoAnswerRule('r2')]);
		expect(readRules().map((r) => r.id)).toEqual(['r1', 'r2']);
	});

	it('writeRules drops invalid entries before persisting', () => {
		const bad = { id: 'bad', scope: 'planet' } as unknown as PianolaRule;
		const saved = writeRules([autoAnswerRule('good'), bad]);
		expect(saved.map((r) => r.id)).toEqual(['good']);
		expect(readRules().map((r) => r.id)).toEqual(['good']);
	});

	it('writes atomically (no leftover .tmp file)', () => {
		writeRules([autoAnswerRule('r1')]);
		const tmp = path.join(tmpDir, `${PIANOLA_RULES_FILENAME}.tmp`);
		expect(fs.existsSync(tmp)).toBe(false);
	});

	it('reads an electron-store style { rules: [...] } object', () => {
		fs.writeFileSync(
			path.join(tmpDir, PIANOLA_RULES_FILENAME),
			JSON.stringify({ rules: [autoAnswerRule('r2')] }),
			'utf-8'
		);
		expect(readRules().map((r) => r.id)).toEqual(['r2']);
	});

	it('returns [] for malformed JSON', () => {
		fs.writeFileSync(path.join(tmpDir, PIANOLA_RULES_FILENAME), '{ not json', 'utf-8');
		expect(readRules()).toEqual([]);
	});
});

describe('readRulesResult malformed signal', () => {
	it('reports malformed=false when the file is missing', () => {
		expect(readRulesResult()).toEqual({ rules: [], malformed: false });
	});

	it('reports malformed=true when the file exists but is unparseable', () => {
		fs.writeFileSync(path.join(tmpDir, PIANOLA_RULES_FILENAME), '{ not json', 'utf-8');
		expect(readRulesResult()).toEqual({ rules: [], malformed: true });
	});

	it('reports malformed=false for a valid file', () => {
		writeRules([autoAnswerRule('r1')]);
		const result = readRulesResult();
		expect(result.malformed).toBe(false);
		expect(result.rules.map((r) => r.id)).toEqual(['r1']);
	});
});

describe('decision audit log', () => {
	it('returns [] when the log is missing', () => {
		expect(readDecisions()).toEqual([]);
	});

	it('appends and reads back records in order', () => {
		appendDecision(decisionRecord('d1'));
		appendDecision(decisionRecord('d2'));
		expect(readDecisions().map((r) => r.id)).toEqual(['d1', 'd2']);
	});

	it('honors a tail limit', () => {
		appendDecision(decisionRecord('d1'));
		appendDecision(decisionRecord('d2'));
		appendDecision(decisionRecord('d3'));
		expect(readDecisions(2).map((r) => r.id)).toEqual(['d2', 'd3']);
	});

	it('skips corrupt and schema-invalid lines', () => {
		appendDecision(decisionRecord('d1'));
		fs.appendFileSync(path.join(tmpDir, PIANOLA_DECISIONS_FILENAME), 'not json\n', 'utf-8');
		fs.appendFileSync(path.join(tmpDir, PIANOLA_DECISIONS_FILENAME), '{"foo":1}\n', 'utf-8');
		appendDecision(decisionRecord('d2'));
		expect(readDecisions().map((r) => r.id)).toEqual(['d1', 'd2']);
	});

	it('folds an intent and outcome record sharing an id (last wins)', () => {
		appendDecision({ ...decisionRecord('same'), dispatched: false });
		appendDecision({ ...decisionRecord('same'), dispatched: true });
		const records = readDecisions();
		expect(records.map((r) => r.id)).toEqual(['same']);
		expect(records[0].dispatched).toBe(true);
	});
});

describe('decision audit log compaction (LOW-7)', () => {
	const decisionsFile = (): string => path.join(tmpDir, PIANOLA_DECISIONS_FILENAME);

	function paddedRecord(id: string, pad: string): PianolaDecisionRecord {
		const r = decisionRecord(id);
		return { ...r, classification: { ...r.classification, topic: pad } };
	}

	it('compacts to the most recent records once the log exceeds the size gate', () => {
		const total = PIANOLA_DECISIONS_MAX_RECORDS + 50;
		// Pad each record so the file clears the byte gate that arms compaction.
		const pad = 'x'.repeat(Math.ceil(PIANOLA_DECISIONS_COMPACT_BYTES / total) + 64);
		let bulk = '';
		for (let i = 0; i < total; i++) bulk += `${JSON.stringify(paddedRecord(`old-${i}`, pad))}\n`;
		fs.writeFileSync(decisionsFile(), bulk, 'utf-8');

		appendDecision(paddedRecord('newest', pad));

		const lines = fs.readFileSync(decisionsFile(), 'utf-8').split('\n').filter(Boolean);
		expect(lines.length).toBeLessThanOrEqual(PIANOLA_DECISIONS_MAX_RECORDS);
		expect(fs.statSync(decisionsFile()).size).toBeLessThanOrEqual(PIANOLA_DECISIONS_COMPACT_BYTES);
		const ids = lines.map((l) => JSON.parse(l).id as string);
		expect(ids).toContain('newest');
		expect(ids).not.toContain('old-0');
		expect(fs.existsSync(`${decisionsFile()}.${process.pid}.tmp`)).toBe(false);
	});

	it('leaves a small log untouched (no compaction under the gate)', () => {
		appendDecision(decisionRecord('d1'));
		appendDecision(decisionRecord('d2'));
		const lines = fs.readFileSync(decisionsFile(), 'utf-8').split('\n').filter(Boolean);
		expect(lines.length).toBe(2);
	});
});
