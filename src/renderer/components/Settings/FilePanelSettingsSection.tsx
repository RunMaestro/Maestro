/**
 * FilePanelSettingsSection - Global limits for the file explorer indexer.
 *
 * Exposes two knobs that apply to every session (local and remote):
 * - Max recursion depth (controls how deep the scan walks)
 * - Max file entries (soft cap — scans stop early and the panel shows a
 *   "truncated" warning with a Load More / Load All affordance)
 *
 * Styled to match IgnorePatternsSection so the Settings > Display "File
 * Indexing" group reads as one cohesive section.
 */

import { SlidersHorizontal } from 'lucide-react';
import type { Theme } from '../../types';
import {
	DEFAULT_FILE_EXPLORER_MAX_DEPTH,
	DEFAULT_FILE_EXPLORER_MAX_ENTRIES,
	FILE_EXPLORER_MAX_DEPTH_CAP,
	FILE_EXPLORER_MAX_ENTRIES_CAP,
	FILE_EXPLORER_MIN_DEPTH,
	FILE_EXPLORER_MIN_ENTRIES,
	SSH_REDUCE_ENTRY_CAP_MAX_FRACTION,
	SSH_REDUCE_ENTRY_CAP_MIN_FRACTION,
	SSH_REDUCE_ENTRY_CAP_STEP,
} from '../../stores/settingsStore';

export interface FilePanelSettingsSectionProps {
	theme: Theme;
	maxDepth: number;
	onMaxDepthChange: (value: number) => void;
	maxEntries: number;
	onMaxEntriesChange: (value: number) => void;
	sshReduceEntryCapEnabled: boolean;
	onSshReduceEntryCapEnabledChange: (value: boolean) => void;
	sshReduceEntryCapFraction: number;
	onSshReduceEntryCapFractionChange: (value: number) => void;
}

/** Preset buckets for max entries — kept small so the UI is one click wide. */
const MAX_ENTRY_PRESETS = [10_000, 50_000, 100_000, 250_000, 500_000];

