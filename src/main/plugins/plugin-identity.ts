/**
 * Plugin identity (main process).
 *
 * Resolves the `AuthIdentity` a grant is bound to: the content digest of the
 * plugin's files PLUS its signature/trust identity. This is the single place
 * that maps an installed plugin directory to the identity the authorization
 * ledger mints against and the refresh-time verifier recomputes and compares.
 *
 * The content digest deliberately excludes `signature.json` (so re-signing with
 * a different key does not change the digest), which is exactly why the signer
 * key and trust status are folded into the identity: a post-consent signer or
 * trust change must force re-consent even when the code is byte-identical.
 */

import { computePluginContentHash } from './plugin-signature';
import { verifyPluginSignature } from './plugin-signature';
import type { AuthIdentity } from './authorization-ledger';

/**
 * Compute a plugin directory's current `AuthIdentity` (content digest + signature
 * status + signer key). Returns null when the directory cannot be hashed (e.g. it
 * contains a symlink or is unreadable) — an unhashable tree can never be granted
 * an authorization.
 */
export function pluginIdentity(dir: string, trustedKeys: readonly string[]): AuthIdentity | null {
	try {
		// computePluginContentHash throws on a symlink (escape) or unreadable tree;
		// verifyPluginSignature rethrows non-ENOENT signature.json read errors. Either
		// way an identity we can't establish safely is not mintable → null.
		const contentHash = computePluginContentHash(dir);
		const check = verifyPluginSignature(dir, trustedKeys);
		return {
			contentHash,
			signatureStatus: check.status,
			signerKey: check.signerKey ?? null,
		};
	} catch {
		return null;
	}
}
