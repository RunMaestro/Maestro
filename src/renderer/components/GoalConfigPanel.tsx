import { useState } from 'react';
import { Target, Flag, Infinity as InfinityIcon, Maximize2 } from 'lucide-react';
import type { Theme } from '../types';
import { AgentPromptComposerModal } from './AgentPromptComposerModal';

interface GoalConfigPanelProps {
	theme: Theme;
	/** The free-text objective the agent pursues. */
	goal: string;
	/** Free-text guidance on what "done" looks like and when to declare a deadlock. */
	exitCriteria: string;
	/** Maximum iterations before forcing a stop. `null` = run indefinitely. */
	maxIterations: number | null;
	onGoalChange: (value: string) => void;
	onExitCriteriaChange: (value: string) => void;
	onMaxIterationsChange: (value: number | null) => void;
}

// Default iteration cap applied when the user turns OFF "Infinite". Picking a
// small bounded number keeps a first run from looping forever by accident.
const DEFAULT_MAX_ITERATIONS = 10;

/**
 * Body of the Goal-Driven tab in the Auto Run modal. Swaps the document picker
 * for the three inputs that feed the goal engine (see
 * src/shared/goalDriven/types.ts → GoalRunConfig): a free-text goal, free-text
 * exit criteria, and an iteration cap with an "Infinite" escape hatch that
 * mirrors the loop "∞ / max" affordance in DocumentsPanel.
 */
