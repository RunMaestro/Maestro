/**
 * WizardExitConfirmModal.tsx
 *
 * Confirmation modal displayed when user attempts to exit the wizard mid-flow.
 * Shows after step 1 to confirm that the user wants to exit and informs them
 * that their progress will be saved for later resumption.
 */

import { useEffect, useRef } from 'react';
import { AlertCircle } from 'lucide-react';
import type { Theme } from '../../types';
import { useLayerStack } from '../../contexts/LayerStackContext';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';

interface WizardExitConfirmModalProps {
	theme: Theme;
	/** Current step number (1-4) */
	currentStep: number;
	/** Total number of steps */
	totalSteps: number;
	/** Callback when user confirms exit (saves progress and closes wizard) */
	onConfirmExit: () => void;
	/** Callback when user cancels and wants to stay in wizard */
	onCancel: () => void;
	/** Callback when user wants to quit without saving progress */
	onQuitWithoutSaving: () => void;
}

/**
 * WizardExitConfirmModal - Confirmation dialog for exiting wizard mid-flow
 *
 * Informs the user that their progress will be saved and they can resume later.
 * Focuses on "Stay" button by default since staying is typically the safer action.
 */
export function WizardExitConfirmModal({
	theme,
	currentStep,
	totalSteps,
	onConfirmExit,
	onCancel,
	onQuitWithoutSaving,
}: WizardExitConfirmModalProps): JSX.Element {
	const { registerLayer, unregisterLayer, updateLayerHandler } = useLayerStack();
	const layerIdRef = useRef<string>();
	const stayButtonRef = useRef<HTMLButtonElement>(null);
	const onCancelRef = useRef(onCancel);
	onCancelRef.current = onCancel;

	// Focus "Stay" button on mount (safer default action)
	useEffect(() => {
		stayButtonRef.current?.focus();
	}, []);

	// Register with layer stack
	useEffect(() => {
		const id = registerLayer({
			type: 'modal',
			priority: MODAL_PRIORITIES.WIZARD_EXIT_CONFIRM,
			blocksLowerLayers: true,
			capturesFocus: true,
			focusTrap: 'strict',
			ariaLabel: 'Confirm Exit Setup Wizard',
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

	const progressPercent = Math.round(((currentStep - 1) / (totalSteps - 1)) * 100);

	return (
		<div
			className="fixed inset-0 modal-overlay flex items-center justify-center z-[10000] animate-in fade-in duration-200"
			role="dialog"
			aria-modal="true"
			aria-labelledby="wizard-exit-title"
			aria-describedby="wizard-exit-description"
			tabIndex={-1}
			onKeyDown={handleKeyDown}
		>
			<div
				className="w-[480px] border rounded-xl shadow-2xl overflow-hidden"
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
						id="wizard-exit-title"
						className="text-base font-semibold"
						style={{ color: theme.colors.textMain }}
					>
						Exit Setup Wizard?
					</h2>
				</div>

				{/* Content */}
				<div className="p-6">
					<p
						id="wizard-exit-description"
						className="text-sm leading-relaxed"
						style={{ color: theme.colors.textMain }}
					>
						Are you sure you want to exit the setup wizard?
					</p>
					<p className="text-sm mt-3 leading-relaxed" style={{ color: theme.colors.textDim }}>
						Your progress can be saved, and you can resume where you left off the next time you open
						Maestro.
					</p>

					{/* Progress indicator */}
					<div
						className="mt-4 p-3 rounded-lg border"
						style={{
							backgroundColor: theme.colors.bgMain,
							borderColor: theme.colors.border,
						}}
					>
						<div className="flex justify-between items-center mb-2">
							<span className="text-xs font-medium" style={{ color: theme.colors.textDim }}>
								Current Progress
							</span>
							<span className="text-xs font-medium" style={{ color: theme.colors.accent }}>
								Step {currentStep} of {totalSteps}
							</span>
						</div>
						<div
							className="h-2 rounded-full overflow-hidden"
							style={{ backgroundColor: theme.colors.border }}
						>
							<div
								className="h-full rounded-full transition-all duration-300"
								style={{
									width: `${progressPercent}%`,
									backgroundColor: theme.colors.accent,
								}}
							/>
						</div>
					</div>

					{/* Actions */}
					<div className="mt-6 flex justify-center gap-3">
						<button
							onClick={onConfirmExit}
							className="px-4 py-2 rounded-lg border text-sm font-medium hover:bg-white/5 transition-colors focus:outline-none focus:ring-2 focus:ring-offset-1"
							style={{
								borderColor: theme.colors.border,
								color: theme.colors.textMain,
								['--tw-ring-color' as any]: theme.colors.accent,
								['--tw-ring-offset-color' as any]: theme.colors.bgSidebar,
							}}
						>
							Exit & Save Progress
						</button>
						<button
							onClick={onQuitWithoutSaving}
							className="px-4 py-2 rounded-lg border text-sm font-medium hover:bg-white/5 transition-colors focus:outline-none focus:ring-2 focus:ring-offset-1"
							style={{
								borderColor: theme.colors.border,
								color: theme.colors.textMain,
								['--tw-ring-color' as any]: theme.colors.accent,
								['--tw-ring-offset-color' as any]: theme.colors.bgSidebar,
							}}
						>
							Just Quit
						</button>
						<button
							ref={stayButtonRef}
							onClick={onCancel}
							className="px-4 py-2 rounded-lg text-sm font-medium focus:outline-none focus:ring-2 focus:ring-offset-1 transition-colors"
							style={{
								backgroundColor: theme.colors.accent,
								color: theme.colors.accentForeground,
								['--tw-ring-color' as any]: theme.colors.accent,
								['--tw-ring-offset-color' as any]: theme.colors.bgSidebar,
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
