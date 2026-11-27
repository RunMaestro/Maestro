// A DESKTOP host serves an agent's History to a Federation client: `get_history`,
// `delete_history_entry`, `update_history_entry`, the same three messages a headless host answers
// (L43). Before this, a desktop echoed them back as unknown, the client read `unsupported`, and a
// Move Back from a desktop host was always refused (it could not read the copy's History).
//
// These run the REAL message handler over a REAL HistoryManager on a scratch folder: the reply a
// client gets is what `MaestroClient.history` reads (`success`, `entries`, `removed`, `updated`).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const scratch = vi.hoisted(() => ({ dir: '' }));

vi.mock('electron', () => ({
	app: { getPath: vi.fn(() => scratch.dir) },
}));
vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../../main/utils/sentry', () => ({
	captureException: vi.fn(),
	captureMessage: vi.fn(),
}));
vi.mock('../../../../main/plugins/plugin-manager-singleton', () => ({
	getPluginManager: () => null,
	getActivePluginManager: () => null,
	isPluginsFeatureEnabled: () => false,
}));

import WebSocket from 'ws';
import { WebSocketMessageHandler } from '../../../../main/web-server/handlers/messageHandlers';
import type { WebClient } from '../../../../main/web-server/handlers/messageHandlers';
import { HistoryManager } from '../../../../main/history-manager';
import * as historyManagerModule from '../../../../main/history-manager';
import { planHostHistoryHome } from '../../../../shared/maestro-lib/agents/lift-history';
import type { HistoryEntry } from '../../../../shared/types';
import { createMemoryAgentHistoryStore } from '../../../helpers/agentHistoryStore';

function entry(id: string, sessionId: string, timestamp: number): HistoryEntry {
	return {
		id,
		type: 'USER',
		timestamp,
		summary: `entry ${id}`,
		projectPath: '/project',
		sessionId,
	} as HistoryEntry;
}

function createClient(): WebClient {
	return {
		socket: { readyState: WebSocket.OPEN, send: vi.fn() } as unknown as WebClient['socket'],
		id: 'client-1',
		connectedAt: 0,
	};
}

function replies(client: WebClient): Record<string, unknown>[] {
	return (client.socket.send as ReturnType<typeof vi.fn>).mock.calls.map(
		(call) => JSON.parse(call[0] as string) as Record<string, unknown>
	);
}

/** Send one message and wait for the reply that carries its request id. */
async function ask(
	handler: WebSocketMessageHandler,
	client: WebClient,
	message: Record<string, unknown>
): Promise<Record<string, unknown>> {
	const requestId = `req-${Math.random()}`;
	handler.handleMessage(client, { ...message, requestId } as never);
	for (let i = 0; i < 200; i++) {
		const reply = replies(client).find((r) => r.requestId === requestId);
		if (reply) return reply;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(`no reply to ${String(message.type)}`);
}

describe('History messages on a desktop host (L43)', () => {
	let manager: HistoryManager;
	let handler: WebSocketMessageHandler;
	let client: WebClient;

	beforeEach(async () => {
		scratch.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-history-handler-'));
		manager = new HistoryManager();
		await manager.initialize();
		vi.spyOn(historyManagerModule, 'getHistoryManager').mockReturnValue(manager);
		handler = new WebSocketMessageHandler();
		client = createClient();
		handler.setCallbacks({
			getSessions: () => [
				{
					id: 'host-agent',
					name: 'Agent',
					toolType: 'claude-code',
					state: 'idle',
					inputMode: 'ai',
					cwd: path.join(scratch.dir, 'no-project'),
				},
			],
		} as never);
		await manager.importEntries('host-agent', [
			entry('old', 'host-agent', 1_000),
			entry('new', 'host-agent', 2_000),
		]);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		fs.rmSync(scratch.dir, { recursive: true, force: true });
	});

	it("get_history answers the agent's own entries, newest first, with a limit", async () => {
		const all = await ask(handler, client, { type: 'get_history', sessionId: 'host-agent' });
		expect(all).toMatchObject({ type: 'get_history_result', success: true });
		expect((all.entries as HistoryEntry[]).map((e) => e.id)).toEqual(['new', 'old']);

		const one = await ask(handler, client, {
			type: 'get_history',
			sessionId: 'host-agent',
			limit: 1,
		});
		expect((one.entries as HistoryEntry[]).map((e) => e.id)).toEqual(['new']);
	});

	it('refuses an agent the host does not have, by name', async () => {
		const reply = await ask(handler, client, { type: 'get_history', sessionId: 'nobody' });
		expect(reply).toMatchObject({ type: 'get_history_result', success: false });
		expect(String(reply.error)).toContain('nobody');
	});

	it('delete_history_entry and update_history_entry edit the one copy in the HistoryManager', async () => {
		const updated = await ask(handler, client, {
			type: 'update_history_entry',
			sessionId: 'host-agent',
			entryId: 'old',
			validated: true,
		});
		expect(updated).toMatchObject({ success: true, updated: true });
		expect((await manager.getEntries('host-agent')).find((e) => e.id === 'old')?.validated).toBe(
			true
		);

		const removed = await ask(handler, client, {
			type: 'delete_history_entry',
			sessionId: 'host-agent',
			entryId: 'old',
		});
		expect(removed).toMatchObject({ success: true, removed: true });
		expect((await manager.getEntries('host-agent')).map((e) => e.id)).toEqual(['new']);

		const missing = await ask(handler, client, {
			type: 'delete_history_entry',
			sessionId: 'host-agent',
			entryId: 'old',
		});
		expect(missing).toMatchObject({ success: true, removed: false });
	});

	it('a Move Back plan reads the copy History through these replies', async () => {
		// The reader a Move Back uses, fed by the desktop handler's replies as the client reads them.
		const reader = {
			list: async (agentId: string) => {
				const reply = await ask(handler, client, { type: 'get_history', sessionId: agentId });
				return reply.success === true
					? { ok: true as const, value: reply.entries as HistoryEntry[] }
					: { ok: false as const, error: { message: String(reply.error) } };
			},
		};
		const here = createMemoryAgentHistoryStore({ local: [entry('new', 'local', 2_000)] });
		const coming = await planHostHistoryHome(reader, 'host-agent', 'local', here);
		expect(coming?.map((e) => [e.id, e.sessionId])).toEqual([['old', 'local']]);
	});
});
