/** Opaque confirmed records and native secret references, confined to one installation/plugin. */
import { randomBytes } from 'node:crypto';
import {
	pluginEndpointScope,
	PLUGIN_RECORD_KEY_PATTERN,
	type PluginEndpoint,
} from '../../shared/plugins/primitives';
import type { PluginCapability } from '../../shared/plugins/permissions';
import { createKeyringEntry, type KeyringEntry } from '../utils/keyring-anchor';
import type { AuthorizationStore, AuthIdentity } from './authorization-ledger';
import type { PluginToolRunIdentity } from './plugin-tool-run-identity';
import type { PluginPrimitiveLifetime } from './plugin-tls';
import type { PluginConfirmation } from './plugin-confirmation-window';
import {
	PluginAuthorityError,
	assertPluginAuthority,
	pluginJson,
	pluginRequest,
} from './plugin-authority';

export interface PluginPrivateStateDeps {
	store: AuthorizationStore;
	identity: PluginToolRunIdentity;
	confirmation: PluginConfirmation;
	identityFor(pluginId: string): AuthIdentity;
	capture(pluginId: string): PluginPrimitiveLifetime;
	assertAllowed(pluginId: string, capability: PluginCapability, target: string): void;
	assertDeclared?(pluginId: string, capability: PluginCapability): void;
	stopTls?(pluginId: string): Promise<void>;
	entry?: (service: string, account: string) => KeyringEntry | null;
}
export class PluginPrivateState {
	constructor(private readonly deps: PluginPrivateStateDeps) {}
	private check(
		pluginId: string,
		identity: AuthIdentity,
		lifetime: PluginPrimitiveLifetime,
		cap: PluginCapability,
		target: string
	): void {
		assertPluginAuthority(lifetime.assertActive);
		if (lifetime.signal.aborted) throw new PluginAuthorityError('PLUGIN_CANCELED');
		assertPluginAuthority(() => this.deps.assertAllowed(pluginId, cap, target));
		this.deps.store.assertPluginPersistent(pluginId, identity);
		assertPluginAuthority(lifetime.assertActive);
	}
	async read(pluginId: string, params: unknown) {
		const p = pluginRequest(params, ['key']);
		if (typeof p.key !== 'string' || !PLUGIN_RECORD_KEY_PATTERN.test(p.key))
			throw new PluginAuthorityError('PLUGIN_INVALID');
		const identity = this.deps.identityFor(pluginId),
			lifetime = this.deps.capture(pluginId);
		await lifetime.prepare();
		this.check(pluginId, identity, lifetime, 'records:read', p.key);
		const result = this.deps.store.readPluginRecord(pluginId, identity, p.key);
		this.check(pluginId, identity, lifetime, 'records:read', p.key);
		return result;
	}
	async commit(pluginId: string, params: unknown): Promise<{ revision: number }> {
		const p = pluginRequest(params, ['key', 'expectedRevision', 'value', 'summary']);
		if (
			typeof p.key !== 'string' ||
			!PLUGIN_RECORD_KEY_PATTERN.test(p.key) ||
			typeof p.summary !== 'string' ||
			!p.summary.length ||
			p.summary.length > 240 ||
			/[\x00-\x1f\x7f]/.test(p.summary) ||
			!Number.isSafeInteger(p.expectedRevision) ||
			(p.expectedRevision as number) < 0 ||
			(p.expectedRevision as number) >= Number.MAX_SAFE_INTEGER
		)
			throw new PluginAuthorityError('PLUGIN_INVALID');
		const key = p.key,
			revision = p.expectedRevision as number,
			value = pluginJson(p.value, 64 * 1024);
		const identity = this.deps.identityFor(pluginId),
			lifetime = this.deps.capture(pluginId);
		const check = () => this.check(pluginId, identity, lifetime, 'records:confirm', key);
		await lifetime.prepare();
		check();
		if ((this.deps.store.readPluginRecord(pluginId, identity, key)?.revision ?? 0) !== revision)
			throw new PluginAuthorityError('PLUGIN_CONFLICT');
		const result = await this.deps.confirmation.confirm(
			{
				kind: 'record',
				pluginId,
				key,
				summary: p.summary,
				value: { expectedRevision: revision, nextRevision: revision + 1, value },
			},
			lifetime.signal,
			check,
			() => {
				check();
				const committed = this.deps.store.commitPluginRecord(
					pluginId,
					identity,
					key,
					revision,
					value,
					check
				);
				// Conservative revocation: the host cannot interpret which opaque rights changed.
				this.deps.identity.revokePlugin(pluginId);
				check();
				return { revision: committed };
			},
			() => lifetime.prepare()
		);
		await lifetime.prepare();
		check();
		return result;
	}

