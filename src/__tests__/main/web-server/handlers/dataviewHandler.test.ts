// Covers the dataview_command WebSocket message that backs `maestro-cli
// dataview`. Each action is one DataviewService request method (the ones the
// `dataview:*` IPC handlers call), its fields come from the message, and every
// reply carries the request id so the CLI never hangs. The trust actions answer
// the CLI's own connection only.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebSocket } from 'ws';

vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../../main/plugins/plugin-manager-singleton', () => ({
	getPluginManager: () => null,
	getActivePluginManager: () => null,
	isPluginsFeatureEnabled: () => false,
}));

const service = {
	query: vi.fn(),
	queryInline: vi.fn(),
	queryFile: vi.fn(),
	indexStatus: vi.fn(),
	rebuildIndex: vi.fn(),
	trustRoot: vi.fn(),
	untrustRoot: vi.fn(),
	trustedRootList: vi.fn(),
};

vi.mock('../../../../main/dataview/dataview-service', () => ({
	getDataviewService: () => service,
}));

import { WebSocketMessageHandler } from '../../../../main/web-server/handlers/messageHandlers';
import type { WebClient } from '../../../../main/web-server/handlers/messageHandlers';

function createMockClient(cli = false): WebClient {
	return {
		socket: { readyState: WebSocket.OPEN, send: vi.fn() } as unknown as WebClient['socket'],
		id: 'client-1',
		connectedAt: 0,
		...(cli ? { cli: true } : {}),
	};
}

function lastResponse(client: WebClient): Record<string, unknown> {
	const calls = (client.socket.send as ReturnType<typeof vi.fn>).mock.calls;
	return JSON.parse(calls[calls.length - 1][0] as string);
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

const RESPONSE = { root: '/vault', sshRemoteId: null, revision: 3, path: 'a.md', result: {} };

describe('dataview_command handler', () => {
	let handler: WebSocketMessageHandler;
	let client: WebClient;
	const send = async (message: Record<string, unknown>) => {
		handler.handleMessage(client, { type: 'dataview_command', requestId: 'r1', ...message });
		await flush();
		return lastResponse(client);
	};

	beforeEach(() => {
		vi.clearAllMocks();
		service.query.mockResolvedValue(RESPONSE);
		service.queryInline.mockResolvedValue(RESPONSE);
		service.queryFile.mockResolvedValue(RESPONSE);
		service.indexStatus.mockReturnValue([]);
		service.rebuildIndex.mockResolvedValue({ root: '/vault', pageCount: 2 });
		service.trustRoot.mockReturnValue({
			root: '/vault',
			trusted: true,
			changed: true,
			roots: ['/vault'],
		});
		service.untrustRoot.mockReturnValue({
			root: '/vault',
			trusted: false,
			changed: true,
			roots: [],
		});
		service.trustedRootList.mockReturnValue(['/vault']);
		handler = new WebSocketMessageHandler();
		client = createMockClient();
	});

	it('query runs the source against the note', async () => {
		const reply = await send({
			action: 'query',
			filePath: '/vault/a.md',
			agentId: 'agent-1',
			source: 'LIST',
		});
		expect(service.query).toHaveBeenCalledWith({
			filePath: '/vault/a.md',
			agentId: 'agent-1',
			source: 'LIST',
		});
		expect(reply).toMatchObject({
			type: 'dataview_result',
			success: true,
			response: RESPONSE,
			requestId: 'r1',
		});
	});

	it('queryInline passes the expression', async () => {
		await send({
			action: 'queryInline',
			filePath: '/vault/a.md',
			agentId: 'agent-1',
			expression: '= this.file.name',
		});
		expect(service.queryInline).toHaveBeenCalledWith({
			filePath: '/vault/a.md',
			agentId: 'agent-1',
			expression: '= this.file.name',
		});
	});

	it('queryFile passes the block number', async () => {
		await send({ action: 'queryFile', filePath: '/vault/a.md', agentId: 'agent-1', block: 2 });
		expect(service.queryFile).toHaveBeenCalledWith({
			filePath: '/vault/a.md',
			agentId: 'agent-1',
			block: 2,
		});
	});

	it('status and rebuild name the root and the agent', async () => {
		expect(await send({ action: 'status' })).toMatchObject({ success: true, response: [] });
		expect(service.indexStatus).toHaveBeenCalledWith({ root: undefined, agentId: undefined });

		const reply = await send({ action: 'rebuild', root: '/vault', agentId: 'agent-1' });
		expect(service.rebuildIndex).toHaveBeenCalledWith({ root: '/vault', agentId: 'agent-1' });
		expect(reply).toMatchObject({ success: true, response: { root: '/vault', pageCount: 2 } });
	});

	it('answers a service error with success false', async () => {
		service.query.mockRejectedValue(new Error('Dataview: no agent with id "nope"'));
		expect(await send({ action: 'query', filePath: '/vault/a.md', agentId: 'nope' })).toMatchObject(
			{
				type: 'dataview_result',
				success: false,
				error: 'Dataview: no agent with id "nope"',
				requestId: 'r1',
			}
		);
	});

	it('trust, untrust, and trusted edit and read the trust list for the CLI', async () => {
		client = createMockClient(true);
		expect(await send({ action: 'trust', root: '/vault' })).toMatchObject({
			success: true,
			response: { root: '/vault', trusted: true, roots: ['/vault'] },
		});
		expect(service.trustRoot).toHaveBeenCalledWith({ root: '/vault' });
		expect(await send({ action: 'untrust', root: '/vault' })).toMatchObject({
			success: true,
			response: { trusted: false, roots: [] },
		});
		expect(service.untrustRoot).toHaveBeenCalledWith({ root: '/vault' });
		expect(await send({ action: 'trusted' })).toMatchObject({
			success: true,
			response: ['/vault'],
		});
	});

	it('answers the trust actions to the CLI only, never a browser client', async () => {
		for (const action of ['trust', 'untrust', 'trusted']) {
			expect(await send({ action, root: '/vault' })).toMatchObject({
				success: false,
				error: `Dataview ${action} is available to maestro-cli only`,
				requestId: 'r1',
			});
		}
		expect(service.trustRoot).not.toHaveBeenCalled();
		expect(service.untrustRoot).not.toHaveBeenCalled();
		expect(service.trustedRootList).not.toHaveBeenCalled();
	});

	it('refuses an unknown action without calling the service', async () => {
		expect(await send({ action: 'run' })).toMatchObject({
			success: false,
			error: 'Unknown Dataview action: run',
			requestId: 'r1',
		});
		expect(await send({})).toMatchObject({ error: 'Unknown Dataview action: (none)' });
		for (const method of Object.values(service)) expect(method).not.toHaveBeenCalled();
	});
});
