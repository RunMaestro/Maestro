// src/shared/maestro-lib/version.ts

/**
 * The version of maestro-lib's public surface (`index.ts`), for a tool that
 * builds on the library and has to pin what it was written against.
 *
 * Semver over the entry module alone, independent of the app's own version:
 * the app can ship many releases with no change to this surface, and a change
 * to the surface is not an app release. Bump it in the same change that edits
 * what `index.ts` exports or how an exported function behaves: the patch for a
 * fix, the minor for an addition, the major for a removal or a breaking
 * change. Below 1.0 the surface is still being proven, so a minor may break.
 *
 * `npm run build:maestro-lib` writes it into the built package's
 * `package.json`, next to the app version the build was cut from.
 */
export const MAESTRO_LIB_VERSION = '0.2.0';
