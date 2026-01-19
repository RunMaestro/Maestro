/**
 * DebugWizardModal.tsx
 *
 * Debug modal for jumping directly to the wizard's Phase Review step.
 * Collects directory path and agent name, loads existing Auto Run docs,
 * then navigates to Phase Review.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { FolderOpen } from 'lucide-react';
import type { Theme } from '../types';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { Modal, ModalFooter } from './ui/Modal';
import { useWizard } from './Wizard/WizardContext';
import { AUTO_RUN_FOLDER_NAME } from './Wizard/services/phaseGenerator';

interface DebugWizardModalProps {
	theme: Theme;
	isOpen: boolean;
	onClose: () => void;
}

export function DebugWizardModal({
	theme,
	isOpen,
	onClose,
}: DebugWizardModalProps): JSX.Element | null {
	const [directoryPath, setDirectoryPath] = useState('');
	const [agentName, setAgentName] = useState('');
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);

	const inputRef = useRef<HTMLInputElement>(null);

	const {
		openWizard,
		goToStep,
		setDirectoryPath: setWizardDirectoryPath,
		setAgentName: setWizardAgentName,
		setSelectedAgent,
		setGeneratedDocuments,
	} = useWizard();

	// Reset state when modal opens
	useEffect(() => {
		if (isOpen) {
			setDirectoryPath('');
			setAgentName('');
			setError(null);
			setLoading(false);
		}
	}, [isOpen]);

	const handleSelectDirectory = useCallback(async () => {
		try {
			const result = await window.maestro.dialog.selectFolder();
			if (result) {
				setDirectoryPath(result);
				// Auto-populate agent name from folder name
				const folderName = result.split('/').pop() || result.split('\\').pop() || 'My Project';
				if (!agentName) {
					setAgentName(folderName);
				}
				setError(null);
			}
		} catch (err) {
			console.error('Failed to select directory:', err);
		}
	}, [agentName]);

	const handleSubmit = useCallback(async () => {
		if (!directoryPath) {
			setError('Please select a directory');
			return;
		}

		if (!agentName.trim()) {
			setError('Please enter an agent name');
			return;
		}

		setLoading(true);
		setError(null);

		try {
			// Check if Auto Run Docs folder exists
			const autoRunPath = `${directoryPath}/${AUTO_RUN_FOLDER_NAME}`;

			let files: string[] = [];
			try {
				const dirContents = await window.maestro.fs.readDir(autoRunPath);
				files = dirContents
					.filter(
						(f: { name: string; isDirectory: boolean }) => !f.isDirectory && f.name.endsWith('.md')
					)
					.map((f: { name: string }) => f.name);
			} catch {
				setError(`No Auto Run Docs folder found at ${autoRunPath}`);
				setLoading(false);
				return;
			}

			if (files.length === 0) {
				setError(`No markdown files found in ${autoRunPath}`);
				setLoading(false);
				return;
			}

			// Load the documents
			const documents: Array<{
				filename: string;
				content: string;
				taskCount: number;
			}> = [];

			for (const filename of files) {
				try {
					const content = await window.maestro.fs.readFile(`${autoRunPath}/${filename}`);
					// Count tasks (markdown checkboxes)
					const taskCount = (content.match(/^-\s*\[\s*[xX ]?\s*\]/gm) || []).length;
					documents.push({ filename, content, taskCount });
				} catch (err) {
					console.warn(`Failed to read ${filename}:`, err);
				}
			}

			if (documents.length === 0) {
				setError('Failed to load any documents');
				setLoading(false);
				return;
			}

			// Set wizard state
			setSelectedAgent('claude-code');
			setWizardDirectoryPath(directoryPath);
			setWizardAgentName(agentName.trim());
			setGeneratedDocuments(documents);

			// Open wizard and navigate to phase-review
			openWizard();

			// Small delay to ensure wizard is mounted
			setTimeout(() => {
				goToStep('phase-review');
			}, 100);

			onClose();
		} catch (err) {
			console.error('Failed to load documents:', err);
			setError(err instanceof Error ? err.message : 'Unknown error');
			setLoading(false);
		}
	}, [
		directoryPath,
		agentName,
		openWizard,
		goToStep,
		setWizardDirectoryPath,
		setWizardAgentName,
		setSelectedAgent,
		setGeneratedDocuments,
		onClose,
	]);

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			if (e.key === 'Enter' && !loading) {
				e.preventDefault();
				handleSubmit();
			}
		},
		[handleSubmit, loading]
	);

	if (!isOpen) return null;

	return (
		<Modal
			theme={theme}
			title="Debug: Jump to Phase Review"
			priority={MODAL_PRIORITIES.CONFIRM || 100}
			onClose={onClose}
			width={500}
			initialFocusRef={inputRef}
			footer={
				<ModalFooter
					theme={theme}
					onCancel={onClose}
					onConfirm={handleSubmit}
					confirmLabel={loading ? 'Loading...' : 'Jump to Phase Review'}
					confirmDisabled={loading}
				/>
			}
		>
			<div className="space-y-4" onKeyDown={handleKeyDown}>
				{/* Directory picker */}
				<div>
					<label
						className="block text-sm font-medium mb-2"
						style={{ color: theme.colors.textMain }}
					>
						Project Directory
					</label>
					<div className="flex gap-2">
						<input
							ref={inputRef}
							type="text"
							value={directoryPath}
							onChange={(e) => setDirectoryPath(e.target.value)}
							placeholder="/path/to/project"
							className="flex-1 px-3 py-2 rounded-lg text-sm outline-none"
							style={{
								backgroundColor: theme.colors.bgMain,
								color: theme.colors.textMain,
								border: `1px solid ${theme.colors.border}`,
							}}
						/>
						<button
							onClick={handleSelectDirectory}
							className="px-3 py-2 rounded-lg flex items-center gap-2 hover:opacity-80 transition-opacity"
							style={{
								backgroundColor: theme.colors.bgMain,
								color: theme.colors.textMain,
								border: `1px solid ${theme.colors.border}`,
							}}
						>
							<FolderOpen className="w-4 h-4" />
							Browse
						</button>
					</div>
					<p className="text-xs mt-1" style={{ color: theme.colors.textDim }}>
						Must contain an "{AUTO_RUN_FOLDER_NAME}" folder with .md files
					</p>
				</div>

				{/* Agent name */}
				<div>
					<label
						className="block text-sm font-medium mb-2"
						style={{ color: theme.colors.textMain }}
					>
						Agent Name
					</label>
					<input
						type="text"
						value={agentName}
						onChange={(e) => setAgentName(e.target.value)}
						placeholder="My Project"
						className="w-full px-3 py-2 rounded-lg text-sm outline-none"
						style={{
							backgroundColor: theme.colors.bgMain,
							color: theme.colors.textMain,
							border: `1px solid ${theme.colors.border}`,
						}}
					/>
				</div>

				{/* Error message */}
				{error && (
					<div
						className="text-sm p-3 rounded-lg"
						style={{
							backgroundColor: `${theme.colors.error}20`,
							color: theme.colors.error,
						}}
					>
						{error}
					</div>
				)}
			</div>
		</Modal>
	);
}
