/**
 * SaveMarkdownModal - Modal for saving markdown content to a file
 *
 * Allows users to:
 * - Specify a folder path (with folder browser button)
 * - Enter a filename (auto-appends .md extension if missing)
 * - Save the markdown content to the specified location
 */

import React, { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { FolderOpen } from 'lucide-react';
import type { Theme } from '../types';
import { Modal, ModalFooter } from './ui/Modal';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';

export interface SaveMarkdownModalProps {
	theme: Theme;
	content: string;
	onClose: () => void;
	/** Default folder path to show initially */
	defaultFolder?: string;
	/** Whether the session is running over SSH (hides folder browser button) */
	isRemoteSession?: boolean;
	/** SSH remote ID for saving to remote filesystem */
	sshRemoteId?: string;
	/** Callback when file is successfully saved (e.g., to refresh file list) */
	onFileSaved?: () => void;
	/** Callback to open the saved file in a tab. When provided, shows an "Open in Tab" checkbox. */
	onOpenInTab?: (file: { path: string; name: string; content: string; sshRemoteId?: string }) => void;
}

export function SaveMarkdownModal({
	theme,
	content,
	onClose,
	defaultFolder = '',
	isRemoteSession = false,
	sshRemoteId,
	onFileSaved,
	onOpenInTab,
}: SaveMarkdownModalProps) {
	const [folder, setFolder] = useState(defaultFolder);
	const [filename, setFilename] = useState('');
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [openInTab, setOpenInTab] = useState(false);
	const filenameInputRef = useRef<HTMLInputElement>(null);

	// Focus the filename input on mount
	useEffect(() => {
		requestAnimationFrame(() => {
			filenameInputRef.current?.focus();
		});
	}, []);

	const handleBrowseFolder = async () => {
		try {
			const selectedFolder = await window.maestro.dialog.selectFolder();
			if (selectedFolder) {
				setFolder(selectedFolder);
				setError(null);
			}
		} catch {
			setError('Failed to open folder browser');
		}
	};

	const handleSave = async () => {
		if (!folder.trim()) {
			setError('Please select a folder');
			return;
		}
		if (!filename.trim()) {
			setError('Please enter a filename');
			return;
		}

		setSaving(true);
		setError(null);

		try {
			// Ensure .md extension
			let finalFilename = filename.trim();
			if (!finalFilename.toLowerCase().endsWith('.md')) {
				finalFilename += '.md';
			}

			// Construct full path
			const separator = folder.includes('\\') ? '\\' : '/';
			const fullPath = `${folder}${folder.endsWith(separator) ? '' : separator}${finalFilename}`;

			// Write the file (local or remote via SSH)
			const result = await window.maestro.fs.writeFile(fullPath, content, sshRemoteId);
			if (result.success) {
				onFileSaved?.();
				if (openInTab && onOpenInTab) {
					onOpenInTab({ path: fullPath, name: finalFilename, content, sshRemoteId });
				}
				onClose();
			} else {
				setError('Failed to save file');
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Failed to save file');
		} finally {
			setSaving(false);
		}
	};

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === 'Enter' && !saving && folder.trim() && filename.trim()) {
			e.preventDefault();
			handleSave();
		}
	};

	const isValid = folder.trim() && filename.trim();

	return createPortal(
		<Modal
			theme={theme}
			title="Save Markdown"
			priority={MODAL_PRIORITIES.SAVE_MARKDOWN}
			onClose={onClose}
			width={480}
			closeOnBackdropClick
			footer={
				<div className="flex items-center justify-between w-full">
					{/* Open in Tab checkbox - left side of footer */}
					{onOpenInTab ? (
						<label
							className="flex items-center gap-2 cursor-pointer select-none"
							style={{ color: theme.colors.textDim }}
						>
							<input
								type="checkbox"
								checked={openInTab}
								onChange={(e) => setOpenInTab(e.target.checked)}
								className="rounded"
								style={{ accentColor: theme.colors.accent }}
							/>
							<span className="text-xs">Open in Tab</span>
						</label>
					) : (
						<div />
					)}
					{/* Buttons - right side of footer */}
					<div className="flex gap-2">
						<ModalFooter
							theme={theme}
							onCancel={onClose}
							onConfirm={handleSave}
							confirmLabel={saving ? 'Saving...' : 'Save'}
							confirmDisabled={!isValid || saving}
						/>
					</div>
				</div>
			}
		>
			<div className="flex flex-col gap-4">
				{/* Folder input with browse button */}
				<div>
					<label
						className="block text-xs font-medium mb-1.5"
						style={{ color: theme.colors.textDim }}
					>
						Folder
					</label>
					<div className="flex gap-2">
						<input
							type="text"
							value={folder}
							onChange={(e) => {
								setFolder(e.target.value);
								setError(null);
							}}
							onKeyDown={handleKeyDown}
							placeholder="/path/to/folder"
							className="flex-1 px-3 py-2 rounded border text-sm outline-none focus:ring-1"
							style={{
								backgroundColor: theme.colors.bgMain,
								borderColor: theme.colors.border,
								color: theme.colors.textMain,
							}}
						/>
						{/* Hide folder browser for remote sessions - native dialog can only browse local fs */}
						{!isRemoteSession && (
							<button
								type="button"
								onClick={handleBrowseFolder}
								className="px-3 py-2 rounded border hover:bg-white/5 transition-colors"
								style={{
									borderColor: theme.colors.border,
									color: theme.colors.textMain,
								}}
								title="Browse for folder"
							>
								<FolderOpen className="w-4 h-4" />
							</button>
						)}
					</div>
				</div>

				{/* Filename input */}
				<div>
					<label
						className="block text-xs font-medium mb-1.5"
						style={{ color: theme.colors.textDim }}
					>
						Filename
					</label>
					<input
						ref={filenameInputRef}
						type="text"
						value={filename}
						onChange={(e) => {
							setFilename(e.target.value);
							setError(null);
						}}
						onKeyDown={handleKeyDown}
						placeholder="document.md"
						className="w-full px-3 py-2 rounded border text-sm outline-none focus:ring-1"
						style={{
							backgroundColor: theme.colors.bgMain,
							borderColor: theme.colors.border,
							color: theme.colors.textMain,
						}}
					/>
					<p className="text-xs mt-1" style={{ color: theme.colors.textDim }}>
						.md extension will be added automatically if not provided
					</p>
				</div>

				{/* Error message */}
				{error && (
					<p className="text-xs" style={{ color: theme.colors.error }}>
						{error}
					</p>
				)}
			</div>
		</Modal>,
		document.body
	);
}

export default SaveMarkdownModal;
