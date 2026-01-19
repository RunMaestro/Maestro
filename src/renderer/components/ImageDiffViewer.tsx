import { useState, useEffect } from 'react';
import { ImageIcon, AlertCircle, Plus, Trash2 } from 'lucide-react';
import type { Theme } from '../types';

interface ImageDiffViewerProps {
	oldPath: string;
	newPath: string;
	cwd: string;
	theme: Theme;
	isNewFile: boolean;
	isDeletedFile: boolean;
	/** SSH remote ID for remote file operations */
	sshRemoteId?: string;
}

/**
 * Component to display side-by-side image comparison for git diffs
 */
export function ImageDiffViewer({
	oldPath,
	newPath,
	cwd,
	theme,
	isNewFile,
	isDeletedFile,
	sshRemoteId,
}: ImageDiffViewerProps) {
	const [oldImage, setOldImage] = useState<string | null>(null);
	const [newImage, setNewImage] = useState<string | null>(null);
	const [oldError, setOldError] = useState<string | null>(null);
	const [newError, setNewError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		const loadImages = async () => {
			setLoading(true);
			setOldError(null);
			setNewError(null);

			// Load old image from git HEAD (unless it's a new file)
			if (!isNewFile) {
				try {
					const result = await window.maestro.git.showFile(cwd, 'HEAD', oldPath);
					if (result.error) {
						setOldError(result.error);
					} else if (result.content) {
						setOldImage(result.content);
					}
				} catch (err) {
					setOldError(err instanceof Error ? err.message : 'Failed to load old image');
				}
			}

			// Load new image from working directory (unless it's a deleted file)
			if (!isDeletedFile) {
				try {
					const fullPath = `${cwd}/${newPath}`;
					const content = await window.maestro.fs.readFile(fullPath, sshRemoteId);
					setNewImage(content);
				} catch (err) {
					setNewError(err instanceof Error ? err.message : 'Failed to load new image');
				}
			}

			setLoading(false);
		};

		loadImages();
	}, [cwd, oldPath, newPath, isNewFile, isDeletedFile, sshRemoteId]);

	if (loading) {
		return (
			<div
				className="flex items-center justify-center h-64"
				style={{ color: theme.colors.textDim }}
			>
				<div className="flex items-center gap-2">
					<div className="animate-spin w-5 h-5 border-2 border-current border-t-transparent rounded-full" />
					<span>Loading images...</span>
				</div>
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-4">
			{/* Header */}
			<div
				className="text-sm font-medium px-3 py-2 rounded"
				style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textMain }}
			>
				<div className="flex items-center gap-2">
					<ImageIcon className="w-4 h-4" />
					<span>Binary file changed</span>
					{isNewFile && (
						<span
							className="text-xs px-2 py-0.5 rounded flex items-center gap-1"
							style={{ backgroundColor: 'rgba(34, 197, 94, 0.2)', color: 'rgb(34, 197, 94)' }}
						>
							<Plus className="w-3 h-3" /> New file
						</span>
					)}
					{isDeletedFile && (
						<span
							className="text-xs px-2 py-0.5 rounded flex items-center gap-1"
							style={{ backgroundColor: 'rgba(239, 68, 68, 0.2)', color: 'rgb(239, 68, 68)' }}
						>
							<Trash2 className="w-3 h-3" /> Deleted
						</span>
					)}
				</div>
			</div>

			{/* Side-by-side comparison */}
			<div className="grid grid-cols-2 gap-4">
				{/* Old Image (Before) */}
				<div
					className="flex flex-col rounded-lg overflow-hidden"
					style={{ border: `1px solid ${theme.colors.border}` }}
				>
					<div
						className="px-3 py-2 text-sm font-medium border-b flex items-center gap-2"
						style={{
							backgroundColor: 'rgba(239, 68, 68, 0.1)',
							borderColor: theme.colors.border,
							color: theme.colors.textMain,
						}}
					>
						<span className="text-red-500">Before</span>
						<span className="text-xs" style={{ color: theme.colors.textDim }}>
							{isNewFile ? '(file did not exist)' : oldPath}
						</span>
					</div>
					<div
						className="flex-1 flex items-center justify-center p-4 min-h-[200px]"
						style={{ backgroundColor: theme.colors.bgSidebar }}
					>
						{isNewFile ? (
							<div
								className="flex flex-col items-center gap-2"
								style={{ color: theme.colors.textDim }}
							>
								<ImageIcon className="w-12 h-12 opacity-30" />
								<span className="text-sm">File did not exist</span>
							</div>
						) : oldError ? (
							<div
								className="flex flex-col items-center gap-2 text-center"
								style={{ color: theme.colors.textDim }}
							>
								<AlertCircle className="w-8 h-8 text-red-500" />
								<span className="text-sm">Failed to load</span>
								<span className="text-xs opacity-70">{oldError}</span>
							</div>
						) : oldImage ? (
							<img
								src={oldImage}
								alt="Before"
								className="max-w-full max-h-[400px] object-contain"
								style={{ imageRendering: 'crisp-edges' }}
							/>
						) : (
							<div style={{ color: theme.colors.textDim }}>
								<ImageIcon className="w-12 h-12 opacity-30" />
							</div>
						)}
					</div>
				</div>

				{/* New Image (After) */}
				<div
					className="flex flex-col rounded-lg overflow-hidden"
					style={{ border: `1px solid ${theme.colors.border}` }}
				>
					<div
						className="px-3 py-2 text-sm font-medium border-b flex items-center gap-2"
						style={{
							backgroundColor: 'rgba(34, 197, 94, 0.1)',
							borderColor: theme.colors.border,
							color: theme.colors.textMain,
						}}
					>
						<span className="text-green-500">After</span>
						<span className="text-xs" style={{ color: theme.colors.textDim }}>
							{isDeletedFile ? '(file deleted)' : newPath}
						</span>
					</div>
					<div
						className="flex-1 flex items-center justify-center p-4 min-h-[200px]"
						style={{ backgroundColor: theme.colors.bgSidebar }}
					>
						{isDeletedFile ? (
							<div
								className="flex flex-col items-center gap-2"
								style={{ color: theme.colors.textDim }}
							>
								<Trash2 className="w-12 h-12 opacity-30" />
								<span className="text-sm">File deleted</span>
							</div>
						) : newError ? (
							<div
								className="flex flex-col items-center gap-2 text-center"
								style={{ color: theme.colors.textDim }}
							>
								<AlertCircle className="w-8 h-8 text-red-500" />
								<span className="text-sm">Failed to load</span>
								<span className="text-xs opacity-70">{newError}</span>
							</div>
						) : newImage ? (
							<img
								src={newImage}
								alt="After"
								className="max-w-full max-h-[400px] object-contain"
								style={{ imageRendering: 'crisp-edges' }}
							/>
						) : (
							<div style={{ color: theme.colors.textDim }}>
								<ImageIcon className="w-12 h-12 opacity-30" />
							</div>
						)}
					</div>
				</div>
			</div>
		</div>
	);
}
