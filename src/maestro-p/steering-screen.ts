// The screen predicates that decide whether claude's TUI can accept an injection
// right now (see src/shared/chatSteering.ts for the wire protocol).
//
// maestro-p's own business rather than shared/: these read a replayed terminal
// grid, which only this process ever has.

// The input editor renders as a full-width rule, a line opening with the prompt
// glyph, and another full-width rule. Claude uses `❯` and has used `>`; both are
// accepted so a glyph change does not silently disable steering.
const EDITOR_PROMPT_RE = /^[›❯>]/;
const RULE_RE = /^[─-]{40,}$/;

/**
 * True when the TUI's input editor is drawn, i.e. keystrokes will land in the
 * composer rather than in a dialog.
 *
 * This is an ALLOWLIST on purpose, and that choice is the whole safety argument:
 * a blocklist of dialog phrases has to know every dialog claude will ever ship,
 * and the cost of one miss is an Enter landing on an approval prompt. Every
 * blocking dialog observed REPLACES the editor box rather than drawing beside
 * it, so requiring the box refuses an unknown future dialog by construction.
 *
 * Verified against claude 2.1.261 on rendered grids (`replayTerminalScreen`, not
 * a naive ANSI strip, which mashes rows together and cannot see this structure):
 * the box is present on the idle editor and on every 2.5s sample through a
 * streaming multi-tool turn, and absent while a permission prompt is up.
 */
export function editorIsAcceptingInput(screen: string): boolean {
	const lines = screen.split('\n').map((l) => l.trim());
	for (let i = 0; i + 2 < lines.length; i += 1) {
		if (
			RULE_RE.test(lines[i]) &&
			EDITOR_PROMPT_RE.test(lines[i + 1]) &&
			RULE_RE.test(lines[i + 2])
		) {
			return true;
		}
	}
	return false;
}

// Named dialogs, used ONLY to explain a refusal the allowlist above already
// made. Never to decide one: if this list is the gate, a dialog missing from it
// gets an Enter.
const DIALOG_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
	[/trust\s*this\s*folder|Yes,?\s*I\s*trust/i, 'a workspace-trust prompt'],
	[/Bypass\s*Permissions\s*mode/i, 'the bypass-permissions gate'],
	[/Do you want to/i, 'a permission prompt'],
	[/Would you like to proceed|Ready to code\?/i, 'a plan-approval prompt'],
	[/Esc to cancel\s*·\s*Tab to amend/i, 'a confirmation prompt'],
];

/** Name the dialog on screen, for a refusal message. Null when none is recognized. */
export function describeBlockingDialog(screen: string): string | null {
	for (const [re, label] of DIALOG_PATTERNS) {
		if (re.test(screen)) return label;
	}
	return null;
}

/**
 * Whether `text` visibly landed in the editor.
 *
 * Compared with all whitespace removed, because the editor soft-wraps at the
 * pane width and the rendered grid trims trailing blanks, so a multi-line steer
 * is never one contiguous run of characters on screen.
 *
 * Either END matching is enough, and BOTH are checked for a reason: the composer
 * scrolls. A steer longer than the editor is tall shows its TAIL with the opening
 * words scrolled out of view, so a prefix-only check reports "never landed" for
 * text that landed perfectly - and that false negative is expensive, because it
 * leaves the user's words sitting in the composer unsent. A short steer is
 * matched in full by both ends.
 *
 * The failure being screened for is "the keystrokes went somewhere else
 * entirely", not "one character was dropped"; the paced chunking covers the
 * latter and the prompt-echo check covers it for real prompts.
 */
export function screenShowsTypedText(screen: string, text: string): boolean {
	const squash = (s: string) => s.replace(/\s+/g, '');
	const flat = squash(text);
	if (flat.length === 0) return true;
	const haystack = squash(screen);
	const head = flat.slice(0, ECHO_MATCH_CHARS);
	const tail = flat.slice(-ECHO_MATCH_CHARS);
	return haystack.includes(head) || haystack.includes(tail);
}

/**
 * How much of the typed text must be visible at one end. Long enough not to
 * match some incidental fragment of chrome, short enough to survive a narrow
 * pane that wraps and elides.
 */
export const ECHO_MATCH_CHARS = 24;
