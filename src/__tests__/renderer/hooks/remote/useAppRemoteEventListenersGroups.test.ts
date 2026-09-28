/**
 * Covers the remote group create/update handlers in useAppRemoteEventListeners -
 * the path `maestro-cli create-group` / `update-group` drive.
 *
 * The invariants under test: appearance is re-validated in the renderer (this
 * listener is reachable from any WebSocket client, not just our CLI), the group
 * list is flushed to disk before the ack (so a CLI readback is not racing the
 * store's effect-driven persistence), setting an icon never silently discards
 * the emoji the Groups+-disabled view falls back to, clearing is explicit, and
 * an illegal reparent is refused instead of half-applied.
 */
import { renderHook } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { useAppRemoteEventListeners } from '../../../../renderer/hooks/remote/useAppRemoteEventListeners';
import type { Group } from '../../../../shared/types';

const storeState: { groups: Group[] } = { groups: [] };

vi.mock('../../../../renderer/stores/sessionStore', () => ({
	useSessionStore: Object.assign(vi.fn(), { getState: vi.fn(() => storeState) }),
	selectSessionById: vi.fn(),
}));
vi.mock('../../../../renderer/stores/settingsStore', () => ({
	useSettingsStore: Object.assign(vi.fn(), { getState: vi.fn(() => ({})) }),
}));
vi.mock('../../../../renderer/hooks/batch/batchUtils', () => ({ DEFAULT_BATCH_PROMPT: '' }));
vi.mock('../../../../renderer/services/git', () => ({ gitService: {} }));
vi.mock('../../../../renderer/utils/worktreeSpawn', () => ({
	spawnWorktreeAgentAndDispatch: vi.fn(),
}));
vi.mock('../../../../renderer/stores/notificationStore', () => ({ notifyToast: vi.fn() }));
vi.mock('../../../../renderer/utils/browserTabPersistence', () => ({
	getBrowserTabPartition: () => 'persist:test',
}));
vi.mock('../../../../renderer/utils/ids', () => ({ generateId: () => 'new-group' }));

const createAck = vi.fn();
const updateAck = vi.fn();
const setAll = vi.fn().mockResolvedValue(undefined);

const DEFAULT_EMOJI = '\u{1F4C2}';

function setup() {
	const setGroups = vi.fn();
	renderHook(() =>
		useAppRemoteEventListeners({
			sessionsRef: { current: [] },
			setActiveSessionId: vi.fn(),
			setSessions: vi.fn(),
			setGroups,
			handleOpenFileTab: vi.fn(),
			refreshFileTree: vi.fn(),
			handleAutoRunRefresh: vi.fn(),
			startBatchRun: vi.fn(),
			stopBatchRun: vi.fn(),
			resumeAfterError: vi.fn(),
			skipCurrentDocument: vi.fn(),
			abortBatchOnError: vi.fn(),
		} as any)
	);
	return { setGroups };
}

