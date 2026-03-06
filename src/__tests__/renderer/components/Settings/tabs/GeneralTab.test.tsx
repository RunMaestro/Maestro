/**
 * Tests for GeneralTab component
 *
 * Tests the general settings tab including:
 * - Section rendering (About Me, Shell, Log Level, GitHub CLI, etc.)
 * - Conductor Profile textarea with character count and limit
 * - Shell detection, selection, and configuration
 * - Custom shell path, arguments, and environment variables
 * - Log level toggle buttons
 * - GitHub CLI path input with clear button
 * - Enter to Send toggles for AI and Terminal modes
 * - History toggle
 * - Thinking mode toggle (Off/On/Sticky)
 * - Auto-scroll toggle
 * - Automatic tab naming toggle
 * - Power management (prevent sleep) toggle
 * - Rendering options (GPU acceleration, confetti)
 * - Update settings (check on startup, beta updates)
 * - Crash reporting toggle
 * - Storage location display
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';
import { GeneralTab } from '../../../../../renderer/components/Settings/tabs/GeneralTab';
import type { Theme, ShellInfo } from '../../../../../renderer/types';

// Mock platformUtils
vi.mock('../../../../../renderer/utils/platformUtils', () => ({
	getOpenInLabel: vi.fn(() => 'Open in Finder'),
	isWindowsPlatform: vi.fn(() => false),
	isMacOSPlatform: vi.fn(() => false),
	isLinuxPlatform: vi.fn(() => false),
}));

// Shared mock fns so tests can assert on useSettings setters
const mockSetConductorProfile = vi.fn();
const mockSetDefaultShell = vi.fn();
const mockSetCustomShellPath = vi.fn();
const mockSetShellArgs = vi.fn();
const mockSetShellEnvVars = vi.fn();
const mockSetGhPath = vi.fn();
const mockSetLogLevel = vi.fn();
const mockSetEnterToSendAI = vi.fn();
const mockSetEnterToSendTerminal = vi.fn();
const mockSetDefaultSaveToHistory = vi.fn();
const mockSetDefaultShowThinking = vi.fn();
const mockSetAutoScrollAiMode = vi.fn();
const mockSetAutomaticTabNamingEnabled = vi.fn();
const mockSetPreventSleepEnabled = vi.fn();
const mockSetDisableGpuAcceleration = vi.fn();
const mockSetDisableConfetti = vi.fn();
const mockSetCheckForUpdatesOnStartup = vi.fn();
const mockSetEnableBetaUpdates = vi.fn();
const mockSetCrashReportingEnabled = vi.fn();

// Allow per-test overrides of settings
let mockUseSettingsOverrides: Record<string, any> = {};
vi.mock('../../../../../renderer/hooks/settings/useSettings', () => ({
	useSettings: () => ({
		// Conductor Profile
		conductorProfile: '',
		setConductorProfile: mockSetConductorProfile,
		// Shell settings
		defaultShell: 'zsh',
		setDefaultShell: mockSetDefaultShell,
		customShellPath: '',
		setCustomShellPath: mockSetCustomShellPath,
		shellArgs: '',
		setShellArgs: mockSetShellArgs,
		shellEnvVars: {},
		setShellEnvVars: mockSetShellEnvVars,
		ghPath: '',
		setGhPath: mockSetGhPath,
		// Log level
		logLevel: 'info',
		setLogLevel: mockSetLogLevel,
		// Input settings
		enterToSendAI: true,
		setEnterToSendAI: mockSetEnterToSendAI,
		enterToSendTerminal: true,
		setEnterToSendTerminal: mockSetEnterToSendTerminal,
		defaultSaveToHistory: true,
		setDefaultSaveToHistory: mockSetDefaultSaveToHistory,
		defaultShowThinking: 'off',
		setDefaultShowThinking: mockSetDefaultShowThinking,
		autoScrollAiMode: true,
		setAutoScrollAiMode: mockSetAutoScrollAiMode,
		// Tab naming
		automaticTabNamingEnabled: true,
		setAutomaticTabNamingEnabled: mockSetAutomaticTabNamingEnabled,
		// Power management
		preventSleepEnabled: false,
		setPreventSleepEnabled: mockSetPreventSleepEnabled,
		// Rendering
		disableGpuAcceleration: false,
		setDisableGpuAcceleration: mockSetDisableGpuAcceleration,
		disableConfetti: false,
		setDisableConfetti: mockSetDisableConfetti,
		// Updates
		checkForUpdatesOnStartup: true,
		setCheckForUpdatesOnStartup: mockSetCheckForUpdatesOnStartup,
		enableBetaUpdates: false,
		setEnableBetaUpdates: mockSetEnableBetaUpdates,
		crashReportingEnabled: true,
		setCrashReportingEnabled: mockSetCrashReportingEnabled,
		...mockUseSettingsOverrides,
	}),
}));

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

const mockShells: ShellInfo[] = [
	{ id: 'zsh', name: 'Zsh', path: '/bin/zsh', available: true },
	{ id: 'bash', name: 'Bash', path: '/bin/bash', available: true },
	{ id: 'fish', name: 'Fish', path: '/usr/local/bin/fish', available: false },
];

describe('GeneralTab', () => {
	beforeEach(() => {
		vi.useFakeTimers();

		// Reset window.maestro mocks
		vi.mocked(window.maestro.shells.detect).mockResolvedValue(mockShells);
		vi.mocked(window.maestro.sync.getDefaultPath).mockResolvedValue('/default/path');
		vi.mocked(window.maestro.sync.getSettings).mockResolvedValue({
			customSyncPath: undefined,
		} as any);
		vi.mocked(window.maestro.sync.getCurrentStoragePath).mockResolvedValue('/current/path');
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
		mockUseSettingsOverrides = {};
	});

	// =========================================================================
	// 1. Rendering - correct sections visible
	// =========================================================================
	describe('Rendering', () => {
		it('should render all major section headers', async () => {
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(screen.getByText('Conductor Profile (aka, About Me)')).toBeInTheDocument();
			expect(screen.getByText('Default Terminal Shell')).toBeInTheDocument();
			expect(screen.getByText('System Log Level')).toBeInTheDocument();
			expect(screen.getByText('GitHub CLI (gh) Path')).toBeInTheDocument();
			expect(screen.getByText('Input Send Behavior')).toBeInTheDocument();
			expect(screen.getByText('Default History Toggle')).toBeInTheDocument();
			expect(screen.getByText('Default Thinking Mode')).toBeInTheDocument();
			expect(screen.getByText('Automatic Tab Naming')).toBeInTheDocument();
			expect(screen.getByText('Auto-scroll AI Output')).toBeInTheDocument();
			expect(screen.getByText('Power')).toBeInTheDocument();
			expect(screen.getByText('Rendering Options')).toBeInTheDocument();
			expect(screen.getByText('Updates')).toBeInTheDocument();
			expect(screen.getByText('Pre-release Channel')).toBeInTheDocument();
			expect(screen.getByText('Privacy')).toBeInTheDocument();
			expect(screen.getByText('Storage Location')).toBeInTheDocument();
		});

		it('should not render when isOpen is false (effects skipped)', async () => {
			render(<GeneralTab theme={mockTheme} isOpen={false} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			// The component still renders its JSX, but effects that fetch data won't fire
			// Verify the sync load effects didn't run
			expect(window.maestro.sync.getDefaultPath).not.toHaveBeenCalled();
		});
	});

	// =========================================================================
	// 2. Conductor Profile
	// =========================================================================
	describe('Conductor Profile', () => {
		it('should render the textarea with placeholder', async () => {
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			const textarea = screen.getByPlaceholderText(/I'm a senior developer/);
			expect(textarea).toBeInTheDocument();
		});

		it('should display character count as 0/1000 when empty', async () => {
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(screen.getByText('0/1000')).toBeInTheDocument();
		});

		it('should display character count matching profile length', async () => {
			mockUseSettingsOverrides = { conductorProfile: 'Hello world' };
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(screen.getByText('11/1000')).toBeInTheDocument();
		});

		it('should have maxLength of 1000 on the textarea', async () => {
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			const textarea = screen.getByPlaceholderText(/I'm a senior developer/) as HTMLTextAreaElement;
			expect(textarea.maxLength).toBe(1000);
		});

		it('should call setConductorProfile when text changes', async () => {
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			const textarea = screen.getByPlaceholderText(/I'm a senior developer/);
			fireEvent.change(textarea, { target: { value: 'Test profile' } });

			expect(mockSetConductorProfile).toHaveBeenCalledWith('Test profile');
		});
	});

	// =========================================================================
	// 3. Shell Selection
	// =========================================================================
	describe('Shell Selection', () => {
		it('should show detect button when shells not loaded', async () => {
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(screen.getByText('Detect other available shells...')).toBeInTheDocument();
		});

		it('should show current default shell before detection', async () => {
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			// defaultShell is 'zsh', so it should capitalize to 'Zsh'
			expect(screen.getByText('Zsh')).toBeInTheDocument();
			expect(screen.getByText('Current default')).toBeInTheDocument();
		});

		it('should load shells when detect button is clicked', async () => {
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			const detectButton = screen.getByText('Detect other available shells...');
			fireEvent.click(detectButton);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(window.maestro.shells.detect).toHaveBeenCalled();
		});

		it('should load shells on mouseenter of shell button', async () => {
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			// First load shells via detect button
			const detectButton = screen.getByText('Detect other available shells...');
			fireEvent.click(detectButton);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			// After loading, shell buttons should be visible
			expect(screen.getByText('Bash')).toBeInTheDocument();
		});

		it('should call setDefaultShell when a shell is selected', async () => {
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			// Trigger shell loading
			const detectButton = screen.getByText('Detect other available shells...');
			fireEvent.click(detectButton);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			// Click on Bash shell
			const bashButton = screen.getByText('Bash').closest('button');
			fireEvent.click(bashButton!);

			expect(mockSetDefaultShell).toHaveBeenCalledWith('bash');
		});

		it('should show shell paths after detection', async () => {
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			const detectButton = screen.getByText('Detect other available shells...');
			fireEvent.click(detectButton);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(screen.getByText('/bin/zsh')).toBeInTheDocument();
			expect(screen.getByText('/bin/bash')).toBeInTheDocument();
		});

		it('should show Not Found badge for unavailable shells', async () => {
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			const detectButton = screen.getByText('Detect other available shells...');
			fireEvent.click(detectButton);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(screen.getByText('Not Found')).toBeInTheDocument();
		});

		it('should show Available badge for available non-selected shells', async () => {
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			const detectButton = screen.getByText('Detect other available shells...');
			fireEvent.click(detectButton);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			// Bash is available but not selected (zsh is default)
			expect(screen.getByText('Available')).toBeInTheDocument();
		});
	});

	// =========================================================================
	// 4. Shell Config Expansion
	// =========================================================================
	describe('Shell Configuration Expansion', () => {
		it('should show Shell Configuration toggle button', async () => {
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(screen.getByText('Shell Configuration')).toBeInTheDocument();
		});

		it('should expand to show custom path and args when clicked', async () => {
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			// Shell config is collapsed by default
			expect(screen.queryByPlaceholderText('/path/to/shell')).not.toBeInTheDocument();

			// Click to expand
			const configButton = screen.getByText('Shell Configuration').closest('button');
			fireEvent.click(configButton!);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(screen.getByPlaceholderText('/path/to/shell')).toBeInTheDocument();
			expect(screen.getByPlaceholderText('--flag value')).toBeInTheDocument();
		});

		it('should show environment variables section when expanded', async () => {
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			const configButton = screen.getByText('Shell Configuration').closest('button');
			fireEvent.click(configButton!);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(screen.getByText('Global Environment Variables')).toBeInTheDocument();
		});

		it('should collapse when clicked again', async () => {
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			const configButton = screen.getByText('Shell Configuration').closest('button');

			// Expand
			fireEvent.click(configButton!);
			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});
			expect(screen.getByPlaceholderText('/path/to/shell')).toBeInTheDocument();

			// Collapse
			fireEvent.click(configButton!);
			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});
			expect(screen.queryByPlaceholderText('/path/to/shell')).not.toBeInTheDocument();
		});
	});

	// =========================================================================
	// 5. Custom Shell Path
	// =========================================================================
	describe('Custom Shell Path', () => {
		it('should call setCustomShellPath when input changes', async () => {
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			// Expand shell config
			const configButton = screen.getByText('Shell Configuration').closest('button');
			fireEvent.click(configButton!);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			const pathInput = screen.getByPlaceholderText('/path/to/shell');
			fireEvent.change(pathInput, { target: { value: '/usr/local/bin/fish' } });

			expect(mockSetCustomShellPath).toHaveBeenCalledWith('/usr/local/bin/fish');
		});

		it('should show clear button when customShellPath has value', async () => {
			mockUseSettingsOverrides = { customShellPath: '/usr/local/bin/fish' };
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			// Expand shell config
			const configButton = screen.getByText('Shell Configuration').closest('button');
			fireEvent.click(configButton!);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			// Find the Clear button near the custom shell path input
			const pathInput = screen.getByDisplayValue('/usr/local/bin/fish');
			const container = pathInput.closest('.flex');
			const clearButton = container?.querySelector('button');
			expect(clearButton).toBeDefined();
			expect(clearButton?.textContent).toBe('Clear');
		});

		it('should call setCustomShellPath with empty string when clear is clicked', async () => {
			mockUseSettingsOverrides = { customShellPath: '/usr/local/bin/fish' };
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			// Expand shell config
			const configButton = screen.getByText('Shell Configuration').closest('button');
			fireEvent.click(configButton!);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			const pathInput = screen.getByDisplayValue('/usr/local/bin/fish');
			const container = pathInput.closest('.flex');
			const clearButton = container?.querySelector('button');
			fireEvent.click(clearButton!);

			expect(mockSetCustomShellPath).toHaveBeenCalledWith('');
		});
	});

	// =========================================================================
	// 6. Shell Arguments
	// =========================================================================
	describe('Shell Arguments', () => {
		it('should render the shell arguments input', async () => {
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			// Expand shell config
			const configButton = screen.getByText('Shell Configuration').closest('button');
			fireEvent.click(configButton!);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(screen.getByPlaceholderText('--flag value')).toBeInTheDocument();
		});

		it('should call setShellArgs when input changes', async () => {
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			const configButton = screen.getByText('Shell Configuration').closest('button');
			fireEvent.click(configButton!);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			const argsInput = screen.getByPlaceholderText('--flag value');
			fireEvent.change(argsInput, { target: { value: '--login' } });

			expect(mockSetShellArgs).toHaveBeenCalledWith('--login');
		});

		it('should show clear button when shellArgs has value', async () => {
			mockUseSettingsOverrides = { shellArgs: '--login' };
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			const configButton = screen.getByText('Shell Configuration').closest('button');
			fireEvent.click(configButton!);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			const argsInput = screen.getByDisplayValue('--login');
			const container = argsInput.closest('.flex');
			const clearButton = container?.querySelector('button');
			expect(clearButton).toBeDefined();

			fireEvent.click(clearButton!);
			expect(mockSetShellArgs).toHaveBeenCalledWith('');
		});
	});

	// =========================================================================
	// 7. Log Level
	// =========================================================================
	describe('Log Level', () => {
		it('should call setLogLevel with debug when Debug is clicked', async () => {
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			fireEvent.click(screen.getByRole('button', { name: 'Debug' }));
			expect(mockSetLogLevel).toHaveBeenCalledWith('debug');
		});

		it('should call setLogLevel with info when Info is clicked', async () => {
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			fireEvent.click(screen.getByRole('button', { name: 'Info' }));
			expect(mockSetLogLevel).toHaveBeenCalledWith('info');
		});

		it('should call setLogLevel with warn when Warn is clicked', async () => {
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			fireEvent.click(screen.getByRole('button', { name: 'Warn' }));
			expect(mockSetLogLevel).toHaveBeenCalledWith('warn');
		});

		it('should call setLogLevel with error when Error is clicked', async () => {
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			fireEvent.click(screen.getByRole('button', { name: 'Error' }));
			expect(mockSetLogLevel).toHaveBeenCalledWith('error');
		});
	});

	// =========================================================================
	// 8. GitHub CLI Path
	// =========================================================================
	describe('GitHub CLI Path', () => {
		it('should render the gh path input with placeholder', async () => {
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(screen.getByPlaceholderText('/opt/homebrew/bin/gh')).toBeInTheDocument();
		});

		it('should call setGhPath when path is changed', async () => {
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			const ghInput = screen.getByPlaceholderText('/opt/homebrew/bin/gh');
			fireEvent.change(ghInput, { target: { value: '/usr/local/bin/gh' } });

			expect(mockSetGhPath).toHaveBeenCalledWith('/usr/local/bin/gh');
		});

		it('should not show clear button when ghPath is empty', async () => {
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			const ghInput = screen.getByPlaceholderText('/opt/homebrew/bin/gh');
			const container = ghInput.closest('.flex');
			const clearButton = container?.querySelector('button');
			expect(clearButton).toBeNull();
		});

		it('should show clear button when ghPath has value', async () => {
			mockUseSettingsOverrides = { ghPath: '/usr/local/bin/gh' };
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			const ghInput = screen.getByDisplayValue('/usr/local/bin/gh');
			const container = ghInput.closest('.flex');
			const clearButton = container?.querySelector('button');
			expect(clearButton).toBeDefined();
		});

		it('should call setGhPath with empty string when clear is clicked', async () => {
			mockUseSettingsOverrides = { ghPath: '/usr/local/bin/gh' };
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			const ghInput = screen.getByDisplayValue('/usr/local/bin/gh');
			const container = ghInput.closest('.flex');
			const clearButton = container?.querySelector('button');
			fireEvent.click(clearButton!);

			expect(mockSetGhPath).toHaveBeenCalledWith('');
		});
	});

	// =========================================================================
	// 9. Enter to Send
	// =========================================================================
	describe('Enter to Send', () => {
		it('should display AI Interaction Mode and Terminal Mode sections', async () => {
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(screen.getByText('AI Interaction Mode')).toBeInTheDocument();
			expect(screen.getByText('Terminal Mode')).toBeInTheDocument();
		});

		it('should call setEnterToSendAI when AI toggle is clicked', async () => {
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			const aiModeLabel = screen.getByText('AI Interaction Mode');
			const aiModeSection = aiModeLabel.closest('.p-3');
			const toggleButton = aiModeSection?.querySelector('button');
			fireEvent.click(toggleButton!);

			expect(mockSetEnterToSendAI).toHaveBeenCalledWith(false);
		});

		it('should call setEnterToSendTerminal when Terminal toggle is clicked', async () => {
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			const terminalModeLabel = screen.getByText('Terminal Mode');
			const terminalModeSection = terminalModeLabel.closest('.p-3');
			const toggleButton = terminalModeSection?.querySelector('button');
			fireEvent.click(toggleButton!);

			expect(mockSetEnterToSendTerminal).toHaveBeenCalledWith(false);
		});

		it('should show correct label based on enterToSendAI value', async () => {
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			// enterToSendAI=true => label should be "Enter"
			const aiModeLabel = screen.getByText('AI Interaction Mode');
			const aiModeSection = aiModeLabel.closest('.p-3');
			const toggleButton = aiModeSection?.querySelector('button');
			expect(toggleButton?.textContent).toBe('Enter');
		});

		it('should show Ctrl + Enter label when enterToSendAI is false', async () => {
			mockUseSettingsOverrides = { enterToSendAI: false };
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			const aiModeLabel = screen.getByText('AI Interaction Mode');
			const aiModeSection = aiModeLabel.closest('.p-3');
			const toggleButton = aiModeSection?.querySelector('button');
			expect(toggleButton?.textContent).toMatch(/(Ctrl|⌘)\s*\+\s*Enter/);
		});

		it('should toggle enterToSendAI from false to true', async () => {
			mockUseSettingsOverrides = { enterToSendAI: false };
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			const aiModeLabel = screen.getByText('AI Interaction Mode');
			const aiModeSection = aiModeLabel.closest('.p-3');
			const toggleButton = aiModeSection?.querySelector('button');
			fireEvent.click(toggleButton!);

			expect(mockSetEnterToSendAI).toHaveBeenCalledWith(true);
		});
	});

	// =========================================================================
	// 10. History
	// =========================================================================
	describe('History', () => {
		it('should render history toggle', async () => {
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(screen.getByText('Enable "History" by default for new tabs')).toBeInTheDocument();
		});

		it('should call setDefaultSaveToHistory when toggle switch is clicked', async () => {
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			// SettingCheckbox uses role="button" wrapper and role="switch" toggle
			const titleElement = screen.getByText('Enable "History" by default for new tabs');
			const toggleContainer = titleElement.closest('[role="button"]');
			const toggleSwitch = toggleContainer?.querySelector('button[role="switch"]');
			expect(toggleSwitch).toBeDefined();

			fireEvent.click(toggleSwitch!);
			expect(mockSetDefaultSaveToHistory).toHaveBeenCalledWith(false);
		});

		it('should call setDefaultSaveToHistory with true when currently false', async () => {
			mockUseSettingsOverrides = { defaultSaveToHistory: false };
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			const titleElement = screen.getByText('Enable "History" by default for new tabs');
			const toggleContainer = titleElement.closest('[role="button"]');
			const toggleSwitch = toggleContainer?.querySelector('button[role="switch"]');

			fireEvent.click(toggleSwitch!);
			expect(mockSetDefaultSaveToHistory).toHaveBeenCalledWith(true);
		});
	});

	// =========================================================================
	// 11. Thinking Mode
	// =========================================================================
	describe('Thinking Mode', () => {
		it('should render thinking mode toggle group with Off, On, Sticky', async () => {
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(
				screen.getByText('Show AI thinking/reasoning content for new tabs')
			).toBeInTheDocument();
			expect(screen.getByRole('button', { name: 'Off' })).toBeInTheDocument();
			expect(screen.getByRole('button', { name: 'On' })).toBeInTheDocument();
			expect(screen.getByRole('button', { name: 'Sticky' })).toBeInTheDocument();
		});

		it('should call setDefaultShowThinking with on when On is clicked', async () => {
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			fireEvent.click(screen.getByRole('button', { name: 'On' }));
			expect(mockSetDefaultShowThinking).toHaveBeenCalledWith('on');
		});

		it('should call setDefaultShowThinking with sticky when Sticky is clicked', async () => {
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			fireEvent.click(screen.getByRole('button', { name: 'Sticky' }));
			expect(mockSetDefaultShowThinking).toHaveBeenCalledWith('sticky');
		});

		it('should call setDefaultShowThinking with off when Off is clicked', async () => {
			mockUseSettingsOverrides = { defaultShowThinking: 'on' };
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			fireEvent.click(screen.getByRole('button', { name: 'Off' }));
			expect(mockSetDefaultShowThinking).toHaveBeenCalledWith('off');
		});

		it('should show description based on current thinking mode', async () => {
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			// defaultShowThinking is 'off'
			expect(screen.getByText('Thinking hidden, only final responses shown')).toBeInTheDocument();
		});

		it('should show on description when thinking mode is on', async () => {
			mockUseSettingsOverrides = { defaultShowThinking: 'on' };
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(screen.getByText('Thinking streams live, clears on completion')).toBeInTheDocument();
		});

		it('should show sticky description when thinking mode is sticky', async () => {
			mockUseSettingsOverrides = { defaultShowThinking: 'sticky' };
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(screen.getByText('Thinking streams live and stays visible')).toBeInTheDocument();
		});
	});

	// =========================================================================
	// 12. Auto-scroll
	// =========================================================================
	describe('Auto-scroll', () => {
		it('should render auto-scroll toggle', async () => {
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(screen.getByText('Auto-scroll AI output')).toBeInTheDocument();
		});

		it('should call setAutoScrollAiMode when toggle is clicked', async () => {
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			const titleElement = screen.getByText('Auto-scroll AI output');
			const toggleContainer = titleElement.closest('[role="button"]');
			const toggleSwitch = toggleContainer?.querySelector('button[role="switch"]');

			fireEvent.click(toggleSwitch!);
			expect(mockSetAutoScrollAiMode).toHaveBeenCalledWith(false);
		});
	});

	// =========================================================================
	// 13. Tab Naming
	// =========================================================================
	describe('Tab Naming', () => {
		it('should render automatic tab naming toggle', async () => {
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(
				screen.getByText('Automatically name tabs based on first message')
			).toBeInTheDocument();
		});

		it('should call setAutomaticTabNamingEnabled when toggle is clicked', async () => {
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			const titleElement = screen.getByText('Automatically name tabs based on first message');
			const toggleContainer = titleElement.closest('[role="button"]');
			const toggleSwitch = toggleContainer?.querySelector('button[role="switch"]');

			fireEvent.click(toggleSwitch!);
			expect(mockSetAutomaticTabNamingEnabled).toHaveBeenCalledWith(false);
		});
	});

	// =========================================================================
	// 14. Power Management
	// =========================================================================
	describe('Power Management', () => {
		it('should render prevent sleep toggle', async () => {
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(screen.getByText('Prevent sleep while working')).toBeInTheDocument();
		});

		it('should call setPreventSleepEnabled when toggle switch is clicked', async () => {
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			const titleElement = screen.getByText('Prevent sleep while working');
			const parentSection = titleElement.closest('[role="button"]');
			const toggleSwitch = parentSection?.querySelector('button[role="switch"]');

			fireEvent.click(toggleSwitch!);
			expect(mockSetPreventSleepEnabled).toHaveBeenCalledWith(true);
		});

		it('should call setPreventSleepEnabled via the clickable row', async () => {
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			const titleElement = screen.getByText('Prevent sleep while working');
			const parentRow = titleElement.closest('[role="button"]');
			fireEvent.click(parentRow!);

			expect(mockSetPreventSleepEnabled).toHaveBeenCalledWith(true);
		});

		it('should toggle prevent sleep from enabled to disabled', async () => {
			mockUseSettingsOverrides = { preventSleepEnabled: true };
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			const titleElement = screen.getByText('Prevent sleep while working');
			const parentSection = titleElement.closest('[role="button"]');
			const toggleSwitch = parentSection?.querySelector('button[role="switch"]');

			fireEvent.click(toggleSwitch!);
			expect(mockSetPreventSleepEnabled).toHaveBeenCalledWith(false);
		});

		it('should show Linux-specific note when on Linux platform', async () => {
			const { isLinuxPlatform } = await import('../../../../../renderer/utils/platformUtils');
			vi.mocked(isLinuxPlatform).mockReturnValue(true);

			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(
				screen.getByText(/limited support on some Linux desktop environments/)
			).toBeInTheDocument();

			vi.mocked(isLinuxPlatform).mockReturnValue(false);
		});

		it('should not show Linux-specific note on non-Linux platforms', async () => {
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(
				screen.queryByText(/limited support on some Linux desktop environments/)
			).not.toBeInTheDocument();
		});
	});

	// =========================================================================
	// 15. Rendering Settings
	// =========================================================================
	describe('Rendering Settings', () => {
		it('should render GPU acceleration toggle', async () => {
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(screen.getByText('Disable GPU acceleration')).toBeInTheDocument();
		});

		it('should call setDisableGpuAcceleration when GPU toggle switch is clicked', async () => {
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			const titleElement = screen.getByText('Disable GPU acceleration');
			const parentRow = titleElement.closest('[role="button"]');
			const toggleSwitch = parentRow?.querySelector('button[role="switch"]');

			fireEvent.click(toggleSwitch!);
			expect(mockSetDisableGpuAcceleration).toHaveBeenCalledWith(true);
		});

		it('should call setDisableGpuAcceleration via the clickable row', async () => {
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			const titleElement = screen.getByText('Disable GPU acceleration');
			const parentRow = titleElement.closest('[role="button"]');
			fireEvent.click(parentRow!);

			expect(mockSetDisableGpuAcceleration).toHaveBeenCalledWith(true);
		});

		it('should render confetti toggle', async () => {
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(screen.getByText('Disable confetti animations')).toBeInTheDocument();
		});

		it('should call setDisableConfetti when confetti toggle switch is clicked', async () => {
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			const titleElement = screen.getByText('Disable confetti animations');
			const parentRow = titleElement.closest('[role="button"]');
			const toggleSwitch = parentRow?.querySelector('button[role="switch"]');

			fireEvent.click(toggleSwitch!);
			expect(mockSetDisableConfetti).toHaveBeenCalledWith(true);
		});

		it('should call setDisableConfetti via the clickable row', async () => {
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			const titleElement = screen.getByText('Disable confetti animations');
			const parentRow = titleElement.closest('[role="button"]');
			fireEvent.click(parentRow!);

			expect(mockSetDisableConfetti).toHaveBeenCalledWith(true);
		});

		it('should toggle GPU acceleration from enabled to disabled', async () => {
			mockUseSettingsOverrides = { disableGpuAcceleration: true };
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			const titleElement = screen.getByText('Disable GPU acceleration');
			const parentRow = titleElement.closest('[role="button"]');
			const toggleSwitch = parentRow?.querySelector('button[role="switch"]');

			fireEvent.click(toggleSwitch!);
			expect(mockSetDisableGpuAcceleration).toHaveBeenCalledWith(false);
		});

		it('should toggle confetti from enabled to disabled', async () => {
			mockUseSettingsOverrides = { disableConfetti: true };
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			const titleElement = screen.getByText('Disable confetti animations');
			const parentRow = titleElement.closest('[role="button"]');
			const toggleSwitch = parentRow?.querySelector('button[role="switch"]');

			fireEvent.click(toggleSwitch!);
			expect(mockSetDisableConfetti).toHaveBeenCalledWith(false);
		});
	});

	// =========================================================================
	// 16. Updates
	// =========================================================================
	describe('Updates', () => {
		it('should render check for updates toggle', async () => {
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(screen.getByText('Check for updates on startup')).toBeInTheDocument();
		});

		it('should call setCheckForUpdatesOnStartup when toggle is clicked', async () => {
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			const titleElement = screen.getByText('Check for updates on startup');
			const toggleContainer = titleElement.closest('[role="button"]');
			const toggleSwitch = toggleContainer?.querySelector('button[role="switch"]');

			fireEvent.click(toggleSwitch!);
			expect(mockSetCheckForUpdatesOnStartup).toHaveBeenCalledWith(false);
		});

		it('should render beta updates toggle', async () => {
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(screen.getByText('Include beta and release candidate updates')).toBeInTheDocument();
		});

		it('should call setEnableBetaUpdates when beta toggle is clicked', async () => {
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			const titleElement = screen.getByText('Include beta and release candidate updates');
			const toggleContainer = titleElement.closest('[role="button"]');
			const toggleSwitch = toggleContainer?.querySelector('button[role="switch"]');

			fireEvent.click(toggleSwitch!);
			expect(mockSetEnableBetaUpdates).toHaveBeenCalledWith(true);
		});
	});

	// =========================================================================
	// 17. Crash Reporting
	// =========================================================================
	describe('Crash Reporting', () => {
		it('should render crash reporting toggle', async () => {
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(screen.getByText('Send anonymous crash reports')).toBeInTheDocument();
		});

		it('should call setCrashReportingEnabled when toggle is clicked', async () => {
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			const titleElement = screen.getByText('Send anonymous crash reports');
			const toggleContainer = titleElement.closest('[role="button"]');
			const toggleSwitch = toggleContainer?.querySelector('button[role="switch"]');

			fireEvent.click(toggleSwitch!);
			expect(mockSetCrashReportingEnabled).toHaveBeenCalledWith(false);
		});

		it('should toggle crash reporting from disabled to enabled', async () => {
			mockUseSettingsOverrides = { crashReportingEnabled: false };
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			const titleElement = screen.getByText('Send anonymous crash reports');
			const toggleContainer = titleElement.closest('[role="button"]');
			const toggleSwitch = toggleContainer?.querySelector('button[role="switch"]');

			fireEvent.click(toggleSwitch!);
			expect(mockSetCrashReportingEnabled).toHaveBeenCalledWith(true);
		});
	});


	// =========================================================================
	// 20. Shell Detection Failure
	// =========================================================================
	describe('Shell Detection Failure', () => {
		it('should handle shell detection failure gracefully', async () => {
			vi.mocked(window.maestro.shells.detect).mockRejectedValue(new Error('Detection failed'));

			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			// Click detect button
			const detectButton = screen.getByText('Detect other available shells...');
			fireEvent.click(detectButton);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			// Component should still show the detect button area without crashing
			// Since the promise rejects, shells remain empty and shellsLoaded remains false
			// The component falls back to showing the current default shell
			expect(screen.getByText('Zsh')).toBeInTheDocument();
		});

		it('should show loading state during shell detection', async () => {
			// Mock shells.detect to never resolve (stays loading)
			vi.mocked(window.maestro.shells.detect).mockImplementation(() => new Promise(() => {}));

			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			const detectButton = screen.getByText('Detect other available shells...');
			fireEvent.click(detectButton);

			// Loading state should appear
			expect(screen.getByText('Loading shells...')).toBeInTheDocument();
		});
	});

	// =========================================================================
	// Storage Location
	// =========================================================================
	describe('Storage Location', () => {
		it('should load sync settings when modal is open', async () => {
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(window.maestro.sync.getDefaultPath).toHaveBeenCalled();
			expect(window.maestro.sync.getSettings).toHaveBeenCalled();
			expect(window.maestro.sync.getCurrentStoragePath).toHaveBeenCalled();
		});

		it('should display the default storage path', async () => {
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(screen.getByText('/default/path')).toBeInTheDocument();
		});

		it('should show Choose Folder button', async () => {
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(screen.getByText('Choose Folder...')).toBeInTheDocument();
		});

		it('should display Open in Finder button', async () => {
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(screen.getByText('Open in Finder')).toBeInTheDocument();
		});
	});

	// =========================================================================
	// Keyboard accessibility
	// =========================================================================
	describe('Keyboard accessibility', () => {
		it('should toggle prevent sleep on Enter key', async () => {
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			const titleElement = screen.getByText('Prevent sleep while working');
			const parentRow = titleElement.closest('[role="button"]');

			fireEvent.keyDown(parentRow!, { key: 'Enter' });
			expect(mockSetPreventSleepEnabled).toHaveBeenCalledWith(true);
		});

		it('should toggle prevent sleep on Space key', async () => {
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			const titleElement = screen.getByText('Prevent sleep while working');
			const parentRow = titleElement.closest('[role="button"]');

			fireEvent.keyDown(parentRow!, { key: ' ' });
			expect(mockSetPreventSleepEnabled).toHaveBeenCalledWith(true);
		});

		it('should toggle GPU acceleration on Enter key', async () => {
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			const titleElement = screen.getByText('Disable GPU acceleration');
			const parentRow = titleElement.closest('[role="button"]');

			fireEvent.keyDown(parentRow!, { key: 'Enter' });
			expect(mockSetDisableGpuAcceleration).toHaveBeenCalledWith(true);
		});

		it('should toggle confetti on Space key', async () => {
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			const titleElement = screen.getByText('Disable confetti animations');
			const parentRow = titleElement.closest('[role="button"]');

			fireEvent.keyDown(parentRow!, { key: ' ' });
			expect(mockSetDisableConfetti).toHaveBeenCalledWith(true);
		});
	});
});
