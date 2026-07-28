/**
 * Tests for SettingsModal.tsx
 *
 * Tests the SettingsModal component, including:
 * - Modal rendering and isOpen conditional
 * - Tab navigation (general, display, shortcuts, theme, notifications, aicommands, encore)
 * - Tab keyboard navigation (Cmd+Shift+[ and ])
 * - Layer stack integration
 * - Agent loading and configuration
 * - Font loading and management
 * - Shell loading and selection
 * - Shortcut recording
 * - Theme picker with Tab navigation
 * - Various setting controls
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { logger } from '../../../renderer/utils/logger';
import { render, screen, fireEvent, act, waitFor, within } from '@testing-library/react';
import {
	SettingsModal,
	__resetLastOpenSettingsTabForTests,
} from '../../../renderer/components/Settings/SettingsModal';
import { formatEnterToSend } from '../../../renderer/utils/shortcutFormatter';
import { useModalStore } from '../../../renderer/stores/modalStore';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import { mockTheme } from '../../helpers/mockTheme';
import type {
	Theme,
	Shortcut,
	ShellInfo,
	CustomAICommand,
	AgentConfig,
} from '../../../renderer/types';

// __APP_VERSION__ / __COMMIT_HASH__ are injected by the bundler at build time.
// The About tab renders them, so stub them for the jsdom test environment.
(globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = '1.0.0';
(globalThis as unknown as { __COMMIT_HASH__: string }).__COMMIT_HASH__ = '';

// Mock the LayerStackContext
vi.mock('../../../renderer/contexts/LayerStackContext', () => ({
	useLayerStack: vi.fn(() => ({
		registerLayer: vi.fn(() => 'layer-123'),
		unregisterLayer: vi.fn(),
		updateLayerHandler: vi.fn(),
	})),
}));

// Mock formatShortcutKeys
vi.mock('../../../renderer/utils/shortcutFormatter', () => ({
	formatShortcutKeys: vi.fn((keys: string[]) => keys.join('+')),
	isMacOS: vi.fn(() => false), // Test environment is not Mac
	formatMetaKey: vi.fn(() => 'Ctrl'),
	formatMetaKeyName: vi.fn(() => 'Ctrl'),
	formatEnterToSend: vi.fn((enterToSend: boolean) => (enterToSend ? 'Enter' : 'Ctrl + Enter')),
	formatEnterToSendTooltip: vi.fn((enterToSend: boolean) =>
		enterToSend ? 'Switch to Ctrl+Enter to send' : 'Switch to Enter to send'
	),
}));

// Mock AICommandsPanel
vi.mock('../../../renderer/components/AICommandsPanel', () => ({
	AICommandsPanel: ({ theme }: { theme: Theme }) => (
		<div data-testid="ai-commands-panel">AI Commands Panel</div>
	),
}));

// Mock SpecKitCommandsPanel
vi.mock('../../../renderer/components/SpecKitCommandsPanel', () => ({
	SpecKitCommandsPanel: ({ theme }: { theme: Theme }) => (
		<div data-testid="spec-kit-commands-panel">Spec Kit Commands Panel</div>
	),
}));

// Mock CustomThemeBuilder
vi.mock('../../../renderer/components/CustomThemeBuilder', () => ({
	CustomThemeBuilder: ({ isSelected, onSelect }: { isSelected: boolean; onSelect: () => void }) => (
		<div data-testid="custom-theme-builder">
			<button onClick={onSelect} data-theme-id="custom" className={isSelected ? 'ring-2' : ''}>
				Custom Theme
			</button>
		</div>
	),
}));

// Shared mock fns so tests can assert on useSettings setters
const mockSetActiveThemeId = vi.fn();
const mockSetCustomThemeColors = vi.fn();
const mockSetCustomThemeBaseId = vi.fn();
const mockSetLlmProvider = vi.fn();
const mockSetModelSlug = vi.fn();
const mockSetApiKey = vi.fn();
const mockSetShortcuts = vi.fn();
const mockSetTabShortcuts = vi.fn();
const mockSetFontFamily = vi.fn();
const mockSetFontSize = vi.fn();
const mockSetLogLevel = vi.fn();
const mockSetMaxLogBuffer = vi.fn();
const mockSetMaxOutputLines = vi.fn();
const mockSetDefaultShell = vi.fn();
const mockSetCustomShellPath = vi.fn();
const mockSetShellArgs = vi.fn();
const mockSetShellEnvVars = vi.fn();
const mockSetGhPath = vi.fn();
const mockSetEnterToSendAI = vi.fn();
const mockSetDefaultSaveToHistory = vi.fn();
const mockSetDefaultShowThinking = vi.fn();
const mockSetUserMessageAlignment = vi.fn();
const mockSetOsNotificationsEnabled = vi.fn();
const mockSetAudioFeedbackEnabled = vi.fn();
const mockSetAudioFeedbackCommand = vi.fn();
const mockSetToastDuration = vi.fn();
const mockSetIdleNotificationEnabled = vi.fn();
const mockSetIdleNotificationCommand = vi.fn();
const mockSetCheckForUpdatesOnStartup = vi.fn();
const mockSetEnableBetaUpdates = vi.fn();
const mockSetCrashReportingEnabled = vi.fn();
const mockSetCustomAICommands = vi.fn();
const mockSetEncoreFeatures = vi.fn();
const mockSetDirectorNotesSettings = vi.fn();

// Mock useSettings hook (now self-sources all settings previously passed as props)
let mockUseSettingsOverrides: Record<string, any> = {};
vi.mock('../../../renderer/hooks/settings/useSettings', () => ({
	useSettings: () => ({
		// Theme settings
		activeThemeId: 'dracula',
		setActiveThemeId: mockSetActiveThemeId,
		customThemeColors: {
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
		setCustomThemeColors: mockSetCustomThemeColors,
		customThemeBaseId: 'dracula',
		setCustomThemeBaseId: mockSetCustomThemeBaseId,
		// LLM settings
		llmProvider: 'openrouter',
		setLlmProvider: mockSetLlmProvider,
		modelSlug: '',
		setModelSlug: mockSetModelSlug,
		apiKey: '',
		setApiKey: mockSetApiKey,
		// Shortcut settings
		shortcuts: {
			'new-session': { id: 'new-session', label: 'New Session', keys: ['Meta', 'n'] },
			'close-session': { id: 'close-session', label: 'Close Session', keys: ['Meta', 'w'] },
			'toggle-mode': { id: 'toggle-mode', label: 'Toggle Mode', keys: ['Meta', 'j'] },
		},
		setShortcuts: mockSetShortcuts,
		tabShortcuts: {},
		setTabShortcuts: mockSetTabShortcuts,
		// Display settings
		fontFamily: 'Menlo',
		setFontFamily: mockSetFontFamily,
		fontSize: 14,
		setFontSize: mockSetFontSize,
		logLevel: 'info',
		setLogLevel: mockSetLogLevel,
		maxLogBuffer: 5000,
		setMaxLogBuffer: mockSetMaxLogBuffer,
		maxOutputLines: 25,
		setMaxOutputLines: mockSetMaxOutputLines,
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
		// Input settings
		enterToSendAI: true,
		setEnterToSendAI: mockSetEnterToSendAI,
		defaultSaveToHistory: true,
		setDefaultSaveToHistory: mockSetDefaultSaveToHistory,
		defaultShowThinking: 'off',
		setDefaultShowThinking: mockSetDefaultShowThinking,
		userMessageAlignment: 'left',
		setUserMessageAlignment: mockSetUserMessageAlignment,
		// Notification settings
		osNotificationsEnabled: true,
		setOsNotificationsEnabled: mockSetOsNotificationsEnabled,
		audioFeedbackEnabled: false,
		setAudioFeedbackEnabled: mockSetAudioFeedbackEnabled,
		audioFeedbackCommand: 'say',
		setAudioFeedbackCommand: mockSetAudioFeedbackCommand,
		toastDuration: 10,
		setToastDuration: mockSetToastDuration,
		idleNotificationEnabled: false,
		setIdleNotificationEnabled: mockSetIdleNotificationEnabled,
		idleNotificationCommand: 'say Maestro is idle',
		setIdleNotificationCommand: mockSetIdleNotificationCommand,
		// Update settings
		checkForUpdatesOnStartup: true,
		setCheckForUpdatesOnStartup: mockSetCheckForUpdatesOnStartup,
		enableBetaUpdates: false,
		setEnableBetaUpdates: mockSetEnableBetaUpdates,
		crashReportingEnabled: true,
		setCrashReportingEnabled: mockSetCrashReportingEnabled,
		// AI Commands
		customAICommands: [],
		setCustomAICommands: mockSetCustomAICommands,
		// Encore features
		encoreFeatures: { directorNotes: false, usageStats: true, symphony: true },
		setEncoreFeatures: mockSetEncoreFeatures,
		// Conductor profile settings
		conductorProfile: '',
		setConductorProfile: vi.fn(),
		// Global show-Maestro hotkey
		globalShowHotkey: [],
		setGlobalShowHotkey: vi.fn(),
		// Context management settings
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
		updateContextManagementSettings: vi.fn(),
		// Document Graph settings
		documentGraphShowExternalLinks: true,
		setDocumentGraphShowExternalLinks: vi.fn(),
		documentGraphMaxNodes: 100,
		setDocumentGraphMaxNodes: vi.fn(),
		// Stats settings
		statsCollectionEnabled: true,
		setStatsCollectionEnabled: vi.fn(),
		defaultStatsTimeRange: 'week',
		setDefaultStatsTimeRange: vi.fn(),
		// Power management settings
		preventSleepEnabled: false,
		setPreventSleepEnabled: vi.fn(),
		// Rendering settings
		disableGpuAcceleration: false,
		setDisableGpuAcceleration: vi.fn(),
		disableConfetti: false,
		setDisableConfetti: vi.fn(),
		// SSH remote ignore settings
		sshRemoteIgnorePatterns: ['.git', '.*cache*'],
		setSshRemoteIgnorePatterns: vi.fn(),
		sshRemoteHonorGitignore: false,
		setSshRemoteHonorGitignore: vi.fn(),
		// Local file indexing ignore settings
		localIgnorePatterns: ['.git', 'node_modules', '__pycache__'],
		setLocalIgnorePatterns: vi.fn(),
		localHonorGitignore: true,
		setLocalHonorGitignore: vi.fn(),
		// File explorer indexing limits
		fileExplorerMaxDepth: 5,
		setFileExplorerMaxDepth: vi.fn(),
		fileExplorerMaxEntries: 100_000,
		setFileExplorerMaxEntries: vi.fn(),
		sshReduceEntryCapEnabled: false,
		setSshReduceEntryCapEnabled: vi.fn(),
		sshReduceEntryCapFraction: 0.1,
		setSshReduceEntryCapFraction: vi.fn(),
		// Automatic tab naming
		automaticTabNamingEnabled: true,
		setAutomaticTabNamingEnabled: vi.fn(),
		// Director's Notes settings
		directorNotesSettings: {
			provider: 'claude-code',
			defaultLookbackDays: 7,
		},
		setDirectorNotesSettings: mockSetDirectorNotesSettings,
		// WakaTime integration settings
		wakatimeEnabled: false,
		setWakatimeEnabled: vi.fn(),
		wakatimeApiKey: '',
		setWakatimeApiKey: vi.fn(),
		wakatimeDetailedTracking: false,
		setWakatimeDetailedTracking: vi.fn(),
		// Window chrome settings
		useNativeTitleBar: false,
		setUseNativeTitleBar: vi.fn(),
		autoHideMenuBar: false,
		setAutoHideMenuBar: vi.fn(),
		// Symphony registry URLs
		symphonyRegistryUrls: [],
		setSymphonyRegistryUrls: vi.fn(),
		// File Edit & Preview settings
		fileEditWordWrap: true,
		setFileEditWordWrap: vi.fn(),
		fileEditShowLineNumbers: true,
		setFileEditShowLineNumbers: vi.fn(),
		filePreviewToolbarVisibility: {
			save: true,
			wordWrap: true,
			remoteImages: true,
			htmlRender: true,
			previewTier: true,
			editToggle: true,
			editImage: true,
			copyContent: true,
			publishGist: true,
			documentGraph: true,
			openInBrowser: true,
			openInDefault: true,
			copyPath: true,
		},
		setFilePreviewToolbarButtonVisibility: vi.fn(),
		...mockUseSettingsOverrides,
	}),
}));

// Sample theme for testing

const mockLightTheme: Theme = {
	id: 'github-light',
	name: 'GitHub Light',
	mode: 'light',
	colors: {
		bgMain: '#ffffff',
		bgSidebar: '#f6f8fa',
		bgActivity: '#e1e4e8',
		border: '#e1e4e8',
		textMain: '#24292e',
		textDim: '#586069',
		accent: '#0366d6',
		accentDim: '#0366d620',
		accentText: '#0366d6',
		accentForeground: '#ffffff',
		success: '#28a745',
		warning: '#f59e0b',
		error: '#d73a49',
	},
};

const mockVibeTheme: Theme = {
	id: 'pedurple',
	name: 'Pedurple',
	mode: 'vibe',
	colors: {
		bgMain: '#1a1a2e',
		bgSidebar: '#16213e',
		bgActivity: '#0f3460',
		border: '#e94560',
		textMain: '#eaeaea',
		textDim: '#a8a8a8',
		accent: '#e94560',
		accentDim: '#e9456020',
		accentText: '#ff8dc7',
		accentForeground: '#ffffff',
		success: '#50fa7b',
		warning: '#ffb86c',
		error: '#ff5555',
	},
};

const mockThemes: Record<string, Theme> = {
	dracula: mockTheme,
	'github-light': mockLightTheme,
	pedurple: mockVibeTheme,
};

const mockShortcuts: Record<string, Shortcut> = {
	'new-session': { id: 'new-session', label: 'New Session', keys: ['Meta', 'n'] },
	'close-session': { id: 'close-session', label: 'Close Session', keys: ['Meta', 'w'] },
	'toggle-mode': { id: 'toggle-mode', label: 'Toggle Mode', keys: ['Meta', 'j'] },
};

const createDefaultProps = (overrides = {}) => ({
	// Only the 8 actual SettingsModal props (settings are now self-sourced from useSettings)
	isOpen: true,
	onClose: vi.fn(),
	theme: mockTheme,
	themes: mockThemes,
	hasNoAgents: false,
	onThemeImportError: vi.fn(),
	onThemeImportSuccess: vi.fn(),
	...overrides,
});

/**
 * Open a marketplace tile's detail pane by clicking its card. Per-feature
 * config now lives inside the tile detail (a Settings sub-tab), not a separate
 * accordion list. Assumes the Plugins tab is already active.
 */
