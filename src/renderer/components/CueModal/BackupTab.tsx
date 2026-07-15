/**
 * BackupTab - Cue modal "Backup" tab.
 *
 * Lets the user snapshot every workspace's `.maestro/cue.yaml` plus the
 * contents of `.maestro/prompts/` into a zip stored under userData. Existing
 * backups are listed newest-first; each row expands to reveal per-workspace
 * file lists with per-file Diff (against live) and Restore actions, plus a
 * top-level Restore-All / Delete pair on each backup.
 *
 * Restores are gated behind a confirmation modal because they overwrite the
 * live `cue.yaml` / prompt files in place.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPatch } from 'diff';
import {
	Archive,
	ChevronDown,
	ChevronRight,
	FileText,
	Loader2,
	Plus,
	RotateCcw,
	Trash2,
	GitCompareArrows,
	FolderOpen,
} from 'lucide-react';
import type { Theme } from '../../types';
import type { CueBackupDiffStatusMap, CueBackupSummary } from '../../../shared/cue-backup-types';
import { cueBackupStatusKey } from '../../../shared/cue-backup-types';
import { cueBackupService } from '../../services/cueBackup';
import { getModalActions } from '../../stores/modalStore';
import { notifyToast } from '../../stores/notificationStore';
import { captureException } from '../../utils/sentry';
import { formatSize } from '../../../shared/formatters';
import { GitDiffViewer } from '../GitDiffViewer';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';

interface BackupTabProps {
	theme: Theme;
}

interface DiffViewerState {
	title: string;
	cwd: string;
	diffText: string;
}

/**
 * Build a synthetic git-style unified diff so the existing GitDiffViewer
 * (which expects `diff --git a/... b/...` headers) can render it. The
 * `diff` library's createPatch produces an `Index:` header that the parser
 * doesn't understand on its own.
 */
function buildSyntheticGitDiff(
	displayPath: string,
	oldContent: string,
	newContent: string
): string {
	const patch = createPatch(displayPath, oldContent, newContent, '', '');
	return `diff --git a/${displayPath} b/${displayPath}\n${patch}`;
}

