import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Folder, AlertTriangle } from 'lucide-react';
import type {
	AdditionalDirectory,
	AgentConfig,
	Group,
	GroupAgentDefaults,
	PeerAccess,
	PeerAgent,
	ToolType,
} from '../../types';
import type { SshRemoteConfig, AgentSshRemoteConfig } from '../../../shared/types';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';
import { validateNewSession } from '../../utils/sessionValidation';
import { isAdaptiveModeDefaultOn, resilienceEnabled } from '../../../shared/agentConstants';
import { normalizeAdditionalDirectories } from '../../../shared/additionalDirectories';
import { normalizePeerAgents } from '../../../shared/peerAgents';
import {
	groupDefaultLabel,
	groupDefaultsCreateExtras,
	resolveGroupDefaultsSeed,
	type GroupDefaultKey,
	type GroupDefaultsSeed,
} from '../../../shared/groupAgentDefaults';
import { getBasename } from '../../../shared/formatters';
import { FormInput } from '../ui/FormInput';
import { Modal, ModalFooter } from '../ui/Modal';
import { ModalTabStrip, useModalTabs } from '../ui/ModalTabStrip';
import { ThemedSelect } from '../shared/ThemedSelect';
import { GatewayUrlField } from '../shared/GatewayUrlField';
import {
	AGENT_FORM_TAB_IDS,
	buildAgentSettingsTabs,
	ProviderEnvironmentSection,
	firstTabWithError,
	GeneralTab,
	ModelsTab,
	PeersTab,
	ProviderTab,
	SshTab,
} from '../AgentSettings';
import { parseGatewayUrlEdit } from '../../../shared/local-models/gateway';
import {
	agentRunOnSupport,
	isRunOnSourceTarget,
	parseRunOnTarget,
	RUN_ON_GATEWAY_SKIPPED_REASON,
	type RunOnSourceTarget,
	type RunOnTarget,
} from '../../../shared/local-models/run-on';
import { RunOnField } from '../shared/RunOnField';
import { TOKEN_PROXY_NAME } from '../../../shared/local-models/token-proxy';
import { getAgentDisplayName } from '../../../shared/agentMetadata';
import { useSessionStore } from '../../stores/sessionStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { getModalActions } from '../../stores/modalStore';
import { formatShortcutKeys } from '../../utils/shortcutFormatter';
import type { AgentDebugInfo, AgentSeed, NewInstanceModalProps } from './types';
import { SUPPORTED_AGENTS } from './types';
import { useRemotePathValidation } from '../../hooks/agent/useRemotePathValidation';
import { usePeerFleet } from '../../hooks/agent/usePeerFleet';
import { RemotePathStatus } from './RemotePathStatus';
import { AgentPickerGrid } from './AgentPickerGrid';
import { GroupSeedBanner } from './GroupSeedBanner';
import { sshRemoteConfigToForm } from '../GroupSettingsModal/groupDefaultsForm';
import {
	filterToAvailableProviders,
	providerLocationLabel,
} from '../../utils/providerAvailability';
import { logger } from '../../utils/logger';
import type { CodexTransport } from '../../../shared/codexTransport';
import { getEffortConfigKey, readEffortFromConfig } from '../../utils/agentEffort';
import { gitService } from '../../services/git';
import { withBlankEnvVarRow } from '../../../shared/envVarCatalog';

/**
 * NewInstanceModal - the New Agent form.
 *
 * The form is tabbed (General, Provider, Models, Peers, SSH; see
 * `AgentSettings/`). Every piece of state stays here: the panels only draw it.
 * Only the active panel is rendered, so Tab never walks into a hidden one. It
 * always opens on General, where the name is the first thing to type.
 *
 * The form can open pre-filled from one of two seeds: an agent being duplicated
 * (`sourceSession`), or the defaults of the group the agent is created in
 * (`presetGroupId`). A group's defaults are copy-at-create: they are read once,
 * as the modal opens, and the banner above the tabs says where the values came
 * from.
 */
