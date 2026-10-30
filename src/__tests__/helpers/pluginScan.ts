/** Explicit inline filesystem seam for lifecycle unit tests; production never falls back to main. */
import { pluginIdentity } from '../../main/plugins/plugin-identity';
import { verifyPluginSignature, fingerprintPluginDir } from '../../main/plugins/plugin-signature';
export async function scanPluginFiles(dir: string, keys: readonly string[]) {
	return {
		identity: pluginIdentity(dir, keys),
		signature: verifyPluginSignature(dir, keys),
		fingerprint: fingerprintPluginDir(dir),
	};
}