function formatTimestamp(iso: string): string {
	try {
		const d = new Date(iso);
		const pad = (n: number) => String(n).padStart(2, '0');
		return (
			`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
			`${pad(d.getHours())}:${pad(d.getMinutes())}`
		);
	} catch {
		return iso;
	}
}

function workspaceLabel(cwd: string): string {
	const parts = cwd.split(/[/\\]/).filter(Boolean);
	return parts.length > 0 ? parts[parts.length - 1] : cwd;
}

export function BackupTab({ theme }: BackupTabProps) {
	const [backups, setBackups] = useState<CueBackupSummary[]>([]);
	const [loading, setLoading] = useState(true);
	const [creating, setCreating] = useState(false);
	const [expanded, setExpanded] = useState<Set<string>>(new Set());
	const [diffViewer, setDiffViewer] = useState<DiffViewerState | null>(null);
	/**
	 * Per-backup diff status (workspaceId::relativePath -> 'unchanged' |
	 * 'changed' | 'missing-live'). Lazily fetched the first time a backup is
	 * expanded so we only pay the read cost for backups the user inspects.
	 * `null` means "loading" - render the row without action buttons until the
	 * status arrives so we never flash unactionable buttons that disappear.
	 */
	const [diffStatus, setDiffStatus] = useState<Record<string, CueBackupDiffStatusMap | null>>({});

	const loadBackups = useCallback(async () => {
		setLoading(true);
		try {
			const list = await cueBackupService.list();
			setBackups(list);
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		loadBackups();
	}, [loadBackups]);

	const handleCreate = useCallback(async () => {
		setCreating(true);
		try {
			const summary = await cueBackupService.create();
			const wsCount = summary.manifest.workspaces.length;
			const fileCount = summary.manifest.workspaces.reduce((acc, w) => acc + w.files.length, 0);
			notifyToast({
				title: 'Backup created',
				message:
					wsCount === 0
						? 'No workspaces had Cue configuration to back up.'
						: `Captured ${fileCount} file${fileCount === 1 ? '' : 's'} across ${wsCount} workspace${wsCount === 1 ? '' : 's'}.`,
				color: wsCount === 0 ? 'yellow' : 'green',
			});
			await loadBackups();
		} catch (err) {
			captureException(err, { extra: { context: 'BackupTab.handleCreate' } });
			notifyToast({
				title: 'Backup failed',
				message: err instanceof Error ? err.message : 'Could not create backup.',
				color: 'red',
			});
		} finally {
			setCreating(false);
		}
	}, [loadBackups]);

	const fetchDiffStatus = useCallback(async (filePath: string) => {
		setDiffStatus((prev) => ({ ...prev, [filePath]: null }));
		try {
			const status = await cueBackupService.getDiffStatus(filePath);
			setDiffStatus((prev) => ({ ...prev, [filePath]: status }));
		} catch (err) {
			captureException(err, { extra: { context: 'BackupTab.fetchDiffStatus' } });
			// On failure, default to an empty map so all files render as
			// "changed" via the lookup helper - better to show a button that
			// errors on click than to hide actionable rows.
			setDiffStatus((prev) => ({ ...prev, [filePath]: {} }));
		}
	}, []);

	const invalidateDiffStatus = useCallback(
		(filePath: string) => {
			if (expanded.has(filePath)) {
				void fetchDiffStatus(filePath);
			} else {
				setDiffStatus((prev) => {
					const { [filePath]: _drop, ...rest } = prev;
					return rest;
				});
			}
		},
		[expanded, fetchDiffStatus]
	);

	const handleDelete = useCallback(
		(backup: CueBackupSummary) => {
			getModalActions().showConfirmation(
				`Delete backup "${backup.fileName}"? This cannot be undone.`,
				async () => {
					try {
						await cueBackupService.delete(backup.filePath);
						notifyToast({
							title: 'Backup deleted',
							message: backup.fileName,
							color: 'green',
						});
						await loadBackups();
					} catch (err) {
						captureException(err, { extra: { context: 'BackupTab.handleDelete' } });
						notifyToast({
							title: 'Delete failed',
							message: err instanceof Error ? err.message : 'Could not delete backup.',
							color: 'red',
						});
					}
				}
			);
		},
		[loadBackups]
	);

	const handleRestoreAll = useCallback(
		(backup: CueBackupSummary) => {
			const wsCount = backup.manifest.workspaces.length;
			const fileCount = backup.manifest.workspaces.reduce((acc, w) => acc + w.files.length, 0);
			getModalActions().showConfirmation(
				`Restore everything from "${backup.fileName}"?\n\n` +
					`This will overwrite ${fileCount} file${fileCount === 1 ? '' : 's'} ` +
					`across ${wsCount} workspace${wsCount === 1 ? '' : 's'} with the contents of the backup. ` +
					`Files that exist live but are not in the backup will be left in place.`,
				async () => {
					try {
						const result = await cueBackupService.restoreAll(backup.filePath);
						invalidateDiffStatus(backup.filePath);
						const skippedMsg =
							result.skipped.length > 0
								? ` ${result.skipped.length} file${result.skipped.length === 1 ? '' : 's'} skipped (workspace path missing or read error).`
								: '';
						notifyToast({
							title: 'Backup restored',
							message: `Wrote ${result.written} file${result.written === 1 ? '' : 's'}.${skippedMsg}`,
							color: result.skipped.length > 0 ? 'yellow' : 'green',
						});
					} catch (err) {
						captureException(err, { extra: { context: 'BackupTab.handleRestoreAll' } });
						notifyToast({
							title: 'Restore failed',
							message: err instanceof Error ? err.message : 'Could not restore backup.',
							color: 'red',
						});
					}
				}
			);
		},
		[invalidateDiffStatus]
	);

	const handleRestoreFile = useCallback(
		(backup: CueBackupSummary, workspaceCwd: string, relativePath: string) => {
			const workspace = backup.manifest.workspaces.find((w) => w.cwd === workspaceCwd);
			if (!workspace) return;
			getModalActions().showConfirmation(
				`Restore "${relativePath}" in ${workspaceCwd}?\n\n` +
					`This overwrites the live file with the contents from the backup.`,
				async () => {
					try {
						await cueBackupService.restoreFile(backup.filePath, workspace.id, relativePath);
						invalidateDiffStatus(backup.filePath);
						notifyToast({
							title: 'File restored',
							message: `${relativePath} restored from backup.`,
							color: 'green',
						});
					} catch (err) {
						captureException(err, {
							extra: { context: 'BackupTab.handleRestoreFile', relativePath },
						});
						notifyToast({
							title: 'Restore failed',
							message: err instanceof Error ? err.message : 'Could not restore file.',
							color: 'red',
						});
					}
				}
			);
		},
		[invalidateDiffStatus]
	);

	const handleDiff = useCallback(
		async (
			backup: CueBackupSummary,
			workspaceCwd: string,
			workspaceId: string,
			relativePath: string
		) => {
			try {
				const [backupContent, liveContent] = await Promise.all([
					cueBackupService.readFile(backup.filePath, workspaceId, relativePath),
					cueBackupService.readLive(workspaceCwd, relativePath),
				]);
				if (backupContent === null) {
					notifyToast({
						title: 'Diff failed',
						message: 'File missing from backup zip.',
						color: 'red',
					});
					return;
				}
				const live = liveContent ?? '';
				const diffText = buildSyntheticGitDiff(relativePath, live, backupContent);
				setDiffViewer({
					title: `Backup vs live · ${relativePath}`,
					cwd: workspaceCwd,
					diffText,
				});
			} catch (err) {
				captureException(err, { extra: { context: 'BackupTab.handleDiff', relativePath } });
				notifyToast({
					title: 'Diff failed',
					message: err instanceof Error ? err.message : 'Could not compute diff.',
					color: 'red',
				});
			}
		},
		[]
	);

	const toggleExpanded = useCallback(
		(filePath: string) => {
			setExpanded((prev) => {
				const next = new Set(prev);
				if (next.has(filePath)) {
					next.delete(filePath);
				} else {
					next.add(filePath);
				}
				return next;
			});
			if (!expanded.has(filePath) && diffStatus[filePath] === undefined) {
				void fetchDiffStatus(filePath);
			}
		},
		[expanded, diffStatus, fetchDiffStatus]
	);

	const totalBackups = backups.length;
	const totalSize = useMemo(() => backups.reduce((acc, b) => acc + b.size, 0), [backups]);

	return (
		<div className="flex-1 overflow-auto px-5 py-4 space-y-4">
			{/* Top action row */}
			<div className="flex items-center justify-between">
				<div className="flex items-center gap-3">
					<button
						onClick={handleCreate}
						disabled={creating}
						className="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-colors disabled:opacity-50"
						style={{
							backgroundColor: theme.colors.accent,
							color: theme.colors.bgMain,
						}}
					>
						{creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
						{creating ? 'Creating…' : 'Create Backup'}
					</button>
				</div>
				{totalBackups > 0 && (
					<span className="text-xs" style={{ color: theme.colors.textDim }}>
						{totalBackups} backup{totalBackups === 1 ? '' : 's'} · {formatSize(totalSize)}
					</span>
				)}
			</div>

			{/* Backups list */}
			{loading ? (
				<div
					className="flex items-center justify-center py-12 text-sm"
					style={{ color: theme.colors.textDim }}
				>
					<Loader2 className="w-4 h-4 animate-spin mr-2" />
					Loading backups…
				</div>
			) : totalBackups === 0 ? (
				<div
					className="flex flex-col items-center justify-center py-12 gap-2 text-sm rounded-lg border border-dashed"
					style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
				>
					<Archive className="w-6 h-6" />
					<p>No backups yet - click "Create Backup" to take your first snapshot.</p>
				</div>
			) : (
				<div className="space-y-2">
					{backups.map((backup) => {
						const isExpanded = expanded.has(backup.filePath);
						const wsCount = backup.manifest.workspaces.length;
						const fileCount = backup.manifest.workspaces.reduce(
							(acc, w) => acc + w.files.length,
							0
						);
						const status = diffStatus[backup.filePath];
						const statusReady = status !== null && status !== undefined;
						const differCount = statusReady
							? Object.values(status).filter((s) => s !== 'unchanged').length
							: null;
						const allUnchanged = statusReady && differCount === 0 && fileCount > 0;
						return (
							<div
								key={backup.filePath}
								className="rounded-lg border"
								style={{
									borderColor: theme.colors.border,
									backgroundColor: theme.colors.bgSidebar,
								}}
							>
								{/* Backup row */}
								<div className="flex items-center gap-3 px-3 py-2.5">
									<button
										onClick={() => toggleExpanded(backup.filePath)}
										className="p-1 rounded hover:bg-white/10 transition-colors"
										aria-label={isExpanded ? 'Collapse' : 'Expand'}
										style={{ color: theme.colors.textDim }}
									>
										{isExpanded ? (
											<ChevronDown className="w-4 h-4" />
										) : (
											<ChevronRight className="w-4 h-4" />
										)}
									</button>
									<Archive className="w-4 h-4 shrink-0" style={{ color: theme.colors.accent }} />
									<div className="flex-1 min-w-0">
										<div
											className="text-sm font-medium truncate"
											style={{ color: theme.colors.textMain }}
										>
											{backup.fileName}
										</div>
										<div
											className="text-xs flex items-center gap-3"
											style={{ color: theme.colors.textDim }}
										>
											<span>{formatTimestamp(backup.manifest.createdAt)}</span>
											<span>{formatSize(backup.size)}</span>
											<span>
												{wsCount} workspace{wsCount === 1 ? '' : 's'}
											</span>
											<span>
												{fileCount} file{fileCount === 1 ? '' : 's'}
											</span>
											{differCount !== null && differCount > 0 && (
												<span style={{ color: theme.colors.accent }}>
													{differCount} differ{differCount === 1 ? 's' : ''} from live
												</span>
											)}
											{allUnchanged && (
												<span style={{ color: theme.colors.textDim }}>All up to date</span>
											)}
										</div>
									</div>
									{!allUnchanged && (
										<button
											onClick={() => handleRestoreAll(backup)}
											disabled={fileCount === 0}
											className="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs hover:bg-white/10 transition-colors disabled:opacity-40"
											style={{
												color: theme.colors.textMain,
												border: `1px solid ${theme.colors.border}`,
											}}
											title="Restore all files in this backup"
										>
											<RotateCcw className="w-3.5 h-3.5" />
											Restore All
										</button>
									)}
									<button
										onClick={() => handleDelete(backup)}
										className="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs hover:bg-red-500/10 transition-colors"
										style={{
											color: theme.colors.textDim,
											border: `1px solid ${theme.colors.border}`,
										}}
										title="Delete this backup zip"
									>
										<Trash2 className="w-3.5 h-3.5" />
										Delete
									</button>
								</div>

								{/* Expanded workspace + file list */}
								{isExpanded && (
									<div
										className="border-t px-3 py-2 space-y-3"
										style={{ borderColor: theme.colors.border }}
									>
										{wsCount === 0 ? (
											<div className="text-xs py-2" style={{ color: theme.colors.textDim }}>
												This backup contains no workspaces - none of your agents had a{' '}
												<code>.maestro/cue.yaml</code> or prompt files at the time it was created.
											</div>
										) : (
											(() => {
												const status = diffStatus[backup.filePath];
												const statusLoading = status === null;
												const statusReady = status !== null && status !== undefined;
												return backup.manifest.workspaces.map((ws) => (
													<div key={ws.id} className="space-y-1">
														<div className="flex items-center gap-2">
															<FolderOpen
																className="w-3.5 h-3.5"
																style={{ color: theme.colors.textDim }}
															/>
															<span
																className="text-xs font-semibold"
																style={{ color: theme.colors.textMain }}
															>
																{workspaceLabel(ws.cwd)}
															</span>
															<span
																className="text-[11px] font-mono truncate"
																style={{ color: theme.colors.textDim }}
																title={ws.cwd}
															>
																{ws.cwd}
															</span>
															{ws.agents.length > 0 && (
																<span
																	className="text-[11px]"
																	style={{ color: theme.colors.textDim }}
																>
																	· {ws.agents.length} agent
																	{ws.agents.length === 1 ? '' : 's'}
																</span>
															)}
														</div>
														<div className="ml-5 space-y-1">
															{ws.files.map((f) => {
																const fileStatus = statusReady
																	? status[cueBackupStatusKey(ws.id, f.relativePath)]
																	: undefined;
																const isUnchanged = fileStatus === 'unchanged';
																const isMissingLive = fileStatus === 'missing-live';
																return (
																	<div
																		key={`${ws.id}-${f.relativePath}`}
																		className="flex items-center gap-2 text-xs px-2 py-1 rounded hover:bg-white/5 transition-colors"
																	>
																		<FileText
																			className="w-3.5 h-3.5"
																			style={{
																				color: isUnchanged
																					? theme.colors.textDim
																					: theme.colors.textDim,
																				opacity: isUnchanged ? 0.5 : 1,
																			}}
																		/>
																		<span
																			className="font-mono"
																			style={{
																				color: isUnchanged
																					? theme.colors.textDim
																					: theme.colors.textMain,
																			}}
																		>
																			{f.relativePath}
																		</span>
																		<span
																			className="text-[11px]"
																			style={{ color: theme.colors.textDim }}
																		>
																			{formatSize(f.size)}
																		</span>
																		{isMissingLive && (
																			<span
																				className="text-[11px] px-1.5 py-0.5 rounded"
																				style={{
																					backgroundColor: `${theme.colors.accent}22`,
																					color: theme.colors.accent,
																				}}
																				title="No live file at this path - restoring will recreate it"
																			>
																				missing live
																			</span>
																		)}
																		<div className="flex-1" />
																		{statusLoading ? (
																			<span
																				className="text-[11px] italic"
																				style={{ color: theme.colors.textDim }}
																			>
																				Checking…
																			</span>
																		) : isUnchanged ? (
																			<span
																				className="text-[11px]"
																				style={{ color: theme.colors.textDim }}
																				title="Live file matches backup byte-for-byte"
																			>
																				Up to date
																			</span>
																		) : (
																			<>
																				<button
																					onClick={() =>
																						handleDiff(backup, ws.cwd, ws.id, f.relativePath)
																					}
																					className="flex items-center gap-1 px-2 py-0.5 rounded hover:bg-white/10 transition-colors"
																					style={{ color: theme.colors.textDim }}
																					title="Diff backup vs live file"
																				>
																					<GitCompareArrows className="w-3 h-3" />
																					Diff
																				</button>
																				<button
																					onClick={() =>
																						handleRestoreFile(backup, ws.cwd, f.relativePath)
																					}
																					className="flex items-center gap-1 px-2 py-0.5 rounded hover:bg-white/10 transition-colors"
																					style={{ color: theme.colors.textMain }}
																					title="Restore this file from backup"
																				>
																					<RotateCcw className="w-3 h-3" />
																					Restore
																				</button>
																			</>
																		)}
																	</div>
																);
															})}
														</div>
													</div>
												));
											})()
										)}
									</div>
								)}
							</div>
						);
					})}
				</div>
			)}

			{/* Diff viewer (rendered above the Cue modal via priority override) */}
			{diffViewer && (
				<GitDiffViewer
					diffText={diffViewer.diffText}
					cwd={diffViewer.cwd}
					theme={theme}
					title={diffViewer.title}
					initialViewType="split"
					priority={MODAL_PRIORITIES.CUE_BACKUP_DIFF}
					onClose={() => setDiffViewer(null)}
				/>
			)}
		</div>
	);
}
