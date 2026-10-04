/**
 * @deprecated Import from 'src/shared/maestro-lib' instead.
 *
 * This module now lives in the library to support headless and non-Electron
 * use cases. This re-export shim is kept for backwards compatibility.
 */

export { resolveUserDataDir, assertUserDataDirExists } from './maestro-lib/paths/userDataDir';
export type { UserDataDirOptions } from './maestro-lib/paths/userDataDir';
