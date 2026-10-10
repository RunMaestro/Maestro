import { describe, it, expect } from 'vitest';
import { buildRenderedIdMap } from '../../../../renderer/components/TerminalOutput/utils/renderedLogIds';
import type { LogEntry } from '../../../../renderer/types';

function log(id: string, source: LogEntry['source'] = 'stdout'): LogEntry {
	return { id, text: id, source, timestamp: 0 } as LogEntry;
}

describe('buildRenderedIdMap', () => {
	it('maps a 1:1 transcript to itself', () => {
		const logs = [log('user-1', 'user'), log('resp-1')];
		const map = buildRenderedIdMap(logs, logs);
		expect(map.get('user-1')).toBe('user-1');
		expect(map.get('resp-1')).toBe('resp-1');
	});

	it('resolves entries folded into a collapsed response group to the group row', () => {
		const original = [log('user-1', 'user'), log('resp-1'), log('resp-2'), log('resp-3')];
		// collapseAiResponseLogs keeps the FIRST entry's id for the merged row.
		const rendered = [log('user-1', 'user'), log('resp-1')];

		const map = buildRenderedIdMap(rendered, original);
		expect(map.get('resp-1')).toBe('resp-1');
		expect(map.get('resp-2')).toBe('resp-1');
		expect(map.get('resp-3')).toBe('resp-1');
	});

	it('resolves a filtered-out tool entry to the preceding visible row', () => {
		// Thinking off drops tool entries entirely; a hit inside one should still
		// land the user next to it rather than resolving to nothing.
		const original = [log('user-1', 'user'), log('tool-1', 'tool'), log('resp-1')];
		const rendered = [log('user-1', 'user'), log('resp-1')];

		const map = buildRenderedIdMap(rendered, original);
		expect(map.get('tool-1')).toBe('user-1');
		expect(map.get('resp-1')).toBe('resp-1');
	});

	it('leaves entries before the first rendered row unmapped', () => {
		const original = [log('dropped-1'), log('resp-1')];
		const rendered = [log('resp-1')];

		const map = buildRenderedIdMap(rendered, original);
		expect(map.has('dropped-1')).toBe(false);
		expect(map.get('resp-1')).toBe('resp-1');
	});

	it('returns an empty map when nothing renders', () => {
		expect(buildRenderedIdMap([], [log('resp-1')]).size).toBe(0);
	});
});
