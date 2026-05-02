/**
 * SshRemoteSelector.tsx
 *
 * Standalone component for SSH remote execution configuration.
 * Extracted from AgentConfigPanel to be used at the top level of modals.
 *
 * Displays:
 * - Dropdown to select SSH remote (or local execution)
 * - Status indicator showing selected remote
 * - Hint when no remotes are configured
 */

import { ChevronDown, Monitor, Cloud, History } from 'lucide-react';
import type { Theme } from '../../types';
import type { SshRemoteConfig, AgentSshRemoteConfig } from '../../../shared/types';

export interface SshRemoteSelectorProps {
	theme: Theme;
	sshRemotes: SshRemoteConfig[];
	sshRemoteConfig?: AgentSshRemoteConfig;
	onSshRemoteConfigChange: (config: AgentSshRemoteConfig) => void;
	/** Optional: compact mode with less padding (for use inside config panels) */
	compact?: boolean;
}

export function SshRemoteSelector({
	theme,
	sshRemotes,
	sshRemoteConfig,
	onSshRemoteConfigChange,
	compact = false,
}: SshRemoteSelectorProps): JSX.Element {
	// Compact mode uses bordered container style (for nested use in config panels)
	// Non-compact mode uses simple label + input style (for top-level modal use)
	if (compact) {
		return (
			<div
				className="p-2 rounded border"
				style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
			>
				<label className="block text-xs font-medium mb-2" style={{ color: theme.colors.textDim }}>
					SSH Remote Execution
				</label>
				<SshRemoteDropdown
					theme={theme}
					sshRemotes={sshRemotes}
					sshRemoteConfig={sshRemoteConfig}
					onSshRemoteConfigChange={onSshRemoteConfigChange}
				/>
				<p className="text-xs opacity-50 mt-2">
					Execute this agent on a remote host via SSH instead of locally
				</p>
			</div>
		);
	}

	// Non-compact: simple label + input style matching other form fields
	return (
		<div>
			<label
				className="block text-xs font-bold opacity-70 uppercase mb-2"
				style={{ color: theme.colors.textMain }}
			>
				SSH Remote Execution
			</label>
			<SshRemoteDropdown
				theme={theme}
				sshRemotes={sshRemotes}
				sshRemoteConfig={sshRemoteConfig}
				onSshRemoteConfigChange={onSshRemoteConfigChange}
			/>
			<p className="mt-1 text-xs" style={{ color: theme.colors.textDim }}>
				Execute this agent on a remote host via SSH instead of locally.
			</p>
		</div>
	);
}

