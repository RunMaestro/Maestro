/**
 * The shared settings a library client reads (ST-1), and the Encore gate (ST-2).
 *
 * The desktop holds these in four places: `maestro-settings.json` (a flat store
 * with hundreds of keys), `maestro-agent-configs.json` (one config per
 * provider), the SSH remotes (served through the host), and
 * `core-prompts-customizations.json` (the prompts the user edited). A client
 * wants one answer, so `buildSettingsSnapshot` folds the four into a display
 * shape and `loadSettingsSnapshot` fetches them: from the host when one is
 * attached, from the store files otherwise. Read-only. Nothing here writes.
 *
 * Encore flags are resolved through `resolveEncoreFeatures` and nothing else,
 * so a flag the user never touched reads as its default, exactly as the desktop
 * reads it. A surface behind a flag asks `isEncoreEnabled`.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
	ENCORE_FEATURE_DEFAULTS,
	resolveEncoreFeatures,
	type EncoreFeatureDefaults,
} from '../../encoreFeatureDefaults';
import { isSecretEnvKey, maskEnvValue } from '../../agentEnvironment';
import { asThinkingMode, type SshRemoteConfig, type ThinkingMode } from '../../types';
import type { MaestroClient } from '../client/types';
import type { MaestroPaths } from '../paths/resolve';
import { parseStoreJson } from '../store/corrupt-store';
import { readAgentConfigsStore, readSettingsStore } from '../store/read-stores';

export { ENCORE_FEATURE_DEFAULTS, resolveEncoreFeatures };
export type { EncoreFeatureDefaults };

/** The name of an Encore flag. A binding or a view names the flag it sits behind with this. */
export type EncoreFlag = keyof EncoreFeatureDefaults;

/** The keys of `maestro-settings.json` the snapshot reads. */
export const SETTINGS_SNAPSHOT_KEYS = [
	'defaultShell',
	'defaultSaveToHistory',
	'defaultShowThinking',
	'shellEnvVars',
	'conductorProfile',
	'encoreFeatures',
] as const;

/** Where the user's edited prompts live, beside the settings. */
export const PROMPT_CUSTOMIZATIONS_FILE = 'core-prompts-customizations.json';

/**
 * How each Encore flag reads on screen. A `Record` over the flag names, so a
 * newly graduated feature does not compile until it has a label.
 */
export const ENCORE_FEATURE_LABELS: Record<EncoreFlag, string> = {
	directorNotes: "Director's Notes",
	usageStats: 'Usage Dashboard',
	symphony: 'Symphony',
	maestroCue: 'Maestro Cue',
	pianola: 'Pianola',
	plugins: 'Plugins',
	coworking: 'Coworking',
	opencodeServer: 'OpenCode server',
	concerto: 'Concerto',
	groupsPlus: 'Groups+',
	webLogin: 'Web Login',
};

/** One `key: value` line of a provider's config, ready to print. A secret is already masked. */
export interface SettingsEntry {
	key: string;
	value: string;
}

export interface ProviderConfigSummary {
	/** Provider id. Kept a string: a provider this build does not know still has a config. */
	providerId: string;
	entries: SettingsEntry[];
}

export interface SshRemoteSummary {
	id: string;
	name: string;
	/** `user@host:port`, or the `~/.ssh/config` alias when the remote uses one. */
	target: string;
	enabled: boolean;
}

export interface PromptCustomization {
	id: string;
	/** Whether the stored prompt differs from the bundled one. */
	modified: boolean;
}

/** Where a snapshot's settings values came from. */
export type SettingsSource = 'host' | 'files';

export interface SettingsSnapshot {
	source: SettingsSource;
	/** Why the host was not used, when it was expected to be. */
	note?: string;
	defaults: {
		shell?: string;
		saveToHistory: boolean;
		thinkingMode: ThinkingMode;
		/** Names with secrets masked: the global environment every agent starts with. */
		envVars: SettingsEntry[];
	};
	providers: ProviderConfigSummary[];
	sshRemotes: SshRemoteSummary[];
	conductorProfile: string;
	prompts: PromptCustomization[];
	/** Every flag, resolved: one the user never touched carries its default. */
	encore: EncoreFeatureDefaults;
	/** Store files that could not be read, one line each. */
	problems: string[];
}

