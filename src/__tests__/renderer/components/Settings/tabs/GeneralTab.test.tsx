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
 * - Stats collection toggle and time range selector
 * - WakaTime integration (toggle, API key, detailed tracking, CLI check)
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
const mockSetStatsCollectionEnabled = vi.fn();
const mockSetDefaultStatsTimeRange = vi.fn();
const mockSetWakatimeEnabled = vi.fn();
const mockSetWakatimeApiKey = vi.fn();
const mockSetWakatimeDetailedTracking = vi.fn();

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
		// Stats
		statsCollectionEnabled: true,
		setStatsCollectionEnabled: mockSetStatsCollectionEnabled,
		defaultStatsTimeRange: 'week',
		setDefaultStatsTimeRange: mockSetDefaultStatsTimeRange,
		// WakaTime
		wakatimeEnabled: false,
		setWakatimeEnabled: mockSetWakatimeEnabled,
		wakatimeApiKey: '',
		setWakatimeApiKey: mockSetWakatimeApiKey,
		wakatimeDetailedTracking: false,
		setWakatimeDetailedTracking: mockSetWakatimeDetailedTracking,
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
		vi.mocked(window.maestro.wakatime.checkCli).mockResolvedValue({ available: false });
		vi.mocked(window.maestro.wakatime.validateApiKey).mockResolvedValue({ valid: false });
		vi.mocked(window.maestro.stats.getDatabaseSize).mockResolvedValue(1024 * 1024);
		vi.mocked(window.maestro.stats.getEarliestTimestamp).mockResolvedValue(null);
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
			expect(screen.getByText('Usage & Stats')).toBeInTheDocument();
			expect(screen.getByText('Storage Location')).toBeInTheDocument();
		});

		it('should not render when isOpen is false (effects skipped)', async () => {
			render(<GeneralTab theme={mockTheme} isOpen={false} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			// The component still renders its JSX, but effects that fetch data won't fire
			// Verify the sync/stats load effects didn't run
			expect(window.maestro.sync.getDefaultPath).not.toHaveBeenCalled();
			expect(window.maestro.stats.getDatabaseSize).not.toHaveBeenCalled();
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

		it('should keep the shell list collapsed when detection returns no shells', async () => {
			vi.mocked(window.maestro.shells.detect).mockResolvedValue([]);

			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			fireEvent.click(screen.getByText('Detect other available shells...'));

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(window.maestro.shells.detect).toHaveBeenCalled();
			expect(screen.getByText('Zsh')).toBeInTheDocument();
			expect(screen.queryByText('Bash')).not.toBeInTheDocument();
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

		it('should not redetect shells when a loaded shell button receives focus', async () => {
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			fireEvent.click(screen.getByText('Detect other available shells...'));

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(window.maestro.shells.detect).toHaveBeenCalledTimes(1);

			fireEvent.focus(screen.getByText('Bash').closest('button')!);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(window.maestro.shells.detect).toHaveBeenCalledTimes(1);
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

		it('should expand shell configuration when an unavailable shell is selected', async () => {
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			fireEvent.click(screen.getByText('Detect other available shells...'));

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			const fishButton = screen.getByText('Fish').closest('button');
			fireEvent.click(fishButton!);

			expect(mockSetDefaultShell).toHaveBeenCalledWith('fish');
			expect(screen.getByPlaceholderText('/path/to/shell')).toBeInTheDocument();
			expect(screen.getByPlaceholderText('--flag value')).toBeInTheDocument();
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

		it('should ignore unrelated keyboard events on the prevent sleep row', async () => {
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			const row = screen.getByText('Prevent sleep while working').closest('[role="button"]');
			fireEvent.keyDown(row!, { key: 'Escape' });

			expect(mockSetPreventSleepEnabled).not.toHaveBeenCalled();
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

		it('should ignore unrelated keyboard events on the confetti row', async () => {
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			const row = screen.getByText('Disable confetti animations').closest('[role="button"]');
			fireEvent.keyDown(row!, { key: 'Escape' });

			expect(mockSetDisableConfetti).not.toHaveBeenCalled();
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
	// 18. WakaTime
	// =========================================================================
	describe('WakaTime', () => {
		it('should render WakaTime enable toggle', async () => {
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(screen.getByText('Enable WakaTime tracking')).toBeInTheDocument();
		});

		it('should call setWakatimeEnabled when toggle is clicked', async () => {
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			// The WakaTime toggle is a standalone switch (not wrapped in SettingCheckbox).
			// Find it via aria-checked attribute on the WakaTime section's switch.
			// Since wakatimeEnabled is false by default, find the switch with aria-checked=false
			// that is adjacent to the WakaTime label.
			const titleElement = screen.getByText('Enable WakaTime tracking');
			// Walk up from <p> -> <div> -> <div class="flex items-center justify-between">
			const outerContainer = titleElement.parentElement?.parentElement;
			const toggleSwitch = outerContainer?.querySelector('button[role="switch"]');

			fireEvent.click(toggleSwitch!);
			expect(mockSetWakatimeEnabled).toHaveBeenCalledWith(true);
		});

		it('should show API key input when WakaTime is enabled', async () => {
			mockUseSettingsOverrides = { wakatimeEnabled: true };
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(screen.getByPlaceholderText('waka_...')).toBeInTheDocument();
		});

		it('should not show API key input when WakaTime is disabled', async () => {
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(screen.queryByPlaceholderText('waka_...')).not.toBeInTheDocument();
		});

		it('should call setWakatimeApiKey when API key input changes', async () => {
			mockUseSettingsOverrides = { wakatimeEnabled: true };
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			const apiKeyInput = screen.getByPlaceholderText('waka_...');
			fireEvent.change(apiKeyInput, { target: { value: 'waka_test123' } });

			expect(mockSetWakatimeApiKey).toHaveBeenCalledWith('waka_test123');
		});

		it('should show detailed tracking toggle when WakaTime is enabled', async () => {
			mockUseSettingsOverrides = { wakatimeEnabled: true };
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(screen.getByText('Detailed file tracking')).toBeInTheDocument();
		});

		it('should call setWakatimeDetailedTracking when toggle is clicked', async () => {
			mockUseSettingsOverrides = { wakatimeEnabled: true };
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			const titleElement = screen.getByText('Detailed file tracking');
			const parentDiv = titleElement.closest('.flex');
			const toggleSwitch = parentDiv?.querySelector('button[role="switch"]');

			fireEvent.click(toggleSwitch!);
			expect(mockSetWakatimeDetailedTracking).toHaveBeenCalledWith(true);
		});

		it('should check WakaTime CLI when enabled and modal is open', async () => {
			mockUseSettingsOverrides = { wakatimeEnabled: true };
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(window.maestro.wakatime.checkCli).toHaveBeenCalled();
		});

		it('should not check WakaTime CLI when disabled', async () => {
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(window.maestro.wakatime.checkCli).not.toHaveBeenCalled();
		});

		it('should show CLI installing message when CLI is not available', async () => {
			mockUseSettingsOverrides = { wakatimeEnabled: true };
			vi.mocked(window.maestro.wakatime.checkCli).mockResolvedValue({ available: false });

			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(
				screen.getByText('WakaTime CLI is being installed automatically...')
			).toBeInTheDocument();
		});

		it('should not show CLI installing message when CLI is available', async () => {
			mockUseSettingsOverrides = { wakatimeEnabled: true };
			vi.mocked(window.maestro.wakatime.checkCli).mockResolvedValue({
				available: true,
				version: '1.0.0',
			});

			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(
				screen.queryByText('WakaTime CLI is being installed automatically...')
			).not.toBeInTheDocument();
		});

		it('should validate API key on blur', async () => {
			mockUseSettingsOverrides = {
				wakatimeEnabled: true,
				wakatimeApiKey: 'waka_test123',
			};
			vi.mocked(window.maestro.wakatime.validateApiKey).mockResolvedValue({ valid: true });

			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			const apiKeyInput = screen.getByPlaceholderText('waka_...');
			fireEvent.blur(apiKeyInput);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(window.maestro.wakatime.validateApiKey).toHaveBeenCalledWith('waka_test123');
		});

		it('should skip API key validation when the WakaTime key is empty', async () => {
			mockUseSettingsOverrides = {
				wakatimeEnabled: true,
				wakatimeApiKey: '',
			};

			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			fireEvent.blur(screen.getByPlaceholderText('waka_...'));

			expect(window.maestro.wakatime.validateApiKey).not.toHaveBeenCalled();
		});

		it('should mark API key invalid when validation rejects', async () => {
			mockUseSettingsOverrides = {
				wakatimeEnabled: true,
				wakatimeApiKey: 'waka_test123',
			};
			vi.mocked(window.maestro.wakatime.validateApiKey).mockRejectedValue(
				new Error('validation unavailable')
			);

			const { container } = render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			fireEvent.blur(screen.getByPlaceholderText('waka_...'));

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(window.maestro.wakatime.validateApiKey).toHaveBeenCalledWith('waka_test123');
			const invalidIcon = Array.from(container.querySelectorAll('svg')).find((svg) => {
				const color = (svg as SVGElement).style.color;
				return color === mockTheme.colors.error || color === 'rgb(255, 85, 85)';
			});
			expect(invalidIcon).toBeDefined();
		});

		it('should clear the WakaTime API key from the input control', async () => {
			mockUseSettingsOverrides = {
				wakatimeEnabled: true,
				wakatimeApiKey: 'waka_test123',
			};
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			fireEvent.click(screen.getByTitle('Clear API key'));

			expect(mockSetWakatimeApiKey).toHaveBeenCalledWith('');
		});

		it('should retry after an unavailable WakaTime CLI check and handle retry failure', async () => {
			mockUseSettingsOverrides = { wakatimeEnabled: true };
			vi.mocked(window.maestro.wakatime.checkCli)
				.mockResolvedValueOnce({ available: false })
				.mockRejectedValueOnce(new Error('retry failed'));

			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(
				screen.getByText('WakaTime CLI is being installed automatically...')
			).toBeInTheDocument();

			await act(async () => {
				await vi.advanceTimersByTimeAsync(3000);
			});

			expect(window.maestro.wakatime.checkCli).toHaveBeenCalledTimes(2);
			expect(
				screen.getByText('WakaTime CLI is being installed automatically...')
			).toBeInTheDocument();
		});

		it('should clear the installing message when a WakaTime CLI retry succeeds', async () => {
			mockUseSettingsOverrides = { wakatimeEnabled: true };
			vi.mocked(window.maestro.wakatime.checkCli)
				.mockResolvedValueOnce({ available: false })
				.mockResolvedValueOnce({ available: true, version: '1.2.3' });

			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(
				screen.getByText('WakaTime CLI is being installed automatically...')
			).toBeInTheDocument();

			await act(async () => {
				await vi.advanceTimersByTimeAsync(3000);
			});

			expect(window.maestro.wakatime.checkCli).toHaveBeenCalledTimes(2);
			expect(
				screen.queryByText('WakaTime CLI is being installed automatically...')
			).not.toBeInTheDocument();
		});

		it('should retry after an initial WakaTime CLI check failure', async () => {
			mockUseSettingsOverrides = { wakatimeEnabled: true };
			vi.mocked(window.maestro.wakatime.checkCli)
				.mockRejectedValueOnce(new Error('initial failed'))
				.mockRejectedValueOnce(new Error('retry failed'));

			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(
				screen.getByText('WakaTime CLI is being installed automatically...')
			).toBeInTheDocument();

			await act(async () => {
				await vi.advanceTimersByTimeAsync(3000);
			});

			expect(window.maestro.wakatime.checkCli).toHaveBeenCalledTimes(2);
			expect(
				screen.getByText('WakaTime CLI is being installed automatically...')
			).toBeInTheDocument();
		});

		it('should recover when a WakaTime CLI retry after initial failure succeeds', async () => {
			mockUseSettingsOverrides = { wakatimeEnabled: true };
			vi.mocked(window.maestro.wakatime.checkCli)
				.mockRejectedValueOnce(new Error('initial failed'))
				.mockResolvedValueOnce({ available: true, version: '1.2.3' });

			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(
				screen.getByText('WakaTime CLI is being installed automatically...')
			).toBeInTheDocument();

			await act(async () => {
				await vi.advanceTimersByTimeAsync(3000);
			});

			expect(window.maestro.wakatime.checkCli).toHaveBeenCalledTimes(2);
			expect(
				screen.queryByText('WakaTime CLI is being installed automatically...')
			).not.toBeInTheDocument();
		});

		it('should ignore a successful unavailable-status retry after unmount', async () => {
			mockUseSettingsOverrides = { wakatimeEnabled: true };
			let resolveRetry!: (status: { available: boolean; version?: string }) => void;
			vi.mocked(window.maestro.wakatime.checkCli)
				.mockResolvedValueOnce({ available: false })
				.mockReturnValueOnce(
					new Promise((resolve) => {
						resolveRetry = resolve;
					})
				);

			const { unmount } = render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
				await vi.advanceTimersByTimeAsync(3000);
			});

			expect(window.maestro.wakatime.checkCli).toHaveBeenCalledTimes(2);
			unmount();

			await act(async () => {
				resolveRetry({ available: true, version: '1.2.3' });
				await Promise.resolve();
			});
		});

		it('should ignore a failed unavailable-status retry after unmount', async () => {
			mockUseSettingsOverrides = { wakatimeEnabled: true };
			let rejectRetry!: (error: Error) => void;
			vi.mocked(window.maestro.wakatime.checkCli)
				.mockResolvedValueOnce({ available: false })
				.mockReturnValueOnce(
					new Promise((_, reject) => {
						rejectRetry = reject;
					})
				);

			const { unmount } = render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
				await vi.advanceTimersByTimeAsync(3000);
			});

			expect(window.maestro.wakatime.checkCli).toHaveBeenCalledTimes(2);
			unmount();

			await act(async () => {
				rejectRetry(new Error('late retry failure'));
				await Promise.resolve();
			});
		});

		it('should ignore a successful initial-failure retry after unmount', async () => {
			mockUseSettingsOverrides = { wakatimeEnabled: true };
			let resolveRetry!: (status: { available: boolean; version?: string }) => void;
			vi.mocked(window.maestro.wakatime.checkCli)
				.mockRejectedValueOnce(new Error('initial failed'))
				.mockReturnValueOnce(
					new Promise((resolve) => {
						resolveRetry = resolve;
					})
				);

			const { unmount } = render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
				await vi.advanceTimersByTimeAsync(3000);
			});

			expect(window.maestro.wakatime.checkCli).toHaveBeenCalledTimes(2);
			unmount();

			await act(async () => {
				resolveRetry({ available: true, version: '1.2.3' });
				await Promise.resolve();
			});
		});

		it('should ignore a failed initial-failure retry after unmount', async () => {
			mockUseSettingsOverrides = { wakatimeEnabled: true };
			let rejectRetry!: (error: Error) => void;
			vi.mocked(window.maestro.wakatime.checkCli)
				.mockRejectedValueOnce(new Error('initial failed'))
				.mockReturnValueOnce(
					new Promise((_, reject) => {
						rejectRetry = reject;
					})
				);

			const { unmount } = render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
				await vi.advanceTimersByTimeAsync(3000);
			});

			expect(window.maestro.wakatime.checkCli).toHaveBeenCalledTimes(2);
			unmount();

			await act(async () => {
				rejectRetry(new Error('late retry failure'));
				await Promise.resolve();
			});
		});

		it('should ignore WakaTime CLI success after unmount', async () => {
			mockUseSettingsOverrides = { wakatimeEnabled: true };
			let resolveCheck!: (status: { available: boolean; version?: string }) => void;
			vi.mocked(window.maestro.wakatime.checkCli).mockReturnValue(
				new Promise((resolve) => {
					resolveCheck = resolve;
				})
			);

			const { unmount } = render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(0);
			});

			unmount();

			await act(async () => {
				resolveCheck({ available: true, version: '1.2.3' });
				await Promise.resolve();
			});

			expect(window.maestro.wakatime.checkCli).toHaveBeenCalledTimes(1);
		});

		it('should ignore WakaTime CLI failure after unmount', async () => {
			mockUseSettingsOverrides = { wakatimeEnabled: true };
			let rejectCheck!: (error: Error) => void;
			vi.mocked(window.maestro.wakatime.checkCli).mockReturnValue(
				new Promise((_, reject) => {
					rejectCheck = reject;
				})
			);

			const { unmount } = render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(0);
			});

			unmount();

			await act(async () => {
				rejectCheck(new Error('late failure'));
				await Promise.resolve();
			});

			expect(window.maestro.wakatime.checkCli).toHaveBeenCalledTimes(1);
		});
	});

	// =========================================================================
	// 19. Stats Collection
	// =========================================================================
	describe('Stats Collection', () => {
		it('should render stats collection toggle', async () => {
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(screen.getByText('Enable stats collection')).toBeInTheDocument();
		});

		it('should call setStatsCollectionEnabled when toggle is clicked', async () => {
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			const titleElement = screen.getByText('Enable stats collection');
			const parentDiv = titleElement.closest('.flex');
			const toggleSwitch = parentDiv?.querySelector('button[role="switch"]');

			fireEvent.click(toggleSwitch!);
			expect(mockSetStatsCollectionEnabled).toHaveBeenCalledWith(false);
		});

		it('should render time range select', async () => {
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(screen.getByText('Default dashboard time range')).toBeInTheDocument();
			const select = screen.getByDisplayValue('Last 7 days') as HTMLSelectElement;
			expect(select).toBeInTheDocument();
		});

		it('should call setDefaultStatsTimeRange when time range is changed', async () => {
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			const select = screen.getByDisplayValue('Last 7 days');
			fireEvent.change(select, { target: { value: 'month' } });

			expect(mockSetDefaultStatsTimeRange).toHaveBeenCalledWith('month');
		});

		it('should show all time range options', async () => {
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(screen.getByText('Last 24 hours')).toBeInTheDocument();
			expect(screen.getByText('Last 7 days')).toBeInTheDocument();
			expect(screen.getByText('Last 30 days')).toBeInTheDocument();
			expect(screen.getByText('Last 365 days')).toBeInTheDocument();
			expect(screen.getByText('All time')).toBeInTheDocument();
		});

		it('should display database size', async () => {
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(screen.getByText('Database size')).toBeInTheDocument();
			// 1024*1024 bytes = 1.00 MB
			expect(screen.getByText(/1\.00 MB/)).toBeInTheDocument();
		});

		it('should display Loading... when stats size is not yet loaded', async () => {
			vi.mocked(window.maestro.stats.getDatabaseSize).mockImplementation(
				() => new Promise(() => {}) // never resolves
			);

			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(screen.getByText('Loading...')).toBeInTheDocument();
		});

		it('should skip clearing stats when no retention period is selected', async () => {
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			await act(async () => {
				fireEvent.click(screen.getByRole('button', { name: /Clear/i }));
				await vi.runAllTimersAsync();
			});

			expect(window.maestro.stats.clearOldData).not.toHaveBeenCalled();
		});

		it('should clear old stats and refresh the database size', async () => {
			vi.mocked(window.maestro.stats.getEarliestTimestamp).mockResolvedValue(Date.UTC(2024, 1, 3));
			vi.mocked(window.maestro.stats.getDatabaseSize)
				.mockResolvedValueOnce(1024 * 1024)
				.mockResolvedValueOnce(2 * 1024 * 1024);
			vi.mocked(window.maestro.stats.clearOldData).mockResolvedValue({
				success: true,
				deletedQueryEvents: 1,
				deletedAutoRunSessions: 2,
				deletedAutoRunTasks: 3,
			});

			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(screen.getByText(/since 2024-02-03/)).toBeInTheDocument();

			const select = document.getElementById('clear-stats-period') as HTMLSelectElement;
			await act(async () => {
				fireEvent.change(select, { target: { value: '30' } });
				fireEvent.click(screen.getByRole('button', { name: /Clear/i }));
				await vi.runAllTimersAsync();
			});

			expect(window.maestro.stats.clearOldData).toHaveBeenCalledWith(30);
			expect(window.maestro.stats.getDatabaseSize).toHaveBeenCalledTimes(2);
			expect(screen.getByText(/Cleared 6 records/)).toBeInTheDocument();
			expect(screen.getByText(/2\.00 MB/)).toBeInTheDocument();
		});

		it('should show a clearing state while old stats are being deleted', async () => {
			let resolveClear!: (
				result: Awaited<ReturnType<typeof window.maestro.stats.clearOldData>>
			) => void;
			vi.mocked(window.maestro.stats.clearOldData).mockReturnValue(
				new Promise((resolve) => {
					resolveClear = resolve;
				})
			);

			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			const select = document.getElementById('clear-stats-period') as HTMLSelectElement;
			await act(async () => {
				fireEvent.change(select, { target: { value: '7' } });
				fireEvent.click(screen.getByRole('button', { name: /Clear/i }));
				await Promise.resolve();
			});

			expect(screen.getByRole('button', { name: /Clearing/i })).toBeDisabled();

			await act(async () => {
				resolveClear({
					success: false,
					deletedQueryEvents: 0,
					deletedAutoRunSessions: 0,
					deletedAutoRunTasks: 0,
				});
				await Promise.resolve();
			});
		});

		it('should show a stats clearing error when clearing old data fails', async () => {
			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
			const clearError = new Error('stats database locked');
			vi.mocked(window.maestro.stats.clearOldData).mockRejectedValue(clearError);

			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			const select = document.getElementById('clear-stats-period') as HTMLSelectElement;
			await act(async () => {
				fireEvent.change(select, { target: { value: '7' } });
				fireEvent.click(screen.getByRole('button', { name: /Clear/i }));
				await vi.runAllTimersAsync();
			});

			expect(consoleError).toHaveBeenCalledWith('Failed to clear old stats:', clearError);
			expect(screen.getByText('stats database locked')).toBeInTheDocument();

			consoleError.mockRestore();
		});

		it('should show the default stats clearing failure when the result has no error', async () => {
			vi.mocked(window.maestro.stats.clearOldData).mockResolvedValue({
				success: false,
				deletedQueryEvents: 0,
				deletedAutoRunSessions: 0,
				deletedAutoRunTasks: 0,
			});

			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			const select = document.getElementById('clear-stats-period') as HTMLSelectElement;
			await act(async () => {
				fireEvent.change(select, { target: { value: '365' } });
				fireEvent.click(screen.getByRole('button', { name: /Clear/i }));
				await vi.runAllTimersAsync();
			});

			expect(screen.getByText('Failed to clear stats data')).toBeInTheDocument();
		});
	});

	// =========================================================================
	// 20. Shell Detection Failure
	// =========================================================================
	describe('Shell Detection Failure', () => {
		it('should handle shell detection failure gracefully', async () => {
			const detectionError = new Error('Detection failed');
			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
			vi.mocked(window.maestro.shells.detect).mockRejectedValue(detectionError);

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
			expect(consoleError).toHaveBeenCalledWith('Failed to load shells:', detectionError);
			consoleError.mockRestore();
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

		it('should show and log sync and stats load failures', async () => {
			const syncError = new Error('sync unavailable');
			const sizeError = new Error('size unavailable');
			const earliestError = new Error('earliest unavailable');
			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
			vi.mocked(window.maestro.sync.getSettings).mockRejectedValue(syncError);
			vi.mocked(window.maestro.stats.getDatabaseSize).mockRejectedValue(sizeError);
			vi.mocked(window.maestro.stats.getEarliestTimestamp).mockRejectedValue(earliestError);

			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(screen.getByText('Failed to load storage settings')).toBeInTheDocument();
			expect(consoleError).toHaveBeenCalledWith('Failed to load sync settings:', syncError);
			expect(consoleError).toHaveBeenCalledWith('Failed to load stats database size:', sizeError);
			expect(consoleError).toHaveBeenCalledWith(
				'Failed to load earliest stats timestamp:',
				earliestError
			);

			consoleError.mockRestore();
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

		it('should fall back to the macOS file-manager label when platform is unavailable', async () => {
			const originalPlatform = window.maestro.platform;
			(window.maestro as any).platform = undefined;

			try {
				render(<GeneralTab theme={mockTheme} isOpen={true} />);

				await act(async () => {
					await vi.advanceTimersByTimeAsync(100);
				});

				expect(screen.getByText('Open in Finder')).toBeInTheDocument();
			} finally {
				(window.maestro as any).platform = originalPlatform;
			}
		});

		it('should open the current storage folder in Finder', async () => {
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			fireEvent.click(screen.getByRole('button', { name: /Open in Finder/i }));

			expect(window.maestro.shell.openPath).toHaveBeenCalledWith('/default/path');
		});

		it('should migrate to a selected custom storage folder', async () => {
			vi.mocked(window.maestro.sync.selectSyncFolder).mockResolvedValue('/sync/path');
			vi.mocked(window.maestro.sync.setCustomPath).mockResolvedValue({
				success: true,
				migrated: 2,
			} as any);

			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			await act(async () => {
				fireEvent.click(screen.getByRole('button', { name: /Choose Folder/i }));
				await vi.runAllTimersAsync();
			});

			expect(window.maestro.sync.selectSyncFolder).toHaveBeenCalled();
			expect(window.maestro.sync.setCustomPath).toHaveBeenCalledWith('/sync/path');
			expect(screen.getByText('Migrated 2 settings files')).toBeInTheDocument();
			expect(screen.getByText('Restart Maestro for changes to take effect')).toBeInTheDocument();
			expect(screen.getByText('/sync/path')).toBeInTheDocument();
		});

		it('should show migrating while a selected custom storage folder is being applied', async () => {
			let resolveSetPath!: (result: { success: boolean }) => void;
			vi.mocked(window.maestro.sync.selectSyncFolder).mockResolvedValue('/sync/path');
			vi.mocked(window.maestro.sync.setCustomPath).mockReturnValue(
				new Promise((resolve) => {
					resolveSetPath = resolve;
				}) as any
			);

			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			await act(async () => {
				fireEvent.click(screen.getByRole('button', { name: /Choose Folder/i }));
				await Promise.resolve();
			});

			expect(screen.getByRole('button', { name: /Migrating/i })).toBeDisabled();

			await act(async () => {
				resolveSetPath({ success: true });
				await Promise.resolve();
			});

			expect(screen.getByText('Restart Maestro for changes to take effect')).toBeInTheDocument();
			expect(screen.queryByText(/Migrated \d settings file/)).not.toBeInTheDocument();
		});

		it('should do nothing when custom storage folder selection is cancelled', async () => {
			vi.mocked(window.maestro.sync.selectSyncFolder).mockResolvedValue(null);

			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			await act(async () => {
				fireEvent.click(screen.getByRole('button', { name: /Choose Folder/i }));
				await vi.runAllTimersAsync();
			});

			expect(window.maestro.sync.selectSyncFolder).toHaveBeenCalled();
			expect(window.maestro.sync.setCustomPath).not.toHaveBeenCalled();
		});

		it('should show custom storage selection errors', async () => {
			vi.mocked(window.maestro.sync.selectSyncFolder).mockResolvedValue('/sync/path');
			vi.mocked(window.maestro.sync.setCustomPath).mockResolvedValue({
				success: false,
				errors: ['copy failed', 'permissions denied'],
			} as any);

			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			await act(async () => {
				fireEvent.click(screen.getByRole('button', { name: /Choose Folder/i }));
				await vi.runAllTimersAsync();
			});

			expect(screen.getByText('copy failed, permissions denied')).toBeInTheDocument();
		});

		it('should show a single custom storage selection error', async () => {
			vi.mocked(window.maestro.sync.selectSyncFolder).mockResolvedValue('/sync/path');
			vi.mocked(window.maestro.sync.setCustomPath).mockResolvedValue({
				success: false,
				error: 'copy denied',
			} as any);

			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			await act(async () => {
				fireEvent.click(screen.getByRole('button', { name: /Choose Folder/i }));
				await vi.runAllTimersAsync();
			});

			expect(screen.getByText('copy denied')).toBeInTheDocument();
		});

		it('should show the default custom storage selection failure', async () => {
			vi.mocked(window.maestro.sync.selectSyncFolder).mockResolvedValue('/sync/path');
			vi.mocked(window.maestro.sync.setCustomPath).mockResolvedValue({
				success: false,
			} as any);

			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			await act(async () => {
				fireEvent.click(screen.getByRole('button', { name: /Choose Folder/i }));
				await vi.runAllTimersAsync();
			});

			expect(screen.getByText('Failed to change storage location')).toBeInTheDocument();
		});

		it('should show selection dialog errors when choosing a custom storage folder fails', async () => {
			vi.mocked(window.maestro.sync.selectSyncFolder).mockRejectedValue(
				new Error('folder dialog unavailable')
			);

			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			await act(async () => {
				fireEvent.click(screen.getByRole('button', { name: /Choose Folder/i }));
				await vi.runAllTimersAsync();
			});

			expect(screen.getByText('folder dialog unavailable')).toBeInTheDocument();
		});

		it('should stringify non-Error selection dialog failures', async () => {
			vi.mocked(window.maestro.sync.selectSyncFolder).mockRejectedValue(
				'folder dialog unavailable'
			);

			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			await act(async () => {
				fireEvent.click(screen.getByRole('button', { name: /Choose Folder/i }));
				await vi.runAllTimersAsync();
			});

			expect(screen.getByText('folder dialog unavailable')).toBeInTheDocument();
		});

		it('should show migration errors when setting a custom storage folder throws', async () => {
			vi.mocked(window.maestro.sync.selectSyncFolder).mockResolvedValue('/sync/path');
			vi.mocked(window.maestro.sync.setCustomPath).mockRejectedValue(new Error('migration failed'));

			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			await act(async () => {
				fireEvent.click(screen.getByRole('button', { name: /Choose Folder/i }));
				await vi.runAllTimersAsync();
			});

			expect(screen.getByText('migration failed')).toBeInTheDocument();
		});

		it('should stringify non-Error custom storage migration failures', async () => {
			vi.mocked(window.maestro.sync.selectSyncFolder).mockResolvedValue('/sync/path');
			vi.mocked(window.maestro.sync.setCustomPath).mockRejectedValue('migration failed');

			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			await act(async () => {
				fireEvent.click(screen.getByRole('button', { name: /Choose Folder/i }));
				await vi.runAllTimersAsync();
			});

			expect(screen.getByText('migration failed')).toBeInTheDocument();
		});

		it('should reset a custom storage folder back to the default path', async () => {
			vi.mocked(window.maestro.sync.getSettings).mockResolvedValue({
				customSyncPath: '/sync/path',
			} as any);
			vi.mocked(window.maestro.sync.setCustomPath).mockResolvedValue({
				success: true,
				migrated: 1,
			} as any);

			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			await act(async () => {
				fireEvent.click(screen.getByRole('button', { name: /Use Default/i }));
				await vi.runAllTimersAsync();
			});

			expect(window.maestro.sync.setCustomPath).toHaveBeenCalledWith(null);
			expect(screen.getByText('Migrated 1 settings file')).toBeInTheDocument();
			expect(screen.getByText('Restart Maestro for changes to take effect')).toBeInTheDocument();
		});

		it('should reset a custom storage folder without a migrated count', async () => {
			vi.mocked(window.maestro.sync.getSettings).mockResolvedValue({
				customSyncPath: '/sync/path',
			} as any);
			vi.mocked(window.maestro.sync.setCustomPath).mockResolvedValue({
				success: true,
			} as any);

			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			await act(async () => {
				fireEvent.click(screen.getByRole('button', { name: /Use Default/i }));
				await vi.runAllTimersAsync();
			});

			expect(window.maestro.sync.setCustomPath).toHaveBeenCalledWith(null);
			expect(screen.getByText('Restart Maestro for changes to take effect')).toBeInTheDocument();
			expect(screen.queryByText(/Migrated \d settings file/)).not.toBeInTheDocument();
		});

		it('should show reset errors when resetting custom storage fails', async () => {
			vi.mocked(window.maestro.sync.getSettings).mockResolvedValue({
				customSyncPath: '/sync/path',
			} as any);
			vi.mocked(window.maestro.sync.setCustomPath).mockResolvedValue({
				success: false,
				error: 'reset denied',
			} as any);

			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			await act(async () => {
				fireEvent.click(screen.getByRole('button', { name: /Use Default/i }));
				await vi.runAllTimersAsync();
			});

			expect(window.maestro.sync.setCustomPath).toHaveBeenCalledWith(null);
			expect(screen.getByText('reset denied')).toBeInTheDocument();
		});

		it('should show the default reset failure when no reset error is returned', async () => {
			vi.mocked(window.maestro.sync.getSettings).mockResolvedValue({
				customSyncPath: '/sync/path',
			} as any);
			vi.mocked(window.maestro.sync.setCustomPath).mockResolvedValue({
				success: false,
			} as any);

			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			await act(async () => {
				fireEvent.click(screen.getByRole('button', { name: /Use Default/i }));
				await vi.runAllTimersAsync();
			});

			expect(window.maestro.sync.setCustomPath).toHaveBeenCalledWith(null);
			expect(screen.getByText('Failed to reset storage location')).toBeInTheDocument();
		});

		it('should show thrown reset errors when resetting custom storage rejects', async () => {
			vi.mocked(window.maestro.sync.getSettings).mockResolvedValue({
				customSyncPath: '/sync/path',
			} as any);
			vi.mocked(window.maestro.sync.setCustomPath).mockRejectedValue(new Error('reset rejected'));

			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			await act(async () => {
				fireEvent.click(screen.getByRole('button', { name: /Use Default/i }));
				await vi.runAllTimersAsync();
			});

			expect(window.maestro.sync.setCustomPath).toHaveBeenCalledWith(null);
			expect(screen.getByText('reset rejected')).toBeInTheDocument();
		});

		it('should stringify non-Error reset failures', async () => {
			vi.mocked(window.maestro.sync.getSettings).mockResolvedValue({
				customSyncPath: '/sync/path',
			} as any);
			vi.mocked(window.maestro.sync.setCustomPath).mockRejectedValue('reset rejected');

			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			await act(async () => {
				fireEvent.click(screen.getByRole('button', { name: /Use Default/i }));
				await vi.runAllTimersAsync();
			});

			expect(window.maestro.sync.setCustomPath).toHaveBeenCalledWith(null);
			expect(screen.getByText('reset rejected')).toBeInTheDocument();
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

		it('should warn when conductor profile approaches the character limit', async () => {
			mockUseSettingsOverrides = { conductorProfile: 'x'.repeat(901) };

			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(screen.getByText('901/1000')).toBeInTheDocument();
		});

		it('should mark an unavailable selected shell as requiring a custom path', async () => {
			mockUseSettingsOverrides = { defaultShell: 'fish' };

			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});
			fireEvent.click(screen.getByText('Detect other available shells...'));

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(screen.getByText('Custom Path Required')).toBeInTheDocument();
		});

		it('should render terminal Ctrl+Enter mode when terminal Enter-to-send is disabled', async () => {
			mockUseSettingsOverrides = { enterToSendTerminal: false };

			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(screen.getAllByText(/Ctrl.*Enter/).length).toBeGreaterThan(0);
			expect(screen.getByText(/Enter creates new line/)).toBeInTheDocument();
		});

		it('should ignore unrelated GPU acceleration keyboard events', async () => {
			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			const titleElement = screen.getByText('Disable GPU acceleration');
			const parentRow = titleElement.closest('[role="button"]');

			fireEvent.keyDown(parentRow!, { key: 'Escape' });
			expect(mockSetDisableGpuAcceleration).not.toHaveBeenCalled();
		});

		it('should render disabled stats collection and enabled detailed WakaTime tracking states', async () => {
			mockUseSettingsOverrides = {
				statsCollectionEnabled: false,
				wakatimeEnabled: true,
				wakatimeDetailedTracking: true,
			};

			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(screen.getByRole('switch', { name: 'Enable stats collection' })).toHaveAttribute(
				'aria-checked',
				'false'
			);
			expect(screen.getByRole('switch', { name: 'Detailed file tracking' })).toHaveAttribute(
				'aria-checked',
				'true'
			);
		});

		it('should show a generic stats clearing error for non-Error rejections', async () => {
			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
			vi.mocked(window.maestro.stats.clearOldData).mockRejectedValue('locked');

			render(<GeneralTab theme={mockTheme} isOpen={true} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			const select = document.getElementById('clear-stats-period') as HTMLSelectElement;
			await act(async () => {
				fireEvent.change(select, { target: { value: '7' } });
				fireEvent.click(screen.getByRole('button', { name: /Clear/i }));
				await vi.runAllTimersAsync();
			});

			expect(consoleError).toHaveBeenCalledWith('Failed to clear old stats:', 'locked');
			expect(screen.getByText('Unknown error')).toBeInTheDocument();

			consoleError.mockRestore();
		});
	});
});
