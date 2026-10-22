/**
 * The DataviewJS sandbox guest (D4, D5, D6, DV-11) under jsdom: the runtime in
 * src/renderer/dataview-sandbox/ runs note scripts against an index snapshot of the fixture vault, with a
 * fake host that answers `query.dql` with the shared executor and `io.load` from the fixture files.
 *
 * Under vitest, inline scripts run in jsdom's own realm, not the test's `globalThis`, exactly as the
 * guest runs them in its page (DEV-6). `dataviewGuestRealm()` reaches that realm's global.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
	PageIndex,
	SANDBOX_TO_GUEST_CHANNEL,
	SANDBOX_TO_HOST_CHANNEL,
	executeDql,
	parseSandboxMessage,
	sandboxEnvelope,
	type SandboxEvalResultMessage,
	type SandboxGuestMessage,
	type SandboxIndexSnapshot,
} from '../../../shared/dataview';
import {
	INLINE_ELEMENT_MESSAGE,
	blockScriptBody,
	createDataviewGuest,
	inlineScriptBody,
	startDataviewGuest,
	type DataviewGuest,
} from '../../../renderer/dataview-sandbox/guestRuntime';
import { compileInlineScript } from '../../../renderer/dataview-sandbox/inlineScript';
import { renderMarkdown } from '../../../renderer/dataview-sandbox/markdownDom';
import { OBSIDIAN_API_UNAVAILABLE } from '../../../renderer/dataview-sandbox/dvApi';
import { fixtureSnapshot, fixtureText } from '../../helpers/dataviewFixtureVault';
import { dataviewGuestRealm, type DataviewGuestRealm } from '../../helpers/dataviewGuestRealm';

/** The `dv` members D5 lists, top level (`io` holds `load`, `csv`, and `normalize`). */
const D5_MEMBERS = [
	'current',
	'page',
	'pages',
	'pagePaths',
	'array',
	'isArray',
	'fileLink',
	'sectionLink',
	'blockLink',
	'date',
	'duration',
	'compare',
	'equal',
	'clone',
	'parse',
	'luxon',
	'func',
	'el',
	'header',
	'paragraph',
	'span',
	'list',
	'taskList',
	'table',
	'markdownTable',
	'markdownList',
	'markdownTaskList',
	'query',
	'tryQuery',
	'queryMarkdown',
	'tryQueryMarkdown',
	'evaluate',
	'tryEvaluate',
	'execute',
	'io',
	'view',
	'container',
];

interface Harness {
	guest: DataviewGuest;
	root: HTMLElement;
	sent: SandboxGuestMessage[];
	realm: DataviewGuestRealm;
	run(
		source: string,
		options?: { thisPath?: string; blockId?: string; runId?: string }
	): Promise<{ block: HTMLElement; outcome: SandboxGuestMessage | undefined }>;
	/** Evaluate inline `$=` expressions as one `eval` run; the guest's `eval.result` answers, in order. */
	evaluate(sources: string[], options?: { thisPath?: string }): Promise<SandboxEvalResultMessage[]>;
}

/**
 * A guest and a fake host over the fixture vault snapshot. `readText` stands in for the host's file
 * read, so a test can serve the bytes another checkout would have (CRLF on Windows).
 */
