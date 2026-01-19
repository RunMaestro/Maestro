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
 *
 * Integrates with the useSshRemotes hook for state management and
 * the SshRemoteModal for add/edit operations.
 *
 * Usage:
 * ```tsx
 * <SshRemotesSection theme={theme} />
 * ```
 */

import React, { useState } from 'react';
import {
	Server,
	Plus,
	Edit2,
	Trash2,
	Check,
	CheckCircle,
	XCircle,
	Loader2,
	Wifi,
	WifiOff,
} from 'lucide-react';
import type { Theme } from '../../types';
import type { SshRemoteConfig } from '../../../shared/types';
import { useSshRemotes } from '../../hooks';
import { SshRemoteModal } from './SshRemoteModal';

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
	} = useSshRemotes();

	// Local UI state
	const [showModal, setShowModal] = useState(false);
	const [editingConfig, setEditingConfig] = useState<SshRemoteConfig | undefined>(undefined);
	const [deletingId, setDeletingId] = useState<string | null>(null);
	const [testResults, setTestResults] = useState<
		Record<string, { success: boolean; message: string }>
	>({});

	// Handle add new remote
	const handleAddNew = () => {
		setEditingConfig(undefined);
		setShowModal(true);
	};

	// Handle edit existing remote
	const handleEdit = (config: SshRemoteConfig) => {
		setEditingConfig(config);
		setShowModal(true);
	};

	// Handle delete remote
	const handleDelete = async (id: string) => {
		setDeletingId(id);
		const result = await deleteConfig(id);
		if (!result.success) {
			console.error('Failed to delete SSH remote:', result.error);
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
					? `Connected to ${result.result?.remoteInfo?.hostname || config.host}`
					: result.error || 'Connection failed',
			},
		}));
	};

	// Handle save from modal
	const handleSave = async (config: Partial<SshRemoteConfig>) => {
		const result = await saveConfig(config);
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
				<Loader2 className="w-5 h-5 animate-spin" style={{ color: theme.colors.accent }} />
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
					<p className="text-[10px] uppercase font-bold opacity-50 mb-1">Remote Execution</p>
					<p className="font-semibold mb-1">SSH Remote Hosts</p>
					<p className="text-xs opacity-60 mb-3">
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

					{/* Remote List */}
					{configs.length > 0 && (
						<div className="space-y-2 mb-3">
							{configs.map((config) => {
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
														className="font-medium truncate"
														style={{ color: theme.colors.textMain }}
													>
														{config.name}
													</span>
													{isDefault && (
														<span
															className="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase"
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
															className="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase"
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
													{config.username}@{config.host}:{config.port}
												</div>

												{/* Test Result */}
												{testResult && (
													<div
														className="mt-2 text-xs flex items-center gap-1"
														style={{
															color: testResult.success ? theme.colors.success : theme.colors.error,
														}}
													>
														{testResult.success ? (
															<CheckCircle className="w-3 h-3" />
														) : (
															<XCircle className="w-3 h-3" />
														)}
														<span className="truncate">{testResult.message}</span>
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
														<Loader2 className="w-4 h-4 animate-spin" />
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

												{/* Edit */}
												<button
													type="button"
													onClick={() => handleEdit(config)}
													className="p-1.5 rounded hover:bg-white/10 transition-colors"
													style={{ color: theme.colors.textDim }}
													title="Edit"
												>
													<Edit2 className="w-4 h-4" />
												</button>

												{/* Delete */}
												<button
													type="button"
													onClick={() => handleDelete(config.id)}
													disabled={isDeleting}
													className="p-1.5 rounded hover:bg-white/10 transition-colors disabled:opacity-50"
													style={{ color: theme.colors.error }}
													title="Delete"
												>
													{isDeleting ? (
														<Loader2 className="w-4 h-4 animate-spin" />
													) : (
														<Trash2 className="w-4 h-4" />
													)}
												</button>
											</div>
										</div>
									</div>
								);
							})}
						</div>
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
							<p className="text-xs opacity-60 mt-1" style={{ color: theme.colors.textDim }}>
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
		</>
	);
}

export default SshRemotesSection;
