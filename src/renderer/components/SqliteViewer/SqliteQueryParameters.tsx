/**
 * SqliteQueryParameters - one value box per parameter of the statement in
 * Query mode's editor (`?`, `?3`, `:id`, `@id`, `$id`), so a value is typed
 * once and bound by the driver instead of being pasted into the SQL.
 *
 * The parameter list is read from the editor's text as it changes
 * (`sqliteQueryParameters()` in src/shared/sqlite/query.ts, the same scan the
 * run binds with), so a box appears as soon as a `?` is typed and goes when
 * it is deleted. Each box has a type: Text binds the text as typed (empty
 * included), Number binds it as an integer or a double and is refused when
 * it is not one, NULL binds NULL. Values are keyed by the parameter's label
 * and owned by the viewer, so a box that goes and comes back keeps its value.
 *
 * Enter in a box runs the statement, as Cmd+Enter does in the editor.
 */

import { useCallback } from 'react';

import type {
	SqliteParameterType,
	SqliteParameterValue,
	SqliteParameterValues,
	SqliteQueryParameter,
} from '../../../shared/sqlite/types';
import type { Theme } from '../../types';
import { SegmentedControl } from '../ui/SegmentedControl';
import { isImeComposing } from '../../utils/ime';

/** What a box holds before anyone types in it: empty text. */
export const EMPTY_SQLITE_PARAMETER_VALUE: SqliteParameterValue = { type: 'text', text: '' };

/** The value `label` binds as: the one given, or empty text. */
export function sqliteParameterValue(
	values: SqliteParameterValues,
	label: string
): SqliteParameterValue {
	return Object.prototype.hasOwnProperty.call(values, label)
		? values[label]
		: EMPTY_SQLITE_PARAMETER_VALUE;
}

/** The values for exactly these parameters, an untouched one as empty text. */
export function sqliteParameterValuesFor(
	parameters: readonly SqliteQueryParameter[],
	values: SqliteParameterValues
): SqliteParameterValues {
	const filled: SqliteParameterValues = {};
	for (const parameter of parameters) {
		filled[parameter.label] = sqliteParameterValue(values, parameter.label);
	}
	return filled;
}

const TYPE_OPTIONS = [
	{ value: 'text' as const, label: 'Text', title: 'Bind the text as typed' },
	{ value: 'number' as const, label: 'Number', title: 'Bind as an integer or a decimal number' },
	{ value: 'null' as const, label: 'NULL', title: 'Bind NULL' },
];

interface SqliteQueryParametersProps {
	parameters: readonly SqliteQueryParameter[];
	values: SqliteParameterValues;
	onChange: (label: string, value: SqliteParameterValue) => void;
	/** Why the parameters cannot bind as written (a `?` mixed with `?NNN`). */
	problem: string | null;
	onRun: () => void;
	theme: Theme;
}

export function SqliteQueryParameters({
	parameters,
	values,
	onChange,
	problem,
	onRun,
	theme,
}: SqliteQueryParametersProps) {
	const handleKeyDown = useCallback(
		(event: React.KeyboardEvent<HTMLInputElement>) => {
			if (event.key !== 'Enter' || event.shiftKey || isImeComposing(event)) return;
			event.preventDefault();
			onRun();
		},
		[onRun]
	);

	return (
		<div
			className="shrink-0 px-3 py-1.5 flex flex-col gap-1 max-h-[30%] overflow-y-auto text-xs"
			style={{ borderBottom: `1px solid ${theme.colors.border}`, color: theme.colors.textDim }}
			data-testid="sqlite-query-parameters"
		>
			<div className="flex items-center gap-2 select-none">
				<span className="font-medium" style={{ color: theme.colors.textMain }}>
					Parameters
				</span>
				<span>Bound as values, never pasted into the SQL. Enter runs.</span>
			</div>
			{problem && (
				<div style={{ color: theme.colors.warning }} data-testid="sqlite-query-parameters-problem">
					{problem}
				</div>
			)}
			{parameters.map((parameter) => {
				const value = sqliteParameterValue(values, parameter.label);
				const isNull = value.type === 'null';
				return (
					<div
						key={parameter.label}
						className="flex items-center gap-2 min-w-0"
						data-testid={`sqlite-query-parameter-${parameter.label}`}
					>
						<label
							htmlFor={`sqlite-query-parameter-input-${parameter.label}`}
							className="shrink-0 w-24 truncate font-mono select-none"
							style={{ color: theme.colors.accent }}
							title={
								parameter.anonymous
									? `Bare ? number ${parameter.label.slice(1)}, counted from the start of the statement`
									: parameter.label
							}
						>
							{parameter.label}
						</label>
						<input
							id={`sqlite-query-parameter-input-${parameter.label}`}
							type="text"
							value={isNull ? '' : value.text}
							disabled={isNull}
							onChange={(event) =>
								onChange(parameter.label, { ...value, text: event.target.value })
							}
							onKeyDown={handleKeyDown}
							placeholder={
								isNull ? 'NULL' : value.type === 'number' ? 'A number' : 'Text (empty binds "")'
							}
							spellCheck={false}
							autoComplete="off"
							className="flex-1 min-w-0 px-2 py-1 rounded outline-none"
							style={{
								backgroundColor: theme.colors.bgMain,
								border: `1px solid ${theme.colors.border}`,
								color: theme.colors.textMain,
								fontFamily: 'var(--maestro-font-mono, ui-monospace, SFMono-Regular, monospace)',
								opacity: isNull ? 0.6 : 1,
							}}
							data-testid={`sqlite-query-parameter-input-${parameter.label}`}
						/>
						<div className="shrink-0">
							<SegmentedControl<SqliteParameterType>
								value={value.type}
								onChange={(type) => onChange(parameter.label, { ...value, type })}
								options={TYPE_OPTIONS}
								theme={theme}
								ariaLabel={`How ${parameter.label} binds`}
								testId={`sqlite-query-parameter-type-${parameter.label}`}
							/>
						</div>
					</div>
				);
			})}
		</div>
	);
}