function createHarness(readText: (relPath: string) => string = fixtureText): Harness {
	const snapshot: SandboxIndexSnapshot = fixtureSnapshot();
	const hostIndex = PageIndex.fromSnapshot(snapshot, async (relPath) => readText(relPath));
	const root = document.createElement('div');
	document.body.append(root);
	const sent: SandboxGuestMessage[] = [];
	const realm = dataviewGuestRealm();
	let guest: DataviewGuest;
	const send = (message: SandboxGuestMessage) => {
		sent.push(message);
		if (message.type === 'query.dql') {
			void executeDql(message.source, message.originPath ?? '', hostIndex).then((result) =>
				guest.receive({ type: 'query.dql.result', requestId: message.requestId, result })
			);
		} else if (message.type === 'io.load') {
			const text = snapshot.files.includes(message.path) ? readText(message.path) : null;
			void guest.receive({ type: 'io.load.result', requestId: message.requestId, text });
		}
	};
	guest = createDataviewGuest({ document, root, scriptGlobal: realm, send });
	let runCount = 0;
	return {
		guest,
		root,
		sent,
		realm,
		async run(source, { thisPath = 'Scripts/JS Demo.md', blockId = 'block-1', runId } = {}) {
			const id = runId ?? `run-${++runCount}`;
			await guest.receive({ type: 'run', runId: id, blockId, source, thisPath, snapshot });
			const block = root.querySelector(`[data-block-id="${blockId}"]`) as HTMLElement;
			const outcome = sent.find(
				(message) =>
					(message.type === 'render.done' || message.type === 'render.error') &&
					message.runId === id
			);
			return { block, outcome };
		},
		async evaluate(sources, { thisPath = 'Scripts/JS Demo.md' } = {}) {
			const runId = `inline-run-${++runCount}`;
			const expressions = sources.map((source, index) => ({ id: `expr-${index + 1}`, source }));
			await guest.receive({ type: 'eval', runId, thisPath, snapshot, expressions });
			return sent.filter(
				(message): message is SandboxEvalResultMessage =>
					message.type === 'eval.result' && message.runId === runId
			);
		},
	};
}

function texts(elements: Iterable<Element>): string[] {
	return Array.from(elements, (element) => element.textContent ?? '');
}

function click(element: Element, init: MouseEventInit = {}): void {
	element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init }));
}

let harness: Harness;

beforeEach(() => {
	harness = createHarness();
});

afterEach(() => {
	// Everything the guest sent is something the host accepts.
	for (const message of harness.sent) {
		expect(parseSandboxMessage(message, 'guest')).toMatchObject({ ok: true });
	}
	harness.root.remove();
	delete harness.realm.__captured;
});