	async setupSecret(pluginId: string, params: unknown): Promise<{ secretRef: string }> {
		const p = pluginRequest(params, ['key', 'label', 'endpoint']);
		const endpoint = pluginRequest(p.endpoint, ['host', 'port']);
		const scope = pluginEndpointScope(endpoint.host, endpoint.port);
		if (
			typeof p.key !== 'string' ||
			!PLUGIN_RECORD_KEY_PATTERN.test(p.key) ||
			typeof p.label !== 'string' ||
			!p.label.length ||
			p.label.length > 120 ||
			/[\x00-\x1f\x7f]/.test(p.label) ||
			!scope
		)
			throw new PluginAuthorityError('PLUGIN_INVALID');
		const key = p.key,
			identity = this.deps.identityFor(pluginId),
			lifetime = this.deps.capture(pluginId);
		const check = () => this.check(pluginId, identity, lifetime, 'secrets:use', scope);
		await lifetime.prepare();
		check();
		let entry: KeyringEntry | null = null;
		try {
			const result = await this.deps.confirmation.confirm(
				{
					kind: 'secret',
					pluginId,
					key,
					summary: p.label,
					value: {
						endpoint: { host: endpoint.host as string, port: endpoint.port as number },
						encoding: 'quoted-ascii',
					},
				},
				lifetime.signal,
				check,
				(password) => {
					check();
					if (typeof password !== 'string' || !/^[\x20-\x7e]{1,4096}$/.test(password))
						throw new PluginAuthorityError('PLUGIN_INVALID');
					const ref = randomBytes(32).toString('hex');
					const slot = this.deps.store.pluginSecretSlot(pluginId, identity, ref);
					try {
						// Quota and durable cleanup provenance must precede even a partial native write.
						this.deps.store.registerPluginSecret(pluginId, identity, key, scope, ref, check);
						check();
						entry = (this.deps.entry ?? createKeyringEntry)('com.maestro.plugin-secrets', slot);
						check();
						if (!entry) throw new PluginAuthorityError('PLUGIN_UNAVAILABLE');
						entry.setPassword(password);
						check();
						if (entry.getPassword() !== password)
							throw new PluginAuthorityError('PLUGIN_UNAVAILABLE');
						check();
						return { secretRef: ref };
					} finally {
						password = undefined;
					}
				},
				() => lifetime.prepare()
			);
			check();
			// Confirmation itself can await/reject after its native commit callback.
			this.deps.store.setPluginSecretState(pluginId, identity, result.secretRef, 'active', check);
			check();
			return result;
		} catch (error) {
			try {
				if (entry) {
					(entry as KeyringEntry).deletePassword();
					if ((entry as KeyringEntry).getPassword() !== null)
						throw new PluginAuthorityError('PLUGIN_UNAVAILABLE');
				}
			} catch {
				// The sealed pending reservation survives failure/revoke for exact-slot uninstall retry.
			}
			throw error instanceof PluginAuthorityError
				? error
				: new PluginAuthorityError('PLUGIN_UNAVAILABLE');
		}
	}

