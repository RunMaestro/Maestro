import { describe, it, expect } from 'vitest';
import { createCueEvent } from '../../../main/cue/cue-types';

describe('createCueEvent', () => {
	it('returns an object with all 5 CueEvent fields', () => {
		const event = createCueEvent('time.heartbeat', 'my-trigger', { foo: 'bar' });
		expect(event).toHaveProperty('id');
		expect(event).toHaveProperty('type');
		expect(event).toHaveProperty('timestamp');
		expect(event).toHaveProperty('triggerName');
		expect(event).toHaveProperty('payload');
	});

	it('generates a valid UUID for id', () => {
		const event = createCueEvent('file.changed', 'watcher');
		expect(event.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
	});

	it('generates a valid ISO timestamp', () => {
		const event = createCueEvent('time.scheduled', 'daily-check');
		const parsed = new Date(event.timestamp).getTime();
		expect(Number.isNaN(parsed)).toBe(false);
		expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});

	it('sets type to the provided event type', () => {
		const event = createCueEvent('github.pull_request', 'pr-watcher');
		expect(event.type).toBe('github.pull_request');
	});

	it('sets triggerName to the provided value', () => {
		const event = createCueEvent('task.pending', 'task-scanner');
		expect(event.triggerName).toBe('task-scanner');
	});

	it('defaults payload to empty object when omitted', () => {
		const event = createCueEvent('time.heartbeat', 'heartbeat');
		expect(event.payload).toEqual({});
	});

	it('includes provided payload values', () => {
		const payload = { interval_minutes: 30, reconciled: true };
		const event = createCueEvent('time.heartbeat', 'heartbeat', payload);
		expect(event.payload).toEqual(payload);
	});

	it('generates a unique id on each call', () => {
		const event1 = createCueEvent('time.heartbeat', 'a');
		const event2 = createCueEvent('time.heartbeat', 'a');
		expect(event1.id).not.toBe(event2.id);
	});
});
