import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentConfig } from '../../../../../types';
import type { AgentSshRemoteConfig } from '../../../../../../shared/types';
import { logger } from '../../../../../utils/logger';
import { captureException } from '../../../../../utils/sentry';
import type { AgentTile } from '../types';
import { AGENT_TILES } from '../utils/agentTiles';
import {
	addEnvVar,
	normalizeOptionalWizardString,
	normalizeWizardEnvVars,
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
	setWizardAgentConfigValues: (value: Record<string, unknown> | undefined) => void;
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
	setWizardAgentConfigValues,
	setWizardSessionSshRemoteConfig,
	customPath,
	customEnvVars,
	refreshAgentDetection,
	showConfigView,
	showGridView,
	announce,
}: UseAgentConfigurationPanelArgs) {
	const [agentConfig, setAgentConfig] = useState<Record<string, any>>({});
	const agentConfigRef = useRef<Record<string, any>>({});
	const configLoadRequestRef = useRef(0);
	const [availableModels, setAvailableModels] = useState<string[]>([]);
	const [loadingModels, setLoadingModels] = useState(false);
	const [refreshingAgent, setRefreshingAgent] = useState(false);
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
		(value: string) => setWizardCustomPath(normalizeOptionalWizardString(value)),
		[setWizardCustomPath]
	);

	const setCustomArgs = useCallback(
		(value: string) => setWizardCustomArgs(normalizeOptionalWizardString(value)),
		[setWizardCustomArgs]
	);

	const setCustomEnvVars = useCallback(
		(value: Record<string, string>) => setWizardCustomEnvVars(normalizeWizardEnvVars(value)),
		[setWizardCustomEnvVars]
	);

	const handleOpenConfig = useCallback(
		async (agentId: string) => {
			const requestId = ++configLoadRequestRef.current;
			setSelectedAgent(agentId);
			const config = await window.maestro.agents.getConfig(agentId);
			if (requestId !== configLoadRequestRef.current) return;
			agentConfigRef.current = config || {};
			setAgentConfig(config || {});
			setWizardAgentConfigValues(config || {});
			setConfiguringAgentId(agentId);

			const agent = detectedAgents.find((candidate) => candidate.id === agentId);
			if (agent?.capabilities?.supportsModelSelection) {
				setLoadingModels(true);
				const sshRemoteId = getSshRemoteIdForDetection(sshRemoteConfig);
				try {
					const models = await window.maestro.agents.getModels(agentId, false, sshRemoteId);
					if (requestId !== configLoadRequestRef.current) return;
					setAvailableModels(models);
				} catch (error) {
					if (requestId !== configLoadRequestRef.current) return;
					logger.error('Failed to load models:', undefined, error);
					captureException(error, {
						extra: {
							operation: 'agentSelection:loadModels',
							agentId,
							remoteMode: Boolean(sshRemoteId),
						},
					});
				} finally {
					if (requestId === configLoadRequestRef.current) {
						setLoadingModels(false);
					}
				}
			}

			showConfigView();

			const tile = AGENT_TILES.find((candidate) => candidate.id === agentId);
			announce(`Configuring ${tile?.name || agentId}`);
		},
		[
			announce,
			detectedAgents,
			setConfiguringAgentId,
			setSelectedAgent,
			showConfigView,
			sshRemoteConfig,
			setWizardAgentConfigValues,
		]
	);

	const handleCloseConfig = useCallback(() => {
		setWizardSessionSshRemoteConfig(toWizardSshRemoteConfig(sshRemoteConfig));
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
		if (!configuringAgentId) return;
		setRefreshingAgent(true);
		try {
			await refreshAgentDetection();
		} finally {
			setRefreshingAgent(false);
		}
	}, [configuringAgentId, refreshAgentDetection]);

	const handleRefreshModels = useCallback(async () => {
		if (!configuringAgentId) return;
		setLoadingModels(true);
		const sshRemoteId = getSshRemoteIdForDetection(sshRemoteConfig);
		try {
			const models = await window.maestro.agents.getModels(configuringAgentId, true, sshRemoteId);
			setAvailableModels(models);
		} catch (error) {
			logger.error('Failed to refresh models:', undefined, error);
			captureException(error, {
				extra: {
					operation: 'agentSelection:refreshModels',
					agentId: configuringAgentId,
					remoteMode: Boolean(sshRemoteId),
				},
			});
		} finally {
			setLoadingModels(false);
		}
	}, [configuringAgentId, sshRemoteConfig]);

	const handleCustomPathBlur = useCallback(async () => {
		if (configuringAgentId) {
			const pathToSet = customPath.trim() || null;
			await window.maestro.agents.setCustomPath(configuringAgentId, pathToSet);
		}
		await refreshAgentDetection();
	}, [configuringAgentId, customPath, refreshAgentDetection]);

	const handleConfigChange = useCallback(
		(key: string, value: unknown) => {
			const updatedConfig = { ...agentConfigRef.current, [key]: value };
			agentConfigRef.current = updatedConfig;
			setAgentConfig(updatedConfig);
			setWizardAgentConfigValues(updatedConfig);
		},
		[setWizardAgentConfigValues]
	);

	const handleConfigBlur = useCallback(
		async (key: string, value: any) => {
			if (!configuringAgentId) return;
			const updatedConfig = { ...agentConfigRef.current, [key]: value };
			agentConfigRef.current = updatedConfig;
			setAgentConfig(updatedConfig);
			setWizardAgentConfigValues(updatedConfig);
			await window.maestro.agents.setConfig(configuringAgentId, updatedConfig);
		},
		[configuringAgentId, setWizardAgentConfigValues]
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
	const detectedConfigAgent = detectedAgents.find((agent) => agent.id === configuringAgentId);

	return {
		agentConfig,
		availableModels,
		loadingModels,
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
	};
}
