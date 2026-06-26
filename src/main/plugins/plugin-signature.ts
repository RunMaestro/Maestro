/**
 * Plugin signature verification (main process).
 *
 * Computes the SHA-256 of every file in a plugin directory, checks the set and
 * hashes match the plugin's signature.json EXACTLY (no extra, missing, or
 * altered files), then verifies the ed25519 signature over the canonical payload
 * and resolves trust against the trusted-key set.
 *
 * The "exact set" check is the important one: verifying only the listed files
 * would let an attacker ADD an unlisted malicious file (e.g. a second require
 * target) without breaking the signature. We require the on-disk file set to be
 * identical to the signed set.
 */

import * as fs from 'fs';
import * as path from 'path';
import { createHash, createPublicKey, verify as cryptoVerify } from 'crypto';
import {
	SIGNATURE_FILENAME,
	buildSigningPayload,
	validateSignatureManifest,
	isTrustedKey,
	normalizeRelPath,
	type SignatureCheck,
} from '../../shared/plugins/signing';

export type { SignatureCheck };

/** SHA-256 (lowercase hex) of a file's bytes. */
function hashFile(absPath: string): string {
	const buf = fs.readFileSync(absPath);
	return createHash('sha256').update(buf).digest('hex');
}

/**
 * Recursively map every file in `dir` to its plugin-relative POSIX path and
 * SHA-256, excluding the signature file itself.
 *
 * Symlinks are NOT skipped silently: a symlink can point outside the plugin and
 * is never legitimate signed content, and silently skipping it would let a
 * signed plugin ship an unsigned symlink (a real escape - see the security
 * review). Encountering ANY symlink throws, and the caller maps that to an
 * `invalid` signature so the plugin will not run.
 */
function hashTree(dir: string): Record<string, string> {
	const out: Record<string, string> = {};
	const walk = (current: string): void => {
		for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
			const abs = path.join(current, entry.name);
			if (entry.isSymbolicLink()) {
				throw new Error(`plugin contains a symlink: ${normalizeRelPath(path.relative(dir, abs))}`);
			}
			if (entry.isDirectory()) {
				walk(abs);
				continue;
			}
			if (!entry.isFile()) continue;
			const rel = normalizeRelPath(path.relative(dir, abs));
			if (rel === SIGNATURE_FILENAME) continue;
			out[rel] = hashFile(abs);
		}
	};
	walk(dir);
	return out;
}

/** Do two file-hash maps describe exactly the same files with the same hashes? */
function fileSetsMatch(a: Record<string, string>, b: Record<string, string>): boolean {
	const aKeys = Object.keys(a).sort();
	const bKeys = Object.keys(b).sort();
	if (aKeys.length !== bKeys.length) return false;
	for (let i = 0; i < aKeys.length; i++) {
		if (aKeys[i] !== bKeys[i]) return false;
		if (a[aKeys[i]].toLowerCase() !== b[bKeys[i]].toLowerCase()) return false;
	}
	return true;
}

/** Verify an ed25519 signature (base64) over `payload` with a base64 SPKI key. */
function verifyEd25519(payload: string, publicKeyB64: string, signatureB64: string): boolean {
	try {
		const keyObject = createPublicKey({
			key: Buffer.from(publicKeyB64, 'base64'),
			format: 'der',
			type: 'spki',
		});
		return cryptoVerify(
			null,
			Buffer.from(payload, 'utf-8'),
			keyObject,
			Buffer.from(signatureB64, 'base64')
		);
	} catch {
		// Malformed key or signature bytes => not verifiable => not valid.
		return false;
	}
}

/**
 * Resolve a plugin directory's signature status against the trusted key set.
 *
 * - 'unsigned'  : no signature.json present.
 * - 'invalid'   : signature.json malformed, file set/hashes mismatch, or the
 *                 ed25519 signature does not verify (tampered or corrupt).
 * - 'untrusted' : signature verifies (integrity ok) but the signer key is not
 *                 in the trusted set (unknown publisher).
 * - 'trusted'   : signature verifies AND the signer key is trusted.
 */
export function verifyPluginSignature(
	pluginDir: string,
	trustedKeys: readonly string[]
): SignatureCheck {
	const sigPath = path.join(pluginDir, SIGNATURE_FILENAME);
	let raw: string;
	try {
		raw = fs.readFileSync(sigPath, 'utf-8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'unsigned' };
		throw error;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { status: 'invalid', detail: 'signature.json is not valid JSON' };
	}

	const { manifest, errors } = validateSignatureManifest(parsed);
	if (!manifest) {
		return { status: 'invalid', detail: errors.join('; ') };
	}

	let actual: Record<string, string>;
	try {
		actual = hashTree(pluginDir);
	} catch (err) {
		// A symlink (or unreadable tree) makes the signed file set unverifiable.
		return {
			status: 'invalid',
			signerKey: manifest.publicKey,
			detail: err instanceof Error ? err.message : 'could not hash plugin files',
		};
	}
	if (!fileSetsMatch(actual, manifest.files)) {
		return {
			status: 'invalid',
			signerKey: manifest.publicKey,
			detail: 'plugin files do not match the signed file set',
		};
	}

	const payload = buildSigningPayload(manifest.files);
	if (!verifyEd25519(payload, manifest.publicKey, manifest.signature)) {
		return { status: 'invalid', signerKey: manifest.publicKey, detail: 'signature did not verify' };
	}

	return {
		status: isTrustedKey(manifest.publicKey, trustedKeys) ? 'trusted' : 'untrusted',
		signerKey: manifest.publicKey,
	};
}
