import { describe, expect, it } from 'vitest';
import {
	OmpProtocolError,
	OmpRpcClient,
	redactOmpDiagnostic,
	type OmpRpcTransport,
} from '../../runtime';

class FakeTransport implements OmpRpcTransport {
	readonly writes: string[] = [];
	private readonly stdoutListeners: Array<(chunk: Uint8Array | string) => void> = [];
	private readonly stderrListeners: Array<(chunk: Uint8Array | string) => void> = [];
	private readonly closedListeners: Array<(reason?: string) => void> = [];

	send(frame: string): void {
		this.writes.push(frame);
	}

	onFrame(listener: (chunk: Uint8Array | string) => void): () => void {
		this.stdoutListeners.push(listener);
		return () => this.stdoutListeners.splice(this.stdoutListeners.indexOf(listener), 1);
	}

	onDiagnostic(listener: (chunk: Uint8Array | string) => void): () => void {
		this.stderrListeners.push(listener);
		return () => this.stderrListeners.splice(this.stderrListeners.indexOf(listener), 1);
	}

	onClosed(listener: (reason?: string) => void): () => void {
		this.closedListeners.push(listener);
		return () => this.closedListeners.splice(this.closedListeners.indexOf(listener), 1);
	}

	stdout(frame: string): void {
		for (const listener of this.stdoutListeners) listener(frame);
	}

	stderr(frame: string): void {
		for (const listener of this.stderrListeners) listener(frame);
	}

	close(reason?: string): void {
		for (const listener of this.closedListeners) listener(reason);
	}
}

function readyClient(options: ConstructorParameters<typeof OmpRpcClient>[1] = {}) {
	const transport = new FakeTransport();
	const client = new OmpRpcClient(transport, { requestTimeoutMs: 5_000, ...options });
	const ready = client.waitForReady();
	transport.stdout('{"type":"ready"}\n');
	return { client, transport, ready };
}

describe('OmpRpcClient framing and protocol boundaries', () => {
	it('requires ready before issuing correlated commands and resolves responses by id rather than arrival order', async () => {
		const { client, transport, ready } = readyClient();
		await ready;

		const first = client.command({ type: 'get_state' });
		const second = client.command({ type: 'get_available_commands' });
		const firstId = JSON.parse(transport.writes[0] ?? '').id as string;
		const secondId = JSON.parse(transport.writes[1] ?? '').id as string;

		transport.stdout(
			`{"id":"${secondId}","type":"response","command":"get_available_commands","success":true,"data":{"commands":[]}}\n`
		);
		transport.stdout(
			`{"id":"${firstId}","type":"response","command":"get_state","success":true,"data":{"sessionId":"s","thinkingLevel":"medium","isStreaming":false,"isCompacting":false,"steeringMode":"all","followUpMode":"all","interruptMode":"immediate","autoCompactionEnabled":true,"messageCount":0,"queuedMessageCount":0,"todoPhases":[]}}\n`
		);

		await expect(second).resolves.toMatchObject({ command: 'get_available_commands' });
		await expect(first).resolves.toMatchObject({ command: 'get_state' });
	});

	it('keeps prompt operations pending after acknowledgement until their correlated prompt result', async () => {
		const { client, transport, ready } = readyClient();
		await ready;
		const pending = client.command({ type: 'prompt', message: 'hello' });
		const id = JSON.parse(transport.writes[0] ?? '').id as string;

		transport.stdout(`{"id":"${id}","type":"response","command":"prompt","success":true}\n`);
		expect(client.pendingRequestCount).toBe(1);
		transport.stdout(
			`{"id":"${id}","type":"prompt_result","success":true,"result":{"text":"done"}}\n`
		);

		await expect(pending).resolves.toMatchObject({ command: 'prompt', success: true });
		expect(client.pendingRequestCount).toBe(0);
	});

	it('preserves stdout event order and does not treat events as command responses', async () => {
		const { client, transport, ready } = readyClient();
		await ready;
		const seen: string[] = [];
		client.onEvent((event) => seen.push(event.type));

		transport.stdout(
			'{"type":"agent_start"}\n{"type":"message_update","assistantMessageEvent":{"type":"text_delta"}}\n'
		);

		expect(seen).toEqual(['agent_start', 'message_update']);
	});

	it('fails the generation for an out-of-order explicit runtime sequence', async () => {
		const { client, transport, ready } = readyClient();
		await ready;

		transport.stdout('{"type":"agent_start","sequence":2}\n');
		transport.stdout('{"type":"agent_end","sequence":1}\n');

		expect(client.status).toBe('failed');
	});

	it('rejects a cancelled command and removes its pending correlation without killing the owned process', async () => {
		const { client, ready } = readyClient();
		await ready;
		const controller = new AbortController();
		const pending = client.command({ type: 'get_state' }, { signal: controller.signal });
		controller.abort();

		await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
		expect(client.pendingRequestCount).toBe(0);
	});

	it('writes stable inbound callback frames without creating a request correlation', async () => {
		const { client, transport, ready } = readyClient();
		await ready;
		client.sendInbound({ type: 'extension_ui_response', id: 'approval-1', confirmed: true });

		expect(transport.writes).toEqual([
			'{"type":"extension_ui_response","id":"approval-1","confirmed":true}\n',
		]);
		expect(client.pendingRequestCount).toBe(0);
	});

	it('limits a controller generation to thirty-two in-flight correlated commands', async () => {
		const { client, ready } = readyClient();
		await ready;

		const pending = Array.from({ length: 32 }, () => client.command({ type: 'get_state' }));
		await expect(client.command({ type: 'get_state' })).rejects.toThrow(/32.*in-flight/i);
		client.close();
		await Promise.allSettled(pending);
	});

	it.each([
		['malformed JSON', '{not-json}\n'],
		['unknown frame type', '{"type":"future_protocol_member"}\n'],
		['oversized frame', '{"type":"ready","padding":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}\n'],
	])('fails closed for %s', async (_caseName, frame) => {
		const transport = new FakeTransport();
		const client = new OmpRpcClient(transport, { maxFrameBytes: 32, requestTimeoutMs: 5_000 });
		const waiting = client.waitForReady();
		transport.stdout(frame);

		await expect(waiting).rejects.toBeInstanceOf(OmpProtocolError);
		expect(client.status).toBe('failed');
	});

	it('caps and redacts stderr diagnostics before exposing them', async () => {
		const { client, transport, ready } = readyClient({ maxDiagnosticBytes: 24 });
		await ready;
		const diagnostics: string[] = [];
		client.onDiagnostic((diagnostic) => diagnostics.push(diagnostic));
		transport.stderr('token=super-secret-value and trailing material');

		expect(diagnostics).toEqual(['token=[REDACTED] and tra']);
		expect(redactOmpDiagnostic('Authorization: Bearer very-secret')).toContain('[REDACTED]');
	});

	it('rejects all pending calls when its process exits', async () => {
		const { client, transport, ready } = readyClient();
		await ready;
		const pending = client.command({ type: 'get_state' });
		transport.close('crashed');

		await expect(pending).rejects.toMatchObject({ code: 'runtime_closed' });
		expect(client.status).toBe('exited');
	});
});
