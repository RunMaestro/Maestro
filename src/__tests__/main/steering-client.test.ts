/**
 * @file steering-client.test.ts
 * @description Tests for src/main/process-manager/steering-client.ts - the
 * main-process end of maestro-p's chat-steering channel. Real sockets, because the
 * behaviour under test is the socket contract and its failure modes.
 */

import * as fs from 'fs';
import * as net from 'net';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	sendSteeringRequest,
	steeringSocketPathFor,
} from '../../main/process-manager/steering-client';
import { STEERING_MAX_TEXT_BYTES, STEERING_TOO_LONG_DETAIL } from '../../shared/chatSteering';

vi.mock('../../main/utils/logger', () => ({
	logger: { warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() },
}));

// Real platform by default, so the socket tests below bind what this OS binds;
// individual tests pin one platform to check the path shape on the other.
const platformMock = vi.hoisted(() => ({ windows: undefined as boolean | undefined }));
vi.mock('../../shared/platformDetection', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../shared/platformDetection')>();
	return {
		...actual,
		isWindows: () => platformMock.windows ?? actual.isWindows(),
	};
});

const servers: net.Server[] = [];

afterEach(async () => {
	platformMock.windows = undefined;
	while (servers.length) {
		const server = servers.pop()!;
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

/**
 * Stand in for maestro-p on the socket a given process key derives, replying with
 * whatever `reply` produces. `null` means answer nothing at all.
 */
async function fakeMaestroP(
	processKey: string,
	reply: (frame: { id: string; text: string }) => string | null
): Promise<void> {
	const socketPath = steeringSocketPathFor(processKey);
	try {
		if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);
	} catch {
		// best effort
	}
	const server = net.createServer((socket) => {
		socket.setEncoding('utf8');
		socket.on('data', (chunk: string) => {
			for (const line of chunk.split('\n')) {
				if (!line.trim()) continue;
				const parsed = JSON.parse(line);
				const out = reply({ id: parsed.id, text: parsed.text });
				if (out !== null) socket.write(`${out}\n`);
			}
		});
		socket.on('error', () => {});
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()));
}

describe('steeringSocketPathFor', () => {
	it('is stable for a key and distinct between keys', () => {
		// Both the spawner and the client derive it independently; they have to agree
		// without either passing a value to the other.
		const a = steeringSocketPathFor('agent-1-ai-tab-1');
		expect(steeringSocketPathFor('agent-1-ai-tab-1')).toBe(a);
		expect(steeringSocketPathFor('agent-1-ai-tab-2')).not.toBe(a);
	});

	it('is a named pipe on Windows, where Node cannot bind a filesystem path', () => {
		platformMock.windows = true;
		const pipe = steeringSocketPathFor('agent-1-ai-tab-1');
		expect(pipe).toMatch(/^\\\\\.\\pipe\\maestro-steer-[0-9a-f]{16}$/);

		// Same hash on both platforms: only the namespace differs.
		platformMock.windows = false;
		const sock = steeringSocketPathFor('agent-1-ai-tab-1');
		expect(sock.endsWith('.sock')).toBe(true);
		expect(sock).not.toContain('\\pipe\\');
		expect(pipe.slice(-16)).toBe(sock.slice(-21, -5));
	});

	it('stays short enough to bind however long the process key is', async () => {
		// A unix socket address is capped near 104 bytes on macOS. A session UUID plus
		// a tab id plus the tmpdir blows past that, and the failure mode is a socket
		// that never binds - steering silently unavailable, with no obvious cause.
		const longKey = `${'0123456789abcdef'.repeat(8)}-ai-${'tab'.repeat(40)}`;
		const socketPath = steeringSocketPathFor(longKey);
		expect(socketPath.length).toBeLessThan(104);

		// Prove it, rather than trusting the arithmetic.
		const server = net.createServer();
		servers.push(server);
		await expect(
			new Promise<void>((resolve, reject) => {
				server.once('error', reject);
				server.listen(socketPath, () => resolve());
			})
		).resolves.toBeUndefined();
	});
});

describe('sendSteeringRequest', () => {
	it('sends the text and returns the verdict', async () => {
		const key = `t1-${Date.now()}-ai-tab`;
		const seen: Array<{ id: string; text: string }> = [];
		await fakeMaestroP(key, (frame) => {
			seen.push(frame);
			return JSON.stringify({ type: 'steering', id: frame.id, verdict: 'delivered' });
		});

		const result = await sendSteeringRequest({ processKey: key, text: 'go left', id: 'req-1' });

		expect(seen).toEqual([{ id: 'req-1', text: 'go left' }]);
		expect(result).toEqual({ type: 'steering', id: 'req-1', verdict: 'delivered' });
	});

	it('passes a refusal through with its reason and detail', async () => {
		// The UI needs the specific reason: "a permission prompt is on screen" is
		// actionable where a bare failure is not.
		const key = `t2-${Date.now()}-ai-tab`;
		await fakeMaestroP(key, (frame) =>
			JSON.stringify({
				type: 'steering',
				id: frame.id,
				verdict: 'refused',
				refusal: 'blocking-dialog',
				detail: 'a permission prompt',
			})
		);

		const result = await sendSteeringRequest({ processKey: key, text: 'x', id: 'req-2' });

		expect(result).toMatchObject({
			verdict: 'refused',
			refusal: 'blocking-dialog',
			detail: 'a permission prompt',
		});
	});

	it('refuses an over-cap steer without opening the socket', async () => {
		// processKey names no listener: reaching the socket would answer not-running.
		const result = await sendSteeringRequest({
			processKey: `never-listened-${Date.now()}-ai-tab`,
			text: 'x'.repeat(STEERING_MAX_TEXT_BYTES + 1),
			id: 'req-big',
		});

		expect(result).toEqual({
			type: 'steering',
			id: 'req-big',
			verdict: 'refused',
			refusal: 'too-long',
			detail: STEERING_TOO_LONG_DETAIL,
		});
	});

	it('reports an unsteerable turn as refused rather than throwing', async () => {
		// Nothing is listening: the agent is on the API token source, the turn already
		// finished, or this maestro-p predates steering. All ordinary, none an error.
		const result = await sendSteeringRequest({
			processKey: `never-listened-${Date.now()}-ai-tab`,
			text: 'x',
			id: 'req-3',
		});

		expect(result.verdict).toBe('refused');
		expect(result.refusal).toBe('not-running');
		expect(result.detail).toContain('not steerable');
	});

	it('ignores a verdict for a different request id', async () => {
		// One channel can carry several requests. Settling on somebody else's verdict
		// would report the wrong outcome for this message.
		const key = `t4-${Date.now()}-ai-tab`;
		await fakeMaestroP(key, (frame) =>
			[
				JSON.stringify({ type: 'steering', id: 'someone-else', verdict: 'absorbed' }),
				JSON.stringify({ type: 'steering', id: frame.id, verdict: 'delivered' }),
			].join('\n')
		);

		const result = await sendSteeringRequest({ processKey: key, text: 'x', id: 'req-4' });

		expect(result).toEqual({ type: 'steering', id: 'req-4', verdict: 'delivered' });
	});

	it('rejects a malformed verdict rather than handing it to the UI', async () => {
		// Falls through to the close/timeout path as `unknown`. A garbage frame must
		// not become a verdict the UI has no branch for.
		const key = `t5-${Date.now()}-ai-tab`;
		await fakeMaestroP(key, () => '{"type":"steering","id":"req-5","verdict":"teleported"}');

		const result = await sendSteeringRequest({
			processKey: key,
			text: 'x',
			id: 'req-5',
			timeoutMs: 300,
		});

		expect(result.verdict).toBe('unknown');
	});

	it('answers `unknown`, never `refused`, when the reply never comes', async () => {
		// The text may well have been typed - we simply never heard back. Reporting
		// `refused` would invite a re-send that could double the message into the turn.
		const key = `t6-${Date.now()}-ai-tab`;
		await fakeMaestroP(key, () => null);

		const result = await sendSteeringRequest({
			processKey: key,
			text: 'x',
			id: 'req-6',
			timeoutMs: 250,
		});

		expect(result.verdict).toBe('unknown');
		expect(result.detail).toContain('in time');
	});

	it('answers `unknown` when the channel closes without a verdict', async () => {
		const key = `t7-${Date.now()}-ai-tab`;
		const socketPath = steeringSocketPathFor(key);
		const server = net.createServer((socket) => socket.destroy());
		servers.push(server);
		await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()));

		const result = await sendSteeringRequest({ processKey: key, text: 'x', id: 'req-7' });

		expect(result.verdict).toBe('unknown');
	});
});
