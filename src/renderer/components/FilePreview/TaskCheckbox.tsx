import { useCallback, useEffect, useState } from 'react';
import type { Theme } from '../../types';

interface TaskCheckboxProps {
	/** 1-based source line of the `- [ ]` marker this box renders. */
	line: number;
	/** State parsed from the document currently on screen. */
	checked: boolean;
	theme: Theme;
	/**
	 * Persist the flip. Derives the new state from the source line itself, so
	 * it takes no desired value. Resolves false when the write did not happen
	 * (stale line, unsaved edits, disk error), which reverts the local flip.
	 */
	onToggle: (line: number) => Promise<boolean>;
}

/**
 * An interactive GFM task checkbox in the rendered markdown preview.
 *
 * The box owns a short-lived optimistic state because the source of truth is a
 * file on disk: a click writes the document and the new `checked` prop only
 * arrives once the tab re-reads it. Without the local flip, React's controlled
 * input would snap back to the old value for the length of that round trip -
 * a visible bounce on a local file, a long one over SSH.
 *
 * `optimistic` clears whenever `checked` changes, so the moment the saved
 * document flows back in, the box is driven by the file again.
 */
export function TaskCheckbox({ line, checked, theme, onToggle }: TaskCheckboxProps) {
	const [optimistic, setOptimistic] = useState<boolean | null>(null);

	useEffect(() => {
		setOptimistic(null);
	}, [checked]);

	const value = optimistic ?? checked;

	const handleChange = useCallback(async () => {
		setOptimistic(!value);
		const saved = await onToggle(line);
		if (!saved) setOptimistic(null);
	}, [value, line, onToggle]);

	return (
		<input
			type="checkbox"
			checked={value}
			onChange={handleChange}
			// The box sits inside markdown that routes clicks to file links and
			// anchors; a task toggle is not navigation.
			onClick={(e) => e.stopPropagation()}
			aria-label={value ? 'Mark task as not done' : 'Mark task as done'}
			title="Toggle this task and save the file"
			style={{ cursor: 'pointer', accentColor: theme.colors.accent }}
		/>
	);
}

export default TaskCheckbox;
