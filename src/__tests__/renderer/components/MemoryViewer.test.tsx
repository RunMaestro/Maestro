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
import { render, screen, cleanup, waitFor, fireEvent, act } from '@testing-library/react';

/**
 * The real edit surface is CodeMirror 6, which needs a layout engine jsdom does
 * not have. Standing in a plain textarea keeps these tests about the wiring the
 * viewer owns - which mode is showing, where focus lands - and matches how the
 * FilePreview suites stub the same module.
 */
vi.mock('../../../renderer/components/FilePreview/markdownEditor', async () => {
	const { markdownEditorModuleMock } = await import('../../helpers/mockMarkdownEditor');
	return markdownEditorModuleMock();
});

vi.mock('../../../renderer/hooks/agent/useAgentModelEffortOptions', async (importOriginal) => ({
	...(await importOriginal<
		typeof import('../../../renderer/hooks/agent/useAgentModelEffortOptions')
	>()),
	useAgentModelEffortOptions: () => ({
		defaultModel: 'synthetic-model',
		defaultEffort: 'medium',
		loaded: true,
		models: [],
		efforts: [],
	}),
}));

import { selectMemoryCommandDraft } from '../../../renderer/services/memoryCommandDraft';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
vi.mock('../../../renderer/services/memoryCommandDraft', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../renderer/services/memoryCommandDraft')>()),
	selectMemoryCommandDraft: vi.fn((...args: Parameters<typeof selectMemoryCommandDraft>) =>
		actualSelect(...args)
	),
}));
let actualSelect: typeof selectMemoryCommandDraft;

import type { MemoryViewerHandle } from '../../../renderer/components/MemoryViewer';
import type { CodexMemorySourceRef } from '../../../main/agents/codex-memory';
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

/** Claude's store: one flat directory per project, linked through MEMORY.md. */
const CLAUDE_LAYOUT = { scope: 'project', nested: false, newEntryDir: '', tracksLinks: true };
/** Codex's store: one nested directory per account; people add ad-hoc notes. */
const CODEX_LAYOUT = {
	scope: 'account',
	nested: true,
	newEntryDir: 'extensions/ad_hoc/notes',
	tracksLinks: false,
};
let layout: Record<string, unknown> = CLAUDE_LAYOUT;
/** Files the main process reports as `protected` (the index, generated files). */
let protectedNames = new Set(['MEMORY.md']);

/** What every memory call for the default Claude agent is addressed to. */
const CLAUDE_TARGET = expect.objectContaining({
	projectPath: '/test/project',
	toolType: 'claude-code',
});

const sourceRef: CodexMemorySourceRef = {
	sourceAgentId: 'codex-source',
	provider: 'codex',
	location: { kind: 'local' },
	codexHome: '/synthetic/codex',
	memoryRoot: '/synthetic/codex/memories',
	relativePath: '',
};
let draftListener:
	| ((value: {
			viewerId: string;
			requestId: string;
			draft: { command: string; description: string; prompt: string };
	  }) => void)
	| undefined;
