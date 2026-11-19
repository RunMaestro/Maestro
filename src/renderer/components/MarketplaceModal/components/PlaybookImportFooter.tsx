import { Download, FolderOpen, Play, RefreshCw } from 'lucide-react';
import { isCompatible } from '../../../../shared/marketplace-compatibility';
import type { MarketplacePlaybook } from '../../../../shared/marketplace-types';
import {
	describePlaybookUpdate,
	type PlaybookUpdateStatus,
} from '../../../../shared/playbookUpdates';
import { PlaybookUpdatePill } from './PlaybookUpdatePill';
import { Spinner } from '../../ui/Spinner';
import type { Theme } from '../../../types';

export interface PlaybookImportFooterProps {
	theme: Theme;
	playbook: MarketplacePlaybook;
	targetFolderName: string;
	isImporting: boolean;
	/**
	 * The copy the agent already has. Set, the footer names its folder and
	 * offers Update (re-fetch into that folder, answers kept) in place of a
	 * second install.
	 */
	installed?: PlaybookUpdateStatus;
	isRemoteSession: boolean;
	runningVersion: string;
	onTargetFolderChange: (name: string) => void;
	onBrowseFolder: () => void;
	/** Primary action: install (or update), then move straight on to configuring the run. */
	onInstallAndRun: () => void;
	/** Secondary action: install (or update) the files and record, then close. */
	onInstallOnly: () => void;
}

export function PlaybookImportFooter({
	theme,
	playbook,
	targetFolderName,
	isImporting,
	installed,
	isRemoteSession,
	runningVersion,
	onTargetFolderChange,
	onBrowseFolder,
	onInstallAndRun,
	onInstallOnly,
}: PlaybookImportFooterProps) {
	const compatible = isCompatible(playbook, runningVersion);
	const installDisabled = isImporting || (!installed && !targetFolderName.trim()) || !compatible;
	const incompatibleTitle = !compatible
		? `Update Maestro to ${playbook.minMaestroVersion} or newer to install this playbook.`
		: undefined;
	const updateTitle = installed ? describePlaybookUpdate(installed) : undefined;

	return (
		<div
			className="shrink-0 px-4 py-3 border-t"
			style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
		>
			<div className="flex items-center gap-3">
				{installed ? (
					<div className="flex-1 min-w-0" data-testid="marketplace-installed-summary">
						<div className="text-xs mb-1" style={{ color: theme.colors.textDim }}>
							Installed on this agent
						</div>
						<div className="flex items-center gap-2 min-w-0">
							<span
								className="text-sm truncate select-text"
								style={{ color: theme.colors.textMain }}
								title={installed.targetFolderName}
							>
								{installed.targetFolderName}/
							</span>
							<PlaybookUpdatePill
								theme={theme}
								status={installed}
								testId="marketplace-update-pill"
							/>
						</div>
					</div>
				) : (
					<div className="flex-1">
						<label
							htmlFor="marketplace-target-folder"
							className="block text-xs mb-1"
							style={{ color: theme.colors.textDim }}
						>
							Install to folder (single name inside the Auto Run folder)
						</label>
						<div className="flex items-center gap-2">
							<input
								id="marketplace-target-folder"
								type="text"
								value={targetFolderName}
								onChange={(e) => onTargetFolderChange(e.target.value)}
								className="flex-1 px-3 py-2 rounded border outline-none text-sm focus:ring-1"
								style={{
									borderColor: theme.colors.border,
									color: theme.colors.textMain,
									backgroundColor: theme.colors.bgActivity,
								}}
								placeholder="folder-name"
							/>
							<button
								onClick={onBrowseFolder}
								disabled={isRemoteSession}
								className={`p-2 rounded border transition-colors ${
									isRemoteSession ? 'opacity-50 cursor-not-allowed' : 'hover:bg-white/5'
								}`}
								style={{ borderColor: theme.colors.border }}
								title={
									isRemoteSession
										? 'Browse is not available for remote sessions'
										: 'Browse for folder'
								}
							>
								<FolderOpen className="w-4 h-4" style={{ color: theme.colors.textDim }} />
							</button>
						</div>
					</div>
				)}

				{compatible && (
					<button
						type="button"
						onClick={onInstallOnly}
						disabled={installDisabled}
						className="px-2 py-2 text-sm underline-offset-2 hover:underline transition-colors disabled:opacity-50 disabled:cursor-not-allowed disabled:no-underline mt-5"
						style={{ color: theme.colors.textDim }}
						title={
							installed
								? updateTitle
								: 'Install the documents and playbook record without starting a run'
						}
						data-testid="marketplace-install-only"
					>
						<span className="flex items-center gap-1.5">
							{installed ? (
								<RefreshCw className="w-3.5 h-3.5" />
							) : (
								<Download className="w-3.5 h-3.5" />
							)}
							{installed ? 'Update only' : 'Install only'}
						</span>
					</button>
				)}

				<button
					type="button"
					onClick={onInstallAndRun}
					disabled={installDisabled}
					className="px-4 py-2 rounded font-semibold text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed mt-5"
					style={{
						backgroundColor: theme.colors.accent,
						color: theme.colors.accentForeground,
					}}
					title={incompatibleTitle ?? updateTitle}
					data-testid="marketplace-install-and-run"
				>
					{isImporting ? (
						<span className="flex items-center gap-2">
							<Spinner size={16} />
							{installed ? 'Updating...' : 'Installing...'}
						</span>
					) : !compatible ? (
						<span className="flex items-center gap-2">
							<Download className="w-4 h-4" />
							Update Maestro to install
						</span>
					) : (
						<span className="flex items-center gap-2">
							<Play className="w-4 h-4" />
							{installed ? 'Update and Run' : 'Install and Run'}
						</span>
					)}
				</button>
			</div>
		</div>
	);
}
