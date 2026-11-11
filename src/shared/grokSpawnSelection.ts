import { canonicalJson } from './canonicalJson';
import type { SshRemoteConfig } from './types';

/** In-memory comparison only. Never persist/log this value or treat it as a grant. */
export type GrokSpawnSelectionFingerprint = `grok-spawn-selection-v1:${string}`;

/** Configuration read by each host, before applying any per-session overrides. */
export interface GrokSpawnSelection {
	providerConfig: Readonly<Record<string, unknown>>;
	shellEnvVars: Readonly<Record<string, string>>;
	/** The configured, resolved endpoint; null means a deliberately local launch.
	 *  A missing/disabled selected remote must be refused by the caller, not
	 *  represented as local. Observed sshRemoteId/remoteCwd cannot select it. */
	sshRemote: SshRemoteConfig | null;
}

/** Main supplies the existing sha256Hex utility to compare synchronously. */
export function fingerprintGrokSpawnSelection(
	selection: GrokSpawnSelection,
	sha256: (text: string) => string
): GrokSpawnSelectionFingerprint;
/** Renderer uses Web Crypto, keeping Node dependencies out of its bundle. */
export function fingerprintGrokSpawnSelection(
	selection: GrokSpawnSelection
): Promise<GrokSpawnSelectionFingerprint>;
/**
 * One projection for enqueue and main entry. Snapshot before asynchronous
 * hashing; only the digest may cross process:spawn, never the raw values.
 * This detects stale configuration, not native ownership or managed admission.
 * Session/tab/cwd selection stays with the existing owner checks; model/effort
 * stay frozen on the queued turn. Environment blanks and absent/empty overrides
 * retain their exact meaning. No account/path resolution or credential reads.
 */
export function fingerprintGrokSpawnSelection(
	selection: GrokSpawnSelection,
	sha256?: (text: string) => string
): GrokSpawnSelectionFingerprint | Promise<GrokSpawnSelectionFingerprint> {
	const { providerConfig, shellEnvVars, sshRemote } = selection;
	const text = canonicalJson({
		customPath: providerConfig.customPath,
		customArgs: providerConfig.customArgs,
		customEnvVars: providerConfig.customEnvVars,
		shellEnvVars,
		remote: sshRemote
			? {
					id: sshRemote.id,
					enabled: sshRemote.enabled,
					host: sshRemote.host,
					port: sshRemote.port,
					username: sshRemote.username,
					privateKeyPath: sshRemote.privateKeyPath,
					useSshConfig: sshRemote.useSshConfig,
					sshOptions: sshRemote.sshOptions,
					remoteEnv: sshRemote.remoteEnv,
				}
			: null,
	});
	if (sha256) return `grok-spawn-selection-v1:${sha256(text)}`;
	return globalThis.crypto.subtle
		.digest('SHA-256', new TextEncoder().encode(text))
		.then(
			(digest): GrokSpawnSelectionFingerprint =>
				`grok-spawn-selection-v1:${Array.from(new Uint8Array(digest), (byte) =>
					byte.toString(16).padStart(2, '0')
				).join('')}`
		);
}
