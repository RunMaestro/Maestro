import { describe, expect, it } from 'vitest';
import type { Key } from 'ink';
import {
	KEYMAP,
	bindingFor,
	chordsIn,
	formatBindingKeys,
	formatChord,
	keysFor,
	resolveAction,
	type KeyChord,
	type KeyContext,
} from '../keymap';

const NO_KEY: Key = {
	upArrow: false,
	downArrow: false,
	leftArrow: false,
	rightArrow: false,
	pageDown: false,
	pageUp: false,
	return: false,
	escape: false,
	ctrl: false,
	shift: false,
	tab: false,
	backspace: false,
	delete: false,
	meta: false,
};

/** The `(input, key)` pair Ink would hand the handler for a chord. */
function press(chord: KeyChord): { input: string; key: Key } {
	const key: Key = {
		...NO_KEY,
		ctrl: Boolean(chord.ctrl),
		shift: Boolean(chord.shift),
		tab: chord.named === 'tab',
		return: chord.named === 'return',
		escape: chord.named === 'escape',
		upArrow: chord.named === 'up',
		downArrow: chord.named === 'down',
		leftArrow: chord.named === 'left',
		rightArrow: chord.named === 'right',
	};
	return { input: chord.input ?? '', key };
}

describe('keymap', () => {
	it('resolves every chord of every binding to that binding in each of its contexts', () => {
		for (const binding of KEYMAP) {
			for (const context of binding.contexts) {
				for (const chord of chordsIn(binding, context)) {
					const { input, key } = press(chord);
					expect(
						resolveAction(context, input, key),
						`${binding.action} via ${formatChord(chord)}`
					).toBe(binding.action);
				}
			}
		}
	});

	it('never gives one chord two meanings in the same context', () => {
		const seen = new Map<string, string>();
		for (const binding of KEYMAP) {
			for (const context of binding.contexts) {
				for (const chord of chordsIn(binding, context)) {
					const id = `${context}:${formatChord(chord)}`;
					expect(seen.get(id), `${id} is bound twice`).toBeUndefined();
					seen.set(id, binding.action);
				}
			}
		}
	});

	it('keeps one binding per action', () => {
		const actions = KEYMAP.map((binding) => binding.action);
		expect(new Set(actions).size).toBe(actions.length);
	});

	it('tells Tab from Shift-Tab', () => {
		expect(resolveAction('main', '', { ...NO_KEY, tab: true })).toBe('nextPane');
		expect(resolveAction('main', '', { ...NO_KEY, tab: true, shift: true })).toBe('prevPane');
	});

	it('ignores a key outside the context it is bound in', () => {
		const contexts: KeyContext[] = ['help', 'tabs'];
		for (const context of contexts) {
			expect(resolveAction(context, 'q', NO_KEY)).toBeUndefined();
		}
		expect(resolveAction('main', '', { ...NO_KEY, escape: true })).toBeUndefined();
		// Only the overlays with a list move a cursor.
		expect(resolveAction('help', 'j', NO_KEY)).toBeUndefined();
		expect(resolveAction('tabs', 'j', NO_KEY)).toBe('moveDown');
	});

	it('keeps letters for typing in the palette and moves its cursor with arrows and Ctrl chords', () => {
		for (const letter of ['j', 'k', 'q', 'm', '?', 'T']) {
			expect(resolveAction('palette', letter, NO_KEY), letter).toBeUndefined();
		}
		expect(resolveAction('palette', '', { ...NO_KEY, downArrow: true })).toBe('moveDown');
		expect(resolveAction('palette', '', { ...NO_KEY, upArrow: true })).toBe('moveUp');
		expect(resolveAction('palette', 'n', { ...NO_KEY, ctrl: true })).toBe('moveDown');
		expect(resolveAction('palette', 'p', { ...NO_KEY, ctrl: true })).toBe('moveUp');
		expect(resolveAction('palette', '', { ...NO_KEY, return: true })).toBe('open');
		expect(resolveAction('palette', '', { ...NO_KEY, escape: true })).toBe('closeOverlay');
		// The same chord that opens the palette closes it.
		expect(resolveAction('main', 'k', { ...NO_KEY, ctrl: true })).toBe('palette');
		expect(resolveAction('palette', 'k', { ...NO_KEY, ctrl: true })).toBe('palette');
		expect(resolveAction('tabs', 'k', { ...NO_KEY, ctrl: true })).toBeUndefined();
	});

	it('opens the agent menu with m and lets the menu use the list keys', () => {
		expect(resolveAction('main', 'm', NO_KEY)).toBe('agentMenu');
		expect(resolveAction('menu', 'j', NO_KEY)).toBe('moveDown');
		expect(resolveAction('menu', '', { ...NO_KEY, return: true })).toBe('open');
		expect(resolveAction('menu', '', { ...NO_KEY, escape: true })).toBe('closeOverlay');
		expect(resolveAction('menu', 'm', NO_KEY)).toBeUndefined();
	});

	it('opens the agent form with n and E, and puts E in the agent menu', () => {
		expect(resolveAction('main', 'n', NO_KEY)).toBe('newAgent');
		expect(resolveAction('main', 'E', NO_KEY)).toBe('editAgent');
		expect(bindingFor('editAgent').agentMenu).toBe('Edit agent');
		// A new agent belongs to no agent, so it is not in the agent menu.
		expect(bindingFor('newAgent').agentMenu).toBeUndefined();
	});

	it('keeps every letter for typing in the form and moves with arrows, Tab, and Ctrl chords', () => {
		for (const letter of ['j', 'k', 'q', 'm', 'n', 'E', 's', '?']) {
			expect(resolveAction('form', letter, NO_KEY), letter).toBeUndefined();
		}
		expect(resolveAction('form', '', { ...NO_KEY, downArrow: true })).toBe('moveDown');
		expect(resolveAction('form', '', { ...NO_KEY, tab: true })).toBe('moveDown');
		expect(resolveAction('form', 'n', { ...NO_KEY, ctrl: true })).toBe('moveDown');
		expect(resolveAction('form', '', { ...NO_KEY, upArrow: true })).toBe('moveUp');
		expect(resolveAction('form', '', { ...NO_KEY, tab: true, shift: true })).toBe('moveUp');
		expect(resolveAction('form', 'p', { ...NO_KEY, ctrl: true })).toBe('moveUp');
		expect(resolveAction('form', '', { ...NO_KEY, leftArrow: true })).toBe('choicePrev');
		expect(resolveAction('form', '', { ...NO_KEY, rightArrow: true })).toBe('choiceNext');
		expect(resolveAction('form', 's', { ...NO_KEY, ctrl: true })).toBe('submitForm');
		expect(resolveAction('form', '', { ...NO_KEY, return: true })).toBe('open');
		expect(resolveAction('form', '', { ...NO_KEY, escape: true })).toBe('closeOverlay');
		// Tab walks panes in the main view, fields in the form.
		expect(resolveAction('main', '', { ...NO_KEY, tab: true })).toBe('nextPane');
	});

	it('writes the arrow keys the way a person reads them', () => {
		expect(keysFor('choicePrev')).toBe('←');
		expect(keysFor('choiceNext')).toBe('→');
		expect(keysFor('submitForm')).toBe('Ctrl-S');
	});

	it('does not take Ctrl-or-Meta chords for the plain letter', () => {
		expect(resolveAction('main', 'q', { ...NO_KEY, ctrl: true })).toBeUndefined();
		expect(resolveAction('main', 'q', { ...NO_KEY, meta: true })).toBeUndefined();
		expect(resolveAction('main', 'b', { ...NO_KEY, ctrl: true })).toBe('toggleAgentsPane');
		expect(resolveAction('main', 'b', NO_KEY)).toBeUndefined();
	});

	it('takes the Esc Ink reports with meta set, since a bare Esc arrives that way', () => {
		expect(resolveAction('help', '', { ...NO_KEY, escape: true, meta: true })).toBe('closeOverlay');
	});

	it('writes keys the way a person reads them', () => {
		expect(formatBindingKeys(bindingFor('moveDown'))).toBe('j / ↓');
		expect(keysFor('prevPane')).toBe('Shift-Tab');
		expect(keysFor('toggleAgentsPane')).toBe('Ctrl-B');
		expect(keysFor('closeOverlay')).toBe('Esc');
		expect(keysFor('open')).toBe('Enter');
		expect(keysFor('palette')).toBe('Ctrl-K');
	});

	it('throws for an action nobody bound, so a typo cannot print an empty hint', () => {
		expect(() => bindingFor('nope' as never)).toThrow('no binding');
	});
});
