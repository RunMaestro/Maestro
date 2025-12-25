import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Folder, RefreshCw, ChevronRight, AlertTriangle } from 'lucide-react';
import type { AgentConfig, Session, ToolType } from '../types';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { validateNewSession, validateEditSession } from '../utils/sessionValidation';
import { FormInput } from './ui/FormInput';
import { Modal, ModalFooter } from './ui/Modal';
import { AgentConfigPanel } from './shared/AgentConfigPanel';

// Maximum character length for nudge message
const NUDGE_MESSAGE_MAX_LENGTH = 1000;

interface AgentDebugInfo {
  agentId: string;
  available: boolean;
  path: string | null;
  binaryName: string;
  envPath: string;
  homeDir: string;
  platform: string;
  whichCommand: string;
  error: string | null;
}

interface NewInstanceModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (
    agentId: string,
    workingDir: string,
    name: string,
    nudgeMessage?: string,
    customPath?: string,
    customArgs?: string,
    customEnvVars?: Record<string, string>,
    customModel?: string,
    customContextWindow?: number,
    customProviderPath?: string
  ) => void;
  theme: any;
  existingSessions: Session[];
  sourceSession?: Session; // Optional session to duplicate from
}

interface EditAgentModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (
    sessionId: string,
    name: string,
    nudgeMessage?: string,
    customPath?: string,
    customArgs?: string,
    customEnvVars?: Record<string, string>,
    customModel?: string,
    customContextWindow?: number
  ) => void;
  theme: any;
  session: Session | null;
  existingSessions: Session[];
}

// Supported agents that are fully implemented
const SUPPORTED_AGENTS = ['claude-code', 'opencode', 'codex'];

