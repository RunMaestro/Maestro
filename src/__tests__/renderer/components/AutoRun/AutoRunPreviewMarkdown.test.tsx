import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AutoRun } from '../../../../renderer/components/AutoRun';
import { LayerStackProvider } from '../../../../renderer/contexts/LayerStackContext';
import { mockTheme } from '../../../helpers/mockTheme';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import { Link, toWireValue } from '../../../../shared/dataview';

/**
 * The Auto Run preview through the REAL markdown pipeline.
 *
 * The main AutoRun suite stubs `react-markdown` out, so it cannot tell a
 * callout from a blockquote or a live checkbox from a disabled one. Both of
 * those have already regressed once: the preview assembled its own remark stack
 * without `remarkAlert` (literal `[!WARNING]` markers), and react-markdown's
 * default `disabled` checkbox made preview a read-only surface even though the
 * prose styles gave the box a pointer cursor.
 */
vi.mock('../../../../renderer/components/MermaidRenderer', () => ({
	MermaidRenderer: () => <div data-testid="mermaid" />,
}));

const writeDoc = vi.fn().mockResolvedValue(undefined);

const baseProps = (overrides: Record<string, unknown> = {}) => ({
	theme: mockTheme,
	sessionId: 'session-1',
	folderPath: '/test/folder',
	selectedFile: 'doc',
	documentList: ['doc'],
	content: '',
	onContentChange: vi.fn(),
	mode: 'preview' as const,
	onModeChange: vi.fn(),
	onOpenSetup: vi.fn(),
	onRefresh: vi.fn(),
	onSelectDocument: vi.fn(),
	onCreateDocument: vi.fn().mockResolvedValue(true),
	...overrides,
});

const renderPreview = (content: string, overrides: Record<string, unknown> = {}) =>
	render(
		<LayerStackProvider>
			<AutoRun {...(baseProps({ content, ...overrides }) as any)} />
		</LayerStackProvider>
	);

beforeEach(() => {
	writeDoc.mockClear();
	(window as any).maestro = {
		fs: { readFile: vi.fn().mockResolvedValue(''), readDir: vi.fn().mockResolvedValue([]) },
		autorun: {
			listImages: vi.fn().mockResolvedValue({ success: true, images: [] }),
			writeDoc,
		},
		settings: { get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue(undefined) },
	};
});

describe('Auto Run preview callouts', () => {
	const ALERT_DOC =
		'> [!WARNING]\n> Not a playbook.\n\n> [!IMPORTANT]\n> Read this.\n\n> Just a quote.\n';

	it('renders `[!TYPE]` blockquotes as callouts instead of literal markers', () => {
		const { container } = renderPreview(ALERT_DOC);

		expect(screen.getByText('Warning')).toBeInTheDocument();
		expect(screen.getByText('Important')).toBeInTheDocument();
		expect(container.textContent).not.toContain('[!WARNING]');
		expect(container.textContent).not.toContain('[!IMPORTANT]');

		expect(
			Array.from(container.querySelectorAll('.markdown-alert')).map((el) =>
				el.getAttribute('data-alert-type')
			)
		).toEqual(['warning', 'important']);
	});

	it('leaves an ordinary blockquote alone', () => {
		const { container } = renderPreview(ALERT_DOC);

		expect(container.querySelectorAll('blockquote')).toHaveLength(1);
		expect(container.querySelector('blockquote')?.textContent).toContain('Just a quote.');
	});
});

