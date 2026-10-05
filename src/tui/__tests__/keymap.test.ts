import { describe, expect, it } from 'vitest';
import type { Key } from 'ink';
import {
	KEYMAP,
	bindingFor,
	chordsIn,
	formatBindingKeys,
	formatChord,
	gatedKeymap,
	keysFor,
	resolveAction,
	type Binding,
	type KeyChord,
	type KeyContext,
} from '../keymap';
import { agentMenuEntries } from '../palette/agentMenu';
import { buildPaletteEntries } from '../palette/entries';

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
		// Only the overlays with a list move a cursor; help is one now that it scrolls.
		expect(resolveAction('help', 'j', NO_KEY)).toBe('moveDown');
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

	describe('the composer context', () => {
		it("sends on Enter, and tells Ink's Enter (which also reports the character \\r) from Alt-Enter", () => {
			// Ink reports a plain Enter as input '\r' with `return` set; ESC then CR arrives as '\r' without it.
			expect(resolveAction('composer', '\r', { ...NO_KEY, return: true })).toBe('send');
			expect(resolveAction('composer', '\r', NO_KEY)).toBe('newline');
			// A bare line feed (Ctrl-J) reaches the handler as '\n' with no flag set.
			expect(resolveAction('composer', '\n', NO_KEY)).toBe('newline');
		});

		it('leaves letters and the editing keys to the text box', () => {
			for (const letter of ['j', 'k', 'q', 't', 'x', 'e', '?', 'T']) {
				expect(resolveAction('composer', letter, NO_KEY), letter).toBeUndefined();
			}
			expect(resolveAction('composer', '', { ...NO_KEY, leftArrow: true })).toBeUndefined();
			expect(resolveAction('composer', 'a', { ...NO_KEY, ctrl: true })).toBeUndefined();
		});

		it('keeps the keys that leave it: Esc, Tab, Ctrl-K, Ctrl-B', () => {
			expect(resolveAction('composer', '', { ...NO_KEY, escape: true })).toBe('blurComposer');
			expect(resolveAction('composer', '', { ...NO_KEY, tab: true })).toBe('nextPane');
			expect(resolveAction('composer', 'k', { ...NO_KEY, ctrl: true })).toBe('palette');
			expect(resolveAction('composer', 'b', { ...NO_KEY, ctrl: true })).toBe('toggleAgentsPane');
		});

		it('writes its keys the way a person reads them', () => {
			expect(keysFor('send')).toBe('Enter');
			expect(keysFor('newline')).toBe('Ctrl-J / Alt-Enter');
			expect(keysFor('interrupt')).toBe('Ctrl-C');
			expect(keysFor('blurComposer')).toBe('Esc');
		});
	});

	it('answers Ctrl-C in every context, so it can always interrupt or quit', () => {
		const contexts: KeyContext[] = [
			'main',
			'composer',
			'composerMention',
			'help',
			'tabs',
			'history',
			'palette',
			'menu',
			'form',
			'prompt',
			'confirm',
			'groupPicker',
			'autoRun',
			'autoRunName',
			'autoRunLaunch',
			'autoRunProgress',
		];
		for (const context of contexts) {
			expect(resolveAction(context, 'c', { ...NO_KEY, ctrl: true }), context).toBe('interrupt');
		}
	});

	describe('the Auto Run screens', () => {
		const type = (context: KeyContext, input: string) => resolveAction(context, input, NO_KEY);

		it('gives one letter a meaning per screen: s starts a run on the list and stops one on the progress screen', () => {
			expect(type('autoRun', 's')).toBe('startRun');
			expect(type('autoRunProgress', 's')).toBe('stopRun');
			expect(type('autoRun', 'g')).toBe('startGoalRun');
			expect(type('autoRun', 'w')).toBe('watchRun');
			expect(type('autoRun', ' ')).toBe('toggleDocument');
			expect(type('autoRunProgress', 'r')).toBe('resumeRun');
			expect(type('autoRunProgress', 'n')).toBe('skipDocument');
			expect(type('autoRunProgress', 'a')).toBe('abortRun');
		});

		it('keeps every letter for typing in the launch form and moves on arrows, Tab, and Ctrl chords', () => {
			for (const letter of ['j', 'k', 's', 'g', 'w', 'n', 'p', ' ']) {
				expect(type('autoRunLaunch', letter), letter).toBeUndefined();
			}
			const form = (key: Partial<Key>, input = '') =>
				resolveAction('autoRunLaunch', input, { ...NO_KEY, ...key });
			expect(form({ downArrow: true })).toBe('moveDown');
			expect(form({ tab: true })).toBe('moveDown');
			expect(form({ tab: true, shift: true })).toBe('moveUp');
			expect(form({ ctrl: true }, 'n')).toBe('moveDown');
			expect(form({ leftArrow: true })).toBe('choicePrev');
			expect(form({ rightArrow: true })).toBe('choiceNext');
			expect(form({ return: true })).toBe('open');
		});

		it('leaves the progress screen to its controls, and every screen leaves on Esc', () => {
			expect(type('autoRunProgress', 'j')).toBeUndefined();
			for (const context of ['autoRun', 'autoRunLaunch', 'autoRunProgress'] as const) {
				expect(resolveAction(context, '', { ...NO_KEY, escape: true }), context).toBe(
					'closeOverlay'
				);
			}
		});

		it('puts the run actions in the agent menu', () => {
			for (const action of ['startRun', 'startGoalRun', 'watchRun'] as const) {
				expect(bindingFor(action).agentMenu, action).toBeTruthy();
			}
		});
	});

	describe('the @ agent picker (XM-1)', () => {
		const pick = (key: Partial<Key>, input = '') =>
			resolveAction('composerMention', input, { ...NO_KEY, ...key });

		it('picks with arrows and Ctrl-N/P, inserts on Tab or Enter, and closes on Esc', () => {
			expect(pick({ downArrow: true })).toBe('moveDown');
			expect(pick({ upArrow: true })).toBe('moveUp');
			expect(pick({ ctrl: true }, 'n')).toBe('moveDown');
			expect(pick({ ctrl: true }, 'p')).toBe('moveUp');
			expect(pick({ tab: true })).toBe('acceptMention');
			expect(pick({ return: true })).toBe('acceptMention');
			expect(pick({ escape: true })).toBe('dismissMention');
		});

		it('keeps every letter for the name being typed, and Enter does not send while it is open', () => {
			for (const letter of ['j', 'k', 'n', 'p', 'd', ' ']) {
				expect(pick({}, letter), letter).toBeUndefined();
			}
			expect(resolveAction('composer', '', { ...NO_KEY, return: true })).toBe('send');
			expect(pick({ return: true })).not.toBe('send');
		});

		it('delegates with Ctrl-D from the composer, picker open or not, and nowhere else', () => {
			expect(resolveAction('composer', 'd', { ...NO_KEY, ctrl: true })).toBe('delegate');
			expect(pick({ ctrl: true }, 'd')).toBe('delegate');
			expect(resolveAction('main', 'd', { ...NO_KEY, ctrl: true })).toBeUndefined();
			expect(bindingFor('delegate').description).toMatch(/work/);
		});

		it('still reaches the palette and the newline key with the picker open', () => {
			expect(pick({ ctrl: true }, 'k')).toBe('palette');
			expect(pick({}, '\n')).toBe('newline');
		});
	});

	describe('the group chat screens', () => {
		const type = (context: KeyContext, input: string) => resolveAction(context, input, NO_KEY);

		it('opens the list with c from the main view, and gives the list its own letters', () => {
			expect(type('main', 'c')).toBe('groupChats');
			expect(type('groupChats', 'n')).toBe('newGroupChat');
			expect(type('groupChats', 'R')).toBe('renameGroupChat');
			expect(type('groupChats', 'X')).toBe('deleteGroupChat');
			expect(type('groupChats', 'r')).toBe('reloadGroupChats');
			expect(type('groupChats', 'j')).toBe('moveDown');
		});

		it('keeps every letter for typing in the form and in an open chat', () => {
			for (const context of ['groupChatForm', 'groupChat'] as const) {
				for (const letter of ['j', 'k', 'n', 'c', 'x', 'R', 'X', ' ']) {
					expect(type(context, letter), `${context} ${letter}`).toBeUndefined();
				}
			}
			const form = (key: Partial<Key>, input = '') =>
				resolveAction('groupChatForm', input, { ...NO_KEY, ...key });
			expect(form({ downArrow: true })).toBe('moveDown');
			expect(form({ tab: true })).toBe('moveDown');
			expect(form({ tab: true, shift: true })).toBe('moveUp');
			expect(form({ leftArrow: true })).toBe('choicePrev');
			expect(form({ rightArrow: true })).toBe('choiceNext');
			expect(form({ ctrl: true }, 's')).toBe('submitForm');
		});

		it('sends on Enter and stops on Ctrl-X in an open chat, which never queues a message', () => {
			const chat = (key: Partial<Key>, input = '') =>
				resolveAction('groupChat', input, { ...NO_KEY, ...key });
			expect(chat({ return: true })).toBe('sendGroupChat');
			expect(chat({ ctrl: true }, 'x')).toBe('stopGroupChat');
			expect(chat({ ctrl: true }, 'c')).toBe('interrupt');
			expect(chat({ upArrow: true })).toBeUndefined();
		});

		it('leaves every screen on Esc', () => {
			for (const context of ['groupChats', 'groupChatForm', 'groupChat'] as const) {
				expect(resolveAction(context, '', { ...NO_KEY, escape: true }), context).toBe(
					'closeOverlay'
				);
			}
		});
	});

	describe('the Encore gate (ST-2)', () => {
		// No shipped binding sits behind a flag yet, so the gate is exercised on a table that has some.
		const gated: readonly Binding[] = KEYMAP.map((binding) =>
			binding.action === 'groupChats' || binding.action === 'startRun'
				? { ...binding, encore: binding.action === 'groupChats' ? 'maestroCue' : 'pianola' }
				: binding
		);

		it('opens the settings view on S, reloads on r, and leaves on Esc', () => {
			expect(resolveAction('main', 'S', NO_KEY)).toBe('settings');
			expect(resolveAction('settings', 'r', NO_KEY)).toBe('reloadSettings');
			expect(resolveAction('settings', 'j', NO_KEY)).toBe('moveDown');
			expect(resolveAction('settings', '', { ...NO_KEY, upArrow: true })).toBe('moveUp');
			expect(resolveAction('settings', '', { ...NO_KEY, escape: true })).toBe('closeOverlay');
		});

		it('drops a binding whose flag is off from key resolution, the palette, help, and the agent menu', () => {
			const live = gatedKeymap({ maestroCue: false, pianola: true }, gated);
			expect(live.some((binding) => binding.action === 'groupChats')).toBe(false);
			expect(live.some((binding) => binding.action === 'startRun')).toBe(true);
			// A dead key: `c` means nothing once its feature is off.
			expect(resolveAction('main', 'c', NO_KEY, live)).toBeUndefined();
			expect(resolveAction('main', 'c', NO_KEY, gated)).toBe('groupChats');
			expect(buildPaletteEntries([], live).some((entry) => entry.label === 'Group chats')).toBe(
				false
			);
			expect(agentMenuEntries(live).some((entry) => entry.action === 'startRun')).toBe(true);
			const both = gatedKeymap({ maestroCue: false, pianola: false }, gated);
			expect(agentMenuEntries(both).some((entry) => entry.action === 'startRun')).toBe(false);
		});

		it('reads a flag the host never held as its default', () => {
			// Cue is on and Pianola is off by default, so a fresh install gates exactly Pianola.
			const live = gatedKeymap(undefined, gated);
			expect(live.some((binding) => binding.action === 'groupChats')).toBe(true);
			expect(live.some((binding) => binding.action === 'startRun')).toBe(false);
		});

		it('hands back the same table when nothing is gated off, so memos on it hold', () => {
			expect(gatedKeymap({}, KEYMAP)).toBe(KEYMAP);
			expect(gatedKeymap(undefined, KEYMAP)).toBe(KEYMAP);
			expect(gatedKeymap({ maestroCue: true, pianola: true }, gated)).toBe(gated);
		});
	});

	it('throws for an action nobody bound, so a typo cannot print an empty hint', () => {
		expect(() => bindingFor('nope' as never)).toThrow('no binding');
	});
});
