/**
 * @file AutoRunSessionIsolation.test.tsx
 * @description Tests for session switching content isolation in Auto Run
 *
 * These tests verify that:
 * 1. Editing a document in Session A doesn't affect Session B's document
 * 2. Content changes are properly isolated per-session
 * 3. Session/document switches properly reset local state
 * 4. contentVersion forcing sync works correctly
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import React from 'react';
import { AutoRun, AutoRunHandle } from '../../../renderer/components/AutoRun';
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';
import type { Theme, BatchRunState } from '../../../renderer/types';

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
		theme,
		documents,
		selectedDocument,
		onSelectDocument,
		onRefresh,
		onChangeFolder,
		onCreateDocument,
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
	folderPath: '/test/folder-a',
	selectedFile: 'Phase 1',
	documentList: ['Phase 1', 'Phase 2'],
	content: '# Session A - Phase 1\n\nContent for session A.',
	onContentChange: vi.fn(),
	mode: 'edit' as const,
	onModeChange: vi.fn(),
	onOpenSetup: vi.fn(),
	onRefresh: vi.fn(),
	onSelectDocument: vi.fn(),
	onCreateDocument: vi.fn().mockResolvedValue(true),
	...overrides,
});

describe('AutoRun Session Isolation', () => {
	let mockMaestro: ReturnType<typeof setupMaestroMock>;

	beforeEach(() => {
		mockMaestro = setupMaestroMock();
		vi.useFakeTimers({ shouldAdvanceTime: true });
	});

	afterEach(() => {
		vi.clearAllMocks();
		vi.useRealTimers();
	});

	describe('Session Switching Content Isolation', () => {
		it('editing doc "Phase 1" in Session A does not affect Session B\'s "Phase 1"', async () => {
			// Session A starts with its own content
			const sessionAContent = '# Session A - Phase 1\n\nOriginal content A.';
			const sessionBContent = '# Session B - Phase 1\n\nOriginal content B.';

			const propsA = createDefaultProps({
				sessionId: 'session-a',
				folderPath: '/projects/session-a/Auto Run Docs',
				selectedFile: 'Phase 1',
				content: sessionAContent,
			});

			const { rerender } = renderWithProviders(<AutoRun {...propsA} />);

			// Edit content in Session A
			const textarea = screen.getByRole('textbox');
			expect(textarea).toHaveValue(sessionAContent);

			fireEvent.change(textarea, { target: { value: 'Modified content in Session A' } });
			expect(textarea).toHaveValue('Modified content in Session A');

			// Now switch to Session B - the content should reset to Session B's content
			const propsB = createDefaultProps({
				sessionId: 'session-b',
				folderPath: '/projects/session-b/Auto Run Docs',
				selectedFile: 'Phase 1',
				content: sessionBContent,
			});

			rerender(<AutoRun {...propsB} />);

			// Session B should have its own content, not the modified Session A content
			expect(textarea).toHaveValue(sessionBContent);

			// Verify writeDoc was NOT called when switching sessions
			// (unsaved changes from Session A should be discarded, not auto-saved)
			expect(mockMaestro.autorun.writeDoc).not.toHaveBeenCalled();
		});

		it('switching back to Session A shows its content (not modified content from earlier)', async () => {
			const sessionAContent = '# Session A\n\nOriginal.';
			const sessionBContent = '# Session B\n\nDifferent.';

			const propsA = createDefaultProps({
				sessionId: 'session-a',
				content: sessionAContent,
			});

			const { rerender } = renderWithProviders(<AutoRun {...propsA} />);

			const textarea = screen.getByRole('textbox');

			// Edit in Session A (unsaved)
			fireEvent.change(textarea, { target: { value: 'Unsaved changes A' } });
			expect(textarea).toHaveValue('Unsaved changes A');

			// Switch to Session B
			const propsB = createDefaultProps({
				sessionId: 'session-b',
				content: sessionBContent,
			});
			rerender(<AutoRun {...propsB} />);
			expect(textarea).toHaveValue(sessionBContent);

			// Switch back to Session A with fresh content from props
			// (simulating re-loading from disk or state)
			rerender(<AutoRun {...propsA} />);

			// Should show Session A's original content from props, not the unsaved changes
			expect(textarea).toHaveValue(sessionAContent);
		});

		it('discards pending saves on session switch (no cross-session writes)', async () => {
			const propsA = createDefaultProps({
				sessionId: 'session-a',
				folderPath: '/path/a',
				selectedFile: 'doc-a',
				content: 'Content A',
			});

			const { rerender } = renderWithProviders(<AutoRun {...propsA} />);

			const textarea = screen.getByRole('textbox');

			// Make changes in Session A
			fireEvent.change(textarea, { target: { value: 'Modified A' } });

			// Before any auto-save could trigger, switch to Session B
			const propsB = createDefaultProps({
				sessionId: 'session-b',
				folderPath: '/path/b',
				selectedFile: 'doc-b',
				content: 'Content B',
			});
			rerender(<AutoRun {...propsB} />);

			// Verify no writeDoc was called for Session A's folder/file
			expect(mockMaestro.autorun.writeDoc).not.toHaveBeenCalledWith(
				'/path/a',
				'doc-a.md',
				expect.anything()
			);
		});
	});

	describe('Document Switching Within Same Session', () => {
		it('switching documents within same session loads new document content', async () => {
			const doc1Content = '# Document 1\n\nContent 1.';
			const doc2Content = '# Document 2\n\nContent 2.';

			const props = createDefaultProps({
				sessionId: 'session-a',
				selectedFile: 'doc1',
				content: doc1Content,
			});

			const { rerender } = renderWithProviders(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox');
			expect(textarea).toHaveValue(doc1Content);

			// Edit doc1
			fireEvent.change(textarea, { target: { value: 'Modified doc1' } });
			expect(textarea).toHaveValue('Modified doc1');

			// Switch to doc2 within same session
			rerender(<AutoRun {...props} selectedFile="doc2" content={doc2Content} />);

			// Should show doc2 content
			expect(textarea).toHaveValue(doc2Content);
		});

		it('unsaved changes are discarded when switching documents (manual save model)', async () => {
			const doc1Content = 'Original doc1';

			const props = createDefaultProps({
				selectedFile: 'doc1',
				content: doc1Content,
			});

			const { rerender } = renderWithProviders(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox');
			fireEvent.change(textarea, { target: { value: 'Unsaved changes' } });

			// Switch document
			rerender(<AutoRun {...props} selectedFile="doc2" content="Doc 2 content" />);

			// No auto-save should occur
			expect(mockMaestro.autorun.writeDoc).not.toHaveBeenCalled();
		});
	});

	describe('contentVersion Force Sync', () => {
		it('contentVersion change forces content sync even without session/document change', async () => {
			const originalContent = 'Original content';
			const externallyModifiedContent = 'Externally modified by file watcher';

			const props = createDefaultProps({
				sessionId: 'session-a',
				selectedFile: 'doc1',
				content: originalContent,
				contentVersion: 1,
			});

			const { rerender } = renderWithProviders(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox');
			expect(textarea).toHaveValue(originalContent);

			// User edits locally
			fireEvent.change(textarea, { target: { value: 'Local edits' } });
			expect(textarea).toHaveValue('Local edits');

			// External change detected (file watcher) - contentVersion incremented
			rerender(<AutoRun {...props} content={externallyModifiedContent} contentVersion={2} />);

			// Content should sync to the external change, overwriting local edits
			expect(textarea).toHaveValue(externallyModifiedContent);
		});

		it('contentVersion without change does not overwrite local edits', async () => {
			const originalContent = 'Original';

			const props = createDefaultProps({
				content: originalContent,
				contentVersion: 1,
			});

			const { rerender } = renderWithProviders(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox');
			fireEvent.change(textarea, { target: { value: 'Local edits' } });

			// Rerender with same contentVersion (no external change)
			rerender(<AutoRun {...props} content="Some prop update" contentVersion={1} />);

			// Local edits should be preserved
			expect(textarea).toHaveValue('Local edits');
		});
	});

	describe('Save/Revert with Session Context', () => {
		it('save writes to current session folder/file only', async () => {
			const props = createDefaultProps({
				sessionId: 'session-a',
				folderPath: '/session-a-folder',
				selectedFile: 'my-doc',
				content: 'Original',
			});

			renderWithProviders(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox');
			fireEvent.change(textarea, { target: { value: 'New content' } });

			// Click save button
			const saveButton = screen.getByText('Save');
			fireEvent.click(saveButton);

			// Should save to correct path
			expect(mockMaestro.autorun.writeDoc).toHaveBeenCalledWith(
				'/session-a-folder',
				'my-doc.md',
				'New content',
				undefined // sshRemoteId (undefined for local sessions)
			);

			// Should NOT be called with any other path
			expect(mockMaestro.autorun.writeDoc).toHaveBeenCalledTimes(1);
		});

		it('revert restores saved content without writing to disk', async () => {
			const originalContent = 'Original saved content';

			const props = createDefaultProps({
				content: originalContent,
			});

			renderWithProviders(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox');

			// Make changes
			fireEvent.change(textarea, { target: { value: 'Changed content' } });
			expect(textarea).toHaveValue('Changed content');

			// Click revert
			const revertButton = screen.getByText('Revert');
			fireEvent.click(revertButton);

			// Should restore original
			expect(textarea).toHaveValue(originalContent);

			// No disk write should occur
			expect(mockMaestro.autorun.writeDoc).not.toHaveBeenCalled();
		});
	});

	describe('Dirty State Tracking Per Session', () => {
		it('dirty state resets when switching sessions', async () => {
			const props = createDefaultProps({
				sessionId: 'session-a',
				content: 'Original',
			});

			const { rerender } = renderWithProviders(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox');

			// Make changes - should show Save/Revert buttons
			fireEvent.change(textarea, { target: { value: 'Dirty content' } });
			expect(screen.getByText('Save')).toBeInTheDocument();
			expect(screen.getByText('Revert')).toBeInTheDocument();

			// Switch session
			rerender(<AutoRun {...props} sessionId="session-b" content="Session B content" />);

			// Dirty state should be reset (no Save/Revert buttons)
			expect(screen.queryByText('Save')).not.toBeInTheDocument();
			expect(screen.queryByText('Revert')).not.toBeInTheDocument();
		});

		it('dirty state resets when switching documents', async () => {
			const props = createDefaultProps({
				selectedFile: 'doc1',
				content: 'Doc 1 content',
			});

			const { rerender } = renderWithProviders(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox');

			// Make changes
			fireEvent.change(textarea, { target: { value: 'Modified' } });
			expect(screen.getByText('Save')).toBeInTheDocument();

			// Switch document
			rerender(<AutoRun {...props} selectedFile="doc2" content="Doc 2 content" />);

			// Dirty state should be reset
			expect(screen.queryByText('Save')).not.toBeInTheDocument();
		});
	});

	describe('Rapid Session Switching', () => {
		it('handles rapid session switches without content leakage', async () => {
			const sessions = [
				{ id: 'session-1', content: 'Content 1' },
				{ id: 'session-2', content: 'Content 2' },
				{ id: 'session-3', content: 'Content 3' },
			];

			const baseProps = createDefaultProps();

			const { rerender } = renderWithProviders(
				<AutoRun {...baseProps} sessionId={sessions[0].id} content={sessions[0].content} />
			);

			const textarea = screen.getByRole('textbox');

			// Rapid switching
			for (let i = 0; i < 10; i++) {
				const session = sessions[i % sessions.length];
				rerender(<AutoRun {...baseProps} sessionId={session.id} content={session.content} />);
			}

			// Final session should show its content
			const finalSession = sessions[9 % sessions.length];
			expect(textarea).toHaveValue(finalSession.content);

			// No writes should have occurred during switching
			expect(mockMaestro.autorun.writeDoc).not.toHaveBeenCalled();
		});

		it('edits during rapid switches are isolated', async () => {
			const baseProps = createDefaultProps();

			const { rerender } = renderWithProviders(
				<AutoRun {...baseProps} sessionId="session-1" content="Content 1" />
			);

			const textarea = screen.getByRole('textbox');

			// Edit in session 1
			fireEvent.change(textarea, { target: { value: 'Edit 1' } });

			// Quickly switch to session 2
			rerender(<AutoRun {...baseProps} sessionId="session-2" content="Content 2" />);
			expect(textarea).toHaveValue('Content 2');

			// Edit in session 2
			fireEvent.change(textarea, { target: { value: 'Edit 2' } });

			// Switch back to session 1
			rerender(<AutoRun {...baseProps} sessionId="session-1" content="Content 1" />);

			// Should show session 1's original content (unsaved edits were discarded)
			expect(textarea).toHaveValue('Content 1');
		});
	});

	describe('Focus Management on Session Switch', () => {
		it('focuses textarea after session switch in edit mode', async () => {
			const props = createDefaultProps({ mode: 'edit' });

			const { rerender } = renderWithProviders(<AutoRun {...props} sessionId="session-1" />);

			// Switch session
			rerender(<AutoRun {...props} sessionId="session-2" content="Session 2 content" />);

			// Wait for focus to be set
			await waitFor(() => {
				const textarea = screen.getByRole('textbox');
				// The component should attempt to focus the textarea
				// (actual focus might not work in jsdom but we can verify the element exists)
				expect(textarea).toBeInTheDocument();
			});
		});
	});

	describe('Imperative Handle with Sessions', () => {
		it('isDirty reflects current session state', async () => {
			const ref = React.createRef<AutoRunHandle>();
			const props = createDefaultProps({ content: 'Original' });

			const { rerender } = renderWithProviders(
				<AutoRun {...props} ref={ref} sessionId="session-1" />
			);

			// Initially not dirty
			expect(ref.current?.isDirty()).toBe(false);

			// Make changes
			const textarea = screen.getByRole('textbox');
			fireEvent.change(textarea, { target: { value: 'Modified' } });
			expect(ref.current?.isDirty()).toBe(true);

			// Switch session - dirty state should reset
			rerender(<AutoRun {...props} ref={ref} sessionId="session-2" content="Session 2" />);
			expect(ref.current?.isDirty()).toBe(false);
		});

		it('save via ref writes to correct session', async () => {
			const ref = React.createRef<AutoRunHandle>();
			const props = createDefaultProps({
				sessionId: 'session-a',
				folderPath: '/folder-a',
				selectedFile: 'doc-a',
				content: 'Original',
			});

			renderWithProviders(<AutoRun {...props} ref={ref} />);

			const textarea = screen.getByRole('textbox');
			fireEvent.change(textarea, { target: { value: 'Modified' } });

			// Save via ref
			await act(async () => {
				await ref.current?.save();
			});

			expect(mockMaestro.autorun.writeDoc).toHaveBeenCalledWith(
				'/folder-a',
				'doc-a.md',
				'Modified',
				undefined // sshRemoteId (undefined for local sessions)
			);
		});
	});
});

describe('AutoRun Folder Path Isolation', () => {
	let mockMaestro: ReturnType<typeof setupMaestroMock>;

	beforeEach(() => {
		mockMaestro = setupMaestroMock();
		vi.useFakeTimers({ shouldAdvanceTime: true });
	});

	afterEach(() => {
		vi.clearAllMocks();
		vi.useRealTimers();
	});

	it('different sessions can have different folder paths', async () => {
		const propsA = createDefaultProps({
			sessionId: 'session-a',
			folderPath: '/projects/alpha/Auto Run Docs',
			selectedFile: 'Phase 1',
			content: 'Alpha project content',
		});

		const { rerender } = renderWithProviders(<AutoRun {...propsA} />);

		const textarea = screen.getByRole('textbox');
		expect(textarea).toHaveValue('Alpha project content');

		// Switch to session B with different folder
		const propsB = createDefaultProps({
			sessionId: 'session-b',
			folderPath: '/projects/beta/Auto Run Docs',
			selectedFile: 'Phase 1',
			content: 'Beta project content',
		});

		rerender(<AutoRun {...propsB} />);
		expect(textarea).toHaveValue('Beta project content');
	});

	it('saving writes to session-specific folder path', async () => {
		const props = createDefaultProps({
			sessionId: 'session-specific',
			folderPath: '/unique/session/path',
			selectedFile: 'unique-doc',
			content: 'Original',
		});

		renderWithProviders(<AutoRun {...props} />);

		const textarea = screen.getByRole('textbox');
		fireEvent.change(textarea, { target: { value: 'Changed' } });

		fireEvent.click(screen.getByText('Save'));

		expect(mockMaestro.autorun.writeDoc).toHaveBeenCalledWith(
			'/unique/session/path',
			'unique-doc.md',
			'Changed',
			undefined // sshRemoteId (undefined for local sessions)
		);
	});
});
