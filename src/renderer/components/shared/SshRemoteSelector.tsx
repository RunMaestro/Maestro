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

import { ChevronDown, Monitor, Cloud } from 'lucide-react';
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
							// Run locally
							onSshRemoteConfigChange({
								enabled: false,
								remoteId: null,
							});
						} else {
							// Use specific remote
							onSshRemoteConfigChange({
								enabled: true,
								remoteId: value,
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
