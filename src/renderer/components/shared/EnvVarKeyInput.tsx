/**
 * EnvVarKeyInput - the NAME half of an environment-variable row.
 *
 * A plain text field here is a memory test with a silent failure mode: type
 * `CLAUDE_HOME` instead of `CLAUDE_CONFIG_DIR` and the variable is set, the
 * provider ignores it, and the agent runs as if nothing was configured. So the
 * field offers the provider's own vars plus every name the user has set before,
 * while still accepting anything typed by hand - the list is a shortcut, not a
 * whitelist.
 *
 * Sibling of `AuthPathValueInput`, which does the same job for the VALUE half.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent } from 'react';
import {
	suggestEnvVarKeys,
	EMPTY_KNOWN_ENV_VAR_KEYS,
	type KnownEnvVarKeys,
} from '../../../shared/envVarCatalog';
import type { Theme } from '../../types';

export interface EnvVarKeyInputProps {
	theme: Theme;
	value: string;
	onChange: (value: string) => void;
	onBlur?: () => void;
	/** Agent id whose catalog to offer. Omit for the global environment. */
	toolType?: string;
	/** Names already set, gathered by `useKnownEnvVarKeys`. */
	knownEnvVarKeys?: KnownEnvVarKeys;
	/** Names used by other rows in this editor, so none is offered twice. */
	usedKeys?: readonly string[];
	className: string;
	containerClassName?: string;
	style: CSSProperties;
	placeholder?: string;
	'data-testid'?: string;
}

export function EnvVarKeyInput({
	theme,
	value,
	onChange,
	onBlur,
	toolType,
	knownEnvVarKeys = EMPTY_KNOWN_ENV_VAR_KEYS,
	usedKeys,
	className,
	containerClassName = 'relative flex-1 min-w-0',
	style,
	placeholder = 'VARIABLE_NAME',
	'data-testid': testId = 'env-var-key-input',
}: EnvVarKeyInputProps) {
	const [open, setOpen] = useState(false);
	const [activeIndex, setActiveIndex] = useState(0);
	const containerRef = useRef<HTMLDivElement>(null);

	// The row's own name never excludes itself: a user re-opening the list on a
	// filled row is usually correcting that very name.
	const exclude = useMemo(() => (usedKeys ?? []).filter((key) => key !== value), [usedKeys, value]);

	const suggestions = useMemo(
		() => suggestEnvVarKeys({ toolType, known: knownEnvVarKeys, exclude, query: value }),
		[toolType, knownEnvVarKeys, exclude, value]
	);

	// An exact hit is the state where the list has nothing left to say.
	const exactMatch = suggestions.length === 1 && suggestions[0].key === value;
	const showList = open && suggestions.length > 0 && !exactMatch;

	useEffect(() => {
		setActiveIndex(0);
	}, [value]);

	// A click elsewhere in the modal closes the list without waiting for blur,
	// which never fires when the click lands on a non-focusable surface.
	useEffect(() => {
		if (!open) return;
		const handlePointerDown = (event: MouseEvent) => {
			if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
		};
		document.addEventListener('mousedown', handlePointerDown);
		return () => document.removeEventListener('mousedown', handlePointerDown);
	}, [open]);

	const commitSuggestion = (key: string) => {
		onChange(key);
		setOpen(false);
	};

	const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.key === 'Escape' && open) {
			// Swallowed on purpose: closing the list must not also close the modal
			// the row lives in.
			event.preventDefault();
			event.stopPropagation();
			setOpen(false);
			return;
		}
		if (!showList) {
			if (event.key === 'ArrowDown') setOpen(true);
			return;
		}
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			setActiveIndex((index) => (index + 1) % suggestions.length);
		} else if (event.key === 'ArrowUp') {
			event.preventDefault();
			setActiveIndex((index) => (index - 1 + suggestions.length) % suggestions.length);
		} else if (event.key === 'Enter') {
			event.preventDefault();
			commitSuggestion(suggestions[activeIndex].key);
		} else if (event.key === 'Tab') {
			setOpen(false);
		}
	};

	return (
		<div ref={containerRef} className={containerClassName}>
			<input
				type="text"
				role="combobox"
				aria-expanded={showList}
				aria-autocomplete="list"
				aria-controls={showList ? `${testId}-list` : undefined}
				value={value}
				onChange={(event) => {
					onChange(event.target.value);
					setOpen(true);
				}}
				onFocus={() => setOpen(true)}
				onBlur={() => {
					setOpen(false);
					onBlur?.();
				}}
				onKeyDown={handleKeyDown}
				onClick={(event) => event.stopPropagation()}
				placeholder={placeholder}
				className={`${className} w-full`}
				style={style}
				data-testid={testId}
			/>
			{showList && (
				<div
					id={`${testId}-list`}
					role="listbox"
					className="absolute left-0 right-0 top-full mt-1 z-50 rounded border shadow-lg overflow-y-auto"
					style={{
						backgroundColor: theme.colors.bgMain,
						borderColor: theme.colors.border,
						maxHeight: '13rem',
					}}
					data-testid={`${testId}-suggestions`}
				>
					{suggestions.map((suggestion, index) => (
						<button
							key={suggestion.key}
							type="button"
							role="option"
							aria-selected={index === activeIndex}
							// Keep focus in the field so the parent's blur-commit path
							// still owns when the typed name is written.
							onMouseDown={(event) => {
								event.preventDefault();
								event.stopPropagation();
								commitSuggestion(suggestion.key);
							}}
							onMouseEnter={() => setActiveIndex(index)}
							className="w-full text-left px-2 py-1.5 text-xs font-mono flex flex-col gap-0.5"
							style={{
								backgroundColor: index === activeIndex ? `${theme.colors.accent}22` : 'transparent',
								color: theme.colors.textMain,
							}}
						>
							<span>{suggestion.key}</span>
							<span className="text-2xs font-sans" style={{ color: theme.colors.textDim }}>
								{suggestion.description}
							</span>
						</button>
					))}
				</div>
			)}
		</div>
	);
}
