/**
 * AgentConfigPanel.tsx
 *
 * Shared component for agent configuration settings.
 * Used by both NewInstanceModal and the Wizard's AgentSelectionScreen.
 *
 * Displays:
 * - Detected path (read-only)
 * - Custom path input
 * - Custom arguments input
 * - Environment variables (key-value pairs)
 * - Built-in environment variables (MAESTRO_SESSION_RESUMED)
 * - Agent-specific config options (contextWindow, model, etc.)
 */

import { useState, useRef, useMemo } from 'react';
import { RefreshCw, Plus, Trash2, HelpCircle } from 'lucide-react';
import type { Theme, AgentConfig } from '../../types';

// Counter for generating stable IDs for env vars
let envVarIdCounter = 0;

// Built-in environment variables that Maestro sets automatically
const BUILT_IN_ENV_VARS: { key: string; description: string; value: string }[] = [
  {
    key: 'MAESTRO_SESSION_RESUMED',
    description: 'Set to "1" when resuming an existing session. Not set for new sessions. Use this in your agent hooks to skip initialization on resumed sessions.',
    value: '1 (when resuming)',
  },
];

export interface AgentConfigPanelProps {
  theme: Theme;
  agent: AgentConfig;
  // Custom path
  customPath: string;
  onCustomPathChange: (value: string) => void;
  onCustomPathBlur: () => void;
  onCustomPathClear: () => void;
  // Custom arguments
  customArgs: string;
  onCustomArgsChange: (value: string) => void;
  onCustomArgsBlur: () => void;
  onCustomArgsClear: () => void;
  // Environment variables
  customEnvVars: Record<string, string>;
  onEnvVarKeyChange: (oldKey: string, newKey: string, value: string) => void;
  onEnvVarValueChange: (key: string, value: string) => void;
  onEnvVarRemove: (key: string) => void;
  onEnvVarAdd: () => void;
  onEnvVarsBlur: () => void;
  // Agent-specific config options
  agentConfig: Record<string, any>;
  onConfigChange: (key: string, value: any) => void;
  onConfigBlur: () => void;
  // Model selection (if supported)
  availableModels?: string[];
  loadingModels?: boolean;
  onRefreshModels?: () => void;
  // Agent refresh
  onRefreshAgent?: () => void;
  refreshingAgent?: boolean;
  // Optional: compact mode for wizard (less padding)
  compact?: boolean;
  // Show built-in environment variables section
  showBuiltInEnvVars?: boolean;
}

