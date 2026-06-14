import { Download, FolderOpen } from 'lucide-react';
import { isCompatible } from '../../../../shared/marketplace-compatibility';
import type { MarketplacePlaybook } from '../../../../shared/marketplace-types';
import { Spinner } from '../../ui/Spinner';
import type { Theme } from '../../../types';

export interface PlaybookImportFooterProps {
	theme: Theme;
	playbook: MarketplacePlaybook;
	targetFolderName: string;
	isImporting: boolean;
	isRemoteSession: boolean;
	runningVersion: string;
	onTargetFolderChange: (name: string) => void;
	onBrowseFolder: () => void;
	onImport: () => void;
}

export function PlaybookImportFooter({
	theme,
	playbook,
	targetFolderName,
	isImporting,
	isRemoteSession,
	runningVersion,
	onTargetFolderChange,
	onBrowseFolder,
	onImport,
}: PlaybookImportFooterProps) {
	const compatible = isCompatible(playbook, runningVersion);

	return (
		<div
			className="shrink-0 px-4 py-3 border-t"
			style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
		>
			<div className="flex items-center gap-3">
				<div className="flex-1">
					<label
						htmlFor="marketplace-target-folder"
						className="block text-xs mb-1"
						style={{ color: theme.colors.textDim }}
					>
						Import to folder (single name inside the Auto Run folder)
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

				<button
					onClick={onImport}
					disabled={isImporting || !targetFolderName.trim() || !compatible}
					className="px-4 py-2 rounded font-semibold text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed mt-5"
					style={{
						backgroundColor: theme.colors.accent,
						color: theme.colors.accentForeground,
					}}
					title={
						!compatible
							? `Update Maestro to ${playbook.minMaestroVersion} or newer to install this playbook.`
							: undefined
					}
				>
					{isImporting ? (
						<span className="flex items-center gap-2">
							<Spinner size={16} />
							Importing...
						</span>
					) : !compatible ? (
						<span className="flex items-center gap-2">
							<Download className="w-4 h-4" />
							Update Maestro to install
						</span>
					) : (
						<span className="flex items-center gap-2">
							<Download className="w-4 h-4" />
							Import Playbook
						</span>
					)}
				</button>
			</div>
		</div>
	);
}
