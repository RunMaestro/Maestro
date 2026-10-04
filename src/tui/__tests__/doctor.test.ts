import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runDoctor } from '../doctor';

describe('runDoctor', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-tui-doctor-'));
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it('exits 0 and prints the report for an existing data directory', () => {
		let output = '';
		const code = runDoctor({ env: { MAESTRO_USER_DATA: tempDir } }, (text) => (output += text));
		expect(code).toBe(0);
		expect(output).toContain(tempDir);
		expect(output).toContain('MAESTRO_USER_DATA');
	});

	it('exits 1, lists what it tried, and creates nothing when the directory is missing', () => {
		const missing = path.join(tempDir, 'nope');
		let output = '';
		const code = runDoctor({ env: { MAESTRO_USER_DATA: missing } }, (text) => (output += text));
		expect(code).toBe(1);
		expect(output).toContain('Paths tried');
		expect(output).toContain(missing);
		expect(fs.existsSync(missing)).toBe(false);
	});
});
