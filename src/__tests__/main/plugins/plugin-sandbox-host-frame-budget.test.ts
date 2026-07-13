import { beforeEach, describe, expect, it, vi } from 'vitest';

const { forkMock, postMessage, emitMessage } = vi.hoisted(() => {
	let onMessage: ((data: unknown) => void) | undefined;
	const postMessage = vi.fn();
	const proc = {
		postMessage,
		on: vi.fn((event: string, listener: (data: unknown) => void) => {
			if (event === 'message') onMessage = listener;
		}),
		kill: vi.fn(() => true),
	};
	return {
		forkMock: vi.fn(() => proc),
		postMessage,
		emitMessage(data: unknown) {
			if (!onMessage) throw new Error('sandbox message listener was not installed');
			onMessage(data);
		},
	};
});

vi.mock('electron', () => ({ utilityProcess: { fork: forkMock } }));

import { PluginSandboxHost } from '../../../main/plugins/plugin-sandbox-host';
import type { PermissionBroker } from '../../../main/plugins/permission-broker';
import { MAX_INTERACTIVE_RUNTIME_WRITE_HOST_CALL_BYTES } from '../../../shared/plugins/interactive-runtime';
import { MAX_PLUGIN_HOST_CALL_BYTES } from '../../../shared/plugins/rpc-protocol';

function paramsWithSerializedBytes(byteLength: number) {
	const prefix = { runtimeId: 'runtime-1', request: { data: '' } };
	return {
		runtimeId: prefix.runtimeId,
		request: { data: 'x'.repeat(byteLength - Buffer.byteLength(JSON.stringify(prefix))) },
	};
}

function startHost(allowed: boolean, handler = vi.fn(async () => ({}))) {
	const host = new PluginSandboxHost({
		broker: {
			authorizeInvocation: vi.fn(() => ({ allowed })),
		} as unknown as PermissionBroker,
		handlers: {
			'interactiveRuntime.write': handler,
			'fs.read': handler,
		},
	});
	host.start('test-plugin', '// entry', {
		ownerPluginId: 'test-plugin',
		generation: 1,
		artifactDigest: 'a'.repeat(64),
		signerKeyId: 'test-signer',
	});
	postMessage.mockClear();
	return { host, handler };
}

async function dispatch(request: { id: number; method: string; params: unknown }) {
	emitMessage(request);
	await vi.waitFor(() =>
		expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ id: request.id }))
	);
}

describe('PluginSandboxHost interactive runtime write budget', () => {
	beforeEach(() => vi.clearAllMocks());

	it('allows just-under and exact authorized interactive runtime write payloads, but rejects one byte over before its handler', async () => {
		const { handler } = startHost(true);
		for (const [id, bytes] of [
			[1, MAX_INTERACTIVE_RUNTIME_WRITE_HOST_CALL_BYTES - 1],
			[2, MAX_INTERACTIVE_RUNTIME_WRITE_HOST_CALL_BYTES],
		] as const) {
			await dispatch({
				id,
				method: 'interactiveRuntime.write',
				params: paramsWithSerializedBytes(bytes),
			});
		}
		expect(handler).toHaveBeenCalledTimes(2);

		await dispatch({
			id: 3,
			method: 'interactiveRuntime.write',
			params: paramsWithSerializedBytes(MAX_INTERACTIVE_RUNTIME_WRITE_HOST_CALL_BYTES + 1),
		});
		expect(handler).toHaveBeenCalledTimes(2);
		expect(postMessage).toHaveBeenLastCalledWith(
			expect.objectContaining({ id: 3, ok: false, error: 'request params exceed size limit' })
		);
	});

	it('retains the smaller generic host-call limit and never extends it to unauthorized runtime writes', async () => {
		const authorized = startHost(true);
		await dispatch({
			id: 4,
			method: 'fs.read',
			params: { data: 'x'.repeat(MAX_PLUGIN_HOST_CALL_BYTES + 1) },
		});
		expect(authorized.handler).not.toHaveBeenCalled();
		expect(postMessage).toHaveBeenLastCalledWith(
			expect.objectContaining({ id: 4, ok: false, error: 'request params exceed size limit' })
		);

		const denied = startHost(false);
		await dispatch({
			id: 5,
			method: 'interactiveRuntime.write',
			params: paramsWithSerializedBytes(MAX_INTERACTIVE_RUNTIME_WRITE_HOST_CALL_BYTES),
		});
		expect(denied.handler).not.toHaveBeenCalled();
		expect(postMessage).toHaveBeenLastCalledWith(
			expect.objectContaining({ id: 5, ok: false, error: 'permission denied' })
		);
	});
});
