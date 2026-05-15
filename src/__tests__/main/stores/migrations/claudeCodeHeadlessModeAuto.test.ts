/**
 * Tests for src/main/stores/migrations/claudeCodeHeadlessModeAuto.ts
 *
 * The migration is a marker + observability hook — it never mutates
 * `claudeCode.headlessMode` itself. The tests exercise the disk-read
 * codepath (real temp files via `fs.mkdtempSync`) so we catch regressions
 * in the explicit-vs-implicit detection logic.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('../../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		debug: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

import { runClaudeCodeHeadlessModeAutoMigration } from '../../../../main/stores/migrations/claudeCodeHeadlessModeAuto';
import { logger } from '../../../../main/utils/logger';

const MIGRATION_MARKER_KEY = 'claudeCodeHeadlessModeAutoMigrationApplied';

interface FakeStoreOptions {
	storePath: string;
	initial?: Record<string, unknown>;
}

/**
 * Minimal `electron-store`-shaped stand-in. Backing data is an in-memory map;
 * `path` returns the temp file path so the migration's `fs.readFileSync`
 * actually reads on-disk JSON.
 */
function makeFakeStore({ storePath, initial }: FakeStoreOptions) {
	const data: Record<string, unknown> = { ...(initial ?? {}) };
	const set = vi.fn((key: string, value: unknown) => {
		data[key] = value;
	});
	const get = vi.fn((key: string, defaultValue?: unknown) => {
		if (Object.prototype.hasOwnProperty.call(data, key)) {
			return data[key];
		}
		return defaultValue;
	});
	return {
		path: storePath,
		get,
		set,
		_data: data,
	};
}

describe('runClaudeCodeHeadlessModeAutoMigration', () => {
	let tempDir: string;
	let storePath: string;
	let infoMock: ReturnType<typeof vi.fn>;
	let warnMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-headless-mig-'));
		storePath = path.join(tempDir, 'config.json');
		infoMock = logger.info as unknown as ReturnType<typeof vi.fn>;
		warnMock = logger.warn as unknown as ReturnType<typeof vi.fn>;
		infoMock.mockClear();
		warnMock.mockClear();
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it('treats a missing settings file as "no explicit value" and marks migration applied', () => {
		// No file written → fs.readFileSync throws → migration treats as no explicit.
		const store = makeFakeStore({ storePath });

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		runClaudeCodeHeadlessModeAutoMigration(store as any);

		expect(store.set).toHaveBeenCalledWith(MIGRATION_MARKER_KEY, true);
		expect(infoMock).toHaveBeenCalledWith(
			expect.stringContaining('No explicit claudeCode.headlessMode'),
			expect.any(String)
		);
	});

	it("preserves explicit 'api' choice (logs preservation, never mutates headlessMode)", () => {
		fs.writeFileSync(storePath, JSON.stringify({ claudeCode: { headlessMode: 'api' } }));
		const store = makeFakeStore({ storePath });

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		runClaudeCodeHeadlessModeAutoMigration(store as any);

		// Only the marker should be set; headlessMode is left alone.
		expect(store.set).toHaveBeenCalledWith(MIGRATION_MARKER_KEY, true);
		const setKeys = store.set.mock.calls.map((c) => c[0]);
		expect(setKeys).not.toContain('claudeCode.headlessMode');
		expect(setKeys).not.toContain('claudeCode');
		expect(infoMock).toHaveBeenCalledWith(
			expect.stringContaining("Preserving explicit claudeCode.headlessMode='api'"),
			expect.any(String)
		);

		// The on-disk JSON is untouched — verify by re-reading.
		const onDisk = JSON.parse(fs.readFileSync(storePath, 'utf-8'));
		expect(onDisk.claudeCode.headlessMode).toBe('api');
	});

	it("preserves explicit 'interactive' choice", () => {
		fs.writeFileSync(storePath, JSON.stringify({ claudeCode: { headlessMode: 'interactive' } }));
		const store = makeFakeStore({ storePath });

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		runClaudeCodeHeadlessModeAutoMigration(store as any);

		expect(infoMock).toHaveBeenCalledWith(
			expect.stringContaining("Preserving explicit claudeCode.headlessMode='interactive'"),
			expect.any(String)
		);
		expect(store.set).toHaveBeenCalledWith(MIGRATION_MARKER_KEY, true);
	});

	it("preserves explicit 'auto' choice", () => {
		fs.writeFileSync(storePath, JSON.stringify({ claudeCode: { headlessMode: 'auto' } }));
		const store = makeFakeStore({ storePath });

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		runClaudeCodeHeadlessModeAutoMigration(store as any);

		expect(infoMock).toHaveBeenCalledWith(
			expect.stringContaining("Preserving explicit claudeCode.headlessMode='auto'"),
			expect.any(String)
		);
		expect(store.set).toHaveBeenCalledWith(MIGRATION_MARKER_KEY, true);
	});

	it('treats a partial claudeCode block without headlessMode as no explicit value', () => {
		fs.writeFileSync(storePath, JSON.stringify({ claudeCode: { autoFallbackToApiOnLimit: true } }));
		const store = makeFakeStore({ storePath });

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		runClaudeCodeHeadlessModeAutoMigration(store as any);

		expect(infoMock).toHaveBeenCalledWith(
			expect.stringContaining('No explicit claudeCode.headlessMode'),
			expect.any(String)
		);
		expect(store.set).toHaveBeenCalledWith(MIGRATION_MARKER_KEY, true);
	});

	it('treats malformed JSON as no explicit value (does not throw)', () => {
		fs.writeFileSync(storePath, '{ not valid json ::: ');
		const store = makeFakeStore({ storePath });

		expect(() => {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			runClaudeCodeHeadlessModeAutoMigration(store as any);
		}).not.toThrow();

		expect(infoMock).toHaveBeenCalledWith(
			expect.stringContaining('No explicit claudeCode.headlessMode'),
			expect.any(String)
		);
		expect(store.set).toHaveBeenCalledWith(MIGRATION_MARKER_KEY, true);
	});

	it('short-circuits on subsequent boots when the marker is already set', () => {
		fs.writeFileSync(storePath, JSON.stringify({ claudeCode: { headlessMode: 'api' } }));
		const store = makeFakeStore({
			storePath,
			initial: { [MIGRATION_MARKER_KEY]: true },
		});

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		runClaudeCodeHeadlessModeAutoMigration(store as any);

		// No log entries, no set calls.
		expect(infoMock).not.toHaveBeenCalled();
		expect(store.set).not.toHaveBeenCalled();
	});

	it('is idempotent across two back-to-back calls (second call short-circuits)', () => {
		fs.writeFileSync(storePath, JSON.stringify({ claudeCode: { headlessMode: 'api' } }));
		const store = makeFakeStore({ storePath });

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		runClaudeCodeHeadlessModeAutoMigration(store as any);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		runClaudeCodeHeadlessModeAutoMigration(store as any);

		// First call: 1 info log + 1 marker set. Second call: nothing.
		expect(infoMock).toHaveBeenCalledTimes(1);
		expect(store.set).toHaveBeenCalledTimes(1);
		expect(store.set).toHaveBeenCalledWith(MIGRATION_MARKER_KEY, true);
	});
});
