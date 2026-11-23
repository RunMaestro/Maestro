import { describe, expect, it, vi } from 'vitest';
import { buildFederationCommands } from '../../../../../renderer/components/QuickActionsModal/commands/federationCommands';
import {
	createMirroredPeer,
	replacePeerAgents,
	type MirroredPeer,
} from '../../../../../shared/maestro-lib/client/peer-mirror';

const peer: MirroredPeer = replacePeerAgents(
	createMirroredPeer({ peerId: 'buildbox', remoteId: 'r1', name: 'Build Box' }),
	[{ id: 'a1', name: 'Builder', toolType: 'claude-code', aiTabs: [] }],
	[],
	1
).peer;

function build(overrides: Partial<Parameters<typeof buildFederationCommands>[0]> = {}) {
	const deps = {
		peers: [peer],
		reconnectPeer: vi.fn(),
		requestMoveToHost: vi.fn(),
		setQuickActionOpen: vi.fn(),
		...overrides,
	};
	return { deps, commands: buildFederationCommands(deps) };
}

describe('buildFederationCommands', () => {
	it('offers nothing with no mirrored peer', () => {
		expect(build({ peers: [] }).commands).toEqual([]);
	});

	it("never lists a host's agents: hosted agents are Left Bar rows the agent switcher lists", () => {
		expect(build().commands.some((c) => c.id.startsWith('federation-open-buildbox'))).toBe(false);
	});

	it('offers Add Hosted Agent only while a host runs an agent the Left Bar does not show', () => {
		const openAddHostedAgent = vi.fn();
		expect(
			build({ openAddHostedAgent, addableHostedAgentCount: 0 }).commands.some(
				(c) => c.id === 'federation-add-hosted-agent'
			)
		).toBe(false);
		const { deps, commands } = build({ openAddHostedAgent, addableHostedAgentCount: 3 });
		const add = commands.find((c) => c.id === 'federation-add-hosted-agent');
		expect(add?.label).toBe('Add Hosted Agent...');
		expect(add?.subtext).toContain('3 not added');
		add?.action();
		expect(openAddHostedAgent).toHaveBeenCalled();
		expect(deps.setQuickActionOpen).toHaveBeenCalledWith(false);
	});

	it('reconnects a peer', () => {
		const { deps, commands } = build();
		commands.find((c) => c.id === 'federation-reconnect-buildbox')?.action();
		expect(deps.reconnectPeer).toHaveBeenCalledWith('buildbox');
	});

	it('offers Move to Host for the active agent only when it can move', () => {
		expect(build().commands.some((c) => c.id === 'federation-move-to-host')).toBe(false);
		const { deps, commands } = build({
			moveToHost: { sessionId: 's1', agentName: 'Docs', peerName: 'Build Box', hostReady: true },
		});
		const move = commands.find((c) => c.id === 'federation-move-to-host');
		expect(move?.label).toBe('Move to Host: Docs (Build Box)');
		expect(move?.subtext).toMatch(/^Run this SSH agent/);
		move?.action();
		expect(deps.requestMoveToHost).toHaveBeenCalledWith('s1');
		expect(deps.setQuickActionOpen).toHaveBeenCalledWith(false);
	});

	it('offers the hosted-agents switch only while a hosted agent exists, labeled by its state', () => {
		expect(build().commands.some((c) => c.id === 'federation-toggle-hosted-agents')).toBe(false);
		const setEnabled = vi.fn();
		const { commands } = build({ hostedAgents: { enabled: true, setEnabled } });
		const toggle = commands.find((c) => c.id === 'federation-toggle-hosted-agents');
		expect(toggle?.label).toBe('Turn Hosted Agents Off');
		toggle?.action();
		expect(setEnabled).toHaveBeenCalledWith(false);
		expect(
			build({ hostedAgents: { enabled: false, setEnabled } }).commands.find(
				(c) => c.id === 'federation-toggle-hosted-agents'
			)?.label
		).toBe('Turn Hosted Agents On');
	});

	it('offers Move Back from Host only for a hosted active agent', () => {
		const requestMoveBackFromHost = vi.fn();
		expect(
			build({ requestMoveBackFromHost }).commands.some(
				(c) => c.id === 'federation-move-back-from-host'
			)
		).toBe(false);
		const { deps, commands } = build({
			moveBackFromHost: { sessionId: 's1', agentName: 'Docs', peerName: 'Build Box' },
			requestMoveBackFromHost,
		});
		const back = commands.find((c) => c.id === 'federation-move-back-from-host');
		expect(back?.label).toBe('Move Back from Host: Docs (Build Box)');
		back?.action();
		expect(requestMoveBackFromHost).toHaveBeenCalledWith('s1', 'Docs', 'Build Box');
		expect(deps.setQuickActionOpen).toHaveBeenCalledWith(false);
	});

	it('offers the same Move to Host when the remote runs no host yet, saying it sets one up', () => {
		const { deps, commands } = build({
			peers: [],
			moveToHost: { sessionId: 's1', agentName: 'Docs', peerName: 'Build Box', hostReady: false },
		});
		const entries = commands.filter((c) => c.id.startsWith('federation-move'));
		expect(entries).toHaveLength(1);
		expect(entries[0].label).toBe('Move to Host: Docs (Build Box)');
		expect(entries[0].subtext).toMatch(/^Set up a Maestro host/);
		entries[0].action();
		expect(deps.requestMoveToHost).toHaveBeenCalledWith('s1');
		expect(deps.setQuickActionOpen).toHaveBeenCalledWith(false);
	});

	it('offers the settings conflicts review only while some wait', () => {
		const openSettingsConflicts = vi.fn();
		expect(
			build({ openSettingsConflicts, settingsConflictCount: 0 }).commands.some(
				(c) => c.id === 'federation-settings-conflicts'
			)
		).toBe(false);
		const { commands } = build({ openSettingsConflicts, settingsConflictCount: 2 });
		const review = commands.find((c) => c.id === 'federation-settings-conflicts');
		expect(review?.label).toBe('Review Federation Settings Conflicts (2)');
		review?.action();
		expect(openSettingsConflicts).toHaveBeenCalled();
	});
});
