/**
 * Tests for the Cue active-state module.
 *
 * The visibility-aware pause that PR-B 1.4 wires into every scanner.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
	isCueActive,
	setCueActive,
	resetCueActiveForTests,
} from '../../../main/cue/cue-active-state';

describe('cue-active-state', () => {
	beforeEach(() => {
		resetCueActiveForTests();
	});

	it('defaults to active', () => {
		expect(isCueActive()).toBe(true);
	});

	it('flips to inactive when setCueActive(false) is called', () => {
		setCueActive(false);
		expect(isCueActive()).toBe(false);
	});

	it('flips back to active when setCueActive(true) is called', () => {
		setCueActive(false);
		setCueActive(true);
		expect(isCueActive()).toBe(true);
	});

	it('is idempotent — repeated calls preserve the same state', () => {
		setCueActive(false);
		setCueActive(false);
		expect(isCueActive()).toBe(false);
		setCueActive(true);
		setCueActive(true);
		expect(isCueActive()).toBe(true);
	});

	it('resetCueActiveForTests restores the default', () => {
		setCueActive(false);
		resetCueActiveForTests();
		expect(isCueActive()).toBe(true);
	});
});
