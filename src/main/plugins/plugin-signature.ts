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
	SIGNATURE_EXCLUDED_DIRS,
	isExcludedSignaturePath,
	buildSigningPayload,
	buildPluginContentHashPayload,
	validateSignatureManifest,
	isTrustedKey,
	normalizeRelPath,
	type SignatureCheck,
} from '../../shared/plugins/signing';

export type { SignatureCheck };

/** Bounded memory reserved for one verified in-process plugin execution image. */
export const PLUGIN_SOURCE_SNAPSHOT_LIMITS = Object.freeze({
	maxFiles: 128,
	maxFileBytes: 2 * 1024 * 1024,
	maxBytes: 8 * 1024 * 1024,
});

export interface VerifiedPluginSourceIdentity {
	pluginId: string;
	artifactDigest: string;
	authorizationContentHash: string;
	authorizationSignerKey: string;
	signerKeyId: string;
}

/**
 * Private in-memory bytes captured during the same reads that are hash-checked
 * against the detached signature. Runtime consumers get text only, never a
 * mutable file path or Buffer reference.
 */
export class VerifiedPluginSourceSnapshot {
	readonly identity: Readonly<VerifiedPluginSourceIdentity>;
	private readonly textByPath: Map<string, string>;
	private storedByteLength: number;

	constructor(
		identity: VerifiedPluginSourceIdentity,
		textByPath: Map<string, string>,
		byteLength: number
	) {
		this.identity = Object.freeze({ ...identity });
		this.textByPath = textByPath;
		this.storedByteLength = byteLength;
	}

	get fileCount(): number {
		return this.textByPath.size;
	}

	get byteLength(): number {
		return this.storedByteLength;
	}

	text(filePath: string): string | null {
		return this.textByPath.get(filePath) ?? null;
	}

	release(): void {
		this.textByPath.clear();
		this.storedByteLength = 0;
	}
}

/** SHA-256 (lowercase hex) of a file's bytes. */
function hashFile(absPath: string): string {
	const buf = fs.readFileSync(absPath);
	return createHash('sha256').update(buf).digest('hex');
}

/**
 * Recursively map every file in `dir` to its plugin-relative POSIX path and
 * SHA-256, excluding the signature file itself and anything the shared
 * exclusion policy strips (node_modules/, .git/, *.pem, *.key) so the signer,
 * packer, and verifier agree on one file set.
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
				if (SIGNATURE_EXCLUDED_DIRS.has(entry.name)) continue;
				walk(abs);
				continue;
			}
			if (!entry.isFile()) continue;
			const rel = normalizeRelPath(path.relative(dir, abs));
			if (rel === SIGNATURE_FILENAME) continue;
			if (isExcludedSignaturePath(rel)) continue;
			out[rel] = hashFile(abs);
		}
	};
	walk(dir);
	return out;
}

/**
 * A stable content digest of a plugin directory — the same file set and hashing
 * the signer uses, hashed once more into a single hex digest. The authorization
 * ledger binds a grant to this value, so if ANY plugin file changes after
 * consent the digest changes and the plugin must be re-consented. Throws on a
 * symlink (same policy as the signer); the caller treats a throw as
 * un-authorizable (disabled).
 */
export function computePluginContentHashFromFileHashes(files: Record<string, string>): string {
	return createHash('sha256').update(buildPluginContentHashPayload(files), 'utf-8').digest('hex');
}

export function computePluginContentHash(dir: string): string {
	return computePluginContentHashFromFileHashes(hashTree(dir));
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

/**
 * Capture a signed plugin's exact verified bytes into a bounded in-memory
 * snapshot. A mutable installed path is read once per file, hashed from those
 * exact bytes, then never used by execution/panel consumers again.
 */
export function captureVerifiedPluginSnapshot(
	pluginDir: string,
	trustedKeys: readonly string[],
	pluginId = path.basename(pluginDir)
): VerifiedPluginSourceSnapshot | null {
	const sigPath = path.join(pluginDir, SIGNATURE_FILENAME);
	let raw: string;
	try {
		raw = fs.readFileSync(sigPath, 'utf-8');
	} catch {
		return null;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	const { manifest } = validateSignatureManifest(parsed);
	if (!manifest || !isTrustedKey(manifest.publicKey, trustedKeys)) return null;

	const hashes: Record<string, string> = {};
	const textByPath = new Map<string, string>();
	let byteLength = 0;
	try {
		const visit = (current: string): void => {
			for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
				const absolute = path.join(current, entry.name);
				if (entry.isSymbolicLink()) throw new Error('plugin contains a symlink');
				if (entry.isDirectory()) {
					if (!SIGNATURE_EXCLUDED_DIRS.has(entry.name)) visit(absolute);
					continue;
				}
				if (!entry.isFile()) continue;
				const relativePath = normalizeRelPath(path.relative(pluginDir, absolute));
				if (relativePath === SIGNATURE_FILENAME || isExcludedSignaturePath(relativePath)) continue;
				if (textByPath.size >= PLUGIN_SOURCE_SNAPSHOT_LIMITS.maxFiles) {
					throw new Error('plugin snapshot exceeds file count limit');
				}
				const bytes = fs.readFileSync(absolute);
				if (bytes.byteLength > PLUGIN_SOURCE_SNAPSHOT_LIMITS.maxFileBytes) {
					throw new Error('plugin snapshot file exceeds byte limit');
				}
				byteLength += bytes.byteLength;
				if (byteLength > PLUGIN_SOURCE_SNAPSHOT_LIMITS.maxBytes) {
					throw new Error('plugin snapshot exceeds byte limit');
				}
				hashes[relativePath] = createHash('sha256').update(bytes).digest('hex');
				textByPath.set(relativePath, bytes.toString('utf8'));
			}
		};
		visit(pluginDir);
	} catch {
		return null;
	}
	if (!fileSetsMatch(hashes, manifest.files)) return null;
	const payload = buildSigningPayload(manifest.files);
	if (!verifyEd25519(payload, manifest.publicKey, manifest.signature)) return null;
	return new VerifiedPluginSourceSnapshot(
		{
			pluginId,
			artifactDigest: createHash('sha256').update(raw, 'utf8').digest('hex'),
			authorizationContentHash: computePluginContentHashFromFileHashes(hashes),
			authorizationSignerKey: manifest.publicKey,
			signerKeyId: manifest.publicKey,
		},
		textByPath,
		byteLength
	);
}
