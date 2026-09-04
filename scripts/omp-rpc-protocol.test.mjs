import assert from 'node:assert/strict';
import test from 'node:test';

import {
	JsonLineDecoder,
	RpcProcessPeer,
	RpcV2FrameDecoder,
	clampTransportLimits,
	redactConformanceReport,
	summarizeProtocolFrame,
	validateReadyFrame,
} from './omp-rpc-protocol.mjs';

const jsonLine = (value) => Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');

function chunkFrames(value, splitAt) {
	const bytes = Buffer.from(JSON.stringify(value), 'utf8');
	const chunks = [bytes.subarray(0, splitAt), bytes.subarray(splitAt)];
	return chunks.map((chunk, index) => ({
		type: 'rpc_chunk',
		chunkId: 'rpc-test',
		index,
		count: chunks.length,
		byteLength: bytes.length,
		data: chunk.toString('base64'),
	}));
}

test('JsonLineDecoder preserves UTF-8 split across byte chunks', () => {
	const decoder = new JsonLineDecoder({ maxFrameBytes: 128 });
	const snowman = '\u2603';
	const frame = jsonLine({ type: 'notice', text: `before ${snowman} after` });
	const splitAt = frame.indexOf(Buffer.from(snowman)) + 1;

	assert.deepEqual(decoder.push(frame.subarray(0, splitAt)), []);
	assert.deepEqual(decoder.push(frame.subarray(splitAt)), [
		{ type: 'notice', text: `before ${snowman} after` },
	]);
	assert.equal(decoder.bufferedBytes, 0);
});

test('JsonLineDecoder accepts CRLF and ignores empty lines', () => {
	const decoder = new JsonLineDecoder({ maxFrameBytes: 128 });
	assert.deepEqual(decoder.push(Buffer.from('\r\n{"type":"ready"}\r\n\n')), [{ type: 'ready' }]);
});

test('JsonLineDecoder rejects non-object JSON and invalid JSON', () => {
	const decoder = new JsonLineDecoder({ maxFrameBytes: 128 });
	assert.throws(() => decoder.push(Buffer.from('[]\n')), /JSON object/);
	assert.throws(() => new JsonLineDecoder().push(Buffer.from('{broken}\n')), /invalid JSON/);
});

test('JsonLineDecoder enforces the physical frame limit before newline', () => {
	const decoder = new JsonLineDecoder({ maxFrameBytes: 8 });
	assert.throws(() => decoder.push(Buffer.from('123456789')), /physical frame limit/);
});

test('JsonLineDecoder flush rejects a truncated final frame', () => {
	const decoder = new JsonLineDecoder({ maxFrameBytes: 128 });
	decoder.push(Buffer.from('{"type":"ready"'));
	assert.throws(() => decoder.flush(), /truncated JSONL frame/);
});

test('validateReadyFrame accepts the public v1 ready frame and protocol v2 advertisement', () => {
	assert.deepEqual(
		validateReadyFrame({
			type: 'ready',
			protocolVersion: 1,
			supportedProtocolVersions: [1, 2],
			maxFrameBytes: 1_048_576,
			maxReassembledFrameBytes: 67_108_864,
		}),
		{
			protocolVersion: 1,
			supportedProtocolVersions: [1, 2],
			maxFrameBytes: 1_048_576,
			maxReassembledFrameBytes: 67_108_864,
		}
	);
});

test('validateReadyFrame rejects malformed or contradictory limits', () => {
	assert.throws(
		() =>
			validateReadyFrame({
				type: 'ready',
				protocolVersion: 1,
				supportedProtocolVersions: [1],
				maxFrameBytes: 0,
				maxReassembledFrameBytes: 10,
			}),
		/maxFrameBytes/
	);
	assert.throws(
		() =>
			validateReadyFrame({
				type: 'ready',
				protocolVersion: 1,
				supportedProtocolVersions: [1, 2],
				maxFrameBytes: 100,
				maxReassembledFrameBytes: 99,
			}),
		/reassembled limit/
	);
});

test('clampTransportLimits applies Maestro product ceilings', () => {
	assert.deepEqual(
		clampTransportLimits({ maxFrameBytes: 2_000_000, maxReassembledFrameBytes: 67_108_864 }),
		{ maxFrameBytes: 1_048_576, maxReassembledFrameBytes: 8_388_608 }
	);
});

test('RpcV2FrameDecoder reassembles an ordered logical object', () => {
	const expected = { type: 'response', id: 'messages', data: { value: ''.repeat(20) } };
	const frames = chunkFrames(expected, 17);
	const decoder = new RpcV2FrameDecoder({ maxReassembledFrameBytes: 1024 });

	assert.equal(decoder.push(frames[0]), null);
	assert.deepEqual(decoder.push(frames[1]), expected);
	assert.equal(decoder.hasActiveSequence, false);
});

test('RpcV2FrameDecoder passes through ordinary frames when idle', () => {
	const decoder = new RpcV2FrameDecoder();
	assert.deepEqual(decoder.push({ type: 'response', id: 'one', success: true }), {
		type: 'response',
		id: 'one',
		success: true,
	});
});

