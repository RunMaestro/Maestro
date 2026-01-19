/**
 * @file AutoRunBlurSaveTiming.test.tsx
 * @description Tests for save timing and session path correctness in Auto Run
 *
 * These tests verify that:
 * 1. Save operations write to the correct session's folder/file path
 * 2. Unsaved changes are discarded (not saved to wrong session) on session switch
 * 3. savedContent state prevents duplicate/unnecessary saves
 * 4. Save button and Cmd+S correctly update savedContent and clear dirty state
 *
 * Note: The original task referenced "syncContentToParent" and "lastSavedContentRef"
 * which were from an older implementation. The current implementation uses:
 * - handleSave() to write to disk
 * - savedContent state to track what's been saved
 * - isDirty computed from (localContent !== savedContent)
 * - No blur-based auto-save (manual save model)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import React from 'react';
import { AutoRun, AutoRunHandle } from '../../../renderer/components/AutoRun';
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';
import type { Theme } from '../../../renderer/types';

// Helper to wrap component in LayerStackProvider with custom rerender
const renderWithProviders = (ui: React.ReactElement) => {
	const result = render(<LayerStackProvider>{ui}</LayerStackProvider>);
	return {
		...result,
		rerender: (newUi: React.ReactElement) =>
			result.rerender(<LayerStackProvider>{newUi}</LayerStackProvider>),
	};
};

// Mock the external dependencies
vi.mock('react-markdown', () => ({
	default: ({ children }: { children: string }) => (
		<div data-testid="react-markdown">{children}</div>
	),
}));

vi.mock('remark-gfm', () => ({
	default: {},
}));

vi.mock('react-syntax-highlighter', () => ({
	Prism: ({ children }: { children: string }) => (
		<code data-testid="syntax-highlighter">{children}</code>
	),
}));

vi.mock('react-syntax-highlighter/dist/esm/styles/prism', () => ({
	vscDarkPlus: {},
}));

vi.mock('../../../renderer/components/AutoRunnerHelpModal', () => ({
	AutoRunnerHelpModal: ({ onClose }: { onClose: () => void }) => (
		<div data-testid="help-modal">
			<button onClick={onClose}>Close</button>
		</div>
	),
}));

vi.mock('../../../renderer/components/MermaidRenderer', () => ({
	MermaidRenderer: ({ chart }: { chart: string }) => (
		<div data-testid="mermaid-renderer">{chart}</div>
	),
}));

vi.mock('../../../renderer/components/AutoRunDocumentSelector', () => ({
	AutoRunDocumentSelector: ({
		documents,
		selectedDocument,
		onSelectDocument,
		onRefresh,
		onChangeFolder,
		isLoading,
	}: any) => (
		<div data-testid="document-selector">
			<select
				data-testid="doc-select"
				value={selectedDocument || ''}
				onChange={(e) => onSelectDocument(e.target.value)}
			>
				{documents.map((doc: string) => (
					<option key={doc} value={doc}>
						{doc}
					</option>
				))}
			</select>
			<button data-testid="refresh-btn" onClick={onRefresh}>
				Refresh
			</button>
			<button data-testid="change-folder-btn" onClick={onChangeFolder}>
				Change
			</button>
			{isLoading && <span data-testid="loading-indicator">Loading...</span>}
		</div>
	),
}));

vi.mock('../../../renderer/hooks/input/useTemplateAutocomplete', () => ({
	useTemplateAutocomplete: ({
		value,
		onChange,
	}: {
		value: string;
		onChange: (value: string) => void;
	}) => {
		return {
			autocompleteState: {
				isOpen: false,
				suggestions: [],
				selectedIndex: 0,
				position: { top: 0, left: 0 },
			},
			handleKeyDown: () => false,
			handleChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => {
				onChange(e.target.value);
			},
			selectVariable: () => {},
			closeAutocomplete: () => {},
			autocompleteRef: { current: null },
		};
	},
}));

vi.mock('../../../renderer/components/TemplateAutocompleteDropdown', () => ({
	TemplateAutocompleteDropdown: React.forwardRef(() => null),
}));

// Create a mock theme for testing
const createMockTheme = (): Theme => ({
	id: 'test-theme',
	name: 'Test Theme',
	mode: 'dark',
	colors: {
		bgMain: '#1a1a1a',
		bgPanel: '#252525',
		bgActivity: '#2d2d2d',
		textMain: '#ffffff',
		textDim: '#888888',
		accent: '#0066ff',
		accentForeground: '#ffffff',
		border: '#333333',
		highlight: '#0066ff33',
		success: '#00aa00',
		warning: '#ffaa00',
		error: '#ff0000',
	},
});

// Setup window.maestro mock
const setupMaestroMock = () => {
	const mockMaestro = {
		fs: {
			readFile: vi.fn().mockResolvedValue('data:image/png;base64,abc123'),
			readDir: vi.fn().mockResolvedValue([]),
		},
		autorun: {
			listImages: vi.fn().mockResolvedValue({ success: true, images: [] }),
			saveImage: vi.fn().mockResolvedValue({ success: true, relativePath: 'images/test-123.png' }),
			deleteImage: vi.fn().mockResolvedValue({ success: true }),
			writeDoc: vi.fn().mockResolvedValue(undefined),
		},
		settings: {
			get: vi.fn().mockResolvedValue(null),
			set: vi.fn().mockResolvedValue(undefined),
		},
	};

	(window as any).maestro = mockMaestro;
	return mockMaestro;
};

// Default props for AutoRun component
const createDefaultProps = (overrides: Partial<React.ComponentProps<typeof AutoRun>> = {}) => ({
	theme: createMockTheme(),
	sessionId: 'session-a',
	folderPath: '/test/folder',
	selectedFile: 'test-doc',
	documentList: ['test-doc', 'another-doc'],
	content: '# Original Content',
	onContentChange: vi.fn(),
	mode: 'edit' as const,
	onModeChange: vi.fn(),
	onOpenSetup: vi.fn(),
	onRefresh: vi.fn(),
	onSelectDocument: vi.fn(),
	onCreateDocument: vi.fn().mockResolvedValue(true),
	...overrides,
});

describe('AutoRun Save Path Correctness', () => {
	let mockMaestro: ReturnType<typeof setupMaestroMock>;

	beforeEach(() => {
		mockMaestro = setupMaestroMock();
		vi.useFakeTimers({ shouldAdvanceTime: true });
	});

	afterEach(() => {
		vi.clearAllMocks();
		vi.useRealTimers();
	});

	describe('Save writes to correct session path', () => {
		it('handleSave writes to the current session folderPath and selectedFile', async () => {
			const ref = React.createRef<AutoRunHandle>();
			const props = createDefaultProps({
				sessionId: 'session-alpha',
				folderPath: '/projects/alpha/docs',
				selectedFile: 'Phase-1',
				content: 'Original content',
			});

			renderWithProviders(<AutoRun {...props} ref={ref} />);

			const textarea = screen.getByRole('textbox');
			fireEvent.change(textarea, { target: { value: 'Modified content for alpha' } });

			// Save via imperative handle
			await act(async () => {
				await ref.current?.save();
			});

			// Verify writeDoc was called with correct path
			expect(mockMaestro.autorun.writeDoc).toHaveBeenCalledTimes(1);
			expect(mockMaestro.autorun.writeDoc).toHaveBeenCalledWith(
				'/projects/alpha/docs',
				'Phase-1.md',
				'Modified content for alpha',
				undefined // sshRemoteId (undefined for local sessions)
			);
		});

		it('Save button writes to correct path', async () => {
			const props = createDefaultProps({
				sessionId: 'session-beta',
				folderPath: '/projects/beta/auto-run',
				selectedFile: 'Tasks',
				content: 'Initial tasks',
			});

			renderWithProviders(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox');
			fireEvent.change(textarea, { target: { value: 'Updated tasks list' } });

			// Click save button
			const saveButton = screen.getByText('Save');
			fireEvent.click(saveButton);

			expect(mockMaestro.autorun.writeDoc).toHaveBeenCalledWith(
				'/projects/beta/auto-run',
				'Tasks.md',
				'Updated tasks list',
				undefined // sshRemoteId (undefined for local sessions)
			);
		});

		it('Cmd+S keyboard shortcut writes to correct path', async () => {
			const props = createDefaultProps({
				sessionId: 'session-gamma',
				folderPath: '/home/user/gamma-project/docs',
				selectedFile: 'README',
				content: 'Original readme',
			});

			renderWithProviders(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox');
			fireEvent.change(textarea, { target: { value: 'Updated readme content' } });

			// Press Cmd+S
			fireEvent.keyDown(textarea, { key: 's', metaKey: true });

			expect(mockMaestro.autorun.writeDoc).toHaveBeenCalledWith(
				'/home/user/gamma-project/docs',
				'README.md',
				'Updated readme content',
				undefined // sshRemoteId (undefined for local sessions)
			);
		});

		it('multiple consecutive saves always use current path', async () => {
			const props = createDefaultProps({
				sessionId: 'session-delta',
				folderPath: '/delta/path',
				selectedFile: 'doc1',
				content: 'Version 1',
			});

			const { rerender } = renderWithProviders(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox');

			// First edit and save
			fireEvent.change(textarea, { target: { value: 'Version 2' } });
			fireEvent.click(screen.getByText('Save'));

			expect(mockMaestro.autorun.writeDoc).toHaveBeenLastCalledWith(
				'/delta/path',
				'doc1.md',
				'Version 2',
				undefined // sshRemoteId (undefined for local sessions)
			);

			// Simulate saved content update (file watcher triggers contentVersion change)
			rerender(<AutoRun {...props} content="Version 2" contentVersion={1} />);

			// Second edit and save
			fireEvent.change(textarea, { target: { value: 'Version 3' } });
			fireEvent.click(screen.getByText('Save'));

			expect(mockMaestro.autorun.writeDoc).toHaveBeenLastCalledWith(
				'/delta/path',
				'doc1.md',
				'Version 3',
				undefined // sshRemoteId (undefined for local sessions)
			);

			expect(mockMaestro.autorun.writeDoc).toHaveBeenCalledTimes(2);
		});
	});

	describe('Unsaved changes discarded on session switch', () => {
		it('does not auto-save when switching sessions with dirty content', async () => {
			const propsA = createDefaultProps({
				sessionId: 'session-a',
				folderPath: '/path/a',
				selectedFile: 'doc-a',
				content: 'Content A',
			});

			const { rerender } = renderWithProviders(<AutoRun {...propsA} />);

			const textarea = screen.getByRole('textbox');

			// Make edits in Session A (dirty state)
			fireEvent.change(textarea, { target: { value: 'Dirty content in A' } });

			// Switch to Session B without saving
			const propsB = createDefaultProps({
				sessionId: 'session-b',
				folderPath: '/path/b',
				selectedFile: 'doc-b',
				content: 'Content B',
			});
			rerender(<AutoRun {...propsB} />);

			// Verify NO writeDoc was called
			expect(mockMaestro.autorun.writeDoc).not.toHaveBeenCalled();
		});

		it('dirty changes in Session A do not persist after switch to B and back', async () => {
			const propsA = createDefaultProps({
				sessionId: 'session-a',
				folderPath: '/path/a',
				selectedFile: 'doc-a',
				content: 'Original A',
			});

			const { rerender } = renderWithProviders(<AutoRun {...propsA} />);

			const textarea = screen.getByRole('textbox');

			// Dirty session A
			fireEvent.change(textarea, { target: { value: 'Unsaved edits A' } });

			// Switch to Session B
			rerender(
				<AutoRun
					{...createDefaultProps({
						sessionId: 'session-b',
						folderPath: '/path/b',
						selectedFile: 'doc-b',
						content: 'Content B',
					})}
				/>
			);

			// Switch back to Session A
			rerender(<AutoRun {...propsA} />);

			// Textarea should show Session A's original content, not dirty edits
			expect(textarea).toHaveValue('Original A');

			// No saves should have occurred
			expect(mockMaestro.autorun.writeDoc).not.toHaveBeenCalled();
		});

		it('switching documents within session discards unsaved changes without saving', async () => {
			const props = createDefaultProps({
				sessionId: 'session-x',
				folderPath: '/shared/path',
				selectedFile: 'doc1',
				content: 'Doc 1 content',
			});

			const { rerender } = renderWithProviders(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox');
			fireEvent.change(textarea, { target: { value: 'Dirty doc1 content' } });

			// Switch document
			rerender(<AutoRun {...props} selectedFile="doc2" content="Doc 2 content" />);

			// No save should occur
			expect(mockMaestro.autorun.writeDoc).not.toHaveBeenCalled();

			// New document content shown
			expect(textarea).toHaveValue('Doc 2 content');
		});
	});

	describe('savedContent state prevents duplicate saves', () => {
		it('save is not possible when content matches savedContent', async () => {
			const ref = React.createRef<AutoRunHandle>();
			const props = createDefaultProps({
				content: 'Unchanged content',
			});

			renderWithProviders(<AutoRun {...props} ref={ref} />);

			// Initially not dirty
			expect(ref.current?.isDirty()).toBe(false);

			// Save button should not be visible
			expect(screen.queryByText('Save')).not.toBeInTheDocument();

			// Trying to save via ref should not trigger writeDoc
			await act(async () => {
				await ref.current?.save();
			});

			expect(mockMaestro.autorun.writeDoc).not.toHaveBeenCalled();
		});

		it('typing same content as original clears dirty state', async () => {
			const ref = React.createRef<AutoRunHandle>();
			const originalContent = 'The original content';
			const props = createDefaultProps({
				content: originalContent,
			});

			renderWithProviders(<AutoRun {...props} ref={ref} />);

			const textarea = screen.getByRole('textbox');

			// Make changes - becomes dirty
			fireEvent.change(textarea, { target: { value: 'Different content' } });
			expect(ref.current?.isDirty()).toBe(true);
			expect(screen.getByText('Save')).toBeInTheDocument();

			// Type back to original - no longer dirty
			fireEvent.change(textarea, { target: { value: originalContent } });
			expect(ref.current?.isDirty()).toBe(false);
			expect(screen.queryByText('Save')).not.toBeInTheDocument();
		});

		it('save updates savedContent so immediate resave is not triggered', async () => {
			const ref = React.createRef<AutoRunHandle>();
			const props = createDefaultProps({
				folderPath: '/test/path',
				selectedFile: 'mydoc',
				content: 'Original',
			});

			renderWithProviders(<AutoRun {...props} ref={ref} />);

			const textarea = screen.getByRole('textbox');
			fireEvent.change(textarea, { target: { value: 'Changed' } });

			expect(ref.current?.isDirty()).toBe(true);

			// First save
			await act(async () => {
				await ref.current?.save();
			});

			expect(mockMaestro.autorun.writeDoc).toHaveBeenCalledTimes(1);
			expect(ref.current?.isDirty()).toBe(false);

			// Try to save again immediately - should not trigger since not dirty
			await act(async () => {
				await ref.current?.save();
			});

			// Still only 1 call
			expect(mockMaestro.autorun.writeDoc).toHaveBeenCalledTimes(1);
		});

		it('revert restores savedContent without triggering save', async () => {
			const ref = React.createRef<AutoRunHandle>();
			const props = createDefaultProps({
				content: 'Original saved content',
			});

			renderWithProviders(<AutoRun {...props} ref={ref} />);

			const textarea = screen.getByRole('textbox');
			fireEvent.change(textarea, { target: { value: 'Dirty changes' } });

			expect(ref.current?.isDirty()).toBe(true);

			// Revert
			await act(async () => {
				ref.current?.revert();
			});

			expect(textarea).toHaveValue('Original saved content');
			expect(ref.current?.isDirty()).toBe(false);

			// No save occurred
			expect(mockMaestro.autorun.writeDoc).not.toHaveBeenCalled();
		});
	});

	describe('Save clears dirty state', () => {
		it('Save button click clears dirty state', async () => {
			const ref = React.createRef<AutoRunHandle>();
			const props = createDefaultProps({
				folderPath: '/test',
				selectedFile: 'doc',
				content: 'Initial',
			});

			renderWithProviders(<AutoRun {...props} ref={ref} />);

			const textarea = screen.getByRole('textbox');
			fireEvent.change(textarea, { target: { value: 'New content' } });

			expect(ref.current?.isDirty()).toBe(true);
			expect(screen.getByText('Save')).toBeInTheDocument();
			expect(screen.getByText('Revert')).toBeInTheDocument();

			// Click Save
			fireEvent.click(screen.getByText('Save'));

			// Wait for async save to complete
			await waitFor(() => {
				expect(ref.current?.isDirty()).toBe(false);
			});

			expect(screen.queryByText('Save')).not.toBeInTheDocument();
			expect(screen.queryByText('Revert')).not.toBeInTheDocument();
		});

		it('Cmd+S clears dirty state', async () => {
			const ref = React.createRef<AutoRunHandle>();
			const props = createDefaultProps({
				folderPath: '/test',
				selectedFile: 'doc',
				content: 'Initial',
			});

			renderWithProviders(<AutoRun {...props} ref={ref} />);

			const textarea = screen.getByRole('textbox');
			fireEvent.change(textarea, { target: { value: 'New content' } });

			expect(ref.current?.isDirty()).toBe(true);

			// Press Cmd+S
			fireEvent.keyDown(textarea, { key: 's', metaKey: true });

			await waitFor(() => {
				expect(ref.current?.isDirty()).toBe(false);
			});
		});

		it('savedContent updates correctly after save', async () => {
			const ref = React.createRef<AutoRunHandle>();
			const props = createDefaultProps({
				folderPath: '/test',
				selectedFile: 'doc',
				content: 'Version 1',
			});

			renderWithProviders(<AutoRun {...props} ref={ref} />);

			const textarea = screen.getByRole('textbox');

			// Edit to version 2
			fireEvent.change(textarea, { target: { value: 'Version 2' } });
			expect(ref.current?.isDirty()).toBe(true);

			// Save
			fireEvent.click(screen.getByText('Save'));
			await waitFor(() => {
				expect(ref.current?.isDirty()).toBe(false);
			});

			// Now edit to version 3
			fireEvent.change(textarea, { target: { value: 'Version 3' } });
			expect(ref.current?.isDirty()).toBe(true);

			// Revert should go back to version 2 (last saved), not version 1
			await act(async () => {
				ref.current?.revert();
			});

			expect(textarea).toHaveValue('Version 2');
			expect(ref.current?.isDirty()).toBe(false);
		});
	});

	describe('Edge cases for save timing', () => {
		it('rapid edits followed by save captures final content', async () => {
			const props = createDefaultProps({
				folderPath: '/rapid/test',
				selectedFile: 'rapid-doc',
				content: 'Start',
			});

			renderWithProviders(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox');

			// Rapid typing simulation
			const chars = 'Final typed content';
			for (let i = 1; i <= chars.length; i++) {
				fireEvent.change(textarea, { target: { value: chars.substring(0, i) } });
			}

			// Save immediately after rapid edits
			fireEvent.click(screen.getByText('Save'));

			// Should save the final content
			expect(mockMaestro.autorun.writeDoc).toHaveBeenCalledWith(
				'/rapid/test',
				'rapid-doc.md',
				'Final typed content',
				undefined // sshRemoteId (undefined for local sessions)
			);
		});

		it('empty content can be saved', async () => {
			const props = createDefaultProps({
				folderPath: '/empty/test',
				selectedFile: 'empty-doc',
				content: 'Has content initially',
			});

			renderWithProviders(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox');
			fireEvent.change(textarea, { target: { value: '' } });

			fireEvent.click(screen.getByText('Save'));

			expect(mockMaestro.autorun.writeDoc).toHaveBeenCalledWith(
				'/empty/test',
				'empty-doc.md',
				'',
				undefined // sshRemoteId (undefined for local sessions)
			);
		});

		it('whitespace-only content can be saved', async () => {
			const props = createDefaultProps({
				folderPath: '/whitespace/test',
				selectedFile: 'ws-doc',
				content: 'Original text',
			});

			renderWithProviders(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox');
			fireEvent.change(textarea, { target: { value: '   \n\n   ' } });

			fireEvent.click(screen.getByText('Save'));

			expect(mockMaestro.autorun.writeDoc).toHaveBeenCalledWith(
				'/whitespace/test',
				'ws-doc.md',
				'   \n\n   ',
				undefined // sshRemoteId (undefined for local sessions)
			);
		});

		it('special characters in content are preserved on save', async () => {
			const props = createDefaultProps({
				folderPath: '/special/test',
				selectedFile: 'special-doc',
				content: 'Plain',
			});

			renderWithProviders(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox');
			const specialContent = '# Hello 🌍\n```js\nconst x = "test";\n```\n<div>HTML</div>';
			fireEvent.change(textarea, { target: { value: specialContent } });

			fireEvent.click(screen.getByText('Save'));

			expect(mockMaestro.autorun.writeDoc).toHaveBeenCalledWith(
				'/special/test',
				'special-doc.md',
				specialContent,
				undefined // sshRemoteId (undefined for local sessions)
			);
		});

		it('very long content can be saved', async () => {
			const props = createDefaultProps({
				folderPath: '/long/test',
				selectedFile: 'long-doc',
				content: 'Short',
			});

			renderWithProviders(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox');
			// Reduced from 100,000 to 5,000 chars - still tests "long" content without excessive slowdown
			const longContent = 'X'.repeat(5000);
			fireEvent.change(textarea, { target: { value: longContent } });

			fireEvent.click(screen.getByText('Save'));

			expect(mockMaestro.autorun.writeDoc).toHaveBeenCalledWith(
				'/long/test',
				'long-doc.md',
				longContent,
				undefined // sshRemoteId (undefined for local sessions)
			);
		});
	});

	describe('Save during batch run lock', () => {
		it('save button is not visible when batch run is active', () => {
			const props = createDefaultProps({
				content: 'Content',
				batchRunState: {
					isRunning: true,
					isStopping: false,
					currentTaskIndex: 0,
					totalTasks: 5,
				},
			});

			renderWithProviders(<AutoRun {...props} />);

			// During batch run, mode switches to preview automatically
			// Save/Revert buttons should not be visible
			expect(screen.queryByText('Save')).not.toBeInTheDocument();
			expect(screen.queryByText('Revert')).not.toBeInTheDocument();
		});

		it('Cmd+S does nothing when batch run is active', async () => {
			const props = createDefaultProps({
				folderPath: '/test',
				selectedFile: 'doc',
				content: 'Initial',
				batchRunState: {
					isRunning: true,
					isStopping: false,
					currentTaskIndex: 0,
					totalTasks: 5,
				},
			});

			renderWithProviders(<AutoRun {...props} />);

			// The textarea is read-only during batch run
			// Even if we could send keyDown, it should not trigger save
			const container = screen.getByRole('textbox').parentElement?.parentElement?.parentElement;
			if (container) {
				fireEvent.keyDown(container, { key: 's', metaKey: true });
			}

			// No save should occur
			expect(mockMaestro.autorun.writeDoc).not.toHaveBeenCalled();
		});
	});

	describe('Save with missing required props', () => {
		it('does not save when folderPath is null', async () => {
			const ref = React.createRef<AutoRunHandle>();
			const props = createDefaultProps({
				folderPath: null,
				selectedFile: 'doc',
				content: 'Content',
			});

			renderWithProviders(<AutoRun {...props} ref={ref} />);

			// With null folderPath, the main content area isn't rendered
			// But we can still try to save via ref
			await act(async () => {
				await ref.current?.save();
			});

			expect(mockMaestro.autorun.writeDoc).not.toHaveBeenCalled();
		});

		it('does not save when selectedFile is null', async () => {
			const ref = React.createRef<AutoRunHandle>();
			const props = createDefaultProps({
				folderPath: '/test',
				selectedFile: null,
				content: 'Content',
			});

			renderWithProviders(<AutoRun {...props} ref={ref} />);

			await act(async () => {
				await ref.current?.save();
			});

			expect(mockMaestro.autorun.writeDoc).not.toHaveBeenCalled();
		});
	});
});

describe('AutoRun savedContent state reset behavior', () => {
	let mockMaestro: ReturnType<typeof setupMaestroMock>;

	beforeEach(() => {
		mockMaestro = setupMaestroMock();
		vi.useFakeTimers({ shouldAdvanceTime: true });
	});

	afterEach(() => {
		vi.clearAllMocks();
		vi.useRealTimers();
	});

	it('savedContent resets to new content when session changes', async () => {
		const ref = React.createRef<AutoRunHandle>();
		const propsA = createDefaultProps({
			sessionId: 'session-a',
			content: 'Session A content',
		});

		const { rerender } = renderWithProviders(<AutoRun {...propsA} ref={ref} />);

		const textarea = screen.getByRole('textbox');

		// Dirty Session A
		fireEvent.change(textarea, { target: { value: 'Dirty A' } });
		expect(ref.current?.isDirty()).toBe(true);

		// Switch to Session B
		const propsB = createDefaultProps({
			sessionId: 'session-b',
			content: 'Session B content',
		});
		rerender(<AutoRun {...propsB} ref={ref} />);

		// In Session B, savedContent should be 'Session B content'
		expect(ref.current?.isDirty()).toBe(false);
		expect(textarea).toHaveValue('Session B content');

		// Making dirty in B then reverting should go to B's savedContent
		fireEvent.change(textarea, { target: { value: 'Dirty B' } });
		await act(async () => {
			ref.current?.revert();
		});
		expect(textarea).toHaveValue('Session B content');
	});

	it('savedContent resets to new content when document changes', async () => {
		const ref = React.createRef<AutoRunHandle>();
		const props = createDefaultProps({
			sessionId: 'session-x',
			selectedFile: 'doc1',
			content: 'Doc 1 content',
		});

		const { rerender } = renderWithProviders(<AutoRun {...props} ref={ref} />);

		const textarea = screen.getByRole('textbox');

		// Dirty doc1
		fireEvent.change(textarea, { target: { value: 'Dirty doc1' } });
		expect(ref.current?.isDirty()).toBe(true);

		// Switch to doc2
		rerender(<AutoRun {...props} ref={ref} selectedFile="doc2" content="Doc 2 content" />);

		// savedContent should be 'Doc 2 content'
		expect(ref.current?.isDirty()).toBe(false);
		expect(textarea).toHaveValue('Doc 2 content');

		// Revert in doc2 should stay at doc2's content
		fireEvent.change(textarea, { target: { value: 'Dirty doc2' } });
		await act(async () => {
			ref.current?.revert();
		});
		expect(textarea).toHaveValue('Doc 2 content');
	});

	it('savedContent updates when contentVersion changes', async () => {
		const ref = React.createRef<AutoRunHandle>();
		const props = createDefaultProps({
			sessionId: 'session-y',
			selectedFile: 'doc1',
			content: 'Version 1 from disk',
			contentVersion: 1,
		});

		const { rerender } = renderWithProviders(<AutoRun {...props} ref={ref} />);

		const textarea = screen.getByRole('textbox');

		// Local edits
		fireEvent.change(textarea, { target: { value: 'Local edits' } });
		expect(ref.current?.isDirty()).toBe(true);

		// External change detected (file watcher)
		rerender(<AutoRun {...props} ref={ref} content="Version 2 from disk" contentVersion={2} />);

		// savedContent should now be 'Version 2 from disk'
		expect(ref.current?.isDirty()).toBe(false);
		expect(textarea).toHaveValue('Version 2 from disk');

		// Revert should go to version 2
		fireEvent.change(textarea, { target: { value: 'More local edits' } });
		await act(async () => {
			ref.current?.revert();
		});
		expect(textarea).toHaveValue('Version 2 from disk');
	});
});
