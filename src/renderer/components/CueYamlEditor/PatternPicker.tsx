/**
 * PatternPicker — Grid of available Cue YAML patterns for quick start.
 */

import type { CuePattern } from '../../constants/cuePatterns';
import { CUE_PATTERNS } from '../../constants/cuePatterns';
import type { Theme } from '../../types';

interface PatternPickerProps {
	theme: Theme;
	disabled?: boolean;
	onSelect: (pattern: CuePattern) => void;
}

export function PatternPicker({ theme, disabled, onSelect }: PatternPickerProps) {
	return (
		<div className="grid grid-cols-2 gap-1.5 shrink-0" data-testid="pattern-presets">
			{CUE_PATTERNS.map((pattern) => (
				<button
					key={pattern.id}
					onClick={() => onSelect(pattern)}
					disabled={disabled}
					className="text-left px-2 py-1.5 rounded border text-xs transition-colors hover:opacity-90 disabled:opacity-50"
					style={{
						borderColor: theme.colors.border,
						color: theme.colors.textMain,
						backgroundColor: theme.colors.bgActivity,
					}}
					data-testid={`pattern-${pattern.id}`}
				>
					<div className="font-medium truncate">{pattern.name}</div>
					<div className="truncate mt-0.5" style={{ color: theme.colors.textDim, fontSize: 10 }}>
						{pattern.description}
					</div>
				</button>
			))}
		</div>
	);
}
