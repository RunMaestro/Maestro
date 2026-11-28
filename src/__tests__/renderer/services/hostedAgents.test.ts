/**
 * Tests for hosted agents in the Left Bar: the host roster with the rows that show it, resolving a
 * `peer:agent` the CLI typed, adding one (the record a lift leaves behind), and the window request
 * main forwards from `maestro-cli federation agents|add`.
 */

import { beforeEach, describe, expect, it, type Mock } from 'vitest';
import {
	addHostedAgent,
	answerFederationWindowRequest,
	buildHostedAgentListings,
	listHostedAgents,
	resolveHostAgentRef,
} from '../../../renderer/services/hostedAgents';
import { usePeerMirrorStore } from '../../../renderer/stores/peerMirrorStore';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import {
	createMirroredPeer,
	replacePeerAgents,
	type MirroredPeer,
} from '../../../shared/maestro-lib/client/peer-mirror';
import type { AgentRecord } from '../../../shared/maestro-lib/store/records';
import { planLiftedSettingsSync } from '../../../shared/maestro-lib/agents/lift-settings-sync';
import type { Session } from '../../../renderer/types';
import { resetStores } from '../../helpers';

const hostAgent = (id: string, name: string, extra: Partial<AgentRecord> = {}): AgentRecord => ({
	id,
	name,
	toolType: 'claude-code',
	cwd: `/srv/${id}`,
	aiTabs: [{ id: `${id}-t1` }],
	...extra,
});

function peer(peerId: string, agents: AgentRecord[], name = peerId): MirroredPeer {
	return {
		...replacePeerAgents(
			createMirroredPeer({ peerId, remoteId: `remote-${peerId}`, name }),
			agents,
			[{ id: 'hg1', name: 'Host Group' }],
			1
		).peer,
		connection: 'connected',
	};
}

/** The preload's sessions writer, which the test setup mocks. */
const setMany = () =>
	(window as unknown as { maestro: { sessions: { setMany: Mock } } }).maestro.sessions.setMany;

const row = (id: string, peerId: string, agentId: string, name = id) =>
	({ id, name, liftedTo: { peer: peerId, agentId, at: 1 } }) as unknown as Session;

