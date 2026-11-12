/**
 * LaunchInputField - one typed question of a playbook's launch form.
 *
 * A playbook's `launch.inputs` are declared data, not code, so this one component
 * draws a field for every `PlaybookLaunchInput.type`:
 *
 * | type                | control                                                       |
 * | ------------------- | ------------------------------------------------------------- |
 * | `text`, `url`       | `FormInput`                                                   |
 * | `textarea`          | a native textarea that grows with its content                 |
 * | `number`            | `FormInput type="number"` with the input's `min` / `max`      |
 * | `boolean`           | `ToggleSwitch`                                                |
 * | `select`            | `SegmentedControl` (4 options or fewer), else `ThemedSelect`  |
 * | `multiselect`       | a row of `ToggleChip`s                                        |
 * | `path`              | `FormInput` plus a Browse button (folder or file dialog)      |
 *
 * Every field shows its label, a red asterisk when required, the author's `help`,
 * and the validation message for it. The message comes from the host
 * (`validateLaunchValues` in `shared/playbookLaunch.ts`), because that is the one
 * place that decides what a valid answer is; this component only draws it.
 *
 * It is controlled and presentational: no store, no IPC except the Browse dialog,
 * no validation. `value` is the answer the user has given, `undefined` for none,
 * and the host seeds each field with its default, so a cleared field really is
 * empty (it falls back to the default only when the values are resolved).
 * `onChange(name, value)` reports the new answer in the shape
 * `PlaybookLaunchValues` holds: a string, a number, a boolean or a list of
 * strings, or `undefined` once a text or number field is emptied.
 */

import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { FolderOpen } from 'lucide-react';
import { getFileExtension } from '../../../../shared/fileCategories';
import type {
	PlaybookLaunchInput,
	PlaybookLaunchValues,
} from '../../../../shared/marketplace-types';
import { useAutosizeTextarea } from '../../../hooks/ui/useAutosizeTextarea';
import type { Theme } from '../../../types';
import { ThemedSelect } from '../../shared/ThemedSelect';
import { FormInput } from '../../ui/FormInput';
import { GhostIconButton } from '../../ui/GhostIconButton';
import { SegmentedControl } from '../../ui/SegmentedControl';
import { ToggleChip } from '../../ui/ToggleChip';
import { ToggleSwitch } from '../../ui/ToggleSwitch';

/** One answer, in the shape `PlaybookLaunchValues` holds. */
export type LaunchFieldValue = PlaybookLaunchValues[string];

/** The dialog a `path` input's Browse button opens. */
export type PathBrowseKind = 'file' | 'folder';

/** A select with this many options or fewer is a segmented bar, not a dropdown. */
const SEGMENTED_MAX_OPTIONS = 4;

/** Height at which a textarea stops growing and scrolls (about ten lines). */
const TEXTAREA_MAX_HEIGHT = 240;

/** The `ThemedSelect` row that stands for "no answer". */
const UNSET_OPTION = '';

const LABEL_CLASS = 'block text-xs font-bold opacity-70 uppercase';

export interface LaunchInputFieldProps {
	theme: Theme;
	input: PlaybookLaunchInput;
	/** The answer so far. `undefined` draws an empty field. */
	value: LaunchFieldValue | undefined;
	/** Called with the input's name and the new answer. Keep it stable so a keystroke redraws one field. */
	onChange: (name: string, value: LaunchFieldValue | undefined) => void;
	/** The validation message for this input, if any. */
	error?: string;
	/** Blocks every control, for example while the launch is starting. */
	disabled?: boolean;
	/**
	 * Disables a `path` input's Browse button and shows this as its tooltip. The dialogs pick a
	 * path on THIS computer, so the host sets it when the launch target is an SSH remote.
	 */
	browseDisabledReason?: string;
}

/** The test id of a field's root element. */
export function launchInputTestId(name: string): string {
	return `launch-input-${name}`;
}

/**
 * Which dialog a `path` input's Browse button opens.
 *
 * The schema does not say whether a path names a file or a folder, so this reads the hint the
 * author left in the default (else the placeholder): a last segment with an extension
 * (`README.md`) names a file; anything else (`~/Journal`, `{{AUTORUN_FOLDER}}/vault`, no hint at
 * all) names a folder, which is the common case.
 */
