import type { UseSettingsReturn } from '../../../../hooks/settings/useSettings';
import type { UseAgentConfigurationReturn } from '../../../../hooks/agent/useAgentConfiguration';
import type { CueSettings } from '../../../../../shared/cue';
import type { AgentConfig, Theme, ToolType } from '../../../../types';

export interface EncoreTabProps {
	theme: Theme;
	isOpen: boolean;
}

export type EncoreTabSettings = UseSettingsReturn;

export type StatsTimeRange = 'day' | 'week' | 'month' | 'quarter' | 'year' | 'all';

export interface WakatimeCliStatus {
	available: boolean;
	version?: string;
}

export interface WakatimeSettingsState {
	wakatimeCliStatus: WakatimeCliStatus | null;
	wakatimeKeyValid: boolean | null;
	wakatimeKeyValidating: boolean;
	handleWakatimeApiKeyChange: (value: string) => void;
	validateWakatimeApiKey: () => void;
}

export interface SymphonyRegistryState {
	newRegistryUrl: string;
	registryUrlError: string | null;
	setNewRegistryUrl: (value: string) => void;
	addRegistryUrl: () => void;
	removeRegistryUrl: (url: string) => void;
}

export type CueSettingsSaveState = 'idle' | 'saving' | 'saved' | 'error' | 'no-targets';

export interface CueSettingsState {
	cueSettings: CueSettings;
	cueSettingsLoaded: boolean;
	cueSettingsSaveState: CueSettingsSaveState;
	cueQueueSizeStr: string;
	updateCueSettings: (patch: Partial<CueSettings>) => void;
	handleTimeoutMinutesChange: (value: string) => void;
	handleTimeoutOnFailChange: (value: CueSettings['timeout_on_fail']) => void;
	handleMaxConcurrentChange: (value: string) => void;
	handleQueueSizeChange: (value: string) => void;
	handleQueueSizeBlur: () => void;
}

export interface TtsrSettingsState {
	newDisabledRule: string;
	disabledRuleError: string | null;
	setNewDisabledRule: (value: string) => void;
	addDisabledRule: () => void;
	removeDisabledRule: (name: string) => void;
}

export interface DirectorNotesTile {
	id: ToolType;
	name: string;
	supported: boolean;
}

export interface DirectorNotesAgentState {
	agentConfiguration: UseAgentConfigurationReturn;
	availableTiles: DirectorNotesTile[];
	selectedAgentConfig: AgentConfig | undefined;
	selectedTile: DirectorNotesTile | undefined;
	handleAgentChange: (agentId: ToolType) => void;
	persistCustomConfig: () => void;
	handleEnvVarKeyChange: (oldKey: string, newKey: string, value: string) => void;
	handleEnvVarValueChange: (key: string, value: string) => void;
	handleEnvVarRemove: (key: string) => void;
	handleEnvVarAdd: () => void;
	handleConfigChange: (key: string, value: unknown) => void;
	handleConfigBlur: () => Promise<void>;
}
