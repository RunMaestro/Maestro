import React, { useState, useEffect, useCallback } from 'react';
import {
	Plus,
	Trash2,
	Star,
	Search,
	RefreshCw,
	ChevronDown,
	ChevronRight,
	AlertTriangle,
	Check,
	Wrench,
	Download,
} from 'lucide-react';
import type { Theme } from '../types';
import type { AccountProfile, AccountSwitchConfig } from '../../shared/account-types';
import { ACCOUNT_SWITCH_DEFAULTS } from '../../shared/account-types';

interface AccountsPanelProps {
	theme: Theme;
}

interface DiscoveredAccount {
	configDir: string;
	name: string;
	email: string | null;
	hasAuth: boolean;
}

interface ConflictingSession {
	sessionId: string;
	sessionName: string;
	manualConfigDir: string;
}

const WINDOW_DURATION_OPTIONS = [
	{ label: '1 hour', value: 1 * 60 * 60 * 1000 },
	{ label: '2 hours', value: 2 * 60 * 60 * 1000 },
	{ label: '5 hours', value: 5 * 60 * 60 * 1000 },
	{ label: '8 hours', value: 8 * 60 * 60 * 1000 },
	{ label: '24 hours', value: 24 * 60 * 60 * 1000 },
];

export function AccountsPanel({ theme }: AccountsPanelProps) {
	const [accounts, setAccounts] = useState<AccountProfile[]>([]);
	const [switchConfig, setSwitchConfig] = useState<AccountSwitchConfig>(ACCOUNT_SWITCH_DEFAULTS);
	const [discoveredAccounts, setDiscoveredAccounts] = useState<DiscoveredAccount[] | null>(null);
	const [isDiscovering, setIsDiscovering] = useState(false);
	const [isCreating, setIsCreating] = useState(false);
	const [newAccountName, setNewAccountName] = useState('');
	const [createStep, setCreateStep] = useState<'idle' | 'created' | 'login-ready'>('idle');
	const [createdConfigDir, setCreatedConfigDir] = useState('');
	const [loginCommand, setLoginCommand] = useState('');
	const [editingAccountId, setEditingAccountId] = useState<string | null>(null);
	const [conflictingSessions, setConflictingSessions] = useState<ConflictingSession[]>([]);
	const [loading, setLoading] = useState(true);
	const [errorMessage, setErrorMessage] = useState<string | null>(null);

	const refreshAccounts = useCallback(async () => {
		try {
			const list = (await window.maestro.accounts.list()) as AccountProfile[];
			setAccounts(list);
		} catch (err) {
			console.error('Failed to load accounts:', err);
		}
	}, []);

	const refreshSwitchConfig = useCallback(async () => {
		try {
			const config = (await window.maestro.accounts.getSwitchConfig()) as AccountSwitchConfig;
			setSwitchConfig(config);
		} catch (err) {
			console.error('Failed to load switch config:', err);
		}
	}, []);

	// Load accounts, switch config, and check for conflicts on mount
	useEffect(() => {
		const init = async () => {
			setLoading(true);
			await Promise.all([refreshAccounts(), refreshSwitchConfig()]);

			// Check for sessions with manual CLAUDE_CONFIG_DIR
			try {
				const sessions = await window.maestro.sessions.getAll();
				const conflicts = sessions
					.filter(
						(s: any) => s.customEnvVars?.CLAUDE_CONFIG_DIR && !s.accountId
					)
					.map((s: any) => ({
						sessionId: s.id,
						sessionName: s.name || s.id,
						manualConfigDir: s.customEnvVars!.CLAUDE_CONFIG_DIR,
					}));
				setConflictingSessions(conflicts);
			} catch (err) {
				console.error('Failed to check session conflicts:', err);
			}

			setLoading(false);
		};
		init();

		// Auto-refresh when account status changes (e.g., marked expired during spawn)
		const cleanupStatusChanged = window.maestro.accounts.onStatusChanged(() => {
			refreshAccounts();
		});

		return () => {
			cleanupStatusChanged();
		};
	}, [refreshAccounts, refreshSwitchConfig]);

	const handleDiscover = async () => {
		setIsDiscovering(true);
		try {
			const found = await window.maestro.accounts.discoverExisting();
			// Filter out already-registered accounts
			const existingDirs = new Set(accounts.map((a) => a.configDir));
			setDiscoveredAccounts(found.filter((d) => !existingDirs.has(d.configDir)));
		} catch (err) {
			console.error('Failed to discover accounts:', err);
		} finally {
			setIsDiscovering(false);
		}
	};

	const handleImportDiscovered = async (discovered: DiscoveredAccount) => {
		try {
			await window.maestro.accounts.add({
				name: discovered.name,
				email: discovered.email || discovered.name,
				configDir: discovered.configDir,
			});
			await refreshAccounts();
			// Remove from discovered list
			setDiscoveredAccounts((prev) =>
				prev ? prev.filter((d) => d.configDir !== discovered.configDir) : null
			);
		} catch (err) {
			console.error('Failed to import account:', err);
		}
	};

	const handleCreateAndLogin = async () => {
		if (!newAccountName.trim()) return;
		setIsCreating(true);
		setErrorMessage(null);
		try {
			const result = await window.maestro.accounts.createDirectory(newAccountName.trim());
			if (!result.success) {
				setErrorMessage(`Failed to create account directory: ${result.error}`);
				return;
			}
			setCreatedConfigDir(result.configDir);

			const cmd = await window.maestro.accounts.getLoginCommand(result.configDir);
			if (cmd) {
				setLoginCommand(cmd);
				setCreateStep('login-ready');
			} else {
				setCreateStep('created');
			}
		} catch (err) {
			setErrorMessage(`Failed to create account: ${err}`);
		} finally {
			setIsCreating(false);
		}
	};

	const handleLoginComplete = async () => {
		try {
			const email = await window.maestro.accounts.readEmail(createdConfigDir);
			await window.maestro.accounts.add({
				name: email || newAccountName.trim(),
				email: email || newAccountName.trim(),
				configDir: createdConfigDir,
			});
			await refreshAccounts();
			// Reset create flow
			setNewAccountName('');
			setCreateStep('idle');
			setCreatedConfigDir('');
			setLoginCommand('');
		} catch (err) {
			console.error('Failed to register account after login:', err);
		}
	};

	const handleRemoveAccount = async (id: string) => {
		try {
			await window.maestro.accounts.remove(id);
			await refreshAccounts();
		} catch (err) {
			console.error('Failed to remove account:', err);
		}
	};

	const handleSetDefault = async (id: string) => {
		try {
			await window.maestro.accounts.setDefault(id);
			await refreshAccounts();
		} catch (err) {
			console.error('Failed to set default:', err);
		}
	};

	const handleUpdateAccount = async (id: string, updates: Partial<AccountProfile>) => {
		try {
			await window.maestro.accounts.update(id, updates as Record<string, unknown>);
			await refreshAccounts();
		} catch (err) {
			console.error('Failed to update account:', err);
		}
	};

	const handleUpdateSwitchConfig = async (updates: Partial<AccountSwitchConfig>) => {
		try {
			await window.maestro.accounts.updateSwitchConfig(updates as Record<string, unknown>);
			await refreshSwitchConfig();
		} catch (err) {
			console.error('Failed to update switch config:', err);
		}
	};

	const handleValidateSymlinks = async (configDir: string) => {
		try {
			const result = await window.maestro.accounts.validateSymlinks(configDir);
			if (result.valid) {
				alert('All symlinks are valid.');
			} else {
				alert(
					`Symlink issues found:\nBroken: ${result.broken.join(', ') || 'none'}\nMissing: ${result.missing.join(', ') || 'none'}`
				);
			}
		} catch (err) {
			console.error('Failed to validate symlinks:', err);
		}
	};

	const handleRepairSymlinks = async (configDir: string) => {
		try {
			const result = await window.maestro.accounts.repairSymlinks(configDir);
			if (result.errors.length === 0) {
				alert(`Repaired: ${result.repaired.join(', ') || 'none needed'}`);
			} else {
				alert(`Repair errors: ${result.errors.join(', ')}`);
			}
			await refreshAccounts();
		} catch (err) {
			console.error('Failed to repair symlinks:', err);
		}
	};

	const handleSyncCredentials = async (configDir: string) => {
		try {
			const result = await window.maestro.accounts.syncCredentials(configDir);
			if (result.success) {
				setErrorMessage(null);
				alert('Credentials synced from base ~/.claude directory.');
			} else {
				setErrorMessage(`Sync failed: ${result.error}`);
			}
		} catch (err) {
			setErrorMessage(`Failed to sync credentials: ${err}`);
		}
	};

	const statusBadge = (status: AccountProfile['status']) => {
		const styles: Record<
			string,
			{ bg: string; fg: string }
		> = {
			active: { bg: theme.colors.success + '20', fg: theme.colors.success },
			throttled: { bg: theme.colors.warning + '20', fg: theme.colors.warning },
			expired: { bg: theme.colors.error + '20', fg: theme.colors.error },
			disabled: { bg: theme.colors.error + '20', fg: theme.colors.error },
		};
		const s = styles[status] || styles.disabled;
		return (
			<span
				style={{
					backgroundColor: s.bg,
					color: s.fg,
					padding: '2px 8px',
					borderRadius: '4px',
					fontSize: '11px',
					fontWeight: 'bold',
					textTransform: 'uppercase',
				}}
			>
				{status}
			</span>
		);
	};

	if (loading) {
		return (
			<div style={{ color: theme.colors.textDim, padding: '20px', textAlign: 'center' }}>
				Loading accounts...
			</div>
		);
	}

	return (
		<div className="space-y-5">
			{/* Conflict Warning Banner */}
			{conflictingSessions.length > 0 && (
				<div
					style={{
						padding: '12px',
						backgroundColor: theme.colors.warning + '15',
						border: `1px solid ${theme.colors.warning}`,
						borderRadius: '6px',
					}}
				>
					<div
						style={{
							color: theme.colors.warning,
							fontWeight: 'bold',
							marginBottom: '4px',
							display: 'flex',
							alignItems: 'center',
							gap: '6px',
						}}
					>
						<AlertTriangle className="w-4 h-4" />
						Manual CLAUDE_CONFIG_DIR Detected
					</div>
					<div style={{ color: theme.colors.textDim, fontSize: '12px' }}>
						{conflictingSessions.length} session(s) have CLAUDE_CONFIG_DIR set manually in
						custom env vars. These sessions will not be managed by the account system.
						Consider migrating them to managed accounts.
					</div>
					{conflictingSessions.map((s) => (
						<div
							key={s.sessionId}
							style={{
								fontSize: '11px',
								color: theme.colors.textDim,
								marginTop: '4px',
							}}
						>
							&bull; {s.sessionName}: {s.manualConfigDir}
						</div>
					))}
				</div>
			)}

			{/* Registered Accounts */}
			<div>
				<div
					className="flex items-center justify-between mb-3"
					style={{ color: theme.colors.textMain }}
				>
					<div>
						<label className="block text-xs font-bold opacity-70 uppercase flex items-center gap-2">
							Registered Virtuosos
						</label>
						<p className="text-xs mt-1" style={{ color: theme.colors.textDim }}>
							AI Account Providers
						</p>
					</div>
					<button
						onClick={refreshAccounts}
						className="p-1 rounded hover:bg-white/10 transition-colors"
						title="Refresh accounts"
						style={{ color: theme.colors.textDim }}
					>
						<RefreshCw className="w-3 h-3" />
					</button>
				</div>

				{accounts.length === 0 ? (
					<div
						style={{
							color: theme.colors.textDim,
							fontSize: '13px',
							padding: '16px',
							textAlign: 'center',
							backgroundColor: theme.colors.bgMain,
							borderRadius: '6px',
							border: `1px solid ${theme.colors.border}`,
						}}
					>
						No virtuosos registered. Use &quot;Discover Existing&quot; or &quot;Create
						New&quot; below.
					</div>
				) : (
					<div className="space-y-2">
						{accounts.map((account) => (
							<div
								key={account.id}
								style={{
									backgroundColor: theme.colors.bgMain,
									border: `1px solid ${theme.colors.border}`,
									borderRadius: '6px',
									padding: '12px',
								}}
							>
								<div className="flex items-center justify-between">
									<div className="flex items-center gap-3">
										<div>
											<div
												className="flex items-center gap-2"
												style={{ color: theme.colors.textMain }}
											>
												<span className="font-bold text-sm">
													{account.email || account.name}
												</span>
												{account.isDefault && (
													<Star
														className="w-3 h-3"
														style={{ color: theme.colors.accent }}
														fill={theme.colors.accent}
													/>
												)}
												{statusBadge(account.status)}
											</div>
											{account.status === 'expired' && (
												<div
													className="text-xs mt-1 flex items-center gap-1"
													style={{ color: theme.colors.error }}
												>
													<AlertTriangle className="w-3 h-3" />
													OAuth token expired — run:{' '}
													<code
														className="font-mono select-all px-1 py-0.5 rounded"
														style={{
															backgroundColor: theme.colors.bgSidebar,
															fontSize: '10px',
														}}
													>
														CLAUDE_CONFIG_DIR=&quot;{account.configDir}&quot; claude login
													</code>
												</div>
											)}
											<div
												className="text-xs mt-1"
												style={{ color: theme.colors.textDim }}
											>
												{account.configDir}
												{account.tokenLimitPerWindow > 0 && (
													<span>
														{' '}
														&middot; Limit:{' '}
														{account.tokenLimitPerWindow.toLocaleString()}{' '}
														tokens
													</span>
												)}
											</div>
										</div>
									</div>
									<div className="flex items-center gap-1">
										<button
											onClick={() =>
												setEditingAccountId(
													editingAccountId === account.id
														? null
														: account.id
												)
											}
											className="p-1.5 rounded hover:bg-white/10 transition-colors"
											title="Configure"
											style={{ color: theme.colors.textDim }}
										>
											{editingAccountId === account.id ? (
												<ChevronDown className="w-3 h-3" />
											) : (
												<ChevronRight className="w-3 h-3" />
											)}
										</button>
										{account.status === 'expired' && (
											<button
												onClick={() =>
													handleUpdateAccount(account.id, {
														status: 'active',
													})
												}
												className="px-2 py-1 rounded text-xs font-bold transition-colors hover:bg-white/10"
												title="Mark as active after re-login"
												style={{
													color: theme.colors.success,
													border: `1px solid ${theme.colors.success}`,
												}}
											>
												Reactivate
											</button>
										)}
										{!account.isDefault && (
											<button
												onClick={() => handleSetDefault(account.id)}
												className="p-1.5 rounded hover:bg-white/10 transition-colors"
												title="Set as default"
												style={{ color: theme.colors.textDim }}
											>
												<Star className="w-3 h-3" />
											</button>
										)}
										<button
											onClick={() => handleRemoveAccount(account.id)}
											className="p-1.5 rounded hover:bg-white/10 transition-colors"
											title="Remove account"
											style={{ color: theme.colors.textDim }}
										>
											<Trash2 className="w-3 h-3" />
										</button>
									</div>
								</div>

								{/* Expanded per-account configuration */}
								{editingAccountId === account.id && (
									<div
										className="mt-3 pt-3 space-y-3"
										style={{ borderTop: `1px solid ${theme.colors.border}` }}
									>
										<div className="flex items-center gap-4">
											<div className="flex-1">
												<label
													className="block text-xs mb-1"
													style={{ color: theme.colors.textDim }}
												>
													Token limit per window (0 = no limit)
												</label>
												<input
													type="number"
													value={account.tokenLimitPerWindow}
													onChange={(e) =>
														handleUpdateAccount(account.id, {
															tokenLimitPerWindow:
																parseInt(e.target.value) || 0,
														})
													}
													className="w-full p-2 rounded border bg-transparent outline-none text-xs font-mono"
													style={{
														borderColor: theme.colors.border,
														color: theme.colors.textMain,
													}}
													min={0}
												/>
											</div>
											<div className="flex-1">
												<label
													className="block text-xs mb-1"
													style={{ color: theme.colors.textDim }}
												>
													Window duration
												</label>
												<select
													value={account.tokenWindowMs}
													onChange={(e) =>
														handleUpdateAccount(account.id, {
															tokenWindowMs: parseInt(e.target.value),
														})
													}
													className="w-full p-2 rounded border bg-transparent outline-none text-xs"
													style={{
														borderColor: theme.colors.border,
														color: theme.colors.textMain,
														backgroundColor: theme.colors.bgMain,
													}}
												>
													{WINDOW_DURATION_OPTIONS.map((opt) => (
														<option key={opt.value} value={opt.value}>
															{opt.label}
														</option>
													))}
												</select>
											</div>
										</div>

										<div className="flex items-center justify-between">
											<label
												className="text-xs"
												style={{ color: theme.colors.textDim }}
											>
												Auto-switch enabled
											</label>
											<button
												onClick={() =>
													handleUpdateAccount(account.id, {
														autoSwitchEnabled: !account.autoSwitchEnabled,
													})
												}
												className="w-8 h-4 rounded-full transition-colors relative"
												style={{
													backgroundColor: account.autoSwitchEnabled
														? theme.colors.accent
														: theme.colors.border,
												}}
											>
												<div
													className="absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform"
													style={{
														transform: account.autoSwitchEnabled
															? 'translateX(16px)'
															: 'translateX(2px)',
													}}
												/>
											</button>
										</div>

										<div className="flex gap-2 flex-wrap">
											<button
												onClick={() =>
													handleSyncCredentials(account.configDir)
												}
												className="flex items-center gap-1 px-2 py-1.5 rounded text-xs hover:bg-white/10 transition-colors"
												style={{
													color: theme.colors.accent,
													border: `1px solid ${theme.colors.accent}`,
												}}
											>
												<RefreshCw className="w-3 h-3" />
												Sync Auth
											</button>
											<button
												onClick={() =>
													handleValidateSymlinks(account.configDir)
												}
												className="flex items-center gap-1 px-2 py-1.5 rounded text-xs hover:bg-white/10 transition-colors"
												style={{
													color: theme.colors.textDim,
													border: `1px solid ${theme.colors.border}`,
												}}
											>
												<Check className="w-3 h-3" />
												Validate Symlinks
											</button>
											<button
												onClick={() =>
													handleRepairSymlinks(account.configDir)
												}
												className="flex items-center gap-1 px-2 py-1.5 rounded text-xs hover:bg-white/10 transition-colors"
												style={{
													color: theme.colors.textDim,
													border: `1px solid ${theme.colors.border}`,
												}}
											>
												<Wrench className="w-3 h-3" />
												Repair Symlinks
											</button>
										</div>
									</div>
								)}
							</div>
						))}
					</div>
				)}
			</div>

			{/* Add Virtuoso Section */}
			<div>
				<label
					className="block text-xs font-bold opacity-70 uppercase mb-3 flex items-center gap-2"
					style={{ color: theme.colors.textMain }}
				>
					Add Virtuoso
				</label>

				<div className="flex gap-2 mb-3">
					<button
						onClick={handleDiscover}
						disabled={isDiscovering}
						className="flex items-center gap-1.5 px-3 py-2 rounded text-xs font-bold transition-colors"
						style={{
							backgroundColor: theme.colors.bgMain,
							color: theme.colors.textMain,
							border: `1px solid ${theme.colors.border}`,
							opacity: isDiscovering ? 0.6 : 1,
						}}
					>
						<Search className="w-3 h-3" />
						{isDiscovering ? 'Searching...' : 'Discover Existing'}
					</button>
				</div>

				{/* Discovered accounts */}
				{discoveredAccounts !== null && (
					<div className="mb-3">
						{discoveredAccounts.length === 0 ? (
							<div
								className="text-xs p-3 rounded"
								style={{
									color: theme.colors.textDim,
									backgroundColor: theme.colors.bgMain,
									border: `1px solid ${theme.colors.border}`,
								}}
							>
								No unregistered account directories found.
							</div>
						) : (
							<div className="space-y-1">
								{discoveredAccounts.map((d) => (
									<div
										key={d.configDir}
										className="flex items-center justify-between p-2 rounded"
										style={{
											backgroundColor: theme.colors.bgMain,
											border: `1px solid ${theme.colors.border}`,
										}}
									>
										<div>
											<div
												className="text-xs font-bold"
												style={{ color: theme.colors.textMain }}
											>
												{d.email || d.name}
											</div>
											<div
												className="text-xs"
												style={{ color: theme.colors.textDim }}
											>
												{d.configDir}
												{d.hasAuth && (
													<span
														style={{ color: theme.colors.success }}
													>
														{' '}
														&middot; Authenticated
													</span>
												)}
											</div>
										</div>
										<button
											onClick={() => handleImportDiscovered(d)}
											className="flex items-center gap-1 px-2 py-1 rounded text-xs font-bold transition-colors"
											style={{
												backgroundColor: theme.colors.accent,
												color: theme.colors.accentForeground,
											}}
										>
											<Download className="w-3 h-3" />
											Import
										</button>
									</div>
								))}
							</div>
						)}
					</div>
				)}

				{/* Error message */}
				{errorMessage && (
					<div
						className="p-3 rounded mb-3 flex items-start gap-2"
						style={{
							backgroundColor: theme.colors.error + '15',
							border: `1px solid ${theme.colors.error}`,
						}}
					>
						<AlertTriangle
							className="w-4 h-4 flex-shrink-0 mt-0.5"
							style={{ color: theme.colors.error }}
						/>
						<div className="flex-1">
							<div
								className="text-xs"
								style={{ color: theme.colors.error }}
							>
								{errorMessage}
							</div>
							<button
								onClick={() => setErrorMessage(null)}
								className="text-xs mt-1 underline"
								style={{ color: theme.colors.textDim }}
							>
								Dismiss
							</button>
						</div>
					</div>
				)}

				{/* Create new account */}
				<div
					className="p-3 rounded"
					style={{
						backgroundColor: theme.colors.bgMain,
						border: `1px solid ${theme.colors.border}`,
					}}
				>
					<label
						className="block text-xs mb-2"
						style={{ color: theme.colors.textDim }}
					>
						Create New Virtuoso
					</label>

					{createStep === 'idle' && (
						<div className="flex gap-2">
							<input
								type="text"
								value={newAccountName}
								onChange={(e) => setNewAccountName(e.target.value)}
								placeholder="Virtuoso name (e.g., work, personal)"
								className="flex-1 p-2 rounded border bg-transparent outline-none text-xs font-mono"
								style={{
									borderColor: theme.colors.border,
									color: theme.colors.textMain,
								}}
								onKeyDown={(e) => e.key === 'Enter' && handleCreateAndLogin()}
							/>
							<button
								onClick={handleCreateAndLogin}
								disabled={!newAccountName.trim() || isCreating}
								className="flex items-center gap-1 px-3 py-2 rounded text-xs font-bold transition-colors"
								style={{
									backgroundColor: theme.colors.accent,
									color: theme.colors.accentForeground,
									opacity: !newAccountName.trim() || isCreating ? 0.5 : 1,
								}}
							>
								<Plus className="w-3 h-3" />
								{isCreating ? 'Creating...' : 'Create & Login'}
							</button>
						</div>
					)}

					{createStep === 'login-ready' && (
						<div className="space-y-2">
							<div
								className="text-xs"
								style={{ color: theme.colors.textDim }}
							>
								Directory created at{' '}
								<span className="font-mono">{createdConfigDir}</span>. Run the
								following command in a terminal to log in:
							</div>
							<div
								className="p-2 rounded text-xs font-mono select-all"
								style={{
									backgroundColor: theme.colors.bgSidebar,
									color: theme.colors.textMain,
									border: `1px solid ${theme.colors.border}`,
								}}
							>
								{loginCommand}
							</div>
							<div className="flex gap-2">
								<button
									onClick={handleLoginComplete}
									className="flex items-center gap-1 px-3 py-2 rounded text-xs font-bold transition-colors"
									style={{
										backgroundColor: theme.colors.success,
										color: '#fff',
									}}
								>
									<Check className="w-3 h-3" />
									Login Complete
								</button>
								<button
									onClick={() => {
										setCreateStep('idle');
										setCreatedConfigDir('');
										setLoginCommand('');
									}}
									className="px-3 py-2 rounded text-xs transition-colors hover:bg-white/10"
									style={{ color: theme.colors.textDim }}
								>
									Cancel
								</button>
							</div>
						</div>
					)}

					{createStep === 'created' && (
						<div className="space-y-2">
							<div
								className="text-xs"
								style={{ color: theme.colors.textDim }}
							>
								Directory created at{' '}
								<span className="font-mono">{createdConfigDir}</span>. Could
								not determine login command. Please authenticate manually and
								click &quot;Login Complete&quot;.
							</div>
							<div className="flex gap-2">
								<button
									onClick={handleLoginComplete}
									className="flex items-center gap-1 px-3 py-2 rounded text-xs font-bold transition-colors"
									style={{
										backgroundColor: theme.colors.success,
										color: '#fff',
									}}
								>
									<Check className="w-3 h-3" />
									Login Complete
								</button>
								<button
									onClick={() => {
										setCreateStep('idle');
										setCreatedConfigDir('');
										setLoginCommand('');
									}}
									className="px-3 py-2 rounded text-xs transition-colors hover:bg-white/10"
									style={{ color: theme.colors.textDim }}
								>
									Cancel
								</button>
							</div>
						</div>
					)}
				</div>
			</div>

			{/* Global Switch Configuration */}
			<div>
				<label
					className="block text-xs font-bold opacity-70 uppercase mb-3 flex items-center gap-2"
					style={{ color: theme.colors.textMain }}
				>
					Auto-Switch Configuration
				</label>

				<div
					className="space-y-3 p-3 rounded"
					style={{
						backgroundColor: theme.colors.bgMain,
						border: `1px solid ${theme.colors.border}`,
					}}
				>
					{/* Enable/disable auto-switching */}
					<div className="flex items-center justify-between">
						<label className="text-xs" style={{ color: theme.colors.textMain }}>
							Enable auto-switching
						</label>
						<button
							onClick={() =>
								handleUpdateSwitchConfig({ enabled: !switchConfig.enabled })
							}
							className="w-8 h-4 rounded-full transition-colors relative"
							style={{
								backgroundColor: switchConfig.enabled
									? theme.colors.accent
									: theme.colors.border,
							}}
						>
							<div
								className="absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform"
								style={{
									transform: switchConfig.enabled
										? 'translateX(16px)'
										: 'translateX(2px)',
								}}
							/>
						</button>
					</div>

					{/* Prompt before switch */}
					<div className="flex items-center justify-between">
						<label className="text-xs" style={{ color: theme.colors.textMain }}>
							Prompt before switching
						</label>
						<button
							onClick={() =>
								handleUpdateSwitchConfig({
									promptBeforeSwitch: !switchConfig.promptBeforeSwitch,
								})
							}
							className="w-8 h-4 rounded-full transition-colors relative"
							style={{
								backgroundColor: switchConfig.promptBeforeSwitch
									? theme.colors.accent
									: theme.colors.border,
							}}
						>
							<div
								className="absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform"
								style={{
									transform: switchConfig.promptBeforeSwitch
										? 'translateX(16px)'
										: 'translateX(2px)',
								}}
							/>
						</button>
					</div>

					{/* Warning threshold */}
					<div>
						<div className="flex items-center justify-between mb-1">
							<label className="text-xs" style={{ color: theme.colors.textMain }}>
								Warning threshold
							</label>
							<span
								className="text-xs font-mono"
								style={{ color: theme.colors.textDim }}
							>
								{switchConfig.warningThresholdPercent}%
							</span>
						</div>
						<input
							type="range"
							min={50}
							max={100}
							value={switchConfig.warningThresholdPercent}
							onChange={(e) =>
								handleUpdateSwitchConfig({
									warningThresholdPercent: parseInt(e.target.value),
								})
							}
							className="w-full"
							style={{ accentColor: theme.colors.accent }}
						/>
					</div>

					{/* Auto-switch threshold */}
					<div>
						<div className="flex items-center justify-between mb-1">
							<label className="text-xs" style={{ color: theme.colors.textMain }}>
								Auto-switch threshold
							</label>
							<span
								className="text-xs font-mono"
								style={{ color: theme.colors.textDim }}
							>
								{switchConfig.autoSwitchThresholdPercent}%
							</span>
						</div>
						<input
							type="range"
							min={50}
							max={100}
							value={switchConfig.autoSwitchThresholdPercent}
							onChange={(e) =>
								handleUpdateSwitchConfig({
									autoSwitchThresholdPercent: parseInt(e.target.value),
								})
							}
							className="w-full"
							style={{ accentColor: theme.colors.accent }}
						/>
					</div>

					{/* Selection strategy */}
					<div>
						<label
							className="block text-xs mb-1"
							style={{ color: theme.colors.textMain }}
						>
							Selection strategy
						</label>
						<select
							value={switchConfig.selectionStrategy}
							onChange={(e) =>
								handleUpdateSwitchConfig({
									selectionStrategy: e.target.value as
										| 'least-used'
										| 'round-robin',
								})
							}
							className="w-full p-2 rounded border bg-transparent outline-none text-xs"
							style={{
								borderColor: theme.colors.border,
								color: theme.colors.textMain,
								backgroundColor: theme.colors.bgMain,
							}}
						>
							<option value="least-used">Least Used</option>
							<option value="round-robin">Round Robin</option>
						</select>
					</div>
				</div>
			</div>
		</div>
	);
}
