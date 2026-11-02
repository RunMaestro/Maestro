/** Fresh file identity scans only; no authority, grants or cached decisions live here. */
import { parentPort } from 'node:worker_threads';
import { pluginIdentity } from './plugin-identity';
import { verifyPluginSignature, fingerprintPluginDir } from './plugin-signature';
const port = parentPort;
if (!port) throw Error('Plugin scan requires a worker');
port.on('message', (request: { id: number; dir: string; trustedKeys: string[] }) => {
	try {
		port.postMessage({
			id: request.id,
			result: {
				identity: pluginIdentity(request.dir, request.trustedKeys),
				signature: verifyPluginSignature(request.dir, request.trustedKeys),
				fingerprint: fingerprintPluginDir(request.dir),
			},
		});
	} catch {
		port.postMessage({ id: request.id, error: true });
	}
});
