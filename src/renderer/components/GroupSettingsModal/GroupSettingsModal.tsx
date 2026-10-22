import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { AgentConfig, Group, GroupAgentDefaults, Theme, ToolType } from '../../types';
import { getAgentDisplayName } from '../../../shared/agentMetadata';
import {
	diffGroupDefaults,
	directGroupMembers,
	publishableChangesFor,
	withGroupDefaults,
	withGroupShortLabel,
	type GroupDefaultsDiff,
} from '../../../shared/groupAgentDefaults';
import { backgroundRequestsSupport } from '../../../shared/local-models/background-requests';
import {
	agentRunOnSupport,
	isRunOnSourceTarget,
	RUN_ON_GATEWAY_SKIPPED_REASON,
} from '../../../shared/local-models/run-on';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';
import { useAgentConfiguration } from '../../hooks/agent/useAgentConfiguration';
import { usePeerFleet } from '../../hooks/agent/usePeerFleet';
import { useEventListener } from '../../hooks/utils/useEventListener';
import { useHomeDir } from '../../hooks/utils/useHomeDir';
import {
	notifyGroupDefaultsPublished,
	publishGroupDefaults,
} from '../../services/groupDefaultsPublish';
import { useSessionStore } from '../../stores/sessionStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { getEffortConfigKey } from '../../utils/agentEffort';
import {
	AGENT_FORM_TAB_IDS,
	AgentProviderSelect,
	BrowseFolderButton,
	buildAgentSettingsTabs,
	ProviderEnvironmentSection,
	firstTabWithError,
	GeneralTab,
	ModelsTab,
	PeersTab,
	ProviderTab,
	sshFolderPickerUnavailableTitle,
	SshTab,
} from '../AgentSettings';
import { ConfirmModal } from '../ConfirmModal';
import { SUPPORTED_AGENTS } from '../NewInstanceModal/types';
import { AgentConfigPanel } from '../shared/AgentConfigPanel';
import { agentEnvVarHandlers } from '../shared/agentEnvVarHandlers';
import { BackgroundRequestsField } from '../shared/BackgroundRequestsField';
import { GatewayUrlField } from '../shared/GatewayUrlField';
import { RunOnField } from '../shared/RunOnField';
import { TierTargetsField } from '../shared/TierTargetsField';
import { TokenProxyModeField, tokenProxyModeBlocker } from '../shared/TokenProxyModeField';
import { FormFieldLabel, FormInput, Modal, ModalFooter, ToggleSwitch } from '../ui';
import { MODAL_BUTTON_BASE_CLASS } from '../ui/Modal';
import { ModalTabStrip, useModalTabs } from '../ui/ModalTabStrip';
import {
	buildGroupDefaults,
	groupDefaultsToForm,
	groupDefaultWorkingDirProblem,
	isSshRemoteChosen,
	PROVIDER_BOUND_DEFAULTS,
	type GroupDefaultsForm,
} from './groupDefaultsForm';
import { GroupPillLabelField } from './GroupPillLabelField';
import { PublishDefaultsDialog, type PublishDialogMember } from './PublishDefaultsDialog';

const TAB_ID_PREFIX = 'group-settings';

/**
 * Every provider a user can pick, installed on this machine or not: a group's
 * agents can run on an SSH remote that has a provider this machine lacks.
 * Module-level so the hook's detection effect sees one stable function.
 */
const isPickableProvider = (agent: AgentConfig) => SUPPORTED_AGENTS.includes(agent.id);

/**
 * The form values the modal holds itself. The rest (provider, path, args, env
 * vars, SSH) are held by `useAgentConfiguration`, as in the moderator form.
 */
type OwnFormState = Omit<
	GroupDefaultsForm,
	| 'toolType'
	| 'customPath'
	| 'customArgs'
	| 'customEnvVars'
	| 'customEnvVarsDisabled'
	| 'sshRemoteConfig'
>;

