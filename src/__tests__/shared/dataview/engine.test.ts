/**
 * The vendored engine over a real index (D2, DV-1, DV-2, DV-9): `executeDql` and `executeInlineDql`
 * (src/shared/dataview/execute.ts) run against a main-process `VaultIndex` built over a temp copy of
 * the fixture vault, with `this` bound to `People/Pedram Amini.md`. `file.ctime` is stubbed from each
 * note's frontmatter `created`, as the fixture README says, so the `file.cday` sorts are stable.
 * Every result must also survive `JSON.stringify` and the revive helpers (the IPC, bridge, and CLI path).
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('../../../main/utils/sentry', () => ({ captureException: vi.fn() }));

import {
	Link,
	Values,
	executeDql,
	executeInlineDql,
	mapTaskGroups,
	reviveDataviewInlineResult,
	reviveDataviewResult,
	toWireValue,
	type DataviewInlineResult,
	type DataviewResult,
	type DataviewWireValue,
	type Literal,
	type RevivedDataviewResult,
} from '../../../shared/dataview';
import { createLocalVaultFs } from '../../../main/dataview/vault-fs';
import { VaultIndex } from '../../../main/dataview/vault-index';
import {
	DATAVIEW_FIXTURE_VAULT,
	withFixtureCreatedTimes,
} from '../../helpers/dataviewFixtureVault';

const THIS_PATH = 'People/Pedram Amini.md';

/** The spec's two motivating blocks, exactly as `People/Pedram Amini.md` holds them. */
const MEETINGS_QUERY = [
	'TABLE file.cday as Created, Summary',
	'FROM #meeting or "meetings"',
	'WHERE contains(file.outlinks, this.file.link)',
	'SORT file.cday DESC',
	'LIMIT 25',
].join('\n');
const CONNECTIONS_QUERY = [
	'TABLE Company, Role',
	'FROM "People"',
	'WHERE contains(Connection, this.file.link)',
	'SORT file.cday DESC',
	'LIMIT 25',
].join('\n');

/**
 * A second note with tasks, written into the temp copy only (the fixture vault has tasks in
 * `Notes/Standup.md` alone), so a `TASK` query has two files to group.
 */
const INBOX_TODO = [
	'---',
	'created: 2026-09-12',
	'---',
	'',
	'# Todo',
	'',
	'- [x] ship it',
	'- [ ] tidy up',
	'',
].join('\n');

let tempDir: string;
let index: VaultIndex;

beforeAll(async () => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dataview-engine-'));
	fs.cpSync(DATAVIEW_FIXTURE_VAULT, tempDir, { recursive: true });
	fs.mkdirSync(path.join(tempDir, 'Inbox'));
	fs.writeFileSync(path.join(tempDir, 'Inbox', 'Todo.md'), INBOX_TODO);
	index = new VaultIndex(withFixtureCreatedTimes(createLocalVaultFs(tempDir)), {
		onWarning: () => {},
		watch: false,
	});
	await index.scan();
});

afterAll(async () => {
	await index.dispose();
	fs.rmSync(tempDir, { recursive: true, force: true });
});

function overJson<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

/** Run a block and check that it survives JSON and the revive helper before handing it back. */
async function run(source: string): Promise<DataviewResult> {
	const result = await executeDql(source, THIS_PATH, index);
	expectRoundTrip(result);
	return result;
}

/**
 * The wire result is plain JSON, so a JSON round trip changes nothing; and reviving it, from either
 * side of that trip, restores values that encode back to the same wire form.
 */
function expectRoundTrip(result: DataviewResult): void {
	const travelled = overJson(result);
	expect(travelled).toEqual(result);
	expect(reencode(reviveDataviewResult(travelled))).toEqual(result);
	expect(reencode(reviveDataviewResult(result))).toEqual(result);
}

function reencode(result: RevivedDataviewResult): DataviewResult {
	switch (result.kind) {
		case 'table':
			return { ...result, rows: result.rows.map((row) => row.map(toWireValue)) };
		case 'list':
			return { ...result, items: result.items.map(toWireValue) };
		case 'task':
			return { ...result, groups: mapTaskGroups(result.groups, toWireValue) };
		default:
			return result;
	}
}

/** The path of a wire link (`Transferable` form). */
function linkPath(value: DataviewWireValue): string {
	const revived = reviveDataviewResult({
		kind: 'list',
		items: [value],
		idMeaning: { type: 'path' },
		warnings: [],
	});
	const link = (revived as { items: Literal[] }).items[0];
	expect(Values.isLink(link)).toBe(true);
	return (link as Link).path;
}

