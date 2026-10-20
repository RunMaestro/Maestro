/**
 * Tests for the Dataview wire codec (src/shared/dataview/wire.ts) and the paths of executeDql that
 * never reach the index (src/shared/dataview/execute.ts). The engine over a real index is covered in
 * engine.test.ts.
 */

import { describe, expect, it } from 'vitest';
import { DateTime, Duration } from 'luxon';
import {
	Link,
	Values,
	Widgets,
	executeDql,
	fromWireValue,
	parseErrorLine,
	reviveDataviewInlineResult,
	reviveDataviewResult,
	toWireValue,
	type DataviewIndexReader,
	type DataviewResult,
	type Literal,
} from '../../../shared/dataview';

/** An index the tested paths must never read. */
const UNREACHABLE_INDEX = new Proxy({} as DataviewIndexReader, {
	get(_target, key) {
		throw new Error(`index.${String(key)} was read`);
	},
});

function overJson<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function expectSameValue(actual: Literal, expected: Literal): void {
	expect(Values.compareValue(actual, expected)).toBe(0);
}

describe('toWireValue and fromWireValue', () => {
	it('keeps primitives as they are', () => {
		for (const value of [null, true, false, 0, 42.5, 'text', '']) {
			expect(toWireValue(value)).toBe(value);
			expect(fromWireValue(overJson(toWireValue(value)))).toBe(value);
		}
		expect(toWireValue(undefined)).toBeNull();
	});

	it('uses the Transferable tags for links, dates, and durations', () => {
		const link = Link.file('People/Rami Example.md', false, 'Rami');
		const date = DateTime.fromISO('2026-09-05T10:30:00');
		const duration = Duration.fromObject({ hours: 2, minutes: 5 });

		expect(toWireValue(link)).toMatchObject({ '___transfer-type': 'link' });
		expect(toWireValue(date)).toMatchObject({ '___transfer-type': 'date' });
		expect(toWireValue(duration)).toMatchObject({ '___transfer-type': 'duration' });

		const revivedLink = fromWireValue(overJson(toWireValue(link)));
		expect(Values.isLink(revivedLink)).toBe(true);
		expect((revivedLink as Link).equals(link)).toBe(true);
		expect((revivedLink as Link).display).toBe('Rami');

		const revivedDate = fromWireValue(overJson(toWireValue(date)));
		expect(Values.isDate(revivedDate)).toBe(true);
		expect((revivedDate as DateTime).toMillis()).toBe(date.toMillis());

		const revivedDuration = fromWireValue(overJson(toWireValue(duration)));
		expect(Values.isDuration(revivedDuration)).toBe(true);
		expectSameValue(revivedDuration, duration);
	});

	it('keeps a date in a fixed zone in that zone', () => {
		const date = DateTime.fromISO('2026-09-05T10:30:00', { zone: 'Asia/Tokyo' });
		const revived = fromWireValue(overJson(toWireValue(date))) as DateTime;
		expect(revived.zoneName).toBe('Asia/Tokyo');
		expect(revived.toMillis()).toBe(date.toMillis());
	});

	it('walks arrays and objects', () => {
		const link = Link.file('Notes/A.md');
		const value = {
			owner: link,
			tags: ['#a', '#b'],
			nested: { when: Duration.fromObject({ days: 1 }) },
		};
		const revived = fromWireValue(overJson(toWireValue(value))) as Record<string, Literal>;
		expect((revived.owner as Link).equals(link)).toBe(true);
		expect(revived.tags).toEqual(['#a', '#b']);
		expect(Values.isDuration((revived.nested as Record<string, Literal>).when)).toBe(true);
	});

	it('carries list-pair and external-link widgets', () => {
		const pair = Widgets.listPair(Link.file('Notes/A.md'), 3);
		const revivedPair = fromWireValue(overJson(toWireValue(pair)));
		expect(Values.isWidget(revivedPair)).toBe(true);
		if (!Values.isWidget(revivedPair) || !Widgets.isListPair(revivedPair))
			throw new Error('not a pair');
		expect((revivedPair.key as Link).path).toBe('Notes/A.md');
		expect(revivedPair.value).toBe(3);

		const elink = Widgets.externalLink('https://example.com', 'Example');
		const revivedLink = fromWireValue(overJson(toWireValue(elink)));
		if (!Values.isWidget(revivedLink) || !Widgets.isExternalLink(revivedLink))
			throw new Error('not a link');
		expect(revivedLink.url).toBe('https://example.com');
		expect(revivedLink.display).toBe('Example');
	});

	it('keeps non-finite numbers and renders functions as upstream does', () => {
		expect(Number.isNaN(fromWireValue(overJson(toWireValue(NaN))) as number)).toBe(true);
		expect(fromWireValue(overJson(toWireValue(-Infinity)))).toBe(-Infinity);
		expect(toWireValue((() => 1) as unknown as Literal)).toBe('<function>');
	});
});