describe('the dv object', () => {
	it('exposes exactly the D5 surface, and app throws on dv, this, and the global', async () => {
		const { outcome } = await harness.run(
			'globalThis.__captured = { keys: Object.keys(dv), io: Object.keys(dv.io), same: this === dv && dataview === dv };'
		);
		expect(outcome).toMatchObject({ type: 'render.done' });
		const captured = harness.realm.__captured as { keys: string[]; io: string[]; same: boolean };
		expect([...captured.keys].sort()).toEqual([...D5_MEMBERS].sort());
		expect([...captured.io].sort()).toEqual(['csv', 'load', 'normalize']);
		expect(captured.same).toBe(true);
	});

	it.each([
		"dv.paragraph(app.vault.getMarkdownFiles().length + ' files');",
		'this.app.vault.getMarkdownFiles();',
		'dv.app.plugins;',
		'window.app.workspace;',
		'DataviewAPI.pages();',
	])('fails with the Obsidian API error: %s', async (source) => {
		const { block, outcome } = await harness.run(source);
		expect(outcome).toMatchObject({ type: 'render.error', blockId: 'block-1' });
		const message = (outcome as { message: string }).message;
		expect(message.startsWith('Evaluation Error: ')).toBe(true);
		expect(message).toContain(OBSIDIAN_API_UNAVAILABLE);
		expect(block.textContent).toBe('');
	});

	it('renders dv.table with links, dates, and the result count', async () => {
		const { block, outcome } = await harness.run(
			"dv.table(['Meeting', 'Created'], dv.pages('#meeting').sort((p) => p.file.cday, 'desc').map((p) => [p.file.link, p.file.cday]));"
		);
		expect(outcome).toMatchObject({ type: 'render.done', blockId: 'block-1' });
		const table = block.querySelector('table.dataview.table-view-table')!;
		const headers = table.querySelectorAll('th.table-view-th');
		expect(headers[0].querySelector('.small-text')!.textContent).toBe('3');
		expect(headers[1].textContent).toBe('Created');
		const rows = Array.from(table.querySelectorAll('tbody tr'), (row) =>
			texts(row.querySelectorAll('td'))
		);
		expect(rows).toEqual([
			['2026-09-20 Unrelated', 'September 20, 2026'],
			['Standup', 'September 10, 2026'],
			['2026-09-01 Kickoff', 'September 01, 2026'],
		]);
		const links = table.querySelectorAll('a.internal-link');
		expect(links[1].getAttribute('data-dataview-path')).toBe('Notes/Standup.md');
	});

	it('renders the empty-result notice for an empty dv.table', async () => {
		const { block } = await harness.run("dv.table(['Name'], []);");
		expect(block.querySelector('.dataview-error-message')!.textContent).toBe(
			'Dataview: No results to show for table query.'
		);
	});

	it('renders dv.list over swizzled page fields', async () => {
		const { block } = await harness.run(
			'dv.list(dv.pages(\'"People"\').sort((p) => p.file.name).file.name);'
		);
		expect(texts(block.querySelectorAll('ul.list-view-ul > li'))).toEqual([
			'Dana Sample',
			'Lee Outsider',
			'Pedram Amini',
			'Rami Example',
		]);
	});

	it("filters dv.pages('#meeting') with where", async () => {
		const { block } = await harness.run(
			"dv.list(dv.pages('#meeting').where((p) => p.file.folder === 'meetings').file.name.sort());"
		);
		expect(texts(block.querySelectorAll('li'))).toEqual([
			'2026-09-01 Kickoff',
			'2026-09-20 Unrelated',
		]);
	});

	it('binds dv.current() and dv.func to the note the block sits in', async () => {
		const { block } = await harness.run(
			[
				'const me = dv.current();',
				'dv.paragraph(me.file.name);',
				'dv.list(dv.pages(\'#meeting or "meetings"\').where((p) => dv.func.contains(p.file.outlinks, me.file.link)).file.name.sort());',
				"dv.span(dv.evaluate('this.file.name').value);",
			].join('\n'),
			{ thisPath: 'People/Pedram Amini.md' }
		);
		expect(block.querySelector('p')!.textContent).toBe('Pedram Amini');
		expect(texts(block.querySelectorAll('li'))).toEqual([
			'2026-09-01 Kickoff',
			'2026-09-15 Review',
			'Standup',
		]);
		expect(block.querySelector(':scope > div > span')!.textContent).toBe('Pedram Amini');
	});

	it('renders dv.taskList grouped by file, and a checkbox click toggles the task in its own file', async () => {
		const { block } = await harness.run(
			'dv.taskList(dv.pages(\'"Notes"\').file.tasks.where((t) => !t.completed));'
		);
		const heading = block.querySelector('h4')!;
		expect(heading.querySelector('a.internal-link')!.textContent).toBe('Standup');
		expect(heading.querySelector('.small-text')!.textContent).toBe('3');
		const items = block.querySelectorAll('ul.contains-task-list > li.task-list-item');
		expect(texts(items)).toEqual([
			'follow up [due:: 2026-10-05]',
			'review the parser [priority:: high] (owner:: Rami Example)',
			'nested task under a list item',
		]);
		// The task's own text resolves its links from its own file.
		expect(items[1].querySelector('a')!.getAttribute('data-dataview-path')).toBe(
			'People/Rami Example.md'
		);

		const checkbox = items[0].querySelector('input[type="checkbox"]') as HTMLInputElement;
		expect(checkbox.checked).toBe(false);
		click(checkbox);
		expect(harness.sent).toContainEqual({
			type: 'toggle.task',
			path: 'Notes/Standup.md',
			line: 9,
			text: 'follow up [due:: 2026-10-05]',
		});
		expect(items[0].getAttribute('data-task')).toBe('x');
	});

	it('renders dv.paragraph markdown, and its links send open.link', async () => {
		const { block } = await harness.run(
			"dv.paragraph('**Bold** with [[Rami Example|Rami]] and [docs](https://example.com/docs)'); dv.paragraph(dv.fileLink('People/Dana Sample.md'));",
			{ thisPath: 'People/Pedram Amini.md' }
		);
		const [first, second] = block.querySelectorAll('p');
		expect(first.querySelector('strong')!.textContent).toBe('Bold');
		const internal = first.querySelector('a.internal-link')!;
		expect(internal.textContent).toBe('Rami');
		expect(internal.getAttribute('data-dataview-path')).toBe('People/Rami Example.md');
		const external = first.querySelector('a.external-link')!;
		expect(external.getAttribute('href')).toBe('https://example.com/docs');
		expect(second.textContent).toBe('Dana Sample');

		click(internal);
		click(external, { metaKey: true });
		click(second.querySelector('a')!, { ctrlKey: true });
		expect(harness.sent.filter((message) => message.type === 'open.link')).toEqual([
			{ type: 'open.link', kind: 'file', path: 'People/Rami Example.md', newTab: false },
			{ type: 'open.link', kind: 'url', url: 'https://example.com/docs', newTab: true },
			{ type: 'open.link', kind: 'file', path: 'People/Dana Sample.md', newTab: true },
		]);
	});

	it('renders a <script> or an onerror attribute in markdown text as inert text', async () => {
		const attack =
			'<script>globalThis.__pwned = 1</script><img src=x onerror="globalThis.__pwned = 2">';
		const { block, outcome } = await harness.run(
			[
				`dv.paragraph(${JSON.stringify(attack)});`,
				`dv.table(['Cell'], [[${JSON.stringify('<b onmouseover="globalThis.__pwned = 3">bold</b>')}]]);`,
				`dv.paragraph(dv.fileLink('People/Rami Example.md', false, ${JSON.stringify(attack)}));`,
				`dv.paragraph(${JSON.stringify(`[[Rami Example|${attack}]]`)});`,
			].join('\n')
		);
		expect(outcome).toMatchObject({ type: 'render.done' });
		expect(block.querySelector('script, img, b, [onerror], [onmouseover]')).toBeNull();
		expect(block.querySelector('p')!.textContent).toBe(attack);
		expect(block.querySelectorAll('a.internal-link')[0].textContent).toBe(attack);
		expect(harness.realm.__pwned).toBeUndefined();
	});

	it('runs dv.view with its CSS, and reads vault files with dv.io.csv and dv.io.load', async () => {
		const { block, outcome } = await harness.run(
			[
				"await dv.view('views/sample', { title: 'People' });",
				"const rows = await dv.io.csv('data/people.csv');",
				"dv.table(['Name', 'Company'], rows.map((r) => [r.name, r.company]));",
				"const text = await dv.io.load('data/people.csv');",
				"globalThis.__captured = { first: text.split(/\\r?\\n/)[0], outside: await dv.io.load('../outside.md'), hidden: await dv.io.load('.obsidian/app.json'), normalized: dv.io.normalize('people.csv', 'data/x.md') };",
			].join('\n'),
			{ thisPath: 'Scripts/JS Demo.md' }
		);
		expect(outcome).toMatchObject({ type: 'render.done' });
		expect(block.querySelector('h3')!.textContent).toBe('People');
		expect(block.querySelector('div.sample-view')!.textContent).toBe(
			'Rendered by views/sample/view.js'
		);
		expect(block.querySelector('style')!.textContent).toContain('.sample-view');
		expect(texts(block.querySelectorAll('ul.list-view-ul > li'))).toHaveLength(4);
		expect(
			Array.from(block.querySelectorAll('tbody tr'), (row) => texts(row.querySelectorAll('td')))
		).toEqual([
			['Rami Example', 'Example Corp'],
			['Dana Sample', 'Sample Labs'],
		]);
		expect(harness.realm.__captured).toEqual({
			first: 'name,company',
			outside: undefined,
			hidden: undefined,
			normalized: 'data/people.csv',
		});
		// Paths the vault does not list never reach the host.
		const loads = harness.sent.filter((message) => message.type === 'io.load');
		expect(loads.map((message) => (message as { path: string }).path).sort()).toEqual([
			'data/people.csv',
			'data/people.csv',
			'views/sample/view.css',
			'views/sample/view.js',
		]);
	});

	it('reads a CRLF file (a Windows checkout) as clean rows, and dv.io.load returns it unchanged', async () => {
		harness.root.remove();
		harness = createHarness((relPath) => fixtureText(relPath).replace(/\r?\n/g, '\r\n'));
		const { block, outcome } = await harness.run(
			[
				"const rows = await dv.io.csv('data/people.csv');",
				"dv.table(['Name', 'Company'], rows.map((r) => [r.name, r.company]));",
				"globalThis.__captured = await dv.io.load('data/people.csv');",
			].join('\n')
		);
		expect(outcome).toMatchObject({ type: 'render.done' });
		expect(
			Array.from(block.querySelectorAll('tbody tr'), (row) => texts(row.querySelectorAll('td')))
		).toEqual([
			['Rami Example', 'Example Corp'],
			['Dana Sample', 'Sample Labs'],
		]);
		// Upstream's dv.io.load is the raw file text; only the CSV parser drops the line endings.
		expect(harness.realm.__captured).toBe(
			'name,company\r\nRami Example,Example Corp\r\nDana Sample,Sample Labs\r\n'
		);
	});

	it('fails the run when a render call gets bad rows, even when the script does not await it', async () => {
		const { block, outcome } = await harness.run(
			"dv.paragraph('before'); dv.table(['A'], [1, 2]);"
		);
		expect(outcome).toMatchObject({ type: 'render.error' });
		expect((outcome as { message: string }).message).toContain(
			'dv.table expects every row to be an array; got number.'
		);
		expect(block.textContent).toBe('');
	});

	it('shows dv.execute of something that is not DQL text without asking the host', async () => {
		const { block, outcome } = await harness.run('dv.execute(5);');
		expect(outcome).toMatchObject({ type: 'render.done' });
		expect(block.querySelector('pre.dataview-error')!.textContent).toBe(
			'Dataview: DQL must be text, not number.'
		);
		expect(harness.sent.some((message) => message.type === 'query.dql')).toBe(false);
	});

	it('shows a missing view as upstream does', async () => {
		const { block } = await harness.run("await dv.view('views/none');");
		expect(block.querySelector('pre.dataview-error')!.textContent).toBe(
			"Dataview: custom view not found for 'views/none.js' or 'views/none/view.js'."
		);
	});

	it('runs DQL through the host for dv.query, dv.queryMarkdown, and dv.execute', async () => {
		const { block, outcome } = await harness.run(
			[
				'const list = await dv.tryQuery(\'LIST FROM "People" SORT file.name\');',
				"const bad = await dv.query('TABLE FROM');",
				'const markdown = await dv.tryQueryMarkdown(\'TABLE WITHOUT ID Company FROM "People" WHERE Company SORT file.name\');',
				"globalThis.__captured = { type: list.type, names: list.values.map((link) => link.path), bad: bad.successful ? '' : bad.error, markdown };",
				'await dv.execute(\'TABLE Company, Role FROM "People" WHERE contains(Connection, this.file.link) SORT file.cday DESC\');',
			].join('\n'),
			{ thisPath: 'People/Pedram Amini.md' }
		);
		expect(outcome).toMatchObject({ type: 'render.done' });
		const captured = harness.realm.__captured as Record<string, unknown>;
		expect(captured.type).toBe('list');
		expect(captured.names).toEqual([
			'People/Dana Sample.md',
			'People/Lee Outsider.md',
			'People/Pedram Amini.md',
			'People/Rami Example.md',
		]);
		// Upstream's own failure text (`"" + error`), without the `Dataview: ` prefix blocks add.
		expect(captured.bad).toMatch(/^Error: \n-- PARSING FAILED --/);
		expect(captured.markdown).toBe(
			'| Company      |\n| ------------ |\n| Sample Labs  |\n| Outside Inc  |\n| Example Corp |\n'
		);
		const rows = Array.from(block.querySelectorAll('tbody tr'), (row) =>
			texts(row.querySelectorAll('td'))
		);
		expect(rows).toEqual([
			['Dana Sample', 'Sample Labs', 'Researcher'],
			['Rami Example', 'Example Corp', 'Security Engineer'],
		]);
		const queries = harness.sent.filter((message) => message.type === 'query.dql');
		expect(
			queries.every(
				(message) => (message as { originPath?: string }).originPath === 'People/Pedram Amini.md'
			)
		).toBe(true);
	});

	it('exports tables, lists, and tasks to markdown', async () => {
		await harness.run(
			[
				'globalThis.__captured = {',
				"\ttable: dv.markdownTable(['A', 'B'], [[1, 'x']]),",
				"\tlist: dv.markdownList(['a', 'b']),",
				'\ttasks: dv.markdownTaskList(dv.pages(\'"Notes"\').file.tasks.where((t) => !t.completed)),',
				'};',
			].join('\n')
		);
		expect(harness.realm.__captured).toEqual({
			table: '| A | B |\n| - | - |\n| 1 | x |\n',
			list: '- a\n- b\n',
			tasks:
				'- [ ] follow up [due:: 2026-10-05]\n' +
				'- [ ] review the parser [priority:: high] (owner:: [[Rami Example]])\n' +
				'- [ ] nested task under a list item\n',
		});
	});
});

