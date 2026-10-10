/**
 * @file decision-log.test.ts
 * @description Decision-log compaction trims to BOTH the record cap and the byte
 * budget, leaves a within-caps file untouched, and never leaks its compaction
 * lock. The module is fs-backed (Node only), so these run against a real tmp dir.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { compactDecisionLog, appendDecisionLine } from '../../../shared/pianola/decision-log';
import { PIANOLA_DECISION_RECORD_MAX_BYTES } from '../../../shared/pianola/storage';

let dir: string;
let file: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-declog-'));
	file = path.join(dir, 'pianola-decisions.jsonl');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** A valid JSON-object line, comfortably over the 50-byte record floor. */
function jsonLine(i: number): string {
	return `${JSON.stringify({ id: `rec-${String(i).padStart(5, '0')}`, pad: 'x'.repeat(50) })}\n`;
}

function writeLines(count: number): void {
	for (let i = 0; i < count; i += 1) appendDecisionLine(file, jsonLine(i));
}

function nonEmptyLines(): string[] {
	return fs
		.readFileSync(file, 'utf-8')
		.split('\n')
		.filter((l) => l.trim().length > 0);
}

describe('compactDecisionLog', () => {
	it('trims to maxRecords on the record-count trigger (file under the byte cap)', () => {
		writeLines(25);
		expect(fs.statSync(file).size).toBeLessThan(1_000_000);
		compactDecisionLog(file, 10, 1_000_000);
		const lines = nonEmptyLines();
		expect(lines.length).toBe(10);
		// Oldest dropped, newest kept.
		expect(lines.some((l) => l.includes('rec-00024'))).toBe(true);
		expect(lines.some((l) => l.includes('rec-00000'))).toBe(false);
	});

	it('leaves a file already within both caps unchanged', () => {
		writeLines(8);
		const before = fs.readFileSync(file, 'utf-8');
		compactDecisionLog(file, 10, 1_000_000);
		expect(fs.readFileSync(file, 'utf-8')).toBe(before);
	});

	it('does not leave a .lock behind after compaction', () => {
		writeLines(25);
		compactDecisionLog(file, 10, 1_000_000);
		expect(fs.existsSync(`${file}.lock`)).toBe(false);
	});

	it('honors BOTH caps under a tiny byte budget', () => {
		writeLines(25);
		const byteCap = 200;
		compactDecisionLog(file, 10, byteCap);
		const lines = nonEmptyLines();
		expect(lines.length).toBeGreaterThanOrEqual(1);
		expect(lines.length).toBeLessThanOrEqual(10);
		expect(fs.statSync(file).size).toBeLessThanOrEqual(byteCap);
	});
});

/** A record line whose serialized byte length exceeds the per-record cap. */
function oversizedLine(): string {
	const answer = 'x'.repeat(PIANOLA_DECISION_RECORD_MAX_BYTES);
	return `${JSON.stringify({ id: 'huge', answer })}\n`;
}

describe('appendDecisionLine - per-record byte cap', () => {
	it('appends a normal within-cap record', () => {
		appendDecisionLine(file, jsonLine(0));
		expect(nonEmptyLines().length).toBe(1);
	});

	it('drops a single record over the per-record byte cap (never written)', () => {
		appendDecisionLine(file, oversizedLine());
		expect(fs.existsSync(file)).toBe(false);
	});

	it('keeps small records around a dropped oversized one', () => {
		appendDecisionLine(file, jsonLine(1));
		appendDecisionLine(file, oversizedLine());
		appendDecisionLine(file, jsonLine(2));
		const lines = nonEmptyLines();
		expect(lines.length).toBe(2);
		expect(lines.some((l) => l.includes('huge'))).toBe(false);
		expect(lines.some((l) => l.includes('rec-00001'))).toBe(true);
		expect(lines.some((l) => l.includes('rec-00002'))).toBe(true);
	});
});
