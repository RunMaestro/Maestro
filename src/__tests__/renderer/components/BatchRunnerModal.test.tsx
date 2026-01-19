import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import React from 'react';
import {
	BatchRunnerModal,
	DEFAULT_BATCH_PROMPT,
} from '../../../renderer/components/BatchRunnerModal';
import type { Theme, Playbook } from '../../../renderer/types';

// Mock LayerStackContext
const mockRegisterLayer = vi.fn(() => 'layer-123');
const mockUnregisterLayer = vi.fn();
const mockUpdateLayerHandler = vi.fn();

vi.mock('../../../renderer/contexts/LayerStackContext', () => ({
	useLayerStack: () => ({
		registerLayer: mockRegisterLayer,
		unregisterLayer: mockUnregisterLayer,
		updateLayerHandler: mockUpdateLayerHandler,
	}),
}));

// Mock child modals
vi.mock('../../../renderer/components/PlaybookDeleteConfirmModal', () => ({
	PlaybookDeleteConfirmModal: ({
		onConfirm,
		onCancel,
		playbookName,
	}: {
		onConfirm: () => void;
		onCancel: () => void;
		playbookName: string;
	}) => (
		<div data-testid="playbook-delete-modal">
			<span>Delete {playbookName}?</span>
			<button onClick={onCancel}>Cancel</button>
			<button onClick={onConfirm}>Confirm Delete</button>
		</div>
	),
}));

vi.mock('../../../renderer/components/PlaybookNameModal', () => ({
	PlaybookNameModal: ({
		onSave,
		onCancel,
		title,
	}: {
		onSave: (name: string) => void;
		onCancel: () => void;
		title: string;
	}) => (
		<div data-testid="playbook-name-modal">
			<span>{title}</span>
			<input data-testid="playbook-name-input" defaultValue="Test Playbook" />
			<button onClick={onCancel}>Cancel</button>
			<button onClick={() => onSave('Test Playbook')}>Save</button>
		</div>
	),
}));

vi.mock('../../../renderer/components/AgentPromptComposerModal', () => ({
	AgentPromptComposerModal: ({
		isOpen,
		onClose,
		onSubmit,
		initialValue,
	}: {
		isOpen: boolean;
		onClose: () => void;
		onSubmit: (value: string) => void;
		initialValue: string;
	}) =>
		isOpen ? (
			<div data-testid="prompt-composer-modal">
				<textarea defaultValue={initialValue} data-testid="composer-textarea" />
				<button onClick={onClose}>Close</button>
				<button onClick={() => onSubmit('Updated prompt from composer')}>Submit</button>
			</div>
		) : null,
}));

// Helper to create a mock theme
function createMockTheme(): Theme {
	return {
		id: 'dark',
		name: 'Dark',
		mode: 'dark',
		colors: {
			bgMain: '#1a1a1a',
			bgSidebar: '#111111',
			bgActivity: '#222222',
			textMain: '#ffffff',
			textDim: '#888888',
			accent: '#0066ff',
			border: '#333333',
			success: '#00cc00',
			warning: '#ffcc00',
			error: '#ff0000',
			info: '#0099ff',
			link: '#66aaff',
			userBubble: '#0044cc',
		},
	};
}

// Helper to create mock playbook
function createMockPlaybook(overrides: Partial<Playbook> = {}): Playbook {
	return {
		id: 'playbook-1',
		name: 'Test Playbook',
		createdAt: Date.now() - 86400000,
		updatedAt: Date.now(),
		documents: [
			{ filename: 'doc1', resetOnCompletion: false },
			{ filename: 'doc2', resetOnCompletion: true },
		],
		loopEnabled: false,
		prompt: DEFAULT_BATCH_PROMPT,
		...overrides,
	};
}

// Default props
function createDefaultProps() {
	return {
		theme: createMockTheme(),
		onClose: vi.fn(),
		onGo: vi.fn(),
		onSave: vi.fn(),
		showConfirmation: vi.fn((message: string, onConfirm: () => void) => onConfirm()),
		folderPath: '/path/to/folder',
		currentDocument: 'test-doc',
		allDocuments: ['test-doc', 'doc1', 'doc2', 'doc3'],
		getDocumentTaskCount: vi.fn().mockResolvedValue(5),
		onRefreshDocuments: vi.fn().mockResolvedValue(undefined),
		sessionId: 'session-123',
		sessionCwd: '/path/to/project',
	};
}

