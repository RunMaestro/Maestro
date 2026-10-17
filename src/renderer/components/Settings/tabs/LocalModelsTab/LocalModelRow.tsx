/**
 * One model's row: bill of materials, install state, and the actions for it.
 *
 * Shared by the Models tab, Voice Setup, and A Cappella's Models page so
 * no two surfaces can describe the same model differently. Everything shown here comes from the frozen
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

import type { DownloadProgress } from '../../../../../main/local-models/model-downloader';
import type { LocalModelListing } from '../../../../../main/local-models/service';
import type { VerifyResult } from '../../../../../main/local-models/model-store';
import { formatSize } from '../../../../../shared/formatters';
import { formatDurationHuman } from '../../../../../shared/duration';
import { localModelRoleBadges } from '../../../../../shared/local-models/library';
import {
	MODEL_FIT_LABELS,
	type ModelFit,
	type ModelFitLevel,
} from '../../../../../shared/local-models/model-fit';
import {
	USER_MODEL_UNVERIFIED_DETAIL,
	USER_MODEL_UNVERIFIED_LABEL,
} from '../../../../../shared/local-models/user-models';
import type { Theme } from '../../../../types';
import { MiniBadge } from '../../../ui/MiniBadge';

export interface LocalModelRowProps {
	theme: Theme;
	listing: LocalModelListing;
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
	/**
	 * What uses this model right now, in display words ("Tab naming", "Voice:
	 * speech-to-text"). Shown as a line under the description; omitted when empty.
	 */
	usedBy?: readonly string[];
	/**
	 * Bytes of engine the Download button fetches along with the model, when the
	 * runtime that reads it is not installed yet. Stated on the button, because
	 * a download the label did not name is one the user did not agree to.
	 */
	engineBytes?: number;
	/**
	 * The Library's reading of the model: its "good at" sentence in place of the
	 * bill-of-materials description, and a badge per role. Off for the surfaces
	 * that list a model for one fixed job (Voice Setup).
	 */
	showRoles?: boolean;
	/** Whether the model runs on this computer. Omitted until the hardware is read. */
	fit?: ModelFit;
	/**
	 * Take a model the user added out of the Library, files and entry. Offered
	 * only on a user-added row; a curated model has `onRemove` alone.
	 */
	onRemoveFromLibrary?: (modelId: string) => void;
}

/** A download is "in flight" while queued, transferring, or verifying (not paused, not finished). */
/** Whole-model download progress as 0-100; 0 before the total is known. */
export function downloadPercent(progress?: DownloadProgress): number {
	return progress && progress.bytesTotal > 0
		? Math.min(100, Math.round((progress.bytesReceived / progress.bytesTotal) * 100))
		: 0;
}

export function isActive(progress?: DownloadProgress): boolean {
	if (!progress) return false;
	return (
		progress.phase === 'queued' ||
		progress.phase === 'downloading' ||
		progress.phase === 'verifying'
	);
}

