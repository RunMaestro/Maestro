import React, { useState, useEffect, useRef, memo } from 'react';
import { X, Key, Moon, Sun, Keyboard, Check, Terminal, Bell, Cpu, Settings, Palette, Sparkles, History, Download, Bug, Cloud, FolderSync, RotateCcw, Folder, ChevronDown, Plus, Trash2, Brain } from 'lucide-react';
import type { Theme, ThemeColors, ThemeId, Shortcut, ShellInfo, CustomAICommand, LLMProvider } from '../types';
import { CustomThemeBuilder } from './CustomThemeBuilder';
import { useLayerStack } from '../contexts/LayerStackContext';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { AICommandsPanel } from './AICommandsPanel';
import { SpecKitCommandsPanel } from './SpecKitCommandsPanel';
import { formatShortcutKeys } from '../utils/shortcutFormatter';
import { ToggleButtonGroup } from './ToggleButtonGroup';
import { SettingCheckbox } from './SettingCheckbox';
import { FontConfigurationPanel } from './FontConfigurationPanel';
import { NotificationsPanel } from './NotificationsPanel';

// Feature flags - set to true to enable dormant features
const FEATURE_FLAGS = {
  LLM_SETTINGS: false,  // LLM provider configuration (OpenRouter, Anthropic, Ollama)
};

// Environment Variables Editor - uses stable indices to prevent focus loss during key editing
interface EnvVarEntry {
  id: number;
  key: string;
  value: string;
}

interface EnvVarsEditorProps {
  envVars: Record<string, string>;
  setEnvVars: (vars: Record<string, string>) => void;
  theme: Theme;
}

function EnvVarsEditor({ envVars, setEnvVars, theme }: EnvVarsEditorProps) {
  // Convert object to array with stable IDs for editing
  const [entries, setEntries] = useState<EnvVarEntry[]>(() => {
    return Object.entries(envVars).map(([key, value], index) => ({
      id: index,
      key,
      value,
    }));
  });
  const [nextId, setNextId] = useState(Object.keys(envVars).length);

  // Sync entries back to parent when they change (but debounced to avoid focus issues)
  const commitChanges = (newEntries: EnvVarEntry[]) => {
    const newEnvVars: Record<string, string> = {};
    newEntries.forEach(entry => {
      if (entry.key.trim()) {
        newEnvVars[entry.key] = entry.value;
      }
    });
    setEnvVars(newEnvVars);
  };

  // Sync from parent when envVars changes externally (e.g., on modal open)
  useEffect(() => {
    const parentEntries = Object.entries(envVars);
    // Only reset if the keys/values actually differ
    const currentKeys = entries.filter(e => e.key.trim()).map(e => `${e.key}=${e.value}`).sort().join(',');
    const parentKeys = parentEntries.map(([k, v]) => `${k}=${v}`).sort().join(',');
    if (currentKeys !== parentKeys) {
      setEntries(parentEntries.map(([key, value], index) => ({
        id: index,
        key,
        value,
      })));
      setNextId(parentEntries.length);
    }
  }, [envVars]);

  const updateEntry = (id: number, field: 'key' | 'value', newValue: string) => {
    setEntries(prev => {
      const updated = prev.map(entry =>
        entry.id === id ? { ...entry, [field]: newValue } : entry
      );
      // Commit changes on every update for value field, but for key field
      // only commit valid keys to avoid issues with empty keys
      commitChanges(updated);
      return updated;
    });
  };

  const removeEntry = (id: number) => {
    setEntries(prev => {
      const updated = prev.filter(entry => entry.id !== id);
      commitChanges(updated);
      return updated;
    });
  };

  const addEntry = () => {
    // Generate a unique default key name
    let newKey = 'VAR';
    let counter = 1;
    const existingKeys = new Set(entries.map(e => e.key));
    while (existingKeys.has(newKey)) {
      newKey = `VAR_${counter}`;
      counter++;
    }
    setEntries(prev => [...prev, { id: nextId, key: newKey, value: '' }]);
    setNextId(prev => prev + 1);
  };

  return (
    <div>
      <label className="block text-xs opacity-60 mb-1">Environment Variables (optional)</label>
      <div className="space-y-2">
        {entries.map((entry) => (
          <div key={entry.id} className="flex gap-2 items-center">
            <input
              type="text"
              value={entry.key}
              onChange={(e) => updateEntry(entry.id, 'key', e.target.value)}
              placeholder="VARIABLE"
              className="flex-1 p-2 rounded border bg-transparent outline-none text-xs font-mono"
              style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
            />
            <span className="text-xs" style={{ color: theme.colors.textDim }}>=</span>
            <input
              type="text"
              value={entry.value}
              onChange={(e) => updateEntry(entry.id, 'value', e.target.value)}
              placeholder="value"
              className="flex-[2] p-2 rounded border bg-transparent outline-none text-xs font-mono"
              style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
            />
            <button
              onClick={() => removeEntry(entry.id)}
              className="p-2 rounded hover:bg-white/10 transition-colors"
              title="Remove variable"
              style={{ color: theme.colors.textDim }}
            >
              <Trash2 className="w-3 h-3" />
            </button>
          </div>
        ))}
        <button
          onClick={addEntry}
          className="flex items-center gap-1 px-2 py-1.5 rounded text-xs hover:bg-white/10 transition-colors"
          style={{ color: theme.colors.textDim }}
        >
          <Plus className="w-3 h-3" />
          Add Variable
        </button>
      </div>
      <p className="text-xs opacity-50 mt-1">
        Environment variables passed to every shell session.
      </p>
    </div>
  );
}

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  theme: Theme;
  themes: Record<string, Theme>;
  activeThemeId: ThemeId;
  setActiveThemeId: (id: ThemeId) => void;
  customThemeColors: ThemeColors;
  setCustomThemeColors: (colors: ThemeColors) => void;
  customThemeBaseId: ThemeId;
  setCustomThemeBaseId: (id: ThemeId) => void;
  llmProvider: LLMProvider;
  setLlmProvider: (provider: LLMProvider) => void;
  modelSlug: string;
  setModelSlug: (slug: string) => void;
  apiKey: string;
  setApiKey: (key: string) => void;
  shortcuts: Record<string, Shortcut>;
  setShortcuts: (shortcuts: Record<string, Shortcut>) => void;
  tabShortcuts: Record<string, Shortcut>;
  setTabShortcuts: (shortcuts: Record<string, Shortcut>) => void;
  fontFamily: string;
  setFontFamily: (font: string) => void;
  fontSize: number;
  setFontSize: (size: number) => void;
  terminalWidth: number;
  setTerminalWidth: (width: number) => void;
  logLevel: string;
  setLogLevel: (level: string) => void;
  maxLogBuffer: number;
  setMaxLogBuffer: (buffer: number) => void;
  maxOutputLines: number;
  setMaxOutputLines: (lines: number) => void;
  defaultShell: string;
  setDefaultShell: (shell: string) => void;
  customShellPath: string;
  setCustomShellPath: (path: string) => void;
  shellArgs: string;
  setShellArgs: (args: string) => void;
  shellEnvVars: Record<string, string>;
  setShellEnvVars: (vars: Record<string, string>) => void;
  ghPath: string;
  setGhPath: (path: string) => void;
  enterToSendAI: boolean;
  setEnterToSendAI: (value: boolean) => void;
  enterToSendTerminal: boolean;
  setEnterToSendTerminal: (value: boolean) => void;
  defaultSaveToHistory: boolean;
  setDefaultSaveToHistory: (value: boolean) => void;
  defaultShowThinking: boolean;
  setDefaultShowThinking: (value: boolean) => void;
  osNotificationsEnabled: boolean;
  setOsNotificationsEnabled: (value: boolean) => void;
  audioFeedbackEnabled: boolean;
  setAudioFeedbackEnabled: (value: boolean) => void;
  audioFeedbackCommand: string;
  setAudioFeedbackCommand: (value: string) => void;
  toastDuration: number;
  setToastDuration: (value: number) => void;
  checkForUpdatesOnStartup: boolean;
  setCheckForUpdatesOnStartup: (value: boolean) => void;
  crashReportingEnabled: boolean;
  setCrashReportingEnabled: (value: boolean) => void;
  customAICommands: CustomAICommand[];
  setCustomAICommands: (commands: CustomAICommand[]) => void;
  initialTab?: 'general' | 'llm' | 'shortcuts' | 'theme' | 'notifications' | 'aicommands';
  hasNoAgents?: boolean;
  onThemeImportError?: (message: string) => void;
  onThemeImportSuccess?: (message: string) => void;
}

