/**
 * One model's row: bill of materials, install state, and the actions for it.
 *
 * Shared by Voice Setup and the Models page so the two surfaces cannot describe
 * the same model differently. Everything shown here comes from the frozen
 * catalog plus a disk stat; nothing in this component can start a download by
 * rendering, which is the property the panel test asserts.
 *
 * Text selection: the row is click-driven so its container carries `select-none`
 * (from the panel root), but the install path and the license line get
 * `select-text` back. A path you cannot copy is a path you have to retype.
 */

import { memo } from 'react';
import {
	AlertTriangle,
	CheckCircle2,
	Download,
	Pause,
	Play,
	RefreshCw,
	Trash2,
	X,
} from 'lucide-react';

import type { DownloadProgress } from '../../../../main/acappella/models/model-downloader';
import type { VoiceModelListing } from '../../../../main/ipc/handlers/acappella-models';
import type { VerifyResult } from '../../../../main/acappella/models/model-store';
import { formatSize } from '../../../../shared/formatters';
import { formatDurationHuman } from '../../../../shared/duration';
import type { Theme } from '../../../types';

export interface VoiceModelRowProps {
	theme: Theme;
	listing: VoiceModelListing;
	progress?: DownloadProgress;
	verifyResult?: VerifyResult;
	/** Hides the license and path block on the compact Models page. */
	compact?: boolean;
	onDownload: (modelId: string) => void;
	onPause: (modelId: string) => void;
	onResume: (modelId: string) => void;
	onCancel: (modelId: string) => void;
	onVerify: (modelId: string) => void;
	onRemove?: (modelId: string) => void;
}

/** A download is "in flight" in every phase except the terminal ones. */
function isActive(progress?: DownloadProgress): boolean {
	if (!progress) return false;
	return (
		progress.phase === 'queued' ||
		progress.phase === 'downloading' ||
		progress.phase === 'verifying'
	);
}

