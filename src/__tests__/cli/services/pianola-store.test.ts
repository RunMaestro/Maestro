/**
 * @file pianola-store.test.ts
 * @description Tests for the Pianola CLI storage (rules read + decision log).
 * Uses a temp MAESTRO_USER_DATA dir so reads/writes are isolated.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	readPianolaRules,
	appendPianolaDecision,
	readPianolaDecisions,
} from '../../../cli/services/pianola-store';
import {
	PIANOLA_RULES_FILENAME,
	PIANOLA_DECISIONS_FILENAME,
	type PianolaDecisionRecord,
} from '../../../shared/pianola/storage';

let tmpDir: string;
let prevEnv: string | undefined;

beforeEach(() => {
	prevEnv = process.env.MAESTRO_USER_DATA;
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pianola-store-'));
	process.env.MAESTRO_USER_DATA = tmpDir;
});

afterEach(() => {
	if (prevEnv === undefined) delete process.env.MAESTRO_USER_DATA;
	else process.env.MAESTRO_USER_DATA = prevEnv;
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeRulesFile(content: string): void {
	fs.writeFileSync(path.join(tmpDir, PIANOLA_RULES_FILENAME), content, 'utf-8');
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

describe('readPianolaRules', () => {
	it('returns [] when the rules file is missing', () => {
		expect(readPianolaRules()).toEqual([]);
	});

	it('reads a bare array of rules', () => {
		writeRulesFile(
			JSON.stringify([
				{
					id: 'r1',
					enabled: true,
					scope: 'global',
					match: { maxRisk: 'low' },
					action: 'auto_answer',
					answer: 'ok',
					priority: 1,
					createdAt: 1,
					updatedAt: 1,
				},
			])
		);
		expect(readPianolaRules().map((r) => r.id)).toEqual(['r1']);
	});

	it('reads an electron-store style { rules: [...] } object', () => {
		writeRulesFile(
			JSON.stringify({
				rules: [
					{
						id: 'r2',
						enabled: true,
						scope: 'global',
						match: {},
						action: 'escalate',
						priority: 1,
						createdAt: 1,
						updatedAt: 1,
					},
				],
			})
		);
		expect(readPianolaRules().map((r) => r.id)).toEqual(['r2']);
	});

	it('returns [] for malformed JSON', () => {
		writeRulesFile('{ not json');
		expect(readPianolaRules()).toEqual([]);
	});

	it('drops individual invalid rules', () => {
		writeRulesFile(
			JSON.stringify([
				{
					id: 'good',
					enabled: true,
					scope: 'global',
					action: 'escalate',
					priority: 1,
					createdAt: 1,
					updatedAt: 1,
				},
				{ id: 'bad', scope: 'planet' },
			])
		);
		expect(readPianolaRules().map((r) => r.id)).toEqual(['good']);
	});
});

describe('decision audit log', () => {
	it('returns [] when the log is missing', () => {
		expect(readPianolaDecisions()).toEqual([]);
	});

	it('appends and reads back records in order', () => {
		appendPianolaDecision(decisionRecord('d1'));
		appendPianolaDecision(decisionRecord('d2'));
		expect(readPianolaDecisions().map((r) => r.id)).toEqual(['d1', 'd2']);
	});

	it('honors a tail limit', () => {
		appendPianolaDecision(decisionRecord('d1'));
		appendPianolaDecision(decisionRecord('d2'));
		appendPianolaDecision(decisionRecord('d3'));
		expect(readPianolaDecisions(2).map((r) => r.id)).toEqual(['d2', 'd3']);
	});

	it('skips a corrupt line without failing the read', () => {
		appendPianolaDecision(decisionRecord('d1'));
		fs.appendFileSync(path.join(tmpDir, PIANOLA_DECISIONS_FILENAME), 'not json\n', 'utf-8');
		appendPianolaDecision(decisionRecord('d2'));
		expect(readPianolaDecisions().map((r) => r.id)).toEqual(['d1', 'd2']);
	});

	it('skips a schema-invalid JSON line', () => {
		appendPianolaDecision(decisionRecord('d1'));
		fs.appendFileSync(path.join(tmpDir, PIANOLA_DECISIONS_FILENAME), '{"foo":1}\n', 'utf-8');
		expect(readPianolaDecisions().map((r) => r.id)).toEqual(['d1']);
	});

	it('folds an intent and outcome record sharing an id (last wins, position kept)', () => {
		const intent = { ...decisionRecord('same'), dispatched: false };
		const outcome = { ...decisionRecord('same'), dispatched: true };
		appendPianolaDecision(decisionRecord('first'));
		appendPianolaDecision(intent);
		appendPianolaDecision(outcome);
		const records = readPianolaDecisions();
		expect(records.map((r) => r.id)).toEqual(['first', 'same']);
		expect(records[1].dispatched).toBe(true);
	});
});
