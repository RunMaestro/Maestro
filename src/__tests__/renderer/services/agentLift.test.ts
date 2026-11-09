/**
 * Tests for the window side of Move to Host (FED-SSH-06): pending writes flush before main reads
 * the agent, the plan is a dry run, a lift toasts where to send next, and a lifted agent's pointer
 * opens the mirrored agent (or says why it cannot).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../renderer/stores/notificationStore', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../renderer/stores/notificationStore')>()),
	notifyToast: vi.fn(),
}));
const flush = vi.fn(async () => undefined);
vi.mock('../../../renderer/services/sessionPersistenceFlush', () => ({
	flushSessionPersistenceNow: () => flush(),
}));

import {
	moveAgentToHost,
	openLiftedAgent,
	planMoveToHost,
	requestMoveToHost,
} from '../../../renderer/services/agentLift';
import { notifyToast } from '../../../renderer/stores/notificationStore';
import { useModalStore } from '../../../renderer/stores/modalStore';
import { usePeerMirrorStore } from '../../../renderer/stores/peerMirrorStore';
import {
	createMirroredPeer,
	replacePeerAgents,
} from '../../../shared/maestro-lib/client/peer-mirror';
import { resetStores } from '../../helpers';

const lift = vi.fn();

const okAnswer = {
	ok: true,
	planText: 'Lifting "Docs"',
	result: {
		dryRun: false,
		plan: { agent: { name: 'Docs' }, peer: 'box' },
		target: 'box:h1',
		notices: ['image refs stayed'],
	},
};

beforeEach(() => {
	resetStores(usePeerMirrorStore, useModalStore);
	vi.mocked(notifyToast).mockClear();
	flush.mockClear();
	lift.mockReset();
	(window as unknown as { maestro: Record<string, unknown> }).maestro = {
		...(window as unknown as { maestro?: Record<string, unknown> }).maestro,
		federation: { lift },
	};
});

describe('planMoveToHost / moveAgentToHost', () => {
	it('flushes pending writes, then asks main for a dry run', async () => {
		lift.mockResolvedValue({ ok: true, planText: 'Would lift', result: { dryRun: true } });
		const answer = await planMoveToHost('s1', true);
		expect(flush).toHaveBeenCalledBefore(lift);
		expect(lift).toHaveBeenCalledWith('s1', { dryRun: true, withEnv: true });
		expect(answer).toMatchObject({ ok: true, planText: 'Would lift' });
		expect(notifyToast).not.toHaveBeenCalled();
	});

	it('lifts and toasts the notices and where to send from now on', async () => {
		lift.mockResolvedValue(okAnswer);
		const answer = await moveAgentToHost('s1', false);
		expect(lift).toHaveBeenCalledWith('s1', { dryRun: false, withEnv: false });
		expect(answer.ok).toBe(true);
		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({ color: 'yellow', message: 'image refs stayed' })
		);
		expect(notifyToast).toHaveBeenLastCalledWith(
			expect.objectContaining({ color: 'green', message: expect.stringContaining('box:h1') })
		);
	});

	it('answers a refusal and a rejected IPC call without a success toast', async () => {
		lift.mockResolvedValueOnce({ ok: false, code: 'LIFT_BUSY', error: 'busy' });
		expect(await moveAgentToHost('s1', false)).toEqual({
			ok: false,
			code: 'LIFT_BUSY',
			error: 'busy',
		});
		lift.mockRejectedValueOnce(new Error('ipc down'));
		expect(await moveAgentToHost('s1', false)).toMatchObject({ ok: false, code: 'LIFT_FAILED' });
		expect(notifyToast).not.toHaveBeenCalled();
	});
});

describe('requestMoveToHost', () => {
	it('opens the Move to Host modal for the agent', () => {
		requestMoveToHost('s1');
		const modal = useModalStore.getState().modals.get('moveToHost');
		expect(modal).toMatchObject({ open: true, data: { sessionId: 's1' } });
	});
});

describe('openLiftedAgent', () => {
	const pointer = { liftedTo: { peer: 'box', agentId: 'h1', at: 1 } };

	beforeEach(() => {
		const { peer } = replacePeerAgents(
			createMirroredPeer({ peerId: 'box', remoteId: 'r1', name: 'box' }),
			[{ id: 'h1', name: 'Docs', toolType: 'claude-code', aiTabs: [] }],
			[],
			1
		);
		usePeerMirrorStore.getState().hydrate([peer]);
	});

	it('shows the mirrored agent the pointer names', () => {
		expect(openLiftedAgent(pointer)).toBe(true);
		expect(usePeerMirrorStore.getState().activeMirror).toMatchObject({
			peerId: 'box',
			agentId: 'h1',
		});
	});

	it('toasts when the mirror does not hold the agent', () => {
		expect(openLiftedAgent({ liftedTo: { peer: 'box', agentId: 'gone', at: 1 } })).toBe(false);
		expect(openLiftedAgent({ liftedTo: { peer: 'other', agentId: 'h1', at: 1 } })).toBe(false);
		expect(notifyToast).toHaveBeenCalledTimes(2);
		expect(vi.mocked(notifyToast).mock.calls[1][0].message).toContain('is not mirrored');
		expect(usePeerMirrorStore.getState().activeMirror).toBeNull();
	});

	it('does nothing for an agent that never moved', () => {
		expect(openLiftedAgent({})).toBe(false);
		expect(notifyToast).not.toHaveBeenCalled();
	});
});
