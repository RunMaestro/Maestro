/**
 * Tests for the vendored Dataview evaluator (src/shared/dataview/vendor/expression/functions.ts,
 * binaryop.ts, and context.ts) through `evaluateField` and `DataviewSettings`, reached through
 * the one import site, src/shared/dataview/index.ts.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DateTime, Duration, Settings } from 'luxon';
import {
	DEFAULT_QUERY_SETTINGS,
	DataviewSettings,
	Link,
	UNRESOLVED_LINK_HANDLER,
	Values,
	evaluateField,
	parseField,
} from '../../../shared/dataview';
import type { DataObject, LinkHandler, Literal } from '../../../shared/dataview';

// dateformat formats through luxon; pin the locale so month names do not follow the machine.
let previousLocale: string;
beforeAll(() => {
	previousLocale = Settings.defaultLocale;
	Settings.defaultLocale = 'en-US';
});
afterAll(() => {
	Settings.defaultLocale = previousLocale;
});

/** A handler that knows two pages, so `[[B]]` and `[[B.md]]` normalize to the same path. */
const VAULT: Record<string, DataObject> = {
	'B.md': { status: 'done', file: { day: DateTime.fromISO('2024-05-01') } },
	'notes/C.md': { status: 'open' },
};
const vaultHandler: LinkHandler = {
	resolve: (path) => VAULT[vaultHandler.normalize(path)] ?? null,
	normalize: (path) => {
		if (path in VAULT) return path;
		const match = Object.keys(VAULT).find(
			(full) => full === `${path}.md` || full.endsWith(`/${path}.md`)
		);
		return match ?? path;
	},
	exists: (path) => vaultHandler.normalize(path) in VAULT,
};

function run(
	text: string,
	row: Record<string, Literal> = {},
	thisPage?: DataObject,
	linkHandler?: LinkHandler
) {
	return evaluateField(parseField(text).orElseThrow(), row, thisPage, linkHandler);
}

function value(
	text: string,
	row: Record<string, Literal> = {},
	thisPage?: DataObject,
	linkHandler?: LinkHandler
): Literal {
	return run(text, row, thisPage, linkHandler).orElseThrow();
}

describe('DataviewSettings', () => {
	it('holds the upstream defaults', () => {
		expect(DataviewSettings.defaultDateFormat).toBe('MMMM dd, yyyy');
		expect(DataviewSettings.defaultDateTimeFormat).toBe('h:mm a - MMMM dd, yyyy');
		expect(DataviewSettings.renderNullAs).toBe('\\-');
		expect(DataviewSettings.taskCompletionTracking).toBe(false);
		expect(DataviewSettings.inlineQueryPrefix).toBe('=');
		expect(DataviewSettings.inlineJsQueryPrefix).toBe('$=');
		expect(DataviewSettings.dataviewJsKeyword).toBe('dataviewjs');
		expect(DataviewSettings).toMatchObject(DEFAULT_QUERY_SETTINGS);
	});

	it('is frozen', () => {
		expect(Object.isFrozen(DataviewSettings)).toBe(true);
	});
});

describe('evaluateField', () => {
	it('reads row variables by name and binds this', () => {
		const thisPage = { file: { name: 'Home' } };
		expect(value('rating * 2', { rating: 4 }, thisPage)).toBe(8);
		expect(value('this.file.name', {}, thisPage)).toBe('Home');
	});

	it('binds an empty this when no page is given', () => {
		expect(value('this')).toEqual({});
		expect(value('this.file.name')).toBeNull();
	});

	it('reads an unknown variable as null', () => {
		expect(value('missing')).toBeNull();
	});

	it('returns a Failure for an unknown function', () => {
		const result = run('nosuchfn(1)');
		expect(result.successful).toBe(false);
		if (!result.successful) expect(result.error).toBe("Unrecognized function name 'nosuchfn'");
	});

	it('defaults to a link handler that resolves nothing', () => {
		expect(UNRESOLVED_LINK_HANDLER.resolve('B')).toBeNull();
		expect(UNRESOLVED_LINK_HANDLER.normalize('B')).toBe('B');
		expect(UNRESOLVED_LINK_HANDLER.exists('B')).toBe(false);
		expect(value('[[B]].status')).toBeNull();
	});

	it('resolves link fields through the given link handler', () => {
		expect(value('[[B]].status', {}, undefined, vaultHandler)).toBe('done');
		expect(value('[[C]].status', {}, undefined, vaultHandler)).toBe('open');
	});
});