function LocalModelRowInner({
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
	usedBy,
	engineBytes = 0,
	showRoles = false,
	fit,
	onRemoveFromLibrary,
}: LocalModelRowProps) {
	const { entry, status, installPaths } = listing;
	const active = isActive(progress);
	const paused = progress?.phase === 'paused';
	const percent = downloadPercent(progress);
	const roleBadges = showRoles ? localModelRoleBadges(entry) : [];

	return (
		<div
			className="rounded border p-3 space-y-2"
			style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgActivity }}
		>
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0">
					<div className="flex flex-wrap items-center gap-1.5">
						<span className="font-medium text-sm" style={{ color: theme.colors.textMain }}>
							{entry.displayName}
						</span>
						{roleBadges.map((badge) => (
							<MiniBadge key={badge} theme={theme} label={badge} />
						))}
						{entry.userAdded && (
							// Shown on every surface that lists the model, not only the Library:
							// where the hash came from is not a detail of one screen.
							<MiniBadge
								theme={theme}
								label={USER_MODEL_UNVERIFIED_LABEL}
								color={theme.colors.warning}
								title={USER_MODEL_UNVERIFIED_DETAIL}
								testId={`local-model-unverified-${entry.id}`}
							/>
						)}
					</div>
					<p className="text-xs opacity-70 mt-0.5">
						{showRoles && entry.goodAt ? entry.goodAt : entry.description}
					</p>
					{fit && <FitLine theme={theme} fit={fit} modelId={entry.id} />}
					{usedBy && usedBy.length > 0 && (
						<p
							className="text-xs-plus mt-0.5"
							style={{ color: theme.colors.accent }}
							data-testid={`local-model-used-by-${entry.id}`}
						>
							In use by {usedBy.join(', ')}
						</p>
					)}
				</div>
				<StatusBadge theme={theme} listing={listing} progress={progress} />
			</div>

			{!compact && (
				<div className="text-xs-plus opacity-55 select-text space-y-0.5">
					<div>
						{formatSize(entry.bytes)} &middot; {entry.source.repo}@
						{entry.source.revision.slice(0, 7)} &middot;{' '}
						<a
							href={entry.license.url}
							target="_blank"
							rel="noreferrer"
							style={{ color: theme.colors.accent }}
						>
							{entry.license.spdx}
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
					<div className="text-xs-plus opacity-55">
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
				<div className="text-xs-plus opacity-55 select-text break-all">
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
				{!active && !paused && status.status === 'not-installed' && !entry.pending && (
					<RowButton
						theme={theme}
						icon={Download}
						label={
							engineBytes > 0
								? `Download (${formatSize(entry.bytes)} + ${formatSize(engineBytes)} engine)`
								: `Download (${formatSize(entry.bytes)})`
						}
						primary
						onClick={() => onDownload(entry.id)}
					/>
				)}
				{!active && !paused && status.status === 'not-installed' && entry.pending && (
					// A model nothing in this build can read is not offered: the row says
					// why instead of inviting a download that would only ever be removed.
					<p className="text-xs-plus opacity-70" style={{ color: theme.colors.warning }}>
						{entry.pending}
					</p>
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
				{!active && onRemoveFromLibrary && entry.userAdded && (
					<RowButton
						theme={theme}
						icon={X}
						label="Remove from Library"
						onClick={() => onRemoveFromLibrary(entry.id)}
					/>
				)}
			</div>
		</div>
	);
}

/**
 * A visible hardware-fit verdict and reason, read before downloading a model.
 */
function FitLine({ theme, fit, modelId }: { theme: Theme; fit: ModelFit; modelId: string }) {
	const colors: Record<ModelFitLevel, string> = {
		fits: theme.colors.success,
		tight: theme.colors.warning,
		'too-large': theme.colors.error,
	};
	const Icon = fit.fit === 'fits' ? CheckCircle2 : AlertTriangle;
	return (
		<div
			className="mt-2 rounded border px-3 py-2 select-text"
			style={{ borderColor: colors[fit.fit], backgroundColor: theme.colors.bgMain }}
			data-testid={`local-model-fit-${modelId}`}
			data-fit={fit.fit}
		>
			<div
				className="flex items-center gap-2 text-sm font-semibold"
				style={{ color: colors[fit.fit] }}
			>
				<Icon className="w-4 h-4 flex-shrink-0" aria-hidden="true" />
				{MODEL_FIT_LABELS[fit.fit]} on this computer
			</div>
			<p className="text-xs opacity-70 mt-1">{fit.reason}</p>
		</div>
	);
}

function StatusBadge({
	theme,
	listing,
	progress,
}: {
	theme: Theme;
	listing: LocalModelListing;
	progress?: DownloadProgress;
}) {
	if (progress && isActive(progress)) {
		return (
			<span className="text-xs-plus opacity-55 flex-shrink-0">
				{progress.phase === 'verifying' ? 'Verifying' : 'Downloading'}
			</span>
		);
	}
	if (progress?.phase === 'paused') {
		return <span className="text-xs-plus opacity-55 flex-shrink-0">Paused</span>;
	}
	if (listing.status.status === 'installed') {
		return (
			<span
				className="text-xs-plus flex items-center gap-1 flex-shrink-0"
				style={{ color: theme.colors.success }}
			>
				<CheckCircle2 className="w-3 h-3" />
				Installed
			</span>
		);
	}
	if (listing.status.status === 'corrupt') {
		return (
			<span className="text-xs-plus flex-shrink-0" style={{ color: theme.colors.warning }}>
				Corrupt
			</span>
		);
	}
	return <span className="text-xs-plus opacity-55 flex-shrink-0">Not installed</span>;
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

export const LocalModelRow = memo(LocalModelRowInner);
