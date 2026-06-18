import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	useAgentManagement,
	type UseAgentManagementReturn,
} from '../../../web/hooks/useAgentManagement';
import type { GroupData } from '../../../web/hooks/useWebSocket';

const group: GroupData = {
	id: 'group-1',
	name: 'Core',
	emoji: 'C',
	sessionIds: ['session-1'],
};

function makeSendRequest() {
	return vi.fn(async (type: string) => {
		if (type === 'get_groups') return { groups: [group] };
		if (type === 'create_session') return { success: true, sessionId: 'session-2' };
		if (type === 'delete_session') return { success: true };
		if (type === 'rename_session') return { success: true };
		if (type === 'create_group') return { success: true, groupId: 'group-2' };
		if (type === 'rename_group') return { success: true };
		if (type === 'delete_group') return { success: true };
		if (type === 'move_session_to_group') return { success: true };
		return {};
	});
}

describe('useAgentManagement', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('loads groups once per connection and resets fetch state after disconnect', async () => {
		const sendRequest = makeSendRequest();
		const { result, rerender } = renderHook(
			({ connected }) => useAgentManagement(sendRequest as any, connected),
			{ initialProps: { connected: true } }
		);

		expect(result.current.isLoading).toBe(true);
		await waitFor(() => expect(result.current.groups).toEqual([group]));
		expect(result.current.isLoading).toBe(false);
		expect(sendRequest).toHaveBeenCalledWith('get_groups');

		rerender({ connected: true });
		expect(sendRequest).toHaveBeenCalledTimes(1);

		rerender({ connected: false });
		rerender({ connected: true });
		await waitFor(() => expect(sendRequest).toHaveBeenCalledTimes(2));
	});

	it('performs agent and group CRUD request wrappers', async () => {
		const sendRequest = makeSendRequest();
		const { result } = renderHook(() => useAgentManagement(sendRequest as any, false));

		await act(async () => {
			await expect(
				result.current.createAgent('Agent', 'codex', '/tmp/project', 'group-1')
			).resolves.toEqual({
				sessionId: 'session-2',
			});
			await expect(result.current.deleteAgent('session-1')).resolves.toBe(true);
			await expect(result.current.renameAgent('session-1', 'Renamed')).resolves.toBe(true);
			await expect(result.current.getGroups()).resolves.toEqual([group]);
			await expect(result.current.createGroup('New group', 'N')).resolves.toEqual({
				id: 'group-2',
			});
			await expect(result.current.renameGroup('group-1', 'Renamed group')).resolves.toBe(true);
			await expect(result.current.deleteGroup('group-1')).resolves.toBe(true);
			await expect(result.current.moveToGroup('session-1', null)).resolves.toBe(true);
		});

		expect(sendRequest).toHaveBeenCalledWith('create_session', {
			name: 'Agent',
			toolType: 'codex',
			cwd: '/tmp/project',
			groupId: 'group-1',
		});
		expect(sendRequest).toHaveBeenCalledWith('delete_session', { sessionId: 'session-1' });
		expect(sendRequest).toHaveBeenCalledWith('rename_session', {
			sessionId: 'session-1',
			newName: 'Renamed',
		});
		expect(sendRequest).toHaveBeenCalledWith('create_group', { name: 'New group', emoji: 'N' });
		expect(sendRequest).toHaveBeenCalledWith('rename_group', {
			groupId: 'group-1',
			name: 'Renamed group',
		});
		expect(sendRequest).toHaveBeenCalledWith('delete_group', { groupId: 'group-1' });
		expect(sendRequest).toHaveBeenCalledWith('move_session_to_group', {
			sessionId: 'session-1',
			groupId: null,
		});
		expect(result.current.groups).toEqual([group]);
	});

	it('applies group broadcasts', () => {
		const { result } = renderHook(() => useAgentManagement(vi.fn() as any, false));
		const broadcastGroups = [{ ...group, name: 'Broadcast' }];

		act(() => {
			result.current.handleGroupsChanged(broadcastGroups);
		});

		expect(result.current.groups).toEqual(broadcastGroups);
	});

	it('returns safe fallbacks on missing success flags and request failures', async () => {
		const sendRequest = vi.fn(async (type: string) => {
			if (type === 'get_groups') return {};
			if (type === 'create_session') return { success: false };
			if (type === 'create_group') return { success: true };
			return {};
		});
		const { result } = renderHook(() => useAgentManagement(sendRequest as any, false));

		await act(async () => {
			await expect(
				result.current.createAgent('Agent', 'codex', '/tmp/project')
			).resolves.toBeNull();
			await expect(result.current.deleteAgent('session-1')).resolves.toBe(false);
			await expect(result.current.renameAgent('session-1', 'Renamed')).resolves.toBe(false);
			await expect(result.current.getGroups()).resolves.toEqual([]);
			await expect(result.current.createGroup('Group')).resolves.toBeNull();
			await expect(result.current.renameGroup('group-1', 'Renamed')).resolves.toBe(false);
			await expect(result.current.deleteGroup('group-1')).resolves.toBe(false);
			await expect(result.current.moveToGroup('session-1', 'group-1')).resolves.toBe(false);
		});

		sendRequest.mockRejectedValue(new Error('offline'));
		act(() => {
			result.current.handleGroupsChanged([group]);
		});
		await act(async () => {
			await expectAllFallbacks(result.current);
		});
		expect(result.current.groups).toEqual([group]);
	});
});

async function expectAllFallbacks(current: UseAgentManagementReturn) {
	await expect(current.createAgent('Agent', 'codex', '/tmp/project')).resolves.toBeNull();
	await expect(current.deleteAgent('session-1')).resolves.toBe(false);
	await expect(current.renameAgent('session-1', 'Renamed')).resolves.toBe(false);
	await expect(current.getGroups()).resolves.toEqual([group]);
	await expect(current.createGroup('Group')).resolves.toBeNull();
	await expect(current.renameGroup('group-1', 'Renamed')).resolves.toBe(false);
	await expect(current.deleteGroup('group-1')).resolves.toBe(false);
	await expect(current.moveToGroup('session-1', 'group-1')).resolves.toBe(false);
}
