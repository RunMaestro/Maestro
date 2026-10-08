/**
 * The one off-Electron reader and writer of `maestro-sessions.json`, against a
 * real temp directory.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	readSessionsStoreFile,
	SessionsStoreCorruptError,
	sessionsStorePath,
	writeSessionsStoreFile,
} from '../../../main/stores/sessions-store-file';

let dataDir: string;

beforeEach(() => {
	dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-store-file-'));
});

afterEach(() => {
	fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('readSessionsStoreFile', () => {
	it('reads a missing file as empty', () => {
		expect(readSessionsStoreFile(dataDir)).toEqual({ data: undefined, sessions: [] });
	});

	it('returns the sessions and the whole top level', () => {
		fs.writeFileSync(
			sessionsStorePath(dataDir),
			JSON.stringify({ sessions: [{ id: 'a', name: 'A' }], activeSessionId: 'a' })
		);
		const file = readSessionsStoreFile(dataDir);
		expect(file.sessions.map((s) => s.id)).toEqual(['a']);
		expect(file.data?.activeSessionId).toBe('a');
	});

	it('reads a file without a sessions array as no sessions', () => {
		fs.writeFileSync(sessionsStorePath(dataDir), JSON.stringify({ sessions: 'nope' }));
		expect(readSessionsStoreFile(dataDir).sessions).toEqual([]);
	});

	it('throws a typed error for content that is not JSON', () => {
		fs.writeFileSync(sessionsStorePath(dataDir), '{ torn');
		expect(() => readSessionsStoreFile(dataDir)).toThrow(SessionsStoreCorruptError);
		expect(() => readSessionsStoreFile(dataDir)).toThrow(/Could not read maestro-sessions\.json/);
	});

	it('throws a typed error for JSON that is not an object', () => {
		fs.writeFileSync(sessionsStorePath(dataDir), '[]');
		expect(() => readSessionsStoreFile(dataDir)).toThrow(SessionsStoreCorruptError);
	});
});

describe('writeSessionsStoreFile', () => {
	it('keeps the top-level keys it was given and leaves no temp file', async () => {
		fs.writeFileSync(
			sessionsStorePath(dataDir),
			JSON.stringify({ sessions: [], activeSessionId: 'x', future: { kept: true } })
		);
		const { data } = readSessionsStoreFile(dataDir);
		await writeSessionsStoreFile(dataDir, {
			...data,
			sessions: [{ id: 'b', name: 'B', toolType: 'codex', cwd: '/p', projectRoot: '/p' }],
		});
		const after = readSessionsStoreFile(dataDir);
		expect(after.sessions.map((s) => s.id)).toEqual(['b']);
		expect(after.data?.activeSessionId).toBe('x');
		expect(after.data?.future).toEqual({ kept: true });
		expect(fs.readdirSync(dataDir)).toEqual(['maestro-sessions.json']);
	});
});
