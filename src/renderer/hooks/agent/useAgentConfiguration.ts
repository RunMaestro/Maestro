/**
 * useAgentConfiguration
 *
 * Centralized hook for agent configuration state management.
 * Eliminates duplicated detection, config loading, model fetching,
 * and custom path/args/envvars state across GroupChatModal, EncoreTab,
 * AgentCreationDialog, and NewInstanceModal.
 *
 * Supports single-agent mode (flat state) for GroupChatModal and EncoreTab.
 * Multi-agent mode (Record-based state) will be added in a later phase.
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { AgentConfig } from '../../types';
import type {
	SshRemoteConfig,
	AgentSshRemoteConfig,
	AgentDiscoveryRequest,
	AgentDiscoveryResult,
} from '../../../shared/types';
import { logger } from '../../utils/logger';
import { getEffortConfigKey, readEffortFromConfig } from '../../utils/agentEffort';
import { useDebouncedValue } from '../utils/useThrottle';

export interface UseAgentConfigurationOptions {
	/** Whether the hook should be active (e.g., modal is open) */
	enabled: boolean;
	/** Filter which agents to show */
	agentFilter?: (agent: AgentConfig) => boolean;
	/** Whether to auto-select the first available agent (default: true) */
	autoSelect?: boolean;
	/** Whether to load SSH remotes (default: false) */
	loadSshRemotes?: boolean;
	/** Host-owned discovery needs the selected workspace; omission stays unavailable. */
	discoveryContext?: Exclude<AgentDiscoveryRequest['context'], { kind: 'agent' }>;
	/** Initial values for edit mode or pre-populated state */
	initialValues?: {
		selectedAgent?: string;
		customPath?: string;
		customArgs?: string;
		customEnvVars?: Record<string, string>;
		/** Env vars switched off in the editor: parked, never spawned with. */
		customEnvVarsDisabled?: Record<string, string>;
		/** Claude token-source: legacy Adaptive opt-in (off => pure API). */
		enableMaestroP?: boolean;
		/** Refines `enableMaestroP`: 'interactive' always TUI, 'dynamic' auto-switch. */
		maestroPMode?: 'interactive' | 'dynamic';
		/** Optional override path to the maestro-p binary. */
		maestroPPath?: string;
	};
}

export interface UseAgentConfigurationReturn {
	// Detection
	detectedAgents: AgentConfig[];
	isDetecting: boolean;
	detectAgents: () => Promise<void>;

	// Selection
	selectedAgent: string | null;
	setSelectedAgent: (agentId: string | null) => void;
	handleAgentChange: (agentId: string) => void;

	// Config expansion
	isConfigExpanded: boolean;
	toggleConfigExpanded: () => void;

	// Custom config
	customPath: string;
	setCustomPath: (path: string) => void;
	customArgs: string;
	setCustomArgs: (args: string) => void;
	customEnvVars: Record<string, string>;
	setCustomEnvVars: (vars: Record<string, string>) => void;
	/**
	 * Env vars the user switched off. Held separately from `customEnvVars` so a
	 * parked var never reaches a spawn - see Session.customEnvVarsDisabled.
	 */
	customEnvVarsDisabled: Record<string, string>;
	setCustomEnvVarsDisabled: Dispatch<SetStateAction<Record<string, string>>>;

	// Claude token source (maestro-p TUI vs `claude --print` API)
	enableMaestroP: boolean;
	setEnableMaestroP: (enabled: boolean) => void;
	maestroPMode: 'interactive' | 'dynamic';
	setMaestroPMode: (mode: 'interactive' | 'dynamic') => void;
	maestroPPath: string;
	setMaestroPPath: (path: string) => void;

	// Agent config (model, context window, etc.)
	agentConfig: Record<string, any>;
	setAgentConfig: (config: Record<string, any>) => void;
	agentConfigRef: React.MutableRefObject<Record<string, any>>;

	// Models
	availableModels: string[];
	loadingModels: boolean;
	modelDiscoveryStatus: AgentDiscoveryResult['status'];
	refreshModels: () => Promise<void>;

	// Dynamic config options (for select fields with dynamic: true)
	dynamicOptions: Record<string, string[]>;
	loadingDynamicOptions: boolean;
	dynamicOptionStatuses: Record<string, AgentDiscoveryResult['status']>;

