/**
 * EnvVarSuggestInput
 *
 * The text field used for an environment variable's NAME or VALUE, with a
 * dropdown of suggestions when any exist. Replaces `AuthPathValueInput`, which
 * only handled the value side and only for two hard-coded variables.
 *
 * Shape of the control, and why:
 *
 *   - It is a text input first and a dropdown second. The set of useful
 *     environment variables is open-ended, so a control that only offered
 *     choices would block every variable nobody thought to list. A bare
 *     `<select>` also cannot be typed into, and the previous version worked
 *     around that with a separate "Custom..." option that revealed a second
 *     field below - two controls for one value.
 *   - Suggestions render as a popover under the field rather than a native
 *     `<datalist>`, which Chromium styles with the OS chrome and ignores the
 *     theme entirely.
 *   - Typing filters the list, but opening it via focus or the caret does not.
 *     Clicking the caret asks "what are my options?", and answering that with
 *     a list narrowed by whatever the field already holds shows nothing at all
 *     for a freshly added variable still named `VAR`.
 *
 * The caller decides WHICH suggestions apply. For a value field that means
 * passing only the values seen for the current variable name, which is what
 * keeps a `MAX_THINKING_TOKENS` number out of the `CLAUDE_CONFIG_DIR` list.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { ChevronDown } from 'lucide-react';
import type { Theme } from '../../types';
import { getHomeDir, getHomeDirAsync } from '../../utils/homeDir';

export interface EnvVarSuggestInputProps {
	value: string;
	/** Candidates for this field. An empty list renders a plain text input. */
	suggestions: string[];
	onChange: (value: string) => void;
	onBlur?: () => void;
	placeholder: string;
	/** Describes the field for screen readers, e.g. "Environment variable name". */
	ariaLabel: string;
	/**
	 * Abbreviate `$HOME` to `~` in the dropdown. Home-relative paths are how
	 * users think about account dirs, and the absolute form is wide enough to
	 * push the rest of the row off screen. Only the LABEL is abbreviated; the
	 * stored value stays absolute.
	 */
	abbreviateHome?: boolean;
	theme: Theme;
	className: string;
	containerClassName?: string;
	style: CSSProperties;
	testId?: string;
}

