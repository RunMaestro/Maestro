import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { AgentConfig } from '../../../../../types';
import type { AgentDiscoveryRequest, AgentSshRemoteConfig } from '../../../../../../shared/types';
import { useAgentModelEffortOptions } from '../../../../../hooks/agent/useAgentModelEffortOptions';
import { readEffortFromConfig } from '../../../../../utils/agentEffort';
import { logger } from '../../../../../utils/logger';
import { captureException } from '../../../../../utils/sentry';
import { useWizard } from '../../../WizardContext';
import type { AgentTile } from '../types';
import { AGENT_TILES } from '../utils/agentTiles';
import {
	addEnvVar,
	normalizeOptionalWizardString,
	removeEnvVar,
	renameEnvVarKey,
	updateEnvVarValue,
} from '../utils/agentConfigForms';
import {
	getSshRemoteIdForDetection,
	toWizardSshRemoteConfig,
	type WizardSessionSshRemoteConfig,
} from '../utils/sshConfig';

interface UseAgentConfigurationPanelArgs {
	detectedAgents: AgentConfig[];
	sshRemoteConfig: AgentSshRemoteConfig | undefined;
	configuringAgentId: string | null;
	setConfiguringAgentId: (agentId: string | null) => void;
	setSelectedAgent: (agentId: string) => void;
	setWizardCustomPath: (value: string | undefined) => void;
	setWizardCustomArgs: (value: string | undefined) => void;
	setWizardCustomEnvVars: (value: Record<string, string> | undefined) => void;
	setWizardSessionSshRemoteConfig: (config: WizardSessionSshRemoteConfig) => void;
	customPath: string;
	customEnvVars: Record<string, string>;
	refreshAgentDetection: () => Promise<void>;
	showConfigView: () => void;
	showGridView: (agentId: string | null) => void;
	announce: (message: string) => void;
}

