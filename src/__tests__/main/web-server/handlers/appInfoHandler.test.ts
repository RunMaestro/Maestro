// Covers the get_app_info WebSocket command that backs `maestro-cli version`:
// the handler must echo the request id and report the app version + build commit
// hash (from utils/build-info) so the CLI can surface the exact HEAD a build came
// from. Mocks electron's `app` and the build-info reader so no real app/git is hit.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
	app: {
		getVersion: () => '9.9.9',
		getAppPath: () => '/repo',
	},
}));

vi.mock('../../../../main/utils/build-info', () => ({
	getCommitHash: () => 'deadbeef',
}));

vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../../main/plugins/plugin-manager-singleton', () => ({
	getPluginManager: () => null,
}));

import { WebSocketMessageHandler } from '../../../../main/web-server/handlers/messageHandlers';
import type { WebClient } from '../../../../main/web-server/handlers/messageHandlers';

function createMockClient(): WebClient {
	return {
		socket: { send: vi.fn() } as unknown as WebClient['socket'],
		id: 'client-1',
		connectedAt: 0,
	};
}

describe('get_app_info handler', () => {
	let handler: WebSocketMessageHandler;
	let client: WebClient;

	beforeEach(() => {
		handler = new WebSocketMessageHandler();
		client = createMockClient();
	});

	it('reports version, commit hash, platform, and echoes the request id', () => {
		handler.handleMessage(client, { type: 'get_app_info', requestId: 'req-42' });

		expect(client.socket.send).toHaveBeenCalledTimes(1);
		const response = JSON.parse((client.socket.send as any).mock.calls[0][0]);
		expect(response).toMatchObject({
			type: 'app_info',
			requestId: 'req-42',
			version: '9.9.9',
			commitHash: 'deadbeef',
			platform: process.platform,
		});
	});
});
