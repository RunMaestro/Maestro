/**
 * GroupChatModal.tsx
 *
 * Unified modal for creating and editing Group Chats. Supports two modes:
 * - 'create': Empty initial state, "Create" button, description text
 * - 'edit': Pre-populated from existing group chat, "Save" button, moderator change warning
 *
 * The chat form keeps the moderator picker, name and availability together.
 * Customize opens the moderator's General, Provider and SSH panels in a
 * separate dialog. Environment variables belong to Provider, as in agent forms.
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { ChevronDown, AlertTriangle, Settings } from 'lucide-react';
import { AGENT_AUTOSELECT_ORDER, isBetaAgent } from '../../shared/agentMetadata';
import { requiresIdleParticipants } from '../../shared/group-chat-types';
import type { Theme, AgentConfig, ModeratorConfig, GroupChat } from '../types';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { Modal, ModalFooter, FormInput, ToggleSwitch } from './ui';
import { ModalTabStrip, useModalTabs } from './ui/ModalTabStrip';
import { AGENT_TILES } from './Wizard/screens/AgentSelectionScreen';
import { AgentConfigPanel } from './shared/AgentConfigPanel';
import { agentEnvVarHandlers } from './shared/agentEnvVarHandlers';
import {
	AgentSettingsPanel,
	ProviderEnvironmentSection,
	AgentProviderSelect,
	MODERATOR_TAB_IDS,
	ProviderTab,
	SshTab,
	buildAgentSettingsTabs,
} from './AgentSettings';
import { useAgentConfiguration } from '../hooks/agent';

const TAB_ID_PREFIX = 'group-chat-moderator';

interface GroupChatModalCreateProps {
	mode: 'create';
	theme: Theme;
	isOpen: boolean;
	onClose: () => void;
	onCreate: (
		name: string,
		moderatorAgentId: string,
		moderatorConfig?: ModeratorConfig,
		requireIdleParticipants?: boolean
	) => void;
	groupChat?: undefined;
	onSave?: undefined;
}

interface GroupChatModalEditProps {
	mode: 'edit';
	theme: Theme;
	isOpen: boolean;
	onClose: () => void;
	onSave: (
		id: string,
		name: string,
		moderatorAgentId: string,
		moderatorConfig?: ModeratorConfig,
		requireIdleParticipants?: boolean
	) => void;
	groupChat: GroupChat | null;
	onCreate?: undefined;
}

type GroupChatModalProps = GroupChatModalCreateProps | GroupChatModalEditProps;

export function GroupChatModal(props: GroupChatModalProps): JSX.Element | null {
	const { mode, theme, isOpen, onClose } = props;
	const groupChat = mode === 'edit' ? props.groupChat : undefined;

	const [name, setName] = useState('');
	// Whether the moderator may only hand work to agents that are currently free.
	// Default ON: a participant runs in the agent's own working directory, so
	// delegating to an agent mid-turn puts two writers in one repo.
	const [requireIdle, setRequireIdle] = useState(true);
	// Set by a submit that could not go through, so the empty name shows why.
	const [submitAttempted, setSubmitAttempted] = useState(false);
	// Auto-detected maestro-p path, shown as helper text in the Claude Token Source selector
	const [detectedMaestroPPath, setDetectedMaestroPPath] = useState<string | undefined>(undefined);

	const [customizationOpen, setCustomizationOpen] = useState(false);
	const [customizationVisited, setCustomizationVisited] = useState(false);
	const [saving, setSaving] = useState(false);
	const [saveError, setSaveError] = useState<string | undefined>();
	const [providerConfigDraft, setProviderConfigDraft] = useState<Record<string, unknown>>({});
	// Keep the moderator's explicit model separate from provider defaults loaded
	// asynchronously by the shared configuration hook.
	const [customModel, setCustomModel] = useState<string | undefined>(undefined);
	const discardCustomizationRef = useRef<(() => void) | null>(null);

	const nameInputRef = useRef<HTMLInputElement>(null);

	// Use centralized agent configuration hook
	const ac = useAgentConfiguration({
		enabled: isOpen,
		loadSshRemotes: true,
		autoSelect: false, // We handle auto-select with AGENT_TILES priority
	});

	// Only the customization dialog owns tabs; the chat form stays flat.
	const { activeTab, setActiveTab } = useModalTabs({
		tabs: MODERATOR_TAB_IDS,
		initialTab: 'provider',
		rememberKey: 'group-chat-moderator',
		enabled: isOpen && customizationOpen,
	});

	// Load once customization has been visited. Returning to the chat or
	// reopening Customize must not replace the draft with provider defaults.
	const { setConfigExpanded } = ac;
	useEffect(() => {
		setConfigExpanded(isOpen && customizationVisited);
	}, [isOpen, customizationVisited, setConfigExpanded]);

	// Initialize state from groupChat when modal opens (edit mode)
	useEffect(() => {
		if (mode !== 'edit' || !isOpen || !groupChat) {
			return;
		}

		// Pre-populate from existing group chat
		setName(groupChat.name);
		setRequireIdle(requiresIdleParticipants(groupChat));
		setCustomModel(groupChat.moderatorConfig?.customModel);
		ac.setSelectedAgent(groupChat.moderatorAgentId);
		ac.setCustomPath(groupChat.moderatorConfig?.customPath || '');
		ac.setCustomArgs(groupChat.moderatorConfig?.customArgs || '');
		ac.setCustomEnvVars(groupChat.moderatorConfig?.customEnvVars || {});
		ac.setCustomEnvVarsDisabled(groupChat.moderatorConfig?.customEnvVarsDisabled || {});
		ac.setSshRemoteConfig(groupChat.moderatorConfig?.sshRemoteConfig as any);
		// Claude token source (Claude Code moderator only)
		ac.setEnableMaestroP(groupChat.moderatorConfig?.enableMaestroP ?? false);
		ac.setMaestroPMode(groupChat.moderatorConfig?.maestroPMode ?? 'dynamic');
		ac.setMaestroPPath(groupChat.moderatorConfig?.maestroPPath ?? '');
	}, [mode, isOpen, groupChat]);

	// Resolve the auto-detected maestro-p path for the Claude Token Source helper text
	useEffect(() => {
		if (!isOpen) return;
		void window.maestro.agents
			.getMaestroPDetectedPath()
			.then((p) => setDetectedMaestroPPath(p ?? undefined))
			.catch(() => setDetectedMaestroPPath(undefined));
	}, [isOpen]);

	// Focus name input when agents detected
	useEffect(() => {
		if (!ac.isDetecting && isOpen) {
			nameInputRef.current?.focus();
		}
	}, [ac.isDetecting, isOpen]);

	// Auto-select the most preferred installed agent (create mode only) after
	// detection, and revalidate if current selection is no longer available.
	// The dropdown itself is alphabetical, so the default comes from
	// AGENT_AUTOSELECT_ORDER rather than from whatever sorts first.
	useEffect(() => {
		if (mode !== 'create' || ac.isDetecting) return;

		if (ac.detectedAgents.length === 0) {
			ac.setSelectedAgent(null);
			return;
		}

		// If current selection is still valid, keep it
		if (ac.selectedAgent && ac.detectedAgents.some((a) => a.id === ac.selectedAgent)) return;

		const isSupportedAndDetected = (agentId: string) =>
			AGENT_TILES.some((tile) => tile.id === agentId && tile.supported) &&
			ac.detectedAgents.some((a: AgentConfig) => a.id === agentId);

		const preferred =
			AGENT_AUTOSELECT_ORDER.find(isSupportedAndDetected) ??
			AGENT_TILES.find((tile) => tile.supported && isSupportedAndDetected(tile.id))?.id;

		if (preferred) {
			ac.setSelectedAgent(preferred);
		} else {
			ac.setSelectedAgent(ac.detectedAgents[0].id);
		}
	}, [mode, ac.isDetecting, ac.detectedAgents, ac.selectedAgent, ac.setSelectedAgent]);

	// Reset local state when modal closes
	useEffect(() => {
		if (!isOpen) {
			setName('');
			setRequireIdle(true);
			setSubmitAttempted(false);
			setCustomizationOpen(false);
			setCustomizationVisited(false);
			setSaving(false);
			setSaveError(undefined);
			setProviderConfigDraft({});
			setCustomModel(undefined);
			discardCustomizationRef.current = null;
		}
	}, [isOpen]);

	// Build moderator config from state
	const buildModeratorConfig = useCallback((): ModeratorConfig | undefined => {
		const customModelValue = customModel;
		// Claude token source (maestro-p TUI vs `claude --print` API) only applies to a
		// Claude Code moderator; mirror NewInstanceModal and store the opt-in (and its
		// refinements) only when enabled.
		const tokenSourceEnabled = ac.selectedAgent === 'claude-code' && ac.enableMaestroP;
		const maestroPPathValue =
			tokenSourceEnabled && ac.maestroPPath.trim() ? ac.maestroPPath.trim() : undefined;
		const hasConfig =
			ac.customPath ||
			ac.customArgs ||
			Object.keys(ac.customEnvVars).length > 0 ||
			Object.keys(ac.customEnvVarsDisabled).length > 0 ||
			customModelValue ||
			ac.sshRemoteConfig ||
			tokenSourceEnabled;
		if (!hasConfig) return undefined;

		return {
			customPath: ac.customPath || undefined,
			customArgs: ac.customArgs || undefined,
			customEnvVars: Object.keys(ac.customEnvVars).length > 0 ? ac.customEnvVars : undefined,
			customEnvVarsDisabled:
				Object.keys(ac.customEnvVarsDisabled).length > 0 ? ac.customEnvVarsDisabled : undefined,
			customModel: customModelValue || undefined,
			sshRemoteConfig: ac.sshRemoteConfig || undefined,
			enableMaestroP: tokenSourceEnabled || undefined,
			maestroPMode: tokenSourceEnabled ? ac.maestroPMode : undefined,
			maestroPPath: maestroPPathValue,
		};
	}, [
		ac.customPath,
		ac.customArgs,
		ac.customEnvVars,
		ac.customEnvVarsDisabled,
		customModel,
		ac.sshRemoteConfig,
		ac.selectedAgent,
		ac.enableMaestroP,
		ac.maestroPMode,
		ac.maestroPPath,
	]);

	const handleSubmit = useCallback(async () => {
		if (!name.trim() || !ac.selectedAgent || saving) return;
		setSaving(true);
		setSaveError(undefined);
		try {
			// Provider-wide options retain their existing persistence behavior, but
			// only after the user saves the chat. Cancel never writes them.
			if (Object.keys(providerConfigDraft).length > 0) {
				ac.agentConfigRef.current = { ...ac.agentConfigRef.current, ...providerConfigDraft };
				const saved = await ac.saveAgentConfig(ac.selectedAgent);
				if (saved === false) throw new Error('Could not save the provider settings.');
			}

			const moderatorConfig = buildModeratorConfig();

			if (mode === 'create') {
				props.onCreate(name.trim(), ac.selectedAgent, moderatorConfig, requireIdle);
			} else if (groupChat) {
				props.onSave(groupChat.id, name.trim(), ac.selectedAgent, moderatorConfig, requireIdle);
			}

			setName('');
			setRequireIdle(true);
			setSubmitAttempted(false);
			onClose();
		} catch (error) {
			setSaveError(error instanceof Error ? error.message : 'Could not save the group chat.');
		} finally {
			setSaving(false);
		}
	}, [
		name,
		ac.selectedAgent,
		ac.saveAgentConfig,
		ac.agentConfigRef,
		providerConfigDraft,
		saving,
		buildModeratorConfig,
		mode,
		props,
		groupChat,
		requireIdle,
		onClose,
	]);

	// Check if anything has changed (edit mode only)
	const hasChanges = useCallback((): boolean => {
		if (!groupChat) return false;

		const nameChanged = name.trim() !== groupChat.name;
		const requireIdleChanged = requireIdle !== requiresIdleParticipants(groupChat);
		const agentChanged = ac.selectedAgent !== groupChat.moderatorAgentId;
		const modelChanged = (customModel || undefined) !== groupChat.moderatorConfig?.customModel;
		const pathChanged = ac.customPath !== (groupChat.moderatorConfig?.customPath || '');
		const argsChanged = ac.customArgs !== (groupChat.moderatorConfig?.customArgs || '');

		const originalEnvVars = groupChat.moderatorConfig?.customEnvVars || {};
		const originalDisabledEnvVars = groupChat.moderatorConfig?.customEnvVarsDisabled || {};
		const envVarsChanged =
			JSON.stringify(ac.customEnvVars) !== JSON.stringify(originalEnvVars) ||
			JSON.stringify(ac.customEnvVarsDisabled) !== JSON.stringify(originalDisabledEnvVars);

		const originalSshConfig = groupChat.moderatorConfig?.sshRemoteConfig;
		const sshChanged = JSON.stringify(ac.sshRemoteConfig) !== JSON.stringify(originalSshConfig);

		// Claude token source (Claude Code moderator only) - toggling it marks the config dirty
		const isClaudeModerator = ac.selectedAgent === 'claude-code';
		const enableMaestroPChanged =
			isClaudeModerator &&
			ac.enableMaestroP !== (groupChat.moderatorConfig?.enableMaestroP ?? false);
		const maestroPModeChanged =
			isClaudeModerator &&
			ac.maestroPMode !== (groupChat.moderatorConfig?.maestroPMode ?? 'dynamic');
		const maestroPPathChanged =
			isClaudeModerator && ac.maestroPPath !== (groupChat.moderatorConfig?.maestroPPath ?? '');

		return (
			nameChanged ||
			requireIdleChanged ||
			agentChanged ||
			modelChanged ||
			pathChanged ||
			argsChanged ||
			envVarsChanged ||
			sshChanged ||
			enableMaestroPChanged ||
			maestroPModeChanged ||
			maestroPPathChanged ||
			Object.keys(providerConfigDraft).length > 0
		);
	}, [
		groupChat,
		name,
		requireIdle,
		ac.selectedAgent,
		customModel,
		ac.customPath,
		ac.customArgs,
		ac.customEnvVars,
		ac.customEnvVarsDisabled,
		ac.sshRemoteConfig,
		ac.enableMaestroP,
		ac.maestroPMode,
		ac.maestroPPath,
		providerConfigDraft,
	]);

	const canSubmit =
		name.trim().length > 0 && ac.selectedAgent !== null && (mode === 'create' || hasChanges());

	const nameError = submitAttempted && !name.trim() ? 'Enter a name for the group chat' : undefined;
	const tabs = useMemo(() => buildAgentSettingsTabs(MODERATOR_TAB_IDS), []);

	const openCustomization = () => {
		// The editor works against the existing local form state. Keep a snapshot
		// for Cancel, Escape and the close button; no chat is saved here.
		discardCustomizationRef.current = () => {
			ac.setSelectedAgent(ac.selectedAgent);
			ac.setCustomPath(ac.customPath);
			ac.setCustomArgs(ac.customArgs);
			ac.setCustomEnvVars(ac.customEnvVars);
			ac.setCustomEnvVarsDisabled(ac.customEnvVarsDisabled);
			ac.setSshRemoteConfig(ac.sshRemoteConfig);
			ac.setEnableMaestroP(ac.enableMaestroP);
			ac.setMaestroPMode(ac.maestroPMode);
			ac.setMaestroPPath(ac.maestroPPath);
			setCustomModel(customModel);
			setProviderConfigDraft(providerConfigDraft);
		};
		setCustomizationVisited(true);
		setCustomizationOpen(true);
	};

	const cancelCustomization = () => {
		discardCustomizationRef.current?.();
		discardCustomizationRef.current = null;
		setCustomizationOpen(false);
	};

	const applyCustomization = useCallback(() => {
		discardCustomizationRef.current = null;
		setCustomizationOpen(false);
	}, []);

	const attemptSubmit = useCallback(() => {
		if (customizationOpen) {
			applyCustomization();
			return;
		}
		if (canSubmit) {
			handleSubmit();
			return;
		}
		setSubmitAttempted(true);
		nameInputRef.current?.focus();
	}, [customizationOpen, applyCustomization, canSubmit, handleSubmit]);

	// Window capture, as in Edit Agent: the Modal stops keydown propagation on
	// its backdrop, and preventDefault here keeps the name field's own Enter
	// submit from firing a second time.
	useEffect(() => {
		if (!isOpen) return;
		const handler = (e: KeyboardEvent) => {
			if ((e.metaKey || e.ctrlKey) && (e.key === 'Enter' || e.key === 's') && !e.shiftKey) {
				e.preventDefault();
				attemptSubmit();
			}
		};
		window.addEventListener('keydown', handler, true);
		return () => window.removeEventListener('keydown', handler, true);
	}, [isOpen, attemptSubmit]);

	if (!isOpen) return null;
	if (mode === 'edit' && !groupChat) return null;

	// Filter AGENT_TILES to only show supported + detected agents
	const availableTiles = AGENT_TILES.filter((tile) => {
		if (!tile.supported) return false;
		return ac.detectedAgents.some((a: AgentConfig) => a.id === tile.id);
	});

	// Get selected agent info
	const selectedAgentConfig = ac.detectedAgents.find((a) => a.id === ac.selectedAgent);
	const selectedTile = AGENT_TILES.find((t) => t.id === ac.selectedAgent);

	// One editor under Provider; the config panel hides its inline copy.
	const envVarProps = agentEnvVarHandlers({
		customEnvVars: ac.customEnvVars,
		customEnvVarsDisabled: ac.customEnvVarsDisabled,
		setCustomEnvVars: ac.setCustomEnvVars,
		setCustomEnvVarsDisabled: ac.setCustomEnvVarsDisabled,
	});

	const nameInput = (
		<FormInput
			ref={nameInputRef}
			id="group-chat-name-input"
			theme={theme}
			label="Chat Name"
			value={name}
			onChange={setName}
			onSubmit={canSubmit ? handleSubmit : undefined}
			placeholder="e.g., Auth Feature Implementation"
			error={nameError}
		/>
	);

	// Rendered in both modes, but in different slots: the edit form leads with the
	// chat's identity, while the create form ends with the name field the modal
	// focuses on open.
	const availabilitySection = (
		<div>
			<label
				className="block text-xs font-bold opacity-70 uppercase mb-2"
				style={{ color: theme.colors.textMain }}
			>
				Agent Availability
			</label>

			<div className="flex items-start gap-3">
				<ToggleSwitch
					checked={requireIdle}
					onChange={setRequireIdle}
					theme={theme}
					ariaLabel="Only work with agents that are free"
				/>
				<div className="flex-1 min-w-0">
					<div className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
						Only work with agents that are free
					</div>
					<div className="text-xs mt-1 leading-relaxed" style={{ color: theme.colors.textDim }}>
						An agent brought into this chat runs in its own working directory. When this is on, the
						moderator holds the request for any agent that is busy with your own conversation, an
						Auto Run, or a CLI run, and sends it the moment that agent is free instead of starting a
						second process there.
					</div>
				</div>
			</div>

			{!requireIdle && (
				<div
					className="mt-3 text-xs p-3 rounded flex items-start gap-2"
					style={{
						backgroundColor: `${theme.colors.warning}20`,
						color: theme.colors.warning,
						border: `1px solid ${theme.colors.warning}40`,
					}}
					role="alert"
				>
					<AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
					<div className="leading-relaxed">
						<strong>Agents will be interrupted.</strong> The moderator will hand work to an agent
						even while you are talking to it, so two processes can edit the same files at once,
						overwrite each other, and leave both conversations acting on stale state. Leave this off
						only when you know the work cannot collide.
					</div>
				</div>
			)}
		</div>
	);

	const isCreate = mode === 'create';
	const modalTitle = isCreate ? 'New Group Chat' : 'Edit Group Chat';
	const modalPriority = isCreate
		? MODAL_PRIORITIES.NEW_GROUP_CHAT
		: MODAL_PRIORITIES.EDIT_GROUP_CHAT;

	return (
		<>
			<Modal
				theme={theme}
				title={modalTitle}
				hidden={customizationOpen}
				priority={modalPriority}
				onClose={onClose}
				initialFocusRef={nameInputRef}
				resizable
				resizeKey="group-chat-settings"
				defaultSize={{ width: 720, height: 640 }}
				minSize={{ width: 560, height: 420 }}
				contentClassName="flex flex-col flex-1 min-h-0"
				footer={
					<ModalFooter
						theme={theme}
						onCancel={onClose}
						onConfirm={handleSubmit}
						confirmLabel={isCreate ? 'Create' : 'Save'}
						confirmDisabled={!canSubmit || saving}
					/>
				}
			>
				<div className="flex-1 min-h-0 overflow-y-auto p-6" data-testid="group-chat-body">
					<div className="space-y-5">
						{saveError && (
							<p role="alert" className="text-sm" style={{ color: theme.colors.error }}>
								{saveError}
							</p>
						)}
						{/* Description (create mode only) */}
						{isCreate && (
							<div className="text-sm leading-relaxed" style={{ color: theme.colors.textDim }}>
								A Group Chat lets you collaborate with multiple AI agents in a single conversation.
								The <span style={{ color: theme.colors.textMain }}>moderator</span> manages the
								conversation flow, deciding when to involve other agents. You can{' '}
								<span style={{ color: theme.colors.accent }}>@mention</span> any agent defined in
								Maestro to bring them into the discussion. You can @mention agents from any regular
								AI chat too, but there each mention is a single-turn answer and you are the
								moderator: every follow-up is yours to write. A Group Chat delegates that job to an
								agent who acts as your fiduciary, wrangling the others to work together across
								multiple turns.
							</div>
						)}

						{/* Name Input (edit mode: before moderator, create mode: after) */}
						{!isCreate && nameInput}

						{/* Moderator selection and its full settings editor. */}
						<div>
							<label
								className="block text-xs font-bold opacity-70 uppercase mb-2"
								style={{ color: theme.colors.textMain }}
							>
								{isCreate ? 'Select Moderator' : 'Moderator Agent'}
							</label>

							{ac.isDetecting ? (
								<div className="flex items-center gap-2 py-2">
									<div
										className="w-4 h-4 border-2 border-t-transparent rounded-full animate-spin"
										style={{ borderColor: theme.colors.accent, borderTopColor: 'transparent' }}
									/>
									<span className="text-sm" style={{ color: theme.colors.textDim }}>
										Detecting agents...
									</span>
								</div>
							) : availableTiles.length === 0 ? (
								<div className="text-sm py-2" style={{ color: theme.colors.textDim }}>
									No agents available. Please install Claude Code, OpenCode, Codex, or Factory
									Droid.
								</div>
							) : (
								<div className="flex items-center gap-2">
									<div className="relative min-w-0 flex-1">
										<select
											value={ac.selectedAgent || ''}
											onChange={(e) => {
												ac.handleAgentChange(e.target.value);
												setCustomModel(undefined);
												setProviderConfigDraft({});
											}}
											className="w-full px-3 py-2 pr-10 rounded-lg border outline-none appearance-none cursor-pointer text-sm"
											style={{
												backgroundColor: theme.colors.bgMain,
												borderColor: theme.colors.border,
												color: theme.colors.textMain,
											}}
											aria-label="Select moderator agent"
										>
											{availableTiles.map((tile) => {
												const isBeta = isBetaAgent(tile.id);
												return (
													<option key={tile.id} value={tile.id}>
														{tile.name}
														{isBeta ? ' (Beta)' : ''}
													</option>
												);
											})}
										</select>
										<ChevronDown
											className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 pointer-events-none"
											style={{ color: theme.colors.textDim }}
										/>
									</div>
									{selectedAgentConfig && (
										<button
											type="button"
											onClick={openCustomization}
											className="shrink-0 inline-flex items-center gap-2 rounded border px-3 py-2 text-sm"
											style={{ borderColor: theme.colors.border, color: theme.colors.accent }}
										>
											<Settings className="w-4 h-4" />
											Customize
										</button>
									)}
								</div>
							)}

							{/* Warning about changing moderator (edit mode only) */}
							{mode === 'edit' && groupChat && ac.selectedAgent !== groupChat.moderatorAgentId && (
								<div
									className="mt-3 text-xs p-3 rounded"
									style={{
										backgroundColor: `${theme.colors.warning}20`,
										color: theme.colors.warning,
										border: `1px solid ${theme.colors.warning}40`,
									}}
								>
									<strong>Note:</strong> Changing the moderator agent will restart the moderator
									process. Existing conversation history will be preserved.
								</div>
							)}
						</div>

						{/* Agent availability (edit mode: after the moderator) */}
						{!isCreate && availabilitySection}

						{/* Name Input (create mode: after the moderator, before the options) */}
						{isCreate && nameInput}

						{/* Agent availability (create mode: last, below the name) */}
						{isCreate && availabilitySection}
					</div>
				</div>
			</Modal>
			{customizationOpen && (
				<Modal
					theme={theme}
					title="Edit Moderator"
					subtitle={selectedTile?.name}
					priority={MODAL_PRIORITIES.GROUP_CHAT_MODERATOR_SETTINGS}
					onClose={cancelCustomization}
					resizable
					resizeKey="group-chat-moderator-settings"
					defaultSize={{ width: 720, height: 640 }}
					minSize={{ width: 560, height: 420 }}
					contentClassName="flex flex-col flex-1 min-h-0"
					footer={
						<ModalFooter
							theme={theme}
							onCancel={cancelCustomization}
							onConfirm={applyCustomization}
							confirmLabel="Save Changes"
						/>
					}
				>
					<ModalTabStrip
						theme={theme}
						tabs={tabs}
						activeTab={activeTab}
						onChange={setActiveTab}
						label="Moderator settings"
						idPrefix={TAB_ID_PREFIX}
						className="px-6 pt-4"
					/>
					<div className="flex-1 min-h-0 overflow-y-auto p-6">
						{activeTab === 'general' && (
							<AgentSettingsPanel theme={theme} idPrefix={TAB_ID_PREFIX} tab="general">
								<div className="text-sm" style={{ color: theme.colors.textMain }}>
									{selectedTile?.name} moderates {name.trim() || 'this group chat'}.
								</div>
								<p className="text-xs" style={{ color: theme.colors.textDim }}>
									Choose the provider, account, model and environment on Provider. Choose where the
									moderator runs on SSH. Save Changes returns to the group chat form.
								</p>
							</AgentSettingsPanel>
						)}

						{activeTab === 'provider' && (
							<ProviderTab
								theme={theme}
								idPrefix={TAB_ID_PREFIX}
								environment={
									<ProviderEnvironmentSection
										theme={theme}
										toolType={ac.selectedAgent ?? undefined}
										isSshEnabled={!!ac.sshRemoteConfig?.enabled}
										{...envVarProps}
									/>
								}
								picker={
									selectedAgentConfig && selectedTile ? (
										// The same provider controls used by the other agent forms.
										<div className="space-y-4">
											<AgentProviderSelect
												theme={theme}
												value={ac.selectedAgent ?? ''}
												options={availableTiles.map((tile) => ({
													value: tile.id,
													label: tile.name,
												}))}
												onChange={(agentId) => {
													ac.handleAgentChange(agentId);
													setCustomModel(undefined);
													setProviderConfigDraft({});
												}}
											/>
											<div
												className="block text-xs font-bold opacity-70 uppercase mb-2"
												style={{ color: theme.colors.textMain }}
											>
												{selectedTile.name} Settings
											</div>
											<AgentConfigPanel
												theme={theme}
												agent={selectedAgentConfig}
												hideEnvVars
												customPath={ac.customPath}
												onCustomPathChange={ac.setCustomPath}
												onCustomPathBlur={() => {
													/* Local state only */
												}}
												customArgs={ac.customArgs}
												onCustomArgsChange={ac.setCustomArgs}
												onCustomArgsBlur={() => {
													/* Local state only */
												}}
												{...envVarProps}
												agentConfig={{
													...ac.agentConfig,
													...providerConfigDraft,
													model: customModel ?? ac.agentConfig.model,
												}}
												onConfigChange={(key, value) => {
													if (key === 'model') {
														setCustomModel(value);
														return;
													}
													setProviderConfigDraft((previous) => ({ ...previous, [key]: value }));
												}}
												onConfigBlur={() => {
													/* Saved with the group chat. */
												}}
												availableModels={ac.availableModels}
												loadingModels={ac.loadingModels}
												onRefreshModels={ac.refreshModels}
												dynamicOptions={ac.dynamicOptions}
												loadingDynamicOptions={ac.loadingDynamicOptions}
												onRefreshAgent={ac.refreshAgent}
												refreshingAgent={ac.refreshingAgent}
												isSshEnabled={!!ac.sshRemoteConfig?.enabled}
												sshRemoteId={ac.sshRemoteConfig?.remoteId ?? undefined}
												enableMaestroP={ac.enableMaestroP}
												onEnableMaestroPChange={ac.setEnableMaestroP}
												maestroPMode={ac.maestroPMode}
												onMaestroPModeChange={ac.setMaestroPMode}
												maestroPPath={ac.maestroPPath}
												onMaestroPPathChange={ac.setMaestroPPath}
												onMaestroPPathBlur={() => {
													/* Local state only */
												}}
												detectedMaestroPPath={detectedMaestroPPath}
											/>
										</div>
									) : (
										<p className="text-sm" style={{ color: theme.colors.textDim }}>
											{ac.isDetecting
												? 'Detecting agents...'
												: 'Choose a moderator on the General tab to set its provider options.'}
										</p>
									)
								}
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
			)}
		</>
	);
}