export function useAgentConfigurationPanel({
	detectedAgents,
	sshRemoteConfig,
	configuringAgentId,
	setConfiguringAgentId,
	setSelectedAgent,
	setWizardCustomPath,
	setWizardCustomArgs,
	setWizardCustomEnvVars,
	setWizardSessionSshRemoteConfig,
	customPath,
	customEnvVars,
	refreshAgentDetection,
	showConfigView,
	showGridView,
	announce,
}: UseAgentConfigurationPanelArgs) {
	const { state: wizardState } = useWizard();
	const [agentConfig, setAgentConfig] = useState<Record<string, any>>({});
	const agentConfigRef = useRef<Record<string, any>>({});
	const [loadedConfigFor, setLoadedConfigFor] = useState<string>();
	const configRequestRef = useRef(0);
	const agentRefreshRequestRef = useRef(0);
	const currentConfiguringAgent = useRef(configuringAgentId);
	currentConfiguringAgent.current = configuringAgentId;
	const [availableModels, setAvailableModels] = useState<string[]>([]);
	const [loadingModels, setLoadingModels] = useState(false);
	const [refreshingAgent, setRefreshingAgent] = useState(false);
	const [grokRefresh, setGrokRefresh] = useState(0);
	const [customPathEditedFor, setCustomPathEditedFor] = useState<string | null>(null);
	// Read the actual wizard environment, not the caller's display-only `{}`
	// placeholder: absent inherits provider settings; explicit empty replaces them.
	const draft = useMemo(
		() => ({
			cwd: wizardState.directoryPath,
			customPath:
				customPathEditedFor === 'grok' ? customPath : normalizeOptionalWizardString(customPath),
			customEnvVars: wizardState.customEnvVars,
			sessionSshRemoteConfig: sshRemoteConfig,
			isOpen: wizardState.isOpen,
			step: wizardState.currentStep,
			selectedAgent: wizardState.selectedAgent,
		}),
		[
			wizardState.directoryPath,
			customPath,
			customPathEditedFor,
			wizardState.customEnvVars,
			sshRemoteConfig,
			wizardState.isOpen,
			wizardState.currentStep,
			wizardState.selectedAgent,
		]
	);
	const currentDraft = useRef<typeof draft | undefined>(draft);
	currentDraft.current = draft;
	useLayoutEffect(() => {
		currentDraft.current = draft;
		setLoadingModels(false);
		setRefreshingAgent(false);
		return () => {
			currentDraft.current = undefined;
			configRequestRef.current++;
			agentRefreshRequestRef.current++;
		};
	}, [draft, configuringAgentId]);
	useLayoutEffect(() => {
		setAvailableModels([]);
	}, [sshRemoteConfig?.enabled, sshRemoteConfig?.remoteId]);

	const grokContext = useMemo<AgentDiscoveryRequest['context'] | undefined>(() => {
		void grokRefresh;
		return draft.isOpen &&
			draft.step === 'agent-selection' &&
			configuringAgentId === 'grok' &&
			loadedConfigFor === 'grok'
			? {
					// These controls write provider model/effort settings on blur.
					// Empty drafts must not inherit the old, not-yet-saved value.
					kind: 'provider-settings',
					cwd: draft.cwd,
					customPath: draft.customPath,
					customEnvVars: draft.customEnvVars,
					model: agentConfig.model,
					effort: readEffortFromConfig(agentConfig) ?? '',
					// Preserve enabled SSH with no remote ID as unresolved.
					sessionSshRemoteConfig: draft.sessionSshRemoteConfig,
				}
			: undefined;
	}, [draft, configuringAgentId, loadedConfigFor, agentConfig, grokRefresh]);
	const grokOptions = useAgentModelEffortOptions(grokContext ? 'grok' : undefined, grokContext);
	const currentGrokContext = useRef(grokContext);
	currentGrokContext.current = grokContext;
	useEffect(() => {
		currentGrokContext.current = grokContext;
		return () => {
			currentGrokContext.current = undefined;
		};
	}, [grokContext]);
	// Auto-detected maestro-p path, shown as helper text under the Claude Token
	// Source path override (mirrors EditAgentModal). Local-only; the override is
	// hidden over SSH where maestro-p is resolved on the remote PATH.
	const [detectedMaestroPPath, setDetectedMaestroPPath] = useState<string | undefined>(undefined);

	useEffect(() => {
		void window.maestro.agents
			.getMaestroPDetectedPath()
			.then((p) => setDetectedMaestroPPath(p ?? undefined))
			.catch(() => setDetectedMaestroPPath(undefined));
	}, []);

	const setCustomPath = useCallback(
		(value: string) => {
			setCustomPathEditedFor(configuringAgentId);
			setWizardCustomPath(normalizeOptionalWizardString(value));
		},
		[configuringAgentId, setWizardCustomPath]
	);

	const setCustomArgs = useCallback(
		(value: string) => setWizardCustomArgs(normalizeOptionalWizardString(value)),
		[setWizardCustomArgs]
	);

	const setCustomEnvVars = useCallback(
		// Called only for an explicit edit. An empty map replaces inherited account
		// settings; opening or closing the panel leaves undefined inheritance intact.
		(value: Record<string, string>) => setWizardCustomEnvVars(value),
		[setWizardCustomEnvVars]
	);

	const handleOpenConfig = useCallback(
		async (agentId: string) => {
			if (currentDraft.current !== draft || currentConfiguringAgent.current !== configuringAgentId)
				return;
			const requestId = ++configRequestRef.current;
			const isCurrentRequest = () =>
				configRequestRef.current === requestId &&
				currentDraft.current === draft &&
				currentConfiguringAgent.current === configuringAgentId;
			setLoadedConfigFor(undefined);
			setAvailableModels([]);
			setLoadingModels(false);
			try {
				const config = await window.maestro.agents.getConfig(agentId);
				if (!isCurrentRequest()) return;
				let models: string[] = [];
				const agent = detectedAgents.find((candidate) => candidate.id === agentId);
				const sshRemoteId = getSshRemoteIdForDetection(sshRemoteConfig);
				if (
					agentId !== 'grok' &&
					agent?.capabilities?.supportsModelSelection &&
					(!sshRemoteConfig?.enabled || sshRemoteId)
				) {
					setLoadingModels(true);
					try {
						models = await window.maestro.agents.getModels(agentId, false, sshRemoteId);
					} catch (error) {
						if (!isCurrentRequest()) return;
						logger.error('Failed to load models:', undefined, error);
						captureException(error, {
							extra: {
								operation: 'agentSelection:loadModels',
								agentId,
								remoteMode: Boolean(sshRemoteId),
							},
						});
					}
				}

				if (!isCurrentRequest()) return;
				// Publish together after every read. Changing the panel's provider here
				// must not invalidate its own pending model lookup.
				agentConfigRef.current = config || {};
				setAgentConfig(config || {});
				setLoadedConfigFor(agentId);
				setAvailableModels(models);
				setConfiguringAgentId(agentId);
				setSelectedAgent(agentId);
				showConfigView();

				const tile = AGENT_TILES.find((candidate) => candidate.id === agentId);
				announce(`Configuring ${tile?.name || agentId}`);
			} catch (error) {
				if (!isCurrentRequest()) return;
				logger.error('Failed to load agent configuration:', undefined, error);
				captureException(error, {
					extra: { operation: 'agentSelection:loadConfig', agentId },
				});
				announce('Failed to load agent configuration. Please try again.');
			} finally {
				if (isCurrentRequest()) setLoadingModels(false);
			}
		},
		[
			announce,
			configuringAgentId,
			detectedAgents,
			draft,
			setConfiguringAgentId,
			setSelectedAgent,
			showConfigView,
			sshRemoteConfig,
		]
	);

	const handleCloseConfig = useCallback(() => {
		configRequestRef.current++;
		agentRefreshRequestRef.current++;
		currentGrokContext.current = undefined;
		setLoadedConfigFor(undefined);
		setAvailableModels([]);
		setLoadingModels(false);
		setRefreshingAgent(false);
		setWizardSessionSshRemoteConfig(
			sshRemoteConfig?.enabled && !sshRemoteConfig.remoteId
				? { ...sshRemoteConfig, remoteId: null }
				: toWizardSshRemoteConfig(sshRemoteConfig)
		);
		showGridView(configuringAgentId);
		announce('Returned to agent selection');
	}, [
		announce,
		configuringAgentId,
		setWizardSessionSshRemoteConfig,
		showGridView,
		sshRemoteConfig,
	]);

	const handleRefreshAgent = useCallback(async () => {
		if (
			!configuringAgentId ||
			currentDraft.current !== draft ||
			currentConfiguringAgent.current !== configuringAgentId
		)
			return;
		const requestId = ++agentRefreshRequestRef.current;
		setRefreshingAgent(true);
		try {
			await refreshAgentDetection();
		} finally {
			if (agentRefreshRequestRef.current === requestId && currentDraft.current === draft) {
				setRefreshingAgent(false);
			}
		}
	}, [configuringAgentId, draft, refreshAgentDetection]);

	const handleRefreshModels = useCallback(async () => {
		if (
			!configuringAgentId ||
			currentConfiguringAgent.current !== configuringAgentId ||
			currentDraft.current !== draft
		)
			return;
		if (configuringAgentId === 'grok') {
			if (!grokContext) return;
			// The forced request refreshes the host cache. Only the shared hook
			// publishes options, and only if this draft is still current.
			try {
				await window.maestro.agents.getModels({
					providerId: 'grok',
					context: grokContext,
					forceRefresh: true,
				});
			} catch (error) {
				logger.error('Failed to refresh models:', undefined, error);
				captureException(error, {
					extra: {
						operation: 'agentSelection:refreshModels',
						agentId: configuringAgentId,
						remoteMode: Boolean(sshRemoteConfig?.enabled),
					},
				});
			} finally {
				if (currentGrokContext.current === grokContext) setGrokRefresh((value) => value + 1);
			}
			return;
		}
		const requestId = ++configRequestRef.current;
		const sshRemoteId = getSshRemoteIdForDetection(sshRemoteConfig);
		if (sshRemoteConfig?.enabled && !sshRemoteId) return;
		const isCurrentRequest = () =>
			configRequestRef.current === requestId &&
			currentDraft.current === draft &&
			currentConfiguringAgent.current === configuringAgentId;
		setLoadingModels(true);
		try {
			const models = await window.maestro.agents.getModels(configuringAgentId, true, sshRemoteId);
			if (!isCurrentRequest()) return;
			setAvailableModels(models);
		} catch (error) {
			if (!isCurrentRequest()) return;
			logger.error('Failed to refresh models:', undefined, error);
			captureException(error, {
				extra: {
					operation: 'agentSelection:refreshModels',
					agentId: configuringAgentId,
					remoteMode: Boolean(sshRemoteId),
				},
			});
		} finally {
			if (isCurrentRequest()) {
				setLoadingModels(false);
			}
		}
	}, [configuringAgentId, draft, grokContext, sshRemoteConfig]);

	// Optional `value` covers the chooser: it calls this in the same handler as
	// the state update that sets customPath, so reading customPath back out of
	// this closure would still see the path from before that update landed.
	const handleCustomPathBlur = useCallback(
		async (value?: string) => {
			if (configuringAgentId) {
				const requestId = configRequestRef.current;
				setCustomPathEditedFor(configuringAgentId);
				const pathToSet = (value ?? customPath).trim() || null;
				await window.maestro.agents.setCustomPath(configuringAgentId, pathToSet);
				if (
					configuringAgentId === 'grok' &&
					configRequestRef.current === requestId &&
					currentDraft.current?.isOpen
				) {
					// Saving a clear changes the inherited executable without changing
					// the empty text field. Recheck the host-owned selection afterward.
					setGrokRefresh((value) => value + 1);
				}
			}
			await refreshAgentDetection();
		},
		[configuringAgentId, customPath, refreshAgentDetection]
	);

	const handleConfigChange = useCallback((key: string, value: any) => {
		const updatedConfig = { ...agentConfigRef.current, [key]: value };
		agentConfigRef.current = updatedConfig;
		setAgentConfig(updatedConfig);
	}, []);

	const handleConfigBlur = useCallback(
		async (key: string, value: any) => {
			if (!configuringAgentId) return;
			const updatedConfig = { ...agentConfigRef.current, [key]: value };
			agentConfigRef.current = updatedConfig;
			setAgentConfig(updatedConfig);
			await window.maestro.agents.setConfig(configuringAgentId, updatedConfig);
		},
		[configuringAgentId]
	);

	const handleEnvVarKeyChange = useCallback(
		(oldKey: string, newKey: string, value: string) => {
			setCustomEnvVars(renameEnvVarKey(customEnvVars, oldKey, newKey, value));
		},
		[customEnvVars, setCustomEnvVars]
	);

	const handleEnvVarValueChange = useCallback(
		(key: string, value: string) => {
			setCustomEnvVars(updateEnvVarValue(customEnvVars, key, value));
		},
		[customEnvVars, setCustomEnvVars]
	);

	const handleEnvVarRemove = useCallback(
		(key: string) => {
			setCustomEnvVars(removeEnvVar(customEnvVars, key));
		},
		[customEnvVars, setCustomEnvVars]
	);

	const handleEnvVarAdd = useCallback(() => {
		setCustomEnvVars(addEnvVar(customEnvVars));
	}, [customEnvVars, setCustomEnvVars]);

	const configuringTile: AgentTile | undefined = AGENT_TILES.find(
		(tile) => tile.id === configuringAgentId
	);
	const detectedAgent = detectedAgents.find((agent) => agent.id === configuringAgentId);
	// The existing panel renders option descriptions alongside its text controls.
	// Keep manual values intact and distinguish unavailable metadata from invalidity.
	const detectedConfigAgent =
		detectedAgent?.id === 'grok'
			? {
					...detectedAgent,
					configOptions: detectedAgent.configOptions?.map((option) => {
						if (!['model', 'effort', 'reasoningEffort'].includes(option.key)) return option;
						const status =
							option.key === 'model' ? grokOptions.modelStatus : grokOptions.effortStatus;
						return status === 'discovered'
							? option
							: {
									...option,
									description: `${option.description} ${
										!draft.cwd
											? 'Discovery is unavailable until a project directory is selected. Manual values are preserved.'
											: status === 'configured-fallback'
												? 'Discovery is unavailable for this selection. The configured value is preserved; manual entry remains available.'
												: 'Discovery is unavailable for this selection. Manual values are preserved.'
									}`,
								};
					}),
				}
			: detectedAgent;

	return {
		agentConfig,
		availableModels:
			configuringAgentId === 'grok'
				? grokOptions.modelStatus === 'discovered'
					? grokOptions.models
					: []
				: availableModels,
		loadingModels:
			configuringAgentId === 'grok' ? Boolean(grokContext) && !grokOptions.loaded : loadingModels,
		modelDiscoveryStatus: grokOptions.modelStatus,
		effortDiscoveryStatus: grokOptions.effortStatus,
		refreshingAgent,
		detectedMaestroPPath,
		configuringTile,
		detectedConfigAgent,
		setCustomPath,
		setCustomArgs,
		handleOpenConfig,
		handleCloseConfig,
		handleRefreshAgent,
		handleRefreshModels,
		handleCustomPathBlur,
		handleConfigChange,
		handleConfigBlur,
		handleEnvVarKeyChange,
		handleEnvVarValueChange,
		handleEnvVarRemove,
		handleEnvVarAdd,
		handleEnvVarsReplace: setCustomEnvVars,
	};
}