export function NewInstanceModal({
	isOpen,
	onClose,
	onCreate,
	theme,
	existingSessions,
	sourceSession,
	presetGroupId,
	presetWorkingDir,
}: NewInstanceModalProps) {
	const [agents, setAgents] = useState<AgentConfig[]>([]);
	const [selectedAgent, setSelectedAgent] = useState('');
	const [expandedAgent, setExpandedAgent] = useState<string | null>(null);
	const [showAllProviders, setShowAllProviders] = useState(false);
	const [workingDir, setWorkingDir] = useState('');
	const [additionalDirectories, setAdditionalDirectories] = useState<AdditionalDirectory[]>([]);
	// Peer Agents: the explicit rows and the two grants. An absent grant is off.
	const [peerAgents, setPeerAgents] = useState<PeerAgent[]>([]);
	const [groupPeerAccess, setGroupPeerAccess] = useState<PeerAccess | undefined>(undefined);
	const [worktreePeerAccess, setWorktreePeerAccess] = useState<PeerAccess | undefined>(undefined);
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
	const [enableMaestroPByAgent, setEnableMaestroPByAgent] = useState<Record<string, boolean>>({});
	const [maestroPModeByAgent, setMaestroPModeByAgent] = useState<
		Record<string, 'interactive' | 'dynamic'>
	>({});
	const [maestroPPathByAgent, setMaestroPPathByAgent] = useState<Record<string, string>>({});
	const [detectedMaestroPPath, setDetectedMaestroPPath] = useState<string | undefined>(undefined);
	// Agent Resilience (auto-retry) per-agent toggles. Both default ON; a map
	// only holds a value once the user flips a switch, so we read with `?? true`.
	const [retryAvailabilityByAgent, setRetryAvailabilityByAgent] = useState<Record<string, boolean>>(
		{}
	);
	const [retryTokenByAgent, setRetryTokenByAgent] = useState<Record<string, boolean>>({});
	// Codex automatic usage resets, per provider. Defaults OFF - unlike the
	// resilience toggles above, spending a reset credit is irreversible.
	const [codexAutoResetByAgent, setCodexAutoResetByAgent] = useState<Record<string, boolean>>({});
	// Codex transport, per provider. Absent means `exec`, the default.
	const [codexTransportByAgent, setCodexTransportByAgent] = useState<
		Record<string, CodexTransport>
	>({});
	const [agentConfigs, setAgentConfigs] = useState<Record<string, Record<string, any>>>({});
	const [availableModels, setAvailableModels] = useState<Record<string, string[]>>({});
	const [loadingModels, setLoadingModels] = useState<Record<string, boolean>>({});
	const [dynamicOptions, setDynamicOptions] = useState<Record<string, Record<string, string[]>>>(
		{}
	);
	const [loadingDynamicOptions, setLoadingDynamicOptions] = useState<Record<string, boolean>>({});
	const [directoryWarningAcknowledged, setDirectoryWarningAcknowledged] = useState(false);
	// Git repo status of the selected working directory.
	// 'unknown' = haven't checked yet, 'is-repo' / 'not-repo' = checked.
	const [gitRepoStatus, setGitRepoStatus] = useState<'unknown' | 'is-repo' | 'not-repo'>('unknown');
	const [isInitializingRepo, setIsInitializingRepo] = useState(false);
	const [initRepoError, setInitRepoError] = useState<string | null>(null);
	// SSH Remote configuration
	const [sshRemotes, setSshRemotes] = useState<SshRemoteConfig[]>([]);
	const [agentSshRemoteConfigs, setAgentSshRemoteConfigs] = useState<
		Record<string, AgentSshRemoteConfig>
	>({});
	// SSH connection error state - shown when we can't connect to the selected remote
	const [sshConnectionError, setSshConnectionError] = useState<string | null>(null);
	// Local Models gateway, per provider like the rest of the provider settings:
	// a URL typed for one provider is not carried onto another, whose base-URL
	// variable and route differ. Validated against the provider on create.
	const [gatewayUrlByAgent, setGatewayUrlByAgent] = useState<Record<string, string>>({});
	const [gatewayUrlError, setGatewayUrlError] = useState<string | undefined>(undefined);
	// Where the new agent's model runs. One value for the form, not one per
	// provider: a target names a source and a model, which every harness with a
	// recipe can use. A provider with none reads as Provider (`effectiveRunOn`).
	const [runOn, setRunOn] = useState<RunOnTarget>({ type: 'provider' });
	const [runOnError, setRunOnError] = useState<string | undefined>(undefined);
	// Set by a create attempt the form refused. From then on a required field
	// left empty shows its error, and its tab shows the dot.
	const [createAttempted, setCreateAttempted] = useState(false);

	// Group placement: '' means "No Group (Ungrouped)". Initialized when the modal
	// opens from the source session (when duplicating) or the caller's preset.
	const [selectedGroupId, setSelectedGroupId] = useState<string>('');
	const groups = useSessionStore((s) => s.groups);
	// The group whose defaults filled this form, with the seed as it was resolved
	// when the modal opened. `null` for a blank form and for a duplicate.
	const [groupSeed, setGroupSeed] = useState<(GroupDefaultsSeed & { group: Group }) | null>(null);
	const seededFromGroup = groupSeed?.group ?? null;
	const localModelEndpoints = useSettingsStore((s) => s.localModelEndpoints);
	// The Peers tab counts the group selected here, so choosing a group on General
	// is what enables its group grant.
	const peerGroupId = selectedGroupId || undefined;
	const peerFleet = usePeerFleet(peerGroupId);

	const nameInputRef = useRef<HTMLInputElement>(null);
	// The SSH remote a group seed just switched on. The re-detection that follows
	// is the seed's own doing, and is the one pass that keeps the form.
	const seedSshRemoteIdRef = useRef<string | null>(null);

	// The one piece of form state the tabs own. No `rememberKey`: create always
	// starts on General.
	const { activeTab, setActiveTab } = useModalTabs({
		tabs: AGENT_FORM_TAB_IDS,
		initialTab: 'general',
		enabled: isOpen,
	});

	// Fetch home directory on mount for tilde expansion
	useEffect(() => {
		window.maestro.fs.homeDir().then(setHomeDir);
	}, []);

	// Resolve the auto-detected maestro-p path for the Batch Mode toggle's helper text.
	useEffect(() => {
		void window.maestro.agents
			.getMaestroPDetectedPath()
			.then((p) => setDetectedMaestroPPath(p ?? undefined))
			.catch(() => setDetectedMaestroPPath(undefined));
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
	const loadAgents = async (
		source?: AgentSeed,
		sshRemoteId?: string,
		options: {
			/**
			 * What kind of seed `source` is. A `copy` (an agent being duplicated) is
			 * the whole truth: a provider setting it lacks is cleared in the form. A
			 * group's `defaults` are sparse: an absent one is no opinion, and the
			 * form keeps what it loaded for the provider.
			 */
			seedKind?: 'copy' | 'defaults';
			/**
			 * Refresh which providers the host can run and nothing else. Set for the
			 * re-detection a seed's own SSH remote causes, which must not replace
			 * the values the seed just put in the form.
			 */
			keepForm?: boolean;
		} = {}
	) => {
		setLoading(true);
		setSshConnectionError(null);
		const sparse = options.seedKind === 'defaults';
		// The provider the seed's provider settings belong to. A seed with none
		// (a group default that names no provider) fills the fields the form does
		// not keep per provider, and its env vars, resilience flags and SSH remote
		// for every provider, so they hold whichever one the user picks.
		const seedProvider = source?.toolType;
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
				setEnableMaestroPByAgent({});
				setMaestroPModeByAgent({});
				setMaestroPPathByAgent({});
				setRetryAvailabilityByAgent({});
				setRetryTokenByAgent({});
				setAgentSshRemoteConfigs({});
				setGatewayUrlByAgent({});
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
				// Local detection validates and recovers rotating binary paths. SSH paths
				// belong to the remote host and must not be validated against the local filesystem.
				const customPath = sshRemoteId ? config.customPath : agent.customPath;
				if (customPath) {
					paths[agent.id] = customPath;
				}
				if (config.customArgs) {
					args[agent.id] = config.customArgs;
				}
				if (config.customEnvVars && Object.keys(config.customEnvVars).length > 0) {
					envVars[agent.id] = config.customEnvVars;
				}
			}

			// If duplicating, merge source session config values into loaded configs
			if (source && seedProvider) {
				const sourceConfig: Record<string, any> = { ...configs[seedProvider] };
				if (source.customModel) {
					sourceConfig.model = source.customModel;
				}
				if (source.customContextWindow) {
					sourceConfig.contextWindow = source.customContextWindow;
				}
				if (source.customProviderPath) {
					sourceConfig.providerPath = source.customProviderPath;
				}
				if (source.customEffort) {
					// Agents use either `effort` (Claude Code) or `reasoningEffort` (Codex,
					// Copilot-CLI, Factory Droid). Pick whichever key the source agent
					// actually defines so the value round-trips through the modal.
					const sourceAgent = detectedAgents.find((a: AgentConfig) => a.id === seedProvider);
					sourceConfig[getEffortConfigKey(sourceAgent)] = source.customEffort;
				}
				configs[seedProvider] = sourceConfig;
			}

			if (!options.keepForm) {
				setAgentConfigs(configs);
				setCustomAgentPaths(paths);
				setCustomAgentArgs(args);
				setCustomAgentEnvVars(envVars);
			}

			// Select first available non-hidden agent (or source agent if duplicating)
			// (hidden agents like 'terminal' should never be auto-selected)
			if (seedProvider) {
				setSelectedAgent(seedProvider);
			} else if (!sshRemoteId) {
				// Only auto-select on initial load, not on SSH remote re-detection
				const firstAvailable = detectedAgents.find((a: AgentConfig) => a.available && !a.hidden);
				if (firstAvailable) {
					setSelectedAgent(firstAvailable.id);
				}
			}

			// Pre-fill form fields AFTER agents are loaded (ensures no race condition)
			if (source) {
				// For an SSH agent the field must show the REMOTE directory the agent
				// actually runs in. A CLI-created agent (`create-agent --ssh-cwd`) keeps
				// a local placeholder in `cwd` and the real path in the override, so the
				// override is what the copy should start from. The value on screen is
				// then the single source for the new agent's cwd AND its override.
				const seedWorkingDir =
					(source.sessionSshRemoteConfig?.enabled &&
						source.sessionSshRemoteConfig.workingDirOverride) ||
					(source.cwd ?? source.projectRoot);
				// A directory the caller named ("New Agent Here") outranks a group's
				// default one: it is the more specific of the two.
				if (seedWorkingDir !== undefined && !(sparse && presetWorkingDir)) {
					handleWorkingDirChange(seedWorkingDir);
				}
				// Clone the grants, don't alias them - the rows are edited in place and
				// would otherwise mutate the source agent's persisted array.
				setAdditionalDirectories((source.additionalDirectories ?? []).map((d) => ({ ...d })));
				// The copy starts with the source's peer grants, cloned for the same reason.
				setPeerAgents((source.peerAgents ?? []).map((peer) => ({ ...peer })));
				setGroupPeerAccess(source.groupPeerAccess && { ...source.groupPeerAccess });
				setWorktreePeerAccess(source.worktreePeerAccess && { ...source.worktreePeerAccess });
				if (source.name !== undefined) {
					setInstanceName(`${source.name} (Copy)`);
				}
				setNudgeMessage(source.nudgeMessage || '');
				setNewSessionMessage(source.newSessionMessage || '');

				// The copy runs on the same model. A stored target that cannot be read is
				// not copied: the copy starts on its provider's model.
				const sourceRunOn = parseRunOnTarget(source.runOn);
				setRunOn(sourceRunOn.ok ? sourceRunOn.target : { type: 'provider' });

				if (sparse) {
					// A group's env vars, resilience flags and SSH remote are not tied to
					// a provider, and the form keeps all three per provider. So they are
					// filled for every provider: a default that names no provider still
					// applies, and one that names a provider survives the user picking
					// another.
					const everyProvider = detectedAgents.map((a: AgentConfig) => a.id);
					const forEveryProvider = <Value,>(value: Value): Record<string, Value> =>
						Object.fromEntries(everyProvider.map((id: string) => [id, value]));
					const seedEnvVars = source.customEnvVars;
					if (seedEnvVars && Object.keys(seedEnvVars).length > 0) {
						// These become the agent's own variables, which replace the
						// provider set at launch. Do not copy unrelated provider values
						// (including account selectors) into the group's environment.
						setCustomAgentEnvVars(
							Object.fromEntries(everyProvider.map((id: string) => [id, { ...seedEnvVars }]))
						);
					}
					if (source.retryOnAvailabilityErrors !== undefined) {
						setRetryAvailabilityByAgent(
							forEveryProvider(resilienceEnabled(source.retryOnAvailabilityErrors))
						);
					}
					if (source.retryOnTokenExhaustion !== undefined) {
						setRetryTokenByAgent(
							forEveryProvider(resilienceEnabled(source.retryOnTokenExhaustion))
						);
					}
					// Under `_pending_` too, the key the SSH tab writes: the config then
					// follows the provider selection the way one chosen by hand does.
					const seedSsh = sshRemoteConfigToForm(source.sessionSshRemoteConfig);
					if (seedSsh) {
						setAgentSshRemoteConfigs((prev) => ({
							...prev,
							_pending_: seedSsh,
							...(seedProvider ? { [seedProvider]: seedSsh } : {}),
						}));
						// Turning the remote on makes the form detect providers on it.
						// That pass must not undo this one.
						if (seedSsh.enabled && seedSsh.remoteId) {
							seedSshRemoteIdRef.current = seedSsh.remoteId;
						}
					}
				}

				if (seedProvider) {
					// Pre-fill custom agent configuration, kept per provider. A copy
					// takes each value from its source, so an absent one clears the
					// form's. A group default with no path or args has no opinion, and
					// the form keeps the provider's own.
					if (!sparse || source.customPath !== undefined) {
						setCustomAgentPaths((prev) => ({
							...prev,
							[seedProvider]: source.customPath || '',
						}));
					}
					if (!sparse || source.customArgs !== undefined) {
						setCustomAgentArgs((prev) => ({
							...prev,
							[seedProvider]: source.customArgs || '',
						}));
					}
					if (!sparse) {
						setCustomAgentEnvVars((prev) => ({
							...prev,
							[seedProvider]: source.customEnvVars || {},
						}));
					}
					// Mirror the source agent's EXPLICIT Adaptive Mode choice so a duplicate
					// inherits it. When the source never configured a token source, leave the
					// entry unset so the duplicate falls through to the same default path as a
					// fresh agent (see agentEnableMaestroP below) instead of pinning a falsy
					// default as if it were an explicit "API" choice.
					setEnableMaestroPByAgent((prev) => {
						const next = { ...prev };
						if (source.enableMaestroP === undefined) {
							delete next[seedProvider];
						} else {
							next[seedProvider] = source.enableMaestroP;
						}
						return next;
					});
					setMaestroPModeByAgent((prev) => ({
						...prev,
						[seedProvider]: source.maestroPMode ?? 'dynamic',
					}));
					setMaestroPPathByAgent((prev) => ({
						...prev,
						[seedProvider]: source.maestroPPath || '',
					}));
					// Mirror the source agent's Agent Resilience toggles (default ON).
					if (!sparse) {
						setRetryAvailabilityByAgent((prev) => ({
							...prev,
							[seedProvider]: resilienceEnabled(source.retryOnAvailabilityErrors),
						}));
						setRetryTokenByAgent((prev) => ({
							...prev,
							[seedProvider]: resilienceEnabled(source.retryOnTokenExhaustion),
						}));
					}
					// Duplicating an agent carries its automatic-reset preference too, so a
					// copy does not silently start spending credits the original never did
					// (and vice versa).
					setCodexAutoResetByAgent((prev) => ({
						...prev,
						[seedProvider]: source.codexAutoResetOnExhaustion === true,
					}));
					// A copy runs its chat turns on the same transport as the original.
					setCodexTransportByAgent((prev) => ({
						...prev,
						[seedProvider]: source.codexTransport === 'app-server' ? 'app-server' : 'exec',
					}));
					// And through the same gateway. Its token proxy mode is not copied:
					// absent reads as passthrough, so a copy never starts compressing.
					setGatewayUrlByAgent((prev) => ({
						...prev,
						[seedProvider]: source.gatewayUrl ?? '',
					}));

					// Pre-fill SSH remote configuration if source session has it
					if (
						!sparse &&
						source.sessionSshRemoteConfig?.enabled &&
						source.sessionSshRemoteConfig?.remoteId
					) {
						setAgentSshRemoteConfigs((prev) => ({
							...prev,
							[seedProvider]: {
								enabled: true,
								remoteId: source.sessionSshRemoteConfig!.remoteId!,
								workingDirOverride: source.sessionSshRemoteConfig!.workingDirOverride,
							},
						}));
					}
				}
			}
		} catch (error) {
			logger.error('Failed to load agents:', undefined, error);
		} finally {
			setLoading(false);
		}
	};

	// Fill the form from a group's defaults. A fresh form plus the group's
	// values: `loadAgents` runs with the seed as it does with a duplicate's source.
	const seedFromGroup = async (group: Group, defaults: GroupAgentDefaults) => {
		// Whether the defaults' SSH remote still exists decides the seed, so the
		// remotes are read before anything is filled. A read that fails judges no
		// remote gone: an unknown remote then fails the launch by name, where a
		// remote wrongly dropped would run the agent on this machine.
		let sshRemoteIds: string[] | undefined;
		if (defaults.sessionSshRemoteConfig?.enabled) {
			try {
				const result = await window.maestro.sshRemote.getConfigs();
				if (result.success && result.configs) {
					sshRemoteIds = result.configs.map((remote: SshRemoteConfig) => remote.id);
				}
			} catch (error) {
				logger.error('Failed to load SSH remote configs for a group seed:', undefined, error);
			}
		}
		const resolved = resolveGroupDefaultsSeed(defaults, {
			sshRemoteIds,
			endpoints: useSettingsStore.getState().localModelEndpoints ?? [],
		});
		setGroupSeed({ ...resolved, group });
		await loadAgents(resolved.seed, undefined, { seedKind: 'defaults' });
	};

	const handleSelectFolder = React.useCallback(async () => {
		const folder = await window.maestro.dialog.selectFolder();
		if (folder) {
			handleWorkingDirChange(folder);
		}
	}, [handleWorkingDirChange]);

	// Resolve the SSH remote ID currently selected (pending or per-agent).
	const effectiveSshRemoteId = useMemo(() => {
		if (!isSshEnabled) return undefined;
		const config = selectedAgent
			? agentSshRemoteConfigs[selectedAgent]
			: agentSshRemoteConfigs['_pending_'];
		return config?.remoteId || undefined;
	}, [isSshEnabled, selectedAgent, agentSshRemoteConfigs]);

	// Debounced git repo detection - checks if the selected working dir is
	// already a git repo so we can offer to `git init` it if not.
	useEffect(() => {
		const trimmed = workingDir.trim();
		// Reset stale state from a previous directory before the async check
		// resolves - otherwise the previous "not-repo" panel keeps rendering
		// (with a clickable Init button) against the new, unvalidated path
		// during the 500ms debounce window.
		setGitRepoStatus('unknown');
		setInitRepoError(null);
		if (!trimmed) {
			return;
		}

		// For SSH, wait until the remote path validates as a directory.
		if (isSshEnabled && !remotePathValidation.valid) {
			return;
		}

		let cancelled = false;
		const timeoutId = setTimeout(async () => {
			const expanded = expandTilde(trimmed);
			const isRepo = await gitService.isRepo(expanded, effectiveSshRemoteId);
			if (!cancelled) {
				setGitRepoStatus(isRepo ? 'is-repo' : 'not-repo');
			}
		}, 500);

		return () => {
			cancelled = true;
			clearTimeout(timeoutId);
		};
	}, [workingDir, isSshEnabled, remotePathValidation.valid, effectiveSshRemoteId, expandTilde]);

	const handleInitRepo = React.useCallback(async () => {
		const trimmed = workingDir.trim();
		if (!trimmed || isInitializingRepo) return;
		setIsInitializingRepo(true);
		setInitRepoError(null);
		try {
			const expanded = expandTilde(trimmed);
			const result = await gitService.init(expanded, effectiveSshRemoteId);
			if (!result.success) {
				setInitRepoError(result.error || 'Failed to initialize git repository');
				return;
			}
			setGitRepoStatus('is-repo');
		} finally {
			setIsInitializingRepo(false);
		}
	}, [workingDir, isInitializingRepo, expandTilde, effectiveSshRemoteId]);

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

	// A provider whose harness has no Run on recipe runs on its own model, so a
	// target chosen under another provider is neither shown nor stored for it.
	const effectiveRunOn: RunOnTarget = useMemo(
		() => (agentRunOnSupport(selectedAgent).supported ? runOn : { type: 'provider' }),
		[selectedAgent, runOn]
	);
	// What the Auto model choice is judged against besides the provider: a new
	// agent has no tier targets of its own yet, so only where it runs.
	const autoModelFor = useMemo(() => ({ runOn: effectiveRunOn }), [effectiveRunOn]);

	// The group defaults this form has no control for (tiers, switched-off
	// variables, the token proxy, System One). They are stamped onto the agent
	// as it is created, judged against the form as it stands NOW: a provider, an
	// SSH remote or a gateway the user changed since the seed decides what the
	// new agent can take. The banner names them from the same value.
	const seedExtras = useMemo(() => {
		if (!groupSeed || !selectedAgent) return null;
		return groupDefaultsCreateExtras(
			groupSeed.seed,
			{
				toolType: selectedAgent as ToolType,
				customEnvVars: customAgentEnvVars[selectedAgent],
				gatewayUrl: gatewayUrlByAgent[selectedAgent]?.trim() || undefined,
				sessionSshRemoteConfig: effectiveSshRemoteId
					? { enabled: true, remoteId: effectiveSshRemoteId }
					: undefined,
			},
			{ endpoints: localModelEndpoints ?? [] }
		);
	}, [
		groupSeed,
		selectedAgent,
		customAgentEnvVars,
		gatewayUrlByAgent,
		effectiveSshRemoteId,
		localModelEndpoints,
	]);

	// One test turn on the target the picker shows, launched with the form as it
	// stands. No agent exists yet, so every launch setting comes from the form.
	const handleTestRunOn = useCallback(
		(target: RunOnSourceTarget) => {
			const sshConfig = agentSshRemoteConfigs[selectedAgent] || agentSshRemoteConfigs['_pending_'];
			const remoteId = sshConfig?.enabled ? sshConfig.remoteId : null;
			// A remote path keeps its `~`: only the remote shell can expand it.
			const cwd = remoteId ? workingDir.trim() : expandTilde(workingDir.trim());
			return window.maestro.localModels.runOn.test({
				target,
				subject: {
					toolType: selectedAgent,
					cwd,
					customPath: customAgentPaths[selectedAgent]?.trim() || undefined,
					customArgs: customAgentArgs[selectedAgent]?.trim() || undefined,
					customEnvVars: customAgentEnvVars[selectedAgent],
					sshRemoteConfig: remoteId
						? { enabled: true, remoteId, workingDirOverride: cwd }
						: { enabled: false, remoteId: null },
				},
			});
		},
		[
			agentSshRemoteConfigs,
			selectedAgent,
			workingDir,
			expandTilde,
			customAgentPaths,
			customAgentArgs,
			customAgentEnvVars,
		]
	);

	const handleCreate = React.useCallback(() => {
		const name = instanceName.trim();
		if (!name) return; // Name is required

		const sshConfig = agentSshRemoteConfigs[selectedAgent] || agentSshRemoteConfigs['_pending_'];
		const sshRemoteId = sshConfig?.enabled ? sshConfig?.remoteId : null;
		// With SSH enabled the field holds a REMOTE path, so a leading `~` is the
		// remote user's home and only the remote shell can expand it: every
		// remote `cd`/`ls`/`stat` renders it as `"$HOME/..."`. Expanding locally
		// turned `~/git-projects` into `/Users/<local>/git-projects`, a path that
		// validated green here (the validator statted the raw text) and then did
		// not exist on the host the agent started on.
		const effectiveWorkingDir = sshRemoteId ? workingDir.trim() : expandTilde(workingDir.trim());

		// Validate before creating
		const result = validateNewSession(
			name,
			effectiveWorkingDir,
			selectedAgent as ToolType,
			existingSessions,
			sshRemoteId
		);
		if (!result.valid) return;

		// The gateway is checked against the provider that will use it, with the
		// function the launch and the CLI use, so nothing is stored that the
		// launch would then refuse. A refusal shows on the Models tab.
		const gatewayEdit = parseGatewayUrlEdit(selectedAgent, gatewayUrlByAgent[selectedAgent] ?? '');
		if (!gatewayEdit.ok) {
			setGatewayUrlError(gatewayEdit.error);
			setActiveTab('models');
			return;
		}

		// The Run on target goes through the validator every writer shares. A
		// refusal shows on the Models tab.
		const runOnEdit = parseRunOnTarget(effectiveRunOn);
		if (!runOnEdit.ok) {
			setRunOnError(runOnEdit.error);
			setActiveTab('models');
			return;
		}

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
		// Effort/reasoningEffort: agents use one or the other key (e.g. Codex stores
		// it under `reasoningEffort`, Claude Code uses `effort`).
		const agentCustomEffort = readEffortFromConfig(agentConfigs[selectedAgent]);

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
						// Always the directory TYPED here, never a value carried over from
						// the agent being duplicated: that carry-over pinned every terminal,
						// git call and file tree of the new agent to the OLD agent's remote
						// directory while the agent itself started in the new one.
						workingDirOverride: effectiveWorkingDir || undefined,
						syncHistory: sshRemoteConfig.syncHistory,
						shareHistoryToProjectDir: sshRemoteConfig.shareHistoryToProjectDir,
					}
				: {
						enabled: false,
						remoteId: null,
						shareHistoryToProjectDir: sshRemoteConfig?.shareHistoryToProjectDir,
					};

		// The dropdown's selected value wins - it was seeded from the source
		// session's group (when duplicating) or the caller's preset (e.g. "New
		// Agent in Group" from the group context menu), so explicit user
		// selection naturally overrides those defaults.
		const targetGroupId = selectedGroupId || undefined;

		// New agents default Adaptive Mode on for Claude Code (isAdaptiveModeDefaultOn);
		// an explicit toggle in the form (true/false) always wins over the default.
		// The explicit choice must NOT be collapsed by `|| undefined` - an explicit
		// `false` (API) has to survive, or over SSH it reverts to the TUI default
		// and spawns maestro-p on a remote that may not have it (exit 127). Only the
		// unset->default path keeps the `|| undefined` collapse (a falsy default
		// stays "unconfigured").
		const explicitMaestroP = enableMaestroPByAgent[selectedAgent];
		const agentEnableMaestroP =
			explicitMaestroP ?? (isAdaptiveModeDefaultOn(selectedAgent) || undefined);
		const agentMaestroPPath =
			agentEnableMaestroP && maestroPPathByAgent[selectedAgent]?.trim()
				? maestroPPathByAgent[selectedAgent].trim()
				: undefined;
		// Token-source refinement only travels with the opt-in (defaults to dynamic).
		const agentMaestroPMode = agentEnableMaestroP
			? (maestroPModeByAgent[selectedAgent] ?? 'dynamic')
			: undefined;

		onCreate(
			selectedAgent,
			effectiveWorkingDir,
			name,
			nudgeMessage.trim() || undefined,
			newSessionMessage.trim() || undefined,
			agentCustomPath,
			agentCustomArgs,
			agentCustomEnvVars,
			agentCustomModel,
			agentCustomContextWindow,
			agentCustomProviderPath,
			sessionSshRemoteConfig,
			agentCustomEffort,
			targetGroupId ?? undefined,
			agentEnableMaestroP,
			agentMaestroPPath,
			agentMaestroPMode,
			retryAvailabilityByAgent[selectedAgent] ?? true,
			retryTokenByAgent[selectedAgent] ?? true,
			normalizeAdditionalDirectories(additionalDirectories, homeDir),
			codexAutoResetByAgent[selectedAgent] ?? false,
			codexTransportByAgent[selectedAgent] ?? 'exec',
			gatewayEdit.gatewayUrl ?? undefined,
			// Provider is the absence of a target on the agent record.
			isRunOnSourceTarget(runOnEdit.target) ? runOnEdit.target : undefined,
			{
				peerAgents: normalizePeerAgents(peerAgents),
				groupPeerAccess,
				worktreePeerAccess,
			},
			// The group defaults the form has no control for. Absent for a form that
			// was not seeded from a group, and for a seed that holds none.
			seedExtras && Object.keys(seedExtras.extras).length > 0 ? seedExtras.extras : undefined
		);
		onClose();

		// Reset
		setInstanceName('');
		handleWorkingDirChange('');
		setAdditionalDirectories([]);
		setPeerAgents([]);
		setGroupPeerAccess(undefined);
		setWorktreePeerAccess(undefined);
		setNudgeMessage('');
		setNewSessionMessage('');
		// Reset per-agent config for selected agent
		setCustomAgentPaths((prev) => ({ ...prev, [selectedAgent]: '' }));
		setCustomAgentArgs((prev) => ({ ...prev, [selectedAgent]: '' }));
		setCustomAgentEnvVars((prev) => ({ ...prev, [selectedAgent]: {} }));
		// Clear the explicit override (rather than forcing false) so the agent's
		// default (on for Claude Code) applies again on the next open.
		setEnableMaestroPByAgent((prev) => {
			const next = { ...prev };
			delete next[selectedAgent];
			return next;
		});
		// Clear the explicit mode override too so the default (dynamic) applies again.
		setMaestroPModeByAgent((prev) => {
			const next = { ...prev };
			delete next[selectedAgent];
			return next;
		});
		setMaestroPPathByAgent((prev) => ({ ...prev, [selectedAgent]: '' }));
		// Clear the resilience overrides so the default (both ON) applies next open.
		setRetryAvailabilityByAgent((prev) => {
			const next = { ...prev };
			delete next[selectedAgent];
			return next;
		});
		setRetryTokenByAgent((prev) => {
			const next = { ...prev };
			delete next[selectedAgent];
			return next;
		});
		setAgentSshRemoteConfigs((prev) => {
			const newConfigs = { ...prev };
			delete newConfigs[selectedAgent];
			return newConfigs;
		});
		setGatewayUrlByAgent((prev) => {
			const next = { ...prev };
			delete next[selectedAgent];
			return next;
		});
		setRunOn({ type: 'provider' });
		setRunOnError(undefined);
	}, [
		instanceName,
		selectedAgent,
		workingDir,
		additionalDirectories,
		peerAgents,
		groupPeerAccess,
		worktreePeerAccess,
		homeDir,
		nudgeMessage,
		newSessionMessage,
		customAgentPaths,
		customAgentArgs,
		customAgentEnvVars,
		enableMaestroPByAgent,
		maestroPModeByAgent,
		maestroPPathByAgent,
		agentConfigs,
		agentSshRemoteConfigs,
		onCreate,
		onClose,
		expandTilde,
		handleWorkingDirChange,
		existingSessions,
		selectedGroupId,
		retryAvailabilityByAgent,
		retryTokenByAgent,
		codexAutoResetByAgent,
		codexTransportByAgent,
		gatewayUrlByAgent,
		effectiveRunOn,
		seedExtras,
		setActiveTab,
	]);

	// Agent is considered available if:
	// 1. It was auto-detected (agent.available), OR
	// 2. User specified a custom path for it
	const isAgentUsable = useMemo(() => {
		const agent = agents.find((a) => a.id === selectedAgent);
		return !!agent?.available || !!customAgentPaths[selectedAgent]?.trim();
	}, [agents, selectedAgent, customAgentPaths]);
	const directoryWarningNeedsAck = !!validation.warning && !directoryWarningAcknowledged;

	// Check if form is valid for submission
	const isFormValid = useMemo(() => {
		// Remote path validation is informational only - don't block creation
		// Users may want to set up agent for a remote before the path exists
		return (
			selectedAgent &&
			isAgentUsable &&
			workingDir.trim() &&
			instanceName.trim() &&
			validation.valid &&
			!directoryWarningNeedsAck
		);
	}, [
		selectedAgent,
		isAgentUsable,
		workingDir,
		instanceName,
		validation.valid,
		directoryWarningNeedsAck,
	]);

	// The message under each field. An empty required field only says so once a
	// create attempt was refused, so a fresh form is not drawn in red.
	const nameError =
		validation.errorField === 'name'
			? validation.error
			: createAttempted && !instanceName.trim()
				? 'Enter a name for the agent'
				: undefined;
	const directoryError =
		validation.errorField === 'directory'
			? validation.error
			: createAttempted && !workingDir.trim()
				? 'Choose a working directory'
				: undefined;

	// Fields showing an error message: each puts a dot on its tab.
	const errorFields = useMemo(() => {
		const fields: string[] = [];
		if (nameError) fields.push('name');
		if (directoryError) fields.push('directory');
		if (gatewayUrlError) fields.push('gatewayUrl');
		if (runOnError) fields.push('runOn');
		return fields;
	}, [nameError, directoryError, gatewayUrlError, runOnError]);
	const tabs = useMemo(
		() => buildAgentSettingsTabs(AGENT_FORM_TAB_IDS, errorFields),
		[errorFields]
	);

	// Create from the footer button or the keyboard. A refused attempt goes to
	// the first field that blocks it, so a user on another tab is not left
	// facing a dead Create button. A provider that cannot run and an
	// unacknowledged shared directory block without a message, so they count
	// here too.
	const attemptCreate = useCallback(() => {
		if (isFormValid) {
			handleCreate();
			return;
		}
		setCreateAttempted(true);
		const blocking: string[] = [...errorFields];
		if (!instanceName.trim()) blocking.push('name');
		if (!workingDir.trim() || directoryWarningNeedsAck) blocking.push('directory');
		if (!selectedAgent || !isAgentUsable) blocking.push('provider');
		const tab = firstTabWithError(blocking, AGENT_FORM_TAB_IDS);
		if (tab) setActiveTab(tab);
	}, [
		isFormValid,
		handleCreate,
		errorFields,
		instanceName,
		workingDir,
		directoryWarningNeedsAck,
		selectedAgent,
		isAgentUsable,
		setActiveTab,
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
				attemptCreate();
			}
		};
		window.addEventListener('keydown', handler, true);
		return () => window.removeEventListener('keydown', handler, true);
	}, [isOpen, handleSelectFolder, attemptCreate, isSshEnabled]);

	// Sort agents: supported first, then coming soon at the bottom. Each bucket is
	// alphabetical by the name the row renders, matching the wizard's tile strip
	// and the Group Chat moderator dropdown.
	const sortedAgents = useMemo(() => {
		const byName = (a: AgentConfig, b: AgentConfig) => a.name.localeCompare(b.name);
		const visible = agents.filter((a) => !a.hidden);
		const supported = visible.filter((a) => SUPPORTED_AGENTS.includes(a.id)).sort(byName);
		const comingSoon = visible.filter((a) => !SUPPORTED_AGENTS.includes(a.id)).sort(byName);
		return [...supported, ...comingSoon];
	}, [agents]);

	// The rows the picker draws. Same rule as the wizard's tile strip: hide what
	// this machine cannot run, unless asked, and never filter down to nothing.
	const visibleAgents = useMemo(
		() =>
			filterToAvailableProviders(
				sortedAgents,
				(agent) => SUPPORTED_AGENTS.includes(agent.id) && !!agent.available,
				showAllProviders,
				(agent) => agent.id === selectedAgent
			),
		[sortedAgents, showAllProviders, selectedAgent]
	);

	// Counted over ALL supported providers, not the filtered rows - a count that
	// shrank with the list would read "4 of 4" and answer nothing.
	const providerCounts = useMemo(() => {
		const supported = sortedAgents.filter((agent) => SUPPORTED_AGENTS.includes(agent.id));
		return {
			total: supported.length,
			available: supported.filter((agent) => agent.available).length,
		};
	}, [sortedAgents]);

	// The counts describe whichever machine detection probed, so name that machine
	// rather than claiming "locally" while an SSH remote is selected.
	const providerLocation = useMemo(() => providerLocationLabel(sshRemoteHost), [sshRemoteHost]);

	// The remote's name, for the gateway field and the "Runs on" chip. The id
	// stands in until the remotes load: both must know the agent is remote.
	const sshRemoteName = useMemo(() => {
		if (!effectiveSshRemoteId) return undefined;
		return sshRemotes.find((r) => r.id === effectiveSshRemoteId)?.name ?? effectiveSshRemoteId;
	}, [effectiveSshRemoteId, sshRemotes]);

	// One set of env var handlers, keyed by provider. The picker's config panels
	// (which hide the rows) and the Provider environment section share it.
	const envVarHandlers = {
		onEnvVarKeyChange: (agentId: string, oldKey: string, newKey: string, value: string) => {
			setCustomAgentEnvVars((prev) => {
				const currentVars = { ...prev[agentId] };
				delete currentVars[oldKey];
				currentVars[newKey] = value;
				return { ...prev, [agentId]: currentVars };
			});
		},
		onEnvVarValueChange: (agentId: string, key: string, value: string) => {
			setCustomAgentEnvVars((prev) => ({
				...prev,
				[agentId]: {
					...prev[agentId],
					[key]: value,
				},
			}));
		},
		onEnvVarRemove: (agentId: string, key: string) => {
			setCustomAgentEnvVars((prev) => {
				const currentVars = { ...prev[agentId] };
				delete currentVars[key];
				const next = { ...prev };
				if (Object.keys(currentVars).length > 0) {
					next[agentId] = currentVars;
				} else {
					delete next[agentId];
				}
				return next;
			});
		},
		onEnvVarAdd: (agentId: string) => {
			setCustomAgentEnvVars((prev) => ({
				...prev,
				[agentId]: withBlankEnvVarRow(prev[agentId] ?? {}),
			}));
		},
	};

	// Effects - load agents and optionally pre-fill from source session
	// Dependency uses sourceSession?.id (not the full object) so unrelated
	// `sessions` store updates don't re-fire pre-fill and clobber what the
	// user has typed (issue #827).
	useEffect(() => {
		if (isOpen) {
			// A group's defaults seed the form when the agent is created in that
			// group and is not a duplicate (a duplicate is its source's copy). Read
			// from the store here, once: the defaults are copy-at-create, so a later
			// edit to the group must not refill a form the user is typing in.
			const seedGroup =
				!sourceSession && presetGroupId
					? useSessionStore.getState().groups.find((g) => g.id === presetGroupId)
					: undefined;
			if (seedGroup?.defaults) {
				void seedFromGroup(seedGroup, seedGroup.defaults);
			} else {
				setGroupSeed(null);
				// Pass sourceSession to loadAgents to handle pre-fill AFTER agents are loaded
				// This prevents the race condition where loadAgents would overwrite pre-filled values
				loadAgents(sourceSession);
			}
			// Keep all agents collapsed by default, or expand the seed's provider
			// (a duplicate's, or a group default's) to show its custom config.
			setExpandedAgent(sourceSession?.toolType ?? seedGroup?.defaults?.toolType ?? null);
			// Reset warning acknowledgment when modal opens
			setDirectoryWarningAcknowledged(false);
			// A fresh form: General first, no refused attempt, no gateway error.
			setActiveTab('general');
			setCreateAttempted(false);
			setGatewayUrlError(undefined);
			// Seed group selection: duplicate inherits source's group; otherwise
			// honor any presetGroupId from the caller. Choosing another group in the
			// picker afterwards moves the new agent and does NOT reseed the form:
			// a reseed would replace values the user has typed since it opened.
			setSelectedGroupId(sourceSession?.groupId ?? presetGroupId ?? '');
			// Seed the working directory from the caller (e.g. "New Agent Here" on a
			// folder in the Files panel). Skipped when duplicating - loadAgents fills
			// the working dir from the source session instead. The folder's basename
			// is a sensible default name, and both fields stay editable.
			if (!sourceSession && presetWorkingDir) {
				handleWorkingDirChange(presetWorkingDir);
				setInstanceName(getBasename(presetWorkingDir));
			}
		}
	}, [
		isOpen,
		sourceSession?.id,
		presetGroupId,
		presetWorkingDir,
		handleWorkingDirChange,
		setActiveTab,
	]);

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

		// A group seed that switched this remote on caused this pass itself. It
		// only needs to learn which providers the remote can run: reloading the
		// provider settings would replace the env vars, path and model the seed
		// put in the form a moment ago.
		const keepForm = !!currentSshRemoteId && seedSshRemoteIdRef.current === currentSshRemoteId;
		seedSshRemoteIdRef.current = null;

		// Re-run agent detection with the new SSH remote ID
		loadAgents(undefined, currentSshRemoteId ?? undefined, { keepForm });
	}, [isOpen, currentSshRemoteId]);

	if (!isOpen) return null;

	return (
		<Modal
			theme={theme}
			title="Create New Agent"
			priority={MODAL_PRIORITIES.NEW_INSTANCE}
			onClose={onClose}
			resizable
			resizeKey="new-agent"
			defaultSize={{ width: 720, height: 640 }}
			minSize={{ width: 560, height: 420 }}
			contentClassName="flex flex-col flex-1 min-h-0"
			initialFocusRef={nameInputRef}
			footer={
				<ModalFooter
					theme={theme}
					onCancel={onClose}
					onConfirm={attemptCreate}
					confirmLabel="Create Agent"
					confirmDisabled={!isFormValid}
				/>
			}
		>
			{seededFromGroup && groupSeed && (
				<GroupSeedBanner
					theme={theme}
					group={seededFromGroup}
					sshRemoteMissing={groupSeed.sshRemoteMissing}
					appliedOnCreate={(Object.keys(seedExtras?.extras ?? {}) as GroupDefaultKey[]).map(
						groupDefaultLabel
					)}
					skipped={[...groupSeed.skipped, ...(seedExtras?.skipped ?? [])]}
					onOpenGroupSettings={() => {
						// One modal at a time: Group Settings takes the window, and this
						// form is closed without creating an agent.
						onClose();
						getModalActions().openGroupSettings(seededFromGroup.id);
					}}
					className="mx-6 mt-4"
				/>
			)}
			<ModalTabStrip
				theme={theme}
				tabs={tabs}
				activeTab={activeTab}
				onChange={setActiveTab}
				label="Agent settings"
				idPrefix="new-agent"
				className="px-6 pt-4"
			/>
			<div className="flex-1 min-h-0 overflow-y-auto p-6" data-testid="new-agent-tab-body">
				{activeTab === 'general' && (
					<GeneralTab
						theme={theme}
						idPrefix="new-agent"
						name={instanceName}
						onNameChange={setInstanceName}
						nameError={nameError}
						nameInputRef={nameInputRef}
						nameInputId="agent-name-input"
						groupPicker={
							// Agent Group - only shown when at least one group exists
							groups.length > 0 ? (
								<div className="w-full">
									<label
										htmlFor="agent-group-select"
										className="block text-xs font-bold opacity-70 uppercase mb-2"
										style={{ color: theme.colors.textMain }}
									>
										Agent Group
									</label>
									<ThemedSelect
										id="agent-group-select"
										theme={theme}
										value={selectedGroupId}
										onChange={setSelectedGroupId}
										aria-label="Agent Group"
										options={[
											{ value: '', label: 'No Group (Ungrouped)' },
											...groups.map((g) => ({
												value: g.id,
												label: `${g.emoji} ${g.name}`.trim(),
											})),
										]}
									/>
								</div>
							) : undefined
						}
						workingDirectory={
							// The input, then what it learned about the directory: remote
							// path status, the git-repo hint, and the shared-directory warning.
							<div className="space-y-5">
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
									error={directoryError}
									monospace
									heightClass="p-2"
									addon={
										<button
											onClick={isSshEnabled ? undefined : handleSelectFolder}
											disabled={isSshEnabled}
											className={`p-2 rounded border transition-colors ${isSshEnabled ? 'opacity-40 cursor-not-allowed' : 'row-hover'}`}
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

								{isSshEnabled && workingDir.trim() && (
									<RemotePathStatus
										theme={theme}
										validation={remotePathValidation}
										remoteHost={sshRemoteHost}
									/>
								)}

								{/* Git repo hint - offer to `git init` when the selected dir isn't a repo */}
								{workingDir.trim() && gitRepoStatus === 'not-repo' && (
									<div
										className="flex items-center gap-3 p-3 rounded border"
										style={{
											backgroundColor: theme.colors.bgSidebar,
											borderColor: theme.colors.border,
										}}
									>
										<div className="flex-1">
											<p className="text-sm" style={{ color: theme.colors.textMain }}>
												Not a Git repository
											</p>
											{initRepoError && (
												<p className="text-xs mt-1" style={{ color: theme.colors.error }}>
													{initRepoError}
												</p>
											)}
										</div>
										<button
											type="button"
											onClick={handleInitRepo}
											disabled={isInitializingRepo}
											className="text-xs px-3 py-1.5 rounded border transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2"
											style={{
												backgroundColor: 'transparent',
												borderColor: theme.colors.accent,
												color: theme.colors.accent,
												opacity: isInitializingRepo ? 0.6 : 1,
												cursor: isInitializingRepo ? 'wait' : 'pointer',
												['--tw-ring-color' as any]: theme.colors.accent,
												['--tw-ring-offset-color' as any]: theme.colors.bgMain,
											}}
										>
											{isInitializingRepo ? 'Initializing…' : 'Initialize as Git Repository'}
										</button>
									</div>
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
							</div>
						}
						additionalDirectories={{
							directories: additionalDirectories,
							onChange: setAdditionalDirectories,
							disableBrowse: !!isSshEnabled,
							nativelyEnforced: !!agents.find((a) => a.id === selectedAgent)?.capabilities
								?.supportsAdditionalDirectories,
						}}
						newSessionMessage={newSessionMessage}
						onNewSessionMessageChange={setNewSessionMessage}
						nudgeMessage={nudgeMessage}
						onNudgeMessageChange={setNudgeMessage}
						sshRemoteHost={sshRemoteName}
					/>
				)}

				{activeTab === 'provider' && (
					<ProviderTab
						theme={theme}
						idPrefix="new-agent"
						picker={
							// Each provider's settings (path, args, model, ...) expand in its
							// card. The selected provider's environment follows the picker.
							<AgentPickerGrid
								theme={theme}
								hideEnvVars
								autoModelFor={autoModelFor}
								loading={loading}
								sshConnectionError={sshConnectionError}
								visibleAgents={visibleAgents}
								availableProviderCount={providerCounts.available}
								totalProviderCount={providerCounts.total}
								providerLocationLabel={providerLocation}
								showAllProviders={showAllProviders}
								onShowAllProvidersChange={setShowAllProviders}
								selectedAgent={selectedAgent}
								expandedAgent={expandedAgent}
								refreshingAgent={refreshingAgent}
								debugInfo={debugInfo}
								customAgentPaths={customAgentPaths}
								customAgentArgs={customAgentArgs}
								customAgentEnvVars={customAgentEnvVars}
								enableMaestroPByAgent={enableMaestroPByAgent}
								maestroPModeByAgent={maestroPModeByAgent}
								maestroPPathByAgent={maestroPPathByAgent}
								detectedMaestroPPath={detectedMaestroPPath}
								agentConfigs={agentConfigs}
								availableModels={availableModels}
								loadingModels={loadingModels}
								onAgentSelect={(agentId) => {
									setSelectedAgent(agentId);
									// A refusal was about the previous provider's gateway.
									setGatewayUrlError(undefined);
								}}
								onAgentExpand={(agentId) => setExpandedAgent(agentId)}
								onRefreshAgent={handleRefreshAgent}
								onDismissDebug={() => setDebugInfo(null)}
								onCustomPathChange={(agentId, value) => {
									setCustomAgentPaths((prev) => ({ ...prev, [agentId]: value }));
								}}
								onCustomArgsChange={(agentId, value) => {
									setCustomAgentArgs((prev) => ({ ...prev, [agentId]: value }));
								}}
								onEnableMaestroPChange={(agentId, value) => {
									setEnableMaestroPByAgent((prev) => ({ ...prev, [agentId]: value }));
								}}
								onMaestroPModeChange={(agentId, value) => {
									setMaestroPModeByAgent((prev) => ({ ...prev, [agentId]: value }));
								}}
								onMaestroPPathChange={(agentId, value) => {
									setMaestroPPathByAgent((prev) => ({ ...prev, [agentId]: value }));
								}}
								onEnvVarKeyChange={envVarHandlers.onEnvVarKeyChange}
								onEnvVarValueChange={envVarHandlers.onEnvVarValueChange}
								onEnvVarRemove={envVarHandlers.onEnvVarRemove}
								onEnvVarAdd={envVarHandlers.onEnvVarAdd}
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
								codexAutoResetByAgent={codexAutoResetByAgent}
								onCodexAutoResetChange={(agentId, value) =>
									setCodexAutoResetByAgent((prev) => ({ ...prev, [agentId]: value }))
								}
								codexTransportByAgent={codexTransportByAgent}
								onCodexTransportChange={(agentId, value) =>
									setCodexTransportByAgent((prev) => ({ ...prev, [agentId]: value }))
								}
							/>
						}
						environment={
							selectedAgent ? (
								<ProviderEnvironmentSection
									theme={theme}
									providerName={getAgentDisplayName(selectedAgent)}
									toolType={selectedAgent}
									isSshEnabled={!!isSshEnabled}
									customEnvVars={customAgentEnvVars[selectedAgent] ?? {}}
									onEnvVarKeyChange={(oldKey, newKey, value) =>
										envVarHandlers.onEnvVarKeyChange(selectedAgent, oldKey, newKey, value)
									}
									onEnvVarValueChange={(key, value) =>
										envVarHandlers.onEnvVarValueChange(selectedAgent, key, value)
									}
									onEnvVarRemove={(key) => envVarHandlers.onEnvVarRemove(selectedAgent, key)}
									onEnvVarAdd={() => envVarHandlers.onEnvVarAdd(selectedAgent)}
									onEnvVarsBlur={() => {
										/* Saved on agent create */
									}}
								/>
							) : undefined
						}
						// Agent Resilience: auto-retry toggles (default ON).
						resilience={
							selectedAgent
								? {
										retryOnAvailabilityErrors: retryAvailabilityByAgent[selectedAgent] ?? true,
										retryOnTokenExhaustion: retryTokenByAgent[selectedAgent] ?? true,
										onChangeAvailability: (value) =>
											setRetryAvailabilityByAgent((prev) => ({ ...prev, [selectedAgent]: value })),
										onChangeTokenExhaustion: (value) =>
											setRetryTokenByAgent((prev) => ({ ...prev, [selectedAgent]: value })),
									}
								: undefined
						}
					/>
				)}

				{activeTab === 'models' && (
					<ModelsTab
						theme={theme}
						idPrefix="new-agent"
						runOn={
							selectedAgent ? (
								<div data-testid="new-agent-run-on">
									<RunOnField
										theme={theme}
										toolType={selectedAgent}
										value={effectiveRunOn}
										onChange={(target) => {
											setRunOn(target);
											setRunOnError(undefined);
										}}
										userEnvVars={customAgentEnvVars[selectedAgent]}
										sshRemoteName={sshRemoteName}
										error={runOnError}
										onTest={handleTestRunOn}
										testBlockedReason={
											workingDir.trim() === ''
												? 'Choose a working directory on the General tab first.'
												: undefined
										}
										testId="new-agent-run-on-field"
									/>
								</div>
							) : undefined
						}
						gateway={
							selectedAgent ? (
								// Local Models gateway, for the selected provider. Rendered for
								// every provider: one that cannot use a gateway shows the field
								// disabled with the reason.
								<div data-testid="new-agent-gateway" className="space-y-2">
									<GatewayUrlField
										theme={theme}
										label="Local Models Gateway"
										toolType={selectedAgent}
										value={gatewayUrlByAgent[selectedAgent] ?? ''}
										onChange={(value) => {
											setGatewayUrlByAgent((prev) => ({ ...prev, [selectedAgent]: value }));
											setGatewayUrlError(undefined);
										}}
										// Seeded from the provider-level set, and saved as the agent's own.
										userEnvVars={customAgentEnvVars[selectedAgent]}
										sshRemoteName={sshRemoteName}
										error={gatewayUrlError}
										disabledReason={
											isRunOnSourceTarget(effectiveRunOn)
												? RUN_ON_GATEWAY_SKIPPED_REASON
												: undefined
										}
										testId="new-agent-gateway-url"
									/>
									<p className="text-xs" style={{ color: theme.colors.textDim }}>
										The {TOKEN_PROXY_NAME} mode is chosen in Edit Agent once the agent exists.
									</p>
								</div>
							) : undefined
						}
					/>
				)}

				{activeTab === 'peers' && (
					// No `selfSessionId`: the agent has no id until it is created, so the
					// picker offers the whole fleet.
					<PeersTab
						theme={theme}
						idPrefix="new-agent"
						peers={peerAgents}
						onChange={setPeerAgents}
						groupAccess={groupPeerAccess}
						onGroupAccessChange={setGroupPeerAccess}
						worktreeAccess={worktreePeerAccess}
						onWorktreeAccessChange={setWorktreePeerAccess}
						{...peerFleet}
						groupId={peerGroupId}
					/>
				)}

				{activeTab === 'ssh' && (
					// Always rendered, even when no remotes are configured, so the
					// "remote-controlled" toggle is reachable - it mirrors history
					// to the local project dir for a Maestro SSH'd into this
					// machine, independent of local SSH remote setup.
					// Uses '_pending_' key when no agent selected, transfers to
					// agent when selected.
					<SshTab
						theme={theme}
						idPrefix="new-agent"
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
				)}
			</div>
		</Modal>
	);
}
