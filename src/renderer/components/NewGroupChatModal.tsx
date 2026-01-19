/**
 * NewGroupChatModal.tsx
 *
 * Modal for creating a new Group Chat. Allows user to:
 * - Select a moderator agent from available agents
 * - Customize moderator settings (CLI args, path, ENV vars)
 * - Enter a name for the group chat
 *
 * Only shows agents that are both supported by Maestro and detected on the system.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { Check, X, Settings, ArrowLeft } from 'lucide-react';
import type { Theme, AgentConfig, ModeratorConfig } from '../types';
import type { SshRemoteConfig, AgentSshRemoteConfig } from '../../shared/types';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { Modal, ModalFooter, FormInput } from './ui';
import { AgentLogo, AGENT_TILES } from './Wizard/screens/AgentSelectionScreen';
import { AgentConfigPanel } from './shared/AgentConfigPanel';
import { SshRemoteSelector } from './shared/SshRemoteSelector';

interface NewGroupChatModalProps {
	theme: Theme;
	isOpen: boolean;
	onClose: () => void;
	onCreate: (name: string, moderatorAgentId: string, moderatorConfig?: ModeratorConfig) => void;
}

export function NewGroupChatModal({
	theme,
	isOpen,
	onClose,
	onCreate,
}: NewGroupChatModalProps): JSX.Element | null {
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

	// SSH Remote configuration state
	const [sshRemotes, setSshRemotes] = useState<SshRemoteConfig[]>([]);
	const [sshRemoteConfig, setSshRemoteConfig] = useState<AgentSshRemoteConfig | undefined>(
		undefined
	);

	const nameInputRef = useRef<HTMLInputElement>(null);
	// Ref to track latest agentConfig for async save operations
	const agentConfigRef = useRef<Record<string, any>>({});

	// Reset all state when modal closes
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

				// Auto-select first available supported agent
				if (available.length > 0) {
					// Find first agent that is both supported in AGENT_TILES and detected
					const firstSupported = AGENT_TILES.find((tile) => {
						if (!tile.supported) return false;
						return available.some((a: AgentConfig) => a.id === tile.id);
					});
					if (firstSupported) {
						setSelectedAgent(firstSupported.id);
					} else if (available.length > 0) {
						setSelectedAgent(available[0].id);
					}
				}
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

	const handleCreate = useCallback(() => {
		if (name.trim() && selectedAgent) {
			const moderatorConfig = buildModeratorConfig();
			onCreate(name.trim(), selectedAgent, moderatorConfig);
			resetState();
			onClose();
		}
	}, [name, selectedAgent, buildModeratorConfig, onCreate, resetState, onClose]);

	const canCreate = name.trim().length > 0 && selectedAgent !== null;

	// Open configuration panel for the selected agent
	const handleOpenConfig = useCallback(async () => {
		if (!selectedAgent) return;

		// Load agent config
		const config = await window.maestro.agents.getConfig(selectedAgent);
		setAgentConfig(config || {});
		agentConfigRef.current = config || {};

		// Load models if agent supports it
		const agent = detectedAgents.find((a) => a.id === selectedAgent);
		if (agent?.capabilities?.supportsModelSelection) {
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

	if (!isOpen) return null;

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
				priority={MODAL_PRIORITIES.NEW_GROUP_CHAT}
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
						}}
						onConfigBlur={async () => {
							if (selectedAgent) {
								// Use ref to get latest config (state may be stale in async callback)
								await window.maestro.agents.setConfig(selectedAgent, agentConfigRef.current);
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
			title="New Group Chat"
			priority={MODAL_PRIORITIES.NEW_GROUP_CHAT}
			onClose={onClose}
			initialFocusRef={nameInputRef}
			width={600}
			customHeader={
				<div
					className="p-4 border-b flex items-center justify-between shrink-0"
					style={{ borderColor: theme.colors.border }}
				>
					<div className="flex items-center gap-3">
						<h2 className="text-sm font-bold" style={{ color: theme.colors.textMain }}>
							New Group Chat
						</h2>
						<span
							className="text-[10px] font-semibold tracking-wide uppercase px-2 py-0.5 rounded"
							style={{
								backgroundColor: `${theme.colors.accent}20`,
								color: theme.colors.accent,
								border: `1px solid ${theme.colors.accent}40`,
							}}
						>
							Beta
						</span>
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
					onCancel={onClose}
					onConfirm={handleCreate}
					confirmLabel="Create"
					confirmDisabled={!canCreate}
				/>
			}
		>
			<div
				className={`transition-opacity duration-150 ${isTransitioning ? 'opacity-0' : 'opacity-100'}`}
			>
				{/* Description */}
				<div className="mb-6 text-sm leading-relaxed" style={{ color: theme.colors.textDim }}>
					A Group Chat lets you collaborate with multiple AI agents in a single conversation. The{' '}
					<span style={{ color: theme.colors.textMain }}>moderator</span> manages the conversation
					flow, deciding when to involve other agents. You can{' '}
					<span style={{ color: theme.colors.accent }}>@mention</span> any agent defined in Maestro
					to bring them into the discussion. We're still working on this feature, but right now
					Claude appears to be the best performing moderator.
				</div>

				{/* Agent Selection */}
				<div className="mb-6">
					<label
						className="block text-sm font-medium mb-3"
						style={{ color: theme.colors.textMain }}
					>
						Select Moderator
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
					<div className="mb-6">
						<SshRemoteSelector
							theme={theme}
							sshRemotes={sshRemotes}
							sshRemoteConfig={sshRemoteConfig}
							onSshRemoteConfigChange={setSshRemoteConfig}
						/>
					</div>
				)}

				{/* Name Input */}
				<FormInput
					ref={nameInputRef}
					theme={theme}
					label="Chat Name"
					value={name}
					onChange={setName}
					onSubmit={canCreate ? handleCreate : undefined}
					placeholder="e.g., Auth Feature Implementation"
				/>
			</div>
		</Modal>
	);
}
