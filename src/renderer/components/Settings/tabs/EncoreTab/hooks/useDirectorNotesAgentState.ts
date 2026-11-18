import { useEffect, useRef } from 'react';
import { useAgentConfiguration } from '../../../../../hooks/agent/useAgentConfiguration';
import { withBlankEnvVarRow } from '../../../../../../shared/envVarCatalog';
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
	const enabled = isOpen && directorNotesEnabled;
	const initializedProvider = useRef<string>();
	const customEnvVarsRef = useRef(directorNotesSettings.customEnvVars);
	const grokConfigEdits = useRef<Record<string, unknown>>({});
	// The synopsis workspace is chosen by the host at generation time. Settings
	// has no cwd to qualify discovery with, so never substitute the user's home.
	const agentConfiguration = useAgentConfiguration({
		enabled,
		autoSelect: false,
		initialValues: {
			selectedAgent: directorNotesSettings.provider,
			customPath: directorNotesSettings.customPath,
			customArgs: directorNotesSettings.customArgs || '',
			customEnvVars: directorNotesSettings.customEnvVars,
		},
	});

	// The shared hook resets when disabled. Restore the saved selection on reopen
	// without resetting in-progress edits when an unrelated setting changes.
	useEffect(() => {
		if (!enabled) {
			initializedProvider.current = undefined;
			grokConfigEdits.current = {};
			return;
		}
		if (initializedProvider.current === directorNotesSettings.provider) return;
		initializedProvider.current = directorNotesSettings.provider;
		grokConfigEdits.current = {};
		customEnvVarsRef.current = directorNotesSettings.customEnvVars;
		agentConfiguration.handleAgentChange(directorNotesSettings.provider);
		if (directorNotesSettings.customPath !== undefined) {
			agentConfiguration.setCustomPath(directorNotesSettings.customPath);
		}
		agentConfiguration.setCustomArgs(directorNotesSettings.customArgs ?? '');
		if (directorNotesSettings.customEnvVars !== undefined) {
			agentConfiguration.setCustomEnvVars(directorNotesSettings.customEnvVars);
		}
	}, [
		enabled,
		directorNotesSettings.provider,
		directorNotesSettings.customPath,
		directorNotesSettings.customArgs,
		directorNotesSettings.customEnvVars,
		agentConfiguration.handleAgentChange,
		agentConfiguration.setCustomPath,
		agentConfiguration.setCustomArgs,
		agentConfiguration.setCustomEnvVars,
	]);
	// A delayed settings load or redetection must not replace manually entered
	// Grok model/effort values. These remain provider settings, saved on blur.
	const visibleConfig =
		enabled && directorNotesSettings.provider === 'grok' && initializedProvider.current === 'grok'
			? { ...agentConfiguration.agentConfig, ...grokConfigEdits.current }
			: agentConfiguration.agentConfig;

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
		initializedProvider.current = agentId;
		customEnvVarsRef.current = undefined;
		grokConfigEdits.current = {};
		setDirectorNotesSettings({
			...directorNotesSettings,
			provider: agentId,
			customPath: undefined,
			customArgs: undefined,
			customEnvVars: undefined,
		});
		agentConfiguration.handleAgentChange(agentId);
	};

	// Shared by onCustomPathBlur/onCustomArgsBlur/onEnvVarsBlur. Optional
	// `pathValue` is for the path chooser specifically: it calls this in the
	// same handler as the change that sets customPath, so reading
	// agentConfiguration.customPath back out of this closure would still see
	// the path from before that update landed. Env-key blur callbacks likewise
	// persist before their state update renders, so the latest env draft is
	// used, including an explicit {}.
	//
	// Only a string counts as a path. This is handed straight to blur props, and
	// an input that forwards its own onBlur passes the FocusEvent here: stored as
	// customPath it poisoned the setting, and the IPC write (then every Director's
	// Notes run) threw "An object could not be cloned" (MAESTRO-11C).
	const persistCustomConfig = (pathValue?: string) => {
		setDirectorNotesSettings({
			...directorNotesSettings,
			customPath:
				(typeof pathValue === 'string' ? pathValue : agentConfiguration.customPath) || undefined,
			customArgs: agentConfiguration.customArgs || undefined,
			// An untouched empty editor inherits. An explicitly emptied record
			// replaces provider env, and blank values continue to unset keys.
			customEnvVars: customEnvVarsRef.current,
		});
	};

	const handleEnvVarKeyChange = (oldKey: string, newKey: string, value: string) => {
		const newVars = { ...customEnvVarsRef.current };
		delete newVars[oldKey];
		newVars[newKey] = value;
		customEnvVarsRef.current = newVars;
		agentConfiguration.setCustomEnvVars(newVars);
	};

	const handleEnvVarValueChange = (key: string, value: string) => {
		customEnvVarsRef.current = { ...customEnvVarsRef.current, [key]: value };
		agentConfiguration.setCustomEnvVars(customEnvVarsRef.current);
	};

	const handleEnvVarRemove = (key: string) => {
		const newVars = { ...customEnvVarsRef.current };
		delete newVars[key];
		customEnvVarsRef.current = newVars;
		agentConfiguration.setCustomEnvVars(newVars);
		persistCustomConfig();
	};

	const handleEnvVarAdd = () => {
		customEnvVarsRef.current = withBlankEnvVarRow(customEnvVarsRef.current ?? {});
		agentConfiguration.setCustomEnvVars(customEnvVarsRef.current);
	};

	const handleConfigChange = (key: string, value: unknown) => {
		if (directorNotesSettings.provider === 'grok') {
			grokConfigEdits.current = { ...grokConfigEdits.current, [key]: value };
		}
		const newConfig = { ...visibleConfig, [key]: value };
		agentConfiguration.setAgentConfig(newConfig);
		agentConfiguration.agentConfigRef.current = newConfig;
	};

	const handleConfigBlur = async () => {
		if (directorNotesSettings.provider) {
			if (directorNotesSettings.provider === 'grok') {
				agentConfiguration.agentConfigRef.current = {
					...agentConfiguration.agentConfigRef.current,
					...grokConfigEdits.current,
				};
			}
			await agentConfiguration.saveAgentConfig(directorNotesSettings.provider);
		}
	};

	return {
		agentConfiguration: { ...agentConfiguration, agentConfig: visibleConfig },
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
