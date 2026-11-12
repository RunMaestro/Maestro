import { Download, FolderOpen, Rocket } from 'lucide-react';
import { isCompatible } from '../../../../shared/marketplace-compatibility';
import type { MarketplacePlaybook } from '../../../../shared/marketplace-types';
import { hostPlatform } from '../../../utils/platformUtils';
import { Spinner } from '../../ui/Spinner';
import type { Theme } from '../../../types';
import { getLaunchOffer } from '../launch/launchOffer';

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
	/** Open the launch dialog for this playbook. Offered only when the playbook can launch here. */
	onLaunch: () => void;
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
	onLaunch,
}: PlaybookImportFooterProps) {
	const compatible = isCompatible(playbook, runningVersion);
	// A playbook with a launch block gets Launch as the primary action and Download beside it.
	// One whose launch cannot run here keeps Download alone and says why on hover; one without a
	// launch block is exactly what it was.
	const offer = getLaunchOffer(playbook, runningVersion, hostPlatform());
	const launchOffered = offer.status === 'available';
	const hasLaunchBlock = offer.status !== 'none';

	const importTitle = !compatible
		? `Update Maestro to ${playbook.minMaestroVersion} or newer to install this playbook.`
		: offer.status === 'unavailable'
			? offer.reason
			: undefined;
	const downloadIsPrimary = !launchOffered;

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
						{hasLaunchBlock ? 'Download' : 'Import'} to folder (single name inside the Auto Run
						folder)
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

				<div className="flex items-center gap-2 mt-5">
					{launchOffered && (
						<button
							onClick={onLaunch}
							disabled={isImporting}
							className="px-4 py-2 rounded font-semibold text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
							style={{
								backgroundColor: theme.colors.accent,
								color: theme.colors.accentForeground,
							}}
							data-testid="playbook-launch-button"
						>
							<span className="flex items-center gap-2">
								<Rocket className="w-4 h-4" />
								Launch
							</span>
						</button>
					)}

					<button
						onClick={onImport}
						disabled={isImporting || !targetFolderName.trim() || !compatible}
						className={`px-4 py-2 rounded text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
							downloadIsPrimary ? 'font-semibold' : 'font-medium border hover:bg-white/5'
						}`}
						style={
							downloadIsPrimary
								? {
										backgroundColor: theme.colors.accent,
										color: theme.colors.accentForeground,
									}
								: { borderColor: theme.colors.border, color: theme.colors.textMain }
						}
						title={importTitle}
						data-testid="playbook-import-button"
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
								{hasLaunchBlock ? 'Download' : 'Import Playbook'}
							</span>
						)}
					</button>
				</div>
			</div>
		</div>
	);
}
