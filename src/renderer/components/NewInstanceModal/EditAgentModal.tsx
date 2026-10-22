import { requestProviderTranslation } from '../../services/providerTranslation';
import type { TranslationPlan } from '../../../shared/maestro-lib/translation/types';
import { limitationsNeedingAcceptance } from '../../../shared/maestro-lib/translation/limitations';
import { getDeclaredTranslationDirection } from '../../../shared/maestro-lib/translation/support';
import { providerOverridesFor } from '../../../shared/maestro-lib/agents/providerSwap';
import { canonicalJson } from '../../../shared/canonicalJson';
import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Info, Copy, Check, X } from 'lucide-react';
import { GhostIconButton } from '../ui/GhostIconButton';
import { isCotExportAvailable } from './AgentCotExportSection';
import { MiniBadge } from '../ui/MiniBadge';
import { Spinner } from '../ui/Spinner';
import { StatCardGrid } from '../widgets';
import { resilienceEnabled } from '../../../shared/agentConstants';
import { getClaudeTokenMode } from '../../../shared/claudeTokenMode';
import { normalizeAdditionalDirectories } from '../../../shared/additionalDirectories';
import { normalizePeerAgents } from '../../../shared/peerAgents';
import { formatCount, formatTokensCompact } from '../../../shared/formatters';
import { getActiveTab } from '../../utils/tabHelpers';
import { useSessionStore, selectSessionById } from '../../stores/sessionStore';
import { useSettingsStore, selectACappellaEnabled } from '../../stores/settingsStore';
import { useModalStore, selectModalData } from '../../stores/modalStore';
import { AgentWakePhraseSection } from '../Settings/ACappella/AgentWakePhraseSection';
import {
	resolveContextWindow,
	isStoredContextWindowOverridden,
} from '../../utils/contextWindowPrecedence';
import type {
	AdditionalDirectory,
	AgentConfig,
	PeerAccess,
	PeerAgent,
	ToolType,
} from '../../types';
import type { SshRemoteConfig, AgentSshRemoteConfig } from '../../../shared/types';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';
import { validateEditSession } from '../../utils/sessionValidation';
import { FormInput } from '../ui/FormInput';
import { Modal, ModalFooter } from '../ui/Modal';
import { ModalTabStrip, useModalTabs } from '../ui/ModalTabStrip';
import { AgentConfigPanel } from '../shared/AgentConfigPanel';
import { agentEnvVarHandlers } from '../shared/agentEnvVarHandlers';
import { useHomeDir } from '../../hooks/utils/useHomeDir';
import { usePeerFleet } from '../../hooks/agent/usePeerFleet';
import { GatewayUrlField } from '../shared/GatewayUrlField';
import { RunOnField } from '../shared/RunOnField';
import { TierTargetsField } from '../shared/TierTargetsField';
import {
	AGENT_FORM_TAB_IDS,
	AgentProviderSelect,
	AUDIT_LOG_TAB_ID,
	AuditLogTab,
	BrowseFolderButton,
	buildAgentSettingsTabs,
	EDIT_AGENT_TAB_IDS,
	ProviderEnvironmentSection,
	firstTabWithError,
	GeneralTab,
	ModelsTab,
	PeersTab,
	ProviderTab,
	sshFolderPickerUnavailableTitle,
	SshTab,
} from '../AgentSettings';
import { AgentSystemOneControl } from './AgentSystemOneControl';
import { AgentTokenProxyModeControl } from './AgentTokenProxyModeControl';
import { parseGatewayUrlEdit } from '../../../shared/local-models/gateway';
import {
	agentRunOnSupport,
	isRunOnSourceTarget,
	parseRunOnEdit,
	parseRunOnTarget,
	RUN_ON_GATEWAY_SKIPPED_REASON,
	type RunOnSourceTarget,
	type RunOnTarget,
} from '../../../shared/local-models/run-on';
import { parseTierTargetsEdit, type TierTargets } from '../../../shared/modelTiers';
import { getEffortConfigKey } from '../../utils/agentEffort';
import { safeClipboardWrite } from '../../utils/clipboard';
import { getAgentDisplayName } from '../../../shared/agentMetadata';
import { useRemotePathValidation } from '../../hooks/agent/useRemotePathValidation';
import { RemotePathStatus } from './RemotePathStatus';
import { SUPPORTED_AGENTS, type EditAgentModalProps } from './types';
import { logger } from '../../utils/logger';
import { isAbsolutePath } from '../../../shared/formatters';
import { isSameDirectory, workingDirectoryChangeBlocker } from '../../utils/agentWorkingDirectory';
import type { CodexTransport } from '../../../shared/codexTransport';

/**
 * EditAgentModal - Modal for editing an existing agent's settings
 *
 * Allows editing the agent's name, provider, working directory (refused while
 * the agent is running), messages, provider settings, and SSH configuration.
 *
 * The form is tabbed (General, Provider, Models, Peers, SSH; see
 * `AgentSettings/`). Every piece of state stays here: the panels only draw it.
 * Only the active panel is rendered, so Tab never walks into a hidden one.
 * The desktop app adds a last tab, Audit Log, which is the exception: it saves
 * itself and none of its state is here.
 */
