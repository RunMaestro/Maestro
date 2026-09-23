/**
 * A store file that is not valid JSON must not brick the app. conf calls
 * `deserialize` from inside its own constructor, so an escaping SyntaxError
 * takes down startup on every launch until somebody deletes the file by hand.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockCaptureException } = vi.hoisted(() => ({
	mockCaptureException: vi.fn(
		async (_error: Error | unknown, _extra?: Record<string, unknown>) => {}
	),
}));

vi.mock('../../../main/utils/logger', () => ({
	logger: {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

vi.mock('../../../main/utils/sentry', () => ({
	captureException: mockCaptureException,
}));

import {
	createStoreDeserializer,
	corruptStorePath,
} from '../../../main/stores/corrupt-store-recovery';

let tempDir: string;
let storePath: string;

/** Sidecars this store produced, newest last. */
function sidecars(): string[] {
	return fs
		.readdirSync(tempDir)
		.filter((name) => name.startsWith('maestro-sessions.corrupt-'))
		.sort();
}

beforeEach(() => {
	vi.clearAllMocks();
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-store-recovery-'));
	storePath = path.join(tempDir, 'maestro-sessions.json');
});

afterEach(() => {
	fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('corruptStorePath', () => {
	it('stamps the sidecar so a second incident cannot overwrite the first', () => {
		const first = corruptStorePath(storePath, new Date(2026, 8, 22, 7, 15, 30));
		const second = corruptStorePath(storePath, new Date(2026, 8, 22, 9, 0, 0));

		expect(path.basename(first)).toBe('maestro-sessions.corrupt-20260922-071530.json');
		expect(path.dirname(first)).toBe(tempDir);
		expect(second).not.toBe(first);
	});
});

describe('createStoreDeserializer', () => {
	it('parses a healthy document, BOM included', () => {
		const deserialize = createStoreDeserializer(storePath);

		expect(deserialize('\uFEFF{"sessions":[{"id":"a"}]}')).toEqual({
			sessions: [{ id: 'a' }],
		});
		expect(sidecars()).toHaveLength(0);
	});

	it('quarantines a truncated document and falls back to an empty one', () => {
		const torn = '{"sessions":[{"id":"a","name":"unterminat';
		fs.writeFileSync(storePath, torn, 'utf-8');

		const result = createStoreDeserializer(storePath)(torn);

		expect(result).toEqual({});
		// The bad file is out of the way, so the next read starts clean.
		expect(fs.existsSync(storePath)).toBe(false);
		// ...and its bytes are still on disk, under a name that says what happened.
		const preserved = sidecars();
		expect(preserved).toHaveLength(1);
		expect(fs.readFileSync(path.join(tempDir, preserved[0]), 'utf-8')).toBe(torn);
	});

	it('reports the corruption rather than swallowing it', () => {
		const torn = '{"sessions":[';
		fs.writeFileSync(storePath, torn, 'utf-8');

		createStoreDeserializer(storePath)(torn);

		expect(mockCaptureException).toHaveBeenCalledOnce();
		const [error, extra] = mockCaptureException.mock.calls[0];
		expect(error).toBeInstanceOf(SyntaxError);
		expect(extra).toMatchObject({
			operation: 'store:deserialize',
			storeFile: 'maestro-sessions.json',
			quarantined: true,
		});
	});

	it('still preserves the contents when the file cannot be renamed', () => {
		// No file on disk at all: rename fails, so the in-memory copy is written.
		const torn = 'not json at all';

		const result = createStoreDeserializer(storePath)(torn);

		expect(result).toEqual({});
		const preserved = sidecars();
		expect(preserved).toHaveLength(1);
		expect(fs.readFileSync(path.join(tempDir, preserved[0]), 'utf-8')).toBe(torn);
	});

	it('rethrows anything that is not a parse failure', () => {
		const deserialize = createStoreDeserializer(storePath);
		const exploding = {
			charCodeAt() {
				throw new RangeError('string too long');
			},
		} as unknown as string;

		expect(() => deserialize(exploding)).toThrow(RangeError);
		expect(mockCaptureException).not.toHaveBeenCalled();
	});
});
