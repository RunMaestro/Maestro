/**
 * ExistingAutoRunDocsModal.tsx
 *
 * Dialog that appears when the user selects a directory that already contains
 * an "Auto Run Docs" folder. Gives users the option to:
 * 1. Start fresh - delete existing docs and begin new planning
 * 2. Continue planning - have the agent read existing docs and continue from there
 */

import { useEffect, useRef, useState } from 'react';
import { Trash2, BookOpen, FolderOpen, AlertTriangle, FileText } from 'lucide-react';
import type { Theme } from '../../types';
import { useLayerStack } from '../../contexts/LayerStackContext';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';

interface ExistingAutoRunDocsModalProps {
	theme: Theme;
	directoryPath: string;
	documentCount: number;
	onStartFresh: () => void;
	onContinuePlanning: () => void;
	onCancel: () => void;
}

export function ExistingAutoRunDocsModal({
	theme,
	directoryPath,
	documentCount,
	onStartFresh,
	onContinuePlanning,
	onCancel,
}: ExistingAutoRunDocsModalProps) {
	const { registerLayer, unregisterLayer, updateLayerHandler } = useLayerStack();
	const layerIdRef = useRef<string>();
	const continueButtonRef = useRef<HTMLButtonElement>(null);
	const [focusedButton, setFocusedButton] = useState<'continue' | 'fresh'>('continue');
	const [isDeleting, setIsDeleting] = useState(false);

	// Focus continue button on mount
	useEffect(() => {
		continueButtonRef.current?.focus();
	}, []);

	// Register layer on mount
	useEffect(() => {
		const id = registerLayer({
			type: 'modal',
			priority: MODAL_PRIORITIES.EXISTING_AUTORUN_DOCS,
			blocksLowerLayers: true,
			capturesFocus: true,
			focusTrap: 'strict',
			ariaLabel: 'Existing Auto Run Documents Detected',
			onEscape: onCancel,
		});
		layerIdRef.current = id;
		return () => {
			if (layerIdRef.current) {
				unregisterLayer(layerIdRef.current);
			}
		};
	}, [registerLayer, unregisterLayer]);

	// Update handler when dependencies change
	useEffect(() => {
		if (layerIdRef.current) {
			updateLayerHandler(layerIdRef.current, onCancel);
		}
	}, [onCancel, updateLayerHandler]);

	// Handle keyboard navigation between buttons
	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === 'Tab') {
			e.preventDefault();
			setFocusedButton(focusedButton === 'continue' ? 'fresh' : 'continue');
		} else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			e.preventDefault();
			setFocusedButton(focusedButton === 'continue' ? 'fresh' : 'continue');
		} else if (e.key === 'Enter') {
			e.preventDefault();
			if (focusedButton === 'continue') {
				onContinuePlanning();
			} else {
				handleStartFresh();
			}
		}
	};

	// Handle start fresh with loading state
	const handleStartFresh = async () => {
		setIsDeleting(true);
		// Call the parent handler which will delete the folder
		onStartFresh();
	};

	// Auto-focus the correct button when focusedButton changes
	useEffect(() => {
		if (focusedButton === 'continue') {
			continueButtonRef.current?.focus();
		}
	}, [focusedButton]);

	// Get folder name from path
	const folderName = directoryPath.split('/').pop() || directoryPath;

	return (
		<div
			className="fixed inset-0 modal-overlay flex items-center justify-center z-[10000] animate-in fade-in duration-200"
			role="dialog"
			aria-modal="true"
			aria-label="Existing Auto Run Documents Detected"
			tabIndex={-1}
			onKeyDown={handleKeyDown}
		>
			<div
				className="w-[520px] border rounded-xl shadow-2xl overflow-hidden"
				style={{ backgroundColor: theme.colors.bgSidebar, borderColor: theme.colors.border }}
			>
				{/* Header */}
				<div className="p-5 border-b" style={{ borderColor: theme.colors.border }}>
					<div className="flex items-center gap-3">
						<div
							className="w-10 h-10 rounded-lg flex items-center justify-center"
							style={{ backgroundColor: theme.colors.warning + '20' }}
						>
							<AlertTriangle className="w-5 h-5" style={{ color: theme.colors.warning }} />
						</div>
						<div>
							<h2 className="text-lg font-semibold" style={{ color: theme.colors.textMain }}>
								Existing Planning Documents Found
							</h2>
							<p className="text-sm mt-0.5" style={{ color: theme.colors.textDim }}>
								This project already has Auto Run documents
							</p>
						</div>
					</div>
				</div>

				{/* Content */}
				<div className="p-5 space-y-4">
					{/* Project info */}
					<div
						className="rounded-lg p-4 space-y-3"
						style={{ backgroundColor: theme.colors.bgActivity }}
					>
						<div className="flex items-center gap-3">
							<div
								className="w-8 h-8 rounded-lg flex items-center justify-center"
								style={{ backgroundColor: theme.colors.accent + '20' }}
							>
								<FolderOpen className="w-4 h-4" style={{ color: theme.colors.accent }} />
							</div>
							<div className="flex-1 min-w-0">
								<p className="text-xs" style={{ color: theme.colors.textDim }}>
									Project Location
								</p>
								<p
									className="text-sm font-mono truncate"
									style={{ color: theme.colors.textMain }}
									title={directoryPath}
								>
									{folderName}
								</p>
							</div>
						</div>

						<div className="flex items-center gap-3">
							<div className="w-8" />
							<div className="flex items-center gap-2">
								<FileText className="w-4 h-4" style={{ color: theme.colors.textDim }} />
								<p className="text-sm" style={{ color: theme.colors.textMain }}>
									{documentCount} document{documentCount !== 1 ? 's' : ''} found in{' '}
									<code
										className="px-1.5 py-0.5 rounded text-xs font-mono"
										style={{ backgroundColor: theme.colors.bgMain }}
									>
										Auto Run Docs/
									</code>
								</p>
							</div>
						</div>
					</div>

					{/* Explanation */}
					<p className="text-sm leading-relaxed" style={{ color: theme.colors.textDim }}>
						It looks like you've already started planning this project. Would you like the agent to
						read the existing documents and continue from where you left off, or start fresh with a
						new plan?
					</p>
				</div>

				{/* Actions */}
				<div className="p-5 pt-0 space-y-3">
					<button
						ref={continueButtonRef}
						onClick={onContinuePlanning}
						onFocus={() => setFocusedButton('continue')}
						className="w-full py-3 px-4 rounded-lg flex items-center justify-center gap-2 font-medium transition-all duration-200 outline-none"
						style={{
							backgroundColor: theme.colors.accent,
							color: theme.colors.accentForeground,
							boxShadow:
								focusedButton === 'continue'
									? `0 0 0 2px ${theme.colors.bgSidebar}, 0 0 0 4px ${theme.colors.accent}`
									: 'none',
						}}
					>
						<BookOpen className="w-4 h-4" />
						Continue Planning
					</button>

					<button
						onClick={handleStartFresh}
						onFocus={() => setFocusedButton('fresh')}
						disabled={isDeleting}
						className="w-full py-3 px-4 rounded-lg flex items-center justify-center gap-2 font-medium border transition-all duration-200 outline-none hover:bg-white/5"
						style={{
							borderColor: theme.colors.error + '60',
							color: theme.colors.error,
							opacity: isDeleting ? 0.7 : 1,
							boxShadow:
								focusedButton === 'fresh'
									? `0 0 0 2px ${theme.colors.bgSidebar}, 0 0 0 4px ${theme.colors.error}`
									: 'none',
						}}
					>
						{isDeleting ? (
							<>
								<div
									className="w-4 h-4 border-2 border-t-transparent rounded-full animate-spin"
									style={{ borderColor: theme.colors.error, borderTopColor: 'transparent' }}
								/>
								Deleting...
							</>
						) : (
							<>
								<Trash2 className="w-4 h-4" />
								Start Fresh (Delete Existing Docs)
							</>
						)}
					</button>

					{/* Keyboard hints */}
					<p className="text-center text-xs pt-2" style={{ color: theme.colors.textDim }}>
						Press{' '}
						<kbd
							className="px-1.5 py-0.5 rounded text-[10px] font-mono"
							style={{ backgroundColor: theme.colors.bgActivity }}
						>
							Tab
						</kbd>{' '}
						to switch,{' '}
						<kbd
							className="px-1.5 py-0.5 rounded text-[10px] font-mono"
							style={{ backgroundColor: theme.colors.bgActivity }}
						>
							Enter
						</kbd>{' '}
						to confirm,{' '}
						<kbd
							className="px-1.5 py-0.5 rounded text-[10px] font-mono"
							style={{ backgroundColor: theme.colors.bgActivity }}
						>
							Esc
						</kbd>{' '}
						to cancel
					</p>
				</div>
			</div>
		</div>
	);
}
