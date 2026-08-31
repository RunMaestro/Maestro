/**
 * Tests for MemoryViewer - the filter box, the edit/preview switch, and the
 * delete flow.
 *
 * These cover the wiring the viewer owns rather than the primitives it composes
 * (`FilterInput`, `DualPaneFileEditor` and `MarkdownEditor` have their own
 * tests): that the filter narrows the list from a main-process search, that
 * Escape clears the filter before it closes the pane, that the pane opens on
 * the rendered document and Cmd+E flips it, and that a delete goes through the
 * shared confirm modal and then lands on the NEXT memory rather than back on
 * the index.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';

/**
 * The real edit surface is CodeMirror 6, which needs a layout engine jsdom does
 * not have. Standing in a plain textarea keeps these tests about the wiring the
 * viewer owns - which mode is showing, where focus lands - and matches how the
 * FilePreview suites stub the same module.
 */
vi.mock('../../../renderer/components/FilePreview/markdownEditor', () => ({
	MarkdownEditor: React.forwardRef<
		{ focus(): void; setSearchMatches(m: unknown[], i: number): void },
		{ value: string; onChange: (v: string) => void }
	>(({ value, onChange }, ref) => {
		const areaRef = React.useRef<HTMLTextAreaElement>(null);
		React.useImperativeHandle(ref, () => ({
			focus: () => areaRef.current?.focus(),
			setSearchMatches: () => {},
		}));
		return <textarea ref={areaRef} value={value} onChange={(e) => onChange(e.target.value)} />;
	}),
}));

import { MemoryViewer } from '../../../renderer/components/MemoryViewer';
import { mockTheme } from '../../helpers/mockTheme';
import { createMockSession } from '../../helpers/mockSession';
import { installLocalStorageMock } from '../../helpers/mockLocalStorage';

const mockRegisterLayer = vi.fn(() => 'layer-memory');
const mockUnregisterLayer = vi.fn();

/** Captured so a test can fire the layer stack's Escape the way the app does. */
let registeredOnEscape: (() => void) | undefined;

vi.mock('../../../renderer/contexts/LayerStackContext', async () => {
	const actual = await vi.importActual('../../../renderer/contexts/LayerStackContext');
	return {
		...actual,
		useLayerStack: () => ({
			registerLayer: (config: { onEscape?: () => void }) => {
				registeredOnEscape = config.onEscape;
				return mockRegisterLayer();
			},
			unregisterLayer: mockUnregisterLayer,
			updateLayerHandler: vi.fn(),
			getTopLayer: vi.fn(),
			closeTopLayer: vi.fn(),
			getLayers: vi.fn(() => []),
			hasOpenLayers: vi.fn(() => false),
			hasOpenModal: vi.fn(() => false),
			layerCount: 0,
		}),
	};
});

const mockOpenGraphScope = vi.fn();
vi.mock('../../../renderer/stores/fileExplorerStore', () => ({
	useFileExplorerStore: Object.assign(() => undefined, {
		getState: () => ({ openGraphScope: mockOpenGraphScope }),
	}),
}));

const mockOpenModal = vi.fn();
vi.mock('../../../renderer/stores/modalStore', () => ({
	useModalStore: Object.assign(() => undefined, { getState: () => ({ openModal: mockOpenModal }) }),
}));

interface MemoryFile {
	name: string;
	body: string;
}

/** In-memory stand-in for the project's memory directory. */
let files: MemoryFile[] = [];

