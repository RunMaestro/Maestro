/**
 * Every key the TUI answers, in one table (spec section 5.2).
 *
 * The input handler resolves a keypress through `resolveAction`, and the help
 * overlay draws its rows from `KEYMAP` through `formatBindingKeys`. Both read
 * this one table, so the help on screen cannot disagree with what a key does.
 * Adding a binding here is the whole change: it shows up in help by itself.
 */

import type { Key } from 'ink';

/** Where a binding is live: the main view, or one of the overlays. */
export type KeyContext = 'main' | 'help' | 'tabs';

export type KeyAction =
	| 'quit'
	| 'help'
	| 'nextPane'
	| 'prevPane'
	| 'moveUp'
	| 'moveDown'
	| 'open'
	| 'tabSwitcher'
	| 'toggleToolCalls'
	| 'toggleAgentsPane'
	| 'closeOverlay';

/** Keys that arrive as a flag on Ink's `Key` rather than as text. */
export type NamedKey = 'tab' | 'return' | 'escape' | 'up' | 'down';

export interface KeyChord {
	/** A printable key, as Ink reports it (`j`, `T`, `?`). */
	input?: string;
	named?: NamedKey;
	ctrl?: boolean;
	/** Only meaningful for `Tab`: letters carry their shift in the character itself. */
	shift?: boolean;
}

export interface Binding {
	action: KeyAction;
	chords: readonly KeyChord[];
	contexts: readonly KeyContext[];
	/** One short line. Help draws it beside the keys. */
	description: string;
}

export const KEYMAP: readonly Binding[] = [
	{
		action: 'nextPane',
		chords: [{ named: 'tab' }],
		contexts: ['main'],
		description: 'Next pane',
	},
	{
		action: 'prevPane',
		chords: [{ named: 'tab', shift: true }],
		contexts: ['main'],
		description: 'Previous pane',
	},
	{
		action: 'moveDown',
		chords: [{ input: 'j' }, { named: 'down' }],
		contexts: ['main', 'tabs'],
		description: 'Move down',
	},
	{
		action: 'moveUp',
		chords: [{ input: 'k' }, { named: 'up' }],
		contexts: ['main', 'tabs'],
		description: 'Move up',
	},
	{
		action: 'open',
		chords: [{ named: 'return' }],
		contexts: ['main', 'tabs'],
		description: 'Open agent, fold group, pick tab',
	},
	{
		action: 'tabSwitcher',
		chords: [{ input: 'T' }],
		contexts: ['main'],
		description: 'Tab switcher for the selected agent',
	},
	{
		action: 'toggleToolCalls',
		chords: [{ input: 'e' }],
		contexts: ['main'],
		description: 'Expand or collapse tool calls',
	},
	{
		action: 'toggleAgentsPane',
		chords: [{ input: 'b', ctrl: true }],
		contexts: ['main'],
		description: 'Show or hide the Agents pane',
	},
	{
		action: 'help',
		chords: [{ input: '?' }],
		contexts: ['main', 'help'],
		description: 'Key help',
	},
	{
		action: 'quit',
		chords: [{ input: 'q' }],
		contexts: ['main'],
		description: 'Quit',
	},
	{
		action: 'closeOverlay',
		chords: [{ named: 'escape' }],
		contexts: ['help', 'tabs'],
		description: 'Close the overlay',
	},
];

function namedKeyPressed(named: NamedKey, key: Key): boolean {
	switch (named) {
		case 'tab':
			return key.tab;
		case 'return':
			return key.return;
		case 'escape':
			return key.escape;
		case 'up':
			return key.upArrow;
		case 'down':
			return key.downArrow;
	}
}

export function chordMatches(chord: KeyChord, input: string, key: Key): boolean {
	// Ink reports a bare Esc with `meta` set too (it reads the leading ESC byte as an Alt prefix).
	if (key.meta && chord.named !== 'escape') return false;
	if (chord.named) {
		if (!namedKeyPressed(chord.named, key)) return false;
		// Only Tab has a shifted form; the other named keys ignore the flag.
		return chord.named !== 'tab' || Boolean(chord.shift) === key.shift;
	}
	return chord.input === input && Boolean(chord.ctrl) === key.ctrl;
}

/** The action a keypress means in `context`, or undefined when it means nothing there. */
export function resolveAction(
	context: KeyContext,
	input: string,
	key: Key,
	keymap: readonly Binding[] = KEYMAP
): KeyAction | undefined {
	for (const binding of keymap) {
		if (!binding.contexts.includes(context)) continue;
		if (binding.chords.some((chord) => chordMatches(chord, input, key))) return binding.action;
	}
	return undefined;
}

const NAMED_KEY_LABELS: Record<NamedKey, string> = {
	tab: 'Tab',
	return: 'Enter',
	escape: 'Esc',
	up: '↑',
	down: '↓',
};

export function formatChord(chord: KeyChord): string {
	if (chord.named) {
		const label = NAMED_KEY_LABELS[chord.named];
		return chord.shift ? `Shift-${label}` : label;
	}
	const input = chord.input ?? '';
	return chord.ctrl ? `Ctrl-${input.toUpperCase()}` : input;
}

/** `j / ↓`: how a binding's keys read in help and in hints. */
export function formatBindingKeys(binding: Binding): string {
	return binding.chords.map(formatChord).join(' / ');
}

export function bindingFor(action: KeyAction, keymap: readonly Binding[] = KEYMAP): Binding {
	const binding = keymap.find((candidate) => candidate.action === action);
	if (!binding) throw new Error(`no binding for ${action}`);
	return binding;
}

/** The keys for one action, ready to print in a hint line. */
export function keysFor(action: KeyAction): string {
	return formatBindingKeys(bindingFor(action));
}
