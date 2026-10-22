import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
	resolveWindowDestination,
	runRemoteWindowCommand,
} from '../../../renderer/services/windowCommands';
import { buildWindowMoveTargets } from '../../../renderer/utils/windowTargets';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { createMockSession } from '../../helpers/mockSession';
import type { WindowInfo } from '../../../shared/window-types';

const windows: WindowInfo[] = [
	{ id: 'p', isMain: true, sessionIds: [], activeSessionId: null },
	{ id: 'w2', isMain: false, sessionIds: ['b'], activeSessionId: null, name: 'Research' },
];

function makeCtx() {
	return {
		windows,
		moveSessionToNewWindow: vi.fn(async () => ({
			moved: true,
			windowId: 'w3',
			movedAgentIds: ['a'],
		})),
		moveSessionToWindow: vi.fn(async () => ({ moved: true, windowId: 'w2', movedAgentIds: ['a'] })),
		moveGroupToNewWindow: vi.fn(async () => ({ moved: false, error: 'blocked' })),
		moveGroupToWindow: vi.fn(async () => ({ moved: false, windowId: 'p', movedAgentIds: [] })),
	};
}

describe('resolveWindowDestination', () => {
	const targets = buildWindowMoveTargets(windows, '');
	it('matches main, a number, an id, and a custom name', () => {
		expect(resolveWindowDestination('main', targets)?.windowId).toBe('p');
		expect(resolveWindowDestination('2', targets)?.windowId).toBe('w2');
		expect(resolveWindowDestination('w2', targets)?.windowId).toBe('w2');
		expect(resolveWindowDestination('research', targets)?.windowId).toBe('w2');
		expect(resolveWindowDestination('9', targets)).toBeNull();
	});
});

describe('runRemoteWindowCommand', () => {
	beforeEach(() => {
		useSessionStore.setState({
			sessions: [createMockSession({ id: 'a' }), createMockSession({ id: 'b' })],
			groups: [{ id: 'g', name: 'G', emoji: '', collapsed: false }],
		} as unknown as Parameters<typeof useSessionStore.setState>[0]);
	});

	it('fails outside a multi-window client', async () => {
		const ctx = { ...makeCtx(), windows: [] };
		const result = await runRemoteWindowCommand({ action: 'list' }, ctx);
		expect(result.success).toBe(false);
	});

	it('routes "new" to the new-window mover', async () => {
		const ctx = makeCtx();
		const result = await runRemoteWindowCommand(
			{ action: 'move-agent', targetId: 'a', to: 'NEW' },
			ctx
		);
		expect(ctx.moveSessionToNewWindow).toHaveBeenCalledWith('a');
		expect(result).toEqual({
			success: true,
			windowId: 'w3',
			windowLabel: 'New Window',
			movedAgentIds: ['a'],
		});
	});

	it('resolves a named window and relays a group move', async () => {
		const ctx = makeCtx();
		const result = await runRemoteWindowCommand(
			{ action: 'move-group', targetId: 'g', to: 'main' },
			ctx
		);
		expect(ctx.moveGroupToWindow).toHaveBeenCalledWith('g', 'p');
		expect(result).toEqual({
			success: true,
			windowId: 'p',
			windowLabel: 'Main Window',
			movedAgentIds: [],
		});
	});

	it('surfaces a blocked move as an error', async () => {
		const result = await runRemoteWindowCommand(
			{ action: 'move-group', targetId: 'g', to: 'new' },
			makeCtx()
		);
		expect(result).toEqual({ success: false, error: 'blocked' });
	});

	it('names unknown agents, groups, and windows', async () => {
		const ctx = makeCtx();
		expect(
			(await runRemoteWindowCommand({ action: 'move-agent', targetId: 'zz', to: 'new' }, ctx)).error
		).toBe('Agent not found: zz');
		expect(
			(await runRemoteWindowCommand({ action: 'move-group', targetId: 'zz', to: 'new' }, ctx)).error
		).toBe('Group not found: zz');
		expect(
			(await runRemoteWindowCommand({ action: 'move-agent', targetId: 'a', to: '7' }, ctx)).error
		).toMatch(/No window matches "7"/);
	});
});
