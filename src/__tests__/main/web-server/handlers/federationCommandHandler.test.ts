// Covers the federation_command WebSocket message behind `maestro-cli federation peers|reconnect`.
// It must reach the ONE PeerMirrorService the desktop's `federation:*` IPC reads, refuse a browser
// socket before touching it (reconnect dials SSH), and answer the feature's own "turned off"
// message while Federation is off (no service exists then).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebSocket } from 'ws';
import type { MirrorPeerSummary } from '../../../../shared/maestro-lib/client/peer-mirror';

vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../../main/plugins/plugin-manager-singleton', () => ({
	getPluginManager: () => null,
	getActivePluginManager: () => null,
	isPluginsFeatureEnabled: () => false,
}));

const PEERS: MirrorPeerSummary[] = [
	{
		peerId: 'buildbox',
		remoteId: 'remote-1',
		name: 'buildbox',
		connection: 'connected',
		agentCount: 3,
	},
	{
		peerId: 'gpu',
		remoteId: 'remote-2',
		name: 'gpu',
		connection: 'host-down',
		error: 'No host is running on gpu.',
		agentCount: 0,
	},
];

const service = {
	peers: vi.fn(() => PEERS),
	reconnect: vi.fn(async (peerId: string) =>
		peerId === 'buildbox'
			? { ok: true, peer: PEERS[0] }
			: { ok: false, error: 'No host is running on gpu.', peer: PEERS[1] }
	),
};
const running = vi.hoisted(() => ({ on: true }));
vi.mock('../../../../main/federation', () => ({
	getPeerMirrorService: () => (running.on ? service : null),
}));

import { WebSocketMessageHandler } from '../../../../main/web-server/handlers/messageHandlers';
import type { WebClient } from '../../../../main/web-server/handlers/messageHandlers';

function client(cli: boolean): WebClient {
	return {
		socket: { readyState: WebSocket.OPEN, send: vi.fn() } as unknown as WebClient['socket'],
		id: cli ? 'cli-1' : 'browser-1',
		connectedAt: 0,
		...(cli ? { cli: true } : {}),
	};
}

function lastResponse(c: WebClient): Record<string, unknown> {
	const calls = (c.socket.send as ReturnType<typeof vi.fn>).mock.calls;
	return JSON.parse(calls[calls.length - 1][0] as string);
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('federation_command handler', () => {
	let handler: WebSocketMessageHandler;

	async function send(c: WebClient, payload: Record<string, unknown>) {
		handler.handleMessage(c, { type: 'federation_command', requestId: 'q', ...payload } as never);
		await flush();
		return lastResponse(c);
	}

	beforeEach(() => {
		vi.clearAllMocks();
		running.on = true;
		handler = new WebSocketMessageHandler();
		handler.setCallbacks({} as never);
	});

	it('refuses a browser (non-CLI) client without touching the service', async () => {
		const browser = client(false);
		expect(await send(browser, { action: 'reconnect', peer: 'buildbox' })).toMatchObject({
			type: 'federation_command_result',
			success: false,
			requestId: 'q',
		});
		expect(service.peers).not.toHaveBeenCalled();
		expect(service.reconnect).not.toHaveBeenCalled();
	});

	it('lists the peers the service mirrors', async () => {
		expect(await send(client(true), { action: 'peers' })).toEqual({
			type: 'federation_command_result',
			success: true,
			peers: PEERS,
			requestId: 'q',
			timestamp: expect.any(Number),
		});
	});

	it('resolves the peer ref, then reconnects through the service', async () => {
		expect(await send(client(true), { action: 'reconnect', peer: 'BUILDBOX' })).toMatchObject({
			success: true,
			peer: PEERS[0],
		});
		expect(service.reconnect).toHaveBeenCalledWith('buildbox');

		expect(await send(client(true), { action: 'reconnect', peer: 'remote-2' })).toMatchObject({
			success: false,
			error: 'No host is running on gpu.',
			peer: PEERS[1],
		});
		expect(service.reconnect).toHaveBeenLastCalledWith('gpu');
	});

	it('refuses an unknown or missing peer without reconnecting', async () => {
		expect(await send(client(true), { action: 'reconnect', peer: 'nope' })).toMatchObject({
			success: false,
			error: 'Not a mirrored peer: nope',
		});
		expect(await send(client(true), { action: 'reconnect' })).toMatchObject({
			success: false,
			error: 'Name the peer to reconnect',
		});
		expect(service.reconnect).not.toHaveBeenCalled();
	});

	it('refuses an unknown action', async () => {
		expect(await send(client(true), { action: 'lift' })).toMatchObject({
			success: false,
			error: 'Unknown federation action: lift',
		});
	});

	it('answers the feature-off message while no service runs', async () => {
		running.on = false;
		const reply = await send(client(true), { action: 'peers' });
		expect(reply).toMatchObject({ success: false });
		expect(String(reply.error)).toContain('maestro-cli encore enable federation');
	});
});