export function EditAgentModal({
	isOpen,
	onClose,
	onSave,
	theme,
	session,
	existingSessions,
}: EditAgentModalProps) {
	const [instanceName, setInstanceName] = useState('');
	const [workingDir, setWorkingDir] = useState('');
	const [nudgeMessage, setNudgeMessage] = useState('');
	const [newSessionMessage, setNewSessionMessage] = useState('');
	const [additionalDirectories, setAdditionalDirectories] = useState<AdditionalDirectory[]>([]);
	// Peer Agents: the explicit rows, and the group and worktree grants. A grant
	// that is off is `undefined`, never a pair of false bits.
	const [peerAgents, setPeerAgents] = useState<PeerAgent[]>([]);
	const [groupPeerAccess, setGroupPeerAccess] = useState<PeerAccess | undefined>(undefined);
	const [worktreePeerAccess, setWorktreePeerAccess] = useState<PeerAccess | undefined>(undefined);
	const homeDir = useHomeDir();
	const [agent, setAgent] = useState<AgentConfig | null>(null);
	const [agentConfig, setAgentConfig] = useState<Record<string, any>>({});
	/**
	 * The context window the config panel was SEEDED with, so save can tell a
	 * deliberate edit from an untouched round-trip (finding AD1). A ref, not
	 * state: nothing renders from it and it must not retrigger the seeding
	 * effect that writes it.
	 */
	const seededContextWindowRef = useRef<number | undefined>(undefined);
	const [availableModels, setAvailableModels] = useState<string[]>([]);
	const [loadingModels, setLoadingModels] = useState(false);
	const [customPath, setCustomPath] = useState('');
	const [customArgs, setCustomArgs] = useState('');
	const [customEnvVars, setCustomEnvVars] = useState<Record<string, string>>({});
	// Vars the user switched off: listed and editable, never passed to the agent.
	const [customEnvVarsDisabled, setCustomEnvVarsDisabled] = useState<Record<string, string>>({});
	// Local Models gateway URL, and the reason the last save refused it.
	const [gatewayUrl, setGatewayUrl] = useState('');
	const [gatewayUrlError, setGatewayUrlError] = useState<string | undefined>(undefined);
	// Where the agent's model runs, and the reason the last save refused it.
	const [runOn, setRunOn] = useState<RunOnTarget>({ type: 'provider' });
	const [runOnError, setRunOnError] = useState<string | undefined>(undefined);
	// Where each tier launches for this agent, and the reason the last save
	// refused it. A tier the record does not hold follows the harness default.
	const [tierTargets, setTierTargets] = useState<TierTargets>({});
	const [tierTargetsError, setTierTargetsError] = useState<string | undefined>(undefined);
	// What the Auto model choice is judged against besides the provider, as the
	// form holds it: mapping a tier on the Models tab can make Auto offered here.
	const autoModelFor = useMemo(() => ({ tierTargets, runOn }), [tierTargets, runOn]);
	// A save was refused: an empty name now says so instead of blocking silently.
	const [saveAttempted, setSaveAttempted] = useState(false);
	// Tri-state, NOT coerced to a boolean: undefined = never configured (so the
	// SSH default - TUI - applies), false = explicit API, true = explicit
	// maestro-p. Coercing undefined->false here (or false->undefined on save)
	// erases the distinction, and over SSH that silently reverts an explicit API
	// choice to the TUI default (which spawns maestro-p on the remote and exits
	// 127 when it isn't installed there).
	const [enableMaestroP, setEnableMaestroP] = useState<boolean | undefined>(undefined);
	const [maestroPMode, setMaestroPMode] = useState<'interactive' | 'dynamic'>('dynamic');
	const [maestroPPath, setMaestroPPath] = useState('');
	const [detectedMaestroPPath, setDetectedMaestroPPath] = useState<string | undefined>(undefined);
	// Agent Resilience (auto-retry) toggles. Both default ON; read with `?? true`.
	const [retryOnAvailabilityErrors, setRetryOnAvailabilityErrors] = useState(true);
	const [retryOnTokenExhaustion, setRetryOnTokenExhaustion] = useState(true);
	// Codex automatic usage resets. Defaults OFF - see `codexAutoResetOnExhaustion`
	// on Session for why this one does NOT follow the resilience flags' default-on
	// rule: reset credits are finite and irreversible.
	const [codexAutoReset, setCodexAutoReset] = useState(false);
	// Codex transport. `exec` is the default; app-server is an experimental opt-in.
	const [codexTransport, setCodexTransport] = useState<CodexTransport>('exec');
	const [editDynamicOptions, setEditDynamicOptions] = useState<Record<string, string[]>>({});
	const [editLoadingDynamicOptions, setEditLoadingDynamicOptions] = useState(false);
	const [refreshingAgent, setRefreshingAgent] = useState(false);
	const [copiedId, setCopiedId] = useState(false);
	// Provider change state
	const [selectedToolType, setSelectedToolType] = useState<ToolType>(
		session?.toolType ?? 'claude-code'
	);
	// SSH Remote configuration
	const [sshRemotes, setSshRemotes] = useState<SshRemoteConfig[]>([]);
	const [sshRemoteConfig, setSshRemoteConfig] = useState<AgentSshRemoteConfig | undefined>(
		undefined
	);
	const nameInputRef = useRef<HTMLInputElement>(null);
	const copyTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);
	// Agent-level config as loaded, before the session's per-session overrides are
	// merged in for display. Blur-saves of agent-level options rebuild from this so
	// they never write (or erase) the per-session model/contextWindow/effort.
	const globalConfigRef = useRef<Record<string, any>>({});

	// One owner for the voice gate: the same selector the HUD and Voice Setup read.
	const aCappellaEnabled = useSettingsStore(selectACappellaEnabled);

	// The one piece of form state the tabs own. Reopening shows the last tab used.
	// A caller can send the user to one tab (`openAgentSettings(session, { tab })`).
	const requestedTab = useModalStore((state) => selectModalData('editAgent')(state)?.initialTab);
	const translationReview = useModalStore(
		(state) => selectModalData('editAgent')(state)?.translationReview
	);
	// The Audit Log tab exists only where the desktop app offers the feature.
	const tabIds = isCotExportAvailable() ? EDIT_AGENT_TAB_IDS : AGENT_FORM_TAB_IDS;
	const { activeTab, setActiveTab } = useModalTabs({
		tabs: tabIds,
		initialTab: 'general',
		rememberKey: 'edit-agent',
		requestedTab,
		enabled: isOpen,
	});

	// Clear copy timeout and reset copied state on unmount, close, or session change
	useEffect(() => {
		if (!isOpen) {
			if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
			setCopiedId(false);
		}
		return () => {
			if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
		};
	}, [isOpen, session?.id]);

	// Copy session ID to clipboard
	const handleCopySessionId = useCallback(async () => {
		if (!session) return;
		const ok = await safeClipboardWrite(session.id);
		if (ok) {
			if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
			setCopiedId(true);
			copyTimeoutRef.current = setTimeout(() => setCopiedId(false), 2000);
		}
	}, [session]);

	// Track whether provider has been changed from the original
	const providerChanged = session ? selectedToolType !== session.toolType : false;
	const translationDestination = translationReview?.provider ?? selectedToolType;
	/** Live store entry for this agent; the form's session prop is an opening snapshot. */
	const liveSession = useSessionStore(selectSessionById(session?.id ?? ''));
	const [migrationPlan, setMigrationPlan] = useState<TranslationPlan | null>(null);
	const [migrationError, setMigrationError] = useState('');
	const [migrationLoading, setMigrationLoading] = useState(false);
	const [migrationSaving, setMigrationSaving] = useState(false);
	const [acceptTranslationLimitations, setAcceptTranslationLimitations] = useState(false);
	const [projectResourcesIntoRepo, setProjectResourcesIntoRepo] = useState(false);
	// Converting memory and session history is opt-in. Off, a provider change is
	// a plain switch: tabs and transcripts stay, and each tab starts a fresh
	// conversation on the new provider.
	const [convertProviderHistory, setConvertProviderHistory] = useState(false);
	const canConvertProvider =
		providerChanged && !!getDeclaredTranslationDirection(session?.toolType ?? '', selectedToolType);
	const convertingProvider = canConvertProvider && convertProviderHistory;
	const translationRequested = convertingProvider || !!translationReview;
	/** What the incoming provider parked when the agent last left it; the form is seeded from it. */
	const parkedOverrides = useMemo(
		() => (session && providerChanged ? providerOverridesFor(session, selectedToolType) : {}),
		[session, providerChanged, selectedToolType]
	);
	const carryOverBadge = useMemo(
		() => (
			<MiniBadge
				label="Carry Over"
				theme={theme}
				className="inline-flex align-middle whitespace-nowrap"
				style={{ textTransform: 'none', borderRadius: '9999px' }}
			/>
		),
		[theme]
	);
	const providerOptions = useMemo(
		() =>
			SUPPORTED_AGENTS.map((provider) => ({
				value: provider,
				label: getAgentDisplayName(provider),
				rightContent: getDeclaredTranslationDirection(session?.toolType ?? '', provider)
					? carryOverBadge
					: undefined,
			})),
		[session?.toolType, carryOverBadge]
	);
	const currentMigration = (liveSession ?? session)?.providerMigration;
	const migrationState =
		currentMigration?.operationId === migrationPlan?.id
			? currentMigration?.state
			: migrationPlan?.status;
	const migrationNotices = useMemo(
		() => [
			...new Map(
				(migrationLoading ? [] : (migrationPlan?.limitations ?? []))
					.filter((limit) => limit.severity !== 'info')
					.map((limit) => [`${limit.severity}:${limit.code}:${limit.message}`, limit])
			).values(),
		],
		[migrationPlan, migrationLoading]
	);
	const needsTranslationAcceptance =
		!!migrationPlan &&
		!migrationLoading &&
		migrationPlan.status !== 'blocked' &&
		limitationsNeedingAcceptance(migrationPlan.limitations).length > 0;
	const migrationActivity = migrationSaving
		? migrationState === 'deferred'
			? 'Waiting for the current turn to finish...'
			: migrationState === 'staged' || migrationState === 'committing'
				? 'Finishing provider switch...'
				: 'Translating memory and session history...'
		: migrationLoading
			? 'Reading memory and session history...'
			: null;
	useEffect(() => {
		if (!isOpen || !session || !translationRequested) {
			setMigrationPlan(null);
			setMigrationError('');
			setMigrationLoading(false);
			return;
		}
		let disposed = false;
		setMigrationLoading(true);
		setMigrationPlan(null);
		setAcceptTranslationLimitations(false);
		setMigrationError('');
		void requestProviderTranslation({
			agentId: session.id,
			destination: translationDestination,
			tabId: translationReview?.tabId,
			action: 'plan',
			projectResourcesIntoRepo,
			selectedUserResources: [],
		})
			.then((report) => {
				if (disposed) return;
				setMigrationPlan(report.plan ?? null);
				setMigrationError(report.error ?? '');
				setMigrationLoading(false);
			})
			.catch((error) => {
				if (disposed) return;
				setMigrationPlan(null);
				setMigrationError(error instanceof Error ? error.message : String(error));
				setMigrationLoading(false);
			});
		return () => {
			disposed = true;
		};
	}, [
		isOpen,
		session?.id,
		translationRequested,
		translationDestination,
		translationReview?.tabId,
		projectResourcesIntoRepo,
	]);

	// Resolve the auto-detected maestro-p path so the Batch Mode toggle can show
	// it as helper text in the path-override input.
	useEffect(() => {
		void window.maestro.agents
			.getMaestroPDetectedPath()
			.then((p) => setDetectedMaestroPPath(p ?? undefined))
			.catch(() => setDetectedMaestroPPath(undefined));
	}, []);

	// Load agent info, config, custom settings, and models when modal opens or provider changes
	useEffect(() => {
		if (!isOpen || !session) return;

		let stale = false;
		const activeToolType = selectedToolType;
		const isProviderSwitch = activeToolType !== session.toolType;
		// On a provider switch the form edits what the incoming provider parked
		// when the agent last left it (blank if it never ran there), so saving
		// keeps the configuration a switch back would restore.
		const overrides = isProviderSwitch ? providerOverridesFor(session, activeToolType) : session;

		// Load agent definition (for configOptions) and the agent-level config together:
		// seeding the config panel needs the agent's effort key, which only the
		// definition knows, so resolving them in two independent chains would race.
		Promise.all([
			window.maestro.agents.detect(),
			window.maestro.agents.getConfig(activeToolType).catch((err) => {
				logger.error('Failed to load agent config:', undefined, err);
				return {} as Record<string, any>;
			}),
		])
			.then(([agents, globalConfig]: [AgentConfig[], Record<string, any>]) => {
				if (stale) return;
				const foundAgent = agents.find((a) => a.id === activeToolType);
				setAgent(foundAgent || null);

				// Load models if agent supports model selection
				if (foundAgent?.capabilities?.supportsModelSelection) {
					setLoadingModels(true);
					window.maestro.agents
						.getModels(activeToolType)
						.then((models) => {
							if (!stale) setAvailableModels(models);
						})
						.catch((err) => logger.error('Failed to load models:', undefined, err))
						.finally(() => {
							if (!stale) setLoadingModels(false);
						});
				} else {
					setAvailableModels([]);
				}

				// Load dynamic config options
				const dynamicSelects = foundAgent?.configOptions?.filter(
					(opt: any) => opt.type === 'select' && opt.dynamic
				);
				if (dynamicSelects && dynamicSelects.length > 0) {
					setEditLoadingDynamicOptions(true);
					Promise.all(
						dynamicSelects.map(async (opt: any) => {
							try {
								return {
									key: opt.key,
									options: await window.maestro.agents.getConfigOptions(activeToolType, opt.key),
								};
							} catch {
								return { key: opt.key, options: [] as string[] };
							}
						})
					)
						.then((results) => {
							if (stale) return;
							const opts: Record<string, string[]> = {};
							for (const r of results) opts[r.key] = r.options;
							setEditDynamicOptions(opts);
						})
						.finally(() => {
							if (!stale) setEditLoadingDynamicOptions(false);
						});
				} else {
					setEditDynamicOptions({});
				}

				// Keep the pristine agent-level config so blur-saves of agent-level
				// options can be written back without dropping the values this modal
				// manages per-session (agents:setConfig replaces the whole object).
				globalConfigRef.current = globalConfig;

				// Seed the panel from the agent-level config, then let the session's own
				// overrides win. Model, contextWindow and effort are per-session: showing
				// the agent-level effort here while the session override silently drove
				// the spawn is what made "Effort: high" run at max.
				// Empty string means explicitly cleared, undefined means never set (use agent-level default)
				const effortKey = getEffortConfigKey(foundAgent);
				const modelValue =
					overrides.customModel !== undefined ? overrides.customModel : (globalConfig.model ?? '');
				const contextWindowValue = overrides.customContextWindow ?? globalConfig.contextWindow;
				// Remember what the control was SEEDED with so save can tell an
				// actual edit from an untouched round-trip. Seeding from
				// `globalConfig.contextWindow` when the session has no override is
				// exactly how the agent-level default gets materialized into a
				// per-session value just by opening this modal and pressing Save
				// (finding P1); without this the write would be indistinguishable
				// from a deliberate choice (finding AD1).
				seededContextWindowRef.current = contextWindowValue;
				const effortValue =
					overrides.customEffort !== undefined
						? overrides.customEffort
						: (globalConfig[effortKey] ?? '');
				setAgentConfig({
					...globalConfig,
					model: modelValue,
					contextWindow: contextWindowValue,
					[effortKey]: effortValue,
				});
			})
			.catch((err) => {
				logger.error('Failed to detect agents:', undefined, err);
				if (!stale) {
					setAgent(null);
					setAvailableModels([]);
					setLoadingModels(false);
				}
			});

		// Load SSH remote config from session (per-session, not global).
		// Always surface the `shareHistoryToProjectDir` flag even when SSH is
		// disabled, so the checkbox can stay toggled on for locally-executed
		// agents that are controlled by another Maestro instance over SSH.
		const persisted = session.sessionSshRemoteConfig;
		if (persisted?.enabled && persisted.remoteId) {
			setSshRemoteConfig({
				enabled: true,
				remoteId: persisted.remoteId,
				workingDirOverride: persisted.workingDirOverride,
				syncHistory: persisted.syncHistory,
				shareHistoryToProjectDir: persisted.shareHistoryToProjectDir,
			});
		} else if (persisted?.shareHistoryToProjectDir) {
			setSshRemoteConfig({
				enabled: false,
				remoteId: null,
				shareHistoryToProjectDir: true,
			});
		} else {
			setSshRemoteConfig(undefined);
		}

		// Load SSH remote configurations
		window.maestro.sshRemote
			.getConfigs()
			.then((result) => {
				if (stale) return;
				if (result.success && result.configs) {
					setSshRemotes(result.configs);
				}
			})
			.catch((err) => logger.error('Failed to load SSH remotes:', undefined, err));

		// Load per-session config (stored on the session/agent instance). The
		// provider-specific overrides come from `overrides` above.
		setCustomPath(overrides.customPath ?? '');
		setCustomArgs(overrides.customArgs ?? '');
		setCustomEnvVars(overrides.customEnvVars ?? {});
		setCustomEnvVarsDisabled(overrides.customEnvVarsDisabled ?? {});
		// Preserve the tri-state (undefined stays undefined) so an unconfigured
		// SSH agent keeps its "unset" signal instead of looking like explicit API.
		setEnableMaestroP(overrides.enableMaestroP);
		setMaestroPMode(overrides.maestroPMode ?? 'dynamic');
		setMaestroPPath(overrides.maestroPPath ?? '');
		// Provider-agnostic: a switch keeps them. Both default ON; `undefined`
		// (never configured) reads as enabled.
		setRetryOnAvailabilityErrors(resilienceEnabled(session.retryOnAvailabilityErrors));
		setRetryOnTokenExhaustion(resilienceEnabled(session.retryOnTokenExhaustion));
		setCodexAutoReset(session.codexAutoResetOnExhaustion === true);
		// Read the stored value, not `resolveCodexTransport`: that answers `exec`
		// for a non-Codex agent, and saving it back would erase the preference
		// of an agent that was moved off Codex and may move back.
		setCodexTransport(session.codexTransport === 'app-server' ? 'app-server' : 'exec');
		setGatewayUrl(isProviderSwitch ? '' : (session.gatewayUrl ?? ''));
		const storedRunOn = parseRunOnTarget(session.runOn);
		setRunOn(
			storedRunOn.ok && agentRunOnSupport(activeToolType).supported
				? storedRunOn.target
				: { type: 'provider' }
		);
		setRunOnError(
			storedRunOn.ok
				? undefined
				: `The stored Run on target cannot be used: ${storedRunOn.error} Saving sets it to what is chosen here.`
		);
		setTierTargets(isProviderSwitch ? {} : { ...session.tierTargets });
		setTierTargetsError(undefined);

		return () => {
			stale = true;
		};
	}, [isOpen, session, selectedToolType]);

	// Populate form when session changes or modal opens
	useEffect(() => {
		if (isOpen && session) {
			setInstanceName(session.name);
			setSaveAttempted(false);
			setWorkingDir(session.projectRoot);
			setNudgeMessage(session.nudgeMessage || '');
			setNewSessionMessage(session.newSessionMessage || '');
			// Clone the grants so editing a row doesn't mutate the persisted array
			// in the session store before the user hits Save.
			setAdditionalDirectories((session.additionalDirectories ?? []).map((d) => ({ ...d })));
			// The same for the peer rows and the two grants.
			setPeerAgents((session.peerAgents ?? []).map((peer) => ({ ...peer })));
			setGroupPeerAccess(session.groupPeerAccess && { ...session.groupPeerAccess });
			setWorktreePeerAccess(session.worktreePeerAccess && { ...session.worktreePeerAccess });
			// Only reset if different to avoid re-triggering the config loading effect
			setSelectedToolType((prev) => (prev === session.toolType ? prev : session.toolType));
			setProjectResourcesIntoRepo(false);
			setAcceptTranslationLimitations(false);
			setConvertProviderHistory(false);
		}
	}, [isOpen, session?.id]);

	// Validate session name uniqueness (excluding current session)
	const validation = useMemo(() => {
		const name = instanceName.trim();
		if (!name || !session) {
			return { valid: true }; // Don't show errors until fields are filled
		}
		return validateEditSession(name, session.id, existingSessions);
	}, [instanceName, session, existingSessions]);

	// Check if SSH remote is enabled
	const isSshEnabled = useMemo(() => {
		return sshRemoteConfig?.enabled && !!sshRemoteConfig?.remoteId;
	}, [sshRemoteConfig]);

	// Get SSH remote host for display
	const sshRemoteHost = useMemo(() => {
		if (!isSshEnabled) return undefined;
		const remoteId = sshRemoteConfig?.remoteId;
		if (!remoteId) return undefined;
		const remote = sshRemotes.find((r) => r.id === remoteId);
		return remote?.host;
	}, [isSshEnabled, sshRemoteConfig?.remoteId, sshRemotes]);

	// The remote's name, for the gateway field and the "Runs on" chip. The id
	// stands in until the remotes load: both must know the agent is remote.
	const sshRemoteName = useMemo(() => {
		if (!isSshEnabled) return undefined;
		const remoteId = sshRemoteConfig?.remoteId ?? undefined;
		return sshRemotes.find((r) => r.id === remoteId)?.name ?? remoteId;
	}, [isSshEnabled, sshRemoteConfig?.remoteId, sshRemotes]);

	const trimmedWorkingDir = workingDir.trim();
	// Compared as directories, so a trailing slash is not a move.
	const workingDirChanged =
		!!session &&
		trimmedWorkingDir !== '' &&
		!isSameDirectory(trimmedWorkingDir, session.projectRoot);
	const workingDirBlocker = session ? workingDirectoryChangeBlocker(session) : null;
	// A local path is typed as well as picked, so it is checked for shape here
	// and for existence below. A remote path may start with `~`, which only the
	// remote shell can expand, so its shape is left to the remote check.
	const localWorkingDirRelative =
		workingDirChanged && !isSshEnabled && !isAbsolutePath(trimmedWorkingDir);

	// Validate the path (debounced): on the remote when SSH is enabled, locally
	// when a new local directory was typed. Prefer a newly entered directory,
	// then workingDirOverride (user-specified remote path), then session.projectRoot.
	const remotePathValidation = useRemotePathValidation({
		isSshEnabled: !!isSshEnabled,
		validateLocal: workingDirChanged && !isSshEnabled && !localWorkingDirRelative,
		path: workingDirChanged
			? trimmedWorkingDir
			: (sshRemoteConfig?.workingDirOverride ?? session?.projectRoot ?? ''),
		sshRemoteId: sshRemoteConfig?.remoteId,
	});
	// A NEW directory must be confirmed to exist before it is saved: it becomes
	// the spawn cwd, and a typo would strand every later launch. The existing
	// path is not gated, so an agent whose remote is offline can still have its
	// other settings edited.
	const newWorkingDirUnverified =
		workingDirChanged && (remotePathValidation.checking || !remotePathValidation.isDirectory);

	const workingDirError = useMemo(() => {
		if (!session) return undefined;
		if (!trimmedWorkingDir) return 'Working directory is required';
		if (localWorkingDirRelative) return 'Enter an absolute path';
		// The SSH status line below the field reports remote failures.
		if (workingDirChanged && !isSshEnabled && remotePathValidation.error) {
			return remotePathValidation.error;
		}
		return undefined;
	}, [
		session,
		trimmedWorkingDir,
		localWorkingDirRelative,
		workingDirChanged,
		isSshEnabled,
		remotePathValidation.error,
	]);

	const handleSelectFolder = useCallback(async () => {
		const folder = await window.maestro.dialog.selectFolder();
		if (folder) setWorkingDir(folder);
	}, []);

	// What the Peers tab draws from besides the form: the live fleet and the
	// group this agent is in right now. This form does not edit the group, so the
	// live entry is the truth and the opening snapshot is the fallback.
	const peerGroupId = (liveSession ?? session)?.groupId;
	const peerFleet = usePeerFleet(peerGroupId);
	/**
	 * Advisory note for the context-window control when the stored value is NOT
	 * the one in use (#1370, following finding AD1).
	 *
	 * Only this surface can compute it: the decision needs the session AND its
	 * live usage stats, which `AgentConfigPanel` does not receive. The ranking
	 * itself is deliberately NOT re-derived here - `resolveContextWindow` is the
	 * same helper the header gauge resolves through, so the note and the gauge
	 * cannot disagree about which window won.
	 */
	const configOptionNotes = useMemo(() => {
		// The `session` prop is a snapshot taken when the modal opened
		// (`openModal('editAgent', { session })`), which is right for the form
		// fields - they must not change under someone mid-edit. The note describes
		// what the gauge is doing RIGHT NOW though, and a turn completing while
		// this is open changes that, so it reads the live store entry instead
		// (review of #1371).
		const current = liveSession ?? session;
		if (!current) return undefined;
		// Mid provider switch the panel already shows the NEW provider's config
		// while this would still describe the OLD provider's window, captioning
		// the wrong control. The switch clears the stored window anyway.
		if (providerChanged) return undefined;
		const activeTab = getActiveTab(current);
		const resolved = resolveContextWindow({
			customModel: current.customModel,
			customContextWindow: current.customContextWindow,
			contextWindowSource: current.contextWindowSource,
			reportedWindow: activeTab?.usageStats?.contextWindow,
			reportedResolved: activeTab?.usageStats?.contextWindowResolved,
			// Deliberately omitted: the agent-level configured window ranks BELOW
			// the stored value, so it can never be what overrides it. Leaving it
			// out keeps this from waiting on the async lookup the panel does not do.
		});
		// Nothing stored means nothing to override, and a value that won needs no
		// explaining.
		if (!current.customContextWindow || !isStoredContextWindowOverridden(resolved)) {
			return undefined;
		}
		const winner =
			resolved.source === 'model-marker'
				? `the selected model (${formatTokensCompact(resolved.window)})`
				: `the provider, which reports ${formatTokensCompact(resolved.window)}`;
		return {
			contextWindow: `Currently overridden by ${winner}. Edit this field to use your own value instead.`,
		};
	}, [liveSession, session, providerChanged]);

	// The opted-in conversion was refused or failed. Saving is never blocked on
	// it: the notice says so, and the save switches providers without converting.
	const conversionFailed =
		convertingProvider &&
		!migrationLoading &&
		!migrationSaving &&
		(!!migrationError || migrationPlan?.status === 'blocked');
	const conversionRunnable =
		convertingProvider &&
		!!migrationPlan &&
		migrationPlan.status !== 'blocked' &&
		!migrationError &&
		!migrationLoading;

	const handleSave = useCallback(async () => {
		if (!session || migrationSaving) return;
		if (
			(!!translationReview || conversionRunnable) &&
			(!migrationPlan ||
				migrationLoading ||
				migrationPlan.status === 'blocked' ||
				(limitationsNeedingAcceptance(migrationPlan.limitations).length > 0 &&
					!acceptTranslationLimitations))
		)
			return;
		if (translationReview && migrationPlan) {
			setMigrationSaving(true);
			try {
				const report = await requestProviderTranslation(
					{
						agentId: session.id,
						tabId: translationReview.tabId,
						destination: translationReview.provider,
						action: 'apply',
						planId: migrationPlan.id,
						acceptLimitations: acceptTranslationLimitations,
						projectResourcesIntoRepo,
						selectedUserResources: [],
					},
					{ waitForDeferred: true }
				);
				if (!report.success)
					throw new Error(report.error ?? report.result?.error ?? 'Context translation failed');
				onClose();
			} catch (error) {
				setMigrationError(error instanceof Error ? error.message : String(error));
			} finally {
				setMigrationSaving(false);
			}
			return;
		}

		if (translationRequested && migrationLoading) return;
		const converting = conversionRunnable;
		const name = instanceName.trim();
		if (!name) return;

		// Validate before saving
		const result = validateEditSession(name, session.id, existingSessions);
		if (!result.valid || workingDirError || newWorkingDirUnverified) return;

		// A gateway the launch would refuse is refused here instead, where the
		// user can still fix it. Blank clears the gateway.
		const gatewayEdit = parseGatewayUrlEdit(selectedToolType, gatewayUrl);
		if (!gatewayEdit.ok) {
			setGatewayUrlError(gatewayEdit.error);
			setActiveTab('models');
			return;
		}

		// The Run on target goes through the validator every writer shares, so
		// nothing is stored that the launch would refuse as malformed.
		const runOnEdit = parseRunOnEdit(selectedToolType, runOn);
		if (!runOnEdit.ok) {
			setRunOnError(runOnEdit.error);
			setActiveTab('models');
			return;
		}

		// The tiers go through the check every tier writer shares, so a target a
		// launch would refuse is refused here, with the tier named.
		const tiersEdit = parseTierTargetsEdit(selectedToolType, tierTargets);
		if (!tiersEdit.ok) {
			setTierTargetsError(tiersEdit.error);
			setActiveTab('models');
			return;
		}

		// Get model, contextWindow and effort from agentConfig (updated via onConfigChange).
		// Pass empty string to explicitly clear (distinguishes from undefined = never set)
		const modelValue = agentConfig.model?.trim() ?? undefined;
		const contextWindowValue =
			typeof agentConfig.contextWindow === 'number' && agentConfig.contextWindow > 0
				? agentConfig.contextWindow
				: undefined;
		// Provenance for that number (finding AD1). Only a value the user actually
		// moved off the seed counts as intent; an untouched round-trip keeps
		// whatever provenance the session already had, which for everything stored
		// before AD1 is none - so P1's "provider report wins" stands for it.
		const contextWindowSource =
			contextWindowValue === undefined
				? // Clearing the control clears the value, so its provenance goes with
					// it - keeping a stale 'user-edited' would let the NEXT value
					// inherit precedence nobody asked for.
					undefined
				: contextWindowValue !== seededContextWindowRef.current
					? ('user-edited' as const)
					: providerChanged
						? parkedOverrides.contextWindowSource
						: session.contextWindowSource;
		const effortValue = agentConfig[getEffortConfigKey(agent)]?.trim() ?? undefined;

		// Build per-session SSH remote config: ALWAYS pass explicitly to override any agent-level config.
		// When disabled or no remoteId, we explicitly pass enabled: false to ensure local execution.
		// `shareHistoryToProjectDir` is preserved independently of SSH enablement so a
		// locally-executed agent can still be flagged as remote-controlled.
		const sessionSshRemoteConfig =
			sshRemoteConfig?.enabled && sshRemoteConfig?.remoteId
				? {
						enabled: true,
						remoteId: sshRemoteConfig.remoteId,
						// Ensure workingDirOverride is set: a newly entered directory wins, then
						// the explicit override, then session's projectRoot (which is the remote
						// path the user originally configured).
						workingDirOverride: workingDirChanged
							? trimmedWorkingDir
							: sshRemoteConfig.workingDirOverride || session?.projectRoot || undefined,
						syncHistory: sshRemoteConfig.syncHistory,
						shareHistoryToProjectDir: sshRemoteConfig.shareHistoryToProjectDir,
					}
				: {
						enabled: false,
						remoteId: null,
						shareHistoryToProjectDir: sshRemoteConfig?.shareHistoryToProjectDir,
					};

		const formCustomPath = customPath.trim() || undefined;
		const formCustomArgs = customArgs.trim() || undefined;
		const formCustomEnvVars = Object.keys(customEnvVars).length > 0 ? customEnvVars : undefined;
		// A conversion owns the binary, arguments and account environment, so
		// only a value the user actually changed from the parked seed is sent
		// (and refused by the save, which asks for it in a separate edit).
		const editedFromParked = <T,>(value: T | undefined, parked: T | undefined) =>
			converting && canonicalJson(value ?? null) === canonicalJson(parked ?? null)
				? undefined
				: value;

		// Save with per-session config fields including model, contextWindow, and SSH config
		setMigrationSaving(true);
		setMigrationError('');
		try {
			const saveArguments: Parameters<typeof onSave> = [
				session.id,
				name,
				providerChanged ? selectedToolType : undefined,
				nudgeMessage.trim() || undefined,
				newSessionMessage.trim() || undefined,
				editedFromParked(formCustomPath, parkedOverrides.customPath),
				editedFromParked(formCustomArgs, parkedOverrides.customArgs),
				editedFromParked(formCustomEnvVars, parkedOverrides.customEnvVars),
				modelValue,
				effortValue,
				contextWindowValue,
				sessionSshRemoteConfig,
				// Preserve the explicit tri-state: an explicit `false` (API) must NOT
				// collapse to `undefined`, or over SSH it reverts to the TUI default.
				enableMaestroP,
				enableMaestroP && maestroPPath.trim() ? maestroPPath.trim() : undefined,
				enableMaestroP ? maestroPMode : undefined,
				retryOnAvailabilityErrors,
				retryOnTokenExhaustion,
				normalizeAdditionalDirectories(additionalDirectories, homeDir),
				contextWindowSource,
				Object.keys(customEnvVarsDisabled).length > 0 ? customEnvVarsDisabled : undefined,
				workingDirChanged ? trimmedWorkingDir : undefined,
				codexAutoReset,
				codexTransport,
				gatewayEdit.gatewayUrl ?? undefined,
				// Provider is the absence of a target on the agent record.
				runOnEdit.target,
				// No tier set is the absence of the field: every tier follows its harness default.
				tiersEdit.tierTargets,
				// A row with neither square lit is kept: it is an exclusion.
				{
					peerAgents: normalizePeerAgents(peerAgents),
					groupPeerAccess,
					worktreePeerAccess,
				},
			];
			if (converting) {
				saveArguments[27] = acceptTranslationLimitations;
				saveArguments[28] = [];
				saveArguments[29] = migrationPlan?.id;
				saveArguments[30] = projectResourcesIntoRepo;
				saveArguments[31] = true;
			}
			const saved = onSave(...saveArguments);
			if (saved) await saved;
			onClose();
		} catch (error) {
			setMigrationError(error instanceof Error ? error.message : String(error));
		} finally {
			setMigrationSaving(false);
		}
	}, [
		translationReview,
		translationRequested,
		migrationSaving,
		convertingProvider,
		conversionRunnable,
		parkedOverrides,
		migrationPlan,
		migrationLoading,
		acceptTranslationLimitations,
		projectResourcesIntoRepo,
		session,
		instanceName,
		workingDirChanged,
		trimmedWorkingDir,
		workingDirError,
		newWorkingDirUnverified,
		nudgeMessage,
		newSessionMessage,
		additionalDirectories,
		homeDir,
		peerAgents,
		groupPeerAccess,
		worktreePeerAccess,
		customPath,
		customArgs,
		customEnvVars,
		customEnvVarsDisabled,
		gatewayUrl,
		runOn,
		tierTargets,
		enableMaestroP,
		maestroPMode,
		maestroPPath,
		retryOnAvailabilityErrors,
		retryOnTokenExhaustion,
		codexAutoReset,
		codexTransport,
		agent,
		agentConfig,
		sshRemoteConfig,
		selectedToolType,
		providerChanged,
		onSave,
		onClose,
		existingSessions,
		setActiveTab,
	]);

	// Refresh available models
	const refreshModels = useCallback(async () => {
		if (!agent?.capabilities?.supportsModelSelection) return;
		setLoadingModels(true);
		try {
			const models = await window.maestro.agents.getModels(selectedToolType, true);
			setAvailableModels(models);
		} catch (err) {
			logger.error('Failed to refresh models:', undefined, err);
		} finally {
			setLoadingModels(false);
		}
	}, [selectedToolType, agent]);

	// Refresh agent detection
	const handleRefreshAgent = useCallback(async () => {
		setRefreshingAgent(true);
		try {
			const result = await window.maestro.agents.refresh(selectedToolType);
			const foundAgent = result.agents.find((a: AgentConfig) => a.id === selectedToolType);
			setAgent(foundAgent || null);
		} catch (error) {
			logger.error('Failed to refresh agent:', undefined, error);
		} finally {
			setRefreshingAgent(false);
		}
	}, [selectedToolType]);

	// Check if form is valid for submission
	const isFormValid = useMemo(() => {
		// Path validation only blocks a NEW directory (newWorkingDirUnverified).
		// The existing path stays informational so an agent whose remote is offline
		// can still be edited.
		return (
			!!instanceName.trim() &&
			validation.valid &&
			!workingDirError &&
			!newWorkingDirUnverified &&
			!migrationSaving &&
			(!translationRequested ||
				(!translationReview && conversionFailed) ||
				(!!migrationPlan &&
					!migrationLoading &&
					migrationPlan.status !== 'blocked' &&
					(limitationsNeedingAcceptance(migrationPlan.limitations).length === 0 ||
						acceptTranslationLimitations)))
		);
	}, [
		instanceName,
		validation.valid,
		workingDirError,
		newWorkingDirUnverified,
		migrationSaving,
		translationRequested,
		translationReview,
		conversionFailed,
		migrationPlan,
		migrationLoading,
		acceptTranslationLimitations,
	]);

	// The message under the name. An empty name only says so once a save was
	// refused, so clearing the field to retype it is not drawn in red.
	const nameError =
		validation.errorField === 'name'
			? validation.error
			: saveAttempted && !instanceName.trim()
				? 'Enter a name for the agent'
				: undefined;

	// Fields showing an error message: each puts a dot on its tab.
	const errorFields = useMemo(() => {
		const fields: string[] = [];
		if (nameError) fields.push('name');
		if (!validation.valid && validation.errorField && validation.errorField !== 'name') {
			fields.push(validation.errorField);
		}
		if (workingDirError) fields.push('workingDir');
		if (gatewayUrlError) fields.push('gatewayUrl');
		if (runOnError) fields.push('runOn');
		if (tierTargetsError) fields.push('tierTargets');
		return fields;
	}, [
		nameError,
		validation.valid,
		validation.errorField,
		workingDirError,
		gatewayUrlError,
		runOnError,
		tierTargetsError,
	]);
	const tabs = useMemo(() => buildAgentSettingsTabs(tabIds, errorFields), [tabIds, errorFields]);

	// A save attempt that cannot save goes to the field that blocks it, so a
	// user on another tab is not left facing a dead Save. An unverified new
	// directory blocks without a message, so it counts here too.
	const showFirstBlockingField = useCallback(() => {
		setSaveAttempted(true);
		const blocking = [...errorFields];
		if (!instanceName.trim()) blocking.push('name');
		if (newWorkingDirUnverified) blocking.push('workingDir');
		const tab = firstTabWithError(blocking, tabIds);
		if (tab) setActiveTab(tab);
	}, [errorFields, instanceName, newWorkingDirUnverified, setActiveTab, tabIds]);

	// Handle keyboard shortcuts via window listener (Modal stops propagation on its backdrop)
	useEffect(() => {
		if (!isOpen) return;
		const handler = (e: KeyboardEvent) => {
			if ((e.metaKey || e.ctrlKey) && (e.key === 'Enter' || e.key === 's') && !e.shiftKey) {
				e.preventDefault();
				if (isFormValid) {
					handleSave();
				} else {
					showFirstBlockingField();
				}
			}
		};
		window.addEventListener('keydown', handler, true);
		return () => window.removeEventListener('keydown', handler, true);
	}, [isOpen, isFormValid, handleSave, showFirstBlockingField]);

	// The live agent's gateway after the proxy mode control stored one.
	const handleProxyGatewayUrl = useCallback((next: string) => {
		setGatewayUrl(next);
		setGatewayUrlError(undefined);
	}, []);

	// One test turn on the target the picker shows, launched with the form as
	// it stands: a provider, path, variable or remote that is not saved yet is
	// what the next turn would use once it is.
	const handleTestRunOn = useCallback(
		(target: RunOnSourceTarget) => {
			if (!session) throw new Error('No agent to test.');
			return window.maestro.localModels.runOn.test({
				agentId: session.id,
				target,
				subject: {
					toolType: selectedToolType,
					cwd:
						(workingDirChanged ? trimmedWorkingDir : undefined) ||
						(isSshEnabled ? sshRemoteConfig?.workingDirOverride : undefined) ||
						session.projectRoot,
					customPath: customPath.trim() || undefined,
					customArgs: customArgs.trim() || undefined,
					customEnvVars,
					sshRemoteConfig:
						isSshEnabled && sshRemoteConfig?.remoteId
							? {
									enabled: true,
									remoteId: sshRemoteConfig.remoteId,
									workingDirOverride: sshRemoteConfig.workingDirOverride,
								}
							: { enabled: false, remoteId: null },
				},
			});
		},
		[
			session,
			selectedToolType,
			workingDirChanged,
			trimmedWorkingDir,
			isSshEnabled,
			sshRemoteConfig,
			customPath,
			customArgs,
			customEnvVars,
		]
	);

	// Shared by the Provider tab's config panel (which hides them) and the
	// Provider environment section: one set of handlers over two records.
	const envVarProps = agentEnvVarHandlers({
		customEnvVars,
		customEnvVarsDisabled,
		setCustomEnvVars,
		setCustomEnvVarsDisabled,
	});

	if (!isOpen || !session) return null;

	const agentName = getAgentDisplayName(selectedToolType);
	// Whether a turn of this agent can run through the claude TUI, as the form
	// stands now. Dynamic counts: it starts on the TUI and leaves it only near a
	// limit. Read through the one resolver every spawn uses, so an SSH agent
	// that was never configured (TUI by default) is answered the same way here.
	const usesInteractiveTokenSource =
		selectedToolType === 'claude-code' &&
		getClaudeTokenMode({ enableMaestroP, maestroPMode }, { sshEnabled: !!isSshEnabled }) !== 'api';
	// The agent's own vars replace the provider-level set, so the provider-level
	// set only counts when the agent has none.
	const effectiveEnvVars =
		Object.keys(customEnvVars).length > 0
			? customEnvVars
			: (globalConfigRef.current.customEnvVars as Record<string, string> | undefined);
	// A Run on target takes the gateway's place: both gateway controls say so.
	const gatewaySkippedReason = isRunOnSourceTarget(runOn)
		? RUN_ON_GATEWAY_SKIPPED_REASON
		: undefined;

	return (
		<Modal
			theme={theme}
			title={`Edit Agent: ${session.name}`}
			priority={MODAL_PRIORITIES.NEW_INSTANCE}
			onClose={onClose}
			resizable
			resizeKey="edit-agent"
			// Wider than New Agent's 720: the strip here can hold a seventh tab.
			defaultSize={{ width: 820, height: 640 }}
			minSize={{ width: 560, height: 420 }}
			contentClassName="flex flex-col flex-1 min-h-0"
			initialFocusRef={nameInputRef}
			customHeader={
				<div
					className="p-4 border-b flex items-center justify-between shrink-0"
					style={{ borderColor: theme.colors.border }}
				>
					<h2 className="text-sm font-bold" style={{ color: theme.colors.textMain }}>
						Edit Agent: {session.name}
					</h2>
					<div className="flex items-center gap-2">
						<button
							type="button"
							onClick={handleCopySessionId}
							className="flex items-center gap-1 px-2 py-0.5 rounded-full text-2xs font-mono font-bold uppercase transition-colors hover:opacity-80"
							style={{
								backgroundColor: copiedId
									? theme.colors.success + '20'
									: theme.colors.accent + '20',
								color: copiedId ? theme.colors.success : theme.colors.accent,
								border: `1px solid ${copiedId ? theme.colors.success : theme.colors.accent}40`,
							}}
							title={copiedId ? 'Copied!' : `Click to copy: ${session.id}`}
						>
							{copiedId ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
							<span>{session.id.slice(0, 8)}</span>
						</button>
						<GhostIconButton onClick={onClose} ariaLabel="Close modal" color={theme.colors.textDim}>
							<X className="w-4 h-4" />
						</GhostIconButton>
					</div>
				</div>
			}
			footer={
				<>
					{translationRequested && !migrationSaving && (
						<div className="mr-auto text-xs" style={{ color: theme.colors.textDim }}>
							{needsTranslationAcceptance ? (
								<label className="flex items-center gap-2">
									<input
										type="checkbox"
										checked={acceptTranslationLimitations}
										onChange={(e) => setAcceptTranslationLimitations(e.target.checked)}
									/>
									Accept the listed conversion limitations
								</label>
							) : migrationLoading ? (
								'Checking carry-over…'
							) : conversionFailed ? (
								'Saving switches without converting.'
							) : migrationError || migrationPlan?.status === 'blocked' ? (
								'Provider switch blocked. Review the Provider tab.'
							) : null}
						</div>
					)}
					<ModalFooter
						theme={theme}
						onCancel={onClose}
						onConfirm={handleSave}
						confirmLabel={
							migrationSaving
								? migrationState === 'deferred'
									? 'Waiting for current turn'
									: 'Translating provider'
								: 'Save Changes'
						}
						confirmDisabled={!isFormValid}
					/>
				</>
			}
		>
			<ModalTabStrip
				theme={theme}
				tabs={tabs}
				activeTab={activeTab}
				onChange={setActiveTab}
				label="Agent settings"
				idPrefix="edit-agent"
				className="px-6 pt-4"
			/>
			<div className="flex-1 min-h-0 overflow-y-auto p-6" data-testid="edit-agent-tab-body">
				{activeTab === 'general' && (
					<GeneralTab
						theme={theme}
						idPrefix="edit-agent"
						name={instanceName}
						onNameChange={setInstanceName}
						nameError={nameError}
						nameInputRef={nameInputRef}
						nameInputId="edit-agent-name-input"
						workingDirectory={
							<FormInput
								id="edit-agent-working-dir-input"
								theme={theme}
								label="Working Directory"
								value={workingDir}
								onChange={setWorkingDir}
								placeholder={
									isSshEnabled
										? `Enter remote path${sshRemoteHost ? ` on ${sshRemoteHost}` : ''} (e.g., /home/user/project)`
										: 'Select directory...'
								}
								error={workingDirError}
								helperText={
									workingDirBlocker ??
									(workingDirChanged
										? 'On save, the Files panel, Auto Run folder, and git follow the new directory. Conversations the provider stored under the old path may not resume.'
										: undefined)
								}
								disabled={!!workingDirBlocker}
								monospace
								heightClass="p-2"
								addon={
									<BrowseFolderButton
										theme={theme}
										onBrowse={handleSelectFolder}
										disabled={isSshEnabled || !!workingDirBlocker}
										title={
											isSshEnabled ? sshFolderPickerUnavailableTitle(sshRemoteHost) : undefined
										}
									/>
								}
							/>
						}
						remotePathStatus={
							// Remote path validation status (only shown when SSH is enabled)
							isSshEnabled ? (
								<RemotePathStatus
									theme={theme}
									validation={remotePathValidation}
									remoteHost={sshRemoteHost || 'remote'}
								/>
							) : undefined
						}
						additionalDirectories={{
							directories: additionalDirectories,
							onChange: setAdditionalDirectories,
							disableBrowse: !!isSshEnabled,
							nativelyEnforced: !!agent?.capabilities?.supportsAdditionalDirectories,
						}}
						newSessionMessage={newSessionMessage}
						onNewSessionMessageChange={setNewSessionMessage}
						nudgeMessage={nudgeMessage}
						onNudgeMessageChange={setNudgeMessage}
						sshRemoteHost={sshRemoteName}
						extra={
							// Voice wake phrase. Renders nothing unless A Cappella is switched on.
							<AgentWakePhraseSection
								theme={theme}
								agentSessionId={session.id}
								enabled={aCappellaEnabled}
							/>
						}
					/>
				)}

				{activeTab === 'provider' && (
					<ProviderTab
						theme={theme}
						idPrefix="edit-agent"
						picker={
							<>
								<AgentProviderSelect
									theme={theme}
									value={translationReview ? translationDestination : selectedToolType}
									disabled={migrationSaving || !!translationReview}
									options={providerOptions}
									onChange={(providerId) => {
										setProjectResourcesIntoRepo(false);
										setConvertProviderHistory(false);
										setAcceptTranslationLimitations(false);
										setSelectedToolType(providerId as ToolType);
									}}
								>
									<div className="mt-2 text-xs" style={{ color: theme.colors.textDim }}>
										Some providers support the ability to transfer sessions, memories, subagents,
										etc between them. They are denoted as {carryOverBadge} in the list.
									</div>
									{(providerChanged || translationReview) && (
										<div
											className="mt-2 p-2 rounded border text-xs space-y-2"
											style={{
												borderColor: theme.colors.accent + '60',
												backgroundColor: theme.colors.accent + '10',
												color: theme.colors.textMain,
											}}
										>
											<div className="flex items-start gap-2">
												<Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
												<span>
													{translationRequested
														? 'Tabs, transcripts, drafts, queue and file previews are preserved. Native conversion remains unverified until resume and round-trip acceptance are proved.'
														: `Tabs, transcripts, drafts, queue and file previews are kept. Each tab that follows the agent starts a new ${agentName} conversation; switching back to ${getAgentDisplayName(session.toolType)} resumes where it left off. Explicitly pinned tabs keep their provider.`}
												</span>
											</div>
											{canConvertProvider && !translationReview && (
												<label className="flex items-center gap-2">
													<input
														type="checkbox"
														checked={convertProviderHistory}
														disabled={migrationSaving}
														onChange={(event) => setConvertProviderHistory(event.target.checked)}
													/>
													Convert memory and session history
												</label>
											)}
											{translationRequested && (
												<>
													<label className="flex items-center gap-2">
														<input
															type="checkbox"
															checked={projectResourcesIntoRepo}
															disabled={migrationSaving}
															onChange={(e) => setProjectResourcesIntoRepo(e.target.checked)}
														/>
														Also install skills and subagents into the project (git-excluded)
													</label>
													{migrationPlan && !migrationLoading && (
														<StatCardGrid
															theme={theme}
															minColumnWidth={120}
															cards={[
																{ label: 'Sessions', value: migrationPlan.tabs.length },
																{
																	label:
																		migrationPlan.counts.messages === undefined
																			? 'Records'
																			: 'Messages',
																	value:
																		migrationPlan.counts.messages ?? migrationPlan.counts.records,
																	displayValue: formatCount(
																		migrationPlan.counts.messages ?? migrationPlan.counts.records
																	),
																},
																{
																	label: 'On next use',
																	value: migrationPlan.deferredTabs?.length ?? 0,
																},
															]}
														/>
													)}
													<div role="status" aria-live="polite" className="flex items-center gap-2">
														{migrationActivity && (
															<Spinner size={14} color={theme.colors.accent} decorative />
														)}
														<span>
															{migrationActivity ??
																(conversionFailed
																	? 'Saving switches without converting.'
																	: migrationError || migrationPlan?.status === 'blocked'
																		? 'Resolve the issue below to switch providers.'
																		: migrationPlan?.status === 'deferred'
																			? 'Ready. The switch will wait for the current turn to finish.'
																			: 'Ready to switch providers.')}
														</span>
													</div>
													{migrationNotices.map((limit) => (
														<div
															key={`${limit.severity}-${limit.code}-${limit.message}`}
															style={{
																color:
																	limit.severity === 'block'
																		? theme.colors.error
																		: theme.colors.textDim,
															}}
														>
															{limit.message}
														</div>
													))}
												</>
											)}
										</div>
									)}
									{migrationError && (
										<div
											role="alert"
											className="mt-2 text-xs"
											style={{ color: theme.colors.error }}
										>
											{migrationError}
										</div>
									)}
									{conversionFailed && (
										<div className="mt-2 text-xs" style={{ color: theme.colors.textDim }}>
											The conversion cannot run, so saving switches providers without converting.
										</div>
									)}
								</AgentProviderSelect>

								{/* Provider settings (path, args, agent-specific options). Its env
								    vars live in the Provider environment section. Per-session values are saved
								    on modal save, not on blur. */}
								{agent && (
									<div>
										<div
											className="block text-xs font-bold opacity-70 uppercase mb-2"
											style={{ color: theme.colors.textMain }}
										>
											{agentName} Settings
										</div>
										<AgentConfigPanel
											theme={theme}
											agent={agent}
											hideEnvVars
											autoModelFor={autoModelFor}
											configOptionNotes={configOptionNotes}
											customPath={customPath}
											onCustomPathChange={setCustomPath}
											onCustomPathBlur={() => {
												/* Saved on modal save */
											}}
											customArgs={customArgs}
											onCustomArgsChange={setCustomArgs}
											onCustomArgsBlur={() => {
												/* Saved on modal save */
											}}
											{...envVarProps}
											agentConfig={agentConfig}
											onConfigChange={(key, value) => {
												setAgentConfig((prev) => ({ ...prev, [key]: value }));
											}}
											onConfigBlur={(key, value) => {
												// model, contextWindow and effort are per-session: they are saved on
												// modal save and must never leak into the agent-level config, which
												// only supplies the defaults for newly created agents.
												const effortKey = getEffortConfigKey(agent);
												if (key === 'model' || key === 'contextWindow' || key === effortKey) return;

												// agents:setConfig replaces the whole object, so rebuild from the
												// agent-level config we loaded: dropping the per-session keys from
												// `agentConfig` alone would erase the agent-level model/effort
												// defaults every time an unrelated option was edited.
												const {
													model: _model,
													contextWindow: _contextWindow,
													[effortKey]: _effort,
													...otherConfig
												} = { ...agentConfig, [key]: value };
												void window.maestro.agents
													.setConfig(selectedToolType, {
														...globalConfigRef.current,
														...otherConfig,
													})
													.catch((error) => {
														logger.error(
															`Failed to persist config for ${selectedToolType}:`,
															undefined,
															error
														);
													});
											}}
											availableModels={availableModels}
											loadingModels={loadingModels}
											onRefreshModels={refreshModels}
											dynamicOptions={editDynamicOptions}
											loadingDynamicOptions={editLoadingDynamicOptions}
											onRefreshAgent={handleRefreshAgent}
											refreshingAgent={refreshingAgent}
											isSshEnabled={isSshEnabled}
											sshRemoteId={sshRemoteConfig?.remoteId ?? undefined}
											enableMaestroP={enableMaestroP}
											onEnableMaestroPChange={setEnableMaestroP}
											maestroPMode={maestroPMode}
											onMaestroPModeChange={setMaestroPMode}
											maestroPPath={maestroPPath}
											onMaestroPPathChange={setMaestroPPath}
											onMaestroPPathBlur={() => {
												/* Saved on modal save */
											}}
											detectedMaestroPPath={detectedMaestroPPath}
											codexAutoResetOnExhaustion={codexAutoReset}
											onCodexAutoResetChange={setCodexAutoReset}
											codexTransport={codexTransport}
											onCodexTransportChange={setCodexTransport}
										/>
									</div>
								)}
							</>
						}
						environment={
							<ProviderEnvironmentSection
								theme={theme}
								toolType={selectedToolType}
								isSshEnabled={!!isSshEnabled}
								{...envVarProps}
							/>
						}
						// Agent Resilience: auto-retry toggles (default ON), editable post-creation.
						resilience={{
							retryOnAvailabilityErrors,
							retryOnTokenExhaustion,
							onChangeAvailability: setRetryOnAvailabilityErrors,
							onChangeTokenExhaustion: setRetryOnTokenExhaustion,
						}}
					/>
				)}

				{activeTab === 'models' && (
					<ModelsTab
						theme={theme}
						idPrefix="edit-agent"
						runOn={
							<div data-testid="edit-agent-run-on">
								<RunOnField
									theme={theme}
									toolType={selectedToolType}
									value={runOn}
									onChange={(target) => {
										setRunOn(target);
										setRunOnError(undefined);
									}}
									userEnvVars={effectiveEnvVars}
									sshRemoteName={sshRemoteName}
									error={runOnError}
									onTest={handleTestRunOn}
									testId="edit-agent-run-on-field"
								/>
							</div>
						}
						tiers={
							<div data-testid="edit-agent-tiers">
								<TierTargetsField
									theme={theme}
									toolType={selectedToolType}
									value={tierTargets}
									onChange={(next) => {
										setTierTargets(next);
										setTierTargetsError(undefined);
									}}
									runOn={runOn}
									error={tierTargetsError}
									testId="edit-agent-tier-targets"
								/>
							</div>
						}
						gateway={
							<>
								{/* Maestro token proxy mode, and under it where the proxy sends
								    background requests. Both apply at once; the gateway draft
								    below follows the mode. */}
								<AgentTokenProxyModeControl
									theme={theme}
									agentId={session.id}
									agentName={session.name}
									toolType={selectedToolType}
									gatewayUrl={gatewayUrl}
									storedMode={(liveSession ?? session).tokenProxyMode}
									storedBackgroundRequests={(liveSession ?? session).backgroundRequests}
									sshRemoteName={sshRemoteName}
									pendingReason={
										gatewaySkippedReason ??
										(providerChanged
											? 'Save the provider change first: the proxy route depends on the provider.'
											: undefined)
									}
									onGatewayUrlChange={handleProxyGatewayUrl}
								/>

								{/* Local Models gateway. Rendered for every provider: one that cannot
								    use a gateway shows the field disabled with the reason. */}
								<div data-testid="edit-agent-gateway">
									<GatewayUrlField
										theme={theme}
										label="Local Models Gateway"
										toolType={selectedToolType}
										value={gatewayUrl}
										onChange={(value) => {
											setGatewayUrl(value);
											setGatewayUrlError(undefined);
										}}
										userEnvVars={effectiveEnvVars}
										sshRemoteName={sshRemoteName}
										error={gatewayUrlError}
										disabledReason={gatewaySkippedReason}
										testId="edit-agent-gateway-url"
									/>
								</div>
							</>
						}
						systemOne={
							// Whether this agent may ask System One. Applies at once, like the
							// proxy mode above: main answers the request and builds the prompt.
							<AgentSystemOneControl
								theme={theme}
								agentId={session.id}
								agentName={session.name}
								optedOut={(liveSession ?? session).systemOneOptOut === true}
								sshRemoteName={sshRemoteName}
							/>
						}
					/>
				)}

				{activeTab === 'peers' && (
					<PeersTab
						theme={theme}
						idPrefix="edit-agent"
						peers={peerAgents}
						onChange={setPeerAgents}
						groupAccess={groupPeerAccess}
						onGroupAccessChange={setGroupPeerAccess}
						worktreeAccess={worktreePeerAccess}
						onWorktreeAccessChange={setWorktreePeerAccess}
						{...peerFleet}
						selfSessionId={session.id}
						groupId={peerGroupId}
					/>
				)}

				{activeTab === 'ssh' && (
					// Always rendered (not gated on sshRemotes.length) because the
					// "remote-controlled" toggle inside is meaningful even when no
					// local remotes exist - it lets a Maestro SSH'd into this
					// machine see mirrored history for this agent.
					<SshTab
						theme={theme}
						idPrefix="edit-agent"
						sshRemotes={sshRemotes}
						sshRemoteConfig={sshRemoteConfig}
						onSshRemoteConfigChange={setSshRemoteConfig}
					/>
				)}

				{activeTab === AUDIT_LOG_TAB_ID && (
					// The tab saves its own changes the moment they are made, into the
					// feature's own store. It hands this dialog no state on purpose:
					// nothing of it may reach `onSave`, and through that the Session
					// object.
					<AuditLogTab
						theme={theme}
						idPrefix="edit-agent"
						agentId={session.id}
						agentName={session.name}
						supportsReasoning={agent?.capabilities?.supportsThinkingDisplay !== false}
						usesInteractiveTokenSource={usesInteractiveTokenSource}
					/>
				)}
			</div>
		</Modal>
	);
}