describe('Auto Run preview task checkboxes', () => {
	const TASK_DOC = '# Doc\n\n- [ ] first\n- [x] second\n';

	it('writes the flipped task back to the document when a box is clicked', async () => {
		const { container } = renderPreview(TASK_DOC);
		const boxes = container.querySelectorAll('input[type="checkbox"]');

		expect(boxes).toHaveLength(2);
		fireEvent.click(boxes[0]);

		await waitFor(() =>
			expect(writeDoc).toHaveBeenCalledWith(
				'/test/folder',
				'doc.md',
				'# Doc\n\n- [x] first\n- [x] second\n',
				undefined
			)
		);
	});

	it('unchecks a completed task', async () => {
		const { container } = renderPreview(TASK_DOC);

		fireEvent.click(container.querySelectorAll('input[type="checkbox"]')[1]);

		await waitFor(() =>
			expect(writeDoc).toHaveBeenCalledWith(
				'/test/folder',
				'doc.md',
				'# Doc\n\n- [ ] first\n- [ ] second\n',
				undefined
			)
		);
	});

	// Saving on a toggle writes the whole draft, so with unsaved edits in play
	// the toggle would persist them and leave Revert nothing to discard.
	it('keeps a toggle in the draft while the document has unsaved edits', async () => {
		const draft = TASK_DOC + '\nunsaved line\n';
		const { container } = renderPreview(TASK_DOC, {
			externalLocalContent: draft,
			externalSavedContent: TASK_DOC,
		});

		fireEvent.click(container.querySelectorAll('input[type="checkbox"]')[0]);
		await waitFor(() =>
			expect(
				(container.querySelectorAll('input[type="checkbox"]')[0] as HTMLInputElement).checked
			).toBe(true)
		);
		expect(writeDoc).not.toHaveBeenCalled();

		fireEvent.click(screen.getByTitle('Discard changes'));
		await waitFor(() => expect(container.textContent).not.toContain('unsaved line'));
		expect(
			(container.querySelectorAll('input[type="checkbox"]')[0] as HTMLInputElement).checked
		).toBe(false);
	});

	// A document owned by a running Auto Run is read-only in the editor; its
	// checkboxes must match rather than letting a click race the agent.
	it('keeps checkboxes read-only while the document is locked by a run', () => {
		const { container } = renderPreview(TASK_DOC, {
			batchRunState: {
				isRunning: true,
				isStopping: false,
				documents: ['doc'],
				lockedDocuments: ['doc'],
				currentDocumentIndex: 0,
				worktreeActive: false,
				folderPath: '/test/folder',
				totalTasks: 2,
				completedTasks: 1,
				currentTaskIndex: 0,
				originalContent: '',
			},
		});

		const boxes = container.querySelectorAll('input[type="checkbox"]');
		expect(boxes).toHaveLength(2);
		expect((boxes[0] as HTMLInputElement).disabled).toBe(true);

		fireEvent.click(boxes[0]);
		expect(writeDoc).not.toHaveBeenCalled();
	});
});

/**
 * Ticking a box must not move the page.
 *
 * `createMarkdownComponents()` returns a map of freshly-created component
 * functions, so rebuilding it hands React a NEW component TYPE for every
 * element and it unmounts and remounts the entire rendered document. The
 * scroll container survives, its contents do not, so the reader is thrown back
 * to the top of a long playbook on every click. The toggle handler closes over
 * the document content, which is exactly the kind of dependency that rebuilds
 * that map.
 *
 * jsdom has no layout engine, so asserting on `scrollTop` would pass either
 * way. Asserting that the DOM nodes SURVIVE the toggle is the real invariant -
 * a preserved node cannot have had its scroll position reset.
 */
describe('Auto Run preview stability across a toggle', () => {
	it('keeps the rendered document mounted when a task is ticked', async () => {
		const { container } = renderPreview('# Doc\n\n- [ ] first\n- [ ] second\n');

		const headingBefore = container.querySelector('h1');
		const listBefore = container.querySelector('ul');
		expect(headingBefore).not.toBeNull();

		fireEvent.click(container.querySelectorAll('input[type="checkbox"]')[0]);
		await waitFor(() => expect(writeDoc).toHaveBeenCalled());

		expect(container.querySelector('h1')).toBe(headingBefore);
		expect(container.querySelector('ul')).toBe(listBefore);
	});

	it('survives several toggles in a row', async () => {
		const { container } = renderPreview('# Doc\n\n- [ ] first\n- [ ] second\n');
		const headingBefore = container.querySelector('h1');

		fireEvent.click(container.querySelectorAll('input[type="checkbox"]')[0]);
		await waitFor(() => expect(writeDoc).toHaveBeenCalledTimes(1));
		fireEvent.click(container.querySelectorAll('input[type="checkbox"]')[1]);
		await waitFor(() => expect(writeDoc).toHaveBeenCalledTimes(2));

		expect(container.querySelector('h1')).toBe(headingBefore);
		expect(writeDoc).toHaveBeenLastCalledWith(
			'/test/folder',
			'doc.md',
			'# Doc\n\n- [x] first\n- [x] second\n',
			undefined
		);
	});
});