describe('hostedAgents', () => {
	beforeEach(() => {
		resetStores(usePeerMirrorStore, useSessionStore);
		setMany().mockClear();
	});

	describe('buildHostedAgentListings', () => {
		it('lists every host agent in peer order, with the row that shows it and its host group', () => {
			const peers = {
				tome: peer('tome', [
					hostAgent('k1', 'Kensho', { groupId: 'hg1' }),
					hostAgent('m1', 'Maestro'),
				]),
				gpu: peer('gpu', [hostAgent('g1', 'Trainer')], 'GPU Box'),
			};
			const listings = buildHostedAgentListings(
				peers,
				['gpu', 'tome'],
				[row('row-1', 'tome', 'm1')]
			);
			expect(listings.map((listing) => listing.ref)).toEqual(['gpu:g1', 'tome:k1', 'tome:m1']);
			expect(listings[0]).toMatchObject({ peerName: 'GPU Box', name: 'Trainer', cwd: '/srv/g1' });
			expect(listings[1]).toMatchObject({ hostGroupName: 'Host Group' });
			expect(listings[1].addedAs).toBeUndefined();
			expect(listings[2].addedAs).toBe('row-1');
		});

		it('skips a remote probed without a host', () => {
			const probed = { ...createMirroredPeer({ peerId: 'bare', remoteId: 'r', name: 'bare' }) };
			expect(buildHostedAgentListings({ bare: probed }, ['bare'], [])).toEqual([]);
		});
	});

	describe('resolveHostAgentRef', () => {
		const peers = {
			tome: peer('tome', [
				hostAgent('abc-123', 'Kensho'),
				hostAgent('abd-456', 'Pedsidian'),
				hostAgent('x1', 'Twin'),
				hostAgent('x2', 'twin'),
			]),
			'tome:lab': peer('tome:lab', [hostAgent('l1', 'Lab')]),
		};
		const order = ['tome', 'tome:lab'];
		const resolve = (ref: string) => resolveHostAgentRef(ref, peers, order);

		it('finds an agent by id, a unique id prefix, or its name', () => {
			expect(resolve('tome:abc-123')).toMatchObject({ ok: true, agent: { name: 'Kensho' } });
			expect(resolve('tome:abd')).toMatchObject({ ok: true, agent: { name: 'Pedsidian' } });
			expect(resolve(' tome:kensho ')).toMatchObject({ ok: true, agent: { id: 'abc-123' } });
		});

		it('prefers the longest peer id that matches', () => {
			expect(resolve('tome:lab:l1')).toMatchObject({ ok: true, peer: { peerId: 'tome:lab' } });
		});

		it('refuses an unknown peer, a missing agent, an ambiguous one, and an unknown one', () => {
			expect(resolve('nope:a')).toMatchObject({
				ok: false,
				error: expect.stringContaining('Peers: tome'),
			});
			expect(resolve('tome:')).toMatchObject({
				ok: false,
				error: expect.stringContaining('Name the agent'),
			});
			expect(resolve('tome:ab')).toMatchObject({
				ok: false,
				error: expect.stringContaining('more than one'),
			});
			expect(resolve('tome:twin')).toMatchObject({
				ok: false,
				error: expect.stringContaining('more than one'),
			});
			expect(resolve('tome:ghost')).toMatchObject({
				ok: false,
				error: 'tome runs no agent "ghost".',
			});
		});
	});

	describe('addHostedAgent', () => {
		beforeEach(() => {
			usePeerMirrorStore.getState().hydrate([peer('tome', [hostAgent('k1', 'Kensho')])]);
			useSessionStore.setState({
				groups: [{ id: 'grp-1', name: 'Research', emoji: '', collapsed: false }] as never,
			});
		});

		it('adds the record a lift leaves behind, in the group, on disk, and selected', async () => {
			const result = await addHostedAgent({ agent: 'tome:Kensho', group: 'research' });
			expect(result).toMatchObject({
				ok: true,
				added: { name: 'Kensho', ref: 'tome:k1', groupId: 'grp-1' },
			});
			const [record] = useSessionStore.getState().sessions;
			expect(record).toMatchObject({
				name: 'Kensho',
				toolType: 'claude-code',
				cwd: '/srv/k1',
				groupId: 'grp-1',
				liftedTo: { peer: 'tome', agentId: 'k1' },
				sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-tome' },
			});
			expect(setMany()).toHaveBeenCalledWith([record], []);
			expect(useSessionStore.getState().activeSessionId).toBe(record.id);
		});

		it('starts in step with the host settings, and leaves the selection alone in the background', async () => {
			usePeerMirrorStore.getState().hydrate([
				peer('tome', [
					hostAgent('k1', 'Kensho', {
						customModel: 'opus',
						nudgeMessage: 'Keep diffs small.',
						bookmarked: true,
						customEnvVars: { DEBUG: '1' },
					}),
				]),
			]);
			useSessionStore.setState({ activeSessionId: 'other' });
			const result = await addHostedAgent({ agent: 'tome:k1', background: true });
			expect(result).toMatchObject({ ok: true, added: { name: 'Kensho' } });
			const [record] = useSessionStore.getState().sessions;
			expect(record).toMatchObject({
				customModel: 'opus',
				nudgeMessage: 'Keep diffs small.',
				bookmarked: true,
				customEnvVars: { DEBUG: '1' },
			});
			expect(record.groupId).toBeUndefined();
			// The settings sync finds nothing to settle on the first pass.
			const plan = planLiftedSettingsSync({
				local: record as unknown as AgentRecord,
				host: usePeerMirrorStore.getState().peers.tome.agents[0],
				now: 1,
			});
			expect(plan.conflicts).toEqual([]);
			expect(plan.pushes).toEqual([]);
			expect(useSessionStore.getState().activeSessionId).toBe('other');
		});

		it('refuses an agent the Left Bar shows already, and an unknown group', async () => {
			useSessionStore.setState({ sessions: [row('row-1', 'tome', 'k1', 'Kensho')] });
			expect(await addHostedAgent({ agent: 'tome:k1' })).toEqual({
				ok: false,
				error: 'tome:k1 is in the Left Bar already, as "Kensho".',
			});
			useSessionStore.setState({ sessions: [] });
			expect(await addHostedAgent({ agent: 'tome:k1', group: 'Nope' })).toEqual({
				ok: false,
				error: 'No group "Nope".',
			});
			expect(useSessionStore.getState().sessions).toEqual([]);
			expect(setMany()).not.toHaveBeenCalled();
		});
	});

	describe('answerFederationWindowRequest', () => {
		it('answers the host agents and adds one', async () => {
			usePeerMirrorStore.getState().hydrate([peer('tome', [hostAgent('k1', 'Kensho')])]);
			const listed = await answerFederationWindowRequest({ action: 'hosted-agents' });
			expect(listed).toEqual({ success: true, hostedAgents: listHostedAgents() });
			expect(listed.hostedAgents).toHaveLength(1);

			const added = await answerFederationWindowRequest({
				action: 'add-agent',
				agent: 'tome:k1',
				background: true,
			});
			expect(added).toMatchObject({ success: true, added: { ref: 'tome:k1' } });
			const again = await answerFederationWindowRequest({ action: 'add-agent', agent: 'tome:k1' });
			expect(again).toMatchObject({ success: false, error: expect.stringContaining('already') });
		});

		it('hands the settings conflict actions to the settings sync', async () => {
			expect(await answerFederationWindowRequest({ action: 'list' })).toEqual({
				success: true,
				conflicts: [],
			});
		});
	});
});
