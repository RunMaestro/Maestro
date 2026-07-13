import { describe, expect, it, vi } from 'vitest';
import {
	PluginInteractivePanelHost,
	type InteractivePanelDescriptor,
	type InteractivePanelGuestSender,
} from '../../../main/plugins/plugin-interactive-panel-host';

const descriptor: InteractivePanelDescriptor = {
	requestSchemas: {
		ping: {
			canonicalJsonSchema: {
				type: 'object',
				additionalProperties: false,
				required: ['payload'],
				properties: {
					payload: {
						type: 'array',
						maxItems: 1,
						items: {
							type: 'object',
							additionalProperties: false,
							required: ['state'],
							properties: {
								state: { type: 'string', enum: ['ready'] },
							},
						},
					},
				},
			},
		},
	},
	eventSchemas: { status: { canonicalJsonSchema: { type: 'object' } } },
	resultSchemas: { ping: { canonicalJsonSchema: { type: 'object', additionalProperties: false } } },
	errorSchemas: {},
};

function createMount() {
	const send = vi.fn();
	const sender: InteractivePanelGuestSender = { send };
	return { sender, send };
}

function createScheduler() {
	let now = 0;
	let nextHandle = 1;
	const timers = new Map<number, { readonly dueAt: number; readonly callback: () => void }>();
	const runDue = () => {
		const due = [...timers.entries()]
			.filter(([, timer]) => timer.dueAt <= now)
			.sort(([left], [right]) => left - right);
		for (const [handle, timer] of due) {
			timers.delete(handle);
			timer.callback();
		}
	};
	return {
		now: () => now,
		setTimeout: (callback: () => void, delayMs: number) => {
			const handle = nextHandle;
			nextHandle += 1;
			timers.set(handle, { dueAt: now + delayMs, callback });
			return handle;
		},
		clearTimeout: (handle: number | object) => {
			if (typeof handle === 'number') timers.delete(handle);
		},
		advance: (milliseconds: number) => {
			now += milliseconds;
			runDue();
		},
	};
}

function validPayload() {
	return { payload: [{ state: 'ready' }] };
}

