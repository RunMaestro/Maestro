/**
 * The key seal the opt-in local-model suites give the Maestro model server.
 *
 * The real seal is Electron's `safeStorage`, which works only inside the app.
 * Every on-device suite shares ONE scratch data dir (`maestro-local-model-e2e`),
 * and the server keeps its sealed API key there between runs. So every suite
 * must seal the same way: a suite with a seal of its own cannot open the key the
 * last suite wrote, and the server refuses to start (`key-unavailable`).
 *
 * This is not protection, and it is not meant to be: the scratch dir holds a
 * key for a loopback server that lives as long as one test run.
 */

import type { SealProvider } from '../../main/utils/safe-storage-seal';

const SCRATCH_SEAL_PREFIX = 'e2e-sealed:';

/**
 * The shared stand-in seal. `available` lets a suite take the key store away,
 * to prove what the server does without one.
 */
export function scratchKeySeal(available: () => boolean = () => true): SealProvider {
	return {
		available,
		seal: (text) => Buffer.from(`${SCRATCH_SEAL_PREFIX}${text}`),
		unseal: (blob) => blob.toString().slice(SCRATCH_SEAL_PREFIX.length),
	};
}
