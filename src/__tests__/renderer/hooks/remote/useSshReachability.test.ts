import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

vi.mock('../../../../renderer/contexts/WindowContext', () => ({
	useIsLifecycleOwner: () => true,
}));

const notifyToast = vi.fn();
vi.mock('../../../../renderer/stores/notificationStore', () => ({
	notifyToast: (...args: unknown[]) => notifyToast(...args),
}));

import { useSshReachability } from '../../../../renderer/hooks/remote/useSshReachability';
import { useSshOutageStore } from '../../../../renderer/stores/sshOutageStore';
import type { SshReachabilityEvent } from '../../../../shared/sshConnection';

const down: SshReachabilityEvent = {
	remoteId: 'r1',
	remoteName: 'pedtome',
	reachable: false,
	message: 'Unable to connect to "pedtome" over SSH.',
	since: 1,
};
const up: SshReachabilityEvent = {
	remoteId: 'r1',
	remoteName: 'pedtome',
	reachable: true,
	since: 2,
};

let push: (event: SshReachabilityEvent) => void;

beforeEach(() => {
	notifyToast.mockReset();
	useSshOutageStore.setState({ outages: {} });
	(window as any).maestro = {
		...((window as any).maestro || {}),
		sshRemote: {
			getReachability: vi.fn().mockResolvedValue({ success: true, unreachable: [] }),
			onReachability: (cb: (event: SshReachabilityEvent) => void) => {
				push = cb;
				return () => {};
			},
		},
	};
});

describe('useSshReachability', () => {
	it('hydrates the remotes already down', async () => {
		(window as any).maestro.sshRemote.getReachability.mockResolvedValue({
			success: true,
			unreachable: [down],
		});
		renderHook(() => useSshReachability());
		await waitFor(() => expect(useSshOutageStore.getState().outages.r1).toBeDefined());
	});

	it('stays quiet when a remote the user never saw comes back', () => {
		renderHook(() => useSshReachability());
		push(down);
		push(up);
		expect(notifyToast).not.toHaveBeenCalled();
		expect(useSshOutageStore.getState().outages).toEqual({});
	});

	it('announces the recovery of an outage the user saw', () => {
		renderHook(() => useSshReachability());
		push(down);
		useSshOutageStore.getState().surface('r1');
		push(up);
		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({ type: 'success', title: 'SSH connection restored' })
		);
	});

	it('drops a cleared outage (the remote was deleted) without a recovery toast', () => {
		renderHook(() => useSshReachability());
		push(down);
		useSshOutageStore.getState().surface('r1');
		push({ ...up, cleared: true });
		expect(notifyToast).not.toHaveBeenCalled();
		expect(useSshOutageStore.getState().outages).toEqual({});
	});

	it('announces a host coming back through the same toast, naming the host (ssh worked throughout)', () => {
		renderHook(() => useSshReachability());
		push({ ...down, cause: 'host', message: 'The Maestro host on "pedtome" stopped answering.' });
		useSshOutageStore.getState().surface('r1');
		push({ ...up, cause: 'host' });
		expect(notifyToast).toHaveBeenCalledWith({
			type: 'success',
			title: 'Host connection restored',
			message: 'The Maestro host on "pedtome" is reachable again.',
		});
		// The dialog closes with it.
		expect(useSshOutageStore.getState().outages).toEqual({});
	});

	it('words the SSH and the host recovery from one place, the same shape for both', () => {
		renderHook(() => useSshReachability());
		for (const cause of [undefined, 'host'] as const) {
			notifyToast.mockReset();
			push({ ...down, ...(cause ? { cause } : {}) });
			useSshOutageStore.getState().surface('r1');
			push({ ...up, ...(cause ? { cause } : {}) });
			expect(notifyToast).toHaveBeenCalledTimes(1);
			expect(Object.keys(notifyToast.mock.calls[0][0]).sort()).toEqual([
				'message',
				'title',
				'type',
			]);
		}
	});
});
