/**
 * @file code-structure.test.ts
 *
 * Code-structure previews: the imports, exports and signatures of a source file an
 * agent read, bodies left out. A preview measures what an outline could save and
 * labels the figure a potential reduction. It never edits a request, opens the cache,
 * reads a file, trusts a tree the parser flagged, or guesses at a language.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('electron', () => ({
	app: { getPath: () => '/tmp/code-structure-unused' },
}));

vi.mock('../../../../main/utils/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../../main/prompt-manager', () => ({
	getPrompt: vi.fn((id: string) => `PROMPT:${id}`),
}));

vi.mock('../../../../main/local-models/task-router', () => ({
	runLocalTask: vi.fn(),
}));

// Previews never open the cache. Any use of these two accessors fails the test.
vi.mock('../../../../main/local-models/proxy/compression-cache', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('../../../../main/local-models/proxy/compression-cache')>();
	return {
		...actual,
		getCompressionCache: vi.fn(() => {
			throw new Error('previews must not open the compression cache');
		}),
		createCompressionCache: vi.fn(() => {
			throw new Error('previews must not create a compression cache');
		}),
	};
});

// The real event loop turn, counted: it marks both the slices of a parse and the work done.
vi.mock('../../../../main/utils/concurrency', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../../../main/utils/concurrency')>();
	return { ...actual, yieldToEventLoop: vi.fn(actual.yieldToEventLoop) };
});

import { yieldToEventLoop } from '../../../../main/utils/concurrency';
import {
	buildCodeStructurePreviews,
	CODE_STRUCTURE_LIMITS,
	CODE_STRUCTURE_NOTE,
	codeLanguageOf,
	PARSE_SLICE_STEPS,
	type CodeStructureEntry,
	type CodeStructureLimits,
	type CodeStructureReport,
} from '../../../../main/local-models/proxy/code-structure';
import {
	analyzeReadOpportunities,
	readEventsFromDescriptors,
	type ReadEvent,
	type ReadOpportunityReport,
} from '../../../../main/local-models/proxy/read-opportunities';
import {
	findToolResultDescriptors,
	formatCompressionMarker,
	MIN_SAVING_RATIO,
} from '../../../../main/local-models/proxy/compress';
import {
	contentHash,
	createCompressionCache,
	getCompressionCache,
} from '../../../../main/local-models/proxy/compression-cache';
import { parseJsonSpans } from '../../../../main/local-models/proxy/json-spans';
import {
	resultDeliveries,
	type ResultDelivery,
} from '../../../../main/local-models/proxy/read-previews';
import { estimateTokenCount } from '../../../../shared/formatters';
import {
	fileText,
	filler,
	JS_COMMONJS,
	JS_MODULE,
	PY_MODULE,
	TS_MODULE,
	TSX_COMPONENT,
} from '../../../helpers/codeStructureFixtures';
import {
	body,
	deepFreeze,
	event,
	numbered,
	read,
	ROOT,
	type ApiKind,
	type Item,
} from '../../../helpers/proxyReadRequests';

type Preview = Extract<CodeStructureEntry, { status: 'preview' }>;

const TS_FILE = `${ROOT}/src/repo.ts`;
const TSX_FILE = `${ROOT}/src/Button.tsx`;
const JS_FILE = `${ROOT}/src/cache.js`;
const CJS_FILE = `${ROOT}/src/index.cjs`;
const PY_FILE = `${ROOT}/tools/run.py`;

/** A body long enough that an outline of a small file is clearly smaller than the file. */
const TS_PAD = ['export function pad() {', ...filler(40), '}'];
const PY_PAD = ['def pad():', ...filler(40, 'python')];
const TS_PAD_OUTLINE = 'export function pad() { /* 42 lines omitted */ }';
const PY_PAD_OUTLINE = 'def pad(): ...  # 41 lines omitted';

async function outlineEvents(
	events: ReadEvent[],
	options: {
		deliveries?: ReadonlyMap<number, ResultDelivery>;
		limits?: Partial<CodeStructureLimits>;
		report?: ReadOpportunityReport;
	} = {}
): Promise<CodeStructureReport> {
	return buildCodeStructurePreviews({
		report: options.report ?? analyzeReadOpportunities(events),
		events,
		deliveries: options.deliveries,
		limits: options.limits,
	});
}

/** One whole-file read of `file` with this text. */
function outline(
	file: string,
	text: string,
	options: Parameters<typeof outlineEvents>[1] = {}
): Promise<CodeStructureReport> {
	return outlineEvents([event(0, { path: file, text })], options);
}

function previewAt(report: CodeStructureReport, index = 0): Preview {
	const entry = report.previews[index];
	if (entry?.status !== 'preview') {
		throw new Error(`entry ${index} is ${JSON.stringify(entry)}, not a preview`);
	}
	return entry;
}

const reasons = (report: CodeStructureReport) =>
	report.previews.map((entry) => (entry.status === 'unsupported' ? entry.reason : 'preview'));

/** The outline lines of a preview, without its marker. */
const bodyOf = (preview: Preview): string[] => preview.text.split('\n').slice(1);

const hash12 = (text: string) => contentHash(text).slice(0, 12);

/**
 * The outline of `source` padded with a long body, without the padding's own line, so
 * a case can say exactly what the shapes under test look like.
 */
async function shape(file: string, source: readonly string[]): Promise<string[]> {
	const python = file.endsWith('.py');
	const report = await outline(file, fileText([...source, ...(python ? PY_PAD : TS_PAD)]));
	const lines = bodyOf(previewAt(report));
	expect(lines.pop()).toBe(python ? PY_PAD_OUTLINE : TS_PAD_OUTLINE);
	return lines;
}

/** A request body and the whole analysis chain over it, the way a caller composes it. */
async function runRequest(kind: ApiKind, items: Item[]) {
	const text = body(kind, items);
	const root = parseJsonSpans(text);
	if (!root) throw new Error('fixture is not JSON');
	const view = { body: text, descriptors: findToolResultDescriptors(kind, text, root) };
	const scan = readEventsFromDescriptors({
		kind,
		body: text,
		root,
		descriptors: view.descriptors,
		roots: [ROOT],
	});
	const report = analyzeReadOpportunities(scan.events, { complete: scan.complete });
	const previews = await buildCodeStructurePreviews({
		report,
		events: scan.events,
		deliveries: resultDeliveries(view, view),
	});
	return { events: scan.events, report, previews };
}

beforeEach(() => {
	vi.mocked(yieldToEventLoop).mockClear();
});

afterEach(() => {
	// Back to the real event loop turn after a case that replaced it.
	vi.mocked(yieldToEventLoop).mockReset();
});

// ---------------------------------------------------------------------------
// What an outline looks like
// ---------------------------------------------------------------------------

