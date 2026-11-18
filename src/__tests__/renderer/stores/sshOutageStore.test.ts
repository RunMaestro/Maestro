import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
	isSshRemoteDown,
	isSshTransportError,
	selectOpenSshOutages,
	useSshOutageStore,
} from '../../../renderer/stores/sshOutageStore';
import type { SshReachabilityEvent } from '../../../shared/sshConnection';

const down = (remoteId: string, since = 1): SshReachabilityEvent => ({
	remoteId,
	remoteName: remoteId.toUpperCase(),
	reachable: false,
	message: `Unable to connect to "${remoteId}" over SSH.`,
	since,
});
const up = (remoteId: string): SshReachabilityEvent => ({
	remoteId,
	remoteName: remoteId.toUpperCase(),
	reachable: true,
	since: 99,
});

beforeEach(() => {
	useSshOutageStore.setState({ outages: {} });
});

describe('sshOutageStore', () => {
	it('opens an outage on an unreachable push and ends it on recovery, returning what ended', () => {
		const store = useSshOutageStore.getState();
		expect(store.applyReachability(down('r1'))).toBeUndefined();
		expect(selectOpenSshOutages(useSshOutageStore.getState(), 'r1')).toHaveLength(1);

		const ended = useSshOutageStore.getState().applyReachability(up('r1'));
		expect(ended?.event.remoteId).toBe('r1');
		expect(useSshOutageStore.getState().outages).toEqual({});
	});

	it('reports no ended outage for a recovery it never saw', () => {
		expect(useSshOutageStore.getState().applyReachability(up('r1'))).toBeUndefined();
	});

	it('keeps a dismissal across a repeat push for the same outage', () => {
		const store = useSshOutageStore.getState();
		store.applyReachability(down('r1'));
		store.dismiss('r1');
		useSshOutageStore.getState().applyReachability({ ...down('r1'), message: 'newer reason' });

		const outage = useSshOutageStore.getState().outages.r1;
		expect(outage.dismissed).toBe(true);
		expect(outage.event.message).toBe('newer reason');
		expect(selectOpenSshOutages(useSshOutageStore.getState(), 'r1')).toEqual([]);
	});

	it('reopens for the next outage after a recovery', () => {
		const store = useSshOutageStore.getState();
		store.applyReachability(down('r1'));
		store.dismiss('r1');
		useSshOutageStore.getState().applyReachability(up('r1'));
		useSshOutageStore.getState().applyReachability(down('r1'));
		expect(selectOpenSshOutages(useSshOutageStore.getState(), 'r1')).toHaveLength(1);
	});

	it('hydrates without clobbering a known outage, and lists open ones oldest first', () => {
		const store = useSshOutageStore.getState();
		store.applyReachability(down('r2', 5));
		store.dismiss('r2');
		useSshOutageStore.getState().hydrate([down('r2', 5), down('r3', 9), down('r1', 2), up('r4')]);
		useSshOutageStore.getState().surface('r1');
		useSshOutageStore.getState().surface('r2');
		useSshOutageStore.getState().surface('r3');

		const open = selectOpenSshOutages(useSshOutageStore.getState());
		expect(open.map((o) => o.event.remoteId)).toEqual(['r1', 'r3']);
		expect(useSshOutageStore.getState().outages.r4).toBeUndefined();
	});

	describe('only what matters reaches the screen', () => {
		it('keeps an outage on a remote the user is not working with off screen', () => {
			useSshOutageStore.getState().applyReachability(down('r1'));
			expect(selectOpenSshOutages(useSshOutageStore.getState())).toEqual([]);
			expect(selectOpenSshOutages(useSshOutageStore.getState(), 'other')).toEqual([]);
		});

		it('shows it once the user is on an agent of that remote', () => {
			useSshOutageStore.getState().applyReachability(down('r1'));
			expect(selectOpenSshOutages(useSshOutageStore.getState(), 'r1')).toHaveLength(1);
		});

		it('shows it anywhere once a live turn surfaced it, and keeps that across a repeat push', () => {
			useSshOutageStore.getState().applyReachability(down('r1'));
			useSshOutageStore.getState().surface('r1');
			useSshOutageStore.getState().applyReachability({ ...down('r1'), message: 'again' });

			expect(selectOpenSshOutages(useSshOutageStore.getState(), 'other')).toHaveLength(1);
			expect(useSshOutageStore.getState().applyReachability(up('r1'))?.surfaced).toBe(true);
		});

		it('reports an unsurfaced recovery as not surfaced, so it raises no toast', () => {
			useSshOutageStore.getState().applyReachability(down('r1'));
			expect(useSshOutageStore.getState().applyReachability(up('r1'))?.surfaced).toBe(false);
		});

		it('surface is a no-op for a remote that is not down', () => {
			useSshOutageStore.getState().surface('nope');
			expect(useSshOutageStore.getState().outages).toEqual({});
		});
	});
});

describe('isSshTransportError', () => {
	it('is a network error from a process that ran over SSH', () => {
		expect(isSshTransportError({ type: 'network_error', sshRemoteId: 'r1' })).toBe(true);
		expect(isSshTransportError({ type: 'network_error' })).toBe(false);
		expect(isSshTransportError({ type: 'auth_expired', sshRemoteId: 'r1' })).toBe(false);
	});
});

describe('isSshRemoteDown', () => {
	function mockCheck(result: unknown) {
		const checkReachability =
			result instanceof Error
				? vi.fn().mockRejectedValue(result)
				: vi.fn().mockResolvedValue(result);
		(window as any).maestro = {
			...((window as any).maestro || {}),
			sshRemote: { checkReachability },
		};
		return checkReachability;
	}

	it('answers from the store without a probe when an outage is already open', async () => {
		const check = mockCheck({ success: true, reachable: true });
		useSshOutageStore.getState().applyReachability(down('r1'));
		await expect(isSshRemoteDown('r1')).resolves.toBe(true);
		expect(check).not.toHaveBeenCalled();
	});

	it('records the outage the probe confirmed', async () => {
		mockCheck({ success: true, reachable: false, event: down('r1') });
		await expect(isSshRemoteDown('r1')).resolves.toBe(true);
		expect(useSshOutageStore.getState().outages.r1).toBeDefined();
	});

	it('is false when the host answers, the check fails, or the call throws', async () => {
		mockCheck({ success: true, reachable: true });
		await expect(isSshRemoteDown('r1')).resolves.toBe(false);
		mockCheck({ success: false, error: 'boom' });
		await expect(isSshRemoteDown('r1')).resolves.toBe(false);
		mockCheck(new Error('bridge gone'));
		await expect(isSshRemoteDown('r1')).resolves.toBe(false);
	});
});
