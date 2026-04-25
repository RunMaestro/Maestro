import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Folder, AlertTriangle } from 'lucide-react';
import type { AgentConfig, Session, ToolType } from '../../types';
import type { SshRemoteConfig, AgentSshRemoteConfig } from '../../../shared/types';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';
import { validateNewSession } from '../../utils/sessionValidation';
import { FormInput } from '../ui/FormInput';
import { Modal, ModalFooter } from '../ui/Modal';
import { SshRemoteSelector } from '../shared/SshRemoteSelector';
import { formatShortcutKeys } from '../../utils/shortcutFormatter';
import type { AgentDebugInfo, NewInstanceModalProps } from './types';
import { SUPPORTED_AGENTS, NEW_SESSION_MESSAGE_MAX_LENGTH } from './types';
import { useRemotePathValidation } from '../../hooks/agent/useRemotePathValidation';
import { NudgeMessageField } from './NudgeMessageField';
import { RemotePathStatus } from './RemotePathStatus';
import { AgentPickerGrid } from './AgentPickerGrid';
import { logger } from '../../utils/logger';

export function NewInstanceModal({
	isOpen,
	onClose,
	onCreate,
	theme,
	existingSessions,
	sourceSession,
}: NewInstanceModalProps) {
	const [agents, setAgents] = useState<AgentConfig[]>([]);
	const [selectedAgent, setSelectedAgent] = useState('');
	const [expandedAgent, setExpandedAgent] = useState<string | null>(null);
	const [workingDir, setWorkingDir] = useState('');
	const [instanceName, setInstanceName] = useState('');
	const [nudgeMessage, setNudgeMessage] = useState('');
	const [newSessionMessage, setNewSessionMessage] = useState('');
	const [loading, setLoading] = useState(true);
	const [refreshingAgent, setRefreshingAgent] = useState<string | null>(null);
	const [debugInfo, setDebugInfo] = useState<AgentDebugInfo | null>(null);
	const [homeDir, setHomeDir] = useState<string>('');
	const [customAgentPaths, setCustomAgentPaths] = useState<Record<string, string>>({});
	const [customAgentArgs, setCustomAgentArgs] = useState<Record<string, string>>({});
	const [customAgentEnvVars, setCustomAgentEnvVars] = useState<
		Record<string, Record<string, string>>
	>({});
	const [agentConfigs, setAgentConfigs] = useState<Record<string, Record<string, any>>>({});
	const [availableModels, setAvailableModels] = useState<Record<string, string[]>>({});
	const [loadingModels, setLoadingModels] = useState<Record<string, boolean>>({});
	const [dynamicOptions, setDynamicOptions] = useState<Record<string, Record<string, string[]>>>(
		{}
	);
	const [loadingDynamicOptions, setLoadingDynamicOptions] = useState<Record<string, boolean>>({});
	const [directoryWarningAcknowledged, setDirectoryWarningAcknowledged] = useState(false);
	// SSH Remote configuration
	const [sshRemotes, setSshRemotes] = useState<SshRemoteConfig[]>([]);
	const [agentSshRemoteConfigs, setAgentSshRemoteConfigs] = useState<
		Record<string, AgentSshRemoteConfig>
	>({});
	// SSH connection error state - shown when we can't connect to the selected remote
	const [sshConnectionError, setSshConnectionError] = useState<string | null>(null);

	const nameInputRef = useRef<HTMLInputElement>(null);

	// Fetch home directory on mount for tilde expansion
	useEffect(() => {
		window.maestro.fs.homeDir().then(setHomeDir);
	}, []);

	// Expand tilde in path
	const expandTilde = React.useCallback(
		(path: string): string => {
			if (!homeDir) return path;
			if (path === '~') return homeDir;
			if (path.startsWith('~/')) return homeDir + path.slice(1);
			return path;
		},
		[homeDir]
	);

	const handleWorkingDirChange = React.useCallback((value: string) => {
		setWorkingDir(value);
		setDirectoryWarningAcknowledged(false);
	}, []);

	// Validate session uniqueness
	const validation = useMemo(() => {
		const name = instanceName.trim();
		const expandedDir = expandTilde(workingDir.trim());
		if (!name || !expandedDir || !selectedAgent) {
			return { valid: true }; // Don't show errors until fields are filled
		}
		const sshConfig = agentSshRemoteConfigs[selectedAgent] || agentSshRemoteConfigs['_pending_'];
		const sshRemoteId = sshConfig?.enabled ? sshConfig?.remoteId : null;
		return validateNewSession(
			name,
			expandedDir,
			selectedAgent as ToolType,
			existingSessions,
			sshRemoteId
		);
	}, [instanceName, workingDir, selectedAgent, existingSessions, homeDir, agentSshRemoteConfigs]);

	// Check if SSH remote is enabled for the selected agent or pending config
	// When no agent is selected, check the _pending_ config (user may select SSH before choosing agent)
	const isSshEnabled = useMemo(() => {
		const config = selectedAgent
			? agentSshRemoteConfigs[selectedAgent]
			: agentSshRemoteConfigs['_pending_'];
		return config?.enabled && !!config?.remoteId;
	}, [selectedAgent, agentSshRemoteConfigs]);

	// Get SSH remote host for display (moved up for use in validation)
	// Also works with pending config when no agent is selected
	const sshRemoteHost = useMemo(() => {
		if (!isSshEnabled) return undefined;
		const config = selectedAgent
			? agentSshRemoteConfigs[selectedAgent]
			: agentSshRemoteConfigs['_pending_'];
		if (!config?.remoteId) return undefined;
		const remote = sshRemotes.find((r) => r.id === config.remoteId);
		return remote?.host;
	}, [isSshEnabled, selectedAgent, agentSshRemoteConfigs, sshRemotes]);

	// Validate remote path when SSH is enabled (debounced)
	const remotePathValidation = useRemotePathValidation({
		isSshEnabled: !!isSshEnabled,
		path: workingDir,
		sshRemoteId: (agentSshRemoteConfigs[selectedAgent] || agentSshRemoteConfigs['_pending_'])
			?.remoteId,
	});

	// Define handlers first before they're used in effects
	const loadAgents = async (source?: Session, sshRemoteId?: string) => {
		setLoading(true);
		setSshConnectionError(null);
		try {
			const detectedAgents = await window.maestro.agents.detect(sshRemoteId);

			// Check if all agents have connection errors (indicates SSH connection failure)
			if (sshRemoteId) {
				const connectionErrors = detectedAgents
					.filter((a: AgentConfig) => !a.hidden)

					.filter((a: any) => a.error)

					.map((a: any) => a.error);
				const allHaveErrors =
					connectionErrors.length > 0 &&
					detectedAgents
						.filter((a: AgentConfig) => !a.hidden)

						.every((a: any) => a.error || !a.available);

				if (allHaveErrors && connectionErrors.length > 0) {
					setSshConnectionError(connectionErrors[0]);
					setLoading(false);
					return;
				}
			}

			setAgents(detectedAgents);

			// Per-agent config (path, args, env vars) starts empty - each agent gets its own config
			// No provider-level loading - config is set per-agent during creation
			// Only reset if NOT duplicating (source session will provide values)
			// Also preserve SSH configs when re-detecting (sshRemoteId is provided during re-detection)
			if (!source && !sshRemoteId) {
				setCustomAgentPaths({});
				setCustomAgentArgs({});
				setCustomAgentEnvVars({});
				setAgentSshRemoteConfigs({});
			}

			// Load configurations for all agents (model, contextWindow - these are provider-level)
			const configs: Record<string, Record<string, any>> = {};
			const paths: Record<string, string> = {};
			const args: Record<string, string> = {};
			const envVars: Record<string, Record<string, string>> = {};

			for (const agent of detectedAgents) {
				const config = await window.maestro.agents.getConfig(agent.id);
				configs[agent.id] = config;

				// Extract per-agent settings from the loaded config
				if (config.customPath) {
					paths[agent.id] = config.customPath;
				}
				if (config.customArgs) {
					args[agent.id] = config.customArgs;
				}
				if (config.customEnvVars && Object.keys(config.customEnvVars).length > 0) {
					envVars[agent.id] = config.customEnvVars;
				}
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
			setCustomAgentPaths(paths);
			setCustomAgentArgs(args);
			setCustomAgentEnvVars(envVars);

			// Select first available non-hidden agent (or source agent if duplicating)
			// (hidden agents like 'terminal' should never be auto-selected)
			if (source) {
				setSelectedAgent(source.toolType);
			} else if (!sshRemoteId) {
				// Only auto-select on initial load, not on SSH remote re-detection
				const firstAvailable = detectedAgents.find((a: AgentConfig) => a.available && !a.hidden);
				if (firstAvailable) {
					setSelectedAgent(firstAvailable.id);
				}
			}

			// Pre-fill form fields AFTER agents are loaded (ensures no race condition)
			if (source) {
				handleWorkingDirChange(source.cwd);
				setInstanceName(`${source.name} (Copy)`);
				setNudgeMessage(source.nudgeMessage || '');
				setNewSessionMessage(source.newSessionMessage || '');

				// Pre-fill custom agent configuration
				setCustomAgentPaths((prev) => ({
					...prev,
					[source.toolType]: source.customPath || '',
				}));
				setCustomAgentArgs((prev) => ({
					...prev,
					[source.toolType]: source.customArgs || '',
				}));
				setCustomAgentEnvVars((prev) => ({
					...prev,
					[source.toolType]: source.customEnvVars || {},
				}));

				// Pre-fill SSH remote configuration if source session has it
				if (source.sessionSshRemoteConfig?.enabled && source.sessionSshRemoteConfig?.remoteId) {
					setAgentSshRemoteConfigs((prev) => ({
						...prev,
						[source.toolType]: {
							enabled: true,
							remoteId: source.sessionSshRemoteConfig!.remoteId!,
							workingDirOverride: source.sessionSshRemoteConfig!.workingDirOverride,
						},
					}));
				}
			}
		} catch (error) {
			logger.error('Failed to load agents:', undefined, error);
		} finally {
			setLoading(false);
		}
	};

	const handleSelectFolder = React.useCallback(async () => {
		const folder = await window.maestro.dialog.selectFolder();
		if (folder) {
			handleWorkingDirChange(folder);
		}
	}, [handleWorkingDirChange]);

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
			logger.error('Failed to refresh agent:', undefined, error);
		} finally {
			setRefreshingAgent(null);
		}
	}, []);

	// Load available models for an agent that supports model selection
	const loadModelsForAgent = React.useCallback(
		async (agentId: string, forceRefresh = false) => {
			// Check if agent supports model selection
			const agent = agents.find((a) => a.id === agentId);
			if (!agent?.capabilities?.supportsModelSelection) return;

			// Skip if already loaded and not forcing refresh
			if (!forceRefresh && availableModels[agentId]?.length > 0) return;

			setLoadingModels((prev) => ({ ...prev, [agentId]: true }));
			try {
				const models = await window.maestro.agents.getModels(agentId, forceRefresh);
				setAvailableModels((prev) => ({ ...prev, [agentId]: models }));
			} catch (error) {
				logger.error(`Failed to load models for ${agentId}:`, undefined, error);
			} finally {
				setLoadingModels((prev) => ({ ...prev, [agentId]: false }));
			}
		},
		[agents, availableModels]
	);

	// Load dynamic config options for an agent (e.g., effort levels, reasoning levels)
	const loadDynamicOptionsForAgent = React.useCallback(
		async (agentId: string) => {
			const agent = agents.find((a) => a.id === agentId);
			if (!agent?.configOptions) return;

			const dynamicSelects = agent.configOptions.filter(
				(opt: any) => opt.type === 'select' && opt.dynamic
			);
			if (dynamicSelects.length === 0) return;

			// Skip if already loaded
			if (dynamicOptions[agentId] && Object.keys(dynamicOptions[agentId]).length > 0) return;

			setLoadingDynamicOptions((prev) => ({ ...prev, [agentId]: true }));
			try {
				const results: Record<string, string[]> = {};
				await Promise.all(
					dynamicSelects.map(async (opt: any) => {
						try {
							const options = await window.maestro.agents.getConfigOptions(agentId, opt.key);
							results[opt.key] = options;
						} catch {
							// Fall back to static options
						}
					})
				);
				setDynamicOptions((prev) => ({ ...prev, [agentId]: results }));
			} finally {
				setLoadingDynamicOptions((prev) => ({ ...prev, [agentId]: false }));
			}
		},
		[agents, dynamicOptions]
	);

	const handleCreate = React.useCallback(() => {
		const name = instanceName.trim();
		if (!name) return; // Name is required
		// Expand tilde before passing to callback
		const expandedWorkingDir = expandTilde(workingDir.trim());

		// Validate before creating
		const sshConfig = agentSshRemoteConfigs[selectedAgent] || agentSshRemoteConfigs['_pending_'];
		const sshRemoteId = sshConfig?.enabled ? sshConfig?.remoteId : null;
		const result = validateNewSession(
			name,
			expandedWorkingDir,
			selectedAgent as ToolType,
			existingSessions,
			sshRemoteId
		);
		if (!result.valid) return;

		// Get per-agent config values
		const agentCustomPath = customAgentPaths[selectedAgent]?.trim() || undefined;
		const agentCustomArgs = customAgentArgs[selectedAgent]?.trim() || undefined;
		const agentCustomEnvVars =
			customAgentEnvVars[selectedAgent] && Object.keys(customAgentEnvVars[selectedAgent]).length > 0
				? customAgentEnvVars[selectedAgent]
				: undefined;
		// Get model from agent config - this will become per-session
		const agentCustomModel = agentConfigs[selectedAgent]?.model?.trim() || undefined;
		// Get contextWindow and providerPath from agent config
		const agentCustomContextWindow = agentConfigs[selectedAgent]?.contextWindow || undefined;
		const agentCustomProviderPath = agentConfigs[selectedAgent]?.providerPath?.trim() || undefined;

		// Get SSH remote configuration for this session (stored per-session, not per-agent)
		const sshRemoteConfig = agentSshRemoteConfigs[selectedAgent];
		// Convert to session-level format: ALWAYS pass explicitly to override any agent-level config
		// For new sessions, this ensures consistent behavior with the UI selection.
		// `shareHistoryToProjectDir` persists regardless of SSH enablement so it also
		// applies to agents that run locally but are controlled from another Maestro.
		const sessionSshRemoteConfig =
			sshRemoteConfig?.enabled && sshRemoteConfig?.remoteId
				? {
						enabled: true,
						remoteId: sshRemoteConfig.remoteId,
						// When SSH is enabled, the Working Directory field contains a remote path.
						// Use it as workingDirOverride so SSH terminals cd to the right place.
						workingDirOverride:
							sshRemoteConfig.workingDirOverride || expandedWorkingDir || undefined,
						syncHistory: sshRemoteConfig.syncHistory,
						shareHistoryToProjectDir: sshRemoteConfig.shareHistoryToProjectDir,
					}
				: {
						enabled: false,
						remoteId: null,
						shareHistoryToProjectDir: sshRemoteConfig?.shareHistoryToProjectDir,
					};

		onCreate(
			selectedAgent,
			expandedWorkingDir,
			name,
			nudgeMessage.trim() || undefined,
			newSessionMessage.trim() || undefined,
			agentCustomPath,
			agentCustomArgs,
			agentCustomEnvVars,
			agentCustomModel,
			agentCustomContextWindow,
			agentCustomProviderPath,
			sessionSshRemoteConfig
		);
		onClose();

		// Reset
		setInstanceName('');
		handleWorkingDirChange('');
		setNudgeMessage('');
		setNewSessionMessage('');
		// Reset per-agent config for selected agent
		setCustomAgentPaths((prev) => ({ ...prev, [selectedAgent]: '' }));
		setCustomAgentArgs((prev) => ({ ...prev, [selectedAgent]: '' }));
		setCustomAgentEnvVars((prev) => ({ ...prev, [selectedAgent]: {} }));
		setAgentSshRemoteConfigs((prev) => {
			const newConfigs = { ...prev };
			delete newConfigs[selectedAgent];
			return newConfigs;
		});
	}, [
		instanceName,
		selectedAgent,
		workingDir,
		nudgeMessage,
		newSessionMessage,
		customAgentPaths,
		customAgentArgs,
		customAgentEnvVars,
		agentConfigs,
		agentSshRemoteConfigs,
		onCreate,
		onClose,
		expandTilde,
		handleWorkingDirChange,
		existingSessions,
	]);

	// Check if form is valid for submission
	const isFormValid = useMemo(() => {
		const hasWarningThatNeedsAck = validation.warning && !directoryWarningAcknowledged;
		const agent = agents.find((a) => a.id === selectedAgent);
		// Agent is considered available if:
		// 1. It was auto-detected (agent.available), OR
		// 2. User specified a custom path for it
		const hasCustomPath = customAgentPaths[selectedAgent]?.trim();
		const isAgentUsable = agent?.available || !!hasCustomPath;
		// Remote path validation is informational only - don't block creation
		// Users may want to set up agent for a remote before the path exists
		return (
			selectedAgent &&
			isAgentUsable &&
			workingDir.trim() &&
			instanceName.trim() &&
			validation.valid &&
			!hasWarningThatNeedsAck
		);
	}, [
		selectedAgent,
		agents,
		workingDir,
		instanceName,
		validation.valid,
		validation.warning,
		directoryWarningAcknowledged,
		customAgentPaths,
	]);

	// Handle keyboard shortcuts via window listener (Modal stops propagation on its backdrop)
	useEffect(() => {
		if (!isOpen) return;
		const handler = (e: KeyboardEvent) => {
			// Handle Cmd+O for folder picker (disabled when SSH remote is active)
			if ((e.key === 'o' || e.key === 'O') && (e.metaKey || e.ctrlKey)) {
				e.preventDefault();
				if (!isSshEnabled) {
					handleSelectFolder();
				}
				return;
			}
			// Handle Cmd+Enter or Cmd+S for creating agent
			if ((e.metaKey || e.ctrlKey) && (e.key === 'Enter' || e.key === 's') && !e.shiftKey) {
				e.preventDefault();
				if (isFormValid) {
					handleCreate();
				}
			}
		};
		window.addEventListener('keydown', handler, true);
		return () => window.removeEventListener('keydown', handler, true);
	}, [isOpen, handleSelectFolder, handleCreate, isFormValid, isSshEnabled]);

	// Sort agents: supported first, then coming soon at the bottom
	const sortedAgents = useMemo(() => {
		const visible = agents.filter((a) => !a.hidden);
		const supported = visible.filter((a) => SUPPORTED_AGENTS.includes(a.id));
		const comingSoon = visible.filter((a) => !SUPPORTED_AGENTS.includes(a.id));
		return [...supported, ...comingSoon];
	}, [agents]);

	// Effects - load agents and optionally pre-fill from source session
	useEffect(() => {
		if (isOpen) {
			// Pass sourceSession to loadAgents to handle pre-fill AFTER agents are loaded
			// This prevents the race condition where loadAgents would overwrite pre-filled values
			loadAgents(sourceSession);
			// Keep all agents collapsed by default, or expand when duplicating to show custom config
			if (sourceSession) {
				setExpandedAgent(sourceSession.toolType);
			} else {
				setExpandedAgent(null);
			}
			// Reset warning acknowledgment when modal opens
			setDirectoryWarningAcknowledged(false);
		}
	}, [isOpen, sourceSession]);

	// Load SSH remote configurations independently of agent detection
	// This ensures SSH remotes are available even if agent detection fails
	useEffect(() => {
		if (isOpen) {
			const loadSshConfigs = async () => {
				try {
					const sshConfigsResult = await window.maestro.sshRemote.getConfigs();
					if (sshConfigsResult.success && sshConfigsResult.configs) {
						setSshRemotes(sshConfigsResult.configs);
					}
				} catch (sshError) {
					logger.error('Failed to load SSH remote configs:', undefined, sshError);
				}
			};
			loadSshConfigs();
		}
	}, [isOpen]);

	// Transfer pending SSH config to selected agent automatically
	// This ensures SSH config is preserved when agent is auto-selected or manually clicked
	useEffect(() => {
		if (
			selectedAgent &&
			agentSshRemoteConfigs['_pending_'] &&
			!agentSshRemoteConfigs[selectedAgent]
		) {
			setAgentSshRemoteConfigs((prev) => ({
				...prev,
				[selectedAgent]: prev['_pending_'],
			}));
		}
	}, [selectedAgent, agentSshRemoteConfigs]);

	// Track the current SSH remote ID for re-detection
	// Uses _pending_ key when no agent is selected, which is the shared SSH config
	const currentSshRemoteId = useMemo(() => {
		const config = agentSshRemoteConfigs['_pending_'] || agentSshRemoteConfigs[selectedAgent];
		return config?.enabled ? config.remoteId : null;
	}, [agentSshRemoteConfigs, selectedAgent]);

	// Track initial load to avoid re-running on first mount
	const initialLoadDoneRef = useRef(false);
	const lastSshRemoteIdRef = useRef<string | null | undefined>(undefined);

	// Re-detect agents when SSH remote selection changes
	// This allows users to see which agents are available on remote vs local
	useEffect(() => {
		// Skip if modal not open
		if (!isOpen) {
			initialLoadDoneRef.current = false;
			lastSshRemoteIdRef.current = undefined;
			return;
		}

		// Skip the initial load (handled by the isOpen effect above)
		if (!initialLoadDoneRef.current) {
			initialLoadDoneRef.current = true;
			lastSshRemoteIdRef.current = currentSshRemoteId;
			return;
		}

		// Only re-detect if the SSH remote ID actually changed
		if (lastSshRemoteIdRef.current === currentSshRemoteId) {
			return;
		}

		lastSshRemoteIdRef.current = currentSshRemoteId;

		// Re-run agent detection with the new SSH remote ID
		loadAgents(undefined, currentSshRemoteId ?? undefined);
	}, [isOpen, currentSshRemoteId]);

	if (!isOpen) return null;

	return (
		<Modal
			theme={theme}
			title="Create New Agent"
			priority={MODAL_PRIORITIES.NEW_INSTANCE}
			onClose={onClose}
			width={600}
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
				<AgentPickerGrid
					theme={theme}
					loading={loading}
					sshConnectionError={sshConnectionError}
					sortedAgents={sortedAgents}
					selectedAgent={selectedAgent}
					expandedAgent={expandedAgent}
					refreshingAgent={refreshingAgent}
					debugInfo={debugInfo}
					customAgentPaths={customAgentPaths}
					customAgentArgs={customAgentArgs}
					customAgentEnvVars={customAgentEnvVars}
					agentConfigs={agentConfigs}
					availableModels={availableModels}
					loadingModels={loadingModels}
					onAgentSelect={(agentId) => setSelectedAgent(agentId)}
					onAgentExpand={(agentId) => setExpandedAgent(agentId)}
					onRefreshAgent={handleRefreshAgent}
					onDismissDebug={() => setDebugInfo(null)}
					onCustomPathChange={(agentId, value) => {
						setCustomAgentPaths((prev) => ({ ...prev, [agentId]: value }));
					}}
					onCustomArgsChange={(agentId, value) => {
						setCustomAgentArgs((prev) => ({ ...prev, [agentId]: value }));
					}}
					onEnvVarKeyChange={(agentId, oldKey, newKey, value) => {
						const currentVars = { ...customAgentEnvVars[agentId] };
						delete currentVars[oldKey];
						currentVars[newKey] = value;
						setCustomAgentEnvVars((prev) => ({
							...prev,
							[agentId]: currentVars,
						}));
					}}
					onEnvVarValueChange={(agentId, key, value) => {
						setCustomAgentEnvVars((prev) => ({
							...prev,
							[agentId]: {
								...prev[agentId],
								[key]: value,
							},
						}));
					}}
					onEnvVarRemove={(agentId, key) => {
						const currentVars = { ...customAgentEnvVars[agentId] };
						delete currentVars[key];
						if (Object.keys(currentVars).length > 0) {
							setCustomAgentEnvVars((prev) => ({
								...prev,
								[agentId]: currentVars,
							}));
						} else {
							setCustomAgentEnvVars((prev) => {
								const newVars = { ...prev };
								delete newVars[agentId];
								return newVars;
							});
						}
					}}
					onEnvVarAdd={(agentId) => {
						const currentVars = customAgentEnvVars[agentId] || {};
						let newKey = 'NEW_VAR';
						let counter = 1;
						while (currentVars[newKey]) {
							newKey = `NEW_VAR_${counter}`;
							counter++;
						}
						setCustomAgentEnvVars((prev) => ({
							...prev,
							[agentId]: {
								...prev[agentId],
								[newKey]: '',
							},
						}));
					}}
					onConfigChange={(agentId, key, value) => {
						setAgentConfigs((prev) => ({
							...prev,
							[agentId]: {
								...prev[agentId],
								[key]: value,
							},
						}));
					}}
					onConfigBlur={(agentId, key, value) => {
						const updatedConfig = {
							...(agentConfigs[agentId] || {}),
							[key]: value,
						};
						void window.maestro.agents.setConfig(agentId, updatedConfig).catch((error) => {
							logger.error(`Failed to persist config for ${agentId}:`, undefined, error);
						});
					}}
					onRefreshModels={(agentId) => loadModelsForAgent(agentId, true)}
					onTransferPendingSshConfig={(agentId) => {
						setAgentSshRemoteConfigs((prev) => {
							const pendingConfig = prev['_pending_'];
							if (pendingConfig && !prev[agentId]) {
								return {
									...prev,
									[agentId]: pendingConfig,
								};
							}
							return prev;
						});
					}}
					onLoadModelsForAgent={(agentId) => loadModelsForAgent(agentId)}
					dynamicOptions={dynamicOptions}
					loadingDynamicOptions={loadingDynamicOptions}
					onLoadDynamicOptionsForAgent={loadDynamicOptionsForAgent}
				/>

				{/* Working Directory */}
				<FormInput
					theme={theme}
					label="Working Directory"
					value={workingDir}
					onChange={handleWorkingDirChange}
					placeholder={
						isSshEnabled
							? `Enter remote path${sshRemoteHost ? ` on ${sshRemoteHost}` : ''} (e.g., /home/user/project)`
							: 'Select directory...'
					}
					error={validation.errorField === 'directory' ? validation.error : undefined}
					monospace
					heightClass="p-2"
					addon={
						<button
							onClick={isSshEnabled ? undefined : handleSelectFolder}
							disabled={isSshEnabled}
							className={`p-2 rounded border transition-colors ${isSshEnabled ? 'opacity-40 cursor-not-allowed' : 'hover:bg-opacity-10'}`}
							style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
							title={
								isSshEnabled
									? `Folder picker unavailable for SSH remote${sshRemoteHost ? ` (${sshRemoteHost})` : ''}. Enter the remote path manually.`
									: `Browse folders (${formatShortcutKeys(['Meta', 'o'])})`
							}
						>
							<Folder className="w-5 h-5" />
						</button>
					}
				/>

				{/* Remote path validation status (only shown when SSH is enabled) */}
				{isSshEnabled && workingDir.trim() && (
					<RemotePathStatus
						theme={theme}
						validation={remotePathValidation}
						remoteHost={sshRemoteHost}
					/>
				)}

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

				{/* SSH Remote Execution - Top Level.
				    Always rendered, even when no remotes are configured, so the
				    "remote-controlled" toggle is reachable — it mirrors history
				    to the local project dir for a Maestro SSH'd into this
				    machine, independent of local SSH remote setup.
				    Uses '_pending_' key when no agent selected, transfers to
				    agent when selected. */}
				<SshRemoteSelector
					theme={theme}
					sshRemotes={sshRemotes}
					sshRemoteConfig={
						agentSshRemoteConfigs[selectedAgent] || agentSshRemoteConfigs['_pending_']
					}
					onSshRemoteConfigChange={(config) => {
						setAgentSshRemoteConfigs((prev) => {
							const newConfigs: Record<string, AgentSshRemoteConfig> = {
								...prev,
								_pending_: config,
							};
							if (selectedAgent) {
								newConfigs[selectedAgent] = config;
							}
							return newConfigs;
						});
					}}
				/>

				{/* New Session Message */}
				<NudgeMessageField
					theme={theme}
					value={newSessionMessage}
					onChange={setNewSessionMessage}
					maxLength={NEW_SESSION_MESSAGE_MAX_LENGTH}
					label="New Session Message"
					description="This text is prefixed to your first message whenever a new session is created (not visible in chat)."
					placeholder="Instructions sent with the first message of every new session..."
				/>

				{/* Nudge Message */}
				<NudgeMessageField theme={theme} value={nudgeMessage} onChange={setNudgeMessage} />
			</div>
		</Modal>
	);
}
