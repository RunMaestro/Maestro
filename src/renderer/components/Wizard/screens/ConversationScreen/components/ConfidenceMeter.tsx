import type { Theme } from '../../../../../types';
import { getConfidenceColor, READY_CONFIDENCE_THRESHOLD } from '../../../services/wizardPrompts';

export function ConfidenceMeter({
	confidence,
	theme,
}: {
	confidence: number;
	theme: Theme;
}): JSX.Element {
	const clampedConfidence = Math.max(0, Math.min(100, confidence));
	const confidenceColor = getConfidenceColor(clampedConfidence);

	return (
		<div className="w-full">
			<div className="flex items-center justify-between mb-2">
				<span className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
					Project Understanding Confidence
				</span>
				<span className="text-sm font-bold" style={{ color: confidenceColor }}>
					{clampedConfidence}%
				</span>
			</div>
			<div
				className="w-full h-2 rounded-full overflow-hidden"
				style={{ backgroundColor: theme.colors.border }}
			>
				<div
					className="h-full rounded-full transition-all duration-500 ease-out"
					style={{
						width: `${clampedConfidence}%`,
						backgroundColor: confidenceColor,
						boxShadow: `0 0 8px ${confidenceColor}40`,
					}}
				/>
			</div>
			{clampedConfidence >= READY_CONFIDENCE_THRESHOLD && (
				<p className="text-xs mt-1 text-center" style={{ color: theme.colors.success }}>
					Ready to create your Playbook!
				</p>
			)}
		</div>
	);
}
