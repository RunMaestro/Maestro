/**
 * WizardModePrompt.tsx
 *
 * Modal/inline prompt shown when wizard mode is 'ask' (user ran `/wizard`
 * with no args and existing Auto Run docs exist). Allows user to choose
 * between creating a new plan or iterating on an existing one.
 *
 * Features:
 * - Two main buttons: "Create New Plan" and "Iterate on Existing"
 * - Text input for describing the goal when iterating
 * - Styled to match app modals
 * - On selection, calls setWizardMode() and setWizardGoal() from context
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Wand2, FileText, RefreshCw } from 'lucide-react';
import type { Theme } from '../../types';
import type { InlineWizardMode } from '../../hooks/useInlineWizard';
import { Modal } from '../ui/Modal';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';

export interface WizardModePromptProps {
	/** Theme for styling */
	theme: Theme;
	/** Whether the prompt is visible */
	isOpen: boolean;
	/** Callback when user selects a mode */
	onSelectMode: (mode: InlineWizardMode) => void;
	/** Callback when user sets a goal (for iterate mode) */
	onSetGoal: (goal: string | null) => void;
	/** Callback to close the prompt (e.g., on cancel/exit) */
	onClose: () => void;
	/** Number of existing documents (for context) */
	existingDocCount?: number;
}

/**
 * WizardModePrompt - Modal for choosing between 'new' and 'iterate' wizard modes
 *
 * This is shown when the user runs `/wizard` without arguments and existing
 * Auto Run documents are detected. They can choose to:
 * 1. Create a new plan from scratch
 * 2. Iterate on existing documents with a specific goal
 */