export function GoalConfigPanel({
	theme,
	goal,
	exitCriteria,
	maxIterations,
	onGoalChange,
	onExitCriteriaChange,
	onMaxIterationsChange,
}: GoalConfigPanelProps) {
	const isInfinite = maxIterations === null;

	// Which free-text field (if any) is open in the full-screen editor. Both the
	// goal and exit criteria reuse AgentPromptComposerModal for a large editor,
	// with template variables hidden since these are fed to the goal engine
	// verbatim rather than substituted.
	const [composerField, setComposerField] = useState<'goal' | 'exitCriteria' | null>(null);

	return (
		<div className="mb-6 flex flex-col gap-5 select-text">
			{/* Goal */}
			<div className="flex flex-col gap-2">
				<div className="flex items-center gap-2">
					<Target className="w-3.5 h-3.5" style={{ color: theme.colors.accent }} />
					<label className="text-xs font-bold uppercase" style={{ color: theme.colors.textDim }}>
						Goal
					</label>
				</div>
				<p className="text-xs" style={{ color: theme.colors.textDim }}>
					Describe what you want the agent to accomplish. The agent makes one increment of real
					progress per iteration and reports back, until it's done.
				</p>
				<div className="relative">
					<textarea
						value={goal}
						onChange={(e) => onGoalChange(e.target.value)}
						className="w-full p-3 pr-10 rounded border bg-transparent outline-none resize-none text-sm"
						style={{
							borderColor: theme.colors.border,
							color: theme.colors.textMain,
							minHeight: '96px',
						}}
						placeholder="e.g. Migrate the settings store from Redux to Zustand and keep all tests green."
					/>
					<button
						type="button"
						onClick={() => setComposerField('goal')}
						className="absolute top-2 right-2 p-1.5 rounded hover:bg-white/10 transition-colors"
						style={{ color: theme.colors.textDim }}
						title="Expand editor"
					>
						<Maximize2 className="w-4 h-4" />
					</button>
				</div>
			</div>

			{/* Exit Criteria */}
			<div className="flex flex-col gap-2">
				<div className="flex items-center gap-2">
					<Flag className="w-3.5 h-3.5" style={{ color: theme.colors.accent }} />
					<label className="text-xs font-bold uppercase" style={{ color: theme.colors.textDim }}>
						Exit Criteria
					</label>
				</div>
				<p className="text-xs" style={{ color: theme.colors.textDim }}>
					Spell out what "done" looks like and when the agent should declare a deadlock instead of
					spinning. This guides the agent - it isn't matched automatically.
				</p>
				<div className="relative">
					<textarea
						value={exitCriteria}
						onChange={(e) => onExitCriteriaChange(e.target.value)}
						className="w-full p-3 pr-10 rounded border bg-transparent outline-none resize-none text-sm"
						style={{
							borderColor: theme.colors.border,
							color: theme.colors.textMain,
							minHeight: '80px',
						}}
						placeholder="e.g. Done when no Redux imports remain and `npm test` passes. Deadlock if a test can't be made to pass after two tries."
					/>
					<button
						type="button"
						onClick={() => setComposerField('exitCriteria')}
						className="absolute top-2 right-2 p-1.5 rounded hover:bg-white/10 transition-colors"
						style={{ color: theme.colors.textDim }}
						title="Expand editor"
					>
						<Maximize2 className="w-4 h-4" />
					</button>
				</div>
			</div>

			{/* Iteration limit */}
			<div className="flex flex-col gap-2">
				<label className="text-xs font-bold uppercase" style={{ color: theme.colors.textDim }}>
					Iteration Limit
				</label>
				<p className="text-xs" style={{ color: theme.colors.textDim }}>
					Maximum agent iterations before the run stops. Choose Infinite to run until the goal is
					reached or a deadlock is detected.
				</p>
				<div className="flex items-center gap-2">
					{/* Infinite / numeric segmented toggle - mirrors the loop ∞/max control */}
					<div
						className="flex items-center rounded-lg border overflow-hidden"
						style={{ borderColor: theme.colors.border }}
					>
						<button
							type="button"
							onClick={() => onMaxIterationsChange(null)}
							className={`flex items-center gap-1 px-2.5 py-1 text-xs font-medium transition-colors ${
								isInfinite ? 'bg-white/10' : 'hover:bg-white/5'
							}`}
							style={{ color: isInfinite ? theme.colors.accent : theme.colors.textDim }}
							title="Run until the goal is reached or a deadlock is detected"
						>
							<InfinityIcon className="w-3.5 h-3.5" />
							Infinite
						</button>
						<button
							type="button"
							onClick={() => {
								if (isInfinite) {
									onMaxIterationsChange(DEFAULT_MAX_ITERATIONS);
								}
							}}
							className={`px-2.5 py-1 text-xs font-medium transition-colors border-l ${
								!isInfinite ? 'bg-white/10' : 'hover:bg-white/5'
							}`}
							style={{
								color: !isInfinite ? theme.colors.accent : theme.colors.textDim,
								borderColor: theme.colors.border,
							}}
							title="Cap the number of iterations"
						>
							Limit
						</button>
					</div>

					{/* Numeric input - only meaningful when a finite cap is selected */}
					{!isInfinite && (
						<input
							type="number"
							min={1}
							value={maxIterations ?? DEFAULT_MAX_ITERATIONS}
							onChange={(e) => {
								const parsed = parseInt(e.target.value, 10);
								onMaxIterationsChange(Number.isFinite(parsed) && parsed > 0 ? parsed : 1);
							}}
							className="w-20 px-2 py-1 rounded border bg-transparent outline-none text-sm font-mono"
							style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
							aria-label="Maximum iterations"
						/>
					)}
				</div>
			</div>

			{/* Full-screen editor for whichever free-text field was expanded. */}
			<AgentPromptComposerModal
				isOpen={composerField !== null}
				onClose={() => setComposerField(null)}
				theme={theme}
				initialValue={composerField === 'exitCriteria' ? exitCriteria : goal}
				onSubmit={(value) => {
					if (composerField === 'exitCriteria') {
						onExitCriteriaChange(value);
					} else {
						onGoalChange(value);
					}
				}}
				title={composerField === 'exitCriteria' ? 'Exit Criteria Editor' : 'Goal Editor'}
				placeholder={
					composerField === 'exitCriteria'
						? 'Describe what "done" looks like and when to declare a deadlock...'
						: 'Describe what you want the agent to accomplish...'
				}
				showTemplateVariables={false}
			/>
		</div>
	);
}
