/**
 * SshRemotesSection - Settings section for managing SSH remote configurations
 *
 * This component provides a UI for:
 * - Listing all configured SSH remotes
 * - Adding new SSH remotes
 * - Editing existing SSH remotes
 * - Deleting SSH remotes
 * - Setting the global default SSH remote
 * - Testing SSH connections
 * - Stop Host / Remove Host: undo the Maestro host an earlier release set up on the remote
 *   (the same `stopRemoteHost()` as `maestro-cli remote-host stop` / `uninstall`)
 *
 * Integrates with the useSshRemotes hook for state management and
 * the SshRemoteModal for add/edit operations.
 *
 * Usage:
 * ```tsx
 * <SshRemotesSection theme={theme} />
 * ```
 */

import React, { useMemo, useRef, useState } from 'react';
import {
	Server,
	Plus,
	Edit2,
	Trash2,
	Check,
	CheckCircle,
	XCircle,
	Wifi,
	WifiOff,
	PowerOff,
	PackageX,
} from 'lucide-react';
import { GhostIconButton } from '../ui/GhostIconButton';
import { FilterInput } from '../ui/FilterInput';
import { Spinner } from '../ui/Spinner';
import type { Theme } from '../../types';
import type { SshRemoteConfig } from '../../../shared/types';
import type { SshRemoteRemediation } from '../../../shared/sshRemoteShell';
import { formatSshTarget } from '../../../shared/formatters';
import { federationFieldFor, isFederationRemote } from '../../../shared/federationRemote';
import { compareNamesIgnoringEmojis } from '../../../shared/emojiUtils';
import { useSshRemotes } from '../../hooks';
import { SshRemoteModal } from './SshRemoteModal';
import { SshRemediationNotice } from './SshRemediationNotice';
import { ConfirmModal } from '../ConfirmModal';
import { stopRemoteHostFromWindow } from '../../services/agentLift';
import { logger } from '../../utils/logger';

/** What each confirmation says, so a person knows what goes before anything does. */
export function stopHostConfirmMessage(name: string): string {
	return (
		`Stop the Maestro host on ${name}? Maestro disables its boot service, so it does not come back ` +
		"after a reboot, then stops the host once its work in flight finishes. Maestro's install and " +
		"the host's data stay on the remote."
	);
}

export function removeHostConfirmMessage(name: string): string {
	// The paths `buildRemoteHostStopScript()` removes (REMOTE_SERVICE_UNIT, REMOTE_SERVICE_LABEL).
	return (
		`Remove the Maestro host from ${name}? Maestro stops the host, then removes its boot service ` +
		'(the systemd user unit ~/.config/systemd/user/maestro-host.service and its ' +
		'default.target.wants link, or the launchd agent ~/Library/LaunchAgents/sh.maestro.host.plist) ' +
		'and its own install under ~/.maestro (cli, node, npm-cache, the maestro-cli launcher and the ' +
		'maestro-host-service wrapper). It keeps ~/.maestro/host.env, any maestro-cli Maestro did not ' +
		"install, and the host's data directory. If the host holds agents, Maestro names them and asks " +
		'again: removing it anyway leaves those agents behind on the remote, with no host to run them.'
	);
}

/** The second ask: what going ahead anyway does to the agents the host holds. */
function forceConfirmMessage(message: string, action: HostAction, unknownHost: boolean): string {
	const verb = action === 'remove' ? 'Remove' : 'Stop';
	if (unknownHost) return `${message} ${verb} it anyway?`;
	const left =
		action === 'remove'
			? 'Removing it anyway leaves those agents behind on the remote, with no host to run them.'
			: 'Stopping it anyway leaves those agents behind on the remote until a host runs there again.';
	return `${message} ${left} ${verb} it anyway?`;
}

type HostAction = 'stop' | 'remove';

interface HostConfirm {
	config: SshRemoteConfig;
	action: HostAction;
	/** The second ask, after the host named the agents it holds. */
	force?: boolean;
	message: string;
}

/** Name A-Z, with the connection target breaking ties between same-named remotes. */
export function sortSshRemotes(configs: SshRemoteConfig[]): SshRemoteConfig[] {
	return [...configs].sort(
		(a, b) =>
			compareNamesIgnoringEmojis(a.name || a.host, b.name || b.host) ||
			formatSshTarget(a).localeCompare(formatSshTarget(b))
	);
}

