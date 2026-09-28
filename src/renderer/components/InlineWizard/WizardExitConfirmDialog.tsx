/**
 * WizardExitConfirmDialog.tsx
 *
 * Confirmation shown before leaving the inline wizard. This is the ONLY route out -
 * Escape never exits the wizard directly, it opens this.
 *
 * Exiting has two different outcomes and the copy has to say which one applies, because
 * one of them loses data and the other does not. `willCloseTab` is true when the wizard
 * got its own throwaway tab: exiting closes that tab and the conversation goes with it.
 * Otherwise `/wizard` ran in place in a tab the user was already using, and exiting
 * flattens the wizard conversation into that tab's normal transcript (see
 * `flattenWizardIntoTab`), so nothing is lost.
 *
 * Confirming is deliberate: the "Yes, Exit" button is focused, so Enter confirms and
 * Escape (the reflex after an accidental Escape) cancels. It is painted in the error
 * color only when exiting actually destroys something.
 */

import { useEffect, useRef } from 'react';
import { AlertTriangle } from 'lucide-react';
import type { Theme } from '../../types';
import { useModalLayer } from '../../hooks/ui/useModalLayer';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';

interface WizardExitConfirmDialogProps {
	theme: Theme;
	/**
	 * True when exiting closes the wizard's own tab, discarding the conversation.
	 * False when the wizard ran in place and the conversation is kept in the tab.
	 */
	willCloseTab: boolean;
	/** Called when user confirms exit */
	onConfirm: () => void;
	/** Called when user cancels and wants to stay in wizard */
	onCancel: () => void;
}

/**
 * WizardExitConfirmDialog - Confirmation for exiting the inline wizard
 *
 * Says whether the conversation is discarded (throwaway wizard tab) or kept in the tab
 * (`/wizard` run in place). Focuses "Yes, Exit" so Enter confirms; Escape cancels.
 */
export function WizardExitConfirmDialog({
	theme,
	willCloseTab,
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
					<div
						className="p-2 rounded-lg"
						style={{
							backgroundColor: `${willCloseTab ? theme.colors.error : theme.colors.accent}20`,
						}}
					>
						<AlertTriangle
							className="w-5 h-5"
							style={{ color: willCloseTab ? theme.colors.error : theme.colors.accent }}
						/>
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
						{willCloseTab
							? 'Are you sure you want to exit the wizard and lose your progress? This closes the wizard tab, so the conversation and anything not yet generated will be discarded.'
							: 'Leave wizard mode? The conversation stays in this tab and you can keep chatting. Anything not yet generated will be discarded.'}
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
								backgroundColor: willCloseTab ? theme.colors.error : theme.colors.accent,
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
