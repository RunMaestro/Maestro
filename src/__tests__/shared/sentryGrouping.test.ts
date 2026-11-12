/**
 * Tests for v8OomFingerprint - one Sentry issue per process type for V8 OOM
 * minidumps, instead of one per allocation site that happened to fail (#1862).
 */

import { describe, it, expect } from 'vitest';
import { v8OomFingerprint } from '../../shared/sentryGrouping';

/** A minidump event as @sentry/electron hands it to beforeSend. */
function minidumpEvent(annotations: Record<string, string>, tags: Record<string, string> = {}) {
	const electron = Object.fromEntries(
		Object.entries(annotations).map(([key, value]) => [`crashpad.${key}`, value])
	);
	return { contexts: { electron }, tags };
}

describe('v8OomFingerprint', () => {
	it('groups a main-process heap OOM by its process type', () => {
		const event = minidumpEvent({
			'electron.v8-oom.is_heap_oom': '1',
			'electron.v8-oom.location': 'CALL_AND_RETRY_LAST',
			process_type: 'browser',
		});
		expect(v8OomFingerprint(event)).toEqual(['v8-oom', 'browser']);
	});

	it('keeps renderer OOMs in their own group', () => {
		const event = minidumpEvent({ 'electron.v8-oom.is_heap_oom': '1', process_type: 'renderer' });
		expect(v8OomFingerprint(event)).toEqual(['v8-oom', 'renderer']);
	});

	it('includes a V8 OOM that is not a heap OOM', () => {
		const event = minidumpEvent({ 'electron.v8-oom.is_heap_oom': '0', process_type: 'browser' });
		expect(v8OomFingerprint(event)).toEqual(['v8-oom', 'browser']);
	});

	it('falls back to the event.process tag, then to unknown', () => {
		const tagged = minidumpEvent(
			{ 'electron.v8-oom.is_heap_oom': '1' },
			{ 'event.process': 'gpu' }
		);
		expect(v8OomFingerprint(tagged)).toEqual(['v8-oom', 'gpu']);
		expect(v8OomFingerprint(minidumpEvent({ 'electron.v8-oom.is_heap_oom': '1' }))).toEqual([
			'v8-oom',
			'unknown',
		]);
	});

	it('names the GPU process one way whichever spelling reached it', () => {
		// Crashpad says `gpu-process`; the SDK's child-process-gone path says `GPU`.
		const fromAnnotation = minidumpEvent({
			'electron.v8-oom.is_heap_oom': '1',
			process_type: 'gpu-process',
		});
		const fromSdkTag = minidumpEvent(
			{ 'electron.v8-oom.is_heap_oom': '1' },
			{ 'event.process': 'GPU' }
		);
		expect(v8OomFingerprint(fromAnnotation)).toEqual(['v8-oom', 'gpu']);
		expect(v8OomFingerprint(fromSdkTag)).toEqual(['v8-oom', 'gpu']);
	});

	it('skips a blank process_type and uses the event.process tag', () => {
		const event = minidumpEvent(
			{ 'electron.v8-oom.is_heap_oom': '1', process_type: ' ' },
			{ 'event.process': 'renderer' }
		);
		expect(v8OomFingerprint(event)).toEqual(['v8-oom', 'renderer']);
	});

	it('groups a startup minidump shaped like MAESTRO-174, whatever the OOM location', () => {
		// The shape @sentry/electron hands beforeSend for a minidump found at the next
		// launch: the SDK's native tags plus the Crashpad annotations, no stack yet.
		const event = (location: string) => ({
			level: 'fatal',
			platform: 'native',
			tags: { 'event.environment': 'native', 'event.process': 'browser' },
			contexts: {
				electron: {
					'crashpad.electron.v8-oom.is_heap_oom': '1',
					'crashpad.electron.v8-oom.location': location,
					'crashpad.process_type': 'browser',
				},
			},
		});
		expect(v8OomFingerprint(event('Ineffective mark-compacts near heap limit'))).toEqual([
			'v8-oom',
			'browser',
		]);
		expect(v8OomFingerprint(event('Reached heap limit'))).toEqual(['v8-oom', 'browser']);
	});

	it('leaves every other event to default grouping', () => {
		expect(v8OomFingerprint({})).toBeUndefined();
		expect(v8OomFingerprint(minidumpEvent({ process_type: 'browser' }))).toBeUndefined();
		expect(v8OomFingerprint({ contexts: { electron: { details: 'crashed' } } })).toBeUndefined();
	});
});
