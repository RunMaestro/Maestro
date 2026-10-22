import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { DateTime } from 'luxon';
import { DataviewBlock } from '../../../../renderer/components/Markdown/components/DataviewBlock';
import {
	DataviewDocumentContext,
	type DataviewDocumentScope,
} from '../../../../renderer/components/Markdown/components/DataviewDocumentContext';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import {
	Link,
	toWireValue,
	type DataviewChangeEvent,
	type DataviewResult,
	type Literal,
} from '../../../../shared/dataview';
import { DATAVIEW_REFRESH_DEBOUNCE_MS } from '../../../../renderer/hooks/file/useLiveDataviewResult';
import { clearCachedResources } from '../../../../renderer/hooks/utils/useCachedResource';
import { mockTheme } from '../../../helpers/mockTheme';

const ROOT = '/vault';
const NOTE = '/vault/People/Ada.md';

function scope(overrides: Partial<DataviewDocumentScope> = {}): DataviewDocumentScope {
	return { filePath: NOTE, agentId: 'agent-1', openLink: vi.fn(), ...overrides };
}

function respond(result: DataviewResult, path = 'People/Ada.md', revision = 1) {
	vi.mocked(window.maestro.dataview.query).mockResolvedValue({
		root: ROOT,
		sshRemoteId: null,
		revision,
		path,
		result,
	});
}

/** Capture the window's `dataview:changed` listener so a test can emit events. */
function captureChanges(): (event: DataviewChangeEvent) => void {
	let emit: (event: DataviewChangeEvent) => void = () => {};
	vi.mocked(window.maestro.dataview.onChanged).mockImplementation((handler) => {
		emit = handler;
		return () => {};
	});
	return (event) => emit(event);
}

function listOf(names: string[]): DataviewResult {
	return {
		kind: 'list',
		items: wire(names),
		idMeaning: { type: 'path' },
		warnings: [],
	};
}

function wire(values: Literal[]) {
	return values.map((value) => toWireValue(value));
}

function renderBlock(code: string, doc: DataviewDocumentScope | null = scope()) {
	const block = <DataviewBlock code={code} theme={mockTheme} />;
	return render(
		doc ? (
			<DataviewDocumentContext.Provider value={doc}>{block}</DataviewDocumentContext.Provider>
		) : (
			block
		)
	);
}

function setDataviewEnabled(enabled: boolean) {
	useSettingsStore.setState((state) => ({
		encoreFeatures: { ...state.encoreFeatures, dataview: enabled },
	}));
}

