/**
 * @file atomicJsonSync.test.ts
 * @description atomicWriteJsonSync against a real temp directory: the target is
 * replaced whole, a payload that serializes to nothing never touches it, and no
 * temp file is left behind.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { atomicWriteJsonSync } from '../../shared/atomicJsonSync';

let tmpDir: string;
let filePath: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-json-sync-'));
	filePath = path.join(tmpDir, 'store.json');
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('atomicWriteJsonSync', () => {
	it('writes a value that reads back, on one line by default', () => {
		atomicWriteJsonSync(filePath, { a: 1, b: ['x'] });

		expect(fs.readFileSync(filePath, 'utf-8')).toBe('{"a":1,"b":["x"]}');
	});

	it('honors the indent and the trailing newline', () => {
		atomicWriteJsonSync(filePath, { a: 1 }, { indent: '\t', trailingNewline: true });

		expect(fs.readFileSync(filePath, 'utf-8')).toBe('{\n\t"a": 1\n}\n');
	});

	it('writes the text a custom serializer returns, and still adds the newline', () => {
		atomicWriteJsonSync(
			filePath,
			{ a: 1 },
			{ trailingNewline: true, serialize: (value) => JSON.stringify(value, null, 2) }
		);

		expect(fs.readFileSync(filePath, 'utf-8')).toBe('{\n  "a": 1\n}\n');
	});

	it('checks a custom serializer the same way: text that is not JSON never lands', () => {
		fs.writeFileSync(filePath, '{"old":true}', 'utf-8');

		expect(() => atomicWriteJsonSync(filePath, { a: 1 }, { serialize: () => 'undefined' })).toThrow(
			/Refusing to write/
		);

		expect(fs.readFileSync(filePath, 'utf-8')).toBe('{"old":true}');
	});

	it('replaces an existing file and leaves no temp file behind', () => {
		fs.writeFileSync(filePath, '{"old":true}', 'utf-8');

		atomicWriteJsonSync(filePath, { new: true });

		expect(JSON.parse(fs.readFileSync(filePath, 'utf-8'))).toEqual({ new: true });
		expect(fs.readdirSync(tmpDir)).toEqual(['store.json']);
	});

	it('refuses a value that serializes to nothing and keeps the old file', () => {
		fs.writeFileSync(filePath, '{"old":true}', 'utf-8');

		expect(() => atomicWriteJsonSync(filePath, undefined)).toThrow(/Refusing to write/);

		expect(fs.readFileSync(filePath, 'utf-8')).toBe('{"old":true}');
		expect(fs.readdirSync(tmpDir)).toEqual(['store.json']);
	});

	it('removes its temp file and rethrows when the rename fails', () => {
		// A directory at the target makes the rename fail on every platform
		// (EISDIR on POSIX; EPERM on Windows, after the transient-lock retries).
		fs.mkdirSync(filePath);

		expect(() => atomicWriteJsonSync(filePath, { a: 1 })).toThrow();

		expect(fs.readdirSync(tmpDir)).toEqual(['store.json']);
	});
});
