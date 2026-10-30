import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough, Writable } from 'stream';
import {
	NdJsonConnection,
	type NdJsonRecord,
} from '../../../../../shared/maestro-lib/harness/rpc/connection';

function childFixture() {
	const stdout = new PassThrough();
	const writes: string[] = [];
	const stdin = new Writable({
		write(chunk, _encoding, callback) {
			writes.push(String(chunk));
			callback();
		},
	});
	const child = Object.assign(new EventEmitter(), { stdin, stdout });
	return { child: child as never, stdout, writes };
}

describe('NdJsonConnection', () => {
	it('correlates Pi command responses and negotiates RPC v2 chunks', async () => {
		const { child, stdout } = childFixture();
		const notifications: NdJsonRecord[] = [];
		const connection = new NdJsonConnection(child, {
			protocol: 'pi',
			negotiateV2: true,
			onNotification: (record) => notifications.push(record),
			onServerRequest: async () => ({ kind: 'ignore' }),
		});
		const statePromise = connection.request('get_state');
		const negotiatePromise = connection.request('negotiate_protocol', { protocolVersion: 2 });
		stdout.write(
			JSON.stringify({ type: 'ready', protocolVersion: 1, supportedProtocolVersions: [1, 2] }) +
				'\n'
		);
		stdout.write(
			JSON.stringify({
				id: 'req-1',
				type: 'response',
				success: true,
				data: { sessionId: 'session-a' },
			}) + '\n'
		);
		stdout.write(
			JSON.stringify({
				id: 'req-2',
				type: 'response',
				success: true,
				data: { protocolVersion: 2 },
			}) + '\n'
		);
		const payload = Buffer.from(JSON.stringify({ type: 'agent_settled' })).toString('base64');
		const midpoint = Math.ceil(payload.length / 2);
		const first = payload.slice(0, midpoint);
		const second = payload.slice(midpoint);
		stdout.write(
			JSON.stringify({
				type: 'rpc_chunk',
				chunkId: 'chunk-1',
				index: 0,
				count: 2,
				byteLength: Buffer.from(JSON.stringify({ type: 'agent_settled' })).length,
				data: first,
			}) + '\n'
		);
		stdout.write(
			JSON.stringify({
				type: 'rpc_chunk',
				chunkId: 'chunk-1',
				index: 1,
				count: 2,
				byteLength: Buffer.from(JSON.stringify({ type: 'agent_settled' })).length,
				data: second,
			}) + '\n'
		);

		await expect(statePromise).resolves.toEqual({ sessionId: 'session-a' });
		await expect(negotiatePromise).resolves.toEqual({ protocolVersion: 2 });
		expect(notifications.some((record) => record.type === 'agent_settled')).toBe(true);
		connection.close();
	});

	it('rejects interleaved or oversized RPC chunks without approving work', () => {
		const { child, stdout } = childFixture();
		const notifications: NdJsonRecord[] = [];
		const connection = new NdJsonConnection(child, {
			protocol: 'pi',
			onNotification: (record) => notifications.push(record),
			onServerRequest: async () => ({ kind: 'ignore' }),
			maxReassembledFrameBytes: 8,
		});
		stdout.write(
			JSON.stringify({
				type: 'rpc_chunk',
				chunkId: 'chunk-1',
				index: 0,
				count: 2,
				byteLength: 100,
				data: 'AAAA',
			}) + '\n'
		);
		expect(notifications[0].type).toBe('rpc_frame_error');
		connection.close();
	});

	it('preserves UTF-8 characters split across stdout chunks', async () => {
		const { child, stdout } = childFixture();
		const notifications: NdJsonRecord[] = [];
		new NdJsonConnection(child, {
			protocol: 'jsonrpc',
			onNotification: (record) => notifications.push(record),
			onServerRequest: async () => ({ kind: 'ignore' }),
		});
		const bytes = Buffer.from(JSON.stringify({ type: 'text', text: 'hello 😀' }) + '\n');
		const emoji = bytes.indexOf(Buffer.from('😀'));
		stdout.write(bytes.subarray(0, emoji + 2));
		stdout.write(bytes.subarray(emoji + 2));
		await vi.waitFor(() => expect(notifications).toHaveLength(1));
		expect(notifications[0].text).toBe('hello 😀');
	});

	it('closes on an oversized unterminated line without echoing its payload', async () => {
		const { child, stdout } = childFixture();
		const notifications: NdJsonRecord[] = [];
		const onServerRequest = vi.fn(async () => ({ kind: 'ignore' as const }));
		const connection = new NdJsonConnection(child, {
			protocol: 'jsonrpc',
			maxLineBytes: 16,
			onNotification: (record) => notifications.push(record),
			onServerRequest,
		});
		const pending = connection.request('status');
		stdout.write('{"type":"unterminated-secret-payload');
		expect(notifications).toEqual([{ type: 'transport_error', error: 'RPC line exceeds limit' }]);
		await expect(pending).rejects.toThrow('native transport line exceeds limit');
		stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'status' }) + '\n');
		stdout.write(JSON.stringify({ type: 'text', text: 'late' }) + '\n');
		expect(notifications).toHaveLength(1);
		expect(onServerRequest).not.toHaveBeenCalled();
	});

	it('answers rejected server requests for JSON-RPC and Pi peers', async () => {
		const json = childFixture();
		new NdJsonConnection(json.child, {
			protocol: 'jsonrpc',
			onNotification: () => undefined,
			onServerRequest: async () => {
				throw new Error('handler failed');
			},
		});
		json.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'status' }) + '\n');
		await vi.waitFor(() => expect(json.writes).toHaveLength(1));
		expect(JSON.parse(json.writes[0])).toMatchObject({
			jsonrpc: '2.0',
			id: 7,
			error: { code: -32603, message: 'Internal error' },
		});

		const pi = childFixture();
		new NdJsonConnection(pi.child, {
			protocol: 'pi',
			onNotification: () => undefined,
			onServerRequest: async () => {
				throw new Error('handler failed');
			},
		});
		pi.stdout.write(
			JSON.stringify({ type: 'extension_ui_request', id: 'ui-1', method: 'confirm' }) + '\n'
		);
		await vi.waitFor(() => expect(pi.writes).toHaveLength(1));
		expect(JSON.parse(pi.writes[0])).toMatchObject({
			type: 'extension_ui_response',
			id: 'ui-1',
			cancelled: true,
		});
	});
});
