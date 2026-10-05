import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendRuntimeCommand = vi.fn();
vi.mock('../../../renderer/services/runtimeMirror', () => ({
	sendRuntimeCommand: (...args: unknown[]) => sendRuntimeCommand(...args),
}));
vi.mock('../../../renderer/stores/notificationStore', () => ({ notifyToast: vi.fn() }));

import * as ops from '../../../renderer/services/agentOps';
import { notifyToast } from '../../../renderer/stores/notificationStore';

const ok = (value: unknown = undefined) => ({ result: { ok: true, value }, changes: [] });
const refused = (message: string) => ({
	result: { ok: false, error: { code: 'invalid', message, method: 'x' } },
	changes: [],
});

describe('agentOps', () => {
	beforeEach(() => {
		sendRuntimeCommand.mockReset();
		sendRuntimeCommand.mockResolvedValue(ok());
		vi.mocked(notifyToast).mockClear();
	});

	const cases: Array<[string, () => Promise<unknown>, unknown, unknown]> = [
		[
			'renameAgent',
			() => ops.renameAgent('a1', 'New'),
			{ method: 'agents.rename', agentId: 'a1', name: 'New' },
			{ agentIds: ['a1'] },
		],
		[
			'removeAgent',
			() => ops.removeAgent('a1'),
			{ method: 'agents.remove', agentId: 'a1' },
			{ agentIds: ['a1'] },
		],
		[
			'updateAgent',
			() => ops.updateAgent('a1', { nudgeMessage: 'x' }),
			{ method: 'agents.update', agentId: 'a1', patch: { nudgeMessage: 'x' } },
			{ agentIds: ['a1'] },
		],
		[
			'setAgentBookmarked',
			() => ops.setAgentBookmarked('a1', true),
			{ method: 'agents.update', agentId: 'a1', patch: { bookmarked: true } },
			{ agentIds: ['a1'] },
		],
		[
			'moveAgentToGroup',
			() => ops.moveAgentToGroup('a1', null),
			{ method: 'groups.moveAgent', agentId: 'a1', groupId: null },
			{ agentIds: ['a1'] },
		],
		[
			'createGroup',
			() => ops.createGroup({ id: 'g1', name: 'Team' }),
			{ method: 'groups.create', input: { id: 'g1', name: 'Team' } },
			{},
		],
		[
			'renameGroup',
			() => ops.renameGroup('g1', 'Squad'),
			{ method: 'groups.rename', groupId: 'g1', name: 'Squad' },
			{},
		],
		[
			'updateGroup',
			() => ops.updateGroup('g1', { icon: null }),
			{ method: 'groups.update', groupId: 'g1', patch: { icon: null } },
			{},
		],
		['removeGroup', () => ops.removeGroup('g1'), { method: 'groups.remove', groupId: 'g1' }, {}],
	];

	it.each(cases)(
		'%s sends its command and holds events only for the agents it names',
		async (_n, call, command, options) => {
			await expect(call()).resolves.toEqual({ ok: true, value: undefined });
			expect(sendRuntimeCommand).toHaveBeenCalledWith(command, options);
			expect(notifyToast).not.toHaveBeenCalled();
		}
	);

	it('createAgent hands the local copy and the new id to the mirror', async () => {
		sendRuntimeCommand.mockResolvedValue(ok({ agentId: 'a9' }));
		const local = { id: 'a9' } as never;
		const input = { id: 'a9', name: 'N', provider: 'claude-code', cwd: '/w' };
		await expect(ops.createAgent(input, local)).resolves.toEqual({
			ok: true,
			value: { agentId: 'a9' },
		});
		expect(sendRuntimeCommand).toHaveBeenCalledWith(
			{ method: 'agents.create', input },
			{ agentIds: ['a9'], creating: local }
		);
	});

	it('toasts the runtime message when a command is refused, and answers not ok', async () => {
		sendRuntimeCommand.mockResolvedValue(refused('That name is taken.'));
		await expect(ops.renameAgent('a1', 'Dup')).resolves.toEqual({
			ok: false,
			message: 'That name is taken.',
		});
		expect(notifyToast).toHaveBeenCalledWith({
			type: 'error',
			title: 'Rename Failed',
			message: 'That name is taken.',
		});
	});

	it('answers not ok and toasts when the command could not be sent at all', async () => {
		sendRuntimeCommand.mockRejectedValue(new Error('The library runtime is not available.'));
		await expect(ops.removeGroup('g1')).resolves.toEqual({
			ok: false,
			message: 'The library runtime is not available.',
		});
		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({
				title: 'Delete Failed',
				message: 'The library runtime is not available.',
			})
		);
	});
});
