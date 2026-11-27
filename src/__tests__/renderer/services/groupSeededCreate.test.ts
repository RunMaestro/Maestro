/**
 * @fileoverview Seeding a create from a group's defaults for a caller with no
 * form (`maestro-cli create-agent --group`). The merge rules themselves are
 * pinned in shared/groupAgentDefaults.test.ts; this covers which group seeds,
 * what the seed is judged against, and what is reported back.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { seedRemoteCreate, seedableGroup } from '../../../renderer/services/groupSeededCreate';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import type { Group, GroupAgentDefaults } from '../../../shared/types';

vi.mock('../../../renderer/stores/sessionStore', () => ({
	useSessionStore: Object.assign(vi.fn(), { getState: vi.fn(() => ({ groups: [] })) }),
}));
vi.mock('../../../renderer/utils/logger', () => ({
	logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../renderer/stores/settingsStore', () => ({
	useSettingsStore: Object.assign(vi.fn(), { getState: vi.fn(() => ({})) }),
}));

const group = (defaults?: GroupAgentDefaults, overrides: Partial<Group> = {}): Group => ({
	id: 'group-1',
	name: 'Work',
	emoji: '💼',
	collapsed: false,
	...(defaults ? { defaults } : {}),
	...overrides,
});

function useGroups(...groups: Group[]) {
	vi.mocked(useSessionStore.getState).mockReturnValue({ groups } as never);
}

const getConfigs = vi.fn();

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(useSettingsStore.getState).mockReturnValue({ localModelEndpoints: [] } as never);
	getConfigs.mockResolvedValue({ success: true, configs: [{ id: 'remote-1', name: 'Box' }] });
	(window as any).maestro = { sshRemote: { getConfigs } };
});

describe('seedableGroup', () => {
	it('finds a user group that holds defaults', () => {
		const groups = [group({ customModel: 'opus' })];
		expect(seedableGroup('group-1', groups)?.id).toBe('group-1');
	});

	it.each([
		['no id', undefined, [group({ customModel: 'opus' })]],
		['an unknown id', 'nope', [group({ customModel: 'opus' })]],
		['a group with no defaults', 'group-1', [group()]],
		['a group with empty defaults', 'group-1', [group({})]],
		['a worktree group', 'group-1', [group({ customModel: 'opus' }, { kind: 'worktree' })]],
	])('finds nothing for %s', (_name, id, groups) => {
		expect(seedableGroup(id, groups)).toBeUndefined();
	});
});

describe('seedRemoteCreate', () => {
	it('lays the explicit fields over the group seed and reports the group', async () => {
		useGroups(group({ toolType: 'claude-code', customModel: 'opus', nudgeMessage: 'Be brief.' }));

		const seeded = await seedRemoteCreate({
			groupId: 'group-1',
			toolType: 'claude-code',
			explicit: { customModel: 'sonnet' },
		});

		expect(seeded.seededFromGroup).toBe('group-1');
		expect(seeded.fields).toEqual({ customModel: 'sonnet', nudgeMessage: 'Be brief.' });
		expect(seeded.skipped).toEqual([]);
	});

	it('returns the explicit fields untouched when no group seeds', async () => {
		useGroups(group({ customModel: 'opus' }));
		const explicit = { customModel: 'sonnet' };

		const seeded = await seedRemoteCreate({ toolType: 'claude-code', explicit });
		expect(seeded).toEqual({ seededFromGroup: null, fields: explicit, extras: {}, skipped: [] });

		const bare = await seedRemoteCreate({
			groupId: 'group-1',
			toolType: 'claude-code',
			explicit,
			seed: false,
		});
		expect(bare.seededFromGroup).toBeNull();
		expect(bare.fields).toBe(explicit);
	});

	it('hands back the defaults the create has no field for', async () => {
		useGroups(
			group({
				toolType: 'claude-code',
				systemOneOptOut: true,
				customEnvVarsDisabled: { DEBUG: '1' },
			})
		);

		const { extras } = await seedRemoteCreate({
			groupId: 'group-1',
			toolType: 'claude-code',
			explicit: {},
		});

		expect(extras).toEqual({ systemOneOptOut: true, customEnvVarsDisabled: { DEBUG: '1' } });
	});

	it('does not stamp a switched-off variable the caller switched on', async () => {
		useGroups(group({ customEnvVarsDisabled: { DEBUG: '1', TRACE: '1' } }));

		const { extras } = await seedRemoteCreate({
			groupId: 'group-1',
			toolType: 'claude-code',
			explicit: { customEnvVars: { DEBUG: '2' } },
		});

		expect(extras.customEnvVarsDisabled).toEqual({ TRACE: '1' });
	});

	it('names an SSH remote that no longer exists, and runs the agent here', async () => {
		useGroups(
			group({ sessionSshRemoteConfig: { enabled: true, remoteId: 'gone' }, nudgeMessage: 'Hi' })
		);

		const seeded = await seedRemoteCreate({
			groupId: 'group-1',
			toolType: 'claude-code',
			explicit: {},
		});

		expect(seeded.fields).not.toHaveProperty('sessionSshRemoteConfig');
		expect(seeded.fields.nudgeMessage).toBe('Hi');
		expect(seeded.skipped).toEqual([expect.stringContaining('no longer exists')]);
	});

	it('keeps the remote when the remotes cannot be read', async () => {
		getConfigs.mockRejectedValue(new Error('ipc down'));
		useGroups(group({ sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' } }));

		const seeded = await seedRemoteCreate({
			groupId: 'group-1',
			toolType: 'claude-code',
			explicit: {},
		});

		// A remote wrongly judged gone would run the agent on this machine.
		expect(seeded.fields.sessionSshRemoteConfig?.remoteId).toBe('remote-1');
		expect(seeded.skipped).toEqual([]);
	});
});
