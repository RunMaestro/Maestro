/**
 * Tests for the cadenzaStore reducer + bridge adapter. Cadenzas are the small
 * always-on-top cards an agent opens; `applyCadenzaPayload` is the bridge seam.
 * These pin the open-defaults, the "patch only what was sent" update (so a
 * living-tracker body update doesn't wipe the title), close, and the chip flash.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useCadenzaStore, applyCadenzaPayload } from '../../../renderer/stores/cadenzaStore';

function reset() {
	useCadenzaStore.setState({ cadenzas: [], flashedId: null });
}

describe('applyCadenzaPayload', () => {
	beforeEach(reset);

	it('open applies defaults (tracker type, theme color, id as title)', () => {
		applyCadenzaPayload({ op: 'open', id: 'tests' });
		const c = useCadenzaStore.getState().cadenzas[0];
		expect(c).toMatchObject({ id: 'tests', viewType: 'tracker', color: 'theme', title: 'tests' });
		expect(typeof c.x).toBe('number');
		expect(typeof c.y).toBe('number');
	});

	it('open honors explicit fields', () => {
		applyCadenzaPayload({
			op: 'open',
			id: 'c',
			viewType: 'decision',
			title: 'Ship it?',
			color: 'orange',
			options: [{ label: 'Yes', value: 'yes' }],
		});
		expect(useCadenzaStore.getState().cadenzas[0]).toMatchObject({
			viewType: 'decision',
			title: 'Ship it?',
			color: 'orange',
			options: [{ label: 'Yes', value: 'yes' }],
		});
	});

	it('update patches only the sent fields, leaving title intact on a body-only update', () => {
		applyCadenzaPayload({ op: 'open', id: 'c', title: 'Suite', body: 'running' });
		applyCadenzaPayload({ op: 'update', id: 'c', body: '3/10 passed' });
		expect(useCadenzaStore.getState().cadenzas[0]).toMatchObject({
			title: 'Suite',
			body: '3/10 passed',
		});
	});

	it('re-opening an existing id preserves its position', () => {
		applyCadenzaPayload({ op: 'open', id: 'c' });
		const { x, y } = useCadenzaStore.getState().cadenzas[0];
		applyCadenzaPayload({ op: 'open', id: 'c', title: 'renamed' });
		expect(useCadenzaStore.getState().cadenzas).toHaveLength(1);
		expect(useCadenzaStore.getState().cadenzas[0]).toMatchObject({ x, y, title: 'renamed' });
	});

	it('close removes the cadenza', () => {
		applyCadenzaPayload({ op: 'open', id: 'c' });
		applyCadenzaPayload({ op: 'close', id: 'c' });
		expect(useCadenzaStore.getState().cadenzas).toHaveLength(0);
	});

	it('keeps static plugin view data safe across update and close', () => {
		const id = 'com.acme.metrics/release-summary';
		applyCadenzaPayload({
			op: 'open',
			id,
			viewType: 'view',
			title: 'Release summary',
			body: JSON.stringify({ blocks: [{ kind: 'text', text: 'Initial report' }] }),
			sourcePlugin: 'Acme Metrics',
		});
		applyCadenzaPayload({
			op: 'update',
			id,
			body: JSON.stringify({ blocks: [{ kind: 'text', text: 'Updated report' }] }),
		});

		expect(useCadenzaStore.getState().cadenzas).toMatchObject([
			{
				id,
				viewType: 'view',
				title: 'Release summary',
				sourcePlugin: 'Acme Metrics',
				body: JSON.stringify({ blocks: [{ kind: 'text', text: 'Updated report' }] }),
			},
		]);

		applyCadenzaPayload({ op: 'close', id });
		expect(useCadenzaStore.getState().cadenzas).toHaveLength(0);
	});
});

describe('flashItem', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		reset();
	});
	afterEach(() => {
		vi.clearAllTimers();
		vi.useRealTimers();
	});

	it('pulses the id then clears it after the timeout', () => {
		useCadenzaStore.getState().flashItem('c');
		expect(useCadenzaStore.getState().flashedId).toBe('c');
		vi.advanceTimersByTime(2200);
		expect(useCadenzaStore.getState().flashedId).toBeNull();
	});
});