const openExtensionDetail = (extensionId: string): void => {
	const card = document.querySelector(`[data-extension-id="${extensionId}"]`);
	expect(card).toBeInTheDocument();
	fireEvent.click(card as HTMLElement);
};

/** Select a detail-pane sub-tab (Settings or Permissions). */
const selectSubTab = (which: 'settings' | 'permissions'): void => {
	fireEvent.click(screen.getByTestId(`extension-subtab-${which}`));
};
// useViewportBreakpoint reads window.innerWidth synchronously during render, so
// setting it before render is enough to drive the xs (< 640px) layout branch.
function setViewportWidth(width: number): void {
	Object.defineProperty(window, 'innerWidth', {
		writable: true,
		configurable: true,
		value: width,
	});
}

describe('SettingsModal', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		__resetLastOpenSettingsTabForTests();
		useModalStore.getState().closeAll();
		useSettingsStore.setState({
			encoreFeatures: {
				directorNotes: false,
				usageStats: true,
				symphony: true,
				maestroCue: false,
				pianola: false,
				plugins: false,
			},
		});

		// Reset window.maestro mocks
		vi.mocked(window.maestro.agents.detect).mockResolvedValue([
			{
				id: 'claude-code',
				name: 'Claude Code',
				available: true,
				path: '/usr/local/bin/claude',
				hidden: false,
			},
			{
				id: 'codex',
				name: 'Codex',
				available: true,
				path: '/usr/local/bin/codex',
				hidden: false,
			},
			{ id: 'openai-codex', name: 'OpenAI Codex', available: false, hidden: false },
		] as AgentConfig[]);
		vi.mocked(window.maestro.agents.getConfig).mockResolvedValue({});
		vi.mocked(window.maestro.settings.get).mockResolvedValue(undefined);
		vi.mocked(window.maestro.shells.detect).mockResolvedValue([
			{ id: 'zsh', name: 'Zsh', path: '/bin/zsh', available: true },
			{ id: 'bash', name: 'Bash', path: '/bin/bash', available: true },
		] as ShellInfo[]);

		// Add missing mocks to window.maestro
		(window.maestro as any).fonts = {
			detect: vi.fn().mockResolvedValue(['Menlo', 'Monaco', 'Courier New']),
		};
		(window.maestro as any).agents.getAllCustomPaths = vi.fn().mockResolvedValue({});
		(window.maestro as any).agents.setCustomPath = vi.fn().mockResolvedValue(undefined);
		(window.maestro as any).agents.setConfig = vi.fn().mockResolvedValue(undefined);
		// Generic capability-snapshot stubs so any agentStore call made from
		// Settings stays inert in tests that don't exercise that pipeline.
		(window.maestro as any).agents.getAllSnapshots = vi.fn().mockResolvedValue({});
		(window.maestro as any).agents.getSnapshot = vi.fn().mockResolvedValue(null);
		(window.maestro as any).agents.reprobe = vi.fn().mockResolvedValue(null);
		(window.maestro as any).agents.onSnapshotUpdated = vi.fn().mockReturnValue(() => {});
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
		mockUseSettingsOverrides = {};
	});

	describe('render conditions', () => {
		it('should return null when isOpen is false', () => {
			const { container } = render(<SettingsModal {...createDefaultProps({ isOpen: false })} />);
			expect(container.firstChild).toBeNull();
		});

		it('should render modal when isOpen is true', () => {
			render(<SettingsModal {...createDefaultProps()} />);
			expect(screen.getByRole('dialog')).toBeInTheDocument();
		});

		it('should have correct aria attributes', () => {
			render(<SettingsModal {...createDefaultProps()} />);
			const dialog = screen.getByRole('dialog');
			expect(dialog).toHaveAttribute('aria-modal', 'true');
			expect(dialog).toHaveAttribute('aria-label', 'Settings');
		});
	});

	describe('tab navigation', () => {
		it('should render all tab buttons', async () => {
			render(<SettingsModal {...createDefaultProps()} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			expect(screen.getByTitle('General')).toBeInTheDocument();
			expect(screen.getByTitle('Display')).toBeInTheDocument();
			expect(screen.getByTitle('Shortcuts')).toBeInTheDocument();
			expect(screen.getByTitle('Themes')).toBeInTheDocument();
			expect(screen.getByTitle('Notifications')).toBeInTheDocument();
			expect(screen.getByTitle('AI Commands')).toBeInTheDocument();
			expect(screen.getByTitle('Plugins')).toBeInTheDocument();
		});

		it('should default to general tab', async () => {
			render(<SettingsModal {...createDefaultProps()} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			// General tab content should show the Default Terminal Shell label
			expect(screen.getByText('Default Terminal Shell')).toBeInTheDocument();
		});

		it('should respect initialTab prop', async () => {
			render(<SettingsModal {...createDefaultProps({ initialTab: 'theme' })} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			// Theme tab should show theme mode sections
			expect(screen.getByText('dark Mode')).toBeInTheDocument();
		});

		it('should switch to shortcuts tab when clicked', async () => {
			render(<SettingsModal {...createDefaultProps()} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			fireEvent.click(screen.getByTitle('Shortcuts'));

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(screen.getByPlaceholderText('Filter shortcuts...')).toBeInTheDocument();
		});

		it('should switch to notifications tab when clicked', async () => {
			render(<SettingsModal {...createDefaultProps()} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			fireEvent.click(screen.getByTitle('Notifications'));

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(screen.getByText('Operating System Notifications')).toBeInTheDocument();
		});

		it('should switch to AI Commands tab when clicked', async () => {
			render(<SettingsModal {...createDefaultProps()} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			fireEvent.click(screen.getByTitle('AI Commands'));

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(screen.getByTestId('ai-commands-panel')).toBeInTheDocument();
		});

		it('should reopen on the last tab the user viewed (in-session)', async () => {
			// Open, switch to Shortcuts, close.
			const { unmount } = render(<SettingsModal {...createDefaultProps()} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			fireEvent.click(screen.getByTitle('Shortcuts'));

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(screen.getByPlaceholderText('Filter shortcuts...')).toBeInTheDocument();

			unmount();

			// Reopen with no explicit initialTab - should land on Shortcuts, not General.
			render(<SettingsModal {...createDefaultProps()} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(screen.getByPlaceholderText('Filter shortcuts...')).toBeInTheDocument();
		});

		it('should remember and restore per-tab vertical scroll position', async () => {
			const { container } = render(<SettingsModal {...createDefaultProps()} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			// The scrollable content panel is the one combining .p-6 + .overflow-y-auto
			// (the sidebar nav uses overflow-y-auto but has no p-6).
			const getContent = () => container.querySelector<HTMLDivElement>('.p-6.overflow-y-auto');
			expect(getContent()).toBeTruthy();

			// Scroll General down - simulates the user being deep in a long panel.
			const general = getContent()!;
			general.scrollTop = 420;
			fireEvent.scroll(general);

			// Switch to Shortcuts - never visited, should land at the top.
			fireEvent.click(screen.getByTitle('Shortcuts'));
			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});
			expect(getContent()!.scrollTop).toBe(0);

			// Scroll Shortcuts to a different position.
			const shortcuts = getContent()!;
			shortcuts.scrollTop = 180;
			fireEvent.scroll(shortcuts);

			// Back to General - restores 420.
			fireEvent.click(screen.getByTitle('General'));
			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});
			expect(getContent()!.scrollTop).toBe(420);

			// Back to Shortcuts - restores 180.
			fireEvent.click(screen.getByTitle('Shortcuts'));
			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});
			expect(getContent()!.scrollTop).toBe(180);
		});

		it('should restore the saved scroll position when the modal is reopened', async () => {
			const first = render(<SettingsModal {...createDefaultProps()} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			fireEvent.click(screen.getByTitle('Display'));
			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			const getContent = (root: HTMLElement) =>
				root.querySelector<HTMLDivElement>('.p-6.overflow-y-auto');
			const display = getContent(first.container)!;
			display.scrollTop = 300;
			fireEvent.scroll(display);

			first.unmount();

			// Reopen - last tab AND last scroll position should be restored together.
			const second = render(<SettingsModal {...createDefaultProps()} />);
			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			expect(getContent(second.container)?.scrollTop).toBe(300);
		});
	});

	describe('keyboard tab navigation', () => {
		// Sidebar is alphabetized by label, so the order under no LLM flag is:
		// About, AI Commands, Display, Environment, General, Maestro Prompts,
		// Notifications, Plugins, Shortcuts, SSH Hosts, Themes.
		it('should navigate to next tab with Cmd+Shift+] from default (general)', async () => {
			render(<SettingsModal {...createDefaultProps({ initialTab: 'general' })} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			// Start on general tab
			expect(screen.getByText('Default Terminal Shell')).toBeInTheDocument();

			// Press Cmd+Shift+] - alphabetically the next tab after General is Maestro Prompts
			fireEvent.keyDown(window, { key: ']', metaKey: true, shiftKey: true });

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			// Maestro Prompts tab should now be the active sidebar entry
			expect(screen.getByTitle('Maestro Prompts')).toHaveClass('font-bold');
		});

		it('should navigate to previous tab with Cmd+Shift+[ from shortcuts', async () => {
			render(<SettingsModal {...createDefaultProps({ initialTab: 'shortcuts' })} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			// Start on shortcuts tab
			expect(screen.getByPlaceholderText('Filter shortcuts...')).toBeInTheDocument();

			// Press Cmd+Shift+[ - alphabetically the prev tab before Shortcuts is Plugins
			fireEvent.keyDown(window, { key: '[', metaKey: true, shiftKey: true });

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(screen.getByTitle('Plugins')).toHaveClass('font-bold');
		});

		it('should wrap around when navigating past last tab (Themes)', async () => {
			render(<SettingsModal {...createDefaultProps({ initialTab: 'theme' })} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			// Themes is the last tab alphabetically
			expect(screen.getByText('dark Mode')).toBeInTheDocument();

			// Press Cmd+Shift+] to wrap to About (first tab alphabetically)
			fireEvent.keyDown(window, { key: ']', metaKey: true, shiftKey: true });

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(screen.getByTitle('About')).toHaveClass('font-bold');
		});

		it('should wrap around when navigating before first tab (About)', async () => {
			render(<SettingsModal {...createDefaultProps({ initialTab: 'about' })} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			// About is the first tab alphabetically
			expect(screen.getByTitle('About')).toHaveClass('font-bold');

			// Press Cmd+Shift+[ to wrap to Themes (last tab alphabetically)
			fireEvent.keyDown(window, { key: '[', metaKey: true, shiftKey: true });

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(screen.getByText('dark Mode')).toBeInTheDocument();
		});
	});

	describe('close button', () => {
		it('should call onClose when close button is clicked', async () => {
			const onClose = vi.fn();
			render(<SettingsModal {...createDefaultProps({ onClose })} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			// Find the X close button in the header
			const closeButtons = screen.getAllByRole('button');
			const closeButton = closeButtons.find((btn) => btn.querySelector('svg.w-5.h-5'));
			expect(closeButton).toBeDefined();

			fireEvent.click(closeButton!);
			expect(onClose).toHaveBeenCalled();
		});
	});

	describe('Display tab - Font settings', () => {
		it('should show font loading message initially', async () => {
			render(<SettingsModal {...createDefaultProps({ initialTab: 'display' })} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			// Font selector should exist
			expect(screen.getByText('Interface Font')).toBeInTheDocument();
		});

		it('should call setFontFamily when font is changed', async () => {
			const setFontFamily = vi.fn();
			render(<SettingsModal {...createDefaultProps({ setFontFamily, initialTab: 'display' })} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			// Find the font select (first combobox) and trigger change
			const comboboxes = screen.getAllByRole('combobox');
			const fontSelect = comboboxes[0] as HTMLSelectElement;
			fireEvent.change(fontSelect, { target: { value: 'Monaco' } });

			expect(mockSetFontFamily).toHaveBeenCalledWith('Monaco');
		});

		it('should load fonts when font select is focused', async () => {
			render(<SettingsModal {...createDefaultProps({ initialTab: 'display' })} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			// Get the font select (first combobox)
			const comboboxes = screen.getAllByRole('combobox');
			const fontSelect = comboboxes[0];
			fireEvent.focus(fontSelect);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect((window.maestro as any).fonts.detect).toHaveBeenCalled();
		});
	});

	describe('Display tab - Font size buttons', () => {
		it('should call setFontSize with 12 when Small is clicked', async () => {
			const setFontSize = vi.fn();
			render(<SettingsModal {...createDefaultProps({ setFontSize, initialTab: 'display' })} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			// Scope to the font-size section - the toast-width setting also renders
			// Small/Medium/Large buttons, so an unscoped query is ambiguous.
			const fontSizeSection = within(
				document.querySelector('[data-setting-id="display-font-size"]') as HTMLElement
			);
			fireEvent.click(fontSizeSection.getByRole('button', { name: 'Small' }));
			expect(mockSetFontSize).toHaveBeenCalledWith(12);
		});

		it('should call setFontSize with 14 when Medium is clicked', async () => {
			const setFontSize = vi.fn();
			render(<SettingsModal {...createDefaultProps({ setFontSize, initialTab: 'display' })} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			const fontSizeSection = within(
				document.querySelector('[data-setting-id="display-font-size"]') as HTMLElement
			);
			fireEvent.click(fontSizeSection.getByRole('button', { name: 'Medium' }));
			expect(mockSetFontSize).toHaveBeenCalledWith(14);
		});

		it('should call setFontSize with 16 when Large is clicked', async () => {
			const setFontSize = vi.fn();
			render(<SettingsModal {...createDefaultProps({ setFontSize, initialTab: 'display' })} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			const fontSizeSection = within(
				document.querySelector('[data-setting-id="display-font-size"]') as HTMLElement
			);
			fireEvent.click(fontSizeSection.getByRole('button', { name: 'Large' }));
			expect(mockSetFontSize).toHaveBeenCalledWith(16);
		});

		it('should call setFontSize with 18 when X-Large is clicked', async () => {
			const setFontSize = vi.fn();
			render(<SettingsModal {...createDefaultProps({ setFontSize, initialTab: 'display' })} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			fireEvent.click(screen.getByRole('button', { name: 'X-Large' }));
			expect(mockSetFontSize).toHaveBeenCalledWith(18);
		});

		it('should highlight selected font size', async () => {
			render(<SettingsModal {...createDefaultProps({ fontSize: 14, initialTab: 'display' })} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			const fontSizeSection = within(
				document.querySelector('[data-setting-id="display-font-size"]') as HTMLElement
			);
			const mediumButton = fontSizeSection.getByText('Medium');
			expect(mediumButton).toHaveClass('ring-2');
		});
	});

	describe('General tab - Log level buttons', () => {
		it('should call setLogLevel with debug', async () => {
			const setLogLevel = vi.fn();
			render(<SettingsModal {...createDefaultProps({ setLogLevel, initialTab: 'general' })} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			fireEvent.click(screen.getByRole('button', { name: 'Debug' }));
			expect(mockSetLogLevel).toHaveBeenCalledWith('debug');
		});

		it('should call setLogLevel with info', async () => {
			const setLogLevel = vi.fn();
			render(<SettingsModal {...createDefaultProps({ setLogLevel, initialTab: 'general' })} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			fireEvent.click(screen.getByRole('button', { name: 'Info' }));
			expect(mockSetLogLevel).toHaveBeenCalledWith('info');
		});

		it('should call setLogLevel with warn', async () => {
			const setLogLevel = vi.fn();
			render(<SettingsModal {...createDefaultProps({ setLogLevel, initialTab: 'general' })} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			fireEvent.click(screen.getByRole('button', { name: 'Warn' }));
			expect(mockSetLogLevel).toHaveBeenCalledWith('warn');
		});

		it('should call setLogLevel with error', async () => {
			const setLogLevel = vi.fn();
			render(<SettingsModal {...createDefaultProps({ setLogLevel, initialTab: 'general' })} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			fireEvent.click(screen.getByRole('button', { name: 'Error' }));
			expect(mockSetLogLevel).toHaveBeenCalledWith('error');
		});
	});

	describe('Display tab - Max log buffer buttons', () => {
		it('should call setMaxLogBuffer with various values', async () => {
			const setMaxLogBuffer = vi.fn();
			render(<SettingsModal {...createDefaultProps({ setMaxLogBuffer, initialTab: 'display' })} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			fireEvent.click(screen.getByRole('button', { name: '1.0K' }));
			expect(mockSetMaxLogBuffer).toHaveBeenCalledWith(1000);

			fireEvent.click(screen.getByRole('button', { name: '5.0K' }));
			expect(mockSetMaxLogBuffer).toHaveBeenCalledWith(5000);

			fireEvent.click(screen.getByRole('button', { name: '10.0K' }));
			expect(mockSetMaxLogBuffer).toHaveBeenCalledWith(10000);

			fireEvent.click(screen.getByRole('button', { name: '25.0K' }));
			expect(mockSetMaxLogBuffer).toHaveBeenCalledWith(25000);
		});
	});

	describe('Display tab - Max output lines buttons', () => {
		it('should call setMaxOutputLines with various values', async () => {
			const setMaxOutputLines = vi.fn();
			render(
				<SettingsModal {...createDefaultProps({ setMaxOutputLines, initialTab: 'display' })} />
			);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			fireEvent.click(screen.getByRole('button', { name: '15' }));
			expect(mockSetMaxOutputLines).toHaveBeenCalledWith(15);

			fireEvent.click(screen.getByRole('button', { name: '25' }));
			expect(mockSetMaxOutputLines).toHaveBeenCalledWith(25);

			fireEvent.click(screen.getByRole('button', { name: '50' }));
			expect(mockSetMaxOutputLines).toHaveBeenCalledWith(50);

			fireEvent.click(screen.getByRole('button', { name: 'All' }));
			expect(mockSetMaxOutputLines).toHaveBeenCalledWith(Infinity);
		});
	});

	describe('General tab - Shell selection', () => {
		it('should show shell detection button when shells not loaded', async () => {
			render(<SettingsModal {...createDefaultProps()} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(screen.getByText('Detect other available shells...')).toBeInTheDocument();
		});

		it('should load shells on interaction', async () => {
			render(<SettingsModal {...createDefaultProps()} />);

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

		it('should call setDefaultShell when shell is selected', async () => {
			const setDefaultShell = vi.fn();
			render(<SettingsModal {...createDefaultProps({ setDefaultShell })} />);

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
	});

	describe('General tab - Input behavior toggles', () => {
		it('should call setEnterToSendAI when toggled', async () => {
			const setEnterToSendAI = vi.fn();
			render(<SettingsModal {...createDefaultProps({ setEnterToSendAI, enterToSendAI: true })} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			// Find the AI Interaction Mode section and click its toggle button
			const aiModeLabel = screen.getByText('AI Interaction Mode');
			const aiModeSection = aiModeLabel.closest('.p-3');
			const toggleButton = aiModeSection?.querySelector('button');
			fireEvent.click(toggleButton!);

			expect(mockSetEnterToSendAI).toHaveBeenCalledWith(false);
		});

		it('should display Cmd+Enter (or Ctrl+Enter on non-Mac) when enter-to-send is false', async () => {
			mockUseSettingsOverrides = { enterToSendAI: false };
			render(<SettingsModal {...createDefaultProps()} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			// Both the AI Interaction Mode and Expanded AI Interaction Mode buttons can render
			// this label depending on their respective settings; assert that at least one is shown.
			expect(screen.getAllByText(formatEnterToSend(false)).length).toBeGreaterThan(0);
		});
	});

	describe('General tab - History toggle', () => {
		it('should call setDefaultSaveToHistory when toggle switch is changed', async () => {
			const setDefaultSaveToHistory = vi.fn();
			render(
				<SettingsModal
					{...createDefaultProps({ setDefaultSaveToHistory, defaultSaveToHistory: true })}
				/>
			);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			// SettingCheckbox uses a button with role="switch" instead of input[type="checkbox"]
			const titleElement = screen.getByText('Enable "History" by default for new tabs');
			const toggleContainer = titleElement.closest('[role="button"]');
			const toggleSwitch = toggleContainer?.querySelector('button[role="switch"]');
			expect(toggleSwitch).toBeDefined();

			fireEvent.click(toggleSwitch!);
			expect(mockSetDefaultSaveToHistory).toHaveBeenCalledWith(false);
		});
	});

	describe('General tab - GitHub CLI path', () => {
		it('should call setGhPath when path is changed', async () => {
			const setGhPath = vi.fn();
			render(<SettingsModal {...createDefaultProps({ setGhPath })} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			const ghPathInput = screen.getByPlaceholderText('/opt/homebrew/bin/gh');
			fireEvent.change(ghPathInput, { target: { value: '/usr/local/bin/gh' } });

			expect(mockSetGhPath).toHaveBeenCalledWith('/usr/local/bin/gh');
		});

		it('should show clear button when ghPath has value', async () => {
			mockUseSettingsOverrides = { ghPath: '/usr/local/bin/gh' };
			render(<SettingsModal {...createDefaultProps()} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(screen.getAllByText('Clear').length).toBeGreaterThan(0);
		});

		it('should call setGhPath with empty string when clear is clicked', async () => {
			mockUseSettingsOverrides = { ghPath: '/usr/local/bin/gh' };
			render(<SettingsModal {...createDefaultProps()} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			// Find the Clear button near the gh path input by locating the gh input first
			const ghInput = screen.getByDisplayValue('/usr/local/bin/gh');
			// The clear button should be a sibling of the input in the same container
			const parentContainer = ghInput.closest('div');
			const clearButton = parentContainer?.querySelector('button');
			expect(clearButton).toBeDefined();
			fireEvent.click(clearButton!);

			expect(mockSetGhPath).toHaveBeenCalledWith('');
		});
	});

	describe('Shortcuts tab', () => {
		it('should display shortcuts list', async () => {
			render(<SettingsModal {...createDefaultProps({ initialTab: 'shortcuts' })} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(screen.getByText('New Session')).toBeInTheDocument();
			expect(screen.getByText('Close Session')).toBeInTheDocument();
			expect(screen.getByText('Toggle Mode')).toBeInTheDocument();
		});

		it('should filter shortcuts by label', async () => {
			render(<SettingsModal {...createDefaultProps({ initialTab: 'shortcuts' })} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			const filterInput = screen.getByPlaceholderText('Filter shortcuts...');
			fireEvent.change(filterInput, { target: { value: 'New' } });

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			expect(screen.getByText('New Session')).toBeInTheDocument();
			expect(screen.queryByText('Close Session')).not.toBeInTheDocument();
		});

		it('should show shortcut count', async () => {
			render(<SettingsModal {...createDefaultProps({ initialTab: 'shortcuts' })} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(screen.getByText('3')).toBeInTheDocument();
		});

		it('should show filtered count when filtering', async () => {
			render(<SettingsModal {...createDefaultProps({ initialTab: 'shortcuts' })} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			const filterInput = screen.getByPlaceholderText('Filter shortcuts...');
			fireEvent.change(filterInput, { target: { value: 'Session' } });

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			expect(screen.getByText('2 / 3')).toBeInTheDocument();
		});

		it('should enter recording mode when shortcut button is clicked', async () => {
			render(<SettingsModal {...createDefaultProps({ initialTab: 'shortcuts' })} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			const shortcutButton = screen.getByText('Meta+n');
			fireEvent.click(shortcutButton);

			expect(screen.getByText('Press keys...')).toBeInTheDocument();
		});

		it('should record new shortcut on keydown', async () => {
			const setShortcuts = vi.fn();
			render(<SettingsModal {...createDefaultProps({ initialTab: 'shortcuts', setShortcuts })} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			// Click to enter recording mode
			const shortcutButton = screen.getByText('Meta+n');
			fireEvent.click(shortcutButton);

			// Press new key combination
			fireEvent.keyDown(shortcutButton, {
				key: 'k',
				metaKey: true,
				preventDefault: vi.fn(),
				stopPropagation: vi.fn(),
			});

			expect(mockSetShortcuts).toHaveBeenCalledWith({
				...mockShortcuts,
				'new-session': { ...mockShortcuts['new-session'], keys: ['Meta', 'k'] },
			});
		});

		it('should cancel recording on Escape', async () => {
			const setShortcuts = vi.fn();
			render(<SettingsModal {...createDefaultProps({ initialTab: 'shortcuts', setShortcuts })} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			// Click to enter recording mode
			const shortcutButton = screen.getByText('Meta+n');
			fireEvent.click(shortcutButton);

			expect(screen.getByText('Press keys...')).toBeInTheDocument();

			// Press Escape
			fireEvent.keyDown(shortcutButton, {
				key: 'Escape',
				preventDefault: vi.fn(),
				stopPropagation: vi.fn(),
			});

			// Should exit recording mode without calling setShortcuts
			expect(mockSetShortcuts).not.toHaveBeenCalled();
			expect(screen.getByText('Meta+n')).toBeInTheDocument();
		});
	});

	describe('Theme tab', () => {
		it('should display theme mode sections', async () => {
			render(<SettingsModal {...createDefaultProps({ initialTab: 'theme' })} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(screen.getByText('dark Mode')).toBeInTheDocument();
			expect(screen.getByText('light Mode')).toBeInTheDocument();
			expect(screen.getByText('vibe Mode')).toBeInTheDocument();
		});

		it('should display theme buttons', async () => {
			render(<SettingsModal {...createDefaultProps({ initialTab: 'theme' })} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(screen.getByText('Dracula')).toBeInTheDocument();
			expect(screen.getByText('GitHub Light')).toBeInTheDocument();
			expect(screen.getByText('Pedurple')).toBeInTheDocument();
		});

		it('should call setActiveThemeId when theme is selected', async () => {
			const setActiveThemeId = vi.fn();
			render(<SettingsModal {...createDefaultProps({ initialTab: 'theme', setActiveThemeId })} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			fireEvent.click(screen.getByRole('button', { name: 'GitHub Light' }));
			expect(mockSetActiveThemeId).toHaveBeenCalledWith('github-light');
		});

		it('should highlight active theme', async () => {
			render(
				<SettingsModal {...createDefaultProps({ initialTab: 'theme', activeThemeId: 'dracula' })} />
			);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			const draculaButton = screen.getByText('Dracula').closest('button');
			expect(draculaButton).toHaveClass('ring-2');
		});

		it('should navigate themes with Tab key', async () => {
			const setActiveThemeId = vi.fn();
			render(
				<SettingsModal
					{...createDefaultProps({
						initialTab: 'theme',
						setActiveThemeId,
						activeThemeId: 'dracula',
					})}
				/>
			);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			// Find the theme picker container (the div with tabIndex=0 and onKeyDown handler)
			const themePickerContainer = screen.getByText('dark Mode').closest('.space-y-6');

			// Fire Tab keydown on the theme picker container
			fireEvent.keyDown(themePickerContainer!, { key: 'Tab' });

			// Should move to next theme (github-light in this case, or next in the list)
			expect(mockSetActiveThemeId).toHaveBeenCalled();
		});
	});

	describe('Notifications tab', () => {
		it('should display OS notifications setting', async () => {
			render(<SettingsModal {...createDefaultProps({ initialTab: 'notifications' })} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(screen.getByText('Enable OS Notifications')).toBeInTheDocument();
		});

		it('should call setOsNotificationsEnabled when toggle switch is changed', async () => {
			const setOsNotificationsEnabled = vi.fn();
			render(
				<SettingsModal
					{...createDefaultProps({
						initialTab: 'notifications',
						setOsNotificationsEnabled,
						osNotificationsEnabled: true,
					})}
				/>
			);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			// SettingCheckbox uses a button with role="switch" instead of input[type="checkbox"]
			const titleElement = screen.getByText('Enable OS Notifications');
			const toggleContainer = titleElement.closest('[role="button"]');
			const toggleSwitch = toggleContainer?.querySelector('button[role="switch"]');
			fireEvent.click(toggleSwitch!);

			expect(mockSetOsNotificationsEnabled).toHaveBeenCalledWith(false);
		});

		it('should update toggle state when useSettings changes (regression test for memo bug)', async () => {
			// This test ensures the component re-renders when useSettings values change
			mockUseSettingsOverrides = { osNotificationsEnabled: true };
			const { rerender } = render(
				<SettingsModal {...createDefaultProps({ initialTab: 'notifications' })} />
			);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			// SettingCheckbox uses a button with role="switch" and aria-checked instead of input[type="checkbox"]
			const titleElement = screen.getByText('Enable OS Notifications');
			const toggleContainer = titleElement.closest('[role="button"]');
			const toggleSwitch = toggleContainer?.querySelector(
				'button[role="switch"]'
			) as HTMLButtonElement;
			expect(toggleSwitch.getAttribute('aria-checked')).toBe('true');

			// Update the useSettings override to simulate a change
			mockUseSettingsOverrides = { osNotificationsEnabled: false };
			rerender(<SettingsModal {...createDefaultProps({ initialTab: 'notifications' })} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			// The toggle should now be unchecked - this would fail with the old memo comparator
			expect(toggleSwitch.getAttribute('aria-checked')).toBe('false');
		});

		it('should test notification when button is clicked', async () => {
			render(<SettingsModal {...createDefaultProps({ initialTab: 'notifications' })} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			fireEvent.click(screen.getByRole('button', { name: 'Test Notification' }));
			// The Test button routes through showOsNotification(), which on the
			// Electron desktop path forwards to the notification bridge with the
			// (title, body, sessionId, tabId) signature.
			expect(window.maestro.notification.show).toHaveBeenCalledWith(
				'Maestro',
				'Test notification - notifications are working!',
				undefined,
				undefined
			);
		});

		it('should display custom notification setting', async () => {
			render(<SettingsModal {...createDefaultProps({ initialTab: 'notifications' })} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(screen.getByText('Enable Custom Notification')).toBeInTheDocument();
		});

		it('should call setAudioFeedbackEnabled when toggle switch is changed', async () => {
			const setAudioFeedbackEnabled = vi.fn();
			render(
				<SettingsModal
					{...createDefaultProps({
						initialTab: 'notifications',
						setAudioFeedbackEnabled,
						audioFeedbackEnabled: false,
					})}
				/>
			);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			// SettingCheckbox uses a button with role="switch" instead of input[type="checkbox"]
			const titleElement = screen.getByText('Enable Custom Notification');
			const toggleContainer = titleElement.closest('[role="button"]');
			const toggleSwitch = toggleContainer?.querySelector('button[role="switch"]');
			fireEvent.click(toggleSwitch!);

			expect(mockSetAudioFeedbackEnabled).toHaveBeenCalledWith(true);
		});

		it('should call setAudioFeedbackCommand when Command Chain is changed', async () => {
			const setAudioFeedbackCommand = vi.fn();
			render(
				<SettingsModal
					{...createDefaultProps({ initialTab: 'notifications', setAudioFeedbackCommand })}
				/>
			);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			const ttsInput = screen.getByPlaceholderText('say');
			fireEvent.change(ttsInput, { target: { value: 'espeak' } });

			expect(mockSetAudioFeedbackCommand).toHaveBeenCalledWith('espeak');
		});

		it('should test Command Chain when test button is clicked', async () => {
			render(<SettingsModal {...createDefaultProps({ initialTab: 'notifications' })} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			const customSection = document.querySelector('[data-setting-id="notifications-custom"]')!;
			fireEvent.click(within(customSection as HTMLElement).getByRole('button', { name: 'Test' }));

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			expect(window.maestro.notification.speak).toHaveBeenCalled();
		});

		it('should display toast duration setting', async () => {
			render(<SettingsModal {...createDefaultProps({ initialTab: 'notifications' })} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(screen.getByText('Toast Notification Duration')).toBeInTheDocument();
		});

		it('should call setToastDuration when duration is selected', async () => {
			const setToastDuration = vi.fn();
			render(
				<SettingsModal {...createDefaultProps({ initialTab: 'notifications', setToastDuration })} />
			);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			fireEvent.click(screen.getByRole('button', { name: 'Off' }));
			expect(mockSetToastDuration).toHaveBeenCalledWith(-1);

			fireEvent.click(screen.getByRole('button', { name: '5s' }));
			expect(mockSetToastDuration).toHaveBeenCalledWith(5);

			fireEvent.click(screen.getByRole('button', { name: '10s' }));
			expect(mockSetToastDuration).toHaveBeenCalledWith(10);

			fireEvent.click(screen.getByRole('button', { name: '20s' }));
			expect(mockSetToastDuration).toHaveBeenCalledWith(20);

			fireEvent.click(screen.getByRole('button', { name: '30s' }));
			expect(mockSetToastDuration).toHaveBeenCalledWith(30);

			fireEvent.click(screen.getByRole('button', { name: 'Never' }));
			expect(mockSetToastDuration).toHaveBeenCalledWith(0);
		});
	});

	describe('AI Commands tab', () => {
		it('should render AICommandsPanel component', async () => {
			render(<SettingsModal {...createDefaultProps({ initialTab: 'aicommands' })} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(screen.getByTestId('ai-commands-panel')).toBeInTheDocument();
		});
	});

	describe('custom fonts', () => {
		it('should add custom font when input is submitted', async () => {
			render(<SettingsModal {...createDefaultProps({ initialTab: 'display' })} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			const customFontInput = screen.getAllByPlaceholderText('Add custom font name...')[0];
			fireEvent.change(customFontInput, { target: { value: 'My Custom Font' } });
			// Scope to the font input's parent container to avoid ambiguous "Add" button matches
			const fontContainer = customFontInput.closest('div')!.parentElement!;
			fireEvent.click(within(fontContainer).getByRole('button', { name: 'Add' }));

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			expect(window.maestro.settings.set).toHaveBeenCalledWith('customFonts', ['My Custom Font']);
		});

		it('should add custom font on Enter key', async () => {
			render(<SettingsModal {...createDefaultProps({ initialTab: 'display' })} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			const customFontInput = screen.getAllByPlaceholderText('Add custom font name...')[0];
			fireEvent.change(customFontInput, { target: { value: 'My Custom Font' } });
			fireEvent.keyDown(customFontInput, { key: 'Enter' });

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			expect(window.maestro.settings.set).toHaveBeenCalledWith('customFonts', ['My Custom Font']);
		});

		it('should not add empty custom font', async () => {
			render(<SettingsModal {...createDefaultProps({ initialTab: 'display' })} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			const customFontInput = screen.getAllByPlaceholderText('Add custom font name...')[0];
			fireEvent.change(customFontInput, { target: { value: '   ' } });
			// Scope to the font input's parent container to avoid ambiguous "Add" button matches
			const fontContainer = customFontInput.closest('div')!.parentElement!;
			fireEvent.click(within(fontContainer).getByRole('button', { name: 'Add' }));

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			expect(window.maestro.settings.set).not.toHaveBeenCalledWith(
				'customFonts',
				expect.anything()
			);
		});
	});

	describe('edge cases', () => {
		it('should handle font detection failure gracefully', async () => {
			(window.maestro as any).fonts.detect.mockRejectedValue(new Error('Font detection failed'));

			const consoleSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});

			render(<SettingsModal {...createDefaultProps({ initialTab: 'display' })} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			// Get the font select (first combobox)
			const comboboxes = screen.getAllByRole('combobox');
			const fontSelect = comboboxes[0];
			fireEvent.focus(fontSelect);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(consoleSpy).toHaveBeenCalled();
			consoleSpy.mockRestore();
		});

		it('should handle shell detection failure gracefully', async () => {
			vi.mocked(window.maestro.shells.detect).mockRejectedValue(
				new Error('Shell detection failed')
			);

			const consoleSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});

			render(<SettingsModal {...createDefaultProps()} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			const detectButton = screen.getByText('Detect other available shells...');
			fireEvent.click(detectButton);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(consoleSpy).toHaveBeenCalled();
			consoleSpy.mockRestore();
		});

		it('should handle XSS characters in settings', async () => {
			const customShortcuts: Record<string, Shortcut> = {
				'xss-test': { id: 'xss-test', label: '<script>alert("xss")</script>', keys: ['Meta', 'x'] },
			};

			mockUseSettingsOverrides = { shortcuts: customShortcuts };
			render(<SettingsModal {...createDefaultProps({ initialTab: 'shortcuts' })} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			// Should render as text, not execute
			expect(screen.getByText('<script>alert("xss")</script>')).toBeInTheDocument();
		});

		it('should handle unicode in labels', async () => {
			const customShortcuts: Record<string, Shortcut> = {
				'unicode-test': { id: 'unicode-test', label: 'Hello 🌍 World', keys: ['Meta', 'u'] },
			};

			mockUseSettingsOverrides = { shortcuts: customShortcuts };
			render(<SettingsModal {...createDefaultProps({ initialTab: 'shortcuts' })} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(screen.getByText(/Hello.*World/)).toBeInTheDocument();
		});
	});

	describe('layer stack integration', () => {
		it('should register layer when modal opens', async () => {
			const { useLayerStack } = await import('../../../renderer/contexts/LayerStackContext');
			const mockRegisterLayer = vi.fn(() => 'layer-123');
			vi.mocked(useLayerStack).mockReturnValue({
				registerLayer: mockRegisterLayer,
				unregisterLayer: vi.fn(),
				updateLayerHandler: vi.fn(),
				getTopLayer: vi.fn(),
				closeTopLayer: vi.fn(),
				getLayers: vi.fn(),
				hasOpenLayers: vi.fn(),
				hasOpenModal: vi.fn(),
				layerCount: 0,
			});

			render(<SettingsModal {...createDefaultProps()} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			expect(mockRegisterLayer).toHaveBeenCalledWith(
				expect.objectContaining({
					type: 'modal',
					ariaLabel: 'Settings',
				})
			);
		});

		it('should unregister layer when modal closes', async () => {
			const { useLayerStack } = await import('../../../renderer/contexts/LayerStackContext');
			const mockUnregisterLayer = vi.fn();
			vi.mocked(useLayerStack).mockReturnValue({
				registerLayer: vi.fn(() => 'layer-123'),
				unregisterLayer: mockUnregisterLayer,
				updateLayerHandler: vi.fn(),
				getTopLayer: vi.fn(),
				closeTopLayer: vi.fn(),
				getLayers: vi.fn(),
				hasOpenLayers: vi.fn(),
				hasOpenModal: vi.fn(),
				layerCount: 0,
			});

			const { rerender } = render(<SettingsModal {...createDefaultProps()} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			rerender(<SettingsModal {...createDefaultProps({ isOpen: false })} />);

			expect(mockUnregisterLayer).toHaveBeenCalledWith('layer-123');
		});
	});

	describe('recording state and escape handling', () => {
		it('should not close modal when Escape is pressed during shortcut recording', async () => {
			const onClose = vi.fn();
			const { useLayerStack } = await import('../../../renderer/contexts/LayerStackContext');

			let capturedEscapeHandler: (() => void) | undefined;
			vi.mocked(useLayerStack).mockReturnValue({
				registerLayer: vi.fn((config) => {
					capturedEscapeHandler = config.onEscape;
					return 'layer-123';
				}),
				unregisterLayer: vi.fn(),
				updateLayerHandler: vi.fn(),
				getTopLayer: vi.fn(),
				closeTopLayer: vi.fn(),
				getLayers: vi.fn(),
				hasOpenLayers: vi.fn(),
				hasOpenModal: vi.fn(),
				layerCount: 0,
			});

			render(<SettingsModal {...createDefaultProps({ initialTab: 'shortcuts', onClose })} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			// Enter recording mode (this triggers onRecordingChange(true) on the shell's ref)
			const shortcutButton = screen.getByText('Meta+n');
			fireEvent.click(shortcutButton);

			expect(screen.getByText('Press keys...')).toBeInTheDocument();

			// Call the escape handler (simulating layer stack escape)
			// ShortcutsTab handles its own escape via onKeyDownCapture, so
			// the shell just ignores the escape when recording is active
			capturedEscapeHandler?.();

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			// Modal should still be open - onClose should NOT have been called
			expect(onClose).not.toHaveBeenCalled();
		});
	});

	describe('Custom notification Stop button', () => {
		it('should show Stop button when Command Chain is running and handle click', async () => {
			// Mock speak to return a notificationId
			vi.mocked(window.maestro.notification.speak).mockResolvedValue({
				success: true,
				notificationId: 123,
			});
			vi.mocked(window.maestro.notification.stopSpeak).mockResolvedValue({ success: true });

			render(<SettingsModal {...createDefaultProps({ initialTab: 'notifications' })} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			// Click Test button to start Command Chain
			const customSection = document.querySelector('[data-setting-id="notifications-custom"]')!;
			fireEvent.click(within(customSection as HTMLElement).getByRole('button', { name: 'Test' }));

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			// Stop button should now be visible
			expect(screen.getByText('Stop')).toBeInTheDocument();

			// Click Stop button
			fireEvent.click(screen.getByRole('button', { name: 'Stop' }));

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(window.maestro.notification.stopSpeak).toHaveBeenCalledWith(123);
		});

		it('should handle stopSpeak error gracefully', async () => {
			vi.mocked(window.maestro.notification.speak).mockResolvedValue({
				success: true,
				notificationId: 456,
			});
			vi.mocked(window.maestro.notification.stopSpeak).mockRejectedValue(new Error('Stop failed'));

			const consoleSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});

			render(<SettingsModal {...createDefaultProps({ initialTab: 'notifications' })} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			// Click Test button to start Command Chain
			const customSection = document.querySelector('[data-setting-id="notifications-custom"]')!;
			fireEvent.click(within(customSection as HTMLElement).getByRole('button', { name: 'Test' }));

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			// Click Stop button
			fireEvent.click(screen.getByRole('button', { name: 'Stop' }));

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(consoleSpy).toHaveBeenCalled();
			consoleSpy.mockRestore();
		});

		it('should handle speak error gracefully', async () => {
			vi.mocked(window.maestro.notification.speak).mockRejectedValue(new Error('Speak failed'));

			const consoleSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});

			render(<SettingsModal {...createDefaultProps({ initialTab: 'notifications' })} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			// Click Test button to trigger speak error
			const customSection = document.querySelector('[data-setting-id="notifications-custom"]')!;
			fireEvent.click(within(customSection as HTMLElement).getByRole('button', { name: 'Test' }));

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(consoleSpy).toHaveBeenCalled();
			consoleSpy.mockRestore();
		});

		it('should return to Test button when command completes', async () => {
			// Set up a mock that captures the onCommandCompleted callback
			let capturedCallback: ((notificationId: number) => void) | null = null;
			vi.mocked(window.maestro.notification.onCommandCompleted).mockImplementation((callback) => {
				capturedCallback = callback;
				return () => {
					capturedCallback = null;
				};
			});
			vi.mocked(window.maestro.notification.speak).mockResolvedValue({
				success: true,
				notificationId: 789,
			});

			render(<SettingsModal {...createDefaultProps({ initialTab: 'notifications' })} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			// Click Test button to start Command Chain
			const customSection = document.querySelector('[data-setting-id="notifications-custom"]')!;
			fireEvent.click(within(customSection as HTMLElement).getByRole('button', { name: 'Test' }));

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			// Stop button should be visible while command is running
			expect(screen.getByText('Stop')).toBeInTheDocument();

			// Simulate the command completing
			await act(async () => {
				if (capturedCallback) {
					capturedCallback(789);
				}
				await vi.advanceTimersByTimeAsync(100);
			});

			// Should show Success state briefly
			expect(screen.getByText('Success')).toBeInTheDocument();

			// Advance timer to clear success state (3000ms)
			await act(async () => {
				await vi.advanceTimersByTimeAsync(3000);
			});

			// Test button should be back
			const customSectionAfter = document.querySelector(
				'[data-setting-id="notifications-custom"]'
			)!;
			expect(within(customSectionAfter as HTMLElement).getByText('Test')).toBeInTheDocument();
		});
	});

	describe('Theme picker - Shift+Tab navigation', () => {
		it('should navigate to previous theme with Shift+Tab', async () => {
			mockUseSettingsOverrides = { activeThemeId: 'github-light' };
			render(
				<SettingsModal
					{...createDefaultProps({
						initialTab: 'theme',
					})}
				/>
			);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			// Find the theme picker container
			const themePickerContainer = screen.getByText('dark Mode').closest('.space-y-6');

			// Fire Shift+Tab keydown
			fireEvent.keyDown(themePickerContainer!, { key: 'Tab', shiftKey: true });

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			// Should navigate to previous theme (dracula, since github-light is after dracula)
			expect(mockSetActiveThemeId).toHaveBeenCalledWith('dracula');
		});
	});

	describe('Shortcut recording edge cases', () => {
		it('should handle Ctrl modifier key', async () => {
			const setShortcuts = vi.fn();
			render(<SettingsModal {...createDefaultProps({ initialTab: 'shortcuts', setShortcuts })} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			// Click to enter recording mode
			const shortcutButton = screen.getByText('Meta+n');
			fireEvent.click(shortcutButton);

			// Press Ctrl+k combination
			fireEvent.keyDown(shortcutButton, {
				key: 'k',
				ctrlKey: true,
				preventDefault: vi.fn(),
				stopPropagation: vi.fn(),
			});

			expect(mockSetShortcuts).toHaveBeenCalledWith(
				expect.objectContaining({
					'new-session': expect.objectContaining({ keys: ['Ctrl', 'k'] }),
				})
			);
		});

		it('should handle Alt modifier key', async () => {
			const setShortcuts = vi.fn();
			render(<SettingsModal {...createDefaultProps({ initialTab: 'shortcuts', setShortcuts })} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			// Click to enter recording mode
			const shortcutButton = screen.getByText('Meta+n');
			fireEvent.click(shortcutButton);

			// Press Alt+k combination
			fireEvent.keyDown(shortcutButton, {
				key: 'k',
				altKey: true,
				preventDefault: vi.fn(),
				stopPropagation: vi.fn(),
			});

			expect(mockSetShortcuts).toHaveBeenCalledWith(
				expect.objectContaining({
					'new-session': expect.objectContaining({ keys: ['Alt', 'k'] }),
				})
			);
		});

		it('should handle Shift modifier key', async () => {
			const setShortcuts = vi.fn();
			render(<SettingsModal {...createDefaultProps({ initialTab: 'shortcuts', setShortcuts })} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			// Click to enter recording mode
			const shortcutButton = screen.getByText('Meta+n');
			fireEvent.click(shortcutButton);

			// Press Shift+k combination
			fireEvent.keyDown(shortcutButton, {
				key: 'k',
				shiftKey: true,
				preventDefault: vi.fn(),
				stopPropagation: vi.fn(),
			});

			expect(mockSetShortcuts).toHaveBeenCalledWith(
				expect.objectContaining({
					'new-session': expect.objectContaining({ keys: ['Shift', 'k'] }),
				})
			);
		});

		it('should ignore modifier-only key presses', async () => {
			const setShortcuts = vi.fn();
			render(<SettingsModal {...createDefaultProps({ initialTab: 'shortcuts', setShortcuts })} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			// Click to enter recording mode
			const shortcutButton = screen.getByText('Meta+n');
			fireEvent.click(shortcutButton);

			// Press just Control key
			fireEvent.keyDown(shortcutButton, {
				key: 'Control',
				ctrlKey: true,
				preventDefault: vi.fn(),
				stopPropagation: vi.fn(),
			});

			// Should not call setShortcuts for modifier-only key
			expect(mockSetShortcuts).not.toHaveBeenCalled();
			// Should still be in recording mode
			expect(screen.getByText('Press keys...')).toBeInTheDocument();
		});
	});

	describe('Custom font removal', () => {
		it('should remove custom font when X is clicked', async () => {
			// Preload custom fonts
			vi.mocked(window.maestro.settings.get).mockResolvedValue(['MyCustomFont', 'AnotherFont']);

			render(<SettingsModal {...createDefaultProps({ initialTab: 'display' })} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			// Trigger font loading - get the first combobox which is the font selector
			const comboboxes = screen.getAllByRole('combobox');
			const fontSelect = comboboxes[0]; // Font selector is the first combobox
			fireEvent.focus(fontSelect);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			// Find the remove button for MyCustomFont
			const removeButtons = screen.getAllByText('×');
			expect(removeButtons.length).toBeGreaterThan(0);

			// Click remove on first custom font
			fireEvent.click(removeButtons[0]);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			// Should save updated custom fonts (without MyCustomFont)
			expect(window.maestro.settings.set).toHaveBeenCalledWith('customFonts', ['AnotherFont']);
		});
	});

	describe('Max output lines 100 button', () => {
		it('should call setMaxOutputLines with 100', async () => {
			render(<SettingsModal {...createDefaultProps({ initialTab: 'display' })} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			// Find the Max Output Lines section by its label, then find the 100 button within it
			const maxOutputLabel = screen.getByText('Max Output Lines per Response');
			const maxOutputSection = maxOutputLabel.closest('div')?.parentElement;
			const buttons = maxOutputSection?.querySelectorAll('button') ?? [];
			const button100 = Array.from(buttons).find((btn) => btn.textContent === '100');
			expect(button100).toBeDefined();
			fireEvent.click(button100!);
			expect(mockSetMaxOutputLines).toHaveBeenCalledWith(100);
		});
	});

	describe('Font availability checking', () => {
		it('should check font availability using normalized names', async () => {
			(window.maestro as any).fonts.detect.mockResolvedValue(['JetBrains Mono', 'Fira Code']);

			render(<SettingsModal {...createDefaultProps({ initialTab: 'display' })} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			// Trigger font loading - get the first combobox which is the font selector
			const comboboxes = screen.getAllByRole('combobox');
			const fontSelect = comboboxes[0]; // Font selector is the first combobox
			fireEvent.focus(fontSelect);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			// Should show fonts with availability indicators
			// JetBrains Mono is in the list, so it should be available
			const options = fontSelect.querySelectorAll('option');
			expect(options.length).toBeGreaterThan(0);
		});
	});

	describe('Shell selection with mouseEnter and focus', () => {
		it('should load shells on mouseEnter', async () => {
			render(<SettingsModal {...createDefaultProps()} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			// Trigger shell loading via mouseEnter
			const detectButton = screen.getByText('Detect other available shells...');

			// Load shells first
			fireEvent.click(detectButton);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			// Now shells should be loaded, find a shell button
			const zshButton = screen.getByText('Zsh').closest('button');
			expect(zshButton).toBeInTheDocument();

			// Trigger mouseEnter - should not reload (already loaded)
			fireEvent.mouseEnter(zshButton!);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			// shells.detect should only have been called once
			expect(window.maestro.shells.detect).toHaveBeenCalledTimes(1);
		});
	});

	describe('Plugins settings tab', () => {
		it('should render Plugins tab button', async () => {
			render(<SettingsModal {...createDefaultProps()} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			expect(screen.getByTitle('Plugins')).toBeInTheDocument();
		});

		it('should switch to Plugins tab when clicked', async () => {
			render(<SettingsModal {...createDefaultProps()} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			const tab = screen.getByTitle('Plugins');
			fireEvent.click(tab);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			// The marketplace's own header is the single voice of the tab; the
			// separate "Feature settings" accordion list is gone.
			expect(screen.getByText('Plugins', { selector: 'h3' })).toBeInTheDocument();
			expect(screen.queryByText('Feature settings')).not.toBeInTheDocument();
		});

		it('should show description text for the Plugins tab', async () => {
			render(<SettingsModal {...createDefaultProps()} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			fireEvent.click(screen.getByTitle('Plugins'));

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			expect(
				screen.getByText(/Built-in Encore features and community plugins/)
			).toBeInTheDocument();
		});

		it('should open Pianola modal from enabled Pianola extension details', async () => {
			useSettingsStore.setState({
				encoreFeatures: {
					directorNotes: false,
					usageStats: true,
					symphony: true,
					maestroCue: false,
					pianola: true,
					plugins: false,
				},
			});

			render(<SettingsModal {...createDefaultProps()} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			fireEvent.click(screen.getByTitle('Plugins'));

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			const pianolaCard = document.querySelector('[data-extension-id="pianola"]');
			expect(pianolaCard).toBeInTheDocument();
			fireEvent.click(pianolaCard as HTMLElement);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			fireEvent.click(screen.getByTestId('extension-open-pianola'));

			expect(useModalStore.getState().isOpen('pianolaModal')).toBe(true);
		});

		it('should render enabled plugin settings and write only the plugin namespace', async () => {
			const pluginId = 'com.example.settings';
			useSettingsStore.setState({
				encoreFeatures: {
					directorNotes: false,
					usageStats: true,
					symphony: true,
					maestroCue: false,
					pianola: false,
					plugins: true,
				},
			});
			vi.mocked(window.maestro.plugins.list).mockResolvedValue({
				plugins: [
					{
						id: pluginId,
						manifest: {
							id: pluginId,
							name: 'Settings Plugin',
							version: '0.1.0',
							tier: 1,
							maestro: { minHostApi: '1.7.0' },
							entry: 'dist/entry.js',
							permissions: [],
						},
						source: '/plugins/settings',
						loadStatus: 'ok',
						enabled: true,
						errors: [],
						signature: { status: 'trusted' },
					},
				],
			});
			vi.mocked(window.maestro.plugins.contributions).mockResolvedValue({
				themes: [],
				iconPacks: [],
				prompts: [],
				settings: [
					{
						id: `${pluginId}:poll`,
						localId: 'poll',
						pluginId,
						key: 'poll',
						type: 'boolean',
						default: false,
						description: 'Poll automatically',
					},
				],
				commandMacros: [],
				cueTriggers: [],
				commands: [],
				panels: [],
				agents: [],
				tools: [],
				keybindings: [],
				uiItems: [],
				errorsByPlugin: {},
			});

			render(<SettingsModal {...createDefaultProps()} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			fireEvent.click(screen.getByTitle('Plugins'));

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			const pluginCard = document.querySelector(`[data-extension-id="${pluginId}"]`);
			expect(pluginCard).toBeInTheDocument();
			fireEvent.click(pluginCard as HTMLElement);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			fireEvent.click(screen.getByTestId('extension-configure'));

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			expect(screen.getByText('Poll automatically')).toBeInTheDocument();

			fireEvent.click(screen.getByTestId('extension-setting-input'));

			expect(window.maestro.settings.set).toHaveBeenCalledWith(`plugins.${pluginId}.poll`, true);
		});

		it('should hide plugin settings for disabled plugins', async () => {
			const pluginId = 'com.example.disabled-settings';
			useSettingsStore.setState({
				encoreFeatures: {
					directorNotes: false,
					usageStats: true,
					symphony: true,
					maestroCue: false,
					pianola: false,
					plugins: true,
				},
			});
			vi.mocked(window.maestro.plugins.list).mockResolvedValue({
				plugins: [
					{
						id: pluginId,
						manifest: {
							id: pluginId,
							name: 'Disabled Settings Plugin',
							version: '0.1.0',
							tier: 1,
							maestro: { minHostApi: '1.7.0' },
							entry: 'dist/entry.js',
							permissions: [],
						},
						source: '/plugins/disabled-settings',
						loadStatus: 'ok',
						enabled: false,
						errors: [],
						signature: { status: 'trusted' },
					},
				],
			});
			vi.mocked(window.maestro.plugins.contributions).mockResolvedValue({
				themes: [],
				iconPacks: [],
				prompts: [],
				settings: [
					{
						id: `${pluginId}:poll`,
						localId: 'poll',
						pluginId,
						key: 'poll',
						type: 'boolean',
						default: false,
						description: 'Poll automatically',
					},
				],
				commandMacros: [],
				cueTriggers: [],
				commands: [],
				panels: [],
				agents: [],
				tools: [],
				keybindings: [],
				uiItems: [],
				errorsByPlugin: {},
			});

			render(<SettingsModal {...createDefaultProps()} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			fireEvent.click(screen.getByTitle('Plugins'));

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			const pluginCard = document.querySelector(`[data-extension-id="${pluginId}"]`);
			expect(pluginCard).toBeInTheDocument();
			fireEvent.click(pluginCard as HTMLElement);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			expect(screen.queryByTestId('extension-configure')).not.toBeInTheDocument();
			expect(window.maestro.settings.set).not.toHaveBeenCalledWith(
				`plugins.${pluginId}.poll`,
				expect.anything()
			);
		});

		it("Director's Notes tile: Settings sub-tab shows the disabled hint when off", async () => {
			// Store default has directorNotes disabled.
			render(<SettingsModal {...createDefaultProps()} />);
			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});
			fireEvent.click(screen.getByTitle('Plugins'));
			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			openExtensionDetail('directorNotes');
			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			// Configurable tile opens on Settings; disabled → hint, not config.
			expect(screen.getByTestId('extension-subtab-settings')).toHaveAttribute(
				'aria-selected',
				'true'
			);
			expect(screen.getByTestId('extension-settings-disabled-hint')).toHaveTextContent(
				'Enable this plugin to configure it.'
			);
			expect(screen.queryByText('Synopsis Provider')).not.toBeInTheDocument();
		});

		it('Usage & Stats tile: Settings shows lookback config; Permissions reveals caps + services', async () => {
			// Store default has usageStats enabled.
			render(<SettingsModal {...createDefaultProps()} />);
			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});
			fireEvent.click(screen.getByTitle('Plugins'));
			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			openExtensionDetail('usageStats');
			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			// Settings sub-tab (default) renders the Usage & Stats config body.
			const panel = screen.getByTestId('extension-settings-panel');
			expect(panel).toBeInTheDocument();
			expect(within(panel).getByText('Default lookback window')).toBeInTheDocument();
			expect(within(panel).getByLabelText('Select default lookback window')).toBeInTheDocument();

			// The capability disclosure + supervised service live behind Permissions.
			expect(screen.queryByTestId('extension-background-service')).not.toBeInTheDocument();
			selectSubTab('permissions');
			expect(screen.getAllByTestId('extension-permission').length).toBeGreaterThan(0);
			expect(screen.getByTestId('extension-background-service').getAttribute('data-service')).toBe(
				'stats.sampler'
			);
			// Back to Settings restores the config body.
			selectSubTab('settings');
			expect(screen.getByText('Default lookback window')).toBeInTheDocument();
		});

		it('Maestro Symphony tile: Settings shows Registry Sources when enabled', async () => {
			// Store default has symphony enabled.
			render(<SettingsModal {...createDefaultProps()} />);
			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});
			fireEvent.click(screen.getByTitle('Plugins'));
			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			openExtensionDetail('symphony');
			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			const panel = screen.getByTestId('extension-settings-panel');
			expect(within(panel).getByText('Registry Sources')).toBeInTheDocument();
		});

		it('Maestro Symphony tile: Settings shows the disabled hint when off', async () => {
			useSettingsStore.setState({
				encoreFeatures: {
					directorNotes: false,
					usageStats: true,
					symphony: false,
					maestroCue: false,
					pianola: false,
					plugins: false,
				},
			});
			render(<SettingsModal {...createDefaultProps()} />);
			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});
			fireEvent.click(screen.getByTitle('Plugins'));
			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			openExtensionDetail('symphony');
			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			expect(screen.getByTestId('extension-settings-disabled-hint')).toBeInTheDocument();
			expect(screen.queryByText('Registry Sources')).not.toBeInTheDocument();
		});

		describe("with Director's Notes enabled", () => {
			beforeEach(() => {
				// Both sources must agree: the store drives the tile's enabled
				// state (so the config body renders), the useSettings mock drives
				// the detection hook (so the provider dropdown populates).
				mockUseSettingsOverrides = {
					encoreFeatures: { directorNotes: true, usageStats: true, symphony: true },
				};
				useSettingsStore.setState({
					encoreFeatures: {
						directorNotes: true,
						usageStats: true,
						symphony: true,
						maestroCue: false,
						pianola: false,
						plugins: false,
					},
				});
			});

			it('renders the DN config body (provider dropdown + lookback slider) in the Settings sub-tab', async () => {
				render(<SettingsModal {...createDefaultProps()} />);
				await act(async () => {
					await vi.advanceTimersByTimeAsync(50);
				});
				fireEvent.click(screen.getByTitle('Plugins'));
				await act(async () => {
					await vi.advanceTimersByTimeAsync(100);
				});

				openExtensionDetail('directorNotes');
				await act(async () => {
					await vi.advanceTimersByTimeAsync(100);
				});

				const panel = screen.getByTestId('extension-settings-panel');
				expect(within(panel).getByText('Synopsis Provider')).toBeInTheDocument();
				// detect() returns claude-code + codex; both supported → 2 options.
				const select = within(panel).getByLabelText('Select synopsis provider agent');
				expect(select.querySelectorAll('option')).toHaveLength(2);
				// Lookback slider present with the persisted value.
				const slider = within(panel).getByRole('slider');
				expect(slider).toHaveAttribute('min', '1');
				expect(slider).toHaveAttribute('max', '90');
				expect(slider).toHaveValue('7');
			});

			it('persists provider + lookback changes end-to-end via setDirectorNotesSettings', async () => {
				mockSetDirectorNotesSettings.mockClear();
				render(<SettingsModal {...createDefaultProps()} />);
				await act(async () => {
					await vi.advanceTimersByTimeAsync(50);
				});
				fireEvent.click(screen.getByTitle('Plugins'));
				await act(async () => {
					await vi.advanceTimersByTimeAsync(100);
				});

				openExtensionDetail('directorNotes');
				await act(async () => {
					await vi.advanceTimersByTimeAsync(100);
				});

				const panel = screen.getByTestId('extension-settings-panel');
				fireEvent.change(within(panel).getByLabelText('Select synopsis provider agent'), {
					target: { value: 'codex' },
				});
				expect(mockSetDirectorNotesSettings).toHaveBeenCalledWith(
					expect.objectContaining({ provider: 'codex' })
				);

				mockSetDirectorNotesSettings.mockClear();
				fireEvent.change(within(panel).getByRole('slider'), { target: { value: '30' } });
				expect(mockSetDirectorNotesSettings).toHaveBeenCalledWith(
					expect.objectContaining({ defaultLookbackDays: 30 })
				);
			});
		});
	});

	describe('settings search', () => {
		it('should render search input', () => {
			render(<SettingsModal {...createDefaultProps()} />);
			expect(screen.getByPlaceholderText('Search settings...')).toBeInTheDocument();
		});

		it('should show search results when typing a query', async () => {
			render(<SettingsModal {...createDefaultProps()} />);

			const searchInput = screen.getByPlaceholderText('Search settings...');
			fireEvent.change(searchInput, { target: { value: 'font' } });

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			// Text may be split by highlight spans, so use a function matcher
			expect(
				screen.getByText(
					(_content, element) => element?.textContent === 'Font Family' && element.tagName === 'DIV'
				)
			).toBeInTheDocument();
			expect(
				screen.getByText(
					(_content, element) => element?.textContent === 'Font Size' && element.tagName === 'DIV'
				)
			).toBeInTheDocument();
		});

		it('should show result count badge when searching', async () => {
			render(<SettingsModal {...createDefaultProps()} />);

			const searchInput = screen.getByPlaceholderText('Search settings...');
			fireEvent.change(searchInput, { target: { value: 'font' } });

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			// The count badge should be visible
			const badge = screen.getByText(/^\d+$/);
			expect(badge).toBeInTheDocument();
		});

		it('should show no results message for unmatched query', async () => {
			render(<SettingsModal {...createDefaultProps()} />);

			const searchInput = screen.getByPlaceholderText('Search settings...');
			fireEvent.change(searchInput, { target: { value: 'xyznonexistent' } });

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			expect(screen.getByText(/No settings found/)).toBeInTheDocument();
		});

		it('should hide sidebar and content when search is active', async () => {
			render(<SettingsModal {...createDefaultProps()} />);

			const searchInput = screen.getByPlaceholderText('Search settings...');
			fireEvent.change(searchInput, { target: { value: 'shell' } });

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			// The sidebar+content wrapper should have the hidden class
			const sidebar = screen.getByLabelText('Settings tabs');
			expect(sidebar.closest('div.flex')?.className).toContain('hidden');
		});

		it('should clear search and show clear button', async () => {
			render(<SettingsModal {...createDefaultProps()} />);

			const searchInput = screen.getByPlaceholderText('Search settings...');
			fireEvent.change(searchInput, { target: { value: 'notification' } });

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			// Clear button should be visible
			const clearButton = screen.getByLabelText('Clear search');
			expect(clearButton).toBeInTheDocument();

			fireEvent.click(clearButton);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			// Search should be cleared, tab content visible again
			expect(searchInput).toHaveValue('');
		});

		it('should search across multiple tabs', async () => {
			render(<SettingsModal {...createDefaultProps()} />);

			const searchInput = screen.getByPlaceholderText('Search settings...');
			fireEvent.change(searchInput, { target: { value: 'ignore' } });

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			// The Display-tab "Local Ignore Patterns" entry was merged into the broader
			// "File Indexing & File Panel Settings" section (still tagged with the
			// ignore/gitignore keywords). The SSH-remote entry kept its original label.
			expect(
				screen.getByText(
					(_content, element) =>
						element?.textContent === 'File Indexing & File Panel Settings' &&
						element.tagName === 'DIV'
				)
			).toBeInTheDocument();
			expect(
				screen.getByText(
					(_content, element) =>
						element?.textContent === 'SSH Remote Ignore Patterns' && element.tagName === 'DIV'
				)
			).toBeInTheDocument();
		});

		it('should group results by tab label', async () => {
			render(<SettingsModal {...createDefaultProps()} />);

			const searchInput = screen.getByPlaceholderText('Search settings...');
			fireEvent.change(searchInput, { target: { value: 'ignore' } });

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			// Should show tab group headers (h3 elements in search results)
			const groupHeaders = screen.getAllByRole('heading', { level: 3 });
			const headerTexts = groupHeaders.map((h) => h.textContent);
			expect(headerTexts).toContain('Display');
			expect(headerTexts).toContain('SSH Hosts');
		});
	});

	describe('small-viewport layout', () => {
		afterEach(() => {
			// Restore the jsdom default so leaked phone widths don't affect other suites.
			setViewportWidth(1024);
		});

		it('clamps the modal height so it fits small viewports', async () => {
			render(<SettingsModal {...createDefaultProps()} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			// Height clamping is now owned by the resizable-modal system (inline
			// style, not a static Tailwind class) - it always caps at 90vh rather
			// than switching between a fixed 900px and a viewport-relative class.
			const container = screen
				.getByRole('dialog')
				.querySelector('[data-modal-resize-key="settings"]');
			expect(container).toHaveStyle({ maxHeight: '90vh' });
			expect(container?.className).not.toContain('h-[900px]');
		});

		it('renders the vertical 248px sidebar at desktop widths', async () => {
			setViewportWidth(1280);
			render(<SettingsModal {...createDefaultProps()} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			const nav = screen.getByLabelText('Settings tabs');
			expect(nav.className).toContain('w-[248px]');
			expect(nav.className).not.toContain('overflow-x-auto');
		});

		it('collapses the sidebar into a horizontal tab strip on xs phones', async () => {
			setViewportWidth(390);
			render(<SettingsModal {...createDefaultProps()} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			// Same nav landmark, but now a horizontally scrollable strip above content.
			const nav = screen.getByLabelText('Settings tabs');
			expect(nav.className).toContain('overflow-x-auto');
			expect(nav.className).not.toContain('w-[248px]');

			// The body wrapper stacks (flex-col) so the strip sits above the content.
			expect(nav.closest('div.flex')?.className).toContain('flex-col');
		});

		it('keeps tab switching working from the horizontal strip', async () => {
			setViewportWidth(390);
			render(<SettingsModal {...createDefaultProps()} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			// Every section is still reachable from the strip.
			expect(screen.getByTitle('Shortcuts')).toBeInTheDocument();
			fireEvent.click(screen.getByTitle('Shortcuts'));

			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});

			expect(screen.getByPlaceholderText('Filter shortcuts...')).toBeInTheDocument();
		});

		it('keeps settings search working on xs phones', async () => {
			setViewportWidth(390);
			render(<SettingsModal {...createDefaultProps()} />);

			const searchInput = screen.getByPlaceholderText('Search settings...');
			fireEvent.change(searchInput, { target: { value: 'shell' } });

			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});

			// Search hides the strip+content wrapper just like the sidebar layout.
			const nav = screen.getByLabelText('Settings tabs');
			expect(nav.closest('div.flex')?.className).toContain('hidden');
		});
	});
});