export function NewInstanceModal({ isOpen, onClose, onCreate, theme, existingSessions, sourceSession }: NewInstanceModalProps) {
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const [selectedAgent, setSelectedAgent] = useState('');
  const [expandedAgent, setExpandedAgent] = useState<string | null>(null);
  const [workingDir, setWorkingDir] = useState('');
  const [instanceName, setInstanceName] = useState('');
  const [nudgeMessage, setNudgeMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshingAgent, setRefreshingAgent] = useState<string | null>(null);
  const [debugInfo, setDebugInfo] = useState<AgentDebugInfo | null>(null);
  const [homeDir, setHomeDir] = useState<string>('');
  const [customAgentPaths, setCustomAgentPaths] = useState<Record<string, string>>({});
  const [customAgentArgs, setCustomAgentArgs] = useState<Record<string, string>>({});
  const [customAgentEnvVars, setCustomAgentEnvVars] = useState<Record<string, Record<string, string>>>({});
  const [agentConfigs, setAgentConfigs] = useState<Record<string, Record<string, any>>>({});
  const [availableModels, setAvailableModels] = useState<Record<string, string[]>>({});
  const [loadingModels, setLoadingModels] = useState<Record<string, boolean>>({});
  const [directoryWarningAcknowledged, setDirectoryWarningAcknowledged] = useState(false);

  const nameInputRef = useRef<HTMLInputElement>(null);

  // Fetch home directory on mount for tilde expansion
  useEffect(() => {
    window.maestro.fs.homeDir().then(setHomeDir);
  }, []);

  // Expand tilde in path
  const expandTilde = (path: string): string => {
    if (!homeDir) return path;
    if (path === '~') return homeDir;
    if (path.startsWith('~/')) return homeDir + path.slice(1);
    return path;
  };

  // Validate session uniqueness
  const validation = useMemo(() => {
    const name = instanceName.trim();
    const expandedDir = expandTilde(workingDir.trim());
    if (!name || !expandedDir || !selectedAgent) {
      return { valid: true }; // Don't show errors until fields are filled
    }
    return validateNewSession(name, expandedDir, selectedAgent as ToolType, existingSessions);
  }, [instanceName, workingDir, selectedAgent, existingSessions, homeDir]);

  // Reset warning acknowledgment when directory changes
  useEffect(() => {
    setDirectoryWarningAcknowledged(false);
  }, [workingDir]);

  // Define handlers first before they're used in effects
  // Takes optional source session to pre-fill after loading (avoids race condition)
  const loadAgents = async (source?: Session) => {
    setLoading(true);
    try {
      const detectedAgents = await window.maestro.agents.detect();
      setAgents(detectedAgents);

      // Per-agent config (path, args, env vars) starts empty - each agent gets its own config
      // No provider-level loading - config is set per-agent during creation
      // Only reset if NOT duplicating (source session will provide values)
      if (!source) {
        setCustomAgentPaths({});
        setCustomAgentArgs({});
        setCustomAgentEnvVars({});
      }

      // Load configurations for all agents (model, contextWindow - these are provider-level)
      const configs: Record<string, Record<string, any>> = {};
      for (const agent of detectedAgents) {
        const config = await window.maestro.agents.getConfig(agent.id);
        configs[agent.id] = config;
      }

      // If duplicating, merge source session config values into loaded configs
      if (source) {
        const sourceConfig: Record<string, any> = { ...configs[source.toolType] };
        if (source.customModel) {
          sourceConfig.model = source.customModel;
        }
        if (source.customContextWindow) {
          sourceConfig.contextWindow = source.customContextWindow;
        }
        if (source.customProviderPath) {
          sourceConfig.providerPath = source.customProviderPath;
        }
        configs[source.toolType] = sourceConfig;
      }
      setAgentConfigs(configs);

      // Select first available non-hidden agent (or source agent if duplicating)
      // (hidden agents like 'terminal' should never be auto-selected)
      if (source) {
        setSelectedAgent(source.toolType);
      } else {
        const firstAvailable = detectedAgents.find((a: AgentConfig) => a.available && !a.hidden);
        if (firstAvailable) {
          setSelectedAgent(firstAvailable.id);
        }
      }

      // Pre-fill form fields AFTER agents are loaded (ensures no race condition)
      if (source) {
        setWorkingDir(source.cwd);
        setInstanceName(`${source.name} (Copy)`);
        setNudgeMessage(source.nudgeMessage || '');

        // Pre-fill custom agent configuration
        setCustomAgentPaths(prev => ({
          ...prev,
          [source.toolType]: source.customPath || ''
        }));
        setCustomAgentArgs(prev => ({
          ...prev,
          [source.toolType]: source.customArgs || ''
        }));
        setCustomAgentEnvVars(prev => ({
          ...prev,
          [source.toolType]: source.customEnvVars || {}
        }));
      }
    } catch (error) {
      console.error('Failed to load agents:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleSelectFolder = React.useCallback(async () => {
    const folder = await window.maestro.dialog.selectFolder();
    if (folder) {
      setWorkingDir(folder);
    }
  }, []);

  const handleRefreshAgent = React.useCallback(async (agentId: string) => {
    setRefreshingAgent(agentId);
    setDebugInfo(null);
    try {
      const result = await window.maestro.agents.refresh(agentId);
      setAgents(result.agents);
      if (result.debugInfo && !result.debugInfo.available) {
        setDebugInfo(result.debugInfo);
      }
    } catch (error) {
      console.error('Failed to refresh agent:', error);
    } finally {
      setRefreshingAgent(null);
    }
  }, []);

  // Load available models for an agent that supports model selection
  const loadModelsForAgent = React.useCallback(async (agentId: string, forceRefresh = false) => {
    // Check if agent supports model selection
    const agent = agents.find(a => a.id === agentId);
    if (!agent?.capabilities?.supportsModelSelection) return;

    // Skip if already loaded and not forcing refresh
    if (!forceRefresh && availableModels[agentId]?.length > 0) return;

    setLoadingModels(prev => ({ ...prev, [agentId]: true }));
    try {
      const models = await window.maestro.agents.getModels(agentId, forceRefresh);
      setAvailableModels(prev => ({ ...prev, [agentId]: models }));
    } catch (error) {
      console.error(`Failed to load models for ${agentId}:`, error);
    } finally {
      setLoadingModels(prev => ({ ...prev, [agentId]: false }));
    }
  }, [agents, availableModels]);

  const handleCreate = React.useCallback(() => {
    const name = instanceName.trim();
    if (!name) return; // Name is required
    // Expand tilde before passing to callback
    const expandedWorkingDir = expandTilde(workingDir.trim());

    // Validate before creating
    const result = validateNewSession(name, expandedWorkingDir, selectedAgent as ToolType, existingSessions);
    if (!result.valid) return;

    // Get per-agent config values
    const agentCustomPath = customAgentPaths[selectedAgent]?.trim() || undefined;
    const agentCustomArgs = customAgentArgs[selectedAgent]?.trim() || undefined;
    const agentCustomEnvVars = customAgentEnvVars[selectedAgent] && Object.keys(customAgentEnvVars[selectedAgent]).length > 0
      ? customAgentEnvVars[selectedAgent]
      : undefined;
    // Get model and other config from agent config
    const agentCustomModel = agentConfigs[selectedAgent]?.model?.trim() || undefined;
    const agentCustomContextWindow = typeof agentConfigs[selectedAgent]?.contextWindow === 'number' && agentConfigs[selectedAgent]?.contextWindow > 0
      ? agentConfigs[selectedAgent]?.contextWindow
      : undefined;
    const agentCustomProviderPath = agentConfigs[selectedAgent]?.providerPath?.trim() || undefined;

    onCreate(
      selectedAgent,
      expandedWorkingDir,
      name,
      nudgeMessage.trim() || undefined,
      agentCustomPath,
      agentCustomArgs,
      agentCustomEnvVars,
      agentCustomModel,
      agentCustomContextWindow,
      agentCustomProviderPath
    );
    onClose();

    // Reset
    setInstanceName('');
    setWorkingDir('');
    setNudgeMessage('');
    // Reset per-agent config for selected agent
    setCustomAgentPaths(prev => ({ ...prev, [selectedAgent]: '' }));
    setCustomAgentArgs(prev => ({ ...prev, [selectedAgent]: '' }));
    setCustomAgentEnvVars(prev => ({ ...prev, [selectedAgent]: {} }));
  }, [instanceName, selectedAgent, workingDir, nudgeMessage, customAgentPaths, customAgentArgs, customAgentEnvVars, agentConfigs, onCreate, onClose, expandTilde, existingSessions]);

  // Check if form is valid for submission
  const isFormValid = useMemo(() => {
    const hasWarningThatNeedsAck = validation.warning && !directoryWarningAcknowledged;
    return selectedAgent &&
           agents.find(a => a.id === selectedAgent)?.available &&
           workingDir.trim() &&
           instanceName.trim() &&
           validation.valid &&
           !hasWarningThatNeedsAck;
  }, [selectedAgent, agents, workingDir, instanceName, validation.valid, validation.warning, directoryWarningAcknowledged]);

  // Handle keyboard shortcuts
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Handle Cmd+O for folder picker before stopping propagation
    if ((e.key === 'o' || e.key === 'O') && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      e.stopPropagation();
      handleSelectFolder();
      return;
    }
    // Handle Cmd+Enter for creating agent
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      e.stopPropagation();
      if (isFormValid) {
        handleCreate();
      }
      return;
    }
  }, [handleSelectFolder, handleCreate, isFormValid]);

  // Sort agents: supported first, then coming soon at the bottom
  const sortedAgents = useMemo(() => {
    const visible = agents.filter(a => !a.hidden);
    const supported = visible.filter(a => SUPPORTED_AGENTS.includes(a.id));
    const comingSoon = visible.filter(a => !SUPPORTED_AGENTS.includes(a.id));
    return [...supported, ...comingSoon];
  }, [agents]);

  // Effects - load agents and optionally pre-fill from source session
  useEffect(() => {
    if (isOpen) {
      // Pass sourceSession to loadAgents to handle pre-fill AFTER agents are loaded
      // This prevents the race condition where loadAgents would overwrite pre-filled values
      loadAgents(sourceSession);
      // Keep all agents collapsed by default (unless duplicating - handled in loadAgents)
      if (!sourceSession) {
        setExpandedAgent(null);
      }
      // Reset warning acknowledgment when modal opens
      setDirectoryWarningAcknowledged(false);
    }
  }, [isOpen, sourceSession]);

  if (!isOpen) return null;

  return (
    <div onKeyDown={handleKeyDown}>
      <Modal
        theme={theme}
        title="Create New Agent"
        priority={MODAL_PRIORITIES.NEW_INSTANCE}
        onClose={onClose}
        width={500}
        initialFocusRef={nameInputRef}
        footer={
          <ModalFooter
            theme={theme}
            onCancel={onClose}
            onConfirm={handleCreate}
            confirmLabel="Create Agent"
            confirmDisabled={!isFormValid}
          />
        }
      >
        <div className="space-y-5">
          {/* Agent Name */}
          <FormInput
            ref={nameInputRef}
            id="agent-name-input"
            theme={theme}
            label="Agent Name"
            value={instanceName}
            onChange={setInstanceName}
            placeholder=""
            error={validation.errorField === 'name' ? validation.error : undefined}
            heightClass="p-2"
          />

          {/* Agent Selection */}
          <div>
            <label className="block text-xs font-bold opacity-70 uppercase mb-2" style={{ color: theme.colors.textMain }}>
              Agent Provider
            </label>
            {loading ? (
              <div className="text-sm opacity-50">Loading agents...</div>
            ) : (
              <div className="space-y-1">
                {sortedAgents.map((agent) => {
                  const isSupported = SUPPORTED_AGENTS.includes(agent.id);
                  const isExpanded = expandedAgent === agent.id;
                  const isSelected = selectedAgent === agent.id;
                  const canSelect = isSupported && agent.available;

                  return (
                    <div
                      key={agent.id}
                      className={`rounded border transition-all overflow-hidden ${
                        isSelected ? 'ring-2' : ''
                      }`}
                      style={{
                        borderColor: theme.colors.border,
                        backgroundColor: isSelected ? theme.colors.accentDim : 'transparent',
                        '--tw-ring-color': theme.colors.accent,
                      } as React.CSSProperties}
                    >
                      {/* Collapsed header row */}
                      <div
                        onClick={() => {
                          if (isSupported) {
                            // Toggle expansion
                            const nowExpanded = !isExpanded;
                            setExpandedAgent(nowExpanded ? agent.id : null);
                            // Auto-select if available
                            if (canSelect) {
                              setSelectedAgent(agent.id);
                            }
                            // Load models when expanding an agent that supports model selection
                            if (nowExpanded && agent.capabilities?.supportsModelSelection) {
                              loadModelsForAgent(agent.id);
                            }
                          }
                        }}
                        className={`w-full text-left px-3 py-2 flex items-center justify-between ${
                          !isSupported ? 'opacity-40 cursor-not-allowed' : 'hover:bg-white/5 cursor-pointer'
                        }`}
                        style={{ color: theme.colors.textMain }}
                        role="option"
                        aria-selected={isSelected}
                        aria-expanded={isExpanded}
                        tabIndex={isSupported ? 0 : -1}
                      >
                        <div className="flex items-center gap-2">
                          {/* Expand/collapse chevron for supported agents */}
                          {isSupported && (
                            <ChevronRight
                              className={`w-4 h-4 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
                              style={{ color: theme.colors.textDim }}
                            />
                          )}
                          <span className="font-medium">{agent.name}</span>
                          {/* "Beta" badge for Codex and OpenCode */}
                          {(agent.id === 'codex' || agent.id === 'opencode') && (
                            <span
                              className="text-[9px] px-1.5 py-0.5 rounded font-bold uppercase"
                              style={{
                                backgroundColor: theme.colors.warning + '30',
                                color: theme.colors.warning,
                              }}
                            >
                              Beta
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          {isSupported ? (
                            <>
                              {agent.available ? (
                                <span className="text-xs px-2 py-0.5 rounded" style={{ backgroundColor: theme.colors.success + '20', color: theme.colors.success }}>
                                  Available
                                </span>
                              ) : (
                                <span className="text-xs px-2 py-0.5 rounded" style={{ backgroundColor: theme.colors.error + '20', color: theme.colors.error }}>
                                  Not Found
                                </span>
                              )}
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleRefreshAgent(agent.id);
                                }}
                                className="p-1 rounded hover:bg-white/10 transition-colors"
                                title="Refresh detection"
                                style={{ color: theme.colors.textDim }}
                              >
                                <RefreshCw className={`w-3 h-3 ${refreshingAgent === agent.id ? 'animate-spin' : ''}`} />
                              </button>
                            </>
                          ) : (
                            <span className="text-xs px-2 py-0.5 rounded" style={{ backgroundColor: theme.colors.warning + '20', color: theme.colors.warning }}>
                              Coming Soon
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Expanded details for supported agents */}
                      {/* Per-agent config (path, args, env vars) is local state only - saved to agent on create */}
                      {isSupported && isExpanded && (
                        <div className="px-3 pb-3 pt-2">
                          <AgentConfigPanel
                            theme={theme}
                            agent={agent}
                            customPath={customAgentPaths[agent.id] || ''}
                            onCustomPathChange={(value) => {
                              setCustomAgentPaths(prev => ({ ...prev, [agent.id]: value }));
                            }}
                            onCustomPathBlur={() => {/* Saved on agent create */}}
                            onCustomPathClear={() => {
                              setCustomAgentPaths(prev => {
                                const newPaths = { ...prev };
                                delete newPaths[agent.id];
                                return newPaths;
                              });
                            }}
                            customArgs={customAgentArgs[agent.id] || ''}
                            onCustomArgsChange={(value) => {
                              setCustomAgentArgs(prev => ({ ...prev, [agent.id]: value }));
                            }}
                            onCustomArgsBlur={() => {/* Saved on agent create */}}
                            onCustomArgsClear={() => {
                              setCustomAgentArgs(prev => {
                                const newArgs = { ...prev };
                                delete newArgs[agent.id];
                                return newArgs;
                              });
                            }}
                            customEnvVars={customAgentEnvVars[agent.id] || {}}
                            onEnvVarKeyChange={(oldKey, newKey, value) => {
                              const currentVars = { ...customAgentEnvVars[agent.id] };
                              delete currentVars[oldKey];
                              currentVars[newKey] = value;
                              setCustomAgentEnvVars(prev => ({
                                ...prev,
                                [agent.id]: currentVars
                              }));
                            }}
                            onEnvVarValueChange={(key, value) => {
                              setCustomAgentEnvVars(prev => ({
                                ...prev,
                                [agent.id]: {
                                  ...prev[agent.id],
                                  [key]: value
                                }
                              }));
                            }}
                            onEnvVarRemove={(key) => {
                              const currentVars = { ...customAgentEnvVars[agent.id] };
                              delete currentVars[key];
                              if (Object.keys(currentVars).length > 0) {
                                setCustomAgentEnvVars(prev => ({
                                  ...prev,
                                  [agent.id]: currentVars
                                }));
                              } else {
                                setCustomAgentEnvVars(prev => {
                                  const newVars = { ...prev };
                                  delete newVars[agent.id];
                                  return newVars;
                                });
                              }
                            }}
                            onEnvVarAdd={() => {
                              const currentVars = customAgentEnvVars[agent.id] || {};
                              let newKey = 'NEW_VAR';
                              let counter = 1;
                              while (currentVars[newKey]) {
                                newKey = `NEW_VAR_${counter}`;
                                counter++;
                              }
                              setCustomAgentEnvVars(prev => ({
                                ...prev,
                                [agent.id]: {
                                  ...prev[agent.id],
                                  [newKey]: ''
                                }
                              }));
                            }}
                            onEnvVarsBlur={() => {/* Saved on agent create */}}
                            agentConfig={agentConfigs[agent.id] || {}}
                            onConfigChange={(key, value) => {
                              setAgentConfigs(prev => ({
                                ...prev,
                                [agent.id]: {
                                  ...prev[agent.id],
                                  [key]: value
                                }
                              }));
                            }}
                            onConfigBlur={() => {
                              const currentConfig = agentConfigs[agent.id] || {};
                              window.maestro.agents.setConfig(agent.id, currentConfig);
                            }}
                            availableModels={availableModels[agent.id] || []}
                            loadingModels={loadingModels[agent.id] || false}
                            onRefreshModels={() => loadModelsForAgent(agent.id, true)}
                            onRefreshAgent={() => handleRefreshAgent(agent.id)}
                            refreshingAgent={refreshingAgent === agent.id}
                            showBuiltInEnvVars
                          />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Hook behavior note */}
            <p className="text-xs mt-2" style={{ color: theme.colors.textDim }}>
              Agent hooks run per-message. Use{' '}
              <button
                type="button"
                className="underline hover:opacity-80"
                style={{ color: theme.colors.accent }}
                onClick={() => window.maestro.shell.openExternal('https://github.com/pedramamini/Maestro#environment-variables')}
              >
                MAESTRO_SESSION_RESUMED
              </button>
              {' '}to skip on resumed sessions.
            </p>

            {/* Debug Info Display */}
            {debugInfo && (
              <div
                className="mt-3 p-3 rounded border text-xs font-mono overflow-auto max-h-40"
                style={{
                  backgroundColor: theme.colors.error + '10',
                  borderColor: theme.colors.error + '40',
                  color: theme.colors.textMain,
                }}
              >
                <div className="font-bold mb-2" style={{ color: theme.colors.error }}>
                  Debug Info: {debugInfo.binaryName} not found
                </div>
                {debugInfo.error && (
                  <div className="mb-2 text-red-400">{debugInfo.error}</div>
                )}
                <div className="space-y-1 opacity-70">
                  <div><span className="opacity-50">Platform:</span> {debugInfo.platform}</div>
                  <div><span className="opacity-50">Home:</span> {debugInfo.homeDir}</div>
                  <div><span className="opacity-50">PATH:</span></div>
                  <div className="pl-2 break-all text-[10px]">
                    {debugInfo.envPath.split(':').map((p, i) => (
                      <div key={i}>{p}</div>
                    ))}
                  </div>
                </div>
                <button
                  onClick={() => setDebugInfo(null)}
                  className="mt-2 text-xs underline"
                  style={{ color: theme.colors.textDim }}
                >
                  Dismiss
                </button>
              </div>
            )}
          </div>

          {/* Working Directory */}
          <FormInput
            theme={theme}
            label="Working Directory"
            value={workingDir}
            onChange={setWorkingDir}
            placeholder="Select directory..."
            error={validation.errorField === 'directory' ? validation.error : undefined}
            monospace
            heightClass="p-2"
            addon={
              <button
                onClick={handleSelectFolder}
                className="p-2 rounded border hover:bg-opacity-10"
                style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
                title="Browse folders (Cmd+O)"
              >
                <Folder className="w-5 h-5" />
              </button>
            }
          />

          {/* Directory Warning with Acknowledgment */}
          {validation.warning && validation.warningField === 'directory' && (
            <div
              className="p-3 rounded border"
              style={{
                backgroundColor: theme.colors.warning + '15',
                borderColor: theme.colors.warning + '50',
              }}
            >
              <div className="flex items-start gap-2">
                <AlertTriangle
                  className="w-4 h-4 flex-shrink-0 mt-0.5"
                  style={{ color: theme.colors.warning }}
                />
                <div className="flex-1">
                  <p className="text-sm" style={{ color: theme.colors.textMain }}>
                    {validation.warning}
                  </p>
                  <p className="text-xs mt-2" style={{ color: theme.colors.textDim }}>
                    We recommend using a unique directory for each managed agent.
                  </p>
                  <label className="flex items-center gap-2 mt-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={directoryWarningAcknowledged}
                      onChange={(e) => setDirectoryWarningAcknowledged(e.target.checked)}
                      className="w-4 h-4 rounded"
                      style={{ accentColor: theme.colors.warning }}
                    />
                    <span className="text-sm" style={{ color: theme.colors.textMain }}>
                      I understand the risk and want to proceed
                    </span>
                  </label>
                </div>
              </div>
            </div>
          )}

          {/* Nudge Message */}
          <div>
            <label className="block text-xs font-bold opacity-70 uppercase mb-2" style={{ color: theme.colors.textMain }}>
              Nudge Message <span className="font-normal opacity-50">(optional)</span>
            </label>
            <textarea
              value={nudgeMessage}
              onChange={(e) => setNudgeMessage(e.target.value.slice(0, NUDGE_MESSAGE_MAX_LENGTH))}
              placeholder="Instructions appended to every message you send..."
              className="w-full p-2 rounded border bg-transparent outline-none resize-none text-sm"
              style={{
                borderColor: theme.colors.border,
                color: theme.colors.textMain,
                minHeight: '80px',
              }}
              maxLength={NUDGE_MESSAGE_MAX_LENGTH}
            />
            <p className="mt-1 text-xs" style={{ color: theme.colors.textDim }}>
              {nudgeMessage.length}/{NUDGE_MESSAGE_MAX_LENGTH} characters. This text is added to every message you send to the agent (not visible in chat).
            </p>
          </div>
        </div>
      </Modal>
    </div>
  );
}

/**
 * EditAgentModal - Modal for editing an existing agent's settings
 *
 * Allows editing:
 * - Agent name
 * - Nudge message
 *
 * Does NOT allow editing:
 * - Agent provider (toolType)
 * - Working directory (projectRoot)
 */
export function EditAgentModal({ isOpen, onClose, onSave, theme, session, existingSessions }: EditAgentModalProps) {
  const [instanceName, setInstanceName] = useState('');
  const [nudgeMessage, setNudgeMessage] = useState('');
  const [agent, setAgent] = useState<AgentConfig | null>(null);
  const [agentConfig, setAgentConfig] = useState<Record<string, any>>({});
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [customPath, setCustomPath] = useState('');
  const [customArgs, setCustomArgs] = useState('');
  const [customEnvVars, setCustomEnvVars] = useState<Record<string, string>>({});
  const [customModel, setCustomModel] = useState('');
  const [refreshingAgent, setRefreshingAgent] = useState(false);

  const nameInputRef = useRef<HTMLInputElement>(null);

  // Load agent info, config, custom settings, and models when modal opens
  useEffect(() => {
    if (isOpen && session) {
      // Load agent definition to get configOptions
      window.maestro.agents.detect().then((agents: AgentConfig[]) => {
        const foundAgent = agents.find(a => a.id === session.toolType);
        setAgent(foundAgent || null);

        // Load models if agent supports model selection
        if (foundAgent?.capabilities?.supportsModelSelection) {
          setLoadingModels(true);
          window.maestro.agents.getModels(session.toolType)
            .then((models) => setAvailableModels(models))
            .catch((err) => console.error('Failed to load models:', err))
            .finally(() => setLoadingModels(false));
        }
      });
      // Load agent config for defaults, but use session-level overrides when available
      // Both model and contextWindow are now per-session
      window.maestro.agents.getConfig(session.toolType).then((globalConfig) => {
        // Use session-level values if set, otherwise use global defaults
        const modelValue = session.customModel ?? globalConfig.model ?? '';
        const contextWindowValue = session.customContextWindow ?? globalConfig.contextWindow;
        setAgentConfig({ ...globalConfig, model: modelValue, contextWindow: contextWindowValue });
      });

      // Load per-session config (stored on the session/agent instance)
      // No provider-level fallback - each agent has its own config
      setCustomPath(session.customPath ?? '');
      setCustomArgs(session.customArgs ?? '');
      setCustomEnvVars(session.customEnvVars ?? {});
      setCustomModel(session.customModel ?? '');
    }
  }, [isOpen, session]);

  // Populate form when session changes or modal opens
  useEffect(() => {
    if (isOpen && session) {
      setInstanceName(session.name);
      setNudgeMessage(session.nudgeMessage || '');
    }
  }, [isOpen, session]);

  // Validate session name uniqueness (excluding current session)
  const validation = useMemo(() => {
    const name = instanceName.trim();
    if (!name || !session) {
      return { valid: true }; // Don't show errors until fields are filled
    }
    return validateEditSession(name, session.id, existingSessions);
  }, [instanceName, session, existingSessions]);

  const handleSave = useCallback(() => {
    if (!session) return;
    const name = instanceName.trim();
    if (!name) return;

    // Validate before saving
    const result = validateEditSession(name, session.id, existingSessions);
    if (!result.valid) return;

    // Get model and contextWindow from agentConfig (which is updated via onConfigChange)
    const modelValue = agentConfig.model?.trim() || undefined;
    const contextWindowValue = typeof agentConfig.contextWindow === 'number' && agentConfig.contextWindow > 0
      ? agentConfig.contextWindow
      : undefined;

    // Save with per-session config fields including model and contextWindow
    onSave(
      session.id,
      name,
      nudgeMessage.trim() || undefined,
      customPath.trim() || undefined,
      customArgs.trim() || undefined,
      Object.keys(customEnvVars).length > 0 ? customEnvVars : undefined,
      modelValue,
      contextWindowValue
    );
    onClose();
  }, [session, instanceName, nudgeMessage, customPath, customArgs, customEnvVars, agentConfig, onSave, onClose, existingSessions]);

  // Refresh available models
  const refreshModels = useCallback(async () => {
    if (!session || !agent?.capabilities?.supportsModelSelection) return;
    setLoadingModels(true);
    try {
      const models = await window.maestro.agents.getModels(session.toolType, true);
      setAvailableModels(models);
    } catch (err) {
      console.error('Failed to refresh models:', err);
    } finally {
      setLoadingModels(false);
    }
  }, [session, agent]);

  // Refresh agent detection
  const handleRefreshAgent = useCallback(async () => {
    if (!session) return;
    setRefreshingAgent(true);
    try {
      const result = await window.maestro.agents.refresh(session.toolType);
      const foundAgent = result.agents.find((a: AgentConfig) => a.id === session.toolType);
      setAgent(foundAgent || null);
    } catch (error) {
      console.error('Failed to refresh agent:', error);
    } finally {
      setRefreshingAgent(false);
    }
  }, [session]);

  // Check if form is valid for submission
  const isFormValid = useMemo(() => {
    return instanceName.trim() && validation.valid;
  }, [instanceName, validation.valid]);

  // Handle keyboard shortcuts
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Handle Cmd+Enter for saving
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      e.stopPropagation();
      if (isFormValid) {
        handleSave();
      }
      return;
    }
  }, [handleSave, isFormValid]);

  if (!isOpen || !session) return null;

  // Get agent name for display
  const agentNameMap: Record<string, string> = {
    'claude-code': 'Claude Code',
    'codex': 'Codex',
    'opencode': 'OpenCode',
    'aider': 'Aider',
  };
  const agentName = agentNameMap[session.toolType] || session.toolType;

  return (
    <div onKeyDown={handleKeyDown}>
      <Modal
        theme={theme}
        title="Edit Agent"
        priority={MODAL_PRIORITIES.NEW_INSTANCE}
        onClose={onClose}
        width={500}
        initialFocusRef={nameInputRef}
        footer={
          <ModalFooter
            theme={theme}
            onCancel={onClose}
            onConfirm={handleSave}
            confirmLabel="Save Changes"
            confirmDisabled={!isFormValid}
          />
        }
      >
        <div className="space-y-5">
          {/* Agent Name */}
          <FormInput
            ref={nameInputRef}
            id="edit-agent-name-input"
            theme={theme}
            label="Agent Name"
            value={instanceName}
            onChange={setInstanceName}
            placeholder=""
            error={validation.errorField === 'name' ? validation.error : undefined}
            heightClass="p-2"
          />

          {/* Agent Provider (read-only) */}
          <div>
            <label className="block text-xs font-bold opacity-70 uppercase mb-2" style={{ color: theme.colors.textMain }}>
              Agent Provider
            </label>
            <div
              className="p-2 rounded border text-sm"
              style={{
                borderColor: theme.colors.border,
                color: theme.colors.textDim,
                backgroundColor: theme.colors.bgActivity,
              }}
            >
              {agentName}
            </div>
            <p className="mt-1 text-xs" style={{ color: theme.colors.textDim }}>
              Provider cannot be changed after creation.
            </p>
          </div>

          {/* Working Directory (read-only) */}
          <div>
            <label className="block text-xs font-bold opacity-70 uppercase mb-2" style={{ color: theme.colors.textMain }}>
              Working Directory
            </label>
            <div
              className="p-2 rounded border font-mono text-sm overflow-hidden text-ellipsis"
              style={{
                borderColor: theme.colors.border,
                color: theme.colors.textDim,
                backgroundColor: theme.colors.bgActivity,
              }}
              title={session.projectRoot}
            >
              {session.projectRoot}
            </div>
            <p className="mt-1 text-xs" style={{ color: theme.colors.textDim }}>
              Directory cannot be changed. Create a new agent for a different directory.
            </p>
          </div>

          {/* Nudge Message */}
          <div>
            <label className="block text-xs font-bold opacity-70 uppercase mb-2" style={{ color: theme.colors.textMain }}>
              Nudge Message <span className="font-normal opacity-50">(optional)</span>
            </label>
            <textarea
              value={nudgeMessage}
              onChange={(e) => setNudgeMessage(e.target.value.slice(0, NUDGE_MESSAGE_MAX_LENGTH))}
              placeholder="Instructions appended to every message you send..."
              className="w-full p-2 rounded border bg-transparent outline-none resize-none text-sm"
              style={{
                borderColor: theme.colors.border,
                color: theme.colors.textMain,
                minHeight: '80px',
              }}
              maxLength={NUDGE_MESSAGE_MAX_LENGTH}
            />
            <p className="mt-1 text-xs" style={{ color: theme.colors.textDim }}>
              {nudgeMessage.length}/{NUDGE_MESSAGE_MAX_LENGTH} characters. This text is added to every message you send to the agent (not visible in chat).
            </p>
          </div>

          {/* Agent Configuration (custom path, args, env vars, agent-specific settings) */}
          {/* Per-session config (path, args, env vars) saved on modal save, not on blur */}
          {agent && (
            <div>
              <label className="block text-xs font-bold opacity-70 uppercase mb-2" style={{ color: theme.colors.textMain }}>
                {agentName} Settings
              </label>
              <AgentConfigPanel
                theme={theme}
                agent={agent}
                customPath={customPath}
                onCustomPathChange={setCustomPath}
                onCustomPathBlur={() => {/* Saved on modal save */}}
                onCustomPathClear={() => setCustomPath('')}
                customArgs={customArgs}
                onCustomArgsChange={setCustomArgs}
                onCustomArgsBlur={() => {/* Saved on modal save */}}
                onCustomArgsClear={() => setCustomArgs('')}
                customEnvVars={customEnvVars}
                onEnvVarKeyChange={(oldKey, newKey, value) => {
                  const newVars = { ...customEnvVars };
                  delete newVars[oldKey];
                  newVars[newKey] = value;
                  setCustomEnvVars(newVars);
                }}
                onEnvVarValueChange={(key, value) => {
                  setCustomEnvVars(prev => ({ ...prev, [key]: value }));
                }}
                onEnvVarRemove={(key) => {
                  const newVars = { ...customEnvVars };
                  delete newVars[key];
                  setCustomEnvVars(newVars);
                }}
                onEnvVarAdd={() => {
                  let newKey = 'NEW_VAR';
                  let counter = 1;
                  while (customEnvVars[newKey]) {
                    newKey = `NEW_VAR_${counter}`;
                    counter++;
                  }
                  setCustomEnvVars(prev => ({ ...prev, [newKey]: '' }));
                }}
                onEnvVarsBlur={() => {/* Saved on modal save */}}
                agentConfig={agentConfig}
                onConfigChange={(key, value) => {
                  setAgentConfig(prev => ({ ...prev, [key]: value }));
                }}
                onConfigBlur={() => {
                  // Both model and contextWindow are now saved per-session on modal save
                  // Other config options (if any) can still be saved at agent level
                  const { model: _model, contextWindow: _contextWindow, ...otherConfig } = agentConfig;
                  if (Object.keys(otherConfig).length > 0) {
                    window.maestro.agents.setConfig(session.toolType, otherConfig);
                  }
                }}
                availableModels={availableModels}
                loadingModels={loadingModels}
                onRefreshModels={refreshModels}
                onRefreshAgent={handleRefreshAgent}
                refreshingAgent={refreshingAgent}
                showBuiltInEnvVars
              />
            </div>
          )}
        </div>
      </Modal>
    </div>
  );
}
