/**
 * E2E signer for the fixture plugin dir - mirrors the production verifier by
 * importing the PURE shared signing module (no Electron deps, safe for the
 * Playwright transpiler): recursive walk, POSIX relative paths, the shared
 * exclusion policy (signature.json + *.pem/*.key + pruned dirs), detached
 * signature.json over the frozen `relpath:sha256hex` payload.
 *
 * Keys are createable ONCE and reusable: consent binds the plugin identity to
 * the signer key, so a mid-test fixture edit MUST be re-signed with the SAME
 * key - re-signing with a fresh key is an identity change and force-disables
 * the plugin at the next refresh.
 */
import fs from 'fs';
import path from 'path';
import { generateKeyPairSync, createHash, sign as cryptoSign, type KeyObject } from 'crypto';
import {
	buildSigningPayload,
	isExcludedSignaturePath,
	normalizeRelPath,
	SIGNATURE_FILENAME,
} from '../../src/shared/plugins/signing';

export interface SigningKeys {
	/** base64 SPKI public key - seed into `pluginTrustedKeys` to trust it. */
	publicKeyB64: string;
	privateKey: KeyObject;
}

export function makeSigningKeys(): SigningKeys {
	const { publicKey, privateKey } = generateKeyPairSync('ed25519');
	return {
		publicKeyB64: (publicKey.export({ format: 'der', type: 'spki' }) as Buffer).toString('base64'),
		privateKey,
	};
}

function collectFiles(root: string, dir: string, files: Record<string, string>): void {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const abs = path.join(dir, entry.name);
		const rel = normalizeRelPath(path.relative(root, abs));
		if (entry.isDirectory()) {
			collectFiles(root, abs, files);
			continue;
		}
		if (!entry.isFile()) continue;
		if (rel === SIGNATURE_FILENAME || isExcludedSignaturePath(rel)) continue;
		files[rel] = createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
	}
}

/** (Re-)write `signature.json` over the CURRENT contents of `dir`. Call again
 * after every fixture edit - the exact-file-set check makes stale signatures
 * `invalid`, which the trust gate treats as never-run. */
export function signPluginDir(dir: string, keys: SigningKeys): void {
	const files: Record<string, string> = {};
	collectFiles(dir, dir, files);
	const payload = buildSigningPayload(files);
	const signature = cryptoSign(null, Buffer.from(payload, 'utf-8'), keys.privateKey).toString(
		'base64'
	);
	fs.writeFileSync(
		path.join(dir, SIGNATURE_FILENAME),
		JSON.stringify({ algorithm: 'ed25519', publicKey: keys.publicKeyB64, signature, files })
	);
}
