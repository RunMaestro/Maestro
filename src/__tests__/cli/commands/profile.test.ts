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

import {
	profileList,
	profileCreate,
	profileShow,
	profileUpdate,
	profileDelete,
} from '../../../cli/commands/profile';
import { listProfiles } from '../../../main/profiles/profile-storage';
import { createBoard, addCard, loadBoards } from '../../../main/board/board-storage';

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

	it('profile update edits in place, keeping the id and every card that references it', async () => {
		await profileCreate({ base: 'Alpha', name: 'Reviewer', model: 'sonnet', json: true });
		const created = listProfiles(projectRoot)[0];

		// A board card pointing at this role must survive the edit.
		const board = createBoard(projectRoot, 'B');
		addCard(projectRoot, board.id, {
			id: 'card-1',
			title: 'Review it',
			body: '',
			assigneeProfileId: created.id,
			parents: [],
			status: 'todo',
			createdAt: '2026-07-10T00:00:00.000Z',
			updatedAt: '2026-07-10T00:00:00.000Z',
		});

		await profileUpdate(created.id.slice(0, 8), {
			agent: 'Alpha',
			name: 'Adversarial Reviewer',
			model: 'opus',
			effort: 'high',
			rolePrompt: 'Find the bug.',
			args: '--verbose',
			json: true,
		});

		const profiles = listProfiles(projectRoot);
		expect(profiles).toHaveLength(1);
		expect(profiles[0].id).toBe(created.id);
		expect(profiles[0].name).toBe('Adversarial Reviewer');
		expect(profiles[0].model).toBe('opus');
		expect(profiles[0].effort).toBe('high');
		expect(profiles[0].appendSystemPrompt).toBe('Find the bug.');
		expect(profiles[0].customArgs).toBe('--verbose');
		expect(profiles[0].baseAgentId).toBe('agent-1');
		expect(loadBoards(projectRoot)[0].cards[0].assigneeProfileId).toBe(created.id);
	});

	it('profile update leaves untouched fields alone and clears on an empty value', async () => {
		await profileCreate({
			base: 'Alpha',
			name: 'Keeper',
			model: 'sonnet',
			effort: 'high',
			json: true,
		});
		const created = listProfiles(projectRoot)[0];
		await profileUpdate(created.id, { agent: 'Alpha', model: '', json: true });
		const updated = listProfiles(projectRoot)[0];
		expect(updated.model).toBeUndefined();
		expect(updated.effort).toBe('high');
		expect(updated.name).toBe('Keeper');
	});

	it('profile update --pool drops the base agent', async () => {
		await profileCreate({ base: 'Alpha', name: 'Pinned', json: true });
		const created = listProfiles(projectRoot)[0];
		expect(created.baseAgentId).toBe('agent-1');
		await profileUpdate(created.id, { agent: 'Alpha', pool: true, json: true });
		expect(listProfiles(projectRoot)[0].baseAgentId).toBeUndefined();
	});

	it('profile update rejects --pool with --base, an unknown id, and a no-op call', async () => {
		await profileCreate({ base: 'Alpha', name: 'Solo', json: true });
		const created = listProfiles(projectRoot)[0];

		await profileUpdate(created.id, { agent: 'Alpha', pool: true, base: 'Alpha', json: true });
		expect(exitSpy).toHaveBeenCalledWith(1);
		await profileUpdate('ghost', { agent: 'Alpha', name: 'X', json: true });
		await profileUpdate(created.id, { agent: 'Alpha', json: true });
		expect(exitSpy).toHaveBeenCalledTimes(3);
		expect(listProfiles(projectRoot)[0]).toEqual(created);
	});

	it('profile show --json prints the profile and its resolved overrides', async () => {
		await profileCreate({ base: 'Alpha', name: 'Shown', effort: 'high', json: true });
		const created = listProfiles(projectRoot)[0];
		logSpy.mockClear();
		await profileShow(created.id.slice(0, 8), { agent: 'Alpha', json: true });
		const parsed = JSON.parse(logSpy.mock.calls.map((c) => c[0]).join('\n'));
		expect(parsed.profile.id).toBe(created.id);
		expect(parsed.resolved.customEffort).toBe('high');
		// The base agent supplies nothing here, so an unset override stays unset.
		expect(parsed.resolved.customModel).toBeUndefined();
	});

	it('profile show falls back to the base agent for unset overrides', async () => {
		mockGetSessionById.mockReturnValue({
			id: 'agent-1',
			name: 'Alpha',
			toolType: 'claude-code',
			projectRoot,
			cwd: projectRoot,
			customModel: 'base-model',
		});
		await profileCreate({ base: 'Alpha', name: 'Layered', effort: 'low', json: true });
		const created = listProfiles(projectRoot)[0];
		logSpy.mockClear();
		await profileShow(created.id, { agent: 'Alpha', json: true });
		const parsed = JSON.parse(logSpy.mock.calls.map((c) => c[0]).join('\n'));
		expect(parsed.resolved.customModel).toBe('base-model');
		expect(parsed.resolved.customEffort).toBe('low');
	});

	it('profile show exits non-zero for an unknown profile', async () => {
		await profileShow('nope', { agent: 'Alpha', json: true });
		expect(exitSpy).toHaveBeenCalledWith(1);
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