const TS_OUTLINE = [
	"import fs, { readFile as rf } from 'node:fs';",
	"import type { Alpha, Beta } from './types';",
	"import * as path from 'node:path';",
	"import './side-effect';",
	"export { gamma, delta as epsilon } from './letters';",
	"export * from './all';",
	"export * as helpers from './helpers';",
	'export interface Widget<T = string> extends Base {',
	'\tid: number;',
	'\tlabel?: T;',
	'\trender(options: RenderOptions): string;',
	'}',
	'export type Pair<A, B> = { first: A; second: B } | null;',
	'export enum Color {',
	'\tRed,',
	"\tGreen = 'g',",
	'}',
	"export const VERSION = '1.2.3';",
	'export const TABLE = /* 5 lines omitted */;',
	'export async function* walk<T>(root: string, filter: (entry: T) => boolean): AsyncGenerator<T> { /* 13 lines omitted */ }',
	'export function overload(value: string): string;',
	'export function overload(value: number): number;',
	'export function overload(value: unknown): unknown { /* 9 lines omitted */ }',
	'export const arrow = async (a: number, b: string): Promise<void> => { /* 4 lines omitted */ };',
	'const internal = (x: number) => x * 2;',
	'function helper(this: Context, flag?: boolean): asserts flag is true { /* 8 lines omitted */ }',
	'export abstract class Repository<T extends object> extends Base implements Store<T> {',
	'\tprivate readonly items = new Map<string, T>();',
	'\tstatic instances = 0;',
	'\tdeclare marker: string;',
	'\tconstructor(private readonly name: string, options?: Options) { /* 4 lines omitted */ }',
	'\tget size(): number { /* 3 lines omitted */ }',
	'\tabstract load(id: string): Promise<T>;',
	'\tpublic async save(item: T): Promise<void> { /* 10 lines omitted */ }',
	'\thandler = (event: Event): void => { /* 3 lines omitted */ };',
	'}',
	'namespace Legacy { /* 3 lines omitted */ }',
	'declare global { /* 5 lines omitted */ }',
	'export default class Main extends Repository<Widget> {}',
];

const TSX_OUTLINE = [
	"import React, { useState } from 'react';",
	'export interface ButtonProps {',
	'\tlabel: string;',
	'}',
	'export const Button = ({ label }: ButtonProps): JSX.Element => { /* 8 lines omitted */ };',
	'export default function App(): JSX.Element { /* 8 lines omitted */ }',
];

const JS_OUTLINE = [
	"import { readFileSync } from 'node:fs';",
	'export function load(path, options = {}) { /* 9 lines omitted */ }',
	'export const view = (props) => { /* 12 lines omitted */ };',
	'export default class Cache {',
	'\t#entries = new Map();',
	'\tget(key) { /* 9 lines omitted */ }',
	'\tstatic create() { /* 5 lines omitted */ }',
	'}',
];

const CJS_OUTLINE = [
	"const fs = require('node:fs');",
	"const { join } = require('node:path');",
	'function helper(a, b) { /* 8 lines omitted */ }',
	'exports.helper = helper;',
	'exports.read = function read(path) { /* 6 lines omitted */ };',
	'module.exports.VERSION = 3;',
	'module.exports = /* 5 lines omitted */;',
];

const PY_OUTLINE = [
	'from __future__ import annotations',
	'import os, sys as system',
	'from typing import (',
	'    Any,',
	'    Optional,',
	')',
	'from . import sibling',
	'from .pkg import thing as other',
	'__all__ = ["run", "Widget"]',
	'MAX: int = 5',
	'@decorator(arg)',
	'def run(a: int, b: str = "x", *args, **kwargs) -> Optional[int]: ...  # 6 lines omitted',
	'async def fetch(url: str) -> bytes: ...  # 3 lines omitted',
	'class Widget(Base, metaclass=Meta):',
	'    x: int = 1',
	'    def __init__(self, a: int) -> None: ...  # 3 lines omitted',
	'    @property',
	'    def size(self) -> int: ...  # 2 lines omitted',
	'    @staticmethod',
	'    async def make() -> "Widget": ...  # 2 lines omitted',
	'    class Inner: ...  # 3 lines omitted',
];

describe('code structure: the outline of a source file', () => {
	const cases = [
		{
			name: 'TypeScript',
			file: TS_FILE,
			lines: TS_MODULE,
			language: 'typescript',
			golden: TS_OUTLINE,
			outline: {
				imports: 4,
				declarations: 19,
				members: 8,
				bodies: 11,
				omittedLines: 67,
				statements: 2,
			},
		},
		{
			name: 'TSX',
			file: TSX_FILE,
			lines: TSX_COMPONENT,
			language: 'tsx',
			golden: TSX_OUTLINE,
			outline: {
				imports: 1,
				declarations: 3,
				members: 0,
				bodies: 2,
				omittedLines: 16,
				statements: 0,
			},
		},
		{
			name: 'JavaScript, with JSX',
			file: JS_FILE,
			lines: JS_MODULE,
			language: 'javascript',
			golden: JS_OUTLINE,
			outline: {
				imports: 1,
				declarations: 3,
				members: 3,
				bodies: 4,
				omittedLines: 35,
				statements: 0,
			},
		},
		{
			name: 'CommonJS',
			file: CJS_FILE,
			lines: JS_COMMONJS,
			language: 'javascript',
			golden: CJS_OUTLINE,
			outline: {
				imports: 0,
				declarations: 7,
				members: 0,
				bodies: 3,
				omittedLines: 19,
				statements: 1,
			},
		},
		{
			name: 'Python',
			file: PY_FILE,
			lines: PY_MODULE,
			language: 'python',
			golden: PY_OUTLINE,
			outline: {
				imports: 5,
				declarations: 5,
				members: 5,
				bodies: 6,
				omittedLines: 19,
				statements: 3,
			},
		},
	] as const;

	it.each(cases)(
		'outlines $name as imports, exports and signatures with every body left out',
		async ({ file, lines, language, golden, outline: counts }) => {
			const text = fileText(lines);
			const preview = previewAt(await outline(file, text));
			expect(preview.language).toBe(language);
			expect(bodyOf(preview)).toEqual(golden);
			expect(preview.outline).toEqual(counts);
			expect(preview.text.split('\n')[0]).toBe(
				`[maestro-preview code-structure language=${language} sha256=${hash12(text)} ` +
					`lines=${preview.read.lines} bodies-omitted=${counts.bodies} statements-omitted=${counts.statements}]`
			);
			// The source hash in the marker is the hash the finding carries.
			expect(preview.read.hash).toBe(contentHash(text));
		}
	);

	it('outlines a numbered read exactly as the plain read, and measures it against the numbered text', async () => {
		const plain = previewAt(await outline(TS_FILE, fileText(TS_MODULE)));
		const sent = numbered(TS_MODULE);
		const withNumbers = previewAt(await outline(TS_FILE, sent));
		expect(bodyOf(withNumbers)).toEqual(bodyOf(plain));
		expect(withNumbers.read.numbered).toEqual({ startLine: 1, endLine: TS_MODULE.length });
		// The figure is against the text as sent, printed numbers included.
		expect(withNumbers.potential.fullChars).toBe(sent.length);
		expect(withNumbers.potential.fullChars).toBeGreaterThan(plain.potential.fullChars);
		expect(withNumbers.text.split('\n')[0]).toContain(`sha256=${hash12(sent)}`);
	});

	it('gives CRLF and LF sources the same outline', async () => {
		for (const [file, lines] of [
			[TS_FILE, TS_MODULE],
			[PY_FILE, PY_MODULE],
		] as const) {
			const lf = previewAt(await outline(file, fileText(lines)));
			const crlf = previewAt(await outline(file, fileText(lines).replace(/\n/g, '\r\n')));
			expect(bodyOf(crlf)).toEqual(bodyOf(lf));
			expect(crlf.text).not.toContain('\r');
			expect(crlf.read.hash).not.toBe(lf.read.hash);
		}
	});

	it('shows a byte-order mark as the whitespace it is', async () => {
		const report = await outline(TS_FILE, `\uFEFF${fileText(['import a from "a";', ...TS_PAD])}`);
		expect(bodyOf(previewAt(report))).toEqual(['import a from "a";', TS_PAD_OUTLINE]);
	});

	it('drops comments, doc comments and the hashbang, and says nothing of them', async () => {
		const lines = await shape(TS_FILE, [
			'#!/usr/bin/env node',
			'// a line comment',
			'/** A doc comment on a function. */',
			'export function documented() {',
			'\t// inside',
			'}',
			'/* a block comment */',
		]);
		expect(lines).toEqual(['export function documented() { /* 3 lines omitted */ }']);
	});
});