const memoryApi = {
	list: vi.fn(async () => ({
		success: true,
		directoryPath: '/home/.claude/projects/-test-project/memory',
		exists: true,
		entries: files.map((f) => ({
			name: f.name,
			size: f.body.length,
			createdAt: '2026-01-01T00:00:00.000Z',
			modifiedAt: '2026-01-01T00:00:00.000Z',
		})),
		stats: {
			fileCount: files.length,
			firstCreatedAt: '2026-01-01T00:00:00.000Z',
			lastModifiedAt: '2026-01-01T00:00:00.000Z',
			totalBytes: files.reduce((n, f) => n + f.body.length, 0),
		},
	})),
	read: vi.fn(async (_project: string, name: string) => ({
		success: true,
		content: files.find((f) => f.name === name)?.body ?? '',
	})),
	// Mirrors searchMemoryEntries: name OR body, first matching line as snippet.
	search: vi.fn(async (_project: string, query: string) => {
		const needle = query.toLowerCase();
		return {
			success: true,
			matches: files
				.map((f) => ({
					name: f.name,
					matchedName: f.name.toLowerCase().includes(needle),
					snippet: f.body
						.split('\n')
						.find((l) => l.toLowerCase().includes(needle))
						?.trim(),
				}))
				.filter((m) => m.matchedName || m.snippet),
		};
	}),
	// The viewer asks for orphans on every list change; omitting it here leaves
	// an unhandled rejection behind every test in this file.
	orphans: vi.fn(async () => ({ success: true, orphans: [], brokenLinks: [] })),
	delete: vi.fn(async (_project: string, name: string) => {
		files = files.filter((f) => f.name !== name);
		return { success: true };
	}),
	write: vi.fn(async () => ({ success: true })),
	create: vi.fn(async () => ({ success: true })),
	getPath: vi.fn(async () => ({ success: true, path: '/memory' })),
};

function renderViewer(onClose = vi.fn()) {
	const session = createMockSession({ projectRoot: '/test/project', toolType: 'claude-code' });
	const utils = render(
		<MemoryViewer theme={mockTheme} activeSession={session} onClose={onClose} />
	);
	return { ...utils, onClose };
}

function listRowNames(): string[] {
	return Array.from(document.querySelectorAll('[data-item-id]')).map(
		(el) => el.getAttribute('data-item-id') ?? ''
	);
}

