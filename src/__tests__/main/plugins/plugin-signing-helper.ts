/**
 * Shared test helper: sign a plugin directory with a test ed25519 key so it
 * verifies as `trusted` under the FC1 Option-B gate (code execution requires a
 * trusted signature). Mirrors the production signer: recursive walk, POSIX
 * relative paths, shared exclusion policy, detached signature.json.
 */
import * as fs from 'fs';
import * as path from 'path';
import { generateKeyPairSync, createHash, sign as cryptoSign } from 'crypto';
import {
	buildSigningPayload,
	isExcludedSignaturePath,
	normalizeRelPath,
	SIGNATURE_FILENAME,
} from '../../../shared/plugins/signing';

export interface TestSigningKeys {
	/** base64 SPKI public key - register via the manager's `trustedKeys` dep. */
	publicKeyB64: string;
	privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'];
}

export function makeSigningKeys(): TestSigningKeys {
	const { publicKey, privateKey } = generateKeyPairSync('ed25519');
	return {
		publicKeyB64: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
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
export function signPluginDir(dir: string, keys: TestSigningKeys): void {
	const files: Record<string, string> = {};
	collectFiles(dir, dir, files);
	const payload = buildSigningPayload(files);
	const signature = cryptoSign(null, Buffer.from(payload, 'utf-8'), keys.privateKey).toString(
		'base64'
	);
	fs.writeFileSync(
		path.join(dir, SIGNATURE_FILENAME),
		JSON.stringify({
			algorithm: 'ed25519',
			publicKey: keys.publicKeyB64,
			signature,
			files,
		})
	);
}
