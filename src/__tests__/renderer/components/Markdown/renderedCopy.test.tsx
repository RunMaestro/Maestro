// Source: src/__tests__/renderer/components/Markdown/TaskCheckbox.test.tsx
// Source: src/__tests__/renderer/components/Markdown/renderedCopy.test.ts
// Source: src/__tests__/renderer/components/Markdown/DataviewBlock.test.tsx
// Source: src/__tests__/renderer/components/Markdown/DataviewInlineQuery.test.tsx
// Source: src/__tests__/renderer/components/Markdown/FollowupChip.test.tsx
// Source: src/__tests__/renderer/components/Markdown/LocalImage.test.tsx
// Source: src/__tests__/renderer/components/Markdown/plugins.test.ts
// Source: src/__tests__/renderer/components/Markdown/rehypeSourceLine.test.tsx
import { describe as describeSourceSuite } from 'vitest';
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { vi } from 'vitest';
import { render } from '@testing-library/react';
import { screen } from '@testing-library/react';
import { waitFor } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';
import { TaskCheckbox } from '../../../../renderer/components/Markdown/components/TaskCheckbox';
import { mockTheme } from '../../../helpers/mockTheme';
import { normalizeRenderedChatCopy } from '../../../../renderer/components/Markdown/renderedCopy';
import { serializeRenderedChatFragment } from '../../../../renderer/components/Markdown/renderedCopy';
import { beforeEach } from 'vitest';
import { afterEach } from 'vitest';
import { DateTime } from 'luxon';
import { DataviewBlock } from '../../../../renderer/components/Markdown/components/DataviewBlock';
import { DataviewDocumentContext } from '../../../../renderer/components/Markdown/components/DataviewDocumentContext';
import type { DataviewDocumentScope } from '../../../../renderer/components/Markdown/components/DataviewDocumentContext';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import { Link } from '../../../../shared/dataview';
import { dataviewTruncationNote } from '../../../../shared/dataview';
import { toWireValue } from '../../../../shared/dataview';
import type { DataviewChangeEvent } from '../../../../shared/dataview';
import type { DataviewResult } from '../../../../shared/dataview';
import type { Literal } from '../../../../shared/dataview';
import { DATAVIEW_REFRESH_DEBOUNCE_MS } from '../../../../renderer/hooks/file/useLiveDataviewResult';
import { clearCachedResources } from '../../../../renderer/hooks/utils/useCachedResource';
import ReactMarkdown from 'react-markdown';
import { createDataviewInlineCodeRenderer } from '../../../../renderer/components/Markdown/components/DataviewInlineQuery';
import { parseDataviewInlineQuery } from '../../../../renderer/components/Markdown/components/DataviewInlineQuery';
import { createMarkdownComponents } from '../../../../renderer/utils/markdownConfig';
import { REMARK_GFM_PLUGINS } from '../../../../renderer/utils/markdownConfig';
import { DATAVIEW_REFRESH_DIM_OPACITY } from '../../../../renderer/components/Markdown/components/DataviewLoading';
import type { DataviewInlineResult } from '../../../../shared/dataview';
import type { ComponentProps } from 'react';
import { FollowupChip } from '../../../../renderer/components/Markdown/components/FollowupChip';
import { act } from '@testing-library/react';
import { LocalImage } from '../../../../renderer/components/Markdown/components/LocalImage';
import { resolveLocalImagePath } from '../../../../renderer/components/Markdown/components/LocalImage';
import { useZoomViewerStore } from '../../../../renderer/components/ZoomViewer/zoomViewerStore';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import remarkMath from 'remark-math';
import remarkFrontmatter from 'remark-frontmatter';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import rehypeKatex from 'rehype-katex';
import { remarkFrontmatterTable } from '../../../../renderer/utils/remarkFrontmatterTable';
import { remarkFileLinks } from '../../../../renderer/utils/remarkFileLinks';
import { remarkMentionChips } from '../../../../renderer/utils/remarkMentionChips';
import { remarkPromoteDisplayMath } from '../../../../shared/remarkPromoteDisplayMath';
import { remarkMaestroMarkers } from '../../../../renderer/components/Markdown/remarkMaestroMarkers';
import { remarkStripHtmlComments } from '../../../../shared/remarkStripHtmlComments';
import { buildMarkdownPlugins } from '../../../../renderer/components/Markdown/plugins';
import { rehypeSourceLine } from '../../../../renderer/components/Markdown/rehypeSourceLine';
describeSourceSuite('TaskCheckbox', () => {
	describe('TaskCheckbox', () => {
		it('renders the state parsed from the document', () => {
			const { rerender } = render(
				<TaskCheckbox line={3} checked={false} theme={mockTheme} onToggle={vi.fn()} />
			);
			const box = screen.getByRole('checkbox') as HTMLInputElement;
			expect(box.checked).toBe(false);

			rerender(<TaskCheckbox line={3} checked={true} theme={mockTheme} onToggle={vi.fn()} />);
			expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true);
		});

		it('reports the clicked line to the toggle handler', async () => {
			const onToggle = vi.fn().mockResolvedValue(true);
			render(<TaskCheckbox line={42} checked={false} theme={mockTheme} onToggle={onToggle} />);

			fireEvent.click(screen.getByRole('checkbox'));

			expect(onToggle).toHaveBeenCalledWith(42);
		});

		it('flips immediately instead of waiting for the write to land', async () => {
			// A never-resolving write stands in for a slow disk / SSH round trip.
			const onToggle = vi.fn().mockReturnValue(new Promise<boolean>(() => {}));
			render(<TaskCheckbox line={1} checked={false} theme={mockTheme} onToggle={onToggle} />);

			fireEvent.click(screen.getByRole('checkbox'));

			expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true);
		});

		it('reverts when the write does not happen', async () => {
			const onToggle = vi.fn().mockResolvedValue(false);
			render(<TaskCheckbox line={1} checked={false} theme={mockTheme} onToggle={onToggle} />);

			fireEvent.click(screen.getByRole('checkbox'));

			await waitFor(() =>
				expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false)
			);
		});

		it('hands control back to the document once the saved content arrives', async () => {
			const onToggle = vi.fn().mockResolvedValue(true);
			const { rerender } = render(
				<TaskCheckbox line={1} checked={false} theme={mockTheme} onToggle={onToggle} />
			);

			fireEvent.click(screen.getByRole('checkbox'));
			rerender(<TaskCheckbox line={1} checked={true} theme={mockTheme} onToggle={onToggle} />);
			expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true);

			// An external edit unchecks it again; the stale optimistic flip must not win.
			rerender(<TaskCheckbox line={1} checked={false} theme={mockTheme} onToggle={onToggle} />);
			expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
		});
	});
});
describeSourceSuite('renderedCopy', () => {
	function fragmentFromHtml(html: string): DocumentFragment {
		const template = document.createElement('template');
		template.innerHTML = html;
		return template.content;
	}

	function copyText(html: string): string {
		return normalizeRenderedChatCopy(serializeRenderedChatFragment(fragmentFromHtml(html)));
	}

	describe('serializeRenderedChatFragment list markers', () => {
		it('preserves bullet markers for unordered lists', () => {
			expect(copyText('<ul><li>first</li><li>second</li></ul>')).toBe('- first\n- second');
		});

		it('preserves sequential numbers for ordered lists', () => {
			expect(copyText('<ol><li>first</li><li>second</li><li>third</li></ol>')).toBe(
				'1. first\n2. second\n3. third'
			);
		});

		it('honors the ordered list start attribute', () => {
			expect(copyText('<ol start="3"><li>third</li><li>fourth</li></ol>')).toBe(
				'3. third\n4. fourth'
			);
		});

		it('preserves task-list checkbox markers', () => {
			const html =
				'<ul>' +
				'<li class="task-list-item"><input type="checkbox" disabled> open task</li>' +
				'<li class="task-list-item"><input type="checkbox" checked disabled> done task</li>' +
				'</ul>';
			expect(copyText(html)).toBe('- [ ] open task\n- [x] done task');
		});

		it('leaves non-list prose unchanged', () => {
			expect(copyText('<p>hello world</p>')).toBe('hello world');
		});
	});
});
describeSourceSuite('DataviewBlock', () => {
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

		it('shows ghost rows, then a Calculating pill, while the first run is out', async () => {
			vi.mocked(window.maestro.dataview.query).mockReturnValueOnce(new Promise(() => {}));
			const { container } = renderBlock('LIST');
			const placeholder = container.querySelector('[data-dataview-placeholder]') as HTMLElement;
			expect(placeholder).not.toBeNull();
			expect(placeholder.getAttribute('aria-label')).toBe('Running Dataview query');
			expect(placeholder.querySelectorAll('[data-testid="skeleton-box"]').length).toBeGreaterThan(
				0
			);
			// A fast answer never flashes the pill.
			expect(container.querySelector('[data-dataview-pill]')).toBeNull();
			await waitFor(() =>
				expect(container.querySelector('[data-dataview-pill]')?.textContent).toBe('Calculating')
			);
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

		it('says a result was cut at the row cap in place of the result count', async () => {
			respond({ ...listOf(['People/A.md', 'People/B.md']), total: 4321 } as DataviewResult);
			const { container } = renderBlock('LIST FROM "People"');

			await waitFor(() =>
				expect(container.querySelector('[data-dataview-truncated]')).not.toBeNull()
			);
			expect(container.querySelector('[data-dataview-truncated]')?.textContent).toBe(
				dataviewTruncationNote({ total: 4321 }, 2)
			);
			expect(container.querySelector('[data-dataview-count]')).toBeNull();
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
				groups: [
					{ text: 'ship it', line: 1, path: 'Projects/Alpha.md', task: true, checked: false },
				],
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
				groups: [
					{ text: 'ship it', line: 1, path: 'Projects/Alpha.md', task: true, checked: false },
				],
				idMeaning: { type: 'path' },
				warnings: [],
			});
			renderBlock('TASK FROM "Projects"');

			await screen.findByText('ship it');
			fireEvent.click(screen.getByRole('checkbox'));

			await waitFor(() =>
				expect(window.maestro.fs.readFile).toHaveBeenCalledWith(
					'/vault/Projects/Alpha.md',
					undefined
				)
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
			// The burst cost one query, and the previous answer is still shown, dimmed under a Recalculating pill.
			expect(screen.getByText('first')).toBeTruthy();
			const refreshing = await waitFor(() => {
				const element = document.querySelector('[data-dataview-refreshing]');
				expect(element).not.toBeNull();
				return element as HTMLElement;
			});
			expect(refreshing.querySelector('[data-dataview-pill]')?.textContent).toBe('Recalculating');

			answer({
				root: ROOT,
				sshRemoteId: null,
				revision: 3,
				path: 'People/Ada.md',
				result: listOf(['second']),
			});
			await screen.findByText('second');
			expect(screen.queryByText('first')).toBeNull();
			expect(document.querySelector('[data-dataview-refreshing]')).toBeNull();
			expect(document.querySelector('[data-dataview-pill]')).toBeNull();
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
});
describeSourceSuite('DataviewInlineQuery', () => {
	const NOTE = '/vault/People/Ada.md';

	function scope(overrides: Partial<DataviewDocumentScope> = {}): DataviewDocumentScope {
		return { filePath: NOTE, agentId: 'agent-1', openLink: vi.fn(), ...overrides };
	}

	function respond(result: DataviewInlineResult, revision = 1) {
		vi.mocked(window.maestro.dataview.queryInline).mockResolvedValue({
			root: '/vault',
			sshRemoteId: null,
			revision,
			path: 'People/Ada.md',
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

	function renderNote(markdown: string, doc: DataviewDocumentScope | null = scope()) {
		const note = (
			<ReactMarkdown
				remarkPlugins={REMARK_GFM_PLUGINS}
				components={createMarkdownComponents({
					theme: mockTheme,
					renderInlineCode: createDataviewInlineCodeRenderer(mockTheme),
				})}
			>
				{markdown}
			</ReactMarkdown>
		);
		return render(
			doc ? (
				<DataviewDocumentContext.Provider value={doc}>{note}</DataviewDocumentContext.Provider>
			) : (
				note
			)
		);
	}

	function setDataviewEnabled(enabled: boolean) {
		useSettingsStore.setState((state) => ({
			encoreFeatures: { ...state.encoreFeatures, dataview: enabled },
		}));
	}

	describe('parseDataviewInlineQuery', () => {
		it('takes the expression after the = prefix', () => {
			expect(parseDataviewInlineQuery('= this.file.name')).toBe('this.file.name');
			expect(parseDataviewInlineQuery('=date(today)')).toBe('date(today)');
		});

		it('leaves other spans alone', () => {
			expect(parseDataviewInlineQuery('this.file.name')).toBeNull();
			expect(parseDataviewInlineQuery('$= dv.current()')).toBeNull();
			expect(parseDataviewInlineQuery('=  ')).toBeNull();
		});
	});

	describe('DataviewInlineQuery', () => {
		beforeEach(() => {
			vi.clearAllMocks();
			// Values live in a module-level cache; a test must not see another's answer.
			clearCachedResources();
			setDataviewEnabled(true);
		});

		afterEach(() => {
			setDataviewEnabled(false);
		});

		it('renders the value of an inline query in place of the code span', async () => {
			respond({ kind: 'value', value: toWireValue('Ada Lovelace') });
			const { container } = renderNote('Name: `= this.file.name` and `plain`.');

			await screen.findByText('Ada Lovelace');
			expect(window.maestro.dataview.queryInline).toHaveBeenCalledWith({
				filePath: NOTE,
				expression: 'this.file.name',
				agentId: 'agent-1',
			});
			expect(container.querySelector('[data-dataview-inline]')?.textContent).toBe('Ada Lovelace');
			expect(container.querySelector('code')?.textContent).toBe('plain');
		});

		it('shows the source dimmed while the value is on its way', () => {
			const { container } = renderNote('`= this.file.name`');

			const placeholder = container.querySelector('[data-dataview-inline-placeholder]');
			expect(placeholder?.textContent).toBe('= this.file.name');
		});

		it('renders a link value that opens through the surface', async () => {
			const openLink = vi.fn();
			respond({ kind: 'value', value: toWireValue(Link.file('People/Grace.md')) });
			renderNote('`= this.Connection`', scope({ openLink }));

			(await screen.findByText('Grace')).click();
			expect(openLink).toHaveBeenCalledWith('/vault/People/Grace.md', { openInNewTab: false });
		});

		it('shows an evaluation error inline with the Dataview text', async () => {
			respond({ kind: 'error', message: 'No implementation found for "nope"' });
			const { container } = renderNote('`= nope()`');

			await waitFor(() =>
				expect(container.querySelector('[data-dataview-inline-error]')?.textContent).toBe(
					`Dataview (for inline query 'nope()'): No implementation found for "nope"`
				)
			);
		});

		it('re-evaluates on a change to its root and ignores other roots', async () => {
			const emit = captureChanges();
			respond({ kind: 'value', value: toWireValue('before') });
			renderNote('`= this.status`');
			await screen.findByText('before');

			emit({ root: '/other-vault', sshRemoteId: null, revision: 2, changedPaths: [] });
			await new Promise((resolve) => setTimeout(resolve, DATAVIEW_REFRESH_DEBOUNCE_MS * 2));
			expect(window.maestro.dataview.queryInline).toHaveBeenCalledTimes(1);

			respond({ kind: 'value', value: toWireValue('after') }, 2);
			emit({ root: '/vault', sshRemoteId: null, revision: 2, changedPaths: ['People/Ada.md'] });
			await screen.findByText('after', undefined, { timeout: DATAVIEW_REFRESH_DEBOUNCE_MS * 4 });
			expect(window.maestro.dataview.queryInline).toHaveBeenCalledTimes(2);
		});

		it('keeps the old value in place, dimmed, while a slow refresh is out', async () => {
			const emit = captureChanges();
			respond({ kind: 'value', value: toWireValue('before') });
			const { container } = renderNote('`= this.status`');
			await screen.findByText('before');
			expect(container.querySelector('[data-dataview-refreshing]')).toBeNull();

			let answer: (value: unknown) => void = () => {};
			vi.mocked(window.maestro.dataview.queryInline).mockImplementation(
				() => new Promise((resolve) => (answer = resolve as (value: unknown) => void))
			);
			emit({ root: '/vault', sshRemoteId: null, revision: 2, changedPaths: ['People/Ada.md'] });
			const dimmed = await waitFor(
				() => {
					const element = container.querySelector('[data-dataview-refreshing]') as HTMLElement;
					expect(element).not.toBeNull();
					return element;
				},
				{ timeout: DATAVIEW_REFRESH_DEBOUNCE_MS * 4 }
			);
			expect(dimmed.textContent).toBe('before');
			expect(dimmed.style.opacity).toBe(String(DATAVIEW_REFRESH_DIM_OPACITY));
			// Inline values never draw the block pill over the sentence.
			expect(container.querySelector('[data-dataview-pill]')).toBeNull();

			answer({
				root: '/vault',
				sshRemoteId: null,
				revision: 2,
				path: 'People/Ada.md',
				result: { kind: 'value', value: toWireValue('after') },
			});
			await screen.findByText('after');
			expect(container.querySelector('[data-dataview-refreshing]')).toBeNull();
		});

		it('keeps the span as code outside a Dataview surface or with the Encore Feature off', () => {
			const { container, unmount } = renderNote('`= this.file.name`', null);
			expect(container.querySelector('code')?.textContent).toBe('= this.file.name');
			unmount();

			setDataviewEnabled(false);
			const second = renderNote('`= this.file.name`');
			expect(second.container.querySelector('code')?.textContent).toBe('= this.file.name');
			expect(window.maestro.dataview.queryInline).not.toHaveBeenCalled();
		});
	});
});
describeSourceSuite('FollowupChip', () => {
	const PROMPT = 'Design the canonical schema for the events table, then show me the migration.';

	function renderChip(overrides: Partial<ComponentProps<typeof FollowupChip>> = {}) {
		const onActivate = vi.fn();
		render(
			<FollowupChip
				label="Design the schema"
				prompt={PROMPT}
				sessionId="session-1"
				tabId="tab-1"
				theme={mockTheme}
				onActivate={onActivate}
				{...overrides}
			/>
		);
		return { onActivate };
	}

	describe('FollowupChip', () => {
		it('renders the agent-authored label', () => {
			renderChip();
			expect(screen.getByTestId('codex-followup-chip')).toHaveTextContent('Design the schema');
		});

		it('sends on a plain click', () => {
			const { onActivate } = renderChip();

			fireEvent.click(screen.getByTestId('codex-followup-chip'));

			expect(onActivate).toHaveBeenCalledTimes(1);
			expect(onActivate).toHaveBeenCalledWith('send');
		});

		it('prefills on an Alt-click, so an agent-authored prompt can be edited first', () => {
			const { onActivate } = renderChip();

			fireEvent.click(screen.getByTestId('codex-followup-chip'), { altKey: true });

			expect(onActivate).toHaveBeenCalledWith('prefill');
		});

		it('sends on Enter, because a real button is the only keyboard-reachable form', () => {
			const { onActivate } = renderChip();
			const chip = screen.getByTestId('codex-followup-chip');

			expect(chip.tagName).toBe('BUTTON');
			expect(chip).toHaveAttribute('type', 'button');

			// jsdom does not synthesize the click a browser fires for Enter on a
			// button, so the assertion that matters is that the element IS a button
			// (above) plus that its activation path sends.
			fireEvent.keyDown(chip, { key: 'Enter' });
			fireEvent.click(chip, { detail: 0 });

			expect(onActivate).toHaveBeenCalledWith('send');
		});

		it('carries the whole prompt in its accessible name', () => {
			// This is the half of the "always show the prompt" rule that survives
			// without a mouse: HoverTooltip only opens on hover, so a keyboard or
			// screen-reader user reads the prompt here or not at all.
			renderChip();

			const name = screen.getByTestId('codex-followup-chip').getAttribute('aria-label') ?? '';
			expect(name).toContain('Design the schema');
			expect(name).toContain(PROMPT);
		});

		it('shows the full prompt on hover', () => {
			renderChip();

			fireEvent.mouseEnter(screen.getByTestId('codex-followup-chip').parentElement as HTMLElement);

			expect(screen.getByRole('tooltip')).toHaveTextContent(PROMPT);
		});

		it('names the conversation it was drawn in', () => {
			renderChip();

			const chip = screen.getByTestId('codex-followup-chip');
			expect(chip).toHaveAttribute('data-session-id', 'session-1');
			expect(chip).toHaveAttribute('data-tab-id', 'tab-1');
		});

		it('renders plain text with no button when there is no prompt to send', () => {
			const { onActivate } = renderChip({ prompt: '' });

			expect(screen.queryByRole('button')).toBeNull();
			expect(screen.queryByTestId('codex-followup-chip')).toBeNull();
			expect(screen.getByTestId('codex-followup-plain')).toHaveTextContent('Design the schema');
			expect(onActivate).not.toHaveBeenCalled();
		});
	});
});
describeSourceSuite('LocalImage', () => {
	const PNG = 'data:image/png;base64,iVBORw0KGgo=';

	const readFile = vi.fn().mockResolvedValue(PNG);

	beforeEach(() => {
		readFile.mockClear();
		(globalThis as any).window.maestro = { fs: { readFile } };
	});

	describe('resolveLocalImagePath', () => {
		// mdast-util-to-hast percent-encodes every image destination, so a real path
		// with a space arrives here as `%20` and would ENOENT if read verbatim.
		it('percent-decodes a bare absolute path', () => {
			expect(resolveLocalImagePath('/Users/p/Prop%20Firm%20Model/model.png')).toBe(
				'/Users/p/Prop Firm Model/model.png'
			);
		});

		it('strips the file:// prefix and decodes', () => {
			expect(resolveLocalImagePath('file:///Users/p/My%20Notes/a.png')).toBe(
				'/Users/p/My Notes/a.png'
			);
		});

		it('leaves a malformed percent sequence alone instead of throwing', () => {
			expect(resolveLocalImagePath('/Users/p/100%/chart.png')).toBe('/Users/p/100%/chart.png');
		});

		it('is a no-op for a path with nothing to decode', () => {
			expect(resolveLocalImagePath('/Users/p/notes/a.png')).toBe('/Users/p/notes/a.png');
		});
	});

	describe('LocalImage', () => {
		it('reads the decoded path for a space-bearing bare path', async () => {
			render(
				<LocalImage src="/Users/p/Prop%20Firm%20Model/model.png" alt="model" theme={mockTheme} />
			);
			await waitFor(() => expect(readFile).toHaveBeenCalled());
			expect(readFile).toHaveBeenCalledWith('/Users/p/Prop Firm Model/model.png', undefined);
		});

		it('reads the decoded path for a file:// URL', async () => {
			render(<LocalImage src="file:///Users/p/My%20Notes/a.png" alt="a" theme={mockTheme} />);
			await waitFor(() => expect(readFile).toHaveBeenCalled());
			expect(readFile).toHaveBeenCalledWith('/Users/p/My Notes/a.png', undefined);
		});

		it('renders http(s) sources without an IPC read', () => {
			const { container } = render(
				<LocalImage src="https://example.com/a.png" alt="a" theme={mockTheme} />
			);
			expect(readFile).not.toHaveBeenCalled();
			expect(container.querySelector('img')?.getAttribute('src')).toBe('https://example.com/a.png');
		});
	});

	describe('LocalImage zoom viewer', () => {
		beforeEach(() => {
			act(() => useZoomViewerStore.getState().close());
		});

		it('opens the image in the pan/zoom viewer on click', () => {
			const { container } = render(
				<LocalImage src="https://example.com/a.png" alt="chart" theme={mockTheme} />
			);
			const img = container.querySelector('img')!;
			fireEvent.click(img);
			const request = useZoomViewerStore.getState().request;
			expect(request?.element).toBe(img);
			expect(request?.title).toBe('chart');
		});

		it('leaves a click on a linked image to the link, but the expand button still opens it', () => {
			const { container } = render(
				<a href="https://example.com">
					<LocalImage src="https://example.com/a.png" alt="chart" theme={mockTheme} />
				</a>
			);
			fireEvent.click(container.querySelector('img')!);
			expect(useZoomViewerStore.getState().request).toBeNull();

			fireEvent.click(screen.getByTestId('expand-to-viewer'));
			expect(useZoomViewerStore.getState().request?.element).toBe(container.querySelector('img'));
		});
	});
});
describeSourceSuite('plugins', () => {
	// Helper: a tuple plugin is [plugin, options]; a bare plugin is the function.
	function pluginFn(entry: unknown): unknown {
		return Array.isArray(entry) ? entry[0] : entry;
	}

	function pluginFns(list: unknown[] | undefined): unknown[] {
		return (list ?? []).map(pluginFn);
	}

	describe('buildMarkdownPlugins', () => {
		it('includes GFM + frontmatter + frontmatter-table by default', () => {
			const { remarkPlugins, rehypePlugins } = buildMarkdownPlugins();
			const fns = pluginFns(remarkPlugins as unknown[]);
			expect(fns).toContain(remarkGfm);
			expect(fns).toContain(remarkFrontmatter);
			expect(fns).toContain(remarkFrontmatterTable);
			// No optional plugins
			expect(fns).not.toContain(remarkBreaks);
			expect(fns).not.toContain(remarkMath);
			expect(fns).not.toContain(remarkFileLinks);
			// rehype empty -> undefined (react-markdown expects undefined, not [])
			expect(rehypePlugins).toBeUndefined();
		});

		it('omits frontmatter plugins when frontmatter: false', () => {
			const { remarkPlugins } = buildMarkdownPlugins({ frontmatter: false });
			const fns = pluginFns(remarkPlugins as unknown[]);
			expect(fns).toContain(remarkGfm);
			expect(fns).not.toContain(remarkFrontmatter);
			expect(fns).not.toContain(remarkFrontmatterTable);
		});

		it('adds remark-breaks only when chatLineBreaks is set', () => {
			expect(
				pluginFns(buildMarkdownPlugins({ chatLineBreaks: true }).remarkPlugins as unknown[])
			).toContain(remarkBreaks);
			expect(
				pluginFns(buildMarkdownPlugins({ chatLineBreaks: false }).remarkPlugins as unknown[])
			).not.toContain(remarkBreaks);
		});

		it('adds the Auto Run marker plugin only when autorunMarkers is set', () => {
			expect(
				pluginFns(buildMarkdownPlugins({ autorunMarkers: true }).remarkPlugins as unknown[])
			).toContain(remarkMaestroMarkers);
			// Off by default: a marker pill asserts that something is configured, so
			// it must be opted into rather than inherited by every surface.
			expect(pluginFns(buildMarkdownPlugins().remarkPlugins as unknown[])).not.toContain(
				remarkMaestroMarkers
			);
		});

		// The marker has to still be its own `html` node when the plugin runs. Once
		// remark-breaks has spliced a <br> into the line, it is not.
		it('runs the marker plugin before remark-breaks', () => {
			const fns = pluginFns(
				buildMarkdownPlugins({ autorunMarkers: true, chatLineBreaks: true })
					.remarkPlugins as unknown[]
			);
			expect(fns.indexOf(remarkMaestroMarkers)).toBeLessThan(fns.indexOf(remarkBreaks));
		});

		it('adds remark-math (single-dollar disabled) + promote + rehype-katex for chatMath', () => {
			const { remarkPlugins, rehypePlugins } = buildMarkdownPlugins({ chatMath: true });
			const remark = remarkPlugins as unknown[];
			const fns = pluginFns(remark);
			expect(fns).toContain(remarkMath);
			expect(fns).toContain(remarkPromoteDisplayMath);
			// remark-math configured with singleDollarTextMath: false
			const mathEntry = remark.find((e) => Array.isArray(e) && e[0] === remarkMath) as
				| [unknown, Record<string, unknown>]
				| undefined;
			expect(mathEntry?.[1]).toEqual({ singleDollarTextMath: false });
			// promote runs AFTER remark-math (order matters)
			expect(fns.indexOf(remarkPromoteDisplayMath)).toBeGreaterThan(fns.indexOf(remarkMath));
			expect(pluginFns(rehypePlugins as unknown[])).toContain(rehypeKatex);
		});

		it('adds rehype-raw + rehype-sanitize (in that order) only when allowRawHtml is set', () => {
			const fns = pluginFns(
				buildMarkdownPlugins({ allowRawHtml: true }).rehypePlugins as unknown[]
			);
			expect(fns).toContain(rehypeRaw);
			expect(fns).toContain(rehypeSanitize);
			// sanitize must run AFTER raw so it inspects parsed elements, not raw strings
			expect(fns.indexOf(rehypeSanitize)).toBeGreaterThan(fns.indexOf(rehypeRaw));
			expect(buildMarkdownPlugins({ allowRawHtml: false }).rehypePlugins).toBeUndefined();
		});

		it('strips HTML comments exactly when raw HTML is off', () => {
			// With rehype-raw, a comment is parsed into a real comment node and React
			// drops it. Without it, react-markdown prints the comment as text - so the
			// stripper has to cover precisely the surfaces rehype-raw does not.
			const withRaw = pluginFns(buildMarkdownPlugins({ allowRawHtml: true }).remarkPlugins);
			expect(withRaw).not.toContain(remarkStripHtmlComments);

			const withoutRaw = pluginFns(buildMarkdownPlugins({ allowRawHtml: false }).remarkPlugins);
			expect(withoutRaw).toContain(remarkStripHtmlComments);
		});

		it('strips comments after the marker plugin, so marker pills are not stripped too', () => {
			const fns = pluginFns(buildMarkdownPlugins({ autorunMarkers: true }).remarkPlugins);
			expect(fns.indexOf(remarkStripHtmlComments)).toBeGreaterThan(
				fns.indexOf(remarkMaestroMarkers)
			);
		});

		describe('file links gating (mirrors chat renderer logic)', () => {
			it('adds remarkFileLinks when indices + cwd present', () => {
				const { remarkPlugins } = buildMarkdownPlugins({
					fileLinks: {
						indices: { allPaths: new Set(), filenameIndex: new Map() } as never,
						cwd: '',
					},
				});
				expect(pluginFns(remarkPlugins as unknown[])).toContain(remarkFileLinks);
			});

			it('adds remarkFileLinks when only projectRoot present (absolute paths)', () => {
				const { remarkPlugins } = buildMarkdownPlugins({
					fileLinks: { projectRoot: '/Users/me/proj' },
				});
				expect(pluginFns(remarkPlugins as unknown[])).toContain(remarkFileLinks);
			});

			it('adds remarkFileLinks when only homeDir present (tilde paths)', () => {
				const { remarkPlugins } = buildMarkdownPlugins({ fileLinks: { homeDir: '/Users/me' } });
				expect(pluginFns(remarkPlugins as unknown[])).toContain(remarkFileLinks);
			});

			it('does NOT add remarkFileLinks when nothing actionable is provided', () => {
				expect(
					pluginFns(buildMarkdownPlugins({ fileLinks: {} }).remarkPlugins as unknown[])
				).not.toContain(remarkFileLinks);
				expect(
					pluginFns(
						buildMarkdownPlugins({ fileLinks: { indices: null, cwd: '' } })
							.remarkPlugins as unknown[]
					)
				).not.toContain(remarkFileLinks);
				expect(pluginFns(buildMarkdownPlugins().remarkPlugins as unknown[])).not.toContain(
					remarkFileLinks
				);
			});
		});

		describe('mention chips gating', () => {
			it('is absent by default', () => {
				expect(pluginFns(buildMarkdownPlugins().remarkPlugins as unknown[])).not.toContain(
					remarkMentionChips
				);
			});

			it('adds remarkMentionChips when mentionChips is set', () => {
				expect(
					pluginFns(buildMarkdownPlugins({ mentionChips: true }).remarkPlugins as unknown[])
				).toContain(remarkMentionChips);
			});

			it('runs remarkMentionChips BEFORE remarkFileLinks (claims @paths first)', () => {
				const fns = pluginFns(
					buildMarkdownPlugins({
						mentionChips: true,
						fileLinks: { projectRoot: '/Users/me/proj' },
					}).remarkPlugins as unknown[]
				);
				expect(fns.indexOf(remarkMentionChips)).toBeGreaterThanOrEqual(0);
				expect(fns.indexOf(remarkMentionChips)).toBeLessThan(fns.indexOf(remarkFileLinks));
			});
		});

		it('appends extra remark/rehype plugins after the standard stack', () => {
			const extraRemark = () => {};
			const extraRehype = () => {};
			const { remarkPlugins, rehypePlugins } = buildMarkdownPlugins({
				allowRawHtml: true,
				extraRemarkPlugins: [extraRemark],
				extraRehypePlugins: [extraRehype],
			});
			const remarkFnsList = pluginFns(remarkPlugins as unknown[]);
			expect(remarkFnsList[remarkFnsList.length - 1]).toBe(extraRemark);
			const rehypeFnsList = pluginFns(rehypePlugins as unknown[]);
			expect(rehypeFnsList).toContain(extraRehype);
		});
	});
});
describeSourceSuite('rehypeSourceLine', () => {
	const MD = `# Title

Para one.

## Section 2

- item a
- item b

## Section 5

Some text under five.
`;

	/**
	 * The rendered-markdown preview ⇄ edit toggle relies on these attributes being
	 * present in the live DOM (lineSync.domGetTopLineByAttr reads them). These
	 * tests assert react-markdown actually emits `data-source-line` - the camelCase
	 * hast property must survive the property-information → DOM conversion AND the
	 * rehype-raw round-trip.
	 */
	describe('rehypeSourceLine (rendered DOM)', () => {
		it('stamps data-source-line on block elements, including after rehypeRaw', () => {
			const { container } = render(
				<ReactMarkdown rehypePlugins={[rehypeSourceLine, rehypeRaw]}>{MD}</ReactMarkdown>
			);
			const tagged = container.querySelectorAll('[data-source-line]');
			expect(tagged.length).toBeGreaterThan(0);
		});

		it('maps headings to their 1-based source lines', () => {
			const { container } = render(
				<ReactMarkdown rehypePlugins={[rehypeSourceLine, rehypeRaw]}>{MD}</ReactMarkdown>
			);
			const h2s = Array.from(container.querySelectorAll('h2'));
			const byText = (t: string) => h2s.find((h) => h.textContent?.includes(t));
			expect(byText('Section 2')?.getAttribute('data-source-line')).toBe('5');
			expect(byText('Section 5')?.getAttribute('data-source-line')).toBe('10');
			expect(container.querySelector('h1')?.getAttribute('data-source-line')).toBe('1');
		});

		it('stamps task checkboxes with their list item line', () => {
			const { container } = render(
				<ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSourceLine, rehypeRaw]}>
					{'# Tasks\n\n- [ ] first\n- [x] second\n'}
				</ReactMarkdown>
			);
			const boxes = Array.from(container.querySelectorAll('input[type="checkbox"]'));
			expect(boxes.map((b) => b.getAttribute('data-source-line'))).toEqual(['3', '4']);
		});

		it('stamps task checkboxes in a loose list, where the box sits inside a paragraph', () => {
			const { container } = render(
				<ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSourceLine, rehypeRaw]}>
					{'- [ ] first\n\n- [ ] second\n'}
				</ReactMarkdown>
			);
			const boxes = Array.from(container.querySelectorAll('input[type="checkbox"]'));
			expect(boxes.map((b) => b.getAttribute('data-source-line'))).toEqual(['1', '3']);
		});

		it('delivers the line to a custom input component (what makes a click editable)', () => {
			const seen: Array<Record<string, unknown>> = [];
			render(
				<ReactMarkdown
					remarkPlugins={[remarkGfm]}
					rehypePlugins={[rehypeSourceLine, rehypeRaw]}
					components={{
						input: ({ node: _node, ...props }: any) => {
							seen.push(props);
							return <input {...props} readOnly />;
						},
					}}
				>
					{'intro\n\n- [ ] first\n- [x] second\n'}
				</ReactMarkdown>
			);
			// Arrives as the DOM attribute string, so consumers must coerce it.
			expect(seen.map((p) => p['data-source-line'])).toEqual(['3', '4']);
		});

		it('leaves an ordinary list item without a checkbox', () => {
			const { container } = render(
				<ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSourceLine, rehypeRaw]}>
					{'- plain item\n'}
				</ReactMarkdown>
			);
			expect(container.querySelector('input')).toBeNull();
		});

		it('does not tag inline marks (keeps the attribute query block-level)', () => {
			const { container } = render(
				<ReactMarkdown rehypePlugins={[rehypeSourceLine, rehypeRaw]}>
					{'A line with **bold** and `code`.\n'}
				</ReactMarkdown>
			);
			expect(container.querySelector('strong')?.hasAttribute('data-source-line')).toBe(false);
			expect(container.querySelector('code')?.hasAttribute('data-source-line')).toBe(false);
			// ...but the containing paragraph is tagged.
			expect(container.querySelector('p')?.getAttribute('data-source-line')).toBe('1');
		});
	});
});
