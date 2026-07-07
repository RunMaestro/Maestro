/**
 * @file plugin-identity.test.ts
 * @description Tests for `pluginIdentity` — the single place that maps an installed
 * plugin directory to the `AuthIdentity` (content digest + signature status + signer
 * key) the authorization ledger mints against and the refresh verifier compares.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { generateKeyPairSync, createHash, sign as cryptoSign, type KeyObject } from 'crypto';
import { pluginIdentity } from '../../../main/plugins/plugin-identity';
import { computePluginContentHash } from '../../../main/plugins/plugin-signature';
import { buildSigningPayload, SIGNATURE_FILENAME } from '../../../shared/plugins/signing';

function sha256(buf: Buffer): string {
	return createHash('sha256').update(buf).digest('hex');
}

/** Write a signature.json over the current files in `dir` using `privateKey`. */
function signDir(dir: string, publicKeyB64: string, privateKey: KeyObject): void {
	const files: Record<string, string> = {};
	for (const name of fs.readdirSync(dir)) {
		if (name === SIGNATURE_FILENAME) continue;
		files[name] = sha256(fs.readFileSync(path.join(dir, name)));
	}
	const payload = buildSigningPayload(files);
	const signature = cryptoSign(null, Buffer.from(payload, 'utf-8'), privateKey).toString('base64');
	fs.writeFileSync(
		path.join(dir, SIGNATURE_FILENAME),
		JSON.stringify({ algorithm: 'ed25519', publicKey: publicKeyB64, signature, files })
	);
}

describe('pluginIdentity', () => {
	let dir: string;
	const { publicKey, privateKey } = generateKeyPairSync('ed25519');
	const publicKeyB64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-identity-'));
		fs.writeFileSync(path.join(dir, 'plugin.json'), '{"id":"com.a","name":"A"}');
		fs.writeFileSync(path.join(dir, 'entry.js'), 'module.exports = {}');
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('reports unsigned with a stable content hash and no signer', () => {
		const id = pluginIdentity(dir, []);
		expect(id).not.toBeNull();
		expect(id!.signatureStatus).toBe('unsigned');
		expect(id!.signerKey).toBeNull();
		expect(id!.contentHash).toMatch(/^[0-9a-f]{64}$/);
	});

	it('reports trusted with the signer key when signed by a trusted publisher', () => {
		signDir(dir, publicKeyB64, privateKey);
		const id = pluginIdentity(dir, [publicKeyB64]);
		expect(id!.signatureStatus).toBe('trusted');
		expect(id!.signerKey).toBe(publicKeyB64);
	});

	it('reports untrusted when the signature verifies but the key is unknown', () => {
		signDir(dir, publicKeyB64, privateKey);
		const id = pluginIdentity(dir, []); // signer key not in the trusted set
		expect(id!.signatureStatus).toBe('untrusted');
		expect(id!.signerKey).toBe(publicKeyB64);
	});

	it('binds a content hash that excludes signature.json (signing does not move it)', () => {
		const before = computePluginContentHash(dir);
		signDir(dir, publicKeyB64, privateKey);
		const after = pluginIdentity(dir, [publicKeyB64])!.contentHash;
		expect(after).toBe(before); // re-signing/key change never changes the digest
	});

	it('returns null for an unhashable directory (cannot establish identity)', () => {
		expect(pluginIdentity(path.join(dir, 'does-not-exist'), [])).toBeNull();
	});
});
