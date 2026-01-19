import React, { useState, useRef, useEffect } from 'react';
import { Folder, FileText, Play, CheckSquare } from 'lucide-react';
import type { Theme } from '../types';
import { Modal, ModalFooter, FormInput } from './ui';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';

interface AutoRunSetupModalProps {
	theme: Theme;
	onClose: () => void;
	onFolderSelected: (folderPath: string) => void;
	currentFolder?: string; // Current folder path (for changing existing folder)
	sessionName?: string; // Name of the agent session
	sshRemoteId?: string; // SSH remote ID if agent uses remote execution
	sshRemoteHost?: string; // SSH remote host for tooltip display
}

export function AutoRunSetupModal({
	theme,
	onClose,
	onFolderSelected,
	currentFolder,
	sessionName,
	sshRemoteId,
	sshRemoteHost,
}: AutoRunSetupModalProps) {
	const [selectedFolder, setSelectedFolder] = useState(currentFolder || '');
	const [homeDir, setHomeDir] = useState<string>('');
	const [folderValidation, setFolderValidation] = useState<{
		checking: boolean;
		valid: boolean;
		docCount: number;
		error?: string;
	}>({ checking: false, valid: false, docCount: 0 });
	const continueButtonRef = useRef<HTMLButtonElement>(null);

	// Fetch home directory on mount for tilde expansion
	useEffect(() => {
		window.maestro.fs.homeDir().then(setHomeDir);
	}, []);

	// Expand tilde in path
	const expandTilde = (path: string): string => {
		if (!homeDir) return path;
		if (path === '~') return homeDir;
		if (path.startsWith('~/')) return homeDir + path.slice(1);
		return path;
	};

	// Validate folder and count markdown documents (debounced)
	useEffect(() => {
		if (!selectedFolder.trim()) {
			setFolderValidation({ checking: false, valid: false, docCount: 0 });
			return;
		}

		// If path starts with ~ but homeDir isn't loaded yet, wait
		if (selectedFolder.startsWith('~') && !homeDir) {
			setFolderValidation({ checking: true, valid: false, docCount: 0 });
			return;
		}

		// Debounce the validation
		const timeoutId = setTimeout(async () => {
			setFolderValidation((prev) => ({ ...prev, checking: true }));

			try {
				// Expand tilde inline to avoid closure issues
				let expandedPath = selectedFolder.trim();
				if (homeDir) {
					if (expandedPath === '~') {
						expandedPath = homeDir;
					} else if (expandedPath.startsWith('~/')) {
						expandedPath = homeDir + expandedPath.slice(1);
					}
				}

				const result = await window.maestro.autorun.listDocs(expandedPath, sshRemoteId);

				if (result.success) {
					setFolderValidation({
						checking: false,
						valid: true,
						docCount: result.files?.length || 0,
					});
				} else {
					setFolderValidation({
						checking: false,
						valid: false,
						docCount: 0,
						error: 'Folder not found or not accessible',
					});
				}
			} catch {
				setFolderValidation({
					checking: false,
					valid: false,
					docCount: 0,
					error: 'Failed to access folder',
				});
			}
		}, 300);

		return () => clearTimeout(timeoutId);
	}, [selectedFolder, homeDir, sshRemoteId]);

	const handleSelectFolder = async () => {
		const folder = await window.maestro.dialog.selectFolder();
		if (folder) {
			setSelectedFolder(folder);
			// Focus continue button after folder picker selection (not on typing)
			requestAnimationFrame(() => {
				continueButtonRef.current?.focus();
			});
		}
	};

	const handleContinue = () => {
		if (selectedFolder) {
			// Expand tilde before passing to callback
			const expandedPath = expandTilde(selectedFolder.trim());
			onFolderSelected(expandedPath);
			onClose();
		}
	};

	// Handle custom keyboard shortcuts
	const handleKeyDown = (e: React.KeyboardEvent) => {
		// Handle Cmd+O for folder picker (disabled when SSH remote is active)
		if ((e.key === 'o' || e.key === 'O') && (e.metaKey || e.ctrlKey)) {
			e.preventDefault();
			e.stopPropagation();
			if (!sshRemoteId) {
				handleSelectFolder();
			}
			return;
		}
		// Handle Enter for continue when folder is selected
		if (e.key === 'Enter' && selectedFolder) {
			e.preventDefault();
			e.stopPropagation();
			handleContinue();
			return;
		}
	};

	return (
		<div onKeyDown={handleKeyDown}>
			<Modal
				theme={theme}
				title="Change Auto Run Folder"
				priority={MODAL_PRIORITIES.AUTORUN_SETUP}
				onClose={onClose}
				width={520}
				footer={
					<ModalFooter
						theme={theme}
						onCancel={onClose}
						onConfirm={handleContinue}
						confirmLabel="Continue"
						confirmDisabled={!selectedFolder}
						confirmButtonRef={continueButtonRef}
					/>
				}
			>
				{/* Explanation */}
				<div className="space-y-4">
					<p className="text-sm leading-relaxed" style={{ color: theme.colors.textMain }}>
						Auto Run lets you manage and execute Markdown documents containing open tasks. Select a
						folder that contains your task documents. Each Maestro agent is assigned its own working
						folder.
					</p>

					{/* Feature list */}
					<div className="space-y-3">
						<div className="flex items-start gap-3">
							<FileText
								className="w-5 h-5 mt-0.5 flex-shrink-0"
								style={{ color: theme.colors.accent }}
							/>
							<div>
								<div className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
									Markdown Documents
								</div>
								<div className="text-xs" style={{ color: theme.colors.textDim }}>
									Each .md file in your folder becomes a runnable document
								</div>
							</div>
						</div>

						<div className="flex items-start gap-3">
							<CheckSquare
								className="w-5 h-5 mt-0.5 flex-shrink-0"
								style={{ color: theme.colors.accent }}
							/>
							<div>
								<div className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
									Checkbox Tasks
								</div>
								<div className="text-xs" style={{ color: theme.colors.textDim }}>
									Use markdown checkboxes (- [ ]) to define tasks that can be automated
								</div>
							</div>
						</div>

						<div className="flex items-start gap-3">
							<Play
								className="w-5 h-5 mt-0.5 flex-shrink-0"
								style={{ color: theme.colors.accent }}
							/>
							<div>
								<div className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
									Batch Execution
								</div>
								<div className="text-xs" style={{ color: theme.colors.textDim }}>
									Run multiple documents in sequence with loop and reset options
								</div>
							</div>
						</div>
					</div>
				</div>

				{/* Folder Selection */}
				<div
					className="p-4 rounded-lg border mt-5"
					style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain + '50' }}
				>
					<FormInput
						theme={theme}
						label="Auto Run Folder"
						value={selectedFolder}
						onChange={setSelectedFolder}
						placeholder={
							sshRemoteId
								? `Enter remote path${sshRemoteHost ? ` on ${sshRemoteHost}` : ''} (e.g., /home/user/docs)`
								: sessionName
									? `Select Auto Run folder for ${sessionName}`
									: 'Select Auto Run folder'
						}
						monospace
						heightClass="p-2"
						addon={
							<button
								onClick={sshRemoteId ? undefined : handleSelectFolder}
								disabled={!!sshRemoteId}
								className={`p-2 rounded border transition-colors ${sshRemoteId ? 'opacity-40 cursor-not-allowed' : 'hover:bg-white/5'}`}
								style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
								title={
									sshRemoteId
										? `Folder picker unavailable for SSH remote${sshRemoteHost ? ` (${sshRemoteHost})` : ''}. Enter the remote path manually.`
										: 'Browse folders (Cmd+O)'
								}
							>
								<Folder className="w-5 h-5" />
							</button>
						}
					/>
					{selectedFolder && (
						<div className="mt-2 text-xs">
							{folderValidation.checking ? (
								<span style={{ color: theme.colors.textDim }}>Checking folder...</span>
							) : folderValidation.valid ? (
								<span style={{ color: theme.colors.success }}>
									{folderValidation.docCount === 0
										? 'Folder found (no markdown documents yet)'
										: `Found ${folderValidation.docCount} markdown document${folderValidation.docCount === 1 ? '' : 's'}`}
								</span>
							) : folderValidation.error ? (
								<span style={{ color: theme.colors.error }}>{folderValidation.error}</span>
							) : null}
						</div>
					)}
				</div>
			</Modal>
		</div>
	);
}
