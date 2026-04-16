import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { AlertTriangle, Copy, Check, X } from 'lucide-react';
import { GhostIconButton } from '../ui/GhostIconButton';
import type { AgentConfig, ToolType } from '../../types';
import type { SshRemoteConfig, AgentSshRemoteConfig } from '../../../shared/types';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';
import { validateEditSession } from '../../utils/sessionValidation';
import { FormInput } from '../ui/FormInput';
import { Modal, ModalFooter } from '../ui/Modal';
import { AgentConfigPanel } from '../shared/AgentConfigPanel';
import { SshRemoteSelector } from '../shared/SshRemoteSelector';
import { safeClipboardWrite } from '../../utils/clipboard';
import { getAgentDisplayName } from '../../../shared/agentMetadata';
import { useRemotePathValidation } from '../../hooks/agent/useRemotePathValidation';
import { NudgeMessageField } from './NudgeMessageField';
import { RemotePathStatus } from './RemotePathStatus';
import type { EditAgentModalProps } from './types';
import { SUPPORTED_AGENTS, NEW_SESSION_MESSAGE_MAX_LENGTH } from './types';

/**
 * EditAgentModal - Modal for editing an existing agent's settings
 *
 * Allows editing:
 * - Agent name
 * - Nudge message
 *
 * Does NOT allow editing:
 * - Agent provider (toolType)
 * - Working directory (projectRoot)
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
	const [nudgeMessage, setNudgeMessage] = useState('');
	const [newSessionMessage, setNewSessionMessage] = useState('');
	const [agent, setAgent] = useState<AgentConfig | null>(null);
	const [agentConfig, setAgentConfig] = useState<Record<string, any>>({});
	const [availableModels, setAvailableModels] = useState<string[]>([]);
	const [loadingModels, setLoadingModels] = useState(false);
	const [customPath, setCustomPath] = useState('');
	const [customArgs, setCustomArgs] = useState('');
	const [customEnvVars, setCustomEnvVars] = useState<Record<string, string>>({});
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

	// Load agent info, config, custom settings, and models when modal opens or provider changes
	useEffect(() => {
		if (!isOpen || !session) return;

		let stale = false;
		const activeToolType = selectedToolType;
		const isProviderSwitch = activeToolType !== session.toolType;

		// Load agent definition to get configOptions
		window.maestro.agents
			.detect()
			.then((agents: AgentConfig[]) => {
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
						.catch((err) => console.error('Failed to load models:', err))
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
			})
			.catch((err) => {
				console.error('Failed to detect agents:', err);
				if (!stale) {
					setAgent(null);
					setAvailableModels([]);
					setLoadingModels(false);
				}
			});
		// Load agent config for defaults, but use session-level overrides when available
		// Both model and contextWindow are now per-session
		window.maestro.agents
			.getConfig(activeToolType)
			.then((globalConfig) => {
				if (stale) return;
				if (isProviderSwitch) {
					// When provider changed, use global defaults for the new provider
					setAgentConfig(globalConfig);
				} else {
					// Use session-level values if set, otherwise use global defaults
					// Empty string means explicitly cleared, undefined means never set (use global default)
					const modelValue =
						session.customModel !== undefined ? session.customModel : (globalConfig.model ?? '');
					const contextWindowValue = session.customContextWindow ?? globalConfig.contextWindow;
					setAgentConfig({
						...globalConfig,
						model: modelValue,
						contextWindow: contextWindowValue,
					});
				}
			})
			.catch((err) => console.error('Failed to load agent config:', err));

		// Load SSH remote config from session (per-session, not global)
		if (session.sessionSshRemoteConfig?.enabled && session.sessionSshRemoteConfig?.remoteId) {
			setSshRemoteConfig({
				enabled: true,
				remoteId: session.sessionSshRemoteConfig.remoteId,
				workingDirOverride: session.sessionSshRemoteConfig.workingDirOverride,
				syncHistory: session.sessionSshRemoteConfig.syncHistory,
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
			.catch((err) => console.error('Failed to load SSH remotes:', err));

		// Load per-session config (stored on the session/agent instance)
		// When provider changed, clear provider-specific overrides
		if (isProviderSwitch) {
			setCustomPath('');
			setCustomArgs('');
			setCustomEnvVars({});
		} else {
			setCustomPath(session.customPath ?? '');
			setCustomArgs(session.customArgs ?? '');
			setCustomEnvVars(session.customEnvVars ?? {});
		}

		return () => {
			stale = true;
		};
	}, [isOpen, session, selectedToolType]);

	// Populate form when session changes or modal opens
	useEffect(() => {
		if (isOpen && session) {
			setInstanceName(session.name);
			setNudgeMessage(session.nudgeMessage || '');
			setNewSessionMessage(session.newSessionMessage || '');
			// Only reset if different to avoid re-triggering the config loading effect
			setSelectedToolType((prev) => (prev === session.toolType ? prev : session.toolType));
		}
	}, [isOpen, session]);

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

	// Validate remote path when SSH is enabled (debounced)
	// Prefer workingDirOverride (user-specified remote path) over session.projectRoot
	const remotePathValidation = useRemotePathValidation({
		isSshEnabled: !!isSshEnabled,
		path: sshRemoteConfig?.workingDirOverride ?? session?.projectRoot ?? '',
		sshRemoteId: sshRemoteConfig?.remoteId,
	});

	const handleSave = useCallback(() => {
		if (!session) return;
		const name = instanceName.trim();
		if (!name) return;

		// Validate before saving
		const result = validateEditSession(name, session.id, existingSessions);
		if (!result.valid) return;

		// Get model and contextWindow from agentConfig (which is updated via onConfigChange)
		// Pass empty string to explicitly clear (distinguishes from undefined = never set)
		const modelValue = agentConfig.model?.trim() ?? undefined;
		const contextWindowValue =
			typeof agentConfig.contextWindow === 'number' && agentConfig.contextWindow > 0
				? agentConfig.contextWindow
				: undefined;

		// Build per-session SSH remote config: ALWAYS pass explicitly to override any agent-level config
		// When disabled or no remoteId, we explicitly pass enabled: false to ensure local execution
		const sessionSshRemoteConfig =
			sshRemoteConfig?.enabled && sshRemoteConfig?.remoteId
				? {
						enabled: true,
						remoteId: sshRemoteConfig.remoteId,
						// Ensure workingDirOverride is set: prefer explicit override, then session's
						// projectRoot (which is the remote path the user originally configured).
						workingDirOverride:
							sshRemoteConfig.workingDirOverride || session?.projectRoot || undefined,
						syncHistory: sshRemoteConfig.syncHistory,
					}
				: { enabled: false, remoteId: null };

		// Save with per-session config fields including model, contextWindow, and SSH config
		onSave(
			session.id,
			name,
			providerChanged ? selectedToolType : undefined,
			nudgeMessage.trim() || undefined,
			newSessionMessage.trim() || undefined,
			customPath.trim() || undefined,
			customArgs.trim() || undefined,
			Object.keys(customEnvVars).length > 0 ? customEnvVars : undefined,
			modelValue,
			contextWindowValue,
			sessionSshRemoteConfig
		);
		onClose();
	}, [
		session,
		instanceName,
		nudgeMessage,
		newSessionMessage,
		customPath,
		customArgs,
		customEnvVars,
		agentConfig,
		sshRemoteConfig,
		selectedToolType,
		providerChanged,
		onSave,
		onClose,
		existingSessions,
	]);

	// Refresh available models
	const refreshModels = useCallback(async () => {
		if (!agent?.capabilities?.supportsModelSelection) return;
		setLoadingModels(true);
		try {
			const models = await window.maestro.agents.getModels(selectedToolType, true);
			setAvailableModels(models);
		} catch (err) {
			console.error('Failed to refresh models:', err);
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
			console.error('Failed to refresh agent:', error);
		} finally {
			setRefreshingAgent(false);
		}
	}, [selectedToolType]);

	// Check if form is valid for submission
	const isFormValid = useMemo(() => {
		// Remote path validation is informational only - don't block save
		// Users may want to configure SSH remote before the path exists
		return !!instanceName.trim() && validation.valid;
	}, [instanceName, validation.valid]);

	// Handle keyboard shortcuts via window listener (Modal stops propagation on its backdrop)
	useEffect(() => {
		if (!isOpen) return;
		const handler = (e: KeyboardEvent) => {
			if ((e.metaKey || e.ctrlKey) && (e.key === 'Enter' || e.key === 's') && !e.shiftKey) {
				e.preventDefault();
				if (isFormValid) {
					handleSave();
				}
			}
		};
		window.addEventListener('keydown', handler, true);
		return () => window.removeEventListener('keydown', handler, true);
	}, [isOpen, isFormValid, handleSave]);

	if (!isOpen || !session) return null;

	const agentName = getAgentDisplayName(selectedToolType);

	return (
		<Modal
			theme={theme}
			title={`Edit Agent: ${session.name}`}
			priority={MODAL_PRIORITIES.NEW_INSTANCE}
			onClose={onClose}
			width={600}
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
							className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono font-bold uppercase transition-colors hover:opacity-80"
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
				<ModalFooter
					theme={theme}
					onCancel={onClose}
					onConfirm={handleSave}
					confirmLabel="Save Changes"
					confirmDisabled={!isFormValid}
				/>
			}
		>
			<div className="space-y-5">
				{/* Agent Name */}
				<FormInput
					ref={nameInputRef}
					id="edit-agent-name-input"
					theme={theme}
					label="Agent Name"
					value={instanceName}
					onChange={setInstanceName}
					placeholder=""
					error={validation.errorField === 'name' ? validation.error : undefined}
					heightClass="p-2"
				/>

				{/* Agent Provider */}
				<div>
					<div
						className="block text-xs font-bold opacity-70 uppercase mb-2"
						style={{ color: theme.colors.textMain }}
					>
						Agent Provider
					</div>
					<select
						value={selectedToolType}
						onChange={(e) => setSelectedToolType(e.target.value as ToolType)}
						className="w-full p-2 rounded border bg-transparent outline-none text-sm"
						style={{
							borderColor: theme.colors.border,
							color: theme.colors.textMain,
							backgroundColor: theme.colors.bgMain,
						}}
					>
						{SUPPORTED_AGENTS.map((agentId) => (
							<option key={agentId} value={agentId}>
								{getAgentDisplayName(agentId)}
							</option>
						))}
					</select>
					{providerChanged && (
						<div
							className="mt-2 p-2 rounded border text-xs flex items-start gap-2"
							style={{
								borderColor: theme.colors.warning + '60',
								backgroundColor: theme.colors.warning + '10',
								color: theme.colors.warning,
							}}
						>
							<AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
							<span>
								Changing the provider will clear your session list (tabs). Your history panel data
								will persist.
							</span>
						</div>
					)}
				</div>

				{/* Working Directory (read-only) */}
				<div>
					<div
						className="block text-xs font-bold opacity-70 uppercase mb-2"
						style={{ color: theme.colors.textMain }}
					>
						Working Directory
					</div>
					<div
						className="p-2 rounded border font-mono text-sm overflow-hidden text-ellipsis"
						style={{
							borderColor: theme.colors.border,
							color: theme.colors.textDim,
							backgroundColor: theme.colors.bgActivity,
						}}
						title={session.projectRoot}
					>
						{session.projectRoot}
					</div>
					<p className="mt-1 text-xs" style={{ color: theme.colors.textDim }}>
						Directory cannot be changed. Create a new agent for a different directory.
					</p>
					{/* Remote path validation status (only shown when SSH is enabled) */}
					{isSshEnabled && (
						<RemotePathStatus
							theme={theme}
							validation={remotePathValidation}
							remoteHost={sshRemoteHost || 'remote'}
						/>
					)}
				</div>

				{/* New Session Message */}
				<NudgeMessageField
					theme={theme}
					value={newSessionMessage}
					onChange={setNewSessionMessage}
					maxLength={NEW_SESSION_MESSAGE_MAX_LENGTH}
					label="New Session Message"
					description="This text is prefixed to your first message whenever a new session is created (not visible in chat)."
					placeholder="Instructions sent with the first message of every new session..."
				/>

				{/* Nudge Message */}
				<NudgeMessageField theme={theme} value={nudgeMessage} onChange={setNudgeMessage} />

				{/* Agent Configuration (custom path, args, env vars, agent-specific settings) */}
				{/* Per-session config (path, args, env vars) saved on modal save, not on blur */}
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
							customEnvVars={customEnvVars}
							onEnvVarKeyChange={(oldKey, newKey, value) => {
								const newVars = { ...customEnvVars };
								delete newVars[oldKey];
								newVars[newKey] = value;
								setCustomEnvVars(newVars);
							}}
							onEnvVarValueChange={(key, value) => {
								setCustomEnvVars((prev) => ({ ...prev, [key]: value }));
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
								setCustomEnvVars((prev) => ({ ...prev, [newKey]: '' }));
							}}
							onEnvVarsBlur={() => {
								/* Saved on modal save */
							}}
							agentConfig={agentConfig}
							onConfigChange={(key, value) => {
								setAgentConfig((prev) => ({ ...prev, [key]: value }));
							}}
							onConfigBlur={(key, value) => {
								// Both model and contextWindow are now saved per-session on modal save
								// Other config options (if any) can still be saved at agent level
								const updatedConfig = { ...agentConfig, [key]: value };
								const {
									model: _model,
									contextWindow: _contextWindow,
									...otherConfig
								} = updatedConfig;
								if (Object.keys(otherConfig).length > 0) {
									void window.maestro.agents
										.setConfig(selectedToolType, otherConfig)
										.catch((error) => {
											console.error(`Failed to persist config for ${selectedToolType}:`, error);
										});
								}
							}}
							availableModels={availableModels}
							loadingModels={loadingModels}
							onRefreshModels={refreshModels}
							dynamicOptions={editDynamicOptions}
							loadingDynamicOptions={editLoadingDynamicOptions}
							onRefreshAgent={handleRefreshAgent}
							refreshingAgent={refreshingAgent}
							showBuiltInEnvVars
							isSshEnabled={isSshEnabled}
						/>
					</div>
				)}

				{/* SSH Remote Execution - Top Level */}
				{sshRemotes.length > 0 && (
					<SshRemoteSelector
						theme={theme}
						sshRemotes={sshRemotes}
						sshRemoteConfig={sshRemoteConfig}
						onSshRemoteConfigChange={setSshRemoteConfig}
					/>
				)}
			</div>
		</Modal>
	);
}
