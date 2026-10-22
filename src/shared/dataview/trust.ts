/**
 * DataviewJS trust (D3, DV-12): the vault roots whose scripts run without asking, listed in the setting
 * `dataviewJsTrustedRoots`. One comparison rule, so main (which refuses a DataviewJS snapshot or file read in
 * an untrusted root), the renderer, and the CLI agree on what "trusted" means.
 *
 * A root is compared as main spells an index root (`DataviewQueryResponse.root`): an absolute local path, or a
 * POSIX path on an SSH remote. The list holds plain strings, so a trusted root trusts that path on every host.
 */

import { isAbsolutePath } from '../formatters';

/**
 * What a `dataviewjs` block does (DV-12, DV-14):
 * - `disabled`: the Encore Feature or the DataviewJS setting is off; the fence is ordinary code.
 * - `desktop-only`: the browser build, which never runs a guest; the fence shows a pill.
 * - `ask`: the vault is not trusted (or its root is not known yet); the block shows its source and asks.
 * - `run`: the vault is trusted; the block mounts its guest.
 */
export type DataviewJsRunPolicy = 'disabled' | 'desktop-only' | 'ask' | 'run';

export interface DataviewJsRunPolicyInput {
	/** Whether the `dataview` Encore Feature is on. */
	encoreOn: boolean;
	/** Whether the `dataviewJsEnabled` setting is on. */
	jsEnabled: boolean;
	/** The `dataviewJsTrustedRoots` setting. */
	trustedRoots: readonly unknown[];
	/** The note's vault root as main spells it, or null while it is not known. */
	root: string | null;
	/** Whether this is the web-desktop (browser) build. */
	isWebDesktop: boolean;
}

/** The one decision every `dataviewjs` block makes before it shows anything (D3, DV-12, DV-14). */
export function dataviewJsRunPolicy(input: DataviewJsRunPolicyInput): DataviewJsRunPolicy {
	if (!input.encoreOn || !input.jsEnabled) return 'disabled';
	if (input.isWebDesktop) return 'desktop-only';
	if (input.root !== null && isTrustedDataviewRoot(input.root, input.trustedRoots)) return 'run';
	return 'ask';
}

/**
 * `root` as the trust list stores and compares it: surrounding whitespace and trailing separators dropped (the
 * settings store trims entries too). A filesystem root keeps its separator: `/` and `C:\` stay as they are.
 */
export function normalizeTrustedRoot(root: string): string {
	const trimmed = root.trim();
	const stripped = trimmed.replace(/[/\\]+$/, '');
	if (stripped === '') return trimmed.slice(0, 1);
	if (/^[A-Za-z]:$/.test(stripped)) return trimmed.slice(0, 3);
	return stripped;
}

/** Whether `root` is in `trustedRoots`. Entries that are not strings are ignored. */
export function isTrustedDataviewRoot(root: string, trustedRoots: readonly unknown[]): boolean {
	const wanted = normalizeTrustedRoot(root);
	if (wanted === '') return false;
	return trustedRoots.some(
		(entry) => typeof entry === 'string' && normalizeTrustedRoot(entry) === wanted
	);
}

/** Whether `root` may go on the trust list: an absolute local or POSIX path once normalized. */
export function isTrustableDataviewRoot(root: unknown): root is string {
	return typeof root === 'string' && isAbsolutePath(normalizeTrustedRoot(root));
}

/** The trust list as stored values read: strings only, normalized, empty entries and repeats dropped. */
export function cleanTrustedRoots(trustedRoots: readonly unknown[]): string[] {
	const roots: string[] = [];
	for (const entry of trustedRoots) {
		if (typeof entry !== 'string') continue;
		const root = normalizeTrustedRoot(entry);
		if (root !== '' && !roots.includes(root)) roots.push(root);
	}
	return roots;
}

/** The cleaned list with `root` appended, unless it is on it already. */
export function withTrustedRoot(trustedRoots: readonly unknown[], root: string): string[] {
	const roots = cleanTrustedRoots(trustedRoots);
	const wanted = normalizeTrustedRoot(root);
	return wanted === '' || roots.includes(wanted) ? roots : [...roots, wanted];
}

/** The cleaned list without `root` (every spelling of it). */
export function withoutTrustedRoot(trustedRoots: readonly unknown[], root: string): string[] {
	const unwanted = normalizeTrustedRoot(root);
	return cleanTrustedRoots(trustedRoots).filter((entry) => entry !== unwanted);
}