describe('runs', () => {
	it('reports the block height with render.done, and replaces the output on the next run', async () => {
		const first = await harness.run("dv.paragraph('one');");
		expect(first.outcome).toEqual({
			type: 'render.done',
			blockId: 'block-1',
			runId: 'run-1',
			height: 0,
		});
		const second = await harness.run("dv.paragraph('two');");
		expect(second.outcome).toMatchObject({ type: 'render.done', runId: 'run-2' });
		expect(texts(second.block.querySelectorAll('p'))).toEqual(['two']);
	});

	it('reports a syntax error and a thrown error as Evaluation Error', async () => {
		const syntax = await harness.run('dv.paragraph(;');
		expect(syntax.outcome).toMatchObject({ type: 'render.error', runId: 'run-1' });
		// Chromium's stack starts with the error; Node's vm (under jsdom) puts the source line first.
		expect((syntax.outcome as { message: string }).message).toMatch(
			/^Evaluation Error: [\s\S]*SyntaxError: Unexpected token/
		);
		const thrown = await harness.run("dv.paragraph('partial'); throw new Error('boom');");
		expect(thrown.outcome).toMatchObject({ type: 'render.error', runId: 'run-2' });
		const message = (thrown.outcome as { message: string }).message;
		expect(message).toMatch(/^Evaluation Error: Error: boom/);
		// The script's first line is line 1 of the stack, as with upstream's `eval`.
		expect(message.split('\n')[1]).toMatch(/:1:\d+\)$/);
		expect(thrown.block.textContent).toBe('');
	});

	it('runs a script that ends in a line comment, with or without await', async () => {
		const plain = await harness.run("dv.paragraph('a'); // trailing");
		expect(plain.outcome).toMatchObject({ type: 'render.done' });
		const awaited = await harness.run("await dv.paragraph('b'); // trailing");
		expect(awaited.outcome).toMatchObject({ type: 'render.done' });
		expect(blockScriptBody('await x;')).toBe(
			'return (async () => { const dataview = this;const dv = this;await x;\n})();'
		);
	});

	it('drops the answer of a run a newer run replaced', async () => {
		const stale = harness.run(
			"await new Promise((resolve) => { globalThis.__releaseStale = resolve; }); dv.paragraph('stale');",
			{ runId: 'stale' }
		);
		await Promise.resolve();
		const fresh = await harness.run("dv.paragraph('fresh');", { runId: 'fresh' });
		(harness.realm.__releaseStale as () => void)();
		await stale;
		expect(fresh.outcome).toMatchObject({ type: 'render.done', runId: 'fresh' });
		expect(harness.sent.some((message) => 'runId' in message && message.runId === 'stale')).toBe(
			false
		);
		expect(texts(fresh.block.querySelectorAll('p'))).toEqual(['fresh']);
		delete harness.realm.__releaseStale;
	});

	it('drops host messages the protocol refuses', async () => {
		await harness.guest.receive({ type: 'open.link', kind: 'file', path: 'x.md', newTab: false });
		await harness.guest.receive({
			type: 'run',
			runId: 'r',
			blockId: 'b',
			source: 'dv.paragraph(1)',
		});
		expect(harness.root.children).toHaveLength(0);
		expect(harness.sent).toEqual([]);
	});
});

