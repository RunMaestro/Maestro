/**
 * ExistingDocsModal.tsx
 *
 * Modal displayed when the wizard detects existing Auto Run documents
 * in the selected project directory. Offers the user two choices:
 * 1. Delete the existing docs and start fresh
 * 2. Continue building on the existing planning documents
 */

import { useEffect, useRef, useState } from 'react';
import { FileText, Trash2, ArrowRight } from 'lucide-react';
import type { Theme } from '../../types';
import { useLayerStack } from '../../contexts/LayerStackContext';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';

interface ExistingDocsModalProps {
	theme: Theme;
	/** Number of existing documents found */
	documentCount: number;
	/** Directory path where docs were found */
	directoryPath: string;
	/** Callback when user chooses to delete docs and start fresh */
	onStartFresh: () => void;
	/** Callback when user chooses to continue with existing docs */
	onContinue: () => void;
	/** Callback when user cancels (closes modal without choosing) */
	onCancel: () => void;
}

/**
 * ExistingDocsModal - Choice dialog for existing Auto Run documents
 */
export function ExistingDocsModal({
	theme,
	documentCount,
	directoryPath,
	onStartFresh,
	onContinue,
	onCancel,
}: ExistingDocsModalProps): JSX.Element {
	const { registerLayer, unregisterLayer, updateLayerHandler } = useLayerStack();
	const layerIdRef = useRef<string>();
	const continueButtonRef = useRef<HTMLButtonElement>(null);
	const onCancelRef = useRef(onCancel);
	onCancelRef.current = onCancel;

	const [isDeleting, setIsDeleting] = useState(false);
	const [deleteError, setDeleteError] = useState<string | null>(null);

	// Focus "Continue" button on mount (safer default - preserves work)
	useEffect(() => {
		continueButtonRef.current?.focus();
	}, []);

	// Register with layer stack
	useEffect(() => {
		const id = registerLayer({
			type: 'modal',
			priority: MODAL_PRIORITIES.EXISTING_AUTORUN_DOCS,
			blocksLowerLayers: true,
			capturesFocus: true,
			focusTrap: 'strict',
			ariaLabel: 'Existing Auto Run Documents Found',
			onEscape: () => onCancelRef.current(),
		});
		layerIdRef.current = id;
		return () => {
			if (layerIdRef.current) {
				unregisterLayer(layerIdRef.current);
			}
		};
	}, [registerLayer, unregisterLayer]);

	// Update escape handler when onCancel changes
	useEffect(() => {
		if (layerIdRef.current) {
			updateLayerHandler(layerIdRef.current, () => onCancelRef.current());
		}
	}, [onCancel, updateLayerHandler]);

	// Handle keyboard navigation
	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === 'Tab') {
			// Let natural tab flow work
			return;
		}
		e.stopPropagation();
	};

	/**
	 * Handle "Start Fresh" - delete existing docs folder
	 */
	const handleStartFresh = async () => {
		setIsDeleting(true);
		setDeleteError(null);

		try {
			// Delete the entire Auto Run Docs folder
			const deleteResult = await window.maestro.autorun.deleteFolder(directoryPath);
			if (!deleteResult.success) {
				throw new Error(deleteResult.error || 'Failed to delete Auto Run Docs folder');
			}

			// Success - notify parent
			onStartFresh();
		} catch (error) {
			console.error('Failed to delete existing docs:', error);
			setDeleteError(
				error instanceof Error ? error.message : 'Failed to delete existing documents'
			);
			setIsDeleting(false);
		}
	};

	return (
		<div
			className="fixed inset-0 modal-overlay flex items-center justify-center z-[10000] animate-in fade-in duration-200"
			role="dialog"
			aria-modal="true"
			aria-labelledby="existing-docs-title"
			aria-describedby="existing-docs-description"
			tabIndex={-1}
			onKeyDown={handleKeyDown}
		>
			<div
				className="w-[520px] border rounded-xl shadow-2xl overflow-hidden"
				style={{
					backgroundColor: theme.colors.bgSidebar,
					borderColor: theme.colors.border,
				}}
			>
				{/* Header */}
				<div
					className="p-4 border-b flex items-center gap-3"
					style={{ borderColor: theme.colors.border }}
				>
					<div className="p-2 rounded-lg" style={{ backgroundColor: `${theme.colors.accent}20` }}>
						<FileText className="w-5 h-5" style={{ color: theme.colors.accent }} />
					</div>
					<h2
						id="existing-docs-title"
						className="text-base font-semibold"
						style={{ color: theme.colors.textMain }}
					>
						Existing Auto Run Documents Found
					</h2>
				</div>

				{/* Content */}
				<div className="p-6">
					<p
						id="existing-docs-description"
						className="text-sm leading-relaxed"
						style={{ color: theme.colors.textMain }}
					>
						This project already has{' '}
						<span className="font-semibold" style={{ color: theme.colors.accent }}>
							{documentCount} Auto Run document{documentCount !== 1 ? 's' : ''}
						</span>{' '}
						from a previous planning session.
					</p>
					<p className="text-sm mt-3 leading-relaxed" style={{ color: theme.colors.textDim }}>
						How would you like to proceed?
					</p>

					{/* Error message */}
					{deleteError && (
						<div
							className="mt-4 p-3 rounded-lg text-sm"
							style={{
								backgroundColor: `${theme.colors.error}15`,
								color: theme.colors.error,
								border: `1px solid ${theme.colors.error}30`,
							}}
						>
							{deleteError}
						</div>
					)}

					{/* Options */}
					<div className="mt-6 space-y-3">
						{/* Option 1: Continue with existing docs */}
						<button
							ref={continueButtonRef}
							onClick={onContinue}
							disabled={isDeleting}
							className="w-full p-4 rounded-lg border text-left transition-all hover:scale-[1.01] focus:outline-none focus:ring-2 focus:ring-offset-2"
							style={{
								backgroundColor: theme.colors.bgMain,
								borderColor: theme.colors.accent,
								opacity: isDeleting ? 0.6 : 1,
							}}
						>
							<div className="flex items-start gap-3">
								<div
									className="p-2 rounded-lg shrink-0 mt-0.5"
									style={{ backgroundColor: `${theme.colors.success}20` }}
								>
									<ArrowRight className="w-4 h-4" style={{ color: theme.colors.success }} />
								</div>
								<div className="flex-1">
									<div className="font-medium text-sm" style={{ color: theme.colors.textMain }}>
										Continue Building on Existing Plan
									</div>
									<div className="text-xs mt-1" style={{ color: theme.colors.textDim }}>
										I'll analyze the existing documents, provide a synopsis of what's been planned,
										and help you continue from where you left off.
									</div>
								</div>
								<div
									className="text-xs px-2 py-1 rounded shrink-0"
									style={{
										backgroundColor: `${theme.colors.success}15`,
										color: theme.colors.success,
									}}
								>
									Recommended
								</div>
							</div>
						</button>

						{/* Option 2: Delete and start fresh */}
						<button
							onClick={handleStartFresh}
							disabled={isDeleting}
							className="w-full p-4 rounded-lg border text-left transition-all hover:scale-[1.01] focus:outline-none focus:ring-2 focus:ring-offset-2"
							style={{
								backgroundColor: theme.colors.bgMain,
								borderColor: theme.colors.border,
								opacity: isDeleting ? 0.6 : 1,
							}}
						>
							<div className="flex items-start gap-3">
								<div
									className="p-2 rounded-lg shrink-0 mt-0.5"
									style={{ backgroundColor: `${theme.colors.warning}20` }}
								>
									{isDeleting ? (
										<div
											className="w-4 h-4 border-2 border-t-transparent rounded-full animate-spin"
											style={{ borderColor: theme.colors.warning, borderTopColor: 'transparent' }}
										/>
									) : (
										<Trash2 className="w-4 h-4" style={{ color: theme.colors.warning }} />
									)}
								</div>
								<div className="flex-1">
									<div className="font-medium text-sm" style={{ color: theme.colors.textMain }}>
										{isDeleting ? 'Deleting Documents...' : 'Delete & Start Fresh'}
									</div>
									<div className="text-xs mt-1" style={{ color: theme.colors.textDim }}>
										Remove all existing Auto Run documents and start the planning process from
										scratch.
									</div>
								</div>
							</div>
						</button>
					</div>

					{/* Cancel link */}
					<div className="mt-6 text-center">
						<button
							onClick={onCancel}
							disabled={isDeleting}
							className="text-xs underline transition-colors hover:opacity-80"
							style={{ color: theme.colors.textDim }}
						>
							Cancel and choose a different directory
						</button>
					</div>

					{/* Keyboard hints */}
					<div className="mt-4 text-xs text-center" style={{ color: theme.colors.textDim }}>
						<kbd
							className="px-1.5 py-0.5 rounded border"
							style={{ borderColor: theme.colors.border }}
						>
							Tab
						</kbd>{' '}
						to switch •{' '}
						<kbd
							className="px-1.5 py-0.5 rounded border"
							style={{ borderColor: theme.colors.border }}
						>
							Enter
						</kbd>{' '}
						to confirm •{' '}
						<kbd
							className="px-1.5 py-0.5 rounded border"
							style={{ borderColor: theme.colors.border }}
						>
							Esc
						</kbd>{' '}
						to cancel
					</div>
				</div>
			</div>
		</div>
	);
}
