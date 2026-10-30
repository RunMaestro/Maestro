/** Composition of the narrow JSON platform seams; all provenance stays in main. */
import type { HostMethod } from '../../shared/plugins/rpc-protocol';
import { PluginAuthorityError, pluginRequest } from './plugin-authority';
import type { PluginToolRunIdentity } from './plugin-tool-run-identity';
import type { PluginPrivateState } from './plugin-private-state';
import type { PluginTlsHost, PluginPrimitiveLifetime } from './plugin-tls';
import type { PluginCueEvents } from './plugin-cue-events';

export const PLUGIN_PRIMITIVE_METHODS: readonly HostMethod[] = [
	'net.requestTlsConsent',
	'secrets.remove',
	'invocations.inspect',
	'net.tlsOpen',
	'net.tlsRead',
	'net.tlsWrite',
	'net.tlsClose',
	'secrets.requestSetup',
	'records.read',
	'records.requestCommit',
	'events.consumers',
	'events.begin',
	'events.publish',
];
export class PluginPrimitives {
	constructor(
		private readonly deps: {
			identity: PluginToolRunIdentity;
			state: PluginPrivateState;
			tls: PluginTlsHost;
			events: PluginCueEvents;
			capture(pluginId: string): PluginPrimitiveLifetime;
		}
	) {}
	async call(
		pluginId: string,
		method: HostMethod,
		params: unknown,
		guard?: (check: () => void) => void
	): Promise<unknown> {
		// Release confers no new authority; TLS checks the exact owning child generation.
		if (method === 'net.tlsClose') return this.deps.tls.close(pluginId, params);
		const lifetime = this.deps.capture(pluginId);
		let openedStream: string | undefined;
		let begunInvocation: string | undefined;
		const check = () => {
			lifetime.assertActive();
			if (lifetime.signal.aborted) throw new PluginAuthorityError('PLUGIN_CANCELED');
			if (
				[
					'invocations.inspect',
					'net.tlsOpen',
					'net.tlsRead',
					'net.tlsWrite',
					'events.publish',
				].includes(method)
			) {
				const p = params as Record<string, unknown>;
				this.deps.identity.resolveInvocation(pluginId, p?.invocationId).assertActive();
			}
			if (['net.tlsOpen', 'net.tlsRead', 'net.tlsWrite'].includes(method)) {
				const p = params as Record<string, unknown>;
				const streamId = method === 'net.tlsOpen' ? openedStream : p?.streamId;
				if (streamId !== undefined) this.deps.tls.assertResult(pluginId, streamId, p?.invocationId);
			}
			if (method === 'events.publish')
				this.deps.events.assertInvocation(
					pluginId,
					(params as Record<string, unknown>)?.invocationId
				);
			if (begunInvocation) this.deps.events.assertInvocation(pluginId, begunInvocation);
		};
		await lifetime.prepare();
		check();
		guard?.(check);
		switch (method) {
			case 'net.requestTlsConsent':
				return this.deps.state.requestEndpoint(pluginId, params);
			case 'secrets.remove':
				return this.deps.state.removeSecret(pluginId, params);
			case 'invocations.inspect': {
				const p = pluginRequest(params, ['invocationId']);
				return {
					callerAgentId: this.deps.identity.resolveInvocation(pluginId, p.invocationId)
						.callerAgentId,
					active: true,
				};
			}
			case 'net.tlsOpen': {
				const result = await this.deps.tls.open(pluginId, params);
				openedStream = result.streamId;
				await lifetime.prepare();
				check();
				return result;
			}
			case 'net.tlsRead':
				return this.deps.tls.read(pluginId, params);
			case 'net.tlsWrite':
				return this.deps.tls.write(pluginId, params);
			case 'secrets.requestSetup':
				return this.deps.state.setupSecret(pluginId, params);
			case 'records.read':
				return this.deps.state.read(pluginId, params);
			case 'records.requestCommit':
				return this.deps.state.commit(pluginId, params);
			case 'events.consumers':
				return this.deps.events.list(pluginId, params);
			case 'events.begin': {
				const result = this.deps.events.begin(pluginId, params);
				begunInvocation = result.invocationId;
				await lifetime.prepare();
				check();
				return result;
			}
			case 'events.publish':
				return this.deps.events.publish(pluginId, params);
			default:
				throw new PluginAuthorityError('PLUGIN_DENIED');
		}
	}
	async cleanupPlugin(pluginId: string): Promise<void> {
		this.deps.identity.revokePlugin(pluginId);
		this.deps.events.stopPlugin(pluginId);
		await this.deps.tls.stopPlugin(pluginId);
	}
}