describe('startDataviewGuest', () => {
	it('talks to the preload through envelopes on its own window', async () => {
		const posted: unknown[] = [];
		const listeners: ((event: { data: unknown }) => void)[] = [];
		const root = document.createElement('div');
		root.id = 'dataview-root';
		document.body.append(root);
		const fakeWindow = {
			document,
			postMessage: (data: unknown) => posted.push(data),
			addEventListener: (_type: string, listener: (event: { data: unknown }) => void) =>
				listeners.push(listener),
			// The global note scripts see; the guest locks it down.
			...{},
		};
		startDataviewGuest(fakeWindow as unknown as Window);
		expect(() => (fakeWindow as unknown as DataviewGuestRealm).app).toThrow(
			OBSIDIAN_API_UNAVAILABLE
		);

		const snapshot = fixtureSnapshot();
		const message = {
			type: 'run',
			runId: 'r1',
			blockId: 'b1',
			source: "dv.paragraph('hi');",
			thisPath: 'Scripts/JS Demo.md',
			snapshot,
		};
		// Its own posts and other channels are not host messages.
		for (const listener of listeners)
			listener({ data: sandboxEnvelope(SANDBOX_TO_HOST_CHANNEL, message) });
		for (const listener of listeners) listener({ data: message });
		expect(root.children).toHaveLength(0);

		for (const listener of listeners)
			listener({ data: sandboxEnvelope(SANDBOX_TO_GUEST_CHANNEL, message) });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(root.querySelector('p')!.textContent).toBe('hi');
		expect(posted).toEqual([
			sandboxEnvelope(SANDBOX_TO_HOST_CHANNEL, {
				type: 'render.done',
				blockId: 'b1',
				runId: 'r1',
				height: 0,
			}),
		]);
		root.remove();
	});
});

