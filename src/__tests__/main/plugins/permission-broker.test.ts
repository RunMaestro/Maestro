import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	PermissionBroker,
	type PluginAuthorizationIdentity,
} from '../../../main/plugins/permission-broker';
import type { PermissionGrant } from '../../../shared/plugins/permissions';
import { AuthorizationStore } from '../../../main/plugins/authorization-ledger';
import { ConsentMinter, ConsentNonceRegistry } from '../../../main/plugins/consent-minter';
import { pluginIdentity } from '../../../main/plugins/plugin-identity';
import { captureVerifiedPluginSnapshot } from '../../../main/plugins/plugin-signature';
import { makeSigningKeys, signPluginDir } from './plugin-signing-helper';

function grant(capability: string, scope?: string): PermissionGrant {
	return { capability, ...(scope ? { scope } : {}), grantedAt: 1 } as PermissionGrant;
}

function identity(
	overrides: Partial<PluginAuthorizationIdentity> = {}
): PluginAuthorizationIdentity {
	return {
		ownerPluginId: 'p',
		generation: 1,
		artifactDigest: 'a'.repeat(64),
		authorizationContentHash: 'c'.repeat(64),
		authorizationSignerKey: 'trusted-authorization-signer',
		signerKeyId: 'trusted-signer',
		...overrides,
	};
}

