/**
 * Tests for DisplayTab component
 *
 * Tests the display settings tab including:
 * - Font family selection and loading
 * - Custom font management (add/remove)
 * - Font size toggle buttons
 * - Terminal width toggle buttons
 * - Max log buffer toggle buttons
 * - Max output lines toggle buttons
 * - User message alignment toggle
 * - Native title bar toggle
 * - Auto-hide menu bar toggle
 * - Document Graph settings (external links, max nodes)
 * - Context window warnings (enable/disable, threshold sliders)
 * - Local ignore patterns (add/remove, honor gitignore)
 * - Font detection failure handling
 * - Font configuration panel rendering
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';
import { DisplayTab } from '../../../../../renderer/components/Settings/tabs/DisplayTab';
import type { Theme } from '../../../../../renderer/types';

// --- Mock setters (module-level for assertion access) ---
const mockSetFontFamily = vi.fn();
const mockSetFontSize = vi.fn();
const mockSetTerminalWidth = vi.fn();
const mockSetMaxLogBuffer = vi.fn();
const mockSetMaxOutputLines = vi.fn();
const mockSetUserMessageAlignment = vi.fn();
const mockSetUseNativeTitleBar = vi.fn();
const mockSetAutoHideMenuBar = vi.fn();
const mockSetDocumentGraphShowExternalLinks = vi.fn();
const mockSetDocumentGraphMaxNodes = vi.fn();
const mockUpdateContextManagementSettings = vi.fn();
const mockSetLocalIgnorePatterns = vi.fn();
const mockSetLocalHonorGitignore = vi.fn();

// Per-test overrides (merged into useSettings return)
let mockUseSettingsOverrides: Record<string, any> = {};

vi.mock('../../../../../renderer/hooks/settings/useSettings', () => ({
	useSettings: () => ({
		fontFamily: 'Menlo',
		setFontFamily: mockSetFontFamily,
		fontSize: 14,
		setFontSize: mockSetFontSize,
		terminalWidth: 100,
		setTerminalWidth: mockSetTerminalWidth,
		maxLogBuffer: 5000,
		setMaxLogBuffer: mockSetMaxLogBuffer,
		maxOutputLines: 25,
		setMaxOutputLines: mockSetMaxOutputLines,
		userMessageAlignment: 'right',
		setUserMessageAlignment: mockSetUserMessageAlignment,
		useNativeTitleBar: false,
		setUseNativeTitleBar: mockSetUseNativeTitleBar,
		autoHideMenuBar: false,
		setAutoHideMenuBar: mockSetAutoHideMenuBar,
		documentGraphShowExternalLinks: true,
		setDocumentGraphShowExternalLinks: mockSetDocumentGraphShowExternalLinks,
		documentGraphMaxNodes: 200,
		setDocumentGraphMaxNodes: mockSetDocumentGraphMaxNodes,
		contextManagementSettings: {
			autoGroomContexts: true,
			maxContextTokens: 100000,
			showMergePreview: true,
			groomingTimeout: 60000,
			preferredGroomingAgent: 'fastest',
			contextWarningsEnabled: true,
			contextWarningYellowThreshold: 60,
			contextWarningRedThreshold: 80,
		},
		updateContextManagementSettings: mockUpdateContextManagementSettings,
		localIgnorePatterns: ['.git', 'node_modules', '__pycache__'],
		setLocalIgnorePatterns: mockSetLocalIgnorePatterns,
		localHonorGitignore: true,
		setLocalHonorGitignore: mockSetLocalHonorGitignore,
		...mockUseSettingsOverrides,
	}),
}));

// Mock the IgnorePatternsSection to avoid deep sub-component rendering complexity
// while still verifying props are passed correctly
vi.mock('../../../../../renderer/components/Settings/IgnorePatternsSection', () => ({
	IgnorePatternsSection: ({
		title,
		ignorePatterns,
		onIgnorePatternsChange,
		showHonorGitignore,
		honorGitignore,
		onHonorGitignoreChange,
		onReset,
	}: any) => (
		<div data-testid="ignore-patterns-section">
			<span data-testid="ignore-title">{title}</span>
			<span data-testid="ignore-patterns">{JSON.stringify(ignorePatterns)}</span>
			<span data-testid="honor-gitignore">{String(honorGitignore)}</span>
			<span data-testid="show-honor-gitignore">{String(showHonorGitignore)}</span>
			<button
				data-testid="add-pattern-btn"
				onClick={() => onIgnorePatternsChange([...ignorePatterns, '*.log'])}
			>
				Add Pattern
			</button>
			<button
				data-testid="remove-pattern-btn"
				onClick={() => onIgnorePatternsChange(ignorePatterns.filter((p: string) => p !== '.git'))}
			>
				Remove Pattern
			</button>
			<button
				data-testid="toggle-gitignore-btn"
				onClick={() => onHonorGitignoreChange(!honorGitignore)}
			>
				Toggle Gitignore
			</button>
			<button data-testid="reset-btn" onClick={onReset}>
				Reset
			</button>
		</div>
	),
}));

// Sample theme for testing
const mockTheme: Theme = {
	id: 'dracula',
	name: 'Dracula',
	mode: 'dark',
	colors: {
		bgMain: '#282a36',
		bgSidebar: '#21222c',
		bgActivity: '#343746',
		border: '#44475a',
		textMain: '#f8f8f2',
		textDim: '#6272a4',
		accent: '#bd93f9',
		accentDim: '#bd93f920',
		accentText: '#ff79c6',
		accentForeground: '#ffffff',
		success: '#50fa7b',
		warning: '#ffb86c',
		error: '#ff5555',
	},
};

describe('DisplayTab', () => {
	beforeEach(() => {
		vi.useFakeTimers();

		// Reset window.maestro font/settings mocks
		(window as any).maestro.fonts = {
			detect: vi.fn().mockResolvedValue(['Menlo', 'Monaco', 'Courier New', 'JetBrains Mono']),
		};
		(window as any).maestro.settings.get = vi.fn().mockResolvedValue(undefined);
		(window as any).maestro.settings.set = vi.fn().mockResolvedValue(undefined);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
		mockUseSettingsOverrides = {};
	});

	// =========================================================================
	// Font Family
	// =========================================================================

	describe('Font Family', () => {
		it('should render the Interface Font label', async () => {
			render(<DisplayTab theme={mockTheme} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			expect(screen.getByText('Interface Font')).toBeInTheDocument();
		});

		it('should show loading message while fonts are being detected', async () => {
			// Make font detection slow so we can observe the loading state
			let resolveFonts: (value: string[]) => void;
			(window as any).maestro.fonts.detect = vi.fn(
				() =>
					new Promise<string[]>((resolve) => {
						resolveFonts = resolve;
					})
			);

			render(<DisplayTab theme={mockTheme} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			// Trigger font loading by focusing the select
			const fontSelect = screen.getByRole('combobox');
			fireEvent.focus(fontSelect);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(10);
			});

			expect(screen.getByText('Loading fonts...')).toBeInTheDocument();

			// Resolve the font detection
			await act(async () => {
				resolveFonts!(['Menlo', 'Monaco']);
				await vi.advanceTimersByTimeAsync(50);
			});
		});

		it('should load fonts on select focus (interaction)', async () => {
			render(<DisplayTab theme={mockTheme} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			const fontSelect = screen.getByRole('combobox');
			fireEvent.focus(fontSelect);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect((window as any).maestro.fonts.detect).toHaveBeenCalled();
		});

		it('should load fonts on select click (interaction)', async () => {
			render(<DisplayTab theme={mockTheme} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			const fontSelect = screen.getByRole('combobox');
			fireEvent.click(fontSelect);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect((window as any).maestro.fonts.detect).toHaveBeenCalled();
		});

		it('should call setFontFamily when font is changed', async () => {
			render(<DisplayTab theme={mockTheme} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			const fontSelect = screen.getByRole('combobox');
			fireEvent.change(fontSelect, { target: { value: 'Monaco' } });

			expect(mockSetFontFamily).toHaveBeenCalledWith('Monaco');
		});

		it('should render font select with current fontFamily value', async () => {
			render(<DisplayTab theme={mockTheme} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			const fontSelect = screen.getByRole('combobox') as HTMLSelectElement;
			expect(fontSelect.value).toBe('Menlo');
		});

		it('should not reload fonts if already loaded', async () => {
			render(<DisplayTab theme={mockTheme} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			const fontSelect = screen.getByRole('combobox');

			// First focus triggers load
			fireEvent.focus(fontSelect);
			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect((window as any).maestro.fonts.detect).toHaveBeenCalledTimes(1);

			// Second focus should not reload
			fireEvent.focus(fontSelect);
			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect((window as any).maestro.fonts.detect).toHaveBeenCalledTimes(1);
		});
	});

	// =========================================================================
	// Custom Fonts
	// =========================================================================

	describe('Custom Fonts', () => {
		it('should add custom font via button click', async () => {
			render(<DisplayTab theme={mockTheme} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			const customFontInput = screen.getByPlaceholderText('Add custom font name...');
			fireEvent.change(customFontInput, { target: { value: 'My Custom Font' } });

			// Scope to the font input's parent container to avoid ambiguous "Add" button
			const fontContainer = customFontInput.closest('div')!.parentElement!;
			fireEvent.click(within(fontContainer).getByRole('button', { name: 'Add' }));

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			expect((window as any).maestro.settings.set).toHaveBeenCalledWith('customFonts', [
				'My Custom Font',
			]);
		});

		it('should add custom font on Enter key', async () => {
			render(<DisplayTab theme={mockTheme} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			const customFontInput = screen.getByPlaceholderText('Add custom font name...');
			fireEvent.change(customFontInput, { target: { value: 'My Custom Font' } });
			fireEvent.keyDown(customFontInput, { key: 'Enter' });

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			expect((window as any).maestro.settings.set).toHaveBeenCalledWith('customFonts', [
				'My Custom Font',
			]);
		});

		it('should not add empty custom font', async () => {
			render(<DisplayTab theme={mockTheme} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			const customFontInput = screen.getByPlaceholderText('Add custom font name...');
			fireEvent.change(customFontInput, { target: { value: '   ' } });

			const fontContainer = customFontInput.closest('div')!.parentElement!;
			fireEvent.click(within(fontContainer).getByRole('button', { name: 'Add' }));

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			expect((window as any).maestro.settings.set).not.toHaveBeenCalledWith(
				'customFonts',
				expect.anything()
			);
		});

		it('should remove custom font when X is clicked', async () => {
			// Preload custom fonts so they appear after font loading
			(window as any).maestro.settings.get = vi
				.fn()
				.mockResolvedValue(['MyCustomFont', 'AnotherFont']);

			render(<DisplayTab theme={mockTheme} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			// Trigger font loading to populate customFonts
			const fontSelect = screen.getByRole('combobox');
			fireEvent.focus(fontSelect);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			// Custom font tags appear below the select. Each has a span with the name
			// and a button with the "x" character. Find via getAllByText since the font
			// name also appears in the <option>.
			const myCustomFontSpans = screen.getAllByText('MyCustomFont');
			// The tag span (not the option) has a sibling button with the remove action
			const tagSpan = myCustomFontSpans.find(
				(el) => el.tagName === 'SPAN' && el.closest('.flex.items-center.gap-2')
			);
			expect(tagSpan).toBeTruthy();
			const removeButton = tagSpan!
				.closest('.flex.items-center.gap-2')!
				.querySelector('button') as HTMLButtonElement;
			fireEvent.click(removeButton);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			// Should save updated custom fonts (without MyCustomFont)
			expect((window as any).maestro.settings.set).toHaveBeenCalledWith('customFonts', [
				'AnotherFont',
			]);
		});

		it('should not add duplicate custom font', async () => {
			render(<DisplayTab theme={mockTheme} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			const customFontInput = screen.getByPlaceholderText('Add custom font name...');

			// Add first font
			fireEvent.change(customFontInput, { target: { value: 'DuplicateFont' } });
			fireEvent.keyDown(customFontInput, { key: 'Enter' });

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			expect((window as any).maestro.settings.set).toHaveBeenCalledWith('customFonts', [
				'DuplicateFont',
			]);

			// Try adding same font again
			fireEvent.change(customFontInput, { target: { value: 'DuplicateFont' } });
			fireEvent.keyDown(customFontInput, { key: 'Enter' });

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			// Should not have been called again with a second entry
			expect((window as any).maestro.settings.set).toHaveBeenCalledTimes(1);
		});

		it('should load saved custom fonts from settings', async () => {
			(window as any).maestro.settings.get = vi
				.fn()
				.mockResolvedValue(['SavedFont1', 'SavedFont2']);

			render(<DisplayTab theme={mockTheme} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			// Trigger font loading
			const fontSelect = screen.getByRole('combobox');

			await act(async () => {
				fireEvent.focus(fontSelect);
			});

			// Allow all async operations (detect + settings.get) to resolve
			await act(async () => {
				await vi.advanceTimersByTimeAsync(200);
			});

			// Re-query the combobox after state updates (component re-renders)
			const updatedSelect = screen.getByRole('combobox');
			const options = updatedSelect.querySelectorAll('option');
			const optionValues = Array.from(options).map((o) => o.getAttribute('value'));
			expect(optionValues).toContain('SavedFont1');
			expect(optionValues).toContain('SavedFont2');
		});
	});

	// =========================================================================
	// Font Size
	// =========================================================================

	describe('Font Size', () => {
		it('should render Font Size label', async () => {
			render(<DisplayTab theme={mockTheme} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			expect(screen.getByText('Font Size')).toBeInTheDocument();
		});

		it('should call setFontSize with 12 when Small is clicked', async () => {
			render(<DisplayTab theme={mockTheme} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			fireEvent.click(screen.getByRole('button', { name: 'Small' }));
			expect(mockSetFontSize).toHaveBeenCalledWith(12);
		});

		it('should call setFontSize with 14 when Medium is clicked', async () => {
			render(<DisplayTab theme={mockTheme} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			fireEvent.click(screen.getByRole('button', { name: 'Medium' }));
			expect(mockSetFontSize).toHaveBeenCalledWith(14);
		});

		it('should call setFontSize with 16 when Large is clicked', async () => {
			render(<DisplayTab theme={mockTheme} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			fireEvent.click(screen.getByRole('button', { name: 'Large' }));
			expect(mockSetFontSize).toHaveBeenCalledWith(16);
		});

		it('should call setFontSize with 18 when X-Large is clicked', async () => {
			render(<DisplayTab theme={mockTheme} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			fireEvent.click(screen.getByRole('button', { name: 'X-Large' }));
			expect(mockSetFontSize).toHaveBeenCalledWith(18);
		});

		it('should highlight selected font size (Medium when fontSize=14)', async () => {
			render(<DisplayTab theme={mockTheme} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			const mediumButton = screen.getByText('Medium');
			expect(mediumButton).toHaveClass('ring-2');
		});

		it('should highlight Small when fontSize is 12', async () => {
			mockUseSettingsOverrides = { fontSize: 12 };
			render(<DisplayTab theme={mockTheme} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			const smallButton = screen.getByText('Small');
			expect(smallButton).toHaveClass('ring-2');
		});
	});

	// =========================================================================
	// Terminal Width
	// =========================================================================

	describe('Terminal Width', () => {
		it('should render Terminal Width label', async () => {
			render(<DisplayTab theme={mockTheme} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			expect(screen.getByText('Terminal Width (Columns)')).toBeInTheDocument();
		});

		it('should call setTerminalWidth with 80', async () => {
			render(<DisplayTab theme={mockTheme} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			fireEvent.click(screen.getByRole('button', { name: '80' }));
			expect(mockSetTerminalWidth).toHaveBeenCalledWith(80);
		});

		it('should call setTerminalWidth with 100', async () => {
			render(<DisplayTab theme={mockTheme} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			// There may be multiple "100" on screen (e.g., from max nodes slider)
			// so get the one in the terminal width section
			const buttons = screen.getAllByRole('button', { name: '100' });
			fireEvent.click(buttons[0]);
			expect(mockSetTerminalWidth).toHaveBeenCalledWith(100);
		});

		it('should call setTerminalWidth with 120', async () => {
			render(<DisplayTab theme={mockTheme} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			fireEvent.click(screen.getByRole('button', { name: '120' }));
			expect(mockSetTerminalWidth).toHaveBeenCalledWith(120);
		});

		it('should call setTerminalWidth with 160', async () => {
			render(<DisplayTab theme={mockTheme} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			fireEvent.click(screen.getByRole('button', { name: '160' }));
			expect(mockSetTerminalWidth).toHaveBeenCalledWith(160);
		});

		it('should highlight selected terminal width (100)', async () => {
			render(<DisplayTab theme={mockTheme} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			// Find the 100 button that has ring-2 class (the active one)
			const buttons = screen.getAllByRole('button', { name: '100' });
			const activeButton = buttons.find((btn) => btn.classList.contains('ring-2'));
			expect(activeButton).toBeTruthy();
		});
	});

	// =========================================================================
	// Max Log Buffer
	// =========================================================================

	describe('Max Log Buffer', () => {
		it('should render Maximum Log Buffer label', async () => {
			render(<DisplayTab theme={mockTheme} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			expect(screen.getByText('Maximum Log Buffer')).toBeInTheDocument();
		});

		it('should call setMaxLogBuffer with 1000', async () => {
			render(<DisplayTab theme={mockTheme} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			fireEvent.click(screen.getByRole('button', { name: '1000' }));
			expect(mockSetMaxLogBuffer).toHaveBeenCalledWith(1000);
		});

		it('should call setMaxLogBuffer with 5000', async () => {
			render(<DisplayTab theme={mockTheme} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			fireEvent.click(screen.getByRole('button', { name: '5000' }));
			expect(mockSetMaxLogBuffer).toHaveBeenCalledWith(5000);
		});

		it('should call setMaxLogBuffer with 10000', async () => {
			render(<DisplayTab theme={mockTheme} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			fireEvent.click(screen.getByRole('button', { name: '10000' }));
			expect(mockSetMaxLogBuffer).toHaveBeenCalledWith(10000);
		});

		it('should call setMaxLogBuffer with 25000', async () => {
			render(<DisplayTab theme={mockTheme} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			fireEvent.click(screen.getByRole('button', { name: '25000' }));
			expect(mockSetMaxLogBuffer).toHaveBeenCalledWith(25000);
		});

		it('should display description text', async () => {
			render(<DisplayTab theme={mockTheme} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			expect(
				screen.getByText(/Maximum number of log messages to keep in memory/)
			).toBeInTheDocument();
		});
	});

	// =========================================================================
	// Max Output Lines
	// =========================================================================

	describe('Max Output Lines', () => {
		it('should render Max Output Lines label', async () => {
			render(<DisplayTab theme={mockTheme} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			expect(screen.getByText('Max Output Lines per Response')).toBeInTheDocument();
		});

		it('should call setMaxOutputLines with 15', async () => {
			render(<DisplayTab theme={mockTheme} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			fireEvent.click(screen.getByRole('button', { name: '15' }));
			expect(mockSetMaxOutputLines).toHaveBeenCalledWith(15);
		});

		it('should call setMaxOutputLines with 25', async () => {
			render(<DisplayTab theme={mockTheme} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			fireEvent.click(screen.getByRole('button', { name: '25' }));
			expect(mockSetMaxOutputLines).toHaveBeenCalledWith(25);
		});

		it('should call setMaxOutputLines with 50', async () => {
			render(<DisplayTab theme={mockTheme} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			fireEvent.click(screen.getByRole('button', { name: '50' }));
			expect(mockSetMaxOutputLines).toHaveBeenCalledWith(50);
		});

		it('should call setMaxOutputLines with 100', async () => {
			render(<DisplayTab theme={mockTheme} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			// There might be multiple 100 buttons (terminal width has one too)
			// Max output lines 100 is separate from terminal width 100
			const buttons = screen.getAllByRole('button', { name: '100' });
			// The second 100 button should be in the Max Output Lines section
			const maxOutputButton = buttons[buttons.length - 1];
			fireEvent.click(maxOutputButton);
			expect(mockSetMaxOutputLines).toHaveBeenCalledWith(100);
		});

		it('should call setMaxOutputLines with Infinity when All is clicked', async () => {
			render(<DisplayTab theme={mockTheme} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			fireEvent.click(screen.getByRole('button', { name: 'All' }));
			expect(mockSetMaxOutputLines).toHaveBeenCalledWith(Infinity);
		});

		it('should display description text about output collapsing', async () => {
			render(<DisplayTab theme={mockTheme} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			expect(
				screen.getByText(/Long outputs will be collapsed into a scrollable window/)
			).toBeInTheDocument();
		});
	});

	// =========================================================================
	// User Message Alignment
	// =========================================================================

	describe('User Message Alignment', () => {
		it('should render User Message Alignment label', async () => {
			render(<DisplayTab theme={mockTheme} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			expect(screen.getByText('User Message Alignment')).toBeInTheDocument();
		});

		it('should call setUserMessageAlignment with left when Left is clicked', async () => {
			render(<DisplayTab theme={mockTheme} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			fireEvent.click(screen.getByRole('button', { name: 'Left' }));
			expect(mockSetUserMessageAlignment).toHaveBeenCalledWith('left');
		});

		it('should call setUserMessageAlignment with right when Right is clicked', async () => {
			render(<DisplayTab theme={mockTheme} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			fireEvent.click(screen.getByRole('button', { name: 'Right' }));
			expect(mockSetUserMessageAlignment).toHaveBeenCalledWith('right');
		});

		it('should highlight Right when userMessageAlignment is right', async () => {
			render(<DisplayTab theme={mockTheme} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			const rightButton = screen.getByRole('button', { name: 'Right' });
			expect(rightButton).toHaveClass('ring-2');
		});

		it('should highlight Left when userMessageAlignment is left', async () => {
			mockUseSettingsOverrides = { userMessageAlignment: 'left' };
			render(<DisplayTab theme={mockTheme} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			const leftButton = screen.getByRole('button', { name: 'Left' });
			expect(leftButton).toHaveClass('ring-2');
		});

		it('should default to right when userMessageAlignment is null', async () => {
			mockUseSettingsOverrides = { userMessageAlignment: null };
			render(<DisplayTab theme={mockTheme} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			const rightButton = screen.getByRole('button', { name: 'Right' });
			expect(rightButton).toHaveClass('ring-2');
		});
	});

	// =========================================================================
	// Native Title Bar
	// =========================================================================

	describe('Native Title Bar', () => {
		it('should render native title bar toggle', async () => {
			render(<DisplayTab theme={mockTheme} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			expect(screen.getByText('Use native title bar')).toBeInTheDocument();
			expect(
				screen.getByText(/Use the OS native title bar instead of Maestro's custom title bar/)
			).toBeInTheDocument();
		});

		it('should toggle native title bar on when clicked (currently off)', async () => {
			render(<DisplayTab theme={mockTheme} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			// Click the specific switch next to "Use native title bar"
			const titleBarText = screen.getByText('Use native title bar');
			const titleBarSection = titleBarText.closest('.flex.items-center.justify-between')!;
			const titleBarSwitch = titleBarSection.querySelector('[role="switch"]') as HTMLElement;
			fireEvent.click(titleBarSwitch);

			expect(mockSetUseNativeTitleBar).toHaveBeenCalledWith(true);
		});

		it('should toggle native title bar off when clicked (currently on)', async () => {
			mockUseSettingsOverrides = { useNativeTitleBar: true };
			render(<DisplayTab theme={mockTheme} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			const titleBarText = screen.getByText('Use native title bar');
			const titleBarSection = titleBarText.closest('.flex.items-center.justify-between')!;
			const titleBarSwitch = titleBarSection.querySelector('[role="switch"]') as HTMLElement;
			fireEvent.click(titleBarSwitch);

			expect(mockSetUseNativeTitleBar).toHaveBeenCalledWith(false);
		});

		it('should show aria-checked=true when native title bar is enabled', async () => {
			mockUseSettingsOverrides = { useNativeTitleBar: true };
			render(<DisplayTab theme={mockTheme} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			const titleBarText = screen.getByText('Use native title bar');
			const titleBarSection = titleBarText.closest('.flex.items-center.justify-between')!;
			const titleBarSwitch = titleBarSection.querySelector('[role="switch"]') as HTMLElement;

			expect(titleBarSwitch.getAttribute('aria-checked')).toBe('true');
		});
	});

	// =========================================================================
	// Auto-hide Menu Bar
	// =========================================================================

	describe('Auto-hide Menu Bar', () => {
		it('should render auto-hide menu bar toggle', async () => {
			render(<DisplayTab theme={mockTheme} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			expect(screen.getByText('Auto-hide menu bar')).toBeInTheDocument();
			expect(
				screen.getByText(/Hide the application menu bar. Press Alt to toggle visibility/)
			).toBeInTheDocument();
		});

		it('should toggle auto-hide menu bar on when clicked (currently off)', async () => {
			render(<DisplayTab theme={mockTheme} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			const menuBarText = screen.getByText('Auto-hide menu bar');
			const menuBarSection = menuBarText.closest('.flex.items-center.justify-between')!;
			const menuBarSwitch = menuBarSection.querySelector('[role="switch"]') as HTMLElement;
			fireEvent.click(menuBarSwitch);

			expect(mockSetAutoHideMenuBar).toHaveBeenCalledWith(true);
		});

		it('should toggle auto-hide menu bar off when clicked (currently on)', async () => {
			mockUseSettingsOverrides = { autoHideMenuBar: true };
			render(<DisplayTab theme={mockTheme} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			const menuBarText = screen.getByText('Auto-hide menu bar');
			const menuBarSection = menuBarText.closest('.flex.items-center.justify-between')!;
			const menuBarSwitch = menuBarSection.querySelector('[role="switch"]') as HTMLElement;
			fireEvent.click(menuBarSwitch);

			expect(mockSetAutoHideMenuBar).toHaveBeenCalledWith(false);
		});

		it('should show aria-checked=true when auto-hide is enabled', async () => {
			mockUseSettingsOverrides = { autoHideMenuBar: true };
			render(<DisplayTab theme={mockTheme} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			const menuBarText = screen.getByText('Auto-hide menu bar');
			const menuBarSection = menuBarText.closest('.flex.items-center.justify-between')!;
			const menuBarSwitch = menuBarSection.querySelector('[role="switch"]') as HTMLElement;

			expect(menuBarSwitch.getAttribute('aria-checked')).toBe('true');
		});
	});

	// =========================================================================
	// Document Graph
	// =========================================================================

	describe('Document Graph', () => {
		it('should render Document Graph section with Beta badge', async () => {
			render(<DisplayTab theme={mockTheme} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			expect(screen.getByText('Document Graph')).toBeInTheDocument();
			expect(screen.getByText('Beta')).toBeInTheDocument();
		});

		it('should render show external links toggle', async () => {
			render(<DisplayTab theme={mockTheme} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			expect(screen.getByText('Show external links by default')).toBeInTheDocument();
		});

		it('should toggle external links off when clicked (currently on)', async () => {
			render(<DisplayTab theme={mockTheme} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			const externalLinksText = screen.getByText('Show external links by default');
			const externalLinksSection = externalLinksText.closest('.flex.items-center.justify-between')!;
			const externalLinksSwitch = externalLinksSection.querySelector(
				'[role="switch"]'
			) as HTMLElement;
			fireEvent.click(externalLinksSwitch);

			expect(mockSetDocumentGraphShowExternalLinks).toHaveBeenCalledWith(false);
		});

		it('should toggle external links on when clicked (currently off)', async () => {
			mockUseSettingsOverrides = { documentGraphShowExternalLinks: false };
			render(<DisplayTab theme={mockTheme} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			const externalLinksText = screen.getByText('Show external links by default');
			const externalLinksSection = externalLinksText.closest('.flex.items-center.justify-between')!;
			const externalLinksSwitch = externalLinksSection.querySelector(
				'[role="switch"]'
			) as HTMLElement;
			fireEvent.click(externalLinksSwitch);

			expect(mockSetDocumentGraphShowExternalLinks).toHaveBeenCalledWith(true);
		});

		it('should render max nodes slider', async () => {
			render(<DisplayTab theme={mockTheme} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			expect(screen.getByText('Maximum nodes to display')).toBeInTheDocument();
			// The current value should be displayed
			expect(screen.getByText('200')).toBeInTheDocument();
		});

		it('should call setDocumentGraphMaxNodes when slider changes', async () => {
			render(<DisplayTab theme={mockTheme} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			// Multiple sliders exist (doc graph, yellow threshold, red threshold)
			// The doc graph slider is the first one
			const sliders = screen.getAllByRole('slider');
			const docGraphSlider = sliders[0];
			fireEvent.change(docGraphSlider, { target: { value: '500' } });

			expect(mockSetDocumentGraphMaxNodes).toHaveBeenCalledWith(500);
		});

		it('should display description about node limits', async () => {
			render(<DisplayTab theme={mockTheme} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			expect(screen.getByText(/Limits initial graph size for performance/)).toBeInTheDocument();
		});
	});

	// =========================================================================
	// Context Window Warnings
	// =========================================================================

	describe('Context Window Warnings', () => {
		it('should render Context Window Warnings section', async () => {
			render(<DisplayTab theme={mockTheme} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			expect(screen.getByText('Context Window Warnings')).toBeInTheDocument();
			expect(screen.getByText('Show context consumption warnings')).toBeInTheDocument();
		});

		it('should toggle context warnings off via the switch button', async () => {
			render(<DisplayTab theme={mockTheme} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			const warningsText = screen.getByText('Show context consumption warnings');
			const warningsSection = warningsText.closest('.flex.items-center.justify-between')!;
			const warningsSwitch = warningsSection.querySelector('[role="switch"]') as HTMLElement;
			fireEvent.click(warningsSwitch);

			expect(mockUpdateContextManagementSettings).toHaveBeenCalledWith({
				contextWarningsEnabled: false,
			});
		});

		it('should toggle context warnings on via the switch button (currently off)', async () => {
			mockUseSettingsOverrides = {
				contextManagementSettings: {
					autoGroomContexts: true,
					maxContextTokens: 100000,
					showMergePreview: true,
					groomingTimeout: 60000,
					preferredGroomingAgent: 'fastest',
					contextWarningsEnabled: false,
					contextWarningYellowThreshold: 60,
					contextWarningRedThreshold: 80,
				},
			};
			render(<DisplayTab theme={mockTheme} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			const warningsText = screen.getByText('Show context consumption warnings');
			const warningsSection = warningsText.closest('.flex.items-center.justify-between')!;
			const warningsSwitch = warningsSection.querySelector('[role="switch"]') as HTMLElement;
			fireEvent.click(warningsSwitch);

			expect(mockUpdateContextManagementSettings).toHaveBeenCalledWith({
				contextWarningsEnabled: true,
			});
		});

		it('should toggle context warnings via the clickable row (not just the switch)', async () => {
			render(<DisplayTab theme={mockTheme} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			// Click on the row itself (which has role="button")
			const warningsRow = screen.getByRole('button', {
				name: /Show context consumption warnings/,
			});
			fireEvent.click(warningsRow);

			expect(mockUpdateContextManagementSettings).toHaveBeenCalledWith({
				contextWarningsEnabled: false,
			});
		});

		it('should toggle context warnings via keyboard (Enter key)', async () => {
			render(<DisplayTab theme={mockTheme} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			const warningsRow = screen.getByRole('button', {
				name: /Show context consumption warnings/,
			});
			fireEvent.keyDown(warningsRow, { key: 'Enter' });

			expect(mockUpdateContextManagementSettings).toHaveBeenCalledWith({
				contextWarningsEnabled: false,
			});
		});

		it('should toggle context warnings via keyboard (Space key)', async () => {
			render(<DisplayTab theme={mockTheme} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			const warningsRow = screen.getByRole('button', {
				name: /Show context consumption warnings/,
			});
			fireEvent.keyDown(warningsRow, { key: ' ' });

			expect(mockUpdateContextManagementSettings).toHaveBeenCalledWith({
				contextWarningsEnabled: false,
			});
		});

		it('should display yellow and red threshold values', async () => {
			render(<DisplayTab theme={mockTheme} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			expect(screen.getByText('Yellow warning threshold')).toBeInTheDocument();
			expect(screen.getByText('60%')).toBeInTheDocument();
			expect(screen.getByText('Red warning threshold')).toBeInTheDocument();
			expect(screen.getByText('80%')).toBeInTheDocument();
		});

		it('should update yellow threshold when slider changes', async () => {
			render(<DisplayTab theme={mockTheme} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			// Find the yellow threshold slider (first range input in the threshold area)
			const sliders = screen.getAllByRole('slider');
			// First slider is document graph max nodes, second is yellow, third is red
			const yellowSlider = sliders[1];
			fireEvent.change(yellowSlider, { target: { value: '70' } });

			expect(mockUpdateContextManagementSettings).toHaveBeenCalledWith({
				contextWarningYellowThreshold: 70,
			});
		});

		it('should bump red threshold up when yellow exceeds red', async () => {
			render(<DisplayTab theme={mockTheme} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			const sliders = screen.getAllByRole('slider');
			const yellowSlider = sliders[1];

			// Set yellow to 85, which is >= red (80)
			fireEvent.change(yellowSlider, { target: { value: '85' } });

			expect(mockUpdateContextManagementSettings).toHaveBeenCalledWith({
				contextWarningYellowThreshold: 85,
				contextWarningRedThreshold: 95,
			});
		});

		it('should update red threshold when slider changes', async () => {
			render(<DisplayTab theme={mockTheme} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			const sliders = screen.getAllByRole('slider');
			const redSlider = sliders[2];
			fireEvent.change(redSlider, { target: { value: '90' } });

			expect(mockUpdateContextManagementSettings).toHaveBeenCalledWith({
				contextWarningRedThreshold: 90,
			});
		});

		it('should bump yellow threshold down when red goes below yellow', async () => {
			render(<DisplayTab theme={mockTheme} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			const sliders = screen.getAllByRole('slider');
			const redSlider = sliders[2];

			// Set red to 50, which is <= yellow (60)
			fireEvent.change(redSlider, { target: { value: '50' } });

			expect(mockUpdateContextManagementSettings).toHaveBeenCalledWith({
				contextWarningRedThreshold: 50,
				contextWarningYellowThreshold: 40,
			});
		});

		it('should ghost threshold sliders when warnings are disabled', async () => {
			mockUseSettingsOverrides = {
				contextManagementSettings: {
					autoGroomContexts: true,
					maxContextTokens: 100000,
					showMergePreview: true,
					groomingTimeout: 60000,
					preferredGroomingAgent: 'fastest',
					contextWarningsEnabled: false,
					contextWarningYellowThreshold: 60,
					contextWarningRedThreshold: 80,
				},
			};
			render(<DisplayTab theme={mockTheme} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			// The threshold section should have reduced opacity and pointer-events: none
			const yellowText = screen.getByText('Yellow warning threshold');
			const thresholdContainer = yellowText.closest('.space-y-4') as HTMLElement;
			expect(thresholdContainer).toBeTruthy();
			expect(thresholdContainer.style.opacity).toBe('0.4');
			expect(thresholdContainer.style.pointerEvents).toBe('none');
		});
	});

	// =========================================================================
	// Local Ignore Patterns
	// =========================================================================

	describe('Local Ignore Patterns', () => {
		it('should render ignore patterns section', async () => {
			render(<DisplayTab theme={mockTheme} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			expect(screen.getByTestId('ignore-patterns-section')).toBeInTheDocument();
			expect(screen.getByTestId('ignore-title')).toHaveTextContent('Local Ignore Patterns');
		});

		it('should pass current ignore patterns to section', async () => {
			render(<DisplayTab theme={mockTheme} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			expect(screen.getByTestId('ignore-patterns')).toHaveTextContent(
				JSON.stringify(['.git', 'node_modules', '__pycache__'])
			);
		});

		it('should call setLocalIgnorePatterns when adding a pattern', async () => {
			render(<DisplayTab theme={mockTheme} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			fireEvent.click(screen.getByTestId('add-pattern-btn'));

			expect(mockSetLocalIgnorePatterns).toHaveBeenCalledWith([
				'.git',
				'node_modules',
				'__pycache__',
				'*.log',
			]);
		});

		it('should call setLocalIgnorePatterns when removing a pattern', async () => {
			render(<DisplayTab theme={mockTheme} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			fireEvent.click(screen.getByTestId('remove-pattern-btn'));

			expect(mockSetLocalIgnorePatterns).toHaveBeenCalledWith(['node_modules', '__pycache__']);
		});

		it('should pass honor gitignore setting', async () => {
			render(<DisplayTab theme={mockTheme} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			expect(screen.getByTestId('honor-gitignore')).toHaveTextContent('true');
			expect(screen.getByTestId('show-honor-gitignore')).toHaveTextContent('true');
		});

		it('should call setLocalHonorGitignore when toggling gitignore', async () => {
			render(<DisplayTab theme={mockTheme} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			fireEvent.click(screen.getByTestId('toggle-gitignore-btn'));

			expect(mockSetLocalHonorGitignore).toHaveBeenCalledWith(false);
		});

		it('should call setLocalHonorGitignore(true) on reset', async () => {
			render(<DisplayTab theme={mockTheme} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			fireEvent.click(screen.getByTestId('reset-btn'));

			expect(mockSetLocalHonorGitignore).toHaveBeenCalledWith(true);
		});
	});

	// =========================================================================
	// Font Detection Failure
	// =========================================================================

	describe('Font detection failure', () => {
		it('should handle font detection failure gracefully', async () => {
			(window as any).maestro.fonts.detect = vi
				.fn()
				.mockRejectedValue(new Error('Font detection failed'));

			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

			render(<DisplayTab theme={mockTheme} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			// Trigger font loading
			const fontSelect = screen.getByRole('combobox');
			fireEvent.focus(fontSelect);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			// After the rejection resolves, the select should reappear (fontLoading goes false)
			const fontSelectAfter = screen.getByRole('combobox');
			expect(fontSelectAfter).toBeInTheDocument();
			expect(consoleSpy).toHaveBeenCalledWith('Failed to load fonts:', expect.any(Error));

			consoleSpy.mockRestore();
		});

		it('should still render common monospace fonts even without system font detection', async () => {
			(window as any).maestro.fonts.detect = vi
				.fn()
				.mockRejectedValue(new Error('Font detection failed'));

			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

			render(<DisplayTab theme={mockTheme} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			// Common fonts should be in the dropdown (before any loading is triggered)
			const fontSelect = screen.getByRole('combobox');
			const options = fontSelect.querySelectorAll('option');
			// Option textContent has trailing whitespace from the JSX (font name + space + conditional)
			const optionValues = Array.from(options).map((o) => o.getAttribute('value'));
			expect(optionValues).toContain('Menlo');
			expect(optionValues).toContain('Monaco');

			consoleSpy.mockRestore();
		});
	});

	// =========================================================================
	// Font Configuration Panel Rendering
	// =========================================================================

	describe('Font configuration panel', () => {
		it('should render the font configuration panel with all common monospace fonts', async () => {
			render(<DisplayTab theme={mockTheme} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			const fontSelect = screen.getByRole('combobox');
			const options = fontSelect.querySelectorAll('option');
			const optionTexts = Array.from(options).map((o) => o.textContent?.trim());

			// Verify common monospace fonts are present
			expect(optionTexts).toContain('Roboto Mono');
			expect(optionTexts).toContain('JetBrains Mono');
			expect(optionTexts).toContain('Fira Code');
			expect(optionTexts).toContain('Monaco');
			expect(optionTexts).toContain('Menlo');
			expect(optionTexts).toContain('Consolas');
			expect(optionTexts).toContain('Courier New');
			expect(optionTexts).toContain('SF Mono');
			expect(optionTexts).toContain('Cascadia Code');
			expect(optionTexts).toContain('Source Code Pro');
		});

		it('should render custom font input field', async () => {
			render(<DisplayTab theme={mockTheme} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			expect(screen.getByPlaceholderText('Add custom font name...')).toBeInTheDocument();
		});

		it('should show font availability indicators after loading', async () => {
			// Only JetBrains Mono is available
			(window as any).maestro.fonts.detect = vi.fn().mockResolvedValue(['JetBrains Mono']);

			render(<DisplayTab theme={mockTheme} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			// Trigger font loading
			const fontSelect = screen.getByRole('combobox');

			await act(async () => {
				fireEvent.focus(fontSelect);
			});

			// Allow all async operations (detect + settings.get + state updates) to resolve
			await act(async () => {
				await vi.advanceTimersByTimeAsync(200);
			});

			// After fonts are loaded, unavailable fonts should show "(Not Found)"
			// Re-query after state updates
			const updatedSelect = screen.getByRole('combobox');
			const options = updatedSelect.querySelectorAll('option');

			// Find the Monaco option by value and check its text
			const monacoOption = Array.from(options).find((o) => o.getAttribute('value') === 'Monaco');
			expect(monacoOption).toBeTruthy();
			expect(monacoOption!.textContent).toContain('(Not Found)');

			// JetBrains Mono should NOT show as not found
			const jbOption = Array.from(options).find(
				(o) => o.getAttribute('value') === 'JetBrains Mono'
			);
			expect(jbOption).toBeTruthy();
			expect(jbOption!.textContent).not.toContain('(Not Found)');
		});

		it('should render the Add button for custom fonts', async () => {
			render(<DisplayTab theme={mockTheme} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			const customFontInput = screen.getByPlaceholderText('Add custom font name...');
			const fontContainer = customFontInput.closest('div')!.parentElement!;
			expect(within(fontContainer).getByRole('button', { name: 'Add' })).toBeInTheDocument();
		});
	});

	// =========================================================================
	// Window Chrome Section
	// =========================================================================

	describe('Window Chrome section', () => {
		it('should render Window Chrome section header', async () => {
			render(<DisplayTab theme={mockTheme} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			expect(screen.getByText('Window Chrome')).toBeInTheDocument();
		});

		it('should contain both native title bar and auto-hide menu bar toggles', async () => {
			render(<DisplayTab theme={mockTheme} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			expect(screen.getByText('Use native title bar')).toBeInTheDocument();
			expect(screen.getByText('Auto-hide menu bar')).toBeInTheDocument();
		});
	});

	// =========================================================================
	// Overall Rendering
	// =========================================================================

	describe('Overall rendering', () => {
		it('should render all major sections', async () => {
			render(<DisplayTab theme={mockTheme} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			// Font
			expect(screen.getByText('Interface Font')).toBeInTheDocument();
			// Font Size
			expect(screen.getByText('Font Size')).toBeInTheDocument();
			// Terminal Width
			expect(screen.getByText('Terminal Width (Columns)')).toBeInTheDocument();
			// Max Log Buffer
			expect(screen.getByText('Maximum Log Buffer')).toBeInTheDocument();
			// Max Output Lines
			expect(screen.getByText('Max Output Lines per Response')).toBeInTheDocument();
			// Message Alignment
			expect(screen.getByText('User Message Alignment')).toBeInTheDocument();
			// Window Chrome
			expect(screen.getByText('Window Chrome')).toBeInTheDocument();
			// Document Graph
			expect(screen.getByText('Document Graph')).toBeInTheDocument();
			// Context Window Warnings
			expect(screen.getByText('Context Window Warnings')).toBeInTheDocument();
			// Local Ignore Patterns
			expect(screen.getByTestId('ignore-patterns-section')).toBeInTheDocument();
		});
	});
});
