/**
 * Tests for MemoryViewer - the filter box and the delete flow.
 *
 * These cover the wiring the viewer owns rather than the primitives it composes
 * (`FilterInput` and `DualPaneFileEditor` have their own tests): that the filter
 * narrows the list from a main-process search, that Escape clears the filter
 * before it closes the pane, and that a delete goes through the shared confirm
 * modal and then lands on the NEXT memory rather than back on the index.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
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
});

/** Types into the filter box and lets the 150ms debounce settle. */
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
