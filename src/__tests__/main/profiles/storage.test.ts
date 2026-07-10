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
} from '../../../main/profiles/profile-storage';
import type { AgentProfile } from '../../../shared/profiles/types';

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

	it('returns an empty list on unparseable YAML', () => {
		writeRawYaml(':\n\t- broken: [unbalanced');
		expect(loadProfiles(projectRoot)).toEqual([]);
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