describe('code structure: TypeScript and JavaScript shapes', () => {
	it('shows every import form as written', async () => {
		const imports = [
			"import fs, { readFile as rf } from 'node:fs';",
			"import type { A, B } from './types';",
			"import * as path from 'node:path';",
			"import './side-effect';",
			'import {',
			'\tone,',
			'\ttwo,',
			"} from './multi';",
		];
		expect(await shape(TS_FILE, imports)).toEqual(imports);
	});

	it('shows re-exports as written and an `export default` value without its value', async () => {
		const lines = await shape(TS_FILE, [
			"export { a, b as c } from './letters';",
			"export * from './all';",
			'export default {',
			'\tone: 1,',
			'\ttwo: 2,',
			'};',
		]);
		expect(lines).toEqual([
			"export { a, b as c } from './letters';",
			"export * from './all';",
			'export default /* 4 lines omitted */;',
		]);
	});

	it('keeps the signature of every function form and the overloads that precede an implementation', async () => {
		const lines = await shape(TS_FILE, [
			'export default function () {',
			'\treturn 1;',
			'}',
			'export default async () => {',
			'\treturn 2;',
			'};',
			'export async function* gen<T>(a: T, b = 1): AsyncGenerator<T> {',
			'\tyield a;',
			'}',
			'export declare function ambient(a: string): number;',
			'function one(a: string): void;',
			'function one(a: number): void;',
			'function one(a: unknown): void {}',
		]);
		expect(lines).toEqual([
			'export default function () { /* 3 lines omitted */ }',
			'export default async () => { /* 3 lines omitted */ };',
			'export async function* gen<T>(a: T, b = 1): AsyncGenerator<T> { /* 3 lines omitted */ }',
			'export declare function ambient(a: string): number;',
			'function one(a: string): void;',
			'function one(a: number): void;',
			'function one(a: unknown): void { /* 1 line omitted */ }',
		]);
	});

	it('shows a constant on one line as written and omits a value that spans several', async () => {
		const lines = await shape(TS_FILE, [
			"export const NAME = 'maestro';",
			'export const LIMITS: Record<string, number> = { a: 1, b: 2 };',
			'export const TABLE = {',
			'\tone: 1,',
			'\ttwo: 2,',
			'} as const;',
			'let pending: Promise<void> | undefined;',
			'export const list = [',
			'\t1,',
			'\t2,',
			'];',
		]);
		expect(lines).toEqual([
			"export const NAME = 'maestro';",
			'export const LIMITS: Record<string, number> = { a: 1, b: 2 };',
			'export const TABLE = /* 4 lines omitted */;',
			'let pending: Promise<void> | undefined;',
			'export const list = /* 4 lines omitted */;',
		]);
	});

	it('keeps the signature of a function-valued constant and drops its body, as for a declaration', async () => {
		const lines = await shape(TS_FILE, [
			'export const arrow = async (a: number): Promise<void> => {',
			'\tawait run(a);',
			'};',
			'const named = function named(x: number): number {',
			'\treturn x;',
			'};',
			'const short = (x: number) => x * 2;',
			'const wide = (x: number) =>',
			'\tx *',
			'\t\t2;',
		]);
		expect(lines).toEqual([
			'export const arrow = async (a: number): Promise<void> => { /* 3 lines omitted */ };',
			'const named = function named(x: number): number { /* 3 lines omitted */ };',
			'const short = (x: number) => x * 2;',
			'const wide = /* 3 lines omitted */;',
		]);
	});

	it('shows a class with its members one level down, in the order the source has them', async () => {
		const lines = await shape(TS_FILE, [
			'export class Panel<T> extends Base {',
			'\t@Input() title: string;',
			'\tprivate cache = new Map<string, T>();',
			'\tinner = class Inner {',
			'\t\tm() {}',
			'\t};',
			'\tconstructor(private readonly id: string) {',
			'\t\tsuper();',
			'\t}',
			'\tget size(): number {',
			'\t\treturn 1;',
			'\t}',
			'\tset size(value: number) {}',
			'\tstatic create(): Panel<string> {',
			'\t\treturn new Panel("x");',
			'\t}',
			'\tstatic {',
			'\t\tPanel.count = 0;',
			'\t}',
			'}',
		]);
		expect(lines).toEqual([
			'export class Panel<T> extends Base {',
			'\t@Input() title: string;',
			'\tprivate cache = new Map<string, T>();',
			'\tinner = /* 3 lines omitted */;',
			'\tconstructor(private readonly id: string) { /* 3 lines omitted */ }',
			'\tget size(): number { /* 3 lines omitted */ }',
			'\tset size(value: number) { /* 1 line omitted */ }',
			'\tstatic create(): Panel<string> { /* 3 lines omitted */ }',
			'}',
		]);
	});

	it('shows a class with nothing to show on one line, and counts what it left out', async () => {
		const report = await outline(
			TS_FILE,
			fileText([
				'class Empty {}',
				'class OnlyStatic {',
				'\tstatic {',
				'\t\tinit();',
				'\t}',
				'}',
				...TS_PAD,
			])
		);
		const preview = previewAt(report);
		expect(bodyOf(preview)).toEqual(['class Empty {}', 'class OnlyStatic {}', TS_PAD_OUTLINE]);
		expect(preview.outline.statements).toBe(1);
	});

	it('keeps a decorator that precedes a class, and one on a member', async () => {
		const lines = await shape(TS_FILE, [
			'@sealed()',
			'class Plain {',
			'\t@Input() name: string;',
			'\tmethod() {',
			'\t\treturn 1;',
			'\t}',
			'}',
		]);
		expect(lines).toEqual([
			'@sealed()',
			'class Plain {',
			'\t@Input() name: string;',
			'\tmethod() { /* 3 lines omitted */ }',
			'}',
		]);
	});

	it('shows interfaces, aliases and enums as written, ambient declarations, and namespaces without their content', async () => {
		const lines = await shape(TS_FILE, [
			'export interface Options<T = string> extends Base {',
			'\tname: T;',
			'\trun(): void;',
			'}',
			'export type Handler<E> = (event: E) => void;',
			'export enum Mode {',
			'\tOn,',
			'\tOff = "off",',
			'}',
			'declare const g: number;',
			'export declare namespace NS {',
			'\tconst a: number;',
			'}',
			'namespace Legacy {',
			'\texport const flag = true;',
			'}',
			'declare global {',
			'\tinterface Window {',
			'\t\tapp: unknown;',
			'\t}',
			'}',
		]);
		expect(lines).toEqual([
			'export interface Options<T = string> extends Base {',
			'\tname: T;',
			'\trun(): void;',
			'}',
			'export type Handler<E> = (event: E) => void;',
			'export enum Mode {',
			'\tOn,',
			'\tOff = "off",',
			'}',
			'declare const g: number;',
			'export declare namespace NS { /* 3 lines omitted */ }',
			'namespace Legacy { /* 3 lines omitted */ }',
			'declare global { /* 5 lines omitted */ }',
		]);
	});

	it('shows the CommonJS export statements and the requires, and counts everything else as left out', async () => {
		const lines = await shape(CJS_FILE, [
			"'use strict';",
			"const fs = require('node:fs');",
			'exports.name = "x";',
			'exports.run = function run(a) {',
			'\treturn a;',
			'};',
			'module.exports.version = 3;',
			'module.exports = {',
			'\ta: 1,',
			'};',
			'exports.call();',
			'exportsFoo = 1;',
			'main();',
		]);
		expect(lines).toEqual([
			"const fs = require('node:fs');",
			'exports.name = "x";',
			'exports.run = function run(a) { /* 3 lines omitted */ };',
			'module.exports.version = 3;',
			'module.exports = /* 3 lines omitted */;',
		]);
		const report = await outline(CJS_FILE, fileText([...TS_PAD, "'use strict';", 'main();']));
		expect(previewAt(report).outline.statements).toBe(2);
		expect(previewAt(report).text.split('\n')[0]).toContain('statements-omitted=2');
	});

	it('uses the indentation the source gave a member, and a tab when the member shares its line', async () => {
		const spaced = await shape(TS_FILE, [
			'class Spaced {',
			'  one() {',
			'    return 1;',
			'  }',
			'  two = 2;',
			'}',
		]);
		expect(spaced).toEqual([
			'class Spaced {',
			'  one() { /* 3 lines omitted */ }',
			'  two = 2;',
			'}',
		]);
		const crowded = await shape(TS_FILE, ['class Crowded { one() { return 1; } two = 2; }']);
		expect(crowded).toEqual([
			'class Crowded {',
			'\tone() { /* 1 line omitted */ }',
			'\ttwo = 2;',
			'}',
		]);
	});

	it('keeps a wrapped signature as written, comments inside it included', async () => {
		const lines = await shape(TS_FILE, [
			'export function wrapped(',
			'\ta: number, // the first',
			'\tb: string',
			'): void {',
			'\trun(a, b);',
			'}',
		]);
		expect(lines).toEqual([
			'export function wrapped(',
			'\ta: number, // the first',
			'\tb: string',
			'): void { /* 3 lines omitted */ }',
		]);
	});

	it('cuts a declaration longer than the bound at a line break, and says exactly how much it left out', async () => {
		const members = Array.from({ length: 200 }, (_, index) => `\tMember${index} = ${index},`);
		const written = ['export enum Big {', ...members, '}'].join('\n');
		const lines = await shape(TS_FILE, written.split('\n'));
		const notice = lines.at(-1) ?? '';
		const kept = lines.slice(0, -1).join('\n');
		expect(kept.startsWith('export enum Big {\n\tMember0 = 0,')).toBe(true);
		// Whole lines only, and inside the bound.
		expect(lines.at(-2)).toMatch(/^\tMember\d+ = \d+,$/);
		expect(kept.length).toBeLessThanOrEqual(CODE_STRUCTURE_LIMITS.maxEntryChars);
		expect(written.startsWith(kept)).toBe(true);
		expect(notice).toBe(`/* ${written.length - kept.length} more characters omitted */`);
	});

	it('cuts a single long line at the bound, and says exactly how much it left out', async () => {
		const longLine = `import { ${Array.from({ length: 400 }, (_, index) => `name${index}`).join(', ')} } from './x';`;
		const [cut] = await shape(TS_FILE, [longLine]);
		const kept = longLine.slice(0, CODE_STRUCTURE_LIMITS.maxEntryChars);
		expect(cut).toBe(`${kept} /* ${longLine.length - kept.length} more characters omitted */`);
	});

	it('honours a lower bound on the length of a shown declaration', async () => {
		const written = `export type T = ${'"abcdef" | '.repeat(30)}"z";`;
		const report = await outline(TS_FILE, fileText([written, ...TS_PAD]), {
			limits: { maxEntryChars: 40 },
		});
		expect(bodyOf(previewAt(report))[0]).toBe(
			`${written.slice(0, 40)} /* ${written.length - 40} more characters omitted */`
		);
	});
});