test('RpcV2FrameDecoder rejects interleaved and out-of-order sequences', () => {
	const decoder = new RpcV2FrameDecoder({ maxReassembledFrameBytes: 1024 });
	const [first, second] = chunkFrames({ type: 'response', data: 'abc' }, 8);
	assert.equal(decoder.push(first), null);
	assert.throws(() => decoder.push({ ...second, chunkId: 'rpc-other' }), /interleaved/);

	const fresh = new RpcV2FrameDecoder({ maxReassembledFrameBytes: 1024 });
	assert.throws(() => fresh.push(second), /index 0/);
});

test('RpcV2FrameDecoder rejects interruption by an ordinary frame', () => {
	const decoder = new RpcV2FrameDecoder({ maxReassembledFrameBytes: 1024 });
	const [first] = chunkFrames({ type: 'response', data: 'abc' }, 8);
	assert.equal(decoder.push(first), null);
	assert.throws(() => decoder.push({ type: 'notice' }), /interrupted/);
	assert.equal(decoder.hasActiveSequence, false);
});

test('RpcV2FrameDecoder rejects inconsistent metadata and non-canonical base64', () => {
	const decoder = new RpcV2FrameDecoder({ maxReassembledFrameBytes: 1024 });
	const [first, second] = chunkFrames({ type: 'response', data: 'abc' }, 8);
	assert.equal(decoder.push(first), null);
	assert.throws(() => decoder.push({ ...second, count: 3 }), /count changed/);

	assert.throws(
		() =>
			new RpcV2FrameDecoder().push({
				type: 'rpc_chunk',
				chunkId: 'rpc-invalid',
				index: 0,
				count: 1,
				byteLength: 3,
				data: '@@@=',
			}),
		/base64/
	);
});

test('RpcV2FrameDecoder enforces declared byte length and logical limit', () => {
	const expected = { type: 'response', data: '0123456789' };
	const [first, second] = chunkFrames(expected, 8);
	const mismatch = new RpcV2FrameDecoder({ maxReassembledFrameBytes: 1024 });
	assert.equal(mismatch.push(first), null);
	assert.throws(
		() => mismatch.push({ ...second, byteLength: second.byteLength + 1 }),
		/byteLength changed/
	);

	const oversize = new RpcV2FrameDecoder({ maxReassembledFrameBytes: 8 });
	assert.throws(() => oversize.push(first), /logical frame limit/);
});

test('RpcV2FrameDecoder rejects invalid UTF-8 and non-object logical JSON', () => {
	assert.throws(
		() =>
			new RpcV2FrameDecoder().push({
				type: 'rpc_chunk',
				chunkId: 'rpc-utf8',
				index: 0,
				count: 1,
				byteLength: 2,
				data: Buffer.from([0xc3, 0x28]).toString('base64'),
			}),
		/UTF-8/
	);
	assert.throws(
		() =>
			new RpcV2FrameDecoder().push({
				type: 'rpc_chunk',
				chunkId: 'rpc-array',
				index: 0,
				count: 1,
				byteLength: 2,
				data: Buffer.from('[]').toString('base64'),
			}),
		/JSON object/
	);
});

test('summarizeProtocolFrame reports shape without transcript or tool content', () => {
	const summary = summarizeProtocolFrame({
		type: 'message_update',
		message: { role: 'assistant', content: [{ type: 'text', text: 'private transcript value' }] },
		toolCall: { name: 'write', arguments: { secret: 'private tool argument' } },
	});
	assert.deepEqual(summary, {
		type: 'message_update',
		idPresent: false,
		command: null,
		success: null,
		keys: ['message', 'toolCall', 'type'],
	});
	assert.doesNotMatch(JSON.stringify(summary), /private transcript|private tool/);
});

test('redactConformanceReport removes absolute executable and workspace paths recursively', () => {
	const report = {
		executable: 'C:\\Users\\Example\\AppData\\Local\\omp\\omp.exe',
		workspace: 'C:\\Temp\\omp-conformance-123',
		identity: { digest: 'abc', version: '18.1.6' },
		cases: [{ evidence: ['C:\\Temp\\omp-conformance-123\\session.jsonl', 'safe evidence'] }],
	};
	assert.deepEqual(redactConformanceReport(report), {
		executable: '<explicit-omp-executable>',
		workspace: '<isolated-workspace>',
		identity: { digest: 'abc', version: '18.1.6' },
		cases: [{ evidence: ['<isolated-workspace>\\session.jsonl', 'safe evidence'] }],
	});
});
test('RpcProcessPeer rejects a non-ready first frame', async () => {
	const script = 'process.stdout.write(\'{"type":"notice"}\\n\'); setTimeout(() => {}, 10000);';
	const peer = new RpcProcessPeer({ executable: process.execPath, args: ['-e', script] });
	await assert.rejects(peer.ready, /first RPC frame must be ready/);
	await peer.close();
});

test('RpcProcessPeer rejects a duplicate ready frame', async () => {
	const ready = JSON.stringify({
		type: 'ready',
		protocolVersion: 1,
		supportedProtocolVersions: [1, 2],
		maxFrameBytes: 1024,
		maxReassembledFrameBytes: 2048,
	});
	const script = `const line = ${JSON.stringify(ready + '\n')}; process.stdout.write(line); process.stdin.once('data', () => process.stdout.write(line)); setTimeout(() => {}, 10000);`;
	const peer = new RpcProcessPeer({ executable: process.execPath, args: ['-e', script] });
	await peer.ready;
	await assert.rejects(peer.request('get_state'), /more than one ready frame/);
	await peer.close();
});
