/**
 * SshRemoteModal - Modal for adding/editing SSH remote configurations
 *
 * This modal provides a form for configuring SSH remotes that can be used
 * to execute AI agents on remote hosts. Supports:
 * - Host/port configuration
 * - Username and private key path
 * - Optional remote working directory
 * - Environment variables for remote execution
 * - Connection testing before saving
 * - Importing from ~/.ssh/config (auto-detect SSH config hosts)
 *
 * Usage:
 * ```tsx
 * <SshRemoteModal
 *   theme={theme}
 *   isOpen={showModal}
 *   onClose={() => setShowModal(false)}
 *   onSave={handleSaveConfig}
 *   initialConfig={editingConfig} // Optional for editing
 * />
 * ```
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
	Server,
	Plus,
	Trash2,
	CheckCircle,
	XCircle,
	Loader2,
	FileCode,
	ChevronDown,
} from 'lucide-react';
import type { Theme } from '../../types';
import type { SshRemoteConfig, SshRemoteTestResult } from '../../../shared/types';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';
import { Modal, ModalFooter } from '../ui/Modal';
import { FormInput } from '../ui/FormInput';

/**
 * SSH config host entry from ~/.ssh/config
 */
interface SshConfigHost {
	host: string;
	hostName?: string;
	port?: number;
	user?: string;
	identityFile?: string;
	proxyJump?: string;
}

/**
 * Environment variable entry with stable ID for editing
 */
interface EnvVarEntry {
	id: number;
	key: string;
	value: string;
}

export interface SshRemoteModalProps {
	/** Theme object for styling */
	theme: Theme;
	/** Whether the modal is open */
	isOpen: boolean;
	/** Callback when modal is closed */
	onClose: () => void;
	/** Callback when configuration is saved. Returns the saved config or error */
	onSave: (config: Partial<SshRemoteConfig>) => Promise<{
		success: boolean;
		config?: SshRemoteConfig;
		error?: string;
	}>;
	/** Optional callback to test connection before saving */
	onTestConnection?: (config: SshRemoteConfig) => Promise<{
		success: boolean;
		result?: SshRemoteTestResult;
		error?: string;
	}>;
	/** Optional initial configuration for editing */
	initialConfig?: SshRemoteConfig;
	/** Modal title override */
	title?: string;
}

/**
 * Convert environment variable object to array with stable IDs
 */
function envVarsToArray(envVars?: Record<string, string>): EnvVarEntry[] {
	if (!envVars) return [];
	return Object.entries(envVars).map(([key, value], index) => ({
		id: index,
		key,
		value,
	}));
}

/**
 * Convert environment variable array back to object
 */
function envVarsToObject(entries: EnvVarEntry[]): Record<string, string> {
	const result: Record<string, string> = {};
	entries.forEach((entry) => {
		if (entry.key.trim()) {
			result[entry.key] = entry.value;
		}
	});
	return result;
}

/**
 * Get a display summary for an SSH config host
 */
function getSshConfigHostSummary(host: SshConfigHost): string {
	const parts: string[] = [];
	if (host.user && host.hostName) {
		parts.push(`${host.user}@${host.hostName}`);
	} else if (host.hostName) {
		parts.push(host.hostName);
	} else if (host.user) {
		parts.push(`${host.user}@...`);
	}
	if (host.port && host.port !== 22) {
		parts.push(`port ${host.port}`);
	}
	if (host.identityFile) {
		const keyName = host.identityFile.split('/').pop() || host.identityFile;
		parts.push(`key: ${keyName}`);
	}
	return parts.join(', ') || 'No details available';
}