/** A save that is waiting on the publish dialog. Nothing is written until it is answered. */
interface PendingPublish {
	defaults: GroupAgentDefaults | undefined;
	diff: GroupDefaultsDiff;
	members: PublishDialogMember[];
}

export interface GroupSettingsModalProps {
	theme: Theme;
	/** The group whose defaults for new agents are edited. */
	group: Group;
	/** The store's group write. A save goes through it and through nothing else. */
	setGroups: React.Dispatch<React.SetStateAction<Group[]>>;
	onClose: () => void;
}

/**
 * Group Settings: the values a new agent created in one group starts with.
 *
 * The defaults are copy-at-create. They are stamped into the create-agent form
 * and never read again, so nothing here is a runtime layer. The explainer says
 * so to the user, because a group setting reads like one that applies live.
 *
 * The form is the agent settings form (`AgentSettings/`) with the identity
 * fields removed. Every Models control here is a plain form field: the ones in
 * Edit Agent that apply at once write to a live agent, and a group has none.
 *
 * One field is about the group itself: the pill label (`Group.shortLabel`). It
 * is saved in the same write as the defaults, but it is not one of them. It is
 * never copied into an agent and never published to one.
 *
 * A save that changes a default an agent already in the group could take asks
 * first where the change goes (`PublishDefaultsDialog`). A publish is a
 * one-time write into each agent's own record, not a layer above it.
 *
 * The modal is mounted only while it is open, and it reads `group.defaults`
 * and `group.shortLabel` once, when it mounts: a change to the group from
 * elsewhere must not replace what the user has typed.
 */
