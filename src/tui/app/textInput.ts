import type { Key } from 'ink';

/**
 * The text a keypress adds to a text box, with control characters dropped (a
 * pasted block arrives as one `input`; Tab and a stray Esc must not land in the
 * box). Ctrl and Meta chords add nothing. Shared by every text box in the TUI:
 * the palette, the agent form, and the prompts that follow.
 */
export function typedTextFor(input: string, key: Key): string {
	if (key.ctrl || key.meta) return '';

	return input.replace(/[\u0000-\u001f\u007f]/g, '');
}

/** Whether the key deletes the last typed character. Terminals disagree on which flag Backspace sets. */
export function isBackspaceKey(key: Key): boolean {
	return key.backspace || key.delete;
}
