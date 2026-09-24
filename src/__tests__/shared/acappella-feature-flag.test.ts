/**
 * @file acappella-feature-flag.test.ts
 *
 * The one reader of the A Cappella Encore flag.
 *
 * Contracts defended:
 * - Only the literal `true` counts. This is the whole reason the helper exists:
 *   five hand-rolled copies of `flags.aCappella === true` is five chances for one
 *   of them to drift into truthiness, and the surfaces that read it (IPC, hotkeys,
 *   the signaling adapter, the transport, the debug collector) each control a real
 *   resource - a microphone, a global shortcut, a Bonjour advert.
 * - A missing, null, or malformed `encoreFeatures` blob reads as OFF rather than
 *   throwing. It is read on paths that run before any settings have been written.
 * - The gate throws a stable error string, not a sentence.
 */

import { describe, it, expect } from 'vitest';

import {
	ACAPPELLA_DISABLED_ERROR,
	isACappellaEnabled,
	requireACappellaEnabled,
} from '../../shared/acappella/feature-flag';

/** A settings store that answers with whatever it was handed. */
function storeOf(encoreFeatures: unknown) {
	return {
		get: (key: string, defaultValue?: unknown) =>
			key === 'encoreFeatures' ? encoreFeatures : defaultValue,
	};
}

describe('isACappellaEnabled', () => {
	it('is true only for the literal true', () => {
		expect(isACappellaEnabled(storeOf({ aCappella: true }))).toBe(true);
	});

	it.each([
		['string "true"', 'true'],
		['number 1', 1],
		['an object', {}],
		['the string "on"', 'on'],
	])('reads a truthy %s as OFF', (_label, value) => {
		// The safe direction for a flag whose "on" state opens a capture device and
		// puts the machine on the network. A hand-edited settings file must not be
		// able to half-enable it.
		expect(isACappellaEnabled(storeOf({ aCappella: value }))).toBe(false);
	});

	it.each([
		['false', false],
		['undefined', undefined],
		['null', null],
	])('reads %s as off', (_label, value) => {
		expect(isACappellaEnabled(storeOf({ aCappella: value }))).toBe(false);
	});

	it.each([
		['an absent key', {}],
		['null', null],
		['a string', 'nonsense'],
		['a number', 7],
	])('survives %s where the flag blob should be', (_label, blob) => {
		expect(isACappellaEnabled(storeOf(blob))).toBe(false);
	});
});

describe('requireACappellaEnabled', () => {
	it('passes through when the flag is on', () => {
		expect(() => requireACappellaEnabled(storeOf({ aCappella: true }))).not.toThrow();
	});

	it('throws the stable error code, not prose', () => {
		// The renderer maps this string. A channel that answered with a sentence
		// would make the copy a wire contract.
		expect(() => requireACappellaEnabled(storeOf({}))).toThrow(ACAPPELLA_DISABLED_ERROR);
		expect(ACAPPELLA_DISABLED_ERROR).toBe('ACappellaDisabled');
	});
});