function revivedTable(result: DataviewResult) {
	if (result.kind !== 'table') throw new Error(`expected a table, got ${result.kind}`);
	return reviveDataviewResult(result) as Extract<RevivedDataviewResult, { kind: 'table' }>;
}

function isoDate(value: Literal): string | null {
	if (!Values.isDate(value)) throw new Error(`expected a date, got ${JSON.stringify(value)}`);
	return value.toISODate();
}

describe('the motivating blocks on People/Pedram Amini.md', () => {
	it('lists the meetings that link to Pedram, newest file.cday first, with Summary where present', async () => {
		const result = await run(MEETINGS_QUERY);
		const table = revivedTable(result);
		expect(table.headers).toEqual(['File', 'Created', 'Summary']);
		expect(table.idMeaning).toEqual({ type: 'path' });
		expect(table.warnings).toEqual([]);
		expect(
			table.rows.map(([file, created, summary]) => [(file as Link).path, isoDate(created), summary])
		).toEqual([
			['meetings/2026-09-15 Review.md', '2026-09-15', 'Reviewed the vendoring map.'],
			['Notes/Standup.md', '2026-09-10', null],
			['meetings/2026-09-01 Kickoff.md', '2026-09-01', 'Kicked off the Dataview work.'],
		]);
		// The id column is a real link; no tag-only, folder-only, unlinked, or dot-folder note leaks in.
		expect(table.rows.every(([file]) => file instanceof Link)).toBe(true);
	});

	it('lists the People connected to Pedram with Company and Role', async () => {
		// The task text names Rami; the fixture README's expected table also has Dana, whose
		// `Connection` is a list holding Pedram, so both rows are asserted (Dana is newer).
		const table = revivedTable(await run(CONNECTIONS_QUERY));
		expect(table.headers).toEqual(['File', 'Company', 'Role']);
		expect(table.rows.map(([file, ...rest]) => [(file as Link).path, ...rest])).toEqual([
			['People/Dana Sample.md', 'Sample Labs', 'Researcher'],
			['People/Rami Example.md', 'Example Corp', 'Security Engineer'],
		]);
	});
});

