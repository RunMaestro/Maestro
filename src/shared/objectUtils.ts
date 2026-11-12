/**
 * Shared object utility functions
 *
 * Runtime-agnostic: no renderer, main, or Electron imports, so the main
 * process, the renderer and the CLI can all load it.
 */

/**
 * A copy of `value` without the keys whose value is `undefined`, so an object
 * built from optional inputs carries only the fields that were set. Other
 * falsy values (`false`, `0`, `''`, `null`) are kept: they are choices.
 */
export function definedOnly<T extends object>(value: T): T {
	return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}
