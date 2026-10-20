/**
 * Tests for the window's DataviewJS guest slots (src/renderer/services/dataviewJsGuestSlots.ts, R-3): a block
 * gets a guest only near the viewport and only within the cap; past the cap the holder that left the
 * viewport longest ago gives its slot up, and a newcomer waits while every holder is on screen.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	claimDataviewJsGuestSlot,
	resetDataviewJsGuestSlotsForTests,
} from '../../../renderer/services/dataviewJsGuestSlots';
import { DATAVIEW_JS_MAX_GUESTS_PER_WINDOW } from '../../../shared/dataview';

function block() {
	const callbacks = { onGrant: vi.fn(), onEvict: vi.fn() };
	return { callbacks, claim: claimDataviewJsGuestSlot(callbacks) };
}

beforeEach(() => resetDataviewJsGuestSlotsForTests(2));
afterEach(() => resetDataviewJsGuestSlotsForTests());

describe('claimDataviewJsGuestSlot', () => {
	it('defaults to the window cap', () => {
		resetDataviewJsGuestSlotsForTests();
		const blocks = Array.from({ length: DATAVIEW_JS_MAX_GUESTS_PER_WINDOW + 1 }, block);
		for (const { claim } of blocks) claim.setNear(true);
		expect(blocks.filter(({ callbacks }) => callbacks.onGrant.mock.calls.length > 0)).toHaveLength(
			DATAVIEW_JS_MAX_GUESTS_PER_WINDOW
		);
	});

	it('grants nothing to a block that never comes near the viewport', () => {
		const far = block();
		far.claim.setNear(false);
		expect(far.callbacks.onGrant).not.toHaveBeenCalled();
	});

	it('grants a slot at once while one is free, and only once', () => {
		const a = block();
		a.claim.setNear(true);
		a.claim.setNear(true);
		a.claim.setNear(false);
		a.claim.setNear(true);
		expect(a.callbacks.onGrant).toHaveBeenCalledTimes(1);
		expect(a.callbacks.onEvict).not.toHaveBeenCalled();
	});

	it('makes a newcomer wait while every holder is on screen, and grants it when one unmounts', () => {
		const [a, b, c] = [block(), block(), block()];
		a.claim.setNear(true);
		b.claim.setNear(true);
		c.claim.setNear(true);
		expect(c.callbacks.onGrant).not.toHaveBeenCalled();

		b.claim.release();
		expect(c.callbacks.onGrant).toHaveBeenCalledTimes(1);
		expect(a.callbacks.onEvict).not.toHaveBeenCalled();
	});

	it('takes the slot of the holder that left the viewport longest ago', () => {
		const [a, b, c] = [block(), block(), block()];
		a.claim.setNear(true);
		b.claim.setNear(true);
		a.claim.setNear(false);
		b.claim.setNear(false);
		// Both far: nobody waits, so both keep their guests.
		expect(a.callbacks.onEvict).not.toHaveBeenCalled();

		c.claim.setNear(true);
		expect(a.callbacks.onEvict).toHaveBeenCalledTimes(1);
		expect(b.callbacks.onEvict).not.toHaveBeenCalled();
		expect(c.callbacks.onGrant).toHaveBeenCalledTimes(1);
	});

	it('hands a waiting block the slot of a holder the moment it leaves the viewport', () => {
		const [a, b, c] = [block(), block(), block()];
		a.claim.setNear(true);
		b.claim.setNear(true);
		c.claim.setNear(true);
		b.claim.setNear(false);
		expect(b.callbacks.onEvict).toHaveBeenCalledTimes(1);
		expect(c.callbacks.onGrant).toHaveBeenCalledTimes(1);

		// The evicted block asks again when it comes back, and waits its turn.
		b.claim.setNear(true);
		expect(b.callbacks.onGrant).toHaveBeenCalledTimes(1);
		c.claim.release();
		expect(b.callbacks.onGrant).toHaveBeenCalledTimes(2);
	});

	it('drops a waiting block that leaves the viewport or unmounts before its turn', () => {
		const [a, b, c, d] = [block(), block(), block(), block()];
		a.claim.setNear(true);
		b.claim.setNear(true);
		c.claim.setNear(true);
		d.claim.setNear(true);
		c.claim.setNear(false);
		d.claim.release();
		a.claim.release();
		expect(c.callbacks.onGrant).not.toHaveBeenCalled();
		expect(d.callbacks.onGrant).not.toHaveBeenCalled();
	});

	it('ignores calls after release', () => {
		const a = block();
		a.claim.release();
		a.claim.setNear(true);
		a.claim.release();
		expect(a.callbacks.onGrant).not.toHaveBeenCalled();
	});
});
