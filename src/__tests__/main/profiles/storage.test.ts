/**
 * @file storage.test.ts
 * @description Tests for the Agent Profiles YAML storage: round-trip
 * persistence and malformed-entry skipping.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { PROFILES_CONFIG_PATH } from '../../../shared/maestro-paths';
import {
	loadProfiles,
	saveProfiles,
	listProfiles,
	upsertProfile,
	deleteProfile,
	enqueueProfileWrite,
	ProfileStorageError,
} from '../../../main/profiles/profile-storage';
import type { AgentProfile } from '../../../shared/profiles/types';

const renameFailure = vi.hoisted(() => ({ active: false }));

// Partial `fs` mock so the crash-safety test can fail the rename step only.
// vi.spyOn cannot patch an ESM namespace export, and the whole point of the
// atomic write is what happens when the process dies between temp-write and
// rename, so this is the only way to exercise it.
vi.mock('fs', async (importOriginal) => {
	const actual = await importOriginal<typeof import('fs')>();
	return {
		...actual,
		default: actual,
		renameSync: (from: fs.PathLike, to: fs.PathLike) => {
			if (renameFailure.active) throw new Error('simulated crash before rename');
			return actual.renameSync(from, to);
		},
	};
});

vi.mock('../../../main/utils/logger', () => ({
	logger: {
		warn: vi.fn(),
		info: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

let projectRoot: string;

beforeEach(() => {
	projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-profiles-'));
});

afterEach(() => {
	fs.rmSync(projectRoot, { recursive: true, force: true });
});

function profile(overrides: Partial<AgentProfile> = {}): AgentProfile {
	return {
		id: 'p1',
		name: 'Worker',
		baseAgentId: 'agent-1',
		...overrides,
	};
}

function writeRawYaml(content: string): void {
	fs.mkdirSync(path.join(projectRoot, '.maestro'), { recursive: true });
	fs.writeFileSync(path.join(projectRoot, PROFILES_CONFIG_PATH), content, 'utf-8');
}

describe('profile-storage round-trip', () => {
	it('returns an empty list when no file exists', () => {
		expect(loadProfiles(projectRoot)).toEqual([]);
	});

	it('saves and reloads profiles unchanged', () => {
		const profiles: AgentProfile[] = [
			profile({ id: 'a', name: 'Worker', model: 'haiku', effort: 'low' }),
			profile({
				id: 'b',
				name: 'Reviewer',
				model: 'sonnet',
				appendSystemPrompt: 'Be adversarial.',
			}),
		];
		const filePath = saveProfiles(projectRoot, profiles);
		expect(fs.existsSync(filePath)).toBe(true);
		expect(loadProfiles(projectRoot)).toEqual(profiles);
	});

	it('upsert inserts then replaces by id', () => {
		upsertProfile(projectRoot, profile({ id: 'a', name: 'Worker' }));
		expect(listProfiles(projectRoot)).toHaveLength(1);

		upsertProfile(projectRoot, profile({ id: 'a', name: 'Worker Renamed', model: 'sonnet' }));
		const list = listProfiles(projectRoot);
		expect(list).toHaveLength(1);
		expect(list[0].name).toBe('Worker Renamed');
		expect(list[0].model).toBe('sonnet');
	});

	it('delete removes only the matching profile', () => {
		saveProfiles(projectRoot, [profile({ id: 'a', name: 'A' }), profile({ id: 'b', name: 'B' })]);
		const remaining = deleteProfile(projectRoot, 'a');
		expect(remaining.map((p) => p.id)).toEqual(['b']);
		expect(loadProfiles(projectRoot).map((p) => p.id)).toEqual(['b']);
	});
});

describe('profile-storage fail-closed loads', () => {
	const CORRUPT = ':\n\t- broken: [unbalanced';

	it('still returns [] when the file is simply missing', () => {
		expect(loadProfiles(projectRoot)).toEqual([]);
	});

	it('treats an empty file and an absent `profiles:` key as "no profiles yet"', () => {
		writeRawYaml('');
		expect(loadProfiles(projectRoot)).toEqual([]);
		writeRawYaml('somethingElse: true\n');
		expect(loadProfiles(projectRoot)).toEqual([]);
	});

	it('throws a typed ProfileStorageError naming the file on corrupt YAML', () => {
		writeRawYaml(CORRUPT);
		try {
			loadProfiles(projectRoot);
			throw new Error('expected loadProfiles to throw');
		} catch (err) {
			expect(err).toBeInstanceOf(ProfileStorageError);
			expect((err as ProfileStorageError).filePath).toBe(
				path.join(projectRoot, PROFILES_CONFIG_PATH)
			);
		}
	});

	it('throws when `profiles:` is present but is not a list', () => {
		writeRawYaml('profiles: not-a-list\n');
		expect(() => loadProfiles(projectRoot)).toThrow(ProfileStorageError);
	});

	it('does NOT truncate the corrupt file when a mutation is attempted', () => {
		writeRawYaml(CORRUPT);
		const filePath = path.join(projectRoot, PROFILES_CONFIG_PATH);

		expect(() => upsertProfile(projectRoot, profile({ id: 'x', name: 'X' }))).toThrow(
			ProfileStorageError
		);
		expect(() => deleteProfile(projectRoot, 'x')).toThrow(ProfileStorageError);
		expect(() => listProfiles(projectRoot)).toThrow(ProfileStorageError);

		expect(fs.readFileSync(filePath, 'utf-8')).toBe(CORRUPT);
	});
});

describe('profile-storage atomic + serialized writes', () => {
	it('writes via a temp file that is renamed away, leaving no .tmp behind', () => {
		const filePath = saveProfiles(projectRoot, [profile({ id: 'a', name: 'A' })]);
		expect(fs.existsSync(filePath)).toBe(true);
		expect(fs.existsSync(`${filePath}.tmp`)).toBe(false);
	});

	it('leaves the previous file fully intact when the write fails mid-way', () => {
		saveProfiles(projectRoot, [profile({ id: 'a', name: 'Original' })]);
		const filePath = path.join(projectRoot, PROFILES_CONFIG_PATH);
		const before = fs.readFileSync(filePath, 'utf-8');

		renameFailure.active = true;
		expect(() => saveProfiles(projectRoot, [profile({ id: 'b', name: 'Replacement' })])).toThrow(
			/simulated crash/
		);
		renameFailure.active = false;

		expect(fs.readFileSync(filePath, 'utf-8')).toBe(before);
		expect(loadProfiles(projectRoot)[0].name).toBe('Original');
		expect(fs.existsSync(`${filePath}.tmp`)).toBe(false);
	});

	it('applies two racing enqueued saves in call order', async () => {
		const order: string[] = [];
		const first = enqueueProfileWrite(projectRoot, async () => {
			await new Promise((resolve) => setTimeout(resolve, 20));
			order.push('first');
			upsertProfile(projectRoot, profile({ id: 'first', name: 'First' }));
		});
		const second = enqueueProfileWrite(projectRoot, async () => {
			order.push('second');
			upsertProfile(projectRoot, profile({ id: 'second', name: 'Second' }));
		});
		await Promise.all([first, second]);

		expect(order).toEqual(['first', 'second']);
		expect(loadProfiles(projectRoot).map((p) => p.id)).toEqual(['first', 'second']);
	});

	it('does not let a rejected job poison the ones queued behind it', async () => {
		const failed = enqueueProfileWrite(projectRoot, () => {
			throw new Error('boom');
		});
		await expect(failed).rejects.toThrow(/boom/);

		await enqueueProfileWrite(projectRoot, () =>
			upsertProfile(projectRoot, profile({ id: 'after', name: 'After' }))
		);
		expect(loadProfiles(projectRoot).map((p) => p.id)).toEqual(['after']);
	});
});

describe('profile-storage malformed handling', () => {
	it('skips malformed entries but keeps valid ones (incl. base-agent-less pool roles)', () => {
		const raw = yaml.dump({
			profiles: [
				{ id: 'good', name: 'Worker', baseAgentId: 'agent-1', model: 'haiku' },
				// Phase 6: a profile without baseAgentId is a valid pool role, not malformed.
				{ id: 'pool-role', name: 'Reviewer' },
				{ name: 'no-id', baseAgentId: 'agent-1' }, // no id -> skipped
				'not-an-object', // -> skipped
			],
		});
		writeRawYaml(raw);

		const loaded = loadProfiles(projectRoot);
		expect(loaded.map((p) => p.id)).toEqual(['good', 'pool-role']);
		expect(loaded.find((p) => p.id === 'pool-role')?.baseAgentId).toBeUndefined();
	});

	it('throws (fails closed) on unparseable YAML instead of reading as empty', () => {
		writeRawYaml(':\n\t- broken: [unbalanced');
		expect(() => loadProfiles(projectRoot)).toThrow(ProfileStorageError);
	});

	it('drops duplicate ids, keeping the first', () => {
		const raw = yaml.dump({
			profiles: [
				{ id: 'dup', name: 'First', baseAgentId: 'agent-1' },
				{ id: 'dup', name: 'Second', baseAgentId: 'agent-2' },
			],
		});
		writeRawYaml(raw);

		const loaded = loadProfiles(projectRoot);
		expect(loaded).toHaveLength(1);
		expect(loaded[0].name).toBe('First');
	});
});