describe('Auto Run preview file links', () => {
	// The Auto Run folder is a small corner of the project, but a playbook links
	// to notes all over it. Resolving only against the playbooks tree left every
	// such `[[link]]` as inert text here while the same link worked in a
	// file-preview tab.
	const AUTORUN_TREE = [{ name: 'Sibling.md', type: 'file' as const, path: 'Sibling.md' }];
	const PROJECT_TREE = [
		{
			name: 'Claude',
			type: 'folder' as const,
			children: [{ name: 'Reminders Archive.md', type: 'file' as const }],
		},
	];

	const linkProps = (overrides: Record<string, unknown> = {}) => ({
		documentTree: AUTORUN_TREE,
		projectFileTree: PROJECT_TREE,
		projectRoot: '/Users/p/Vault',
		...overrides,
	});

	it('links a wiki reference that lives in the project but not in the Auto Run folder', () => {
		const onOpenProjectFile = vi.fn();
		const onSelectDocument = vi.fn();
		const { container } = renderPreview(
			'See [[Claude/Reminders Archive]] for the full record.',
			linkProps({ onOpenProjectFile, onSelectDocument })
		);

		const link = container.querySelector('a');
		expect(link).not.toBeNull();
		expect(link?.textContent).toBe('Claude/Reminders Archive');

		fireEvent.click(link!);
		expect(onOpenProjectFile).toHaveBeenCalledWith('Claude/Reminders Archive.md', {
			openInNewTab: false,
		});
		expect(onSelectDocument).not.toHaveBeenCalled();
	});

	it('still switches documents for a link the Auto Run folder owns', () => {
		const onOpenProjectFile = vi.fn();
		const onSelectDocument = vi.fn();
		const { container } = renderPreview(
			'See [[Sibling]].',
			linkProps({ onOpenProjectFile, onSelectDocument })
		);

		fireEvent.click(container.querySelector('a')!);
		expect(onSelectDocument).toHaveBeenCalledWith('Sibling');
		expect(onOpenProjectFile).not.toHaveBeenCalled();
	});

	it('links an absolute path inside the project root', () => {
		const onOpenProjectFile = vi.fn();
		const { container } = renderPreview(
			'Killed asks live in /Users/p/Vault/Claude/Reminders Archive.md today.',
			linkProps({ onOpenProjectFile })
		);

		const link = container.querySelector('a');
		expect(link).not.toBeNull();
		fireEvent.click(link!);
		expect(onOpenProjectFile).toHaveBeenCalledWith('Claude/Reminders Archive.md', {
			openInNewTab: false,
		});
	});

	it('leaves an unresolvable reference as plain text', () => {
		const { container } = renderPreview('See [[Nothing/Here]].', linkProps());

		expect(container.querySelector('a')).toBeNull();
		expect(container.textContent).toContain('[[Nothing/Here]]');
	});
});

describe('Auto Run preview Dataview blocks', () => {
	const DATAVIEW_DOC = '# Doc\n\n- [ ] own task\n\n```dataview\nLIST FROM "Notes"\n```\n';
	let documentCounter = 0;

	const setDataviewEnabled = (enabled: boolean) =>
		useSettingsStore.setState((state) => ({
			encoreFeatures: { ...state.encoreFeatures, dataview: enabled },
		}));

	/** A list result of links, answered for every query (paths relative to the folder root). */
	const answerWithLinks = (paths: string[]) =>
		vi.fn().mockResolvedValue({
			root: '/test/folder',
			sshRemoteId: null,
			revision: 1,
			path: 'doc.md',
			result: {
				kind: 'list',
				items: paths.map((p) => toWireValue(Link.file(p))),
				idMeaning: { type: 'path' },
				warnings: [],
			},
		});

	beforeEach(() => {
		(window as any).maestro.dataview = {
			query: vi.fn(() => new Promise(() => {})),
			queryInline: vi.fn(() => new Promise(() => {})),
			onChanged: vi.fn(() => () => {}),
		};
		setDataviewEnabled(true);
	});

	afterEach(() => setDataviewEnabled(false));

	// A distinct document per test keeps the module-level result cache from leaking.
	const nextDocument = () => `dataview-${++documentCounter}`;

	it('runs the block against the document on screen and its agent', () => {
		const selectedFile = nextDocument();
		const { container } = renderPreview(DATAVIEW_DOC, { selectedFile });

		expect(container.querySelector('[data-dataview-block]')).toBeTruthy();
		expect((window as any).maestro.dataview.query).toHaveBeenCalledWith({
			filePath: `/test/folder/${selectedFile}.md`,
			source: 'LIST FROM "Notes"',
			agentId: 'session-1',
		});
	});

	it('renders the fence as code while the Encore Feature is off', () => {
		setDataviewEnabled(false);
		const { container } = renderPreview(DATAVIEW_DOC, { selectedFile: nextDocument() });

		expect(container.querySelector('[data-dataview-block]')).toBeNull();
		expect(container.textContent).toContain('LIST FROM "Notes"');
		expect((window as any).maestro.dataview.query).not.toHaveBeenCalled();
	});

	it('selects a playbook in the folder and opens anything else as a project file', async () => {
		(window as any).maestro.dataview.query = answerWithLinks(['Other.md', 'img/chart.png']);
		const onSelectDocument = vi.fn();
		const onOpenProjectFile = vi.fn();
		renderPreview(DATAVIEW_DOC, {
			selectedFile: nextDocument(),
			onSelectDocument,
			onOpenProjectFile,
		});

		fireEvent.click(await screen.findByText('Other'));
		expect(onSelectDocument).toHaveBeenCalledWith('Other');

		fireEvent.click(screen.getByText('chart.png'));
		expect(onOpenProjectFile).toHaveBeenCalledWith('/test/folder/img/chart.png', {
			openInNewTab: false,
		});
	});
});
