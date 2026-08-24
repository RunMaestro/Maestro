/**
 * WizardExitConfirmDialog.tsx
 *
 * Destructive confirmation shown before leaving the inline wizard. Leaving discards the
 * whole conversation, so this is the ONLY route out - Escape never exits the wizard
 * directly, it opens this.
 *
 * Confirming is deliberate: the red "Yes, Exit" button is focused, so Enter confirms and
 * Escape (the reflex after an accidental Escape) cancels.
 */

import { useEffect, useRef } from 'react';
import { AlertTriangle } from 'lucide-react';
import type { Theme } from '../../types';
import { useModalLayer } from '../../hooks/ui/useModalLayer';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';

interface WizardExitConfirmDialogProps {
	theme: Theme;
	/** Called when user confirms exit */
	onConfirm: () => void;
	/** Called when user cancels and wants to stay in wizard */
	onCancel: () => void;
}

/**
 * WizardExitConfirmDialog - Destructive confirmation for exiting the inline wizard
 *
 * Warns that the conversation will be lost (the inline wizard doesn't persist state).
 * Focuses the destructive "Yes, Exit" button so Enter confirms; Escape cancels.
 */
export function WizardExitConfirmDialog({
	theme,
	onConfirm,
	onCancel,
}: WizardExitConfirmDialogProps): JSX.Element {
	const confirmButtonRef = useRef<HTMLButtonElement>(null);
	const onCancelRef = useRef(onCancel);
	onCancelRef.current = onCancel;

	// Focus the confirm button so Enter confirms. Escape still cancels (via the modal
	// layer below), which is the reflex when this dialog was opened by accident.
	useEffect(() => {
		confirmButtonRef.current?.focus();
	}, []);

	useModalLayer(MODAL_PRIORITIES.INLINE_WIZARD_EXIT_CONFIRM, 'Confirm Exit Wizard', () =>
		onCancelRef.current()
	);

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
				className="modal-w-xs border rounded-xl shadow-2xl overflow-hidden"
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
					<div className="p-2 rounded-lg" style={{ backgroundColor: `${theme.colors.error}20` }}>
						<AlertTriangle className="w-5 h-5" style={{ color: theme.colors.error }} />
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
						Are you sure you want to exit the wizard and lose your progress? The conversation and
						anything not yet generated will be discarded.
					</p>

					{/* Actions. Cancel sits first so the destructive button is not under the
					    cursor's resting place, but the destructive one holds focus for Enter. */}
					<div className="mt-6 flex justify-end gap-3">
						<button
							onClick={onCancel}
							className="px-4 py-2 rounded-lg border text-sm font-medium hover:bg-white/5 transition-colors outline-none focus:ring-2"
							style={{
								borderColor: theme.colors.border,
								color: theme.colors.textMain,
							}}
						>
							Cancel
						</button>
						<button
							ref={confirmButtonRef}
							onClick={onConfirm}
							className="px-4 py-2 rounded-lg text-sm font-medium outline-none focus:ring-2 focus:ring-offset-1 transition-colors hover:opacity-90"
							style={{
								backgroundColor: theme.colors.error,
								color: 'white',
							}}
							data-testid="wizard-exit-confirm-button"
						>
							Yes, Exit
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
						to exit •{' '}
						<kbd
							className="px-1.5 py-0.5 rounded border"
							style={{ borderColor: theme.colors.border }}
						>
							Esc
						</kbd>{' '}
						to stay
					</div>
				</div>
			</div>
		</div>
	);
}
