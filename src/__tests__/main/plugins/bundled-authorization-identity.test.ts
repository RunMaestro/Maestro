import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AuthorizationStore } from '../../../main/plugins/authorization-ledger';
import { ConsentMinter, ConsentNonceRegistry } from '../../../main/plugins/consent-minter';
import { resolvePluginAuthorizationIdentity } from '../../../main/plugins/plugin-identity';
import {
	PermissionBroker,
	type PluginAuthorizationIdentity,
} from '../../../main/plugins/permission-broker';
import type { PluginExecutionSnapshot } from '../../../main/plugins/plugin-manager';
import type { PluginRecord } from '../../../shared/plugins/plugin-registry';
import type { PermissionGrant } from '../../../shared/plugins/permissions';

const PLUGIN_ID = 'com.maestro.omp';
const SNAPSHOT: PluginExecutionSnapshot = {
	identity: {
		artifactDigest: 'a'.repeat(64),
		authorizationContentHash: 'c'.repeat(64),
		authorizationSignerKey: 'compiled-omp-trust-root',
		signerKeyId: 'omp-release-2026',
	},
	text: () => null,
	release: () => undefined,
};

function bundledRecord(source: string): PluginRecord {
	return {
		id: PLUGIN_ID,
		source,
		manifest: null,
		loadStatus: 'ok',
		enabled: true,
		errors: [],
		installOwner: 'bundle',
		signature: { status: 'trusted', signerKey: SNAPSHOT.identity.authorizationSignerKey },
	};
}

function activation(): PluginAuthorizationIdentity {
	return {
		ownerPluginId: PLUGIN_ID,
		generation: 7,
		artifactDigest: SNAPSHOT.identity.artifactDigest,
		authorizationContentHash: SNAPSHOT.identity.authorizationContentHash,
		authorizationSignerKey: SNAPSHOT.identity.authorizationSignerKey,
		signerKeyId: SNAPSHOT.identity.signerKeyId,
	};
}

function store(directory: string): AuthorizationStore {
	return new AuthorizationStore({
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
}

describe('bundled authorization identity', () => {
	it('mints the immutable bundled identity and authorizes representative host calls after consent', async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-bundled-identity-'));
		try {
			fs.writeFileSync(path.join(directory, 'plugin.json'), JSON.stringify({ id: PLUGIN_ID }));
			const record = bundledRecord(directory);
			const identity = resolvePluginAuthorizationIdentity(record, [], () => SNAPSHOT);
			expect(identity).toEqual({
				contentHash: SNAPSHOT.identity.authorizationContentHash,
				signatureStatus: 'trusted',
				signerKey: SNAPSHOT.identity.authorizationSignerKey,
			});

			const ledger = store(directory);
			const sender = { webContentsId: 1, frameId: 1, url: 'app://consent' };
			let nonce = '';
			const minter = new ConsentMinter({
				registry: new ConsentNonceRegistry({ now: () => 1, newNonce: () => 'nonce', ttlMs: 1000 }),
				store: ledger,
				requested: () => [
					{ capability: 'storage:read' },
					{ capability: 'ui:workspace' },
					{ capability: 'ui:interactivePanel' },
				],
				identityOf: () => identity,
				openPrompt: async ({ nonce: issuedNonce }) => {
					nonce = issuedNonce;
					return sender;
				},
				now: () => 1,
			});
			await minter.requestConsent(PLUGIN_ID);
			expect(
				minter.confirm(sender, {
					pluginId: PLUGIN_ID,
					nonce,
					approved: ['storage:read', 'ui:workspace', 'ui:interactivePanel'],
				}).ok
			).toBe(true);

			const active = activation();
			const broker = new PermissionBroker({
				getGrants: (pluginId): PermissionGrant[] => ledger.readGrants(pluginId),
				getActivationIdentity: (pluginId) => (pluginId === PLUGIN_ID ? active : null),
				getGrantedIdentity: (pluginId) => {
					const granted = ledger.entryIdentity(pluginId);
					return granted
						? { contentHash: granted.contentHash, signerKey: granted.signerKey }
						: null;
				},
			});

			expect(active).toMatchObject({
				ownerPluginId: PLUGIN_ID,
				generation: 7,
				artifactDigest: SNAPSHOT.identity.artifactDigest,
				authorizationContentHash: SNAPSHOT.identity.authorizationContentHash,
				authorizationSignerKey: SNAPSHOT.identity.authorizationSignerKey,
				signerKeyId: SNAPSHOT.identity.signerKeyId,
			});
			expect(ledger.entryIdentity(PLUGIN_ID)).toEqual({
				contentHash: SNAPSHOT.identity.authorizationContentHash,
				signatureStatus: 'trusted',
				signerKey: SNAPSHOT.identity.authorizationSignerKey,
			});
			expect(
				ledger.verify(PLUGIN_ID, identity!, ['storage:read', 'ui:workspace', 'ui:interactivePanel'])
			).toMatchObject({ authorized: true, reason: 'ok' });
			for (const [method, params] of [
				['storage.get', { key: 'a' }],
				['workspace.publishExternalSessions', { sessions: [] }],
				['workspace.setStatus', { status: 'ready' }],
				['interactivePanel.reject', { requestId: 'r', error: 'cancelled' }],
			] as const) {
				expect(broker.authorizeInvocation(active, method, params).allowed).toBe(true);
			}
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});

	it('fails closed when a provided record loses its exact snapshot provenance or owner', () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-bundled-identity-'));
		try {
			fs.writeFileSync(path.join(directory, 'plugin.json'), JSON.stringify({ id: PLUGIN_ID }));
			const record = bundledRecord(directory);
			expect(resolvePluginAuthorizationIdentity(record, [], () => null)).toBeNull();
			expect(
				resolvePluginAuthorizationIdentity(
					{ ...record, installOwner: 'external' },
					[],
					() => SNAPSHOT
				)
			).toBeNull();
			expect(
				resolvePluginAuthorizationIdentity(
					{ ...record, source: path.join(directory, 'wrong') },
					[],
					(candidate) => (candidate.source === directory ? SNAPSHOT : null)
				)
			).toBeNull();
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});
});
