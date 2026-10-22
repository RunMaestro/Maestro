/**
 * Tests for the Dataview JSON codec (src/shared/dataview/json.ts) and the raw/finish split of `parsePage`
 * (src/shared/dataview/page.ts): a raw page that goes through `Transferable` and JSON, then is finished,
 * equals the page `parsePage` builds directly. This is the path every disk-cached page takes (DV-5).
 */

import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
	Transferable,
	createLinkResolver,
	dataviewJsonReplacer,
	dataviewJsonReviver,
	finishPage,
	parsePage,
	parseRawPage,
} from '../../../shared/dataview';

const VAULT = path.join(__dirname, '..', '..', 'fixtures', 'dataview-vault');

function listVault(dir = VAULT): string[] {
	const out: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (entry.name.startsWith('.')) continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...listVault(full));
		else out.push(path.relative(VAULT, full).split(path.sep).join('/'));
	}
	return out.sort();
}

const roundTrip = (value: unknown) =>
	JSON.parse(JSON.stringify(value, dataviewJsonReplacer), dataviewJsonReviver);

describe('dataviewJsonReplacer and dataviewJsonReviver', () => {
	it('round-trip Map and Set at any depth', () => {
		const value = {
			fields: new Map<string, unknown>([
				['tags', new Set(['#a', '#b'])],
				['nested', { inner: new Map([[1, [new Set([2])]]]) }],
			]),
			plain: [1, 'two', null, { three: true }],
		};
		expect(roundTrip(value)).toEqual(value);
	});

	it('leave values without collections as ordinary JSON', () => {
		const value = { a: [1, 2], b: { c: 'd' } };
		expect(JSON.stringify(value, dataviewJsonReplacer)).toBe(JSON.stringify(value));
	});

	it('leave an object that only looks tagged alone when its value is not an array', () => {
		const value = { '___maestro-json': 'map', value: 'not entries' };
		expect(roundTrip(value)).toEqual(value);
	});
});

describe('parseRawPage plus finishPage', () => {
	const files = listVault();
	const resolver = createLinkResolver(files);
	const notes = files.filter((file) => file.endsWith('.md'));

	it.each(notes)('rebuilds %s from its cached form exactly as parsePage builds it', (file) => {
		const input = {
			path: file,
			content: fs.readFileSync(path.join(VAULT, ...file.split('/')), 'utf8'),
			ctime: Date.UTC(2026, 8, 1),
			mtime: Date.UTC(2026, 9, 1),
			size: 100,
		};
		const direct = parsePage(input, resolver, { onWarning: () => {} });

		const cached = roundTrip(
			Transferable.transferable(parseRawPage(input, { onWarning: () => {} }))
		);
		const rebuilt = finishPage(Transferable.value(cached), resolver);

		expect(rebuilt.path).toBe(file);
		expect(Transferable.transferable(rebuilt)).toEqual(Transferable.transferable(direct));
		expect(rebuilt.fullTags()).toEqual(direct.fullTags());
	});

	it('leaves links as written until finishPage resolves them', () => {
		const raw = parseRawPage({
			path: 'Notes/Standup.md',
			content: 'Met with [[Pedram Amini]].',
			ctime: 0,
			mtime: 0,
			size: 26,
		});
		expect(raw.links.map((link) => link.path)).toEqual(['Pedram Amini']);
		expect(finishPage(raw, resolver).links.map((link) => link.path)).toEqual([
			'People/Pedram Amini.md',
		]);
	});
});
