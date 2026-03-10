import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
	ShieldAlert,
	FolderOpen,
	File,
	Folder,
	ChevronDown,
	ChevronRight,
	AlertTriangle,
	RotateCcw,
	Loader2,
} from 'lucide-react';
import type { Theme } from '../types';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { Modal } from './ui/Modal';

export interface WorkspaceApprovalModalProps {
	theme: Theme;
	deniedPath: string;
	sessionName: string;
	sshRemoteId?: string;
	projectCwd?: string;
	onApprove: (directory: string) => void;
	onDeny: () => void;
}

export function WorkspaceApprovalModal({
	theme,
	deniedPath,
	sessionName: _sessionName,
	sshRemoteId,
	projectCwd,
	onApprove,
	onDeny,
}: WorkspaceApprovalModalProps) {
	const [showFiles, setShowFiles] = useState(false);
	const [files, setFiles] = useState<Array<{ name: string; isDirectory: boolean; path: string }>>(
		[]
	);
	const [fileCount, setFileCount] = useState<{ fileCount: number; folderCount: number } | null>(
		null
	);
	const [loadingFiles, setLoadingFiles] = useState(false);
	const [fileError, setFileError] = useState<string | null>(null);

	const approveButtonRef = useRef<HTMLButtonElement>(null);

	// Determine if the path is outside the project working directory
	const isOutsideProject = projectCwd
		? !deniedPath.startsWith(projectCwd + '/') && deniedPath !== projectCwd
		: false;

	const loadDirectoryFiles = useCallback(async () => {
		setLoadingFiles(true);
		setFileError(null);
		try {
			const [dirEntries, counts] = await Promise.all([
				window.maestro.fs.readDir(deniedPath, sshRemoteId),
				window.maestro.fs.countItems(deniedPath, sshRemoteId),
			]);
			setFiles(dirEntries);
			setFileCount(counts);
		} catch {
			setFileError('Could not list directory contents');
		} finally {
			setLoadingFiles(false);
		}
	}, [deniedPath, sshRemoteId]);

	useEffect(() => {
		if (showFiles) {
			loadDirectoryFiles();
		}
	}, [showFiles, loadDirectoryFiles]);

	const sortedFiles = useMemo(
		() =>
			[...files].sort((a, b) => {
				if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
				return a.name.localeCompare(b.name);
			}),
		[files]
	);

	return (
		<Modal
			theme={theme}
			title="Workspace Access Request"
			priority={MODAL_PRIORITIES.WORKSPACE_APPROVAL}
			onClose={onDeny}
			width={520}
			zIndex={10002}
			showCloseButton={true}
			headerIcon={<ShieldAlert className="w-6 h-6" style={{ color: theme.colors.warning }} />}
			initialFocusRef={approveButtonRef}
		>
			{/* Error context section */}
			<div className="space-y-3">
				<p className="text-sm" style={{ color: theme.colors.textMain }}>
					Gemini CLI attempted to access a path outside its allowed workspace:
				</p>
				<div
					style={{
						fontFamily: 'monospace',
						padding: '8px 12px',
						borderRadius: '6px',
						background: theme.colors.bgMain,
						border: `1px solid ${theme.colors.border}`,
						color: theme.colors.textMain,
						fontSize: '13px',
						wordBreak: 'break-all',
					}}
				>
					{deniedPath}
				</div>
			</div>

			{/* Security disclaimer */}
			<div
				style={{
					marginTop: '16px',
					padding: '12px',
					borderRadius: '6px',
					border: `1px solid ${theme.colors.warning}40`,
					background: `${theme.colors.warning}10`,
				}}
			>
				<div className="flex gap-2" style={{ alignItems: 'flex-start' }}>
					<AlertTriangle
						className="w-4 h-4 shrink-0 mt-0.5"
						style={{ color: theme.colors.warning }}
					/>
					<div>
						<div className="text-xs font-semibold" style={{ color: theme.colors.warning }}>
							Security Notice
						</div>
						<div className="text-xs" style={{ marginTop: '4px', color: theme.colors.textDim }}>
							Adding this directory grants Gemini CLI read and write access to all files within it.
							Only approve directories you trust the agent to modify. The agent will be restarted to
							apply this change.
						</div>
					</div>
				</div>
			</div>

			{/* Warning for paths outside project CWD */}
			{isOutsideProject && (
				<div
					style={{
						marginTop: '8px',
						padding: '10px 12px',
						borderRadius: '6px',
						border: `1px solid ${theme.colors.error}40`,
						background: `${theme.colors.error}10`,
					}}
				>
					<div className="flex gap-2" style={{ alignItems: 'flex-start' }}>
						<AlertTriangle
							className="w-4 h-4 shrink-0 mt-0.5"
							style={{ color: theme.colors.error }}
						/>
						<div className="text-xs" style={{ color: theme.colors.error }}>
							This path is outside your project directory{projectCwd ? ` (${projectCwd})` : ''}.
							Approve with caution.
						</div>
					</div>
				</div>
			)}

			{/* Show Files expandable section */}
			<div
				style={{
					marginTop: '12px',
					border: `1px solid ${theme.colors.border}`,
					borderRadius: '6px',
					overflow: 'hidden',
				}}
			>
				<button
					type="button"
					onClick={() => setShowFiles(!showFiles)}
					className="w-full flex items-center gap-2 text-xs hover:bg-white/5 transition-colors"
					style={{
						padding: '8px 12px',
						color: theme.colors.textDim,
					}}
				>
					{showFiles ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
					<FolderOpen className="w-3 h-3" />
					<span>Show Directory Contents</span>
					{fileCount !== null && (
						<span style={{ marginLeft: 'auto', color: theme.colors.textDim }}>
							{fileCount.fileCount} files, {fileCount.folderCount} folders
						</span>
					)}
				</button>
				{showFiles && (
					<div
						style={{
							maxHeight: '200px',
							overflowY: 'auto',
							padding: '4px 0',
							borderTop: `1px solid ${theme.colors.border}`,
						}}
					>
						{loadingFiles && (
							<div
								className="flex items-center justify-center gap-2 py-3"
								style={{ color: theme.colors.textDim }}
							>
								<Loader2 className="w-4 h-4 animate-spin" />
								<span className="text-xs">Loading...</span>
							</div>
						)}
						{fileError && (
							<div className="text-xs px-3 py-2" style={{ color: theme.colors.error }}>
								{fileError}
							</div>
						)}
						{!loadingFiles && !fileError && files.length === 0 && (
							<div className="text-xs px-3 py-2" style={{ color: theme.colors.textDim }}>
								Directory is empty
							</div>
						)}
						{!loadingFiles &&
							!fileError &&
							sortedFiles.map((entry) => (
								<div
									key={entry.path}
									className="flex items-center gap-2 text-xs"
									style={{
										padding: '2px 12px',
										color: theme.colors.textMain,
									}}
								>
									{entry.isDirectory ? (
										<Folder className="w-3 h-3 shrink-0" style={{ color: theme.colors.warning }} />
									) : (
										<File className="w-3 h-3 shrink-0" style={{ color: theme.colors.textDim }} />
									)}
									<span
										style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
									>
										{entry.name}
									</span>
								</div>
							))}
					</div>
				)}
			</div>

			{/* Action buttons */}
			<div
				className="flex gap-2"
				style={{
					marginTop: '20px',
					justifyContent: 'flex-end',
				}}
			>
				<button
					type="button"
					onClick={onDeny}
					style={{
						padding: '8px 16px',
						borderRadius: '6px',
						fontSize: '14px',
						border: `1px solid ${theme.colors.border}`,
						background: 'transparent',
						color: theme.colors.textDim,
						cursor: 'pointer',
					}}
					className="hover:bg-white/5"
				>
					Deny
				</button>
				<button
					ref={approveButtonRef}
					type="button"
					onClick={() => onApprove(deniedPath)}
					className="flex items-center hover:brightness-110"
					style={{
						padding: '8px 16px',
						borderRadius: '6px',
						fontSize: '14px',
						fontWeight: 500,
						background: theme.colors.accent,
						color: theme.colors.accentForeground,
						border: 'none',
						gap: '6px',
						cursor: 'pointer',
					}}
				>
					<RotateCcw className="w-3.5 h-3.5" />
					Approve &amp; Restart
				</button>
			</div>
		</Modal>
	);
}

export default WorkspaceApprovalModal;