export function EnvVarSuggestInput({
	value,
	suggestions,
	onChange,
	onBlur,
	placeholder,
	ariaLabel,
	abbreviateHome = false,
	theme,
	className,
	containerClassName,
	style,
	testId,
}: EnvVarSuggestInputProps) {
	// Closed, or open showing everything, or open filtered by what was typed.
	// The distinction matters: clicking the caret is a request to SEE THE
	// OPTIONS, so it must not be filtered by whatever the field already holds -
	// a freshly added variable named `VAR` matches nothing, and filtering there
	// would answer "show me my choices" with an empty box.
	const [openMode, setOpenMode] = useState<'closed' | 'all' | 'filtered'>('closed');
	const isOpen = openMode !== 'closed';
	const [homeDir, setHomeDir] = useState(getHomeDir);
	const containerRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!abbreviateHome || homeDir) return;
		const pending = getHomeDirAsync();
		if (!pending) return;
		let cancelled = false;
		void pending.then((dir) => {
			if (!cancelled) setHomeDir(dir);
		});
		return () => {
			cancelled = true;
		};
	}, [abbreviateHome, homeDir]);

	// Close on any click outside. Registered only while open so the editor
	// isn't paying for a document listener per env var row at rest.
	useEffect(() => {
		if (!isOpen) return;
		const handlePointerDown = (event: MouseEvent) => {
			if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
				setOpenMode('closed');
			}
		};
		document.addEventListener('mousedown', handlePointerDown);
		return () => document.removeEventListener('mousedown', handlePointerDown);
	}, [isOpen]);

	// While typing, narrow to substring matches; a query that matches nothing
	// hides the popover rather than hovering an empty box over the field.
	const visible = useMemo(() => {
		if (openMode !== 'filtered' || !value) return suggestions;
		const needle = value.toLowerCase();
		return suggestions.filter((entry) => entry.toLowerCase().includes(needle));
	}, [openMode, suggestions, value]);

	// Nothing to offer: a plain input, so no caret invites a click on an empty
	// list. This is the normal case for a variable nobody else has set.
	if (suggestions.length === 0) {
		return (
			<input
				type="text"
				value={value}
				onChange={(event) => onChange(event.target.value)}
				onBlur={onBlur}
				onClick={(event) => event.stopPropagation()}
				placeholder={placeholder}
				aria-label={ariaLabel}
				className={className}
				style={style}
				data-testid={testId}
			/>
		);
	}

	const normalizedHome = abbreviateHome ? homeDir?.replace(/[\\/]+$/, '') : undefined;
	const labelFor = (entry: string): string => {
		if (!normalizedHome) return entry;
		const isUnderHome =
			entry === normalizedHome ||
			entry.startsWith(`${normalizedHome}/`) ||
			entry.startsWith(`${normalizedHome}\\`);
		return isUnderHome ? `~${entry.slice(normalizedHome.length)}` : entry;
	};

	return (
		<div ref={containerRef} className={`relative ${containerClassName ?? ''}`}>
			<input
				type="text"
				value={value}
				onChange={(event) => {
					onChange(event.target.value);
					setOpenMode('filtered');
				}}
				onFocus={() => setOpenMode('all')}
				onBlur={onBlur}
				onClick={(event) => event.stopPropagation()}
				onKeyDown={(event) => {
					if (event.key === 'Escape' && isOpen) {
						// Swallow it: the editor lives inside a modal, and letting
						// Escape bubble would close the whole modal out from under
						// someone who only meant to dismiss the suggestions.
						event.stopPropagation();
						setOpenMode('closed');
					}
				}}
				placeholder={placeholder}
				aria-label={ariaLabel}
				aria-expanded={isOpen}
				aria-autocomplete="list"
				role="combobox"
				className={`${className} pr-6`}
				style={style}
				data-testid={testId}
			/>
			<button
				type="button"
				onClick={(event) => {
					event.stopPropagation();
					setOpenMode((mode) => (mode === 'closed' ? 'all' : 'closed'));
				}}
				// Not a tab stop: the input it belongs to is already focusable and
				// opens the same list on focus, so a second stop per field would
				// double the tabbing cost of the editor for no new capability.
				tabIndex={-1}
				aria-hidden="true"
				className="absolute right-1 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-white/10 transition-colors"
				style={{ color: theme.colors.textDim }}
				title={`Show ${ariaLabel.toLowerCase()} suggestions`}
			>
				<ChevronDown className="w-3 h-3" />
			</button>
			{isOpen && visible.length > 0 && (
				<div
					role="listbox"
					aria-label={`${ariaLabel} suggestions`}
					className="absolute left-0 right-0 top-full mt-1 z-50 max-h-48 overflow-y-auto rounded border shadow-lg"
					style={{
						backgroundColor: theme.colors.bgMain,
						borderColor: theme.colors.border,
					}}
					data-testid={testId ? `${testId}-options` : undefined}
				>
					{visible.map((entry) => (
						<button
							key={entry}
							type="button"
							role="option"
							aria-selected={entry === value}
							// mousedown, not click: the input's blur fires first on a
							// click and can commit/close before the selection lands.
							onMouseDown={(event) => {
								event.preventDefault();
								event.stopPropagation();
								onChange(entry);
								setOpenMode('closed');
								onBlur?.();
							}}
							className="w-full text-left px-2 py-1.5 text-xs font-mono truncate hover:bg-white/10 transition-colors"
							style={{
								color: entry === value ? theme.colors.accent : theme.colors.textMain,
							}}
							title={entry}
						>
							{labelFor(entry)}
						</button>
					))}
				</div>
			)}
		</div>
	);
}
