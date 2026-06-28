import { useAgentConfiguration } from '../../../../../hooks/agent/useAgentConfiguration';
import { AGENT_TILES } from '../../../../Wizard/screens/AgentSelectionScreen';
import type { AgentConfig, DirectorNotesSettings, ToolType } from '../../../../../types';
import type { DirectorNotesAgentState, DirectorNotesTile } from '../types';

interface UseDirectorNotesAgentStateOptions {
	isOpen: boolean;
	directorNotesEnabled: boolean;
	directorNotesSettings: DirectorNotesSettings;
	setDirectorNotesSettings: (settings: DirectorNotesSettings) => void;
}

export function useDirectorNotesAgentState({
	isOpen,
	directorNotesEnabled,
	directorNotesSettings,
	setDirectorNotesSettings,
}: UseDirectorNotesAgentStateOptions): DirectorNotesAgentState {
	const agentConfiguration = useAgentConfiguration({
		enabled: isOpen && directorNotesEnabled,
		autoSelect: false,
		initialValues: {
			selectedAgent: directorNotesSettings.provider,
			customPath: directorNotesSettings.customPath || '',
			customArgs: directorNotesSettings.customArgs || '',
			customEnvVars: directorNotesSettings.customEnvVars || {},
		},
	});

	const availableTiles = AGENT_TILES.filter((tile) => {
		if (!tile.supported) return false;
		return agentConfiguration.detectedAgents.some((agent: AgentConfig) => agent.id === tile.id);
	}) as DirectorNotesTile[];
	const selectedAgentConfig = agentConfiguration.detectedAgents.find(
		(agent) => agent.id === directorNotesSettings.provider
	);
	const selectedTile = AGENT_TILES.find((tile) => tile.id === directorNotesSettings.provider) as
		| DirectorNotesTile
		| undefined;

	const handleAgentChange = (agentId: ToolType) => {
		setDirectorNotesSettings({
			...directorNotesSettings,
			provider: agentId,
			customPath: undefined,
			customArgs: undefined,
			customEnvVars: undefined,
		});
		agentConfiguration.handleAgentChange(agentId);
	};

	const persistCustomConfig = () => {
		setDirectorNotesSettings({
			...directorNotesSettings,
			customPath: agentConfiguration.customPath || undefined,
			customArgs: agentConfiguration.customArgs || undefined,
			customEnvVars:
				Object.keys(agentConfiguration.customEnvVars).length > 0
					? agentConfiguration.customEnvVars
					: undefined,
		});
	};

	const handleEnvVarKeyChange = (oldKey: string, newKey: string, value: string) => {
		const newVars = { ...agentConfiguration.customEnvVars };
		delete newVars[oldKey];
		newVars[newKey] = value;
		agentConfiguration.setCustomEnvVars(newVars);
	};

	const handleEnvVarValueChange = (key: string, value: string) => {
		agentConfiguration.setCustomEnvVars({ ...agentConfiguration.customEnvVars, [key]: value });
	};

	const handleEnvVarRemove = (key: string) => {
		const newVars = { ...agentConfiguration.customEnvVars };
		delete newVars[key];
		agentConfiguration.setCustomEnvVars(newVars);
	};

	const handleEnvVarAdd = () => {
		let newKey = 'NEW_VAR';
		let counter = 1;
		while (Object.prototype.hasOwnProperty.call(agentConfiguration.customEnvVars, newKey)) {
			newKey = `NEW_VAR_${counter}`;
			counter++;
		}
		agentConfiguration.setCustomEnvVars({ ...agentConfiguration.customEnvVars, [newKey]: '' });
	};

	const handleConfigChange = (key: string, value: unknown) => {
		const newConfig = { ...agentConfiguration.agentConfig, [key]: value };
		agentConfiguration.setAgentConfig(newConfig);
		agentConfiguration.agentConfigRef.current = newConfig;
	};

	const handleConfigBlur = async () => {
		if (directorNotesSettings.provider) {
			await agentConfiguration.saveAgentConfig(directorNotesSettings.provider);
		}
	};

	return {
		agentConfiguration,
		availableTiles,
		selectedAgentConfig,
		selectedTile,
		handleAgentChange,
		persistCustomConfig,
		handleEnvVarKeyChange,
		handleEnvVarValueChange,
		handleEnvVarRemove,
		handleEnvVarAdd,
		handleConfigChange,
		handleConfigBlur,
	};
}
