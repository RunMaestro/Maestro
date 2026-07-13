import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { generateKeyPairSync, createHash, sign as cryptoSign } from 'crypto';
import {
	captureVerifiedPluginSnapshot,
	verifyPluginSignature,
	computePluginContentHash,
} from '../../../main/plugins/plugin-signature';
import { buildSigningPayload, SIGNATURE_FILENAME } from '../../../shared/plugins/signing';

function sha256(buf: Buffer): string {
	return createHash('sha256').update(buf).digest('hex');
}

/** Write a signature.json over the current files in `dir` using `privateKey`. */
function signDir(
	dir: string,
	publicKeyB64: string,
	privateKey: ReturnType<typeof generateKeyPairSync>['privateKey']
): void {
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

describe('verifyPluginSignature', () => {
	let dir: string;
	const { publicKey, privateKey } = generateKeyPairSync('ed25519');
	const publicKeyB64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-sig-'));
		fs.writeFileSync(path.join(dir, 'plugin.json'), '{"id":"com.a","name":"A"}');
		fs.writeFileSync(path.join(dir, 'entry.js'), 'module.exports = {}');
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('reports unsigned when no signature.json exists', () => {
		expect(verifyPluginSignature(dir, []).status).toBe('unsigned');
	});

	it('reports trusted for a valid signature from a trusted key', () => {
		signDir(dir, publicKeyB64, privateKey);
		const check = verifyPluginSignature(dir, [publicKeyB64]);
		expect(check.status).toBe('trusted');
		expect(check.signerKey).toBe(publicKeyB64);
	});

	it('captures verified execution bytes that survive a post-verification file swap', () => {
		signDir(dir, publicKeyB64, privateKey);
		const snapshot = captureVerifiedPluginSnapshot(dir, [publicKeyB64]);
		expect(snapshot?.identity.authorizationSignerKey).toBe(publicKeyB64);
		expect(snapshot?.identity.signerKeyId).toBe(publicKeyB64);

		fs.writeFileSync(path.join(dir, 'entry.js'), 'module.exports = { attacker: true }');
		expect(snapshot?.text('entry.js')).toBe('module.exports = {}');
		snapshot?.release();
		expect(snapshot?.text('entry.js')).toBeNull();
	});

	it('derives authorization content identity from captured verified bytes, not signature metadata', () => {
		signDir(dir, publicKeyB64, privateKey);
		const snapshot = captureVerifiedPluginSnapshot(dir, [publicKeyB64]);

		expect(snapshot).not.toBeNull();
		expect(snapshot?.identity.authorizationContentHash).toBe(computePluginContentHash(dir));
		expect(snapshot?.identity.authorizationContentHash).not.toBe(snapshot?.identity.artifactDigest);
	});

	it('reports untrusted for a valid signature from an unknown key', () => {
		signDir(dir, publicKeyB64, privateKey);
		expect(verifyPluginSignature(dir, []).status).toBe('untrusted');
	});

	it('reports invalid when a file is modified after signing', () => {
		signDir(dir, publicKeyB64, privateKey);
		fs.writeFileSync(path.join(dir, 'entry.js'), 'module.exports = { evil: true }');
		const check = verifyPluginSignature(dir, [publicKeyB64]);
		expect(check.status).toBe('invalid');
	});

	it('reports invalid when an unlisted file is ADDED after signing', () => {
		signDir(dir, publicKeyB64, privateKey);
		fs.writeFileSync(path.join(dir, 'sneaky.js'), 'module.exports = {}');
		expect(verifyPluginSignature(dir, [publicKeyB64]).status).toBe('invalid');
	});

	it('reports invalid when a file is removed after signing', () => {
		signDir(dir, publicKeyB64, privateKey);
		fs.rmSync(path.join(dir, 'entry.js'));
		expect(verifyPluginSignature(dir, [publicKeyB64]).status).toBe('invalid');
	});

	it('reports invalid when the tree contains a symlink (cannot be signed safely)', () => {
		signDir(dir, publicKeyB64, privateKey);
		// Add a symlink AFTER signing; it is not in the signed set and must fail.
		try {
			fs.symlinkSync(os.tmpdir(), path.join(dir, 'link'));
		} catch {
			// Some CI/Windows environments forbid symlink creation; skip if so.
			return;
		}
		expect(verifyPluginSignature(dir, [publicKeyB64]).status).toBe('invalid');
	});

	it('reports invalid for a forged signature from a different key', () => {
		const other = generateKeyPairSync('ed25519');
		// sign with `other` but claim the trusted publicKeyB64
		const files: Record<string, string> = {};
		for (const name of fs.readdirSync(dir))
			files[name] = sha256(fs.readFileSync(path.join(dir, name)));
		const payload = buildSigningPayload(files);
		const signature = cryptoSign(null, Buffer.from(payload), other.privateKey).toString('base64');
		fs.writeFileSync(
			path.join(dir, SIGNATURE_FILENAME),
			JSON.stringify({ algorithm: 'ed25519', publicKey: publicKeyB64, signature, files })
		);
		expect(verifyPluginSignature(dir, [publicKeyB64]).status).toBe('invalid');
	});
});