describe('reviveDataviewResult', () => {
	it('revives table cells, list items, and task groups', () => {
		const link = Link.file('People/Pedram Amini.md');
		const table: DataviewResult = {
			kind: 'table',
			headers: ['File', 'Created'],
			rows: [[toWireValue(link), toWireValue(DateTime.fromISO('2026-09-05'))]],
			idMeaning: { type: 'path' },
			warnings: [],
		};
		const revivedTable = reviveDataviewResult(overJson(table));
		if (revivedTable.kind !== 'table') throw new Error('not a table');
		expect((revivedTable.rows[0][0] as Link).equals(link)).toBe(true);
		expect(Values.isDate(revivedTable.rows[0][1])).toBe(true);

		const list: DataviewResult = {
			kind: 'list',
			items: [toWireValue(link)],
			idMeaning: { type: 'path' },
			warnings: [],
		};
		const revivedList = reviveDataviewResult(overJson(list));
		if (revivedList.kind !== 'list') throw new Error('not a list');
		expect(Values.isLink(revivedList.items[0])).toBe(true);

		const tasks: DataviewResult = {
			kind: 'task',
			groups: [
				{
					key: toWireValue(link),
					rows: [toWireValue({ task: true, text: 'Call Rami', link, line: 4 })],
				},
			],
			idMeaning: { type: 'group', name: 'file.link', on: { type: 'path' } },
			warnings: [],
		};
		const revivedTasks = reviveDataviewResult(overJson(tasks));
		if (revivedTasks.kind !== 'task') throw new Error('not tasks');
		const group = revivedTasks.groups[0] as { key: Literal; rows: Literal[] };
		expect(Values.isLink(group.key)).toBe(true);
		expect(Values.isLink((group.rows[0] as Record<string, Literal>).link)).toBe(true);
	});

	it('passes errors, unsupported results, and inline values through', () => {
		const error: DataviewResult = { kind: 'error', message: 'Dataview: boom', line: 2 };
		expect(reviveDataviewResult(error)).toEqual(error);
		expect(reviveDataviewResult({ kind: 'unsupported', feature: 'CALENDAR' })).toEqual({
			kind: 'unsupported',
			feature: 'CALENDAR',
		});
		const inline = reviveDataviewInlineResult({
			kind: 'value',
			value: toWireValue(Link.file('A.md')),
		});
		expect(inline.kind === 'value' && Values.isLink(inline.value)).toBe(true);
	});
});

describe('executeDql without the index', () => {
	it('reports a parse error with the line it stopped on', async () => {
		const result = await executeDql(
			'TABLE a\nFROM "x"\nWHERE a +* 2\nSORT b',
			'Note.md',
			UNREACHABLE_INDEX
		);
		expect(result.kind).toBe('error');
		if (result.kind !== 'error') return;
		expect(result.message).toMatch(/^Dataview: Error: \n-- PARSING FAILED/);
		expect(result.line).toBe(3);
	});

	it('returns CALENDAR as unsupported without running it', async () => {
		await expect(
			executeDql('CALENDAR file.cday\nFROM "meetings"', 'Note.md', UNREACHABLE_INDEX)
		).resolves.toEqual({ kind: 'unsupported', feature: 'CALENDAR' });
	});
});

describe('parseErrorLine', () => {
	it('reads the marked line, or the last line at the end of the input', () => {
		expect(parseErrorLine('  1 | TABLE a\n> 2 | FRM "x"\n    | ^', 'TABLE a\nFRM "x"')).toBe(2);
		expect(parseErrorLine('Got the end of the input', 'TABLE a\nWHERE\n\n')).toBe(2);
		expect(parseErrorLine('something else', 'TABLE a')).toBeUndefined();
	});
});
