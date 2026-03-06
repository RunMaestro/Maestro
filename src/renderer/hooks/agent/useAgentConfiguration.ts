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

import { useState, useEffect, useRef, useCallback } from 'react';
import type { AgentConfig } from '../../types';
import type { SshRemoteConfig, AgentSshRemoteConfig } from '../../../shared/types';

declare const window: Window & {
	maestro: {
		agents: {
			detect: (sshRemoteId?: string) => Promise<AgentConfig[]>;
			getConfig: (agentId: string) => Promise<Record<string, any> | null>;
			setConfig: (agentId: string, config: Record<string, any>) => Promise<boolean>;
			getModels: (agentId: string, force?: boolean) => Promise<string[]>;
			refresh: (agentId: string) => Promise<void>;
		};
		sshRemote: {
			getConfigs: () => Promise<{ success: boolean; configs?: SshRemoteConfig[] }>;
		};
	};
};

export interface UseAgentConfigurationOptions {
	/** Whether the hook should be active (e.g., modal is open) */
	enabled: boolean;
	/** Filter which agents to show */
	agentFilter?: (agent: AgentConfig) => boolean;
	/** Whether to auto-select the first available agent (default: true) */
	autoSelect?: boolean;
	/** Whether to load SSH remotes (default: false) */
	loadSshRemotes?: boolean;
	/** Initial values for edit mode or pre-populated state */
	initialValues?: {
		selectedAgent?: string;
		customPath?: string;
		customArgs?: string;
		customEnvVars?: Record<string, string>;
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

	// Agent config (model, context window, etc.)
	agentConfig: Record<string, any>;
	setAgentConfig: (config: Record<string, any>) => void;
	agentConfigRef: React.MutableRefObject<Record<string, any>>;

	// Models
	availableModels: string[];
	loadingModels: boolean;
	refreshModels: () => Promise<void>;

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
	const [customPath, setCustomPath] = useState(initialValues?.customPath ?? '');
	const [customArgs, setCustomArgs] = useState(initialValues?.customArgs ?? '');
	const [customEnvVars, setCustomEnvVars] = useState<Record<string, string>>(
		initialValues?.customEnvVars ?? {}
	);

	// Agent config
	const [agentConfig, setAgentConfig] = useState<Record<string, any>>({});
	const agentConfigRef = useRef<Record<string, any>>({});

	// Models
	const [availableModels, setAvailableModels] = useState<string[]>([]);
	const [loadingModels, setLoadingModels] = useState(false);

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
		setDetectedAgents([]);
		setIsDetecting(true);
		setSelectedAgent(null);
		setIsConfigExpanded(false);
		setCustomPath('');
		setCustomArgs('');
		setCustomEnvVars({});
		setAgentConfig({});
		agentConfigRef.current = {};
		setAvailableModels([]);
		setLoadingModels(false);
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
			console.error('Failed to detect agents:', error);
		} finally {
			setIsDetecting(false);
		}
	}, [agentFilter, autoSelect]);

	// Load agent config
	const loadAgentConfig = useCallback(
		async (agentId: string) => {
			const requestId = ++latestLoadRequestRef.current;

			const config = await window.maestro.agents.getConfig(agentId);
			if (latestLoadRequestRef.current !== requestId) return; // stale
			setAgentConfig(config || {});
			agentConfigRef.current = config || {};

			// Load models if agent supports it
			const agent = detectedAgents.find((a) => a.id === agentId);
			if (agent?.capabilities?.supportsModelSelection) {
				setLoadingModels(true);
				try {
					const models = await window.maestro.agents.getModels(agentId);
					if (latestLoadRequestRef.current !== requestId) return; // stale
					setAvailableModels(models);
				} catch (err) {
					console.error('Failed to load models:', err);
				} finally {
					if (latestLoadRequestRef.current === requestId) {
						setLoadingModels(false);
					}
				}
			}
		},
		[detectedAgents]
	);

	// Save agent config via IPC
	const saveAgentConfig = useCallback(async (agentId: string): Promise<boolean> => {
		return await window.maestro.agents.setConfig(agentId, agentConfigRef.current);
	}, []);

	// Refresh models
	const refreshModels = useCallback(async () => {
		if (!selectedAgent) return;
		setLoadingModels(true);
		try {
			const models = await window.maestro.agents.getModels(selectedAgent, true);
			setAvailableModels(models);
		} catch (err) {
			console.error('Failed to refresh models:', err);
		} finally {
			setLoadingModels(false);
		}
	}, [selectedAgent]);

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
			console.error('Failed to refresh agents:', error);
		} finally {
			setRefreshingAgent(false);
		}
	}, [agentFilter]);

	// Handle agent selection change — resets customizations and agent-scoped state
	const handleAgentChange = useCallback(
		(agentId: string) => {
			// Invalidate any in-flight loadAgentConfig requests
			latestLoadRequestRef.current++;

			setSelectedAgent(agentId);
			setCustomPath('');
			setCustomArgs('');
			setCustomEnvVars({});
			setAgentConfig({});
			agentConfigRef.current = {};
			setAvailableModels([]);
			setLoadingModels(false);
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
					console.error('Failed to load SSH remotes:', error);
				}
			})();
		}
	}, [enabled, detectAgents, resetState, shouldLoadSshRemotes]);

	// Load config when expanding
	useEffect(() => {
		if (isConfigExpanded && selectedAgent) {
			loadAgentConfig(selectedAgent);
		}
	}, [isConfigExpanded, selectedAgent, loadAgentConfig]);

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

		// Agent config
		agentConfig,
		setAgentConfig,
		agentConfigRef,

		// Models
		availableModels,
		loadingModels,
		refreshModels,

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