/** The group list the handler asked the store to hold. */
function resultingGroups(setGroups: Mock, prev: Group[]): Group[] {
	const arg = setGroups.mock.calls[0][0];
	return typeof arg === 'function' ? arg(prev) : arg;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function dispatchCreate(detail: Record<string, unknown>) {
	window.dispatchEvent(
		new CustomEvent('maestro:remoteCreateGroup', {
			detail: { responseChannel: 'ch', ...detail },
		})
	);
}

function dispatchUpdate(groupId: string, update: Record<string, unknown>) {
	window.dispatchEvent(
		new CustomEvent('maestro:remoteUpdateGroup', {
			detail: { groupId, update, responseChannel: 'ch' },
		})
	);
}

function group(overrides: Partial<Group> & { id: string }): Group {
	return { name: 'TEAM', emoji: DEFAULT_EMOJI, collapsed: false, ...overrides } as Group;
}

beforeEach(() => {
	vi.clearAllMocks();
	storeState.groups = [];
	(window as any).maestro = {
		process: {
			sendRemoteCreateGroupResponse: createAck,
			sendRemoteUpdateGroupResponse: updateAck,
			kill: vi.fn().mockResolvedValue(undefined),
		},
		groups: { setAll },
		sessions: { setMany: vi.fn().mockResolvedValue(undefined) },
	};
});

describe('maestro:remoteCreateGroup', () => {
	it('stores a normalized icon and color and flushes before acking', async () => {
		const { setGroups } = setup();

		dispatchCreate({ name: 'Team', appearance: { icon: 'rocket', color: '#EF4444' } });
		await flush();

		const [created] = resultingGroups(setGroups, []);
		expect(created).toMatchObject({
			id: 'group-new-group',
			name: 'TEAM',
			icon: 'rocket',
			color: '#EF4444',
		});
		expect(setAll).toHaveBeenCalled();
		expect(createAck).toHaveBeenCalledWith('ch', { id: 'group-new-group' });
		// The disk write has to happen before the ack, or a CLI readback races it.
		expect(setAll.mock.invocationCallOrder[0]).toBeLessThan(createAck.mock.invocationCallOrder[0]);
	});

	it('falls back to the default emoji when no appearance is requested', async () => {
		const { setGroups } = setup();

		dispatchCreate({ name: 'Team', appearance: {} });
		await flush();

		expect(resultingGroups(setGroups, [])[0].emoji).toBe(DEFAULT_EMOJI);
	});

	it('refuses an icon the picker cannot draw, even straight off the socket', async () => {
		const { setGroups } = setup();

		dispatchCreate({ name: 'Team', appearance: { icon: 'sparkle-pony' } });
		await flush();

		expect(setGroups).not.toHaveBeenCalled();
		expect(createAck).toHaveBeenCalledWith('ch', null);
	});

	it('refuses an emoji and an icon together', async () => {
		const { setGroups } = setup();

		dispatchCreate({ name: 'Team', emoji: '🚀', appearance: { icon: 'rocket' } });
		await flush();

		expect(setGroups).not.toHaveBeenCalled();
		expect(createAck).toHaveBeenCalledWith('ch', null);
	});
});

describe('maestro:remoteUpdateGroup', () => {
	it('applies an icon and color and flushes before acking', async () => {
		storeState.groups = [group({ id: 'g1' })];
		const { setGroups } = setup();

		dispatchUpdate('g1', { icon: 'shield', color: '#22C55E' });
		await flush();

		expect(resultingGroups(setGroups, storeState.groups)[0]).toMatchObject({
			icon: 'shield',
			color: '#22C55E',
		});
		expect(updateAck).toHaveBeenCalledWith('ch', true);
		expect(setAll.mock.invocationCallOrder[0]).toBeLessThan(updateAck.mock.invocationCallOrder[0]);
	});

	it('keeps the emoji when an icon is set, so the Groups+-off view still has a glyph', async () => {
		storeState.groups = [group({ id: 'g1', emoji: '🚀' })];
		const { setGroups } = setup();

		dispatchUpdate('g1', { icon: 'shield' });
		await flush();

		expect(resultingGroups(setGroups, storeState.groups)[0]).toMatchObject({
			emoji: '🚀',
			icon: 'shield',
		});
	});

	it('uppercases a new name, matching the rename path', async () => {
		storeState.groups = [group({ id: 'g1' })];
		const { setGroups } = setup();

		dispatchUpdate('g1', { name: 'Team Alpha' });
		await flush();

		expect(resultingGroups(setGroups, storeState.groups)[0].name).toBe('TEAM ALPHA');
	});

	it('removes icon and color on an explicit clear', async () => {
		storeState.groups = [group({ id: 'g1', icon: 'shield', color: '#22C55E' })];
		const { setGroups } = setup();

		dispatchUpdate('g1', { clear: ['icon', 'color'] });
		await flush();

		const updated = resultingGroups(setGroups, storeState.groups)[0];
		expect(updated).not.toHaveProperty('icon');
		expect(updated).not.toHaveProperty('color');
	});

	it('restores the default folder when the emoji is cleared', async () => {
		storeState.groups = [group({ id: 'g1', emoji: '🚀' })];
		const { setGroups } = setup();

		dispatchUpdate('g1', { clear: ['emoji'] });
		await flush();

		expect(resultingGroups(setGroups, storeState.groups)[0].emoji).toBe(DEFAULT_EMOJI);
	});

	it('reparents a group under a root group', async () => {
		storeState.groups = [group({ id: 'g1' }), group({ id: 'root', name: 'ROOT' })];
		const { setGroups } = setup();

		dispatchUpdate('g1', { parentGroupId: 'root' });
		await flush();

		const updated = resultingGroups(setGroups, storeState.groups).find((g) => g.id === 'g1');
		expect(updated?.parentGroupId).toBe('root');
		expect(updateAck).toHaveBeenCalledWith('ch', true);
	});

	it('promotes a group to the top level on clear-parent', async () => {
		storeState.groups = [group({ id: 'g1', parentGroupId: 'root' }), group({ id: 'root' })];
		const { setGroups } = setup();

		dispatchUpdate('g1', { clear: ['parent'] });
		await flush();

		const updated = resultingGroups(setGroups, storeState.groups).find((g) => g.id === 'g1');
		expect(updated?.parentGroupId).toBeUndefined();
	});

	it('refuses an illegal reparent without writing anything', async () => {
		// Nesting is one level deep, so a group that already has a child cannot
		// itself become a child.
		storeState.groups = [group({ id: 'g1' }), group({ id: 'child', parentGroupId: 'g1' })];
		const { setGroups } = setup();

		dispatchUpdate('g1', { parentGroupId: 'child' });
		await flush();

		expect(setGroups).not.toHaveBeenCalled();
		expect(setAll).not.toHaveBeenCalled();
		expect(updateAck).toHaveBeenCalledWith('ch', false);
	});

	it('refuses an update to a group that no longer exists', async () => {
		storeState.groups = [];
		const { setGroups } = setup();

		dispatchUpdate('gone', { icon: 'shield' });
		await flush();

		expect(setGroups).not.toHaveBeenCalled();
		expect(updateAck).toHaveBeenCalledWith('ch', false);
	});

	it('refuses an update that sets and clears the same field', async () => {
		storeState.groups = [group({ id: 'g1' })];
		const { setGroups } = setup();

		dispatchUpdate('g1', { icon: 'shield', clear: ['icon'] });
		await flush();

		expect(setGroups).not.toHaveBeenCalled();
		expect(updateAck).toHaveBeenCalledWith('ch', false);
	});
});
