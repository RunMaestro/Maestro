// Source: src/__tests__/renderer/components/TabBar.windowScoping.test.tsx
// Source: src/__tests__/renderer/components/RenameTabModal.test.tsx
import { describe as describeSourceSuite } from 'vitest';
import { render } from '@testing-library/react';
import { screen } from '@testing-library/react';
import { waitFor } from '@testing-library/react';
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { vi } from 'vitest';
import { beforeEach } from 'vitest';
import { afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { TabBar } from '../../../renderer/components/TabBar';
import { WindowProvider } from '../../../renderer/contexts/WindowContext';
import type { AITab } from '../../../renderer/types';
import type { WindowInfo } from '../../../shared/window-types';
import type { WindowState } from '../../../shared/window-types';
import { mockTheme } from '../../helpers/mockTheme';
import { fireEvent } from '@testing-library/react';
import { cleanup } from '@testing-library/react';
import React from 'react';
import { RenameTabModal } from '../../../renderer/components/RenameTabModal';
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';
import type { Theme } from '../../../renderer/types';
import { createMockTheme } from '../../helpers/mockTheme';
describeSourceSuite('TabBar.windowScoping', () => {
	const windows = () => window.maestro.windows;

	function createTab(): AITab {
		return {
			id: 'tab-1',
			agentSessionId: undefined,
			state: 'idle',
			name: 'My Tab',
			starred: false,
			hasUnread: false,
			inputValue: '',
			stagedImages: [],
		};
	}

	function makeState(partial: Partial<WindowState> & Pick<WindowState, 'id'>): WindowState {
		return {
			x: 0,
			y: 0,
			width: 1200,
			height: 800,
			isMaximized: false,
			isFullScreen: false,
			sessionIds: [],
			activeSessionId: null,
			leftPanelCollapsed: false,
			rightPanelCollapsed: false,
			...partial,
		};
	}

	function makeInfo(partial: Partial<WindowInfo> & Pick<WindowInfo, 'id'>): WindowInfo {
		return { isMain: false, sessionIds: [], activeSessionId: null, ...partial };
	}

	function setUrl(search: string): void {
		window.history.replaceState({}, '', search || '/');
	}

	function renderInWindow(sessionId: string) {
		function wrapper({ children }: { children: ReactNode }) {
			return <WindowProvider>{children}</WindowProvider>;
		}
		return render(
			<TabBar
				tabs={[createTab()]}
				activeTabId="tab-1"
				theme={mockTheme}
				sessionId={sessionId}
				onTabSelect={vi.fn()}
				onTabClose={vi.fn()}
				onNewTab={vi.fn()}
			/>,
			{ wrapper }
		);
	}

	describe('TabBar - window scoping', () => {
		beforeEach(() => {
			vi.clearAllMocks();
			setUrl('/');
			vi.mocked(windows().getState).mockResolvedValue(null);
			vi.mocked(windows().list).mockResolvedValue([]);
		});

		afterEach(() => {
			setUrl('/');
		});

		it('renders normally without a WindowProvider (single-window fallback)', () => {
			render(
				<TabBar
					tabs={[createTab()]}
					activeTabId="tab-1"
					theme={mockTheme}
					sessionId="agent-A"
					onTabSelect={vi.fn()}
					onTabClose={vi.fn()}
					onNewTab={vi.fn()}
				/>
			);
			expect(screen.getByText('My Tab')).toBeInTheDocument();
		});

		it('primary window surfaces the active agent (catch-all owner)', async () => {
			setUrl('/');
			vi.mocked(windows().getState).mockResolvedValue(makeState({ id: 'primary-1' }));
			vi.mocked(windows().list).mockResolvedValue([makeInfo({ id: 'primary-1', isMain: true })]);

			renderInWindow('agent-A');

			expect(await screen.findByText('My Tab')).toBeInTheDocument();
		});

		it('primary window hides an agent a secondary window has claimed', async () => {
			setUrl('/');
			vi.mocked(windows().getState).mockResolvedValue(makeState({ id: 'primary-1' }));
			vi.mocked(windows().list).mockResolvedValue([
				makeInfo({ id: 'primary-1', isMain: true }),
				makeInfo({ id: 'win-2', sessionIds: ['agent-A'], activeSessionId: 'agent-A' }),
			]);

			renderInWindow('agent-A');

			// Once the registry snapshot hydrates, the claimed agent's strip disappears.
			await waitFor(() => expect(screen.queryByText('My Tab')).not.toBeInTheDocument());
		});

		it('secondary window shows an empty tab area for an agent it does not own', async () => {
			setUrl('/?windowId=win-2');
			vi.mocked(windows().getState).mockResolvedValue(
				makeState({ id: 'win-2', sessionIds: [], activeSessionId: null })
			);

			renderInWindow('agent-A');

			await waitFor(() => expect(windows().getState).toHaveBeenCalled());
			expect(screen.queryByText('My Tab')).not.toBeInTheDocument();
			// The tab-bar chrome (new-tab button) still renders - only the strip is empty.
			expect(screen.getByTitle(/New tab/)).toBeInTheDocument();
		});

		it('secondary window surfaces an agent it does own', async () => {
			setUrl('/?windowId=win-2');
			vi.mocked(windows().getState).mockResolvedValue(
				makeState({ id: 'win-2', sessionIds: ['agent-A'], activeSessionId: 'agent-A' })
			);

			renderInWindow('agent-A');

			expect(await screen.findByText('My Tab')).toBeInTheDocument();
		});
	});
});
describeSourceSuite('RenameTabModal', () => {
	// Wrapper component to provide LayerStackContext
	const TestWrapper: React.FC<{ children: React.ReactNode }> = ({ children }) => (
		<LayerStackProvider>{children}</LayerStackProvider>
	);

	describe('RenameTabModal', () => {
		const mockTheme = createMockTheme();
		let mockOnClose: ReturnType<typeof vi.fn>;
		let mockOnRename: ReturnType<typeof vi.fn>;

		beforeEach(() => {
			mockOnClose = vi.fn();
			mockOnRename = vi.fn();
		});

		afterEach(() => {
			cleanup();
			vi.clearAllMocks();
		});

		describe('Basic Rendering', () => {
			it('renders the modal with title', () => {
				render(
					<TestWrapper>
						<RenameTabModal
							theme={mockTheme}
							initialName="My Tab"
							onClose={mockOnClose}
							onRename={mockOnRename}
						/>
					</TestWrapper>
				);

				expect(screen.getByText('Rename Tab')).toBeInTheDocument();
			});

			it('renders input with initial name', () => {
				render(
					<TestWrapper>
						<RenameTabModal
							theme={mockTheme}
							initialName="My Tab"
							onClose={mockOnClose}
							onRename={mockOnRename}
						/>
					</TestWrapper>
				);

				const input = screen.getByRole('textbox');
				expect(input).toHaveValue('My Tab');
			});

			it('renders Cancel button', () => {
				render(
					<TestWrapper>
						<RenameTabModal
							theme={mockTheme}
							initialName="My Tab"
							onClose={mockOnClose}
							onRename={mockOnRename}
						/>
					</TestWrapper>
				);

				expect(screen.getByText('Cancel')).toBeInTheDocument();
			});

			it('renders Rename button', () => {
				render(
					<TestWrapper>
						<RenameTabModal
							theme={mockTheme}
							initialName="My Tab"
							onClose={mockOnClose}
							onRename={mockOnRename}
						/>
					</TestWrapper>
				);

				expect(screen.getByText('Rename')).toBeInTheDocument();
			});

			it('has proper dialog accessibility attributes', () => {
				render(
					<TestWrapper>
						<RenameTabModal
							theme={mockTheme}
							initialName="My Tab"
							onClose={mockOnClose}
							onRename={mockOnRename}
						/>
					</TestWrapper>
				);

				const dialog = screen.getByRole('dialog');
				expect(dialog).toHaveAttribute('aria-modal', 'true');
				expect(dialog).toHaveAttribute('aria-label', 'Rename Tab');
			});
		});

		describe('Placeholder', () => {
			it('shows default placeholder when no agentSessionId', () => {
				render(
					<TestWrapper>
						<RenameTabModal
							theme={mockTheme}
							initialName=""
							onClose={mockOnClose}
							onRename={mockOnRename}
						/>
					</TestWrapper>
				);

				const input = screen.getByRole('textbox');
				expect(input).toHaveAttribute('placeholder', 'Enter tab name...');
			});

			it('shows UUID-based placeholder when agentSessionId is provided', () => {
				render(
					<TestWrapper>
						<RenameTabModal
							theme={mockTheme}
							initialName=""
							agentSessionId="abc123-def456-ghi789"
							onClose={mockOnClose}
							onRename={mockOnRename}
						/>
					</TestWrapper>
				);

				const input = screen.getByRole('textbox');
				expect(input).toHaveAttribute('placeholder', 'Rename ABC123...');
			});

			it('handles null agentSessionId', () => {
				render(
					<TestWrapper>
						<RenameTabModal
							theme={mockTheme}
							initialName=""
							agentSessionId={null}
							onClose={mockOnClose}
							onRename={mockOnRename}
						/>
					</TestWrapper>
				);

				const input = screen.getByRole('textbox');
				expect(input).toHaveAttribute('placeholder', 'Enter tab name...');
			});
		});

		describe('Button Actions', () => {
			it('calls onClose when Cancel button is clicked', () => {
				render(
					<TestWrapper>
						<RenameTabModal
							theme={mockTheme}
							initialName="My Tab"
							onClose={mockOnClose}
							onRename={mockOnRename}
						/>
					</TestWrapper>
				);

				fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

				expect(mockOnClose).toHaveBeenCalledTimes(1);
				expect(mockOnRename).not.toHaveBeenCalled();
			});

			it('calls onRename and onClose when Rename button is clicked', () => {
				render(
					<TestWrapper>
						<RenameTabModal
							theme={mockTheme}
							initialName="My Tab"
							onClose={mockOnClose}
							onRename={mockOnRename}
						/>
					</TestWrapper>
				);

				fireEvent.click(screen.getByRole('button', { name: 'Rename' }));

				expect(mockOnRename).toHaveBeenCalledWith('My Tab');
				expect(mockOnClose).toHaveBeenCalledTimes(1);
			});

			it('calls onClose when X button is clicked', () => {
				const { container } = render(
					<TestWrapper>
						<RenameTabModal
							theme={mockTheme}
							initialName="My Tab"
							onClose={mockOnClose}
							onRename={mockOnRename}
						/>
					</TestWrapper>
				);

				// Find the X button (close button in header)
				const closeIcon = screen.getAllByTestId('x-icon')[0];
				const closeButton = closeIcon.closest('button');
				expect(closeButton).toBeTruthy();
				fireEvent.click(closeButton!);

				expect(mockOnClose).toHaveBeenCalledTimes(1);
				expect(mockOnRename).not.toHaveBeenCalled();
			});
		});

		describe('Input Handling', () => {
			it('updates value when typing', () => {
				render(
					<TestWrapper>
						<RenameTabModal
							theme={mockTheme}
							initialName="My Tab"
							onClose={mockOnClose}
							onRename={mockOnRename}
						/>
					</TestWrapper>
				);

				const input = screen.getByRole('textbox');
				fireEvent.change(input, { target: { value: 'New Name' } });

				expect(input).toHaveValue('New Name');
			});

			it('submits on Enter key', () => {
				render(
					<TestWrapper>
						<RenameTabModal
							theme={mockTheme}
							initialName="My Tab"
							onClose={mockOnClose}
							onRename={mockOnRename}
						/>
					</TestWrapper>
				);

				const input = screen.getByRole('textbox');
				fireEvent.keyDown(input, { key: 'Enter' });

				expect(mockOnRename).toHaveBeenCalledWith('My Tab');
				expect(mockOnClose).toHaveBeenCalledTimes(1);
			});

			it('trims whitespace when submitting', () => {
				render(
					<TestWrapper>
						<RenameTabModal
							theme={mockTheme}
							initialName="  Padded Name  "
							onClose={mockOnClose}
							onRename={mockOnRename}
						/>
					</TestWrapper>
				);

				fireEvent.click(screen.getByRole('button', { name: 'Rename' }));

				expect(mockOnRename).toHaveBeenCalledWith('Padded Name');
			});

			it('submits trimmed value on Enter', () => {
				render(
					<TestWrapper>
						<RenameTabModal
							theme={mockTheme}
							initialName="My Tab"
							onClose={mockOnClose}
							onRename={mockOnRename}
						/>
					</TestWrapper>
				);

				const input = screen.getByRole('textbox');
				fireEvent.change(input, { target: { value: '  New Name  ' } });
				fireEvent.keyDown(input, { key: 'Enter' });

				expect(mockOnRename).toHaveBeenCalledWith('New Name');
			});
		});

		describe('Auto Focus', () => {
			it('input receives focus on mount', async () => {
				render(
					<TestWrapper>
						<RenameTabModal
							theme={mockTheme}
							initialName="My Tab"
							onClose={mockOnClose}
							onRename={mockOnRename}
						/>
					</TestWrapper>
				);

				const input = screen.getByRole('textbox');

				// Wait for requestAnimationFrame to complete
				await waitFor(() => {
					expect(document.activeElement).toBe(input);
				});
			});
		});

		describe('Theme Styling', () => {
			it('applies theme colors to modal container', () => {
				const { container } = render(
					<TestWrapper>
						<RenameTabModal
							theme={mockTheme}
							initialName="My Tab"
							onClose={mockOnClose}
							onRename={mockOnRename}
						/>
					</TestWrapper>
				);

				// Modal component uses inline style for width instead of Tailwind class
				const modalBox = container.querySelector('[style*="width: min(calc(400px"]');
				expect(modalBox).toHaveStyle({
					backgroundColor: mockTheme.colors.bgSidebar,
					borderColor: mockTheme.colors.border,
				});
			});

			it('applies accent color to Rename button', () => {
				render(
					<TestWrapper>
						<RenameTabModal
							theme={mockTheme}
							initialName="My Tab"
							onClose={mockOnClose}
							onRename={mockOnRename}
						/>
					</TestWrapper>
				);

				const renameButton = screen.getByText('Rename');
				expect(renameButton).toHaveStyle({
					backgroundColor: mockTheme.colors.accent,
					color: mockTheme.colors.accentForeground,
				});
			});

			it('applies theme colors to title', () => {
				render(
					<TestWrapper>
						<RenameTabModal
							theme={mockTheme}
							initialName="My Tab"
							onClose={mockOnClose}
							onRename={mockOnRename}
						/>
					</TestWrapper>
				);

				const title = screen.getByText('Rename Tab');
				expect(title).toHaveStyle({
					color: mockTheme.colors.textMain,
				});
			});

			it('applies theme colors to input', () => {
				render(
					<TestWrapper>
						<RenameTabModal
							theme={mockTheme}
							initialName="My Tab"
							onClose={mockOnClose}
							onRename={mockOnRename}
						/>
					</TestWrapper>
				);

				const input = screen.getByRole('textbox');
				expect(input).toHaveStyle({
					borderColor: mockTheme.colors.border,
					color: mockTheme.colors.textMain,
				});
			});

			it('applies dim color to close button', () => {
				const { container } = render(
					<TestWrapper>
						<RenameTabModal
							theme={mockTheme}
							initialName="My Tab"
							onClose={mockOnClose}
							onRename={mockOnRename}
						/>
					</TestWrapper>
				);

				const closeIcon = screen.getAllByTestId('x-icon')[0];
				const closeButton = closeIcon.closest('button');
				expect(closeButton).toHaveStyle({
					color: mockTheme.colors.textDim,
				});
			});
		});

		describe('Modal Layout', () => {
			it('has fixed positioning with backdrop', () => {
				render(
					<TestWrapper>
						<RenameTabModal
							theme={mockTheme}
							initialName="My Tab"
							onClose={mockOnClose}
							onRename={mockOnRename}
						/>
					</TestWrapper>
				);

				const dialog = screen.getByRole('dialog');
				expect(dialog).toHaveClass('fixed', 'inset-0');
			});

			it('has proper width style', () => {
				const { container } = render(
					<TestWrapper>
						<RenameTabModal
							theme={mockTheme}
							initialName="My Tab"
							onClose={mockOnClose}
							onRename={mockOnRename}
						/>
					</TestWrapper>
				);

				// Modal component uses inline style for width instead of Tailwind class
				const modalBox = container.querySelector('[style*="width: min(calc(400px"]');
				expect(modalBox).toBeInTheDocument();
			});
		});

		describe('Edge Cases', () => {
			it('handles empty initial name', () => {
				render(
					<TestWrapper>
						<RenameTabModal
							theme={mockTheme}
							initialName=""
							onClose={mockOnClose}
							onRename={mockOnRename}
						/>
					</TestWrapper>
				);

				const input = screen.getByRole('textbox');
				expect(input).toHaveValue('');
			});

			it('handles renaming to empty string', () => {
				render(
					<TestWrapper>
						<RenameTabModal
							theme={mockTheme}
							initialName="My Tab"
							onClose={mockOnClose}
							onRename={mockOnRename}
						/>
					</TestWrapper>
				);

				const input = screen.getByRole('textbox');
				fireEvent.change(input, { target: { value: '' } });
				fireEvent.click(screen.getByRole('button', { name: 'Rename' }));

				expect(mockOnRename).toHaveBeenCalledWith('');
			});

			it('handles special characters in name', () => {
				render(
					<TestWrapper>
						<RenameTabModal
							theme={mockTheme}
							initialName="Tab <script>alert('xss')</script>"
							onClose={mockOnClose}
							onRename={mockOnRename}
						/>
					</TestWrapper>
				);

				const input = screen.getByRole('textbox');
				expect(input).toHaveValue("Tab <script>alert('xss')</script>");
			});

			it('handles very long name', () => {
				const longName = 'A'.repeat(200);
				render(
					<TestWrapper>
						<RenameTabModal
							theme={mockTheme}
							initialName={longName}
							onClose={mockOnClose}
							onRename={mockOnRename}
						/>
					</TestWrapper>
				);

				const input = screen.getByRole('textbox');
				expect(input).toHaveValue(longName);
			});
		});

		describe('Other Keys', () => {
			it('does not submit on other keys', () => {
				render(
					<TestWrapper>
						<RenameTabModal
							theme={mockTheme}
							initialName="My Tab"
							onClose={mockOnClose}
							onRename={mockOnRename}
						/>
					</TestWrapper>
				);

				const input = screen.getByRole('textbox');
				fireEvent.keyDown(input, { key: 'Tab' });
				fireEvent.keyDown(input, { key: 'Escape' });
				fireEvent.keyDown(input, { key: 'a' });

				expect(mockOnRename).not.toHaveBeenCalled();
			});
		});

		describe('Auto Button', () => {
			it('does not render Auto button when onAutoName is not provided', () => {
				render(
					<TestWrapper>
						<RenameTabModal
							theme={mockTheme}
							initialName="My Tab"
							onClose={mockOnClose}
							onRename={mockOnRename}
						/>
					</TestWrapper>
				);

				expect(screen.queryByText('Auto')).not.toBeInTheDocument();
			});

			it('does not render Auto button when hasLogs is false', () => {
				render(
					<TestWrapper>
						<RenameTabModal
							theme={mockTheme}
							initialName="My Tab"
							onClose={mockOnClose}
							onRename={mockOnRename}
							onAutoName={vi.fn()}
							hasLogs={false}
						/>
					</TestWrapper>
				);

				expect(screen.queryByText('Auto')).not.toBeInTheDocument();
			});

			it('renders Auto button when onAutoName and hasLogs are provided', () => {
				render(
					<TestWrapper>
						<RenameTabModal
							theme={mockTheme}
							initialName="My Tab"
							onClose={mockOnClose}
							onRename={mockOnRename}
							onAutoName={vi.fn()}
							hasLogs={true}
						/>
					</TestWrapper>
				);

				expect(screen.getByText('Auto')).toBeInTheDocument();
			});

			it('renders Auto button tooltip with renderer-safe shortcut formatting', () => {
				render(
					<TestWrapper>
						<RenameTabModal
							theme={mockTheme}
							initialName="My Tab"
							onClose={mockOnClose}
							onRename={mockOnRename}
							onAutoName={vi.fn()}
							hasLogs={true}
						/>
					</TestWrapper>
				);

				expect(screen.getByRole('button', { name: 'Auto' })).toHaveAttribute(
					'title',
					'Auto-rename (Ctrl+Shift+Enter)'
				);
			});

			it('calls onAutoName when Auto button is clicked', () => {
				const mockOnAutoName = vi.fn();

				render(
					<TestWrapper>
						<RenameTabModal
							theme={mockTheme}
							initialName="My Tab"
							onClose={mockOnClose}
							onRename={mockOnRename}
							onAutoName={mockOnAutoName}
							hasLogs={true}
						/>
					</TestWrapper>
				);

				fireEvent.click(screen.getByText('Auto'));
				expect(mockOnAutoName).toHaveBeenCalledTimes(1);
			});

			it('triggers onAutoName on Cmd+Shift+Enter when Auto button is shown', () => {
				const mockOnAutoName = vi.fn();

				render(
					<TestWrapper>
						<RenameTabModal
							theme={mockTheme}
							initialName="My Tab"
							onClose={mockOnClose}
							onRename={mockOnRename}
							onAutoName={mockOnAutoName}
							hasLogs={true}
						/>
					</TestWrapper>
				);

				const input = screen.getByRole('textbox');
				fireEvent.keyDown(input, { key: 'Enter', shiftKey: true, metaKey: true });

				expect(mockOnAutoName).toHaveBeenCalledTimes(1);
				expect(mockOnRename).not.toHaveBeenCalled();
			});

			it('leaves Cmd+Shift+Enter to the input method during an IME composition', () => {
				const mockOnAutoName = vi.fn();

				render(
					<TestWrapper>
						<RenameTabModal
							theme={mockTheme}
							initialName="My Tab"
							onClose={mockOnClose}
							onRename={mockOnRename}
							onAutoName={mockOnAutoName}
							hasLogs={true}
						/>
					</TestWrapper>
				);

				const input = screen.getByRole('textbox');
				for (const ime of [{ isComposing: true }, { keyCode: 229 }]) {
					const handled = fireEvent.keyDown(input, {
						key: 'Enter',
						shiftKey: true,
						metaKey: true,
						...ime,
					});
					expect(handled).toBe(true);
				}

				expect(mockOnAutoName).not.toHaveBeenCalled();
				expect(mockOnRename).not.toHaveBeenCalled();
			});

			it('triggers onAutoName on Ctrl+Shift+Enter when Auto button is shown', () => {
				const mockOnAutoName = vi.fn();

				render(
					<TestWrapper>
						<RenameTabModal
							theme={mockTheme}
							initialName="My Tab"
							onClose={mockOnClose}
							onRename={mockOnRename}
							onAutoName={mockOnAutoName}
							hasLogs={true}
						/>
					</TestWrapper>
				);

				const input = screen.getByRole('textbox');
				fireEvent.keyDown(input, { key: 'Enter', shiftKey: true, ctrlKey: true });

				expect(mockOnAutoName).toHaveBeenCalledTimes(1);
				expect(mockOnRename).not.toHaveBeenCalled();
			});

			it('does not trigger onAutoName via Cmd+Shift+Enter when Auto button is hidden', () => {
				const mockOnAutoName = vi.fn();

				render(
					<TestWrapper>
						<RenameTabModal
							theme={mockTheme}
							initialName="My Tab"
							onClose={mockOnClose}
							onRename={mockOnRename}
							onAutoName={mockOnAutoName}
							hasLogs={false}
						/>
					</TestWrapper>
				);

				const input = screen.getByRole('textbox');
				fireEvent.keyDown(input, { key: 'Enter', shiftKey: true, metaKey: true });

				expect(mockOnAutoName).not.toHaveBeenCalled();
			});

			it('Auto button is styled with accent color', () => {
				render(
					<TestWrapper>
						<RenameTabModal
							theme={mockTheme}
							initialName="My Tab"
							onClose={mockOnClose}
							onRename={mockOnRename}
							onAutoName={vi.fn()}
							hasLogs={true}
						/>
					</TestWrapper>
				);

				const autoButton = screen.getByText('Auto');
				expect(autoButton).toHaveStyle({ color: mockTheme.colors.accent });
			});
		});
	});
});
