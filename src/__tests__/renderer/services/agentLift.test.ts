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
	planMoveToHost,
	requestMoveBackFromHost,
	requestMoveToHost,
	setupRemoteHostFromWindow,
	startPeerHost,
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
const setupHost = vi.fn();
const unlift = vi.fn();

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
	setupHost.mockReset();
	unlift.mockReset();
	(window as unknown as { maestro: Record<string, unknown> }).maestro = {
		...(window as unknown as { maestro?: Record<string, unknown> }).maestro,
		federation: { lift, setupHost, unlift },
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

describe('setupRemoteHostFromWindow / startPeerHost', () => {
	const started = { ok: true, result: { cli: 'installed' }, peer: { peerId: 'box' } };

	it('asks main to set the host up with the options given', async () => {
		setupHost.mockResolvedValue(started);
		expect(await setupRemoteHostFromWindow('r1', { restart: true })).toEqual(started);
		expect(setupHost).toHaveBeenCalledWith('r1', { restart: true });
		expect(notifyToast).not.toHaveBeenCalled();
	});

	it('toasts a refusal unless the caller shows it itself', async () => {
		setupHost.mockResolvedValue({ ok: false, code: 'foreign-cli', error: 'Not ours.' });
		await setupRemoteHostFromWindow('r1');
		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({ color: 'red', message: 'Not ours.' })
		);
		vi.mocked(notifyToast).mockClear();
		await setupRemoteHostFromWindow('r1', {}, { toastOnError: false });
		expect(notifyToast).not.toHaveBeenCalled();
	});

	it('answers a rejected IPC call as a failure', async () => {
		setupHost.mockRejectedValue(new Error('main went away'));
		expect(await setupRemoteHostFromWindow('r1', {}, { toastOnError: false })).toMatchObject({
			ok: false,
			code: 'SETUP_FAILED',
		});
	});

	it('Start Host says it is starting, then that the host runs', async () => {
		setupHost.mockResolvedValue(started);
		expect(await startPeerHost('r1', 'box')).toBe(true);
		expect(vi.mocked(notifyToast).mock.calls.map((call) => call[0].title)).toEqual([
			'Starting the host on box',
			'Host running on box',
		]);
	});
});

describe('requestMoveBackFromHost (L39)', () => {
	const confirm = () =>
		useModalStore.getState().modals.get('confirm')?.data as
			| { message: string; onConfirm: () => void }
			| undefined;
	const back = (dryRun: boolean) => ({
		ok: true,
		result: {
			agent: { id: 'a1', name: 'Docs' },
			from: 'box:h1',
			tabs: 3,
			newTabs: 1,
			history: 16,
			hostCopyRemoved: !dryRun,
			...(dryRun ? { dryRun: true } : {}),
		},
	});

	it('confirms with what comes back, counted by a dry run, then moves it back', async () => {
		unlift.mockImplementation(async (_id: string, options: { dryRun?: boolean }) =>
			back(options.dryRun === true)
		);
		requestMoveBackFromHost('a1', 'Docs', 'box');
		await vi.waitFor(() => expect(confirm()).toBeDefined());
		expect(unlift).toHaveBeenCalledWith('a1', { offline: false, dryRun: true });
		expect(confirm()?.message).toBe(
			'Moving "Docs" back from box:h1: 3 tab(s) (1 new) and 16 History entries come back to this machine, and its copy there is removed. "Docs" becomes an SSH agent again, and automatic moves leave it here.'
		);
		confirm()?.onConfirm();
		await vi.waitFor(() => expect(notifyToast).toHaveBeenCalled());
		expect(unlift).toHaveBeenLastCalledWith('a1', { offline: false });
		expect(vi.mocked(notifyToast).mock.calls.at(-1)?.[0]).toMatchObject({
			color: 'green',
			message:
				'"Docs" is an SSH agent again: 3 tab(s) (1 new) and 16 History entries came back from box:h1, host copy removed. Automatic moves leave it here.',
		});
	});

	it('offers the offline Move Back, naming the History that stays, when the host cannot be reached', async () => {
		unlift.mockResolvedValue({ ok: false, code: 'PEER_NOT_CONNECTED', error: 'not connected' });
		requestMoveBackFromHost('a1', 'Docs', 'box');
		await vi.waitFor(() => expect(confirm()).toBeDefined());
		expect(confirm()?.message).toContain('so does the History written there');
		expect(confirm()?.message).toContain('the next Move to Host brings it home');
	});
});