describe('contains', () => {
	it('searches lists, strings, and object keys', () => {
		expect(value('contains(list(1, 2, 3), 2)')).toBe(true);
		expect(value('contains(list(1, 2, 3), 5)')).toBe(false);
		expect(value('contains("hello world", "lo w")')).toBe(true);
		expect(value('contains(object("a", 1), "a")')).toBe(true);
	});

	it('recurses into nested lists', () => {
		expect(value('contains(list(list(1, 2), 3), 2)')).toBe(true);
	});

	it('matches links through the link handler', () => {
		const thisPage = { file: { outlinks: [Link.file('B.md'), Link.file('notes/C.md')] } };
		expect(value('contains(this.file.outlinks, [[B]])', {}, thisPage, vaultHandler)).toBe(true);
		expect(value('contains(this.file.outlinks, [[C]])', {}, thisPage, vaultHandler)).toBe(true);
		expect(value('contains(this.file.outlinks, [[D]])', {}, thisPage, vaultHandler)).toBe(false);
		// Without a resolver, `[[B]]` stays `B` and does not equal `B.md`.
		expect(value('contains(this.file.outlinks, [[B]])', {}, thisPage)).toBe(false);
	});

	it('finds this.file.link in a row field (the spec query shape)', () => {
		const thisPage = { file: { link: Link.file('notes/C.md') } };
		const row = { related: [Link.file('B.md'), Link.file('notes/C.md')] };
		expect(value('contains(related, this.file.link)', row, thisPage, vaultHandler)).toBe(true);
	});
});

describe('date, dur, and dateformat', () => {
	it('parses date literals and strings', () => {
		const d = value('date("2024-03-05")') as DateTime;
		expect(DateTime.isDateTime(d)).toBe(true);
		expect(d.toISODate()).toBe('2024-03-05');
		expect((value('date(2024-03-05T10:30)') as DateTime).hour).toBe(10);
		expect(value('date("not a date")')).toBeNull();
	});

	it('resolves date shorthands', () => {
		const today = value('date(today)') as DateTime;
		expect(today.toISODate()).toBe(DateTime.local().toISODate());
	});

	it('reads a date from a link: its path first, then the page file.day', () => {
		expect((value('date([[2024-02-10]])') as DateTime).toISODate()).toBe('2024-02-10');
		expect((value('date([[B]])', {}, undefined, vaultHandler) as DateTime).toISODate()).toBe(
			'2024-05-01'
		);
		expect(value('date([[B]])')).toBeNull();
	});

	it('builds durations', () => {
		const d = value('dur(2 hours)') as Duration;
		expect(Duration.isDuration(d)).toBe(true);
		expect(d.as('minutes')).toBe(120);
		expect((value('dur("1 day")') as Duration).as('hours')).toBe(24);
	});

	it('formats dates with a luxon pattern', () => {
		expect(value('dateformat(date("2024-03-05"), "yyyy-MM-dd")')).toBe('2024-03-05');
		expect(value('dateformat(date("2024-03-05"), "MMMM d")')).toBe('March 5');
	});

	it('adds a duration to a date', () => {
		const d = value('date("2024-03-05") + dur(1 day)') as DateTime;
		expect(d.toISODate()).toBe('2024-03-06');
	});
});

describe('length', () => {
	it('counts lists, strings, object keys, and null', () => {
		expect(value('length(list(1, 2, 3))')).toBe(3);
		expect(value('length("abcd")')).toBe(4);
		expect(value('length(object("a", 1, "b", 2))')).toBe(2);
		expect(value('length(null)')).toBe(0);
	});
});

describe('filter, map, and join', () => {
	it('filters with a lambda', () => {
		expect(value('filter(list(1, 2, 3, 4), (x) => x > 2)')).toEqual([3, 4]);
	});

	it('maps with a lambda', () => {
		expect(value('map(list(1, 2, 3), (x) => x * 10)')).toEqual([10, 20, 30]);
	});

	it('joins with a separator or the default ", "', () => {
		expect(value('join(list(1, 2, 3), "-")')).toBe('1-2-3');
		expect(value('join(list("a", "b"))')).toBe('a, b');
	});
});

