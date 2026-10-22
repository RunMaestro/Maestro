/**
 * Tests for the remote Group Settings write (`update-group-settings`): the same
 * four steps the dialog's Save takes, with a typed patch for the form. A
 * refusal writes nothing, a write is flushed before it is reported, and a
 * publish pushes exactly the diff of this call.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { applyRemoteGroupSettings } from '../../../renderer/services/groupSettingsRemote';
import { __resetGroupDefaultsPublishForTests } from '../../../renderer/services/groupDefaultsPublish';
import { useNotificationStore } from '../../../renderer/stores/notificationStore';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import type { Group, Session } from '../../../renderer/types';
import { createMockSession } from '../../helpers/mockSession';

const GROUP_ID = 'g-backend';

function group(overrides: Partial<Group> = {}): Group {
	return { id: GROUP_ID, name: 'BACKEND', emoji: '🛠', collapsed: false, ...overrides };
}

function member(id: string, overrides: Partial<Session> = {}): Session {
	return createMockSession({ id, name: id, groupId: GROUP_ID, ...overrides });
}

function seed(groups: Group[], sessions: Session[] = []): void {
	useSessionStore.setState({ groups, sessions });
}

function storedGroup(): Group {
	return useSessionStore.getState().groups.find((g) => g.id === GROUP_ID)!;
}

function storedAgent(id: string): Session {
	return useSessionStore.getState().sessions.find((s) => s.id === id)!;
}

beforeEach(() => {
	__resetGroupDefaultsPublishForTests();
	useNotificationStore.setState({ toasts: [] });
	useSettingsStore.setState({ shellEnvVars: {}, localModelEndpoints: [] });
	vi.mocked(window.maestro.groups.setAll).mockReset();
	vi.mocked(window.maestro.groups.setAll).mockResolvedValue(true as never);
	vi.mocked(window.maestro.sessions.setMany).mockReset();
	vi.mocked(window.maestro.sessions.setMany).mockResolvedValue(undefined as never);
	vi.mocked(window.maestro.sshRemote.getConfigs).mockResolvedValue({
		success: true,
		configs: [],
	} as never);
});

describe('applyRemoteGroupSettings', () => {
	it('writes the profile and flushes the group list before it reports', async () => {
		seed([group()]);

		const result = await applyRemoteGroupSettings(GROUP_ID, {
			configPatch: { nudgeMessage: 'Be brief.' },
		});

		expect(result).toMatchObject({
			success: true,
			defaults: { nudgeMessage: 'Be brief.' },
			shortLabel: null,
			changed: ['Nudge Message'],
		});
		expect(storedGroup().defaults).toEqual({ nudgeMessage: 'Be brief.' });
		const flushed = vi.mocked(window.maestro.groups.setAll).mock.calls[0][0] as Group[];
		expect(flushed.find((g) => g.id === GROUP_ID)?.defaults).toEqual({ nudgeMessage: 'Be brief.' });
	});

	it('writes nothing when a value is refused', async () => {
		seed([group({ defaults: { nudgeMessage: 'Keep.' } })]);

		const result = await applyRemoteGroupSettings(GROUP_ID, {
			configPatch: { nudgeMessage: 'New.', customModel: 'opus' },
		});

		expect(result.success).toBe(false);
		expect(result.error).toContain('--model');
		expect(storedGroup().defaults).toEqual({ nudgeMessage: 'Keep.' });
		expect(window.maestro.groups.setAll).not.toHaveBeenCalled();
	});

	it('refuses a group that does not exist', async () => {
		seed([]);
		const result = await applyRemoteGroupSettings('nope', { configPatch: { nudgeMessage: 'x' } });
		expect(result).toEqual({ success: false, error: 'Group not found' });
	});

	it('refuses a worktree group', async () => {
		seed([group({ kind: 'worktree' })]);
		const result = await applyRemoteGroupSettings(GROUP_ID, { shortLabel: 'WT' });
		expect(result.success).toBe(false);
		expect(result.error).toContain('worktree group');
	});

	describe('pill label', () => {
		it('sets, trims and clears the label without touching the defaults', async () => {
			seed([group({ defaults: { nudgeMessage: 'N' } })]);

			const set = await applyRemoteGroupSettings(GROUP_ID, { shortLabel: '  BE  ' });
			expect(set).toMatchObject({ success: true, shortLabel: 'BE' });
			expect(storedGroup()).toMatchObject({ shortLabel: 'BE', defaults: { nudgeMessage: 'N' } });
			expect(set.changed).toEqual([]);

			const cleared = await applyRemoteGroupSettings(GROUP_ID, { shortLabel: '' });
			expect(cleared).toMatchObject({ success: true, shortLabel: null });
			expect(storedGroup().shortLabel).toBeUndefined();
		});

		it('refuses a label longer than the pill holds', async () => {
			seed([group()]);
			const result = await applyRemoteGroupSettings(GROUP_ID, { shortLabel: 'ABCDEFGHIJKLM' });
			expect(result.success).toBe(false);
			expect(result.error).toContain('12');
			expect(storedGroup().shortLabel).toBeUndefined();
		});
	});

	describe('clearing', () => {
		it('removes the defaults and keeps the label', async () => {
			seed([group({ shortLabel: 'BE', defaults: { nudgeMessage: 'N' } })]);

			const result = await applyRemoteGroupSettings(GROUP_ID, { clearDefaults: true });

			expect(result).toMatchObject({ success: true, defaults: null, shortLabel: 'BE' });
			expect(storedGroup().defaults).toBeUndefined();
			expect(storedGroup().shortLabel).toBe('BE');
		});
	});

	describe('publish', () => {
		it('writes this call to direct members and leaves non-members and unpublishable fields alone', async () => {
			const outsider = member('outsider', { groupId: 'g-other' });
			const child = member('child', { groupId: 'g-child' });
			seed(
				[group(), group({ id: 'g-child', name: 'CHILD', parentGroupId: GROUP_ID })],
				[member('a'), member('b', { nudgeMessage: 'Mine.' }), outsider, child]
			);

			const result = await applyRemoteGroupSettings(GROUP_ID, {
				configPatch: { nudgeMessage: 'Be brief.', projectRoot: '/work/app' },
				publish: true,
			});

			expect(result.success).toBe(true);
			expect(result.publish?.agents.map((agent) => agent.id).sort()).toEqual(['a', 'b']);
			expect(result.publish?.changed).toEqual(['Nudge Message']);
			expect(result.publish?.unpublished).toEqual(['Working Directory']);
			expect(storedAgent('a').nudgeMessage).toBe('Be brief.');
			expect(storedAgent('b').nudgeMessage).toBe('Be brief.');
			// Never the working directory.
			expect(storedAgent('a').projectRoot).not.toBe('/work/app');
			expect(storedAgent('outsider')).toBe(outsider);
			expect(storedAgent('child')).toBe(child);
		});

		it('pushes only what this call changed, not what the profile already held', async () => {
			seed(
				[group({ defaults: { nudgeMessage: 'Old group nudge.' } })],
				[member('a', { nudgeMessage: 'Tuned by hand.' })]
			);

			const result = await applyRemoteGroupSettings(GROUP_ID, {
				configPatch: { newSessionMessage: 'Hello.' },
				publish: true,
			});

			expect(result.publish?.agents).toHaveLength(1);
			expect(storedAgent('a').newSessionMessage).toBe('Hello.');
			expect(storedAgent('a').nudgeMessage).toBe('Tuned by hand.');
		});

		it('offers the dialog Undo toast, since the CLI has none', async () => {
			seed([group()], [member('a')]);

			await applyRemoteGroupSettings(GROUP_ID, {
				configPatch: { nudgeMessage: 'N' },
				publish: true,
			});

			const toasts = useNotificationStore.getState().toasts;
			expect(toasts.some((toast) => toast.clickAction?.kind === 'undo-group-publish')).toBe(true);
		});

		it('reports nothing to publish when the label is the only change', async () => {
			seed([group()], [member('a')]);

			const result = await applyRemoteGroupSettings(GROUP_ID, { shortLabel: 'BE', publish: true });

			expect(result.success).toBe(true);
			expect(result.publish?.agents).toEqual([]);
			expect(result.publish?.changed).toEqual([]);
			expect(window.maestro.sessions.setMany).not.toHaveBeenCalled();
		});

		it('does not write a profile whose provider-bound value would reach another provider', async () => {
			seed(
				[group()],
				[member('claude', { toolType: 'claude-code' }), member('codex', { toolType: 'codex' })]
			);

			const result = await applyRemoteGroupSettings(GROUP_ID, {
				configPatch: { toolType: 'claude-code', customModel: 'opus' },
				publish: true,
			});

			expect(result.success).toBe(true);
			expect(storedAgent('claude').customModel).toBe('opus');
			expect(storedAgent('codex').customModel).not.toBe('opus');
			// The provider itself is never published.
			expect(storedAgent('codex').toolType).toBe('codex');
			expect(result.publish?.unpublished).toContain('Provider');
		});
	});
});
