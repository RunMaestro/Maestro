/**
 * @file queuedTurnSettings.test.ts
 * @description `withQueuedTurnOverrides()`: a Federation sender's own tab chips laid onto the
 * queued item a desktop host builds from its own tab, for that one message.
 */

import { describe, expect, it } from 'vitest';
import { withQueuedTurnOverrides } from '../../shared/queuedTurnSettings';

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

	it('marks the item read-only, but never clears a read-only item', () => {
		expect(withQueuedTurnOverrides(item, { readOnly: true }).readOnlyMode).toBe(true);
		expect(
			withQueuedTurnOverrides({ ...item, readOnlyMode: true }, { readOnly: false }).readOnlyMode
		).toBe(true);
		expect(withQueuedTurnOverrides(item, { readOnly: false }).readOnlyMode).toBe(false);
	});

	it('leaves turnSettings alone when only read-only is overridden', () => {
		expect(withQueuedTurnOverrides(item, { readOnly: true }).turnSettings).toBe(item.turnSettings);
	});
});