describe('DataviewBlock', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// Results live in a module-level cache; a test must not see another's answer.
		clearCachedResources();
		setDataviewEnabled(true);
	});

	afterEach(() => {
		setDataviewEnabled(false);
	});

	it('renders the fence as ordinary code outside a Dataview surface', () => {
		const { container } = renderBlock('LIST FROM "People"', null);
		expect(container.textContent).toContain('LIST FROM "People"');
		expect(container.querySelector('[data-dataview-block]')).toBeNull();
		expect(window.maestro.dataview.query).not.toHaveBeenCalled();
	});

	it('renders the fence as ordinary code while the Encore Feature is off', () => {
		setDataviewEnabled(false);
		const { container } = renderBlock('LIST FROM "People"');
		expect(container.textContent).toContain('LIST FROM "People"');
		expect(container.querySelector('[data-dataview-block]')).toBeNull();
		expect(window.maestro.dataview.query).not.toHaveBeenCalled();
	});

	it('shows a stable-height placeholder while the query runs', () => {
		const { container } = renderBlock('LIST');
		const placeholder = container.querySelector('[data-dataview-placeholder]') as HTMLElement;
		expect(placeholder).not.toBeNull();
		expect(placeholder.style.height).toBe('2.5em');
		expect(window.maestro.dataview.query).toHaveBeenCalledWith({
			filePath: NOTE,
			source: 'LIST',
			agentId: 'agent-1',
		});
	});

	it('renders a table with links, dates, nulls, lists, and a result count', async () => {
		respond({
			kind: 'table',
			headers: ['File', 'Created', 'Summary', 'Tags'],
			rows: [
				wire([
					Link.file('meetings/Kickoff.md'),
					DateTime.fromObject({ year: 2026, month: 1, day: 5 }),
					null,
					['#a', '#b'],
				]),
				wire([Link.file('meetings/Retro.md', false, 'The Retro'), null, 'plain text', []]),
			],
			idMeaning: { type: 'path' },
			warnings: [],
		});
		const { container } = renderBlock('TABLE file.cday as Created, Summary');

		await screen.findByText('Kickoff');
		expect(container.querySelectorAll('th')).toHaveLength(4);
		expect(screen.getByText('The Retro')).toBeTruthy();
		expect(screen.getByText('January 05, 2026')).toBeTruthy();
		expect(screen.getByText('plain text')).toBeTruthy();
		// renderNullAs is "\-", markdown for a dash.
		expect(container.querySelectorAll('tbody tr')[0].children[2].textContent).toBe('-');
		expect(container.querySelectorAll('tbody tr')[0].querySelectorAll('li')).toHaveLength(2);
		expect(container.querySelector('[data-dataview-count]')?.textContent).toBe('2 results');
	});

	it('opens a link through the surface with its absolute path', async () => {
		const openLink = vi.fn();
		respond({
			kind: 'list',
			items: wire([Link.file('meetings/Kickoff.md')]),
			idMeaning: { type: 'path' },
			warnings: [],
		});
		renderBlock('LIST', scope({ openLink }));

		fireEvent.click(await screen.findByText('Kickoff'));
		expect(openLink).toHaveBeenCalledWith('/vault/meetings/Kickoff.md', { openInNewTab: false });

		fireEvent.click(screen.getByText('Kickoff'), { metaKey: true });
		expect(openLink).toHaveBeenLastCalledWith('/vault/meetings/Kickoff.md', {
			openInNewTab: true,
		});
	});

	it('resolves a wiki link inside a markdown string through Dataview before opening it', async () => {
		const openLink = vi.fn();
		respond({
			kind: 'list',
			items: wire(['Met with [[Grace|Grace H]] today']),
			idMeaning: { type: 'path' },
			warnings: [],
		});
		vi.mocked(window.maestro.dataview.queryInline).mockResolvedValue({
			root: ROOT,
			sshRemoteId: null,
			revision: 1,
			path: 'People/Ada.md',
			result: { kind: 'value', value: toWireValue(Link.file('People/Grace.md')) },
		});
		renderBlock('LIST', scope({ openLink }));

		fireEvent.click(await screen.findByText('Grace H'));
		expect(window.maestro.dataview.queryInline).toHaveBeenCalledWith({
			filePath: NOTE,
			agentId: 'agent-1',
			expression: 'link("Grace")',
		});
		await waitFor(() =>
			expect(openLink).toHaveBeenCalledWith('/vault/People/Grace.md', { openInNewTab: false })
		);
	});

	it('renders tasks with checkboxes, nests children, and toggles a task of the note on screen', async () => {
		const toggleOwnTask = vi.fn().mockResolvedValue(true);
		const child = {
			text: 'sub step',
			line: 4,
			path: 'People/Ada.md',
			task: true,
			checked: true,
			parent: 3,
		};
		respond({
			kind: 'task',
			groups: [
				{
					text: 'write the plan',
					line: 3,
					path: 'People/Ada.md',
					task: true,
					checked: false,
					children: [child],
				},
				child,
			],
			idMeaning: { type: 'path' },
			warnings: [],
		});
		renderBlock('TASK', scope({ toggleOwnTask }));

		await screen.findByText('write the plan');
		const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
		// The child renders once, under its parent.
		expect(boxes).toHaveLength(2);
		expect(boxes[0].checked).toBe(false);
		expect(boxes[1].checked).toBe(true);
		expect(screen.getByText('2 results')).toBeTruthy();

		fireEvent.click(boxes[0]);
		expect(toggleOwnTask).toHaveBeenCalledWith(4);
	});

	it('toggles a task of another file in that file, after checking the line still holds it', async () => {
		vi.mocked(window.maestro.fs.readFile).mockResolvedValue('# Alpha\n- [ ] ship it\n');
		vi.mocked(window.maestro.fs.writeFile).mockResolvedValue({ success: true });
		const toggleOwnTask = vi.fn().mockResolvedValue(true);
		respond({
			kind: 'task',
			groups: [{ text: 'ship it', line: 1, path: 'Projects/Alpha.md', task: true, checked: false }],
			idMeaning: { type: 'path' },
			warnings: [],
		});
		renderBlock('TASK', scope({ toggleOwnTask }));

		await screen.findByText('ship it');
		fireEvent.click(screen.getByRole('checkbox'));

		await waitFor(() =>
			expect(window.maestro.fs.writeFile).toHaveBeenCalledWith(
				'/vault/Projects/Alpha.md',
				'# Alpha\n- [x] ship it\n',
				undefined
			)
		);
		expect(toggleOwnTask).not.toHaveBeenCalled();
	});

	it('leaves the file alone when the task line no longer holds the task', async () => {
		vi.mocked(window.maestro.fs.readFile).mockResolvedValue('# Alpha\n- [ ] something else\n');
		respond({
			kind: 'task',
			groups: [{ text: 'ship it', line: 1, path: 'Projects/Alpha.md', task: true, checked: false }],
			idMeaning: { type: 'path' },
			warnings: [],
		});
		renderBlock('TASK FROM "Projects"');

		await screen.findByText('ship it');
		fireEvent.click(screen.getByRole('checkbox'));

		await waitFor(() =>
			expect(window.maestro.fs.readFile).toHaveBeenCalledWith('/vault/Projects/Alpha.md', undefined)
		);
		expect(window.maestro.fs.writeFile).not.toHaveBeenCalled();
	});

	it('re-runs on a change to its root and keeps the old result on screen until the new one arrives', async () => {
		const emit = captureChanges();
		respond(listOf(['first']));
		renderBlock('LIST');
		await screen.findByText('first');

		let answer: (value: unknown) => void = () => {};
		vi.mocked(window.maestro.dataview.query).mockImplementation(
			() => new Promise((resolve) => (answer = resolve as (value: unknown) => void))
		);
		emit({ root: ROOT, sshRemoteId: null, revision: 2, changedPaths: ['People/Ada.md'] });
		emit({ root: ROOT, sshRemoteId: null, revision: 3, changedPaths: ['People/Ada.md'] });

		await waitFor(() => expect(window.maestro.dataview.query).toHaveBeenCalledTimes(2), {
			timeout: DATAVIEW_REFRESH_DEBOUNCE_MS * 4,
		});
		// The burst cost one query, and the previous answer is still shown.
		expect(screen.getByText('first')).toBeTruthy();

		answer({
			root: ROOT,
			sshRemoteId: null,
			revision: 3,
			path: 'People/Ada.md',
			result: listOf(['second']),
		});
		await screen.findByText('second');
		expect(screen.queryByText('first')).toBeNull();
	});

	it('ignores a change to another root or one it has already read', async () => {
		const emit = captureChanges();
		respond(listOf(['first']), 'People/Ada.md', 5);
		renderBlock('LIST');
		await screen.findByText('first');

		emit({ root: '/other-vault', sshRemoteId: null, revision: 9, changedPaths: [] });
		emit({ root: ROOT, sshRemoteId: 'remote-1', revision: 9, changedPaths: [] });
		emit({ root: ROOT, sshRemoteId: null, revision: 5, changedPaths: [] });
		await new Promise((resolve) => setTimeout(resolve, DATAVIEW_REFRESH_DEBOUNCE_MS * 2));

		expect(window.maestro.dataview.query).toHaveBeenCalledTimes(1);
	});

	it('renders GROUP BY task groups under their keys', async () => {
		respond({
			kind: 'task',
			groups: [
				{
					key: toWireValue(Link.file('Projects/Alpha.md')),
					rows: [
						{ text: 'ship it', line: 0, path: 'Projects/Alpha.md', task: true, checked: false },
					],
				},
			],
			idMeaning: { type: 'group', name: 'file.link', on: { type: 'path' } },
			warnings: [],
		});
		const { container } = renderBlock('TASK GROUP BY file.link');

		await screen.findByText('ship it');
		expect(container.querySelector('[data-dataview-group]')?.textContent).toContain('Alpha');
	});

	it('shows a query error inline with the Dataview text', async () => {
		respond({ kind: 'error', message: 'Dataview: Error parsing query', line: 2 });
		const { container } = renderBlock('TABLE WHERE');

		await waitFor(() =>
			expect(container.querySelector('[data-dataview-error]')?.textContent).toBe(
				'Dataview: Error parsing query'
			)
		);
		expect(container.querySelector('[data-alert-type="caution"]')).not.toBeNull();
	});

	it('shows a failed request inline without the IPC wrapper', async () => {
		vi.mocked(window.maestro.dataview.query).mockRejectedValue(
			new Error("Error invoking remote method 'dataview:query': Error: Dataview is turned off")
		);
		const { container } = renderBlock('LIST');

		await waitFor(() =>
			expect(container.querySelector('[data-dataview-error]')?.textContent).toBe(
				'Dataview is turned off'
			)
		);
	});

	it('marks CALENDAR as not supported', async () => {
		respond({ kind: 'unsupported', feature: 'CALENDAR' });
		const { container } = renderBlock('CALENDAR file.cday');

		await screen.findByText(/CALENDAR queries are not supported/);
		expect(container.querySelector('[data-alert-type="warning"]')).not.toBeNull();
	});

	it('counts a single result in the singular and lists skipped-row warnings', async () => {
		respond({
			kind: 'list',
			items: wire(['only one']),
			idMeaning: { type: 'path' },
			warnings: ['Skipped 1 row: field "x" is not a number'],
		});
		const { container } = renderBlock('LIST x');

		await screen.findByText('only one');
		expect(container.querySelector('[data-dataview-count]')?.textContent).toBe('1 result');
		const warning = container.querySelector('[data-alert-type="warning"]');
		expect(warning?.textContent).toContain('Skipped 1 row: field "x" is not a number');
	});

	it("shows Dataview's empty-result notice instead of an empty table", async () => {
		respond({
			kind: 'table',
			headers: ['File'],
			rows: [],
			idMeaning: { type: 'path' },
			warnings: [],
		});
		const { container } = renderBlock('TABLE');

		await screen.findByText('Dataview: No results to show for table query.');
		expect(container.querySelector('table')).toBeNull();
		expect(container.querySelector('[data-dataview-count]')).toBeNull();
	});
});
