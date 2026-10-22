// Vendored from blacksmithgu/obsidian-dataview@0.5.68 (29b1ad87e1f2b964b4fa0c209f11d0622469bdb0).
// Upstream path: src/util/locale.ts. License: MIT, see ../LICENSE.
// Modified for Maestro: E-env; indentation converted to tabs. Search for "MAESTRO" for the non-mechanical ones.
/** Test-environment-friendly function which fetches the current system locale. */
export function currentLocale(): string {
	const nav = (globalThis as any).navigator;
	if (typeof nav === "undefined" || !nav.language) return Intl.DateTimeFormat().resolvedOptions().locale; // MAESTRO: E-env
	return nav.language; // MAESTRO: E-env
}
