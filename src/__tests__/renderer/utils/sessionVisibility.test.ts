/**
 * Tests for sessionVisibility - the predicate deciding which agents the Left Bar
 * (and every keyboard order derived from it) may surface.
 *
 * Tests:
 *   - Ordinary agents are always visible
 *   - The Pianola agent is hidden while its Encore flag is off, visible when on
 *   - filterSessionsVisibleInSidebar returns the same array when nothing is dropped
 */

import { describe, it, expect } from 'vitest';
import {
	filterSessionsVisibleInSidebar,
	isSessionVisibleInSidebar,
	type VisibilityScopableSession,
} from '../../../renderer/utils/sessionVisibility';

/** Sessions carry ids in production; the predicate only reads `isPianola`. */
type TestSession = VisibilityScopableSession & { id: string };

describe('isSessionVisibleInSidebar', () => {
	it('keeps an ordinary agent regardless of the pianola flag', () => {
		expect(isSessionVisibleInSidebar({}, { pianolaEnabled: false })).toBe(true);
		expect(isSessionVisibleInSidebar({}, { pianolaEnabled: true })).toBe(true);
	});

	it('hides the Pianola agent while its Encore flag is off', () => {
		expect(isSessionVisibleInSidebar({ isPianola: true }, { pianolaEnabled: false })).toBe(false);
		expect(isSessionVisibleInSidebar({ isPianola: true }, {})).toBe(false);
	});

	it('shows the Pianola agent once its Encore flag is on', () => {
		expect(isSessionVisibleInSidebar({ isPianola: true }, { pianolaEnabled: true })).toBe(true);
	});
});

describe('filterSessionsVisibleInSidebar', () => {
	const alpha: TestSession = { id: 'a' };
	const pianola: TestSession = { id: 'p', isPianola: true };

	it('drops the Pianola agent while the flag is off', () => {
		expect(filterSessionsVisibleInSidebar([alpha, pianola], { pianolaEnabled: false })).toEqual([
			alpha,
		]);
	});

	it('returns the same array identity when nothing is hidden', () => {
		const sessions = [alpha, pianola];
		// Flag on: no filtering, so memoized consumers keep a stable reference.
		expect(filterSessionsVisibleInSidebar(sessions, { pianolaEnabled: true })).toBe(sessions);
		// Flag off but no Pianola present: still no new array.
		const ordinary: TestSession[] = [alpha];
		expect(filterSessionsVisibleInSidebar(ordinary, { pianolaEnabled: false })).toBe(ordinary);
	});
});
