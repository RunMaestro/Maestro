/**
 * Which Cue bundle archive entries may never carry a qualification's files.
 *
 * The upstream exporter has no forbidden-entry predicate, so the harness's
 * bundle leg (E12) keeps its own: the credential-shaped
 * basenames and directories of the Grok branch's `isForbiddenBundleEntry()`
 * (`cue-bundle-exporter.ts`), without the enrollment, managed-binding and
 * Lite-pairing names that branch's managed host owned. The leg fails
 * `forbidden-entries` on any archive entry this names.
 */

const FORBIDDEN_BUNDLE_BASENAMES: readonly RegExp[] = [
	// Browser session state.
	/^maestro-browser-.*$/i,
	/^(Cookies|Login Data|Web Data)(-journal)?$/,
	// Provider logins and generic credential files.
	/^\.?credentials\.json$/i,
	/^auth\.json$/i,
	/^token\.json$/i,
	/^\.netrc$/i,
	/^\.env(\.(?!md$)[^.]+)?$/i,
	/^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
	/\.(pem|key|p12|pfx|lease)$/i,
	// Plugin grant ledgers.
	/^plugin-grants.*\.json$/i,
];

const FORBIDDEN_BUNDLE_DIRECTORIES: readonly RegExp[] = [
	/^(Local Storage|Session Storage|IndexedDB)$/,
	/^\.ssh$/i,
	/^\.aws$/i,
];

/** Whether an archive path names a file that may never be bundled. */
export function isForbiddenBundleEntry(archivePath: string): boolean {
	const segments = archivePath.split(/[\\/]/).filter((segment) => segment !== '');
	if (segments.length === 0) return false;
	const base = segments[segments.length - 1];
	if (FORBIDDEN_BUNDLE_BASENAMES.some((pattern) => pattern.test(base))) return true;
	return segments.slice(0, -1).some((dir) => FORBIDDEN_BUNDLE_DIRECTORIES.some((p) => p.test(dir)));
}