/** Case-insensitive match on the remote's name or its `user@host:port` target. */
export function matchesSshRemoteFilter(config: SshRemoteConfig, query: string): boolean {
	const needle = query.trim().toLowerCase();
	if (!needle) return true;
	return (
		config.name.toLowerCase().includes(needle) ||
		formatSshTarget(config).toLowerCase().includes(needle)
	);
}

export interface SshRemotesSectionProps {
	/** Theme object for styling */
	theme: Theme;
}

export function SshRemotesSection({ theme }: SshRemotesSectionProps) {
	// SSH remotes state from hook
	const {
		configs,
		defaultId,
		loading,
		error,
		saveConfig,
		deleteConfig,
		setDefaultId,
		testConnection,
		testingConfigId,
		refresh,
	} = useSshRemotes();

	// Local UI state
	const [showModal, setShowModal] = useState(false);
	const [editingConfig, setEditingConfig] = useState<SshRemoteConfig | undefined>(undefined);
	const [deletingId, setDeletingId] = useState<string | null>(null);
	const [testResults, setTestResults] = useState<
		Record<string, { success: boolean; message: string; remediation?: SshRemoteRemediation }>
	>({});
	const [filter, setFilter] = useState('');
	const [hostBusy, setHostBusy] = useState<Record<string, HostAction>>({});
	const [hostResults, setHostResults] = useState<
		Record<string, { success: boolean; message: string }>
	>({});
	const [hostConfirm, setHostConfirm] = useState<HostConfirm | null>(null);
	// Remotes whose Federation switch a Stop Host or Remove Host turned off while the editor held
	// the earlier value: a save that leaves the switch as it was opened keeps it off.
	const federationOffSinceEdit = useRef(new Set<string>());

	const sortedConfigs = useMemo(() => sortSshRemotes(configs), [configs]);
	const visibleConfigs = useMemo(
		() => sortedConfigs.filter((config) => matchesSshRemoteFilter(config, filter)),
		[sortedConfigs, filter]
	);
	const isFiltering = filter.trim().length > 0;

	// Handle add new remote
	const handleAddNew = () => {
		setEditingConfig(undefined);
		setShowModal(true);
	};

	// Handle edit existing remote
	const handleEdit = (config: SshRemoteConfig) => {
		federationOffSinceEdit.current.delete(config.id);
		setEditingConfig(config);
		setShowModal(true);
	};

	// Handle delete remote
	const handleDelete = async (id: string) => {
		setDeletingId(id);
		const result = await deleteConfig(id);
		if (!result.success) {
			logger.error('Failed to delete SSH remote:', undefined, result.error);
		}
		setDeletingId(null);
		// Clear test result for deleted config
		setTestResults((prev) => {
			const { [id]: _, ...rest } = prev;
			return rest;
		});
	};

	// Handle set as default
	const handleSetDefault = async (id: string) => {
		// Toggle default off if already default
		const newDefaultId = id === defaultId ? null : id;
		await setDefaultId(newDefaultId);
	};

	// Handle test connection from list
	const handleTestFromList = async (config: SshRemoteConfig) => {
		const result = await testConnection(config);
		setTestResults((prev) => ({
			...prev,
			[config.id]: {
				success: result.success,
				message: result.success
					? `Connected to ${config.name || config.host}`
					: result.error || 'Connection failed',
				remediation: result.result?.remediation,
			},
		}));
	};

	// Stop Host / Remove Host, after the confirmation. A host that holds agents asks once more,
	// naming them, before it stops anyway.
	const runHostAction = async (config: SshRemoteConfig, action: HostAction, force: boolean) => {
		setHostBusy((prev) => ({ ...prev, [config.id]: action }));
		const answer = await stopRemoteHostFromWindow(config.id, {
			uninstall: action === 'remove',
			force,
		});
		setHostBusy((prev) => {
			const { [config.id]: _, ...rest } = prev;
			return rest;
		});
		if (
			answer.ok &&
			(answer.outcome === 'agents-held' || answer.outcome === 'host-unknown') &&
			!force
		) {
			setHostConfirm({
				config,
				action,
				force: true,
				// Main's message names the agents and their count (`describeRemoteHostStop()`).
				message: forceConfirmMessage(answer.message, action, answer.outcome === 'host-unknown'),
			});
			return;
		}
		// Main switched the remote's Federation off: reload, and keep an editor opened before the stop
		// from switching it back on with the value it was opened with.
		if (answer.federationOff) {
			federationOffSinceEdit.current.add(config.id);
			await refresh();
		}
		const success = answer.ok && (answer.outcome === 'done' || answer.outcome === 'nothing');
		setHostResults((prev) => ({
			...prev,
			[config.id]: { success, message: answer.ok ? answer.message : answer.error },
		}));
	};

	const askHostAction = (config: SshRemoteConfig, action: HostAction) => {
		const name = config.name || config.host;
		setHostConfirm({
			config,
			action,
			message: action === 'remove' ? removeHostConfirmMessage(name) : stopHostConfirmMessage(name),
		});
	};

	// Handle save from modal
	const handleSave = async (config: Partial<SshRemoteConfig>) => {
		const opened = editingConfig;
		const keepOff =
			opened !== undefined &&
			config.id === opened.id &&
			federationOffSinceEdit.current.has(opened.id) &&
			isFederationRemote(config) === isFederationRemote(opened);
		const result = await saveConfig(
			keepOff ? { ...config, federation: federationFieldFor(false) } : config
		);
		if (result.success) {
			setShowModal(false);
			setEditingConfig(undefined);
		}
		return result;
	};

	// Handle test from modal
	const handleTestFromModal = async (config: SshRemoteConfig) => {
		return await testConnection(config);
	};

	if (loading) {
		return (
			<div
				className="flex items-center gap-3 p-4 rounded-xl border"
				style={{ backgroundColor: theme.colors.bgMain, borderColor: theme.colors.border }}
			>
				<Spinner size={20} color={theme.colors.accent} />
				<span className="text-sm" style={{ color: theme.colors.textDim }}>
					Loading SSH remotes...
				</span>
			</div>
		);
	}

	return (
		<>
			<div
				className="flex items-start gap-3 p-4 rounded-xl border relative"
				style={{ backgroundColor: theme.colors.bgMain, borderColor: theme.colors.border }}
			>
				{/* Icon */}
				<div
					className="p-2 rounded-lg flex-shrink-0"
					style={{ backgroundColor: theme.colors.accent + '20' }}
				>
					<Server className="w-5 h-5" style={{ color: theme.colors.accent }} />
				</div>

				{/* Content */}
				<div className="flex-1 min-w-0">
					<p className="text-2xs uppercase font-bold opacity-50 mb-1">Remote Execution</p>
					<p className="font-semibold mb-1">SSH Remote Hosts</p>
					<p className="text-xs opacity-70 mb-3">
						Configure remote hosts where AI agents can be executed via SSH. This allows running
						agents on powerful remote machines or servers with specific tools installed.
					</p>

					{/* Error Display */}
					{error && (
						<div
							className="p-2 rounded text-xs flex items-start gap-2 mb-3"
							style={{
								backgroundColor: theme.colors.error + '20',
								color: theme.colors.error,
							}}
						>
							<XCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
							<span>{error}</span>
						</div>
					)}

					{/* Filter - a single remote has nothing to narrow */}
					{configs.length > 1 && (
						<FilterInput
							theme={theme}
							value={filter}
							onChange={setFilter}
							placeholder="Filter remotes..."
							ariaLabel="Filter SSH remotes"
							resultLabel={
								isFiltering ? `${visibleConfigs.length} of ${configs.length}` : undefined
							}
							width={280}
							className="mb-3"
						/>
					)}

					{/* Remote List */}
					{visibleConfigs.length > 0 && (
						<div className="space-y-2 mb-3">
							{visibleConfigs.map((config) => {
								const isDefault = config.id === defaultId;
								const isTesting = testingConfigId === config.id;
								const isDeleting = deletingId === config.id;
								const testResult = testResults[config.id];

								return (
									<div
										key={config.id}
										className={`p-3 rounded border transition-all ${
											isDefault ? 'ring-2' : ''
										} ${!config.enabled ? 'opacity-50' : ''}`}
										style={
											{
												borderColor: theme.colors.border,
												backgroundColor: theme.colors.bgActivity,
												'--tw-ring-color': theme.colors.accent,
											} as React.CSSProperties
										}
									>
										<div className="flex items-start justify-between gap-2">
											{/* Remote Info */}
											<div className="flex-1 min-w-0">
												<div className="flex items-center gap-2 mb-1">
													<span
														data-testid="ssh-remote-name"
														className="font-medium truncate"
														style={{ color: theme.colors.textMain }}
													>
														{config.name}
													</span>
													{isDefault && (
														<span
															className="px-1.5 py-0.5 rounded text-2xs font-bold uppercase"
															style={{
																backgroundColor: theme.colors.accent + '30',
																color: theme.colors.accent,
															}}
														>
															Default
														</span>
													)}
													{!config.enabled && (
														<span
															className="px-1.5 py-0.5 rounded text-2xs font-bold uppercase"
															style={{
																backgroundColor: theme.colors.warning + '30',
																color: theme.colors.warning,
															}}
														>
															Disabled
														</span>
													)}
												</div>
												<div
													className="text-xs font-mono truncate"
													style={{ color: theme.colors.textDim }}
												>
													{formatSshTarget(config)}
												</div>

												{/* Test Result. A recognized, fixable cause replaces the one-liner:
												    its detail already says what went wrong, and it adds the fix. */}
												{testResult?.remediation && (
													<SshRemediationNotice
														remediation={testResult.remediation}
														theme={theme}
														className="mt-2"
													/>
												)}
												{testResult && !testResult.remediation && (
													<div
														className="mt-2 text-xs flex items-start gap-1"
														style={{
															color: testResult.success ? theme.colors.success : theme.colors.error,
														}}
													>
														{testResult.success ? (
															<CheckCircle className="w-3 h-3 flex-shrink-0 mt-0.5" />
														) : (
															<XCircle className="w-3 h-3 flex-shrink-0 mt-0.5" />
														)}
														<span className="whitespace-pre-wrap break-words min-w-0">
															{testResult.message}
														</span>
													</div>
												)}
												{hostResults[config.id] && (
													<div
														data-testid="ssh-remote-host-result"
														className="mt-2 text-xs flex items-start gap-1"
														style={{
															color: hostResults[config.id].success
																? theme.colors.success
																: theme.colors.error,
														}}
													>
														{hostResults[config.id].success ? (
															<CheckCircle className="w-3 h-3 flex-shrink-0 mt-0.5" />
														) : (
															<XCircle className="w-3 h-3 flex-shrink-0 mt-0.5" />
														)}
														<span className="whitespace-pre-wrap break-words min-w-0 select-text">
															{hostResults[config.id].message}
														</span>
													</div>
												)}
											</div>

											{/* Actions */}
											<div className="flex items-center gap-1">
												{/* Test Connection */}
												<button
													type="button"
													onClick={() => handleTestFromList(config)}
													disabled={isTesting || !config.enabled}
													className="p-1.5 rounded hover:bg-white/10 transition-colors disabled:opacity-50"
													style={{ color: theme.colors.textDim }}
													title="Test connection"
												>
													{isTesting ? (
														<Spinner size={16} />
													) : config.enabled ? (
														<Wifi className="w-4 h-4" />
													) : (
														<WifiOff className="w-4 h-4" />
													)}
												</button>

												{/* Set as Default */}
												<button
													type="button"
													onClick={() => handleSetDefault(config.id)}
													disabled={!config.enabled}
													className={`p-1.5 rounded transition-colors disabled:opacity-50 ${
														isDefault ? '' : 'hover:bg-white/10'
													}`}
													style={{
														color: isDefault ? theme.colors.accent : theme.colors.textDim,
													}}
													title={isDefault ? 'Remove as default' : 'Set as default'}
												>
													<Check className="w-4 h-4" />
												</button>

												{/* Stop Host */}
												<button
													type="button"
													onClick={() => askHostAction(config, 'stop')}
													disabled={!config.enabled || hostBusy[config.id] !== undefined}
													className="p-1.5 rounded hover:bg-white/10 transition-colors disabled:opacity-50"
													style={{ color: theme.colors.textDim }}
													title="Stop Host: stop the Maestro host on this remote and disable its boot service"
													aria-label="Stop Host"
												>
													{hostBusy[config.id] === 'stop' ? (
														<Spinner size={16} />
													) : (
														<PowerOff className="w-4 h-4" />
													)}
												</button>

												{/* Remove Host */}
												<button
													type="button"
													onClick={() => askHostAction(config, 'remove')}
													disabled={!config.enabled || hostBusy[config.id] !== undefined}
													className="p-1.5 rounded hover:bg-white/10 transition-colors disabled:opacity-50"
													style={{ color: theme.colors.textDim }}
													title="Remove Host: stop the Maestro host and remove what Maestro installed on this remote"
													aria-label="Remove Host"
												>
													{hostBusy[config.id] === 'remove' ? (
														<Spinner size={16} />
													) : (
														<PackageX className="w-4 h-4" />
													)}
												</button>

												{/* Edit */}
												<GhostIconButton
													onClick={() => handleEdit(config)}
													padding="p-1.5"
													title="Edit"
													color={theme.colors.textDim}
												>
													<Edit2 className="w-4 h-4" />
												</GhostIconButton>

												{/* Delete */}
												<button
													type="button"
													onClick={() => handleDelete(config.id)}
													disabled={isDeleting}
													className="p-1.5 rounded hover:bg-white/10 transition-colors disabled:opacity-50"
													style={{ color: theme.colors.error }}
													title="Delete"
												>
													{isDeleting ? <Spinner size={16} /> : <Trash2 className="w-4 h-4" />}
												</button>
											</div>
										</div>
									</div>
								);
							})}
						</div>
					)}

					{/* No filter matches */}
					{configs.length > 0 && visibleConfigs.length === 0 && (
						<p className="text-xs mb-3" style={{ color: theme.colors.textDim }}>
							No remotes match &ldquo;{filter.trim()}&rdquo;
						</p>
					)}

					{/* Empty State */}
					{configs.length === 0 && (
						<div
							className="p-4 rounded border border-dashed text-center mb-3"
							style={{ borderColor: theme.colors.border }}
						>
							<Server
								className="w-8 h-8 mx-auto mb-2 opacity-30"
								style={{ color: theme.colors.textDim }}
							/>
							<p className="text-sm" style={{ color: theme.colors.textDim }}>
								No SSH remotes configured
							</p>
							<p className="text-xs opacity-70 mt-1">
								Add a remote host to run AI agents on external machines
							</p>
						</div>
					)}

					{/* Add Button */}
					<button
						type="button"
						onClick={handleAddNew}
						className="flex items-center gap-2 px-3 py-2 rounded text-sm font-medium transition-colors"
						style={{
							backgroundColor: theme.colors.accent,
							color: theme.colors.bgMain,
						}}
					>
						<Plus className="w-4 h-4" />
						Add SSH Remote
					</button>
				</div>
			</div>

			{/* Add/Edit Modal */}
			<SshRemoteModal
				theme={theme}
				isOpen={showModal}
				onClose={() => {
					setShowModal(false);
					setEditingConfig(undefined);
				}}
				onSave={handleSave}
				onTestConnection={handleTestFromModal}
				initialConfig={editingConfig}
			/>

			{hostConfirm && (
				<ConfirmModal
					theme={theme}
					title={hostConfirm.action === 'remove' ? 'Remove Host' : 'Stop Host'}
					message={hostConfirm.message}
					confirmLabel={
						hostConfirm.force
							? hostConfirm.action === 'remove'
								? 'Remove Anyway'
								: 'Stop Anyway'
							: hostConfirm.action === 'remove'
								? 'Remove Host'
								: 'Stop Host'
					}
					destructive={hostConfirm.action === 'remove' || hostConfirm.force === true}
					onConfirm={() => {
						const { config, action, force } = hostConfirm;
						void runHostAction(config, action, force === true);
					}}
					onClose={() => setHostConfirm(null)}
				/>
			)}
		</>
	);
}

export default SshRemotesSection;