export function SshRemoteModal({
	theme,
	isOpen,
	onClose,
	onSave,
	onTestConnection,
	initialConfig,
	title,
}: SshRemoteModalProps) {
	// Form state
	const [name, setName] = useState('');
	const [host, setHost] = useState('');
	const [port, setPort] = useState('22');
	const [username, setUsername] = useState('');
	const [privateKeyPath, setPrivateKeyPath] = useState('');
	const [envVars, setEnvVars] = useState<EnvVarEntry[]>([]);
	const [enabled, setEnabled] = useState(true);
	const [nextEnvVarId, setNextEnvVarId] = useState(0);
	const [useSshConfig, setUseSshConfig] = useState(false);
	const [sshConfigHost, setSshConfigHost] = useState<string | undefined>(undefined);

	// SSH config state
	const [sshConfigHosts, setSshConfigHosts] = useState<SshConfigHost[]>([]);
	const [sshConfigLoading, setSshConfigLoading] = useState(false);
	const [showSshConfigDropdown, setShowSshConfigDropdown] = useState(false);
	const [sshConfigFilter, setSshConfigFilter] = useState('');
	const [sshConfigHighlightIndex, setSshConfigHighlightIndex] = useState(0);

	// UI state
	const [saving, setSaving] = useState(false);
	const [testing, setTesting] = useState(false);
	const [testResult, setTestResult] = useState<{
		success: boolean;
		message: string;
		hostname?: string;
	} | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [showEnvVars, setShowEnvVars] = useState(false);

	// Refs
	const nameInputRef = useRef<HTMLInputElement>(null);
	const dropdownRef = useRef<HTMLDivElement>(null);
	const filterInputRef = useRef<HTMLInputElement>(null);

	// Load SSH config hosts when modal opens
	useEffect(() => {
		if (isOpen && !initialConfig) {
			setSshConfigLoading(true);
			window.maestro.sshRemote
				.getSshConfigHosts()
				.then((result) => {
					if (result.success && result.hosts) {
						setSshConfigHosts(result.hosts);
					}
				})
				.catch(() => {
					// Silently ignore errors - SSH config is optional
				})
				.finally(() => {
					setSshConfigLoading(false);
				});
		}
	}, [isOpen, initialConfig]);

	// Close dropdown when clicking outside
	useEffect(() => {
		const handleClickOutside = (event: MouseEvent) => {
			if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
				setShowSshConfigDropdown(false);
			}
		};
		document.addEventListener('mousedown', handleClickOutside);
		return () => document.removeEventListener('mousedown', handleClickOutside);
	}, []);

	// Reset filter and highlight when dropdown opens, focus filter input
	useEffect(() => {
		if (showSshConfigDropdown) {
			setSshConfigFilter('');
			setSshConfigHighlightIndex(0);
			// Focus filter input after dropdown renders
			setTimeout(() => filterInputRef.current?.focus(), 0);
		}
	}, [showSshConfigDropdown]);

	// Filter SSH config hosts based on search input
	const filteredSshConfigHosts = sshConfigHosts.filter((host) => {
		if (!sshConfigFilter) return true;
		const filterLower = sshConfigFilter.toLowerCase();
		const summary = getSshConfigHostSummary(host).toLowerCase();
		return (
			host.host.toLowerCase().includes(filterLower) ||
			summary.includes(filterLower) ||
			host.hostName?.toLowerCase().includes(filterLower) ||
			host.user?.toLowerCase().includes(filterLower)
		);
	});

	// Reset highlight index when filter changes
	useEffect(() => {
		setSshConfigHighlightIndex(0);
	}, [sshConfigFilter]);

	// Handle keyboard navigation in dropdown
	const handleDropdownKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === 'Escape') {
			e.preventDefault();
			e.stopPropagation();
			setShowSshConfigDropdown(false);
		} else if (e.key === 'ArrowDown') {
			e.preventDefault();
			setSshConfigHighlightIndex((prev) =>
				prev < filteredSshConfigHosts.length - 1 ? prev + 1 : prev
			);
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			setSshConfigHighlightIndex((prev) => (prev > 0 ? prev - 1 : 0));
		} else if (e.key === 'Enter') {
			e.preventDefault();
			if (filteredSshConfigHosts.length > 0 && filteredSshConfigHosts[sshConfigHighlightIndex]) {
				handleSelectSshConfigHost(filteredSshConfigHosts[sshConfigHighlightIndex]);
			}
		}
	};

	// Reset form when modal opens/closes or initialConfig changes
	useEffect(() => {
		if (isOpen) {
			if (initialConfig) {
				setName(initialConfig.name);
				setHost(initialConfig.host);
				setPort(String(initialConfig.port));
				setUsername(initialConfig.username);
				setPrivateKeyPath(initialConfig.privateKeyPath);
				const entries = envVarsToArray(initialConfig.remoteEnv);
				setEnvVars(entries);
				setNextEnvVarId(entries.length);
				setEnabled(initialConfig.enabled);
				setShowEnvVars(entries.length > 0);
				setUseSshConfig(initialConfig.useSshConfig || false);
				setSshConfigHost(initialConfig.sshConfigHost);
			} else {
				// Reset to defaults for new config
				setName('');
				setHost('');
				setPort('22');
				setUsername('');
				setPrivateKeyPath('');
				setEnvVars([]);
				setNextEnvVarId(0);
				setEnabled(true);
				setShowEnvVars(false);
				setUseSshConfig(false);
				setSshConfigHost(undefined);
			}
			setError(null);
			setTestResult(null);
		}
	}, [isOpen, initialConfig]);

	// Validation
	const validateForm = useCallback((): string | null => {
		if (!name.trim()) return 'Name is required';
		if (!host.trim()) return 'Host is required';
		const portNum = parseInt(port, 10);
		if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
			return 'Port must be between 1 and 65535';
		}
		// Username and key are always optional - SSH will use defaults from config or ssh-agent
		return null;
	}, [name, host, port]);

	const isValid = validateForm() === null;

	// Build config object from form state
	const buildConfig = useCallback((): SshRemoteConfig => {
		return {
			id: initialConfig?.id || '',
			name: name.trim(),
			host: host.trim(),
			port: parseInt(port, 10),
			username: username.trim(),
			privateKeyPath: privateKeyPath.trim(),
			remoteEnv:
				Object.keys(envVarsToObject(envVars)).length > 0 ? envVarsToObject(envVars) : undefined,
			enabled,
			useSshConfig,
			sshConfigHost,
		};
	}, [
		initialConfig,
		name,
		host,
		port,
		username,
		privateKeyPath,
		envVars,
		enabled,
		useSshConfig,
		sshConfigHost,
	]);

	// Handle selecting an SSH config host
	// This imports values as a template - user can edit freely and choose whether to use SSH config mode
	const handleSelectSshConfigHost = (configHost: SshConfigHost) => {
		// Pre-fill the host pattern (this is what SSH will connect to)
		setHost(configHost.host);
		// Use host pattern as default display name
		if (!name.trim()) setName(configHost.host);
		// Pre-fill other values from SSH config as defaults
		if (configHost.port) setPort(String(configHost.port));
		if (configHost.user) setUsername(configHost.user);
		if (configHost.identityFile) setPrivateKeyPath(configHost.identityFile);
		// Enable SSH config mode since we're importing from it
		// User can disable this if they want to override everything manually
		setUseSshConfig(true);
		setSshConfigHost(configHost.host);
		setShowSshConfigDropdown(false);
	};

	// Handle save
	const handleSave = async () => {
		const validationError = validateForm();
		if (validationError) {
			setError(validationError);
			return;
		}

		setSaving(true);
		setError(null);

		try {
			const config = buildConfig();
			const result = await onSave(config);
			if (result.success) {
				onClose();
			} else {
				setError(result.error || 'Failed to save configuration');
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Failed to save configuration');
		} finally {
			setSaving(false);
		}
	};

	// Handle test connection
	const handleTestConnection = async () => {
		if (!onTestConnection) return;

		const validationError = validateForm();
		if (validationError) {
			setError(validationError);
			return;
		}

		setTesting(true);
		setError(null);
		setTestResult(null);

		try {
			const config = buildConfig();
			const result = await onTestConnection(config);
			if (result.success && result.result) {
				setTestResult({
					success: true,
					message: 'Connection successful!',
					hostname: result.result.remoteInfo?.hostname,
				});
			} else {
				setTestResult({
					success: false,
					message: result.error || 'Connection failed',
				});
			}
		} catch (err) {
			setTestResult({
				success: false,
				message: err instanceof Error ? err.message : 'Connection test failed',
			});
		} finally {
			setTesting(false);
		}
	};

	// Environment variable handlers
	const addEnvVar = () => {
		setEnvVars((prev) => [...prev, { id: nextEnvVarId, key: '', value: '' }]);
		setNextEnvVarId((prev) => prev + 1);
		setShowEnvVars(true);
	};

	const updateEnvVar = (id: number, field: 'key' | 'value', value: string) => {
		setEnvVars((prev) =>
			prev.map((entry) => (entry.id === id ? { ...entry, [field]: value } : entry))
		);
	};

	const removeEnvVar = (id: number) => {
		setEnvVars((prev) => prev.filter((entry) => entry.id !== id));
	};

	if (!isOpen) return null;

	const modalTitle = title || (initialConfig ? 'Edit SSH Remote' : 'Add SSH Remote');
	const hasSshConfigHosts = sshConfigHosts.length > 0;

	return (
		<Modal
			theme={theme}
			title={modalTitle}
			priority={MODAL_PRIORITIES.SSH_REMOTE}
			onClose={onClose}
			width={500}
			headerIcon={<Server className="w-4 h-4" style={{ color: theme.colors.accent }} />}
			initialFocusRef={nameInputRef as React.RefObject<HTMLElement>}
			footer={
				<div className="flex items-center gap-2 w-full">
					{/* Test Connection Button */}
					{onTestConnection && (
						<button
							type="button"
							onClick={handleTestConnection}
							disabled={testing || !isValid}
							className="px-3 py-2 rounded border text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
							style={{
								borderColor: theme.colors.border,
								color: theme.colors.textMain,
								backgroundColor: 'transparent',
							}}
						>
							{testing ? (
								<>
									<Loader2 className="w-4 h-4 animate-spin" />
									Testing...
								</>
							) : (
								'Test Connection'
							)}
						</button>
					)}
					<div className="flex-1" />
					<ModalFooter
						theme={theme}
						onCancel={onClose}
						onConfirm={handleSave}
						confirmLabel={saving ? 'Saving...' : 'Save'}
						confirmDisabled={!isValid || saving}
					/>
				</div>
			}
		>
			<div className="space-y-4">
				{/* Error Message */}
				{error && (
					<div
						className="p-3 rounded flex items-start gap-2 text-sm"
						style={{
							backgroundColor: theme.colors.error + '20',
							color: theme.colors.error,
						}}
					>
						<XCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
						<span>{error}</span>
					</div>
				)}

				{/* Test Result */}
				{testResult && (
					<div
						className="p-3 rounded flex items-start gap-2 text-sm"
						style={{
							backgroundColor: testResult.success
								? theme.colors.success + '20'
								: theme.colors.error + '20',
							color: testResult.success ? theme.colors.success : theme.colors.error,
						}}
					>
						{testResult.success ? (
							<CheckCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
						) : (
							<XCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
						)}
						<div>
							<div>{testResult.message}</div>
							{testResult.hostname && (
								<div className="text-xs mt-1 opacity-80">
									Remote hostname: {testResult.hostname}
								</div>
							)}
						</div>
					</div>
				)}

				{/* SSH Config Import Section (only shown for new configs) */}
				{!initialConfig && hasSshConfigHosts && (
					<div
						className="p-3 rounded border"
						style={{
							borderColor: theme.colors.accent + '40',
							backgroundColor: theme.colors.accent + '10',
						}}
					>
						<div className="flex items-center gap-2 mb-2">
							<FileCode className="w-4 h-4" style={{ color: theme.colors.accent }} />
							<span className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
								Import from SSH Config
							</span>
						</div>
						<p className="text-xs mb-2" style={{ color: theme.colors.textDim }}>
							{sshConfigHosts.length} host{sshConfigHosts.length !== 1 ? 's' : ''} found in
							~/.ssh/config
						</p>
						<div className="relative" ref={dropdownRef}>
							<button
								type="button"
								onClick={() => setShowSshConfigDropdown(!showSshConfigDropdown)}
								disabled={sshConfigLoading}
								className="w-full px-3 py-2 rounded border text-sm text-left flex items-center justify-between transition-colors"
								style={{
									borderColor: theme.colors.border,
									backgroundColor: theme.colors.bgMain,
									color: theme.colors.textMain,
								}}
							>
								{sshConfigLoading ? (
									<span className="flex items-center gap-2">
										<Loader2 className="w-3 h-3 animate-spin" />
										Loading...
									</span>
								) : (
									<span>Select a host to import...</span>
								)}
								<ChevronDown className="w-4 h-4" style={{ color: theme.colors.textDim }} />
							</button>
							{showSshConfigDropdown && (
								<div
									className="absolute top-full left-0 right-0 mt-1 rounded border shadow-lg z-10"
									style={{
										backgroundColor: theme.colors.bgMain,
										borderColor: theme.colors.border,
									}}
									onKeyDown={handleDropdownKeyDown}
								>
									{/* Filter input */}
									<div className="p-2 border-b" style={{ borderColor: theme.colors.border }}>
										<input
											ref={filterInputRef}
											type="text"
											value={sshConfigFilter}
											onChange={(e) => setSshConfigFilter(e.target.value)}
											onKeyDown={handleDropdownKeyDown}
											placeholder="Type to filter..."
											className="w-full px-2 py-1 rounded text-sm bg-transparent outline-none"
											style={{
												color: theme.colors.textMain,
												backgroundColor: theme.colors.bgActivity,
											}}
										/>
									</div>
									{/* Host list */}
									<div className="max-h-40 overflow-y-auto">
										{filteredSshConfigHosts.length === 0 ? (
											<div
												className="px-3 py-2 text-sm text-center"
												style={{ color: theme.colors.textDim }}
											>
												No hosts match filter
											</div>
										) : (
											filteredSshConfigHosts.map((configHost, index) => (
												<button
													key={configHost.host}
													type="button"
													onClick={() => handleSelectSshConfigHost(configHost)}
													className="w-full px-3 py-2 text-left transition-colors"
													style={{
														color: theme.colors.textMain,
														backgroundColor:
															index === sshConfigHighlightIndex
																? theme.colors.accent + '30'
																: 'transparent',
													}}
													onMouseEnter={() => setSshConfigHighlightIndex(index)}
												>
													<div className="font-mono text-sm">{configHost.host}</div>
													<div className="text-xs" style={{ color: theme.colors.textDim }}>
														{getSshConfigHostSummary(configHost)}
													</div>
												</button>
											))
										)}
									</div>
								</div>
							)}
						</div>
					</div>
				)}

				{/* Using SSH Config indicator */}
				{useSshConfig && sshConfigHost && (
					<div
						className="flex items-center gap-2 px-3 py-2 rounded text-sm"
						style={{
							backgroundColor: theme.colors.accent + '20',
							color: theme.colors.accent,
						}}
					>
						<FileCode className="w-4 h-4" />
						<span>
							Imported from: <code className="font-mono">{sshConfigHost}</code>
						</span>
						<button
							type="button"
							onClick={() => {
								setUseSshConfig(false);
								setSshConfigHost(undefined);
							}}
							className="ml-auto text-xs opacity-70 hover:opacity-100"
							title="Stop tracking SSH config origin"
						>
							×
						</button>
					</div>
				)}

				{/* Name */}
				<FormInput
					ref={nameInputRef}
					theme={theme}
					label="Display Name"
					value={name}
					onChange={setName}
					placeholder="My Remote Server"
					helperText="A friendly name to identify this remote configuration"
				/>

				{/* Host and Port */}
				<div className="flex gap-3">
					<div className="flex-1">
						<FormInput
							theme={theme}
							label="Host"
							value={host}
							onChange={setHost}
							placeholder="hostname, IP, or SSH config alias"
							monospace
							helperText="Hostname, IP address, or Host pattern from ~/.ssh/config"
						/>
					</div>
					<div className="w-24">
						<FormInput
							theme={theme}
							label="Port"
							value={port}
							onChange={setPort}
							placeholder="22"
							monospace
						/>
					</div>
				</div>

				{/* Username */}
				<FormInput
					theme={theme}
					label="Username (optional)"
					value={username}
					onChange={setUsername}
					placeholder="username"
					monospace
					helperText="Leave empty to use SSH config or system defaults"
				/>

				{/* Private Key Path */}
				<FormInput
					theme={theme}
					label="Private Key Path (optional)"
					value={privateKeyPath}
					onChange={setPrivateKeyPath}
					placeholder="~/.ssh/id_ed25519"
					monospace
					helperText="Leave empty to use SSH config or ssh-agent"
				/>

				{/* Environment Variables */}
				<div>
					<div className="flex items-center justify-between mb-2">
						<label
							className="text-xs font-bold opacity-70 uppercase"
							style={{ color: theme.colors.textMain }}
						>
							Environment Variables (optional)
						</label>
						<button
							type="button"
							onClick={addEnvVar}
							className="flex items-center gap-1 px-2 py-1 rounded text-xs hover:bg-white/10 transition-colors"
							style={{ color: theme.colors.accent }}
						>
							<Plus className="w-3 h-3" />
							Add Variable
						</button>
					</div>

					{showEnvVars && envVars.length > 0 && (
						<div className="space-y-2 mb-2">
							{envVars.map((entry) => (
								<div key={entry.id} className="flex items-center gap-2">
									<input
										type="text"
										value={entry.key}
										onChange={(e) => updateEnvVar(entry.id, 'key', e.target.value)}
										placeholder="VARIABLE"
										className="flex-1 p-2 rounded border bg-transparent outline-none text-xs font-mono"
										style={{
											borderColor: theme.colors.border,
											color: theme.colors.textMain,
										}}
									/>
									<span className="text-xs" style={{ color: theme.colors.textDim }}>
										=
									</span>
									<input
										type="text"
										value={entry.value}
										onChange={(e) => updateEnvVar(entry.id, 'value', e.target.value)}
										placeholder="value"
										className="flex-[2] p-2 rounded border bg-transparent outline-none text-xs font-mono"
										style={{
											borderColor: theme.colors.border,
											color: theme.colors.textMain,
										}}
									/>
									<button
										type="button"
										onClick={() => removeEnvVar(entry.id)}
										className="p-2 rounded hover:bg-white/10 transition-colors"
										title="Remove variable"
										style={{ color: theme.colors.textDim }}
									>
										<Trash2 className="w-3 h-3" />
									</button>
								</div>
							))}
						</div>
					)}

					<p className="text-xs" style={{ color: theme.colors.textDim }}>
						Environment variables passed to agents running on this remote host
					</p>
				</div>

				{/* Enabled Toggle */}
				<div
					className="flex items-center justify-between p-3 rounded border"
					style={{
						borderColor: theme.colors.border,
						backgroundColor: theme.colors.bgMain,
					}}
				>
					<div>
						<div className="font-medium text-sm" style={{ color: theme.colors.textMain }}>
							Enable this remote
						</div>
						<div className="text-xs" style={{ color: theme.colors.textDim }}>
							Disabled remotes won&apos;t be available for selection
						</div>
					</div>
					<button
						type="button"
						onClick={() => setEnabled(!enabled)}
						className="w-12 h-6 rounded-full transition-colors relative"
						style={{
							backgroundColor: enabled ? theme.colors.accent : theme.colors.bgActivity,
						}}
					>
						<div
							className="absolute top-1 w-4 h-4 rounded-full bg-white transition-transform"
							style={{
								transform: enabled ? 'translateX(26px)' : 'translateX(4px)',
							}}
						/>
					</button>
				</div>
			</div>
		</Modal>
	);
}

export default SshRemoteModal;