export function WizardModePrompt({
	theme,
	isOpen,
	onSelectMode,
	onSetGoal,
	onClose,
	existingDocCount = 0,
}: WizardModePromptProps): JSX.Element | null {
	const [selectedOption, setSelectedOption] = useState<'new' | 'iterate' | null>(null);
	const [iterateGoal, setIterateGoal] = useState('');
	const goalInputRef = useRef<HTMLInputElement>(null);
	const newButtonRef = useRef<HTMLButtonElement>(null);

	// Reset state when modal opens
	useEffect(() => {
		if (isOpen) {
			setSelectedOption(null);
			setIterateGoal('');
		}
	}, [isOpen]);

	// Focus goal input when iterate is selected
	useEffect(() => {
		if (selectedOption === 'iterate' && goalInputRef.current) {
			goalInputRef.current.focus();
		}
	}, [selectedOption]);

	const handleNewPlan = useCallback(() => {
		onSetGoal(null);
		onSelectMode('new');
		onClose();
	}, [onSelectMode, onSetGoal, onClose]);

	const handleIterateConfirm = useCallback(() => {
		const trimmedGoal = iterateGoal.trim();
		onSetGoal(trimmedGoal || null);
		onSelectMode('iterate');
		onClose();
	}, [iterateGoal, onSelectMode, onSetGoal, onClose]);

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			if (e.key === 'Enter' && selectedOption === 'iterate' && iterateGoal.trim()) {
				e.preventDefault();
				handleIterateConfirm();
			}
		},
		[selectedOption, iterateGoal, handleIterateConfirm]
	);

	if (!isOpen) {
		return null;
	}

	return (
		<Modal
			theme={theme}
			title="Wizard Mode"
			priority={MODAL_PRIORITIES.WIZARD_MODE_PROMPT}
			onClose={onClose}
			width={480}
			headerIcon={<Wand2 className="w-5 h-5" style={{ color: theme.colors.accent }} />}
			initialFocusRef={newButtonRef}
			testId="wizard-mode-prompt"
		>
			<div className="space-y-6">
				{/* Intro text */}
				<p className="text-sm" style={{ color: theme.colors.textDim }}>
					{existingDocCount > 0
						? `You have ${existingDocCount} existing Auto Run document${existingDocCount === 1 ? '' : 's'}. What would you like to do?`
						: 'Choose how you want to proceed with the wizard.'}
				</p>

				{/* Option buttons */}
				<div className="space-y-3">
					{/* Create New Plan option */}
					<button
						ref={newButtonRef}
						type="button"
						onClick={() => {
							setSelectedOption('new');
							handleNewPlan();
						}}
						className="w-full p-4 rounded-lg border-2 text-left transition-all hover:border-opacity-80 focus:outline-none focus:ring-2 focus:ring-offset-1"
						style={{
							borderColor: selectedOption === 'new' ? theme.colors.accent : theme.colors.border,
							backgroundColor:
								selectedOption === 'new' ? `${theme.colors.accent}10` : theme.colors.bgMain,
						}}
						data-testid="wizard-mode-new-button"
					>
						<div className="flex items-start gap-3">
							<div
								className="p-2 rounded-lg"
								style={{ backgroundColor: `${theme.colors.accent}20` }}
							>
								<FileText className="w-5 h-5" style={{ color: theme.colors.accent }} />
							</div>
							<div className="flex-1">
								<h3 className="font-semibold text-sm mb-1" style={{ color: theme.colors.textMain }}>
									Create New Plan
								</h3>
								<p className="text-xs" style={{ color: theme.colors.textDim }}>
									Start fresh with a new project plan. The wizard will ask you about your project to
									generate new Auto Run documents.
								</p>
							</div>
						</div>
					</button>

					{/* Iterate on Existing option */}
					<div
						className="rounded-lg border-2 transition-all"
						style={{
							borderColor: selectedOption === 'iterate' ? theme.colors.accent : theme.colors.border,
							backgroundColor:
								selectedOption === 'iterate' ? `${theme.colors.accent}10` : theme.colors.bgMain,
						}}
					>
						<button
							type="button"
							onClick={() => setSelectedOption('iterate')}
							className="w-full p-4 text-left focus:outline-none focus:ring-2 focus:ring-inset"
							data-testid="wizard-mode-iterate-button"
						>
							<div className="flex items-start gap-3">
								<div
									className="p-2 rounded-lg"
									style={{ backgroundColor: `${theme.colors.success}20` }}
								>
									<RefreshCw className="w-5 h-5" style={{ color: theme.colors.success }} />
								</div>
								<div className="flex-1">
									<h3
										className="font-semibold text-sm mb-1"
										style={{ color: theme.colors.textMain }}
									>
										Iterate on Existing
									</h3>
									<p className="text-xs" style={{ color: theme.colors.textDim }}>
										Build upon your existing documents. Tell the wizard what you want to add,
										change, or extend.
									</p>
								</div>
							</div>
						</button>

						{/* Goal input - shown when iterate is selected */}
						{selectedOption === 'iterate' && (
							<div
								className="px-4 pb-4 pt-2 border-t"
								style={{ borderColor: `${theme.colors.accent}30` }}
							>
								<label
									htmlFor="iterate-goal-input"
									className="block text-xs font-medium mb-2"
									style={{ color: theme.colors.textMain }}
								>
									What do you want to add or change?
								</label>
								<input
									ref={goalInputRef}
									id="iterate-goal-input"
									type="text"
									value={iterateGoal}
									onChange={(e) => setIterateGoal(e.target.value)}
									onKeyDown={handleKeyDown}
									placeholder="e.g., Add user authentication, fix performance issues..."
									className="w-full px-3 py-2 text-sm rounded-md border outline-none focus:ring-2"
									style={{
										borderColor: theme.colors.border,
										backgroundColor: theme.colors.bgSidebar,
										color: theme.colors.textMain,
									}}
									data-testid="wizard-mode-goal-input"
								/>
								<div className="mt-3 flex justify-end gap-2">
									<button
										type="button"
										onClick={() => setSelectedOption(null)}
										className="px-3 py-1.5 text-xs rounded border hover:bg-white/5 transition-colors"
										style={{
											borderColor: theme.colors.border,
											color: theme.colors.textDim,
										}}
									>
										Back
									</button>
									<button
										type="button"
										onClick={handleIterateConfirm}
										className="px-3 py-1.5 text-xs rounded transition-colors disabled:opacity-50"
										style={{
											backgroundColor: theme.colors.accent,
											color: theme.colors.accentForeground,
										}}
										disabled={!iterateGoal.trim()}
										data-testid="wizard-mode-confirm-button"
									>
										Continue
									</button>
								</div>
							</div>
						)}
					</div>
				</div>

				{/* Cancel button */}
				<div className="flex justify-end pt-2">
					<button
						type="button"
						onClick={onClose}
						className="px-4 py-2 text-sm rounded border hover:bg-white/5 transition-colors"
						style={{
							borderColor: theme.colors.border,
							color: theme.colors.textDim,
						}}
						data-testid="wizard-mode-cancel-button"
					>
						Cancel
					</button>
				</div>
			</div>
		</Modal>
	);
}

export default WizardModePrompt;
