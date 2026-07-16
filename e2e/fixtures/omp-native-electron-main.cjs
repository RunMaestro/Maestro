/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
const { createPublicKey, verify } = require('node:crypto');
const path = require('node:path');

const required = (name) => {
	const value = process.env[name];
	if (!value) throw new Error(`missing ${name}`);
	return value;
};

const archivePath = required('MAESTRO_E2E_OMP_ARCHIVE_PATH');
const archiveSha256 = required('MAESTRO_E2E_OMP_ARCHIVE_SHA256');
const runtimePath = required('MAESTRO_E2E_OMP_RUNTIME_PATH');
const bunPath = required('MAESTRO_E2E_OMP_BUN_PATH');
const trustRoot = Object.freeze(JSON.parse(required('MAESTRO_E2E_OMP_TRUST_ROOT')));
const publicKey = createPublicKey({
	key: Buffer.from(trustRoot.publicKey, 'base64'),
	format: 'der',
	type: 'spki',
});
const verifiedRuntime = Object.freeze({
	executablePath: bunPath,
	prefixArgs: Object.freeze([runtimePath]),
	fileIdentities: Object.freeze([
		Object.freeze({ canonicalPath: bunPath, identity: 'maestro-omp-e2e-bun-16.4.8' }),
		Object.freeze({ canonicalPath: runtimePath, identity: 'maestro-omp-e2e-runtime-16.4.8' }),
	]),
	version: '16.4.8',
	provenance: 'verified',
	revalidateForLaunch: async () => verifiedRuntime,
});

require('../../dist/main/plugins/plugin-runtime-startup-config.js').configurePluginRuntimeStartupDependencies(
	{
		productionOmp: {
			pluginsDir: path.join(required('MAESTRO_DEMO_DIR'), 'plugins'),
			archivePath,
			expectedArchiveSha256: archiveSha256,
			trustRoot,
			verifySignature: (payload, signature, root) =>
				root.keyId === trustRoot.keyId &&
				root.algorithm === trustRoot.algorithm &&
				root.publicKey === trustRoot.publicKey &&
				verify(null, payload, publicKey, Buffer.from(signature, 'base64url')),
			pinnedRelease: Object.freeze({
				packageName: '@oh-my-pi/pi-coding-agent',
				version: '16.4.8',
				registryOrigin: 'https://registry.npmjs.org',
				npmKeyIds: Object.freeze(['maestro-omp-e2e-runtime']),
			}),
			resolver: Object.freeze({
				resolveSystem: async () => verifiedRuntime,
				managedInstallAllowed: () => false,
				resolveManaged: async () => {
					throw new Error('managed install disabled in deterministic E2E');
				},
			}),
		},
	}
);
console.log('[OMP_NATIVE_E2E_VERIFIED_RUNTIME_READY]');
require('../../dist/main/index.js');
