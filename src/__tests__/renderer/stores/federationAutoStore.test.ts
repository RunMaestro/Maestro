/**
 * The window's automatic Federation store: which changes earn a toast (a move, a new blocker),
 * and that the first snapshot a window loads is quiet.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../renderer/stores/notificationStore', () => ({ notifyToast: vi.fn() }));

import {
	autoFederationAnnouncements,
	useFederationAutoStore,
} from '../../../renderer/stores/federationAutoStore';
import { notifyToast } from '../../../renderer/stores/notificationStore';
import {
	emptyAutoFederationSnapshot,
	type AutoFederationSnapshot,
} from '../../../shared/federationAuto';

const snap = (patch: Partial<AutoFederationSnapshot>): AutoFederationSnapshot => ({
	...emptyAutoFederationSnapshot(),
	...patch,
});

const agent = (state: 'moved' | 'blocked' | 'waiting', reason = 'r') => ({
	agentId: 'a1',
	agentName: 'Docs',
	remoteId: 'r1',
	state,
	reason,
	fix: 'Do the thing.',
	target: 'r1:h1',
	at: 1,
});

describe('autoFederationAnnouncements', () => {
	it('announces a move once, and a blocker when it is new or its reason changed', () => {
		const empty = snap({});
		expect(autoFederationAnnouncements(empty, snap({ agents: [agent('moved')] }))).toEqual([
			expect.objectContaining({ color: 'green', title: 'Moved "Docs" to its host' }),
		]);
		expect(
			autoFederationAnnouncements(
				snap({ agents: [agent('moved')] }),
				snap({ agents: [agent('moved')] })
			)
		).toEqual([]);
		const blocked = autoFederationAnnouncements(
			empty,
			snap({ agents: [agent('blocked', 'No CLI')] })
		);
		expect(blocked).toEqual([
			expect.objectContaining({
				color: 'yellow',
				title: 'Could not move "Docs" automatically',
				message: 'No CLI Do the thing.',
			}),
		]);
		expect(
			autoFederationAnnouncements(
				snap({ agents: [agent('blocked', 'No CLI')] }),
				snap({ agents: [agent('blocked', 'No CLI')] })
			)
		).toEqual([]);
		expect(autoFederationAnnouncements(empty, snap({ agents: [agent('waiting')] }))).toEqual([]);
	});

	it('announces a remote whose setup became blocked', () => {
		const next = snap({
			remotes: [
				{
					remoteId: 'r1',
					name: 'box',
					state: 'blocked',
					reason: 'No Node.',
					fix: 'Install it.',
					at: 1,
				},
			],
		});
		expect(autoFederationAnnouncements(snap({}), next)).toEqual([
			expect.objectContaining({
				title: 'Could not set up the host on box',
				message: 'No Node. Install it.',
			}),
		]);
	});
});

describe('autoFederationAnnouncements: a running host that needs you', () => {
	it('announces a new required fix once', () => {
		const ready = (fix?: string) =>
			snap({
				remotes: [
					{
						remoteId: 'r1',
						name: 'box',
						state: 'ready',
						needsYou: Boolean(fix),
						...(fix ? { fix } : {}),
						at: 1,
					},
				],
			});
		expect(
			autoFederationAnnouncements(snap({}), ready('Run sudo loginctl enable-linger u.'))
		).toEqual([expect.objectContaining({ title: 'The host on box needs one step from you' })]);
		expect(autoFederationAnnouncements(ready('Run it.'), ready('Run it.'))).toEqual([]);
		expect(autoFederationAnnouncements(snap({}), ready())).toEqual([]);
	});
});

describe('useFederationAutoStore', () => {
	beforeEach(() => {
		useFederationAutoStore.getState().reset();
		vi.mocked(notifyToast).mockClear();
	});

	it('loads the first snapshot quietly and toasts later changes', () => {
		const { applySnapshot } = useFederationAutoStore.getState();
		applySnapshot(snap({ agents: [agent('blocked')] }), false);
		expect(notifyToast).not.toHaveBeenCalled();
		applySnapshot(snap({ agents: [agent('moved')] }));
		expect(notifyToast).toHaveBeenCalledTimes(1);
		expect(useFederationAutoStore.getState().snapshot.agents[0].state).toBe('moved');
	});
});