describe('MemoryViewer', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		installLocalStorageMock();
		registeredOnEscape = undefined;
		files = [
			{ name: 'MEMORY.md', body: '# Memory index' },
			{ name: 'project_worktrees.md', body: 'Worktrees have no node_modules.' },
			{ name: 'user_role.md', body: 'Security researcher on macOS.' },
		];
		(window as unknown as { maestro: Record<string, unknown> }).maestro = {
			...(window as unknown as { maestro: Record<string, unknown> }).maestro,
			memory: memoryApi,
		};
	});

	afterEach(() => {
		cleanup();
	});

	it('lists every memory when no filter is applied', async () => {
		renderViewer();
		await waitFor(() => expect(listRowNames()).toHaveLength(3));
		expect(memoryApi.search).not.toHaveBeenCalled();
	});

	it('narrows the list to files whose BODY matches the query', async () => {
		renderViewer();
		await waitFor(() => expect(listRowNames()).toHaveLength(3));

		await typeFilter('node_modules');

		await waitFor(() => expect(listRowNames()).toEqual(['project_worktrees.md']));
		expect(screen.getByText('1/3')).toBeInTheDocument();
	});

	it('narrows the list on a filename match too', async () => {
		renderViewer();
		await waitFor(() => expect(listRowNames()).toHaveLength(3));

		await typeFilter('user_role');

		await waitFor(() => expect(listRowNames()).toEqual(['user_role.md']));
	});

	it('moves the editor to the top hit when the filter hides the current file', async () => {
		renderViewer();
		// Opens on MEMORY.md, which does not match.
		await waitFor(() =>
			expect(memoryApi.read).toHaveBeenCalledWith('/test/project', 'MEMORY.md', 'claude-code')
		);

		await typeFilter('Worktrees');

		await waitFor(() =>
			expect(memoryApi.read).toHaveBeenCalledWith(
				'/test/project',
				'project_worktrees.md',
				'claude-code'
			)
		);
	});

	it('clears the filter on Escape before it closes the viewer', async () => {
		const { onClose } = renderViewer();
		await waitFor(() => expect(listRowNames()).toHaveLength(3));

		await typeFilter('node_modules');
		await waitFor(() => expect(listRowNames()).toHaveLength(1));

		registeredOnEscape?.();
		await waitFor(() => expect(listRowNames()).toHaveLength(3));
		expect(onClose).not.toHaveBeenCalled();

		registeredOnEscape?.();
		expect(onClose).toHaveBeenCalled();
	});

	it('lands keyboard focus on the list so arrows work without clicking first', async () => {
		renderViewer();
		await waitFor(() => expect(listRowNames()).toHaveLength(3));

		// Opens on MEMORY.md; the row itself must hold focus.
		await waitFor(() =>
			expect(document.activeElement).toBe(document.querySelector('[data-item-id="MEMORY.md"]'))
		);

		const { fireEvent, act } = await import('@testing-library/react');
		await act(async () => {
			fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowDown' });
		});

		await waitFor(() =>
			expect(memoryApi.read).toHaveBeenCalledWith(
				'/test/project',
				'project_worktrees.md',
				'claude-code'
			)
		);
	});

	it('offers no unlinked chip when every memory is referenced', async () => {
		renderViewer();
		await waitFor(() => expect(listRowNames()).toHaveLength(3));
		expect(screen.queryByTestId('memory-orphan-filter')).not.toBeInTheDocument();
	});

	it('narrows to the unlinked memories when the chip is clicked', async () => {
		memoryApi.orphans.mockResolvedValueOnce({
			success: true,
			orphans: ['user_role.md'],
			brokenLinks: [],
		});
		renderViewer();

		const chip = await screen.findByTestId('memory-orphan-filter');
		expect(chip).toHaveTextContent('1 unlinked');

		const { fireEvent, act } = await import('@testing-library/react');
		await act(async () => {
			fireEvent.click(chip);
		});
		await waitFor(() => expect(listRowNames()).toEqual(['user_role.md']));
	});

	it('composes the unlinked chip with the keyword filter', async () => {
		// "unlinked entries mentioning macOS" is a real question; the chip must
		// narrow the search results rather than replace them.
		memoryApi.orphans.mockResolvedValueOnce({
			success: true,
			orphans: ['user_role.md', 'project_worktrees.md'],
			brokenLinks: [],
		});
		renderViewer();

		const chip = await screen.findByTestId('memory-orphan-filter');
		const { fireEvent, act } = await import('@testing-library/react');
		await act(async () => {
			fireEvent.click(chip);
		});
		await waitFor(() => expect(listRowNames()).toHaveLength(2));

		await typeFilter('macOS');
		await waitFor(() => expect(listRowNames()).toEqual(['user_role.md']));
	});

	it('survives an orphan lookup that throws', async () => {
		// The chip is additive, so a failed lookup must degrade to "no chip"
		// rather than leaving an unhandled rejection behind.
		memoryApi.orphans.mockRejectedValueOnce(new Error('ipc exploded'));
		renderViewer();

		await waitFor(() => expect(listRowNames()).toHaveLength(3));
		expect(screen.queryByTestId('memory-orphan-filter')).not.toBeInTheDocument();
	});

	it('graphs the memory directory, rooted outside the project', async () => {
		// Memory lives under ~/.claude, so the graph has to be told its root
		// explicitly - the agent's project root would resolve every path to
		// nothing.
		const { onClose } = renderViewer();
		const button = await screen.findByTestId('memory-open-graph');

		const { fireEvent, act } = await import('@testing-library/react');
		await act(async () => {
			fireEvent.click(button);
		});

		expect(mockOpenGraphScope).toHaveBeenCalledWith({
			directory: '',
			rootPath: '/home/.claude/projects/-test-project/memory',
			focusPath: 'MEMORY.md',
		});
		// Both are full-window views on the same agent, so the viewer must not
		// stay mounted behind the graph.
		expect(onClose).toHaveBeenCalled();
	});

	it('lets the graph auto-center when there is no MEMORY.md index', async () => {
		files = [{ name: 'a_note.md', body: 'body' }];
		renderViewer();
		const button = await screen.findByTestId('memory-open-graph');

		const { fireEvent, act } = await import('@testing-library/react');
		await act(async () => {
			fireEvent.click(button);
		});

		expect(mockOpenGraphScope).toHaveBeenCalledWith(
			expect.objectContaining({ focusPath: undefined })
		);
	});

	describe('search highlighting', () => {
		it('marks the query inside the rendered memory', async () => {
			renderViewer();
			await waitFor(() => expect(listRowNames()).toHaveLength(3));

			await typeFilter('Memory');

			await waitFor(() => {
				const preview = screen.getByTestId('memory-preview');
				expect(preview.querySelectorAll('mark').length).toBeGreaterThan(0);
			});
		});

		it('marks the query inside the matching filenames', async () => {
			renderViewer();
			await waitFor(() => expect(listRowNames()).toHaveLength(3));

			await typeFilter('worktrees');

			await waitFor(() => {
				const row = document.querySelector('[data-item-id="project_worktrees.md"]');
				expect(row?.querySelector('mark')?.textContent?.toLowerCase()).toBe('worktrees');
			});
		});

		it('marks nothing while the filter is empty', async () => {
			renderViewer();
			await waitFor(() => expect(listRowNames()).toHaveLength(3));

			expect(screen.getByTestId('memory-preview').querySelector('mark')).toBeNull();
			expect(document.querySelector('[data-item-id="MEMORY.md"] mark')).toBeNull();
		});

		it('drops the marks again when the filter is cleared', async () => {
			renderViewer();
			await waitFor(() => expect(listRowNames()).toHaveLength(3));

			await typeFilter('Memory');
			await waitFor(() =>
				expect(screen.getByTestId('memory-preview').querySelector('mark')).toBeTruthy()
			);

			await typeFilter('');
			await waitFor(() =>
				expect(screen.getByTestId('memory-preview').querySelector('mark')).toBeNull()
			);
		});
	});

	describe('filter focus shortcuts', () => {
		function filterBox(): HTMLElement {
			return screen.getByLabelText('Filter memories by name or content');
		}
		function row(name: string): HTMLElement {
			const node = document.querySelector<HTMLElement>(`[data-item-id="${name}"]`);
			if (!node) throw new Error(`No row for ${name}`);
			return node;
		}

		it('jumps to the filter box on "/"', async () => {
			renderViewer();
			await waitFor(() => expect(listRowNames()).toHaveLength(3));

			const { fireEvent } = await import('@testing-library/react');
			fireEvent.keyDown(window, { key: '/' });

			expect(document.activeElement).toBe(filterBox());
		});

		it('jumps to the filter box on Cmd+F', async () => {
			renderViewer();
			await waitFor(() => expect(listRowNames()).toHaveLength(3));

			const { fireEvent } = await import('@testing-library/react');
			fireEvent.keyDown(window, { key: 'f', metaKey: true });

			expect(document.activeElement).toBe(filterBox());
		});

		it('lets "/" type a literal slash while editing a memory', async () => {
			// A path or a regex in the memory body contains slashes; flinging focus
			// into the filter mid-word would be unusable.
			renderViewer();
			await waitFor(() => expect(listRowNames()).toHaveLength(3));

			const { fireEvent } = await import('@testing-library/react');
			const editor = await switchToEdit();
			editor.focus();
			fireEvent.keyDown(editor, { key: '/' });

			expect(document.activeElement).toBe(editor);
		});

		it('still honors Cmd+F from inside the editor, since it means nothing else', async () => {
			renderViewer();
			await waitFor(() => expect(listRowNames()).toHaveLength(3));

			const { fireEvent } = await import('@testing-library/react');
			const editor = await switchToEdit();
			editor.focus();
			fireEvent.keyDown(editor, { key: 'f', metaKey: true });

			expect(document.activeElement).toBe(filterBox());
		});

		it('hands focus back to the list on Escape, keeping the query', async () => {
			// The whole point: filter down, Escape out of the box, then arrow
			// through the hits. A query that vanished here would take the results
			// with it.
			renderViewer();
			await waitFor(() => expect(listRowNames()).toHaveLength(3));

			const { fireEvent, act } = await import('@testing-library/react');
			fireEvent.keyDown(window, { key: '/' });
			await typeFilter('node_modules');
			await waitFor(() => expect(listRowNames()).toEqual(['project_worktrees.md']));

			await act(async () => {
				registeredOnEscape?.();
			});

			await waitFor(() => expect(document.activeElement).toBe(row('project_worktrees.md')));
			expect((filterBox() as HTMLInputElement).value).toBe('node_modules');
		});

		it('clears the filter on the next Escape, then closes on the one after', async () => {
			const { onClose } = renderViewer();
			await waitFor(() => expect(listRowNames()).toHaveLength(3));

			fireEventKeyDownSlash();
			await typeFilter('node_modules');
			await waitFor(() => expect(listRowNames()).toHaveLength(1));

			const { act } = await import('@testing-library/react');
			// 1: out of the box, back to the list.
			await act(async () => registeredOnEscape?.());
			// 2: clear the query.
			await act(async () => registeredOnEscape?.());
			await waitFor(() => expect(listRowNames()).toHaveLength(3));
			expect(onClose).not.toHaveBeenCalled();
			// 3: close.
			await act(async () => registeredOnEscape?.());
			expect(onClose).toHaveBeenCalled();
		});

		it('clears instead of blurring when the filter matched nothing', async () => {
			// There is no row to hand focus to, so blurring would strand focus on
			// <body> and the arrow keys would silently die.
			renderViewer();
			await waitFor(() => expect(listRowNames()).toHaveLength(3));

			const { act } = await import('@testing-library/react');
			fireEventKeyDownSlash();
			await typeFilter('zzz-no-such-memory');
			await waitFor(() => expect(listRowNames()).toHaveLength(0));

			await act(async () => registeredOnEscape?.());

			await waitFor(() => expect(listRowNames()).toHaveLength(3));
			expect((filterBox() as HTMLInputElement).value).toBe('');
		});
	});

	it('routes a delete through the shared destructive confirm modal', async () => {
		renderViewer();
		await waitFor(() => expect(listRowNames()).toHaveLength(3));

		await fireDelete('project_worktrees.md');

		expect(mockOpenModal).toHaveBeenCalledWith(
			'confirm',
			expect.objectContaining({ destructive: true, title: 'Delete Memory' })
		);
		// Nothing is removed until the user confirms.
		expect(memoryApi.delete).not.toHaveBeenCalled();
	});

	it('selects the NEXT memory after a confirmed delete', async () => {
		renderViewer();
		await waitFor(() => expect(listRowNames()).toHaveLength(3));

		await fireDelete('project_worktrees.md');
		await confirmLastModal();

		await waitFor(() => expect(listRowNames()).toEqual(['MEMORY.md', 'user_role.md']));
		expect(memoryApi.read).toHaveBeenCalledWith('/test/project', 'user_role.md', 'claude-code');
	});

	it('falls back to the previous memory when the last one is deleted', async () => {
		renderViewer();
		await waitFor(() => expect(listRowNames()).toHaveLength(3));

		await fireDelete('user_role.md');
		await confirmLastModal();

		await waitFor(() => expect(listRowNames()).toEqual(['MEMORY.md', 'project_worktrees.md']));
		expect(memoryApi.read).toHaveBeenCalledWith(
			'/test/project',
			'project_worktrees.md',
			'claude-code'
		);
	});

	it('refuses to delete the MEMORY.md index', async () => {
		renderViewer();
		await waitFor(() => expect(listRowNames()).toHaveLength(3));

		await fireDelete('MEMORY.md');

		expect(mockOpenModal).not.toHaveBeenCalled();
		expect(await screen.findByText(/MEMORY.md is the index/)).toBeInTheDocument();
	});

	describe('edit / preview mode', () => {
		it('opens on the rendered document rather than the editor', async () => {
			// Reading is the common reason to open this pane, so the writable
			// surface is one keystroke away rather than the state you start in.
			renderViewer();
			await waitFor(() => expect(listRowNames()).toHaveLength(3));

			expect(screen.getByTestId('memory-preview')).toBeInTheDocument();
			expect(document.querySelector('textarea')).toBeNull();
		});

		it('toggles both ways on the Edit/Preview switch', async () => {
			renderViewer();
			await waitFor(() => expect(listRowNames()).toHaveLength(3));

			const { fireEvent, act } = await import('@testing-library/react');
			await act(async () => {
				fireEvent.click(screen.getByTestId('memory-view-mode-edit'));
			});
			expect(document.querySelector('textarea')).toBeTruthy();
			expect(screen.queryByTestId('memory-preview')).not.toBeInTheDocument();

			await act(async () => {
				fireEvent.click(screen.getByTestId('memory-view-mode-preview'));
			});
			expect(document.querySelector('textarea')).toBeNull();
			expect(screen.getByTestId('memory-preview')).toBeInTheDocument();
		});

		it('flips on Cmd+E and back again', async () => {
			renderViewer();
			await waitFor(() => expect(listRowNames()).toHaveLength(3));

			const { fireEvent, act } = await import('@testing-library/react');
			await act(async () => {
				fireEvent.keyDown(window, { key: 'e', metaKey: true });
			});
			expect(document.querySelector('textarea')).toBeTruthy();

			await act(async () => {
				fireEvent.keyDown(window, { key: 'e', metaKey: true });
			});
			expect(document.querySelector('textarea')).toBeNull();
		});

		it('lands the caret in the editor when it opens', async () => {
			// A writable surface that does not take focus swallows nothing - every
			// keystroke still goes wherever it was going, which reads as broken.
			renderViewer();
			await waitFor(() => expect(listRowNames()).toHaveLength(3));

			const { fireEvent, act } = await import('@testing-library/react');
			await act(async () => {
				fireEvent.keyDown(window, { key: 'e', metaKey: true });
			});

			await waitFor(() => expect(document.activeElement).toBe(document.querySelector('textarea')));
		});

		it('renders the memory body as markdown, not as raw source', async () => {
			renderViewer();
			await waitFor(() => expect(listRowNames()).toHaveLength(3));

			// MEMORY.md opens first and starts with a `# Memory index` heading.
			await waitFor(() =>
				expect(screen.getByTestId('memory-preview').querySelector('h1')).toBeTruthy()
			);
		});
	});

	describe('chrome layout', () => {
		/** True when `a` comes before `b` in document order. */
		const before = (a: Element, b: Element) =>
			Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

		const filterEl = () => screen.getByLabelText('Filter memories by name or content');

		it('puts the corpus stats in a footer, below the controls', async () => {
			// Reference figures are not controls. Sharing the toolbar's line with
			// them is what forced that row to wrap in the first place.
			renderViewer();
			await waitFor(() => expect(listRowNames()).toHaveLength(3));

			const footer = screen.getByTestId('memory-stats-footer');
			expect(footer).toHaveTextContent('3 files');
			expect(footer.contains(filterEl())).toBe(false);
			expect(before(filterEl(), footer)).toBe(true);
		});

		it('leads the toolbar with the filter, then the unlinked chip, then Graph', async () => {
			memoryApi.orphans.mockResolvedValueOnce({
				success: true,
				orphans: ['user_role.md'],
				brokenLinks: [],
			});
			renderViewer();

			const chip = await screen.findByTestId('memory-orphan-filter');
			const graph = screen.getByTestId('memory-open-graph');

			expect(before(filterEl(), chip)).toBe(true);
			expect(before(chip, graph)).toBe(true);
			// The view switch acts on the pane rather than the list, so it sits
			// apart from the three that narrow it.
			expect(before(graph, screen.getByTestId('memory-view-mode'))).toBe(true);
		});
	});
});