/** Internal component for the dropdown and status indicator */
function SshRemoteDropdown({
	theme,
	sshRemotes,
	sshRemoteConfig,
	onSshRemoteConfigChange,
}: {
	theme: Theme;
	sshRemotes: SshRemoteConfig[];
	sshRemoteConfig?: AgentSshRemoteConfig;
	onSshRemoteConfigChange: (config: AgentSshRemoteConfig) => void;
}): JSX.Element {
	// Get the currently selected remote (if any)
	const selectedRemoteId =
		sshRemoteConfig?.enabled && sshRemoteConfig?.remoteId ? sshRemoteConfig.remoteId : null;
	const selectedRemote = selectedRemoteId
		? sshRemotes.find((r) => r.id === selectedRemoteId && r.enabled)
		: null;

	return (
		<div className="space-y-2">
			{/* Dropdown to select remote */}
			<div className="relative">
				<select
					value={selectedRemoteId || 'local'}
					onChange={(e) => {
						const value = e.target.value;
						if (value === 'local') {
							// Run locally. Preserve workingDirOverride and shareHistoryToProjectDir
							// so toggling the dropdown doesn't silently wipe the
							// "remote-controlled" flag (which is independent of SSH enablement).
							onSshRemoteConfigChange({
								enabled: false,
								remoteId: null,
								workingDirOverride: sshRemoteConfig?.workingDirOverride,
								syncHistory: sshRemoteConfig?.syncHistory,
								shareHistoryToProjectDir: sshRemoteConfig?.shareHistoryToProjectDir,
							});
						} else {
							// Use specific remote. Preserve sibling fields for the same reason.
							onSshRemoteConfigChange({
								enabled: true,
								remoteId: value,
								workingDirOverride: sshRemoteConfig?.workingDirOverride,
								syncHistory: sshRemoteConfig?.syncHistory ?? false,
								shareHistoryToProjectDir: sshRemoteConfig?.shareHistoryToProjectDir,
							});
						}
					}}
					onClick={(e) => e.stopPropagation()}
					className="w-full p-2 rounded border bg-transparent outline-none text-sm appearance-none cursor-pointer pr-8"
					style={{
						borderColor: theme.colors.border,
						color: theme.colors.textMain,
					}}
				>
					<option value="local">Local Execution</option>
					{sshRemotes
						.filter((r) => r.enabled)
						.map((remote) => (
							<option key={remote.id} value={remote.id}>
								{remote.name} ({remote.host})
							</option>
						))}
				</select>
				<ChevronDown
					className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 pointer-events-none"
					style={{ color: theme.colors.textDim }}
				/>
			</div>

			{/* Status indicator showing selected remote */}
			<div
				className="flex items-center gap-2 px-2 py-1.5 rounded text-xs"
				style={{ backgroundColor: theme.colors.bgActivity }}
			>
				{selectedRemote ? (
					<>
						<Cloud className="w-3 h-3" style={{ color: theme.colors.success }} />
						<span style={{ color: theme.colors.textMain }}>
							Agent will run on <span className="font-medium">{selectedRemote.name}</span>
							<span style={{ color: theme.colors.textDim }}> ({selectedRemote.host})</span>
						</span>
					</>
				) : (
					<>
						<Monitor className="w-3 h-3" style={{ color: theme.colors.textDim }} />
						<span style={{ color: theme.colors.textDim }}>Agent will run locally</span>
					</>
				)}
			</div>

			{/* Sync history toggle - shown when an SSH remote is selected */}
			{selectedRemote && (
				<label
					className="flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer transition-colors hover:bg-white/5"
					style={{ backgroundColor: theme.colors.bgActivity }}
				>
					<input
						type="checkbox"
						checked={sshRemoteConfig?.syncHistory === true}
						onChange={(e) => {
							onSshRemoteConfigChange({
								...sshRemoteConfig!,
								syncHistory: e.target.checked,
							});
						}}
						onClick={(e) => e.stopPropagation()}
						className="accent-current"
						style={{ accentColor: theme.colors.accent }}
					/>
					<History className="w-3 h-3 flex-shrink-0" style={{ color: theme.colors.textDim }} />
					<div className="flex flex-col">
						<span className="text-xs font-medium" style={{ color: theme.colors.textMain }}>
							Sync history to remote
						</span>
						<span className="text-[10px]" style={{ color: theme.colors.textDim }}>
							Share history entries via .maestro/history/ on the remote host for cross-machine
							visibility.
						</span>
					</div>
				</label>
			)}

			{/* Share-to-project-dir toggle - visible regardless of SSH selection.
			    Enables mirroring this agent's entries to the local project's
			    .maestro/history/ dir so another Maestro instance (typically one
			    SSH'd into this machine) can see them. */}
			<label
				className="flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer transition-colors hover:bg-white/5"
				style={{ backgroundColor: theme.colors.bgActivity }}
			>
				<input
					type="checkbox"
					checked={sshRemoteConfig?.shareHistoryToProjectDir === true}
					onChange={(e) => {
						onSshRemoteConfigChange({
							// Preserve whatever SSH enablement/remoteId already exist
							enabled: sshRemoteConfig?.enabled ?? false,
							remoteId: sshRemoteConfig?.remoteId ?? null,
							workingDirOverride: sshRemoteConfig?.workingDirOverride,
							syncHistory: sshRemoteConfig?.syncHistory,
							shareHistoryToProjectDir: e.target.checked,
						});
					}}
					onClick={(e) => e.stopPropagation()}
					className="accent-current"
					style={{ accentColor: theme.colors.accent }}
				/>
				<History className="w-3 h-3 flex-shrink-0" style={{ color: theme.colors.textDim }} />
				<div className="flex flex-col">
					<span className="text-xs font-medium" style={{ color: theme.colors.textMain }}>
						This agent is remote-controlled
					</span>
					<span className="text-[10px]" style={{ color: theme.colors.textDim }}>
						Mirror history entries to this project's local .maestro/history/ so another Maestro
						(SSH'd into this machine) can see what was done here.
					</span>
				</div>
			</label>

			{/* No remotes configured hint */}
			{sshRemotes.filter((r) => r.enabled).length === 0 && (
				<p className="text-xs" style={{ color: theme.colors.textDim }}>
					No SSH remotes configured.{' '}
					<span style={{ color: theme.colors.accent }}>
						Configure remotes in Settings → SSH Remotes.
					</span>
				</p>
			)}
		</div>
	);
}
