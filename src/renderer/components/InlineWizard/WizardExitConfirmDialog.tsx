/**
 * WizardExitConfirmDialog.tsx
 *
 * Simple confirmation dialog shown when user presses Escape during the inline wizard.
 * Asks "Exit wizard? Progress will be lost." with Cancel and Exit options.
 */

import { useEffect, useRef } from 'react';
import { AlertCircle } from 'lucide-react';
import type { Theme } from '../../types';
import { useLayerStack } from '../../contexts/LayerStackContext';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';

interface WizardExitConfirmDialogProps {
	theme: Theme;
	/** Called when user confirms exit */
	onConfirm: () => void;
	/** Called when user cancels and wants to stay in wizard */
	onCancel: () => void;
}

/**
 * WizardExitConfirmDialog - Simple confirmation for exiting inline wizard
 *
 * Shows a dialog asking if the user wants to exit the wizard.
 * Warns that progress will be lost (inline wizard doesn't persist state).
 * Focuses on "Cancel" button by default since staying is typically safer.
 */
export function WizardExitConfirmDialog({
	theme,
	onConfirm,
	onCancel,
}: WizardExitConfirmDialogProps): JSX.Element {
	const { registerLayer, unregisterLayer, updateLayerHandler } = useLayerStack();
	const layerIdRef = useRef<string>();
	const cancelButtonRef = useRef<HTMLButtonElement>(null);
	const onCancelRef = useRef(onCancel);
	onCancelRef.current = onCancel;

	// Focus "Cancel" button on mount (safer default action)
	useEffect(() => {
		cancelButtonRef.current?.focus();
	}, []);

	// Register with layer stack
	useEffect(() => {
		const id = registerLayer({
			type: 'modal',
			priority: MODAL_PRIORITIES.INLINE_WIZARD_EXIT_CONFIRM,
			blocksLowerLayers: true,
			capturesFocus: true,
			focusTrap: 'strict',
			ariaLabel: 'Confirm Exit Wizard',
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
		if (e.key === 'Enter') {
			// Enter confirms the focused button
			return;
		}
		e.stopPropagation();
	};

	return (
		<div
			className="fixed inset-0 modal-overlay flex items-center justify-center z-[10000] animate-in fade-in duration-200"
			role="dialog"
			aria-modal="true"
			aria-labelledby="wizard-exit-dialog-title"
			aria-describedby="wizard-exit-dialog-description"
			tabIndex={-1}
			onKeyDown={handleKeyDown}
		>
			<div
				className="w-[400px] border rounded-xl shadow-2xl overflow-hidden"
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
					<div className="p-2 rounded-lg" style={{ backgroundColor: `${theme.colors.warning}20` }}>
						<AlertCircle className="w-5 h-5" style={{ color: theme.colors.warning }} />
					</div>
					<h2
						id="wizard-exit-dialog-title"
						className="text-base font-semibold"
						style={{ color: theme.colors.textMain }}
					>
						Exit Wizard?
					</h2>
				</div>

				{/* Content */}
				<div className="p-6">
					<p
						id="wizard-exit-dialog-description"
						className="text-sm leading-relaxed"
						style={{ color: theme.colors.textDim }}
					>
						Progress will be lost. Are you sure you want to exit the wizard?
					</p>

					{/* Actions */}
					<div className="mt-6 flex justify-end gap-3">
						<button
							onClick={onConfirm}
							className="px-4 py-2 rounded-lg border text-sm font-medium hover:bg-white/5 transition-colors"
							style={{
								borderColor: theme.colors.border,
								color: theme.colors.textMain,
							}}
						>
							Exit
						</button>
						<button
							ref={cancelButtonRef}
							onClick={onCancel}
							className="px-4 py-2 rounded-lg text-sm font-medium outline-none focus:ring-2 focus:ring-offset-1 transition-colors"
							style={{
								backgroundColor: theme.colors.accent,
								color: theme.colors.accentForeground,
							}}
						>
							Cancel
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