	// Refresh
	refreshingAgent: boolean;
	refreshAgent: () => Promise<void>;

	// SSH (when loadSshRemotes is true)
	sshRemotes: SshRemoteConfig[];
	sshRemoteConfig: AgentSshRemoteConfig | undefined;
	setSshRemoteConfig: (config: AgentSshRemoteConfig | undefined) => void;

	// Utilities
	loadAgentConfig: (agentId: string) => Promise<void>;
	saveAgentConfig: (agentId: string) => Promise<boolean>;
	resetState: () => void;
	hasCustomization: boolean;
}

export function useAgentConfiguration(
	options: UseAgentConfigurationOptions
): UseAgentConfigurationReturn {
	const {
		enabled,
		agentFilter,
		autoSelect = true,
		loadSshRemotes: shouldLoadSshRemotes = false,
		initialValues,
		discoveryContext,
	} = options;

	// Detection state
	const [detectedAgents, setDetectedAgents] = useState<AgentConfig[]>([]);
	const [isDetecting, setIsDetecting] = useState(true);

	// Selection
	const [selectedAgent, setSelectedAgent] = useState<string | null>(
		initialValues?.selectedAgent ?? null
	);
	const selectedAgentRef = useRef(selectedAgent);
	selectedAgentRef.current = selectedAgent;

	// Config expansion
	const [isConfigExpanded, setIsConfigExpanded] = useState(false);

	// Custom config
	const [customPath, setCustomPathState] = useState(initialValues?.customPath ?? '');
	const [hasCustomPathOverride, setHasCustomPathOverride] = useState(
		initialValues?.customPath !== undefined
	);
	const setCustomPath = useCallback((value: string) => {
		setHasCustomPathOverride(true);
		setCustomPathState(value);
	}, []);
	const [customArgs, setCustomArgs] = useState(initialValues?.customArgs ?? '');
	const [customEnvVars, setCustomEnvVarsState] = useState<Record<string, string>>(
		initialValues?.customEnvVars ?? {}
	);
	const [hasCustomEnvOverride, setHasCustomEnvOverride] = useState(
		initialValues?.customEnvVars !== undefined
	);
	const setCustomEnvVars = useCallback((vars: Record<string, string>) => {
		setHasCustomEnvOverride(true);
		setCustomEnvVarsState(vars);
	}, []);
	const [customEnvVarsDisabled, setCustomEnvVarsDisabled] = useState<Record<string, string>>(
		initialValues?.customEnvVarsDisabled ?? {}
	);

	// Claude token source (maestro-p TUI vs `claude --print` API)
	const [enableMaestroP, setEnableMaestroP] = useState(initialValues?.enableMaestroP ?? false);
	const [maestroPMode, setMaestroPMode] = useState<'interactive' | 'dynamic'>(
		initialValues?.maestroPMode ?? 'dynamic'
	);
	const [maestroPPath, setMaestroPPath] = useState(initialValues?.maestroPPath ?? '');

	// Agent config
	const [agentConfig, setAgentConfig] = useState<Record<string, any>>({});
	const agentConfigRef = useRef<Record<string, any>>({});

	// Models
	const [availableModels, setAvailableModels] = useState<string[]>([]);
	const [loadingModels, setLoadingModels] = useState(false);
	const [modelDiscoveryStatus, setModelDiscoveryStatus] =
		useState<AgentDiscoveryResult['status']>('unavailable');

	// Dynamic config options (for select fields with dynamic: true)
	const [dynamicOptions, setDynamicOptions] = useState<Record<string, string[]>>({});
	const [loadingDynamicOptions, setLoadingDynamicOptions] = useState(false);
	const [dynamicOptionStatuses, setDynamicOptionStatuses] = useState<
		Record<string, AgentDiscoveryResult['status']>
	>({});
	const latestDiscoveryRequestRef = useRef(0);

	// Guard against stale async results when switching agents rapidly
	const latestLoadRequestRef = useRef(0);

	// Refresh
	const [refreshingAgent, setRefreshingAgent] = useState(false);

	// SSH
	const [sshRemotes, setSshRemotes] = useState<SshRemoteConfig[]>([]);
	const [sshRemoteConfig, setSshRemoteConfig] = useState<AgentSshRemoteConfig | undefined>(
		undefined
	);

	// Reset all state
	const resetState = useCallback(() => {
		latestLoadRequestRef.current++;
		latestDiscoveryRequestRef.current++;
		setModelDiscoveryStatus('unavailable');
		setDynamicOptionStatuses({});
		setDetectedAgents([]);
		setIsDetecting(true);
		setSelectedAgent(null);
		setIsConfigExpanded(false);
		setCustomPathState('');
		setHasCustomPathOverride(false);
		setCustomArgs('');
		setCustomEnvVarsState({});
		setHasCustomEnvOverride(false);
		setEnableMaestroP(false);
		setMaestroPMode('dynamic');
		setMaestroPPath('');
		setAgentConfig({});
		agentConfigRef.current = {};
		setAvailableModels([]);
		setLoadingModels(false);
		setDynamicOptions({});
		setLoadingDynamicOptions(false);
		setRefreshingAgent(false);
		setSshRemoteConfig(undefined);
	}, []);

	// Detect agents
	const detectAgents = useCallback(async () => {
		setIsDetecting(true);
		try {
			const agents = await window.maestro.agents.detect();
			const filtered = agentFilter
				? agents.filter(agentFilter)
				: agents.filter((a: AgentConfig) => a.available && !a.hidden);
			setDetectedAgents(filtered);

			// Auto-select first available agent if none selected
			if (autoSelect && !selectedAgentRef.current && filtered.length > 0) {
				setSelectedAgent(filtered[0].id);
			}
		} catch (error) {
			logger.error('Failed to detect agents:', undefined, error);
		} finally {
			setIsDetecting(false);
		}
	}, [agentFilter, autoSelect]);

	// Load agent config
	const loadAgentConfig = useCallback(
		async (agentId: string) => {
			const requestId = ++latestLoadRequestRef.current;
			const selectedAtRequest = selectedAgentRef.current;
			const current = () =>
				latestLoadRequestRef.current === requestId &&
				selectedAgentRef.current === selectedAtRequest;

			const config = await window.maestro.agents.getConfig(agentId);
			if (!current()) return; // stale
			setAgentConfig(config || {});
			agentConfigRef.current = config || {};
			// Grok discovery follows the current draft in its own effect below.
			if (agentId === 'grok') return;

			// Load models if agent supports it
			const agent = detectedAgents.find((a) => a.id === agentId);
			if (agent?.capabilities?.supportsModelSelection) {
				setLoadingModels(true);
				try {
					const models = await window.maestro.agents.getModels(agentId);
					if (!current()) return; // stale
					setAvailableModels(models);
				} catch (err) {
					logger.error('Failed to load models:', undefined, err);
				} finally {
					if (current()) {
						setLoadingModels(false);
					}
				}
			}

			// Load dynamic config options for select fields with dynamic: true
			if (agent?.configOptions) {
				const dynamicSelects = agent.configOptions.filter(
					(opt: any) => opt.type === 'select' && opt.dynamic
				);
				if (dynamicSelects.length > 0) {
					setLoadingDynamicOptions(true);
					try {
						const results: Record<string, string[]> = {};
						await Promise.all(
							dynamicSelects.map(async (opt: any) => {
								try {
									const options = await window.maestro.agents.getConfigOptions(agentId, opt.key);
									results[opt.key] = options;
								} catch {
									// Silently fall back to static options
								}
							})
						);
						if (!current()) return;
						setDynamicOptions(results);
					} finally {
						if (current()) {
							setLoadingDynamicOptions(false);
						}
					}
				}
			}
		},
		[detectedAgents]
	);

	const selectedEffort =
		readEffortFromConfig(agentConfig) ??
		(typeof agentConfig.reasoningEffort === 'string' || typeof agentConfig.effort === 'string'
			? ''
			: undefined);
	const grokRequest = useMemo<AgentDiscoveryRequest | undefined>(
		() =>
			selectedAgent === 'grok'
				? {
						providerId: selectedAgent,
						context: {
							kind: discoveryContext?.kind ?? 'draft',
							cwd: discoveryContext?.cwd,
							sshRemoteId: discoveryContext?.sshRemoteId,
							customPath: hasCustomPathOverride ? customPath : discoveryContext?.customPath,
							customEnvVars: hasCustomEnvOverride ? customEnvVars : discoveryContext?.customEnvVars,
							model: agentConfig.model ?? discoveryContext?.model,
							effort: selectedEffort ?? discoveryContext?.effort,
							sessionSshRemoteConfig: sshRemoteConfig ?? discoveryContext?.sessionSshRemoteConfig,
						},
					}
				: undefined,
		[
			selectedAgent,
			discoveryContext?.kind,
			discoveryContext?.cwd,
			discoveryContext?.customPath,
			discoveryContext?.sshRemoteId,
			discoveryContext?.customEnvVars,
			discoveryContext?.model,
			discoveryContext?.effort,
			discoveryContext?.sessionSshRemoteConfig,
			customPath,
			hasCustomPathOverride,
			customEnvVars,
			hasCustomEnvOverride,
			agentConfig.model,
			selectedEffort,
			sshRemoteConfig,
		]
	);
	const debouncedGrokRequest = useDebouncedValue(grokRequest, 300);
	const [resolvedGrokRequest, setResolvedGrokRequest] = useState<AgentDiscoveryRequest>();
	const currentGrokRequest = useRef(grokRequest);
	currentGrokRequest.current = grokRequest;
	const loadGrokOptions = useCallback(
		async (forceRefresh = false) => {
			if (!enabled || !grokRequest) return;
			const requestId = ++latestDiscoveryRequestRef.current;
			const current = () =>
				latestDiscoveryRequestRef.current === requestId &&
				currentGrokRequest.current === grokRequest;
			const effortKey = getEffortConfigKey(detectedAgents.find((a) => a.id === 'grok'));
			setAvailableModels([]);
			setDynamicOptions({});
			setModelDiscoveryStatus('unavailable');
			setDynamicOptionStatuses({});
			setLoadingModels(true);
			setLoadingDynamicOptions(true);
			const request = { ...grokRequest, forceRefresh };
			// The shared result carries configured fallbacks, not a validated catalog.
			await Promise.all([
				window.maestro.agents
					.getModels(request)
					.then((result) => {
						if (!current()) return;
						setAvailableModels(result.options);
						setModelDiscoveryStatus(result.status);
					})
					.catch(() => {
						if (current()) setModelDiscoveryStatus('unavailable');
					})
					.finally(() => {
						if (current()) setLoadingModels(false);
					}),
				window.maestro.agents
					.getConfigOptions(request, effortKey)
					.then((result) => {
						if (!current()) return;
						setDynamicOptions({ [effortKey]: result.options });
						setDynamicOptionStatuses({ [effortKey]: result.status });
					})
					.catch(() => {
						if (current()) setDynamicOptionStatuses({ [effortKey]: 'unavailable' });
					})
					.finally(() => {
						if (current()) setLoadingDynamicOptions(false);
					}),
			]);
			if (current()) setResolvedGrokRequest(grokRequest);
		},
		[enabled, grokRequest, detectedAgents]
	);

	useEffect(() => {
		if (grokRequest) {
			setAvailableModels([]);
			setDynamicOptions({});
			setModelDiscoveryStatus('unavailable');
			setDynamicOptionStatuses({});
			setLoadingModels(false);
			setLoadingDynamicOptions(false);
			if (isConfigExpanded && grokRequest === debouncedGrokRequest) void loadGrokOptions();
		}
		return () => {
			latestDiscoveryRequestRef.current++;
		};
	}, [grokRequest, debouncedGrokRequest, isConfigExpanded, loadGrokOptions]);

	// Save agent config via IPC
	const saveAgentConfig = useCallback(async (agentId: string): Promise<boolean> => {
		return await window.maestro.agents.setConfig(agentId, agentConfigRef.current);
	}, []);

	// Refresh models
	const refreshModels = useCallback(async () => {
		if (!selectedAgent) return;
		if (grokRequest) return loadGrokOptions(true);
		const requestId = ++latestDiscoveryRequestRef.current;
		const current = () =>
			latestDiscoveryRequestRef.current === requestId && selectedAgentRef.current === selectedAgent;
		setLoadingModels(true);
		try {
			const models = await window.maestro.agents.getModels(selectedAgent, true);
			if (!current()) return;
			setAvailableModels(models);
		} catch (err) {
			logger.error('Failed to refresh models:', undefined, err);
		} finally {
			if (current()) setLoadingModels(false);
		}
	}, [selectedAgent, grokRequest, loadGrokOptions]);

	// Refresh agent detection
	const refreshAgent = useCallback(async () => {
		setRefreshingAgent(true);
		try {
			const agents = await window.maestro.agents.detect();
			const filtered = agentFilter
				? agents.filter(agentFilter)
				: agents.filter((a: AgentConfig) => a.available && !a.hidden);
			setDetectedAgents(filtered);
		} catch (error) {
			logger.error('Failed to refresh agents:', undefined, error);
		} finally {
			setRefreshingAgent(false);
		}
	}, [agentFilter]);

	// Handle agent selection change - resets customizations and agent-scoped state
	const handleAgentChange = useCallback(
		(agentId: string) => {
			// Invalidate any in-flight loadAgentConfig requests
			latestLoadRequestRef.current++;

			setSelectedAgent(agentId);
			setCustomPathState('');
			setHasCustomPathOverride(false);
			setCustomArgs('');
			setCustomEnvVarsState({});
			setHasCustomEnvOverride(false);
			setEnableMaestroP(false);
			setMaestroPMode('dynamic');
			setMaestroPPath('');
			setAgentConfig({});
			agentConfigRef.current = {};
			setAvailableModels([]);
			setLoadingModels(false);
			setDynamicOptions({});
			setLoadingDynamicOptions(false);
			if (isConfigExpanded) {
				loadAgentConfig(agentId);
			}
		},
		[isConfigExpanded, loadAgentConfig]
	);

	// Toggle config expansion
	const toggleConfigExpanded = useCallback(() => {
		setIsConfigExpanded((prev) => !prev);
	}, []);

	// Detect agents and load SSH remotes when enabled
	useEffect(() => {
		if (!enabled) {
			resetState();
			return;
		}

		detectAgents();

		if (shouldLoadSshRemotes) {
			(async () => {
				try {
					const configsResult = await window.maestro.sshRemote.getConfigs();
					if (configsResult.success && configsResult.configs) {
						setSshRemotes(configsResult.configs);
					}
				} catch (error) {
					logger.error('Failed to load SSH remotes:', undefined, error);
				}
			})();
		}
	}, [enabled, detectAgents, resetState, shouldLoadSshRemotes]);

	useEffect(
		() => () => {
			latestLoadRequestRef.current++;
		},
		[selectedAgent, enabled]
	);

	// Load config when expanding
	useEffect(() => {
		if (isConfigExpanded && selectedAgent) {
			loadAgentConfig(selectedAgent);
		}
	}, [isConfigExpanded, selectedAgent, loadAgentConfig]);

	const staleGrokOptions = !!grokRequest && grokRequest !== resolvedGrokRequest;
	const hasCustomization = !!customPath || !!customArgs || Object.keys(customEnvVars).length > 0;

	return {
		// Detection
		detectedAgents,
		isDetecting,
		detectAgents,

		// Selection
		selectedAgent,
		setSelectedAgent,
		handleAgentChange,

		// Config expansion
		isConfigExpanded,
		toggleConfigExpanded,

		// Custom config
		customPath,
		setCustomPath,
		customArgs,
		setCustomArgs,
		customEnvVars,
		setCustomEnvVars,
		customEnvVarsDisabled,
		setCustomEnvVarsDisabled,

		// Claude token source
		enableMaestroP,
		setEnableMaestroP,
		maestroPMode,
		setMaestroPMode,
		maestroPPath,
		setMaestroPPath,

		// Agent config
		agentConfig,
		setAgentConfig,
		agentConfigRef,

		// Models
		availableModels: staleGrokOptions ? [] : availableModels,
		loadingModels,
		modelDiscoveryStatus: staleGrokOptions ? 'unavailable' : modelDiscoveryStatus,
		refreshModels,

		// Dynamic config options
		dynamicOptions: staleGrokOptions ? {} : dynamicOptions,
		loadingDynamicOptions,
		dynamicOptionStatuses: staleGrokOptions ? {} : dynamicOptionStatuses,

		// Refresh
		refreshingAgent,
		refreshAgent,

		// SSH
		sshRemotes,
		sshRemoteConfig,
		setSshRemoteConfig,

		// Utilities
		loadAgentConfig,
		saveAgentConfig,
		resetState,
		hasCustomization,
	};
}
