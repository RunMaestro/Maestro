import { describe, expect, it, vi } from 'vitest';
import {
	PluginInteractivePanelHost,
	type InteractivePanelDescriptor,
	type InteractivePanelGuestSender,
} from '../../../main/plugins/plugin-interactive-panel-host';

const descriptor: InteractivePanelDescriptor = {
	requestSchemas: { ping: { canonicalJsonSchema: { type: 'object' } } },
	eventSchemas: { status: { canonicalJsonSchema: { type: 'object' } } },
	resultSchemas: {},
	errorSchemas: {},
};

function createMount() {
	const send = vi.fn();
	const sender: InteractivePanelGuestSender = { send };
	return { sender, send };
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
			payload: {},
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
});