describe('query types and steps', () => {
	it('LIST returns one page link per row', async () => {
		const result = await run('LIST\nFROM "People"\nSORT file.name ASC');
		if (result.kind !== 'list') throw new Error(`expected a list, got ${result.kind}`);
		expect(result.idMeaning).toEqual({ type: 'path' });
		expect(result.items.map(linkPath)).toEqual([
			'People/Dana Sample.md',
			'People/Lee Outsider.md',
			'People/Pedram Amini.md',
			'People/Rami Example.md',
		]);
	});

	it('TASK returns the tasks with completion state and line numbers', async () => {
		const result = await run('TASK\nFROM "Notes"');
		if (result.kind !== 'task') throw new Error(`expected tasks, got ${result.kind}`);
		const tasks = result.groups as { [key: string]: DataviewWireValue }[];
		expect(
			tasks.map((task) => [task.path, task.line, task.text, task.completed, task.status])
		).toEqual([
			['Notes/Standup.md', 8, 'follow up [due:: 2026-10-05]', false, ' '],
			['Notes/Standup.md', 9, 'done item', true, 'x'],
			[
				'Notes/Standup.md',
				10,
				'review the parser [priority:: high] (owner:: [[Rami Example]])',
				false,
				' ',
			],
			['Notes/Standup.md', 14, 'nested task under a list item', false, ' '],
		]);
		// The task's own fields travel; the page fields the engine copied on for WHERE do not.
		expect(tasks[0]).toHaveProperty('due');
		expect(tasks[0]).not.toHaveProperty('file');
		expect(tasks[0]).not.toHaveProperty('subtasks');
		expect(tasks[3].parent).toBe(11);
	});

	it("TASK grouped by file keys each group by the file link, with each file's tasks in line order", async () => {
		const result = await run('TASK\nFROM "Notes" or "Inbox"\nWHERE !completed\nGROUP BY file.link');
		if (result.kind !== 'task') throw new Error(`expected tasks, got ${result.kind}`);
		expect(result.idMeaning).toEqual({ type: 'group', name: 'file.link', on: { type: 'path' } });
		const groups = result.groups as {
			key: DataviewWireValue;
			rows: { [key: string]: DataviewWireValue }[];
		}[];
		expect(
			groups.map((group) => [
				linkPath(group.key),
				group.rows.map((task) => [task.line, task.text, task.completed]),
			])
		).toEqual([
			['Inbox/Todo.md', [[7, 'tidy up', false]]],
			[
				'Notes/Standup.md',
				[
					[8, 'follow up [due:: 2026-10-05]', false],
					[10, 'review the parser [priority:: high] (owner:: [[Rami Example]])', false],
					[14, 'nested task under a list item', false],
				],
			],
		]);
	});

	it('GROUP BY puts the group key in the id column and the grouped rows under rows', async () => {
		const table = revivedTable(
			await run('TABLE rows.file.link AS People\nFROM "People"\nGROUP BY Company')
		);
		expect(table.headers).toEqual(['Company', 'People']);
		expect(table.idMeaning).toEqual({ type: 'group', name: 'Company', on: { type: 'path' } });
		expect(
			table.rows.map(([company, people]) => [company, (people as Link[]).map((link) => link.path)])
		).toEqual([
			[null, ['People/Pedram Amini.md']],
			['Example Corp', ['People/Rami Example.md']],
			['Outside Inc', ['People/Lee Outsider.md']],
			['Sample Labs', ['People/Dana Sample.md']],
		]);
	});

	it('FLATTEN makes one row per element of a list field', async () => {
		const table = revivedTable(
			await run('TABLE Connection\nFROM "People"\nFLATTEN Connection\nSORT file.name ASC')
		);
		expect(table.headers).toEqual(['File', 'Connection']);
		const rows = table.rows.map(([file, connection]) => [
			(file as Link).path,
			connection === null ? null : (connection as Link).path,
		]);
		expect(rows).toEqual([
			['People/Dana Sample.md', 'People/Pedram Amini.md'],
			['People/Dana Sample.md', 'People/Rami Example.md'],
			['People/Dana Sample.md', 'Projects/Alpha/Design/Spec.md'],
			['People/Lee Outsider.md', 'People/Rami Example.md'],
			['People/Pedram Amini.md', null],
			['People/Rami Example.md', 'People/Pedram Amini.md'],
		]);
		// A link with display text keeps it across the wire.
		expect((table.rows[2][1] as Link).display).toBe('the spec');
	});

	it('TABLE WITHOUT ID drops the id column', async () => {
		const table = revivedTable(
			await run(
				'TABLE WITHOUT ID file.link AS Note, Summary\nFROM "meetings"\nWHERE Summary\nSORT file.name ASC'
			)
		);
		expect(table.headers).toEqual(['Note', 'Summary']);
		expect(table.rows.map(([note, summary]) => [(note as Link).path, summary])).toEqual([
			['meetings/2026-09-01 Kickoff.md', 'Kicked off the Dataview work.'],
			['meetings/2026-09-15 Review.md', 'Reviewed the vendoring map.'],
			['meetings/2026-09-20 Unrelated.md', 'A meeting without Pedram.'],
		]);
	});

	it('renders an unknown field as null, not an error', async () => {
		const result = await run('TABLE NoSuchField\nFROM "People"\nSORT file.name ASC');
		if (result.kind !== 'table') throw new Error(`expected a table, got ${result.kind}`);
		expect(result.warnings).toEqual([]);
		expect(result.rows).toHaveLength(4);
		expect(result.rows.every((row) => row[1] === null)).toBe(true);
	});

	it('reports CALENDAR as unsupported', async () => {
		expect(await run('CALENDAR file.cday\nFROM "meetings"')).toEqual({
			kind: 'unsupported',
			feature: 'CALENDAR',
		});
	});

	it("reports a parse error with Dataview's message and the line it stopped on", async () => {
		const result = await run('TABLE file.name\nFROM WHERE');
		expect(result.kind).toBe('error');
		if (result.kind !== 'error') return;
		expect(result.message).toMatch(/^Dataview: /);
		expect(result.message).toContain('PARSING FAILED');
		expect(result.line).toBe(2);
	});
});

describe('inline DQL', () => {
	it('evaluates = this.file.name against the bound page', () => {
		const result = executeInlineDql('= this.file.name', THIS_PATH, index);
		expect(result).toEqual({ kind: 'value', value: 'Pedram Amini' });
		const travelled = overJson(result) as DataviewInlineResult;
		expect(travelled).toEqual(result);
		expect(reviveDataviewInlineResult(travelled)).toEqual({ kind: 'value', value: 'Pedram Amini' });
	});

	it('revives a link value from this.file.link', () => {
		const result = executeInlineDql('this.file.link', THIS_PATH, index);
		const revived = reviveDataviewInlineResult(overJson(result));
		expect(revived.kind).toBe('value');
		if (revived.kind !== 'value') return;
		expect(revived.value).toBeInstanceOf(Link);
		expect((revived.value as Link).path).toBe(THIS_PATH);
	});
});
