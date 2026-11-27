import { useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { UpdateStatus } from '../types';
import {
	X,
	Download,
	ExternalLink,
	CheckCircle2,
	AlertCircle,
	RefreshCw,
	RotateCcw,
	History,
	ChevronDown,
	ChevronRight,
	FlaskConical,
	Clock,
	Play,
} from 'lucide-react';
import { GhostIconButton } from './ui/GhostIconButton';
import { Spinner } from './ui/Spinner';
import type { Theme } from '../types';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { Modal } from './ui/Modal';
import { useSettings } from '../hooks';
import { UpdateReleaseCard } from './UpdateReleaseCard';
import { UpdateRollbackPanel } from './UpdateRollbackPanel';
import { openUrl } from '../utils/openUrl';
import { selectIsAnySessionBusy, useSessionStore } from '../stores/sessionStore';
import { selectHasAnyActiveBatch, useBatchStore } from '../stores/batchStore';
import { useRestartPendingStore } from '../stores/restartPendingStore';
import { notifyToast } from '../stores/notificationStore';
import {
	saveAutoRunsForRestart,
	selectResumableAutoRunIds,
} from '../services/autoRunRestartResume';
import { ipcErrorMessage } from '../../shared/serializeError';
import { formatSize } from '../../shared/formatters';
import { normalizeReleaseTag, type RollbackTargetsResult } from '../../shared/updateRollback';
import { compareVersions } from '../../shared/pathUtils';

interface Release {
	tag_name: string;
	name: string;
	body: string;
	html_url: string;
	published_at: string;
}

interface UpdateCheckResult {
	currentVersion: string;
	latestVersion: string;
	updateAvailable: boolean;
	versionsBehind: number;
	releases: Release[];
	releasesUrl: string;
	assetsReady: boolean;
	error?: string;
}

/** What a download is: a forward update, or a rollback to an earlier release. */
type DownloadKind = 'update' | 'rollback';

interface UpdateCheckModalProps {
	theme: Theme;
	onClose: () => void;
}

export function UpdateCheckModal({ theme, onClose }: UpdateCheckModalProps) {
	const [loading, setLoading] = useState(true);
	const [result, setResult] = useState<UpdateCheckResult | null>(null);
	const [expandedReleases, setExpandedReleases] = useState<Set<string>>(new Set());

	// Get beta updates setting
	const { enableBetaUpdates, setEnableBetaUpdates } = useSettings();

	// Auto-updater state
	const [downloadStatus, setDownloadStatus] = useState<UpdateStatus>({ status: 'idle' });
	const [downloadError, setDownloadError] = useState<string | null>(null);
	const [showBusyWarning, setShowBusyWarning] = useState(false);
	// What this modal last asked main to download: a forward update, or a
	// rollback to `downloadTag`. The update and rollback sections must not show
	// each other's progress or Restart button.
	const [downloadKind, setDownloadKind] = useState<DownloadKind | null>(null);
	const [downloadTag, setDownloadTag] = useState<string | null>(null);
	// A finished download names its version, which settles the question even for
	// a download this modal did not start (`maestro-cli rollback`). Mid-download
	// status carries no version, so the modal's own request decides then.
	const downloadedVersion = downloadStatus.info?.version;
	const activeDownloadKind: DownloadKind = downloadedVersion
		? compareVersions(downloadedVersion, __APP_VERSION__) < 0
			? 'rollback'
			: 'update'
		: (downloadKind ?? 'update');
	const activeDownloadTag =
		downloadTag ?? (downloadedVersion ? normalizeReleaseTag(downloadedVersion) : null);

	// Rollback section: collapsed until asked for, and its list is fetched the
	// first time it opens, so a plain update check never pays for it.
	const [rollbackOpen, setRollbackOpen] = useState(false);
	const [rollbackLoading, setRollbackLoading] = useState(false);
	const [rollbackResult, setRollbackResult] = useState<RollbackTargetsResult | null>(null);
	const [rollbackReload, setRollbackReload] = useState(0);
	// A rollback in flight or ready to install keeps its section open, even one
	// started outside this window (`maestro-cli rollback`).
	const showRollback =
		rollbackOpen ||
		(activeDownloadKind === 'rollback' &&
			(downloadStatus.status === 'downloading' || downloadStatus.status === 'downloaded'));

	// Idle / restart-pending state
	const anySessionBusy = useSessionStore(selectIsAnySessionBusy);
	const anyBatchRunning = useBatchStore(selectHasAnyActiveBatch);
	const isAppActive = anySessionBusy || anyBatchRunning;
	const restartPending = useRestartPendingStore((s) => s.pending);
	const setRestartPending = useRestartPendingStore((s) => s.setPending);

	// Auto Runs survive the restart: each one's place is saved and the next
	// launch continues it (services/autoRunRestartResume.ts). Work that does
	// NOT survive is an interactive turn, or a run this client cannot save
	// (a mirror of another window's run, or one already stopping).
	const resumableAutoRunIds = useBatchStore(
		useShallow((s) => selectResumableAutoRunIds(s.batchRunStates))
	);
	const runningBatchIds = useBatchStore(
		useShallow((s) =>
			Object.entries(s.batchRunStates)
				.filter(([, state]) => state.isRunning)
				.map(([sessionId]) => sessionId)
		)
	);
	const otherAgentsBusy = useSessionStore((s) =>
		s.sessions.some((session) => session.state === 'busy' && !runningBatchIds.includes(session.id))
	);
	// An older build may predate Auto Run restart-resume, so a rollback restart
	// never promises it (and never saves runs it cannot honor).
	const resumableCount = activeDownloadKind === 'rollback' ? 0 : resumableAutoRunIds.length;
	const onlyResumableWork =
		resumableCount > 0 && !otherAgentsBusy && runningBatchIds.length === resumableCount;
	const autoRunNoun = resumableCount === 1 ? 'Auto Run' : 'Auto Runs';
	const [savingAutoRuns, setSavingAutoRuns] = useState(false);
	// Check for updates on mount
	useEffect(() => {
		checkForUpdates();
	}, [enableBetaUpdates]);

	// Load the rollback list when that section shows (or the beta toggle changes
	// it). Keyed on `showRollback`, not `rollbackOpen`: a CLI-started rollback
	// opens the section without a click and still needs its list.
	useEffect(() => {
		if (!showRollback) return;
		let cancelled = false;
		setRollbackLoading(true);
		window.maestro.updates
			.listRollbackTargets(enableBetaUpdates)
			.then((targets) => {
				if (!cancelled) setRollbackResult(targets);
			})
			.catch((error) => {
				if (cancelled) return;
				setRollbackResult({
					currentVersion: __APP_VERSION__,
					releases: [],
					releasesUrl: 'https://github.com/RunMaestro/Maestro/releases',
					error: ipcErrorMessage(error, 'Failed to load earlier releases'),
				});
			})
			.finally(() => {
				if (!cancelled) setRollbackLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [showRollback, enableBetaUpdates, rollbackReload]);

	// Subscribe to update status changes
	useEffect(() => {
		const unsubscribe = window.maestro.updates.onStatus((status) => {
			setDownloadStatus(status);
			if (status.status === 'error' && status.error) {
				setDownloadError(status.error);
			}
		});
		return () => unsubscribe();
	}, []);

	const checkForUpdates = async () => {
		setLoading(true);
		setDownloadError(null);
		try {
			const updateResult = await window.maestro.updates.check(enableBetaUpdates);
			setResult(updateResult);
			// Auto-expand if only 1 version behind, otherwise keep all collapsed
			if (updateResult.updateAvailable && updateResult.releases.length === 1) {
				setExpandedReleases(new Set([updateResult.releases[0].tag_name]));
			} else {
				setExpandedReleases(new Set());
			}
		} catch (error) {
			setResult({
				currentVersion: __APP_VERSION__,
				latestVersion: __APP_VERSION__,
				updateAvailable: false,
				assetsReady: false,
				versionsBehind: 0,
				releases: [],
				releasesUrl: 'https://github.com/RunMaestro/Maestro/releases',
				error: error instanceof Error ? error.message : 'Failed to check for updates',
			});
		} finally {
			setLoading(false);
		}
	};

	const toggleRelease = (tagName: string) => {
		setExpandedReleases((prev) => {
			const next = new Set(prev);
			if (next.has(tagName)) {
				next.delete(tagName);
			} else {
				next.add(tagName);
			}
			return next;
		});
	};

	const handleDownloadUpdate = async () => {
		setDownloadError(null);
		setShowBusyWarning(false);
		setDownloadKind('update');
		setDownloadTag(result?.releases?.[0]?.tag_name ?? null);
		setDownloadStatus({
			status: 'downloading',
			progress: { percent: 0, bytesPerSecond: 0, total: 0, transferred: 0 },
		});

		// Hand the main process the exact release tag we're offering so it can fetch
		// from GitHub's CDN asset path instead of the flaky `releases.atom` feed.
		// `result.releases` is newest-first, so [0] is the version shown to the user.
		const targetTag = result?.releases?.[0]?.tag_name;
		const downloadResult = await window.maestro.updates.download(targetTag);
		if (!downloadResult.success && downloadResult.error) {
			setDownloadError(downloadResult.error);
			setDownloadStatus({ status: 'error', error: downloadResult.error });
		}
	};

	const handleRollback = async (tag: string) => {
		setDownloadError(null);
		setShowBusyWarning(false);
		setRestartPending(false);
		setDownloadKind('rollback');
		setDownloadTag(tag);
		setDownloadStatus({
			status: 'downloading',
			progress: { percent: 0, bytesPerSecond: 0, total: 0, transferred: 0 },
		});
		const rollbackResult = await window.maestro.updates.rollback(tag);
		if (!rollbackResult.success && rollbackResult.error) {
			setDownloadError(rollbackResult.error);
			setDownloadStatus({ status: 'error', error: rollbackResult.error });
		}
	};

	const handleInstallUpdate = () => {
		if (isAppActive) {
			setShowBusyWarning(true);
			return;
		}
		window.maestro.updates.install();
	};

	const handleRestartNow = async () => {
		if (resumableCount > 0) {
			setSavingAutoRuns(true);
			try {
				await saveAutoRunsForRestart('update');
			} catch (error) {
				// Restarting now would drop the runs the user was told would resume.
				setSavingAutoRuns(false);
				notifyToast({
					type: 'error',
					title: 'Restart Canceled',
					message: `Could not save Auto Run progress: ${ipcErrorMessage(error)}`,
					dismissible: true,
				});
				return;
			}
		}
		setShowBusyWarning(false);
		setRestartPending(false);
		window.maestro.updates.install();
	};

	const handleRestartWhenIdle = () => {
		setShowBusyWarning(false);
		setRestartPending(true);
	};

	const handleCancelPendingRestart = () => {
		setRestartPending(false);
	};

	const isDownloading = downloadStatus.status === 'downloading';
	const isDownloaded = downloadStatus.status === 'downloaded';
	const isUpdateDownloaded = isDownloaded && activeDownloadKind === 'update';
	const isRollbackDownloaded = isDownloaded && activeDownloadKind === 'rollback';

	const releasesUrl = result?.releasesUrl ?? 'https://github.com/RunMaestro/Maestro/releases';

	// Each section shows only its own download: a failed rollback is not a failed update.
	const ownsDownload = (kind: DownloadKind) => activeDownloadKind === kind;

	const renderDownloadError = (kind: DownloadKind) =>
		downloadError && ownsDownload(kind) ? (
			<div
				className="p-3 rounded border text-xs"
				style={{
					backgroundColor: `${theme.colors.error}15`,
					borderColor: theme.colors.error,
					color: theme.colors.error,
				}}
			>
				<div className="flex items-center gap-2 mb-1">
					<AlertCircle className="w-4 h-4" />
					<span className="font-bold">Download failed</span>
				</div>
				<p style={{ color: theme.colors.textDim }}>{downloadError}</p>
				<button
					onClick={() => openUrl(releasesUrl)}
					className="flex items-center gap-1 mt-2 hover:underline"
					style={{ color: theme.colors.accent }}
				>
					Download manually from GitHub
					<ExternalLink className="w-3 h-3" />
				</button>
			</div>
		) : null;

	const renderDownloadProgress = (kind: DownloadKind, label: string) =>
		isDownloading && downloadStatus.progress && ownsDownload(kind) ? (
			<div className="space-y-2">
				<div
					className="flex items-center justify-between text-xs"
					style={{ color: theme.colors.textDim }}
				>
					<span>{label}</span>
					<span>{Math.round(downloadStatus.progress.percent)}%</span>
				</div>
				<div
					className="h-2 rounded-full overflow-hidden"
					style={{ backgroundColor: theme.colors.bgActivity }}
				>
					<div
						className="h-full transition-all duration-300 rounded-full"
						style={{
							width: `${downloadStatus.progress.percent}%`,
							backgroundColor: theme.colors.accent,
						}}
					/>
				</div>
				<div
					className="flex items-center justify-between text-xs"
					style={{ color: theme.colors.textDim }}
				>
					<span>
						{formatSize(downloadStatus.progress.transferred)} /{' '}
						{formatSize(downloadStatus.progress.total)}
					</span>
					<span>{formatSize(downloadStatus.progress.bytesPerSecond)}/s</span>
				</div>
			</div>
		) : null;

	// What follows a finished download, for an update and a rollback alike: a
	// pending-restart banner, the busy-app warning, or the Restart button.
	const renderRestartControls = (installLabel: string) =>
		restartPending ? (
			<div
				className="p-3 rounded-lg border space-y-2"
				style={{
					backgroundColor: `${theme.colors.warning}15`,
					borderColor: theme.colors.warning,
				}}
			>
				<div className="flex items-start gap-2">
					<Clock className="w-4 h-4 mt-0.5 shrink-0" style={{ color: theme.colors.warning }} />
					<div className="flex-1">
						<div className="text-sm font-bold" style={{ color: theme.colors.textMain }}>
							Restart pending
						</div>
						<div className="text-xs mt-0.5" style={{ color: theme.colors.textDim }}>
							{isAppActive
								? 'Maestro will restart automatically once all agents and Auto Runs finish.'
								: 'Restarting…'}
						</div>
					</div>
				</div>
				<div className="flex gap-2">
					<button
						onClick={handleCancelPendingRestart}
						className="flex-1 p-2 rounded text-xs font-medium transition-colors hover:bg-white/10"
						style={{
							borderColor: theme.colors.border,
							borderWidth: 1,
							color: theme.colors.textMain,
						}}
					>
						Cancel
					</button>
					<button
						onClick={handleRestartNow}
						className="flex-1 p-2 rounded text-xs font-bold transition-colors hover:opacity-90"
						style={{
							backgroundColor: theme.colors.warning,
							color: theme.colors.bgMain,
						}}
					>
						Restart Now Anyway
					</button>
				</div>
			</div>
		) : showBusyWarning ? (
			<div
				className="p-3 rounded-lg border space-y-3"
				style={{
					backgroundColor: `${theme.colors.warning}15`,
					borderColor: theme.colors.warning,
				}}
			>
				<div className="flex items-start gap-2">
					<AlertCircle
						className="w-4 h-4 mt-0.5 shrink-0"
						style={{ color: theme.colors.warning }}
					/>
					<div className="flex-1">
						<div className="text-sm font-bold" style={{ color: theme.colors.textMain }}>
							{onlyResumableWork ? `${autoRunNoun} will resume` : 'Maestro is busy'}
						</div>
						<div className="text-xs mt-0.5" style={{ color: theme.colors.textDim }}>
							{onlyResumableWork ? (
								<>
									Maestro saves {resumableCount === 1 ? 'its' : 'each run’s'} place, restarts into
									the new version, and continues at the task it was on. That task starts over from
									the top.
								</>
							) : (
								<>
									{anySessionBusy && anyBatchRunning
										? 'Agents are working and Auto Runs are in progress.'
										: anySessionBusy
											? 'One or more agents are currently working.'
											: 'One or more Auto Runs are in progress.'}{' '}
									{resumableCount > 0
										? `Restarting now interrupts agent work in progress. ${autoRunNoun} resume${resumableCount === 1 ? 's' : ''} after the restart.`
										: 'Restarting now will interrupt them.'}
								</>
							)}
						</div>
					</div>
				</div>
				{onlyResumableWork ? (
					<div className="flex flex-col gap-2">
						<button
							onClick={handleRestartNow}
							disabled={savingAutoRuns}
							className="w-full flex items-center justify-center gap-2 p-2 rounded text-sm font-bold transition-colors hover:opacity-90 disabled:opacity-50"
							style={{
								backgroundColor: theme.colors.accent,
								color: theme.colors.bgMain,
							}}
						>
							{savingAutoRuns ? <Spinner size={16} /> : <RotateCcw className="w-4 h-4" />}
							Restart and Resume {autoRunNoun}
						</button>
						<div className="flex gap-2">
							<button
								onClick={() => setShowBusyWarning(false)}
								disabled={savingAutoRuns}
								className="flex-1 p-2 rounded text-xs font-medium transition-colors hover:bg-white/10 disabled:opacity-50"
								style={{
									borderColor: theme.colors.border,
									borderWidth: 1,
									color: theme.colors.textMain,
								}}
							>
								Cancel
							</button>
							<button
								onClick={handleRestartWhenIdle}
								disabled={savingAutoRuns}
								className="flex-1 flex items-center justify-center gap-1.5 p-2 rounded text-xs font-medium transition-colors hover:bg-white/10 disabled:opacity-50"
								style={{
									borderColor: theme.colors.border,
									borderWidth: 1,
									color: theme.colors.textMain,
								}}
							>
								<Clock className="w-3.5 h-3.5" />
								Wait Until {autoRunNoun} Finish
							</button>
						</div>
					</div>
				) : (
					<div className="flex flex-col gap-2">
						<button
							onClick={handleRestartWhenIdle}
							className="w-full flex items-center justify-center gap-2 p-2 rounded text-sm font-bold transition-colors hover:opacity-90"
							style={{
								backgroundColor: theme.colors.accent,
								color: theme.colors.bgMain,
							}}
						>
							<Clock className="w-4 h-4" />
							Restart App When Idle
						</button>
						<div className="flex gap-2">
							<button
								onClick={() => setShowBusyWarning(false)}
								className="flex-1 p-2 rounded text-xs font-medium transition-colors hover:bg-white/10"
								style={{
									borderColor: theme.colors.border,
									borderWidth: 1,
									color: theme.colors.textMain,
								}}
							>
								Cancel
							</button>
							<button
								onClick={handleRestartNow}
								className="flex-1 p-2 rounded text-xs font-bold transition-colors hover:opacity-90"
								style={{
									backgroundColor: theme.colors.warning,
									color: theme.colors.bgMain,
								}}
							>
								Restart Now Anyway
							</button>
						</div>
					</div>
				)}
			</div>
		) : (
			<button
				onClick={handleInstallUpdate}
				className="w-full flex items-center justify-center gap-2 p-3 rounded-lg font-bold text-sm transition-colors hover:opacity-90"
				style={{ backgroundColor: theme.colors.success, color: theme.colors.bgMain }}
			>
				<RotateCcw className="w-4 h-4" />
				{installLabel}
			</button>
		);

	// Custom header with refresh button
	const customHeader = (
		<div
			className="p-4 border-b flex items-center justify-between shrink-0"
			style={{ borderColor: theme.colors.border }}
		>
			<div className="flex items-center gap-2">
				<Download className="w-5 h-5" style={{ color: theme.colors.accent }} />
				<h2 className="text-sm font-bold" style={{ color: theme.colors.textMain }}>
					Check for Updates or Rollback
				</h2>
			</div>
			<div className="flex items-center gap-2">
				<button
					onClick={() => {
						checkForUpdates();
						if (showRollback) setRollbackReload((n) => n + 1);
					}}
					disabled={loading || rollbackLoading || isDownloading}
					className="p-1 rounded hover:bg-white/10 transition-colors disabled:opacity-50"
					title="Refresh"
				>
					<RefreshCw
						className={`w-4 h-4 ${loading || rollbackLoading ? 'animate-spin' : ''}`}
						style={{ color: theme.colors.textDim }}
					/>
				</button>
				<GhostIconButton onClick={onClose} color={theme.colors.textDim} ariaLabel="Close">
					<X className="w-4 h-4" />
				</GhostIconButton>
			</div>
		</div>
	);

	return (
		<Modal
			theme={theme}
			title="Check for Updates or Rollback"
			priority={MODAL_PRIORITIES.UPDATE_CHECK}
			onClose={onClose}
			customHeader={customHeader}
			width={1250}
			maxWidthCss="50vw"
			maxHeight="80vh"
		>
			<div className="space-y-4 -my-2">
				{loading ? (
					<div className="flex flex-col items-center justify-center py-8 gap-3">
						<Spinner size={32} color={theme.colors.accent} />
						<span className="text-sm" style={{ color: theme.colors.textDim }}>
							Checking for updates...
						</span>
					</div>
				) : result?.error ? (
					<div className="flex flex-col items-center justify-center py-8 gap-3">
						<AlertCircle className="w-8 h-8" style={{ color: theme.colors.error }} />
						<span className="text-sm text-center" style={{ color: theme.colors.textDim }}>
							{result.error}
						</span>
						<button
							onClick={() => openUrl(result.releasesUrl)}
							className="flex items-center gap-2 text-sm hover:underline"
							style={{ color: theme.colors.accent }}
						>
							Check releases manually
							<ExternalLink className="w-3 h-3" />
						</button>
					</div>
				) : result?.updateAvailable ? (
					<>
						{/* Update Available Banner */}
						<div
							className="p-4 rounded-lg border"
							style={{
								backgroundColor: `${theme.colors.warning}15`,
								borderColor: theme.colors.warning,
							}}
						>
							<div className="flex items-start gap-3">
								<Download className="w-5 h-5 mt-0.5" style={{ color: theme.colors.warning }} />
								<div className="flex-1">
									<div className="text-sm font-bold mb-1" style={{ color: theme.colors.textMain }}>
										Update Available!
									</div>
									<div className="text-xs mb-2" style={{ color: theme.colors.textDim }}>
										You are{' '}
										<span className="font-bold" style={{ color: theme.colors.warning }}>
											{result.versionsBehind} version{result.versionsBehind !== 1 ? 's' : ''}
										</span>{' '}
										behind the latest release.
									</div>
									<div className="text-xs font-mono" style={{ color: theme.colors.textDim }}>
										Current: v{result.currentVersion} → Latest: v{result.latestVersion}
									</div>
									{resumableCount > 0 && (
										<div
											className="flex items-center gap-1.5 text-xs mt-2"
											style={{ color: theme.colors.success }}
											data-testid="update-autorun-resume-note"
										>
											<Play className="w-3.5 h-3.5 shrink-0" />
											<span>
												No need to wait: your{' '}
												{resumableCount === 1 ? 'Auto Run' : `${resumableCount} Auto Runs`} will
												pick up where {resumableCount === 1 ? 'it' : 'they'} left off after the
												update.
											</span>
										</div>
									)}
								</div>
							</div>
						</div>

						{/* Release Notes */}
						<div>
							<div className="text-sm font-bold mb-3" style={{ color: theme.colors.textMain }}>
								Release Notes
							</div>
							<div className="space-y-2">
								{result.releases.map((release) => (
									<UpdateReleaseCard
										key={release.tag_name}
										theme={theme}
										release={release}
										expanded={expandedReleases.has(release.tag_name)}
										onToggle={() => toggleRelease(release.tag_name)}
									/>
								))}
							</div>
						</div>

						{renderDownloadError('update')}
						{renderDownloadProgress('update', 'Downloading update...')}

						{/* Action Buttons */}
						<div className="space-y-2">
							{isUpdateDownloaded ? (
								renderRestartControls('Restart to Update')
							) : !result.assetsReady ? (
								/* Assets not yet available - show building message */
								<div
									className="w-full flex items-center justify-center gap-2 p-3 rounded-lg text-sm"
									style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textDim }}
								>
									<Spinner size={16} />
									Binaries are still building...
								</div>
							) : (
								<button
									onClick={handleDownloadUpdate}
									disabled={isDownloading}
									className="w-full flex items-center justify-center gap-2 p-3 rounded-lg font-bold text-sm transition-colors hover:opacity-90 disabled:opacity-50"
									style={{ backgroundColor: theme.colors.accent, color: theme.colors.bgMain }}
								>
									{isDownloading ? (
										<>
											<Spinner size={16} />
											Downloading...
										</>
									) : (
										<>
											<Download className="w-4 h-4" />
											Download and Install Update
										</>
									)}
								</button>
							)}

							{/* Fallback link */}
							<button
								onClick={() => openUrl(result.releasesUrl)}
								className="w-full flex items-center justify-center gap-2 p-2 rounded text-xs transition-colors hover:bg-white/5"
								style={{ color: theme.colors.textDim }}
							>
								{result.assetsReady
									? 'Or download manually from GitHub'
									: 'Check release page for updates'}
								<ExternalLink className="w-3 h-3" />
							</button>
						</div>
					</>
				) : (
					<div className="flex flex-col items-center justify-center py-8 gap-3">
						<CheckCircle2 className="w-12 h-12" style={{ color: theme.colors.success }} />
						<div className="text-center">
							<div className="text-sm font-bold mb-1" style={{ color: theme.colors.textMain }}>
								You're up to date!
							</div>
							<div className="text-xs font-mono" style={{ color: theme.colors.textDim }}>
								Maestro v{result?.currentVersion || __APP_VERSION__}
							</div>
						</div>
						<button
							onClick={() =>
								openUrl(result?.releasesUrl || 'https://github.com/RunMaestro/Maestro/releases')
							}
							className="flex items-center gap-2 text-xs hover:underline mt-2"
							style={{ color: theme.colors.accent }}
						>
							View all releases
							<ExternalLink className="w-3 h-3" />
						</button>
					</div>
				)}

				{/* Rollback: earlier releases, folded away until asked for */}
				<div className="border-t pt-4" style={{ borderColor: theme.colors.border }}>
					<button
						onClick={() => setRollbackOpen((open) => !open)}
						aria-expanded={showRollback}
						disabled={activeDownloadKind === 'rollback' && (isDownloading || isDownloaded)}
						className="w-full flex items-center gap-2 text-left text-sm font-bold disabled:cursor-default"
						style={{ color: theme.colors.textMain }}
					>
						{showRollback ? (
							<ChevronDown className="w-4 h-4" style={{ color: theme.colors.textDim }} />
						) : (
							<ChevronRight className="w-4 h-4" style={{ color: theme.colors.textDim }} />
						)}
						<History className="w-4 h-4" style={{ color: theme.colors.accent }} />
						Roll back to an earlier version
						{!showRollback && (
							<span className="text-xs font-normal" style={{ color: theme.colors.textDim }}>
								- if this version is giving you trouble
							</span>
						)}
					</button>
					{showRollback && (
						<div className="space-y-4 mt-3">
							<UpdateRollbackPanel
								theme={theme}
								loading={rollbackLoading}
								result={rollbackResult}
								activeTag={activeDownloadKind === 'rollback' ? activeDownloadTag : null}
								downloading={isDownloading}
								onRollback={handleRollback}
							/>
							{renderDownloadError('rollback')}
							{renderDownloadProgress(
								'rollback',
								`Downloading ${activeDownloadTag ?? 'release'}...`
							)}
							{isRollbackDownloaded && (
								<div className="space-y-2">
									{renderRestartControls(
										`Restart to Roll Back to ${activeDownloadTag ?? 'This Version'}`
									)}
									<div className="text-xs text-center" style={{ color: theme.colors.textDim }}>
										{activeDownloadTag} is downloaded and installs the next time Maestro restarts or
										quits.
									</div>
								</div>
							)}
						</div>
					)}
				</div>

				{/* Beta Opt-in Toggle */}
				<div className="mt-4 pt-4 border-t" style={{ borderColor: theme.colors.border }}>
					<label
						className="flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors hover:bg-white/5"
						style={{
							borderColor: enableBetaUpdates ? theme.colors.accent : theme.colors.border,
							backgroundColor: enableBetaUpdates ? `${theme.colors.accent}10` : theme.colors.bgMain,
						}}
					>
						<div
							className="relative flex items-center justify-center w-5 h-5 rounded border-2 transition-colors"
							style={{
								borderColor: enableBetaUpdates ? theme.colors.accent : theme.colors.border,
								backgroundColor: enableBetaUpdates ? theme.colors.accent : 'transparent',
							}}
						>
							{enableBetaUpdates && (
								<svg
									className="w-3 h-3"
									viewBox="0 0 12 12"
									fill="none"
									stroke={theme.colors.bgMain}
									strokeWidth="2"
									strokeLinecap="round"
									strokeLinejoin="round"
								>
									<path d="M2 6l3 3 5-6" />
								</svg>
							)}
							<input
								type="checkbox"
								checked={enableBetaUpdates}
								onChange={(e) => setEnableBetaUpdates(e.target.checked)}
								className="absolute inset-0 opacity-0 cursor-pointer"
							/>
						</div>
						<FlaskConical
							className="w-4 h-4"
							style={{ color: enableBetaUpdates ? theme.colors.accent : theme.colors.textDim }}
						/>
						<div className="flex-1">
							<div className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
								Include pre-release updates
							</div>
							<div className="text-xs mt-0.5" style={{ color: theme.colors.textDim }}>
								Beta and release candidate versions
							</div>
						</div>
					</label>
				</div>
			</div>
		</Modal>
	);
}
