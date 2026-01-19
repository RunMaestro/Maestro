/**
 * EditGroupChatModal.tsx
 *
 * Modal for editing an existing Group Chat. Allows user to:
 * - Change the name of the group chat
 * - Change the moderator agent
 * - Customize moderator settings (CLI args, path, ENV vars)
 *
 * Similar to NewGroupChatModal but pre-populated with existing values.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { Check, X, Settings, ArrowLeft } from 'lucide-react';
import type { Theme, AgentConfig, ModeratorConfig, GroupChat } from '../types';
import type { SshRemoteConfig, AgentSshRemoteConfig } from '../../shared/types';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { Modal, ModalFooter, FormInput } from './ui';
import { AgentLogo, AGENT_TILES } from './Wizard/screens/AgentSelectionScreen';
import { AgentConfigPanel } from './shared/AgentConfigPanel';
import { SshRemoteSelector } from './shared/SshRemoteSelector';

interface EditGroupChatModalProps {
	theme: Theme;
	isOpen: boolean;
	groupChat: GroupChat | null;
	onClose: () => void;
	onSave: (
		id: string,
		name: string,
		moderatorAgentId: string,
		moderatorConfig?: ModeratorConfig
	) => void;
}

export function EditGroupChatModal({
	theme,
	isOpen,
	groupChat,
	onClose,
	onSave,
}: EditGroupChatModalProps): JSX.Element | null {
	const [name, setName] = useState('');
	const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
	const [detectedAgents, setDetectedAgents] = useState<AgentConfig[]>([]);
	const [isDetecting, setIsDetecting] = useState(true);

	// View mode for switching between grid and config
	const [viewMode, setViewMode] = useState<'grid' | 'config'>('grid');
	const [isTransitioning, setIsTransitioning] = useState(false);

	// Custom moderator configuration state
	const [customPath, setCustomPath] = useState('');
	const [customArgs, setCustomArgs] = useState('');
	const [customEnvVars, setCustomEnvVars] = useState<Record<string, string>>({});
	const [agentConfig, setAgentConfig] = useState<Record<string, any>>({});
	const [availableModels, setAvailableModels] = useState<string[]>([]);
	const [loadingModels, setLoadingModels] = useState(false);
	const [refreshingAgent, setRefreshingAgent] = useState(false);
	// Track if user has visited/modified the config panel (agent-level settings like model)
	const [configWasModified, setConfigWasModified] = useState(false);

	// SSH Remote configuration state
	const [sshRemotes, setSshRemotes] = useState<SshRemoteConfig[]>([]);
	const [sshRemoteConfig, setSshRemoteConfig] = useState<AgentSshRemoteConfig | undefined>(
		undefined
	);

	const nameInputRef = useRef<HTMLInputElement>(null);
	// Ref to track latest agentConfig for async save operations
	const agentConfigRef = useRef<Record<string, any>>({});

	// Initialize state from groupChat when modal opens
	useEffect(() => {
		if (!isOpen || !groupChat) {
			return;
		}

		// Pre-populate from existing group chat
		setName(groupChat.name);
		setSelectedAgent(groupChat.moderatorAgentId);
		setCustomPath(groupChat.moderatorConfig?.customPath || '');
		setCustomArgs(groupChat.moderatorConfig?.customArgs || '');
		setCustomEnvVars(groupChat.moderatorConfig?.customEnvVars || {});
		setViewMode('grid');
		setIsTransitioning(false);
		setAgentConfig({});
		setAvailableModels([]);
		setLoadingModels(false);
		setRefreshingAgent(false);
	}, [isOpen, groupChat]);

	// Reset state when modal closes
	const resetState = useCallback(() => {
		setName('');
		setSelectedAgent(null);
		setIsDetecting(true);
		setViewMode('grid');
		setIsTransitioning(false);
		setCustomPath('');
		setCustomArgs('');
		setCustomEnvVars({});
		setAgentConfig({});
		setAvailableModels([]);
		setLoadingModels(false);
		setRefreshingAgent(false);
		setConfigWasModified(false);
		setSshRemoteConfig(undefined);
	}, []);

	// Detect agents on mount
	useEffect(() => {
		if (!isOpen) {
			resetState();
			return;
		}

		async function detect() {
			try {
				const agents = await window.maestro.agents.detect();
				const available = agents.filter((a: AgentConfig) => a.available && !a.hidden);
				setDetectedAgents(available);
			} catch (error) {
				console.error('Failed to detect agents:', error);
			} finally {
				setIsDetecting(false);
			}
		}

		async function loadSshRemotes() {
			try {
				const configsResult = await window.maestro.sshRemote.getConfigs();
				if (configsResult.success && configsResult.configs) {
					setSshRemotes(configsResult.configs);
				}
			} catch (error) {
				console.error('Failed to load SSH remotes:', error);
			}
		}

		detect();
		loadSshRemotes();
	}, [isOpen, resetState]);

	// Focus name input when agents detected
	useEffect(() => {
		if (!isDetecting && isOpen && viewMode === 'grid') {
			nameInputRef.current?.focus();
		}
	}, [isDetecting, isOpen, viewMode]);

	// Build moderator config from state
	const buildModeratorConfig = useCallback((): ModeratorConfig | undefined => {
		const hasConfig = customPath || customArgs || Object.keys(customEnvVars).length > 0;
		if (!hasConfig) return undefined;

		return {
			customPath: customPath || undefined,
			customArgs: customArgs || undefined,
			customEnvVars: Object.keys(customEnvVars).length > 0 ? customEnvVars : undefined,
		};
	}, [customPath, customArgs, customEnvVars]);

	const handleSave = useCallback(() => {
		if (name.trim() && selectedAgent && groupChat) {
			const moderatorConfig = buildModeratorConfig();
			onSave(groupChat.id, name.trim(), selectedAgent, moderatorConfig);
			resetState();
			onClose();
		}
	}, [name, selectedAgent, groupChat, buildModeratorConfig, onSave, resetState, onClose]);

	// Check if anything has changed
	const hasChanges = useCallback((): boolean => {
		if (!groupChat) return false;

		const nameChanged = name.trim() !== groupChat.name;
		const agentChanged = selectedAgent !== groupChat.moderatorAgentId;
		const pathChanged = customPath !== (groupChat.moderatorConfig?.customPath || '');
		const argsChanged = customArgs !== (groupChat.moderatorConfig?.customArgs || '');

		const originalEnvVars = groupChat.moderatorConfig?.customEnvVars || {};
		const envVarsChanged = JSON.stringify(customEnvVars) !== JSON.stringify(originalEnvVars);

		// Also consider changes if user modified agent-level config (model, etc.)
		return (
			nameChanged ||
			agentChanged ||
			pathChanged ||
			argsChanged ||
			envVarsChanged ||
			configWasModified
		);
	}, [groupChat, name, selectedAgent, customPath, customArgs, customEnvVars, configWasModified]);

	const canSave = name.trim().length > 0 && selectedAgent !== null && hasChanges();

	// Open configuration panel for the selected agent
	const handleOpenConfig = useCallback(async () => {
		if (!selectedAgent) return;

		// Load agent config
		const config = await window.maestro.agents.getConfig(selectedAgent);
		setAgentConfig(config || {});
		agentConfigRef.current = config || {};

		// Load models if agent supports it
		const agent = detectedAgents.find((a) => a.id === selectedAgent);
		// Note: capabilities is added by agent-detector but not in the TypeScript type
		if ((agent as any)?.capabilities?.supportsModelSelection) {
			setLoadingModels(true);
			try {
				const models = await window.maestro.agents.getModels(selectedAgent);
				setAvailableModels(models);
			} catch (err) {
				console.error('Failed to load models:', err);
			} finally {
				setLoadingModels(false);
			}
		}

		// Transition to config view
		setIsTransitioning(true);
		setTimeout(() => {
			setViewMode('config');
			setIsTransitioning(false);
		}, 150);
	}, [selectedAgent, detectedAgents]);

	// Close configuration panel
	const handleCloseConfig = useCallback(() => {
		setIsTransitioning(true);
		setTimeout(() => {
			setViewMode('grid');
			setIsTransitioning(false);
		}, 150);
	}, []);

	// Refresh agent detection after config changes
	const refreshAgentDetection = useCallback(async () => {
		const agents = await window.maestro.agents.detect();
		const visible = agents.filter((a: AgentConfig) => !a.hidden);
		setDetectedAgents(visible.filter((a) => a.available));
	}, []);

	// Handle refresh for agent in config panel
	const handleRefreshAgent = useCallback(async () => {
		setRefreshingAgent(true);
		try {
			await refreshAgentDetection();
		} finally {
			setRefreshingAgent(false);
		}
	}, [refreshAgentDetection]);

	// Handle model refresh
	const handleRefreshModels = useCallback(async () => {
		if (!selectedAgent) return;
		setLoadingModels(true);
		try {
			const models = await window.maestro.agents.getModels(selectedAgent, true);
			setAvailableModels(models);
		} catch (err) {
			console.error('Failed to refresh models:', err);
		} finally {
			setLoadingModels(false);
		}
	}, [selectedAgent]);

	if (!isOpen || !groupChat) return null;

	// Filter AGENT_TILES to only show supported + detected agents
	const availableTiles = AGENT_TILES.filter((tile) => {
		if (!tile.supported) return false;
		return detectedAgents.some((a: AgentConfig) => a.id === tile.id);
	});

	// Get selected agent info
	const selectedAgentConfig = detectedAgents.find((a) => a.id === selectedAgent);
	const selectedTile = AGENT_TILES.find((t) => t.id === selectedAgent);

	// Check if there's any customization set
	const hasCustomization = customPath || customArgs || Object.keys(customEnvVars).length > 0;

	// Render configuration view
	if (viewMode === 'config' && selectedAgentConfig && selectedTile) {
		return (
			<Modal
				theme={theme}
				title={`Configure ${selectedTile.name}`}
				priority={MODAL_PRIORITIES.EDIT_GROUP_CHAT}
				onClose={onClose}
				width={600}
				customHeader={
					<div
						className="p-4 border-b flex items-center justify-between shrink-0"
						style={{ borderColor: theme.colors.border }}
					>
						<div className="flex items-center gap-3">
							<button
								onClick={handleCloseConfig}
								className="flex items-center gap-1 px-2 py-1 rounded hover:bg-white/10 transition-colors"
								style={{ color: theme.colors.textDim }}
							>
								<ArrowLeft className="w-4 h-4" />
								Back
							</button>
							<h2 className="text-sm font-bold" style={{ color: theme.colors.textMain }}>
								Configure {selectedTile.name}
							</h2>
						</div>
						<button
							type="button"
							onClick={onClose}
							className="p-1 rounded hover:bg-white/10 transition-colors"
							style={{ color: theme.colors.textDim }}
							aria-label="Close modal"
						>
							<X className="w-4 h-4" />
						</button>
					</div>
				}
				footer={
					<ModalFooter
						theme={theme}
						onCancel={handleCloseConfig}
						cancelLabel="Back"
						onConfirm={handleCloseConfig}
						confirmLabel="Done"
					/>
				}
			>
				<div
					className={`transition-opacity duration-150 ${isTransitioning ? 'opacity-0' : 'opacity-100'}`}
				>
					<AgentConfigPanel
						theme={theme}
						agent={selectedAgentConfig}
						customPath={customPath}
						onCustomPathChange={setCustomPath}
						onCustomPathBlur={() => {
							/* Local state only */
						}}
						onCustomPathClear={() => setCustomPath('')}
						customArgs={customArgs}
						onCustomArgsChange={setCustomArgs}
						onCustomArgsBlur={() => {
							/* Local state only */
						}}
						onCustomArgsClear={() => setCustomArgs('')}
						customEnvVars={customEnvVars}
						onEnvVarKeyChange={(oldKey, newKey, value) => {
							const newVars = { ...customEnvVars };
							delete newVars[oldKey];
							newVars[newKey] = value;
							setCustomEnvVars(newVars);
						}}
						onEnvVarValueChange={(key, value) => {
							setCustomEnvVars({ ...customEnvVars, [key]: value });
						}}
						onEnvVarRemove={(key) => {
							const newVars = { ...customEnvVars };
							delete newVars[key];
							setCustomEnvVars(newVars);
						}}
						onEnvVarAdd={() => {
							let newKey = 'NEW_VAR';
							let counter = 1;
							while (customEnvVars[newKey]) {
								newKey = `NEW_VAR_${counter}`;
								counter++;
							}
							setCustomEnvVars({ ...customEnvVars, [newKey]: '' });
						}}
						onEnvVarsBlur={() => {
							/* Local state only */
						}}
						agentConfig={agentConfig}
						onConfigChange={(key, value) => {
							const newConfig = { ...agentConfig, [key]: value };
							setAgentConfig(newConfig);
							agentConfigRef.current = newConfig;
							setConfigWasModified(true);
						}}
						onConfigBlur={async () => {
							if (selectedAgent) {
								// Use ref to get latest config (state may be stale in async callback)
								await window.maestro.agents.setConfig(selectedAgent, agentConfigRef.current);
								setConfigWasModified(true);
							}
						}}
						availableModels={availableModels}
						loadingModels={loadingModels}
						onRefreshModels={handleRefreshModels}
						onRefreshAgent={handleRefreshAgent}
						refreshingAgent={refreshingAgent}
						compact
						showBuiltInEnvVars
					/>
				</div>
			</Modal>
		);
	}

	// Render grid view
	return (
		<Modal
			theme={theme}
			title="Edit Group Chat"
			priority={MODAL_PRIORITIES.EDIT_GROUP_CHAT}
			onClose={onClose}
			initialFocusRef={nameInputRef}
			width={600}
			footer={
				<ModalFooter
					theme={theme}
					onCancel={onClose}
					onConfirm={handleSave}
					confirmLabel="Save"
					confirmDisabled={!canSave}
				/>
			}
		>
			<div
				className={`transition-opacity duration-150 ${isTransitioning ? 'opacity-0' : 'opacity-100'}`}
			>
				{/* Name Input */}
				<div className="mb-6">
					<FormInput
						ref={nameInputRef}
						theme={theme}
						label="Chat Name"
						value={name}
						onChange={setName}
						onSubmit={canSave ? handleSave : undefined}
						placeholder="e.g., Auth Feature Implementation"
					/>
				</div>

				{/* Agent Selection */}
				<div className="mb-4">
					<label
						className="block text-sm font-medium mb-3"
						style={{ color: theme.colors.textMain }}
					>
						Moderator Agent
					</label>

					{isDetecting ? (
						<div className="flex items-center justify-center py-8">
							<div
								className="w-6 h-6 border-2 border-t-transparent rounded-full animate-spin"
								style={{ borderColor: theme.colors.accent, borderTopColor: 'transparent' }}
							/>
						</div>
					) : availableTiles.length === 0 ? (
						<div className="text-center py-8 text-sm" style={{ color: theme.colors.textDim }}>
							No agents available. Please install Claude Code, OpenCode, or Codex.
						</div>
					) : (
						<div className="grid grid-cols-3 gap-3">
							{availableTiles.map((tile) => {
								const isSelected = selectedAgent === tile.id;

								return (
									<div
										key={tile.id}
										role="button"
										tabIndex={0}
										onClick={() => setSelectedAgent(tile.id)}
										onKeyDown={(e) => {
											if (e.key === 'Enter' || e.key === ' ') {
												e.preventDefault();
												setSelectedAgent(tile.id);
											}
										}}
										className="relative flex flex-col items-center p-4 pb-10 rounded-lg border-2 transition-all outline-none cursor-pointer"
										style={{
											backgroundColor: isSelected ? `${tile.brandColor}15` : theme.colors.bgMain,
											borderColor: isSelected ? tile.brandColor : theme.colors.border,
										}}
									>
										{isSelected && (
											<div
												className="absolute top-2 right-2 w-5 h-5 rounded-full flex items-center justify-center"
												style={{ backgroundColor: tile.brandColor }}
											>
												<Check className="w-3 h-3 text-white" />
											</div>
										)}
										<AgentLogo
											agentId={tile.id}
											supported={true}
											detected={true}
											brandColor={tile.brandColor}
											theme={theme}
										/>
										<span
											className="mt-2 text-sm font-medium"
											style={{ color: theme.colors.textMain }}
										>
											{tile.name}
										</span>

										{/* Customize button */}
										<button
											onClick={(e) => {
												e.stopPropagation();
												setSelectedAgent(tile.id);
												// Small delay to update selection before opening config
												setTimeout(() => handleOpenConfig(), 50);
											}}
											className="absolute bottom-2 left-1/2 -translate-x-1/2 flex items-center gap-1 px-2 py-1 rounded text-[10px] hover:bg-white/10 transition-colors"
											style={{
												color:
													isSelected && hasCustomization ? tile.brandColor : theme.colors.textDim,
											}}
											title="Customize moderator settings"
										>
											<Settings className="w-3 h-3" />
											Customize
											{isSelected && hasCustomization && (
												<span
													className="w-1.5 h-1.5 rounded-full ml-0.5"
													style={{ backgroundColor: tile.brandColor }}
												/>
											)}
										</button>
									</div>
								);
							})}
						</div>
					)}
				</div>

				{/* SSH Remote Execution - Top Level */}
				{sshRemotes.length > 0 && (
					<div className="mb-4">
						<SshRemoteSelector
							theme={theme}
							sshRemotes={sshRemotes}
							sshRemoteConfig={sshRemoteConfig}
							onSshRemoteConfigChange={setSshRemoteConfig}
						/>
					</div>
				)}

				{/* Warning about changing moderator */}
				{groupChat && selectedAgent !== groupChat.moderatorAgentId && (
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
			</div>
		</Modal>
	);
}