describe('the markdown step', () => {
	const links = {
		vaultLink: (linkpath: string, embed: boolean) => {
			const anchor = document.createElement('a');
			anchor.setAttribute('data-vault', linkpath);
			if (embed) anchor.setAttribute('data-embed', '');
			return anchor;
		},
		urlLink: (url: string) => {
			const anchor = document.createElement('a');
			anchor.setAttribute('data-url', url);
			return anchor;
		},
	};

	function render(markdown: string): HTMLElement {
		const container = document.createElement('div');
		renderMarkdown(container, markdown, links);
		return container;
	}

	it('builds blocks, tight lists, tables, and code without HTML', () => {
		const container = render(
			[
				'# Title',
				'',
				'- one',
				'- *two*',
				'',
				'| L | R |',
				'| :- | -: |',
				'| a | b |',
				'',
				'```js',
				'<b>x</b>',
				'```',
			].join('\n')
		);
		expect(container.querySelector('h1')!.textContent).toBe('Title');
		expect(container.querySelector('ul > li')!.innerHTML).toBe('one');
		expect(container.querySelector('li em')!.textContent).toBe('two');
		expect(container.querySelectorAll('td')[1].style.textAlign).toBe('right');
		expect(container.querySelector('pre > code')!.textContent).toBe('<b>x</b>\n');
		expect(container.querySelector('b')).toBeNull();
	});

	it('turns wiki links, embeds, relative links, and URLs into link targets, and drops other schemes', () => {
		const container = render(
			'[[Note#Part|Shown]] ![[img.png]] [[a*b*c]] [rel](Folder/My%20Note.md) https://example.com [js](javascript:alert(1)) [mail](mailto:x@y.z)'
		);
		const anchors = Array.from(container.querySelectorAll('a'), (anchor) => ({
			text: anchor.textContent,
			vault: anchor.getAttribute('data-vault'),
			url: anchor.getAttribute('data-url'),
			embed: anchor.hasAttribute('data-embed'),
		}));
		expect(anchors).toEqual([
			{ text: 'Shown', vault: 'Note#Part', url: null, embed: false },
			{ text: 'img.png', vault: 'img.png', url: null, embed: true },
			{ text: 'a*b*c', vault: 'a*b*c', url: null, embed: false },
			{ text: 'rel', vault: 'Folder/My Note.md', url: null, embed: false },
			{ text: 'https://example.com', vault: null, url: 'https://example.com', embed: false },
		]);
		expect(container.textContent).toContain('[js](javascript:alert(1))');
		expect(container.textContent).toContain('mail');
	});

	it('loads only data: images and links any other image', () => {
		const container = render('![dot](data:image/png;base64,iVBORw0KGgo=) ![photo](pics/photo.png)');
		expect(container.querySelector('img')!.getAttribute('src')).toBe(
			'data:image/png;base64,iVBORw0KGgo='
		);
		expect(container.querySelectorAll('img')).toHaveLength(1);
		expect(container.querySelector('a')!.getAttribute('data-vault')).toBe('pics/photo.png');
		expect(container.querySelector('a')!.textContent).toBe('photo');
	});
});