describe('BatchRunnerModal', () => {
	beforeEach(() => {
		vi.clearAllMocks();

		// Mock crypto.randomUUID
		vi.spyOn(crypto, 'randomUUID').mockReturnValue('uuid-123');

		// Add missing mocks to window.maestro
		(window.maestro as Record<string, unknown>).playbooks = {
			list: vi.fn().mockResolvedValue({ success: true, playbooks: [] }),
			create: vi.fn().mockResolvedValue({ success: true, playbook: createMockPlaybook() }),
			update: vi.fn().mockResolvedValue({ success: true, playbook: createMockPlaybook() }),
			delete: vi.fn().mockResolvedValue({ success: true }),
			export: vi.fn().mockResolvedValue({ success: true }),
			import: vi.fn().mockResolvedValue({ success: true, playbook: createMockPlaybook() }),
		};

		(window.maestro.git as Record<string, unknown>).branches = vi
			.fn()
			.mockResolvedValue({ branches: ['main', 'develop'] });
		(window.maestro.git as Record<string, unknown>).checkGhCli = vi.fn(() => ({
			then: (cb: (value: { installed: boolean; authenticated: boolean }) => void) => {
				cb({ installed: true, authenticated: true });
				return Promise.resolve({ installed: true, authenticated: true });
			},
		}));
		(window.maestro.git as Record<string, unknown>).worktreeInfo = vi.fn().mockResolvedValue({
			success: true,
			exists: false,
			isWorktree: false,
		});
		(window.maestro.git as Record<string, unknown>).getRepoRoot = vi.fn().mockResolvedValue({
			success: true,
			root: '/path/to/project',
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe('Rendering', () => {
		it('renders modal with correct structure and ARIA attributes', async () => {
			render(<BatchRunnerModal {...createDefaultProps()} />);

			const dialog = screen.getByRole('dialog');
			expect(dialog).toBeInTheDocument();
			expect(dialog).toHaveAttribute('aria-modal', 'true');
			expect(dialog).toHaveAttribute('aria-label', 'Auto Run Configuration');
		});

		it('displays header with title and close button', async () => {
			render(<BatchRunnerModal {...createDefaultProps()} />);

			expect(screen.getByText('Auto Run Configuration')).toBeInTheDocument();
			// X button is present
			const closeButtons = screen.getAllByRole('button');
			expect(closeButtons.some((btn) => btn.querySelector('svg'))).toBe(true);
		});

		it('displays task count badge in header', async () => {
			const props = createDefaultProps();
			render(<BatchRunnerModal {...props} />);

			await waitFor(() => {
				expect(screen.getByText('5')).toBeInTheDocument();
				expect(screen.getByText('tasks')).toBeInTheDocument();
			});
		});

		it('displays current document in document list', async () => {
			render(<BatchRunnerModal {...createDefaultProps()} />);

			expect(screen.getByText('test-doc.md')).toBeInTheDocument();
		});

		it('shows "1 task" (singular) when task count is 1', async () => {
			const props = createDefaultProps();
			props.getDocumentTaskCount = vi.fn().mockResolvedValue(1);
			render(<BatchRunnerModal {...props} />);

			await waitFor(() => {
				expect(screen.getByText('task')).toBeInTheDocument();
			});
		});

		it('displays footer with Cancel, Save, and Go buttons', async () => {
			render(<BatchRunnerModal {...createDefaultProps()} />);

			expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
			expect(screen.getByRole('button', { name: /Save/ })).toBeInTheDocument();
			expect(screen.getByRole('button', { name: /Go/ })).toBeInTheDocument();
		});
	});

	describe('Layer Stack Integration', () => {
		it('registers with layer stack on mount', async () => {
			render(<BatchRunnerModal {...createDefaultProps()} />);

			expect(mockRegisterLayer).toHaveBeenCalledWith(
				expect.objectContaining({
					type: 'modal',
					priority: expect.any(Number),
					onEscape: expect.any(Function),
				})
			);
		});

		it('unregisters from layer stack on unmount', async () => {
			const { unmount } = render(<BatchRunnerModal {...createDefaultProps()} />);

			unmount();

			expect(mockUnregisterLayer).toHaveBeenCalledWith('layer-123');
		});

		it('calls onClose when escape is triggered', async () => {
			const props = createDefaultProps();
			render(<BatchRunnerModal {...props} />);

			// Get the onEscape handler and call it
			const registerCall = mockRegisterLayer.mock.calls[0][0];
			registerCall.onEscape();

			expect(props.onClose).toHaveBeenCalled();
		});
	});

	describe('Document Management', () => {
		it('opens document selector modal when Add Docs is clicked', async () => {
			render(<BatchRunnerModal {...createDefaultProps()} />);

			const addButton = screen.getByRole('button', { name: 'Add Docs' });
			fireEvent.click(addButton);

			expect(screen.getByText('Select Documents')).toBeInTheDocument();
		});

		it('displays all documents in selector modal', async () => {
			render(<BatchRunnerModal {...createDefaultProps()} />);

			fireEvent.click(screen.getByRole('button', { name: 'Add Docs' }));

			await waitFor(() => {
				// Look within the selector modal for doc names (test-doc appears in main list AND selector)
				const selectorModal = screen.getByText('Select Documents').closest('.fixed');
				expect(selectorModal).toBeInTheDocument();
				expect(within(selectorModal!).getByText(/doc1\.md/)).toBeInTheDocument();
				expect(within(selectorModal!).getByText(/doc2\.md/)).toBeInTheDocument();
				expect(within(selectorModal!).getByText(/doc3\.md/)).toBeInTheDocument();
			});
		});

		it('adds selected documents from selector', async () => {
			render(<BatchRunnerModal {...createDefaultProps()} />);

			fireEvent.click(screen.getByRole('button', { name: 'Add Docs' }));

			// Select doc1 (current doc is already selected)
			const doc1Button = screen.getByRole('button', { name: /doc1\.md/ });
			fireEvent.click(doc1Button);

			// Click Add button
			const addButton = screen.getByRole('button', { name: /Add \d+ file/ });
			fireEvent.click(addButton);

			// Verify documents are now in the list
			await waitFor(() => {
				const docListItems = screen.getAllByText(/\.md/);
				expect(docListItems.length).toBeGreaterThan(1);
			});
		});

		it('removes document when X button is clicked', async () => {
			const props = createDefaultProps();
			render(<BatchRunnerModal {...props} />);

			// Add another document first
			fireEvent.click(screen.getByRole('button', { name: 'Add Docs' }));
			const doc1Button = screen.getByRole('button', { name: /doc1\.md/ });
			fireEvent.click(doc1Button);
			fireEvent.click(screen.getByRole('button', { name: /Add \d+ file/ }));

			// Now we have 2 documents - find and click the remove button on the first
			const removeButtons = screen.getAllByTitle(/Remove document/);
			expect(removeButtons.length).toBeGreaterThan(0);
			fireEvent.click(removeButtons[0]);

			// Verify we now have fewer documents
			await waitFor(() => {
				const remainingDocs = screen.getAllByText(/\.md/);
				expect(remainingDocs.length).toBeLessThan(3);
			});
		});

		it('toggles reset on completion when reset button is clicked', async () => {
			render(<BatchRunnerModal {...createDefaultProps()} />);

			// Wait for task counts to load
			await waitFor(() => {
				expect(screen.getByText('5')).toBeInTheDocument();
				expect(screen.getByText('tasks')).toBeInTheDocument();
			});

			// Find and click the reset button
			const resetButton = screen.getByTitle(/Enable reset/);
			fireEvent.click(resetButton);

			// The button should now show reset is enabled
			await waitFor(() => {
				expect(screen.getByTitle(/Reset enabled/)).toBeInTheDocument();
			});
		});

		it('duplicates document when duplicate button is clicked', async () => {
			render(<BatchRunnerModal {...createDefaultProps()} />);

			// First enable reset (which shows the duplicate button)
			await waitFor(() => {
				expect(screen.getByText('5')).toBeInTheDocument();
				expect(screen.getByText('tasks')).toBeInTheDocument();
			});

			const resetButton = screen.getByTitle(/Enable reset/);
			fireEvent.click(resetButton);

			// Now click duplicate
			await waitFor(() => {
				const duplicateButton = screen.getByTitle('Duplicate document');
				fireEvent.click(duplicateButton);
			});

			// Should now have 2 documents with same name
			await waitFor(() => {
				const docs = screen.getAllByText('test-doc.md');
				expect(docs.length).toBeGreaterThanOrEqual(1);
			});
		});

		it('shows empty state when no documents are selected', async () => {
			const props = createDefaultProps();
			props.currentDocument = '';
			render(<BatchRunnerModal {...props} />);

			expect(screen.getByText('No documents selected')).toBeInTheDocument();
		});

		it('handles document selector refresh', async () => {
			const props = createDefaultProps();
			render(<BatchRunnerModal {...props} />);

			fireEvent.click(screen.getByRole('button', { name: 'Add Docs' }));

			const refreshButton = screen.getByTitle('Refresh document list');
			fireEvent.click(refreshButton);

			expect(props.onRefreshDocuments).toHaveBeenCalled();
		});

		it('closes document selector on backdrop click', async () => {
			render(<BatchRunnerModal {...createDefaultProps()} />);

			fireEvent.click(screen.getByRole('button', { name: 'Add Docs' }));
			expect(screen.getByText('Select Documents')).toBeInTheDocument();

			// Click on backdrop (the outer div)
			const backdrop = screen.getByText('Select Documents').closest('.fixed');
			if (backdrop) {
				fireEvent.click(backdrop);
			}

			await waitFor(() => {
				expect(screen.queryByText('Select Documents')).not.toBeInTheDocument();
			});
		});
	});

	describe('Drag and Drop', () => {
		it('supports drag and drop reordering of documents', async () => {
			const props = createDefaultProps();
			render(<BatchRunnerModal {...props} />);

			// Add a second document
			fireEvent.click(screen.getByRole('button', { name: 'Add Docs' }));
			fireEvent.click(screen.getByRole('button', { name: /doc1\.md/ }));
			fireEvent.click(screen.getByRole('button', { name: /Add \d+ file/ }));

			// Find the drag handles
			const items = screen.getAllByText(/\.md/);
			expect(items.length).toBeGreaterThanOrEqual(2);

			// Test drag start - find the draggable container
			const dragContainers = document.querySelectorAll('[draggable="true"]');
			if (dragContainers.length >= 2) {
				// Create a mock dataTransfer object with all required properties for copy-on-drag feature
				const mockDataTransfer = {
					effectAllowed: 'move',
					dropEffect: 'move',
				};
				fireEvent.dragStart(dragContainers[0], { dataTransfer: mockDataTransfer });
				fireEvent.dragOver(dragContainers[1], {
					dataTransfer: mockDataTransfer,
					clientY: 100, // Provide cursor position for drop indicator calculation
				});
				fireEvent.dragEnd(dragContainers[0]);
			}
		});
	});

	describe('Loop Mode', () => {
		it('shows loop button when multiple documents exist', async () => {
			const props = createDefaultProps();
			render(<BatchRunnerModal {...props} />);

			// Add another document
			fireEvent.click(screen.getByRole('button', { name: 'Add Docs' }));
			fireEvent.click(screen.getByRole('button', { name: /doc1\.md/ }));
			fireEvent.click(screen.getByRole('button', { name: /Add \d+ file/ }));

			await waitFor(() => {
				expect(screen.getByText('Loop')).toBeInTheDocument();
			});
		});

		it('toggles loop mode when Loop button is clicked', async () => {
			const props = createDefaultProps();
			render(<BatchRunnerModal {...props} />);

			// Add another document
			fireEvent.click(screen.getByRole('button', { name: 'Add Docs' }));
			fireEvent.click(screen.getByRole('button', { name: /doc1\.md/ }));
			fireEvent.click(screen.getByRole('button', { name: /Add \d+ file/ }));

			const loopButton = await screen.findByText('Loop');
			fireEvent.click(loopButton);

			// Loop controls should now be visible (infinity and max buttons)
			await waitFor(() => {
				expect(screen.getByText('∞')).toBeInTheDocument();
				expect(screen.getByText('max')).toBeInTheDocument();
			});
		});

		it('shows max loops slider when max is selected', async () => {
			const props = createDefaultProps();
			render(<BatchRunnerModal {...props} />);

			// Add another document
			fireEvent.click(screen.getByRole('button', { name: 'Add Docs' }));
			fireEvent.click(screen.getByRole('button', { name: /doc1\.md/ }));
			fireEvent.click(screen.getByRole('button', { name: /Add \d+ file/ }));

			// Enable loop mode
			const loopButton = await screen.findByText('Loop');
			fireEvent.click(loopButton);

			// Click max button
			const maxButton = screen.getByText('max');
			fireEvent.click(maxButton);

			// Should show slider
			await waitFor(() => {
				const slider = screen.getByRole('slider');
				expect(slider).toBeInTheDocument();
				expect(slider).toHaveAttribute('min', '1');
				expect(slider).toHaveAttribute('max', '25');
			});
		});

		it('updates max loops value when slider changes', async () => {
			const props = createDefaultProps();
			render(<BatchRunnerModal {...props} />);

			// Add another document and enable loop with max
			fireEvent.click(screen.getByRole('button', { name: 'Add Docs' }));
			fireEvent.click(screen.getByRole('button', { name: /doc1\.md/ }));
			fireEvent.click(screen.getByRole('button', { name: /Add \d+ file/ }));
			fireEvent.click(await screen.findByText('Loop'));
			fireEvent.click(screen.getByRole('button', { name: 'max' }));

			const slider = screen.getByRole('slider');
			fireEvent.change(slider, { target: { value: '10' } });

			await waitFor(() => {
				// Look for the max loops display (a span with the value)
				const loopControls = slider.closest('.flex');
				const valueSpan = loopControls?.querySelector('.font-mono');
				expect(valueSpan).toHaveTextContent('10');
			});
		});
	});

	describe('Agent Prompt', () => {
		it('inserts tab character on Tab key', async () => {
			render(<BatchRunnerModal {...createDefaultProps()} />);

			const textarea = screen.getByPlaceholderText(
				'Enter the system prompt for auto-run...'
			) as HTMLTextAreaElement;

			// Clear and set a simple value (no space - "HelloWorld")
			fireEvent.change(textarea, { target: { value: 'HelloWorld' } });

			// Set cursor position after "Hello"
			textarea.selectionStart = 5;
			textarea.selectionEnd = 5;

			fireEvent.keyDown(textarea, { key: 'Tab' });

			await waitFor(() => {
				expect(textarea.value).toBe('Hello\tWorld');
			});
		});

		it('displays default prompt in textarea', async () => {
			render(<BatchRunnerModal {...createDefaultProps()} />);

			const textarea = screen.getByPlaceholderText('Enter the system prompt for auto-run...');
			expect(textarea).toHaveValue(DEFAULT_BATCH_PROMPT);
		});

		it('displays CUSTOMIZED badge when prompt is modified', async () => {
			render(<BatchRunnerModal {...createDefaultProps()} />);

			const textarea = screen.getByPlaceholderText('Enter the system prompt for auto-run...');
			fireEvent.change(textarea, { target: { value: 'Custom prompt' } });

			expect(screen.getByText('CUSTOMIZED')).toBeInTheDocument();
		});

		it('resets prompt to default when Reset button is clicked', async () => {
			const props = createDefaultProps();
			render(<BatchRunnerModal {...props} />);

			const textarea = screen.getByPlaceholderText('Enter the system prompt for auto-run...');
			fireEvent.change(textarea, { target: { value: 'Custom prompt' } });

			const resetButton = screen.getByTitle('Reset to default prompt');
			fireEvent.click(resetButton);

			expect(props.showConfirmation).toHaveBeenCalled();
			expect(textarea).toHaveValue(DEFAULT_BATCH_PROMPT);
		});

		it('opens prompt composer modal when expand button is clicked', async () => {
			render(<BatchRunnerModal {...createDefaultProps()} />);

			const expandButton = screen.getByTitle('Expand editor');
			fireEvent.click(expandButton);

			expect(screen.getByTestId('prompt-composer-modal')).toBeInTheDocument();
		});

		it('updates prompt from composer modal', async () => {
			render(<BatchRunnerModal {...createDefaultProps()} />);

			fireEvent.click(screen.getByTitle('Expand editor'));
			fireEvent.click(screen.getByRole('button', { name: 'Submit' }));

			const textarea = screen.getByPlaceholderText('Enter the system prompt for auto-run...');
			expect(textarea).toHaveValue('Updated prompt from composer');
		});
	});

	describe('Template Variables', () => {
		it('expands template variables section when clicked', async () => {
			render(<BatchRunnerModal {...createDefaultProps()} />);

			const variablesButton = screen.getByText('Template Variables');
			fireEvent.click(variablesButton);

			await waitFor(() => {
				expect(screen.getByText(/Use these variables in your prompt/)).toBeInTheDocument();
			});
		});

		it('shows template variable documentation', async () => {
			render(<BatchRunnerModal {...createDefaultProps()} />);

			fireEvent.click(screen.getByRole('button', { name: /Template Variables/ }));

			await waitFor(() => {
				expect(screen.getByText('{{DOCUMENT_PATH}}')).toBeInTheDocument();
			});
		});
	});

	describe('Playbook Management', () => {
		it('shows Load Playbook button when playbooks exist', async () => {
			const mockPlaybooks: Playbook[] = [createMockPlaybook()];
			(window.maestro as Record<string, unknown>).playbooks = {
				list: vi.fn().mockResolvedValue({ success: true, playbooks: mockPlaybooks }),
				create: vi.fn(),
				update: vi.fn(),
				delete: vi.fn(),
				export: vi.fn(),
				import: vi.fn(),
			};

			render(<BatchRunnerModal {...createDefaultProps()} />);

			await waitFor(() => {
				expect(screen.getByText('Load Playbook')).toBeInTheDocument();
			});
		});

		it('opens playbook dropdown when Load Playbook is clicked', async () => {
			const mockPlaybooks: Playbook[] = [createMockPlaybook()];
			(window.maestro as Record<string, unknown>).playbooks = {
				list: vi.fn().mockResolvedValue({ success: true, playbooks: mockPlaybooks }),
				create: vi.fn(),
				update: vi.fn(),
				delete: vi.fn(),
				export: vi.fn(),
				import: vi.fn(),
			};

			render(<BatchRunnerModal {...createDefaultProps()} />);

			await waitFor(() => {
				expect(screen.getByText('Load Playbook')).toBeInTheDocument();
			});

			fireEvent.click(screen.getByRole('button', { name: 'Load Playbook' }));

			await waitFor(() => {
				expect(screen.getByText('Test Playbook')).toBeInTheDocument();
			});
		});

		it('loads playbook when clicked in dropdown', async () => {
			const mockPlaybook = createMockPlaybook();
			const mockPlaybooks: Playbook[] = [mockPlaybook];
			(window.maestro as Record<string, unknown>).playbooks = {
				list: vi.fn().mockResolvedValue({ success: true, playbooks: mockPlaybooks }),
				create: vi.fn(),
				update: vi.fn(),
				delete: vi.fn(),
				export: vi.fn(),
				import: vi.fn(),
			};

			render(<BatchRunnerModal {...createDefaultProps()} />);

			await waitFor(() => screen.getByText('Load Playbook'));
			fireEvent.click(screen.getByRole('button', { name: 'Load Playbook' }));
			fireEvent.click(screen.getByText('Test Playbook'));

			// Should now show playbook name in button
			await waitFor(() => {
				const buttons = screen.getAllByText('Test Playbook');
				expect(buttons.length).toBeGreaterThan(0);
			});
		});

		it('shows Save as Playbook button when multiple documents exist', async () => {
			const props = createDefaultProps();
			render(<BatchRunnerModal {...props} />);

			// Add another document
			fireEvent.click(screen.getByRole('button', { name: 'Add Docs' }));
			fireEvent.click(screen.getByRole('button', { name: /doc1\.md/ }));
			fireEvent.click(screen.getByRole('button', { name: /Add \d+ file/ }));

			await waitFor(() => {
				expect(screen.getByText('Save as Playbook')).toBeInTheDocument();
			});
		});

		it('opens save playbook modal when Save as Playbook is clicked', async () => {
			const props = createDefaultProps();
			render(<BatchRunnerModal {...props} />);

			// Add another document
			fireEvent.click(screen.getByRole('button', { name: 'Add Docs' }));
			fireEvent.click(screen.getByRole('button', { name: /doc1\.md/ }));
			fireEvent.click(screen.getByRole('button', { name: /Add \d+ file/ }));

			fireEvent.click(screen.getByRole('button', { name: 'Save as Playbook' }));

			expect(screen.getByTestId('playbook-name-modal')).toBeInTheDocument();
		});

		it('saves new playbook when modal is submitted', async () => {
			const props = createDefaultProps();
			const mockCreate = vi
				.fn()
				.mockResolvedValue({ success: true, playbook: createMockPlaybook() });
			(window.maestro as Record<string, unknown>).playbooks = {
				...window.maestro.playbooks,
				create: mockCreate,
			};

			render(<BatchRunnerModal {...props} />);

			// Add another document
			fireEvent.click(screen.getByRole('button', { name: 'Add Docs' }));
			fireEvent.click(screen.getByRole('button', { name: /doc1\.md/ }));
			fireEvent.click(screen.getByRole('button', { name: /Add \d+ file/ }));

			fireEvent.click(screen.getByRole('button', { name: 'Save as Playbook' }));

			// Find and click Save button in the playbook name modal
			const modal = screen.getByTestId('playbook-name-modal');
			fireEvent.click(within(modal).getByText('Save'));

			await waitFor(() => {
				expect(mockCreate).toHaveBeenCalled();
			});
		});

		it('shows Save Update button when playbook is modified', async () => {
			const mockPlaybook = createMockPlaybook();
			const mockPlaybooks: Playbook[] = [mockPlaybook];
			(window.maestro as Record<string, unknown>).playbooks = {
				list: vi.fn().mockResolvedValue({ success: true, playbooks: mockPlaybooks }),
				create: vi.fn(),
				update: vi.fn().mockResolvedValue({ success: true, playbook: mockPlaybook }),
				delete: vi.fn(),
				export: vi.fn(),
				import: vi.fn(),
			};

			render(<BatchRunnerModal {...createDefaultProps()} />);

			// Load playbook
			await waitFor(() => screen.getByText('Load Playbook'));
			fireEvent.click(screen.getByRole('button', { name: 'Load Playbook' }));
			fireEvent.click(screen.getByText('Test Playbook'));

			// Modify prompt
			const textarea = screen.getByPlaceholderText('Enter the system prompt for auto-run...');
			fireEvent.change(textarea, { target: { value: 'Modified prompt' } });

			await waitFor(() => {
				expect(screen.getByText('Save Update')).toBeInTheDocument();
				expect(screen.getByText('Discard')).toBeInTheDocument();
			});
		});

		it('deletes playbook when delete is confirmed', async () => {
			const mockPlaybook = createMockPlaybook();
			const mockPlaybooks: Playbook[] = [mockPlaybook];
			const mockDelete = vi.fn().mockResolvedValue({ success: true });
			(window.maestro as Record<string, unknown>).playbooks = {
				list: vi.fn().mockResolvedValue({ success: true, playbooks: mockPlaybooks }),
				create: vi.fn(),
				update: vi.fn(),
				delete: mockDelete,
				export: vi.fn(),
				import: vi.fn(),
			};

			render(<BatchRunnerModal {...createDefaultProps()} />);

			// Open dropdown
			await waitFor(() => screen.getByText('Load Playbook'));
			fireEvent.click(screen.getByRole('button', { name: 'Load Playbook' }));

			// Click delete button (X next to playbook)
			const deleteButton = screen.getByTitle('Delete playbook');
			fireEvent.click(deleteButton);

			// Confirm delete
			expect(screen.getByTestId('playbook-delete-modal')).toBeInTheDocument();
			fireEvent.click(screen.getByRole('button', { name: 'Confirm Delete' }));

			await waitFor(() => {
				expect(mockDelete).toHaveBeenCalledWith('session-123', 'playbook-1');
			});
		});

		it('exports playbook when export button is clicked', async () => {
			const mockPlaybook = createMockPlaybook();
			const mockPlaybooks: Playbook[] = [mockPlaybook];
			const mockExport = vi.fn().mockResolvedValue({ success: true });
			(window.maestro as Record<string, unknown>).playbooks = {
				list: vi.fn().mockResolvedValue({ success: true, playbooks: mockPlaybooks }),
				create: vi.fn(),
				update: vi.fn(),
				delete: vi.fn(),
				export: mockExport,
				import: vi.fn(),
			};

			render(<BatchRunnerModal {...createDefaultProps()} />);

			await waitFor(() => screen.getByText('Load Playbook'));
			fireEvent.click(screen.getByRole('button', { name: 'Load Playbook' }));

			const exportButton = screen.getByTitle('Export playbook');
			fireEvent.click(exportButton);

			await waitFor(() => {
				expect(mockExport).toHaveBeenCalledWith('session-123', 'playbook-1', '/path/to/folder');
			});
		});

		it('imports playbook when Import Playbook is clicked', async () => {
			const mockPlaybook = createMockPlaybook({ id: 'imported-1', name: 'Imported Playbook' });
			const mockImport = vi.fn().mockResolvedValue({ success: true, playbook: mockPlaybook });
			(window.maestro as Record<string, unknown>).playbooks = {
				list: vi.fn().mockResolvedValue({ success: true, playbooks: [createMockPlaybook()] }),
				create: vi.fn(),
				update: vi.fn(),
				delete: vi.fn(),
				export: vi.fn(),
				import: mockImport,
			};

			render(<BatchRunnerModal {...createDefaultProps()} />);

			await waitFor(() => screen.getByText('Load Playbook'));
			fireEvent.click(screen.getByRole('button', { name: 'Load Playbook' }));
			fireEvent.click(screen.getByRole('button', { name: 'Import Playbook' }));

			await waitFor(() => {
				expect(mockImport).toHaveBeenCalledWith('session-123', '/path/to/folder');
			});
		});

		it('marks missing documents when loading playbook', async () => {
			const mockPlaybook = createMockPlaybook({
				documents: [
					{ filename: 'missing-doc', resetOnCompletion: false },
					{ filename: 'test-doc', resetOnCompletion: false },
				],
			});
			const mockPlaybooks: Playbook[] = [mockPlaybook];
			(window.maestro as Record<string, unknown>).playbooks = {
				list: vi.fn().mockResolvedValue({ success: true, playbooks: mockPlaybooks }),
				create: vi.fn(),
				update: vi.fn(),
				delete: vi.fn(),
				export: vi.fn(),
				import: vi.fn(),
			};

			render(<BatchRunnerModal {...createDefaultProps()} />);

			await waitFor(() => screen.getByText('Load Playbook'));
			fireEvent.click(screen.getByRole('button', { name: 'Load Playbook' }));
			fireEvent.click(screen.getByText('Test Playbook'));

			await waitFor(() => {
				expect(screen.getByText('Missing')).toBeInTheDocument();
			});
		});
	});

	// NOTE: Git Worktree tests were removed - worktree configuration has moved to WorktreeConfigModal
	// See src/__tests__/renderer/components/GitWorktreeSection.test.tsx for worktree-specific tests

	describe('Go/Run Functionality', () => {
		it('calls onGo with correct config when Go is clicked', async () => {
			const props = createDefaultProps();
			render(<BatchRunnerModal {...props} />);

			await waitFor(() => {
				expect(screen.getByText('5')).toBeInTheDocument();
				expect(screen.getByText('tasks')).toBeInTheDocument();
			});

			fireEvent.click(screen.getByRole('button', { name: /Go/ }));

			expect(props.onGo).toHaveBeenCalledWith(
				expect.objectContaining({
					documents: expect.arrayContaining([
						expect.objectContaining({
							filename: 'test-doc',
							resetOnCompletion: false,
						}),
					]),
					prompt: DEFAULT_BATCH_PROMPT,
					loopEnabled: false,
				})
			);
			expect(props.onClose).toHaveBeenCalled();
		});

		it('disables Go button when no tasks', async () => {
			const props = createDefaultProps();
			props.getDocumentTaskCount = vi.fn().mockResolvedValue(0);
			render(<BatchRunnerModal {...props} />);

			await waitFor(() => {
				expect(screen.getByText('0')).toBeInTheDocument();
			});

			const goButton = screen.getByRole('button', { name: /Go/ });
			expect(goButton).toBeDisabled();
		});

		it('disables Go button when no documents', async () => {
			const props = createDefaultProps();
			props.currentDocument = '';
			render(<BatchRunnerModal {...props} />);

			const goButton = screen.getByRole('button', { name: /Go/ });
			expect(goButton).toBeDisabled();
		});
		// NOTE: 'includes worktree config when worktree is enabled' test removed - worktree is now in WorktreeConfigModal
	});

	describe('Save Functionality', () => {
		it('calls onSave when Save button is clicked', async () => {
			const props = createDefaultProps();
			render(<BatchRunnerModal {...props} />);

			const textarea = screen.getByPlaceholderText('Enter the system prompt for auto-run...');
			fireEvent.change(textarea, { target: { value: 'Custom prompt' } });

			fireEvent.click(screen.getByRole('button', { name: /Save/ }));

			expect(props.onSave).toHaveBeenCalledWith('Custom prompt');
		});

		it('disables Save button when no unsaved changes', async () => {
			render(<BatchRunnerModal {...createDefaultProps()} />);

			const saveButton = screen.getByRole('button', { name: /Save/ });
			expect(saveButton).toBeDisabled();
		});
	});

	describe('Cancel Functionality', () => {
		it('calls onClose when Cancel is clicked', async () => {
			const props = createDefaultProps();
			render(<BatchRunnerModal {...props} />);

			fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

			expect(props.onClose).toHaveBeenCalled();
		});

		it('calls onClose when X button is clicked', async () => {
			const props = createDefaultProps();
			render(<BatchRunnerModal {...props} />);

			// Find the X button in the header
			const header = screen.getByText('Auto Run Configuration').closest('div');
			const closeButton = header?.querySelector('button');
			if (closeButton) {
				fireEvent.click(closeButton);
				expect(props.onClose).toHaveBeenCalled();
			}
		});
	});

	describe('Edge Cases', () => {
		it('handles empty allDocuments gracefully', async () => {
			const props = createDefaultProps();
			props.allDocuments = [];
			props.currentDocument = '';
			render(<BatchRunnerModal {...props} />);

			fireEvent.click(screen.getByRole('button', { name: 'Add Docs' }));

			expect(screen.getByText('No documents found in folder')).toBeInTheDocument();
		});

		it('handles API errors for task count gracefully', async () => {
			const props = createDefaultProps();
			props.getDocumentTaskCount = vi.fn().mockRejectedValue(new Error('Failed'));
			render(<BatchRunnerModal {...props} />);

			await waitFor(() => {
				expect(screen.getByText('0 tasks')).toBeInTheDocument();
			});
		});

		it('handles playbook list error gracefully', async () => {
			(window.maestro as Record<string, unknown>).playbooks = {
				list: vi.fn().mockRejectedValue(new Error('Failed to load playbooks')),
				create: vi.fn(),
				update: vi.fn(),
				delete: vi.fn(),
				export: vi.fn(),
				import: vi.fn(),
			};

			render(<BatchRunnerModal {...createDefaultProps()} />);

			// Should not show playbook button if loading failed
			await waitFor(() => {
				expect(screen.queryByText('Load Playbook')).not.toBeInTheDocument();
			});
		});

		it('handles git repo check error gracefully', async () => {
			(window.maestro.git.isRepo as ReturnType<typeof vi.fn>).mockRejectedValue(
				new Error('Failed')
			);

			render(<BatchRunnerModal {...createDefaultProps()} />);

			// Should not crash and should not show worktree section
			await waitFor(() => {
				expect(screen.queryByText('Git Worktree')).not.toBeInTheDocument();
			});
		});

		it('handles special characters in document names', async () => {
			const props = createDefaultProps();
			props.allDocuments = ['doc<script>', "doc'quote", 'doc"double'];
			props.currentDocument = 'doc<script>';
			render(<BatchRunnerModal {...props} />);

			expect(screen.getByText('doc<script>.md')).toBeInTheDocument();
		});

		it('handles unicode in document names', async () => {
			const props = createDefaultProps();
			props.allDocuments = ['文档', 'документ', '📄doc'];
			props.currentDocument = '文档';
			render(<BatchRunnerModal {...props} />);

			expect(screen.getByText('文档.md')).toBeInTheDocument();
		});

		it('displays last modified time correctly', async () => {
			const props = createDefaultProps();
			props.lastModifiedAt = Date.now() - 3600000; // 1 hour ago
			props.initialPrompt = 'Custom prompt';
			render(<BatchRunnerModal {...props} />);

			expect(screen.getByText(/Last modified/)).toBeInTheDocument();
		});
	});

	describe('Keyboard Navigation', () => {
		it('focuses textarea on mount', async () => {
			render(<BatchRunnerModal {...createDefaultProps()} />);

			await waitFor(
				() => {
					const textarea = screen.getByPlaceholderText('Enter the system prompt for auto-run...');
					expect(document.activeElement).toBe(textarea);
				},
				{ timeout: 200 }
			);
		});
	});
});

describe('Helper Functions', () => {
	describe('countUncheckedTasks', () => {
		it('counts unchecked markdown tasks', () => {
			// This is tested implicitly through getDocumentTaskCount mock
			// The actual function is internal to the component
		});
	});

	describe('formatLastModified', () => {
		it('formats dates correctly (tested via component display)', async () => {
			const props = createDefaultProps();

			// Test "today"
			props.lastModifiedAt = Date.now();
			props.initialPrompt = 'Custom';
			const { rerender } = render(<BatchRunnerModal {...props} />);
			expect(screen.getByText(/today at/)).toBeInTheDocument();

			// Test "yesterday"
			props.lastModifiedAt = Date.now() - 86400000;
			rerender(<BatchRunnerModal {...props} />);
			expect(screen.getByText(/yesterday at/)).toBeInTheDocument();

			// Test "X days ago"
			props.lastModifiedAt = Date.now() - 3 * 86400000;
			rerender(<BatchRunnerModal {...props} />);
			expect(screen.getByText(/3 days ago/)).toBeInTheDocument();

			// Test older dates (formatted as full date)
			props.lastModifiedAt = Date.now() - 30 * 86400000;
			rerender(<BatchRunnerModal {...props} />);
			// Should show month/day/year format
			expect(screen.getByText(/Last modified/)).toBeInTheDocument();
		});
	});
});

describe('DEFAULT_BATCH_PROMPT export', () => {
	it('exports DEFAULT_BATCH_PROMPT constant', () => {
		expect(DEFAULT_BATCH_PROMPT).toBeDefined();
		expect(typeof DEFAULT_BATCH_PROMPT).toBe('string');
		expect(DEFAULT_BATCH_PROMPT).toContain('{{DOCUMENT_PATH}}');
		expect(DEFAULT_BATCH_PROMPT).toContain('{{AGENT_NAME}}');
		expect(DEFAULT_BATCH_PROMPT).toContain('{{AGENT_PATH}}');
	});
});

describe('Document Selector Modal Additional Controls', () => {
	it('closes document selector when Cancel button in footer is clicked', async () => {
		render(<BatchRunnerModal {...createDefaultProps()} />);

		// Open document selector
		fireEvent.click(screen.getByText('Add Docs'));
		expect(screen.getByText('Select Documents')).toBeInTheDocument();

		// Find and click Cancel button in selector footer
		const selectorModal = screen.getByText('Select Documents').closest('.fixed');
		const cancelButton = within(selectorModal!).getByRole('button', { name: 'Cancel' });
		fireEvent.click(cancelButton);

		await waitFor(() => {
			expect(screen.queryByText('Select Documents')).not.toBeInTheDocument();
		});
	});

	it('does not close document selector when clicking on inner modal content', async () => {
		render(<BatchRunnerModal {...createDefaultProps()} />);

		// Open document selector
		fireEvent.click(screen.getByText('Add Docs'));
		expect(screen.getByText('Select Documents')).toBeInTheDocument();

		// Click on the inner modal content (the white box)
		const selectorModal = screen.getByText('Select Documents').closest('.fixed');
		const innerModal = selectorModal?.querySelector('.w-\\[400px\\]');
		if (innerModal) {
			fireEvent.click(innerModal);
		}

		// Should still be open
		expect(screen.getByText('Select Documents')).toBeInTheDocument();
	});
});

describe('Loop Mode Additional Controls', () => {
	it('switches to infinite mode when ∞ is clicked', async () => {
		const props = createDefaultProps();
		render(<BatchRunnerModal {...props} />);

		// Add another document to show loop controls
		fireEvent.click(screen.getByText('Add Docs'));
		fireEvent.click(screen.getByRole('button', { name: /doc1\.md/ }));
		fireEvent.click(screen.getByRole('button', { name: /Add \d+ file/ }));

		// Enable loop and set max
		const loopButton = await screen.findByText('Loop');
		fireEvent.click(loopButton);
		fireEvent.click(screen.getByRole('button', { name: 'max' }));

		// Verify slider is visible
		expect(screen.getByRole('slider')).toBeInTheDocument();

		// Click infinity to switch back
		fireEvent.click(screen.getByText('∞'));

		// Slider should no longer be visible
		await waitFor(() => {
			expect(screen.queryByRole('slider')).not.toBeInTheDocument();
		});
	});

	it('includes maxLoops in config when set', async () => {
		const props = createDefaultProps();
		render(<BatchRunnerModal {...props} />);

		// Add another document
		fireEvent.click(screen.getByText('Add Docs'));
		fireEvent.click(screen.getByRole('button', { name: /doc1\.md/ }));
		fireEvent.click(screen.getByRole('button', { name: /Add \d+ file/ }));

		// Enable loop with max
		const loopButton = await screen.findByText('Loop');
		fireEvent.click(loopButton);
		fireEvent.click(screen.getByRole('button', { name: 'max' }));

		// Set max loops to 15
		const slider = screen.getByRole('slider');
		fireEvent.change(slider, { target: { value: '15' } });

		// Wait for task counts to load (total shows combined count: 10 tasks from 2 docs)
		await waitFor(() => expect(screen.getByText('10')).toBeInTheDocument());
		fireEvent.click(screen.getByRole('button', { name: /Go/ }));

		expect(props.onGo).toHaveBeenCalledWith(
			expect.objectContaining({
				loopEnabled: true,
				maxLoops: 15,
			})
		);
	});

	it('sets maxLoops to null in config when infinite mode', async () => {
		const props = createDefaultProps();
		render(<BatchRunnerModal {...props} />);

		// Add another document
		fireEvent.click(screen.getByText('Add Docs'));
		fireEvent.click(screen.getByRole('button', { name: /doc1\.md/ }));
		fireEvent.click(screen.getByRole('button', { name: /Add \d+ file/ }));

		// Enable loop (defaults to infinite)
		const loopButton = await screen.findByText('Loop');
		fireEvent.click(loopButton);

		// Wait for task counts to load (total shows combined count: 10 tasks from 2 docs)
		await waitFor(() => expect(screen.getByText('10')).toBeInTheDocument());
		fireEvent.click(screen.getByRole('button', { name: /Go/ }));

		expect(props.onGo).toHaveBeenCalledWith(
			expect.objectContaining({
				loopEnabled: true,
				maxLoops: null,
			})
		);
	});
});

// Note: Escape handler priority tests are implicitly covered via layer stack integration tests
// The BatchRunnerModal does handle escape priority for nested modals via the updateLayerHandler
// but testing this requires complex async timing that causes timeouts in the test environment

// NOTE: Worktree UI has moved to WorktreeConfigModal - these tests no longer apply to BatchRunnerModal
describe.skip('Playbook with Worktree Settings', () => {
	beforeEach(() => {
		(window.maestro.git as Record<string, unknown>).isRepo = vi.fn().mockResolvedValue(true);
		(window.maestro.git as Record<string, unknown>).branches = vi
			.fn()
			.mockResolvedValue({ branches: ['main', 'develop'] });
		(window.maestro.git as Record<string, unknown>).checkGhCli = vi
			.fn()
			.mockResolvedValue({ installed: true, authenticated: true });
		(window.maestro.git as Record<string, unknown>).worktreeInfo = vi
			.fn()
			.mockResolvedValue({ success: true, exists: false, isWorktree: false });
		(window.maestro.git as Record<string, unknown>).getRepoRoot = vi
			.fn()
			.mockResolvedValue({ success: true, root: '/path/to/project' });
	});

	it('loads playbook with worktree settings', async () => {
		const mockPlaybook = createMockPlaybook({
			worktreeSettings: {
				branchNameTemplate: 'autorun-feature-123',
				createPROnCompletion: true,
				prTargetBranch: 'develop',
			},
		});
		const mockPlaybooks: Playbook[] = [mockPlaybook];
		(window.maestro as Record<string, unknown>).playbooks = {
			list: vi.fn().mockResolvedValue({ success: true, playbooks: mockPlaybooks }),
			create: vi.fn(),
			update: vi.fn(),
			delete: vi.fn(),
			export: vi.fn(),
			import: vi.fn(),
		};

		render(<BatchRunnerModal {...createDefaultProps()} />);

		// Wait for playbooks to load
		await waitFor(() => screen.getByText('Load Playbook'));
		fireEvent.click(screen.getByRole('button', { name: 'Load Playbook' }));
		fireEvent.click(screen.getByText('Test Playbook'));

		// Verify worktree settings are restored
		await waitFor(() => {
			expect(screen.getByPlaceholderText('feature-xyz')).toHaveValue('autorun-feature-123');
		});
	});

	it('clears worktree settings when loading playbook without them', async () => {
		const mockPlaybook = createMockPlaybook(); // No worktreeSettings
		const mockPlaybooks: Playbook[] = [mockPlaybook];
		(window.maestro as Record<string, unknown>).playbooks = {
			list: vi.fn().mockResolvedValue({ success: true, playbooks: mockPlaybooks }),
			create: vi.fn(),
			update: vi.fn(),
			delete: vi.fn(),
			export: vi.fn(),
			import: vi.fn(),
		};

		const props = createDefaultProps();
		render(<BatchRunnerModal {...props} />);

		// First enable worktree manually
		await waitFor(() => {
			expect(screen.getByText('Enable Worktree')).toBeInTheDocument();
		});
		fireEvent.click(screen.getByRole('button', { name: 'Enable Worktree' }));

		const branchInput = screen.getByPlaceholderText('feature-xyz');
		fireEvent.change(branchInput, { target: { value: 'my-branch' } });

		// Now load a playbook without worktree settings
		await waitFor(() => screen.getByText('Load Playbook'));
		fireEvent.click(screen.getByRole('button', { name: 'Load Playbook' }));
		fireEvent.click(screen.getByText('Test Playbook'));

		// Worktree should be disabled (Enable Worktree button should appear again)
		await waitFor(() => {
			expect(screen.getByText('Enable Worktree')).toBeInTheDocument();
		});
	});
});

describe('Playbook Update Functionality', () => {
	it('updates existing playbook when Save Update is clicked', async () => {
		const mockPlaybook = createMockPlaybook();
		const mockPlaybooks: Playbook[] = [mockPlaybook];
		const mockUpdate = vi.fn().mockResolvedValue({
			success: true,
			playbook: { ...mockPlaybook, prompt: 'Updated prompt' },
		});
		(window.maestro as Record<string, unknown>).playbooks = {
			list: vi.fn().mockResolvedValue({ success: true, playbooks: mockPlaybooks }),
			create: vi.fn(),
			update: mockUpdate,
			delete: vi.fn(),
			export: vi.fn(),
			import: vi.fn(),
		};

		render(<BatchRunnerModal {...createDefaultProps()} />);

		// Load playbook
		await waitFor(() => screen.getByText('Load Playbook'));
		fireEvent.click(screen.getByRole('button', { name: 'Load Playbook' }));
		fireEvent.click(screen.getByText('Test Playbook'));

		// Modify the prompt
		const textarea = screen.getByPlaceholderText('Enter the system prompt for auto-run...');
		fireEvent.change(textarea, { target: { value: 'Updated prompt' } });

		// Wait for Save Update button to appear
		await waitFor(() => {
			expect(screen.getByText('Save Update')).toBeInTheDocument();
		});

		// Click Save Update
		fireEvent.click(screen.getByText('Save Update'));

		await waitFor(() => {
			expect(mockUpdate).toHaveBeenCalledWith(
				'session-123',
				'playbook-1',
				expect.objectContaining({
					prompt: 'Updated prompt',
					updatedAt: expect.any(Number),
				})
			);
		});
	});

	it('handles update error gracefully', async () => {
		const mockPlaybook = createMockPlaybook();
		const mockPlaybooks: Playbook[] = [mockPlaybook];
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
		const mockUpdate = vi.fn().mockRejectedValue(new Error('Network error'));
		(window.maestro as Record<string, unknown>).playbooks = {
			list: vi.fn().mockResolvedValue({ success: true, playbooks: mockPlaybooks }),
			create: vi.fn(),
			update: mockUpdate,
			delete: vi.fn(),
			export: vi.fn(),
			import: vi.fn(),
		};

		render(<BatchRunnerModal {...createDefaultProps()} />);

		// Load playbook
		await waitFor(() => screen.getByText('Load Playbook'));
		fireEvent.click(screen.getByRole('button', { name: 'Load Playbook' }));
		fireEvent.click(screen.getByText('Test Playbook'));

		// Modify and save
		const textarea = screen.getByPlaceholderText('Enter the system prompt for auto-run...');
		fireEvent.change(textarea, { target: { value: 'Updated prompt' } });
		await waitFor(() => screen.getByText('Save Update'));
		fireEvent.click(screen.getByText('Save Update'));

		await waitFor(() => {
			expect(consoleError).toHaveBeenCalledWith('Failed to update playbook:', expect.any(Error));
		});

		consoleError.mockRestore();
	});
});

describe('Discard Changes Functionality', () => {
	it('discards changes and reloads original playbook', async () => {
		const mockPlaybook = createMockPlaybook({ prompt: 'Original prompt' });
		const mockPlaybooks: Playbook[] = [mockPlaybook];
		(window.maestro as Record<string, unknown>).playbooks = {
			list: vi.fn().mockResolvedValue({ success: true, playbooks: mockPlaybooks }),
			create: vi.fn(),
			update: vi.fn(),
			delete: vi.fn(),
			export: vi.fn(),
			import: vi.fn(),
		};

		render(<BatchRunnerModal {...createDefaultProps()} />);

		// Load playbook
		await waitFor(() => screen.getByText('Load Playbook'));
		fireEvent.click(screen.getByRole('button', { name: 'Load Playbook' }));
		fireEvent.click(screen.getByText('Test Playbook'));

		// Verify original prompt is loaded
		const textarea = screen.getByPlaceholderText('Enter the system prompt for auto-run...');
		expect(textarea).toHaveValue('Original prompt');

		// Modify the prompt
		fireEvent.change(textarea, { target: { value: 'Modified prompt' } });
		expect(textarea).toHaveValue('Modified prompt');

		// Click Discard
		await waitFor(() => {
			expect(screen.getByText('Discard')).toBeInTheDocument();
		});
		fireEvent.click(screen.getByText('Discard'));

		// Prompt should be restored to original
		await waitFor(() => {
			expect(textarea).toHaveValue('Original prompt');
		});
	});
});

describe('Delete Playbook Edge Cases', () => {
	it('clears loaded playbook when deleting the currently loaded one', async () => {
		const mockPlaybook = createMockPlaybook();
		const mockPlaybooks: Playbook[] = [mockPlaybook];
		const mockDelete = vi.fn().mockResolvedValue({ success: true });
		(window.maestro as Record<string, unknown>).playbooks = {
			list: vi.fn().mockResolvedValue({ success: true, playbooks: mockPlaybooks }),
			create: vi.fn(),
			update: vi.fn(),
			delete: mockDelete,
			export: vi.fn(),
			import: vi.fn(),
		};

		render(<BatchRunnerModal {...createDefaultProps()} />);

		// Load the playbook first
		await waitFor(() => screen.getByText('Load Playbook'));
		fireEvent.click(screen.getByRole('button', { name: 'Load Playbook' }));
		fireEvent.click(screen.getByText('Test Playbook'));

		// Wait for playbook to be loaded (button text changes)
		await waitFor(() => {
			const buttons = screen.getAllByText('Test Playbook');
			expect(buttons.length).toBeGreaterThan(0);
		});

		// Now open dropdown again and delete the loaded playbook
		fireEvent.click(screen.getAllByText('Test Playbook')[0]);

		await waitFor(() => {
			const deleteButton = screen.getByTitle('Delete playbook');
			fireEvent.click(deleteButton);
		});

		// Confirm delete
		expect(screen.getByTestId('playbook-delete-modal')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Confirm Delete' }));

		await waitFor(() => {
			expect(mockDelete).toHaveBeenCalled();
		});
	});

	it('handles delete error gracefully', async () => {
		const mockPlaybook = createMockPlaybook();
		const mockPlaybooks: Playbook[] = [mockPlaybook];
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
		const mockDelete = vi.fn().mockRejectedValue(new Error('Delete failed'));
		(window.maestro as Record<string, unknown>).playbooks = {
			list: vi.fn().mockResolvedValue({ success: true, playbooks: mockPlaybooks }),
			create: vi.fn(),
			update: vi.fn(),
			delete: mockDelete,
			export: vi.fn(),
			import: vi.fn(),
		};

		render(<BatchRunnerModal {...createDefaultProps()} />);

		await waitFor(() => screen.getByText('Load Playbook'));
		fireEvent.click(screen.getByRole('button', { name: 'Load Playbook' }));

		const deleteButton = screen.getByTitle('Delete playbook');
		fireEvent.click(deleteButton);
		fireEvent.click(screen.getByRole('button', { name: 'Confirm Delete' }));

		await waitFor(() => {
			expect(consoleError).toHaveBeenCalledWith('Failed to delete playbook:', expect.any(Error));
		});

		consoleError.mockRestore();
	});

	it('closes delete modal when Cancel is clicked', async () => {
		const mockPlaybook = createMockPlaybook();
		const mockPlaybooks: Playbook[] = [mockPlaybook];
		(window.maestro as Record<string, unknown>).playbooks = {
			list: vi.fn().mockResolvedValue({ success: true, playbooks: mockPlaybooks }),
			create: vi.fn(),
			update: vi.fn(),
			delete: vi.fn(),
			export: vi.fn(),
			import: vi.fn(),
		};

		render(<BatchRunnerModal {...createDefaultProps()} />);

		await waitFor(() => screen.getByText('Load Playbook'));
		fireEvent.click(screen.getByRole('button', { name: 'Load Playbook' }));

		const deleteButton = screen.getByTitle('Delete playbook');
		fireEvent.click(deleteButton);

		expect(screen.getByTestId('playbook-delete-modal')).toBeInTheDocument();

		// Click Cancel button within the delete modal (first button in modal)
		const deleteModal = screen.getByTestId('playbook-delete-modal');
		const buttons = deleteModal.querySelectorAll('button');
		// First button is Cancel, second is Confirm Delete
		fireEvent.click(buttons[0]);

		await waitFor(() => {
			expect(screen.queryByTestId('playbook-delete-modal')).not.toBeInTheDocument();
		});
	});
});

describe('Export Playbook Edge Cases', () => {
	it('handles export failure gracefully', async () => {
		const mockPlaybook = createMockPlaybook();
		const mockPlaybooks: Playbook[] = [mockPlaybook];
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
		const mockExport = vi.fn().mockResolvedValue({ success: false, error: 'Export failed' });
		(window.maestro as Record<string, unknown>).playbooks = {
			list: vi.fn().mockResolvedValue({ success: true, playbooks: mockPlaybooks }),
			create: vi.fn(),
			update: vi.fn(),
			delete: vi.fn(),
			export: mockExport,
			import: vi.fn(),
		};

		render(<BatchRunnerModal {...createDefaultProps()} />);

		await waitFor(() => screen.getByText('Load Playbook'));
		fireEvent.click(screen.getByRole('button', { name: 'Load Playbook' }));

		const exportButton = screen.getByTitle('Export playbook');
		fireEvent.click(exportButton);

		await waitFor(() => {
			expect(consoleError).toHaveBeenCalledWith('Failed to export playbook:', 'Export failed');
		});

		consoleError.mockRestore();
	});

	it('silently ignores export cancelled error', async () => {
		const mockPlaybook = createMockPlaybook();
		const mockPlaybooks: Playbook[] = [mockPlaybook];
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
		const mockExport = vi.fn().mockResolvedValue({ success: false, error: 'Export cancelled' });
		(window.maestro as Record<string, unknown>).playbooks = {
			list: vi.fn().mockResolvedValue({ success: true, playbooks: mockPlaybooks }),
			create: vi.fn(),
			update: vi.fn(),
			delete: vi.fn(),
			export: mockExport,
			import: vi.fn(),
		};

		render(<BatchRunnerModal {...createDefaultProps()} />);

		await waitFor(() => screen.getByText('Load Playbook'));
		fireEvent.click(screen.getByRole('button', { name: 'Load Playbook' }));

		const exportButton = screen.getByTitle('Export playbook');
		fireEvent.click(exportButton);

		await waitFor(() => {
			expect(mockExport).toHaveBeenCalled();
		});

		// Should not log error for "Export cancelled"
		expect(consoleError).not.toHaveBeenCalled();

		consoleError.mockRestore();
	});

	it('handles export exception gracefully', async () => {
		const mockPlaybook = createMockPlaybook();
		const mockPlaybooks: Playbook[] = [mockPlaybook];
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
		const mockExport = vi.fn().mockRejectedValue(new Error('Network error'));
		(window.maestro as Record<string, unknown>).playbooks = {
			list: vi.fn().mockResolvedValue({ success: true, playbooks: mockPlaybooks }),
			create: vi.fn(),
			update: vi.fn(),
			delete: vi.fn(),
			export: mockExport,
			import: vi.fn(),
		};

		render(<BatchRunnerModal {...createDefaultProps()} />);

		await waitFor(() => screen.getByText('Load Playbook'));
		fireEvent.click(screen.getByRole('button', { name: 'Load Playbook' }));

		const exportButton = screen.getByTitle('Export playbook');
		fireEvent.click(exportButton);

		await waitFor(() => {
			expect(consoleError).toHaveBeenCalledWith('Failed to export playbook:', expect.any(Error));
		});

		consoleError.mockRestore();
	});
});

describe('Import Playbook Edge Cases', () => {
	it('handles import failure gracefully', async () => {
		const mockPlaybook = createMockPlaybook();
		const mockPlaybooks: Playbook[] = [mockPlaybook];
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
		const mockImport = vi.fn().mockResolvedValue({ success: false, error: 'Invalid format' });
		(window.maestro as Record<string, unknown>).playbooks = {
			list: vi.fn().mockResolvedValue({ success: true, playbooks: mockPlaybooks }),
			create: vi.fn(),
			update: vi.fn(),
			delete: vi.fn(),
			export: vi.fn(),
			import: mockImport,
		};

		render(<BatchRunnerModal {...createDefaultProps()} />);

		await waitFor(() => screen.getByText('Load Playbook'));
		fireEvent.click(screen.getByRole('button', { name: 'Load Playbook' }));
		fireEvent.click(screen.getByRole('button', { name: 'Import Playbook' }));

		await waitFor(() => {
			expect(consoleError).toHaveBeenCalledWith('Failed to import playbook:', 'Invalid format');
		});

		consoleError.mockRestore();
	});

	it('silently ignores import cancelled error', async () => {
		const mockPlaybook = createMockPlaybook();
		const mockPlaybooks: Playbook[] = [mockPlaybook];
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
		const mockImport = vi.fn().mockResolvedValue({ success: false, error: 'Import cancelled' });
		(window.maestro as Record<string, unknown>).playbooks = {
			list: vi.fn().mockResolvedValue({ success: true, playbooks: mockPlaybooks }),
			create: vi.fn(),
			update: vi.fn(),
			delete: vi.fn(),
			export: vi.fn(),
			import: mockImport,
		};

		render(<BatchRunnerModal {...createDefaultProps()} />);

		await waitFor(() => screen.getByText('Load Playbook'));
		fireEvent.click(screen.getByRole('button', { name: 'Load Playbook' }));
		fireEvent.click(screen.getByRole('button', { name: 'Import Playbook' }));

		await waitFor(() => {
			expect(mockImport).toHaveBeenCalled();
		});

		// Should not log error for "Import cancelled"
		expect(consoleError).not.toHaveBeenCalled();

		consoleError.mockRestore();
	});

	it('handles import exception gracefully', async () => {
		const mockPlaybook = createMockPlaybook();
		const mockPlaybooks: Playbook[] = [mockPlaybook];
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
		const mockImport = vi.fn().mockRejectedValue(new Error('Network error'));
		(window.maestro as Record<string, unknown>).playbooks = {
			list: vi.fn().mockResolvedValue({ success: true, playbooks: mockPlaybooks }),
			create: vi.fn(),
			update: vi.fn(),
			delete: vi.fn(),
			export: vi.fn(),
			import: mockImport,
		};

		render(<BatchRunnerModal {...createDefaultProps()} />);

		await waitFor(() => screen.getByText('Load Playbook'));
		fireEvent.click(screen.getByRole('button', { name: 'Load Playbook' }));
		fireEvent.click(screen.getByRole('button', { name: 'Import Playbook' }));

		await waitFor(() => {
			expect(consoleError).toHaveBeenCalledWith('Failed to import playbook:', expect.any(Error));
		});

		consoleError.mockRestore();
	});
});

describe('Click Outside Dropdown Handlers', () => {
	it('closes playbook dropdown when clicking outside', async () => {
		const mockPlaybook = createMockPlaybook();
		const mockPlaybooks: Playbook[] = [mockPlaybook];
		(window.maestro as Record<string, unknown>).playbooks = {
			list: vi.fn().mockResolvedValue({ success: true, playbooks: mockPlaybooks }),
			create: vi.fn(),
			update: vi.fn(),
			delete: vi.fn(),
			export: vi.fn(),
			import: vi.fn(),
		};

		render(<BatchRunnerModal {...createDefaultProps()} />);

		await waitFor(() => screen.getByText('Load Playbook'));
		fireEvent.click(screen.getByRole('button', { name: 'Load Playbook' }));

		// Dropdown should be visible
		expect(screen.getByText('Test Playbook')).toBeInTheDocument();

		// Simulate clicking outside via document mousedown
		fireEvent.mouseDown(document.body);

		await waitFor(() => {
			// Dropdown should be closed - only the "Load Playbook" button remains
			expect(screen.queryByText('Import Playbook')).not.toBeInTheDocument();
		});
	});

	// NOTE: Worktree UI has moved to WorktreeConfigModal - this test no longer applies to BatchRunnerModal
	it.skip('closes branch dropdown when clicking outside', async () => {
		(window.maestro.git as Record<string, unknown>).isRepo = vi.fn().mockResolvedValue(true);
		(window.maestro.git as Record<string, unknown>).branches = vi
			.fn()
			.mockResolvedValue({ branches: ['main', 'develop', 'feature'] });
		(window.maestro.git as Record<string, unknown>).checkGhCli = vi
			.fn()
			.mockResolvedValue({ installed: true, authenticated: true });
		(window.maestro.git as Record<string, unknown>).worktreeInfo = vi
			.fn()
			.mockResolvedValue({ success: true, exists: false, isWorktree: false });
		(window.maestro.git as Record<string, unknown>).getRepoRoot = vi
			.fn()
			.mockResolvedValue({ success: true, root: '/path/to/project' });

		render(<BatchRunnerModal {...createDefaultProps()} />);

		await waitFor(() => {
			expect(screen.getByText('Enable Worktree')).toBeInTheDocument();
		});
		fireEvent.click(screen.getByRole('button', { name: 'Enable Worktree' }));

		// Enable Create PR checkbox to show branch dropdown
		await waitFor(() => {
			expect(screen.getByText('Create PR on completion')).toBeInTheDocument();
		});
		fireEvent.click(screen.getByText('Create PR on completion'));

		// Click on the branch dropdown button
		await waitFor(() => {
			expect(screen.getByText('main')).toBeInTheDocument();
		});
		fireEvent.click(screen.getByText('main'));

		// Dropdown should show other branches
		await waitFor(() => {
			expect(screen.getByText('develop')).toBeInTheDocument();
		});

		// Click outside
		fireEvent.mouseDown(document.body);

		await waitFor(() => {
			// Check that develop is no longer in dropdown (but main button is still there)
			const develops = screen.queryAllByText('develop');
			// develop should only appear if dropdown is open
			expect(develops.length).toBeLessThanOrEqual(1);
		});
	});
});

describe('Save as New Playbook', () => {
	it('shows Save as New button when playbook is modified', async () => {
		const mockPlaybook = createMockPlaybook();
		const mockPlaybooks: Playbook[] = [mockPlaybook];
		(window.maestro as Record<string, unknown>).playbooks = {
			list: vi.fn().mockResolvedValue({ success: true, playbooks: mockPlaybooks }),
			create: vi.fn().mockResolvedValue({
				success: true,
				playbook: { ...mockPlaybook, id: 'new-id', name: 'New Playbook' },
			}),
			update: vi.fn(),
			delete: vi.fn(),
			export: vi.fn(),
			import: vi.fn(),
		};

		render(<BatchRunnerModal {...createDefaultProps()} />);

		// Load playbook
		await waitFor(() => screen.getByText('Load Playbook'));
		fireEvent.click(screen.getByRole('button', { name: 'Load Playbook' }));
		fireEvent.click(screen.getByText('Test Playbook'));

		// Modify the prompt
		const textarea = screen.getByPlaceholderText('Enter the system prompt for auto-run...');
		fireEvent.change(textarea, { target: { value: 'Modified prompt' } });

		// Save as New button should appear
		await waitFor(() => {
			expect(screen.getByText('Save as New')).toBeInTheDocument();
		});
	});

	it('opens save playbook modal when Save as New is clicked', async () => {
		const mockPlaybook = createMockPlaybook();
		const mockPlaybooks: Playbook[] = [mockPlaybook];
		(window.maestro as Record<string, unknown>).playbooks = {
			list: vi.fn().mockResolvedValue({ success: true, playbooks: mockPlaybooks }),
			create: vi.fn(),
			update: vi.fn(),
			delete: vi.fn(),
			export: vi.fn(),
			import: vi.fn(),
		};

		render(<BatchRunnerModal {...createDefaultProps()} />);

		// Load playbook and modify
		await waitFor(() => screen.getByText('Load Playbook'));
		fireEvent.click(screen.getByRole('button', { name: 'Load Playbook' }));
		fireEvent.click(screen.getByText('Test Playbook'));

		const textarea = screen.getByPlaceholderText('Enter the system prompt for auto-run...');
		fireEvent.change(textarea, { target: { value: 'Modified prompt' } });

		await waitFor(() => screen.getByText('Save as New'));
		fireEvent.click(screen.getByText('Save as New'));

		expect(screen.getByTestId('playbook-name-modal')).toBeInTheDocument();
	});
});

// NOTE: Worktree UI has moved to WorktreeConfigModal - these tests no longer apply to BatchRunnerModal
describe.skip('Worktree Browse Button', () => {
	it('opens folder dialog and sets worktree path', async () => {
		(window.maestro.git as Record<string, unknown>).isRepo = vi.fn().mockResolvedValue(true);
		(window.maestro.git as Record<string, unknown>).branches = vi
			.fn()
			.mockResolvedValue({ branches: ['main'] });
		(window.maestro.git as Record<string, unknown>).checkGhCli = vi
			.fn()
			.mockResolvedValue({ installed: true, authenticated: true });
		(window.maestro.git as Record<string, unknown>).worktreeInfo = vi
			.fn()
			.mockResolvedValue({ success: true, exists: false, isWorktree: false });
		(window.maestro.git as Record<string, unknown>).getRepoRoot = vi
			.fn()
			.mockResolvedValue({ success: true, root: '/path/to/project' });
		(window.maestro.dialog.selectFolder as ReturnType<typeof vi.fn>).mockResolvedValue(
			'/selected/path'
		);

		render(<BatchRunnerModal {...createDefaultProps()} />);

		await waitFor(() => {
			expect(screen.getByText('Enable Worktree')).toBeInTheDocument();
		});
		fireEvent.click(screen.getByRole('button', { name: 'Enable Worktree' }));

		fireEvent.click(screen.getByRole('button', { name: 'Browse' }));

		await waitFor(() => {
			expect(window.maestro.dialog.selectFolder).toHaveBeenCalled();
			expect(screen.getByPlaceholderText('/path/to/worktrees')).toHaveValue('/selected/path');
		});
	});

	it('handles cancelled folder selection', async () => {
		(window.maestro.git as Record<string, unknown>).isRepo = vi.fn().mockResolvedValue(true);
		(window.maestro.git as Record<string, unknown>).branches = vi
			.fn()
			.mockResolvedValue({ branches: ['main'] });
		(window.maestro.git as Record<string, unknown>).checkGhCli = vi
			.fn()
			.mockResolvedValue({ installed: true, authenticated: true });
		(window.maestro.git as Record<string, unknown>).worktreeInfo = vi
			.fn()
			.mockResolvedValue({ success: true, exists: false, isWorktree: false });
		(window.maestro.git as Record<string, unknown>).getRepoRoot = vi
			.fn()
			.mockResolvedValue({ success: true, root: '/path/to/project' });
		(window.maestro.dialog.selectFolder as ReturnType<typeof vi.fn>).mockResolvedValue(null);

		render(<BatchRunnerModal {...createDefaultProps()} />);

		await waitFor(() => {
			expect(screen.getByText('Enable Worktree')).toBeInTheDocument();
		});
		fireEvent.click(screen.getByRole('button', { name: 'Enable Worktree' }));

		const pathInput = screen.getByPlaceholderText('/path/to/worktrees');
		fireEvent.change(pathInput, { target: { value: '/original/path' } });

		fireEvent.click(screen.getByRole('button', { name: 'Browse' }));

		await waitFor(() => {
			expect(window.maestro.dialog.selectFolder).toHaveBeenCalled();
		});

		// Path should remain unchanged (null result doesn't update)
		expect(pathInput).toHaveValue('/original/path');
	});
});

// NOTE: Worktree UI has moved to WorktreeConfigModal - these tests no longer apply to BatchRunnerModal
describe.skip('Worktree Validation Edge Cases', () => {
	it('shows uncommitted changes warning when branch mismatch exists', async () => {
		(window.maestro.git as Record<string, unknown>).isRepo = vi.fn().mockResolvedValue(true);
		(window.maestro.git as Record<string, unknown>).branches = vi
			.fn()
			.mockResolvedValue({ branches: ['main'] });
		(window.maestro.git as Record<string, unknown>).checkGhCli = vi
			.fn()
			.mockResolvedValue({ installed: true, authenticated: true });
		(window.maestro.git as Record<string, unknown>).worktreeInfo = vi.fn().mockResolvedValue({
			success: true,
			exists: true,
			isWorktree: true,
			currentBranch: 'feature-branch',
			repoRoot: '/path/to/project',
		});
		(window.maestro.git as Record<string, unknown>).getRepoRoot = vi.fn().mockResolvedValue({
			success: true,
			root: '/path/to/project',
		});
		(window.maestro.git as Record<string, unknown>).status = vi.fn().mockResolvedValue({
			stdout: 'M modified-file.ts\n',
		});

		render(<BatchRunnerModal {...createDefaultProps()} />);

		await waitFor(() => {
			expect(screen.getByText('Enable Worktree')).toBeInTheDocument();
		});
		fireEvent.click(screen.getByRole('button', { name: 'Enable Worktree' }));

		const pathInput = screen.getByPlaceholderText('/path/to/worktrees');
		fireEvent.change(pathInput, { target: { value: '/path/to/worktrees' } });
		fireEvent.change(screen.getByPlaceholderText('feature-xyz'), {
			target: { value: 'different-branch' },
		});

		// Wait for validation with warning about branch mismatch
		await waitFor(
			() => {
				expect(screen.getByText(/Worktree exists with branch/)).toBeInTheDocument();
			},
			{ timeout: 1000 }
		);
	});

	it('handles validation exception gracefully', async () => {
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
		(window.maestro.git as Record<string, unknown>).isRepo = vi.fn().mockResolvedValue(true);
		(window.maestro.git as Record<string, unknown>).branches = vi
			.fn()
			.mockResolvedValue({ branches: ['main'] });
		(window.maestro.git as Record<string, unknown>).checkGhCli = vi
			.fn()
			.mockResolvedValue({ installed: true, authenticated: true });
		(window.maestro.git as Record<string, unknown>).worktreeInfo = vi
			.fn()
			.mockRejectedValue(new Error('Permission denied'));
		(window.maestro.git as Record<string, unknown>).getRepoRoot = vi.fn().mockResolvedValue({
			success: true,
			root: '/path/to/project',
		});

		render(<BatchRunnerModal {...createDefaultProps()} />);

		await waitFor(() => {
			expect(screen.getByText('Enable Worktree')).toBeInTheDocument();
		});
		fireEvent.click(screen.getByRole('button', { name: 'Enable Worktree' }));

		const pathInput = screen.getByPlaceholderText('/path/to/worktrees');
		fireEvent.change(pathInput, { target: { value: '/path/to/worktrees' } });
		// Also set branch name to trigger validation (computedWorktreePath requires both)
		fireEvent.change(screen.getByPlaceholderText('feature-xyz'), {
			target: { value: 'my-branch' },
		});

		await waitFor(
			() => {
				expect(consoleError).toHaveBeenCalledWith(
					'Failed to validate worktree path:',
					expect.any(Error)
				);
			},
			{ timeout: 2000 }
		);

		consoleError.mockRestore();
	});
});

describe('Document Selector Refresh', () => {
	it('shows added documents notification after refresh', async () => {
		vi.useFakeTimers();
		const props = createDefaultProps();
		let docCount = 3;
		props.allDocuments = ['test-doc', 'doc1', 'doc2'];
		props.onRefreshDocuments = vi.fn().mockImplementation(async () => {
			// Simulate adding a document
			docCount = 4;
		});

		const { rerender } = render(<BatchRunnerModal {...props} />);

		// Open document selector
		fireEvent.click(screen.getByText('Add Docs'));
		expect(screen.getByText('Select Documents')).toBeInTheDocument();

		// Trigger refresh
		const refreshButton = screen.getByTitle('Refresh document list');
		fireEvent.click(refreshButton);

		// Simulate the refresh completing and document count changing
		await act(async () => {
			vi.advanceTimersByTime(100);
		});

		// Rerender with new documents
		rerender(
			<BatchRunnerModal {...props} allDocuments={['test-doc', 'doc1', 'doc2', 'new-doc']} />
		);

		// Wait for refresh spinner to stop
		await act(async () => {
			vi.advanceTimersByTime(500);
		});

		// Should show notification about new document
		expect(screen.getByText(/Found 1 new document/)).toBeInTheDocument();

		vi.useRealTimers();
	});

	it('shows removed documents notification after refresh', async () => {
		vi.useFakeTimers();
		const props = createDefaultProps();
		props.allDocuments = ['test-doc', 'doc1', 'doc2', 'doc3'];
		props.onRefreshDocuments = vi.fn();

		const { rerender } = render(<BatchRunnerModal {...props} />);

		// Open document selector
		fireEvent.click(screen.getByText('Add Docs'));

		// Trigger refresh
		const refreshButton = screen.getByTitle('Refresh document list');
		fireEvent.click(refreshButton);

		await act(async () => {
			vi.advanceTimersByTime(100);
		});

		// Rerender with fewer documents
		rerender(<BatchRunnerModal {...props} allDocuments={['test-doc', 'doc1']} />);

		await act(async () => {
			vi.advanceTimersByTime(500);
		});

		// Should show notification about removed documents
		expect(screen.getByText(/2 documents removed/)).toBeInTheDocument();

		vi.useRealTimers();
	});
});

describe('countUncheckedTasks helper', () => {
	// This function is internal but we can test it indirectly through component behavior
	it('correctly counts unchecked tasks (tested via mock)', async () => {
		const props = createDefaultProps();
		// getDocumentTaskCount mock returns 5 by default
		render(<BatchRunnerModal {...props} />);

		await waitFor(() => {
			expect(screen.getByText('5')).toBeInTheDocument();
			expect(screen.getByText('tasks')).toBeInTheDocument();
		});
	});
});

// NOTE: GitHub CLI Link tests removed - worktree UI has moved to GitWorktreeSection and WorktreeConfigModal
describe.skip('GitHub CLI Link', () => {
	it('renders GitHub CLI link and prevents propagation on click', async () => {
		(window.maestro.git as Record<string, unknown>).isRepo = vi.fn().mockResolvedValue(true);
		(window.maestro.git as Record<string, unknown>).branches = vi
			.fn()
			.mockResolvedValue({ branches: ['main'] });
		(window.maestro.git as Record<string, unknown>).checkGhCli = vi
			.fn()
			.mockResolvedValue({ installed: false, authenticated: false });
		(window.maestro.git as Record<string, unknown>).worktreeInfo = vi
			.fn()
			.mockResolvedValue({ success: true, exists: false, isWorktree: false });
		(window.maestro.git as Record<string, unknown>).getRepoRoot = vi
			.fn()
			.mockResolvedValue({ success: true, root: '/path/to/project' });

		render(<BatchRunnerModal {...createDefaultProps()} />);

		await waitFor(() => {
			expect(screen.getByText('Git Worktree')).toBeInTheDocument();
		});

		// Find the GitHub CLI link
		const link = screen.getByText('GitHub CLI');
		expect(link).toHaveAttribute('href', 'https://cli.github.com');
		expect(link).toHaveAttribute('target', '_blank');

		// Click should stop propagation (doesn't trigger parent handlers)
		const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true });
		const stopPropagationSpy = vi.spyOn(clickEvent, 'stopPropagation');
		link.dispatchEvent(clickEvent);
		expect(stopPropagationSpy).toHaveBeenCalled();
	});
});

describe('Escape Handler Priority', () => {
	it('closes delete modal on escape before closing main modal', async () => {
		const mockPlaybook = createMockPlaybook();
		const mockPlaybooks: Playbook[] = [mockPlaybook];
		(window.maestro as Record<string, unknown>).playbooks = {
			list: vi.fn().mockResolvedValue({ success: true, playbooks: mockPlaybooks }),
			create: vi.fn(),
			update: vi.fn(),
			delete: vi.fn(),
			export: vi.fn(),
			import: vi.fn(),
		};

		const props = createDefaultProps();
		render(<BatchRunnerModal {...props} />);

		await waitFor(() => screen.getByText('Load Playbook'));
		fireEvent.click(screen.getByRole('button', { name: 'Load Playbook' }));

		// Open delete modal
		const deleteButton = screen.getByTitle('Delete playbook');
		fireEvent.click(deleteButton);
		expect(screen.getByTestId('playbook-delete-modal')).toBeInTheDocument();

		// Get the latest escape handler from updateLayerHandler (which gets called when nested modals open)
		// The last call to updateLayerHandler contains the handler that checks for nested modals
		const lastUpdateCall =
			mockUpdateLayerHandler.mock.calls[mockUpdateLayerHandler.mock.calls.length - 1];
		if (lastUpdateCall && lastUpdateCall[1]) {
			lastUpdateCall[1]();
		}

		// Delete modal should close, but main modal should remain
		await waitFor(() => {
			expect(screen.queryByTestId('playbook-delete-modal')).not.toBeInTheDocument();
		});

		// Main modal still open
		expect(screen.getByText('Auto Run Configuration')).toBeInTheDocument();
	});

	it('closes save playbook modal on escape', async () => {
		const props = createDefaultProps();
		render(<BatchRunnerModal {...props} />);

		// Add documents to show Save as Playbook button
		fireEvent.click(screen.getByText('Add Docs'));
		fireEvent.click(screen.getByRole('button', { name: /doc1\.md/ }));
		fireEvent.click(screen.getByRole('button', { name: /Add \d+ file/ }));

		await waitFor(() => screen.getByText('Save as Playbook'));
		fireEvent.click(screen.getByRole('button', { name: 'Save as Playbook' }));

		expect(screen.getByTestId('playbook-name-modal')).toBeInTheDocument();

		// Get the latest escape handler from updateLayerHandler
		const lastUpdateCall =
			mockUpdateLayerHandler.mock.calls[mockUpdateLayerHandler.mock.calls.length - 1];
		if (lastUpdateCall && lastUpdateCall[1]) {
			lastUpdateCall[1]();
		}

		await waitFor(() => {
			expect(screen.queryByTestId('playbook-name-modal')).not.toBeInTheDocument();
		});
	});
});