export function pathBrowseKind(
	input: Pick<PlaybookLaunchInput, 'default' | 'placeholder'>
): PathBrowseKind {
	const hint =
		typeof input.default === 'string' && input.default.trim() !== ''
			? input.default
			: input.placeholder;
	return hint !== undefined && getFileExtension(hint.trim()) !== '' ? 'file' : 'folder';
}

/** The answer as text, whatever shape the host handed over. */
function textOf(value: LaunchFieldValue | undefined): string {
	if (value === undefined) return '';
	return Array.isArray(value) ? value.join(',') : String(value);
}

function optionLabel(option: { value: string; label?: string }): string {
	return option.label ?? option.value;
}

/** The number a box of text holds. An empty box, or text that is not a finite number, holds none. */
function parseNumberText(text: string): number | undefined {
	if (text.trim() === '') return undefined;
	const parsed = Number(text);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function numberText(answer: number | undefined): string {
	return answer === undefined ? '' : String(answer);
}

// ============================================================================
// Shared field chrome (label, required marker, help, error)
// ============================================================================

/** What every per-type field needs; `emit` is `onChange` bound to the input's name. */
interface FieldProps {
	theme: Theme;
	input: PlaybookLaunchInput;
	value: LaunchFieldValue | undefined;
	error: string | undefined;
	disabled: boolean;
	emit: (value: LaunchFieldValue | undefined) => void;
}

function RequiredMark({ theme }: { theme: Theme }) {
	return (
		<span aria-hidden="true" className="ml-1" style={{ color: theme.colors.error }}>
			*
		</span>
	);
}

/** The caption under a control. As in `FormInput`, a validation message replaces the help. */
function FieldCaption({ theme, help, error }: { theme: Theme; help?: string; error?: string }) {
	if (error) {
		return (
			<p className="mt-1 text-xs" style={{ color: theme.colors.error }}>
				{error}
			</p>
		);
	}
	if (help) {
		return (
			<p className="mt-2 text-xs" style={{ color: theme.colors.textDim }}>
				{help}
			</p>
		);
	}
	return null;
}

/**
 * Label, control and caption, stacked. `labelFor` names the control a real `<label>` can point
 * at (a textarea, the select's button); a control that is a group of buttons gets a plain
 * element the group refers to by `labelId` instead.
 */
function FieldFrame({
	theme,
	input,
	error,
	labelId,
	labelFor,
	children,
}: {
	theme: Theme;
	input: PlaybookLaunchInput;
	error: string | undefined;
	labelId: string;
	labelFor?: string;
	children: ReactNode;
}) {
	const caption = (
		<>
			{input.label}
			{input.required && <RequiredMark theme={theme} />}
		</>
	);
	const labelProps = {
		id: labelId,
		className: `${LABEL_CLASS} mb-2`,
		style: { color: theme.colors.textMain },
	};
	return (
		<div className="w-full" data-testid={launchInputTestId(input.name)}>
			{labelFor ? (
				<label htmlFor={labelFor} {...labelProps}>
					{caption}
				</label>
			) : (
				<div {...labelProps}>{caption}</div>
			)}
			{children}
			<FieldCaption theme={theme} help={input.help} error={error} />
		</div>
	);
}

// ============================================================================
// One field per input type
// ============================================================================

function TextField({ theme, input, value, error, disabled, emit }: FieldProps) {
	const isUrl = input.type === 'url';
	return (
		<FormInput
			theme={theme}
			type={isUrl ? 'url' : 'text'}
			label={input.label}
			required={input.required}
			value={textOf(value)}
			onChange={emit}
			placeholder={input.placeholder}
			helperText={input.help}
			error={error}
			disabled={disabled}
			monospace={isUrl}
			testId={launchInputTestId(input.name)}
		/>
	);
}

function TextareaField({ theme, input, value, error, disabled, emit }: FieldProps) {
	const labelId = useId();
	const textareaId = useId();
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const text = textOf(value);
	useAutosizeTextarea({ textareaRef, value: text, maxHeight: TEXTAREA_MAX_HEIGHT });

	return (
		<FieldFrame theme={theme} input={input} error={error} labelId={labelId} labelFor={textareaId}>
			<textarea
				ref={textareaRef}
				id={textareaId}
				value={text}
				onChange={(e) => emit(e.target.value)}
				placeholder={input.placeholder}
				disabled={disabled}
				rows={3}
				aria-required={input.required || undefined}
				aria-invalid={error ? true : undefined}
				className={`w-full p-3 rounded border bg-transparent outline-none resize-none ${
					disabled ? 'opacity-50 cursor-not-allowed' : ''
				}`}
				style={{
					borderColor: error ? theme.colors.error : theme.colors.border,
					color: theme.colors.textMain,
				}}
			/>
		</FieldFrame>
	);
}

function NumberField({ theme, input, value, error, disabled, emit }: FieldProps) {
	const answer = typeof value === 'number' ? value : undefined;
	// The box holds text and the answer is a number, so the two are not the same string: "2.50" is
	// 2.5. Feeding the number back into the box would rewrite "2.50" to "2.5" mid-keystroke and make
	// "2.505" impossible to type. So the box keeps what was typed for as long as it still reads as
	// the answer, and takes the answer's own text only when the host changes it (a reset).
	const [draft, setDraft] = useState(() => numberText(answer));
	useEffect(() => {
		setDraft((typed) => (parseNumberText(typed) === answer ? typed : numberText(answer)));
	}, [answer]);

	return (
		<FormInput
			theme={theme}
			type="number"
			label={input.label}
			required={input.required}
			value={draft}
			onChange={(typed) => {
				setDraft(typed);
				emit(parseNumberText(typed));
			}}
			min={input.min}
			max={input.max}
			// The validator accepts any finite number, so the browser must not flag a decimal.
			step="any"
			placeholder={input.placeholder}
			helperText={input.help}
			error={error}
			disabled={disabled}
			addon={
				input.unit ? (
					<span className="self-center text-sm" style={{ color: theme.colors.textDim }}>
						{input.unit}
					</span>
				) : undefined
			}
			testId={launchInputTestId(input.name)}
		/>
	);
}

function PathField({
	theme,
	input,
	value,
	error,
	disabled,
	emit,
	browseDisabledReason,
}: FieldProps & { browseDisabledReason?: string }) {
	const kind = pathBrowseKind(input);
	const blocked = disabled || browseDisabledReason !== undefined;

	const browse = useCallback(async () => {
		const picked =
			kind === 'folder'
				? await window.maestro.dialog.selectFolder()
				: await window.maestro.dialog.selectFile({ title: input.label });
		// A cancelled dialog answers null: keep what is there.
		if (picked) emit(picked);
	}, [kind, input.label, emit]);

	const browseTitle = browseDisabledReason ?? `Browse for a ${kind}`;

	return (
		<FormInput
			theme={theme}
			label={input.label}
			required={input.required}
			value={textOf(value)}
			onChange={emit}
			placeholder={input.placeholder}
			helperText={input.help}
			error={error}
			disabled={disabled}
			monospace
			addon={
				<GhostIconButton
					onClick={browse}
					disabled={blocked}
					title={browseTitle}
					ariaLabel={`Browse for a ${kind}`}
					color={theme.colors.textDim}
					padding="px-3"
					className="shrink-0 gap-1.5 text-xs"
					style={{ border: `1px solid ${theme.colors.border}` }}
					testId={`${launchInputTestId(input.name)}-browse`}
				>
					<FolderOpen className="w-4 h-4" />
					Browse
				</GhostIconButton>
			}
			testId={launchInputTestId(input.name)}
		/>
	);
}

function BooleanField({ theme, input, value, error, disabled, emit }: FieldProps) {
	const labelId = useId();
	return (
		<div className="w-full" data-testid={launchInputTestId(input.name)}>
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0">
					<div id={labelId} className={LABEL_CLASS} style={{ color: theme.colors.textMain }}>
						{input.label}
						{input.required && <RequiredMark theme={theme} />}
					</div>
					{input.help && (
						<p className="mt-1 text-xs" style={{ color: theme.colors.textDim }}>
							{input.help}
						</p>
					)}
				</div>
				<ToggleSwitch
					theme={theme}
					checked={value === true}
					onChange={emit}
					ariaLabel={input.label}
					disabled={disabled}
				/>
			</div>
			<FieldCaption theme={theme} error={error} />
		</div>
	);
}

function SelectField({ theme, input, value, error, disabled, emit }: FieldProps) {
	const labelId = useId();
	const selectId = useId();
	const declared = input.options;
	const selected = typeof value === 'string' ? value : UNSET_OPTION;
	const options = useMemo(
		() => (declared ?? []).map((option) => ({ value: option.value, label: optionLabel(option) })),
		[declared]
	);
	// A dropdown names "no answer" so an unanswered or optional field has a row to show and to go
	// back to. A required field that already has an answer does not offer one.
	const offersUnset = selected === UNSET_OPTION || !input.required;
	const unsetLabel = input.placeholder ?? (input.required ? 'Select...' : 'Not set');
	// ThemedSelect resets its highlight whenever `options` changes identity, so keep it stable.
	const dropdownOptions = useMemo(
		() => (offersUnset ? [{ value: UNSET_OPTION, label: unsetLabel }, ...options] : options),
		[offersUnset, unsetLabel, options]
	);

	if (options.length <= SEGMENTED_MAX_OPTIONS) {
		return (
			<FieldFrame theme={theme} input={input} error={error} labelId={labelId}>
				<SegmentedControl
					theme={theme}
					value={selected}
					options={options}
					onChange={emit}
					ariaLabel={input.label}
					testId={`${launchInputTestId(input.name)}-options`}
				/>
			</FieldFrame>
		);
	}

	return (
		<FieldFrame theme={theme} input={input} error={error} labelId={labelId} labelFor={selectId}>
			<ThemedSelect
				theme={theme}
				id={selectId}
				value={selected}
				options={dropdownOptions}
				onChange={(next) => emit(next === UNSET_OPTION ? undefined : next)}
				disabled={disabled}
			/>
		</FieldFrame>
	);
}

function MultiselectField({ theme, input, value, error, disabled, emit }: FieldProps) {
	const labelId = useId();
	const options = input.options ?? [];
	const picked = Array.isArray(value) ? value : [];

	// The answer keeps the order the options were declared in, not the order of the clicks, so the
	// same picks always write the same line.
	const toggle = (optionValue: string, on: boolean) => {
		const next = new Set(picked);
		if (on) next.add(optionValue);
		else next.delete(optionValue);
		emit(options.filter((option) => next.has(option.value)).map((option) => option.value));
	};

	return (
		<FieldFrame theme={theme} input={input} error={error} labelId={labelId}>
			<div
				role="group"
				aria-labelledby={labelId}
				className="flex flex-wrap gap-1.5"
				data-testid={`${launchInputTestId(input.name)}-options`}
			>
				{options.map((option) => (
					<ToggleChip
						key={option.value}
						theme={theme}
						label={optionLabel(option)}
						selected={picked.includes(option.value)}
						onToggle={(on) => toggle(option.value, on)}
						disabled={disabled}
					/>
				))}
			</div>
		</FieldFrame>
	);
}

// ============================================================================
// The field
// ============================================================================

export const LaunchInputField = memo(function LaunchInputField({
	theme,
	input,
	value,
	onChange,
	error,
	disabled = false,
	browseDisabledReason,
}: LaunchInputFieldProps) {
	const name = input.name;
	const emit = useCallback(
		(next: LaunchFieldValue | undefined) => onChange(name, next),
		[onChange, name]
	);
	const field: FieldProps = { theme, input, value, error, disabled, emit };

	switch (input.type) {
		case 'text':
		case 'url':
			return <TextField {...field} />;
		case 'textarea':
			return <TextareaField {...field} />;
		case 'number':
			return <NumberField {...field} />;
		case 'path':
			return <PathField {...field} browseDisabledReason={browseDisabledReason} />;
		case 'boolean':
			return <BooleanField {...field} />;
		case 'select':
			return <SelectField {...field} />;
		case 'multiselect':
			return <MultiselectField {...field} />;
		default:
			return null;
	}
});
