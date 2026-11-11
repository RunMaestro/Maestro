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
		activeMirror: null,
		selectMirroredAgent: vi.fn(),
		reconnectPeer: vi.fn(),
		copyPeerAgentRef: vi.fn(),
		requestMoveToHost: vi.fn(),
		openLiftedAgent: vi.fn(),
		setQuickActionOpen: vi.fn(),
		...overrides,
	};
	return { deps, commands: buildFederationCommands(deps) };
}

describe('buildFederationCommands', () => {
	it('offers nothing with no mirrored peer', () => {
		expect(build({ peers: [] }).commands).toEqual([]);
	});

	it('opens a mirrored agent and closes the palette', () => {
		const { deps, commands } = build();
		const open = commands.find((c) => c.id === 'federation-open-buildbox:a1');
		expect(open?.label).toBe('Peer: Builder (Build Box)');
		open?.action();
		expect(deps.selectMirroredAgent).toHaveBeenCalledWith('buildbox', 'a1');
		expect(deps.setQuickActionOpen).toHaveBeenCalledWith(false);
	});

	it('reconnects a peer', () => {
		const { deps, commands } = build();
		commands.find((c) => c.id === 'federation-reconnect-buildbox')?.action();
		expect(deps.reconnectPeer).toHaveBeenCalledWith('buildbox');
	});

	it('offers to copy the peer:agent address only while a mirror is shown', () => {
		expect(build().commands.some((c) => c.id === 'federation-copy-peer-agent-ref')).toBe(false);
		const { deps, commands } = build({
			activeMirror: { key: 'buildbox:a1', peerId: 'buildbox', agentId: 'a1' },
		});
		const copy = commands.find((c) => c.id === 'federation-copy-peer-agent-ref');
		expect(copy?.label).toContain('buildbox:a1');
		copy?.action();
		expect(deps.copyPeerAgentRef).toHaveBeenCalledWith('buildbox', 'a1');
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

	it('offers to open a lifted agent on its host', () => {
		expect(build().commands.some((c) => c.id === 'federation-open-lifted-agent')).toBe(false);
		const { deps, commands } = build({ liftedTarget: { ref: 'buildbox:h1' } });
		const open = commands.find((c) => c.id === 'federation-open-lifted-agent');
		expect(open?.label).toBe('Open on Host (buildbox:h1)');
		open?.action();
		expect(deps.openLiftedAgent).toHaveBeenCalled();
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
});
