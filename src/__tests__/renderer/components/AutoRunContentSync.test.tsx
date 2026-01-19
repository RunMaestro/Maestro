/**
 * @file AutoRunContentSync.test.tsx
 * @description Tests for content synchronization race conditions in Auto Run
 *
 * These tests verify that:
 * 1. Async content loads don't overwrite local edits during active editing
 * 2. Local state is protected from stale prop updates during editing
 * 3. contentVersion forces sync from external file changes (disk watcher)
 * 4. Proper handling of rapid content prop changes during editing
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

describe('AutoRun Content Synchronization Race Conditions', () => {
	let mockMaestro: ReturnType<typeof setupMaestroMock>;

	beforeEach(() => {
		mockMaestro = setupMaestroMock();
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	describe('Async Content Load Protection', () => {
		it('preserves local edits when content prop changes without session/document change', async () => {
			// This simulates a parent component re-rendering with new content prop
			// but the user is actively editing - local edits should be preserved
			const props = createDefaultProps({
				content: 'Initial content from props',
				contentVersion: 1,
			});

			const { rerender } = renderWithProviders(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox');
			expect(textarea).toHaveValue('Initial content from props');

			// User starts typing local edits
			fireEvent.change(textarea, { target: { value: 'User typed this content' } });
			expect(textarea).toHaveValue('User typed this content');

			// Parent re-renders with different content but SAME contentVersion
			// (this could happen from various prop updates, state changes, etc.)
			rerender(
				<AutoRun {...props} content="Different content from async load" contentVersion={1} />
			);

			// Local edits should be preserved because contentVersion didn't change
			expect(textarea).toHaveValue('User typed this content');
		});

		it('overwrites local edits only when contentVersion changes (external file change)', async () => {
			const props = createDefaultProps({
				content: 'Initial content',
				contentVersion: 1,
			});

			const { rerender } = renderWithProviders(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox');
			fireEvent.change(textarea, { target: { value: 'User local edits' } });
			expect(textarea).toHaveValue('User local edits');

			// Simulate external file change - file watcher detected change, contentVersion bumped
			rerender(<AutoRun {...props} content="Externally modified content" contentVersion={2} />);

			// Now local edits should be overwritten
			expect(textarea).toHaveValue('Externally modified content');
		});

		it('handles rapid content prop updates during editing correctly', async () => {
			// Simulates a scenario where async operations cause multiple prop updates
			// while user is actively editing
			const props = createDefaultProps({
				content: 'Version 1',
				contentVersion: 1,
			});

			const { rerender } = renderWithProviders(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox');

			// User starts editing
			fireEvent.change(textarea, { target: { value: 'User editing in progress' } });

			// Multiple rapid prop updates without version change (stale prop delivery)
			rerender(<AutoRun {...props} content="Stale async update 1" contentVersion={1} />);
			rerender(<AutoRun {...props} content="Stale async update 2" contentVersion={1} />);
			rerender(<AutoRun {...props} content="Stale async update 3" contentVersion={1} />);

			// User edits should still be preserved
			expect(textarea).toHaveValue('User editing in progress');

			// Now a legitimate external change
			rerender(<AutoRun {...props} content="Real external change" contentVersion={2} />);
			expect(textarea).toHaveValue('Real external change');
		});

		it('syncs content when session changes even if contentVersion is same', async () => {
			// Session change should always reset content, regardless of contentVersion
			const props = createDefaultProps({
				sessionId: 'session-1',
				content: 'Session 1 content',
				contentVersion: 1,
			});

			const { rerender } = renderWithProviders(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox');
			fireEvent.change(textarea, { target: { value: 'Local edits in session 1' } });

			// Switch to different session (same contentVersion but different session)
			rerender(
				<AutoRun {...props} sessionId="session-2" content="Session 2 content" contentVersion={1} />
			);

			// Should show session 2 content, not local edits from session 1
			expect(textarea).toHaveValue('Session 2 content');
		});

		it('syncs content when document changes even if contentVersion is same', async () => {
			// Document change should always reset content
			const props = createDefaultProps({
				selectedFile: 'doc-1',
				content: 'Doc 1 content',
				contentVersion: 1,
			});

			const { rerender } = renderWithProviders(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox');
			fireEvent.change(textarea, { target: { value: 'Local edits in doc 1' } });

			// Switch to different document
			rerender(
				<AutoRun {...props} selectedFile="doc-2" content="Doc 2 content" contentVersion={1} />
			);

			// Should show doc 2 content
			expect(textarea).toHaveValue('Doc 2 content');
		});
	});

	describe('Local Edit State Protection During Async Updates', () => {
		it('maintains local state integrity during delayed prop propagation', async () => {
			// This tests the scenario where onContentChange callback is slow
			// and the parent state update causes a re-render with stale content
			const props = createDefaultProps({
				content: 'Original',
				contentVersion: 1,
			});

			const { rerender } = renderWithProviders(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox');

			// User types multiple characters
			fireEvent.change(textarea, { target: { value: 'O' } });
			fireEvent.change(textarea, { target: { value: 'Or' } });
			fireEvent.change(textarea, { target: { value: 'Ori' } });
			fireEvent.change(textarea, { target: { value: 'Orig' } });
			fireEvent.change(textarea, { target: { value: 'Origi' } });
			fireEvent.change(textarea, { target: { value: 'Origin' } });
			fireEvent.change(textarea, { target: { value: 'Origina' } });
			fireEvent.change(textarea, { target: { value: 'Original' } });
			fireEvent.change(textarea, { target: { value: 'Original ' } });
			fireEvent.change(textarea, { target: { value: 'Original E' } });
			fireEvent.change(textarea, { target: { value: 'Original Ed' } });
			fireEvent.change(textarea, { target: { value: 'Original Edi' } });
			fireEvent.change(textarea, { target: { value: 'Original Edit' } });
			fireEvent.change(textarea, { target: { value: 'Original Edits' } });

			// Stale prop arrives (from slow parent state update)
			rerender(<AutoRun {...props} content="O" contentVersion={1} />);

			// User's complete edits should still be in the textarea
			expect(textarea).toHaveValue('Original Edits');
		});

		it('protects local content when parent triggers multiple re-renders', async () => {
			const props = createDefaultProps({
				content: 'Start',
				contentVersion: 1,
			});

			const { rerender } = renderWithProviders(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox');

			// User types
			fireEvent.change(textarea, { target: { value: 'User typed content' } });

			// Parent re-renders for various reasons (e.g., other state changes)
			// but content prop stays stale from the initial load
			for (let i = 0; i < 10; i++) {
				rerender(<AutoRun {...props} content="Start" contentVersion={1} />);
			}

			// User's edits should remain
			expect(textarea).toHaveValue('User typed content');
		});

		it('preserves cursor position concept (local state not disrupted by props)', async () => {
			// While we can't easily test actual cursor position in jsdom,
			// we can verify the content remains stable and user edits are preserved
			const props = createDefaultProps({
				content: 'Hello World',
				contentVersion: 1,
			});

			const { rerender } = renderWithProviders(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox');

			// User edits in the middle of text
			fireEvent.change(textarea, { target: { value: 'Hello Beautiful World' } });

			// Multiple prop updates that shouldn't affect local state
			rerender(<AutoRun {...props} content="Hello World" contentVersion={1} />);
			rerender(<AutoRun {...props} content="Hello World" contentVersion={1} />);

			expect(textarea).toHaveValue('Hello Beautiful World');
		});
	});

	describe('contentVersion Force Sync Behavior', () => {
		it('increments in contentVersion trigger immediate content sync', async () => {
			const props = createDefaultProps({
				content: 'Version 1 content',
				contentVersion: 1,
			});

			const { rerender } = renderWithProviders(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox');
			fireEvent.change(textarea, { target: { value: 'Dirty local content' } });

			// Version bump forces sync
			rerender(<AutoRun {...props} content="Version 2 content" contentVersion={2} />);
			expect(textarea).toHaveValue('Version 2 content');

			// More edits
			fireEvent.change(textarea, { target: { value: 'More dirty content' } });

			// Another version bump
			rerender(<AutoRun {...props} content="Version 3 content" contentVersion={3} />);
			expect(textarea).toHaveValue('Version 3 content');
		});

		it('handles large contentVersion jumps correctly', async () => {
			const props = createDefaultProps({
				content: 'Initial',
				contentVersion: 1,
			});

			const { rerender } = renderWithProviders(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox');
			fireEvent.change(textarea, { target: { value: 'Local edits' } });

			// Large version jump (e.g., multiple rapid external changes)
			rerender(<AutoRun {...props} content="After many changes" contentVersion={100} />);
			expect(textarea).toHaveValue('After many changes');
		});

		it('contentVersion 0 is treated as valid version', async () => {
			const props = createDefaultProps({
				content: 'Content with version 0',
				contentVersion: 0,
			});

			const { rerender } = renderWithProviders(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox');
			expect(textarea).toHaveValue('Content with version 0');

			fireEvent.change(textarea, { target: { value: 'Local edits' } });

			// Version change from 0 to 1 should sync
			rerender(<AutoRun {...props} content="New content" contentVersion={1} />);
			expect(textarea).toHaveValue('New content');
		});

		it('undefined contentVersion defaults to 0 behavior', async () => {
			const props = createDefaultProps({
				content: 'Initial content',
				// contentVersion not specified (undefined)
			});

			const { rerender } = renderWithProviders(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox');
			fireEvent.change(textarea, { target: { value: 'Local edits' } });

			// Without contentVersion prop, content changes don't force sync
			rerender(<AutoRun {...props} content="New content from props" />);
			expect(textarea).toHaveValue('Local edits');
		});
	});

	describe('Dirty State and Save Consistency', () => {
		it('dirty state reflects actual difference between local and saved content', async () => {
			const ref = React.createRef<AutoRunHandle>();
			const props = createDefaultProps({
				content: 'Original saved content',
				contentVersion: 1,
			});

			renderWithProviders(<AutoRun {...props} ref={ref} />);

			// Initially not dirty
			expect(ref.current?.isDirty()).toBe(false);

			const textarea = screen.getByRole('textbox');
			fireEvent.change(textarea, { target: { value: 'Modified content' } });

			// Now dirty
			expect(ref.current?.isDirty()).toBe(true);

			// Type the same as original
			fireEvent.change(textarea, { target: { value: 'Original saved content' } });

			// Should no longer be dirty (content matches saved)
			expect(ref.current?.isDirty()).toBe(false);
		});

		it('save updates savedContent and clears dirty state', async () => {
			const ref = React.createRef<AutoRunHandle>();
			const props = createDefaultProps({
				content: 'Original',
				folderPath: '/test/path',
				selectedFile: 'my-doc',
			});

			renderWithProviders(<AutoRun {...props} ref={ref} />);

			const textarea = screen.getByRole('textbox');
			fireEvent.change(textarea, { target: { value: 'New content to save' } });

			expect(ref.current?.isDirty()).toBe(true);

			// Save
			await act(async () => {
				await ref.current?.save();
			});

			// Dirty state should be cleared
			expect(ref.current?.isDirty()).toBe(false);

			// Verify save was called with correct content
			expect(mockMaestro.autorun.writeDoc).toHaveBeenCalledWith(
				'/test/path',
				'my-doc.md',
				'New content to save',
				undefined // sshRemoteId (undefined for local sessions)
			);
		});

		it('revert restores savedContent and clears dirty state', async () => {
			const ref = React.createRef<AutoRunHandle>();
			const props = createDefaultProps({
				content: 'Original saved content',
			});

			renderWithProviders(<AutoRun {...props} ref={ref} />);

			const textarea = screen.getByRole('textbox');
			fireEvent.change(textarea, { target: { value: 'Dirty changes' } });

			expect(ref.current?.isDirty()).toBe(true);
			expect(textarea).toHaveValue('Dirty changes');

			// Revert - wrap in act since it causes state update
			await act(async () => {
				ref.current?.revert();
			});

			expect(ref.current?.isDirty()).toBe(false);
			expect(textarea).toHaveValue('Original saved content');
		});

		it('dirty state persists correctly through prop updates without version change', async () => {
			const ref = React.createRef<AutoRunHandle>();
			const props = createDefaultProps({
				content: 'Original',
				contentVersion: 1,
			});

			const { rerender } = renderWithProviders(<AutoRun {...props} ref={ref} />);

			const textarea = screen.getByRole('textbox');
			fireEvent.change(textarea, { target: { value: 'Dirty' } });

			expect(ref.current?.isDirty()).toBe(true);

			// Multiple rerenders with stale props
			rerender(<AutoRun {...props} ref={ref} content="Original" contentVersion={1} />);
			rerender(<AutoRun {...props} ref={ref} content="Original" contentVersion={1} />);

			// Dirty state should still be true
			expect(ref.current?.isDirty()).toBe(true);
			expect(textarea).toHaveValue('Dirty');
		});
	});

	describe('Edge Cases and Boundary Conditions', () => {
		it('handles empty content correctly', async () => {
			const props = createDefaultProps({
				content: '',
				contentVersion: 1,
			});

			const { rerender } = renderWithProviders(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox');
			expect(textarea).toHaveValue('');

			fireEvent.change(textarea, { target: { value: 'Adding content' } });
			expect(textarea).toHaveValue('Adding content');

			// Force sync with empty content
			rerender(<AutoRun {...props} content="" contentVersion={2} />);
			expect(textarea).toHaveValue('');
		});

		it('handles very long content sync correctly', async () => {
			// Use 500 chars - sufficient to test sync mechanism without jsdom performance issues
			const longContent = 'A'.repeat(500);
			const props = createDefaultProps({
				content: longContent,
				contentVersion: 1,
			});

			const { rerender } = renderWithProviders(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox');
			expect(textarea).toHaveValue(longContent);

			// Edit at the end
			const editedContent = longContent + ' EDITED';
			fireEvent.change(textarea, { target: { value: editedContent } });
			expect(textarea).toHaveValue(editedContent);

			// Force sync should still work
			const newLongContent = 'B'.repeat(500);
			rerender(<AutoRun {...props} content={newLongContent} contentVersion={2} />);
			expect(textarea).toHaveValue(newLongContent);
		});

		it('handles special characters and unicode in content', async () => {
			const specialContent =
				'# Hello 🌍\n\n`code` **bold** _italic_\n\n## 中文标题\n\nSpecial chars: < > & " \' / \\';
			const props = createDefaultProps({
				content: specialContent,
				contentVersion: 1,
			});

			const { rerender } = renderWithProviders(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox');
			expect(textarea).toHaveValue(specialContent);

			// Edit with more unicode
			const editedContent = specialContent + '\n\n## Added 日本語';
			fireEvent.change(textarea, { target: { value: editedContent } });

			// Force sync with different special content
			const newContent = '# 新内容 🎉\n\n- Bullet\n- Points';
			rerender(<AutoRun {...props} content={newContent} contentVersion={2} />);
			expect(textarea).toHaveValue(newContent);
		});

		it('handles whitespace-only content correctly', async () => {
			const props = createDefaultProps({
				content: '   \n\n   \t\t\n   ',
				contentVersion: 1,
			});

			const { rerender } = renderWithProviders(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox');
			expect(textarea).toHaveValue('   \n\n   \t\t\n   ');

			fireEvent.change(textarea, { target: { value: 'Real content now' } });

			// Force sync back to whitespace - use exact same string for comparison
			const whitespaceContent = '\n\n\n';
			rerender(<AutoRun {...props} content={whitespaceContent} contentVersion={2} />);
			expect(textarea.value).toBe(whitespaceContent);
		});

		it('handles simultaneous session and contentVersion change', async () => {
			const props = createDefaultProps({
				sessionId: 'session-1',
				content: 'Session 1 Content v1',
				contentVersion: 1,
			});

			const { rerender } = renderWithProviders(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox');
			fireEvent.change(textarea, { target: { value: 'Local edits' } });

			// Both session and version change at once
			rerender(
				<AutoRun
					{...props}
					sessionId="session-2"
					content="Session 2 Content v5"
					contentVersion={5}
				/>
			);

			expect(textarea).toHaveValue('Session 2 Content v5');
		});

		it('handles simultaneous document and contentVersion change', async () => {
			const props = createDefaultProps({
				selectedFile: 'doc-1',
				content: 'Doc 1 Content v1',
				contentVersion: 1,
			});

			const { rerender } = renderWithProviders(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox');
			fireEvent.change(textarea, { target: { value: 'Local edits' } });

			// Both document and version change at once
			rerender(
				<AutoRun {...props} selectedFile="doc-2" content="Doc 2 Content v3" contentVersion={3} />
			);

			expect(textarea).toHaveValue('Doc 2 Content v3');
		});
	});

	describe('Saved Content State Reset on Context Change', () => {
		it('savedContent resets when session changes', async () => {
			const ref = React.createRef<AutoRunHandle>();
			const props = createDefaultProps({
				sessionId: 'session-1',
				content: 'Session 1 saved content',
				contentVersion: 1,
			});

			const { rerender } = renderWithProviders(<AutoRun {...props} ref={ref} />);

			// Make dirty in session 1
			const textarea = screen.getByRole('textbox');
			fireEvent.change(textarea, { target: { value: 'Dirty in session 1' } });
			expect(ref.current?.isDirty()).toBe(true);

			// Switch to session 2
			rerender(<AutoRun {...props} ref={ref} sessionId="session-2" content="Session 2 content" />);

			// In session 2, content matches savedContent (from the content prop)
			expect(ref.current?.isDirty()).toBe(false);
			expect(textarea).toHaveValue('Session 2 content');

			// Make dirty in session 2
			fireEvent.change(textarea, { target: { value: 'Dirty in session 2' } });
			expect(ref.current?.isDirty()).toBe(true);

			// Revert should restore session 2's savedContent
			await act(async () => {
				ref.current?.revert();
			});
			expect(textarea).toHaveValue('Session 2 content');
		});

		it('savedContent resets when document changes', async () => {
			const ref = React.createRef<AutoRunHandle>();
			const props = createDefaultProps({
				selectedFile: 'doc-1',
				content: 'Doc 1 saved content',
				contentVersion: 1,
			});

			const { rerender } = renderWithProviders(<AutoRun {...props} ref={ref} />);

			// Make dirty
			const textarea = screen.getByRole('textbox');
			fireEvent.change(textarea, { target: { value: 'Dirty in doc 1' } });
			expect(ref.current?.isDirty()).toBe(true);

			// Switch document
			rerender(<AutoRun {...props} ref={ref} selectedFile="doc-2" content="Doc 2 content" />);

			// Should not be dirty in new document
			expect(ref.current?.isDirty()).toBe(false);
			expect(textarea).toHaveValue('Doc 2 content');
		});

		it('savedContent updates when contentVersion changes', async () => {
			const ref = React.createRef<AutoRunHandle>();
			const props = createDefaultProps({
				content: 'Original saved',
				contentVersion: 1,
			});

			const { rerender } = renderWithProviders(<AutoRun {...props} ref={ref} />);

			// Make dirty
			const textarea = screen.getByRole('textbox');
			fireEvent.change(textarea, { target: { value: 'Dirty content' } });
			expect(ref.current?.isDirty()).toBe(true);

			// External change forces sync
			rerender(<AutoRun {...props} ref={ref} content="Externally changed" contentVersion={2} />);

			// Now savedContent should be the new content, so not dirty
			expect(ref.current?.isDirty()).toBe(false);
			expect(textarea).toHaveValue('Externally changed');

			// Revert should restore to the new savedContent
			fireEvent.change(textarea, { target: { value: 'Make dirty again' } });
			await act(async () => {
				ref.current?.revert();
			});
			expect(textarea).toHaveValue('Externally changed');
		});
	});
});
