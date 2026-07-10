/**
 * @file profile.test.ts
 * @description Integration tests for `maestro-cli profile` (Phase 5 / Phase 1
 * parity). Drives the CLI commands end-to-end against a real temp project root
 * so the `.maestro/profiles.yaml` round-trip is asserted on disk. Only the agent
 * lookup (`storage`) is mocked; the profile storage module runs unmodified.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const mockGetSessionById = vi.fn();
const mockResolveAgentId = vi.fn();

vi.mock('../../../cli/services/storage', () => ({
	getSessionById: (id: string) => mockGetSessionById(id),
	resolveAgentId: (partial: string) => mockResolveAgentId(partial),
	readSessions: vi.fn(),
}));

import { profileList, profileCreate, profileDelete } from '../../../cli/commands/profile';
import { listProfiles } from '../../../main/profiles/profile-storage';

describe('maestro-cli profile', () => {
	let projectRoot = '';
	let logSpy: MockInstance;
	let exitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-cli-'));
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
		mockResolveAgentId.mockReturnValue('agent-1');
		mockGetSessionById.mockReturnValue({
			id: 'agent-1',
			name: 'Alpha',
			toolType: 'claude-code',
			projectRoot,
			cwd: projectRoot,
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		if (projectRoot && fs.existsSync(projectRoot)) {
			fs.rmSync(projectRoot, { recursive: true, force: true });
		}
	});

	it('profile create writes a profile layered on the base agent', async () => {
		await profileCreate({
			base: 'Alpha',
			name: 'Reviewer',
			model: 'sonnet',
			effort: 'high',
			role: 'Be adversarial.',
			json: true,
		});
		const profiles = listProfiles(projectRoot);
		expect(profiles).toHaveLength(1);
		expect(profiles[0].name).toBe('Reviewer');
		expect(profiles[0].baseAgentId).toBe('agent-1');
		expect(profiles[0].model).toBe('sonnet');
		expect(profiles[0].effort).toBe('high');
		expect(profiles[0].appendSystemPrompt).toBe('Be adversarial.');
	});

	it('profile list --json prints all profiles', async () => {
		await profileCreate({ base: 'Alpha', name: 'One', json: true });
		logSpy.mockClear();
		await profileList({ agent: 'Alpha', json: true });
		const parsed = JSON.parse(logSpy.mock.calls.map((c) => c[0]).join('\n'));
		expect(parsed).toHaveLength(1);
		expect(parsed[0].name).toBe('One');
	});

	it('profile delete removes a profile by id prefix', async () => {
		await profileCreate({ base: 'Alpha', name: 'ToDelete', json: true });
		const created = listProfiles(projectRoot)[0];
		await profileDelete(created.id.slice(0, 8), { agent: 'Alpha', json: true });
		expect(listProfiles(projectRoot)).toHaveLength(0);
	});

	it('profile create requires a name', async () => {
		await profileCreate({ base: 'Alpha', name: '  ', json: true });
		expect(exitSpy).toHaveBeenCalledWith(1);
		expect(listProfiles(projectRoot)).toHaveLength(0);
	});

	it('profile delete exits non-zero for an unknown profile', async () => {
		await profileDelete('nope', { agent: 'Alpha', json: true });
		expect(exitSpy).toHaveBeenCalledWith(1);
	});
});
