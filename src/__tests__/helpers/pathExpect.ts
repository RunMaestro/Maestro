/**
 * Test helpers for platform-symmetric path assertions.
 *
 * The product code canonicalizes paths with `path.resolve` / `path.join` and
 * joins PATH-like strings with `path.delimiter`. On Windows those primitives
 * emit `\` separators and drive-anchor absolute paths, so tests that hardcode
 * POSIX literals (`/Users/...`, `:` delimiter) fail even though the product is
 * correct. Routing expected values through the SAME primitives keeps the tests
 * green on macOS, Linux, and Windows without changing any behavior.
 */

import * as path from 'path';

/**
 * Canonical account key, matching the product's `path.resolve(raw)`.
 * Use for `configDirKey` / `codexHomeKey` expectations.
 */
export function canonKey(p: string): string {
	return path.resolve(p);
}

/**
 * The in-asar node_modules path, matching the product's
 * `path.join(resources, 'app.asar', 'node_modules')`.
 */
export function asarNodePath(resources: string): string {
	return path.join(resources, 'app.asar', 'node_modules');
}

/**
 * Run `fn` with `process.platform` overridden, restoring it afterward.
 * `platformDetection.getPlatform()` reads `process.platform` first (before
 * `window.maestro.platform`) under Node, so Unix-branch tests must force it.
 */
export function withPlatform(value: NodeJS.Platform, fn: () => void): void {
	const original = process.platform;
	Object.defineProperty(process, 'platform', { value, configurable: true });
	try {
		fn();
	} finally {
		Object.defineProperty(process, 'platform', { value: original, configurable: true });
	}
}
