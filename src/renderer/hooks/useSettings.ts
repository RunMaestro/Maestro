import { useState, useEffect, useCallback, useMemo } from 'react';
import type { LLMProvider, ThemeId, ThemeColors, Shortcut, CustomAICommand, GlobalStats, AutoRunStats, OnboardingStats, LeaderboardRegistration } from '../types';
import { DEFAULT_CUSTOM_THEME_COLORS } from '../constants/themes';
import { DEFAULT_SHORTCUTS } from '../constants/shortcuts';
import { commitCommandPrompt } from '../../prompts';

// Default global stats
const DEFAULT_GLOBAL_STATS: GlobalStats = {
  totalSessions: 0,
  totalMessages: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCacheReadTokens: 0,
  totalCacheCreationTokens: 0,
  totalCostUsd: 0,
  totalActiveTimeMs: 0,
};

// Default auto-run stats
const DEFAULT_AUTO_RUN_STATS: AutoRunStats = {
  cumulativeTimeMs: 0,
  longestRunMs: 0,
  longestRunTimestamp: 0,
  totalRuns: 0,
  currentBadgeLevel: 0,
  lastBadgeUnlockLevel: 0,
  lastAcknowledgedBadgeLevel: 0,
  badgeHistory: [],
};

// Default onboarding stats (all local, no external telemetry)
const DEFAULT_ONBOARDING_STATS: OnboardingStats = {
  // Wizard statistics
  wizardStartCount: 0,
  wizardCompletionCount: 0,
  wizardAbandonCount: 0,
  wizardResumeCount: 0,
  averageWizardDurationMs: 0,
  totalWizardDurationMs: 0,
  lastWizardCompletedAt: 0,

  // Tour statistics
  tourStartCount: 0,
  tourCompletionCount: 0,
  tourSkipCount: 0,
  tourStepsViewedTotal: 0,
  averageTourStepsViewed: 0,

  // Conversation statistics
  totalConversationExchanges: 0,
  averageConversationExchanges: 0,
  totalConversationsCompleted: 0,

  // Phase generation statistics
  totalPhasesGenerated: 0,
  averagePhasesPerWizard: 0,
  totalTasksGenerated: 0,
  averageTasksPerPhase: 0,
};

// Default AI commands that ship with Maestro
// Template variables available: {{AGENT_NAME}}, {{AGENT_PATH}}, {{TAB_NAME}}, {{AGENT_GROUP}}, {{AGENT_SESSION_ID}}, {{DATE}}, {{TIME}}, etc.
const DEFAULT_AI_COMMANDS: CustomAICommand[] = [
  {
    id: 'commit',
    command: '/commit',
    description: 'Commit outstanding changes and push up',
    prompt: commitCommandPrompt,
    isBuiltIn: true,
  },
];

export interface UseSettingsReturn {
  // Loading state
  settingsLoaded: boolean;

  // LLM settings
  llmProvider: LLMProvider;
  modelSlug: string;
  apiKey: string;
  setLlmProvider: (value: LLMProvider) => void;
  setModelSlug: (value: string) => void;
  setApiKey: (value: string) => void;

  // Shell settings
  defaultShell: string;
  setDefaultShell: (value: string) => void;
  customShellPath: string;
  setCustomShellPath: (value: string) => void;
  shellArgs: string;
  setShellArgs: (value: string) => void;
  shellEnvVars: Record<string, string>;
  setShellEnvVars: (value: Record<string, string>) => void;

  // GitHub CLI settings
  ghPath: string;
  setGhPath: (value: string) => void;

  // Font settings
  fontFamily: string;
  fontSize: number;
  setFontFamily: (value: string) => void;
  setFontSize: (value: number) => void;

  // UI settings
  activeThemeId: ThemeId;
  setActiveThemeId: (value: ThemeId) => void;
  customThemeColors: ThemeColors;
  setCustomThemeColors: (value: ThemeColors) => void;
  customThemeBaseId: ThemeId;
  setCustomThemeBaseId: (value: ThemeId) => void;
  enterToSendAI: boolean;
  setEnterToSendAI: (value: boolean) => void;
  enterToSendTerminal: boolean;
  setEnterToSendTerminal: (value: boolean) => void;
  defaultSaveToHistory: boolean;
  setDefaultSaveToHistory: (value: boolean) => void;

  // Default thinking toggle
  defaultShowThinking: boolean;
  setDefaultShowThinking: (value: boolean) => void;
  leftSidebarWidth: number;
  rightPanelWidth: number;
  markdownEditMode: boolean;
  setLeftSidebarWidth: (value: number) => void;
  setRightPanelWidth: (value: number) => void;
  setMarkdownEditMode: (value: boolean) => void;
  showHiddenFiles: boolean;
  setShowHiddenFiles: (value: boolean) => void;

  // Terminal settings
  terminalWidth: number;
  setTerminalWidth: (value: number) => void;

  // Logging settings
  logLevel: string;
  setLogLevel: (value: string) => void;
  maxLogBuffer: number;
  setMaxLogBuffer: (value: number) => void;

  // Output settings
  maxOutputLines: number;
  setMaxOutputLines: (value: number) => void;

  // Notification settings
  osNotificationsEnabled: boolean;
  setOsNotificationsEnabled: (value: boolean) => void;
  audioFeedbackEnabled: boolean;
  setAudioFeedbackEnabled: (value: boolean) => void;
  audioFeedbackCommand: string;
  setAudioFeedbackCommand: (value: string) => void;
  toastDuration: number;
  setToastDuration: (value: number) => void;

  // Update settings
  checkForUpdatesOnStartup: boolean;
  setCheckForUpdatesOnStartup: (value: boolean) => void;

  // Crash reporting settings
  crashReportingEnabled: boolean;
  setCrashReportingEnabled: (value: boolean) => void;

  // Log Viewer settings
  logViewerSelectedLevels: string[];
  setLogViewerSelectedLevels: (value: string[]) => void;

  // Shortcuts
  shortcuts: Record<string, Shortcut>;
  setShortcuts: (value: Record<string, Shortcut>) => void;

  // Custom AI Commands
  customAICommands: CustomAICommand[];
  setCustomAICommands: (value: CustomAICommand[]) => void;

  // Global Stats (persistent across restarts)
  globalStats: GlobalStats;
  setGlobalStats: (value: GlobalStats) => void;
  updateGlobalStats: (delta: Partial<GlobalStats>) => void;

  // Auto-run Stats (persistent across restarts)
  autoRunStats: AutoRunStats;
  setAutoRunStats: (value: AutoRunStats) => void;
  recordAutoRunComplete: (elapsedTimeMs: number) => { newBadgeLevel: number | null; isNewRecord: boolean };
  updateAutoRunProgress: (currentRunElapsedMs: number) => { newBadgeLevel: number | null; isNewRecord: boolean };
  acknowledgeBadge: (level: number) => void;
  getUnacknowledgedBadgeLevel: () => number | null;

