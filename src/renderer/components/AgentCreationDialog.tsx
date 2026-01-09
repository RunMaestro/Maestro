/**
 * AgentCreationDialog
 *
 * Dialog for selecting an AI provider and creating a dedicated agent session
 * for a Symphony contribution. Shown when user clicks "Start Symphony" on an issue.
 *
 * Features:
 * - Filters to agents that support batch mode (required for Symphony)
 * - Accordion-style expandable agent config (Custom Path, Arguments, Env Vars)
 * - Folder browser for working directory
 * - Uses shared AgentSelector and AgentConfigPanel components
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
  Music,
  X,
  Loader2,
  Bot,
  Settings,
  FolderOpen,
  ChevronRight,
  RefreshCw,
} from 'lucide-react';
import type { Theme, AgentConfig } from '../types';
import type { RegisteredRepository, SymphonyIssue } from '../../shared/symphony-types';
import { useLayerStack } from '../contexts/LayerStackContext';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { AgentConfigPanel } from './shared/AgentConfigPanel';

// ============================================================================
// Types
// ============================================================================

export interface AgentCreationDialogProps {
  theme: Theme;
  isOpen: boolean;
  onClose: () => void;
  repo: RegisteredRepository;
  issue: SymphonyIssue;
  onCreateAgent: (config: AgentCreationConfig) => Promise<{ success: boolean; error?: string }>;
}

export interface AgentCreationConfig {
  /** Selected agent type (e.g., 'claude-code') */
  agentType: string;
  /** Session name (pre-filled, editable) */
  sessionName: string;
  /** Working directory (pre-filled, editable) */
  workingDirectory: string;
  /** Repository being contributed to */
  repo: RegisteredRepository;
  /** Issue being worked on */
  issue: SymphonyIssue;
  /** Custom path override for the agent */
  customPath?: string;
  /** Custom arguments for the agent */
  customArgs?: string;
  /** Custom environment variables */
  customEnvVars?: Record<string, string>;
  /** Agent-specific configuration options */
  agentConfig?: Record<string, any>;
}

// ============================================================================
// Main Dialog Component
// ============================================================================

