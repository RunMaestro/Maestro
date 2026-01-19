import React, { useEffect, useState } from 'react';
import {
	X,
	Download,
	ExternalLink,
	Loader2,
	CheckCircle2,
	AlertCircle,
	RefreshCw,
	ChevronDown,
	ChevronRight,
	RotateCcw,
	FlaskConical,
} from 'lucide-react';
import type { Theme } from '../types';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import ReactMarkdown from 'react-markdown';
import { Modal } from './ui/Modal';
import { useSettings } from '../hooks';

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

interface UpdateStatus {
	status:
		| 'idle'
		| 'checking'
		| 'available'
		| 'not-available'
		| 'downloading'
		| 'downloaded'
		| 'error';
	info?: { version: string };
	progress?: { percent: number; bytesPerSecond: number; total: number; transferred: number };
	error?: string;
}

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

	// Check for updates on mount
	useEffect(() => {
		checkForUpdates();
	}, [enableBetaUpdates]);

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
				releasesUrl: 'https://github.com/pedramamini/Maestro/releases',
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

	const formatDate = (dateString: string) => {
		return new Date(dateString).toLocaleDateString('en-US', {
			year: 'numeric',
			month: 'short',
			day: 'numeric',
		});
	};

	const formatBytes = (bytes: number) => {
		if (bytes === 0) return '0 B';
		const k = 1024;
		const sizes = ['B', 'KB', 'MB', 'GB'];
		const i = Math.floor(Math.log(bytes) / Math.log(k));
		return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
	};

	const handleDownloadUpdate = async () => {
		setDownloadError(null);
		setDownloadStatus({
			status: 'downloading',
			progress: { percent: 0, bytesPerSecond: 0, total: 0, transferred: 0 },
		});

		const downloadResult = await window.maestro.updates.download();
		if (!downloadResult.success && downloadResult.error) {
			setDownloadError(downloadResult.error);
			setDownloadStatus({ status: 'error', error: downloadResult.error });
		}
	};

	const handleInstallUpdate = () => {
		window.maestro.updates.install();
	};

	const isDownloading = downloadStatus.status === 'downloading';
	const isDownloaded = downloadStatus.status === 'downloaded';

	// Custom header with refresh button
	const customHeader = (
		<div
			className="p-4 border-b flex items-center justify-between shrink-0"
			style={{ borderColor: theme.colors.border }}
		>
			<div className="flex items-center gap-2">
				<Download className="w-5 h-5" style={{ color: theme.colors.accent }} />
				<h2 className="text-sm font-bold" style={{ color: theme.colors.textMain }}>
					Check for Updates
				</h2>
			</div>
			<div className="flex items-center gap-2">
				<button
					onClick={checkForUpdates}
					disabled={loading || isDownloading}
					className="p-1 rounded hover:bg-white/10 transition-colors disabled:opacity-50"
					title="Refresh"
				>
					<RefreshCw
						className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`}
						style={{ color: theme.colors.textDim }}
					/>
				</button>
				<button
					onClick={onClose}
					className="p-1 rounded hover:bg-white/10 transition-colors"
					style={{ color: theme.colors.textDim }}
				>
					<X className="w-4 h-4" />
				</button>
			</div>
		</div>
	);

	return (
		<Modal
			theme={theme}
			title="Check for Updates"
			priority={MODAL_PRIORITIES.UPDATE_CHECK}
			onClose={onClose}
			customHeader={customHeader}
			width={625}
			maxHeight="80vh"
		>
			<div className="space-y-4 -my-2">
				{loading ? (
					<div className="flex flex-col items-center justify-center py-8 gap-3">
						<Loader2 className="w-8 h-8 animate-spin" style={{ color: theme.colors.accent }} />
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
							onClick={() => window.maestro.shell.openExternal(result.releasesUrl)}
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
									<div
										key={release.tag_name}
										className="border rounded overflow-hidden"
										style={{ borderColor: theme.colors.border }}
									>
										<button
											onClick={() => toggleRelease(release.tag_name)}
											className="w-full flex items-center justify-between p-3 hover:bg-white/5 transition-colors text-left"
											style={{ backgroundColor: theme.colors.bgActivity }}
										>
											<div className="flex items-center gap-2">
												{expandedReleases.has(release.tag_name) ? (
													<ChevronDown
														className="w-4 h-4"
														style={{ color: theme.colors.textDim }}
													/>
												) : (
													<ChevronRight
														className="w-4 h-4"
														style={{ color: theme.colors.textDim }}
													/>
												)}
												<span
													className="font-mono font-bold text-sm"
													style={{ color: theme.colors.accent }}
												>
													{release.tag_name}
												</span>
												{(() => {
													// Strip version prefix if name starts with it (e.g., "v0.14.2 | Description" -> "Description")
													if (!release.name || release.name === release.tag_name) return null;
													const name = release.name;
													const tag = release.tag_name;
													let displayName: string | null = name;

													// Check for patterns like "v0.14.2 | Description" or "v0.14.2 - Description"
													const pipeIndex = name.indexOf('|');
													const dashIndex = name.indexOf(' - ');

													if (
														pipeIndex !== -1 &&
														name.substring(0, pipeIndex).trim().toLowerCase() === tag.toLowerCase()
													) {
														displayName = name.substring(pipeIndex + 1).trim();
													} else if (
														dashIndex !== -1 &&
														name.substring(0, dashIndex).trim().toLowerCase() === tag.toLowerCase()
													) {
														displayName = name.substring(dashIndex + 3).trim();
													} else if (name.toLowerCase().startsWith(tag.toLowerCase())) {
														// If name just starts with the tag, strip it
														const remainder = name.substring(tag.length).trim();
														// Remove leading separator if present
														if (remainder.startsWith('|') || remainder.startsWith('-')) {
															displayName = remainder.substring(1).trim();
														} else {
															displayName = remainder || null;
														}
													}

													if (!displayName) return null;
													return (
														<span className="text-xs" style={{ color: theme.colors.textDim }}>
															- {displayName}
														</span>
													);
												})()}
											</div>
											<span className="text-xs" style={{ color: theme.colors.textDim }}>
												{formatDate(release.published_at)}
											</span>
										</button>
										{expandedReleases.has(release.tag_name) && (
											<div
												className="py-3 px-5 border-t text-xs prose prose-sm prose-invert max-w-none"
												style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
											>
												<ReactMarkdown
													components={{
														h1: ({ children }) => (
															<h1
																className="text-base font-bold mt-3 mb-2"
																style={{ color: theme.colors.textMain }}
															>
																{children}
															</h1>
														),
														h2: ({ children }) => (
															<h2
																className="text-sm font-bold mt-3 mb-2"
																style={{ color: theme.colors.textMain }}
															>
																{children}
															</h2>
														),
														h3: ({ children }) => (
															<h3
																className="text-xs font-bold mt-2 mb-1"
																style={{ color: theme.colors.textMain }}
															>
																{children}
															</h3>
														),
														p: ({ children }) => (
															<p className="my-1.5" style={{ color: theme.colors.textDim }}>
																{children}
															</p>
														),
														ul: ({ children }) => (
															<ul className="list-disc list-inside my-1.5 space-y-0.5">
																{children}
															</ul>
														),
														ol: ({ children }) => (
															<ol className="list-decimal list-inside my-1.5 space-y-0.5">
																{children}
															</ol>
														),
														li: ({ children }) => (
															<li style={{ color: theme.colors.textDim }}>{children}</li>
														),
														code: ({ children }) => (
															<code
																className="px-1 py-0.5 rounded font-mono text-xs"
																style={{
																	backgroundColor: theme.colors.bgMain,
																	color: theme.colors.accent,
																}}
															>
																{children}
															</code>
														),
														a: ({ href, children }) => (
															<a
																href={href}
																onClick={(e) => {
																	e.preventDefault();
																	if (href) window.maestro.shell.openExternal(href);
																}}
																className="hover:underline cursor-pointer"
																style={{ color: theme.colors.accent }}
															>
																{children}
															</a>
														),
													}}
												>
													{release.body || 'No release notes available.'}
												</ReactMarkdown>
											</div>
										)}
									</div>
								))}
							</div>
						</div>

						{/* Download Error */}
						{downloadError && (
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
									onClick={() => window.maestro.shell.openExternal(result.releasesUrl)}
									className="flex items-center gap-1 mt-2 hover:underline"
									style={{ color: theme.colors.accent }}
								>
									Download manually from GitHub
									<ExternalLink className="w-3 h-3" />
								</button>
							</div>
						)}

						{/* Download Progress */}
						{isDownloading && downloadStatus.progress && (
							<div className="space-y-2">
								<div
									className="flex items-center justify-between text-xs"
									style={{ color: theme.colors.textDim }}
								>
									<span>Downloading update...</span>
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
										{formatBytes(downloadStatus.progress.transferred)} /{' '}
										{formatBytes(downloadStatus.progress.total)}
									</span>
									<span>{formatBytes(downloadStatus.progress.bytesPerSecond)}/s</span>
								</div>
							</div>
						)}

						{/* Action Buttons */}
						<div className="space-y-2">
							{isDownloaded ? (
								<button
									onClick={handleInstallUpdate}
									className="w-full flex items-center justify-center gap-2 p-3 rounded-lg font-bold text-sm transition-colors hover:opacity-90"
									style={{ backgroundColor: theme.colors.success, color: theme.colors.bgMain }}
								>
									<RotateCcw className="w-4 h-4" />
									Restart to Update
								</button>
							) : !result.assetsReady ? (
								/* Assets not yet available - show building message */
								<div
									className="w-full flex items-center justify-center gap-2 p-3 rounded-lg text-sm"
									style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textDim }}
								>
									<Loader2 className="w-4 h-4 animate-spin" />
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
											<Loader2 className="w-4 h-4 animate-spin" />
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
								onClick={() => window.maestro.shell.openExternal(result.releasesUrl)}
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
								window.maestro.shell.openExternal(
									result?.releasesUrl || 'https://github.com/pedramamini/Maestro/releases'
								)
							}
							className="flex items-center gap-2 text-xs hover:underline mt-2"
							style={{ color: theme.colors.accent }}
						>
							View all releases
							<ExternalLink className="w-3 h-3" />
						</button>
					</div>
				)}

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
