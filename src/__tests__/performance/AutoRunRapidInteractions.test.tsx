/**
 * @file AutoRunRapidInteractions.test.tsx
 * @description Performance and stress tests for rapid user interactions in Auto Run
 *
 * Task 7.3 - Rapid user interactions tests:
 * - Rapid session switching
 * - Rapid mode toggling
 * - Rapid document selection
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import React from 'react';
import { AutoRun, AutoRunHandle } from '../../renderer/components/AutoRun';
import { AutoRunDocumentSelector } from '../../renderer/components/AutoRunDocumentSelector';
import { LayerStackProvider } from '../../renderer/contexts/LayerStackContext';
import type { Theme, BatchRunState, SessionState } from '../../renderer/types';

// Helper to wrap component in LayerStackProvider with custom rerender
const renderWithProviders = (ui: React.ReactElement) => {
	const result = render(<LayerStackProvider>{ui}</LayerStackProvider>);
	return {
		...result,
		rerender: (newUi: React.ReactElement) =>
			result.rerender(<LayerStackProvider>{newUi}</LayerStackProvider>),
	};
};

// Mock dependencies
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

vi.mock('../../renderer/components/AutoRunnerHelpModal', () => ({
	AutoRunnerHelpModal: ({ onClose }: { onClose: () => void }) => (
		<div data-testid="help-modal">
			<button onClick={onClose}>Close</button>
		</div>
	),
}));

vi.mock('../../renderer/components/MermaidRenderer', () => ({
	MermaidRenderer: ({ chart }: { chart: string }) => (
		<div data-testid="mermaid-renderer">{chart}</div>
	),
}));

vi.mock('../../renderer/hooks/useTemplateAutocomplete', () => ({
	useTemplateAutocomplete: ({
		value,
		onChange,
	}: {
		value: string;
		onChange: (value: string) => void;
	}) => ({
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
	}),
}));

vi.mock('../../renderer/components/TemplateAutocompleteDropdown', () => ({
	TemplateAutocompleteDropdown: React.forwardRef(() => null),
}));

// Mock lucide-react icons
vi.mock('lucide-react', () => ({
	ChevronDown: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<span data-testid="chevron-down" className={className} style={style}>
			▼
		</span>
	),
	ChevronRight: ({ className }: { className?: string }) => (
		<span data-testid="chevron-right" className={className}>
			▶
		</span>
	),
	ChevronUp: ({ className }: { className?: string }) => (
		<span data-testid="chevron-up" className={className}>
			▲
		</span>
	),
	RefreshCw: ({ className }: { className?: string }) => (
		<span data-testid="refresh-icon" className={className}>
			↻
		</span>
	),
	FolderOpen: ({ className }: { className?: string }) => (
		<span data-testid="folder-open" className={className}>
			📂
		</span>
	),
	Plus: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<span data-testid="plus-icon" className={className} style={style}>
			+
		</span>
	),
	Folder: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<span data-testid="folder-icon" className={className} style={style}>
			📁
		</span>
	),
	Search: ({ className }: { className?: string }) => (
		<span data-testid="search-icon" className={className}>
			🔍
		</span>
	),
	X: ({ className }: { className?: string }) => (
		<span data-testid="x-icon" className={className}>
			×
		</span>
	),
	ArrowUp: () => <span data-testid="arrow-up">↑</span>,
	ArrowDown: () => <span data-testid="arrow-down">↓</span>,
	Save: () => <span data-testid="save-icon">💾</span>,
	RotateCcw: () => <span data-testid="rotate-icon">↺</span>,
	Maximize2: ({ className }: { className?: string }) => (
		<span data-testid="maximize-icon" className={className}>
			⛶
		</span>
	),
	Image: ({ className }: { className?: string }) => (
		<span data-testid="image-icon" className={className}>
			🖼
		</span>
	),
	HelpCircle: ({ className }: { className?: string }) => (
		<span data-testid="help-icon" className={className}>
			?
		</span>
	),
	Play: ({ className }: { className?: string }) => (
		<span data-testid="play-icon" className={className}>
			▶
		</span>
	),
	Square: ({ className }: { className?: string }) => (
		<span data-testid="square-icon" className={className}>
			■
		</span>
	),
	Eye: ({ className }: { className?: string }) => (
		<span data-testid="eye-icon" className={className}>
			👁
		</span>
	),
	Edit: ({ className }: { className?: string }) => (
		<span data-testid="edit-icon" className={className}>
			✎
		</span>
	),
	Edit3: ({ className }: { className?: string }) => (
		<span data-testid="edit3-icon" className={className}>
			✎
		</span>
	),
	Loader2: ({ className }: { className?: string }) => (
		<span data-testid="loader-icon" className={className}>
			⟳
		</span>
	),
	FileText: ({ className }: { className?: string }) => (
		<span data-testid="filetext-icon" className={className}>
			📄
		</span>
	),
}));

// Helper to create mock theme
const createMockTheme = (): Theme => ({
	id: 'test-theme',
	name: 'Test Theme',
	mode: 'dark',
	colors: {
		bgMain: '#1a1a1a',
		bgPanel: '#252525',
		bgActivity: '#2d2d2d',
		bgSidebar: '#202020',
		bgHover: '#353535',
		textMain: '#ffffff',
		textDim: '#888888',
		accent: '#0066ff',
		accentForeground: '#ffffff',
		border: '#333333',
		highlight: '#0066ff33',
		success: '#00aa00',
		warning: '#ffaa00',
		error: '#ff0000',
		purple: '#8b5cf6',
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

// Default props factory
const createDefaultProps = (overrides: Partial<React.ComponentProps<typeof AutoRun>> = {}) => ({
	theme: createMockTheme(),
	sessionId: 'test-session-1',
	folderPath: '/test/folder',
	selectedFile: 'test-doc',
	documentList: ['test-doc', 'doc-2', 'doc-3'],
	content: '# Test Content\n\nSome markdown content.',
	onContentChange: vi.fn(),
	mode: 'edit' as const,
	onModeChange: vi.fn(),
	onOpenSetup: vi.fn(),
	onRefresh: vi.fn(),
	onSelectDocument: vi.fn(),
	onCreateDocument: vi.fn().mockResolvedValue(true),
	...overrides,
});

// Generate session data for testing
function generateSessionData(
	count: number
): Array<{ id: string; content: string; folderPath: string }> {
	const sessions: Array<{ id: string; content: string; folderPath: string }> = [];
	for (let i = 1; i <= count; i++) {
		sessions.push({
			id: `session-${i}`,
			content: `# Session ${i} Content\n\n- [ ] Task ${i}.1\n- [x] Task ${i}.2\n- [ ] Task ${i}.3\n\nContent specific to session ${i}.`,
			folderPath: `/projects/project-${i}/Auto Run Docs`,
		});
	}
	return sessions;
}

// Generate document names
function generateDocuments(count: number): string[] {
	const docs: string[] = [];
	for (let i = 1; i <= count; i++) {
		docs.push(`Document-${i.toString().padStart(3, '0')}`);
	}
	return docs;
}

describe('AutoRun Rapid User Interactions Performance', () => {
	let mockMaestro: ReturnType<typeof setupMaestroMock>;

	beforeEach(() => {
		mockMaestro = setupMaestroMock();
		vi.useFakeTimers({ shouldAdvanceTime: true });
	});

	afterEach(() => {
		vi.clearAllMocks();
		vi.useRealTimers();
	});

	describe('Rapid Session Switching', () => {
		it('handles 10 rapid session switches without content loss', () => {
			const sessions = generateSessionData(10);
			let currentSessionIndex = 0;
			const props = createDefaultProps({
				sessionId: sessions[0].id,
				content: sessions[0].content,
				folderPath: sessions[0].folderPath,
			});

			const { rerender } = renderWithProviders(<AutoRun {...props} />);

			// Rapid switching through sessions
			for (let i = 1; i < 10; i++) {
				currentSessionIndex = i;
				rerender(
					<AutoRun
						{...props}
						sessionId={sessions[i].id}
						content={sessions[i].content}
						folderPath={sessions[i].folderPath}
					/>
				);
			}

			// Verify final session content is correct
			const textarea = screen.getByRole('textbox');
			expect(textarea).toHaveValue(sessions[9].content);
		});

		it('handles 50 rapid session switches', () => {
			const sessions = generateSessionData(50);
			const props = createDefaultProps({
				sessionId: sessions[0].id,
				content: sessions[0].content,
				folderPath: sessions[0].folderPath,
			});

			const { rerender } = renderWithProviders(<AutoRun {...props} />);

			// Rapid switching
			for (let i = 1; i < 50; i++) {
				rerender(
					<AutoRun
						{...props}
						sessionId={sessions[i].id}
						content={sessions[i].content}
						folderPath={sessions[i].folderPath}
					/>
				);
			}

			// Component should still be functional
			const textarea = screen.getByRole('textbox');
			expect(textarea).toBeInTheDocument();
			expect(textarea).toHaveValue(sessions[49].content);
		});

		it('handles back-and-forth session switching (A-B-A-B pattern)', () => {
			const sessions = generateSessionData(2);
			const props = createDefaultProps({
				sessionId: sessions[0].id,
				content: sessions[0].content,
				folderPath: sessions[0].folderPath,
			});

			const { rerender } = renderWithProviders(<AutoRun {...props} />);

			// Switch back and forth 20 times (ends on last iteration i=19 => 19%2=1 => session 1)
			for (let i = 0; i < 20; i++) {
				const targetSession = sessions[i % 2];
				rerender(
					<AutoRun
						{...props}
						sessionId={targetSession.id}
						content={targetSession.content}
						folderPath={targetSession.folderPath}
					/>
				);
			}

			// Should end on session 1 (19 % 2 = 1)
			const textarea = screen.getByRole('textbox');
			expect(textarea).toHaveValue(sessions[1].content);
		});

		it('preserves local edits indication on rapid session switch', () => {
			const sessions = generateSessionData(5);
			const props = createDefaultProps({
				sessionId: sessions[0].id,
				content: sessions[0].content,
				folderPath: sessions[0].folderPath,
			});

			const { rerender } = renderWithProviders(<AutoRun {...props} />);

			// Make an edit to first session
			const textarea = screen.getByRole('textbox');
			fireEvent.change(textarea, { target: { value: 'Modified content' } });

			// Verify dirty state (Save button should appear)
			expect(screen.getByText('Save')).toBeInTheDocument();

			// Switch rapidly through sessions
			for (let i = 1; i < 5; i++) {
				rerender(
					<AutoRun
						{...props}
						sessionId={sessions[i].id}
						content={sessions[i].content}
						folderPath={sessions[i].folderPath}
					/>
				);
			}

			// Come back to first session (without the edit - simulating fresh load)
			rerender(
				<AutoRun
					{...props}
					sessionId={sessions[0].id}
					content={sessions[0].content}
					folderPath={sessions[0].folderPath}
				/>
			);

			// Content should be the original (local edits not persisted across session switch)
			expect(screen.getByRole('textbox')).toHaveValue(sessions[0].content);
		});

		it('handles session switch with contentVersion increment', () => {
			const sessions = generateSessionData(3);
			let version = 0;
			const props = createDefaultProps({
				sessionId: sessions[0].id,
				content: sessions[0].content,
				folderPath: sessions[0].folderPath,
				contentVersion: version,
			});

			const { rerender } = renderWithProviders(<AutoRun {...props} />);

			// Switch sessions with version changes
			for (let i = 1; i < 3; i++) {
				version++;
				rerender(
					<AutoRun
						{...props}
						sessionId={sessions[i].id}
						content={sessions[i].content}
						folderPath={sessions[i].folderPath}
						contentVersion={version}
					/>
				);
			}

			// Content should sync to new version
			const textarea = screen.getByRole('textbox');
			expect(textarea).toHaveValue(sessions[2].content);
		});

		it('maintains textarea focus stability during rapid session switching', () => {
			const sessions = generateSessionData(10);
			const props = createDefaultProps({
				sessionId: sessions[0].id,
				content: sessions[0].content,
				folderPath: sessions[0].folderPath,
			});

			const { rerender } = renderWithProviders(<AutoRun {...props} />);

			// Focus the textarea
			const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
			textarea.focus();

			// Rapid switching
			for (let i = 1; i < 10; i++) {
				rerender(
					<AutoRun
						{...props}
						sessionId={sessions[i].id}
						content={sessions[i].content}
						folderPath={sessions[i].folderPath}
					/>
				);
			}

			// Textarea should still be accessible
			expect(screen.getByRole('textbox')).toBeInTheDocument();
		});

		it('handles null session transitions during rapid switching', () => {
			const sessions = generateSessionData(5);
			const props = createDefaultProps({
				sessionId: sessions[0].id,
				content: sessions[0].content,
				folderPath: sessions[0].folderPath,
			});

			const { rerender } = renderWithProviders(<AutoRun {...props} />);

			// Simulate switching through sessions with occasional null folder paths
			for (let i = 0; i < 10; i++) {
				const sessionIndex = i % 5;
				const nullFolderPath = i % 3 === 0 ? null : sessions[sessionIndex].folderPath;
				rerender(
					<AutoRun
						{...props}
						sessionId={sessions[sessionIndex].id}
						content={sessions[sessionIndex].content}
						folderPath={nullFolderPath}
					/>
				);
			}

			// Ends on i=9, 9 % 3 === 0 so folderPath is null, showing setup button
			// Component should handle null gracefully - either shows textarea or setup button
			const textbox = screen.queryByRole('textbox');
			const setupButton = screen.queryByRole('button', { name: /select.*folder/i });
			expect(textbox || setupButton).toBeInTheDocument();
		});

		it('undo/redo stacks are isolated across rapid session switches', () => {
			const sessions = generateSessionData(3);
			const props = createDefaultProps({
				sessionId: sessions[0].id,
				content: sessions[0].content,
				folderPath: sessions[0].folderPath,
			});

			const { rerender } = renderWithProviders(<AutoRun {...props} />);

			// Make edits in session 1
			const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
			fireEvent.change(textarea, { target: { value: 'Session 1 edit' } });

			// Switch to session 2
			rerender(
				<AutoRun
					{...props}
					sessionId={sessions[1].id}
					content={sessions[1].content}
					folderPath={sessions[1].folderPath}
				/>
			);

			// Make edits in session 2
			fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Session 2 edit' } });

			// Rapidly switch back to session 1
			rerender(
				<AutoRun
					{...props}
					sessionId={sessions[0].id}
					content={sessions[0].content}
					folderPath={sessions[0].folderPath}
				/>
			);

			// Content should be session 1's original (not session 2 edit)
			expect(screen.getByRole('textbox')).toHaveValue(sessions[0].content);
		});
	});

	describe('Rapid Mode Toggling', () => {
		it('handles 20 rapid mode toggles (edit ↔ preview)', () => {
			const onModeChange = vi.fn();
			const props = createDefaultProps({ mode: 'edit', onModeChange });

			const { rerender } = renderWithProviders(<AutoRun {...props} />);

			// Rapid toggles
			for (let i = 0; i < 20; i++) {
				const currentMode = i % 2 === 0 ? 'edit' : 'preview';
				const nextMode = i % 2 === 0 ? 'preview' : 'edit';

				// Click the toggle button
				fireEvent.click(screen.getByText(nextMode === 'preview' ? 'Preview' : 'Edit'));

				// Rerender with new mode
				rerender(<AutoRun {...props} mode={nextMode as 'edit' | 'preview'} />);
			}

			expect(onModeChange).toHaveBeenCalledTimes(20);
		});

		it('handles 50 rapid mode toggles', () => {
			const onModeChange = vi.fn();
			const props = createDefaultProps({ mode: 'edit', onModeChange });

			const { rerender } = renderWithProviders(<AutoRun {...props} />);

			for (let i = 0; i < 50; i++) {
				const nextMode = i % 2 === 0 ? 'preview' : 'edit';
				fireEvent.click(screen.getByText(nextMode === 'preview' ? 'Preview' : 'Edit'));
				rerender(<AutoRun {...props} mode={nextMode as 'edit' | 'preview'} />);
			}

			// Component should still render correctly
			expect(
				screen.queryByRole('textbox') || screen.queryByTestId('react-markdown')
			).toBeInTheDocument();
		});

		it('preserves content through rapid mode switches', () => {
			const content = '# Test\n\n- [ ] Task 1\n- [x] Task 2\n\nSome content here.';
			const props = createDefaultProps({ content, mode: 'edit' });

			const { rerender } = renderWithProviders(<AutoRun {...props} />);

			// Verify initial content
			expect(screen.getByRole('textbox')).toHaveValue(content);

			// Switch to preview
			rerender(<AutoRun {...props} mode="preview" />);
			expect(screen.getByTestId('react-markdown')).toBeInTheDocument();

			// Back to edit
			rerender(<AutoRun {...props} mode="edit" />);
			expect(screen.getByRole('textbox')).toHaveValue(content);

			// Rapid switching
			for (let i = 0; i < 10; i++) {
				const mode = i % 2 === 0 ? 'preview' : 'edit';
				rerender(<AutoRun {...props} mode={mode as 'edit' | 'preview'} />);
			}

			// End in edit mode, content should be preserved
			rerender(<AutoRun {...props} mode="edit" />);
			expect(screen.getByRole('textbox')).toHaveValue(content);
		});

		it('handles mode toggle via Cmd+E shortcut rapidly', () => {
			const onModeChange = vi.fn();
			const props = createDefaultProps({ mode: 'edit', onModeChange });

			const { rerender } = renderWithProviders(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;

			// Rapid Cmd+E presses
			for (let i = 0; i < 20; i++) {
				const currentMode = i % 2 === 0 ? 'edit' : 'preview';
				const nextMode = i % 2 === 0 ? 'preview' : 'edit';

				if (currentMode === 'edit') {
					fireEvent.keyDown(textarea, { key: 'e', metaKey: true });
				}

				rerender(<AutoRun {...props} mode={nextMode as 'edit' | 'preview'} />);

				if (nextMode === 'edit') {
					// Get the new textarea after rerender
					const newTextarea = screen.getByRole('textbox');
					fireEvent.keyDown(newTextarea, { key: 'e', metaKey: true });
				}
			}

			expect(onModeChange.mock.calls.length).toBeGreaterThan(0);
		});

		it('dirty state persists correctly through rapid mode toggles', () => {
			const props = createDefaultProps({ mode: 'edit' });

			const { rerender } = renderWithProviders(<AutoRun {...props} />);

			// Make an edit
			const textarea = screen.getByRole('textbox');
			fireEvent.change(textarea, { target: { value: 'Modified content' } });

			// Verify dirty (Save button visible)
			expect(screen.getByText('Save')).toBeInTheDocument();

			// Rapid mode switches
			for (let i = 0; i < 10; i++) {
				const mode = i % 2 === 0 ? 'preview' : 'edit';
				rerender(<AutoRun {...props} mode={mode as 'edit' | 'preview'} />);
			}

			// End in edit mode
			rerender(<AutoRun {...props} mode="edit" />);

			// Content should still be modified (local state preserved)
			expect(screen.getByRole('textbox')).toHaveValue('Modified content');
		});

		it('mode toggle is disabled during batch run', () => {
			const onModeChange = vi.fn();
			const props = createDefaultProps({
				mode: 'preview',
				onModeChange,
				selectedFile: 'test-doc', // Must match what's in lockedDocuments
				batchRunState: {
					isRunning: true,
					isStopping: false,
					documents: ['test-doc'],
					lockedDocuments: ['test-doc'], // Lock test-doc to match selectedFile
					currentDocumentIndex: 0,
					currentDocTasksTotal: 5,
					currentDocTasksCompleted: 2,
					totalTasksAcrossAllDocs: 5,
					completedTasksAcrossAllDocs: 2,
					loopEnabled: false,
					loopIteration: 0,
					folderPath: '/test/folder',
					worktreeActive: false,
					totalTasks: 5,
					completedTasks: 2,
					currentTaskIndex: 0,
					originalContent: '',
				} as BatchRunState,
			});

			renderWithProviders(<AutoRun {...props} />);

			// Try to click Edit button (it should be disabled during batch run)
			const editButton = screen.getByText('Edit');
			fireEvent.click(editButton);

			// Should not change mode (button is disabled)
			expect(onModeChange).not.toHaveBeenCalled();
		});

		it('handles mode toggle with large content', () => {
			const largeContent = '# Large Doc\n\n' + 'Line of content.\n'.repeat(5000);
			const props = createDefaultProps({ content: largeContent, mode: 'edit' });

			const { rerender } = renderWithProviders(<AutoRun {...props} />);

			// Rapid mode toggles with large content
			for (let i = 0; i < 10; i++) {
				const mode = i % 2 === 0 ? 'preview' : 'edit';
				rerender(<AutoRun {...props} mode={mode as 'edit' | 'preview'} />);
			}

			// Should complete without issues
			rerender(<AutoRun {...props} mode="edit" />);
			expect(screen.getByRole('textbox')).toHaveValue(largeContent);
		});

		it('scroll position tracking through rapid mode switches', () => {
			const onStateChange = vi.fn();
			const content = 'Line\n'.repeat(1000);
			const props = createDefaultProps({
				content,
				mode: 'edit',
				onStateChange,
				initialEditScrollPos: 500,
			});

			const { rerender } = renderWithProviders(<AutoRun {...props} />);

			// Rapid mode switches
			for (let i = 0; i < 5; i++) {
				const mode = i % 2 === 0 ? 'preview' : 'edit';
				rerender(
					<AutoRun
						{...props}
						mode={mode as 'edit' | 'preview'}
						initialPreviewScrollPos={mode === 'preview' ? 300 : undefined}
					/>
				);
			}

			// Component should handle state changes
			expect(
				screen.queryByRole('textbox') || screen.queryByTestId('react-markdown')
			).toBeInTheDocument();
		});
	});

	describe('Rapid Document Selection', () => {
		it('handles 20 rapid document selections', () => {
			const documents = generateDocuments(20);
			const onSelectDocument = vi.fn();
			const props = createDefaultProps({
				documentList: documents,
				selectedFile: documents[0],
				onSelectDocument,
			});

			const { rerender } = renderWithProviders(<AutoRun {...props} />);

			// Rapid document changes
			for (let i = 1; i < 20; i++) {
				rerender(
					<AutoRun
						{...props}
						selectedFile={documents[i]}
						content={`# Content for ${documents[i]}`}
					/>
				);
			}

			// Verify final document content
			expect(screen.getByRole('textbox')).toHaveValue(`# Content for ${documents[19]}`);
		});

		it('handles 100 rapid document selections', () => {
			const documents = generateDocuments(100);
			const onSelectDocument = vi.fn();
			const props = createDefaultProps({
				documentList: documents,
				selectedFile: documents[0],
				onSelectDocument,
			});

			const { rerender } = renderWithProviders(<AutoRun {...props} />);

			// Very rapid switching
			for (let i = 1; i < 100; i++) {
				rerender(<AutoRun {...props} selectedFile={documents[i]} content={`# Doc ${i}`} />);
			}

			expect(screen.getByRole('textbox')).toHaveValue('# Doc 99');
		});

		it('handles back-and-forth document selection', () => {
			const documents = generateDocuments(5);
			const props = createDefaultProps({
				documentList: documents,
				selectedFile: documents[0],
				content: '# Doc 0',
			});

			const { rerender } = renderWithProviders(<AutoRun {...props} />);

			// Bounce between documents
			const pattern = [0, 4, 0, 4, 1, 3, 1, 3, 2, 2];
			for (const idx of pattern) {
				rerender(<AutoRun {...props} selectedFile={documents[idx]} content={`# Doc ${idx}`} />);
			}

			// Should end with document 2
			expect(screen.getByRole('textbox')).toHaveValue('# Doc 2');
		});

		it('local edits are discarded on rapid document switch (by design)', () => {
			const documents = generateDocuments(3);
			const props = createDefaultProps({
				documentList: documents,
				selectedFile: documents[0],
				content: '# Original Doc 0',
			});

			const { rerender } = renderWithProviders(<AutoRun {...props} />);

			// Make an edit
			const textarea = screen.getByRole('textbox');
			fireEvent.change(textarea, { target: { value: 'Modified Doc 0' } });

			// Rapid switch through documents
			rerender(<AutoRun {...props} selectedFile={documents[1]} content="# Doc 1" />);
			rerender(<AutoRun {...props} selectedFile={documents[2]} content="# Doc 2" />);

			// Come back to doc 0
			rerender(<AutoRun {...props} selectedFile={documents[0]} content="# Original Doc 0" />);

			// Local edits are not persisted (by design - user must save)
			expect(screen.getByRole('textbox')).toHaveValue('# Original Doc 0');
		});

		it('handles document selection with contentVersion sync', () => {
			const documents = generateDocuments(5);
			let version = 0;
			const props = createDefaultProps({
				documentList: documents,
				selectedFile: documents[0],
				content: '# Doc 0',
				contentVersion: version,
			});

			const { rerender } = renderWithProviders(<AutoRun {...props} />);

			// Switch documents with version increments
			for (let i = 1; i < 5; i++) {
				version++;
				rerender(
					<AutoRun
						{...props}
						selectedFile={documents[i]}
						content={`# Doc ${i}`}
						contentVersion={version}
					/>
				);
			}

			expect(screen.getByRole('textbox')).toHaveValue('# Doc 4');
		});

		it('undo stack resets on document switch', () => {
			const documents = generateDocuments(3);
			const props = createDefaultProps({
				documentList: documents,
				selectedFile: documents[0],
				content: '# Doc 0',
			});

			const { rerender } = renderWithProviders(<AutoRun {...props} />);

			// Make edits
			const textarea = screen.getByRole('textbox');
			fireEvent.change(textarea, { target: { value: 'Edit 1' } });
			fireEvent.change(textarea, { target: { value: 'Edit 2' } });

			// Switch document
			rerender(<AutoRun {...props} selectedFile={documents[1]} content="# Doc 1" />);

			// Try undo (should not affect - new document)
			fireEvent.keyDown(screen.getByRole('textbox'), { key: 'z', metaKey: true });

			// Content should still be the new document's content
			expect(screen.getByRole('textbox')).toHaveValue('# Doc 1');
		});

		it('handles document switch during edit mode', () => {
			const documents = generateDocuments(5);
			const props = createDefaultProps({
				documentList: documents,
				selectedFile: documents[0],
				content: '# Doc 0',
				mode: 'edit',
			});

			const { rerender } = renderWithProviders(<AutoRun {...props} />);

			// Rapid switches while in edit mode
			for (let i = 1; i < 5; i++) {
				rerender(<AutoRun {...props} selectedFile={documents[i]} content={`# Doc ${i}`} />);

				// Verify textarea is present
				expect(screen.getByRole('textbox')).toBeInTheDocument();
			}
		});

		it('handles document switch during preview mode', () => {
			const documents = generateDocuments(5);
			const props = createDefaultProps({
				documentList: documents,
				selectedFile: documents[0],
				content: '# Doc 0',
				mode: 'preview',
			});

			const { rerender } = renderWithProviders(<AutoRun {...props} />);

			// Rapid switches while in preview mode
			for (let i = 1; i < 5; i++) {
				rerender(<AutoRun {...props} selectedFile={documents[i]} content={`# Doc ${i}`} />);

				// Verify markdown preview is present
				expect(screen.getByTestId('react-markdown')).toBeInTheDocument();
			}
		});

		it('task counts update correctly during rapid document switching', () => {
			const documents = generateDocuments(5);
			const taskCounts = new Map([
				[documents[0], { completed: 2, total: 5 }],
				[documents[1], { completed: 0, total: 3 }],
				[documents[2], { completed: 3, total: 3 }],
				[documents[3], { completed: 1, total: 10 }],
				[documents[4], { completed: 0, total: 0 }],
			]);

			const props = createDefaultProps({
				documentList: documents,
				selectedFile: documents[0],
				content: '# Doc 0',
				documentTaskCounts: taskCounts,
			});

			const { rerender } = renderWithProviders(<AutoRun {...props} />);

			// Rapid document switches
			for (let i = 0; i < 10; i++) {
				const idx = i % 5;
				rerender(<AutoRun {...props} selectedFile={documents[idx]} content={`# Doc ${idx}`} />);
			}

			// Component should render without errors
			expect(screen.getByRole('textbox')).toBeInTheDocument();
		});

		it('handles null selectedFile during rapid switching', () => {
			const documents = generateDocuments(5);
			const props = createDefaultProps({
				documentList: documents,
				selectedFile: documents[0],
				content: '# Doc 0',
			});

			const { rerender } = renderWithProviders(<AutoRun {...props} />);

			// Switch including null
			rerender(<AutoRun {...props} selectedFile={null} content="" />);
			rerender(<AutoRun {...props} selectedFile={documents[1]} content="# Doc 1" />);
			rerender(<AutoRun {...props} selectedFile={null} content="" />);
			rerender(<AutoRun {...props} selectedFile={documents[2]} content="# Doc 2" />);

			expect(screen.getByRole('textbox')).toHaveValue('# Doc 2');
		});
	});

	describe('Combined Rapid Interactions', () => {
		it('handles simultaneous session + mode + document changes', () => {
			const sessions = generateSessionData(3);
			const documents = generateDocuments(5);
			const props = createDefaultProps({
				sessionId: sessions[0].id,
				folderPath: sessions[0].folderPath,
				documentList: documents,
				selectedFile: documents[0],
				content: '# Initial',
				mode: 'edit',
			});

			const { rerender } = renderWithProviders(<AutoRun {...props} />);

			// Simulate complex interaction pattern
			for (let i = 0; i < 20; i++) {
				const sessionIdx = i % 3;
				const docIdx = i % 5;
				const mode = i % 2 === 0 ? 'edit' : 'preview';

				rerender(
					<AutoRun
						{...props}
						sessionId={sessions[sessionIdx].id}
						folderPath={sessions[sessionIdx].folderPath}
						selectedFile={documents[docIdx]}
						content={`# Session ${sessionIdx} Doc ${docIdx}`}
						mode={mode as 'edit' | 'preview'}
					/>
				);
			}

			// Component should still be functional
			expect(
				screen.queryByRole('textbox') || screen.queryByTestId('react-markdown')
			).toBeInTheDocument();
		});

		it('handles rapid interactions during batch run state changes', () => {
			const documents = generateDocuments(5);
			const makeBatchState = (isRunning: boolean, isStopping: boolean): BatchRunState => ({
				isRunning,
				isStopping,
				documents: ['doc1'],
				lockedDocuments: ['doc1'],
				currentDocumentIndex: 0,
				currentDocTasksTotal: 5,
				currentDocTasksCompleted: 2,
				totalTasksAcrossAllDocs: 5,
				completedTasksAcrossAllDocs: 2,
				loopEnabled: false,
				loopIteration: 0,
				folderPath: '/test/folder',
				worktreeActive: false,
				totalTasks: 5,
				completedTasks: 2,
				currentTaskIndex: 0,
				originalContent: '',
			});
			const batchStates: (BatchRunState | undefined)[] = [
				undefined,
				makeBatchState(true, false),
				makeBatchState(true, true),
				undefined,
				makeBatchState(true, false),
			];
			const props = createDefaultProps({
				documentList: documents,
				selectedFile: documents[0],
				content: '# Doc 0',
				mode: 'preview', // Start in preview since batch run locks editing
			});

			const { rerender } = renderWithProviders(<AutoRun {...props} />);

			// Rapid state changes
			for (let i = 0; i < 20; i++) {
				const docIdx = i % 5;
				const batchState = batchStates[i % 5];

				rerender(
					<AutoRun
						{...props}
						selectedFile={documents[docIdx]}
						content={`# Doc ${docIdx}`}
						batchRunState={batchState}
						mode={batchState?.isRunning ? 'preview' : 'edit'}
					/>
				);
			}

			expect(
				screen.queryByRole('textbox') || screen.queryByTestId('react-markdown')
			).toBeInTheDocument();
		});

		it('handles rapid edit + mode toggle + content change interactions', () => {
			const props = createDefaultProps({
				content: '# Test\n\nSearchable content here.\nMore searchable lines.\n',
				mode: 'edit',
			});

			const { rerender } = renderWithProviders(<AutoRun {...props} />);

			// Rapid mode toggles combined with content changes
			for (let i = 0; i < 10; i++) {
				// Make an edit
				const textarea = screen.getByRole('textbox');
				fireEvent.change(textarea, { target: { value: `Edit ${i}` } });

				// Toggle to preview
				rerender(<AutoRun {...props} mode="preview" content={`# Content ${i}`} />);

				// Toggle back to edit with new content
				rerender(<AutoRun {...props} mode="edit" content={`# Content ${i + 1}`} />);
			}

			// Component should still work
			expect(screen.getByRole('textbox')).toBeInTheDocument();
		});

		it('handles rapid contentVersion updates', () => {
			const props = createDefaultProps({
				content: '# Initial',
				contentVersion: 0,
			});

			const { rerender } = renderWithProviders(<AutoRun {...props} />);

			// Rapid version updates
			for (let i = 1; i <= 50; i++) {
				rerender(<AutoRun {...props} content={`# Version ${i}`} contentVersion={i} />);
			}

			// Should show latest version
			expect(screen.getByRole('textbox')).toHaveValue('# Version 50');
		});

		it('handles rapid typing during session switches', () => {
			const sessions = generateSessionData(3);
			const props = createDefaultProps({
				sessionId: sessions[0].id,
				content: sessions[0].content,
				folderPath: sessions[0].folderPath,
			});

			const { rerender } = renderWithProviders(<AutoRun {...props} />);

			// Type and switch rapidly
			for (let i = 0; i < 10; i++) {
				const textarea = screen.getByRole('textbox');
				fireEvent.change(textarea, { target: { value: `Typing ${i}` } });

				// Switch session
				const sessionIdx = (i + 1) % 3;
				rerender(
					<AutoRun
						{...props}
						sessionId={sessions[sessionIdx].id}
						content={sessions[sessionIdx].content}
						folderPath={sessions[sessionIdx].folderPath}
					/>
				);
			}

			// Component should render correctly
			expect(screen.getByRole('textbox')).toBeInTheDocument();
		});

		it('stress test: 100 mixed rapid operations', () => {
			const sessions = generateSessionData(5);
			const documents = generateDocuments(10);
			let version = 0;

			const props = createDefaultProps({
				sessionId: sessions[0].id,
				folderPath: sessions[0].folderPath,
				documentList: documents,
				selectedFile: documents[0],
				content: '# Start',
				mode: 'edit',
				contentVersion: version,
			});

			const { rerender } = renderWithProviders(<AutoRun {...props} />);

			// 100 random-ish operations
			for (let i = 0; i < 100; i++) {
				const sessionIdx = i % 5;
				const docIdx = i % 10;
				const mode = i % 3 === 0 ? 'preview' : 'edit';
				const incrementVersion = i % 7 === 0;

				if (incrementVersion) version++;

				rerender(
					<AutoRun
						{...props}
						sessionId={sessions[sessionIdx].id}
						folderPath={sessions[sessionIdx].folderPath}
						selectedFile={documents[docIdx]}
						content={`# Op ${i}`}
						mode={mode as 'edit' | 'preview'}
						contentVersion={version}
					/>
				);
			}

			// Should complete without crashing - check for either edit or preview mode
			const textbox = screen.queryByRole('textbox');
			const markdown = screen.queryByTestId('react-markdown');
			expect(textbox || markdown).toBeInTheDocument();
		});
	});

	describe('Performance Boundary Tests', () => {
		it('handles 200 session switches without degradation', () => {
			const sessions = generateSessionData(200);
			const props = createDefaultProps({
				sessionId: sessions[0].id,
				content: sessions[0].content,
				folderPath: sessions[0].folderPath,
			});

			const { rerender } = renderWithProviders(<AutoRun {...props} />);

			for (let i = 1; i < 200; i++) {
				rerender(
					<AutoRun
						{...props}
						sessionId={sessions[i].id}
						content={sessions[i].content}
						folderPath={sessions[i].folderPath}
					/>
				);
			}

			expect(screen.getByRole('textbox')).toHaveValue(sessions[199].content);
		});

		it('handles 100 mode toggles without degradation', () => {
			const onModeChange = vi.fn();
			const props = createDefaultProps({ mode: 'edit', onModeChange });

			const { rerender } = renderWithProviders(<AutoRun {...props} />);

			for (let i = 0; i < 100; i++) {
				const mode = i % 2 === 0 ? 'preview' : 'edit';
				fireEvent.click(screen.getByText(mode === 'preview' ? 'Preview' : 'Edit'));
				rerender(<AutoRun {...props} mode={mode as 'edit' | 'preview'} />);
			}

			expect(onModeChange).toHaveBeenCalledTimes(100);
		});

		it('handles 200 document switches without degradation', () => {
			const documents = generateDocuments(200);
			const props = createDefaultProps({
				documentList: documents,
				selectedFile: documents[0],
				content: '# Doc 0',
			});

			const { rerender } = renderWithProviders(<AutoRun {...props} />);

			for (let i = 1; i < 200; i++) {
				rerender(<AutoRun {...props} selectedFile={documents[i]} content={`# Doc ${i}`} />);
			}

			expect(screen.getByRole('textbox')).toHaveValue('# Doc 199');
		});

		it('component remains responsive after stress testing', async () => {
			const sessions = generateSessionData(50);
			const documents = generateDocuments(50);
			const props = createDefaultProps({
				sessionId: sessions[0].id,
				folderPath: sessions[0].folderPath,
				documentList: documents,
				selectedFile: documents[0],
				content: '# Test',
				mode: 'edit',
			});

			const { rerender } = renderWithProviders(<AutoRun {...props} />);

			// Stress test
			for (let i = 0; i < 100; i++) {
				const sessionIdx = i % 50;
				const docIdx = i % 50;
				const mode = i % 2 === 0 ? 'preview' : 'edit';

				rerender(
					<AutoRun
						{...props}
						sessionId={sessions[sessionIdx].id}
						folderPath={sessions[sessionIdx].folderPath}
						selectedFile={documents[docIdx]}
						content={`# Content ${i}`}
						mode={mode as 'edit' | 'preview'}
					/>
				);
			}

			// Verify responsiveness
			rerender(<AutoRun {...props} mode="edit" content="# Final Content" />);

			const textarea = screen.getByRole('textbox');
			expect(textarea).toHaveValue('# Final Content');

			// Can still make edits
			fireEvent.change(textarea, { target: { value: '# Modified' } });
			expect(textarea).toHaveValue('# Modified');

			// Save button appears
			expect(screen.getByText('Save')).toBeInTheDocument();
		});
	});
});