export function AgentConfigPanel({
  theme,
  agent,
  customPath,
  onCustomPathChange,
  onCustomPathBlur,
  onCustomPathClear,
  customArgs,
  onCustomArgsChange,
  onCustomArgsBlur,
  onCustomArgsClear,
  customEnvVars,
  onEnvVarKeyChange,
  onEnvVarValueChange,
  onEnvVarRemove,
  onEnvVarAdd,
  onEnvVarsBlur,
  agentConfig,
  onConfigChange,
  onConfigBlur,
  availableModels = [],
  loadingModels = false,
  onRefreshModels,
  onRefreshAgent,
  refreshingAgent = false,
  compact = false,
  showBuiltInEnvVars = false,
}: AgentConfigPanelProps): JSX.Element {
  const padding = compact ? 'p-2' : 'p-3';
  const spacing = compact ? 'space-y-2' : 'space-y-3';
  // Track which built-in env var tooltip is showing
  const [showingTooltip, setShowingTooltip] = useState<string | null>(null);

  // Track stable IDs for env var entries to prevent focus loss when keys change
  // Only key edits are deferred to blur - value edits update immediately
  const envVarIdsRef = useRef<Map<string, number>>(new Map());
  const pendingKeyEditsRef = useRef<Map<string, string>>(new Map());
  // Force re-render when pending key edits change
  const [, forceUpdate] = useState(0);

  // Get or create stable ID for an env var key
  const getEnvVarId = (key: string): number => {
    if (!envVarIdsRef.current.has(key)) {
      envVarIdsRef.current.set(key, ++envVarIdCounter);
    }
    return envVarIdsRef.current.get(key)!;
  };

  // Clean up stale IDs when env vars change (only if not currently being edited)
  useMemo(() => {
    const currentKeys = new Set(Object.keys(customEnvVars));
    for (const key of envVarIdsRef.current.keys()) {
      if (!currentKeys.has(key) && !pendingKeyEditsRef.current.has(key)) {
        envVarIdsRef.current.delete(key);
        pendingKeyEditsRef.current.delete(key);
      }
    }
  }, [customEnvVars]);

  // Get current display value for env var key (pending edit or actual)
  const getKeyDisplayValue = (originalKey: string): string => {
    return pendingKeyEditsRef.current.get(originalKey) ?? originalKey;
  };

  // Handle key input change (local only, deferred to blur)
  const handleKeyInputChange = (originalKey: string, newKey: string) => {
    pendingKeyEditsRef.current.set(originalKey, newKey);
    forceUpdate(n => n + 1);
  };

  // Commit pending key edit on blur
  const handleKeyBlur = (originalKey: string, currentValue: string) => {
    const pendingKey = pendingKeyEditsRef.current.get(originalKey);
    pendingKeyEditsRef.current.delete(originalKey);

    // Update the ID map if key changed
    if (pendingKey !== undefined && pendingKey !== originalKey) {
      const id = envVarIdsRef.current.get(originalKey);
      if (id !== undefined) {
        envVarIdsRef.current.delete(originalKey);
        envVarIdsRef.current.set(pendingKey, id);
      }
      onEnvVarKeyChange(originalKey, pendingKey, currentValue);
    }
    onEnvVarsBlur();
  };

  return (
    <div className={spacing}>
      {/* Show detected path if available */}
      {agent.path && (
        <div
          className="text-xs font-mono px-3 py-2 rounded flex items-center justify-between"
          style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textDim }}
        >
          <div>
            <span className="opacity-60">Detected:</span> {agent.path}
          </div>
          {onRefreshAgent && (
            <button
              onClick={onRefreshAgent}
              className="p-1 rounded hover:bg-white/10 transition-colors ml-2"
              title="Refresh detection"
              style={{ color: theme.colors.textDim }}
            >
              <RefreshCw className={`w-3 h-3 ${refreshingAgent ? 'animate-spin' : ''}`} />
            </button>
          )}
        </div>
      )}

      {/* Custom path input */}
      <div
        className={`${padding} rounded border`}
        style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
      >
        <label className="block text-xs font-medium mb-2" style={{ color: theme.colors.textDim }}>
          Custom Path (optional)
        </label>
        <div className="flex gap-2">
          <input
            type="text"
            value={customPath}
            onChange={(e) => onCustomPathChange(e.target.value)}
            onBlur={onCustomPathBlur}
            onClick={(e) => e.stopPropagation()}
            placeholder={`/path/to/${agent.binaryName}`}
            className="flex-1 p-2 rounded border bg-transparent outline-none text-xs font-mono"
            style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
          />
          {customPath && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onCustomPathClear();
              }}
              className="px-2 py-1.5 rounded text-xs"
              style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textDim }}
            >
              Clear
            </button>
          )}
        </div>
        <p className="text-xs opacity-50 mt-2">
          Specify a custom path if the agent is not in your PATH
        </p>
      </div>

      {/* Custom CLI arguments input */}
      <div
        className={`${padding} rounded border`}
        style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
      >
        <label className="block text-xs font-medium mb-2" style={{ color: theme.colors.textDim }}>
          Custom Arguments (optional)
        </label>
        <div className="flex gap-2">
          <input
            type="text"
            value={customArgs}
            onChange={(e) => onCustomArgsChange(e.target.value)}
            onBlur={onCustomArgsBlur}
            onClick={(e) => e.stopPropagation()}
            placeholder="--flag value --another-flag"
            className="flex-1 p-2 rounded border bg-transparent outline-none text-xs font-mono"
            style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
          />
          {customArgs && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onCustomArgsClear();
              }}
              className="px-2 py-1.5 rounded text-xs"
              style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textDim }}
            >
              Clear
            </button>
          )}
        </div>
        <p className="text-xs opacity-50 mt-2">
          Additional CLI arguments appended to all calls to this agent
        </p>
      </div>

      {/* Custom environment variables input */}
      <div
        className={`${padding} rounded border`}
        style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
      >
        <label className="block text-xs font-medium mb-2" style={{ color: theme.colors.textDim }}>
          Environment Variables (optional)
        </label>
        <div className="space-y-2">
          {/* Built-in env vars (read-only, shown when showBuiltInEnvVars is true) */}
          {showBuiltInEnvVars && BUILT_IN_ENV_VARS.map((envVar) => (
            <div key={envVar.key} className="relative">
              <div
                className="flex gap-2 rounded px-2 py-1.5"
                style={{ backgroundColor: theme.colors.bgActivity }}
              >
                <div
                  className="flex-1 p-2 rounded text-xs font-mono flex items-center gap-1"
                  style={{ color: theme.colors.textDim }}
                >
                  <span>{envVar.key}</span>
                  <div className="relative inline-block">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setShowingTooltip(showingTooltip === envVar.key ? null : envVar.key);
                      }}
                      onBlur={() => setTimeout(() => setShowingTooltip(null), 150)}
                      className="p-0.5 rounded hover:bg-white/10 transition-colors"
                      title="What is this?"
                      style={{ color: theme.colors.accent }}
                    >
                      <HelpCircle className="w-3 h-3" />
                    </button>
                    {/* Tooltip */}
                    {showingTooltip === envVar.key && (
                      <div
                        className="absolute left-1/2 bottom-full mb-1 z-50 p-3 rounded shadow-lg text-xs whitespace-normal leading-relaxed"
                        style={{
                          backgroundColor: theme.colors.bgMain,
                          border: `1px solid ${theme.colors.border}`,
                          color: theme.colors.textMain,
                          width: '320px',
                          transform: 'translateX(-50%)',
                        }}
                      >
                        {envVar.description}
                      </div>
                    )}
                  </div>
                </div>
                <span className="flex items-center text-xs" style={{ color: theme.colors.textDim }}>=</span>
                <div
                  className="flex-[2] p-2 rounded text-xs font-mono italic"
                  style={{ color: theme.colors.textDim }}
                >
                  {envVar.value}
                </div>
                <div className="w-8" /> {/* Spacer to align with delete button column */}
              </div>
              <span className="text-[10px] ml-2" style={{ color: theme.colors.textDim }}>
                Built-in (set by Maestro)
              </span>
            </div>
          ))}
          {/* User-defined env vars */}
          {Object.entries(customEnvVars).map(([key, value]) => (
            <div key={`env-var-${getEnvVarId(key)}`} className="flex gap-2">
              <input
                type="text"
                value={getKeyDisplayValue(key)}
                onChange={(e) => handleKeyInputChange(key, e.target.value)}
                onBlur={() => handleKeyBlur(key, value)}
                onClick={(e) => e.stopPropagation()}
                placeholder="VARIABLE_NAME"
                className="flex-1 p-2 rounded border bg-transparent outline-none text-xs font-mono"
                style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
              />
              <span className="flex items-center text-xs" style={{ color: theme.colors.textDim }}>=</span>
              <input
                type="text"
                value={value}
                onChange={(e) => onEnvVarValueChange(key, e.target.value)}
                onBlur={onEnvVarsBlur}
                onClick={(e) => e.stopPropagation()}
                placeholder="value"
                className="flex-[2] p-2 rounded border bg-transparent outline-none text-xs font-mono"
                style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
              />
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onEnvVarRemove(key);
                }}
                className="p-2 rounded hover:bg-white/10 transition-colors"
                title="Remove variable"
                style={{ color: theme.colors.textDim }}
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          ))}
          {/* Add new env var button */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              onEnvVarAdd();
            }}
            className="flex items-center gap-1 px-2 py-1.5 rounded text-xs hover:bg-white/10 transition-colors"
            style={{ color: theme.colors.textDim }}
          >
            <Plus className="w-3 h-3" />
            Add Variable
          </button>
        </div>
        <p className="text-xs opacity-50 mt-2">
          Environment variables passed to all calls to this agent
        </p>
      </div>

      {/* Agent-specific configuration options (contextWindow, model, etc.) */}
      {agent.configOptions && agent.configOptions.length > 0 && agent.configOptions.map((option: any) => (
        <div
          key={option.key}
          className={`${padding} rounded border`}
          style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
        >
          <label className="block text-xs font-medium mb-2" style={{ color: theme.colors.textDim }}>
            {option.label}
          </label>
          {option.type === 'number' && (
            <input
              type="number"
              value={agentConfig[option.key] ?? option.default}
              onChange={(e) => {
                const value = e.target.value === '' ? 0 : parseInt(e.target.value, 10);
                onConfigChange(option.key, isNaN(value) ? 0 : value);
              }}
              onBlur={onConfigBlur}
              onClick={(e) => e.stopPropagation()}
              placeholder={option.default?.toString() || '0'}
              min={0}
              className="w-full p-2 rounded border bg-transparent outline-none text-xs font-mono"
              style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
            />
          )}
          {option.type === 'text' && (
            <>
              <div className="flex gap-2">
                <input
                  type="text"
                  list={option.key === 'model' ? `models-${agent.id}` : undefined}
                  value={agentConfig[option.key] ?? option.default}
                  onChange={(e) => onConfigChange(option.key, e.target.value)}
                  onBlur={onConfigBlur}
                  onClick={(e) => e.stopPropagation()}
                  placeholder={option.default || ''}
                  className="flex-1 p-2 rounded border bg-transparent outline-none text-xs font-mono"
                  style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
                />
                {option.key === 'model' && agent.capabilities?.supportsModelSelection && onRefreshModels && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onRefreshModels();
                    }}
                    className="p-2 rounded border hover:bg-white/10 transition-colors"
                    title="Refresh available models"
                    style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
                  >
                    <RefreshCw className={`w-3 h-3 ${loadingModels ? 'animate-spin' : ''}`} />
                  </button>
                )}
              </div>
              {/* Datalist for model autocomplete */}
              {option.key === 'model' && availableModels.length > 0 && (
                <datalist id={`models-${agent.id}`}>
                  {availableModels.map((model) => (
                    <option key={model} value={model} />
                  ))}
                </datalist>
              )}
              {option.key === 'model' && loadingModels && (
                <p className="text-xs mt-1" style={{ color: theme.colors.textDim }}>
                  Loading available models...
                </p>
              )}
              {option.key === 'model' && !loadingModels && availableModels.length > 0 && (
                <p className="text-xs mt-1" style={{ color: theme.colors.textDim }}>
                  {availableModels.length} model{availableModels.length !== 1 ? 's' : ''} available
                </p>
              )}
            </>
          )}
          {option.type === 'checkbox' && (
            <label className="flex items-center gap-2 cursor-pointer" onClick={(e) => e.stopPropagation()}>
              <input
                type="checkbox"
                checked={agentConfig[option.key] ?? option.default}
                onChange={(e) => {
                  onConfigChange(option.key, e.target.checked);
                  // Immediately persist checkbox changes
                  onConfigBlur();
                }}
                className="w-4 h-4"
                style={{ accentColor: theme.colors.accent }}
              />
              <span className="text-xs" style={{ color: theme.colors.textMain }}>Enabled</span>
            </label>
          )}
          <p className="text-xs opacity-50 mt-2">
            {option.description}
          </p>
        </div>
      ))}
    </div>
  );
}