describe('inline $= expressions (eval)', () => {
	it("builds upstream's inline body: return the expression, or an async body with await", () => {
		expect(inlineScriptBody('dv.current()')).toBe('return dv.current()');
		expect(inlineScriptBody('return await dv.query("LIST")')).toBe(
			'return (async () => { return await dv.query("LIST")\n})();'
		);
	});

	it('answers each expression in order, with dv in scope and this bound to the note', async () => {
		const results = await harness.evaluate([
			'1 + 2',
			'dv.current().file.name',
			'dataview.current().file.name',
		]);
		expect(results.map((result) => result.id)).toEqual(['expr-1', 'expr-2', 'expr-3']);
		expect(results.map((result) => result.outcome)).toEqual([
			{ kind: 'value', value: 3 },
			{ kind: 'value', value: 'JS Demo' },
			{ kind: 'value', value: 'JS Demo' },
		]);
	});

	it('sends data arrays as plain lists and Dataview values in the wire form', async () => {
		const [names, date, link] = await harness.evaluate([
			"dv.pages('#meeting').file.name",
			"dv.date('2026-10-01')",
			'dv.current().file.link',
		]);
		expect(names.outcome.kind).toBe('value');
		const list = (names.outcome as { value: unknown }).value;
		expect(Array.isArray(list) && list.length > 0 && list.every((n) => typeof n === 'string')).toBe(
			true
		);
		expect((date.outcome as { value: Record<string, unknown> }).value).toMatchObject({
			'___transfer-type': 'date',
		});
		expect((link.outcome as { value: Record<string, unknown> }).value).toMatchObject({
			'___transfer-type': 'link',
		});
	});

	it('answers undefined with nothing, and awaits an async body', async () => {
		const [nothing, awaited] = await harness.evaluate([
			'undefined',
			'return (await dv.query("LIST FROM #meeting")).successful',
		]);
		expect(nothing.outcome).toEqual({ kind: 'empty' });
		expect(awaited.outcome).toEqual({ kind: 'value', value: true });
	});

	it("answers errors with upstream's text, and keeps going", async () => {
		const results = await harness.evaluate([
			'app.vault',
			"dv.el('b', 'bold')",
			'(() => { const a = {}; a.self = a; return a; })()',
			'nope(',
			'2 * 21',
		]);
		const outcomes = results.map((result) => result.outcome);
		expect(outcomes[0]).toEqual({
			kind: 'error',
			message: `Error: ${OBSIDIAN_API_UNAVAILABLE}`,
		});
		expect(outcomes[1]).toEqual({ kind: 'error', message: `Error: ${INLINE_ELEMENT_MESSAGE}` });
		expect(outcomes[2]).toEqual({
			kind: 'error',
			message: 'Error: The value nests too deeply to show.',
		});
		expect(outcomes[3]).toMatchObject({ kind: 'error' });
		expect((outcomes[3] as { message: string }).message).toMatch(/^SyntaxError/);
		expect(outcomes[4]).toEqual({ kind: 'value', value: 42 });
	});

	it('draws nothing into the guest page', async () => {
		await harness.evaluate(["dv.paragraph('hidden'); 1"]);
		expect(harness.root.textContent).toBe('');
	});
});