function VoiceModelRowInner({
	theme,
	listing,
	progress,
	verifyResult,
	compact = false,
	onDownload,
	onPause,
	onResume,
	onCancel,
	onVerify,
	onRemove,
}: VoiceModelRowProps) {
	const { entry, status, installPaths } = listing;
	const active = isActive(progress);
	const paused = progress?.phase === 'paused';
	const percent =
		progress && progress.bytesTotal > 0
			? Math.min(100, Math.round((progress.bytesReceived / progress.bytesTotal) * 100))
			: 0;

	return (
		<div
			className="rounded border p-3 space-y-2"
			style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgActivity }}
		>
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0">
					<div className="font-medium text-sm" style={{ color: theme.colors.textMain }}>
						{entry.displayName}
					</div>
					<p className="text-xs opacity-70 mt-0.5">{entry.description}</p>
				</div>
				<StatusBadge theme={theme} listing={listing} progress={progress} />
			</div>

			{!compact && (
				<div className="text-[11px] opacity-55 select-text space-y-0.5">
					<div>
						{formatSize(entry.bytes)} &middot; {entry.repo}@{entry.revision.slice(0, 7)} &middot;{' '}
						<a
							href={entry.licenseUrl}
							target="_blank"
							rel="noreferrer"
							style={{ color: theme.colors.accent }}
						>
							{entry.license}
						</a>
					</div>
					{installPaths.map((installPath) => (
						<div key={installPath} className="break-all">
							{installPath}
						</div>
					))}
				</div>
			)}

			{(active || paused) && progress && (
				<div className="space-y-1">
					<div
						className="h-1.5 rounded overflow-hidden"
						style={{ backgroundColor: theme.colors.border }}
					>
						<div
							className="h-full transition-all"
							style={{ width: `${percent}%`, backgroundColor: theme.colors.accent }}
						/>
					</div>
					<div className="text-[11px] opacity-55">
						{formatSize(progress.bytesReceived)} of {formatSize(progress.bytesTotal)}
						{progress.bytesPerSecond > 0 && ` at ${formatSize(progress.bytesPerSecond)}/s`}
						{progress.etaSeconds !== null &&
							`, ${formatDurationHuman(progress.etaSeconds * 1000)} left`}
						{progress.currentFile && ` - ${progress.currentFile}`}
					</div>
				</div>
			)}

			{status.status === 'corrupt' && (
				// Above the actions, per the style guide: the caution is read before the
				// choice it qualifies.
				<div className="flex items-start gap-1.5 text-xs" style={{ color: theme.colors.warning }}>
					<AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
					<span>
						{status.detail ?? 'This model failed verification.'} Re-verify to confirm, or
						re-download to replace it.
					</span>
				</div>
			)}

			{verifyResult?.mismatch && (
				<div className="text-[11px] opacity-55 select-text break-all">
					{verifyResult.mismatch.path}: expected {verifyResult.mismatch.expected}, got{' '}
					{verifyResult.mismatch.actual}
				</div>
			)}

			<div className="flex flex-wrap gap-2">
				{active && (
					<RowButton theme={theme} icon={Pause} label="Pause" onClick={() => onPause(entry.id)} />
				)}
				{paused && (
					<RowButton theme={theme} icon={Play} label="Resume" onClick={() => onResume(entry.id)} />
				)}
				{(active || paused) && (
					<RowButton theme={theme} icon={X} label="Cancel" onClick={() => onCancel(entry.id)} />
				)}
				{!active && !paused && status.status === 'not-installed' && (
					<RowButton
						theme={theme}
						icon={Download}
						label={`Download (${formatSize(entry.bytes)})`}
						primary
						onClick={() => onDownload(entry.id)}
					/>
				)}
				{!active && !paused && status.status === 'corrupt' && (
					<RowButton
						theme={theme}
						icon={Download}
						label={`Re-download (${formatSize(entry.bytes)})`}
						onClick={() => onDownload(entry.id)}
					/>
				)}
				{!active && status.manifest && (
					<RowButton
						theme={theme}
						icon={RefreshCw}
						label="Re-verify"
						onClick={() => onVerify(entry.id)}
					/>
				)}
				{!active && onRemove && status.bytesOnDisk > 0 && (
					<RowButton
						theme={theme}
						icon={Trash2}
						label={`Remove (${formatSize(status.bytesOnDisk)})`}
						onClick={() => onRemove(entry.id)}
					/>
				)}
			</div>
		</div>
	);
}

function StatusBadge({
	theme,
	listing,
	progress,
}: {
	theme: Theme;
	listing: VoiceModelListing;
	progress?: DownloadProgress;
}) {
	if (progress && isActive(progress)) {
		return (
			<span className="text-[11px] opacity-55 flex-shrink-0">
				{progress.phase === 'verifying' ? 'Verifying' : 'Downloading'}
			</span>
		);
	}
	if (progress?.phase === 'paused') {
		return <span className="text-[11px] opacity-55 flex-shrink-0">Paused</span>;
	}
	if (listing.status.status === 'installed') {
		return (
			<span
				className="text-[11px] flex items-center gap-1 flex-shrink-0"
				style={{ color: theme.colors.success }}
			>
				<CheckCircle2 className="w-3 h-3" />
				Installed
			</span>
		);
	}
	if (listing.status.status === 'corrupt') {
		return (
			<span className="text-[11px] flex-shrink-0" style={{ color: theme.colors.warning }}>
				Corrupt
			</span>
		);
	}
	return <span className="text-[11px] opacity-55 flex-shrink-0">Not installed</span>;
}

function RowButton({
	theme,
	icon: Icon,
	label,
	onClick,
	primary = false,
}: {
	theme: Theme;
	icon: typeof Download;
	label: string;
	onClick: () => void;
	primary?: boolean;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className="px-2 py-1 rounded border text-xs flex items-center gap-1.5"
			style={{
				borderColor: primary ? theme.colors.accent : theme.colors.border,
				backgroundColor: primary ? theme.colors.accentDim : 'transparent',
				color: theme.colors.textMain,
			}}
		>
			<Icon className="w-3 h-3" />
			{label}
		</button>
	);
}

export const VoiceModelRow = memo(VoiceModelRowInner);
