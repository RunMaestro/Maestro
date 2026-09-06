/**
 * Tests for shared/focusPlacement - the flag that lets a verb stay out of the
 * human's way, and the guarantee that it changes nothing unless asked.
 *
 * `--background` is ADDITIVE. The risk this file exists to catch is a threading
 * mistake in either direction: a flag that does nothing (the verb still steals
 * focus), or - far more likely and far worse - an absent field read as an
 * opt-in, so an unflagged call silently STOPS focusing and every existing
 * script quietly changes behaviour.
 */

import { describe, it, expect } from 'vitest';
import {
	ALREADY_QUIET_VERBS,
	CLI_BACKGROUND_DEFAULTS,
	isAlreadyQuietVerb,
	resolveBackgroundFlag,
	readBackgroundField,
	readSwitchToAgentField,
	type BackgroundCapableVerb,
} from '../../shared/focusPlacement';

const ALL_VERBS = Object.keys(CLI_BACKGROUND_DEFAULTS) as BackgroundCapableVerb[];

/** Every verb that focuses today and must keep focusing. */
const FOCUSING_TODAY: BackgroundCapableVerb[] = [
	'open-file',
	'open-terminal',
	'open-browser',
	'tab-new',
	'dispatch',
	'create-agent',
	'create-worktree',
	'switch-mode',
	'refresh-auto-run',
];

describe('no verb changes its default', () => {
	it('keeps every verb that focuses today focusing when the flag is absent', () => {
		// The whole point of the amendment: existing scripts, playbooks and Cue
		// prompts must behave exactly as they do now.
		for (const verb of FOCUSING_TODAY) {
			expect(CLI_BACKGROUND_DEFAULTS[verb], verb).toBe(false);
			expect(resolveBackgroundFlag({}, verb), verb).toBe(false);
		}
	});

	it('leaves dispatch --new-tab background, which is what it already does', () => {
		// Not an exception to the rule - it IS the rule. dispatch shipped
		// background-by-default with --focus to opt out, so leaving it alone is the
		// same "keep today's behaviour" call as every row above.
		expect(CLI_BACKGROUND_DEFAULTS['dispatch-new-tab']).toBe(true);
		expect(resolveBackgroundFlag({}, 'dispatch-new-tab')).toBe(true);
	});

	it('keys defaults by verb, since two verbs share one message and disagree', () => {
		// `tab new --prompt` and `dispatch --new-tab` both send
		// new_ai_tab_with_prompt. Keying by message would force one of them to
		// change behaviour.
		expect(resolveBackgroundFlag({}, 'tab-new')).toBe(false);
		expect(resolveBackgroundFlag({}, 'dispatch-new-tab')).toBe(true);
	});

	it('splits dispatch in two, because one command name holds two defaults', () => {
		// Creating a tab the caller will address by id is background; writing into
		// an existing conversation selects the agent, as it does today. Collapsing
		// these onto one key would change one of them.
		expect(resolveBackgroundFlag({}, 'dispatch-new-tab')).toBe(true);
		expect(resolveBackgroundFlag({}, 'dispatch')).toBe(false);
	});
});

describe('verbs that accept the flag and ignore it', () => {
	it('recognises refresh-files as already quiet', () => {
		expect(isAlreadyQuietVerb('refresh-files')).toBe(true);
	});

	it('does not claim a verb that really can move the view', () => {
		// The list is "nothing to suppress", not "we have not wired it yet". A verb
		// that focuses must live in CLI_BACKGROUND_DEFAULTS so the flag DOES
		// something, or `--background` is accepted and silently ignored on a verb
		// that steals the viewport - worse than rejecting it.
		for (const verb of Object.keys(CLI_BACKGROUND_DEFAULTS)) {
			expect(isAlreadyQuietVerb(verb), verb).toBe(false);
		}
	});

	it('rejects anything not on the list', () => {
		expect(isAlreadyQuietVerb('open-file')).toBe(false);
		expect(isAlreadyQuietVerb('')).toBe(false);
		expect(isAlreadyQuietVerb('refresh')).toBe(false);
	});

	it('keeps the two lists disjoint', () => {
		// A verb in both would have a resolved default AND be documented as a
		// no-op, which is a contradiction the CLI help would inherit.
		const negotiable = new Set<string>(Object.keys(CLI_BACKGROUND_DEFAULTS));
		for (const verb of ALREADY_QUIET_VERBS) {
			expect(negotiable.has(verb), verb).toBe(false);
		}
	});
});

