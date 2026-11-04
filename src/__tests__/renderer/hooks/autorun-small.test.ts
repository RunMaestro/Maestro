// Consolidated from current rc sources; per-source hooks and state stay in an unnamed suite.
// Source: src/__tests__/renderer/hooks/useAutoRunAutoFollow.test.ts
// Source: src/__tests__/renderer/hooks/useAutoRunKeyboard.test.ts
// Source: src/__tests__/renderer/hooks/useAutoRunScrollSync.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook as s1_renderHook, act as s1_act } from '@testing-library/react';
import { useAutoRunAutoFollow } from '../../../renderer/hooks/batch/useAutoRunAutoFollow';
import type { UseAutoRunAutoFollowDeps } from '../../../renderer/hooks/batch/useAutoRunAutoFollow';
import type { BatchRunState } from '../../../renderer/types';
import { useUIStore } from '../../../renderer/stores/uiStore';
import { renderHook as s2_renderHook } from '@testing-library/react';
import { useAutoRunKeyboard } from '../../../renderer/hooks/batch/useAutoRunKeyboard';
import type { MarkdownEditorHandle } from '../../../renderer/components/FilePreview/markdownEditor';
import { renderHook as s3_renderHook, act as s3_act } from '@testing-library/react';
import {
	useAutoRunScrollSync,
	type UseAutoRunScrollSyncParams,
} from '../../../renderer/hooks/batch/useAutoRunScrollSync';
// Source: src/__tests__/renderer/hooks/useAutoRunAutoFollow.test.ts
describe('', () => {
	function createBatchState(overrides: Partial<BatchRunState> = {}): BatchRunState {
		return {
			isRunning: false,
			isStopping: false,
			documents: [],
			lockedDocuments: [],
			currentDocumentIndex: 0,
			currentDocTasksTotal: 0,
			currentDocTasksCompleted: 0,
			totalTasksAcrossAllDocs: 0,
			completedTasksAcrossAllDocs: 0,
			loopEnabled: false,
			loopIteration: 0,
			folderPath: '/tmp',
			worktreeActive: false,
			totalTasks: 0,
			completedTasks: 0,
			currentTaskIndex: 0,
			originalContent: '',
			sessionIds: [],
			...overrides,
		};
	}
	function createDeps(overrides: Partial<UseAutoRunAutoFollowDeps> = {}): UseAutoRunAutoFollowDeps {
		return {
			currentSessionBatchState: null,
			onAutoRunSelectDocument: vi.fn(),
			selectedFile: null,
			setActiveRightTab: vi.fn(),
			rightPanelOpen: true,
			setRightPanelOpen: vi.fn(),
			onAutoRunModeChange: vi.fn(),
			currentMode: 'preview',
			...overrides,
		};
	}
	describe('useAutoRunAutoFollow', () => {
		beforeEach(() => {
			// Reset the zustand store between tests
			useUIStore.setState({ autoFollowEnabled: false });
		});
		it('should not auto-select when autoFollowEnabled is false', () => {
			const onAutoRunSelectDocument = vi.fn();
			const deps = createDeps({
				onAutoRunSelectDocument,
				currentSessionBatchState: createBatchState({
					isRunning: true,
					documents: ['doc-a', 'doc-b'],
					currentDocumentIndex: 0,
				}),
			});
			s1_renderHook(() => useAutoRunAutoFollow(deps));
			expect(onAutoRunSelectDocument).not.toHaveBeenCalled();
		});
		it('should auto-select document when batch starts and autoFollow is enabled', () => {
			const onAutoRunSelectDocument = vi.fn();
			const deps = createDeps({
				onAutoRunSelectDocument,
				currentSessionBatchState: null,
			});
			const { result, rerender } = s1_renderHook(
				(props: UseAutoRunAutoFollowDeps) => useAutoRunAutoFollow(props),
				{ initialProps: deps }
			);
			// Enable auto-follow
			s1_act(() => {
				result.current.setAutoFollowEnabled(true);
			});
			// Simulate batch start
			const runningDeps = createDeps({
				onAutoRunSelectDocument,
				currentSessionBatchState: createBatchState({
					isRunning: true,
					documents: ['doc-a', 'doc-b'],
					currentDocumentIndex: 0,
				}),
			});
			rerender(runningDeps);
			expect(onAutoRunSelectDocument).toHaveBeenCalledWith('doc-a');
		});
		it('should auto-select next document on index change', () => {
			const onAutoRunSelectDocument = vi.fn();
			const initialDeps = createDeps({
				onAutoRunSelectDocument,
				currentSessionBatchState: createBatchState({
					isRunning: true,
					documents: ['doc-a', 'doc-b'],
					currentDocumentIndex: 0,
				}),
			});
			const { result, rerender } = s1_renderHook(
				(props: UseAutoRunAutoFollowDeps) => useAutoRunAutoFollow(props),
				{ initialProps: initialDeps }
			);
			// Enable auto-follow
			s1_act(() => {
				result.current.setAutoFollowEnabled(true);
			});
			// Move to next document
			const nextDeps = createDeps({
				onAutoRunSelectDocument,
				currentSessionBatchState: createBatchState({
					isRunning: true,
					documents: ['doc-a', 'doc-b'],
					currentDocumentIndex: 1,
				}),
			});
			rerender(nextDeps);
			expect(onAutoRunSelectDocument).toHaveBeenCalledWith('doc-b');
		});
		it('should not auto-select if already on correct document', () => {
			const onAutoRunSelectDocument = vi.fn();
			const deps = createDeps({
				onAutoRunSelectDocument,
				selectedFile: 'doc-a',
				currentSessionBatchState: null,
			});
			const { result, rerender } = s1_renderHook(
				(props: UseAutoRunAutoFollowDeps) => useAutoRunAutoFollow(props),
				{ initialProps: deps }
			);
			// Enable auto-follow
			s1_act(() => {
				result.current.setAutoFollowEnabled(true);
			});
			// Start batch with doc-a at index 0, but selectedFile is already doc-a
			const runningDeps = createDeps({
				onAutoRunSelectDocument,
				selectedFile: 'doc-a',
				currentSessionBatchState: createBatchState({
					isRunning: true,
					documents: ['doc-a', 'doc-b'],
					currentDocumentIndex: 0,
				}),
			});
			rerender(runningDeps);
			expect(onAutoRunSelectDocument).not.toHaveBeenCalled();
		});
		it('should switch to autorun tab on batch start when autoFollow enabled', () => {
			const setActiveRightTab = vi.fn();
			const deps = createDeps({
				setActiveRightTab,
				currentSessionBatchState: createBatchState({ isRunning: false }),
			});
			const { result, rerender } = s1_renderHook(
				(props: UseAutoRunAutoFollowDeps) => useAutoRunAutoFollow(props),
				{ initialProps: deps }
			);
			// Enable auto-follow
			s1_act(() => {
				result.current.setAutoFollowEnabled(true);
			});
			// Transition to running
			const runningDeps = createDeps({
				setActiveRightTab,
				currentSessionBatchState: createBatchState({
					isRunning: true,
					documents: ['doc-a'],
					currentDocumentIndex: 0,
				}),
			});
			rerender(runningDeps);
			expect(setActiveRightTab).toHaveBeenCalledWith('autorun');
		});
		it('should not switch tab when autoFollow is disabled', () => {
			const setActiveRightTab = vi.fn();
			const deps = createDeps({
				setActiveRightTab,
				currentSessionBatchState: createBatchState({ isRunning: false }),
			});
			const { rerender } = s1_renderHook(
				(props: UseAutoRunAutoFollowDeps) => useAutoRunAutoFollow(props),
				{ initialProps: deps }
			);
			// Leave auto-follow off, transition to running
			const runningDeps = createDeps({
				setActiveRightTab,
				currentSessionBatchState: createBatchState({
					isRunning: true,
					documents: ['doc-a'],
					currentDocumentIndex: 0,
				}),
			});
			rerender(runningDeps);
			expect(setActiveRightTab).not.toHaveBeenCalled();
		});
		it('should open right panel on batch start when closed and autoFollow enabled', () => {
			const setRightPanelOpen = vi.fn();
			const deps = createDeps({
				rightPanelOpen: false,
				setRightPanelOpen,
				currentSessionBatchState: createBatchState({ isRunning: false }),
			});
			const { result, rerender } = s1_renderHook(
				(props: UseAutoRunAutoFollowDeps) => useAutoRunAutoFollow(props),
				{ initialProps: deps }
			);
			// Enable auto-follow
			s1_act(() => {
				result.current.setAutoFollowEnabled(true);
			});
			// Transition to running with panel closed
			const runningDeps = createDeps({
				rightPanelOpen: false,
				setRightPanelOpen,
				currentSessionBatchState: createBatchState({
					isRunning: true,
					documents: ['doc-a'],
					currentDocumentIndex: 0,
				}),
			});
			rerender(runningDeps);
			expect(setRightPanelOpen).toHaveBeenCalledWith(true);
		});
		it('should immediately jump to active document when enabling during a running batch', () => {
			const onAutoRunSelectDocument = vi.fn();
			const setActiveRightTab = vi.fn();
			const setRightPanelOpen = vi.fn();
			const deps = createDeps({
				onAutoRunSelectDocument,
				setActiveRightTab,
				rightPanelOpen: false,
				setRightPanelOpen,
				currentMode: 'edit',
				currentSessionBatchState: createBatchState({
					isRunning: true,
					documents: ['doc-a', 'doc-b'],
					currentDocumentIndex: 1,
				}),
			});
			const { result } = s1_renderHook(
				(props: UseAutoRunAutoFollowDeps) => useAutoRunAutoFollow(props),
				{ initialProps: deps }
			);
			s1_act(() => {
				result.current.setAutoFollowEnabled(true);
			});
			expect(onAutoRunSelectDocument).toHaveBeenCalledWith('doc-b');
			expect(setActiveRightTab).toHaveBeenCalledWith('autorun');
			expect(setRightPanelOpen).toHaveBeenCalledWith(true);
		});
		it('should reset refs when batch ends', () => {
			const onAutoRunSelectDocument = vi.fn();
			const deps = createDeps({
				onAutoRunSelectDocument,
				currentSessionBatchState: createBatchState({
					isRunning: true,
					documents: ['doc-a', 'doc-b', 'doc-c'],
					currentDocumentIndex: 0,
				}),
			});
			const { result, rerender } = s1_renderHook(
				(props: UseAutoRunAutoFollowDeps) => useAutoRunAutoFollow(props),
				{ initialProps: deps }
			);
			// Enable auto-follow
			s1_act(() => {
				result.current.setAutoFollowEnabled(true);
			});
			// Advance to index 2
			rerender(
				createDeps({
					onAutoRunSelectDocument,
					currentSessionBatchState: createBatchState({
						isRunning: true,
						documents: ['doc-a', 'doc-b', 'doc-c'],
						currentDocumentIndex: 2,
					}),
				})
			);
			expect(onAutoRunSelectDocument).toHaveBeenCalledWith('doc-c');
			onAutoRunSelectDocument.mockClear();
			// End batch
			rerender(
				createDeps({
					onAutoRunSelectDocument,
					currentSessionBatchState: createBatchState({
						isRunning: false,
						documents: [],
						currentDocumentIndex: 0,
					}),
				})
			);
			onAutoRunSelectDocument.mockClear();
			// Start new batch from index 0 - should auto-select again
			rerender(
				createDeps({
					onAutoRunSelectDocument,
					currentSessionBatchState: createBatchState({
						isRunning: true,
						documents: ['doc-x', 'doc-y'],
						currentDocumentIndex: 0,
					}),
				})
			);
			expect(onAutoRunSelectDocument).toHaveBeenCalledWith('doc-x');
		});
	});
});
// Source: src/__tests__/renderer/hooks/useAutoRunKeyboard.test.ts
describe('', () => {
	/**
	 * A stand-in for the editor handle that tracks what the host saw at dispatch
	 * time. `snapshotAtDispatch` is the whole point of the undo assertions: reading
	 * the ref after the fact cannot tell a stamp-before from a stamp-after.
	 */
	const createEditor = (caret = 0, selectionEnd = caret) => {
		const editor = {
			getCaret: vi.fn(() => caret),
			getSelectionRange: vi.fn(() => ({ from: caret, to: selectionEnd })),
			replaceRange: vi.fn(),
			setSelection: vi.fn(),
			focus: vi.fn(),
		};
		return editor;
	};
	const setup = (
		overrides: {
			localContent?: string;
			caret?: number;
			selectionEnd?: number;
			isDirty?: boolean;
			isLocked?: boolean;
			autocompleteClaims?: boolean;
		} = {}
	) => {
		const {
			localContent = '',
			caret = 0,
			selectionEnd = caret,
			isDirty = false,
			isLocked = false,
			autocompleteClaims = false,
		} = overrides;
		const editor = createEditor(caret, selectionEnd);
		const lastUndoSnapshotRef = { current: '__unstamped__' };
		let observed: string | undefined;
		editor.replaceRange.mockImplementation(() => {
			observed = lastUndoSnapshotRef.current;
		});
		const harness = {
			editor,
			lastUndoSnapshotRef,
			pushUndoState: vi.fn((_content?: string, _cursor?: number) => {}),
			handleUndo: vi.fn(() => {}),
			handleRedo: vi.fn(() => {}),
			handleSave: vi.fn(() => Promise.resolve()),
			toggleMode: vi.fn(() => {}),
			openSearch: vi.fn(() => {}),
			handleAutocompleteKeyDown: vi.fn((_event: KeyboardEvent) => autocompleteClaims),
			/** Ref value observed at the moment `replaceRange` was dispatched. */
			snapshotAtDispatch: () => observed,
		};
		const { result } = s2_renderHook(() =>
			useAutoRunKeyboard({
				localContent,
				editorRef: {
					current: editor as unknown as MarkdownEditorHandle,
				},
				pushUndoState: harness.pushUndoState,
				lastUndoSnapshotRef: harness.lastUndoSnapshotRef,
				handleUndo: harness.handleUndo,
				handleRedo: harness.handleRedo,
				isDirty,
				handleSave: harness.handleSave,
				isLocked,
				toggleMode: harness.toggleMode,
				openSearch: harness.openSearch,
				handleAutocompleteKeyDown: harness.handleAutocompleteKeyDown,
			})
		);
		return { handleKeyDown: result.current, ...harness };
	};
	const keyEvent = (key: string, init: Partial<KeyboardEventInit> = {}) => {
		const event = new KeyboardEvent('keydown', { key, cancelable: true, ...init });
		vi.spyOn(event, 'preventDefault');
		vi.spyOn(event, 'stopPropagation');
		return event;
	};
	beforeEach(() => {
		vi.clearAllMocks();
	});
	describe('useAutoRunKeyboard - who gets the key', () => {
		it('leaves an ordinary character to CodeMirror', () => {
			const { handleKeyDown } = setup();
			const event = keyEvent('a');
			// Returning false is what lets the editor insert the character at all.
			expect(handleKeyDown(event)).toBe(false);
			expect(event.preventDefault).not.toHaveBeenCalled();
		});
		it('lets the autocomplete popup claim a key before anything else', () => {
			const { handleKeyDown, editor, toggleMode } = setup({ autocompleteClaims: true });
			// Cmd+E would otherwise flip to preview and close the popup underneath it.
			expect(handleKeyDown(keyEvent('e', { metaKey: true }))).toBe(true);
			expect(toggleMode).not.toHaveBeenCalled();
			expect(editor.replaceRange).not.toHaveBeenCalled();
		});
		it('normalizes a shifted letter so Cmd+Shift+Z still reads as z', () => {
			const { handleKeyDown, handleRedo, handleUndo } = setup();
			// A shifted `z` arrives as `Z`; matching on the raw key would miss redo.
			expect(handleKeyDown(keyEvent('Z', { metaKey: true, shiftKey: true }))).toBe(true);
			expect(handleRedo).toHaveBeenCalledTimes(1);
			expect(handleUndo).not.toHaveBeenCalled();
		});
	});
	describe('useAutoRunKeyboard - Tab', () => {
		it('inserts a real tab character through the editor', () => {
			const { handleKeyDown, editor } = setup({ localContent: 'abcd', caret: 2 });
			const event = keyEvent('Tab');
			expect(handleKeyDown(event)).toBe(true);
			expect(event.preventDefault).toHaveBeenCalled();
			// A literal tab, not CodeMirror's indent unit - Auto Run documents are
			// hand-written Markdown and tabs are what the rest of the codebase writes.
			expect(editor.replaceRange).toHaveBeenCalledWith(2, 2, '\t');
			expect(editor.setSelection).toHaveBeenCalledWith(3, 3);
		});
		it('replaces the selected range rather than inserting beside it', () => {
			const { handleKeyDown, editor } = setup({ localContent: 'abcd', caret: 1, selectionEnd: 3 });
			handleKeyDown(keyEvent('Tab'));
			expect(editor.replaceRange).toHaveBeenCalledWith(1, 3, '\t');
			expect(editor.setSelection).toHaveBeenCalledWith(2, 2);
		});
		it('stamps the undo snapshot with the post-edit content BEFORE dispatching', () => {
			const h = setup({ localContent: 'abcd', caret: 2 });
			h.handleKeyDown(keyEvent('Tab'));
			expect(h.pushUndoState).toHaveBeenCalledTimes(1);
			// Stamped before the dispatch, so the onChange this dispatch triggers
			// recognizes the content as an edit that already has its undo entry.
			// Stamping afterwards would leave the ref stale for exactly that call and
			// record a second entry, so Cmd+Z would undo one tab in two presses.
			expect(h.snapshotAtDispatch()).toBe('ab\tcd');
			expect(h.lastUndoSnapshotRef.current).toBe('ab\tcd');
		});
	});
	describe('useAutoRunKeyboard - checkbox insert (Cmd+L)', () => {
		it('inserts the checkbox in place at the start of a line', () => {
			const h = setup({ localContent: 'one\n', caret: 4 });
			const event = keyEvent('l', { metaKey: true });
			expect(h.handleKeyDown(event)).toBe(true);
			expect(event.stopPropagation).toHaveBeenCalled();
			expect(h.editor.replaceRange).toHaveBeenCalledWith(4, 4, '- [ ] ');
			expect(h.editor.setSelection).toHaveBeenCalledWith(10, 10);
		});
		it('breaks the line first when the caret sits mid-line', () => {
			const h = setup({ localContent: 'one', caret: 3 });
			h.handleKeyDown(keyEvent('l', { metaKey: true }));
			// Without the leading newline the checkbox would be glued to the prose and
			// would not parse as a task, so the run would not see it.
			expect(h.editor.replaceRange).toHaveBeenCalledWith(3, 3, '\n- [ ] ');
			expect(h.snapshotAtDispatch()).toBe('one\n- [ ] ');
		});
	});
	describe('useAutoRunKeyboard - Enter list continuation', () => {
		const cases: Array<{
			name: string;
			content: string;
			insert: string;
		}> = [
			{ name: 'task list', content: '- [ ] first', insert: '\n- [ ] ' },
			{ name: 'checked task list', content: '- [x] first', insert: '\n- [ ] ' },
			{ name: 'indented task list', content: '\t- [ ] first', insert: '\n\t- [ ] ' },
			{ name: 'dash list', content: '- first', insert: '\n- ' },
			{ name: 'star list', content: '* first', insert: '\n* ' },
			{ name: 'ordered list', content: '3. first', insert: '\n4. ' },
		];
		for (const { name, content, insert } of cases) {
			it(`continues a ${name}`, () => {
				const h = setup({ localContent: content, caret: content.length });
				const event = keyEvent('Enter');
				expect(h.handleKeyDown(event)).toBe(true);
				expect(event.preventDefault).toHaveBeenCalled();
				expect(h.editor.replaceRange).toHaveBeenCalledWith(content.length, content.length, insert);
				expect(h.snapshotAtDispatch()).toBe(content + insert);
			});
		}
		it('continues a checked task with an UNCHECKED box', () => {
			const content = '- [x] done';
			const h = setup({ localContent: content, caret: content.length });
			h.handleKeyDown(keyEvent('Enter'));
			// Inheriting the [x] would silently mark the next task complete before it
			// was written, and an Auto Run skips completed tasks.
			expect(h.editor.replaceRange).toHaveBeenCalledWith(
				content.length,
				content.length,
				'\n- [ ] '
			);
		});
		it('leaves a plain paragraph Enter to CodeMirror', () => {
			const h = setup({ localContent: 'just prose', caret: 10 });
			const event = keyEvent('Enter');
			// Claiming this would mean re-implementing newline insertion, and the
			// editor already does it (with its own history entry).
			expect(h.handleKeyDown(event)).toBe(false);
			expect(event.preventDefault).not.toHaveBeenCalled();
			expect(h.editor.replaceRange).not.toHaveBeenCalled();
		});
		it('leaves Shift+Enter to CodeMirror even inside a list', () => {
			const h = setup({ localContent: '- first', caret: 7 });
			const event = keyEvent('Enter', { shiftKey: true });
			expect(h.handleKeyDown(event)).toBe(false);
			expect(h.editor.replaceRange).not.toHaveBeenCalled();
		});
	});
	describe('useAutoRunKeyboard - commands', () => {
		it('saves on Cmd+S only when the document is dirty', () => {
			const clean = setup({ isDirty: false });
			expect(clean.handleKeyDown(keyEvent('s', { metaKey: true }))).toBe(true);
			expect(clean.handleSave).not.toHaveBeenCalled();
			const dirty = setup({ isDirty: true });
			expect(dirty.handleKeyDown(keyEvent('s', { metaKey: true }))).toBe(true);
			expect(dirty.handleSave).toHaveBeenCalledTimes(1);
		});
		it('swallows Cmd+E but does not flip modes while the document is locked', () => {
			const h = setup({ isLocked: true });
			// Swallowed either way so the key never reaches the editor; the lock only
			// decides whether the flip happens, matching the disabled toggle button.
			expect(h.handleKeyDown(keyEvent('e', { metaKey: true }))).toBe(true);
			expect(h.toggleMode).not.toHaveBeenCalled();
		});
		it('leaves Cmd+Shift+E to the global handler', () => {
			const h = setup();
			// That chord is "Edit Last Queued Message" at the app level.
			expect(h.handleKeyDown(keyEvent('e', { metaKey: true, shiftKey: true }))).toBe(false);
			expect(h.toggleMode).not.toHaveBeenCalled();
		});
		it('opens search on Cmd+F and leaves Cmd+Shift+F to the global handler', () => {
			const find = setup();
			expect(find.handleKeyDown(keyEvent('f', { metaKey: true }))).toBe(true);
			expect(find.openSearch).toHaveBeenCalledTimes(1);
			const goToFiles = setup();
			expect(goToFiles.handleKeyDown(keyEvent('f', { metaKey: true, shiftKey: true }))).toBe(false);
			expect(goToFiles.openSearch).not.toHaveBeenCalled();
		});
		it('routes undo and redo to the host history, not CodeMirror history', () => {
			const undo = setup();
			expect(undo.handleKeyDown(keyEvent('z', { metaKey: true }))).toBe(true);
			expect(undo.handleUndo).toHaveBeenCalledTimes(1);
			const redo = setup();
			expect(redo.handleKeyDown(keyEvent('z', { metaKey: true, shiftKey: true }))).toBe(true);
			expect(redo.handleRedo).toHaveBeenCalledTimes(1);
		});
		it('accepts Ctrl as well as Cmd', () => {
			const h = setup();
			expect(h.handleKeyDown(keyEvent('z', { ctrlKey: true }))).toBe(true);
			expect(h.handleUndo).toHaveBeenCalledTimes(1);
		});
	});
});
// Source: src/__tests__/renderer/hooks/useAutoRunScrollSync.test.ts
describe('', () => {
	// Mock requestAnimationFrame to execute callbacks synchronously
	const originalRAF = globalThis.requestAnimationFrame;
	beforeEach(() => {
		globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => {
			cb(0);
			return 0;
		};
	});
	afterEach(() => {
		globalThis.requestAnimationFrame = originalRAF;
	});
	// ============================================================================
	// Test Helpers
	// ============================================================================
	const createParams = (
		overrides: Partial<UseAutoRunScrollSyncParams> = {}
	): UseAutoRunScrollSyncParams => ({
		mode: 'edit' as const,
		setMode: vi.fn(),
		editorRef: { current: null },
		previewRef: { current: null },
		localContent: 'test content',
		searchOpen: false,
		searchQuery: '',
		initialCursorPosition: 0,
		initialEditScrollPos: 0,
		initialPreviewScrollPos: 0,
		onStateChange: vi.fn(),
		...overrides,
	});
	// ============================================================================
	// Tests
	// ============================================================================
	describe('useAutoRunScrollSync', () => {
		beforeEach(() => {
			vi.clearAllMocks();
		});
		describe('switchMode', () => {
			it('does nothing when newMode equals current mode', () => {
				const params = createParams({ mode: 'edit' });
				const { result } = s3_renderHook(() => useAutoRunScrollSync(params));
				s3_act(() => {
					result.current.switchMode('edit');
				});
				expect(params.setMode).not.toHaveBeenCalled();
				expect(params.onStateChange).not.toHaveBeenCalled();
			});
			it('calls setMode with the new mode', () => {
				const params = createParams({ mode: 'edit' });
				const { result } = s3_renderHook(() => useAutoRunScrollSync(params));
				s3_act(() => {
					result.current.switchMode('preview');
				});
				expect(params.setMode).toHaveBeenCalledWith('preview');
			});
			it('calls onStateChange with the new mode state', () => {
				const params = createParams({ mode: 'edit' });
				const { result } = s3_renderHook(() => useAutoRunScrollSync(params));
				s3_act(() => {
					result.current.switchMode('preview');
				});
				expect(params.onStateChange).toHaveBeenCalledWith({
					mode: 'preview',
					cursorPosition: 0,
					editScrollPos: 0,
					previewScrollPos: 0,
				});
			});
			it('does not call setMode when mode is the same (preview to preview)', () => {
				const params = createParams({ mode: 'preview' });
				const { result } = s3_renderHook(() => useAutoRunScrollSync(params));
				s3_act(() => {
					result.current.switchMode('preview');
				});
				expect(params.setMode).not.toHaveBeenCalled();
			});
			it('calls setMode when switching from preview to edit', () => {
				const params = createParams({ mode: 'preview' });
				const { result } = s3_renderHook(() => useAutoRunScrollSync(params));
				s3_act(() => {
					result.current.switchMode('edit');
				});
				expect(params.setMode).toHaveBeenCalledWith('edit');
			});
			it('does not call onStateChange when mode is the same', () => {
				const params = createParams({ mode: 'edit' });
				const { result } = s3_renderHook(() => useAutoRunScrollSync(params));
				s3_act(() => {
					result.current.switchMode('edit');
				});
				expect(params.onStateChange).not.toHaveBeenCalled();
			});
			it('works without onStateChange callback', () => {
				const params = createParams({ mode: 'edit', onStateChange: undefined });
				const { result } = s3_renderHook(() => useAutoRunScrollSync(params));
				// Should not throw
				s3_act(() => {
					result.current.switchMode('preview');
				});
				expect(params.setMode).toHaveBeenCalledWith('preview');
			});
		});
		describe('toggleMode', () => {
			it('toggles from edit to preview', () => {
				const params = createParams({ mode: 'edit' });
				const { result } = s3_renderHook(() => useAutoRunScrollSync(params));
				s3_act(() => {
					result.current.toggleMode();
				});
				expect(params.setMode).toHaveBeenCalledWith('preview');
			});
			it('toggles from preview to edit', () => {
				const params = createParams({ mode: 'preview' });
				const { result } = s3_renderHook(() => useAutoRunScrollSync(params));
				s3_act(() => {
					result.current.toggleMode();
				});
				expect(params.setMode).toHaveBeenCalledWith('edit');
			});
		});
		describe('handlePreviewScroll', () => {
			it('is a function', () => {
				const params = createParams();
				const { result } = s3_renderHook(() => useAutoRunScrollSync(params));
				expect(typeof result.current.handlePreviewScroll).toBe('function');
			});
		});
	});
});