describe('compileInlineScript', () => {
	it('throws the SyntaxError of code that does not compile, and refuses parameter names that are not identifiers', () => {
		// The error comes from the realm the script ran in, so check its name rather than `instanceof`.
		let thrown: unknown;
		try {
			compileInlineScript(document, { params: [], body: 'return (', strict: true });
		} catch (error) {
			thrown = error;
		}
		expect((thrown as Error).name).toBe('SyntaxError');
		expect(() =>
			compileInlineScript(document, { params: ['a){alert(1)}//'], body: '', strict: false })
		).toThrow('Not a parameter name');
	});

	it('keeps a sourceURL to one line', () => {
		const run = compileInlineScript(document, {
			params: [],
			body: 'return 1;',
			strict: true,
			sourceUrl: 'views/evil\nglobalThis.__pwned = 1;//',
		});
		expect(run()).toBe(1);
		expect(dataviewGuestRealm().__pwned).toBeUndefined();
	});
});

describe('guest sources', () => {
	it('never parse HTML strings or compile code outside inlineScript.ts', () => {
		const folder = path.resolve(__dirname, '../../../renderer/dataview-sandbox');
		for (const file of fs.readdirSync(folder).filter((name) => name.endsWith('.ts'))) {
			const source = fs.readFileSync(path.join(folder, file), 'utf8');
			expect(source, file).not.toMatch(
				/\.innerHTML\s*=|outerHTML\s*=|insertAdjacentHTML|document\.write|DOMParser|createContextualFragment|\beval\(|new Function\(/
			);
		}
	});
});