export interface SettingsInput {
	/** The values of `SETTINGS_SNAPSHOT_KEYS` as held; a key not held is absent. */
	settings: Record<string, unknown>;
	/** Provider id to that provider's stored config. */
	agentConfigs: Record<string, Record<string, unknown>>;
	sshRemotes: readonly SshRemoteConfig[];
	/** The `prompts` map of the customizations file. */
	promptStore: Record<string, unknown>;
	source: SettingsSource;
	note?: string;
	problems?: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `NAME=value` pairs, secrets masked. A blank-valued name is shown as unset. */
function envEntries(vars: Record<string, unknown>): SettingsEntry[] {
	return Object.entries(vars)
		.filter(([, value]) => typeof value === 'string')
		.map(([key, value]) => ({
			key,
			value: isSecretEnvKey(key) ? maskEnvValue(value as string) : (value as string),
		}))
		.sort((a, b) => a.key.localeCompare(b.key));
}

function describeConfigValue(key: string, value: unknown): string {
	if (typeof value === 'string') return isSecretEnvKey(key) ? maskEnvValue(value) : value;
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	if (Array.isArray(value)) return value.map((item) => String(item)).join(' ');
	if (isRecord(value)) {
		const pairs = envEntries(value).map((entry) => `${entry.key}=${entry.value}`);
		return pairs.length > 0 ? pairs.join(', ') : '(empty)';
	}
	return value === null ? '(unset)' : String(value);
}

function summarizeProviders(
	configs: Record<string, Record<string, unknown>>
): ProviderConfigSummary[] {
	return Object.entries(configs)
		.filter(([, config]) => isRecord(config))
		.map(([providerId, config]) => ({
			providerId,
			entries: Object.entries(config)
				.filter(([, value]) => value !== undefined && value !== '')
				.map(([key, value]) => ({ key, value: describeConfigValue(key, value) }))
				.sort((a, b) => a.key.localeCompare(b.key)),
		}))
		.sort((a, b) => a.providerId.localeCompare(b.providerId));
}

function summarizeRemote(remote: SshRemoteConfig): SshRemoteSummary {
	const user = remote.username ? `${remote.username}@` : '';
	const port = remote.port && remote.port !== 22 ? `:${remote.port}` : '';
	return {
		id: remote.id,
		name: remote.name,
		target: `${user}${remote.host}${port}`,
		enabled: remote.enabled !== false,
	};
}

function summarizePrompts(store: Record<string, unknown>): PromptCustomization[] {
	return Object.entries(store)
		.filter(([, prompt]) => isRecord(prompt))
		.map(([id, prompt]) => ({
			id,
			modified: (prompt as Record<string, unknown>).isModified === true,
		}))
		.sort((a, b) => a.id.localeCompare(b.id));
}

/** Folds what was read into the display shape. Pure. */
export function buildSettingsSnapshot(input: SettingsInput): SettingsSnapshot {
	const { settings } = input;
	return {
		source: input.source,
		...(input.note ? { note: input.note } : {}),
		defaults: {
			...(typeof settings.defaultShell === 'string' ? { shell: settings.defaultShell } : {}),
			// The desktop's own default is on.
			saveToHistory: settings.defaultSaveToHistory !== false,
			thinkingMode: asThinkingMode(settings.defaultShowThinking) ?? 'off',
			envVars: isRecord(settings.shellEnvVars) ? envEntries(settings.shellEnvVars) : [],
		},
		providers: summarizeProviders(input.agentConfigs),
		sshRemotes: input.sshRemotes.map(summarizeRemote),
		conductorProfile:
			typeof settings.conductorProfile === 'string' ? settings.conductorProfile : '',
		prompts: summarizePrompts(input.promptStore),
		encore: resolveEncoreFeatures(settings.encoreFeatures),
		problems: input.problems ?? [],
	};
}

/**
 * Whether a feature behind `flag` is on. A missing or unreadable settings
 * snapshot reads as the defaults, which is what the desktop does with a fresh
 * install, so a TUI that has not reached the host yet is not stricter than it.
 */
export function isEncoreEnabled(
	flags: Partial<EncoreFeatureDefaults> | undefined,
	flag: EncoreFlag
): boolean {
	const value = flags?.[flag];
	return typeof value === 'boolean' ? value : ENCORE_FEATURE_DEFAULTS[flag];
}

type SettingsPaths = Pick<MaestroPaths, 'userDataDir' | 'settingsFile' | 'agentConfigsFile'>;

function readPromptStore(paths: SettingsPaths, problems: string[]): Record<string, unknown> {
	const file = path.join(paths.userDataDir, PROMPT_CUSTOMIZATIONS_FILE);
	let content: string;
	try {
		content = fs.readFileSync(file, 'utf-8');
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		// No file is the normal case: nothing was ever customized.
		if (code !== 'ENOENT')
			problems.push(`Prompt customizations are unreadable: ${code ?? 'error'}`);
		return {};
	}
	const parsed = parseStoreJson<unknown>(content);
	if (!parsed.ok) {
		problems.push(`Prompt customizations are corrupt: ${parsed.error.message}`);
		return {};
	}
	return isRecord(parsed.value) && isRecord(parsed.value.prompts) ? parsed.value.prompts : {};
}

/** Everything but the settings values and SSH remotes, which come from the host when there is one. */
function readLocalParts(paths: SettingsPaths) {
	const problems: string[] = [];
	const agentConfigs = readAgentConfigsStore(paths.agentConfigsFile);
	if (agentConfigs.status === 'corrupt' || agentConfigs.status === 'unreadable') {
		problems.push(`Agent configs are ${agentConfigs.status}: ${agentConfigs.reason}`);
	}
	return {
		problems,
		agentConfigs: (agentConfigs.status === 'ok' ? (agentConfigs.data.configs ?? {}) : {}) as Record<
			string,
			Record<string, unknown>
		>,
		promptStore: readPromptStore(paths, problems),
	};
}

/** Reads the snapshot from the store files alone. */
export function readSettingsSnapshotFromFiles(
	paths: SettingsPaths,
	note?: string
): SettingsSnapshot {
	const local = readLocalParts(paths);
	const settings = readSettingsStore(paths.settingsFile);
	const problems = [...local.problems];
	if (settings.status === 'corrupt' || settings.status === 'unreadable') {
		problems.push(`Settings file is ${settings.status}: ${settings.reason}`);
	}
	const values = settings.status === 'ok' ? settings.data : {};
	const remotes = Array.isArray(values.sshRemotes) ? (values.sshRemotes as SshRemoteConfig[]) : [];
	return buildSettingsSnapshot({
		settings: values,
		agentConfigs: local.agentConfigs,
		sshRemotes: remotes,
		promptStore: local.promptStore,
		source: 'files',
		...(note ? { note } : {}),
		problems,
	});
}

/**
 * The snapshot, from the host when a client is attached (the values the
 * desktop holds right now, not what it last wrote), else from the files. A host
 * that answers with an error falls back to the files and says so in `note`.
 * Agent configs and prompt customizations are always read from disk: the bridge
 * has no read for either, and the desktop writes both through immediately.
 */
export async function loadSettingsSnapshot(
	paths: SettingsPaths,
	client?: MaestroClient
): Promise<SettingsSnapshot> {
	if (!client || client.connection.state() !== 'connected')
		return readSettingsSnapshotFromFiles(paths);
	const [settings, remotes] = await Promise.all([
		client.settings.get(SETTINGS_SNAPSHOT_KEYS),
		client.settings.sshRemotes(),
	]);
	if (!settings.ok) {
		return readSettingsSnapshotFromFiles(paths, `Host: ${settings.error.message}. Showing files.`);
	}
	const local = readLocalParts(paths);
	return buildSettingsSnapshot({
		settings: settings.value,
		agentConfigs: local.agentConfigs,
		sshRemotes: remotes.ok ? remotes.value : [],
		promptStore: local.promptStore,
		source: 'host',
		...(remotes.ok ? {} : { note: `SSH remotes: ${remotes.error.message}` }),
		problems: local.problems,
	});
}