  // UI collapse states (persistent)
  ungroupedCollapsed: boolean;
  setUngroupedCollapsed: (value: boolean) => void;

  // Onboarding settings
  tourCompleted: boolean;
  setTourCompleted: (value: boolean) => void;
  firstAutoRunCompleted: boolean;
  setFirstAutoRunCompleted: (value: boolean) => void;

  // Onboarding Stats (persistent, local-only analytics)
  onboardingStats: OnboardingStats;
  setOnboardingStats: (value: OnboardingStats) => void;
  recordWizardStart: () => void;
  recordWizardComplete: (durationMs: number, conversationExchanges: number, phasesGenerated: number, tasksGenerated: number) => void;
  recordWizardAbandon: () => void;
  recordWizardResume: () => void;
  recordTourStart: () => void;
  recordTourComplete: (stepsViewed: number) => void;
  recordTourSkip: (stepsViewed: number) => void;
  getOnboardingAnalytics: () => {
    wizardCompletionRate: number;
    tourCompletionRate: number;
    averageConversationExchanges: number;
    averagePhasesPerWizard: number;
  };

  // Leaderboard Registration (persistent)
  leaderboardRegistration: LeaderboardRegistration | null;
  setLeaderboardRegistration: (value: LeaderboardRegistration | null) => void;
  isLeaderboardRegistered: boolean;

  // Web Interface settings
  webInterfaceUseCustomPort: boolean;
  setWebInterfaceUseCustomPort: (value: boolean) => void;
  webInterfaceCustomPort: number;
  setWebInterfaceCustomPort: (value: number) => void;
}