const memoryApi = {
	commandAvailability: vi.fn(async () => ({ status: 'plugin-unavailable' })),
	generateCommand: vi.fn(),
	saveCommand: vi.fn(),
	closeCommandViewer: vi.fn(async () => {}),
	onCommandDraft: vi.fn((callback: typeof draftListener) => {
		draftListener = callback;
		return () => {
			draftListener = undefined;
		};
	}),
	list: vi.fn(async () => ({
		success: true,
		directoryPath:
			layout.scope === 'account'
				? sourceRef.memoryRoot
				: '/home/.claude/projects/-test-project/memory',
		exists: true,
		entries: files.map((f) => ({
			name: f.name,
			size: f.body.length,
			createdAt: '2026-01-01T00:00:00.000Z',
			modifiedAt: '2026-01-01T00:00:00.000Z',
			...(protectedNames.has(f.name) ? { protected: true } : {}),
		})),
		stats: {
			fileCount: files.length,
			firstCreatedAt: '2026-01-01T00:00:00.000Z',
			lastModifiedAt: '2026-01-01T00:00:00.000Z',
			totalBytes: files.reduce((n, f) => n + f.body.length, 0),
		},
		layout,
	})),
	read: vi.fn(async (_target: unknown, name: string) => ({
		success: true,
		content: files.find((f) => f.name === name)?.body ?? '',
		sourceRef:
			(_target as { toolType?: string }).toolType === 'codex'
				? {
						...sourceRef,
						sourceAgentId: (_target as { agentId: string }).agentId,
						relativePath: name,
					}
				: undefined,
	})),
	// Mirrors searchMemoryEntries: name OR body, first matching line as snippet.
	search: vi.fn(async (_target: unknown, query: string) => {
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
	delete: vi.fn(async (_target: unknown, name: string) => {
		files = files.filter((f) => f.name !== name);
		return { success: true };
	}),
	write: vi.fn(async () => ({ success: true })),
	create: vi.fn(async () => ({ success: true })),
	getPath: vi.fn(async () => ({ success: true, path: '/memory' })),
};

function renderViewer(
	onClose = vi.fn(),
	sessionOverrides: Parameters<typeof createMockSession>[0] = {}
) {
	const session = createMockSession({
		projectRoot: '/test/project',
		toolType: 'claude-code',
		...sessionOverrides,
	});
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
		layout = CLAUDE_LAYOUT;
		protectedNames = new Set(['MEMORY.md']);
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

	describe('Codex session memory', () => {
		const session = createMockSession({
			id: 'codex-source',
			toolType: 'codex',
			projectRoot: '/test/project',
			cwd: '/test/project',
		});
		function renderCodex() {
			const ref = React.createRef<MemoryViewerHandle>();
			const result = render(
				<MemoryViewer ref={ref} theme={mockTheme} activeSession={session} onClose={vi.fn()} />
			);
			return { ...result, ref };
		}
		beforeEach(async () => {
			useSettingsStore.setState((state) => ({
				encoreFeatures: { ...state.encoreFeatures, plugins: true },
			}));
			actualSelect = (
				await vi.importActual<typeof import('../../../renderer/services/memoryCommandDraft')>(
					'../../../renderer/services/memoryCommandDraft'
				)
			).selectMemoryCommandDraft;
			useSessionStore.setState({ sessions: [] });
			memoryApi.commandAvailability.mockResolvedValue({ status: 'plugin-unavailable' });
			memoryApi.generateCommand.mockReset();
			memoryApi.saveCommand.mockReset().mockImplementation(async (_viewer, requestId, fields) => ({
				requestId,
				status: 'saved',
				commands: [
					...useSettingsStore.getState().customAICommands,
					{ id: 'host-created', ...fields, isBuiltIn: false },
				],
			}));
			files = [
				{ name: 'memory_summary.md', body: '# Synthetic summary\r\n😀 text' },
				{ name: 'rollout_summaries/example.md', body: '# Native rollout' },
			];
			layout = CODEX_LAYOUT;
			protectedNames = new Set(['memory_summary.md']);
		});
		it('hides draft controls and avoids draft subscriptions when plugins are disabled', async () => {
			useSettingsStore.setState((state) => ({
				encoreFeatures: { ...state.encoreFeatures, plugins: false },
			}));
			renderCodex();
			await screen.findByTestId('memory-preview');
			expect(screen.queryByLabelText('Codex generator')).toBeNull();
			expect(screen.queryByText(/command plugin/i)).toBeNull();
			expect(screen.queryByRole('button', { name: /command draft/i })).toBeNull();
			expect(memoryApi.commandAvailability).not.toHaveBeenCalled();
			expect(memoryApi.onCommandDraft).not.toHaveBeenCalled();
			expect(selectMemoryCommandDraft).not.toHaveBeenCalled();
			expect(memoryApi.generateCommand).not.toHaveBeenCalled();
		});

		it('cancels an active preview when plugins are disabled and allows a fresh draft when enabled', async () => {
			memoryApi.commandAvailability.mockResolvedValue({ status: 'available' });
			memoryApi.generateCommand.mockImplementation(async (viewerId) => {
				draftListener?.({
					viewerId,
					requestId: 'preview',
					draft: { command: '/test', description: 'Test', prompt: 'Test' },
				});
				return { requestId: 'preview', status: 'preview' };
			});
			renderCodex();
			await screen.findByTestId('memory-preview');
			fireEvent.click(screen.getByRole('button', { name: 'Prepare command draft' }));
			await waitFor(() =>
				expect(screen.getByRole('button', { name: 'Generate command' })).toBeEnabled()
			);
			fireEvent.click(screen.getByRole('button', { name: 'Generate command' }));
			await screen.findByLabelText('Global command preview');
			const viewerId = memoryApi.generateCommand.mock.calls[0][0];
			act(() =>
				useSettingsStore.setState((state) => ({
					encoreFeatures: { ...state.encoreFeatures, plugins: false },
				}))
			);
			expect(memoryApi.closeCommandViewer).toHaveBeenCalledWith(viewerId);
			expect(screen.queryByLabelText('Global command preview')).toBeNull();
			expect(draftListener).toBeUndefined();
			act(() =>
				useSettingsStore.setState((state) => ({
					encoreFeatures: { ...state.encoreFeatures, plugins: true },
				}))
			);
			expect(screen.getByRole('button', { name: 'Prepare command draft' })).toBeInTheDocument();
			expect(screen.queryByText(/Snapshot selected:/)).toBeNull();
		});
		afterEach(() => {
			// Preparing and generating a command never writes the source memory.
			for (const key of ['write', 'create', 'delete'] as const)
				expect(memoryApi[key]).not.toHaveBeenCalled();
		});

		it('captures explicit command input with a chosen Codex generator and never starts generation', async () => {
			const other = createMockSession({
				id: 'generator-2',
				name: 'Second generator',
				toolType: 'codex',
				customModel: 'chosen-model',
				customEffort: 'high',
			});
			useSessionStore.setState({
				sessions: [
					session,
					other,
					createMockSession({ id: 'claude-generator', toolType: 'claude-code' }),
				],
			});
			renderCodex();
			await screen.findByTestId('memory-preview');
			expect(selectMemoryCommandDraft).not.toHaveBeenCalled();
			expect(screen.queryByRole('option', { name: /claude-generator/ })).toBeNull();
			fireEvent.change(screen.getByLabelText('Codex generator'), { target: { value: other.id } });
			fireEvent.click(screen.getByTestId('memory-view-mode-edit'));
			const area = document.querySelector('textarea') as HTMLTextAreaElement;
			fireEvent.change(area, { target: { value: 'Local 😀 draft' } });
			area.setSelectionRange(6, 8);
			fireEvent.click(screen.getByRole('button', { name: 'Prepare command draft' }));
			expect(selectMemoryCommandDraft).toHaveBeenCalledWith(
				expect.objectContaining({
					textSnapshot: 'Local 😀 draft',
					dirty: true,
					selection: { start: 6, end: 8 },
				}),
				{ agentId: other.id, provider: 'codex', model: 'chosen-model', effort: 'high' }
			);
			expect(screen.getByText(/Snapshot selected:/)).toHaveTextContent(
				'Source: codex-source · Generator: generator-2 · Model: chosen-model · Effort: high · Selected text · Local changes'
			);
			expect(screen.getByRole('button', { name: 'Generate command' })).toBeDisabled();
			expect(files[0].body).toBe('# Synthetic summary\r\n😀 text');
			fireEvent.click(screen.getByRole('button', { name: 'Discard command draft' }));
			expect(screen.queryByText(/Snapshot selected:/)).toBeNull();
		});
		it('invalidates a prepared snapshot on file change and reports snapshot limits', async () => {
			renderCodex();
			await screen.findByTestId('memory-preview');
			fireEvent.click(screen.getByRole('button', { name: 'Prepare command draft' }));
			expect(screen.getByText(/Snapshot selected:/)).toHaveTextContent('Whole file');
			fireEvent.click(document.querySelector('[data-item-id="rollout_summaries/example.md"]')!);
			await waitFor(() => expect(screen.queryByText(/Snapshot selected:/)).toBeNull());
			fireEvent.click(screen.getByTestId('memory-view-mode-edit'));
			fireEvent.change(document.querySelector('textarea')!, {
				target: { value: 'é'.repeat(65537) },
			});
			fireEvent.click(screen.getByRole('button', { name: 'Prepare command draft' }));
			expect(screen.getByRole('alert')).toHaveTextContent('Memory snapshot exceeds 128 KiB');
			expect(screen.queryByText(/Snapshot selected:/)).toBeNull();
		});
		it('generates only on the explicit click, receives the host draft and never saves', async () => {
			memoryApi.commandAvailability.mockResolvedValue({ status: 'available' });
			memoryApi.generateCommand.mockImplementation(async (viewerId: string) => {
				draftListener?.({
					viewerId,
					requestId: 'host-id',
					draft: { command: 'synthetic', description: 'Synthetic', prompt: 'Reusable prompt' },
				});
				return { requestId: 'host-id', status: 'preview' };
			});
			renderCodex();
			await screen.findByTestId('memory-preview');
			fireEvent.click(screen.getByRole('button', { name: 'Prepare command draft' }));
			expect(memoryApi.generateCommand).not.toHaveBeenCalled();
			const button = screen.getByRole('button', { name: 'Generate command' });
			await waitFor(() => expect(button).not.toBeDisabled());
			fireEvent.click(button);
			await screen.findByText('Validated command draft: synthetic · Not saved');
			expect(memoryApi.generateCommand).toHaveBeenCalledOnce();
			expect(memoryApi.generateCommand).toHaveBeenCalledWith(
				expect.any(String),
				expect.objectContaining({
					textSnapshot: files[0].body,
					generator: expect.objectContaining({ agentId: session.id }),
				})
			);
			expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
			expect(memoryApi.write).not.toHaveBeenCalled();
			fireEvent.click(screen.getByRole('button', { name: 'Discard command draft' }));
			expect(memoryApi.closeCommandViewer).toHaveBeenCalledWith(
				memoryApi.generateCommand.mock.calls[0][0]
			);
			expect(screen.queryByText(/Validated command draft:/)).toBeNull();
		});
		it('edits the existing global form and persists only on explicit create', async () => {
			const beforeFiles = JSON.stringify(files);
			const old = {
				id: 'old',
				command: '/old',
				description: 'Old',
				prompt: 'Old prompt',
				isBuiltIn: false,
			};
			useSettingsStore.setState({ customAICommands: [old] });
			vi.mocked(window.maestro.settings.set).mockClear().mockResolvedValue(true);
			memoryApi.commandAvailability.mockResolvedValue({ status: 'available' });
			let event: Parameters<NonNullable<typeof draftListener>>[0];
			memoryApi.generateCommand.mockImplementation(async (viewerId: string) => {
				event = {
					viewerId,
					requestId: 'host-preview',
					draft: { command: '/synthetic', description: 'Synthetic', prompt: 'Reusable prompt' },
				};
				draftListener?.(event);
				// A replay cannot replace an already accepted preview.
				draftListener?.({ ...event, draft: { ...event.draft, prompt: 'Replayed prompt' } });
				return { requestId: 'host-preview', status: 'preview' };
			});
			renderCodex();
			await screen.findByTestId('memory-preview');
			fireEvent.click(screen.getByRole('button', { name: 'Prepare command draft' }));
			await waitFor(() =>
				expect(screen.getByRole('button', { name: 'Generate command' })).not.toBeDisabled()
			);
			fireEvent.click(screen.getByRole('button', { name: 'Generate command' }));
			await screen.findByDisplayValue('Reusable prompt');
			expect(window.maestro.settings.set).not.toHaveBeenCalled();
			fireEvent.change(screen.getByDisplayValue('Reusable prompt'), {
				target: { value: 'Edited prompt' },
			});
			fireEvent.click(screen.getByRole('button', { name: 'Create' }));
			await screen.findByText('Command saved globally.');
			expect(memoryApi.saveCommand).toHaveBeenCalledExactlyOnceWith(
				event!.viewerId,
				'host-preview',
				{
					command: '/synthetic',
					description: 'Synthetic',
					prompt: 'Edited prompt',
				}
			);
			expect(window.maestro.settings.set).not.toHaveBeenCalled();
			expect(memoryApi.closeCommandViewer).not.toHaveBeenCalledWith(event!.viewerId);
			expect(useSettingsStore.getState().customAICommands[0]).toEqual(old);
			expect(useSettingsStore.getState().customAICommands).toHaveLength(2);
			expect(screen.queryByLabelText('Global command preview')).toBeNull();
			act(() => draftListener?.(event));
			expect(screen.queryByLabelText('Global command preview')).toBeNull();
			expect(JSON.stringify(files)).toBe(beforeFiles);
			expect(memoryApi.write).not.toHaveBeenCalled();
		});
		it.each(['retry', 'collision', 'revoked', 'foreign-response'] as const)(
			'keeps the preview after host save %s without a settings write',
			async (failure) => {
				useSettingsStore.setState({ customAICommands: [] });
				memoryApi.commandAvailability.mockResolvedValue({ status: 'available' });
				memoryApi.generateCommand.mockImplementation(async (viewerId: string) => {
					draftListener?.({
						viewerId,
						requestId: 'host-preview',
						draft: { command: '/synthetic', description: 'Synthetic', prompt: 'Synthetic prompt' },
					});
					return { requestId: 'host-preview', status: 'preview' };
				});
				if (failure === 'revoked')
					memoryApi.saveCommand.mockRejectedValueOnce(new Error('MemoryCommandUnavailable'));
				else
					memoryApi.saveCommand.mockResolvedValueOnce({
						requestId: failure === 'foreign-response' ? 'foreign' : 'host-preview',
						status: failure === 'foreign-response' ? 'saved' : failure,
						commands: [],
					});
				renderCodex();
				await screen.findByTestId('memory-preview');
				fireEvent.click(screen.getByRole('button', { name: 'Prepare command draft' }));
				await waitFor(() =>
					expect(screen.getByRole('button', { name: 'Generate command' })).not.toBeDisabled()
				);
				fireEvent.click(screen.getByRole('button', { name: 'Generate command' }));
				await screen.findByDisplayValue('Synthetic prompt');
				fireEvent.click(screen.getByRole('button', { name: 'Create' }));
				await screen.findByRole('alert');
				expect(screen.getByDisplayValue('Synthetic prompt')).toBeInTheDocument();
				expect(useSettingsStore.getState().customAICommands).toEqual([]);
				expect(screen.queryByText('Command saved globally.')).toBeNull();
				fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
				expect(memoryApi.closeCommandViewer).toHaveBeenCalledWith(
					memoryApi.generateCommand.mock.calls[0][0]
				);
				expect(memoryApi.saveCommand).toHaveBeenCalledOnce();
			}
		);
		it('does not let an older confirmed save close a replacement preview', async () => {
			useSettingsStore.setState({ customAICommands: [] });
			let finish!: (saved: Awaited<ReturnType<typeof memoryApi.saveCommand>>) => void;
			memoryApi.saveCommand.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						finish = resolve;
					})
			);
			memoryApi.commandAvailability.mockResolvedValue({ status: 'available' });
			let sequence = 0;
			memoryApi.generateCommand.mockImplementation(async (viewerId: string) => {
				const requestId = `host-${++sequence}`;
				draftListener?.({
					viewerId,
					requestId,
					draft: {
						command: `/draft-${sequence}`,
						description: 'Synthetic',
						prompt: 'Synthetic prompt',
					},
				});
				return { requestId, status: 'preview' };
			});
			renderCodex();
			await screen.findByTestId('memory-preview');
			fireEvent.click(screen.getByRole('button', { name: 'Prepare command draft' }));
			await waitFor(() =>
				expect(screen.getByRole('button', { name: 'Generate command' })).not.toBeDisabled()
			);
			fireEvent.click(screen.getByRole('button', { name: 'Generate command' }));
			await screen.findByDisplayValue('/draft-1');
			fireEvent.click(screen.getByRole('button', { name: 'Create' }));
			fireEvent.click(screen.getByRole('button', { name: 'Discard command draft' }));
			fireEvent.click(screen.getByRole('button', { name: 'Prepare command draft' }));
			fireEvent.click(screen.getByRole('button', { name: 'Generate command' }));
			await screen.findByDisplayValue('/draft-2');
			await act(async () =>
				finish({
					requestId: 'host-1',
					status: 'saved',
					commands: [
						{
							id: 'host-created',
							command: '/draft-1',
							description: 'Synthetic',
							prompt: 'Synthetic prompt',
						},
					],
				})
			);
			expect(screen.getByDisplayValue('/draft-2')).toBeInTheDocument();
			expect(screen.queryByText('Command saved globally.')).toBeNull();
			expect(useSettingsStore.getState().customAICommands).toEqual([
				expect.objectContaining({ command: '/draft-1' }),
			]);
		});
		it('discards late replies after cancellation and ignores a different request viewer', async () => {
			memoryApi.commandAvailability.mockResolvedValue({ status: 'available' });
			let finish!: (value: unknown) => void;
			memoryApi.generateCommand.mockImplementation(
				() =>
					new Promise((resolve) => {
						finish = resolve;
					})
			);
			renderCodex();
			await screen.findByTestId('memory-preview');
			fireEvent.click(screen.getByRole('button', { name: 'Prepare command draft' }));
			const button = screen.getByRole('button', { name: 'Generate command' });
			await waitFor(() => expect(button).not.toBeDisabled());
			fireEvent.click(button);
			const oldViewer = memoryApi.generateCommand.mock.calls[0][0];
			fireEvent.click(screen.getByRole('button', { name: 'Discard command draft' }));
			fireEvent.click(screen.getByRole('button', { name: 'Prepare command draft' }));
			fireEvent.click(screen.getByRole('button', { name: 'Generate command' }));
			await act(async () => {
				draftListener?.({
					viewerId: oldViewer,
					requestId: 'late',
					draft: { command: 'late', description: 'late', prompt: 'late' },
				});
			});
			expect(screen.queryByText(/Validated command draft:/)).toBeNull();
			await act(async () => {
				finish({ requestId: 'host-id', status: 'error' });
			});
			await screen.findByText('Command draft failed');
		});
		it('shows permission denial as an actionable disabled generation state', async () => {
			memoryApi.commandAvailability.mockResolvedValue({ status: 'permission-denied' });
			renderCodex();
			await screen.findByTestId('memory-preview');
			await screen.findByText(
				'Memory command plugin needs trusted signing and generator permissions'
			);
			fireEvent.click(screen.getByRole('button', { name: 'Prepare command draft' }));
			expect(screen.getByRole('button', { name: 'Generate command' })).toBeDisabled();
			expect(memoryApi.generateCommand).not.toHaveBeenCalled();
		});
		it('shows native source identity and retains current RC memory controls', async () => {
			const { ref } = renderCodex();
			await screen.findByTestId('memory-preview');
			expect(listRowNames()).toEqual(files.map((f) => f.name));
			expect(memoryApi.list).toHaveBeenCalledWith(
				expect.objectContaining({ agentId: session.id, toolType: 'codex' })
			);
			expect(memoryApi.read).toHaveBeenCalledWith(
				expect.objectContaining({ agentId: session.id, toolType: 'codex' }),
				'memory_summary.md'
			);
			expect(screen.getByText(/Source agent: codex-source/)).toHaveTextContent(
				sourceRef.memoryRoot
			);
			expect(screen.getByText('New Memory')).toBeInTheDocument();
			expect(screen.getByText('Save')).toBeInTheDocument();
			expect(screen.queryByText('Delete')).toBeNull();
			expect(screen.getByTestId('memory-open-graph')).toBeInTheDocument();
			expect(screen.getByLabelText('Filter memories by name or content')).toBeInTheDocument();
			expect(ref.current!.getSnapshot()).toEqual({
				sourceRef: { ...sourceRef, relativePath: 'memory_summary.md' },
				textSnapshot: files[0].body,
				dirty: false,
			});
		});
		it('reads a nested source and retains the RC delete confirmation', async () => {
			const { ref } = renderCodex();
			await screen.findByTestId('memory-preview');
			fireEvent.click(document.querySelector('[data-item-id="rollout_summaries/example.md"]')!);
			await waitFor(() =>
				expect(ref.current!.getSnapshot().sourceRef.relativePath).toBe(
					'rollout_summaries/example.md'
				)
			);
			fireEvent.keyDown(document.querySelector('[data-item-id="rollout_summaries/example.md"]')!, {
				key: 'Backspace',
			});
			expect(mockOpenModal).toHaveBeenCalledWith('confirm', expect.anything());
		});
		it('captures the current local draft and UTF-16 selection without writing the source', async () => {
			const original = files.map((f) => ({ ...f }));
			const { ref } = renderCodex();
			await screen.findByTestId('memory-preview');
			fireEvent.click(screen.getByTestId('memory-view-mode-edit'));
			const area = document.querySelector('textarea') as HTMLTextAreaElement;
			fireEvent.change(area, { target: { value: 'Draft 😀 example' } });
			area.setSelectionRange(6, 8);
			expect(ref.current!.getSnapshot()).toMatchObject({
				textSnapshot: 'Draft 😀 example',
				dirty: true,
				selection: { start: 6, end: 8 },
			});
			fireEvent.click(screen.getByTestId('memory-view-mode-preview'));
			expect(ref.current!.getSnapshot()).toMatchObject({
				textSnapshot: 'Draft 😀 example',
				dirty: true,
			});
			expect(ref.current!.getSnapshot().selection).toBeUndefined();
			expect(files).toEqual(original);
		});
		it('maps a selection in CRLF source to the original snapshot', async () => {
			files[0].body = 'a\r\nb';
			const { ref } = renderCodex();
			await screen.findByTestId('memory-preview');
			fireEvent.click(screen.getByTestId('memory-view-mode-edit'));
			const area = document.querySelector('textarea') as HTMLTextAreaElement;
			area.setSelectionRange(2, 3);
			const snapshot = ref.current!.getSnapshot();
			expect(snapshot.textSnapshot).toBe('a\r\nb');
			expect(snapshot.selection).toEqual({ start: 3, end: 4 });
			expect(snapshot.textSnapshot.slice(snapshot.selection!.start, snapshot.selection!.end)).toBe(
				'b'
			);
		});
		it.each([false, true])(
			'distinguishes missing and empty memory roots (exists=%s)',
			async (exists) => {
				memoryApi.list.mockResolvedValueOnce({
					success: true,
					sourceRef,
					exists,
					layout: CODEX_LAYOUT,
					entries: [],
				});
				const { ref } = renderCodex();
				await screen.findByText('Codex has not written any memories on this account yet.');
				expect(memoryApi.read).not.toHaveBeenCalled();
				expect(() => ref.current!.getSnapshot()).toThrow('No loaded Codex memory source');
				expect(screen.getByText('Create first memory')).toBeInTheDocument();
			}
		);
		it.each(['response', 'rejection'])(
			'reports list failure (%s) without fallback',
			async (kind) => {
				if (kind === 'response')
					memoryApi.list.mockResolvedValueOnce({
						success: false,
						error: 'Synthetic access denied',
					});
				else memoryApi.list.mockRejectedValueOnce(new Error('Synthetic access denied'));
				const { ref } = renderCodex();
				await screen.findByText(/Synthetic access denied/);
				expect(() => ref.current!.getSnapshot()).toThrow();
			}
		);
		it('rejects a read with the wrong source identity', async () => {
			memoryApi.read.mockResolvedValueOnce({
				success: true,
				content: 'wrong source',
				sourceRef: { ...sourceRef, sourceAgentId: 'other', relativePath: 'memory_summary.md' },
			});
			const { ref } = renderCodex();
			await screen.findByText(/source identity mismatch/);
			expect(() => ref.current!.getSnapshot()).toThrow();
			expect(screen.queryByText('wrong source')).toBeNull();
		});
		it('clears the previous snapshot when another file fails to read', async () => {
			const { ref } = renderCodex();
			await screen.findByTestId('memory-preview');
			memoryApi.read.mockResolvedValueOnce({
				success: false,
				error: 'Synthetic read failed',
			});
			fireEvent.click(document.querySelector('[data-item-id="rollout_summaries/example.md"]')!);
			await screen.findByText(/Synthetic read failed/);
			expect(() => ref.current!.getSnapshot()).toThrow();
		});
		it('discards a late read when another file was selected', async () => {
			const { ref } = renderCodex();
			await screen.findByTestId('memory-preview');
			let finish!: (value: Awaited<ReturnType<typeof memoryApi.read>>) => void;
			memoryApi.read.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						finish = resolve;
					})
			);
			fireEvent.click(document.querySelector('[data-item-id="rollout_summaries/example.md"]')!);
			expect(() => ref.current!.getSnapshot()).toThrow();
			fireEvent.click(document.querySelector('[data-item-id="memory_summary.md"]')!);
			await waitFor(() =>
				expect(ref.current!.getSnapshot().sourceRef.relativePath).toBe('memory_summary.md')
			);
			await act(async () =>
				finish({
					success: true,
					sourceRef: { ...sourceRef, relativePath: 'rollout_summaries/example.md' },
					content: 'late',
				})
			);
			expect(ref.current!.getSnapshot().textSnapshot).toBe(files[0].body);
		});
		it('isolates pending reads across source agent changes', async () => {
			let finish!: (value: Awaited<ReturnType<typeof memoryApi.read>>) => void;
			memoryApi.read.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						finish = resolve;
					})
			);
			const { ref, rerender } = renderCodex();
			await waitFor(() => expect(memoryApi.read).toHaveBeenCalledTimes(1));
			rerender(
				<MemoryViewer
					ref={ref}
					theme={mockTheme}
					activeSession={{ ...session, id: 'other-source' }}
					onClose={vi.fn()}
				/>
			);
			await waitFor(() =>
				expect(ref.current!.getSnapshot().sourceRef.sourceAgentId).toBe('other-source')
			);
			await act(async () =>
				finish({
					success: true,
					sourceRef: { ...sourceRef, relativePath: 'memory_summary.md' },
					content: 'old agent',
				})
			);
			expect(ref.current!.getSnapshot().sourceRef.sourceAgentId).toBe('other-source');
			expect(ref.current!.getSnapshot().textSnapshot).toBe(files[0].body);
		});
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
		await waitFor(() => expect(memoryApi.read).toHaveBeenCalledWith(CLAUDE_TARGET, 'MEMORY.md'));

		await typeFilter('Worktrees');

		await waitFor(() =>
			expect(memoryApi.read).toHaveBeenCalledWith(CLAUDE_TARGET, 'project_worktrees.md')
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
			expect(memoryApi.read).toHaveBeenCalledWith(CLAUDE_TARGET, 'project_worktrees.md')
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

	it('toggles the unlinked filter on Cmd+U', async () => {
		memoryApi.orphans.mockResolvedValueOnce({
			success: true,
			orphans: ['user_role.md'],
			brokenLinks: [],
		});
		renderViewer();
		await screen.findByTestId('memory-orphan-filter');

		const { fireEvent, act } = await import('@testing-library/react');
		await act(async () => {
			fireEvent.keyDown(window, { key: 'u', metaKey: true });
		});
		await waitFor(() => expect(listRowNames()).toEqual(['user_role.md']));

		// Untoggles too - a one-way key would strand the user in a filtered list.
		await act(async () => {
			fireEvent.keyDown(window, { key: 'u', metaKey: true });
		});
		await waitFor(() => expect(listRowNames()).toHaveLength(3));
	});

	it('ignores Cmd+U when nothing is unlinked', async () => {
		// The chip that explains and undoes the state is not rendered, so a
		// filter applied here could not be seen or reversed.
		renderViewer();
		await waitFor(() => expect(listRowNames()).toHaveLength(3));

		const { fireEvent, act } = await import('@testing-library/react');
		await act(async () => {
			fireEvent.keyDown(window, { key: 'u', metaKey: true });
		});

		expect(listRowNames()).toHaveLength(3);
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
			returnTo: 'memoryViewer',
		});
		// Both are full-window views on the same agent, so the viewer must not
		// stay mounted behind the graph.
		expect(onClose).toHaveBeenCalled();
	});

	it('tells the graph to come back here, making the trip round-trip', async () => {
		// Without `returnTo`, Escape out of that graph drops the user on an
		// empty workspace and the only way back is the brain icon.
		renderViewer();
		const { fireEvent, act } = await import('@testing-library/react');
		await act(async () => {
			fireEvent.click(await screen.findByTestId('memory-open-graph'));
		});

		expect(mockOpenGraphScope).toHaveBeenCalledWith(
			expect.objectContaining({ returnTo: 'memoryViewer' })
		);
	});

	it('opens the graph on Cmd+G', async () => {
		renderViewer();
		await waitFor(() => expect(listRowNames()).toHaveLength(3));

		const { fireEvent, act } = await import('@testing-library/react');
		await act(async () => {
			fireEvent.keyDown(window, { key: 'g', metaKey: true });
		});

		expect(mockOpenGraphScope).toHaveBeenCalled();
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
		expect(memoryApi.read).toHaveBeenCalledWith(CLAUDE_TARGET, 'user_role.md');
	});

	it('falls back to the previous memory when the last one is deleted', async () => {
		renderViewer();
		await waitFor(() => expect(listRowNames()).toHaveLength(3));

		await fireDelete('user_role.md');
		await confirmLastModal();

		await waitFor(() => expect(listRowNames()).toEqual(['MEMORY.md', 'project_worktrees.md']));
		expect(memoryApi.read).toHaveBeenCalledWith(CLAUDE_TARGET, 'project_worktrees.md');
	});

	it('refuses to delete the MEMORY.md index', async () => {
		renderViewer();
		await waitFor(() => expect(listRowNames()).toHaveLength(3));

		await fireDelete('MEMORY.md');

		expect(mockOpenModal).not.toHaveBeenCalled();
		expect(await screen.findByText(/MEMORY.md is managed by the agent/)).toBeInTheDocument();
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

	it("addresses every call to the agent's own account, not just its provider", async () => {
		// The agent id is what lets main resolve CLAUDE_CONFIG_DIR / CODEX_HOME;
		// without it a second-account agent is shown the default account's store.
		renderViewer();
		await waitFor(() => expect(listRowNames()).toHaveLength(3));
		expect(memoryApi.list).toHaveBeenCalledWith({
			projectPath: '/test/project',
			toolType: 'claude-code',
			agentId: 'session-1',
		});
	});

	describe('Codex (account-wide, nested store)', () => {
		const rollouts = Array.from({ length: 25 }, (_, i) => ({
			name: `rollout_summaries/2026-10-${String(i + 1).padStart(2, '0')}-run.md`,
			body: `Rollout ${i + 1}`,
		}));

		beforeEach(() => {
			layout = CODEX_LAYOUT;
			protectedNames = new Set(['MEMORY.md', 'memory_summary.md']);
			files = [
				{ name: 'MEMORY.md', body: '# Task Group: widgets' },
				{ name: 'memory_summary.md', body: '## User Profile' },
				{ name: 'extensions/ad_hoc/notes/prefers-tabs.md', body: 'Prefers tabs.' },
				{ name: 'skills/release/SKILL.md', body: 'Release steps.' },
				...rollouts,
			];
		});

		const renderCodex = () => renderViewer(vi.fn(), { toolType: 'codex' });

		it('says the store is shared by every project rather than naming one', async () => {
			renderCodex();
			expect(
				await screen.findByText(/Memories \(shared by every project on this account\)/)
			).toBeInTheDocument();
		});

		it('groups entries by directory, core first, then the user notes', async () => {
			renderCodex();
			await waitFor(() => expect(listRowNames()).toContain('skills/release/SKILL.md'));
			const headers = Array.from(document.querySelectorAll('.dual-pane-category-header')).map(
				(el) => el.textContent ?? ''
			);
			expect(headers[0]).toContain('Core');
			expect(headers[1]).toContain('Your notes');
			// Rows drop the prefix their group header already states.
			expect(screen.getByText('prefers-tabs.md')).toBeInTheDocument();
		});

		it('starts a large generated group collapsed so it does not bury the rest', async () => {
			renderCodex();
			await waitFor(() => expect(listRowNames()).toContain('skills/release/SKILL.md'));
			expect(listRowNames().some((n) => n.startsWith('rollout_summaries/'))).toBe(false);
		});

		it('expands every group while a filter is active', async () => {
			renderCodex();
			await waitFor(() => expect(listRowNames()).toContain('skills/release/SKILL.md'));
			await typeFilter('Rollout 3');
			await waitFor(() => expect(listRowNames()).toContain('rollout_summaries/2026-10-03-run.md'));
		});

		it('creates a new memory as an ad-hoc note Codex folds in', async () => {
			renderCodex();
			await waitFor(() => expect(listRowNames()).toContain('skills/release/SKILL.md'));

			const { fireEvent, act } = await import('@testing-library/react');
			await act(async () => {
				fireEvent.click(screen.getByTitle('Create a new memory file'));
			});
			const input = await screen.findByDisplayValue('new-note.md');
			await act(async () => {
				fireEvent.keyDown(input, { key: 'Enter' });
			});

			await waitFor(() =>
				expect(memoryApi.create).toHaveBeenCalledWith(
					expect.objectContaining({ toolType: 'codex' }),
					'extensions/ad_hoc/notes/new-note.md',
					expect.stringContaining('# Note title')
				)
			);
		});

		it('refuses to delete a file Codex regenerates', async () => {
			renderCodex();
			await waitFor(() => expect(listRowNames()).toContain('memory_summary.md'));

			await fireDelete('memory_summary.md');

			expect(mockOpenModal).not.toHaveBeenCalled();
			expect(
				await screen.findByText(/memory_summary.md is managed by the agent/)
			).toBeInTheDocument();
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
