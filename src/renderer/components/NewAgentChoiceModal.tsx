/**
 * NewAgentChoiceModal - Presents two large tiles for creating a new agent:
 * 1. Manual Setup - Opens the standard NewInstanceModal
 * 2. Guided Setup (Wizard) - Opens the full onboarding wizard
 *
 * Includes an informational note about the in-tab wizard alternative.
 */

import { Bot, Wand2, Info } from 'lucide-react';
import type { Theme } from '../types';
import { Modal } from './ui/Modal';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';

interface NewAgentChoiceModalProps {
	theme: Theme;
	onClose: () => void;
	onManualSetup: () => void;
	onWizardSetup: () => void;
	wizardAvailable: boolean;
}

export function NewAgentChoiceModal({
	theme,
	onClose,
	onManualSetup,
	onWizardSetup,
	wizardAvailable,
}: NewAgentChoiceModalProps) {
	const handleManual = () => {
		onClose();
		onManualSetup();
	};

	const handleWizard = () => {
		onClose();
		onWizardSetup();
	};

	return (
		<Modal
			theme={theme}
			title="New Agent"
			priority={MODAL_PRIORITIES.NEW_AGENT_CHOICE}
			onClose={onClose}
			width={680}
			testId="new-agent-choice-modal"
		>
			<div className="flex flex-col gap-5">
				{/* Two large tiles */}
				<div className="grid grid-cols-2 gap-4">
					{/* Manual Setup Tile */}
					<button
						type="button"
						onClick={handleManual}
						className="flex flex-col items-center gap-4 p-8 rounded-xl border-2 transition-all hover:scale-[1.02] active:scale-[0.98] cursor-pointer text-center"
						style={{
							borderColor: theme.colors.border,
							backgroundColor: theme.colors.bgMain,
						}}
						onMouseEnter={(e) => {
							e.currentTarget.style.borderColor = theme.colors.accent;
							e.currentTarget.style.backgroundColor = `${theme.colors.accent}10`;
						}}
						onMouseLeave={(e) => {
							e.currentTarget.style.borderColor = theme.colors.border;
							e.currentTarget.style.backgroundColor = theme.colors.bgMain;
						}}
						data-testid="manual-setup-tile"
					>
						<div
							className="w-16 h-16 rounded-2xl flex items-center justify-center"
							style={{ backgroundColor: `${theme.colors.accent}20` }}
						>
							<Bot className="w-8 h-8" style={{ color: theme.colors.accent }} />
						</div>
						<div>
							<h3 className="text-base font-bold mb-1" style={{ color: theme.colors.textMain }}>
								Manual Setup
							</h3>
							<p className="text-xs leading-relaxed" style={{ color: theme.colors.textDim }}>
								Choose your agent, working directory, and configuration options directly.
							</p>
						</div>
					</button>

					{/* Wizard Setup Tile */}
					<button
						type="button"
						onClick={handleWizard}
						disabled={!wizardAvailable}
						className="flex flex-col items-center gap-4 p-8 rounded-xl border-2 transition-all hover:scale-[1.02] active:scale-[0.98] cursor-pointer text-center disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:scale-100"
						style={{
							borderColor: theme.colors.border,
							backgroundColor: theme.colors.bgMain,
						}}
						onMouseEnter={(e) => {
							if (!wizardAvailable) return;
							e.currentTarget.style.borderColor = theme.colors.accent;
							e.currentTarget.style.backgroundColor = `${theme.colors.accent}10`;
						}}
						onMouseLeave={(e) => {
							e.currentTarget.style.borderColor = theme.colors.border;
							e.currentTarget.style.backgroundColor = theme.colors.bgMain;
						}}
						data-testid="wizard-setup-tile"
					>
						<div
							className="w-16 h-16 rounded-2xl flex items-center justify-center"
							style={{ backgroundColor: `${theme.colors.accent}20` }}
						>
							<Wand2 className="w-8 h-8" style={{ color: theme.colors.accent }} />
						</div>
						<div>
							<h3 className="text-base font-bold mb-1" style={{ color: theme.colors.textMain }}>
								Guided Setup
							</h3>
							<p className="text-xs leading-relaxed" style={{ color: theme.colors.textDim }}>
								Walk through an interactive wizard that analyzes your project and creates a tailored
								playbook.
							</p>
						</div>
					</button>
				</div>

				{/* Informational note (moved from wizard) */}
				<div
					className="flex items-start gap-3 px-4 py-3 rounded-lg text-xs leading-relaxed"
					style={{
						backgroundColor: `${theme.colors.accent}08`,
						border: `1px solid ${theme.colors.border}`,
					}}
				>
					<Info className="w-4 h-4 flex-shrink-0 mt-0.5" style={{ color: theme.colors.accent }} />
					<span style={{ color: theme.colors.textDim }}>
						<strong style={{ color: theme.colors.textMain }}>Note:</strong> The guided wizard
						captures application inputs until complete. For a lighter touch, create an agent
						manually then run{' '}
						<code
							className="px-1 py-0.5 rounded text-[11px]"
							style={{ backgroundColor: theme.colors.border }}
						>
							/wizard
						</code>{' '}
						or click the{' '}
						<Wand2
							className="inline w-3.5 h-3.5 align-text-bottom"
							style={{ color: theme.colors.accent }}
						/>{' '}
						button in the Auto Run panel. The in-tab wizard runs alongside your other work.
					</span>
				</div>
			</div>
		</Modal>
	);
}
