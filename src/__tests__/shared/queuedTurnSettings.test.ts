/**
 * @file queuedTurnSettings.test.ts
 * @description `withQueuedTurnOverrides()`: a Federation sender's own tab chips laid onto the
 * queued item a desktop host builds from its own tab, for that one message; and
 * `queuedItemRunsReadOnly()`, the one read-only rule every dispatch path asks.
 */

import { describe, expect, it } from 'vitest';
import { queuedItemRunsReadOnly, withQueuedTurnOverrides } from '../../shared/queuedTurnSettings';

const item = {
	id: 'q1',
	turnSettings: { model: 'sonnet', effort: 'low' },
	readOnlyMode: false,
};

describe('withQueuedTurnOverrides', () => {
	it('returns the item untouched without overrides', () => {
		expect(withQueuedTurnOverrides(item, undefined)).toBe(item);
	});

	it('replaces the captured model and effort, one at a time', () => {
		expect(withQueuedTurnOverrides(item, { model: 'opus' }).turnSettings).toEqual({
			model: 'opus',
			effort: 'low',
		});
		expect(withQueuedTurnOverrides(item, { effort: 'high' }).turnSettings).toEqual({
			model: 'sonnet',
			effort: 'high',
		});
		// The item it was built from is not changed.
		expect(item.turnSettings).toEqual({ model: 'sonnet', effort: 'low' });
	});

	it('records the sender read-only choice either way, so it can lift the tab chip', () => {
		const on = withQueuedTurnOverrides(item, { readOnly: true });
		expect(on).toMatchObject({ readOnlyMode: true, turnReadOnly: true });
		const off = withQueuedTurnOverrides({ ...item, readOnlyMode: true }, { readOnly: false });
		expect(off).toMatchObject({ readOnlyMode: false, turnReadOnly: false });
		expect(withQueuedTurnOverrides(item, { model: 'opus' })).not.toHaveProperty('turnReadOnly');
	});

	it('records the sender save to History choice', () => {
		expect(withQueuedTurnOverrides(item, { saveToHistory: false }).turnSaveToHistory).toBe(false);
		expect(withQueuedTurnOverrides(item, { saveToHistory: true }).turnSaveToHistory).toBe(true);
		expect(withQueuedTurnOverrides(item, { model: 'opus' })).not.toHaveProperty(
			'turnSaveToHistory'
		);
	});

	it('leaves turnSettings alone when only read-only is overridden', () => {
		expect(withQueuedTurnOverrides(item, { readOnly: true }).turnSettings).toBe(item.turnSettings);
	});
});

describe('queuedItemRunsReadOnly', () => {
	const readOnlyTab = { readOnlyMode: true };
	const planTab = { permissionMode: 'readonly' };
	const openTab = { readOnlyMode: false, permissionMode: 'full' };

	it('follows the item flag or the tab when the sender made no choice', () => {
		expect(queuedItemRunsReadOnly({}, openTab)).toBe(false);
		expect(queuedItemRunsReadOnly({ readOnlyMode: true }, openTab)).toBe(true);
		expect(queuedItemRunsReadOnly({}, readOnlyTab)).toBe(true);
		expect(queuedItemRunsReadOnly({ readOnlyMode: false }, planTab)).toBe(true);
		expect(queuedItemRunsReadOnly(undefined, undefined)).toBe(false);
	});

	it('lets the sender choice decide over the tab, both ways', () => {
		expect(queuedItemRunsReadOnly({ turnReadOnly: false, readOnlyMode: false }, readOnlyTab)).toBe(
			false
		);
		expect(queuedItemRunsReadOnly({ turnReadOnly: false }, planTab)).toBe(false);
		expect(queuedItemRunsReadOnly({ turnReadOnly: true }, openTab)).toBe(true);
	});
});