/** Types into the filter box and lets the 150ms debounce settle. */
/** Flip to the source editor and hand back its (stubbed) textarea. */
async function switchToEdit(): Promise<HTMLTextAreaElement> {
	const { fireEvent, act } = await import('@testing-library/react');
	await act(async () => {
		fireEvent.click(screen.getByTestId('memory-view-mode-edit'));
	});
	const editor = document.querySelector('textarea');
	expect(editor).toBeTruthy();
	return editor as HTMLTextAreaElement;
}

async function typeFilter(text: string): Promise<void> {
	const { fireEvent, act } = await import('@testing-library/react');
	fireEvent.change(screen.getByLabelText('Filter memories by name or content'), {
		target: { value: text },
	});
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 200));
	});
}

/**
 * Selects a row, then presses Backspace on it - the keyboard delete path.
 *
 * The click matters: Backspace deletes the SELECTION, not whatever row happens
 * to be under the caret, so a test that skips the click is really asking to
 * delete whichever file the viewer opened on.
 */
async function fireDelete(name: string): Promise<void> {
	const { fireEvent, act } = await import('@testing-library/react');
	const row = document.querySelector<HTMLElement>(`[data-item-id="${name}"]`);
	if (!row) throw new Error(`No list row for ${name}`);

	await act(async () => {
		fireEvent.click(row);
	});
	row.focus();
	await act(async () => {
		fireEvent.keyDown(row, { key: 'Backspace' });
	});
}

/** Runs the onConfirm the viewer handed to the confirm modal. */
async function confirmLastModal(): Promise<void> {
	const { act } = await import('@testing-library/react');
	const calls = mockOpenModal.mock.calls;
	const call = calls[calls.length - 1];
	if (!call) throw new Error('No confirm modal was opened');
	await act(async () => {
		(call[1] as { onConfirm: () => void }).onConfirm();
	});
}

/** Presses `/` on window, the way the viewer's global handler sees it. */
function fireEventKeyDownSlash(): void {
	window.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true }));
}