export function useSettings(): UseSettingsReturn {
  // Loading state
  const [settingsLoaded, setSettingsLoaded] = useState(false);

  // LLM Config
  const [llmProvider, setLlmProviderState] = useState<LLMProvider>('openrouter');
  const [modelSlug, setModelSlugState] = useState('anthropic/claude-3.5-sonnet');
  const [apiKey, setApiKeyState] = useState('');

  // Shell Config
  const [defaultShell, setDefaultShellState] = useState('zsh');
  const [customShellPath, setCustomShellPathState] = useState('');
  const [shellArgs, setShellArgsState] = useState('');
  const [shellEnvVars, setShellEnvVarsState] = useState<Record<string, string>>({});

  // GitHub CLI Config
  const [ghPath, setGhPathState] = useState('');

  // Font Config
  const [fontFamily, setFontFamilyState] = useState('Roboto Mono, Menlo, "Courier New", monospace');
  const [fontSize, setFontSizeState] = useState(14);

  // UI Config
  const [activeThemeId, setActiveThemeIdState] = useState<ThemeId>('dracula');
  const [customThemeColors, setCustomThemeColorsState] = useState<ThemeColors>(DEFAULT_CUSTOM_THEME_COLORS);
  const [customThemeBaseId, setCustomThemeBaseIdState] = useState<ThemeId>('dracula');
  const [enterToSendAI, setEnterToSendAIState] = useState(false); // AI mode defaults to Command+Enter
  const [enterToSendTerminal, setEnterToSendTerminalState] = useState(true); // Terminal defaults to Enter
  const [defaultSaveToHistory, setDefaultSaveToHistoryState] = useState(true); // History toggle defaults to on
  const [defaultShowThinking, setDefaultShowThinkingState] = useState(false); // Thinking toggle defaults to off
  const [leftSidebarWidth, setLeftSidebarWidthState] = useState(256);
  const [rightPanelWidth, setRightPanelWidthState] = useState(384);
  const [markdownEditMode, setMarkdownEditModeState] = useState(false);
  const [showHiddenFiles, setShowHiddenFilesState] = useState(true); // Default: show hidden files

  // Terminal Config
  const [terminalWidth, setTerminalWidthState] = useState(100);

  // Logging Config
  const [logLevel, setLogLevelState] = useState('info');
  const [maxLogBuffer, setMaxLogBufferState] = useState(5000);

  // Output Config
  const [maxOutputLines, setMaxOutputLinesState] = useState(25);

  // Notification Config
  const [osNotificationsEnabled, setOsNotificationsEnabledState] = useState(true); // Default: on
  const [audioFeedbackEnabled, setAudioFeedbackEnabledState] = useState(false); // Default: off
  const [audioFeedbackCommand, setAudioFeedbackCommandState] = useState('say'); // Default: macOS say command
  const [toastDuration, setToastDurationState] = useState(20); // Default: 20 seconds, 0 = never auto-dismiss

  // Update Config
  const [checkForUpdatesOnStartup, setCheckForUpdatesOnStartupState] = useState(true); // Default: on

  // Crash Reporting Config
  const [crashReportingEnabled, setCrashReportingEnabledState] = useState(true); // Default: on (opt-out)

  // Log Viewer Config
  const [logViewerSelectedLevels, setLogViewerSelectedLevelsState] = useState<string[]>(['debug', 'info', 'warn', 'error', 'toast']);

  // Shortcuts
  const [shortcuts, setShortcutsState] = useState<Record<string, Shortcut>>(DEFAULT_SHORTCUTS);

  // Custom AI Commands
  const [customAICommands, setCustomAICommandsState] = useState<CustomAICommand[]>(DEFAULT_AI_COMMANDS);

  // Global Stats (persistent)
  const [globalStats, setGlobalStatsState] = useState<GlobalStats>(DEFAULT_GLOBAL_STATS);

  // Auto-run Stats (persistent)
  const [autoRunStats, setAutoRunStatsState] = useState<AutoRunStats>(DEFAULT_AUTO_RUN_STATS);

  // UI collapse states (persistent)
  const [ungroupedCollapsed, setUngroupedCollapsedState] = useState(false);

  // Onboarding settings (persistent)
  const [tourCompleted, setTourCompletedState] = useState(false);
  const [firstAutoRunCompleted, setFirstAutoRunCompletedState] = useState(false);

  // Onboarding Stats (persistent, local-only analytics)
  const [onboardingStats, setOnboardingStatsState] = useState<OnboardingStats>(DEFAULT_ONBOARDING_STATS);

  // Leaderboard Registration (persistent)
  const [leaderboardRegistration, setLeaderboardRegistrationState] = useState<LeaderboardRegistration | null>(null);

  // Web Interface settings (persistent)
  const [webInterfaceUseCustomPort, setWebInterfaceUseCustomPortState] = useState(false);
  const [webInterfaceCustomPort, setWebInterfaceCustomPortState] = useState(8080);

  // Wrapper functions that persist to electron-store
  // PERF: All wrapped in useCallback to prevent re-renders
  const setLlmProvider = useCallback((value: LLMProvider) => {
    setLlmProviderState(value);
    window.maestro.settings.set('llmProvider', value);
  }, []);

  const setModelSlug = useCallback((value: string) => {
    setModelSlugState(value);
    window.maestro.settings.set('modelSlug', value);
  }, []);

  const setApiKey = useCallback((value: string) => {
    setApiKeyState(value);
    window.maestro.settings.set('apiKey', value);
  }, []);

  const setDefaultShell = useCallback((value: string) => {
    setDefaultShellState(value);
    window.maestro.settings.set('defaultShell', value);
  }, []);

  const setCustomShellPath = useCallback((value: string) => {
    setCustomShellPathState(value);
    window.maestro.settings.set('customShellPath', value);
  }, []);

  const setShellArgs = useCallback((value: string) => {
    setShellArgsState(value);
    window.maestro.settings.set('shellArgs', value);
  }, []);

  const setShellEnvVars = useCallback((value: Record<string, string>) => {
    setShellEnvVarsState(value);
    window.maestro.settings.set('shellEnvVars', value);
  }, []);

  const setGhPath = useCallback((value: string) => {
    setGhPathState(value);
    window.maestro.settings.set('ghPath', value);
  }, []);

  const setFontFamily = useCallback((value: string) => {
    setFontFamilyState(value);
    window.maestro.settings.set('fontFamily', value);
  }, []);

  const setFontSize = useCallback((value: number) => {
    setFontSizeState(value);
    window.maestro.settings.set('fontSize', value);
  }, []);

  const setActiveThemeId = useCallback((value: ThemeId) => {
    setActiveThemeIdState(value);
    window.maestro.settings.set('activeThemeId', value);
  }, []);

  const setCustomThemeColors = useCallback((value: ThemeColors) => {
    setCustomThemeColorsState(value);
    window.maestro.settings.set('customThemeColors', value);
  }, []);

  const setCustomThemeBaseId = useCallback((value: ThemeId) => {
    setCustomThemeBaseIdState(value);
    window.maestro.settings.set('customThemeBaseId', value);
  }, []);

  const setEnterToSendAI = useCallback((value: boolean) => {
    setEnterToSendAIState(value);
    window.maestro.settings.set('enterToSendAI', value);
  }, []);

  const setEnterToSendTerminal = useCallback((value: boolean) => {
    setEnterToSendTerminalState(value);
    window.maestro.settings.set('enterToSendTerminal', value);
  }, []);

  const setDefaultSaveToHistory = useCallback((value: boolean) => {
    setDefaultSaveToHistoryState(value);
    window.maestro.settings.set('defaultSaveToHistory', value);
  }, []);

  const setDefaultShowThinking = useCallback((value: boolean) => {
    setDefaultShowThinkingState(value);
    window.maestro.settings.set('defaultShowThinking', value);
  }, []);

  const setLeftSidebarWidth = useCallback((width: number) => {
    const clampedWidth = Math.max(256, Math.min(600, width));
    setLeftSidebarWidthState(clampedWidth);
    window.maestro.settings.set('leftSidebarWidth', clampedWidth);
  }, []);

  const setRightPanelWidth = useCallback((width: number) => {
    setRightPanelWidthState(width);
    window.maestro.settings.set('rightPanelWidth', width);
  }, []);

  const setMarkdownEditMode = useCallback((value: boolean) => {
    setMarkdownEditModeState(value);
    window.maestro.settings.set('markdownEditMode', value);
  }, []);

  const setShowHiddenFiles = useCallback((value: boolean) => {
    setShowHiddenFilesState(value);
    window.maestro.settings.set('showHiddenFiles', value);
  }, []);

  const setShortcuts = useCallback((value: Record<string, Shortcut>) => {
    setShortcutsState(value);
    window.maestro.settings.set('shortcuts', value);
  }, []);

  const setTerminalWidth = useCallback((value: number) => {
    setTerminalWidthState(value);
    window.maestro.settings.set('terminalWidth', value);
  }, []);

  const setLogLevel = useCallback(async (value: string) => {
    setLogLevelState(value);
    await window.maestro.logger.setLogLevel(value);
  }, []);

  const setMaxLogBuffer = useCallback(async (value: number) => {
    setMaxLogBufferState(value);
    await window.maestro.logger.setMaxLogBuffer(value);
  }, []);

  const setMaxOutputLines = useCallback((value: number) => {
    setMaxOutputLinesState(value);
    window.maestro.settings.set('maxOutputLines', value);
  }, []);

  const setOsNotificationsEnabled = useCallback((value: boolean) => {
    setOsNotificationsEnabledState(value);
    window.maestro.settings.set('osNotificationsEnabled', value);
  }, []);

  const setAudioFeedbackEnabled = useCallback((value: boolean) => {
    setAudioFeedbackEnabledState(value);
    window.maestro.settings.set('audioFeedbackEnabled', value);
  }, []);

  const setAudioFeedbackCommand = useCallback((value: string) => {
    setAudioFeedbackCommandState(value);
    window.maestro.settings.set('audioFeedbackCommand', value);
  }, []);

  const setToastDuration = useCallback((value: number) => {
    setToastDurationState(value);
    window.maestro.settings.set('toastDuration', value);
  }, []);

  const setCheckForUpdatesOnStartup = useCallback((value: boolean) => {
    setCheckForUpdatesOnStartupState(value);
    window.maestro.settings.set('checkForUpdatesOnStartup', value);
  }, []);

  const setCrashReportingEnabled = useCallback((value: boolean) => {
    setCrashReportingEnabledState(value);
    window.maestro.settings.set('crashReportingEnabled', value);
  }, []);

  const setLogViewerSelectedLevels = useCallback((value: string[]) => {
    setLogViewerSelectedLevelsState(value);
    window.maestro.settings.set('logViewerSelectedLevels', value);
  }, []);

  const setCustomAICommands = useCallback((value: CustomAICommand[]) => {
    setCustomAICommandsState(value);
    window.maestro.settings.set('customAICommands', value);
  }, []);

  const setGlobalStats = useCallback((value: GlobalStats) => {
    setGlobalStatsState(value);
    window.maestro.settings.set('globalStats', value);
  }, []);

  // Update global stats by adding deltas to existing values
  const updateGlobalStats = useCallback((delta: Partial<GlobalStats>) => {
    setGlobalStatsState(prev => {
      const updated: GlobalStats = {
        totalSessions: prev.totalSessions + (delta.totalSessions || 0),
        totalMessages: prev.totalMessages + (delta.totalMessages || 0),
        totalInputTokens: prev.totalInputTokens + (delta.totalInputTokens || 0),
        totalOutputTokens: prev.totalOutputTokens + (delta.totalOutputTokens || 0),
        totalCacheReadTokens: prev.totalCacheReadTokens + (delta.totalCacheReadTokens || 0),
        totalCacheCreationTokens: prev.totalCacheCreationTokens + (delta.totalCacheCreationTokens || 0),
        totalCostUsd: prev.totalCostUsd + (delta.totalCostUsd || 0),
        totalActiveTimeMs: prev.totalActiveTimeMs + (delta.totalActiveTimeMs || 0),
      };
      window.maestro.settings.set('globalStats', updated);
      return updated;
    });
  }, []);

  const setAutoRunStats = useCallback((value: AutoRunStats) => {
    setAutoRunStatsState(value);
    window.maestro.settings.set('autoRunStats', value);
  }, []);

  // Import badge calculation from constants (moved inline to avoid circular dependency)
  const getBadgeLevelForTime = (cumulativeTimeMs: number): number => {
    // Time thresholds in milliseconds
    const MINUTE = 60 * 1000;
    const HOUR = 60 * MINUTE;
    const DAY = 24 * HOUR;
    const WEEK = 7 * DAY;
    const MONTH = 30 * DAY;

    const thresholds = [
      15 * MINUTE,     // Level 1: 15 minutes
      1 * HOUR,        // Level 2: 1 hour
      8 * HOUR,        // Level 3: 8 hours
      1 * DAY,         // Level 4: 1 day
      1 * WEEK,        // Level 5: 1 week
      1 * MONTH,       // Level 6: 1 month
      3 * MONTH,       // Level 7: 3 months
      6 * MONTH,       // Level 8: 6 months
      365 * DAY,       // Level 9: 1 year
      5 * 365 * DAY,   // Level 10: 5 years
      10 * 365 * DAY,  // Level 11: 10 years
    ];

    let level = 0;
    for (let i = 0; i < thresholds.length; i++) {
      if (cumulativeTimeMs >= thresholds[i]) {
        level = i + 1;
      } else {
        break;
      }
    }
    return level;
  };

  // Record an auto-run completion and check for new badges/records
  // NOTE: Cumulative time is tracked incrementally during the run via updateAutoRunProgress(),
  // so we don't add elapsedTimeMs to cumulative here - only check for longest run record and increment totalRuns
  const recordAutoRunComplete = useCallback((elapsedTimeMs: number): { newBadgeLevel: number | null; isNewRecord: boolean } => {
    let newBadgeLevel: number | null = null;
    let isNewRecord = false;

    setAutoRunStatsState(prev => {
      // Don't add to cumulative time - it was already added incrementally during the run
      // Just check current badge level in case a badge wasn't triggered during incremental updates
      const newBadgeLevelCalc = getBadgeLevelForTime(prev.cumulativeTimeMs);

      // Check if this would be a new badge (edge case: badge threshold crossed between updates)
      if (newBadgeLevelCalc > prev.lastBadgeUnlockLevel) {
        newBadgeLevel = newBadgeLevelCalc;
      }

      // Check if this is a new longest run record
      isNewRecord = elapsedTimeMs > prev.longestRunMs;

      // Build updated badge history if new badge unlocked
      let updatedBadgeHistory = prev.badgeHistory || [];
      if (newBadgeLevel !== null) {
        updatedBadgeHistory = [
          ...updatedBadgeHistory,
          { level: newBadgeLevel, unlockedAt: Date.now() }
        ];
      }

      const updated: AutoRunStats = {
        cumulativeTimeMs: prev.cumulativeTimeMs, // Already updated incrementally
        longestRunMs: isNewRecord ? elapsedTimeMs : prev.longestRunMs,
        longestRunTimestamp: isNewRecord ? Date.now() : prev.longestRunTimestamp,
        totalRuns: prev.totalRuns + 1,
        currentBadgeLevel: newBadgeLevelCalc,
        lastBadgeUnlockLevel: newBadgeLevel !== null ? newBadgeLevelCalc : prev.lastBadgeUnlockLevel,
        lastAcknowledgedBadgeLevel: prev.lastAcknowledgedBadgeLevel ?? 0,
        badgeHistory: updatedBadgeHistory,
      };

      window.maestro.settings.set('autoRunStats', updated);
      return updated;
    });

    return { newBadgeLevel, isNewRecord };
  }, []);

  // Track progress during an active auto-run (called periodically, e.g., every minute)
  // deltaMs is the time elapsed since the last call (NOT total elapsed time)
  // This updates cumulative time and longest run WITHOUT incrementing totalRuns
  // Returns badge/record info so caller can show standing ovation during run
  const updateAutoRunProgress = useCallback((deltaMs: number): { newBadgeLevel: number | null; isNewRecord: boolean } => {
    let newBadgeLevel: number | null = null;
    let isNewRecord = false;

    setAutoRunStatsState(prev => {
      // Add the delta to cumulative time
      const newCumulativeTime = prev.cumulativeTimeMs + deltaMs;
      const newBadgeLevelCalc = getBadgeLevelForTime(newCumulativeTime);

      // Check if this unlocks a new badge
      if (newBadgeLevelCalc > prev.lastBadgeUnlockLevel) {
        newBadgeLevel = newBadgeLevelCalc;
      }

      // Note: We don't update longestRunMs here because we don't know the total
      // run time yet. That's handled when the run completes.

      // Build updated badge history if new badge unlocked
      let updatedBadgeHistory = prev.badgeHistory || [];
      if (newBadgeLevel !== null) {
        updatedBadgeHistory = [
          ...updatedBadgeHistory,
          { level: newBadgeLevel, unlockedAt: Date.now() }
        ];
      }

      const updated: AutoRunStats = {
        cumulativeTimeMs: newCumulativeTime,
        longestRunMs: prev.longestRunMs, // Don't update until run completes
        longestRunTimestamp: prev.longestRunTimestamp,
        totalRuns: prev.totalRuns, // Don't increment - run not complete yet
        currentBadgeLevel: newBadgeLevelCalc,
        lastBadgeUnlockLevel: newBadgeLevel !== null ? newBadgeLevelCalc : prev.lastBadgeUnlockLevel,
        lastAcknowledgedBadgeLevel: prev.lastAcknowledgedBadgeLevel ?? 0,
        badgeHistory: updatedBadgeHistory,
      };

      window.maestro.settings.set('autoRunStats', updated);
      return updated;
    });

    return { newBadgeLevel, isNewRecord };
  }, []);

  // Acknowledge that user has seen the standing ovation for a badge level
  const acknowledgeBadge = useCallback((level: number) => {
    setAutoRunStatsState(prev => {
      const updated: AutoRunStats = {
        ...prev,
        lastAcknowledgedBadgeLevel: Math.max(level, prev.lastAcknowledgedBadgeLevel ?? 0),
      };
      window.maestro.settings.set('autoRunStats', updated);
      return updated;
    });
  }, []);

  // Get the highest unacknowledged badge level (if any)
  const getUnacknowledgedBadgeLevel = useCallback((): number | null => {
    const acknowledged = autoRunStats.lastAcknowledgedBadgeLevel ?? 0;
    const current = autoRunStats.currentBadgeLevel;
    if (current > acknowledged) {
      return current;
    }
    return null;
  }, [autoRunStats.lastAcknowledgedBadgeLevel, autoRunStats.currentBadgeLevel]);

  // UI collapse state setters
  const setUngroupedCollapsed = useCallback((value: boolean) => {
    setUngroupedCollapsedState(value);
    window.maestro.settings.set('ungroupedCollapsed', value);
  }, []);

  // Onboarding setters
  const setTourCompleted = useCallback((value: boolean) => {
    setTourCompletedState(value);
    window.maestro.settings.set('tourCompleted', value);
  }, []);

  const setFirstAutoRunCompleted = useCallback((value: boolean) => {
    setFirstAutoRunCompletedState(value);
    window.maestro.settings.set('firstAutoRunCompleted', value);
  }, []);

  // Onboarding Stats functions
  const setOnboardingStats = useCallback((value: OnboardingStats) => {
    setOnboardingStatsState(value);
    window.maestro.settings.set('onboardingStats', value);
  }, []);

  // Record when wizard is started
  const recordWizardStart = useCallback(() => {
    setOnboardingStatsState(prev => {
      const updated: OnboardingStats = {
        ...prev,
        wizardStartCount: prev.wizardStartCount + 1,
      };
      window.maestro.settings.set('onboardingStats', updated);
      return updated;
    });
  }, []);

  // Record when wizard is completed successfully
  const recordWizardComplete = useCallback((
    durationMs: number,
    conversationExchanges: number,
    phasesGenerated: number,
    tasksGenerated: number
  ) => {
    setOnboardingStatsState(prev => {
      const newCompletionCount = prev.wizardCompletionCount + 1;
      const newTotalDuration = prev.totalWizardDurationMs + durationMs;
      const newTotalExchanges = prev.totalConversationExchanges + conversationExchanges;
      const newTotalPhases = prev.totalPhasesGenerated + phasesGenerated;
      const newTotalTasks = prev.totalTasksGenerated + tasksGenerated;

      const updated: OnboardingStats = {
        ...prev,
        wizardCompletionCount: newCompletionCount,
        totalWizardDurationMs: newTotalDuration,
        averageWizardDurationMs: Math.round(newTotalDuration / newCompletionCount),
        lastWizardCompletedAt: Date.now(),

        // Conversation stats
        totalConversationExchanges: newTotalExchanges,
        totalConversationsCompleted: prev.totalConversationsCompleted + 1,
        averageConversationExchanges: newCompletionCount > 0
          ? Math.round((newTotalExchanges / newCompletionCount) * 10) / 10
          : 0,

        // Phase generation stats
        totalPhasesGenerated: newTotalPhases,
        averagePhasesPerWizard: newCompletionCount > 0
          ? Math.round((newTotalPhases / newCompletionCount) * 10) / 10
          : 0,
        totalTasksGenerated: newTotalTasks,
        averageTasksPerPhase: newTotalPhases > 0
          ? Math.round((newTotalTasks / newTotalPhases) * 10) / 10
          : 0,
      };
      window.maestro.settings.set('onboardingStats', updated);
      return updated;
    });
  }, []);

  // Record when wizard is abandoned (closed before completion)
  const recordWizardAbandon = useCallback(() => {
    setOnboardingStatsState(prev => {
      const updated: OnboardingStats = {
        ...prev,
        wizardAbandonCount: prev.wizardAbandonCount + 1,
      };
      window.maestro.settings.set('onboardingStats', updated);
      return updated;
    });
  }, []);

  // Record when wizard is resumed from saved state
  const recordWizardResume = useCallback(() => {
    setOnboardingStatsState(prev => {
      const updated: OnboardingStats = {
        ...prev,
        wizardResumeCount: prev.wizardResumeCount + 1,
      };
      window.maestro.settings.set('onboardingStats', updated);
      return updated;
    });
  }, []);

  // Record when tour is started
  const recordTourStart = useCallback(() => {
    setOnboardingStatsState(prev => {
      const updated: OnboardingStats = {
        ...prev,
        tourStartCount: prev.tourStartCount + 1,
      };
      window.maestro.settings.set('onboardingStats', updated);
      return updated;
    });
  }, []);

  // Record when tour is completed (all steps viewed)
  const recordTourComplete = useCallback((stepsViewed: number) => {
    setOnboardingStatsState(prev => {
      const newCompletionCount = prev.tourCompletionCount + 1;
      const newTotalStepsViewed = prev.tourStepsViewedTotal + stepsViewed;
      const totalTours = newCompletionCount + prev.tourSkipCount;

      const updated: OnboardingStats = {
        ...prev,
        tourCompletionCount: newCompletionCount,
        tourStepsViewedTotal: newTotalStepsViewed,
        averageTourStepsViewed: totalTours > 0
          ? Math.round((newTotalStepsViewed / totalTours) * 10) / 10
          : stepsViewed,
      };
      window.maestro.settings.set('onboardingStats', updated);
      return updated;
    });
  }, []);

  // Record when tour is skipped before completion
  const recordTourSkip = useCallback((stepsViewed: number) => {
    setOnboardingStatsState(prev => {
      const newSkipCount = prev.tourSkipCount + 1;
      const newTotalStepsViewed = prev.tourStepsViewedTotal + stepsViewed;
      const totalTours = prev.tourCompletionCount + newSkipCount;

      const updated: OnboardingStats = {
        ...prev,
        tourSkipCount: newSkipCount,
        tourStepsViewedTotal: newTotalStepsViewed,
        averageTourStepsViewed: totalTours > 0
          ? Math.round((newTotalStepsViewed / totalTours) * 10) / 10
          : stepsViewed,
      };
      window.maestro.settings.set('onboardingStats', updated);
      return updated;
    });
  }, []);

  // Get computed analytics for display
  const getOnboardingAnalytics = useCallback(() => {
    const totalWizardAttempts = onboardingStats.wizardStartCount;
    const totalTourAttempts = onboardingStats.tourStartCount;

    return {
      wizardCompletionRate: totalWizardAttempts > 0
        ? Math.round((onboardingStats.wizardCompletionCount / totalWizardAttempts) * 100)
        : 0,
      tourCompletionRate: totalTourAttempts > 0
        ? Math.round((onboardingStats.tourCompletionCount / totalTourAttempts) * 100)
        : 0,
      averageConversationExchanges: onboardingStats.averageConversationExchanges,
      averagePhasesPerWizard: onboardingStats.averagePhasesPerWizard,
    };
  }, [
    onboardingStats.wizardStartCount,
    onboardingStats.tourStartCount,
    onboardingStats.wizardCompletionCount,
    onboardingStats.tourCompletionCount,
    onboardingStats.averageConversationExchanges,
    onboardingStats.averagePhasesPerWizard,
  ]);

  // Leaderboard Registration setter
  const setLeaderboardRegistration = useCallback((value: LeaderboardRegistration | null) => {
    setLeaderboardRegistrationState(value);
    window.maestro.settings.set('leaderboardRegistration', value);
  }, []);

  // Computed property for checking if registered
  const isLeaderboardRegistered = useMemo(() => {
    return leaderboardRegistration !== null && leaderboardRegistration.emailConfirmed;
  }, [leaderboardRegistration]);

  // Web Interface settings setters
  const setWebInterfaceUseCustomPort = useCallback((value: boolean) => {
    setWebInterfaceUseCustomPortState(value);
    window.maestro.settings.set('webInterfaceUseCustomPort', value);
  }, []);

  const setWebInterfaceCustomPort = useCallback((value: number) => {
    // Store the value as-is during typing; validation happens on blur/submit
    setWebInterfaceCustomPortState(value);
    // Only persist valid port values
    if (value >= 1024 && value <= 65535) {
      window.maestro.settings.set('webInterfaceCustomPort', value);
    }
  }, []);

  // Load settings from electron-store on mount
  useEffect(() => {
    const loadSettings = async () => {
      const savedEnterToSendAI = await window.maestro.settings.get('enterToSendAI');
      const savedEnterToSendTerminal = await window.maestro.settings.get('enterToSendTerminal');
      const savedDefaultSaveToHistory = await window.maestro.settings.get('defaultSaveToHistory');
      const savedDefaultShowThinking = await window.maestro.settings.get('defaultShowThinking');

      const savedLlmProvider = await window.maestro.settings.get('llmProvider');
      const savedModelSlug = await window.maestro.settings.get('modelSlug');
      const savedApiKey = await window.maestro.settings.get('apiKey');
      const savedDefaultShell = await window.maestro.settings.get('defaultShell');
      const savedCustomShellPath = await window.maestro.settings.get('customShellPath');
      const savedShellArgs = await window.maestro.settings.get('shellArgs');
      const savedShellEnvVars = await window.maestro.settings.get('shellEnvVars');
      const savedGhPath = await window.maestro.settings.get('ghPath');
      const savedFontSize = await window.maestro.settings.get('fontSize');
      const savedFontFamily = await window.maestro.settings.get('fontFamily');
      const savedLeftSidebarWidth = await window.maestro.settings.get('leftSidebarWidth');
      const savedRightPanelWidth = await window.maestro.settings.get('rightPanelWidth');
      const savedMarkdownEditMode = await window.maestro.settings.get('markdownEditMode');
      const savedShowHiddenFiles = await window.maestro.settings.get('showHiddenFiles');
      const savedShortcuts = await window.maestro.settings.get('shortcuts');
      const savedActiveThemeId = await window.maestro.settings.get('activeThemeId');
      const savedCustomThemeColors = await window.maestro.settings.get('customThemeColors');
      const savedCustomThemeBaseId = await window.maestro.settings.get('customThemeBaseId');
      const savedTerminalWidth = await window.maestro.settings.get('terminalWidth');
      const savedLogLevel = await window.maestro.logger.getLogLevel();
      const savedMaxLogBuffer = await window.maestro.logger.getMaxLogBuffer();
      const savedMaxOutputLines = await window.maestro.settings.get('maxOutputLines');
      const savedOsNotificationsEnabled = await window.maestro.settings.get('osNotificationsEnabled');
      const savedAudioFeedbackEnabled = await window.maestro.settings.get('audioFeedbackEnabled');
      const savedAudioFeedbackCommand = await window.maestro.settings.get('audioFeedbackCommand');
      const savedToastDuration = await window.maestro.settings.get('toastDuration');
      const savedCheckForUpdatesOnStartup = await window.maestro.settings.get('checkForUpdatesOnStartup');
      const savedCrashReportingEnabled = await window.maestro.settings.get('crashReportingEnabled');
      const savedLogViewerSelectedLevels = await window.maestro.settings.get('logViewerSelectedLevels');
      const savedCustomAICommands = await window.maestro.settings.get('customAICommands');
      const savedGlobalStats = await window.maestro.settings.get('globalStats');
      const savedAutoRunStats = await window.maestro.settings.get('autoRunStats');
      const concurrentAutoRunTimeMigrationApplied = await window.maestro.settings.get('concurrentAutoRunTimeMigrationApplied');
      const savedUngroupedCollapsed = await window.maestro.settings.get('ungroupedCollapsed');
      const savedTourCompleted = await window.maestro.settings.get('tourCompleted');
      const savedFirstAutoRunCompleted = await window.maestro.settings.get('firstAutoRunCompleted');
      const savedOnboardingStats = await window.maestro.settings.get('onboardingStats');
      const savedLeaderboardRegistration = await window.maestro.settings.get('leaderboardRegistration');
      const savedWebInterfaceUseCustomPort = await window.maestro.settings.get('webInterfaceUseCustomPort');
      const savedWebInterfaceCustomPort = await window.maestro.settings.get('webInterfaceCustomPort');

      if (savedEnterToSendAI !== undefined) setEnterToSendAIState(savedEnterToSendAI as boolean);
      if (savedEnterToSendTerminal !== undefined) setEnterToSendTerminalState(savedEnterToSendTerminal as boolean);
      if (savedDefaultSaveToHistory !== undefined) setDefaultSaveToHistoryState(savedDefaultSaveToHistory as boolean);
      if (savedDefaultShowThinking !== undefined) setDefaultShowThinkingState(savedDefaultShowThinking as boolean);

      if (savedLlmProvider !== undefined) setLlmProviderState(savedLlmProvider as LLMProvider);
      if (savedModelSlug !== undefined) setModelSlugState(savedModelSlug as string);
      if (savedApiKey !== undefined) setApiKeyState(savedApiKey as string);
      if (savedDefaultShell !== undefined) setDefaultShellState(savedDefaultShell as string);
      if (savedCustomShellPath !== undefined) setCustomShellPathState(savedCustomShellPath as string);
      if (savedShellArgs !== undefined) setShellArgsState(savedShellArgs as string);
      if (savedShellEnvVars !== undefined) setShellEnvVarsState(savedShellEnvVars as Record<string, string>);
      if (savedGhPath !== undefined) setGhPathState(savedGhPath as string);
      if (savedFontSize !== undefined) setFontSizeState(savedFontSize as number);
      if (savedFontFamily !== undefined) setFontFamilyState(savedFontFamily as string);
      if (savedLeftSidebarWidth !== undefined) setLeftSidebarWidthState(Math.max(256, Math.min(600, savedLeftSidebarWidth as number)));
      if (savedRightPanelWidth !== undefined) setRightPanelWidthState(savedRightPanelWidth as number);
      if (savedMarkdownEditMode !== undefined) setMarkdownEditModeState(savedMarkdownEditMode as boolean);
      if (savedShowHiddenFiles !== undefined) setShowHiddenFilesState(savedShowHiddenFiles as boolean);
      if (savedActiveThemeId !== undefined) setActiveThemeIdState(savedActiveThemeId as ThemeId);
      if (savedCustomThemeColors !== undefined) setCustomThemeColorsState(savedCustomThemeColors as ThemeColors);
      if (savedCustomThemeBaseId !== undefined) setCustomThemeBaseIdState(savedCustomThemeBaseId as ThemeId);
      if (savedTerminalWidth !== undefined) setTerminalWidthState(savedTerminalWidth as number);
      if (savedLogLevel !== undefined) setLogLevelState(savedLogLevel);
      if (savedMaxLogBuffer !== undefined) setMaxLogBufferState(savedMaxLogBuffer);
      if (savedMaxOutputLines !== undefined) setMaxOutputLinesState(savedMaxOutputLines as number);
      if (savedOsNotificationsEnabled !== undefined) setOsNotificationsEnabledState(savedOsNotificationsEnabled as boolean);
      if (savedAudioFeedbackEnabled !== undefined) setAudioFeedbackEnabledState(savedAudioFeedbackEnabled as boolean);
      if (savedAudioFeedbackCommand !== undefined) setAudioFeedbackCommandState(savedAudioFeedbackCommand as string);
      if (savedToastDuration !== undefined) setToastDurationState(savedToastDuration as number);
      if (savedCheckForUpdatesOnStartup !== undefined) setCheckForUpdatesOnStartupState(savedCheckForUpdatesOnStartup as boolean);
      if (savedCrashReportingEnabled !== undefined) setCrashReportingEnabledState(savedCrashReportingEnabled as boolean);
      if (savedLogViewerSelectedLevels !== undefined) setLogViewerSelectedLevelsState(savedLogViewerSelectedLevels as string[]);

      // Merge saved shortcuts with defaults (in case new shortcuts were added)
      if (savedShortcuts !== undefined) {
        // Migration: Fix shortcuts that were recorded with macOS Alt+key special characters
        // On macOS, Alt+L produces '¬', Alt+P produces 'π', etc. These should be 'l', 'p', etc.
        const macAltCharMap: Record<string, string> = {
          '¬': 'l',  // Alt+L
          'π': 'p',  // Alt+P
          '†': 't',  // Alt+T
          '∫': 'b',  // Alt+B
          '∂': 'd',  // Alt+D
          'ƒ': 'f',  // Alt+F
          '©': 'g',  // Alt+G
          '˙': 'h',  // Alt+H
          'ˆ': 'i',  // Alt+I (circumflex)
          '∆': 'j',  // Alt+J
          '˚': 'k',  // Alt+K
          '¯': 'm',  // Alt+M (macron, though some keyboards differ)
          '˜': 'n',  // Alt+N
          'ø': 'o',  // Alt+O
          '®': 'r',  // Alt+R
          'ß': 's',  // Alt+S
          '√': 'v',  // Alt+V
          '∑': 'w',  // Alt+W
          '≈': 'x',  // Alt+X
          '¥': 'y',  // Alt+Y
          'Ω': 'z',  // Alt+Z
        };

        const migratedShortcuts: Record<string, Shortcut> = {};
        let needsMigration = false;

        for (const [id, shortcut] of Object.entries(savedShortcuts as Record<string, Shortcut>)) {
          const migratedKeys = shortcut.keys.map(key => {
            if (macAltCharMap[key]) {
              needsMigration = true;
              return macAltCharMap[key];
            }
            return key;
          });
          migratedShortcuts[id] = { ...shortcut, keys: migratedKeys };
        }

        // If migration was needed, save the corrected shortcuts
        if (needsMigration) {
          window.maestro.settings.set('shortcuts', migratedShortcuts);
        }

        // Merge: use default labels (in case they changed) but preserve user's custom keys
        const mergedShortcuts: Record<string, Shortcut> = {};
        for (const [id, defaultShortcut] of Object.entries(DEFAULT_SHORTCUTS)) {
          const savedShortcut = migratedShortcuts[id];
          mergedShortcuts[id] = {
            ...defaultShortcut,
            // Preserve user's custom keys if they exist
            keys: savedShortcut?.keys ?? defaultShortcut.keys,
          };
        }
        setShortcutsState(mergedShortcuts);
      }

      // Merge saved AI commands with defaults (ensure built-in commands always exist)
      if (savedCustomAICommands !== undefined && Array.isArray(savedCustomAICommands)) {
        // Start with defaults, then merge saved commands (by ID to avoid duplicates)
        const commandsById = new Map<string, CustomAICommand>();
        DEFAULT_AI_COMMANDS.forEach(cmd => commandsById.set(cmd.id, cmd));
        (savedCustomAICommands as CustomAICommand[]).forEach((cmd: CustomAICommand) => {
          // Migration: Skip old /synopsis command - it was renamed to /history which is now
          // a built-in command handled by Maestro directly (not a custom AI command)
          if (cmd.command === '/synopsis' || cmd.id === 'synopsis') {
            return;
          }
          // For built-in commands, merge to allow user edits but preserve isBuiltIn flag
          if (commandsById.has(cmd.id)) {
            const existing = commandsById.get(cmd.id)!;
            commandsById.set(cmd.id, { ...cmd, isBuiltIn: existing.isBuiltIn });
          } else {
            commandsById.set(cmd.id, cmd);
          }
        });
        setCustomAICommandsState(Array.from(commandsById.values()));
      }

      // Load global stats
      if (savedGlobalStats !== undefined) {
        setGlobalStatsState({ ...DEFAULT_GLOBAL_STATS, ...(savedGlobalStats as Partial<GlobalStats>) });
      }

      // Load auto-run stats
      if (savedAutoRunStats !== undefined) {
        let stats = { ...DEFAULT_AUTO_RUN_STATS, ...(savedAutoRunStats as Partial<AutoRunStats>) };

        // One-time migration: Add 3 hours to compensate for bug where concurrent Auto Runs
        // weren't being tallied correctly (fixed in v0.11.3)
        if (!concurrentAutoRunTimeMigrationApplied && stats.cumulativeTimeMs > 0) {
          const THREE_HOURS_MS = 3 * 60 * 60 * 1000;
          stats = {
            ...stats,
            cumulativeTimeMs: stats.cumulativeTimeMs + THREE_HOURS_MS,
          };
          window.maestro.settings.set('autoRunStats', stats);
          window.maestro.settings.set('concurrentAutoRunTimeMigrationApplied', true);
          console.log('[Settings] Applied concurrent Auto Run time migration: added 3 hours to cumulative time');
        }

        setAutoRunStatsState(stats);
      }

      // Load onboarding settings
      // UI collapse states
      if (savedUngroupedCollapsed !== undefined) setUngroupedCollapsedState(savedUngroupedCollapsed as boolean);

      if (savedTourCompleted !== undefined) setTourCompletedState(savedTourCompleted as boolean);
      if (savedFirstAutoRunCompleted !== undefined) setFirstAutoRunCompletedState(savedFirstAutoRunCompleted as boolean);

      // Load onboarding stats
      if (savedOnboardingStats !== undefined) {
        setOnboardingStatsState({ ...DEFAULT_ONBOARDING_STATS, ...(savedOnboardingStats as Partial<OnboardingStats>) });
      }

      // Load leaderboard registration
      if (savedLeaderboardRegistration !== undefined) {
        setLeaderboardRegistrationState(savedLeaderboardRegistration as LeaderboardRegistration | null);
      }

      // Load web interface settings
      if (savedWebInterfaceUseCustomPort !== undefined) setWebInterfaceUseCustomPortState(savedWebInterfaceUseCustomPort as boolean);
      if (savedWebInterfaceCustomPort !== undefined) setWebInterfaceCustomPortState(savedWebInterfaceCustomPort as number);

      // Mark settings as loaded
      setSettingsLoaded(true);
    };
    loadSettings();
  }, []);

  // Apply font size to HTML root element so rem-based Tailwind classes scale
  // Only apply after settings are loaded to prevent layout shift from default->saved font size
  useEffect(() => {
    if (settingsLoaded) {
      document.documentElement.style.fontSize = `${fontSize}px`;
    }
  }, [fontSize, settingsLoaded]);

  // PERF: Memoize return object to prevent unnecessary re-renders in consumers
  return useMemo(() => ({
    settingsLoaded,
    llmProvider,
    modelSlug,
    apiKey,
    setLlmProvider,
    setModelSlug,
    setApiKey,
    defaultShell,
    setDefaultShell,
    customShellPath,
    setCustomShellPath,
    shellArgs,
    setShellArgs,
    shellEnvVars,
    setShellEnvVars,
    ghPath,
    setGhPath,
    fontFamily,
    fontSize,
    setFontFamily,
    setFontSize,
    activeThemeId,
    setActiveThemeId,
    customThemeColors,
    setCustomThemeColors,
    customThemeBaseId,
    setCustomThemeBaseId,
    enterToSendAI,
    setEnterToSendAI,
    enterToSendTerminal,
    setEnterToSendTerminal,
    defaultSaveToHistory,
    setDefaultSaveToHistory,
    defaultShowThinking,
    setDefaultShowThinking,
    leftSidebarWidth,
    rightPanelWidth,
    markdownEditMode,
    setLeftSidebarWidth,
    setRightPanelWidth,
    setMarkdownEditMode,
    showHiddenFiles,
    setShowHiddenFiles,
    terminalWidth,
    setTerminalWidth,
    logLevel,
    setLogLevel,
    maxLogBuffer,
    setMaxLogBuffer,
    maxOutputLines,
    setMaxOutputLines,
    osNotificationsEnabled,
    setOsNotificationsEnabled,
    audioFeedbackEnabled,
    setAudioFeedbackEnabled,
    audioFeedbackCommand,
    setAudioFeedbackCommand,
    toastDuration,
    setToastDuration,
    checkForUpdatesOnStartup,
    setCheckForUpdatesOnStartup,
    crashReportingEnabled,
    setCrashReportingEnabled,
    logViewerSelectedLevels,
    setLogViewerSelectedLevels,
    shortcuts,
    setShortcuts,
    customAICommands,
    setCustomAICommands,
    globalStats,
    setGlobalStats,
    updateGlobalStats,
    autoRunStats,
    setAutoRunStats,
    recordAutoRunComplete,
    updateAutoRunProgress,
    acknowledgeBadge,
    getUnacknowledgedBadgeLevel,
    ungroupedCollapsed,
    setUngroupedCollapsed,
    tourCompleted,
    setTourCompleted,
    firstAutoRunCompleted,
    setFirstAutoRunCompleted,
    onboardingStats,
    setOnboardingStats,
    recordWizardStart,
    recordWizardComplete,
    recordWizardAbandon,
    recordWizardResume,
    recordTourStart,
    recordTourComplete,
    recordTourSkip,
    getOnboardingAnalytics,
    leaderboardRegistration,
    setLeaderboardRegistration,
    isLeaderboardRegistered,
    webInterfaceUseCustomPort,
    setWebInterfaceUseCustomPort,
    webInterfaceCustomPort,
    setWebInterfaceCustomPort,
  }), [
    // State values
    settingsLoaded,
    llmProvider,
    modelSlug,
    apiKey,
    defaultShell,
    customShellPath,
    shellArgs,
    shellEnvVars,
    ghPath,
    fontFamily,
    fontSize,
    activeThemeId,
    customThemeColors,
    customThemeBaseId,
    enterToSendAI,
    enterToSendTerminal,
    defaultSaveToHistory,
    defaultShowThinking,
    leftSidebarWidth,
    rightPanelWidth,
    markdownEditMode,
    showHiddenFiles,
    terminalWidth,
    logLevel,
    maxLogBuffer,
    maxOutputLines,
    osNotificationsEnabled,
    audioFeedbackEnabled,
    audioFeedbackCommand,
    toastDuration,
    checkForUpdatesOnStartup,
    crashReportingEnabled,
    logViewerSelectedLevels,
    shortcuts,
    customAICommands,
    globalStats,
    autoRunStats,
    ungroupedCollapsed,
    tourCompleted,
    firstAutoRunCompleted,
    onboardingStats,
    // Setter functions (stable via useCallback)
    setLlmProvider,
    setModelSlug,
    setApiKey,
    setDefaultShell,
    setCustomShellPath,
    setShellArgs,
    setShellEnvVars,
    setGhPath,
    setFontFamily,
    setFontSize,
    setActiveThemeId,
    setCustomThemeColors,
    setCustomThemeBaseId,
    setEnterToSendAI,
    setEnterToSendTerminal,
    setDefaultSaveToHistory,
    setDefaultShowThinking,
    setLeftSidebarWidth,
    setRightPanelWidth,
    setMarkdownEditMode,
    setShowHiddenFiles,
    setTerminalWidth,
    setLogLevel,
    setMaxLogBuffer,
    setMaxOutputLines,
    setOsNotificationsEnabled,
    setAudioFeedbackEnabled,
    setAudioFeedbackCommand,
    setToastDuration,
    setCheckForUpdatesOnStartup,
    setCrashReportingEnabled,
    setLogViewerSelectedLevels,
    setShortcuts,
    setCustomAICommands,
    setGlobalStats,
    updateGlobalStats,
    setAutoRunStats,
    recordAutoRunComplete,
    updateAutoRunProgress,
    acknowledgeBadge,
    getUnacknowledgedBadgeLevel,
    setUngroupedCollapsed,
    setTourCompleted,
    setFirstAutoRunCompleted,
    setOnboardingStats,
    recordWizardStart,
    recordWizardComplete,
    recordWizardAbandon,
    recordWizardResume,
    recordTourStart,
    recordTourComplete,
    recordTourSkip,
    getOnboardingAnalytics,
    leaderboardRegistration,
    setLeaderboardRegistration,
    isLeaderboardRegistered,
    webInterfaceUseCustomPort,
    setWebInterfaceUseCustomPort,
    webInterfaceCustomPort,
    setWebInterfaceCustomPort,
  ]);
}
