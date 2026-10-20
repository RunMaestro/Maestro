/**
 * Tests for the vendored Dataview value model (src/shared/dataview/vendor/data-model/value.ts),
 * reached through the one import site, src/shared/dataview/index.ts.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DateTime, Duration, Settings } from 'luxon';
import {
	DEFAULT_QUERY_SETTINGS,
	ExternalLinkWidget,
	Groupings,
	Link,
	ListPairWidget,
	Values,
	Widgets,
} from '../../../shared/dataview';

// Values.toString renders dates and durations through luxon, which follows the default locale.
let previousLocale: string;
beforeAll(() => {
	previousLocale = Settings.defaultLocale;
	Settings.defaultLocale = 'en-US';
});
afterAll(() => {
	Settings.defaultLocale = previousLocale;
});

describe('Values.typeOf', () => {
	it('names every literal type', () => {
		expect(Values.typeOf(null)).toBe('null');
		expect(Values.typeOf(undefined)).toBe('null');
		expect(Values.typeOf(3)).toBe('number');
		expect(Values.typeOf('hi')).toBe('string');
		expect(Values.typeOf(true)).toBe('boolean');
		expect(Values.typeOf(DateTime.fromISO('2026-09-01'))).toBe('date');
		expect(Values.typeOf(Duration.fromObject({ days: 1 }))).toBe('duration');
		expect(Values.typeOf(Link.file('a.md'))).toBe('link');
		expect(Values.typeOf([1, 2])).toBe('array');
		expect(Values.typeOf({ a: 1 })).toBe('object');
		expect(Values.typeOf(() => 1)).toBe('function');
		expect(Values.typeOf(Widgets.listPair('k', 'v'))).toBe('widget');
	});

	it('does not report html without a DOM (main and the CLI)', () => {
		expect(Values.isHtml({ outerHTML: '<b>x</b>' })).toBe(false);
	});
});

describe('Values.compareValue', () => {
	it('orders nulls first and treats undefined as null', () => {
		expect(Values.compareValue(null, null)).toBe(0);
		// The vendored code accepts undefined at runtime even though Literal excludes it.
		expect(Values.compareValue(undefined as unknown as null, null)).toBe(0);
		expect(Values.compareValue(null, 1)).toBe(-1);
		expect(Values.compareValue(1, null)).toBe(1);
	});

	it('orders different types by type name', () => {
		// "number" < "string" alphabetically.
		expect(Values.compareValue(5, 'a')).toBeLessThan(0);
		expect(Values.compareValue('a', 5)).toBeGreaterThan(0);
		// "boolean" < "date".
		expect(Values.compareValue(true, DateTime.now())).toBeLessThan(0);
	});

	it('compares within numbers, strings, and booleans', () => {
		expect(Values.compareValue(1, 2)).toBe(-1);
		expect(Values.compareValue(2, 2)).toBe(0);
		expect(Values.compareValue(3, 2)).toBe(1);
		expect(Values.compareValue('apple', 'banana')).toBeLessThan(0);
		expect(Values.compareValue(false, true)).toBe(-1);
		expect(Values.compareValue(true, false)).toBe(1);
	});

	it('compares dates and durations chronologically', () => {
		const early = DateTime.fromISO('2026-01-01');
		const late = DateTime.fromISO('2026-06-01');
		expect(Values.compareValue(early, late)).toBe(-1);
		expect(Values.compareValue(late, early)).toBe(1);
		expect(Values.compareValue(early, DateTime.fromISO('2026-01-01'))).toBe(0);
		const short = Duration.fromObject({ hours: 1 });
		const long = Duration.fromObject({ hours: 2 });
		expect(Values.compareValue(short, long)).toBe(-1);
		expect(Values.compareValue(long, short)).toBe(1);
		expect(Values.compareValue(short, Duration.fromObject({ hours: 1 }))).toBe(0);
		// Upstream quirk, kept for fidelity: luxon's equals() compares unit by unit, so the same
		// length in different units is "not less" and "not equal", which sorts it after.
		expect(Values.compareValue(short, Duration.fromObject({ minutes: 60 }))).toBe(1);
	});

	it('compares arrays element-wise, then by length', () => {
		expect(Values.compareValue([1, 2], [1, 3])).toBeLessThan(0);
		expect(Values.compareValue([1, 2], [1, 2])).toBe(0);
		expect(Values.compareValue([1, 2, 3], [1, 2])).toBeGreaterThan(0);
	});

	it('compares objects by sorted keys, then values', () => {
		expect(Values.compareValue({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(0);
		expect(Values.compareValue({ a: 1 }, { a: 2 })).toBeLessThan(0);
		expect(Values.compareValue({ a: 1 }, { b: 1 })).toBeLessThan(0);
	});

	it('compares links by path, then type, then subpath, through the normalizer', () => {
		expect(Values.compareValue(Link.file('a.md'), Link.file('b.md'))).toBeLessThan(0);
		expect(Values.compareValue(Link.file('a.md'), Link.file('a.md', false, 'Alias'))).toBe(0);
		expect(Values.compareValue(Link.file('a.md'), Link.header('a.md', 'Intro'))).not.toBe(0);
		expect(Values.compareValue(Link.block('a.md', 'x1'), Link.block('a.md', 'x2'))).toBeLessThan(0);
		const lower = (p: string) => p.toLowerCase();
		expect(Values.compareValue(Link.file('A.md'), Link.file('a.md'), lower)).toBe(0);
	});
});

describe('Values.toString and isTruthy', () => {
	it('renders null with renderNullAs and dates with the default formats', () => {
		expect(Values.toString(null)).toBe(DEFAULT_QUERY_SETTINGS.renderNullAs);
		expect(Values.toString(DateTime.fromObject({ year: 2026, month: 9, day: 1 }))).toBe(
			'September 01, 2026'
		);
		expect(
			Values.toString(DateTime.fromObject({ year: 2026, month: 9, day: 1, hour: 14, minute: 5 }))
		).toBe('2:05 PM - September 01, 2026');
	});

	it('renders durations minimally and arrays and objects recursively', () => {
		expect(Values.toString(Duration.fromObject({ hours: 3, minutes: 0 }))).toBe('3 hours');
		expect(Values.toString([1, 'a', [2]])).toBe('1, a, [2]');
		expect(Values.toString({ k: 1 })).toBe('{ k: 1 }');
	});

	it('treats empty values as falsy', () => {
		expect(Values.isTruthy('')).toBe(false);
		expect(Values.isTruthy(0)).toBe(false);
		expect(Values.isTruthy([])).toBe(false);
		expect(Values.isTruthy(null)).toBe(false);
		expect(Values.isTruthy('x')).toBe(true);
		expect(Values.isTruthy([0])).toBe(true);
		expect(Values.isTruthy(Link.file('a.md'))).toBe(true);
	});
});

describe('Link', () => {
	it('is equal on path, type, and subpath, ignoring display and embed', () => {
		const a = Link.file('notes/a.md');
		expect(a.equals(Link.file('notes/a.md', true, 'Alias'))).toBe(true);
		expect(a.equals(Link.file('notes/b.md'))).toBe(false);
		expect(a.equals(Link.header('notes/a.md', 'Intro'))).toBe(false);
		expect(Link.header('a.md', 'Intro').equals(Link.header('a.md', 'Intro'))).toBe(true);
		expect(Link.block('a.md', 'id1').equals(Link.block('a.md', 'id2'))).toBe(false);
	});

	it('withPath returns a new link at the new path and keeps the rest', () => {
		const original = Link.header('old/a.md', 'Intro', true, 'Shown');
		const moved = original.withPath('new/a.md');
		expect(moved).toBeInstanceOf(Link);
		expect(moved).not.toBe(original);
		expect(moved.path).toBe('new/a.md');
		expect(moved.type).toBe('header');
		expect(moved.subpath).toBe('Intro');
		expect(moved.display).toBe('Shown');
		expect(moved.embed).toBe(true);
		expect(original.path).toBe('old/a.md');
		expect(moved.equals(Link.header('new/a.md', 'Intro'))).toBe(true);
	});

	it('infers file, header, and block links from a link path', () => {
		expect(Link.infer('a.md').type).toBe('file');
		const header = Link.infer('a.md#Intro');
		expect([header.type, header.path, header.subpath]).toEqual(['header', 'a.md', 'Intro']);
		const block = Link.infer('a.md#^abc');
		expect([block.type, block.path, block.subpath]).toEqual(['block', 'a.md', 'abc']);
	});

	it('renders Obsidian markdown and escapes pipes in the path', () => {
		expect(Link.file('notes/Page.md').markdown()).toBe('[[notes/Page.md|Page]]');
		expect(Link.file('notes/Page.md', true, 'Alias').markdown()).toBe('![[notes/Page.md|Alias]]');
		expect(Link.header('Page.md', 'Intro').markdown()).toBe('[[Page.md#Intro|Page > Intro]]');
		expect(Link.block('Page.md', 'abc').obsidianLink()).toBe('Page.md#^abc');
		expect(Link.file('a|b.md').obsidianLink()).toBe('a\\|b.md');
		expect(Link.file('notes/Page.md').fileName()).toBe('Page');
	});

	it('round-trips through toObject and fromObject, and converts embeds', () => {
		const link = Link.block('a.md', 'abc', false, 'D');
		const copy = Link.fromObject(link.toObject());
		expect(copy.equals(link)).toBe(true);
		expect(copy.display).toBe('D');
		const embed = link.toEmbed();
		expect(embed.embed).toBe(true);
		expect(link.embed).toBe(false);
		expect(embed.fromEmbed().embed).toBe(false);
		expect(link.withHeader('Intro').type).toBe('header');
		expect(Link.header('a.md', 'Intro').toFile().type).toBe('file');
	});
});

describe('Widgets', () => {
	it('builds list-pair and external-link widgets and identifies them', () => {
		const pair = Widgets.listPair('key', 3);
		expect(pair).toBeInstanceOf(ListPairWidget);
		expect(Widgets.isListPair(pair)).toBe(true);
		expect(Widgets.isExternalLink(pair)).toBe(false);
		expect(Widgets.isBuiltin(pair)).toBe(true);
		expect(pair.markdown()).toBe('key: 3');

		const ext = Widgets.externalLink('https://example.com', 'Example');
		expect(ext).toBeInstanceOf(ExternalLinkWidget);
		expect(Widgets.isExternalLink(ext)).toBe(true);
		expect(ext.markdown()).toBe('[Example](https://example.com)');
		expect(Widgets.externalLink('https://example.com').markdown()).toBe(
			'[https://example.com](https://example.com)'
		);
		expect(Values.toString(pair)).toBe('key: 3');
	});
});

describe('Groupings', () => {
	it('detects groupings and counts their leaves', () => {
		const grouped = [
			{ key: 'a', rows: [1, 2] },
			{ key: 'b', rows: [{ key: 'c', rows: [3] }] },
		];
		expect(Groupings.isGrouping(grouped)).toBe(true);
		expect(Groupings.isGrouping([1, 2])).toBe(false);
		expect(Groupings.count(grouped)).toBe(3);
	});
});