describe('regextest', () => {
	it('tests a pattern anywhere in the string', () => {
		expect(value('regextest("\\\\d+", "abc123")')).toBe(true);
		expect(value('regextest("^\\\\d+$", "abc123")')).toBe(false);
	});

	it('is false for null on either side', () => {
		expect(value('regextest("a", null)')).toBe(false);
		expect(value('regextest(null, "a")')).toBe(false);
	});
});

describe('choice and default', () => {
	it('picks by truthiness', () => {
		expect(value('choice(true, "yes", "no")')).toBe('yes');
		expect(value('choice(0, "yes", "no")')).toBe('no');
		expect(value('choice(missing, "yes", "no")')).toBe('no');
	});

	it('replaces null only', () => {
		expect(value('default(missing, 5)')).toBe(5);
		expect(value('default(0, 5)')).toBe(0);
		expect(value('default(list(1, null), 9)')).toEqual([1, 9]);
	});
});

describe('link and meta', () => {
	it('builds a file link, normalized through the handler', () => {
		const link = value('link("C")', {}, undefined, vaultHandler) as Link;
		expect(Values.isLink(link)).toBe(true);
		expect(link.path).toBe('notes/C.md');
		const titled = value('link("B", "Bee")', {}, undefined, vaultHandler) as Link;
		expect(titled.path).toBe('B.md');
		expect(titled.display).toBe('Bee');
	});

	it('keeps the written path without a resolver', () => {
		expect((value('link("C")') as Link).path).toBe('C');
	});

	it('exposes link metadata', () => {
		expect(value('meta([[Page#Heading|Shown]])')).toEqual({
			display: 'Shown',
			embed: false,
			path: 'Page',
			subpath: 'Heading',
			type: 'header',
		});
		expect(value('meta([[Page]]).subpath')).toBeNull();
	});
});

describe('typeof', () => {
	it('names the type of each literal', () => {
		expect(value('typeof(1)')).toBe('number');
		expect(value('typeof("a")')).toBe('string');
		expect(value('typeof(true)')).toBe('boolean');
		expect(value('typeof(null)')).toBe('null');
		expect(value('typeof(list(1))')).toBe('array');
		expect(value('typeof(object("a", 1))')).toBe('object');
		expect(value('typeof([[A]])')).toBe('link');
		expect(value('typeof(date(today))')).toBe('date');
		expect(value('typeof(dur(1 day))')).toBe('duration');
	});
});

describe('null handling', () => {
	it('treats null as the smallest value in comparisons', () => {
		expect(value('missing < 1')).toBe(true);
		expect(value('missing = null')).toBe(true);
		expect(value('missing != 1')).toBe(true);
	});

	it('propagates null through null-on-null arithmetic and date math', () => {
		expect(value('missing + missing')).toBeNull();
		expect(value('date("2024-03-05") + missing')).toBeNull();
	});

	it('fails on arithmetic with no null implementation', () => {
		const result = run('missing * "a"');
		expect(result.successful).toBe(false);
	});
});

describe('binaryop comparisons', () => {
	it('compares strings', () => {
		expect(value('"apple" < "banana"')).toBe(true);
		expect(value('"a" = "a"')).toBe(true);
		expect(value('"a" + "b"')).toBe('ab');
	});

	it('compares and combines numbers', () => {
		expect(value('2 > 1')).toBe(true);
		expect(value('2 >= 2')).toBe(true);
		expect(value('7 % 3')).toBe(1);
		expect(value('"n" + 1')).toBe('n1');
	});

	it('compares dates and durations', () => {
		expect(value('date("2024-01-01") < date("2024-02-01")')).toBe(true);
		expect(value('date("2024-01-01") = date("2024-01-01")')).toBe(true);
		expect(value('dur(1 day) > dur(2 hours)')).toBe(true);
		const diff = value('date("2024-01-03") - date("2024-01-01")') as Duration;
		expect(diff.as('days')).toBe(2);
	});

	it('compares links through the link handler', () => {
		expect(value('[[B]] = [[B.md]]', {}, undefined, vaultHandler)).toBe(true);
		expect(value('[[B]] = [[B.md]]')).toBe(false);
	});

	it('combines booleans', () => {
		expect(value('true & false')).toBe(false);
		expect(value('true | false')).toBe(true);
		expect(value('!false')).toBe(true);
	});
});
