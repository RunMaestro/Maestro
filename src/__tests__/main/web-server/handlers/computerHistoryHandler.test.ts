// Covers the computer_history_command WebSocket message behind
// `maestro-cli computer-history` writes. The WS server also serves signed-in
// browsers (web-desktop, possibly remote through the tunnel), so the one rule
// that matters most here is: a socket that did not present the CLI secret is
// refused before the service is touched.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../../main/plugins/plugin-manager-singleton', () => ({
	getPluginManager: () => null,
	getActivePluginManager: () => null,
	isPluginsFeatureEnabled: () => false,
}));

const service = {
	status: vi.fn(() => ({ state: 'recording' })),
	digestStatus: vi.fn(() => ({ pending: 0, lastDigestFile: null, lastError: null })),
	pause: vi.fn(async (forMs: number | null) => ({
		state: 'paused',
		pausedUntil: forMs ? 'x' : 'forever',
	})),
	resume: vi.fn(async () => ({ state: 'recording' })),
	addRule: vi.fn(async (match: string, value: string) => ({
		rule: { id: 'r1', match, value },
		matches: [{ id: 'com.tinyspeck.slackmacgap', name: 'Slack' }],
	})),
	removeRule: vi.fn(async (id: string) => (id === 'r1' ? { id } : null)),
	clear: vi.fn(async () => ({ deletedSegments: 2, freedBytes: 10 })),
	requestAccessibility: vi.fn(async () => ({ platform: 'linux', outcome: 'enabled' })),
	setConfig: vi.fn(async (patch: unknown) => ({ patched: patch })),
};
vi.mock('../../../../main/computer-history', () => ({
	getComputerHistoryService: () => service,
}));

import { WebSocketMessageHandler } from '../../../../main/web-server/handlers/messageHandlers';
import { setBridgeGuardContextProvider } from '../../../../main/web-server/handlers/bridgePathGuard';
import type { WebClient } from '../../../../main/web-server/handlers/messageHandlers';

function client(cli: boolean): WebClient {
	return {
		socket: { send: vi.fn() } as unknown as WebClient['socket'],
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

describe('computer_history_command handler', () => {
	let handler: WebSocketMessageHandler;

	beforeEach(() => {
		vi.clearAllMocks();
		handler = new WebSocketMessageHandler();
		handler.setCallbacks({} as never);
	});

	it('refuses a browser (non-CLI) client without touching the service', async () => {
		const browser = client(false);
		handler.handleMessage(browser, {
			type: 'computer_history_command',
			action: 'clear',
			all: true,
			requestId: 'r-1',
		} as never);
		await flush();
		expect(lastResponse(browser)).toMatchObject({
			type: 'computer_history_command_result',
			success: false,
			requestId: 'r-1',
		});
		expect(service.clear).not.toHaveBeenCalled();
	});

	it('routes CLI actions to the one service and echoes the request id', async () => {
		const cli = client(true);
		const send = async (payload: Record<string, unknown>) => {
			handler.handleMessage(cli, {
				type: 'computer_history_command',
				requestId: 'q',
				...payload,
			} as never);
			await flush();
			return lastResponse(cli);
		};
		expect(await send({ action: 'pause', forMs: 3_600_000 })).toMatchObject({
			success: true,
			requestId: 'q',
		});
		expect(service.pause).toHaveBeenCalledWith(3_600_000);
		expect(
			await send({ action: 'rules-add', match: 'domain', value: 'bank.example.com' })
		).toMatchObject({
			success: true,
			rule: { id: 'r1' },
		});
		expect(service.addRule).toHaveBeenLastCalledWith('domain', 'bank.example.com', 'ignore');
		await send({ action: 'rules-add', match: 'app', value: 'Notes', ruleAction: 'record' });
		expect(service.addRule).toHaveBeenLastCalledWith('app', 'Notes', 'record');
		expect(await send({ action: 'rules-remove', id: 'zzz' })).toMatchObject({ success: false });
		expect(service.removeRule).toHaveBeenLastCalledWith('zzz', undefined);
		await send({ action: 'rules-remove', id: 'Notes', ruleAction: 'record' });
		expect(service.removeRule).toHaveBeenLastCalledWith('Notes', 'record');
		expect(await send({ action: 'clear', sinceMs: 5 })).toMatchObject({
			success: true,
			deletedSegments: 2,
		});
		expect(service.clear).toHaveBeenCalledWith({ sinceMs: 5 });
		expect(await send({ action: 'clear' })).toMatchObject({ success: false });
		expect(await send({ action: 'config-set', patch: { snapshots: false } })).toMatchObject({
			success: true,
		});
		expect(service.setConfig).toHaveBeenCalledWith({ snapshots: false });
		expect(await send({ action: 'status' })).toMatchObject({
			success: true,
			status: { state: 'recording' },
		});
		expect(await send({ action: 'bogus' })).toMatchObject({ success: false });
	});

	it('reports a service error as a failed result, not a dropped reply', async () => {
		service.addRule.mockRejectedValueOnce(new Error('"x y" is not a domain'));
		const cli = client(true);
		handler.handleMessage(cli, {
			type: 'computer_history_command',
			action: 'rules-add',
			match: 'domain',
			value: 'x y',
			requestId: 'e',
		} as never);
		await flush();
		expect(lastResponse(cli)).toMatchObject({
			success: false,
			error: '"x y" is not a domain',
			requestId: 'e',
		});
	});
});

describe('set_setting cannot flip Computer History from a browser', () => {
	it('refuses a browser, allows maestro-cli, and leaves other keys alone', async () => {
		setBridgeGuardContextProvider(() => ({
			userDataDir: null,
			encoreFeatures: { computerHistory: true },
			platform: 'linux',
		}));
		const setSetting = vi.fn(async () => true);
		const handler = new WebSocketMessageHandler();
		handler.setCallbacks({ setSetting } as never);
		const browser = client(false);
		handler.handleMessage(browser, {
			type: 'set_setting',
			key: 'encoreFeatures',
			value: { computerHistory: false },
			requestId: 's1',
		} as never);
		await flush();
		expect(setSetting).not.toHaveBeenCalled();
		expect(lastResponse(browser).type).toBe('error');

		handler.handleMessage(browser, {
			type: 'set_setting',
			key: 'encoreFeatures',
			value: { computerHistory: true, maestroCue: false },
			requestId: 's2',
		} as never);
		await flush();
		expect(setSetting).toHaveBeenCalledTimes(1);

		handler.handleMessage(client(true), {
			type: 'set_setting',
			key: 'encoreFeatures',
			value: { computerHistory: false },
			requestId: 's3',
		} as never);
		await flush();
		expect(setSetting).toHaveBeenCalledTimes(2);
		setBridgeGuardContextProvider(null);
	});
});