describe('PluginInteractivePanelHost', () => {
	it('routes a declared guest request to only its current owner and correlates the reply', async () => {
		const host = new PluginInteractivePanelHost();
		const first = createMount();
		const mounted = host.mount({
			ownerPluginId: 'com.example.plugin',
			workspaceLocalId: 'workspace',
			panelLocalId: 'panel',
			generation: 1n,
			descriptor,
			sender: first.sender,
		});
		const owner = host.ownerApi('com.example.plugin', 1n);
		let requestId = '';
		owner.onRequest((request) => {
			requestId = request.requestId;
		});

		host.receive(first.sender, 'maestro:panel-request', {
			instanceId: mounted.instanceId,
			requestId: 1,
			kind: 'ping',
			payload: { payload: [{ state: 'ready' }] },
		});
		expect(requestId).not.toBe('');
		await owner.resolve(requestId, 'ping', {});
		expect(first.send).toHaveBeenLastCalledWith('maestro:panel-result', {
			instanceId: mounted.instanceId,
			requestId: 1,
			kind: 'ping',
			payload: {},
		});
	});

	it('rejects wrong senders, stale owners, malformed payloads, and closed mounts', () => {
		const host = new PluginInteractivePanelHost();
		const mountedSender = createMount();
		const wrongSender = createMount();
		const mounted = host.mount({
			ownerPluginId: 'com.example.plugin',
			workspaceLocalId: 'workspace',
			panelLocalId: 'panel',
			generation: 2n,
			descriptor,
			sender: mountedSender.sender,
		});
		const listener = vi.fn();
		host.ownerApi('com.example.plugin', 2n).onRequest(listener);
		host.receive(wrongSender.sender, 'maestro:panel-request', {
			instanceId: mounted.instanceId,
			requestId: 1,
			kind: 'ping',
			payload: {},
		});
		host.receive(mountedSender.sender, 'maestro:panel-request', {
			instanceId: mounted.instanceId,
			requestId: 2,
			kind: 'ping',
			payload: 'not-an-object',
		});
		host.revokeOwner('com.example.plugin');
		host.receive(mountedSender.sender, 'maestro:panel-request', {
			instanceId: mounted.instanceId,
			requestId: 3,
			kind: 'ping',
			payload: {},
		});
		expect(listener).not.toHaveBeenCalled();
	});

	it('rejects nested schema violations before dispatching an owner request', () => {
		const host = new PluginInteractivePanelHost();
		const guest = createMount();
		const mounted = host.mount({
			ownerPluginId: 'com.example.plugin',
			workspaceLocalId: 'workspace',
			panelLocalId: 'panel',
			generation: 3n,
			descriptor,
			sender: guest.sender,
		});
		const listener = vi.fn();
		host.ownerApi('com.example.plugin', 3n).onRequest(listener);

		host.receive(guest.sender, 'maestro:panel-request', {
			instanceId: mounted.instanceId,
			requestId: 1,
			kind: 'ping',
			payload: { payload: [{ state: 'ready', injected: true }] },
		});

		expect(listener).not.toHaveBeenCalled();
		expect(guest.send).toHaveBeenLastCalledWith('maestro:panel-error', {
			instanceId: mounted.instanceId,
			requestId: 1,
			kind: 'ping',
			code: 'invalid_request',
		});
	});

	it('enforces the exact twenty-message ingress rate before dispatch', () => {
		const host = new PluginInteractivePanelHost();
		const guest = createMount();
		const mounted = host.mount({
			ownerPluginId: 'com.example.plugin',
			workspaceLocalId: 'workspace',
			panelLocalId: 'panel',
			generation: 4n,
			descriptor,
			sender: guest.sender,
		});
		const listener = vi.fn();
		host.ownerApi('com.example.plugin', 4n).onRequest(listener);

		for (let requestId = 1; requestId <= 21; requestId += 1) {
			host.receive(guest.sender, 'maestro:panel-request', {
				instanceId: mounted.instanceId,
				requestId,
				kind: 'ping',
				payload: { payload: [{ state: 'ready' }] },
			});
		}

		expect(listener).toHaveBeenCalledTimes(20);
		expect(guest.send).toHaveBeenLastCalledWith('maestro:panel-error', {
			instanceId: mounted.instanceId,
			requestId: 21,
			kind: 'ping',
			code: 'backpressure',
		});
	});

	it('expires a pending request exactly once and ignores a late owner terminal', async () => {
		const scheduler = createScheduler();
		const host = new PluginInteractivePanelHost({ scheduler, requestTimeoutMs: 10 });
		const guest = createMount();
		const mounted = host.mount({
			ownerPluginId: 'com.example.plugin',
			workspaceLocalId: 'workspace',
			panelLocalId: 'panel',
			generation: 5n,
			descriptor,
			sender: guest.sender,
		});
		const owner = host.ownerApi('com.example.plugin', 5n);
		let ownerRequestId = '';
		owner.onRequest((request) => {
			ownerRequestId = request.requestId;
		});
		host.receive(guest.sender, 'maestro:panel-request', {
			instanceId: mounted.instanceId,
			requestId: 1,
			kind: 'ping',
			payload: validPayload(),
		});

		scheduler.advance(9);
		expect(guest.send).not.toHaveBeenCalledWith('maestro:panel-error', expect.anything());
		scheduler.advance(1);
		await owner.resolve(ownerRequestId, 'ping', {});
		const terminals = guest.send.mock.calls.filter(
			([channel]) => channel === 'maestro:panel-error' || channel === 'maestro:panel-result'
		);
		expect(terminals).toEqual([
			[
				'maestro:panel-error',
				{
					instanceId: mounted.instanceId,
					requestId: 1,
					kind: 'ping',
					code: 'timeout',
				},
			],
		]);
	});

	it('ignores duplicate and foreign-generation terminals', async () => {
		const host = new PluginInteractivePanelHost();
		const guest = createMount();
		const mounted = host.mount({
			ownerPluginId: 'com.example.plugin',
			workspaceLocalId: 'workspace',
			panelLocalId: 'panel',
			generation: 6n,
			descriptor,
			sender: guest.sender,
		});
		const currentOwner = host.ownerApi('com.example.plugin', 6n);
		let ownerRequestId = '';
		currentOwner.onRequest((request) => {
			ownerRequestId = request.requestId;
		});
		host.receive(guest.sender, 'maestro:panel-request', {
			instanceId: mounted.instanceId,
			requestId: 1,
			kind: 'ping',
			payload: validPayload(),
		});

		await host.ownerApi('com.example.plugin', 7n).resolve(ownerRequestId, 'ping', {});
		await currentOwner.resolve(ownerRequestId, 'ping', {});
		await currentOwner.reject(ownerRequestId, 'cancelled');
		expect(guest.send.mock.calls.filter(([channel]) => channel !== 'maestro:panel-init')).toEqual([
			[
				'maestro:panel-result',
				{
					instanceId: mounted.instanceId,
					requestId: 1,
					kind: 'ping',
					payload: {},
				},
			],
		]);
	});

	it('coalesces only adjacent delta events and rejects out-of-order event sequences', async () => {
		const scheduler = createScheduler();
		const host = new PluginInteractivePanelHost({ scheduler });
		const guest = createMount();
		const eventDescriptor: InteractivePanelDescriptor = {
			...descriptor,
			eventSchemas: { 'stream.delta': { canonicalJsonSchema: { type: 'object' } } },
		};
		const mounted = host.mount({
			ownerPluginId: 'com.example.plugin',
			workspaceLocalId: 'workspace',
			panelLocalId: 'panel',
			generation: 7n,
			descriptor: eventDescriptor,
			sender: guest.sender,
		});
		host.receive(guest.sender, 'maestro:panel-subscribe', {
			instanceId: mounted.instanceId,
			kind: 'stream.delta',
		});
		const owner = host.ownerApi('com.example.plugin', 7n);
		await owner.emit('stream.delta', { value: 'first' }, 1n);
		await owner.emit('stream.delta', { value: 'last' }, 2n);
		await owner.emit('stream.delta', { value: 'late' }, 1n);
		scheduler.advance(0);

		expect(guest.send.mock.calls.filter(([channel]) => channel === 'maestro:panel-event')).toEqual([
			[
				'maestro:panel-event',
				{
					instanceId: mounted.instanceId,
					kind: 'stream.delta',
					payload: { value: 'last' },
					eventSequence: '2',
				},
			],
		]);
	});

	it('enforces the exact 128-event egress window', async () => {
		const scheduler = createScheduler();
		const host = new PluginInteractivePanelHost({ scheduler });
		const guest = createMount();
		const mounted = host.mount({
			ownerPluginId: 'com.example.plugin',
			workspaceLocalId: 'workspace',
			panelLocalId: 'panel',
			generation: 8n,
			descriptor,
			sender: guest.sender,
		});
		host.receive(guest.sender, 'maestro:panel-subscribe', {
			instanceId: mounted.instanceId,
			kind: 'status',
		});
		const owner = host.ownerApi('com.example.plugin', 8n);
		for (let sequence = 1; sequence <= 129; sequence += 1) {
			await owner.emit('status', { sequence }, BigInt(sequence));
		}
		scheduler.advance(0);
		expect(
			guest.send.mock.calls.filter(([channel]) => channel === 'maestro:panel-event')
		).toHaveLength(128);
	});

	it('revokes an instance after eight violations and frees its pending request', () => {
		const scheduler = createScheduler();
		const host = new PluginInteractivePanelHost({ scheduler, requestTimeoutMs: 10 });
		const guest = createMount();
		const mounted = host.mount({
			ownerPluginId: 'com.example.plugin',
			workspaceLocalId: 'workspace',
			panelLocalId: 'panel',
			generation: 9n,
			descriptor,
			sender: guest.sender,
		});
		const listener = vi.fn();
		host.ownerApi('com.example.plugin', 9n).onRequest(listener);
		host.receive(guest.sender, 'maestro:panel-request', {
			instanceId: mounted.instanceId,
			requestId: 100,
			kind: 'ping',
			payload: validPayload(),
		});
		for (let requestId = 1; requestId <= 8; requestId += 1) {
			host.receive(guest.sender, 'maestro:panel-request', {
				instanceId: mounted.instanceId,
				requestId,
				kind: 'ping',
				payload: { payload: [{ state: 'not-ready' }] },
			});
		}
		host.receive(guest.sender, 'maestro:panel-request', {
			instanceId: mounted.instanceId,
			requestId: 9,
			kind: 'ping',
			payload: validPayload(),
		});
		scheduler.advance(10);
		expect(listener).toHaveBeenCalledTimes(1);
		expect(
			guest.send.mock.calls.filter(([channel]) => channel === 'maestro:panel-error')
		).toHaveLength(8);
	});
	it('stages opaque image resources outside the JSON envelope and consumes exact bytes once', async () => {
		const host = new PluginInteractivePanelHost();
		const guest = createMount();
		const mounted = host.mount({
			ownerPluginId: 'com.example.plugin',
			workspaceLocalId: 'workspace',
			panelLocalId: 'panel',
			generation: 10n,
			descriptor,
			sender: guest.sender,
		});
		for (const mediaType of ['image/png', 'image/jpeg', 'image/webp', 'image/gif']) {
			const bytes = new Uint8Array([1, 2, 3]);
			const ref = host.stageResource(guest.sender, {
				instanceId: mounted.instanceId,
				name: `image.${mediaType.slice(6)}`,
				mediaType,
				bytes,
			});
			expect(ref).toEqual(
				expect.objectContaining({
					name: `image.${mediaType.slice(6)}`,
					mediaType,
					size: 3,
					sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
				})
			);
			expect(ref).not.toHaveProperty('bytes');
			bytes.fill(9);
			const consumed = await host.ownerApi('com.example.plugin', 10n).consumeResource(ref.ref);
			expect([...consumed.bytes]).toEqual([1, 2, 3]);
			await expect(
				host.ownerApi('com.example.plugin', 10n).consumeResource(ref.ref)
			).rejects.toThrow('UnavailablePluginPanelResource');
		}
	});

	it('enforces per-file, per-panel byte overhead, and file-count staging quotas', () => {
		const host = new PluginInteractivePanelHost();
		const guest = createMount();
		const mounted = host.mount({
			ownerPluginId: 'com.example.plugin',
			workspaceLocalId: 'workspace',
			panelLocalId: 'panel',
			generation: 11n,
			descriptor,
			sender: guest.sender,
		});
		expect(() =>
			host.stageResource(guest.sender, {
				instanceId: mounted.instanceId,
				name: 'two-meg.png',
				mediaType: 'image/png',
				bytes: new Uint8Array(2 * 1024 * 1024),
			})
		).not.toThrow();
		expect(() =>
			host.stageResource(guest.sender, {
				instanceId: mounted.instanceId,
				name: 'too-large.png',
				mediaType: 'image/png',
				bytes: new Uint8Array(2 * 1024 * 1024 + 1),
			})
		).toThrow('InvalidPluginPanelResource');

		const countedHost = new PluginInteractivePanelHost();
		const countedGuest = createMount();
		const countedMount = countedHost.mount({
			ownerPluginId: 'com.example.plugin',
			workspaceLocalId: 'workspace-2',
			panelLocalId: 'panel',
			generation: 11n,
			descriptor,
			sender: countedGuest.sender,
		});
		for (let index = 0; index < 8; index += 1) {
			countedHost.stageResource(countedGuest.sender, {
				instanceId: countedMount.instanceId,
				name: `${index}.png`,
				mediaType: 'image/png',
				bytes: new Uint8Array([index]),
			});
		}
		expect(() =>
			countedHost.stageResource(countedGuest.sender, {
				instanceId: countedMount.instanceId,
				name: 'ninth.png',
				mediaType: 'image/png',
				bytes: new Uint8Array([1]),
			})
		).toThrow('PluginPanelResourceQuotaExceeded');
	});

	it('fails closed across senders, owners, generations, expiry, and unmount cleanup', async () => {
		const scheduler = createScheduler();
		const host = new PluginInteractivePanelHost({ scheduler, resourceTtlMs: 10 });
		const guest = createMount();
		const attacker = createMount();
		const mounted = host.mount({
			ownerPluginId: 'com.example.plugin',
			workspaceLocalId: 'workspace',
			panelLocalId: 'panel',
			generation: 12n,
			descriptor,
			sender: guest.sender,
		});
		expect(() =>
			host.stageResource(attacker.sender, {
				instanceId: mounted.instanceId,
				name: 'image.png',
				mediaType: 'image/png',
				bytes: new Uint8Array([1]),
			})
		).toThrow('UnavailablePluginPanelResource');
		const ref = host.stageResource(guest.sender, {
			instanceId: mounted.instanceId,
			name: 'image.png',
			mediaType: 'image/png',
			bytes: new Uint8Array([1]),
		});
		await expect(host.ownerApi('other.plugin', 12n).consumeResource(ref.ref)).rejects.toThrow(
			'UnavailablePluginPanelResource'
		);
		await expect(host.ownerApi('com.example.plugin', 13n).consumeResource(ref.ref)).rejects.toThrow(
			'UnavailablePluginPanelResource'
		);
		// Test-only corruption seam proves the consume-time integrity check and zeroization.
		const hostWithTestSeam = host as unknown as {
			readonly mounts: Map<
				string,
				{ readonly resources: Map<string, { readonly bytes: Uint8Array }> }
			>;
		};
		const privateBytes = hostWithTestSeam.mounts
			.get(mounted.instanceId)
			?.resources.get(ref.ref)?.bytes;
		if (!privateBytes) throw new Error('missing staged resource');
		privateBytes[0] = 2;
		await expect(host.ownerApi('com.example.plugin', 12n).consumeResource(ref.ref)).rejects.toThrow(
			'InvalidPluginPanelResource'
		);
		expect(privateBytes).toEqual(new Uint8Array([0]));
		scheduler.advance(10);
		await expect(host.ownerApi('com.example.plugin', 12n).consumeResource(ref.ref)).rejects.toThrow(
			'UnavailablePluginPanelResource'
		);
		const cleanup = host.stageResource(guest.sender, {
			instanceId: mounted.instanceId,
			name: 'cleanup.png',
			mediaType: 'image/png',
			bytes: new Uint8Array([4]),
		});
		mounted.dispose();
		await expect(
			host.ownerApi('com.example.plugin', 12n).consumeResource(cleanup.ref)
		).rejects.toThrow('UnavailablePluginPanelResource');
	});
});
