import { Repeat } from 'lucide-react';
import type { BatchDocumentEntry, Theme } from '../../../types';

interface LoopControlsProps {
	theme: Theme;
	documents: BatchDocumentEntry[];
	loopEnabled: boolean;
	setLoopEnabled: (enabled: boolean) => void;
	maxLoops: number | null;
	setMaxLoops: (maxLoops: number | null) => void;
	totalTaskCount: number;
	missingDocCount: number;
	hasMissingDocs: boolean;
	loadingTaskCounts: boolean;
}

export function LoopControls({
	theme,
	documents,
	loopEnabled,
	setLoopEnabled,
	maxLoops,
	setMaxLoops,
	totalTaskCount,
	missingDocCount,
	hasMissingDocs,
	loadingTaskCounts,
}: LoopControlsProps) {
	const showMaxLoopsSlider = maxLoops != null;

	return (
		<>
			{documents.length < 2 && (
				<p className="mt-1.5 text-xs text-center" style={{ color: theme.colors.textDim }}>
					You can enable loops with two or more documents
				</p>
			)}

			{documents.length > 1 && (
				<div className="mt-2 flex items-center justify-between">
					<div className="flex items-center gap-2">
						<button
							type="button"
							onClick={() => setLoopEnabled(!loopEnabled)}
							className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg border transition-colors ${
								loopEnabled ? 'border-accent' : 'border-border hover:bg-white/5'
							}`}
							style={{
								borderColor: loopEnabled ? theme.colors.accent : theme.colors.border,
								backgroundColor: loopEnabled ? theme.colors.accent + '15' : 'transparent',
							}}
							title="Loop back to first document when finished"
						>
							<Repeat
								className="w-3.5 h-3.5"
								style={{ color: loopEnabled ? theme.colors.accent : theme.colors.textDim }}
							/>
							<span
								className="text-xs font-medium"
								style={{ color: loopEnabled ? theme.colors.accent : theme.colors.textMain }}
							>
								Loop
							</span>
						</button>

						{loopEnabled && (
							<div
								className="flex items-center rounded-lg border overflow-hidden"
								style={{ borderColor: theme.colors.border }}
							>
								<button
									type="button"
									onClick={() => {
										setMaxLoops(null);
									}}
									className={`px-2.5 py-1 text-xs font-medium transition-colors ${
										!showMaxLoopsSlider ? 'bg-white/10' : 'hover:bg-white/5'
									}`}
									style={{
										color: !showMaxLoopsSlider ? theme.colors.accent : theme.colors.textDim,
									}}
									title="Loop forever until all tasks complete"
								>
									<span className="text-xl leading-none">∞</span>
								</button>
								<button
									type="button"
									onClick={() => {
										if (maxLoops === null) {
											setMaxLoops(5);
										}
									}}
									className={`px-2.5 py-1 text-xs font-medium transition-colors border-l ${
										showMaxLoopsSlider ? 'bg-white/10' : 'hover:bg-white/5'
									}`}
									style={{
										color: showMaxLoopsSlider ? theme.colors.accent : theme.colors.textDim,
										borderColor: theme.colors.border,
									}}
									title="Set maximum loop iterations"
								>
									max
								</button>
							</div>
						)}

						{loopEnabled && showMaxLoopsSlider && (
							<div className="flex items-center gap-2">
								<input
									type="range"
									min="1"
									max="25"
									value={maxLoops ?? 5}
									onChange={(e) => setMaxLoops(parseInt(e.target.value))}
									className="w-32 h-1 rounded-lg appearance-none cursor-pointer"
									style={{
										background: `linear-gradient(to right, ${theme.colors.accent} 0%, ${theme.colors.accent} ${((maxLoops ?? 5) / 25) * 100}%, ${theme.colors.border} ${((maxLoops ?? 5) / 25) * 100}%, ${theme.colors.border} 100%)`,
									}}
								/>
								<span
									className="text-xs font-mono w-6 text-center"
									style={{ color: theme.colors.accent }}
								>
									{maxLoops}
								</span>
							</div>
						)}
					</div>
					<span className="text-xs" style={{ color: theme.colors.textDim }}>
						Total: {loadingTaskCounts ? '...' : totalTaskCount} tasks across{' '}
						{documents.length - missingDocCount} {hasMissingDocs ? 'available ' : ''}document
						{documents.length - missingDocCount !== 1 ? 's' : ''}
						{hasMissingDocs && ` (${missingDocCount} missing)`}
					</span>
				</div>
			)}
		</>
	);
}
