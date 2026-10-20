/**
 * Tests for the vendored Dataview query and expression parsers (src/shared/dataview/vendor/query/parse.ts
 * and src/shared/dataview/vendor/expression/parse.ts), reached through the one import site,
 * src/shared/dataview/index.ts. The first two queries are the motivating examples from the spec.
 */

import { describe, expect, it } from 'vitest';
import {
	DEFAULT_QUERY_SETTINGS,
	Fields,
	parseField,
	parseQuery,
	QueryFields,
	Sources,
	Values,
	type Query,
} from '../../../shared/dataview';

function parseOk(text: string): Query {
	const result = parseQuery(text);
	if (!result.successful) throw new Error(`expected a parse, got: ${result.error}`);
	return result.value;
}

/** `this.file.link` and friends parse as nested index fields over a variable. */
const thisFileLink = Fields.indexVariable('this.file.link');
const fileCday = Fields.indexVariable('file.cday');
const sortCdayDesc = { type: 'sort', fields: [QueryFields.sortBy(fileCday, 'descending')] };
const limit25 = { type: 'limit', amount: Fields.literal(25) };

describe('parseQuery: the motivating examples', () => {
	it('parses the meetings table (tag or folder source)', () => {
		const query = parseOk(
			[
				'TABLE file.cday as Created, Summary',
				'FROM #meeting or "meetings"',
				'WHERE contains(file.outlinks, this.file.link)',
				'SORT file.cday DESC',
				'LIMIT 25',
			].join('\n')
		);

		expect(query.header).toEqual({
			type: 'table',
			showId: true,
			fields: [
				QueryFields.named('Created', fileCday),
				QueryFields.named('Summary', Fields.variable('Summary')),
			],
		});
		expect(query.source).toEqual(Sources.or(Sources.tag('#meeting'), Sources.folder('meetings')));
		expect(query.operations).toEqual([
			{
				type: 'where',
				clause: Fields.func(Fields.variable('contains'), [
					Fields.indexVariable('file.outlinks'),
					thisFileLink,
				]),
			},
			sortCdayDesc,
			limit25,
		]);
	});

	it('parses the people table (frontmatter link field)', () => {
		const query = parseOk(
			[
				'TABLE Company, Role',
				'FROM "People"',
				'WHERE contains(Connection, this.file.link)',
				'SORT file.cday DESC',
				'LIMIT 25',
			].join('\n')
		);

		expect(query.header).toEqual({
			type: 'table',
			showId: true,
			fields: [
				QueryFields.named('Company', Fields.variable('Company')),
				QueryFields.named('Role', Fields.variable('Role')),
			],
		});
		expect(query.source).toEqual(Sources.folder('People'));
		expect(query.operations).toEqual([
			{
				type: 'where',
				clause: Fields.func(Fields.variable('contains'), [
					Fields.variable('Connection'),
					thisFileLink,
				]),
			},
			sortCdayDesc,
			limit25,
		]);
	});

	it('attaches the upstream default query settings', () => {
		expect((parseOk('LIST') as Query & { settings: unknown }).settings).toBe(
			DEFAULT_QUERY_SETTINGS
		);
	});
});

describe('parseQuery: query types and clauses', () => {
	it('parses LIST with and without a format field', () => {
		expect(parseOk('LIST').header).toEqual({ type: 'list', showId: true });
		expect(parseOk('LIST file.mtime').header).toEqual({
			type: 'list',
			showId: true,
			format: Fields.indexVariable('file.mtime'),
		});
	});

	it('defaults the source to the whole vault when FROM is absent', () => {
		expect(parseOk('LIST').source).toEqual(Sources.folder(''));
	});

	it('parses TASK', () => {
		const query = parseOk('TASK FROM "Projects" WHERE !completed');
		expect(query.header).toEqual({ type: 'task' });
		expect(query.source).toEqual(Sources.folder('Projects'));
		expect(query.operations).toEqual([
			{ type: 'where', clause: Fields.negate(Fields.variable('completed')) },
		]);
	});

	it('parses WITHOUT ID on TABLE and LIST', () => {
		const table = parseOk('TABLE WITHOUT ID file.link AS Note');
		expect(table.header).toEqual({
			type: 'table',
			showId: false,
			fields: [QueryFields.named('Note', Fields.indexVariable('file.link'))],
		});
		expect(parseOk('LIST WITHOUT ID file.name').header).toEqual({
			type: 'list',
			showId: false,
			format: Fields.indexVariable('file.name'),
		});
	});

	it('parses GROUP BY, with and without an alias', () => {
		expect(parseOk('TABLE rows.file.link GROUP BY status').operations).toEqual([
			{ type: 'group', field: QueryFields.named('status', Fields.variable('status')) },
		]);
		expect(parseOk('LIST GROUP BY file.folder AS Folder').operations).toEqual([
			{ type: 'group', field: QueryFields.named('Folder', Fields.indexVariable('file.folder')) },
		]);
	});

	it('parses FLATTEN with an alias', () => {
		expect(parseOk('TABLE tag FLATTEN file.tags AS tag').operations).toEqual([
			{ type: 'flatten', field: QueryFields.named('tag', Fields.indexVariable('file.tags')) },
		]);
	});

	it('keeps clause order, including repeated clauses', () => {
		const types = parseOk('LIST WHERE a SORT b ASC WHERE c LIMIT 5').operations.map(
			(op) => op.type
		);
		expect(types).toEqual(['where', 'sort', 'where', 'limit']);
	});
});

describe('parseQuery: sources', () => {
	it('parses a negated tag source', () => {
		expect(parseOk('LIST FROM -#archived').source).toEqual(
			Sources.negate(Sources.tag('#archived'))
		);
	});

	it('parses a link source as incoming links', () => {
		expect(parseOk('LIST FROM [[People/Alice]]').source).toEqual(
			Sources.link('People/Alice', true)
		);
	});

	it('parses outgoing([[link]]) as outgoing links', () => {
		expect(parseOk('LIST FROM outgoing([[People/Alice]])').source).toEqual(
			Sources.link('People/Alice', false)
		);
	});

	it('parses and, or, and parentheses', () => {
		expect(parseOk('LIST FROM #a and (#b or "c")').source).toEqual(
			Sources.and(Sources.tag('#a'), Sources.or(Sources.tag('#b'), Sources.folder('c')))
		);
	});
});

describe('parseQuery: malformed queries', () => {
	it.each([
		['an unknown query type', 'SELECT * FROM "People"'],
		['a WHERE with no expression', 'TABLE file.name WHERE'],
		['an unterminated folder source', 'LIST FROM "People'],
	])('rejects %s with a readable message', (_label, text) => {
		const result = parseQuery(text);
		expect(result.successful).toBe(false);
		if (result.successful) return;
		expect(result.error).toContain('PARSING FAILED');
		expect(result.error).toMatch(/Expected/);
	});
});

describe('parseField', () => {
	it('parses a comparison into a binary op', () => {
		expect(parseField('file.size > 100').orElseThrow()).toEqual(
			Fields.binaryOp(Fields.indexVariable('file.size'), '>', Fields.literal(100))
		);
	});

	it('parses a wiki link into a Link literal', () => {
		const field = parseField('[[People/Alice]]').orElseThrow();
		expect(field.type).toBe('literal');
		if (field.type !== 'literal') return;
		expect(Values.isLink(field.value) && field.value.path).toBe('People/Alice');
	});

	it('returns a failure for an incomplete expression', () => {
		const result = parseField('1 +');
		expect(result.successful).toBe(false);
	});
});