describe('code structure: Python shapes', () => {
	it('shows every import form, decorators, async functions and the attributes of a class', async () => {
		const lines = await shape(PY_FILE, [
			'import os, sys as system',
			'from typing import (',
			'    Any,',
			'    Optional,',
			')',
			'from .pkg import thing as other',
			'CONSTANT = 1',
			'',
			'@first',
			'@second(1)',
			'async def work(a, *, b=2, **rest) -> None:',
			'    return None',
			'',
			'@dataclass',
			'class Point:',
			'    x: int = 0',
			'    y: int',
			'',
			'    @property',
			'    def norm(self) -> float:',
			'        return 1.0',
		]);
		expect(lines).toEqual([
			'import os, sys as system',
			'from typing import (',
			'    Any,',
			'    Optional,',
			')',
			'from .pkg import thing as other',
			'CONSTANT = 1',
			'@first',
			'@second(1)',
			'async def work(a, *, b=2, **rest) -> None: ...  # 2 lines omitted',
			'@dataclass',
			'class Point:',
			'    x: int = 0',
			'    y: int',
			'    @property',
			'    def norm(self) -> float: ...  # 2 lines omitted',
		]);
	});

	it('writes an omitted Python value as a placeholder that is valid Python', async () => {
		const lines = await shape(PY_FILE, [
			'DEFAULTS = {',
			'    "a": 1,',
			'    "b": 2,',
			'}',
			'class A: pass',
			'def f(x): return x',
		]);
		expect(lines).toEqual([
			'DEFAULTS = ...  # 4 lines omitted',
			'class A: ...',
			'def f(x): ...  # 1 line omitted',
		]);
	});

	it('counts the docstring, the entry-point guard and the other statements as left out', async () => {
		const report = await outline(
			PY_FILE,
			fileText([
				'"""Doc."""',
				'import os',
				'if __name__ == "__main__":',
				'    main()',
				'print("x")',
				...PY_PAD,
			])
		);
		const preview = previewAt(report);
		expect(preview.outline.statements).toBe(3);
		expect(bodyOf(preview)).toEqual(['import os', PY_PAD_OUTLINE]);
	});

	it('gives a Python file with only statements no outline', async () => {
		const calls = Array.from({ length: 40 }, (_, index) => `run(${index})`);
		const report = await outline(PY_FILE, fileText(['"""Doc."""', ...calls]));
		expect(reasons(report)).toEqual(['nothing-to-outline']);
	});
});

// ---------------------------------------------------------------------------
// Languages
// ---------------------------------------------------------------------------