export function AgentCreationDialog({
  theme,
  isOpen,
  onClose,
  repo,
  issue,
  onCreateAgent,
}: AgentCreationDialogProps) {
  const { registerLayer, unregisterLayer } = useLayerStack();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // State
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const [isLoadingAgents, setIsLoadingAgents] = useState(true);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [expandedAgent, setExpandedAgent] = useState<string | null>(null);
  const [sessionName, setSessionName] = useState('');
  const [workingDirectory, setWorkingDirectory] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshingAgent, setRefreshingAgent] = useState<string | null>(null);

  // Per-agent customization state
  const [customAgentPaths, setCustomAgentPaths] = useState<Record<string, string>>({});
  const [customAgentArgs, setCustomAgentArgs] = useState<Record<string, string>>({});
  const [customAgentEnvVars, setCustomAgentEnvVars] = useState<Record<string, Record<string, string>>>({});
  const [agentConfigs, setAgentConfigs] = useState<Record<string, Record<string, any>>>({});
  const [availableModels, setAvailableModels] = useState<Record<string, string[]>>({});
  const [loadingModels, setLoadingModels] = useState<Record<string, boolean>>({});

  // Get currently selected agent object
  const selectedAgentObj = agents.find(a => a.id === selectedAgent);

  // Filter function: only agents that support batch mode (required for Symphony)
  const symphonyAgentFilter = useCallback((agent: AgentConfig) => {
    return (
      agent.id !== 'terminal' &&
      agent.available &&
      !agent.hidden &&
      agent.capabilities?.supportsBatchMode === true
    );
  }, []);

  // Reset all state when dialog opens
  useEffect(() => {
    if (isOpen) {
      // Reset error state
      setError(null);
      setIsCreating(false);

      // Generate default values for this repo/issue
      if (repo && issue) {
        setSessionName(`Symphony: ${repo.slug} #${issue.number}`);
        const [owner, repoName] = repo.slug.split('/');
        const homeDir = '~';
        setWorkingDirectory(`${homeDir}/Maestro-Symphony/${owner}-${repoName}`);
      }
    }
  }, [isOpen, repo, issue]);

  // Fetch available agents
  useEffect(() => {
    if (isOpen) {
      setIsLoadingAgents(true);
      window.maestro.agents.detect()
        .then((detectedAgents: AgentConfig[]) => {
          setAgents(detectedAgents);
          // Auto-select first compatible agent
          const compatibleAgents = detectedAgents.filter(symphonyAgentFilter);
          if (compatibleAgents.length > 0 && !selectedAgent) {
            setSelectedAgent(compatibleAgents[0].id);
          }
        })
        .catch((err: Error) => {
          setError('Failed to detect available agents');
          console.error('Agent detection failed:', err);
        })
        .finally(() => {
          setIsLoadingAgents(false);
        });
    }
  }, [isOpen, symphonyAgentFilter]);

  // Load models for an agent
  const loadModelsForAgent = useCallback(async (agentId: string, force = false) => {
    if (!force && availableModels[agentId]) return;

    setLoadingModels(prev => ({ ...prev, [agentId]: true }));
    try {
      const models = await window.maestro.agents.getModels(agentId, force);
      setAvailableModels(prev => ({ ...prev, [agentId]: models || [] }));
    } catch (err) {
      console.error('Failed to load models for', agentId, err);
    } finally {
      setLoadingModels(prev => ({ ...prev, [agentId]: false }));
    }
  }, [availableModels]);

  // Refresh single agent detection
  const handleRefreshAgent = useCallback(async (agentId: string) => {
    setRefreshingAgent(agentId);
    try {
      const result = await window.maestro.agents.refresh(agentId);
      if (result?.agents) {
        // Update all agents with the refreshed data
        setAgents(result.agents);
      }
    } catch (err) {
      console.error('Failed to refresh agent:', err);
    } finally {
      setRefreshingAgent(null);
    }
  }, []);

  // Layer stack registration
  useEffect(() => {
    if (isOpen) {
      const id = registerLayer({
        type: 'modal',
        priority: MODAL_PRIORITIES.SYMPHONY_AGENT_CREATION ?? 711,
        blocksLowerLayers: true,
        capturesFocus: true,
        focusTrap: 'strict',
        ariaLabel: 'Create Agent for Symphony Contribution',
        onEscape: () => onCloseRef.current(),
      });
      return () => unregisterLayer(id);
    }
  }, [isOpen, registerLayer, unregisterLayer]);

  // Handle folder selection
  const handleSelectFolder = useCallback(async () => {
    const folder = await window.maestro.dialog.selectFolder();
    if (folder) {
      setWorkingDirectory(folder);
    }
  }, []);

  // Handle agent selection (also expands it)
  const handleSelectAgent = useCallback((agentId: string) => {
    setSelectedAgent(agentId);
    setExpandedAgent(prev => prev === agentId ? null : agentId);

    // Load models if agent supports model selection
    const agent = agents.find(a => a.id === agentId);
    if (agent?.capabilities?.supportsModelSelection) {
      loadModelsForAgent(agentId);
    }
  }, [agents, loadModelsForAgent]);

  // Handle create
  const handleCreate = useCallback(async () => {
    if (!selectedAgent || !sessionName.trim()) return;

    setIsCreating(true);
    setError(null);

    try {
      const result = await onCreateAgent({
        agentType: selectedAgent,
        sessionName: sessionName.trim(),
        workingDirectory,
        repo,
        issue,
        customPath: customAgentPaths[selectedAgent] || undefined,
        customArgs: customAgentArgs[selectedAgent] || undefined,
        customEnvVars: customAgentEnvVars[selectedAgent] || undefined,
        agentConfig: agentConfigs[selectedAgent] || undefined,
      });

      if (!result.success) {
        setError(result.error ?? 'Failed to create agent session');
      }
      // On success, parent will close dialog
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create agent');
    } finally {
      setIsCreating(false);
    }
  }, [selectedAgent, sessionName, workingDirectory, repo, issue, customAgentPaths, customAgentArgs, customAgentEnvVars, agentConfigs, onCreateAgent]);

  if (!isOpen) return null;

  // Get filtered agents
  const filteredAgents = agents.filter(symphonyAgentFilter);

  const modalContent = (
    <div
      className="fixed inset-0 modal-overlay flex items-center justify-center z-[9999] animate-in fade-in duration-100"
      style={{ backgroundColor: 'rgba(0, 0, 0, 0.6)' }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-creation-dialog-title"
        tabIndex={-1}
        className="w-[550px] max-w-[95vw] max-h-[90vh] rounded-xl shadow-2xl border overflow-hidden flex flex-col outline-none"
        style={{ backgroundColor: theme.colors.bgActivity, borderColor: theme.colors.border }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b shrink-0" style={{ borderColor: theme.colors.border }}>
          <div className="flex items-center gap-2">
            <Music className="w-5 h-5" style={{ color: theme.colors.accent }} />
            <h2 id="agent-creation-dialog-title" className="text-lg font-semibold" style={{ color: theme.colors.textMain }}>
              Create Agent Session
            </h2>
          </div>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-white/10 transition-colors" title="Close (Esc)">
            <X className="w-4 h-4" style={{ color: theme.colors.textDim }} />
          </button>
        </div>

        {/* Content - scrollable */}
        <div className="p-4 space-y-4 overflow-y-auto flex-1">
          {/* Issue info */}
          <div className="p-3 rounded-lg" style={{ backgroundColor: theme.colors.bgMain }}>
            <p className="text-xs mb-1" style={{ color: theme.colors.textDim }}>Contributing to</p>
            <p className="font-medium" style={{ color: theme.colors.textMain }}>{repo.name}</p>
            <p className="text-sm" style={{ color: theme.colors.textDim }}>
              #{issue.number}: {issue.title}
            </p>
            <p className="text-xs mt-1" style={{ color: theme.colors.textDim }}>
              {issue.documentPaths.length} Auto Run document{issue.documentPaths.length !== 1 ? 's' : ''}
            </p>
          </div>

          {/* Agent selection with accordion */}
          <div>
            <label className="block text-sm font-medium mb-2" style={{ color: theme.colors.textMain }}>
              <Bot className="w-4 h-4 inline mr-1" />
              Select AI Provider
            </label>

            {isLoadingAgents ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="w-6 h-6 animate-spin" style={{ color: theme.colors.accent }} />
              </div>
            ) : filteredAgents.length === 0 ? (
              <div className="text-center py-4" style={{ color: theme.colors.textDim }}>
                <p>No compatible AI agents detected.</p>
                <p className="text-xs mt-1">Symphony requires an agent with batch mode support (Claude Code, Codex, or OpenCode).</p>
              </div>
            ) : (
              <div className="space-y-2">
                {filteredAgents.map((agent) => {
                  const isSelected = selectedAgent === agent.id;
                  const isExpanded = expandedAgent === agent.id;
                  const isBetaAgent = agent.id === 'codex' || agent.id === 'opencode';

                  return (
                    <div
                      key={agent.id}
                      className="rounded-lg border transition-all"
                      style={{
                        borderColor: isSelected ? theme.colors.accent : theme.colors.border,
                        ...(isSelected && { boxShadow: `0 0 0 2px ${theme.colors.accent}` }),
                      }}
                    >
                      {/* Agent header row */}
                      <div
                        onClick={() => handleSelectAgent(agent.id)}
                        className="w-full text-left px-3 py-2 flex items-center justify-between hover:bg-white/5 cursor-pointer"
                        style={{ color: theme.colors.textMain }}
                      >
                        <div className="flex items-center gap-2">
                          <ChevronRight
                            className={`w-4 h-4 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
                            style={{ color: theme.colors.textDim }}
                          />
                          <span className="font-medium">{agent.name}</span>
                          {isBetaAgent && (
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
                          <span
                            className="text-xs px-2 py-0.5 rounded"
                            style={{ backgroundColor: theme.colors.success + '20', color: theme.colors.success }}
                          >
                            Available
                          </span>
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
                        </div>
                      </div>

                      {/* Expanded config panel */}
                      {isExpanded && (
                        <div className="px-3 pb-3 pt-2 border-t" style={{ borderColor: theme.colors.border }}>
                          <AgentConfigPanel
                            theme={theme}
                            agent={agent}
                            customPath={customAgentPaths[agent.id] || ''}
                            onCustomPathChange={(value) => {
                              setCustomAgentPaths(prev => ({ ...prev, [agent.id]: value }));
                            }}
                            onCustomPathBlur={() => {}}
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
                            onCustomArgsBlur={() => {}}
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
                            onEnvVarsBlur={() => {}}
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
                            onConfigBlur={() => {}}
                            availableModels={availableModels[agent.id] || []}
                            loadingModels={loadingModels[agent.id] || false}
                            onRefreshModels={() => loadModelsForAgent(agent.id, true)}
                            onRefreshAgent={() => handleRefreshAgent(agent.id)}
                            refreshingAgent={refreshingAgent === agent.id}
                            compact
                            showBuiltInEnvVars
                          />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Session name */}
          <div>
            <label className="block text-sm font-medium mb-2" style={{ color: theme.colors.textMain }}>
              <Settings className="w-4 h-4 inline mr-1" />
              Session Name
            </label>
            <input
              type="text"
              value={sessionName}
              onChange={(e) => setSessionName(e.target.value)}
              className="w-full px-3 py-2 rounded border bg-transparent outline-none text-sm focus:ring-1"
              style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
              placeholder="Symphony: owner/repo #123"
            />
          </div>

          {/* Working directory (editable with folder browser) */}
          <div>
            <label className="block text-sm font-medium mb-2" style={{ color: theme.colors.textMain }}>
              <FolderOpen className="w-4 h-4 inline mr-1" />
              Working Directory
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={workingDirectory}
                onChange={(e) => setWorkingDirectory(e.target.value)}
                className="flex-1 px-3 py-2 rounded border bg-transparent outline-none text-sm focus:ring-1"
                style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
                placeholder="~/Maestro-Symphony/owner-repo"
              />
              <button
                onClick={handleSelectFolder}
                className="px-3 py-2 rounded border hover:bg-white/10 transition-colors"
                style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
                title="Browse for folder"
              >
                <FolderOpen className="w-4 h-4" />
              </button>
            </div>
            <p className="text-xs mt-1" style={{ color: theme.colors.textDim }}>
              Repository will be cloned here
            </p>
          </div>

          {/* Error display */}
          {error && (
            <div className="p-3 rounded-lg text-sm" style={{ backgroundColor: '#cc331120', color: '#cc3311' }}>
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 px-4 py-3 border-t shrink-0" style={{ borderColor: theme.colors.border }}>
          <button
            onClick={onClose}
            className="px-4 py-2 rounded text-sm hover:bg-white/10 transition-colors"
            style={{ color: theme.colors.textDim }}
          >
            Cancel
          </button>
          <button
            onClick={handleCreate}
            disabled={!selectedAgent || !sessionName.trim() || isCreating || filteredAgents.length === 0}
            className="px-4 py-2 rounded font-semibold text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            style={{ backgroundColor: theme.colors.accent, color: theme.colors.accentForeground }}
          >
            {isCreating ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Creating...
              </>
            ) : (
              <>
                <Bot className="w-4 h-4" />
                Create Agent
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(modalContent, document.body);
}

export default AgentCreationDialog;