	async requestEndpoint(pluginId: string, params: unknown): Promise<{ granted: true }> {
		const p = pluginRequest(params, ['host', 'port', 'secret']);
		const endpoint = pluginEndpointScope(p.host, p.port);
		if (!endpoint || typeof p.secret !== 'boolean' || !this.deps.assertDeclared)
			throw new PluginAuthorityError('PLUGIN_INVALID');
		const identity = this.deps.identityFor(pluginId),
			lifetime = this.deps.capture(pluginId);
		const caps: PluginCapability[] = p.secret ? ['net:tls', 'secrets:use'] : ['net:tls'];
		const check = () => {
			lifetime.assertActive();
			this.deps.store.assertPluginPersistent(pluginId, identity);
			for (const cap of caps) {
				this.deps.assertDeclared!(pluginId, cap);
				if (!this.deps.store.readGrants(pluginId).some((g) => g.capability === cap))
					throw new PluginAuthorityError('PLUGIN_DENIED');
			}
		};
		await lifetime.prepare();
		check();
		const result = await this.deps.confirmation.confirm(
			{
				kind: 'record',
				pluginId,
				key: 'endpoint-consent',
				summary: 'Authorize this exact endpoint for the trusted plugin',
				value: { endpoint, capabilities: caps },
			},
			lifetime.signal,
			check,
			() => {
				check();
				this.deps.store.extendPluginEndpoint(
					pluginId,
					identity,
					endpoint,
					p.secret as boolean,
					check
				);
				this.deps.identity.revokePlugin(pluginId);
				check();
				return { granted: true as const };
			},
			() => lifetime.prepare()
		);
		await lifetime.prepare();
		check();
		return result;
	}
	async removeSecret(pluginId: string, params: unknown): Promise<{ removed: true }> {
		const p = pluginRequest(params, ['secretRef']);
		if (
			typeof p.secretRef !== 'string' ||
			!/^[0-9a-f]{64}$/.test(p.secretRef) ||
			!this.deps.stopTls
		)
			throw new PluginAuthorityError('PLUGIN_INVALID');
		const ref = p.secretRef,
			identity = this.deps.identityFor(pluginId),
			lifetime = this.deps.capture(pluginId);
		const prior = this.deps.store.pluginSecretRemoval(pluginId, identity, ref);
		const check = () => this.check(pluginId, identity, lifetime, 'secrets:use', prior.endpoint);
		await lifetime.prepare();
		check();
		if (prior.removal === 'removed') return { removed: true };
		this.deps.store.setPluginSecretState(pluginId, identity, ref, 'pending', check);
		this.deps.identity.revokePlugin(pluginId);
		await this.deps.stopTls(pluginId);
		await lifetime.prepare();
		check();
		try {
			const slot = this.deps.store.pluginSecretSlot(pluginId, identity, ref);
			const entry = (this.deps.entry ?? createKeyringEntry)('com.maestro.plugin-secrets', slot);
			check();
			if (!entry) throw new PluginAuthorityError('PLUGIN_UNAVAILABLE');
			entry.deletePassword();
			check();
			if (entry.getPassword() !== null) throw new PluginAuthorityError('PLUGIN_UNAVAILABLE');
			check();
			this.deps.store.setPluginSecretState(pluginId, identity, ref, 'removed', check);
			return { removed: true };
		} catch (error) {
			throw error instanceof PluginAuthorityError
				? error
				: new PluginAuthorityError('PLUGIN_UNAVAILABLE');
		}
	}

	/** Called only after the host has stopped/drained the sandbox and tombstoned it. */
	purgePlugin(pluginId: string): void {
		this.deps.store.purgePluginPrivateState(pluginId, (slot) => {
			try {
				const entry = (this.deps.entry ?? createKeyringEntry)('com.maestro.plugin-secrets', slot);
				if (!entry) throw new PluginAuthorityError('PLUGIN_UNAVAILABLE');
				entry.deletePassword();
				if (entry.getPassword() !== null) throw new PluginAuthorityError('PLUGIN_UNAVAILABLE');
			} catch (error) {
				throw error instanceof PluginAuthorityError
					? error
					: new PluginAuthorityError('PLUGIN_UNAVAILABLE');
			}
		});
	}

	/** Host transport only. Encoded bytes never cross the sandbox boundary as a return value. */
	encodeSecret(
		pluginId: string,
		endpoint: PluginEndpoint,
		ref: string,
		transportCheck: () => void
	): Buffer {
		const scope = pluginEndpointScope(endpoint.host, endpoint.port);
		if (!scope || !/^[0-9a-f]{64}$/.test(ref)) throw new PluginAuthorityError('PLUGIN_INVALID');
		const identity = this.deps.identityFor(pluginId),
			lifetime = this.deps.capture(pluginId);
		const check = () => {
			assertPluginAuthority(transportCheck);
			this.check(pluginId, identity, lifetime, 'secrets:use', scope);
			this.deps.store.assertPluginSecret(pluginId, identity, ref, scope);
			assertPluginAuthority(transportCheck);
		};
		let secret: Buffer | undefined, encoded: Buffer | undefined;
		try {
			check();
			const slot = this.deps.store.pluginSecretSlot(pluginId, identity, ref);
			const entry = (this.deps.entry ?? createKeyringEntry)('com.maestro.plugin-secrets', slot);
			check();
			if (!entry) throw new PluginAuthorityError('PLUGIN_UNAVAILABLE');
			let value = entry.getPassword();
			check();
			if (typeof value !== 'string' || !/^[\x20-\x7e]{1,4096}$/.test(value))
				throw new PluginAuthorityError('PLUGIN_DENIED');
			secret = Buffer.from(value, 'ascii');
			value = null;
			let escapes = 0;
			for (const byte of secret) if (byte === 34 || byte === 92) escapes++;
			encoded = Buffer.alloc(secret.length + escapes + 2);
			let offset = 0;
			encoded[offset++] = 34;
			for (const byte of secret) {
				if (byte === 34 || byte === 92) encoded[offset++] = 92;
				encoded[offset++] = byte;
			}
			encoded[offset] = 34;
			check();
			const result = encoded;
			encoded = undefined;
			return result;
		} catch (error) {
			throw error instanceof PluginAuthorityError
				? error
				: new PluginAuthorityError('PLUGIN_UNAVAILABLE');
		} finally {
			secret?.fill(0);
			encoded?.fill(0);
		}
	}
}
