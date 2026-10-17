// Covers the open_modal WebSocket message that backs `maestro-cli open`. The
// renderer acts on whatever this hop hands it, so the surface, the tab, and
// whether the surface opens on a group are all refused HERE, by the same
// `resolveUiSurfaceTarget` the CLI ran. A group is passed through as given:
// this hop knows no groups, and the graph falls back to every agent when the
// group is gone.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../../main/plugins/plugin-manager-singleton', () => ({
	getPluginManager: () => null,
	getActivePluginManager: () => null,
	isPluginsFeatureEnabled: () => false,
}));

import { WebSocketMessageHandler } from '../../../../main/web-server/handlers/messageHandlers';
import { setBridgeGuardContextProvider } from '../../../../main/web-server/handlers/bridgePathGuard';
import type { WebClient } from '../../../../main/web-server/handlers/messageHandlers';

function createMockClient(): WebClient {
	return {
		socket: { send: vi.fn() } as unknown as WebClient['socket'],
		id: 'client-1',
		connectedAt: 0,
	};
}

function lastResponse(client: WebClient): Record<string, unknown> {
	const calls = (client.socket.send as ReturnType<typeof vi.fn>).mock.calls;
	return JSON.parse(calls[calls.length - 1][0] as string);
}

/** Flush the promise chain the handler's `.then(...)` reply rides on. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('open_modal handler', () => {
	let handler: WebSocketMessageHandler;
	let client: WebClient;
	let openModal: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		handler = new WebSocketMessageHandler();
		client = createMockClient();
		openModal = vi.fn().mockResolvedValue(true);
		handler.setCallbacks({ openModal } as never);
	});

	it('opens a surface with no tab and no group', async () => {
		handler.handleMessage(client, {
			type: 'open_modal',
			requestId: 'req-1',
			surface: 'delegation-graph',
		});
		await flush();

		expect(openModal).toHaveBeenCalledWith({
			surface: 'delegation-graph',
			tab: undefined,
			subTab: undefined,
			group: undefined,
		});
		expect(lastResponse(client)).toMatchObject({
			type: 'open_modal_result',
			success: true,
			requestId: 'req-1',
		});
	});

	it('hands the group to the renderer for the Delegation Graph', async () => {
		handler.handleMessage(client, {
			type: 'open_modal',
			requestId: 'req-2',
			// An alias, so the id the renderer gets is the registry's.
			surface: 'delegation',
			group: 'group-1',
		});
		await flush();

		expect(openModal).toHaveBeenCalledWith(
			expect.objectContaining({ surface: 'delegation-graph', group: 'group-1' })
		);
		expect(lastResponse(client)).toMatchObject({ success: true, requestId: 'req-2' });
	});

	it('refuses a group on a surface that does not open on one, and opens nothing', async () => {
		handler.handleMessage(client, {
			type: 'open_modal',
			requestId: 'req-3',
			surface: 'cue',
			group: 'group-1',
		});
		await flush();

		expect(openModal).not.toHaveBeenCalled();
		expect(lastResponse(client)).toMatchObject({
			type: 'open_modal_result',
			success: false,
			requestId: 'req-3',
		});
		expect(lastResponse(client).error).toContain('--group does not apply');
	});

	it('reads an empty group as no group', async () => {
		handler.handleMessage(client, {
			type: 'open_modal',
			requestId: 'req-4',
			surface: 'cue',
			group: '',
		});
		await flush();

		expect(openModal).toHaveBeenCalledWith(
			expect.objectContaining({ surface: 'cue', group: undefined })
		);
	});

	it('still refuses a tab the surface does not have when a group is given', async () => {
		handler.handleMessage(client, {
			type: 'open_modal',
			requestId: 'req-5',
			surface: 'delegation-graph',
			tab: 'peers',
			group: 'group-1',
		});
		await flush();

		expect(openModal).not.toHaveBeenCalled();
		expect(lastResponse(client).error).toContain('has no tabs');
	});
});

// Edit Agent is one agent's form. This hop knows the agents, so an agent that
// is gone is refused here: the renderer would open nothing and say nothing.
describe("open_modal handler: a surface that is one agent's", () => {
	let handler: WebSocketMessageHandler;
	let client: WebClient;
	let openModal: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		handler = new WebSocketMessageHandler();
		client = createMockClient();
		openModal = vi.fn().mockResolvedValue(true);
		handler.setCallbacks({
			openModal,
			getSessions: () => [{ id: 'agent-1', name: 'Builder' }],
		} as never);
	});

	it('hands the agent and the tab to the renderer for Edit Agent', async () => {
		handler.handleMessage(client, {
			type: 'open_modal',
			requestId: 'req-1',
			// An alias and a label, so the ids the renderer gets are the registry's.
			surface: 'edit-agent',
			tab: 'Peers',
			agent: 'agent-1',
		});
		await flush();

		expect(openModal).toHaveBeenCalledWith(
			expect.objectContaining({ surface: 'agent-settings', tab: 'peers', agent: 'agent-1' })
		);
		expect(lastResponse(client)).toMatchObject({ success: true, requestId: 'req-1' });
	});

	it('refuses Edit Agent without an agent, and opens nothing', async () => {
		handler.handleMessage(client, {
			type: 'open_modal',
			requestId: 'req-2',
			surface: 'agent-settings',
			agent: '',
		});
		await flush();

		expect(openModal).not.toHaveBeenCalled();
		expect(lastResponse(client)).toMatchObject({ success: false, requestId: 'req-2' });
		expect(lastResponse(client).error).toContain('pass --agent');
	});

	it('refuses an agent that is gone, and opens nothing', async () => {
		handler.handleMessage(client, {
			type: 'open_modal',
			requestId: 'req-3',
			surface: 'agent-settings',
			agent: 'agent-gone',
		});
		await flush();

		expect(openModal).not.toHaveBeenCalled();
		expect(lastResponse(client)).toMatchObject({
			success: false,
			error: 'Agent not found: agent-gone',
		});
	});

	it("refuses an agent on a surface that is not one agent's, and opens nothing", async () => {
		handler.handleMessage(client, {
			type: 'open_modal',
			requestId: 'req-4',
			surface: 'cue',
			agent: 'agent-1',
		});
		await flush();

		expect(openModal).not.toHaveBeenCalled();
		expect(lastResponse(client).error).toContain('--agent does not apply');
	});
});

// `open` used to answer "Opened" for a surface behind a switched-off Encore
// Feature: the app showed a toast and stayed as it was, and the caller was
// told the opposite. The flags are read at this hop, so the refusal is in the
// reply.
describe('open_modal handler: a surface behind an Encore Feature', () => {
	let handler: WebSocketMessageHandler;
	let client: WebClient;
	let openModal: ReturnType<typeof vi.fn>;

	const withFlags = (encoreFeatures: unknown) =>
		setBridgeGuardContextProvider(() => ({
			userDataDir: null,
			encoreFeatures,
			platform: process.platform,
		}));

	beforeEach(() => {
		handler = new WebSocketMessageHandler();
		client = createMockClient();
		openModal = vi.fn().mockResolvedValue(true);
		handler.setCallbacks({ openModal } as never);
	});

	afterEach(() => {
		setBridgeGuardContextProvider(null);
	});

	it('refuses a surface whose feature is off, and asks the app for nothing', async () => {
		withFlags({ maestroCue: false });
		handler.handleMessage(client, { type: 'open_modal', requestId: 'req-1', surface: 'cue' });
		await flush();

		expect(openModal).not.toHaveBeenCalled();
		expect(lastResponse(client)).toMatchObject({
			type: 'open_modal_result',
			success: false,
			requestId: 'req-1',
		});
		expect(lastResponse(client).error).toContain('is an Encore Feature and is currently off');
	});

	it('opens the same surface once the feature is on', async () => {
		withFlags({ maestroCue: true });
		handler.handleMessage(client, { type: 'open_modal', requestId: 'req-2', surface: 'cue' });
		await flush();

		expect(openModal).toHaveBeenCalledTimes(1);
		expect(lastResponse(client)).toMatchObject({ success: true });
	});

	it('refuses Voice Setup on an install that never switched voice on', async () => {
		// Nothing stored: A Cappella reads as its default, which is off.
		withFlags(undefined);
		handler.handleMessage(client, {
			type: 'open_modal',
			requestId: 'req-3',
			surface: 'voice-setup',
		});
		await flush();

		expect(openModal).not.toHaveBeenCalled();
		expect(lastResponse(client).success).toBe(false);
	});

	it('does not gate a surface behind no feature', async () => {
		withFlags({});
		handler.handleMessage(client, { type: 'open_modal', requestId: 'req-4', surface: 'settings' });
		await flush();
		expect(openModal).toHaveBeenCalledTimes(1);
	});
});

describe('open_modal handler: Group Settings', () => {
	let handler: WebSocketMessageHandler;
	let client: WebClient;
	let openModal: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		handler = new WebSocketMessageHandler();
		client = createMockClient();
		openModal = vi.fn().mockResolvedValue(true);
		handler.setCallbacks({ openModal } as never);
	});

	it('opens on the group it was given', async () => {
		handler.handleMessage(client, {
			type: 'open_modal',
			requestId: 'req-1',
			surface: 'group-settings',
			group: 'group-1',
		});
		await flush();

		expect(openModal).toHaveBeenCalledWith(
			expect.objectContaining({ surface: 'group-settings', group: 'group-1' })
		);
	});

	it('is refused without a group, since it has nothing to open on', async () => {
		handler.handleMessage(client, {
			type: 'open_modal',
			requestId: 'req-2',
			surface: 'group-settings',
		});
		await flush();

		expect(openModal).not.toHaveBeenCalled();
		expect(lastResponse(client).error).toContain('pass --group');
	});
});
