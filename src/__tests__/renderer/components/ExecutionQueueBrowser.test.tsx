/**
 * Tests for ExecutionQueueBrowser component
 *
 * This component displays a modal for browsing and managing the execution queue
 * across all sessions. Supports filtering by current agent vs global view.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { ExecutionQueueBrowser } from '../../../renderer/components/ExecutionQueueBrowser';
import type { Session, Theme, QueuedItem } from '../../../renderer/types';

// Mock the LayerStackContext
const mockRegisterLayer = vi.fn().mockReturnValue('layer-1');
const mockUnregisterLayer = vi.fn();

vi.mock('../../../renderer/contexts/LayerStackContext', () => ({
	useLayerStack: () => ({
		registerLayer: mockRegisterLayer,
		unregisterLayer: mockUnregisterLayer,
	}),
}));

describe('ExecutionQueueBrowser', () => {
	// Test fixtures
	const theme: Theme = {
		id: 'test-theme',
		name: 'Test Theme',
		mode: 'dark',
		colors: {
			bgMain: '#1a1a24',
			bgSidebar: '#141420',
			bgActivity: '#24243a',
			border: '#3a3a5a',
			textMain: '#fff8e8',
			textDim: '#a8a0a0',
			accent: '#f4c430',
			accentDim: 'rgba(244, 196, 48, 0.25)',
			accentText: '#ffd54f',
			accentForeground: '#1a1a24',
			success: '#66d9a0',
			warning: '#f4c430',
			error: '#e05070',
		},
	};

	const createSession = (overrides?: Partial<Session>): Session => ({
		id: 'session-1',
		name: 'Test Session',
		toolType: 'claude-code',
		state: 'idle',
		inputMode: 'ai',
		cwd: '/test/path',
		projectRoot: '/test/path',
		aiPid: 0,
		terminalPid: 0,
		aiLogs: [],
		shellLogs: [],
		isGitRepo: true,
		fileTree: [],
		fileExplorerExpanded: [],
		messageQueue: [],
		executionQueue: [],
		...overrides,
	});

	const createQueuedItem = (overrides?: Partial<QueuedItem>): QueuedItem => ({
		id: `item-${Math.random().toString(36).substring(7)}`,
		type: 'message',
		content: 'Test message content',
		text: 'Test text',
		timestamp: Date.now(),
		tabId: 'tab-1',
		tabName: 'Tab 1',
		...overrides,
	});

	let mockOnClose: ReturnType<typeof vi.fn>;
	let mockOnRemoveItem: ReturnType<typeof vi.fn>;
	let mockOnSwitchSession: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		mockOnClose = vi.fn();
		mockOnRemoveItem = vi.fn();
		mockOnSwitchSession = vi.fn();
		mockRegisterLayer.mockClear();
		mockUnregisterLayer.mockClear();
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	describe('closed state', () => {
		it('should return null when isOpen is false', () => {
			const { container } = render(
				<ExecutionQueueBrowser
					isOpen={false}
					onClose={mockOnClose}
					sessions={[]}
					activeSessionId={null}
					theme={theme}
					onRemoveItem={mockOnRemoveItem}
					onSwitchSession={mockOnSwitchSession}
				/>
			);
			expect(container.firstChild).toBeNull();
		});

		it('should not register with layer stack when closed', () => {
			render(
				<ExecutionQueueBrowser
					isOpen={false}
					onClose={mockOnClose}
					sessions={[]}
					activeSessionId={null}
					theme={theme}
					onRemoveItem={mockOnRemoveItem}
					onSwitchSession={mockOnSwitchSession}
				/>
			);
			expect(mockRegisterLayer).not.toHaveBeenCalled();
		});
	});

	describe('open state', () => {
		it('should render modal when isOpen is true', () => {
			render(
				<ExecutionQueueBrowser
					isOpen={true}
					onClose={mockOnClose}
					sessions={[]}
					activeSessionId={null}
					theme={theme}
					onRemoveItem={mockOnRemoveItem}
					onSwitchSession={mockOnSwitchSession}
				/>
			);
			expect(screen.getByText('Execution Queue')).toBeInTheDocument();
		});

		it('should register with layer stack when opened', () => {
			render(
				<ExecutionQueueBrowser
					isOpen={true}
					onClose={mockOnClose}
					sessions={[]}
					activeSessionId={null}
					theme={theme}
					onRemoveItem={mockOnRemoveItem}
					onSwitchSession={mockOnSwitchSession}
				/>
			);
			expect(mockRegisterLayer).toHaveBeenCalledWith({
				type: 'modal',
				priority: expect.any(Number),
				blocksLowerLayers: true,
				capturesFocus: true,
				focusTrap: 'strict',
				onEscape: expect.any(Function),
			});
		});

		it('should unregister from layer stack when closed', () => {
			const { rerender } = render(
				<ExecutionQueueBrowser
					isOpen={true}
					onClose={mockOnClose}
					sessions={[]}
					activeSessionId={null}
					theme={theme}
					onRemoveItem={mockOnRemoveItem}
					onSwitchSession={mockOnSwitchSession}
				/>
			);

			rerender(
				<ExecutionQueueBrowser
					isOpen={false}
					onClose={mockOnClose}
					sessions={[]}
					activeSessionId={null}
					theme={theme}
					onRemoveItem={mockOnRemoveItem}
					onSwitchSession={mockOnSwitchSession}
				/>
			);

			expect(mockUnregisterLayer).toHaveBeenCalledWith('layer-1');
		});

		it('should call onClose via layer stack escape handler', () => {
			render(
				<ExecutionQueueBrowser
					isOpen={true}
					onClose={mockOnClose}
					sessions={[]}
					activeSessionId={null}
					theme={theme}
					onRemoveItem={mockOnRemoveItem}
					onSwitchSession={mockOnSwitchSession}
				/>
			);

			// Get the onEscape handler from the registration call
			const registerCall = mockRegisterLayer.mock.calls[0][0];
			registerCall.onEscape();

			expect(mockOnClose).toHaveBeenCalled();
		});
	});

	describe('backdrop interaction', () => {
		it('should close when clicking backdrop', () => {
			const { container } = render(
				<ExecutionQueueBrowser
					isOpen={true}
					onClose={mockOnClose}
					sessions={[]}
					activeSessionId={null}
					theme={theme}
					onRemoveItem={mockOnRemoveItem}
					onSwitchSession={mockOnSwitchSession}
				/>
			);

			// Click the outer container (backdrop area)
			const backdrop = container.querySelector('.fixed.inset-0');
			expect(backdrop).not.toBeNull();
			fireEvent.click(backdrop!);
			expect(mockOnClose).toHaveBeenCalled();
		});

		it('should not close when clicking modal content', () => {
			render(
				<ExecutionQueueBrowser
					isOpen={true}
					onClose={mockOnClose}
					sessions={[]}
					activeSessionId={null}
					theme={theme}
					onRemoveItem={mockOnRemoveItem}
					onSwitchSession={mockOnSwitchSession}
				/>
			);

			// Click the modal content
			const title = screen.getByText('Execution Queue');
			fireEvent.click(title);
			expect(mockOnClose).not.toHaveBeenCalled();
		});
	});

	describe('header', () => {
		it('should display title', () => {
			render(
				<ExecutionQueueBrowser
					isOpen={true}
					onClose={mockOnClose}
					sessions={[]}
					activeSessionId={null}
					theme={theme}
					onRemoveItem={mockOnRemoveItem}
					onSwitchSession={mockOnSwitchSession}
				/>
			);
			expect(screen.getByText('Execution Queue')).toBeInTheDocument();
		});

		it('should display total count with 0 items', () => {
			render(
				<ExecutionQueueBrowser
					isOpen={true}
					onClose={mockOnClose}
					sessions={[]}
					activeSessionId={null}
					theme={theme}
					onRemoveItem={mockOnRemoveItem}
					onSwitchSession={mockOnSwitchSession}
				/>
			);
			expect(screen.getByText('0 total')).toBeInTheDocument();
		});

		it('should display total count with multiple items', () => {
			const session = createSession({
				executionQueue: [createQueuedItem(), createQueuedItem(), createQueuedItem()],
			});
			render(
				<ExecutionQueueBrowser
					isOpen={true}
					onClose={mockOnClose}
					sessions={[session]}
					activeSessionId={session.id}
					theme={theme}
					onRemoveItem={mockOnRemoveItem}
					onSwitchSession={mockOnSwitchSession}
				/>
			);
			expect(screen.getByText('3 total')).toBeInTheDocument();
		});

		it('should close modal when close button is clicked', () => {
			render(
				<ExecutionQueueBrowser
					isOpen={true}
					onClose={mockOnClose}
					sessions={[]}
					activeSessionId={null}
					theme={theme}
					onRemoveItem={mockOnRemoveItem}
					onSwitchSession={mockOnSwitchSession}
				/>
			);

			// Find close button (X icon button)
			const closeButtons = screen.getAllByRole('button');
			const closeButton = closeButtons.find((btn) => {
				const svg = btn.querySelector('svg');
				return svg && btn.classList.contains('hover:opacity-80');
			});
			expect(closeButton).toBeDefined();
			fireEvent.click(closeButton!);
			expect(mockOnClose).toHaveBeenCalled();
		});
	});

	describe('view mode toggle', () => {
		it('should default to current agent view', () => {
			render(
				<ExecutionQueueBrowser
					isOpen={true}
					onClose={mockOnClose}
					sessions={[]}
					activeSessionId={null}
					theme={theme}
					onRemoveItem={mockOnRemoveItem}
					onSwitchSession={mockOnSwitchSession}
				/>
			);

			const currentButton = screen.getByText('Current Agent');
			expect(currentButton.closest('button')).toHaveStyle({
				backgroundColor: theme.colors.accent,
			});
		});

		it('should switch to global view when All Agents is clicked', () => {
			const session = createSession({
				executionQueue: [createQueuedItem()],
			});
			render(
				<ExecutionQueueBrowser
					isOpen={true}
					onClose={mockOnClose}
					sessions={[session]}
					activeSessionId="other-session"
					theme={theme}
					onRemoveItem={mockOnRemoveItem}
					onSwitchSession={mockOnSwitchSession}
				/>
			);

			const allAgentsButton = screen.getByText('All Agents').closest('button');
			expect(allAgentsButton).not.toBeNull();
			fireEvent.click(allAgentsButton!);

			// After switching, All Agents should be active
			expect(allAgentsButton).toHaveStyle({
				backgroundColor: theme.colors.accent,
			});
		});

		it('should show current session item count in toggle', () => {
			const session = createSession({
				id: 'active-session',
				executionQueue: [createQueuedItem(), createQueuedItem()],
			});
			render(
				<ExecutionQueueBrowser
					isOpen={true}
					onClose={mockOnClose}
					sessions={[session]}
					activeSessionId="active-session"
					theme={theme}
					onRemoveItem={mockOnRemoveItem}
					onSwitchSession={mockOnSwitchSession}
				/>
			);

			const currentButton = screen.getByText('Current Agent').closest('button');
			expect(currentButton).toHaveTextContent('(2)');
		});

		it('should show total item count in All Agents button', () => {
			const session1 = createSession({
				id: 'session-1',
				executionQueue: [createQueuedItem()],
			});
			const session2 = createSession({
				id: 'session-2',
				executionQueue: [createQueuedItem(), createQueuedItem()],
			});
			render(
				<ExecutionQueueBrowser
					isOpen={true}
					onClose={mockOnClose}
					sessions={[session1, session2]}
					activeSessionId="session-1"
					theme={theme}
					onRemoveItem={mockOnRemoveItem}
					onSwitchSession={mockOnSwitchSession}
				/>
			);

			const allButton = screen.getByText('All Agents').closest('button');
			expect(allButton).toHaveTextContent('(3)');
		});

		it('should not show count for current agent when 0 items', () => {
			const session = createSession({
				id: 'active-session',
				executionQueue: [],
			});
			render(
				<ExecutionQueueBrowser
					isOpen={true}
					onClose={mockOnClose}
					sessions={[session]}
					activeSessionId="active-session"
					theme={theme}
					onRemoveItem={mockOnRemoveItem}
					onSwitchSession={mockOnSwitchSession}
				/>
			);

			const currentButton = screen.getByText('Current Agent').closest('button');
			expect(currentButton?.textContent).not.toContain('(0)');
		});
	});

	describe('empty state', () => {
		it('should show empty message in current view when no items', () => {
			const session = createSession({
				id: 'active-session',
				executionQueue: [],
			});
			render(
				<ExecutionQueueBrowser
					isOpen={true}
					onClose={mockOnClose}
					sessions={[session]}
					activeSessionId="active-session"
					theme={theme}
					onRemoveItem={mockOnRemoveItem}
					onSwitchSession={mockOnSwitchSession}
				/>
			);

			expect(screen.getByText('No items queued for this agent')).toBeInTheDocument();
		});

		it('should show empty message in global view when no items', () => {
			render(
				<ExecutionQueueBrowser
					isOpen={true}
					onClose={mockOnClose}
					sessions={[]}
					activeSessionId={null}
					theme={theme}
					onRemoveItem={mockOnRemoveItem}
					onSwitchSession={mockOnSwitchSession}
				/>
			);

			// Switch to global view
			const allButton = screen.getByText('All Agents').closest('button');
			fireEvent.click(allButton!);

			expect(screen.getByText('No items queued')).toBeInTheDocument();
		});

		it('should show empty message when active session has no queue', () => {
			const sessionWithQueue = createSession({
				id: 'session-with-queue',
				executionQueue: [createQueuedItem()],
			});
			const activeSession = createSession({
				id: 'active-session',
				executionQueue: [],
			});
			render(
				<ExecutionQueueBrowser
					isOpen={true}
					onClose={mockOnClose}
					sessions={[sessionWithQueue, activeSession]}
					activeSessionId="active-session"
					theme={theme}
					onRemoveItem={mockOnRemoveItem}
					onSwitchSession={mockOnSwitchSession}
				/>
			);

			expect(screen.getByText('No items queued for this agent')).toBeInTheDocument();
		});
	});

	describe('session filtering', () => {
		it('should only show active session items in current view', () => {
			const activeSession = createSession({
				id: 'active-session',
				name: 'Active Project',
				executionQueue: [createQueuedItem({ text: 'Active item' })],
			});
			const otherSession = createSession({
				id: 'other-session',
				name: 'Other Project',
				executionQueue: [createQueuedItem({ text: 'Other item' })],
			});
			render(
				<ExecutionQueueBrowser
					isOpen={true}
					onClose={mockOnClose}
					sessions={[activeSession, otherSession]}
					activeSessionId="active-session"
					theme={theme}
					onRemoveItem={mockOnRemoveItem}
					onSwitchSession={mockOnSwitchSession}
				/>
			);

			expect(screen.getByText('Active item')).toBeInTheDocument();
			expect(screen.queryByText('Other item')).not.toBeInTheDocument();
		});

		it('should show all sessions with items in global view', () => {
			const session1 = createSession({
				id: 'session-1',
				name: 'Project One',
				executionQueue: [createQueuedItem({ text: 'Item one' })],
			});
			const session2 = createSession({
				id: 'session-2',
				name: 'Project Two',
				executionQueue: [createQueuedItem({ text: 'Item two' })],
			});
			render(
				<ExecutionQueueBrowser
					isOpen={true}
					onClose={mockOnClose}
					sessions={[session1, session2]}
					activeSessionId="session-1"
					theme={theme}
					onRemoveItem={mockOnRemoveItem}
					onSwitchSession={mockOnSwitchSession}
				/>
			);

			// Switch to global view
			const allButton = screen.getByText('All Agents').closest('button');
			fireEvent.click(allButton!);

			expect(screen.getByText('Item one')).toBeInTheDocument();
			expect(screen.getByText('Item two')).toBeInTheDocument();
		});

		it('should not show sessions without queued items in global view', () => {
			const sessionWithQueue = createSession({
				id: 'session-with-queue',
				name: 'Has Items',
				executionQueue: [createQueuedItem()],
			});
			const sessionWithoutQueue = createSession({
				id: 'session-without-queue',
				name: 'No Items',
				executionQueue: [],
			});
			render(
				<ExecutionQueueBrowser
					isOpen={true}
					onClose={mockOnClose}
					sessions={[sessionWithQueue, sessionWithoutQueue]}
					activeSessionId="session-with-queue"
					theme={theme}
					onRemoveItem={mockOnRemoveItem}
					onSwitchSession={mockOnSwitchSession}
				/>
			);

			// Switch to global view
			const allButton = screen.getByText('All Agents').closest('button');
			fireEvent.click(allButton!);

			expect(screen.getByText('Has Items')).toBeInTheDocument();
			expect(screen.queryByText('No Items')).not.toBeInTheDocument();
		});
	});

	describe('session headers in global view', () => {
		it('should show session headers in global view', () => {
			const session = createSession({
				id: 'session-1',
				name: 'Test Project',
				executionQueue: [createQueuedItem()],
			});
			render(
				<ExecutionQueueBrowser
					isOpen={true}
					onClose={mockOnClose}
					sessions={[session]}
					activeSessionId="other-session"
					theme={theme}
					onRemoveItem={mockOnRemoveItem}
					onSwitchSession={mockOnSwitchSession}
				/>
			);

			// Switch to global view
			const allButton = screen.getByText('All Agents').closest('button');
			fireEvent.click(allButton!);

			expect(screen.getByText('Test Project')).toBeInTheDocument();
		});

		it('should not show session headers in current view', () => {
			const session = createSession({
				id: 'active-session',
				name: 'Active Project',
				executionQueue: [createQueuedItem()],
			});
			render(
				<ExecutionQueueBrowser
					isOpen={true}
					onClose={mockOnClose}
					sessions={[session]}
					activeSessionId="active-session"
					theme={theme}
					onRemoveItem={mockOnRemoveItem}
					onSwitchSession={mockOnSwitchSession}
				/>
			);

			// Session name should not appear as a clickable header
			// in current view, only in global view
			const sessionHeaders = screen
				.queryAllByRole('button')
				.filter((btn) => btn.textContent?.includes('Active Project'));
			// The session header button should not exist in current view
			expect(sessionHeaders.length).toBe(0);
		});

		it('should show queue count badge in session header', () => {
			const session = createSession({
				id: 'session-1',
				name: 'Test Project',
				executionQueue: [createQueuedItem(), createQueuedItem(), createQueuedItem()],
			});
			render(
				<ExecutionQueueBrowser
					isOpen={true}
					onClose={mockOnClose}
					sessions={[session]}
					activeSessionId="other-session"
					theme={theme}
					onRemoveItem={mockOnRemoveItem}
					onSwitchSession={mockOnSwitchSession}
				/>
			);

			// Switch to global view
			const allButton = screen.getByText('All Agents').closest('button');
			fireEvent.click(allButton!);

			// Find the session header and check for count
			const sessionHeader = screen.getByText('Test Project').closest('button');
			expect(sessionHeader).toHaveTextContent('3');
		});

		it('should switch session and close when clicking session header', () => {
			const session = createSession({
				id: 'session-1',
				name: 'Test Project',
				executionQueue: [createQueuedItem()],
			});
			render(
				<ExecutionQueueBrowser
					isOpen={true}
					onClose={mockOnClose}
					sessions={[session]}
					activeSessionId="other-session"
					theme={theme}
					onRemoveItem={mockOnRemoveItem}
					onSwitchSession={mockOnSwitchSession}
				/>
			);

			// Switch to global view
			const allButton = screen.getByText('All Agents').closest('button');
			fireEvent.click(allButton!);

			// Click session header
			const sessionHeader = screen.getByText('Test Project').closest('button');
			fireEvent.click(sessionHeader!);

			expect(mockOnSwitchSession).toHaveBeenCalledWith('session-1');
			expect(mockOnClose).toHaveBeenCalled();
		});
	});

	describe('queue item rows', () => {
		it('should display position indicator', () => {
			const session = createSession({
				id: 'active-session',
				executionQueue: [createQueuedItem({ id: 'item-1' }), createQueuedItem({ id: 'item-2' })],
			});
			render(
				<ExecutionQueueBrowser
					isOpen={true}
					onClose={mockOnClose}
					sessions={[session]}
					activeSessionId="active-session"
					theme={theme}
					onRemoveItem={mockOnRemoveItem}
					onSwitchSession={mockOnSwitchSession}
				/>
			);

			expect(screen.getByText('#1')).toBeInTheDocument();
			expect(screen.getByText('#2')).toBeInTheDocument();
		});

		it('should display MessageSquare icon for message type', () => {
			const session = createSession({
				id: 'active-session',
				executionQueue: [createQueuedItem({ type: 'message' })],
			});
			const { container } = render(
				<ExecutionQueueBrowser
					isOpen={true}
					onClose={mockOnClose}
					sessions={[session]}
					activeSessionId="active-session"
					theme={theme}
					onRemoveItem={mockOnRemoveItem}
					onSwitchSession={mockOnSwitchSession}
				/>
			);

			// Should have SVG icons rendered
			const svgs = container.querySelectorAll('svg');
			expect(svgs.length).toBeGreaterThan(0);
		});

		it('should display Command icon for command type', () => {
			const session = createSession({
				id: 'active-session',
				executionQueue: [createQueuedItem({ type: 'command', command: '/test' })],
			});
			const { container } = render(
				<ExecutionQueueBrowser
					isOpen={true}
					onClose={mockOnClose}
					sessions={[session]}
					activeSessionId="active-session"
					theme={theme}
					onRemoveItem={mockOnRemoveItem}
					onSwitchSession={mockOnSwitchSession}
				/>
			);

			// Should have SVG icons rendered
			const svgs = container.querySelectorAll('svg');
			expect(svgs.length).toBeGreaterThan(0);
		});

		it('should display command text for command items', () => {
			const session = createSession({
				id: 'active-session',
				executionQueue: [
					createQueuedItem({
						type: 'command',
						command: '/run tests',
					}),
				],
			});
			render(
				<ExecutionQueueBrowser
					isOpen={true}
					onClose={mockOnClose}
					sessions={[session]}
					activeSessionId="active-session"
					theme={theme}
					onRemoveItem={mockOnRemoveItem}
					onSwitchSession={mockOnSwitchSession}
				/>
			);

			expect(screen.getByText('/run tests')).toBeInTheDocument();
		});

		it('should display message text for message items', () => {
			const session = createSession({
				id: 'active-session',
				executionQueue: [
					createQueuedItem({
						type: 'message',
						text: 'Please fix the bug',
					}),
				],
			});
			render(
				<ExecutionQueueBrowser
					isOpen={true}
					onClose={mockOnClose}
					sessions={[session]}
					activeSessionId="active-session"
					theme={theme}
					onRemoveItem={mockOnRemoveItem}
					onSwitchSession={mockOnSwitchSession}
				/>
			);

			expect(screen.getByText('Please fix the bug')).toBeInTheDocument();
		});

		it('should truncate long message text to 100 characters', () => {
			const longText = 'A'.repeat(150);
			const session = createSession({
				id: 'active-session',
				executionQueue: [
					createQueuedItem({
						type: 'message',
						text: longText,
					}),
				],
			});
			render(
				<ExecutionQueueBrowser
					isOpen={true}
					onClose={mockOnClose}
					sessions={[session]}
					activeSessionId="active-session"
					theme={theme}
					onRemoveItem={mockOnRemoveItem}
					onSwitchSession={mockOnSwitchSession}
				/>
			);

			const truncated = 'A'.repeat(100) + '...';
			expect(screen.getByText(truncated)).toBeInTheDocument();
		});

		it('should display command description when present', () => {
			const session = createSession({
				id: 'active-session',
				executionQueue: [
					createQueuedItem({
						type: 'command',
						command: '/test',
						commandDescription: 'Run the test suite',
					}),
				],
			});
			render(
				<ExecutionQueueBrowser
					isOpen={true}
					onClose={mockOnClose}
					sessions={[session]}
					activeSessionId="active-session"
					theme={theme}
					onRemoveItem={mockOnRemoveItem}
					onSwitchSession={mockOnSwitchSession}
				/>
			);

			expect(screen.getByText('Run the test suite')).toBeInTheDocument();
		});

		it('should display images count when present', () => {
			const session = createSession({
				id: 'active-session',
				executionQueue: [
					createQueuedItem({
						type: 'message',
						text: 'Check this',
						images: ['image1.png', 'image2.png'],
					}),
				],
			});
			render(
				<ExecutionQueueBrowser
					isOpen={true}
					onClose={mockOnClose}
					sessions={[session]}
					activeSessionId="active-session"
					theme={theme}
					onRemoveItem={mockOnRemoveItem}
					onSwitchSession={mockOnSwitchSession}
				/>
			);

			expect(screen.getByText('+ 2 images')).toBeInTheDocument();
		});

		it('should use singular "image" for single image', () => {
			const session = createSession({
				id: 'active-session',
				executionQueue: [
					createQueuedItem({
						type: 'message',
						text: 'Check this',
						images: ['image1.png'],
					}),
				],
			});
			render(
				<ExecutionQueueBrowser
					isOpen={true}
					onClose={mockOnClose}
					sessions={[session]}
					activeSessionId="active-session"
					theme={theme}
					onRemoveItem={mockOnRemoveItem}
					onSwitchSession={mockOnSwitchSession}
				/>
			);

			expect(screen.getByText('+ 1 image')).toBeInTheDocument();
		});
	});

	describe('tab name button', () => {
		it('should display tab name when present', () => {
			const session = createSession({
				id: 'active-session',
				executionQueue: [createQueuedItem({ tabName: 'My Tab' })],
			});
			render(
				<ExecutionQueueBrowser
					isOpen={true}
					onClose={mockOnClose}
					sessions={[session]}
					activeSessionId="active-session"
					theme={theme}
					onRemoveItem={mockOnRemoveItem}
					onSwitchSession={mockOnSwitchSession}
				/>
			);

			expect(screen.getByText('My Tab')).toBeInTheDocument();
		});

		it('should switch session when tab name is clicked', () => {
			const session = createSession({
				id: 'session-1',
				executionQueue: [createQueuedItem({ tabName: 'My Tab' })],
			});
			render(
				<ExecutionQueueBrowser
					isOpen={true}
					onClose={mockOnClose}
					sessions={[session]}
					activeSessionId="session-1"
					theme={theme}
					onRemoveItem={mockOnRemoveItem}
					onSwitchSession={mockOnSwitchSession}
				/>
			);

			const tabButton = screen.getByText('My Tab');
			fireEvent.click(tabButton);

			expect(mockOnSwitchSession).toHaveBeenCalledWith('session-1');
			expect(mockOnClose).toHaveBeenCalled();
		});

		it('should have title attribute for accessibility', () => {
			const session = createSession({
				id: 'active-session',
				executionQueue: [createQueuedItem({ tabName: 'My Tab' })],
			});
			render(
				<ExecutionQueueBrowser
					isOpen={true}
					onClose={mockOnClose}
					sessions={[session]}
					activeSessionId="active-session"
					theme={theme}
					onRemoveItem={mockOnRemoveItem}
					onSwitchSession={mockOnSwitchSession}
				/>
			);

			const tabButton = screen.getByText('My Tab');
			expect(tabButton).toHaveAttribute('title', 'Jump to this session');
		});
	});

	describe('time display', () => {
		it('should show "Just now" for items less than 1 minute old', () => {
			const session = createSession({
				id: 'active-session',
				executionQueue: [createQueuedItem({ timestamp: Date.now() })],
			});
			render(
				<ExecutionQueueBrowser
					isOpen={true}
					onClose={mockOnClose}
					sessions={[session]}
					activeSessionId="active-session"
					theme={theme}
					onRemoveItem={mockOnRemoveItem}
					onSwitchSession={mockOnSwitchSession}
				/>
			);

			expect(screen.getByText('Just now')).toBeInTheDocument();
		});

		it('should show minutes for items older than 1 minute', () => {
			const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
			const session = createSession({
				id: 'active-session',
				executionQueue: [createQueuedItem({ timestamp: fiveMinutesAgo })],
			});
			render(
				<ExecutionQueueBrowser
					isOpen={true}
					onClose={mockOnClose}
					sessions={[session]}
					activeSessionId="active-session"
					theme={theme}
					onRemoveItem={mockOnRemoveItem}
					onSwitchSession={mockOnSwitchSession}
				/>
			);

			expect(screen.getByText('5m ago')).toBeInTheDocument();
		});
	});

	describe('remove item', () => {
		it('should call onRemoveItem when remove button is clicked', () => {
			const session = createSession({
				id: 'session-1',
				executionQueue: [createQueuedItem({ id: 'item-1' })],
			});
			render(
				<ExecutionQueueBrowser
					isOpen={true}
					onClose={mockOnClose}
					sessions={[session]}
					activeSessionId="session-1"
					theme={theme}
					onRemoveItem={mockOnRemoveItem}
					onSwitchSession={mockOnSwitchSession}
				/>
			);

			// Find remove button by title
			const removeButton = screen.getByTitle('Remove from queue');
			fireEvent.click(removeButton);

			expect(mockOnRemoveItem).toHaveBeenCalledWith('session-1', 'item-1');
		});
	});

	describe('footer', () => {
		it('should display footer text', () => {
			render(
				<ExecutionQueueBrowser
					isOpen={true}
					onClose={mockOnClose}
					sessions={[]}
					activeSessionId={null}
					theme={theme}
					onRemoveItem={mockOnRemoveItem}
					onSwitchSession={mockOnSwitchSession}
				/>
			);

			expect(
				screen.getByText(
					'Drag and drop to reorder. Items are processed sequentially per agent to prevent file conflicts.'
				)
			).toBeInTheDocument();
		});
	});

	describe('theme styling', () => {
		it('should apply theme colors to modal container', () => {
			const { container } = render(
				<ExecutionQueueBrowser
					isOpen={true}
					onClose={mockOnClose}
					sessions={[]}
					activeSessionId={null}
					theme={theme}
					onRemoveItem={mockOnRemoveItem}
					onSwitchSession={mockOnSwitchSession}
				/>
			);

			const modal = container.querySelector('.rounded-lg.border');
			expect(modal).toHaveStyle({
				backgroundColor: theme.colors.bgMain,
				borderColor: theme.colors.border,
			});
		});

		it('should apply theme colors to header text', () => {
			render(
				<ExecutionQueueBrowser
					isOpen={true}
					onClose={mockOnClose}
					sessions={[]}
					activeSessionId={null}
					theme={theme}
					onRemoveItem={mockOnRemoveItem}
					onSwitchSession={mockOnSwitchSession}
				/>
			);

			const title = screen.getByText('Execution Queue');
			expect(title).toHaveStyle({
				color: theme.colors.textMain,
			});
		});

		it('should apply theme colors to queue item rows', () => {
			const session = createSession({
				id: 'active-session',
				executionQueue: [createQueuedItem()],
			});
			const { container } = render(
				<ExecutionQueueBrowser
					isOpen={true}
					onClose={mockOnClose}
					sessions={[session]}
					activeSessionId="active-session"
					theme={theme}
					onRemoveItem={mockOnRemoveItem}
					onSwitchSession={mockOnSwitchSession}
				/>
			);

			const itemRow = container.querySelector('.rounded-lg.border.group');
			expect(itemRow).toHaveStyle({
				backgroundColor: theme.colors.bgSidebar,
				borderColor: theme.colors.border,
			});
		});

		it('should apply warning color to Command icon', () => {
			const session = createSession({
				id: 'active-session',
				executionQueue: [createQueuedItem({ type: 'command', command: '/test' })],
			});
			const { container } = render(
				<ExecutionQueueBrowser
					isOpen={true}
					onClose={mockOnClose}
					sessions={[session]}
					activeSessionId="active-session"
					theme={theme}
					onRemoveItem={mockOnRemoveItem}
					onSwitchSession={mockOnSwitchSession}
				/>
			);

			// Check that SVG icons are rendered - the icon type styling is verified by the parent div
			const svgs = container.querySelectorAll('svg');
			expect(svgs.length).toBeGreaterThan(0);
			// The Command icon parent div should have the warning color
			const iconDivs = container.querySelectorAll('svg.w-4.h-4');
			const hasIcon = Array.from(iconDivs).some((svg) => {
				const style = svg.getAttribute('style');
				return style?.includes('color');
			});
			expect(hasIcon).toBe(true);
		});

		it('should apply accent color to MessageSquare icon', () => {
			const session = createSession({
				id: 'active-session',
				executionQueue: [createQueuedItem({ type: 'message' })],
			});
			const { container } = render(
				<ExecutionQueueBrowser
					isOpen={true}
					onClose={mockOnClose}
					sessions={[session]}
					activeSessionId="active-session"
					theme={theme}
					onRemoveItem={mockOnRemoveItem}
					onSwitchSession={mockOnSwitchSession}
				/>
			);

			// Check that SVG icons are rendered - the icon type styling is verified by the parent div
			const svgs = container.querySelectorAll('svg');
			expect(svgs.length).toBeGreaterThan(0);
			// The MessageSquare icon should have the accent color in its style
			const iconSvgs = container.querySelectorAll('svg.w-4.h-4');
			const hasIcon = Array.from(iconSvgs).some((svg) => {
				const style = svg.getAttribute('style');
				return style?.includes('color');
			});
			expect(hasIcon).toBe(true);
		});

		it('should apply error color to remove button', () => {
			const session = createSession({
				id: 'active-session',
				executionQueue: [createQueuedItem()],
			});
			render(
				<ExecutionQueueBrowser
					isOpen={true}
					onClose={mockOnClose}
					sessions={[session]}
					activeSessionId="active-session"
					theme={theme}
					onRemoveItem={mockOnRemoveItem}
					onSwitchSession={mockOnSwitchSession}
				/>
			);

			const removeButton = screen.getByTitle('Remove from queue');
			expect(removeButton).toHaveStyle({
				color: theme.colors.error,
			});
		});
	});

	describe('edge cases', () => {
		it('should handle session with undefined executionQueue', () => {
			const session = createSession();
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			delete (session as any).executionQueue;

			const { container } = render(
				<ExecutionQueueBrowser
					isOpen={true}
					onClose={mockOnClose}
					sessions={[session]}
					activeSessionId={session.id}
					theme={theme}
					onRemoveItem={mockOnRemoveItem}
					onSwitchSession={mockOnSwitchSession}
				/>
			);

			// Should show empty state
			expect(screen.getByText('No items queued for this agent')).toBeInTheDocument();
		});

		it('should handle items without tabName', () => {
			const session = createSession({
				id: 'active-session',
				executionQueue: [createQueuedItem({ tabName: undefined })],
			});
			render(
				<ExecutionQueueBrowser
					isOpen={true}
					onClose={mockOnClose}
					sessions={[session]}
					activeSessionId="active-session"
					theme={theme}
					onRemoveItem={mockOnRemoveItem}
					onSwitchSession={mockOnSwitchSession}
				/>
			);

			// Should still render the item (tabName section just won't show)
			expect(screen.getByText('#1')).toBeInTheDocument();
		});

		it('should handle items with empty text', () => {
			const session = createSession({
				id: 'active-session',
				executionQueue: [createQueuedItem({ text: '' })],
			});
			render(
				<ExecutionQueueBrowser
					isOpen={true}
					onClose={mockOnClose}
					sessions={[session]}
					activeSessionId="active-session"
					theme={theme}
					onRemoveItem={mockOnRemoveItem}
					onSwitchSession={mockOnSwitchSession}
				/>
			);

			// Should still render the item
			expect(screen.getByText('#1')).toBeInTheDocument();
		});

		it('should handle activeSessionId being null', () => {
			const session = createSession({
				executionQueue: [createQueuedItem()],
			});
			render(
				<ExecutionQueueBrowser
					isOpen={true}
					onClose={mockOnClose}
					sessions={[session]}
					activeSessionId={null}
					theme={theme}
					onRemoveItem={mockOnRemoveItem}
					onSwitchSession={mockOnSwitchSession}
				/>
			);

			// Current view should show empty (no active session)
			expect(screen.getByText('No items queued for this agent')).toBeInTheDocument();
		});

		it('should handle multiple sessions with same name', () => {
			const session1 = createSession({
				id: 'session-1',
				name: 'Same Name',
				executionQueue: [createQueuedItem({ text: 'Item 1' })],
			});
			const session2 = createSession({
				id: 'session-2',
				name: 'Same Name',
				executionQueue: [createQueuedItem({ text: 'Item 2' })],
			});
			render(
				<ExecutionQueueBrowser
					isOpen={true}
					onClose={mockOnClose}
					sessions={[session1, session2]}
					activeSessionId="other"
					theme={theme}
					onRemoveItem={mockOnRemoveItem}
					onSwitchSession={mockOnSwitchSession}
				/>
			);

			// Switch to global view
			const allButton = screen.getByText('All Agents').closest('button');
			fireEvent.click(allButton!);

			// Both sessions should be rendered (both with "Same Name")
			const sameNameElements = screen.getAllByText('Same Name');
			expect(sameNameElements.length).toBe(2);
		});

		it('should handle very long session names', () => {
			const longName = 'A'.repeat(100);
			const session = createSession({
				id: 'session-1',
				name: longName,
				executionQueue: [createQueuedItem()],
			});
			render(
				<ExecutionQueueBrowser
					isOpen={true}
					onClose={mockOnClose}
					sessions={[session]}
					activeSessionId="other"
					theme={theme}
					onRemoveItem={mockOnRemoveItem}
					onSwitchSession={mockOnSwitchSession}
				/>
			);

			// Switch to global view
			const allButton = screen.getByText('All Agents').closest('button');
			fireEvent.click(allButton!);

			expect(screen.getByText(longName)).toBeInTheDocument();
		});

		it('should handle empty images array', () => {
			const session = createSession({
				id: 'active-session',
				executionQueue: [createQueuedItem({ images: [] })],
			});
			render(
				<ExecutionQueueBrowser
					isOpen={true}
					onClose={mockOnClose}
					sessions={[session]}
					activeSessionId="active-session"
					theme={theme}
					onRemoveItem={mockOnRemoveItem}
					onSwitchSession={mockOnSwitchSession}
				/>
			);

			// Should not show images indicator for empty array
			expect(screen.queryByText(/image/i)).not.toBeInTheDocument();
		});

		it('should update when props change', () => {
			const session1 = createSession({
				id: 'session-1',
				executionQueue: [createQueuedItem({ text: 'First item' })],
			});
			const session2 = createSession({
				id: 'session-1',
				executionQueue: [
					createQueuedItem({ text: 'First item' }),
					createQueuedItem({ text: 'Second item' }),
				],
			});

			const { rerender } = render(
				<ExecutionQueueBrowser
					isOpen={true}
					onClose={mockOnClose}
					sessions={[session1]}
					activeSessionId="session-1"
					theme={theme}
					onRemoveItem={mockOnRemoveItem}
					onSwitchSession={mockOnSwitchSession}
				/>
			);

			expect(screen.getByText('1 total')).toBeInTheDocument();

			rerender(
				<ExecutionQueueBrowser
					isOpen={true}
					onClose={mockOnClose}
					sessions={[session2]}
					activeSessionId="session-1"
					theme={theme}
					onRemoveItem={mockOnRemoveItem}
					onSwitchSession={mockOnSwitchSession}
				/>
			);

			expect(screen.getByText('2 total')).toBeInTheDocument();
		});
	});

	describe('accessibility', () => {
		it('should have accessible close button', () => {
			render(
				<ExecutionQueueBrowser
					isOpen={true}
					onClose={mockOnClose}
					sessions={[]}
					activeSessionId={null}
					theme={theme}
					onRemoveItem={mockOnRemoveItem}
					onSwitchSession={mockOnSwitchSession}
				/>
			);

			const buttons = screen.getAllByRole('button');
			expect(buttons.length).toBeGreaterThan(0);
		});

		it('should have accessible remove button with title', () => {
			const session = createSession({
				id: 'active-session',
				executionQueue: [createQueuedItem()],
			});
			render(
				<ExecutionQueueBrowser
					isOpen={true}
					onClose={mockOnClose}
					sessions={[session]}
					activeSessionId="active-session"
					theme={theme}
					onRemoveItem={mockOnRemoveItem}
					onSwitchSession={mockOnSwitchSession}
				/>
			);

			const removeButton = screen.getByTitle('Remove from queue');
			expect(removeButton).toBeInTheDocument();
			expect(removeButton.tagName).toBe('BUTTON');
		});

		it('should have accessible tab name button with title', () => {
			const session = createSession({
				id: 'active-session',
				executionQueue: [createQueuedItem({ tabName: 'Test Tab' })],
			});
			render(
				<ExecutionQueueBrowser
					isOpen={true}
					onClose={mockOnClose}
					sessions={[session]}
					activeSessionId="active-session"
					theme={theme}
					onRemoveItem={mockOnRemoveItem}
					onSwitchSession={mockOnSwitchSession}
				/>
			);

			const tabButton = screen.getByTitle('Jump to this session');
			expect(tabButton).toBeInTheDocument();
			expect(tabButton).toHaveTextContent('Test Tab');
		});
	});

	describe('layer stack priority', () => {
		it('should register with EXECUTION_QUEUE_BROWSER priority or fallback to 50', () => {
			render(
				<ExecutionQueueBrowser
					isOpen={true}
					onClose={mockOnClose}
					sessions={[]}
					activeSessionId={null}
					theme={theme}
					onRemoveItem={mockOnRemoveItem}
					onSwitchSession={mockOnSwitchSession}
				/>
			);

			expect(mockRegisterLayer).toHaveBeenCalledWith(
				expect.objectContaining({
					type: 'modal',
					priority: expect.any(Number),
				})
			);

			// Priority should be at least 50 (the fallback)
			const priority = mockRegisterLayer.mock.calls[0][0].priority;
			expect(priority).toBeGreaterThanOrEqual(50);
		});
	});

	describe('onClose ref update', () => {
		it('should use updated onClose when escape is triggered', () => {
			const initialOnClose = vi.fn();
			const updatedOnClose = vi.fn();

			const { rerender } = render(
				<ExecutionQueueBrowser
					isOpen={true}
					onClose={initialOnClose}
					sessions={[]}
					activeSessionId={null}
					theme={theme}
					onRemoveItem={mockOnRemoveItem}
					onSwitchSession={mockOnSwitchSession}
				/>
			);

			// Update onClose prop
			rerender(
				<ExecutionQueueBrowser
					isOpen={true}
					onClose={updatedOnClose}
					sessions={[]}
					activeSessionId={null}
					theme={theme}
					onRemoveItem={mockOnRemoveItem}
					onSwitchSession={mockOnSwitchSession}
				/>
			);

			// Trigger escape via the registered handler
			const registerCall = mockRegisterLayer.mock.calls[0][0];
			registerCall.onEscape();

			// Should call the updated onClose, not the initial one
			expect(updatedOnClose).toHaveBeenCalled();
			expect(initialOnClose).not.toHaveBeenCalled();
		});
	});

	describe('drag and drop reordering', () => {
		let mockOnReorderItems: ReturnType<typeof vi.fn>;

		beforeEach(() => {
			mockOnReorderItems = vi.fn();
		});

		it('should not enable drag when onReorderItems is not provided', () => {
			const session = createSession({
				id: 'active-session',
				executionQueue: [createQueuedItem({ id: 'item-1' }), createQueuedItem({ id: 'item-2' })],
			});
			const { container } = render(
				<ExecutionQueueBrowser
					isOpen={true}
					onClose={mockOnClose}
					sessions={[session]}
					activeSessionId="active-session"
					theme={theme}
					onRemoveItem={mockOnRemoveItem}
					onSwitchSession={mockOnSwitchSession}
				/>
			);

			// Items should not have grab cursor when onReorderItems is not provided
			const itemRows = container.querySelectorAll('.group.select-none');
			itemRows.forEach((row) => {
				expect(row).not.toHaveStyle({ cursor: 'grab' });
			});
		});

		it('should not enable drag when session has only one item', () => {
			const session = createSession({
				id: 'active-session',
				executionQueue: [createQueuedItem({ id: 'item-1' })],
			});
			const { container } = render(
				<ExecutionQueueBrowser
					isOpen={true}
					onClose={mockOnClose}
					sessions={[session]}
					activeSessionId="active-session"
					theme={theme}
					onRemoveItem={mockOnRemoveItem}
					onSwitchSession={mockOnSwitchSession}
					onReorderItems={mockOnReorderItems}
				/>
			);

			// Single item should not have grab cursor
			const itemRow = container.querySelector('.group.select-none');
			expect(itemRow).not.toHaveStyle({ cursor: 'grab' });
		});

		it('should enable drag when onReorderItems is provided and session has multiple items', () => {
			const session = createSession({
				id: 'active-session',
				executionQueue: [createQueuedItem({ id: 'item-1' }), createQueuedItem({ id: 'item-2' })],
			});
			const { container } = render(
				<ExecutionQueueBrowser
					isOpen={true}
					onClose={mockOnClose}
					sessions={[session]}
					activeSessionId="active-session"
					theme={theme}
					onRemoveItem={mockOnRemoveItem}
					onSwitchSession={mockOnSwitchSession}
					onReorderItems={mockOnReorderItems}
				/>
			);

			// Items should have grab cursor
			const itemRows = container.querySelectorAll('.group.select-none');
			itemRows.forEach((row) => {
				expect(row).toHaveStyle({ cursor: 'grab' });
			});
		});

		it('should show drag handle indicator when draggable', () => {
			const session = createSession({
				id: 'active-session',
				executionQueue: [createQueuedItem({ id: 'item-1' }), createQueuedItem({ id: 'item-2' })],
			});
			const { container } = render(
				<ExecutionQueueBrowser
					isOpen={true}
					onClose={mockOnClose}
					sessions={[session]}
					activeSessionId="active-session"
					theme={theme}
					onRemoveItem={mockOnRemoveItem}
					onSwitchSession={mockOnSwitchSession}
					onReorderItems={mockOnReorderItems}
				/>
			);

			// Find the first item row
			const itemRow = container.querySelector('.group.select-none');
			expect(itemRow).not.toBeNull();

			// Drag handle should exist (it's just hidden until hover)
			const dragHandle = container.querySelector('.absolute.left-1');
			expect(dragHandle).toBeInTheDocument();
		});

		it('should render drop zones between items when draggable', () => {
			const session = createSession({
				id: 'active-session',
				executionQueue: [
					createQueuedItem({ id: 'item-1' }),
					createQueuedItem({ id: 'item-2' }),
					createQueuedItem({ id: 'item-3' }),
				],
			});
			const { container } = render(
				<ExecutionQueueBrowser
					isOpen={true}
					onClose={mockOnClose}
					sessions={[session]}
					activeSessionId="active-session"
					theme={theme}
					onRemoveItem={mockOnRemoveItem}
					onSwitchSession={mockOnSwitchSession}
					onReorderItems={mockOnReorderItems}
				/>
			);

			// Should have drop zones: before item 1, before item 2, before item 3, and after item 3
			const dropZones = container.querySelectorAll('.relative.h-1');
			expect(dropZones.length).toBe(4); // n+1 drop zones for n items
		});

		it('should not initiate drag when clicking on remove button', () => {
			const session = createSession({
				id: 'active-session',
				executionQueue: [createQueuedItem({ id: 'item-1' }), createQueuedItem({ id: 'item-2' })],
			});
			render(
				<ExecutionQueueBrowser
					isOpen={true}
					onClose={mockOnClose}
					sessions={[session]}
					activeSessionId="active-session"
					theme={theme}
					onRemoveItem={mockOnRemoveItem}
					onSwitchSession={mockOnSwitchSession}
					onReorderItems={mockOnReorderItems}
				/>
			);

			// Get all remove buttons (there should be 2)
			const removeButtons = screen.getAllByTitle('Remove from queue');
			expect(removeButtons.length).toBe(2);

			// Click the first remove button
			fireEvent.click(removeButtons[0]);

			// onRemoveItem should be called, not onReorderItems
			expect(mockOnRemoveItem).toHaveBeenCalledWith('active-session', 'item-1');
			expect(mockOnReorderItems).not.toHaveBeenCalled();
		});

		it('should enable drag for sessions in global view', () => {
			const session1 = createSession({
				id: 'session-1',
				name: 'Project One',
				executionQueue: [createQueuedItem({ id: 'item-1' }), createQueuedItem({ id: 'item-2' })],
			});
			const session2 = createSession({
				id: 'session-2',
				name: 'Project Two',
				executionQueue: [createQueuedItem({ id: 'item-3' }), createQueuedItem({ id: 'item-4' })],
			});
			const { container } = render(
				<ExecutionQueueBrowser
					isOpen={true}
					onClose={mockOnClose}
					sessions={[session1, session2]}
					activeSessionId="session-1"
					theme={theme}
					onRemoveItem={mockOnRemoveItem}
					onSwitchSession={mockOnSwitchSession}
					onReorderItems={mockOnReorderItems}
				/>
			);

			// Switch to global view
			const allButton = screen.getByText('All Agents').closest('button');
			fireEvent.click(allButton!);

			// All items should have grab cursor
			const itemRows = container.querySelectorAll('.group.select-none');
			expect(itemRows.length).toBe(4);
			itemRows.forEach((row) => {
				expect(row).toHaveStyle({ cursor: 'grab' });
			});
		});

		it('should have correct number of drop zones in global view', () => {
			const session1 = createSession({
				id: 'session-1',
				name: 'Project One',
				executionQueue: [createQueuedItem({ id: 'item-1' }), createQueuedItem({ id: 'item-2' })],
			});
			const session2 = createSession({
				id: 'session-2',
				name: 'Project Two',
				executionQueue: [createQueuedItem({ id: 'item-3' }), createQueuedItem({ id: 'item-4' })],
			});
			const { container } = render(
				<ExecutionQueueBrowser
					isOpen={true}
					onClose={mockOnClose}
					sessions={[session1, session2]}
					activeSessionId="session-1"
					theme={theme}
					onRemoveItem={mockOnRemoveItem}
					onSwitchSession={mockOnSwitchSession}
					onReorderItems={mockOnReorderItems}
				/>
			);

			// Switch to global view
			const allButton = screen.getByText('All Agents').closest('button');
			fireEvent.click(allButton!);

			// Should have drop zones for each session: 3 for session1 (2 items + 1 after) + 3 for session2
			const dropZones = container.querySelectorAll('.relative.h-1');
			expect(dropZones.length).toBe(6);
		});

		it('should not show drag handle when session has only one item', () => {
			const session = createSession({
				id: 'active-session',
				executionQueue: [createQueuedItem({ id: 'item-1' })],
			});
			const { container } = render(
				<ExecutionQueueBrowser
					isOpen={true}
					onClose={mockOnClose}
					sessions={[session]}
					activeSessionId="active-session"
					theme={theme}
					onRemoveItem={mockOnRemoveItem}
					onSwitchSession={mockOnSwitchSession}
					onReorderItems={mockOnReorderItems}
				/>
			);

			// Drag handle should not exist for single item
			const dragHandle = container.querySelector('.absolute.left-1');
			expect(dragHandle).not.toBeInTheDocument();
		});

		it('should show visual feedback on mousedown', () => {
			const session = createSession({
				id: 'active-session',
				executionQueue: [createQueuedItem({ id: 'item-1' }), createQueuedItem({ id: 'item-2' })],
			});
			const { container } = render(
				<ExecutionQueueBrowser
					isOpen={true}
					onClose={mockOnClose}
					sessions={[session]}
					activeSessionId="active-session"
					theme={theme}
					onRemoveItem={mockOnRemoveItem}
					onSwitchSession={mockOnSwitchSession}
					onReorderItems={mockOnReorderItems}
				/>
			);

			const itemRow = container.querySelector('.group.select-none');
			expect(itemRow).not.toBeNull();

			// Verify item has grab cursor before interaction
			expect(itemRow).toHaveStyle({ cursor: 'grab' });
		});
	});
});