describe('code structure: which files are outlined', () => {
	it.each([
		['/work/app/a.ts', 'typescript'],
		['/work/app/a.mts', 'typescript'],
		['/work/app/a.cts', 'typescript'],
		['/work/app/a.d.ts', 'typescript'],
		['/work/app/A.TS', 'typescript'],
		['/work/app/a.tsx', 'tsx'],
		['/work/app/a.js', 'javascript'],
		['/work/app/a.mjs', 'javascript'],
		['/work/app/a.cjs', 'javascript'],
		['/work/app/a.jsx', 'javascript'],
		['/work/app/a.py', 'python'],
		['C:\\work\\app\\a.py', 'python'],
	])('%s is %s', (file, language) => {
		expect(codeLanguageOf(file)).toBe(language);
	});

	it.each([
		'/work/app/a',
		'/work/app/.ts',
		'/work/app/a.pyi',
		'/work/app/a.json',
		'/work/app/a.constructor',
		'/work/app/a.__proto__',
		'/work/app/a.toString',
		'/work/app/a.hasOwnProperty',
	])('%s is not a supported language', (file) => {
		expect(codeLanguageOf(file)).toBeNull();
	});

	it.each([
		'README.md',
		'CLAUDE.md',
		'POLICY.md',
		'guide.mdx',
		'notes.txt',
		'data.json',
		'config.yaml',
		'Cargo.toml',
		'main.go',
		'lib.rs',
		'Main.java',
		'main.c',
		'main.cpp',
		'style.css',
		'index.html',
		'query.sql',
		'tool.rb',
		'run.sh',
		'Makefile',
		'.bashrc',
	])('never outlines %s, however much code its text holds', async (name) => {
		// Real TypeScript, so only the name can decide. Documents and policy files are not turned into headings.
		const report = await outline(`${ROOT}/docs/${name}`, fileText([...TS_MODULE, ...TS_PAD]));
		expect(reasons(report)).toEqual(['unsupported-language']);
		expect(vi.mocked(yieldToEventLoop)).not.toHaveBeenCalled();
	});

	it('goes by the extension, never by the content: Markdown in a .ts file is a parse error, not a language', async () => {
		const report = await outline(TS_FILE, `# Title\n\nSome words.\n\n${filler(40).join('\n')}\n`);
		expect(reasons(report)).toEqual(['parse-error']);
	});

	it('loads a grammar only when a source of its language is parsed', async () => {
		// A fresh module over fresh grammar mocks: the grammars the earlier cases used are already loaded.
		vi.resetModules();
		const loads = { javascript: 0, python: 0 };
		vi.doMock('@lezer/javascript', async (importOriginal) => {
			loads.javascript++;
			return importOriginal();
		});
		vi.doMock('@lezer/python', async (importOriginal) => {
			loads.python++;
			return importOriginal();
		});
		try {
			const fresh = await import('../../../../main/local-models/proxy/code-structure');
			const run = (file: string, text: string, range: { offset?: number; limit?: number } = {}) => {
				const events = [event(0, { path: file, text, ...range })];
				return fresh.buildCodeStructurePreviews({
					report: analyzeReadOpportunities(events),
					events,
				});
			};

			// Importing the module loads nothing, and neither does anything refused before a parse.
			expect(loads).toEqual({ javascript: 0, python: 0 });
			await run(`${ROOT}/README.md`, '# Title\n');
			await run(TS_FILE, fileText(TS_MODULE), { offset: 5, limit: 5 });
			expect(loads).toEqual({ javascript: 0, python: 0 });

			// TypeScript, TSX and JavaScript share one grammar package; Python has its own.
			await run(TS_FILE, fileText(TS_MODULE));
			expect(loads).toEqual({ javascript: 1, python: 0 });
			await run(TSX_FILE, fileText(TSX_COMPONENT));
			await run(JS_FILE, fileText(JS_MODULE));
			expect(loads).toEqual({ javascript: 1, python: 0 });
			await run(PY_FILE, fileText(PY_MODULE));
			expect(loads).toEqual({ javascript: 1, python: 1 });
		} finally {
			vi.doUnmock('@lezer/javascript');
			vi.doUnmock('@lezer/python');
		}
	});

	describe('what a failing grammar means', () => {
		/** A grammar whose parse throws `error` from its first step, the way strict mode reports a syntax error. */
		async function parseWith(error: Error): Promise<CodeStructureReport> {
			vi.resetModules();
			vi.doMock('@lezer/javascript', () => ({
				parser: {
					configure: () => ({
						startParse: () => ({
							advance: () => {
								throw error;
							},
						}),
					}),
				},
			}));
			try {
				const fresh = await import('../../../../main/local-models/proxy/code-structure');
				const events = [event(0, { path: TS_FILE, text: fileText(TS_MODULE) })];
				return await fresh.buildCodeStructurePreviews({
					report: analyzeReadOpportunities(events),
					events,
				});
			} finally {
				vi.doUnmock('@lezer/javascript');
			}
		}

		it('reads a syntax error as a parse error: the text is not a program of the grammar', async () => {
			expect(reasons(await parseWith(new SyntaxError('No parse at 3')))).toEqual(['parse-error']);
		});

		it('lets any other error surface: it is a bug, not a property of the text', async () => {
			await expect(parseWith(new TypeError('the grammar broke'))).rejects.toThrow(
				'the grammar broke'
			);
		});
	});

	it('names the grammar that read the text, and its dialect', async () => {
		const names = async (file: string, lines: readonly string[]) =>
			previewAt(await outline(file, fileText(lines))).parser;
		expect(await names(TS_FILE, TS_MODULE)).toEqual({ name: '@lezer/javascript', dialect: 'ts' });
		expect(await names(TSX_FILE, TSX_COMPONENT)).toEqual({
			name: '@lezer/javascript',
			dialect: 'ts jsx',
		});
		expect(await names(JS_FILE, JS_MODULE)).toEqual({ name: '@lezer/javascript', dialect: 'jsx' });
		expect(await names(PY_FILE, PY_MODULE)).toEqual({ name: '@lezer/python', dialect: null });
	});
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

describe('code structure: when the text is a piece of the file', () => {
	const PIECE = TS_MODULE.slice(0, 40);

	it.each([
		['offset', { offset: 10, limit: null }],
		['limit', { offset: null, limit: 40 }],
		['an offset of 0', { offset: 0, limit: null }],
		['offset and limit', { offset: 10, limit: 40 }],
	])('refuses a read that asked for a range by %s', async (_name, range) => {
		const report = await outlineEvents([
			event(0, { path: TS_FILE, text: numbered(PIECE), ...range }),
		]);
		expect(reasons(report)).toEqual(['partial-range']);
		expect(vi.mocked(yieldToEventLoop)).not.toHaveBeenCalled();
	});

	it('refuses text whose printed line numbers do not start at 1, whatever the call said', async () => {
		const report = await outline(TS_FILE, numbered(PIECE, 120));
		expect(reasons(report)).toEqual(['partial-range']);
	});

	it('outlines a whole read that the analyzer could only not relate to the range read before it', async () => {
		const events = [
			event(0, { path: TS_FILE, offset: 1, limit: 40, text: numbered(PIECE) }),
			event(1, { path: TS_FILE, text: numbered(TS_MODULE) }),
		];
		const analysis = analyzeReadOpportunities(events);
		expect(analysis.findings.map((finding) => finding.status)).toEqual(['first', 'unsupported']);
		const report = await outlineEvents(events, { report: analysis });
		expect(reasons(report)).toEqual(['partial-range', 'preview']);
		expect(report.counts).toMatchObject({ examined: 2, outlined: 1, unsupported: 1 });
	});

	it('outlines a whole read after a reset: the analyzer could not relate it, but its text is fine', async () => {
		const { previews, report } = await runRequest('anthropic-messages', [
			read(numbered(TS_MODULE)),
			'compaction',
			read(numbered(TS_MODULE)),
		]);
		expect(
			report.findings.map((finding) =>
				finding.status === 'unsupported' ? finding.reason : finding.status
			)
		).toEqual(['first', 'reset-between']);
		expect(reasons(previews)).toEqual(['preview', 'preview']);
	});

	it('gives a re-read its own outline: the outline needs no baseline', async () => {
		const events = [
			event(0, { path: TS_FILE, text: numbered(TS_MODULE) }),
			event(1, { path: TS_FILE, text: numbered(TS_MODULE) }),
			event(2, { path: TS_FILE, text: numbered(['export const a = 1;', ...TS_PAD]) }),
		];
		const report = await outlineEvents(events);
		expect(reasons(report)).toEqual(['preview', 'preview', 'preview']);
		expect(report.counts.potentialChars).toBe(
			report.previews.reduce(
				(sum, entry) => sum + (entry.status === 'preview' ? entry.potential.reducibleChars : 0),
				0
			)
		);
	});
});

describe('code structure: reads the analyzer ruled out on their own text', () => {
	it('gives no entry to binary-looking, failed or already compressed reads', async () => {
		const compressed = `${numbered(TS_MODULE.slice(0, 3))}\n${formatCompressionMarker(contentHash('x'), 900)}`;
		const events = [
			event(0, { path: TS_FILE, text: 'abc\0def\0'.repeat(50) }),
			event(1, { path: TS_FILE, text: compressed }),
		];
		const report = await outlineEvents(events);
		expect(report.previews).toEqual([]);
		expect(report.counts.examined).toBe(0);

		const failed = await runRequest('anthropic-messages', [
			{ ...read('File does not exist.'), isError: true },
		]);
		expect(failed.previews.previews).toEqual([]);
		expect(failed.previews.counts.examined).toBe(0);
	});

	it.each(['anthropic-messages', 'openai-chat-completions', 'openai-responses'] as const)(
		'outlines a read in a %s request',
		async (kind) => {
			const { previews } = await runRequest(kind, [read(numbered(TS_MODULE))]);
			expect(reasons(previews)).toEqual(['preview']);
			expect(bodyOf(previewAt(previews))).toEqual(TS_OUTLINE);
			// Nothing rewrote the request, so the model is shown what the agent sent.
			expect(previewAt(previews).delivery).toBe('whole');
		}
	);
});

describe('code structure: when the structure is not trusted', () => {
	it.each([
		['a decorator before export', ['@Injectable()', 'export class Service {}']],
		['an import-equals declaration', ["import fs = require('node:fs');"]],
		['an ambient module declaration', ["declare module 'x' {", '\texport const z: number;', '}']],
		['a class index signature', ['class A {', '\t[key: string]: unknown;', '}']],
		['an anonymous default class with a base', ['export default class extends Base {}']],
		['an unterminated template literal', ['const a = `abc']],
		['a statement cut in half', ['export function half(a: number', '']],
		['a stray closing brace', ['export const a = 1;', '}']],
	])(
		'gives no outline for %s: the grammar does not know it, so its structure is unknown',
		async (_name, bad) => {
			const report = await outline(TS_FILE, fileText([...bad, ...TS_PAD]));
			expect(reasons(report)).toEqual(['parse-error']);
		}
	);

	it.each([
		['a def with no name', ['def (:', '    pass']],
		// An unterminated triple-quoted string would swallow every declaration after it.
		['an unterminated triple-quoted string', ['x = """abc']],
		['an unclosed bracket', ['values = [1, 2,', 'other = 3']],
		['a statement missing its colon', ['if ready', '    go()']],
		['an indentation that does not match', ['def f():', '  a = 1', '    b = 2']],
		['a decorator the grammar does not know', ['@a.b[0](1)', 'def g(): pass']],
	])('refuses Python with %s', async (_name, bad) => {
		const report = await outline(PY_FILE, fileText([...bad, ...PY_PAD]));
		expect(reasons(report)).toEqual(['parse-error']);
	});

	it('refuses a tree that strict mode accepts but still holds error nodes', async () => {
		// Valid text. In a very long left-recursive chain the parser forces a reduction, which leaves error nodes
		// in the tree without throwing. The scan for them is what refuses it. This is also a canary: if a future
		// grammar needs no forced reduction here, the scan has lost its reason and this case should be revisited.
		const chain = `export function head() {\n${filler(10).join('\n')}\n}\nconst x = ${'a + '.repeat(60_000)}b;`;
		expect(chain.length).toBeLessThan(CODE_STRUCTURE_LIMITS.maxSourceChars);
		const report = await outline(TS_FILE, chain);
		expect(reasons(report)).toEqual(['parse-error']);
	});

	it('gives a very deep nesting no outline instead of an unbounded parse', async () => {
		const report = await outline(TS_FILE, `${'f('.repeat(50_000)}${')'.repeat(50_000)}\n`);
		expect(reasons(report)).toEqual(['parse-error']);
	});

	it('fails garbage fast: the grammar does not recover from errors in a 256 KiB source of punctuation', async () => {
		const soup = '{[(<>;,:=+-*/%&|!?.'
			.repeat(Math.ceil(CODE_STRUCTURE_LIMITS.maxSourceChars / 19))
			.slice(0, CODE_STRUCTURE_LIMITS.maxSourceChars);
		const started = performance.now();
		const report = await outline(TS_FILE, soup);
		const elapsed = performance.now() - started;
		expect(reasons(report)).toEqual(['parse-error']);
		// Recovering from every error in this text takes about 16 seconds; failing at the first one takes a millisecond.
		expect(elapsed).toBeLessThan(3_000);
	});

	it('gives text that parses but declares nothing no outline', async () => {
		const statements = Array.from({ length: 60 }, (_, index) => `run(${index});`);
		expect(reasons(await outline(TS_FILE, fileText(statements)))).toEqual(['nothing-to-outline']);
		const comments = Array.from({ length: 60 }, (_, index) => `// note ${index}`);
		expect(reasons(await outline(TS_FILE, fileText(comments)))).toEqual(['nothing-to-outline']);
		expect(reasons(await outline(TS_FILE, ''))).toEqual(['nothing-to-outline']);
	});
});

describe('code structure: the saving bar', () => {
	it('refuses an outline that is not clearly smaller than the file, markers counted', async () => {
		const report = await outline(TS_FILE, fileText(['export const a = 1;', 'export const b = 2;']));
		expect(reasons(report)).toEqual(['insufficient-reduction']);
	});

	it('applies the compressor bar exactly, at its edge', async () => {
		// 200 signatures that the outline keeps, and one function whose body grows a line at a time. The outline
		// stays the same size while the file grows, and the bar is crossed inside the range. The file has 213 to
		// 263 lines and the notice counts 12 to 62, so no digit count in the marker or the notice changes.
		const signatures = Array.from(
			{ length: 200 },
			(_, index) => `export const s${index} = ${index};`
		);
		const source = (count: number) =>
			fileText([...signatures, 'export function f() {', ...filler(count), '}']);
		const outcomes: Array<{ sent: number; outline: number | null; reason: string | null }> = [];
		for (let count = 10; count <= 60; count++) {
			const text = source(count);
			const entry = (await outline(TS_FILE, text)).previews[0];
			outcomes.push({
				sent: text.length,
				outline: entry.status === 'preview' ? entry.text.length : null,
				reason: entry.status === 'unsupported' ? entry.reason : null,
			});
		}
		const built = outcomes.filter((outcome) => outcome.outline !== null);
		const refused = outcomes.filter((outcome) => outcome.outline === null);
		// The range really does cross the edge.
		expect(built.length).toBeGreaterThan(0);
		expect(refused.length).toBeGreaterThan(0);
		expect(refused.every((outcome) => outcome.reason === 'insufficient-reduction')).toBe(true);
		const size = built[0].outline ?? 0;
		expect(built.every((outcome) => outcome.outline === size)).toBe(true);
		// Every case is decided by the compressor's own bar, in both directions.
		for (const outcome of outcomes) {
			expect(outcome.outline !== null).toBe(size <= outcome.sent * (1 - MIN_SAVING_RATIO));
		}
	});
});

// ---------------------------------------------------------------------------
// Bounds, and what happens before a parse
// ---------------------------------------------------------------------------

describe('code structure: work bounds', () => {
	const NO_PARSE = async (report: CodeStructureReport, expected: string) => {
		expect(reasons(report)).toEqual([expected]);
		expect(vi.mocked(yieldToEventLoop)).not.toHaveBeenCalled();
	};

	it('refuses a source longer than the bound before it parses it', async () => {
		const text = fileText(TS_MODULE);
		await NO_PARSE(
			await outline(TS_FILE, text, { limits: { maxSourceChars: text.length - 1 } }),
			'too-large'
		);
		vi.mocked(yieldToEventLoop).mockClear();
		expect(
			reasons(await outline(TS_FILE, text, { limits: { maxSourceChars: text.length } }))
		).toEqual(['preview']);
	});

	it('bounds a source by characters and not by lines: many short lines are only as costly as their characters', async () => {
		// 8,000 lines of statements is 80 KB, inside the bound however many lines it has.
		const lines = Array.from({ length: 8_000 }, (_, index) => `go(${index});`);
		const report = await outline(TS_FILE, fileText([...lines, ...TS_PAD]));
		const preview = previewAt(report);
		expect(preview.read.lines).toBeGreaterThan(8_000);
		expect(preview.outline.statements).toBe(8_000);
	});

	it('stops at the source count: a second distinct source is over budget, the same one twice is not', async () => {
		const other = fileText(['export const other = 1;', ...TS_PAD]);
		const distinct = await outlineEvents(
			[
				event(0, { path: TS_FILE, text: fileText(TS_MODULE) }),
				event(1, { path: `${ROOT}/src/b.ts`, text: other }),
			],
			{ limits: { maxSources: 1 } }
		);
		expect(reasons(distinct)).toEqual(['preview', 'over-budget']);
		expect(distinct.complete).toBe(false);

		const twice = await outlineEvents(
			[
				event(0, { path: TS_FILE, text: fileText(TS_MODULE) }),
				event(1, { path: `${ROOT}/src/b.ts`, text: fileText(TS_MODULE) }),
			],
			{ limits: { maxSources: 1 } }
		);
		expect(reasons(twice)).toEqual(['preview', 'preview']);
		expect(twice.complete).toBe(true);
		// One parse, one turn of the event loop for it.
		expect(vi.mocked(yieldToEventLoop).mock.calls.length).toBeGreaterThanOrEqual(1);
		// The two outlines are equal and independent: neither entry shares its counts with the other.
		expect(previewAt(twice, 1).outline).toEqual(previewAt(twice, 0).outline);
		expect(previewAt(twice, 1).outline).not.toBe(previewAt(twice, 0).outline);
	});

	it('parses a text once per language: the same text under two extensions is two parses', async () => {
		const events = [
			event(0, { path: `${ROOT}/src/a.ts`, text: fileText(TS_MODULE) }),
			event(1, { path: `${ROOT}/src/a.js`, text: fileText(TS_MODULE) }),
		];
		const report = await outlineEvents(events, { limits: { maxSources: 1 } });
		expect(reasons(report)).toEqual(['preview', 'over-budget']);
	});

	it('stops at the character total, counting each distinct source once', async () => {
		const a = fileText(TS_MODULE);
		const b = fileText(['export const other = 1;', ...TS_PAD]);
		const events = [
			event(0, { path: TS_FILE, text: a }),
			event(1, { path: `${ROOT}/src/b.ts`, text: b }),
			event(2, { path: `${ROOT}/src/c.ts`, text: a }),
		];
		const report = await outlineEvents(events, {
			limits: { maxTotalChars: a.length + b.length - 1 },
		});
		// The third read repeats the first, which was parsed, so it costs nothing.
		expect(reasons(report)).toEqual(['preview', 'over-budget', 'preview']);
		expect(report.complete).toBe(false);
		const roomy = await outlineEvents(events, { limits: { maxTotalChars: a.length + b.length } });
		expect(reasons(roomy)).toEqual(['preview', 'preview', 'preview']);
		expect(roomy.complete).toBe(true);
	});

	it('refuses a tree with more nodes than the bound', async () => {
		const report = await outline(TS_FILE, fileText(TS_MODULE), { limits: { maxTreeNodes: 50 } });
		expect(reasons(report)).toEqual(['too-complex']);
		expect(reasons(await outline(TS_FILE, fileText(TS_MODULE)))).toEqual(['preview']);
	});

	it('is incomplete when the analyzer was, and says which limits applied', async () => {
		const events = [event(0, { path: TS_FILE, text: fileText(TS_MODULE) })];
		const report = await outlineEvents(events, {
			report: analyzeReadOpportunities(events, { complete: false }),
			limits: { maxEntryChars: 1_500 },
		});
		expect(report.complete).toBe(false);
		expect(report.limits).toEqual({ ...CODE_STRUCTURE_LIMITS, maxEntryChars: 1_500 });
		expect(reasons(report)).toEqual(['preview']);
	});

	it('does not move the defaults: the limits are explicit and frozen', () => {
		expect(CODE_STRUCTURE_LIMITS).toEqual({
			maxSources: 32,
			maxSourceChars: 262_144,
			maxTotalChars: 1_048_576,
			maxTreeNodes: 300_000,
			maxEntryChars: 2_000,
		});
		expect(Object.isFrozen(CODE_STRUCTURE_LIMITS)).toBe(true);
	});
});

describe('code structure: the text must be the text the finding hashed', () => {
	it('refuses a read the events hold no text for', async () => {
		const events = [event(0, { path: TS_FILE, text: fileText(TS_MODULE) })];
		const report = await outlineEvents([], { report: analyzeReadOpportunities(events) });
		expect(reasons(report)).toEqual(['source-missing']);
		expect(vi.mocked(yieldToEventLoop)).not.toHaveBeenCalled();
	});

	it('refuses a text of another length or another content, before it parses anything', async () => {
		const text = fileText(TS_MODULE);
		const analysis = analyzeReadOpportunities([event(0, { path: TS_FILE, text })]);
		const longer = await outlineEvents([event(0, { path: TS_FILE, text: `${text}\n// more` })], {
			report: analysis,
		});
		const sameLength = await outlineEvents(
			[event(0, { path: TS_FILE, text: text.replace('Alpha', 'Omega') })],
			{ report: analysis }
		);
		expect(reasons(longer)).toEqual(['source-mismatch']);
		expect(reasons(sameLength)).toEqual(['source-mismatch']);
		expect(vi.mocked(yieldToEventLoop)).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// The event loop
// ---------------------------------------------------------------------------

describe('code structure: the parse shares the event loop', () => {
	/** The module repeated: duplicate declarations are valid syntax, so it parses and outlines. */
	const big = (copies: number) =>
		Array.from({ length: copies }, () => fileText(TS_MODULE)).join('\n');

	it('gives the loop a turn every PARSE_SLICE_STEPS steps, so a large file is not one long block', async () => {
		const small = await outline(TS_FILE, fileText(TS_MODULE));
		const smallTurns = vi.mocked(yieldToEventLoop).mock.calls.length;
		vi.mocked(yieldToEventLoop).mockClear();
		const large = await outline(TS_FILE, big(30));
		const largeTurns = vi.mocked(yieldToEventLoop).mock.calls.length;
		expect(reasons(small)).toEqual(['preview']);
		expect(reasons(large)).toEqual(['preview']);
		// One turn after the parse for any source; a large one adds many.
		expect(smallTurns).toBeLessThanOrEqual(2);
		expect(largeTurns).toBeGreaterThan(smallTurns + 10);
		expect(PARSE_SLICE_STEPS).toBe(1_024);
	});

	it('gives the loop a turn after each distinct source, however small', async () => {
		const events = ['a', 'b', 'c'].map((name, order) =>
			event(order, {
				path: `${ROOT}/src/${name}.ts`,
				text: fileText([`export const ${name} = 1;`, ...TS_PAD]),
			})
		);
		await outlineEvents(events);
		expect(vi.mocked(yieldToEventLoop).mock.calls.length).toBe(3);
	});

	it('changes nothing about the result however the turns are scheduled', async () => {
		const text = big(20);
		const immediate = await outline(TS_FILE, text);
		vi.mocked(yieldToEventLoop).mockImplementation(
			() => new Promise<void>((resolve) => setTimeout(resolve, 1))
		);
		const delayed = await outline(TS_FILE, text);
		expect(delayed).toEqual(immediate);
		expect(reasons(delayed)).toEqual(['preview']);
	});
});

// ---------------------------------------------------------------------------
// Figures and labels
// ---------------------------------------------------------------------------

describe('code structure: the figure is a potential reduction, never a saving', () => {
	it('measures the whole preview text against the file as sent', async () => {
		const text = fileText(TS_MODULE);
		const preview = previewAt(await outline(TS_FILE, text));
		expect(preview.potential).toEqual({
			kind: 'potential-reduction',
			realized: false,
			basis: 'text-as-sent',
			tokenCountKind: 'character-estimate',
			fullChars: text.length,
			fullTokens: estimateTokenCount(text),
			previewChars: preview.text.length,
			previewTokens: estimateTokenCount(preview.text),
			reducibleChars: text.length - preview.text.length,
			reducibleTokens: estimateTokenCount(text) - estimateTokenCount(preview.text),
		});
		expect(preview.confidence).toBe('parsed-without-errors');
	});

	it('labels the report, and no key anywhere is named as a saving', async () => {
		const report = await outlineEvents([
			event(0, { path: TS_FILE, text: fileText(TS_MODULE) }),
			event(1, { path: PY_FILE, text: fileText(PY_MODULE) }),
		]);
		expect(report.mode).toBe('preview');
		expect(report.version).toBe(1);
		expect(report.note).toBe(CODE_STRUCTURE_NOTE);
		expect(CODE_STRUCTURE_NOTE).toMatch(/^Potential reduction only\./);
		expect(CODE_STRUCTURE_NOTE).toMatch(/never replaced and nothing was saved/);
		const keys = new Set<string>();
		const collect = (value: unknown): void => {
			if (Array.isArray(value)) value.forEach(collect);
			else if (value && typeof value === 'object') {
				for (const [key, child] of Object.entries(value)) {
					keys.add(key);
					collect(child);
				}
			}
		};
		collect(report);
		expect(keys.size).toBeGreaterThan(20);
		expect([...keys].filter((key) => /sav(?:ing|ed)/i.test(key))).toEqual([]);
		for (const entry of report.previews) {
			if (entry.status === 'preview') {
				expect(entry.potential.realized).toBe(false);
				expect(entry.potential.kind).toBe('potential-reduction');
			}
		}
	});

	it('totals the outlines it built and counts what it refused by reason', async () => {
		const events = [
			event(0, { path: TS_FILE, text: fileText(TS_MODULE) }),
			event(1, { path: `${ROOT}/README.md`, text: '# Title\n' }),
			event(2, { path: PY_FILE, text: fileText(PY_MODULE) }),
			event(3, { path: `${ROOT}/src/tiny.ts`, text: 'export const a = 1;\n' }),
		];
		const report = await outlineEvents(events);
		expect(reasons(report)).toEqual([
			'preview',
			'unsupported-language',
			'preview',
			'insufficient-reduction',
		]);
		const built = report.previews.filter((entry): entry is Preview => entry.status === 'preview');
		expect(report.counts).toEqual({
			examined: 4,
			outlined: 2,
			unsupported: 2,
			unsupportedByReason: { 'unsupported-language': 1, 'insufficient-reduction': 1 },
			potentialChars: built.reduce((sum, entry) => sum + entry.potential.reducibleChars, 0),
			potentialTokens: built.reduce((sum, entry) => sum + entry.potential.reducibleTokens, 0),
		});
		expect(report.counts.examined).toBe(report.previews.length);
	});

	it('says what the model is shown for each read, and keeps an outline whose read was replaced', async () => {
		const events = [
			event(0, { path: TS_FILE, text: fileText(TS_MODULE) }),
			event(1, { path: PY_FILE, text: fileText(PY_MODULE) }),
			event(2, { path: JS_FILE, text: fileText(JS_MODULE) }),
		];
		const deliveries = new Map<number, ResultDelivery>([
			[0, 'whole'],
			[1, 'replaced'],
		]);
		const report = await outlineEvents(events, { deliveries });
		expect(
			report.previews.map((entry) => (entry.status === 'preview' ? entry.delivery : entry.status))
		).toEqual(['whole', 'replaced', 'unproven']);
		expect(
			(await outlineEvents(events)).previews.map((entry) =>
				entry.status === 'preview' ? entry.delivery : 'x'
			)
		).toEqual(['unproven', 'unproven', 'unproven']);
	});

	it('holds file text only in the preview text', async () => {
		const report = await outlineEvents([event(0, { path: TS_FILE, text: fileText(TS_MODULE) })]);
		const stripped = JSON.stringify({
			...report,
			previews: report.previews.map((entry) =>
				entry.status === 'preview' ? { ...entry, text: '' } : entry
			),
		});
		for (const identifier of ['Repository', 'walk', 'epsilon', 'side-effect']) {
			expect(previewAt(report).text).toContain(identifier);
			expect(stripped).not.toContain(identifier);
		}
	});
});

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

describe('code structure: a preview observes and nothing else', () => {
	it('is deterministic and leaves frozen inputs untouched', async () => {
		const events = deepFreeze([
			event(0, { path: TS_FILE, text: numbered(TS_MODULE) }),
			event(1, { path: PY_FILE, text: fileText(PY_MODULE) }),
		]);
		const report = deepFreeze(analyzeReadOpportunities(events));
		const deliveries = new Map<number, ResultDelivery>([[0, 'whole']]);
		const first = await buildCodeStructurePreviews({ report, events, deliveries });
		const second = await buildCodeStructurePreviews({ report, events, deliveries });
		expect(second).toEqual(first);
		expect(first.previews).toHaveLength(2);
	});

	it('never opens the compression cache and keeps nothing between calls', async () => {
		await outline(TS_FILE, fileText(TS_MODULE));
		const first = await outline(TS_FILE, fileText(TS_MODULE), { limits: { maxSources: 1 } });
		// A second call with its own budget parses again: no outline survives from the first.
		const second = await outline(TS_FILE, fileText(TS_MODULE), { limits: { maxSources: 1 } });
		expect(reasons(first)).toEqual(['preview']);
		expect(reasons(second)).toEqual(['preview']);
		expect(vi.mocked(getCompressionCache)).not.toHaveBeenCalled();
		expect(vi.mocked(createCompressionCache)).not.toHaveBeenCalled();
	});

	const SRC = path.resolve(__dirname, '../../../../main/local-models/proxy');

	it('is not part of the HTTP forwarding path: the server and the compressor never import it', () => {
		for (const file of ['server.ts', 'compress.ts']) {
			expect(fs.readFileSync(path.join(SRC, file), 'utf8')).not.toMatch(/code-structure/);
		}
	});

	it('imports no file system, process, network or dev-only module, so it cannot crawl source', () => {
		const source = fs.readFileSync(path.join(SRC, 'code-structure.ts'), 'utf8');
		const specifiers = [...source.matchAll(/(?:from|import\()\s*'([^']+)'/g)].map(
			(match) => match[1]
		);
		expect(specifiers.length).toBeGreaterThan(5);
		for (const specifier of specifiers) {
			expect(specifier).not.toMatch(
				/^(?:node:)?(?:fs|child_process|net|http|https|dns|os|path|worker_threads|vm|electron|typescript)(?:\/|$)/
			);
		}
		expect(source).not.toMatch(/\bprocess\.|readFile|readdir|writeFile|\bfetch\(/);
	});

	it('imports only packages that ship in the app: each is a production dependency', () => {
		const source = fs.readFileSync(path.join(SRC, 'code-structure.ts'), 'utf8');
		const manifest = JSON.parse(
			fs.readFileSync(path.resolve(__dirname, '../../../../../package.json'), 'utf8')
		) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
		const packages = [...source.matchAll(/(?:from|import\()\s*'([^'.][^']*)'/g)].map(
			(match) => match[1]
		);
		expect(packages.sort()).toEqual([
			'@lezer/common',
			'@lezer/javascript',
			'@lezer/lr',
			'@lezer/python',
		]);
		for (const name of packages) {
			expect(manifest.dependencies[name], `${name} must be a production dependency`).toBeDefined();
			expect(manifest.devDependencies[name]).toBeUndefined();
		}
	});
});