export function GroupSettingsModal({ theme, group, setGroups, onClose }: GroupSettingsModalProps) {
	// Read once. `seed` feeds every initial value below.
	const [seed] = useState(() => groupDefaultsToForm(group.defaults));

	const ac = useAgentConfiguration({
		enabled: true,
		loadSshRemotes: true,
		autoSelect: false,
		agentFilter: isPickableProvider,
		initialValues: {
			selectedAgent: seed.toolType ?? undefined,
			customPath: seed.customPath,
			customArgs: seed.customArgs,
			customEnvVars: seed.customEnvVars,
			customEnvVarsDisabled: seed.customEnvVarsDisabled,
			sshRemoteConfig: seed.sshRemoteConfig,
		},
	});

	const [own, setOwn] = useState<OwnFormState>(() => {
		const {
			toolType: _toolType,
			customPath: _customPath,
			customArgs: _customArgs,
			customEnvVars: _customEnvVars,
			customEnvVarsDisabled: _customEnvVarsDisabled,
			sshRemoteConfig: _sshRemoteConfig,
			...rest
		} = seed;
		return rest;
	});
	// The group's own pill label. Not a default, so it is held apart from the form.
	const [shortLabel, setShortLabel] = useState(() => group.shortLabel ?? '');
	const setField = useCallback(
		<Key extends keyof OwnFormState>(key: Key, value: OwnFormState[Key]) =>
			setOwn((prev) => ({ ...prev, [key]: value })),
		[]
	);

	// The value the last save refused, and why. Cleared when that value changes.
	const [saveError, setSaveError] = useState<{ field: string; error: string } | null>(null);
	const errorFor = (field: string) => (saveError?.field === field ? saveError.error : undefined);
	const clearError = useCallback(
		(field: string) => setSaveError((prev) => (prev?.field === field ? null : prev)),
		[]
	);

	const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
	const [pendingPublish, setPendingPublish] = useState<PendingPublish | null>(null);
	// Auto-detected maestro-p path, shown as helper text in the Claude Token Source selector.
	const [detectedMaestroPPath, setDetectedMaestroPPath] = useState<string | undefined>(undefined);
	useEffect(() => {
		void window.maestro.agents
			.getMaestroPDetectedPath()
			.then((path) => setDetectedMaestroPPath(path ?? undefined))
			.catch(() => setDetectedMaestroPPath(undefined));
	}, []);

	const homeDir = useHomeDir();
	const endpoints = useSettingsStore((s) => s.localModelEndpoints);
	// The live fleet, for the Peers picker and the group grant's member count.
	const peerFleet = usePeerFleet(group.id);

	const { activeTab, setActiveTab } = useModalTabs({
		tabs: AGENT_FORM_TAB_IDS,
		initialTab: 'general',
		rememberKey: 'group-settings',
		enabled: true,
	});

	// The provider's own config and models load while the Provider tab shows.
	const { setConfigExpanded } = ac;
	useEffect(() => {
		setConfigExpanded(activeTab === 'provider');
	}, [activeTab, setConfigExpanded]);

	const toolType = ac.selectedAgent as ToolType | null;
	const selectedAgentConfig = ac.detectedAgents.find((agent) => agent.id === toolType);
	const effortKey = getEffortConfigKey(selectedAgentConfig);

	const sshRemoteChosen = isSshRemoteChosen(ac.sshRemoteConfig);
	// The remote's name, for the "Runs on" chip and the Models fields. The id
	// stands in until the remotes load: both must know the agents are remote.
	const sshRemoteName = useMemo(() => {
		if (!sshRemoteChosen) return undefined;
		const remoteId = ac.sshRemoteConfig?.remoteId ?? undefined;
		return ac.sshRemotes.find((remote) => remote.id === remoteId)?.name ?? remoteId;
	}, [sshRemoteChosen, ac.sshRemoteConfig?.remoteId, ac.sshRemotes]);

	const form: GroupDefaultsForm = useMemo(
		() => ({
			...own,
			toolType,
			customPath: ac.customPath,
			customArgs: ac.customArgs,
			customEnvVars: ac.customEnvVars,
			customEnvVarsDisabled: ac.customEnvVarsDisabled,
			sshRemoteConfig: ac.sshRemoteConfig,
		}),
		[
			own,
			toolType,
			ac.customPath,
			ac.customArgs,
			ac.customEnvVars,
			ac.customEnvVarsDisabled,
			ac.sshRemoteConfig,
		]
	);

	const handleProviderChange = useCallback(
		(providerId: string) => {
			const next = providerId || null;
			// The env vars stay: they are not tied to a provider, which is what
			// lets a group pin one variable for every agent created in it.
			ac.handleAgentChange(next, { keepEnvVars: true });
			setOwn((prev) => ({
				...prev,
				...PROVIDER_BOUND_DEFAULTS,
				// A Run on target names a source and a model, not a provider, so it
				// is carried across. A provider whose harness cannot use one starts over.
				runOn: next && agentRunOnSupport(next).supported ? prev.runOn : { type: 'provider' },
			}));
			setSaveError(null);
		},
		[ac.handleAgentChange]
	);

	const handleSelectFolder = useCallback(async () => {
		const folder = await window.maestro.dialog.selectFolder();
		if (folder) setField('projectRoot', folder);
	}, [setField]);

	// The one check that is live rather than made at save: the path is typed.
	const workingDirError = groupDefaultWorkingDirProblem(own.projectRoot, sshRemoteChosen);

	const errorFields = useMemo(() => {
		const fields: string[] = [];
		if (workingDirError) fields.push('workingDir');
		if (saveError) fields.push(saveError.field);
		return fields;
	}, [workingDirError, saveError]);
	const tabs = useMemo(
		() => buildAgentSettingsTabs(AGENT_FORM_TAB_IDS, errorFields),
		[errorFields]
	);

	// The profile and the pill label, in one write. A blank label removes
	// `shortLabel`. The label is not a default: it is no part of the diff below.
	const writeProfile = useCallback(
		(defaults: GroupAgentDefaults | undefined) => {
			setGroups((prev) =>
				prev.map((g) =>
					g.id === group.id ? withGroupShortLabel(withGroupDefaults(g, defaults), shortLabel) : g
				)
			);
		},
		[setGroups, group.id, shortLabel]
	);

	// Save builds the profile with every blank or default-valued field omitted
	// (`buildGroupDefaults`); a value a new agent could not be created with goes
	// to its tab instead. Then it diffs the profile against the stored one. When
	// an agent already in the group could take the change, the dialog asks where
	// it goes and nothing is written yet. Otherwise there is nothing to decide:
	// no direct member, or no change a member can receive (an empty diff, a pill
	// label only, a provider or directory only). That saves with no dialog,
	// because a dialog with nothing to decide teaches people to dismiss it unread.
	const handleSave = useCallback(() => {
		const result = buildGroupDefaults(form, { homeDir, sshRemoteName, endpoints });
		if (!result.ok) {
			// The working directory reports its own problem live, under its input.
			if (result.field !== 'workingDir') {
				setSaveError({ field: result.field, error: result.error });
			}
			const tab = firstTabWithError([result.field], AGENT_FORM_TAB_IDS);
			if (tab) setActiveTab(tab);
			return;
		}
		const diff = diffGroupDefaults(group.defaults, result.defaults);
		const members = directGroupMembers(useSessionStore.getState().sessions, group.id);
		if (!members.some((member) => publishableChangesFor(member.toolType, diff).length > 0)) {
			writeProfile(result.defaults);
			onClose();
			return;
		}
		setPendingPublish({
			defaults: result.defaults,
			diff,
			members: members.map(({ id, name, toolType: provider }) => ({
				id,
				name,
				toolType: provider,
			})),
		});
	}, [
		form,
		homeDir,
		sshRemoteName,
		endpoints,
		group.defaults,
		group.id,
		writeProfile,
		onClose,
		setActiveTab,
	]);

	// The profile and the agents in one pass: the service writes every member
	// before it first yields. Its toast is the Undo.
	const handlePublish = useCallback(() => {
		if (!pendingPublish) return;
		const { defaults, diff } = pendingPublish;
		const published = { id: group.id, name: group.name, emoji: group.emoji };
		writeProfile(defaults);
		void publishGroupDefaults(published, diff).then((result) =>
			notifyGroupDefaultsPublished(published, diff, result)
		);
		onClose();
	}, [pendingPublish, group.id, group.name, group.emoji, writeProfile, onClose]);

	const handleNewAgentsOnly = useCallback(() => {
		if (!pendingPublish) return;
		writeProfile(pendingPublish.defaults);
		onClose();
	}, [pendingPublish, writeProfile, onClose]);

	// Clearing is a profile edit only: no agent is read or written.
	const handleClearDefaults = useCallback(() => {
		setGroups((prev) => prev.map((g) => (g.id === group.id ? withGroupDefaults(g, undefined) : g)));
		onClose();
	}, [setGroups, group.id, onClose]);

	// Cmd+Enter / Cmd+S from any tab. Window capture, as in Edit Agent: the Modal
	// stops keydown propagation on its backdrop. Off while a confirmation is
	// up, so a save cannot go through underneath it.
	useEventListener(
		'keydown',
		(event) => {
			const e = event as KeyboardEvent;
			if ((e.metaKey || e.ctrlKey) && (e.key === 'Enter' || e.key === 's') && !e.shiftKey) {
				e.preventDefault();
				handleSave();
			}
		},
		{ capture: true, enabled: !clearConfirmOpen && !pendingPublish }
	);

	// Shared by the Provider tab's config panel (which hides them) and the
	// Provider environment section: one set of handlers over two records.
	const envVarProps = agentEnvVarHandlers({
		customEnvVars: ac.customEnvVars,
		customEnvVarsDisabled: ac.customEnvVarsDisabled,
		setCustomEnvVars: ac.setCustomEnvVars,
		setCustomEnvVarsDisabled: ac.setCustomEnvVarsDisabled,
	});

	// What the config panel draws: the provider's own config, with the group's
	// model, effort and context window over it once the group has an opinion.
	const panelConfig = {
		...ac.agentConfig,
		...(own.customModel !== undefined ? { model: own.customModel } : {}),
		...(own.customEffort !== undefined ? { [effortKey]: own.customEffort } : {}),
		...(own.customContextWindow !== undefined ? { contextWindow: own.customContextWindow } : {}),
	};
	// The group's own vars replace the provider-level set, so the provider-level
	// set only counts when the group has none.
	const effectiveEnvVars =
		Object.keys(ac.customEnvVars).length > 0
			? ac.customEnvVars
			: (ac.agentConfig.customEnvVars as Record<string, string> | undefined);

	// A Run on target takes the gateway's place: both gateway controls say so.
	const gatewaySkippedReason = isRunOnSourceTarget(own.runOn)
		? RUN_ON_GATEWAY_SKIPPED_REASON
		: undefined;
	const proxyBlocker = toolType ? tokenProxyModeBlocker(toolType, sshRemoteName) : undefined;
	// What a save would store: a provider or a remote that cannot use the proxy is off it.
	const proxyMode = proxyBlocker ? 'off' : own.tokenProxyMode;
	const offersBackgroundRequests =
		!!toolType && backgroundRequestsSupport(toolType).supported && proxyMode !== 'off';

	return (
		<>
			<Modal
				theme={theme}
				title={`Group Settings: ${group.emoji} ${group.name}`}
				priority={MODAL_PRIORITIES.GROUP_SETTINGS}
				onClose={onClose}
				resizable
				resizeKey="group-settings"
				defaultSize={{ width: 720, height: 640 }}
				minSize={{ width: 560, height: 420 }}
				contentClassName="flex flex-col flex-1 min-h-0"
				testId="group-settings-modal"
				footer={
					<>
						<button
							type="button"
							onClick={() => setClearConfirmOpen(true)}
							disabled={!group.defaults}
							className={`${MODAL_BUTTON_BASE_CLASS} mr-auto hover:bg-white/5 disabled:opacity-40 disabled:cursor-not-allowed`}
							style={{ color: theme.colors.textDim }}
							title={
								group.defaults
									? 'Remove every default this group holds'
									: 'This group holds no defaults'
							}
							data-testid="group-settings-clear"
						>
							Clear defaults
						</button>
						<ModalFooter
							theme={theme}
							onCancel={onClose}
							onConfirm={handleSave}
							confirmLabel="Save"
							confirmDisabled={!!workingDirError}
						/>
					</>
				}
			>
				<div
					className="mx-6 mt-4 p-3 rounded border text-xs space-y-2 select-text shrink-0"
					style={{
						borderColor: theme.colors.border,
						backgroundColor: theme.colors.bgActivity,
						color: theme.colors.textDim,
					}}
					data-testid="group-settings-explainer"
				>
					<p>
						These are the starting values for{' '}
						<strong style={{ color: theme.colors.textMain }}>new</strong> agents created in this
						group. When you add an agent here, the create-agent form opens with everything below
						already filled in, and you can change any of it before, or after, the agent is created.
					</p>
					<p>
						Nothing here is read while an agent runs. Every agent keeps its own settings, and moving
						an agent into this group does not change it. When you save a change, Maestro asks
						whether to publish that change to the agents already in this group, or to keep it for
						new agents only. Leave a field blank to use the Maestro default.
					</p>
				</div>

				<ModalTabStrip
					theme={theme}
					tabs={tabs}
					activeTab={activeTab}
					onChange={setActiveTab}
					label="Group settings"
					idPrefix={TAB_ID_PREFIX}
					className="px-6 pt-4"
				/>
				<div className="flex-1 min-h-0 overflow-y-auto p-6" data-testid="group-settings-tab-body">
					{activeTab === 'general' && (
						<GeneralTab
							theme={theme}
							idPrefix={TAB_ID_PREFIX}
							lead={
								// First on the page: the one field here that is about the group
								// itself and not about its agents.
								<GroupPillLabelField
									theme={theme}
									groupName={group.name}
									value={shortLabel}
									onChange={setShortLabel}
									onLeaveForSettings={onClose}
								/>
							}
							workingDirectory={
								<FormInput
									id="group-settings-working-dir-input"
									theme={theme}
									label="Default Working Directory"
									value={own.projectRoot}
									onChange={(value) => setField('projectRoot', value)}
									placeholder={
										sshRemoteChosen
											? `Enter remote path${sshRemoteName ? ` on ${sshRemoteName}` : ''} (e.g., /home/user/project)`
											: 'No default: chosen when the agent is created'
									}
									error={workingDirError}
									helperText="Optional. The create-agent form opens on this directory, and it can be changed there."
									monospace
									heightClass="p-2"
									addon={
										<BrowseFolderButton
											theme={theme}
											onBrowse={handleSelectFolder}
											disabled={sshRemoteChosen}
											title={
												sshRemoteChosen ? sshFolderPickerUnavailableTitle(sshRemoteName) : undefined
											}
										/>
									}
								/>
							}
							additionalDirectories={{
								directories: own.additionalDirectories,
								onChange: (directories) => setField('additionalDirectories', directories),
								disableBrowse: sshRemoteChosen,
								nativelyEnforced:
									!!selectedAgentConfig?.capabilities?.supportsAdditionalDirectories,
							}}
							newSessionMessage={own.newSessionMessage}
							onNewSessionMessageChange={(value) => setField('newSessionMessage', value)}
							nudgeMessage={own.nudgeMessage}
							onNudgeMessageChange={(value) => setField('nudgeMessage', value)}
							sshRemoteHost={sshRemoteName}
						/>
					)}

					{activeTab === 'provider' && (
						<ProviderTab
							theme={theme}
							idPrefix={TAB_ID_PREFIX}
							picker={
								<>
									<AgentProviderSelect
										theme={theme}
										value={toolType ?? ''}
										onChange={handleProviderChange}
										noneLabel="No default (chosen when the agent is created)"
										testId="group-settings-provider"
									>
										{!toolType && (
											<p className="mt-2 text-xs" style={{ color: theme.colors.textDim }}>
												Choose a provider to set its path, arguments, model and token source. The
												environment, peers and SSH settings apply to a new agent of any provider.
											</p>
										)}
									</AgentProviderSelect>

									{/* Provider settings (path, args, provider-specific options). Its
									    env vars share this Provider tab. Path, args, model, effort
									    and context window are saved with the group. */}
									{toolType && selectedAgentConfig && (
										<div>
											<FormFieldLabel theme={theme}>
												{getAgentDisplayName(toolType)} Settings
											</FormFieldLabel>
											<AgentConfigPanel
												theme={theme}
												agent={selectedAgentConfig}
												hideEnvVars
												autoModelFor={{ tierTargets: own.tierTargets, runOn: own.runOn }}
												customPath={ac.customPath}
												onCustomPathChange={ac.setCustomPath}
												onCustomPathBlur={() => {
													/* Saved on modal save */
												}}
												customArgs={ac.customArgs}
												onCustomArgsChange={ac.setCustomArgs}
												onCustomArgsBlur={() => {
													/* Saved on modal save */
												}}
												{...envVarProps}
												agentConfig={panelConfig}
												onConfigChange={(key, value) => {
													// Model, effort and context window belong to the group once
													// touched. Every other option is the provider's own config,
													// as it is in every other form that mounts this panel.
													if (key === 'model') setField('customModel', value);
													else if (key === effortKey) setField('customEffort', value);
													else if (key === 'contextWindow') setField('customContextWindow', value);
													else {
														const next = { ...ac.agentConfig, [key]: value };
														ac.setAgentConfig(next);
														ac.agentConfigRef.current = next;
													}
												}}
												onConfigBlur={async (key) => {
													if (key === 'model' || key === effortKey || key === 'contextWindow')
														return;
													await ac.saveAgentConfig(toolType);
												}}
												availableModels={ac.availableModels}
												loadingModels={ac.loadingModels}
												onRefreshModels={ac.refreshModels}
												dynamicOptions={ac.dynamicOptions}
												loadingDynamicOptions={ac.loadingDynamicOptions}
												onRefreshAgent={ac.refreshAgent}
												refreshingAgent={ac.refreshingAgent}
												isSshEnabled={sshRemoteChosen}
												sshRemoteId={ac.sshRemoteConfig?.remoteId ?? undefined}
												enableMaestroP={own.enableMaestroP}
												onEnableMaestroPChange={(value) => setField('enableMaestroP', value)}
												maestroPMode={own.maestroPMode}
												onMaestroPModeChange={(mode) => setField('maestroPMode', mode)}
												maestroPPath={own.maestroPPath}
												onMaestroPPathChange={(value) => setField('maestroPPath', value)}
												onMaestroPPathBlur={() => {
													/* Saved on modal save */
												}}
												detectedMaestroPPath={detectedMaestroPPath}
												codexAutoResetOnExhaustion={own.codexAutoResetOnExhaustion}
												onCodexAutoResetChange={(value) =>
													setField('codexAutoResetOnExhaustion', value)
												}
												codexTransport={own.codexTransport}
												onCodexTransportChange={(transport) =>
													setField('codexTransport', transport)
												}
											/>
										</div>
									)}
									{toolType && !selectedAgentConfig && ac.isDetecting && (
										<p className="text-sm" style={{ color: theme.colors.textDim }}>
											Detecting agents...
										</p>
									)}
								</>
							}
							environment={
								<ProviderEnvironmentSection
									theme={theme}
									toolType={toolType ?? undefined}
									isSshEnabled={sshRemoteChosen}
									{...envVarProps}
								/>
							}
							resilience={{
								retryOnAvailabilityErrors: own.retryOnAvailabilityErrors,
								retryOnTokenExhaustion: own.retryOnTokenExhaustion,
								onChangeAvailability: (value) => setField('retryOnAvailabilityErrors', value),
								onChangeTokenExhaustion: (value) => setField('retryOnTokenExhaustion', value),
							}}
						/>
					)}

					{activeTab === 'models' && (
						<ModelsTab
							theme={theme}
							idPrefix={TAB_ID_PREFIX}
							runOn={
								toolType ? (
									<div data-testid="group-settings-run-on">
										<RunOnField
											theme={theme}
											toolType={toolType}
											value={own.runOn}
											onChange={(target) => {
												setField('runOn', target);
												clearError('runOn');
											}}
											userEnvVars={effectiveEnvVars}
											sshRemoteName={sshRemoteName}
											error={errorFor('runOn')}
											testId="group-settings-run-on-field"
										/>
									</div>
								) : (
									<p
										className="text-sm"
										style={{ color: theme.colors.textDim }}
										data-testid="group-settings-models-no-provider"
									>
										Choose a provider on the Provider tab to set where its model runs, its tiers and
										its gateway. A model target belongs to one provider's harness.
									</p>
								)
							}
							tiers={
								toolType && (
									<div data-testid="group-settings-tiers">
										<TierTargetsField
											theme={theme}
											toolType={toolType}
											value={own.tierTargets}
											onChange={(next) => {
												setField('tierTargets', next);
												clearError('tierTargets');
											}}
											runOn={own.runOn}
											error={errorFor('tierTargets')}
											testId="group-settings-tier-targets"
										/>
									</div>
								)
							}
							gateway={
								toolType && (
									<>
										{/* The proxy mode stands in for the gateway URL: a new agent is put
										    on the proxy when it is created, at the address its provider
										    and credentials need. So the group holds one or the other. */}
										<div>
											<TokenProxyModeField
												theme={theme}
												label="Maestro Token Proxy"
												value={proxyMode}
												onChange={(mode) => {
													setField('tokenProxyMode', mode);
													// The mode decides which of the two is stored at all.
													clearError('backgroundRequests');
													clearError('gatewayUrl');
												}}
												disabledReason={proxyBlocker ?? gatewaySkippedReason}
												ariaLabel="Maestro token proxy mode for new agents in this group"
												testId="group-settings-proxy-mode"
											/>
											<p className="mt-1 text-xs" style={{ color: theme.colors.textDim }}>
												Passthrough and Compress put a new agent on the proxy when it is created, in
												place of the gateway below.
											</p>
										</div>
										{offersBackgroundRequests && (
											<BackgroundRequestsField
												theme={theme}
												value={own.backgroundRequests}
												onChange={(next) => {
													setField('backgroundRequests', next);
													clearError('backgroundRequests');
												}}
												error={errorFor('backgroundRequests')}
												testId="group-settings-background-requests"
											/>
										)}
										<div data-testid="group-settings-gateway">
											<GatewayUrlField
												theme={theme}
												label="Local Models Gateway"
												toolType={toolType}
												value={own.gatewayUrl}
												onChange={(value) => {
													setField('gatewayUrl', value);
													clearError('gatewayUrl');
												}}
												userEnvVars={effectiveEnvVars}
												sshRemoteName={sshRemoteName}
												error={errorFor('gatewayUrl')}
												disabledReason={
													gatewaySkippedReason ??
													(proxyMode !== 'off'
														? 'Set by the proxy mode above when the agent is created. Set the mode to Off to give new agents a gateway of your own.'
														: undefined)
												}
												testId="group-settings-gateway-url"
											/>
										</div>
									</>
								)
							}
							systemOne={
								<div
									className="flex items-start justify-between gap-3"
									data-testid="group-settings-system-one"
								>
									<div className="min-w-0">
										<FormFieldLabel theme={theme}>System One</FormFieldLabel>
										<p className="text-xs" style={{ color: theme.colors.textDim }}>
											{own.systemOneOptOut
												? 'A new agent in this group starts with System One switched off.'
												: 'A new agent in this group follows "Let agents use System One".'}
										</p>
									</div>
									<ToggleSwitch
										theme={theme}
										checked={!own.systemOneOptOut}
										onChange={(allowed) => setField('systemOneOptOut', !allowed)}
										size="sm"
										ariaLabel="Let new agents in this group use System One"
									/>
								</div>
							}
						/>
					)}

					{activeTab === 'peers' && (
						// No `selfSessionId`: the agent these rows are for does not exist
						// yet. The group is known, so the group grant is enabled.
						<PeersTab
							theme={theme}
							idPrefix={TAB_ID_PREFIX}
							peers={own.peerAgents}
							onChange={(peers) => setField('peerAgents', peers)}
							groupAccess={own.groupPeerAccess}
							onGroupAccessChange={(access) => setField('groupPeerAccess', access)}
							worktreeAccess={own.worktreePeerAccess}
							onWorktreeAccessChange={(access) => setField('worktreePeerAccess', access)}
							availableAgents={peerFleet.availableAgents}
							groupId={group.id}
							groupName={group.name}
						/>
					)}

					{activeTab === 'ssh' && (
						<SshTab
							theme={theme}
							idPrefix={TAB_ID_PREFIX}
							sshRemotes={ac.sshRemotes}
							sshRemoteConfig={ac.sshRemoteConfig}
							onSshRemoteConfigChange={ac.setSshRemoteConfig}
						/>
					)}
				</div>
			</Modal>

			{clearConfirmOpen && (
				<ConfirmModal
					theme={theme}
					title="Clear defaults"
					message={`Clear every default for new agents in ${group.emoji} ${group.name}?`}
					confirmLabel="Clear defaults"
					onConfirm={handleClearDefaults}
					onClose={() => setClearConfirmOpen(false)}
				>
					<p className="text-sm" style={{ color: theme.colors.textDim }}>
						A new agent in this group then starts from the Maestro defaults. The agents already in
						this group keep their settings: clearing is not published to them.
					</p>
				</ConfirmModal>
			)}

			{pendingPublish && (
				<PublishDefaultsDialog
					theme={theme}
					group={group}
					diff={pendingPublish.diff}
					members={pendingPublish.members}
					onPublish={handlePublish}
					onNewAgentsOnly={handleNewAgentsOnly}
					// Abandons the save: nothing was written, and the form is as typed.
					onCancel={() => setPendingPublish(null)}
				/>
			)}
		</>
	);
}
