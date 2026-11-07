/**
 * RemoveInUseWarning - the inline "this is assigned to tasks" confirmation the
 * Local Models tab shows before removing a model or an endpoint a task runs on.
 *
 * Inline rather than the global confirm modal, which would open behind
 * Settings. It names the tasks so the user removes knowingly: each one turns
 * unavailable until another source is assigned.
 */

import { AlertTriangle, Trash2, X } from 'lucide-react';
import type { Theme } from '../../../../types';

export interface RemoveInUseWarningProps {
	theme: Theme;
	/** What is being removed, as the user knows it. */
	subjectName: string;
	/** Labels of the tasks whose effective assignment uses it. */
	taskLabels: string[];
	/** How the user gets the tasks back ("download it again", "add it again"). */
	recovery: string;
	onConfirm: () => void;
	onKeep: () => void;
	testId?: string;
}

export function RemoveInUseWarning({
	theme,
	subjectName,
	taskLabels,
	recovery,
	onConfirm,
	onKeep,
	testId = 'local-model-remove-warning',
}: RemoveInUseWarningProps) {
	return (
		<div className="space-y-2" data-testid={testId}>
			<div className="flex items-start gap-1.5 text-xs" style={{ color: theme.colors.warning }}>
				<AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
				<span>
					{subjectName} is assigned to {taskLabels.join(', ')}. Removing it leaves{' '}
					{taskLabels.length === 1 ? 'that task' : 'those tasks'} unavailable until you {recovery}{' '}
					or assign another source.
				</span>
			</div>
			<div className="flex flex-wrap gap-2">
				<button
					type="button"
					onClick={onConfirm}
					className="px-2 py-1 rounded border text-xs flex items-center gap-1.5"
					style={{
						borderColor: theme.colors.warning,
						color: theme.colors.warning,
						backgroundColor: 'transparent',
					}}
				>
					<Trash2 className="w-3 h-3" />
					Remove anyway
				</button>
				<button
					type="button"
					onClick={onKeep}
					className="px-2 py-1 rounded border text-xs flex items-center gap-1.5"
					style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
				>
					<X className="w-3 h-3" />
					Keep it
				</button>
			</div>
		</div>
	);
}
