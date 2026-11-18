/**
 * GroupChatModal.tsx
 *
 * Unified modal for creating and editing Group Chats. Supports two modes:
 * - 'create': Empty initial state, "Create" button, description text
 * - 'edit': Pre-populated from existing group chat, "Save" button, moderator change warning
 *
 * Allows user to:
 * - Select a moderator agent from a dropdown of available agents
 * - Customize moderator settings (CLI args, path, ENV vars) via expandable panel
 * - Enter/edit a name for the group chat
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Settings, ChevronDown, Check, AlertTriangle } from 'lucide-react';
import { AGENT_AUTOSELECT_ORDER, isBetaAgent } from '../../shared/agentMetadata';
import {
	GROUP_CHAT_MODERATION_UNSUPPORTED,
	groupChatModeratorRefusal,
	requiresIdleParticipants,
} from '../../shared/group-chat-types';
import type { Theme, AgentConfig, ModeratorConfig, GroupChat } from '../types';
import type { AgentDiscoveryRequest } from '../../shared/types';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { Modal, ModalFooter, FormInput, ToggleSwitch } from './ui';
import { AGENT_TILES } from './Wizard/screens/AgentSelectionScreen';
import { AgentConfigPanel } from './shared/AgentConfigPanel';
import { useAgentConfiguration } from '../hooks/agent';
import { withBlankEnvVarRow } from '../../shared/envVarCatalog';

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
	// Track if user has visited/modified the config panel (edit mode only)
	const [configWasModified, setConfigWasModified] = useState(false);
	// Auto-detected maestro-p path, shown as helper text in the Claude Token Source selector
	const [detectedMaestroPPath, setDetectedMaestroPPath] = useState<string | undefined>(undefined);

	const nameInputRef = useRef<HTMLInputElement>(null);
	// Absence inherits provider settings; an explicitly emptied Grok record must
	// remain an override in discovery and in the saved moderator configuration.
	const [customEnvVars, setCustomEnvVars] = useState<Record<string, string>>();
	const envVars = customEnvVars ?? {};
	const [discoveryCwd, setDiscoveryCwd] = useState<string>();
	const [grokConfig, setGrokConfig] = useState<Record<string, any>>({});
	const discoveryContext = useMemo<
		Exclude<AgentDiscoveryRequest['context'], { kind: 'agent' }> | undefined
	>(
		() => (discoveryCwd?.trim() ? { kind: 'draft', cwd: discoveryCwd, customEnvVars } : undefined),
		[discoveryCwd, customEnvVars]
	);

	// Use centralized agent configuration hook
	const ac = useAgentConfiguration({
		enabled: isOpen,
		loadSshRemotes: true,
		autoSelect: false, // We handle auto-select with AGENT_TILES priority
		discoveryContext,
	});

	const agentConfig = useMemo(
		() => (ac.selectedAgent === 'grok' ? { ...ac.agentConfig, ...grokConfig } : ac.agentConfig),
		[ac.selectedAgent, ac.agentConfig, grokConfig]
	);
	// Provider config can arrive after the editor opens or expands again. Retain
	// the chat's selected model and typed values while the shared hook reloads it.
	useEffect(() => {
		if (
			ac.selectedAgent === 'grok' &&
			Object.entries(grokConfig).some(([key, value]) => ac.agentConfig[key] !== value)
		) {
			ac.setAgentConfig(agentConfig);
			ac.agentConfigRef.current = agentConfig;
		}
	}, [ac.selectedAgent, ac.agentConfig, grokConfig, agentConfig]);
	// Detection reports each provider's capabilities. A provider that declares it
	// cannot moderate is listed but never selectable; one with no capability
	// record is left to storage's refusal, which uses the same text.
	const canModerate = useCallback(
		(agentId: string) =>
			!groupChatModeratorRefusal(
				agentId,
				ac.detectedAgents.find((a: AgentConfig) => a.id === agentId)?.capabilities
					?.supportsGroupChatModeration !== false
			),
		[ac.detectedAgents]
	);

	const savedEnvVars =
		ac.selectedAgent === 'grok' || Object.keys(envVars).length > 0 ? customEnvVars : undefined;
	const hasCustomization = ac.hasCustomization || savedEnvVars !== undefined;

	// Initialize state from groupChat when modal opens (edit mode)
	useEffect(() => {
		if (mode !== 'edit' || !isOpen || !groupChat) {
			return;
		}

		// Pre-populate from existing group chat
		setName(groupChat.name);
		setRequireIdle(requiresIdleParticipants(groupChat));
		ac.handleAgentChange(groupChat.moderatorAgentId);
		if (groupChat.moderatorConfig?.customPath !== undefined) {
			ac.setCustomPath(groupChat.moderatorConfig.customPath);
		}
		ac.setCustomArgs(groupChat.moderatorConfig?.customArgs || '');
		setCustomEnvVars(groupChat.moderatorConfig?.customEnvVars);
		setGrokConfig(
			groupChat.moderatorAgentId === 'grok' && groupChat.moderatorConfig?.customModel !== undefined
				? { model: groupChat.moderatorConfig.customModel }
				: {}
		);
		// A local moderator has no selected workspace. Only an explicit remote
		// working-directory override describes where this moderator will execute.
		setDiscoveryCwd(
			groupChat.moderatorConfig?.sshRemoteConfig?.enabled
				? groupChat.moderatorConfig.sshRemoteConfig.workingDirOverride || undefined
				: undefined
		);
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
		if (
			ac.selectedAgent &&
			canModerate(ac.selectedAgent) &&
			ac.detectedAgents.some((a) => a.id === ac.selectedAgent)
		)
			return;

		const isSupportedAndDetected = (agentId: string) =>
			AGENT_TILES.some((tile) => tile.id === agentId && tile.supported) &&
			ac.detectedAgents.some((a: AgentConfig) => a.id === agentId) &&
			canModerate(agentId);

		const preferred =
			AGENT_AUTOSELECT_ORDER.find(isSupportedAndDetected) ??
			AGENT_TILES.find((tile) => tile.supported && isSupportedAndDetected(tile.id))?.id;

		if (preferred) {
			ac.setSelectedAgent(preferred);
		} else {
			ac.setSelectedAgent(ac.detectedAgents.find((a) => canModerate(a.id))?.id ?? null);
		}
	}, [mode, ac.isDetecting, ac.detectedAgents, ac.selectedAgent, ac.setSelectedAgent, canModerate]);

	// Reset local state when modal closes
	useEffect(() => {
		if (!isOpen) {
			setName('');
			setRequireIdle(true);
			setConfigWasModified(false);
			setCustomEnvVars(undefined);
			setDiscoveryCwd(undefined);
			setGrokConfig({});
		}
	}, [isOpen]);

	// Build moderator config from state
	const buildModeratorConfig = useCallback((): ModeratorConfig | undefined => {
		const customModelValue = agentConfig.model;
		// Claude token source (maestro-p TUI vs `claude --print` API) only applies to a
		// Claude Code moderator; mirror NewInstanceModal and store the opt-in (and its
		// refinements) only when enabled.
		const tokenSourceEnabled = ac.selectedAgent === 'claude-code' && ac.enableMaestroP;
		const maestroPPathValue =
			tokenSourceEnabled && ac.maestroPPath.trim() ? ac.maestroPPath.trim() : undefined;
		const hasConfig =
			ac.customPath ||
			ac.customArgs ||
			savedEnvVars !== undefined ||
			Object.keys(ac.customEnvVarsDisabled).length > 0 ||
			customModelValue ||
			ac.sshRemoteConfig ||
			tokenSourceEnabled;
		if (!hasConfig) return undefined;

		return {
			customPath: ac.customPath || undefined,
			customArgs: ac.customArgs || undefined,
			customEnvVars: savedEnvVars,
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
		savedEnvVars,
		ac.customEnvVarsDisabled,
		agentConfig.model,
		ac.sshRemoteConfig,
		ac.selectedAgent,
		ac.enableMaestroP,
		ac.maestroPMode,
		ac.maestroPPath,
	]);

	const handleSubmit = useCallback(() => {
		if (!name.trim() || !ac.selectedAgent || !canModerate(ac.selectedAgent)) return;

		const moderatorConfig = buildModeratorConfig();

		if (mode === 'create') {
			props.onCreate(name.trim(), ac.selectedAgent, moderatorConfig, requireIdle);
		} else if (groupChat) {
			props.onSave(groupChat.id, name.trim(), ac.selectedAgent, moderatorConfig, requireIdle);
		}

		setName('');
		setRequireIdle(true);
		setConfigWasModified(false);
		onClose();
	}, [
		name,
		ac.selectedAgent,
		canModerate,
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
		const pathChanged = ac.customPath !== (groupChat.moderatorConfig?.customPath || '');
		const argsChanged = ac.customArgs !== (groupChat.moderatorConfig?.customArgs || '');

		const originalEnvVars = groupChat.moderatorConfig?.customEnvVars || {};
		const originalDisabledEnvVars = groupChat.moderatorConfig?.customEnvVarsDisabled || {};
		const envVarsChanged =
			JSON.stringify(envVars) !== JSON.stringify(originalEnvVars) ||
			(ac.selectedAgent === 'grok' &&
				(savedEnvVars !== undefined) !==
					(groupChat.moderatorConfig?.customEnvVars !== undefined)) ||
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
			pathChanged ||
			argsChanged ||
			envVarsChanged ||
			sshChanged ||
			enableMaestroPChanged ||
			maestroPModeChanged ||
			maestroPPathChanged ||
			configWasModified
		);
	}, [
		groupChat,
		name,
		requireIdle,
		ac.selectedAgent,
		ac.customPath,
		ac.customArgs,
		envVars,
		savedEnvVars,
		ac.customEnvVarsDisabled,
		ac.sshRemoteConfig,
		ac.enableMaestroP,
		ac.maestroPMode,
		ac.maestroPPath,
		configWasModified,
	]);

	const canSubmit =
		name.trim().length > 0 &&
		ac.selectedAgent !== null &&
		canModerate(ac.selectedAgent) &&
		(mode === 'create' || hasChanges());

	if (!isOpen) return null;
	if (mode === 'edit' && !groupChat) return null;

	// Filter AGENT_TILES to only show supported + detected agents
	const availableTiles = AGENT_TILES.filter((tile) => {
		if (!tile.supported) return false;
		return ac.detectedAgents.some((a: AgentConfig) => a.id === tile.id);
	});
	// Listed so the user sees why, but not selectable as moderator.
	const nonModeratorTiles = availableTiles.filter((tile) => !canModerate(tile.id));

	// Get selected agent info
	const selectedAgentConfig = ac.detectedAgents.find((a) => a.id === ac.selectedAgent);
	const selectedTile = AGENT_TILES.find((t) => t.id === ac.selectedAgent);

	// Rendered in both modes, but in different slots: the edit form leads with the
	// chat's identity, while the create form ends with the name field the modal
	// focuses on open.
	const availabilitySection = (
		<div className="mb-6">
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
		<Modal
			theme={theme}
			title={modalTitle}
			priority={modalPriority}
			onClose={onClose}
			initialFocusRef={nameInputRef}
			width={600}
			footer={
				<ModalFooter
					theme={theme}
					onCancel={onClose}
					onConfirm={handleSubmit}
					confirmLabel={isCreate ? 'Create' : 'Save'}
					confirmDisabled={!canSubmit}
				/>
			}
		>
			<div>
				{/* Description (create mode only) */}
				{isCreate && (
					<div className="mb-6 text-sm leading-relaxed" style={{ color: theme.colors.textDim }}>
						A Group Chat lets you collaborate with multiple AI agents in a single conversation. The{' '}
						<span style={{ color: theme.colors.textMain }}>moderator</span> manages the conversation
						flow, deciding when to involve other agents. You can{' '}
						<span style={{ color: theme.colors.accent }}>@mention</span> any agent defined in
						Maestro to bring them into the discussion. You can @mention agents from any regular AI
						chat too, but there each mention is a single-turn answer and you are the moderator:
						every follow-up is yours to write. A Group Chat delegates that job to an agent who acts
						as your fiduciary, wrangling the others to work together across multiple turns.
					</div>
				)}

				{/* Name Input (edit mode: before moderator, create mode: after) */}
				{!isCreate && (
					<div className="mb-6">
						<FormInput
							ref={nameInputRef}
							theme={theme}
							label="Chat Name"
							value={name}
							onChange={setName}
							onSubmit={canSubmit ? handleSubmit : undefined}
							placeholder="e.g., Auth Feature Implementation"
						/>
					</div>
				)}

				{/* Moderator Selection - Dropdown with Customize button */}
				<div className="mb-6">
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
					) : availableTiles.length === nonModeratorTiles.length ? (
						<div className="text-sm py-2" style={{ color: theme.colors.textDim }}>
							No agents available. Please install Claude Code, OpenCode, Codex, or Factory Droid.
						</div>
					) : (
						<div className="flex items-center gap-2">
							{/* Dropdown */}
							<div className="relative flex-1" style={{ zIndex: 10000 }}>
								<select
									value={ac.selectedAgent || ''}
									onChange={(e) => {
										setCustomEnvVars(undefined);
										setGrokConfig({});
										ac.handleAgentChange(e.target.value);
									}}
									className="w-full px-3 py-2 pr-10 rounded-lg border outline-none appearance-none cursor-pointer text-sm relative"
									style={{
										backgroundColor: theme.colors.bgMain,
										borderColor: theme.colors.border,
										color: theme.colors.textMain,
										zIndex: 10000,
									}}
									aria-label="Select moderator agent"
								>
									{availableTiles.map((tile) => {
										const isBeta = isBetaAgent(tile.id);
										const moderates = canModerate(tile.id);
										return (
											<option
												key={tile.id}
												value={tile.id}
												disabled={!moderates}
												title={moderates ? undefined : GROUP_CHAT_MODERATION_UNSUPPORTED}
											>
												{tile.name}
												{isBeta ? ' (Beta)' : ''}
												{moderates ? '' : ' - cannot moderate'}
											</option>
										);
									})}
								</select>
								<ChevronDown
									className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 pointer-events-none"
									style={{ color: theme.colors.textDim, zIndex: 10001 }}
								/>
							</div>

							{/* Customize button */}
							<button
								onClick={ac.toggleConfigExpanded}
								className="flex items-center gap-1.5 px-3 py-2 rounded-lg border transition-colors hover:bg-white/5"
								style={{
									borderColor: ac.isConfigExpanded ? theme.colors.accent : theme.colors.border,
									color: ac.isConfigExpanded ? theme.colors.accent : theme.colors.textDim,
									backgroundColor: ac.isConfigExpanded ? `${theme.colors.accent}10` : 'transparent',
								}}
								title="Customize moderator settings"
							>
								<Settings className="w-4 h-4" />
								<span className="text-sm">Customize</span>
								{hasCustomization && (
									<span
										className="w-2 h-2 rounded-full"
										style={{ backgroundColor: theme.colors.accent }}
									/>
								)}
							</button>
						</div>
					)}

					{!ac.isDetecting && nonModeratorTiles.length > 0 && (
						<p
							className="mt-2 text-xs"
							style={{ color: theme.colors.textDim }}
							data-testid="moderator-unavailable-reason"
						>
							{nonModeratorTiles.map((tile) => tile.name).join(', ')}{' '}
							{nonModeratorTiles.length === 1 ? 'is' : 'are'} not available as moderator:{' '}
							{GROUP_CHAT_MODERATION_UNSUPPORTED}
						</p>
					)}

					{/* Expandable Configuration Panel */}
					{ac.isConfigExpanded && selectedAgentConfig && selectedTile && (
						<div
							className="mt-3 p-4 rounded-lg border"
							style={{
								backgroundColor: theme.colors.bgActivity,
								borderColor: theme.colors.border,
							}}
						>
							<div className="flex items-center justify-between mb-3">
								<span className="text-xs font-medium" style={{ color: theme.colors.textDim }}>
									{selectedTile.name} Configuration
								</span>
								{hasCustomization && (
									<div className="flex items-center gap-1">
										<Check className="w-3 h-3" style={{ color: theme.colors.success }} />
										<span className="text-xs" style={{ color: theme.colors.success }}>
											Customized
										</span>
									</div>
								)}
							</div>
							{ac.selectedAgent === 'grok' && (
								<p className="mb-3 text-xs" style={{ color: theme.colors.textDim }} role="status">
									{!discoveryCwd
										? 'Model and effort discovery is unavailable until the moderator workspace is known. Enter values manually or keep the configured values.'
										: ac.modelDiscoveryStatus === 'discovered' &&
											  Object.values(ac.dynamicOptionStatuses).includes('discovered')
											? 'Model and effort options apply to this moderator configuration. Manual values are preserved.'
											: ac.modelDiscoveryStatus === 'configured-fallback' ||
												  Object.values(ac.dynamicOptionStatuses).includes('configured-fallback')
												? 'Discovery is unavailable. Showing configured model or effort values; manual values are preserved.'
												: 'Model or effort discovery is unavailable. Configured and manual values are preserved.'}
								</p>
							)}
							<AgentConfigPanel
								theme={theme}
								agent={selectedAgentConfig}
								isSshEnabled={ac.sshRemoteConfig?.enabled}
								sshRemoteId={ac.sshRemoteConfig?.remoteId || undefined}
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
								customEnvVars={envVars}
								customEnvVarsDisabled={ac.customEnvVarsDisabled}
								onEnvVarToggle={(key, nextEnabled) => {
									// Move the var between the two records, value intact.
									const from = nextEnabled ? ac.customEnvVarsDisabled : envVars;
									const value = from[key] ?? '';
									const remaining = { ...from };
									delete remaining[key];
									if (nextEnabled) {
										ac.setCustomEnvVarsDisabled(remaining);
										setCustomEnvVars({ ...envVars, [key]: value });
									} else {
										setCustomEnvVars(remaining);
										ac.setCustomEnvVarsDisabled((prev) => ({ ...prev, [key]: value }));
									}
								}}
								onEnvVarKeyChange={(oldKey, newKey, value, enabled) => {
									if (enabled === false) {
										ac.setCustomEnvVarsDisabled((prev) => {
											const newVars = { ...prev };
											delete newVars[oldKey];
											newVars[newKey] = value;
											return newVars;
										});
										return;
									}
									const newVars = { ...envVars };
									delete newVars[oldKey];
									newVars[newKey] = value;
									setCustomEnvVars(newVars);
								}}
								onEnvVarValueChange={(key, value, enabled) => {
									if (enabled === false) {
										ac.setCustomEnvVarsDisabled((prev) => ({ ...prev, [key]: value }));
										return;
									}
									setCustomEnvVars({ ...envVars, [key]: value });
								}}
								onEnvVarRemove={(key, enabled) => {
									if (enabled === false) {
										ac.setCustomEnvVarsDisabled((prev) => {
											const newVars = { ...prev };
											delete newVars[key];
											return newVars;
										});
										return;
									}
									const newVars = { ...envVars };
									delete newVars[key];
									setCustomEnvVars(newVars);
								}}
								onEnvVarAdd={() => {
									setCustomEnvVars(withBlankEnvVarRow(envVars));
								}}
								onEnvVarsReplace={(vars, disabledVars) => {
									ac.setCustomEnvVars(vars);
									ac.setCustomEnvVarsDisabled(disabledVars);
								}}
								onEnvVarsBlur={() => {
									/* Local state only */
								}}
								agentConfig={agentConfig}
								onConfigChange={(key, value) => {
									const newConfig = { ...agentConfig, [key]: value };
									if (ac.selectedAgent === 'grok') {
										setGrokConfig((prev) => ({ ...prev, [key]: value }));
									}
									ac.setAgentConfig(newConfig);
									ac.agentConfigRef.current = newConfig;
									if (mode === 'edit') {
										setConfigWasModified(true);
									}
								}}
								onConfigBlur={async () => {
									if (ac.selectedAgent) {
										await ac.saveAgentConfig(ac.selectedAgent);
										if (mode === 'edit') {
											setConfigWasModified(true);
										}
									}
								}}
								availableModels={ac.availableModels}
								loadingModels={ac.loadingModels}
								onRefreshModels={ac.refreshModels}
								dynamicOptions={ac.dynamicOptions}
								loadingDynamicOptions={ac.loadingDynamicOptions}
								onRefreshAgent={ac.refreshAgent}
								refreshingAgent={ac.refreshingAgent}
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
								compact
								showBuiltInEnvVars
							/>
						</div>
					)}
				</div>

				{/* Agent availability (edit mode: above the moderator-change note) */}
				{!isCreate && availabilitySection}

				{/* Warning about changing moderator (edit mode only) */}
				{mode === 'edit' && groupChat && ac.selectedAgent !== groupChat.moderatorAgentId && (
					<div
						className="text-xs p-3 rounded"
						style={{
							backgroundColor: `${theme.colors.warning}20`,
							color: theme.colors.warning,
							border: `1px solid ${theme.colors.warning}40`,
						}}
					>
						<strong>Note:</strong> Changing the moderator agent will restart the moderator process.
						Existing conversation history will be preserved.
					</div>
				)}

				{/* Name Input (create mode: after the moderator, before the options) */}
				{isCreate && (
					<div className="mb-6">
						<FormInput
							ref={nameInputRef}
							theme={theme}
							label="Chat Name"
							value={name}
							onChange={setName}
							onSubmit={canSubmit ? handleSubmit : undefined}
							placeholder="e.g., Auth Feature Implementation"
						/>
					</div>
				)}

				{/* Agent availability (create mode: last, below the name) */}
				{isCreate && availabilitySection}
			</div>
		</Modal>
	);
}
