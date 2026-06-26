/**
 * Plugin signing contract (pure, bundle-safe).
 *
 * A signed plugin ships a `signature.json` alongside its files. The signature
 * covers a DETERMINISTIC payload built from the SHA-256 of every other file in
 * the plugin directory, so any tampering (including swapping the manifest or the
 * entry code) invalidates it. ed25519 sign/verify uses node:crypto and lives in
 * the main process (src/main/plugins/plugin-signature.ts); this module owns only
 * the on-disk shape and the canonical payload construction, which must be
 * identical on the signer and verifier sides - hence pure and shared.
 *
 * Trust is layered on top of integrity:
 * - integrity = "the files match what was signed" (signature verifies).
 * - trust = "the signing key is one Maestro recognizes" (key in trusted set).
 * A plugin can be integral but untrusted (valid signature, unknown publisher).
 */

/** Filename of the detached signature manifest inside a plugin directory. */
export const SIGNATURE_FILENAME = 'signature.json';

/** The only signature algorithm supported. */
export const SIGNATURE_ALGORITHM = 'ed25519';

/** The on-disk signature manifest. */
export interface SignatureManifest {
	algorithm: typeof SIGNATURE_ALGORITHM;
	/** Signer's ed25519 public key, base64 (SPKI DER). */
	publicKey: string;
	/** Detached signature over buildSigningPayload(files), base64. */
	signature: string;
	/** Map of plugin-relative POSIX path -> lowercase hex SHA-256 of that file. */
	files: Record<string, string>;
}

/** Result of resolving a plugin's signature against the trusted key set. */
export type SignatureStatus = 'unsigned' | 'invalid' | 'untrusted' | 'trusted';

export interface SignatureCheck {
	status: SignatureStatus;
	/** The signer public key (base64) when a signature was present. */
	signerKey?: string;
	/** Human-readable detail (why invalid, etc.). */
	detail?: string;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Build the canonical bytes that get signed/verified from the file-hash map.
 * Deterministic: paths are normalized to POSIX, lowercased-hex hashes, sorted by
 * path, and joined with newlines as `path:hash`. The signer and verifier MUST
 * produce byte-identical output, so this format is frozen.
 *
 * `signature.json` itself is never included (a file cannot sign its own hash).
 */
export function buildSigningPayload(files: Record<string, string>): string {
	const entries = Object.entries(files)
		.filter(([path]) => normalizeRelPath(path) !== SIGNATURE_FILENAME)
		.map(([path, hash]) => [normalizeRelPath(path), hash.toLowerCase()] as const)
		.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
	return entries.map(([path, hash]) => `${path}:${hash}`).join('\n');
}

/** Normalize a plugin-relative path to POSIX with no leading `./` or slashes. */
export function normalizeRelPath(path: string): string {
	return path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

/**
 * Validate a parsed signature.json. Returns the typed manifest or a list of
 * errors. Strict: a malformed signature manifest is treated as no usable
 * signature (the caller maps that to 'invalid'/'unsigned' as appropriate).
 */
export function validateSignatureManifest(input: unknown): {
	manifest: SignatureManifest | null;
	errors: string[];
} {
	const errors: string[] = [];
	if (!isPlainObject(input)) return { manifest: null, errors: ['signature is not an object'] };
	const { algorithm, publicKey, signature, files } = input;

	if (algorithm !== SIGNATURE_ALGORITHM) {
		errors.push(`unsupported signature algorithm "${String(algorithm)}"`);
	}
	if (typeof publicKey !== 'string' || publicKey.trim() === '') {
		errors.push('publicKey must be a non-empty base64 string');
	}
	if (typeof signature !== 'string' || signature.trim() === '') {
		errors.push('signature must be a non-empty base64 string');
	}
	if (!isPlainObject(files)) {
		errors.push('files must be an object of path -> sha256');
	} else {
		for (const [path, hash] of Object.entries(files)) {
			if (typeof hash !== 'string' || !SHA256_HEX.test(hash.toLowerCase())) {
				errors.push(`file "${path}" has an invalid sha256 hash`);
			}
		}
	}

	if (errors.length > 0) return { manifest: null, errors };

	const validatedFiles: Record<string, string> = {};
	for (const [path, hash] of Object.entries(files as Record<string, unknown>)) {
		validatedFiles[normalizeRelPath(path)] = (hash as string).toLowerCase();
	}
	return {
		manifest: {
			algorithm: SIGNATURE_ALGORITHM,
			publicKey: (publicKey as string).trim(),
			signature: (signature as string).trim(),
			files: validatedFiles,
		},
		errors: [],
	};
}

/** Is this public key (base64) in the trusted set? Constant-ish membership. */
export function isTrustedKey(publicKey: string, trustedKeys: readonly string[]): boolean {
	const key = publicKey.trim();
	return trustedKeys.some((k) => k.trim() === key);
}