function formatEntries(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`;
	if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
	return value.toLocaleString();
}

export function FilePanelSettingsSection({
	theme,
	maxDepth,
	onMaxDepthChange,
	maxEntries,
	onMaxEntriesChange,
	sshReduceEntryCapEnabled,
	onSshReduceEntryCapEnabledChange,
	sshReduceEntryCapFraction,
	onSshReduceEntryCapFractionChange,
}: FilePanelSettingsSectionProps) {
	const handleResetToDefaults = () => {
		onMaxDepthChange(DEFAULT_FILE_EXPLORER_MAX_DEPTH);
		onMaxEntriesChange(DEFAULT_FILE_EXPLORER_MAX_ENTRIES);
	};

	const depthPct =
		((maxDepth - FILE_EXPLORER_MIN_DEPTH) /
			(FILE_EXPLORER_MAX_DEPTH_CAP - FILE_EXPLORER_MIN_DEPTH)) *
		100;

	const sshFractionPct =
		((sshReduceEntryCapFraction - SSH_REDUCE_ENTRY_CAP_MIN_FRACTION) /
			(SSH_REDUCE_ENTRY_CAP_MAX_FRACTION - SSH_REDUCE_ENTRY_CAP_MIN_FRACTION)) *
		100;
	const sshPercentLabel = `${Math.round(sshReduceEntryCapFraction * 100)}%`;
	const sshResolvedEntries = Math.max(
		FILE_EXPLORER_MIN_ENTRIES,
		Math.floor(maxEntries * sshReduceEntryCapFraction)
	);

	return (
		<div
			className="flex items-start gap-3 p-4 rounded-xl border relative"
			style={{ backgroundColor: theme.colors.bgMain, borderColor: theme.colors.border }}
		>
			{/* Icon */}
			<div
				className="p-2 rounded-lg flex-shrink-0"
				style={{ backgroundColor: theme.colors.accent + '20' }}
			>
				<SlidersHorizontal className="w-5 h-5" style={{ color: theme.colors.accent }} />
			</div>

			{/* Content */}
			<div className="flex-1 min-w-0">
				<p className="font-semibold mb-1">File Panel Settings</p>
				<p className="text-xs opacity-60 mb-4">
					Limits the indexer so huge directories don&apos;t blow up memory. Scans stop at the entry
					cap and the Files panel surfaces a warning with Load More / Load All.
				</p>

				{/* Max depth */}
				<div className="mb-4">
					<div className="flex items-center justify-between mb-2">
						<label htmlFor="file-panel-max-depth" className="text-xs font-medium">
							Max recursion depth
						</label>
						<span
							className="text-xs font-mono px-2 py-0.5 rounded"
							style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textMain }}
						>
							{maxDepth}
						</span>
					</div>
					<input
						id="file-panel-max-depth"
						type="range"
						min={FILE_EXPLORER_MIN_DEPTH}
						max={FILE_EXPLORER_MAX_DEPTH_CAP}
						step={1}
						value={maxDepth}
						onChange={(e) => onMaxDepthChange(Number(e.target.value))}
						className="w-full h-2 rounded-lg appearance-none cursor-pointer"
						style={{
							background: `linear-gradient(to right, ${theme.colors.accent} 0%, ${theme.colors.accent} ${depthPct}%, ${theme.colors.bgActivity} ${depthPct}%, ${theme.colors.bgActivity} 100%)`,
						}}
					/>
					<p className="text-[11px] opacity-50 mt-1">
						Default {DEFAULT_FILE_EXPLORER_MAX_DEPTH}. Deeper scans see more but take longer and use
						more memory.
					</p>
				</div>

				{/* Max entries */}
				<div className="mb-3">
					<div className="flex items-center justify-between mb-2">
						<label className="text-xs font-medium">Max file entries</label>
						<span
							className="text-xs font-mono px-2 py-0.5 rounded"
							style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textMain }}
						>
							{formatEntries(maxEntries)}
						</span>
					</div>
					<div className="flex flex-wrap gap-2">
						{MAX_ENTRY_PRESETS.map((preset) => {
							const isActive = preset === maxEntries;
							return (
								<button
									key={preset}
									type="button"
									onClick={() => onMaxEntriesChange(preset)}
									className="px-2 py-1 rounded text-xs font-mono transition-colors"
									style={{
										backgroundColor: isActive ? theme.colors.accent : theme.colors.bgActivity,
										color: isActive ? theme.colors.bgMain : theme.colors.textMain,
										border: `1px solid ${isActive ? theme.colors.accent : theme.colors.border}`,
									}}
								>
									{formatEntries(preset)}
								</button>
							);
						})}
					</div>
					<p className="text-[11px] opacity-50 mt-2">
						Soft cap. Default {formatEntries(DEFAULT_FILE_EXPLORER_MAX_ENTRIES)}. Valid range{' '}
						{formatEntries(FILE_EXPLORER_MIN_ENTRIES)} –{' '}
						{formatEntries(FILE_EXPLORER_MAX_ENTRIES_CAP)}. The Files panel shows a Load More / Load
						All button when a scan hits this cap.
					</p>
				</div>

				{/* SSH cap reduction */}
				<div className="mb-3 pt-3 border-t" style={{ borderColor: theme.colors.border }}>
					<label className="flex items-center justify-between cursor-pointer">
						<div className="flex-1 min-w-0 pr-3">
							<p className="text-xs font-medium">Reduce entry cap on SSH remotes</p>
							<p className="text-[11px] opacity-50 mt-0.5">
								Apply a fraction of the cap to remote scans. Each directory walked over SSH is a
								separate round-trip, so a smaller cap returns sooner on large remote trees.
							</p>
						</div>
						<input
							type="checkbox"
							checked={sshReduceEntryCapEnabled}
							onChange={(e) => onSshReduceEntryCapEnabledChange(e.target.checked)}
							className="w-4 h-4 flex-shrink-0 cursor-pointer"
							style={{ accentColor: theme.colors.accent }}
						/>
					</label>

					{sshReduceEntryCapEnabled && (
						<div className="mt-3">
							<div className="flex items-center justify-between mb-2">
								<label htmlFor="file-panel-ssh-fraction" className="text-xs font-medium">
									SSH cap fraction
								</label>
								<span
									className="text-xs font-mono px-2 py-0.5 rounded"
									style={{
										backgroundColor: theme.colors.bgActivity,
										color: theme.colors.textMain,
									}}
								>
									{sshPercentLabel}
								</span>
							</div>
							<input
								id="file-panel-ssh-fraction"
								type="range"
								min={SSH_REDUCE_ENTRY_CAP_MIN_FRACTION}
								max={SSH_REDUCE_ENTRY_CAP_MAX_FRACTION}
								step={SSH_REDUCE_ENTRY_CAP_STEP}
								value={sshReduceEntryCapFraction}
								onChange={(e) => onSshReduceEntryCapFractionChange(Number(e.target.value))}
								className="w-full h-2 rounded-lg appearance-none cursor-pointer"
								style={{
									background: `linear-gradient(to right, ${theme.colors.accent} 0%, ${theme.colors.accent} ${sshFractionPct}%, ${theme.colors.bgActivity} ${sshFractionPct}%, ${theme.colors.bgActivity} 100%)`,
								}}
							/>
							<p className="text-[11px] opacity-50 mt-1">
								{formatEntries(maxEntries)} × {sshPercentLabel} ={' '}
								{formatEntries(sshResolvedEntries)} on SSH. Slider steps by 5%.
							</p>
						</div>
					)}
				</div>

				<button
					type="button"
					onClick={handleResetToDefaults}
					className="text-xs hover:underline"
					style={{ color: theme.colors.textDim }}
				>
					Reset to defaults (depth {DEFAULT_FILE_EXPLORER_MAX_DEPTH},{' '}
					{formatEntries(DEFAULT_FILE_EXPLORER_MAX_ENTRIES)} entries)
				</button>
			</div>
		</div>
	);
}

export default FilePanelSettingsSection;
