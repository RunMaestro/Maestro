/**
 * Cross-capability policy (pure, bundle-safe).
 *
 * Some capability COMBINATIONS are dangerous even when each is individually
 * granted. The canonical case: `transcripts:read` (full conversation content)
 * together with an egress capability (`net:fetch` / `process:spawn`) is the
 * exact exfiltration path the metadata-only event contract (events.ts) exists
 * to prevent - a plugin that can both read your messages AND reach the network
 * can ship them anywhere. We allow that combination ONLY for a TRUSTED plugin
 * (its signing key is in the trusted set); an untrusted plugin may hold one or
 * the other, never both.
 *
 * This is intentionally SEPARATE from parsePermissions (a pure manifest parser
 * that runs BEFORE signature/trust is known). The `trusted` input is supplied
 * by the caller: the consent dialog at grant time, and the host handler at call
 * time (re-checked against LIVE grants + trust so a later toggle takes effect).
 */
import type { PluginCapability } from './permissions';

/** Capabilities that can move data off the machine. */
export const EGRESS_CAPABILITIES: readonly PluginCapability[] = [
	'net:fetch',
	'net:connect',
	'process:spawn',
];

/** Minimal shape shared by PermissionRequest and PermissionGrant. */
interface CapabilityHolder {
	capability: PluginCapability;
}

/**
 * Denial reason when an UNTRUSTED plugin holds `transcripts:read` together with
 * an egress capability, else null. `trusted` means the plugin's signature
 * resolves to a key in the trusted set. Works on requests (consent time) or
 * grants (call time) - both carry `.capability`.
 */
export function transcriptReadEgressConflict(
	held: readonly CapabilityHolder[],
	opts: { trusted: boolean }
): string | null {
	if (opts.trusted) return null;
	const hasTranscripts = held.some((h) => h.capability === 'transcripts:read');
	if (!hasTranscripts) return null;
	const egress = held.find((h) => EGRESS_CAPABILITIES.includes(h.capability));
	if (!egress) return null;
	return (
		`transcripts:read cannot be combined with ${egress.capability} for an untrusted plugin ` +
		`(conversation content could be exfiltrated). Sign the plugin with a trusted key to allow this combination.`
	);
}
