/**
 * Tests for OpenCodeSessionStorage.getStorageWatchSpec().
 *
 * OpenCode's session activity shape is unique among the supported agents:
 * each new message is written as its own `.json` file inside a per-session
 * directory, so the matcher identifies the session by the parent directory
 * segment (not the filename), and the spec advertises `activityEvent: 'create'`
 * rather than the `'append'` default used by the JSONL-per-session agents.
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

import { OpenCodeSessionStorage } from '../../../main/storage/opencode-session-storage';
import { isWindows } from '../../../shared/platformDetection';

describe('OpenCodeSessionStorage.getStorageWatchSpec', () => {
	const storage = new OpenCodeSessionStorage();
	const spec = storage.getStorageWatchSpec();

	it('returns a non-null spec', () => {
		expect(spec).not.toBeNull();
	});

	it('advertises activityEvent: "create" (not the default append)', () => {
		expect(spec?.activityEvent).toBe('create');
	});

	it('rootDir is the XDG OpenCode storage directory for the current platform', () => {
		const expected = isWindows()
			? path.join(
					process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
					'opencode',
					'storage'
				)
			: path.join(os.homedir(), '.local', 'share', 'opencode', 'storage');
		expect(spec?.rootDir).toBe(expected);
	});

	it('matches a `<projectId>/<sessionId>/<msg-id>.json` path and returns the parent directory as sessionId', () => {
		const rel = path.join(
			'message',
			'ses_4d585107dffeO9bO3HvMdvLYyC',
			'msg_aaaaaaaaaaaaaaaaaaaaaaaaaa.json'
		);
		expect(spec?.fileMatcher(rel)).toEqual({
			sessionId: 'ses_4d585107dffeO9bO3HvMdvLYyC',
			projectPath: '',
		});
	});

	it('returns null for `global.json` at the root', () => {
		expect(spec?.fileMatcher('global.json')).toBeNull();
	});

	it('returns null for a `.txt` file inside a session dir', () => {
		const rel = path.join('message', 'ses_4d585107dffeO9bO3HvMdvLYyC', 'msg_aaaa.txt');
		expect(spec?.fileMatcher(rel)).toBeNull();
	});

	it('returns null for an empty path', () => {
		expect(spec?.fileMatcher('')).toBeNull();
	});
});