describe('resolveBackgroundFlag (CLI side)', () => {
	it('opts into background on every verb', () => {
		for (const verb of ALL_VERBS) {
			expect(resolveBackgroundFlag({ background: true }, verb), verb).toBe(true);
		}
	});

	it('opts into foreground on every verb', () => {
		// A no-op on most verbs today. It ships anyway because a future default
		// flip needs the escape hatch to already exist.
		for (const verb of ALL_VERBS) {
			expect(resolveBackgroundFlag({ focus: true }, verb), verb).toBe(false);
		}
	});

	it('lets --focus win when a script somehow passes both', () => {
		expect(resolveBackgroundFlag({ background: true, focus: true }, 'open-file')).toBe(false);
		expect(resolveBackgroundFlag({ background: true, focus: true }, 'dispatch-new-tab')).toBe(
			false
		);
	});

	it('treats an unset commander option as no preference, not as an opt-out', () => {
		// commander leaves an unset boolean undefined and only sets false for a
		// negated option. Neither may flip a verb off its default.
		for (const verb of ALL_VERBS) {
			const expected = CLI_BACKGROUND_DEFAULTS[verb];
			expect(resolveBackgroundFlag({ background: undefined }, verb), verb).toBe(expected);
			expect(resolveBackgroundFlag({ background: false }, verb), verb).toBe(expected);
			expect(resolveBackgroundFlag({ focus: false }, verb), verb).toBe(expected);
		}
	});
});

describe('readBackgroundField (protocol side)', () => {
	it('is an opt-in: only a literal true counts', () => {
		expect(readBackgroundField({ background: true })).toBe(true);
	});

	it('reads an absent field as today s behaviour', () => {
		// The regression this guards: an older client, the web UI, or any in-app
		// caller that never sets the field must keep focusing. Writing `!== false`
		// here would invert it and silently break every one of them.
		expect(readBackgroundField({})).toBe(false);
		expect(readBackgroundField({ background: undefined })).toBe(false);
	});

	it('reads a non-boolean as no preference rather than guessing', () => {
		for (const value of ['yes', 'true', 'false', 1, 0, null, {}, []]) {
			expect(readBackgroundField({ background: value }), String(value)).toBe(false);
		}
	});
});

describe('readSwitchToAgentField (open_file_tab only)', () => {
	it('defaults to switching, which is the historical behaviour', () => {
		expect(readSwitchToAgentField({})).toBe(true);
		expect(readSwitchToAgentField({ switchToAgent: true })).toBe(true);
	});

	it('honours an explicit false, the --no-switch ask', () => {
		expect(readSwitchToAgentField({ switchToAgent: false })).toBe(false);
	});

	it('is a DIFFERENT question from background, and both survive', () => {
		// --no-switch stays on the current agent but still activates the tab in the
		// target. --background changes nothing rendered anywhere. Folding the first
		// into the second would silently change behaviour for callers already
		// passing it, which is precisely what the no-default-changes rule forbids.
		const noSwitch = { switchToAgent: false };
		expect(readSwitchToAgentField(noSwitch)).toBe(false);
		expect(readBackgroundField(noSwitch)).toBe(false);
	});
});

describe('the two entry points agree', () => {
	it('round-trips whatever the CLI resolved', () => {
		// CLI resolves flags -> puts the bit on the wire -> handler reads it back.
		// A divergence here is a flag that looks accepted and does the opposite.
		for (const verb of ALL_VERBS) {
			for (const flags of [{}, { background: true }, { focus: true }]) {
				const onTheWire = resolveBackgroundFlag(flags, verb);
				expect(readBackgroundField({ background: onTheWire }), verb).toBe(onTheWire);
			}
		}
	});
});