describe('PermissionBroker', () => {
	it('denies by default when the plugin has no grants', () => {
		const broker = new PermissionBroker({ getGrants: () => [] });
		const d = broker.authorize('p', 'fs.read', { path: '/x' });
		expect(d.allowed).toBe(false);
		expect(d.capability).toBe('fs:read');
		expect(d.reason).toMatch(/permission denied/);
	});

	it('allows a scoped fs.read inside the granted path', () => {
		const broker = new PermissionBroker({ getGrants: () => [grant('fs:read', '/data')] });
		expect(broker.authorize('p', 'fs.read', { path: '/data/x' }).allowed).toBe(true);
		expect(broker.authorize('p', 'fs.read', { path: '/etc/x' }).allowed).toBe(false);
	});

	it('maps net.fetch to net:fetch and checks host scope', () => {
		const broker = new PermissionBroker({ getGrants: () => [grant('net:fetch', 'example.com')] });
		expect(broker.authorize('p', 'net.fetch', { url: 'https://api.example.com' }).allowed).toBe(
			true
		);
		expect(broker.authorize('p', 'net.fetch', { url: 'https://evil.com' }).allowed).toBe(false);
	});

	it('maps net.connect to net:connect and checks host scope', () => {
		const broker = new PermissionBroker({
			getGrants: () => [grant('net:connect', 'gateway.discord.gg')],
		});
		expect(
			broker.authorize('p', 'net.connect', { url: 'wss://gateway.discord.gg/?v=10' }).allowed
		).toBe(true);
		expect(broker.authorize('p', 'net.connect', { url: 'wss://evil.example' }).allowed).toBe(false);
	});

	it('allows net.send/net.close on a SCOPED net:connect grant (handler re-authorizes the socket URL)', () => {
		// These methods carry only a socketId, so extractTarget yields no host. The
		// broker must not reject a scoped grant for a missing target - it confirms
		// the capability is held and the handler re-checks the stored socket origin.
		const broker = new PermissionBroker({
			getGrants: () => [grant('net:connect', 'gateway.discord.gg')],
		});
		expect(broker.authorize('p', 'net.send', { socketId: 's', data: 'hi' }).allowed).toBe(true);
		expect(broker.authorize('p', 'net.close', { socketId: 's' }).allowed).toBe(true);
	});

	it('denies net.send/net.close when the plugin holds no net:connect grant at all', () => {
		const broker = new PermissionBroker({ getGrants: () => [grant('net:fetch', 'example.com')] });
		expect(broker.authorize('p', 'net.send', { socketId: 's', data: 'hi' }).allowed).toBe(false);
		expect(broker.authorize('p', 'net.close', { socketId: 's' }).allowed).toBe(false);
	});

	it('re-reads grants on each call (live revocation)', () => {
		let grants: PermissionGrant[] = [grant('notifications:toast')];
		const broker = new PermissionBroker({ getGrants: () => grants });
		expect(broker.authorize('p', 'notifications.toast', {}).allowed).toBe(true);
		grants = [];
		expect(broker.authorize('p', 'notifications.toast', {}).allowed).toBe(false);
	});

	it('audits every decision', () => {
		const onDecision = vi.fn();
		const broker = new PermissionBroker({ getGrants: () => [], onDecision });
		broker.authorize('p', 'process.spawn', { command: 'ls' });
		expect(onDecision).toHaveBeenCalledWith(
			'p',
			'process.spawn',
			expect.objectContaining({ allowed: false, capability: 'process:spawn' })
		);
	});

	it('per-plugin isolation: grants for one plugin do not leak to another', () => {
		const broker = new PermissionBroker({
			getGrants: (id) => (id === 'trusted' ? [grant('fs:read')] : []),
		});
		expect(broker.authorize('trusted', 'fs.read', { path: '/x' }).allowed).toBe(true);
		expect(broker.authorize('other', 'fs.read', { path: '/x' }).allowed).toBe(false);
	});

	it('authorizes an exact verified snapshot after real consent despite distinct artifact and content digests', async () => {
		const pluginId = 'com.example.signed';
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-broker-identity-'));
		const signingKeys = makeSigningKeys();
		try {
			fs.writeFileSync(
				path.join(directory, 'plugin.json'),
				JSON.stringify({
					id: pluginId,
					name: 'Signed',
					version: '1.0.0',
					tier: 1,
					maestro: { minHostApi: '1.0.0' },
					entry: 'main.js',
					permissions: [{ capability: 'notifications:toast' }],
				})
			);
			fs.writeFileSync(path.join(directory, 'main.js'), 'module.exports = {};');
			signPluginDir(directory, signingKeys);

			const current = pluginIdentity(directory, [signingKeys.publicKeyB64]);
			const snapshot = captureVerifiedPluginSnapshot(directory, [signingKeys.publicKeyB64], pluginId);
			expect(current).not.toBeNull();
			expect(snapshot).not.toBeNull();
			expect(snapshot?.identity.authorizationContentHash).toBe(current?.contentHash);
			expect(snapshot?.identity.artifactDigest).not.toBe(current?.contentHash);
			expect(snapshot?.identity.authorizationSignerKey).toBe(current?.signerKey);

			const store = new AuthorizationStore({
				seal: {
					available: () => true,
					seal: (plaintext) => Buffer.from(plaintext, 'utf8'),
					unseal: (blob) => blob.toString('utf8'),
				},
				anchor: {
					available: () => false,
					read: () => null,
					write: () => undefined,
					clear: () => undefined,
				},
				ledgerPath: path.join(directory, 'authorization-ledger'),
				now: () => 1,
				newSecret: () => 'test-secret',
			});
			const sender = { webContentsId: 1, frameId: 1, url: 'app://consent' };
			let nonce = '';
			const minter = new ConsentMinter({
				registry: new ConsentNonceRegistry({ now: () => 1, newNonce: () => 'nonce', ttlMs: 1000 }),
				store,
				requested: () => [{ capability: 'notifications:toast' }],
				identityOf: () => current,
				openPrompt: async ({ nonce: issuedNonce }) => {
					nonce = issuedNonce;
					return sender;
				},
				now: () => 1,
			});
			await minter.requestConsent(pluginId);
			expect(
				minter.confirm(sender, {
					pluginId,
					nonce,
					approved: ['notifications:toast'],
				}).ok
			).toBe(true);

			const activation: PluginAuthorizationIdentity = {
				ownerPluginId: pluginId,
				generation: 1,
				artifactDigest: snapshot!.identity.artifactDigest,
				authorizationContentHash: snapshot!.identity.authorizationContentHash,
				authorizationSignerKey: snapshot!.identity.authorizationSignerKey,
				signerKeyId: snapshot!.identity.signerKeyId,
			};
			const broker = new PermissionBroker({
				getGrants: (id) => store.readGrants(id),
				getActivationIdentity: (id) => (id === pluginId ? activation : null),
				getGrantedIdentity: (id) => {
					const granted = store.entryIdentity(id);
					return granted ? { contentHash: granted.contentHash, signerKey: granted.signerKey } : null;
				},
			});

			expect(broker.authorizeInvocation(activation, 'notifications.toast', {}).allowed).toBe(true);
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});

	it('rejects stale or forged snapshot provenance before consulting grants', () => {
		const current = identity();
		const broker = new PermissionBroker({
			getGrants: () => [grant('notifications:toast')],
			getActivationIdentity: (pluginId) => (pluginId === 'p' ? current : null),
			getGrantedIdentity: (pluginId) =>
				pluginId === 'p'
					? {
							contentHash: current.authorizationContentHash,
							signerKey: current.authorizationSignerKey,
						}
					: null,
		});

		expect(broker.authorizeInvocation(current, 'notifications.toast', {}).allowed).toBe(true);
		expect(
			broker.authorizeInvocation(
				identity({ artifactDigest: 'b'.repeat(64) }),
				'notifications.toast',
				{}
			).allowed
		).toBe(false);
		expect(
			broker.authorizeInvocation(
				identity({ authorizationContentHash: 'd'.repeat(64) }),
				'notifications.toast',
				{}
			).allowed
		).toBe(false);
		expect(
			broker.authorizeInvocation(identity({ signerKeyId: 'forged' }), 'notifications.toast', {})
				.allowed
		).toBe(false);
		expect(
			broker.authorizeInvocation(
				identity({ authorizationSignerKey: 'forged-authorization-signer' }),
				'notifications.toast',
				{}
			).allowed
		).toBe(false);
		expect(
			broker.authorizeInvocation(identity({ generation: 2 }), 'notifications.toast', {}).allowed
		).toBe(false);
	});
});
