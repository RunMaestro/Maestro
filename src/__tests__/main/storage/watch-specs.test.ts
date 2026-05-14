/**
 * Tests for getStorageWatchSpec() across agent storage implementations.
 *
 * These are pure matcher unit tests — they instantiate each storage class,
 * pull the spec, and run the `fileMatcher` against representative relative
 * paths. SessionFileWatcher integration is covered separately in
 * `session-file-watcher.test.ts`.
 */

import { describe, it, expect, vi } from 'vitest';
import os from 'os';
import path from 'path';

vi.mock('electron', () => ({
	app: {
		getPath: vi.fn(() => '/tmp/maestro-test-userData'),
	},
}));

vi.mock('electron-store', () => ({
	default: vi.fn().mockImplementation(() => ({
		get: vi.fn((_key: string, defaultValue?: unknown) => defaultValue),
		set: vi.fn(),
		store: {},
	})),
}));

vi.mock('../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		debug: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

import { ClaudeSessionStorage } from '../../../main/storage/claude-session-storage';
import type { ClaudeSessionOriginsData } from '../../../main/storage/claude-session-storage';
import { CodexSessionStorage } from '../../../main/storage/codex-session-storage';
import { FactoryDroidSessionStorage } from '../../../main/storage/factory-droid-session-storage';
import type Store from 'electron-store';

const stubStore = {
	get: vi.fn((_key: string, defaultValue?: unknown) => defaultValue),
	set: vi.fn(),
	store: {},
} as unknown as Store<ClaudeSessionOriginsData>;

describe('getStorageWatchSpec', () => {
	describe('ClaudeSessionStorage', () => {
		const storage = new ClaudeSessionStorage(stubStore);
		const spec = storage.getStorageWatchSpec();

		it('returns a non-null spec', () => {
			expect(spec).not.toBeNull();
		});

		it('rootDir is ~/.claude/projects', () => {
			expect(spec?.rootDir).toBe(path.join(os.homedir(), '.claude', 'projects'));
		});

		it('matches `<encoded-cwd>/<session-id>.jsonl` and returns the sessionId', () => {
			const rel = path.join('-Users-octavia-myproject', 'abc-123-def.jsonl');
			expect(spec?.fileMatcher(rel)).toEqual({
				sessionId: 'abc-123-def',
				projectPath: '-Users-octavia-myproject',
			});
		});

		it('returns null for a too-shallow path (no project segment)', () => {
			expect(spec?.fileMatcher('abc-123.jsonl')).toBeNull();
		});

		it('returns null for a too-deep path (extra nested segment)', () => {
			const rel = path.join('-Users-octavia-myproject', 'nested', 'abc-123.jsonl');
			expect(spec?.fileMatcher(rel)).toBeNull();
		});

		it('returns null for a non-jsonl file (e.g., temp/swap file)', () => {
			const rel = path.join('-Users-octavia-myproject', 'abc-123.tmp');
			expect(spec?.fileMatcher(rel)).toBeNull();
		});
	});

	describe('CodexSessionStorage', () => {
		const storage = new CodexSessionStorage();
		const spec = storage.getStorageWatchSpec();

		it('returns a non-null spec', () => {
			expect(spec).not.toBeNull();
		});

		it('rootDir is ~/.codex/sessions', () => {
			expect(spec?.rootDir).toBe(path.join(os.homedir(), '.codex', 'sessions'));
		});

		it('matches `YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl` and returns the UUID as sessionId', () => {
			const rel = path.join(
				'2026',
				'05',
				'14',
				'rollout-20260514_123045_001-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl'
			);
			expect(spec?.fileMatcher(rel)).toEqual({
				sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
				projectPath: '',
			});
		});

		it('returns null when the date segments are not numeric', () => {
			const rel = path.join(
				'YYYY',
				'05',
				'14',
				'rollout-20260514_123045_001-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl'
			);
			expect(spec?.fileMatcher(rel)).toBeNull();
		});

		it('returns null for a too-shallow path (missing day segment)', () => {
			const rel = path.join(
				'2026',
				'05',
				'rollout-20260514_123045_001-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl'
			);
			expect(spec?.fileMatcher(rel)).toBeNull();
		});

		it('returns null for a file that does not match the rollout pattern', () => {
			const rel = path.join('2026', '05', '14', 'not-a-rollout.jsonl');
			expect(spec?.fileMatcher(rel)).toBeNull();
		});
	});

	describe('FactoryDroidSessionStorage', () => {
		const storage = new FactoryDroidSessionStorage();
		const spec = storage.getStorageWatchSpec();

		it('returns a non-null spec', () => {
			expect(spec).not.toBeNull();
		});

		it('rootDir is ~/.factory/sessions', () => {
			expect(spec?.rootDir).toBe(path.join(os.homedir(), '.factory', 'sessions'));
		});

		it('matches `<encoded-cwd>/<uuid>.jsonl` and returns the UUID as sessionId', () => {
			const rel = path.join(
				'-Users-octavia-myproject',
				'11111111-2222-3333-4444-555555555555.jsonl'
			);
			expect(spec?.fileMatcher(rel)).toEqual({
				sessionId: '11111111-2222-3333-4444-555555555555',
				projectPath: '-Users-octavia-myproject',
			});
		});

		it('returns null for the `.settings.json` sidecar (wrong suffix)', () => {
			const rel = path.join(
				'-Users-octavia-myproject',
				'11111111-2222-3333-4444-555555555555.settings.json'
			);
			expect(spec?.fileMatcher(rel)).toBeNull();
		});

		it('returns null for a too-shallow path (no project segment)', () => {
			expect(spec?.fileMatcher('11111111-2222-3333-4444-555555555555.jsonl')).toBeNull();
		});

		it('returns null for a too-deep path (extra nested segment)', () => {
			const rel = path.join(
				'-Users-octavia-myproject',
				'nested',
				'11111111-2222-3333-4444-555555555555.jsonl'
			);
			expect(spec?.fileMatcher(rel)).toBeNull();
		});
	});
});
