/**
 * PluginManager - Modal for browsing, enabling, and configuring plugins.
 *
 * Shows all discovered plugins with their state, permissions, and toggle controls.
 */

import { useState, useCallback } from 'react';
import {
	Puzzle,
	RefreshCw,
	FolderOpen,
	ToggleLeft,
	ToggleRight,
	AlertCircle,
	Loader2,
} from 'lucide-react';
import type { Theme } from '../types';
import type { LoadedPlugin, PluginPermission } from '../../shared/plugin-types';
import { Modal } from './ui/Modal';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';

interface PluginManagerProps {
	theme: Theme;
	plugins: LoadedPlugin[];
	loading: boolean;
	onClose: () => void;
	onEnablePlugin: (id: string) => Promise<void>;
	onDisablePlugin: (id: string) => Promise<void>;
	onRefresh: () => Promise<void>;
}

/** Returns a color for a permission badge based on its risk level */
function getPermissionColor(
	permission: PluginPermission,
	theme: Theme
): { bg: string; text: string } {
	if (permission === 'middleware') {
		return { bg: `${theme.colors.error}20`, text: theme.colors.error };
	}
	if (permission.endsWith(':write') || permission === 'process:write' || permission === 'settings:write') {
		return { bg: `${theme.colors.warning}20`, text: theme.colors.warning };
	}
	return { bg: `${theme.colors.success}20`, text: theme.colors.success };
}

export function PluginManager({
	theme,
	plugins,
	loading,
	onClose,
	onEnablePlugin,
	onDisablePlugin,
	onRefresh,
}: PluginManagerProps) {
	const [togglingIds, setTogglingIds] = useState<Set<string>>(new Set());
	const [refreshing, setRefreshing] = useState(false);

	const handleToggle = useCallback(
		async (plugin: LoadedPlugin) => {
			const id = plugin.manifest.id;
			setTogglingIds((prev) => new Set(prev).add(id));
			try {
				if (plugin.state === 'active' || plugin.state === 'loaded') {
					await onDisablePlugin(id);
				} else {
					await onEnablePlugin(id);
				}
			} finally {
				setTogglingIds((prev) => {
					const next = new Set(prev);
					next.delete(id);
					return next;
				});
			}
		},
		[onEnablePlugin, onDisablePlugin]
	);

	const handleRefresh = useCallback(async () => {
		setRefreshing(true);
		try {
			await onRefresh();
		} finally {
			setRefreshing(false);
		}
	}, [onRefresh]);

	const handleOpenFolder = useCallback(async () => {
		try {
			const dir = await window.maestro.plugins.getDir();
			await window.maestro.shell.showItemInFolder(dir);
		} catch (err) {
			console.error('Failed to open plugins folder:', err);
		}
	}, []);

	const isEnabled = (plugin: LoadedPlugin) =>
		plugin.state === 'active' || plugin.state === 'loaded';

	return (
		<Modal
			theme={theme}
			title="Plugin Manager"
			priority={MODAL_PRIORITIES.PLUGIN_MANAGER}
			onClose={onClose}
			width={520}
			headerIcon={<Puzzle className="w-4 h-4" />}
		>
			<div className="space-y-3">
				{/* Toolbar */}
				<div className="flex items-center justify-between">
					<span className="text-xs" style={{ color: theme.colors.textDim }}>
						{plugins.length} plugin{plugins.length !== 1 ? 's' : ''} discovered
					</span>
					<div className="flex items-center gap-2">
						<button
							onClick={handleOpenFolder}
							className="flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs border hover:bg-white/5 transition-colors"
							style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
							title="Open plugins folder"
						>
							<FolderOpen className="w-3.5 h-3.5" />
							Open Folder
						</button>
						<button
							onClick={handleRefresh}
							disabled={refreshing}
							className="flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs border hover:bg-white/5 transition-colors"
							style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
							title="Refresh plugin list"
						>
							<RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
							Refresh
						</button>
					</div>
				</div>

				{/* Plugin List */}
				{loading ? (
					<div className="flex items-center justify-center py-8 gap-2">
						<Loader2 className="w-4 h-4 animate-spin" style={{ color: theme.colors.textDim }} />
						<span className="text-xs" style={{ color: theme.colors.textDim }}>
							Loading plugins...
						</span>
					</div>
				) : plugins.length === 0 ? (
					<div
						className="text-center py-8 space-y-2"
						style={{ color: theme.colors.textDim }}
					>
						<Puzzle className="w-8 h-8 mx-auto opacity-50" />
						<p className="text-sm">No plugins installed</p>
						<p className="text-xs">
							Place plugin folders in the plugins directory to get started.
						</p>
					</div>
				) : (
					<div className="space-y-2 max-h-[400px] overflow-y-auto scrollbar-thin">
						{plugins.map((plugin) => {
							const toggling = togglingIds.has(plugin.manifest.id);
							const enabled = isEnabled(plugin);

							return (
								<div
									key={plugin.manifest.id}
									className="p-3 rounded border"
									style={{
										borderColor:
											plugin.state === 'error'
												? theme.colors.error
												: theme.colors.border,
										backgroundColor: theme.colors.bgActivity,
									}}
								>
									{/* Header row */}
									<div className="flex items-center justify-between mb-1">
										<div className="flex items-center gap-2">
											<span
												className="text-sm font-bold"
												style={{ color: theme.colors.textMain }}
											>
												{plugin.manifest.name}
											</span>
											<span
												className="text-xs font-mono"
												style={{ color: theme.colors.textDim }}
											>
												v{plugin.manifest.version}
											</span>
										</div>

										{/* Toggle */}
										<button
											onClick={() => handleToggle(plugin)}
											disabled={toggling || plugin.state === 'error'}
											className="transition-colors"
											title={enabled ? 'Disable plugin' : 'Enable plugin'}
											style={{
												color: enabled
													? theme.colors.success
													: theme.colors.textDim,
											}}
										>
											{toggling ? (
												<Loader2 className="w-5 h-5 animate-spin" />
											) : enabled ? (
												<ToggleRight className="w-5 h-5" />
											) : (
												<ToggleLeft className="w-5 h-5" />
											)}
										</button>
									</div>

									{/* Author */}
									<div className="text-xs mb-1" style={{ color: theme.colors.textDim }}>
										by {plugin.manifest.author}
									</div>

									{/* Description */}
									<div
										className="text-xs mb-2"
										style={{ color: theme.colors.textMain }}
									>
										{plugin.manifest.description}
									</div>

									{/* Permissions */}
									{plugin.manifest.permissions.length > 0 && (
										<div className="flex flex-wrap gap-1 mb-1">
											{plugin.manifest.permissions.map((perm) => {
												const colors = getPermissionColor(perm, theme);
												return (
													<span
														key={perm}
														className="text-[10px] px-1.5 py-0.5 rounded font-mono"
														style={{
															backgroundColor: colors.bg,
															color: colors.text,
														}}
													>
														{perm}
													</span>
												);
											})}
										</div>
									)}

									{/* Error message */}
									{plugin.state === 'error' && plugin.error && (
										<div
											className="flex items-start gap-1.5 mt-2 text-xs"
											style={{ color: theme.colors.error }}
										>
											<AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
											<span>{plugin.error}</span>
										</div>
									)}
								</div>
							);
						})}
					</div>
				)}
			</div>
		</Modal>
	);
}