export const SettingsModal = memo(function SettingsModal(props: SettingsModalProps) {
  const { isOpen, onClose, theme, themes, initialTab } = props;
  const [activeTab, setActiveTab] = useState<'general' | 'llm' | 'shortcuts' | 'theme' | 'notifications' | 'aicommands'>('general');
  const [systemFonts, setSystemFonts] = useState<string[]>([]);
  const [customFonts, setCustomFonts] = useState<string[]>([]);
  const [fontLoading, setFontLoading] = useState(false);
  const [fontsLoaded, setFontsLoaded] = useState(false);
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const [shortcutsFilter, setShortcutsFilter] = useState('');
  const [testingLLM, setTestingLLM] = useState(false);
  const [testResult, setTestResult] = useState<{ status: 'success' | 'error' | null; message: string }>({ status: null, message: '' });
  const [shells, setShells] = useState<ShellInfo[]>([]);
  const [shellsLoading, setShellsLoading] = useState(false);
  const [shellsLoaded, setShellsLoaded] = useState(false);
  const [shellConfigExpanded, setShellConfigExpanded] = useState(false);

  // Sync/storage location state
  const [defaultStoragePath, setDefaultStoragePath] = useState<string>('');
  const [currentStoragePath, setCurrentStoragePath] = useState<string>('');
  const [customSyncPath, setCustomSyncPath] = useState<string | undefined>(undefined);
  const [syncRestartRequired, setSyncRestartRequired] = useState(false);
  const [syncMigrating, setSyncMigrating] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [syncMigratedCount, setSyncMigratedCount] = useState<number | null>(null);

  // Layer stack integration
  const { registerLayer, unregisterLayer, updateLayerHandler } = useLayerStack();
  const layerIdRef = useRef<string>();
  const shortcutsFilterRef = useRef<HTMLInputElement>(null);
  const themePickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isOpen) {
      // Don't load fonts immediately - only when user interacts with font selector
      // Set initial tab if provided, otherwise default to 'general'
      setActiveTab(initialTab || 'general');

      // Load sync settings
      Promise.all([
        window.maestro.sync.getDefaultPath(),
        window.maestro.sync.getSettings(),
        window.maestro.sync.getCurrentStoragePath(),
      ]).then(([defaultPath, settings, currentPath]) => {
        setDefaultStoragePath(defaultPath);
        setCustomSyncPath(settings.customSyncPath);
        setCurrentStoragePath(currentPath);
        setSyncRestartRequired(false);
        setSyncError(null);
        setSyncMigratedCount(null);
      }).catch((err) => {
        console.error('Failed to load sync settings:', err);
        setSyncError('Failed to load storage settings');
      });
    }
  }, [isOpen, initialTab]);

  // Store onClose in a ref to avoid re-registering layer when onClose changes
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Register layer when modal opens
  useEffect(() => {
    if (!isOpen) return;

    const id = registerLayer({
      type: 'modal',
      priority: MODAL_PRIORITIES.SETTINGS,
      blocksLowerLayers: true,
      capturesFocus: true,
      focusTrap: 'strict',
      ariaLabel: 'Settings',
      onEscape: () => {
        // If recording a shortcut, cancel recording instead of closing modal
        if (recordingId) {
          setRecordingId(null);
        } else {
          onCloseRef.current();
        }
      }
    });

    layerIdRef.current = id;

    return () => {
      if (layerIdRef.current) {
        unregisterLayer(layerIdRef.current);
      }
    };
  }, [isOpen, registerLayer, unregisterLayer]); // Removed onClose from deps

  // Update handler when dependencies change
  useEffect(() => {
    if (!isOpen || !layerIdRef.current) return;

    updateLayerHandler(layerIdRef.current, () => {
      // If recording a shortcut, cancel recording instead of closing modal
      if (recordingId) {
        setRecordingId(null);
      } else {
        onCloseRef.current();
      }
    });
  }, [isOpen, recordingId, updateLayerHandler]); // Use ref for onClose

  // Tab navigation with Cmd+Shift+[ and ]
  useEffect(() => {
    if (!isOpen) return;

    const handleTabNavigation = (e: KeyboardEvent) => {
      const tabs: Array<'general' | 'llm' | 'shortcuts' | 'theme' | 'notifications' | 'aicommands'> = FEATURE_FLAGS.LLM_SETTINGS
        ? ['general', 'llm', 'shortcuts', 'theme', 'notifications', 'aicommands']
        : ['general', 'shortcuts', 'theme', 'notifications', 'aicommands'];
      const currentIndex = tabs.indexOf(activeTab);

      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === '[') {
        e.preventDefault();
        const prevIndex = currentIndex === 0 ? tabs.length - 1 : currentIndex - 1;
        setActiveTab(tabs[prevIndex]);
      } else if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === ']') {
        e.preventDefault();
        const nextIndex = (currentIndex + 1) % tabs.length;
        setActiveTab(tabs[nextIndex]);
      }
    };

    window.addEventListener('keydown', handleTabNavigation);
    return () => window.removeEventListener('keydown', handleTabNavigation);
  }, [isOpen, activeTab]);

  // Focus theme picker when theme tab becomes active
  useEffect(() => {
    if (isOpen && activeTab === 'theme') {
      const timer = setTimeout(() => themePickerRef.current?.focus(), 50);
      return () => clearTimeout(timer);
    }
  }, [isOpen, activeTab]);

  // Auto-focus shortcuts filter when switching to shortcuts tab
  useEffect(() => {
    if (isOpen && activeTab === 'shortcuts') {
      // Small delay to ensure DOM is ready
      setTimeout(() => shortcutsFilterRef.current?.focus(), 50);
    }
  }, [isOpen, activeTab]);

  const loadFonts = async () => {
    if (fontsLoaded) return; // Don't reload if already loaded

    setFontLoading(true);
    try {
      const detected = await window.maestro.fonts.detect();
      setSystemFonts(detected);

      const savedCustomFonts = await window.maestro.settings.get('customFonts') as string[] | undefined;
      if (savedCustomFonts && Array.isArray(savedCustomFonts)) {
        setCustomFonts(savedCustomFonts);
      }
      setFontsLoaded(true);
    } catch (error) {
      console.error('Failed to load fonts:', error);
    } finally {
      setFontLoading(false);
    }
  };

  const handleFontInteraction = () => {
    if (!fontsLoaded && !fontLoading) {
      loadFonts();
    }
  };

  const loadShells = async () => {
    if (shellsLoaded) return; // Don't reload if already loaded

    setShellsLoading(true);
    try {
      const detected = await window.maestro.shells.detect();
      setShells(detected);
      setShellsLoaded(true);
    } catch (error) {
      console.error('Failed to load shells:', error);
    } finally {
      setShellsLoading(false);
    }
  };

  const handleShellInteraction = () => {
    if (!shellsLoaded && !shellsLoading) {
      loadShells();
    }
  };

  const addCustomFont = (font: string) => {
    if (font && !customFonts.includes(font)) {
      const newCustomFonts = [...customFonts, font];
      setCustomFonts(newCustomFonts);
      window.maestro.settings.set('customFonts', newCustomFonts);
    }
  };

  const removeCustomFont = (font: string) => {
    const newCustomFonts = customFonts.filter(f => f !== font);
    setCustomFonts(newCustomFonts);
    window.maestro.settings.set('customFonts', newCustomFonts);
  };

  const testLLMConnection = async () => {
    setTestingLLM(true);
    setTestResult({ status: null, message: '' });

    try {
      let response;
      const testPrompt = 'Respond with exactly: "Connection successful"';

      if (props.llmProvider === 'openrouter') {
        if (!props.apiKey) {
          throw new Error('API key is required for OpenRouter');
        }

        response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${props.apiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://maestro.local',
          },
          body: JSON.stringify({
            model: props.modelSlug || 'anthropic/claude-3.5-sonnet',
            messages: [{ role: 'user', content: testPrompt }],
            max_tokens: 50,
          }),
        });

        if (!response.ok) {
          const error = await response.json();
          throw new Error(error.error?.message || `OpenRouter API error: ${response.status}`);
        }

        const data = await response.json();
        if (!data.choices?.[0]?.message?.content) {
          throw new Error('Invalid response from OpenRouter');
        }

        setTestResult({
          status: 'success',
          message: 'Successfully connected to OpenRouter!',
        });
      } else if (props.llmProvider === 'anthropic') {
        if (!props.apiKey) {
          throw new Error('API key is required for Anthropic');
        }

        response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'x-api-key': props.apiKey,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: props.modelSlug || 'claude-3-5-sonnet-20241022',
            max_tokens: 50,
            messages: [{ role: 'user', content: testPrompt }],
          }),
        });

        if (!response.ok) {
          const error = await response.json();
          throw new Error(error.error?.message || `Anthropic API error: ${response.status}`);
        }

        const data = await response.json();
        if (!data.content?.[0]?.text) {
          throw new Error('Invalid response from Anthropic');
        }

        setTestResult({
          status: 'success',
          message: 'Successfully connected to Anthropic!',
        });
      } else if (props.llmProvider === 'ollama') {
        response = await fetch('http://localhost:11434/api/generate', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: props.modelSlug || 'llama3:latest',
            prompt: testPrompt,
            stream: false,
          }),
        });

        if (!response.ok) {
          throw new Error(`Ollama API error: ${response.status}. Make sure Ollama is running locally.`);
        }

        const data = await response.json();
        if (!data.response) {
          throw new Error('Invalid response from Ollama');
        }

        setTestResult({
          status: 'success',
          message: 'Successfully connected to Ollama!',
        });
      }
    } catch (error: any) {
      setTestResult({
        status: 'error',
        message: error.message || 'Connection failed',
      });
    } finally {
      setTestingLLM(false);
    }
  };

  const handleRecord = (e: React.KeyboardEvent, actionId: string, isTabShortcut: boolean = false) => {
    e.preventDefault();
    e.stopPropagation();

    // Escape cancels recording without saving
    if (e.key === 'Escape') {
      setRecordingId(null);
      return;
    }

    const keys = [];
    if (e.metaKey) keys.push('Meta');
    if (e.ctrlKey) keys.push('Ctrl');
    if (e.altKey) keys.push('Alt');
    if (e.shiftKey) keys.push('Shift');
    if (['Meta', 'Control', 'Alt', 'Shift'].includes(e.key)) return;

    // On macOS, Alt+letter produces special characters (e.g., Alt+L = ¬, Alt+P = π)
    // Use e.code to get the physical key name when Alt is pressed
    let mainKey = e.key;
    if (e.altKey && e.code) {
      // e.code is like 'KeyL', 'KeyP', 'Digit1', etc.
      if (e.code.startsWith('Key')) {
        mainKey = e.code.replace('Key', '').toLowerCase();
      } else if (e.code.startsWith('Digit')) {
        mainKey = e.code.replace('Digit', '');
      } else {
        // For other keys like Arrow keys, use as-is
        mainKey = e.key;
      }
    }
    keys.push(mainKey);

    if (isTabShortcut) {
      props.setTabShortcuts({
        ...props.tabShortcuts,
        [actionId]: { ...props.tabShortcuts[actionId], keys }
      });
    } else {
      props.setShortcuts({
        ...props.shortcuts,
        [actionId]: { ...props.shortcuts[actionId], keys }
      });
    }
    setRecordingId(null);
  };

  if (!isOpen) return null;

  // Group themes by mode for the ThemePicker (exclude 'custom' theme - it's handled separately)
  const groupedThemes = Object.values(themes).reduce((acc: Record<string, Theme[]>, t: Theme) => {
    if (t.id === 'custom') return acc; // Skip custom theme in regular grouping
    if (!acc[t.mode]) acc[t.mode] = [];
    acc[t.mode].push(t);
    return acc;
  }, {} as Record<string, Theme[]>);

  const handleThemePickerKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      e.stopPropagation();
      // Create ordered array: dark themes first, then light, then vibe, then custom (cycling back to dark)
      const allThemes = [...(groupedThemes['dark'] || []), ...(groupedThemes['light'] || []), ...(groupedThemes['vibe'] || [])];
      // Add 'custom' as the last item in the cycle
      const allThemeIds = [...allThemes.map(t => t.id), 'custom'];
      const currentIndex = allThemeIds.findIndex((id: string) => id === props.activeThemeId);

      let newThemeId: string;
      if (e.shiftKey) {
        // Shift+Tab: go backwards
        const prevIndex = currentIndex === 0 ? allThemeIds.length - 1 : currentIndex - 1;
        newThemeId = allThemeIds[prevIndex];
      } else {
        // Tab: go forward
        const nextIndex = (currentIndex + 1) % allThemeIds.length;
        newThemeId = allThemeIds[nextIndex];
      }
      props.setActiveThemeId(newThemeId as ThemeId);

      // Scroll the newly selected theme button into view
      setTimeout(() => {
        const themeButton = themePickerRef.current?.querySelector(`[data-theme-id="${newThemeId}"]`);
        themeButton?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }, 0);
    }
  };

  // Theme picker JSX (not a separate component to avoid remount issues)
  const themePickerContent = (
    <div
      ref={themePickerRef}
      className="space-y-6 outline-none"
      tabIndex={0}
      onKeyDown={handleThemePickerKeyDown}
    >
      {['dark', 'light', 'vibe'].map(mode => (
        <div key={mode}>
          <div className="text-xs font-bold uppercase mb-3 flex items-center gap-2" style={{ color: theme.colors.textDim }}>
            {mode === 'dark' ? <Moon className="w-3 h-3" /> : mode === 'light' ? <Sun className="w-3 h-3" /> : <Sparkles className="w-3 h-3" />}
            {mode} Mode
          </div>
          <div className="grid grid-cols-2 gap-3">
            {groupedThemes[mode]?.map((t: Theme) => (
              <button
                key={t.id}
                data-theme-id={t.id}
                onClick={() => props.setActiveThemeId(t.id)}
                className={`p-3 rounded-lg border text-left transition-all ${props.activeThemeId === t.id ? 'ring-2' : ''}`}
                style={{
                  borderColor: theme.colors.border,
                  backgroundColor: t.colors.bgSidebar,
                  '--tw-ring-color': t.colors.accent
                } as React.CSSProperties}
                tabIndex={-1}
              >
                <div className="flex justify-between items-center mb-2">
                  <span className="text-sm font-bold" style={{ color: t.colors.textMain }}>{t.name}</span>
                  {props.activeThemeId === t.id && <Check className="w-4 h-4" style={{ color: t.colors.accent }} />}
                </div>
                <div className="flex h-3 rounded overflow-hidden">
                  <div className="flex-1" style={{ backgroundColor: t.colors.bgMain }} />
                  <div className="flex-1" style={{ backgroundColor: t.colors.bgActivity }} />
                  <div className="flex-1" style={{ backgroundColor: t.colors.accent }} />
                </div>
              </button>
            ))}
          </div>
        </div>
      ))}

      {/* Custom Theme Builder */}
      <div data-theme-id="custom">
        <CustomThemeBuilder
          theme={theme}
          customThemeColors={props.customThemeColors}
          setCustomThemeColors={props.setCustomThemeColors}
          customThemeBaseId={props.customThemeBaseId}
          setCustomThemeBaseId={props.setCustomThemeBaseId}
          isSelected={props.activeThemeId === 'custom'}
          onSelect={() => props.setActiveThemeId('custom')}
          onImportError={props.onThemeImportError}
          onImportSuccess={props.onThemeImportSuccess}
        />
      </div>
    </div>
  );

  return (
    <div
      className="fixed inset-0 modal-overlay flex items-center justify-center z-[9999]"
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
    >
      <div className="w-[650px] h-[600px] rounded-xl border shadow-2xl overflow-hidden flex flex-col"
           style={{ backgroundColor: theme.colors.bgSidebar, borderColor: theme.colors.border }}>

        <div className="flex border-b" style={{ borderColor: theme.colors.border }}>
          <button onClick={() => setActiveTab('general')} className={`px-4 py-4 text-sm font-bold border-b-2 ${activeTab === 'general' ? 'border-indigo-500' : 'border-transparent'} flex items-center gap-2`} tabIndex={-1} title="General">
            <Settings className="w-4 h-4" />
            {activeTab === 'general' && <span>General</span>}
          </button>
          {FEATURE_FLAGS.LLM_SETTINGS && (
            <button onClick={() => setActiveTab('llm')} className={`px-4 py-4 text-sm font-bold border-b-2 ${activeTab === 'llm' ? 'border-indigo-500' : 'border-transparent'}`} tabIndex={-1} title="LLM">LLM</button>
          )}
          <button onClick={() => setActiveTab('shortcuts')} className={`px-4 py-4 text-sm font-bold border-b-2 ${activeTab === 'shortcuts' ? 'border-indigo-500' : 'border-transparent'} flex items-center gap-2`} tabIndex={-1} title="Shortcuts">
            <Keyboard className="w-4 h-4" />
            {activeTab === 'shortcuts' && <span>Shortcuts</span>}
          </button>
          <button onClick={() => setActiveTab('theme')} className={`px-4 py-4 text-sm font-bold border-b-2 ${activeTab === 'theme' ? 'border-indigo-500' : 'border-transparent'} flex items-center gap-2`} tabIndex={-1} title="Themes">
            <Palette className="w-4 h-4" />
            {activeTab === 'theme' && <span>Themes</span>}
          </button>
          <button onClick={() => setActiveTab('notifications')} className={`px-4 py-4 text-sm font-bold border-b-2 ${activeTab === 'notifications' ? 'border-indigo-500' : 'border-transparent'} flex items-center gap-2`} tabIndex={-1} title="Notifications">
            <Bell className="w-4 h-4" />
            {activeTab === 'notifications' && <span>Notify</span>}
          </button>
          <button onClick={() => setActiveTab('aicommands')} className={`px-4 py-4 text-sm font-bold border-b-2 ${activeTab === 'aicommands' ? 'border-indigo-500' : 'border-transparent'} flex items-center gap-2`} tabIndex={-1} title="AI Commands">
            <Cpu className="w-4 h-4" />
            {activeTab === 'aicommands' && <span>AI Commands</span>}
          </button>
          <div className="flex-1 flex justify-end items-center pr-4">
            <button onClick={onClose} tabIndex={-1}><X className="w-5 h-5 opacity-50 hover:opacity-100" /></button>
          </div>
        </div>

        <div className="flex-1 p-6 overflow-y-auto scrollbar-thin">
          {activeTab === 'general' && (
            <div className="space-y-5">
              {/* Font Family */}
              <FontConfigurationPanel
                fontFamily={props.fontFamily}
                setFontFamily={props.setFontFamily}
                systemFonts={systemFonts}
                fontsLoaded={fontsLoaded}
                fontLoading={fontLoading}
                customFonts={customFonts}
                onAddCustomFont={addCustomFont}
                onRemoveCustomFont={removeCustomFont}
                onFontInteraction={handleFontInteraction}
                theme={theme}
              />

              {/* Font Size */}
              <div>
                <label className="block text-xs font-bold opacity-70 uppercase mb-2">Font Size</label>
                <ToggleButtonGroup
                  options={[
                    { value: 12, label: 'Small' },
                    { value: 14, label: 'Medium' },
                    { value: 16, label: 'Large' },
                    { value: 18, label: 'X-Large' },
                  ]}
                  value={props.fontSize}
                  onChange={props.setFontSize}
                  theme={theme}
                />
              </div>

              {/* Terminal Width */}
              <div>
                <label className="block text-xs font-bold opacity-70 uppercase mb-2">Terminal Width (Columns)</label>
                <ToggleButtonGroup
                  options={[80, 100, 120, 160]}
                  value={props.terminalWidth}
                  onChange={props.setTerminalWidth}
                  theme={theme}
                />
              </div>

              {/* Log Level */}
              <div>
                <label className="block text-xs font-bold opacity-70 uppercase mb-2">System Log Level</label>
                <ToggleButtonGroup
                  options={[
                    { value: 'debug', label: 'Debug', activeColor: '#6366f1' },
                    { value: 'info', label: 'Info', activeColor: '#3b82f6' },
                    { value: 'warn', label: 'Warn', activeColor: '#f59e0b' },
                    { value: 'error', label: 'Error', activeColor: '#ef4444' },
                  ]}
                  value={props.logLevel}
                  onChange={props.setLogLevel}
                  theme={theme}
                />
                <p className="text-xs opacity-50 mt-2">
                  Higher levels show fewer logs. Debug shows all logs, Error shows only errors.
                </p>
              </div>

              {/* Max Log Buffer */}
              <div>
                <label className="block text-xs font-bold opacity-70 uppercase mb-2">Maximum Log Buffer</label>
                <ToggleButtonGroup
                  options={[1000, 5000, 10000, 25000]}
                  value={props.maxLogBuffer}
                  onChange={props.setMaxLogBuffer}
                  theme={theme}
                />
                <p className="text-xs opacity-50 mt-2">
                  Maximum number of log messages to keep in memory. Older logs are automatically removed.
                </p>
              </div>

              {/* Max Output Lines */}
              <div>
                <label className="block text-xs font-bold opacity-70 uppercase mb-2">Max Output Lines per Response</label>
                <ToggleButtonGroup
                  options={[
                    { value: 15 },
                    { value: 25 },
                    { value: 50 },
                    { value: 100 },
                    { value: Infinity, label: 'All' },
                  ]}
                  value={props.maxOutputLines}
                  onChange={props.setMaxOutputLines}
                  theme={theme}
                />
                <p className="text-xs opacity-50 mt-2">
                  Long outputs will be collapsed into a scrollable window. Set to "All" to always show full output.
                </p>
              </div>

              {/* Default Shell */}
              <div>
                <label className="block text-xs font-bold opacity-70 uppercase mb-1 flex items-center gap-2">
                  <Terminal className="w-3 h-3" />
                  Default Terminal Shell
                </label>
                <p className="text-xs opacity-50 mb-2">
                  Choose which shell to use for terminal sessions. Select any shell and configure a custom path if needed.
                </p>
                {shellsLoading ? (
                  <div className="text-sm opacity-50 p-2">Loading shells...</div>
                ) : (
                  <div className="space-y-2">
                    {shellsLoaded && shells.length > 0 ? (
                      shells.map((shell) => (
                        <button
                          key={shell.id}
                          onClick={() => {
                            props.setDefaultShell(shell.id);
                            // Auto-expand shell config when selecting an unavailable shell
                            if (!shell.available) {
                              setShellConfigExpanded(true);
                            }
                          }}
                          onMouseEnter={handleShellInteraction}
                          onFocus={handleShellInteraction}
                          className={`w-full text-left p-3 rounded border transition-all ${
                            props.defaultShell === shell.id ? 'ring-2' : ''
                          } hover:bg-opacity-10`}
                          style={{
                            borderColor: theme.colors.border,
                            backgroundColor: props.defaultShell === shell.id ? theme.colors.accentDim : theme.colors.bgMain,
                            '--tw-ring-color': theme.colors.accent,
                            color: theme.colors.textMain,
                          } as React.CSSProperties}
                        >
                          <div className="flex items-center justify-between">
                            <div>
                              <div className="font-medium">{shell.name}</div>
                              {shell.path && (
                                <div className="text-xs opacity-50 font-mono mt-1">{shell.path}</div>
                              )}
                            </div>
                            {shell.available ? (
                              props.defaultShell === shell.id ? (
                                <Check className="w-4 h-4" style={{ color: theme.colors.accent }} />
                              ) : (
                                <span className="text-xs px-2 py-0.5 rounded" style={{ backgroundColor: theme.colors.success + '20', color: theme.colors.success }}>
                                  Available
                                </span>
                              )
                            ) : (
                              props.defaultShell === shell.id ? (
                                <div className="flex items-center gap-2">
                                  <span className="text-xs px-2 py-0.5 rounded" style={{ backgroundColor: theme.colors.warning + '20', color: theme.colors.warning }}>
                                    Custom Path Required
                                  </span>
                                  <Check className="w-4 h-4" style={{ color: theme.colors.accent }} />
                                </div>
                              ) : (
                                <span className="text-xs px-2 py-0.5 rounded" style={{ backgroundColor: theme.colors.warning + '20', color: theme.colors.warning }}>
                                  Not Found
                                </span>
                              )
                            )}
                          </div>
                        </button>
                      ))
                    ) : (
                      /* Show current default shell before detection runs */
                      <div className="space-y-2">
                        <button
                          className="w-full text-left p-3 rounded border ring-2"
                          style={{
                            borderColor: theme.colors.border,
                            backgroundColor: theme.colors.accentDim,
                            '--tw-ring-color': theme.colors.accent,
                            color: theme.colors.textMain,
                          } as React.CSSProperties}
                        >
                          <div className="flex items-center justify-between">
                            <div>
                              <div className="font-medium">{props.defaultShell.charAt(0).toUpperCase() + props.defaultShell.slice(1)}</div>
                              <div className="text-xs opacity-50 font-mono mt-1">Current default</div>
                            </div>
                            <Check className="w-4 h-4" style={{ color: theme.colors.accent }} />
                          </div>
                        </button>
                        <button
                          onClick={handleShellInteraction}
                          className="w-full text-left p-3 rounded border hover:bg-white/5 transition-colors"
                          style={{
                            borderColor: theme.colors.border,
                            backgroundColor: theme.colors.bgMain,
                            color: theme.colors.textDim,
                          }}
                        >
                          <div className="flex items-center gap-2">
                            <Terminal className="w-4 h-4" />
                            <span>Detect other available shells...</span>
                          </div>
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {/* Shell Configuration Expandable Section */}
                <button
                  onClick={() => setShellConfigExpanded(!shellConfigExpanded)}
                  className="w-full flex items-center justify-between p-3 rounded border mt-3 hover:bg-white/5 transition-colors"
                  style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
                >
                  <span className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
                    Shell Configuration
                  </span>
                  <ChevronDown
                    className={`w-4 h-4 transition-transform ${shellConfigExpanded ? 'rotate-180' : ''}`}
                    style={{ color: theme.colors.textDim }}
                  />
                </button>

                {shellConfigExpanded && (
                  <div className="mt-2 space-y-3 p-3 rounded border" style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgActivity }}>
                    {/* Custom Shell Path */}
                    <div>
                      <label className="block text-xs opacity-60 mb-1">Custom Path (optional)</label>
                      <div className="flex gap-2">
                        <input
                          type="text"
                          value={props.customShellPath}
                          onChange={(e) => props.setCustomShellPath(e.target.value)}
                          placeholder="/path/to/shell"
                          className="flex-1 p-2 rounded border bg-transparent outline-none text-sm font-mono"
                          style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
                        />
                        {props.customShellPath && (
                          <button
                            onClick={() => props.setCustomShellPath('')}
                            className="px-2 py-1.5 rounded text-xs"
                            style={{ backgroundColor: theme.colors.bgMain, color: theme.colors.textDim }}
                          >
                            Clear
                          </button>
                        )}
                      </div>
                      <p className="text-xs opacity-50 mt-1">
                        Override the auto-detected shell path. Leave empty to use the detected path.
                      </p>
                    </div>

                    {/* Shell Arguments */}
                    <div>
                      <label className="block text-xs opacity-60 mb-1">Additional Arguments (optional)</label>
                      <div className="flex gap-2">
                        <input
                          type="text"
                          value={props.shellArgs}
                          onChange={(e) => props.setShellArgs(e.target.value)}
                          placeholder="--flag value"
                          className="flex-1 p-2 rounded border bg-transparent outline-none text-sm font-mono"
                          style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
                        />
                        {props.shellArgs && (
                          <button
                            onClick={() => props.setShellArgs('')}
                            className="px-2 py-1.5 rounded text-xs"
                            style={{ backgroundColor: theme.colors.bgMain, color: theme.colors.textDim }}
                          >
                            Clear
                          </button>
                        )}
                      </div>
                      <p className="text-xs opacity-50 mt-1">
                        Additional CLI arguments passed to every shell session (e.g., --login, -c).
                      </p>
                    </div>

                    {/* Shell Environment Variables */}
                    <EnvVarsEditor
                      envVars={props.shellEnvVars}
                      setEnvVars={props.setShellEnvVars}
                      theme={theme}
                    />
                  </div>
                )}

              </div>

              {/* GitHub CLI Path */}
              <div>
                <label className="block text-xs font-bold opacity-70 uppercase mb-2 flex items-center gap-2">
                  <Terminal className="w-3 h-3" />
                  GitHub CLI (gh) Path
                </label>
                <div className="p-3 rounded border" style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}>
                  <label className="block text-xs opacity-60 mb-1">Custom Path (optional)</label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={props.ghPath}
                      onChange={(e) => props.setGhPath(e.target.value)}
                      placeholder="/opt/homebrew/bin/gh"
                      className="flex-1 p-1.5 rounded border bg-transparent outline-none text-xs font-mono"
                      style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
                    />
                    {props.ghPath && (
                      <button
                        onClick={() => props.setGhPath('')}
                        className="px-2 py-1 rounded text-xs"
                        style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textDim }}
                      >
                        Clear
                      </button>
                    )}
                  </div>
                  <p className="text-xs opacity-40 mt-2">
                    Specify the full path to the <code className="px-1 py-0.5 rounded" style={{ backgroundColor: theme.colors.bgActivity }}>gh</code> binary if it's not in your PATH. Used for Auto Run worktree features.
                  </p>
                </div>
              </div>

              {/* Input Behavior Settings */}
              <div>
                <label className="block text-xs font-bold opacity-70 uppercase mb-2 flex items-center gap-2">
                  <Keyboard className="w-3 h-3" />
                  Input Send Behavior
                </label>
                <p className="text-xs opacity-50 mb-3">
                  Configure how to send messages in each mode. Choose between Enter or Command+Enter for each input type.
                </p>

                {/* AI Mode Setting */}
                <div className="mb-4 p-3 rounded border" style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}>
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-sm font-medium">AI Interaction Mode</label>
                    <button
                      onClick={() => props.setEnterToSendAI(!props.enterToSendAI)}
                      className="px-3 py-1.5 rounded text-xs font-mono transition-all"
                      style={{
                        backgroundColor: props.enterToSendAI ? theme.colors.accentDim : theme.colors.bgActivity,
                        color: theme.colors.textMain,
                        border: `1px solid ${theme.colors.border}`
                      }}
                    >
                      {props.enterToSendAI ? 'Enter' : '⌘ + Enter'}
                    </button>
                  </div>
                  <p className="text-xs opacity-50">
                    {props.enterToSendAI
                      ? 'Press Enter to send. Use Shift+Enter for new line.'
                      : 'Press Command+Enter to send. Enter creates new line.'}
                  </p>
                </div>

                {/* Terminal Mode Setting */}
                <div className="p-3 rounded border" style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}>
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-sm font-medium">Terminal Mode</label>
                    <button
                      onClick={() => props.setEnterToSendTerminal(!props.enterToSendTerminal)}
                      className="px-3 py-1.5 rounded text-xs font-mono transition-all"
                      style={{
                        backgroundColor: props.enterToSendTerminal ? theme.colors.accentDim : theme.colors.bgActivity,
                        color: theme.colors.textMain,
                        border: `1px solid ${theme.colors.border}`
                      }}
                    >
                      {props.enterToSendTerminal ? 'Enter' : '⌘ + Enter'}
                    </button>
                  </div>
                  <p className="text-xs opacity-50">
                    {props.enterToSendTerminal
                      ? 'Press Enter to send. Use Shift+Enter for new line.'
                      : 'Press Command+Enter to send. Enter creates new line.'}
                  </p>
                </div>
              </div>

              {/* Default History Toggle */}
              <SettingCheckbox
                icon={History}
                sectionLabel="Default History Toggle"
                title="Enable &quot;History&quot; by default for new tabs"
                description="When enabled, new AI tabs will have the &quot;History&quot; toggle on by default, saving a synopsis after each completion"
                checked={props.defaultSaveToHistory}
                onChange={props.setDefaultSaveToHistory}
                theme={theme}
              />

              {/* Default Thinking Toggle */}
              <SettingCheckbox
                icon={Brain}
                sectionLabel="Default Thinking Toggle"
                title="Enable &quot;Thinking&quot; by default for new tabs"
                description="When enabled, new AI tabs will show streaming thinking/reasoning content as the AI works, instead of waiting for the final result"
                checked={props.defaultShowThinking}
                onChange={props.setDefaultShowThinking}
                theme={theme}
              />

              {/* Check for Updates on Startup */}
              <SettingCheckbox
                icon={Download}
                sectionLabel="Updates"
                title="Check for updates on startup"
                description="Automatically check for new Maestro versions when the app starts"
                checked={props.checkForUpdatesOnStartup}
                onChange={props.setCheckForUpdatesOnStartup}
                theme={theme}
              />

              {/* Crash Reporting */}
              <SettingCheckbox
                icon={Bug}
                sectionLabel="Privacy"
                title="Send anonymous crash reports"
                description="Help improve Maestro by automatically sending crash reports. No personal data is collected. Changes take effect after restart."
                checked={props.crashReportingEnabled}
                onChange={props.setCrashReportingEnabled}
                theme={theme}
              />

              {/* Settings Storage Location */}
              <div
                className="flex items-start gap-3 p-4 rounded-xl border relative"
                style={{ backgroundColor: theme.colors.bgMain, borderColor: theme.colors.border }}
              >
                {/* BETA Badge */}
                <div
                  className="absolute top-2 right-2 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase"
                  style={{ backgroundColor: theme.colors.warning + '30', color: theme.colors.warning }}
                >
                  Beta
                </div>
                <div
                  className="p-2 rounded-lg flex-shrink-0"
                  style={{ backgroundColor: theme.colors.accent + '20' }}
                >
                  <FolderSync className="w-5 h-5" style={{ color: theme.colors.accent }} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[10px] uppercase font-bold opacity-50 mb-1">Storage Location</p>
                  <p className="font-semibold mb-1">Settings folder</p>
                  <p className="text-xs opacity-60 mb-2">
                    Choose where Maestro stores settings, sessions, and groups. Use a synced folder (iCloud Drive, Dropbox, OneDrive) to share across devices.
                  </p>
                  <p className="text-xs opacity-50 mb-4 italic">
                    Note: Only run Maestro on one device at a time to avoid sync conflicts.
                  </p>

                  {/* Default Location */}
                  <div className="mb-3">
                    <p className="text-[10px] uppercase font-bold opacity-40 mb-1">Default Location</p>
                    <div
                      className="text-xs p-2 rounded font-mono truncate"
                      style={{ backgroundColor: theme.colors.bgActivity }}
                      title={defaultStoragePath}
                    >
                      {defaultStoragePath || 'Loading...'}
                    </div>
                  </div>

                  {/* Current Location (if different) */}
                  {customSyncPath && (
                    <div className="mb-3">
                      <p className="text-[10px] uppercase font-bold opacity-40 mb-1">Current Location (Custom)</p>
                      <div
                        className="text-xs p-2 rounded font-mono truncate flex items-center gap-2"
                        style={{ backgroundColor: theme.colors.accent + '15', border: `1px solid ${theme.colors.accent}40` }}
                        title={customSyncPath}
                      >
                        <Cloud className="w-3 h-3 flex-shrink-0" style={{ color: theme.colors.accent }} />
                        <span className="truncate">{customSyncPath}</span>
                      </div>
                    </div>
                  )}

                  {/* Action Buttons */}
                  <div className="flex items-center gap-2 flex-wrap">
                    <button
                      onClick={async () => {
                        const folder = await window.maestro.sync.selectSyncFolder();
                        if (folder) {
                          setSyncMigrating(true);
                          setSyncError(null);
                          setSyncMigratedCount(null);
                          try {
                            const result = await window.maestro.sync.setCustomPath(folder);
                            if (result.success) {
                              setCustomSyncPath(folder);
                              setCurrentStoragePath(folder);
                              setSyncRestartRequired(true);
                              if (result.migrated !== undefined) {
                                setSyncMigratedCount(result.migrated);
                              }
                            } else {
                              setSyncError(result.error || 'Failed to change storage location');
                            }
                            if (result.errors && result.errors.length > 0) {
                              setSyncError(result.errors.join(', '));
                            }
                          } finally {
                            setSyncMigrating(false);
                          }
                        }
                      }}
                      disabled={syncMigrating}
                      className="flex items-center gap-2 px-3 py-1.5 rounded text-xs font-medium transition-colors disabled:opacity-50"
                      style={{
                        backgroundColor: theme.colors.accent,
                        color: theme.colors.bgMain,
                      }}
                    >
                      <Folder className="w-3 h-3" />
                      {syncMigrating ? 'Migrating...' : (customSyncPath ? 'Change Folder...' : 'Choose Folder...')}
                    </button>

                    {customSyncPath && (
                      <button
                        onClick={async () => {
                          setSyncMigrating(true);
                          setSyncError(null);
                          setSyncMigratedCount(null);
                          try {
                            const result = await window.maestro.sync.setCustomPath(null);
                            if (result.success) {
                              setCustomSyncPath(undefined);
                              setCurrentStoragePath(defaultStoragePath);
                              setSyncRestartRequired(true);
                              if (result.migrated !== undefined) {
                                setSyncMigratedCount(result.migrated);
                              }
                            } else {
                              setSyncError(result.error || 'Failed to reset storage location');
                            }
                          } finally {
                            setSyncMigrating(false);
                          }
                        }}
                        disabled={syncMigrating}
                        className="flex items-center gap-2 px-3 py-1.5 rounded text-xs font-medium transition-colors disabled:opacity-50"
                        style={{
                          backgroundColor: theme.colors.border,
                          color: theme.colors.textMain,
                        }}
                        title="Reset to default location"
                      >
                        <RotateCcw className="w-3 h-3" />
                        Use Default
                      </button>
                    )}
                  </div>

                  {/* Success Message */}
                  {syncMigratedCount !== null && syncMigratedCount > 0 && !syncError && (
                    <div
                      className="mt-3 p-2 rounded text-xs flex items-center gap-2"
                      style={{
                        backgroundColor: theme.colors.success + '20',
                        color: theme.colors.success,
                      }}
                    >
                      <Check className="w-3 h-3" />
                      Migrated {syncMigratedCount} settings file{syncMigratedCount !== 1 ? 's' : ''}
                    </div>
                  )}

                  {/* Error Message */}
                  {syncError && (
                    <div
                      className="mt-3 p-2 rounded text-xs flex items-start gap-2"
                      style={{
                        backgroundColor: theme.colors.error + '20',
                        color: theme.colors.error,
                      }}
                    >
                      <X className="w-3 h-3 flex-shrink-0 mt-0.5" />
                      <span>{syncError}</span>
                    </div>
                  )}

                  {/* Restart Required Warning */}
                  {syncRestartRequired && !syncError && (
                    <div
                      className="mt-3 p-2 rounded text-xs flex items-center gap-2"
                      style={{
                        backgroundColor: theme.colors.warning + '20',
                        color: theme.colors.warning,
                      }}
                    >
                      <RotateCcw className="w-3 h-3" />
                      Restart Maestro for changes to take effect
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {activeTab === 'llm' && FEATURE_FLAGS.LLM_SETTINGS && (
            <div className="space-y-5">
              <div>
                <label className="block text-xs font-bold opacity-70 uppercase mb-2">LLM Provider</label>
                <select
                  value={props.llmProvider}
                  onChange={(e) => props.setLlmProvider(e.target.value as LLMProvider)}
                  className="w-full p-2 rounded border bg-transparent outline-none"
                  style={{ borderColor: theme.colors.border }}
                >
                  <option value="openrouter">OpenRouter</option>
                  <option value="anthropic">Anthropic</option>
                  <option value="ollama">Ollama (Local)</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-bold opacity-70 uppercase mb-2">Model Slug</label>
                <input
                  value={props.modelSlug}
                  onChange={(e) => props.setModelSlug(e.target.value)}
                  className="w-full p-2 rounded border bg-transparent outline-none"
                  style={{ borderColor: theme.colors.border }}
                  placeholder={props.llmProvider === 'ollama' ? 'llama3:latest' : 'anthropic/claude-3.5-sonnet'}
                />
              </div>

              {props.llmProvider !== 'ollama' && (
                <div>
                  <label className="block text-xs font-bold opacity-70 uppercase mb-2">API Key</label>
                  <div className="flex items-center border rounded px-3 py-2" style={{ backgroundColor: theme.colors.bgMain, borderColor: theme.colors.border }}>
                    <Key className="w-4 h-4 mr-2 opacity-50" />
                    <input
                      type="password"
                      value={props.apiKey}
                      onChange={(e) => props.setApiKey(e.target.value)}
                      className="bg-transparent flex-1 text-sm outline-none"
                      placeholder="sk-..."
                    />
                  </div>
                  <p className="text-[10px] mt-2 opacity-50">Keys are stored locally in ~/.maestro/settings.json</p>
                </div>
              )}

              {/* Test Connection */}
              <div className="pt-4 border-t" style={{ borderColor: theme.colors.border }}>
                <button
                  onClick={testLLMConnection}
                  disabled={testingLLM || (props.llmProvider !== 'ollama' && !props.apiKey)}
                  className="w-full py-3 rounded-lg font-bold text-sm transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                  style={{
                    backgroundColor: theme.colors.accent,
                    color: theme.colors.accentForeground,
                  }}
                >
                  {testingLLM ? 'Testing Connection...' : 'Test Connection'}
                </button>

                {testResult.status && (
                  <div
                    className="mt-3 p-3 rounded-lg text-sm"
                    style={{
                      backgroundColor: testResult.status === 'success' ? theme.colors.success + '20' : theme.colors.error + '20',
                      color: testResult.status === 'success' ? theme.colors.success : theme.colors.error,
                      border: `1px solid ${testResult.status === 'success' ? theme.colors.success : theme.colors.error}`,
                    }}
                  >
                    {testResult.message}
                  </div>
                )}

                <p className="text-[10px] mt-3 opacity-50 text-center">
                  Test sends a simple prompt to verify connectivity and configuration
                </p>
              </div>
            </div>
          )}

          {activeTab === 'shortcuts' && (() => {
            const allShortcuts = [
              ...Object.values(props.shortcuts).map(sc => ({ ...sc, isTabShortcut: false })),
              ...Object.values(props.tabShortcuts).map(sc => ({ ...sc, isTabShortcut: true })),
            ];
            const totalShortcuts = allShortcuts.length;
            const filteredShortcuts = allShortcuts
              .filter((sc) => sc.label.toLowerCase().includes(shortcutsFilter.toLowerCase()));
            const filteredCount = filteredShortcuts.length;

            // Group shortcuts by category
            const generalShortcuts = filteredShortcuts.filter(sc => !sc.isTabShortcut);
            const tabShortcutsFiltered = filteredShortcuts.filter(sc => sc.isTabShortcut);

            const renderShortcutItem = (sc: Shortcut & { isTabShortcut: boolean }) => (
              <div key={sc.id} className="flex items-center justify-between p-3 rounded border" style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}>
                <span className="text-sm font-medium" style={{ color: theme.colors.textMain }}>{sc.label}</span>
                <button
                  onClick={(e) => {
                    setRecordingId(sc.id);
                    e.currentTarget.focus();
                  }}
                  onKeyDownCapture={(e) => {
                    if (recordingId === sc.id) {
                      e.preventDefault();
                      e.stopPropagation();
                      handleRecord(e, sc.id, sc.isTabShortcut);
                    }
                  }}
                  className={`px-3 py-1.5 rounded border text-xs font-mono min-w-[80px] text-center transition-colors ${recordingId === sc.id ? 'ring-2' : ''}`}
                  style={{
                    borderColor: recordingId === sc.id ? theme.colors.accent : theme.colors.border,
                    backgroundColor: recordingId === sc.id ? theme.colors.accentDim : theme.colors.bgActivity,
                    color: recordingId === sc.id ? theme.colors.accent : theme.colors.textDim,
                    '--tw-ring-color': theme.colors.accent
                  } as React.CSSProperties}
                >
                  {recordingId === sc.id ? 'Press keys...' : formatShortcutKeys(sc.keys)}
                </button>
              </div>
            );

            return (
              <div className="flex flex-col" style={{ minHeight: '450px' }}>
                {props.hasNoAgents && (
                  <p className="text-xs mb-3 px-2 py-1.5 rounded" style={{ backgroundColor: theme.colors.accent + '20', color: theme.colors.accent }}>
                    Note: Most functionality is unavailable until you've created your first agent.
                  </p>
                )}
                <div className="flex items-center gap-2 mb-3">
                  <input
                    ref={shortcutsFilterRef}
                    type="text"
                    value={shortcutsFilter}
                    onChange={(e) => setShortcutsFilter(e.target.value)}
                    placeholder="Filter shortcuts..."
                    className="flex-1 px-3 py-2 rounded border bg-transparent outline-none text-sm"
                    style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
                  />
                  <span className="text-xs px-2 py-1.5 rounded font-medium" style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textDim }}>
                    {shortcutsFilter ? `${filteredCount} / ${totalShortcuts}` : totalShortcuts}
                  </span>
                </div>
                <p className="text-xs opacity-50 mb-3" style={{ color: theme.colors.textDim }}>
                  Not all shortcuts can be modified. Press <kbd className="px-1.5 py-0.5 rounded font-mono" style={{ backgroundColor: theme.colors.bgActivity }}>⌘/</kbd> from the main interface to view the full list of keyboard shortcuts.
                </p>
                <div className="space-y-4 flex-1 overflow-y-auto pr-2 scrollbar-thin">
                  {/* General Shortcuts Section */}
                  {generalShortcuts.length > 0 && (
                    <div>
                      <h3 className="text-xs font-bold uppercase mb-2 px-1" style={{ color: theme.colors.textDim }}>
                        General
                      </h3>
                      <div className="space-y-2">
                        {generalShortcuts.map(renderShortcutItem)}
                      </div>
                    </div>
                  )}

                  {/* AI Tab Shortcuts Section */}
                  {tabShortcutsFiltered.length > 0 && (
                    <div>
                      <h3 className="text-xs font-bold uppercase mb-2 px-1" style={{ color: theme.colors.textDim }}>
                        AI Tab
                      </h3>
                      <div className="space-y-2">
                        {tabShortcutsFiltered.map(renderShortcutItem)}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            );
          })()}

          {activeTab === 'theme' && themePickerContent}

          {activeTab === 'notifications' && (
            <NotificationsPanel
              osNotificationsEnabled={props.osNotificationsEnabled}
              setOsNotificationsEnabled={props.setOsNotificationsEnabled}
              audioFeedbackEnabled={props.audioFeedbackEnabled}
              setAudioFeedbackEnabled={props.setAudioFeedbackEnabled}
              audioFeedbackCommand={props.audioFeedbackCommand}
              setAudioFeedbackCommand={props.setAudioFeedbackCommand}
              toastDuration={props.toastDuration}
              setToastDuration={props.setToastDuration}
              theme={theme}
            />
          )}

          {activeTab === 'aicommands' && (
            <div className="space-y-8">
              <AICommandsPanel
                theme={theme}
                customAICommands={props.customAICommands}
                setCustomAICommands={props.setCustomAICommands}
              />

              {/* Divider */}
              <div
                className="border-t"
                style={{ borderColor: theme.colors.border }}
              />

              {/* Spec Kit Commands Section */}
              <SpecKitCommandsPanel theme={theme} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
});
