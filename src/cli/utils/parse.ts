// Argument parsing helpers shared by CLI commands.
//
// These exist so every verb spells the same value the same way: `--bookmark
// true`, `tab read-only yes`, and `--sync-history-to-remote 1` all accept the
// same vocabulary. Three near-identical copies of the boolean parser had
// already drifted (one accepted on/off, the others didn't).

/** Values that read as `true` / `false` on the command line. */
const TRUE_WORDS = new Set(['true', '1', 'yes', 'on']);
const FALSE_WORDS = new Set(['false', '0', 'no', 'off']);

/**
 * Parse a CLI boolean argument. Accepts true/false, 1/0, yes/no, on/off
 * (case-insensitive). Throws with the offending flag named so the caller can
 * report it however it reports its other errors.
 */
export function parseCliBool(value: string, flag: string): boolean {
	const v = String(value).trim().toLowerCase();
	if (TRUE_WORDS.has(v)) return true;
	if (FALSE_WORDS.has(v)) return false;
	throw new Error(`${flag} expects true or false, got "${value}"`);
}

/**
 * Words that clear a per-tab or per-agent override so the value is inherited
 * again (from the agent, or from the global setting). Distinct from `false`:
 * clearing enter-to-send returns the tab to the `enterToSendAI` setting rather
 * than pinning it off.
 */
const INHERIT_WORDS = new Set(['', 'inherit', 'default', 'none', 'clear', 'unset']);

/** True when an argument means "drop the override and inherit". */
export function isInheritValue(value: string): boolean {
	return INHERIT_WORDS.has(String(value).trim().toLowerCase());
}
