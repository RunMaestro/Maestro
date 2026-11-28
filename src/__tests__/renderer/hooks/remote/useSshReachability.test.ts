import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

vi.mock('../../../../renderer/contexts/WindowContext', () => ({
	useIsLifecycleOwner: () => true,
}));

const notifyToast = vi.fn();
vi.mock('../../../../renderer/stores/notificationStore', async (importOriginal) => ({
	...(await importOriginal<object>()),
	notifyToast: (...args: unknown[]) => notifyToast(...args),
}));

const retryConnectionOutagesNow = vi.fn(
	(_ids: ReadonlySet<string>, _except?: (sessionId: string, tabId: string) => boolean) => 0
);
vi.mock('../../../../renderer/stores/retryStore', async (importOriginal) => ({
	...(await importOriginal<object>()),
	retryConnectionOutagesNow: (
		ids: ReadonlySet<string>,
		except?: (sessionId: string, tabId: string) => boolean
	) => retryConnectionOutagesNow(ids, except),
}));

import { useSshReachability } from '../../../../renderer/hooks/remote/useSshReachability';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import { cutTurnUndecided } from '../../../../renderer/services/hostedLinkLoss';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import { createModeSession } from '../../../helpers';
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
let federationReset: (() => void) | undefined;

beforeEach(() => {
	notifyToast.mockReset();
	retryConnectionOutagesNow.mockClear();
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
		federation: {
			onReset: (cb: () => void) => {
				federationReset = cb;
				return () => {
					federationReset = undefined;
				};
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

	it('drops every host outage, with no toast, when the Federation mirror resets; an SSH outage stays', () => {
		const { unmount } = renderHook(() => useSshReachability());
		push({ ...down, cause: 'host', message: 'The Maestro host on "pedtome" stopped answering.' });
		push({ ...down, remoteId: 'r2', remoteName: 'other' });
		useSshOutageStore.getState().surface('r1');

		federationReset?.();
		expect(notifyToast).not.toHaveBeenCalled();
		expect(Object.keys(useSshOutageStore.getState().outages)).toEqual(['r2']);

		unmount();
		expect(federationReset).toBeUndefined();
	});

	// Parity R18: the link coming back fires the retries kept for it at once, for the agents the
	// outage stopped: every agent on the remote for ssh, the hosted ones for its host.
	describe('fires the kept retries when the link is back (R18)', () => {
		const ids = () => [...(retryConnectionOutagesNow.mock.calls.at(-1)?.[0] ?? [])].sort();

		beforeEach(() => {
			useSettingsStore.setState({ federationHostedAgents: true });
			useSessionStore.setState({
				sessions: [
					createModeSession('local', { id: 'local-1' }),
					createModeSession('ssh', { id: 'ssh-1' }),
					createModeSession('hosted', { id: 'hosted-1' }),
				],
			});
		});

		it('for every agent on the remote when ssh is reachable again', () => {
			renderHook(() => useSshReachability());
			push(down);
			push(up);
			expect(retryConnectionOutagesNow).toHaveBeenCalledTimes(1);
			expect(ids()).toEqual(['hosted-1', 'ssh-1']);
			// A hosted tab whose cut turn the host has yet to settle fires from that decision
			// (CodeRabbit on #2161).
			expect(retryConnectionOutagesNow.mock.calls[0][1]).toBe(cutTurnUndecided);
		});

		it('for the hosted agents when their host is reachable again', () => {
			renderHook(() => useSshReachability());
			push({ ...down, cause: 'host' });
			push({ ...up, cause: 'host' });
			expect(ids()).toEqual(['hosted-1']);
		});

		it('for nothing when an outage is only cleared', () => {
			renderHook(() => useSshReachability());
			push({ ...down, cause: 'host' });
			push({ ...up, cause: 'host', cleared: true });
			expect(retryConnectionOutagesNow).not.toHaveBeenCalled();
		});
	});
});
