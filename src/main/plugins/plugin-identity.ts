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
import { isProvidedPluginId } from '../../shared/plugins/provided';
import type { PluginRecord } from '../../shared/plugins/plugin-registry';

/**
 * The immutable execution provenance that may authorize a materialized bundled
 * record. The callback that supplies it must validate the record against the
 * current canonical bundled artifact before returning a snapshot.
 */
export interface VerifiedBundledAuthorizationSnapshot {
	readonly identity: Readonly<{
		readonly artifactDigest: string;
		readonly authorizationContentHash: string;
		readonly authorizationSignerKey: string;
		readonly signerKeyId: string;
	}>;
}

export type VerifiedBundledAuthorizationSnapshotFor = (
	record: Readonly<PluginRecord>
) => VerifiedBundledAuthorizationSnapshot | null;

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

/**
 * Resolve the only authorization identity that a record may mint or retain.
 *
 * Community records retain their directory identity. A host-provided record is
 * different: its materialized directory deliberately has no signature.json, so
 * it is authorized only from the current immutable bundled execution snapshot.
 * Missing, stale, or invalid bundled provenance fails closed rather than falling
 * back to directory identity or a manifest/plugin id.
 */
export function resolvePluginAuthorizationIdentity(
	record: Readonly<PluginRecord>,
	trustedKeys: readonly string[],
	verifiedBundledSnapshotFor: VerifiedBundledAuthorizationSnapshotFor
): AuthIdentity | null {
	if (isProvidedPluginId(record.id) || record.installOwner === 'bundle') {
		if (record.installOwner !== 'bundle') return null;
		const snapshot = verifiedBundledSnapshotFor(record);
		if (!snapshot || !isValidBundledSnapshot(snapshot)) return null;
		return {
			contentHash: snapshot.identity.authorizationContentHash,
			signatureStatus: 'trusted',
			signerKey: snapshot.identity.authorizationSignerKey,
		};
	}
	return pluginIdentity(record.source, trustedKeys);
}

function isValidBundledSnapshot(snapshot: VerifiedBundledAuthorizationSnapshot): boolean {
	const { artifactDigest, authorizationContentHash, authorizationSignerKey, signerKeyId } =
		snapshot.identity;
	return (
		/^[a-f0-9]{64}$/i.test(artifactDigest) &&
		/^[a-f0-9]{64}$/i.test(authorizationContentHash) &&
		authorizationSignerKey.length > 0 &&
		signerKeyId.length > 0
	);
}
