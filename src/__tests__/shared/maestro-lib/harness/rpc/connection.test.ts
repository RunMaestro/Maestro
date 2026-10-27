import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough, Writable } from 'stream';
import {
	NdJsonConnection,
	type NdJsonRecord,
} from '../../../../../shared/maestro-lib/harness/rpc/connection';

function childFixture() {
	const stdout = new PassThrough();
	const stdin = new Writable({
		write(chunk, _encoding, callback) {
			callback();
		},
	});
	const child = Object.assign(new EventEmitter(), { stdin, stdout });
	return { child: child as never, stdout };
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
});
