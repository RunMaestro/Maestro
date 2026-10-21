/**
 * CodeRunButton - the Run button pinned beside a shell fence's copy button.
 * Click runs the command in command mode (as if typed after `!`); Alt-click
 * loads it into the composer in command mode so it can be edited first.
 *
 * The full command line is in the tooltip and the accessible name: the fence
 * can scroll sideways, so the visible text alone may not show everything a
 * click would run.
 */

import { Play } from 'lucide-react';
import type { Theme } from '../../types';

interface CodeRunButtonProps {
	command: string;
	theme: Theme;
	onRun: (command: string, mode: 'run' | 'prefill') => void;
}

export function CodeRunButton({ command, theme, onRun }: CodeRunButtonProps) {
	return (
		<button
			type="button"
			onClick={(e) => {
				e.stopPropagation();
				onRun(command, e.altKey ? 'prefill' : 'run');
			}}
			// Sits just left of CodeCopyButton (right-2, ~28px wide).
			className="absolute top-2 right-10 flex items-center gap-1 px-1.5 py-1 rounded text-xs font-medium opacity-80 hover:opacity-100 transition-opacity z-10"
			style={{
				backgroundColor: theme.colors.bgActivity,
				color: theme.colors.accent,
				border: `1px solid ${theme.colors.border}`,
			}}
			title={`Run in command mode (Alt-click to edit first)\n\n${command}`}
			aria-label={`Run command: ${command}`}
			data-testid="code-run-button"
		>
			<Play className="w-3 h-3" />
			Run
		</button>
	);
}
