/**
 * EnvVarsDotEnvInput - the Advanced mode of an env-var editor: one textarea of
 * `KEY=value` lines over the same records the row editor edits.
 *
 * Both env-var editors (`Settings/EnvVarsEditor` and the per-agent rows in
 * `AgentConfigPanel`) render this for their Advanced mode, with
 * `<EnvVarsModeToggle>` to switch. What a line means is decided by
 * `parseDotEnv()` in `src/shared/dotEnv.ts`, not here.
 *
 * The textarea owns its text while the user types, so comments, blank lines
 * and a half-typed line stay put. Only the lines that parse are committed, on
 * every edit, and a line that does not is listed underneath with its number.
 * Merely opening this mode commits nothing.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Theme } from '../../types';
import { envVarRecordsFingerprint, parseDotEnv, serializeDotEnv } from '../../../shared/dotEnv';
import { SegmentedControl } from '../ui/SegmentedControl';
import { TextareaLineNumbers, lineNumberGutterMetrics } from '../ui/TextareaLineNumbers';

/**
 * localStorage key for the Basic / Advanced choice. One key for every editor:
 * someone who would rather paste a `.env` wants that wherever variables are
 * edited, not re-chosen per modal.
 */
export const ENV_VARS_ADVANCED_MODE_STORAGE_KEY = 'envVarsEditor.advancedMode';

type EnvVarsEditorMode = 'basic' | 'advanced';

const MODE_OPTIONS = [
	{ value: 'basic', label: 'Basic', title: 'One row per variable' },
	{ value: 'advanced', label: 'Advanced', title: 'Paste or type .env text' },
] as const;

const MIN_ROWS = 4;
const MAX_ROWS = 16;

export interface EnvVarsModeToggleProps {
	advanced: boolean;
	onChange: (advanced: boolean) => void;
	theme: Theme;
}

export function EnvVarsModeToggle({ advanced, onChange, theme }: EnvVarsModeToggleProps) {
	return (
		<SegmentedControl<EnvVarsEditorMode>
			value={advanced ? 'advanced' : 'basic'}
			onChange={(mode) => onChange(mode === 'advanced')}
			options={MODE_OPTIONS}
			theme={theme}
			ariaLabel="Environment variable editor mode"
			testId="env-vars-mode"
		/>
	);
}

export interface EnvVarsDotEnvInputProps {
	theme: Theme;
	envVars: Record<string, string>;
	/**
	 * Parked variables. Pass the record (even an empty one) and `# KEY=value`
	 * round-trips as a switched-off variable; omit it for an editor that cannot
	 * park, where a commented line is only a comment.
	 */
	disabledEnvVars?: Record<string, string>;
	/** Both records, replaced whole. `disabledVars` is `{}` when parking is off. */
	onChange: (vars: Record<string, string>, disabledVars: Record<string, string>) => void;
	onBlur?: () => void;
	/** Whatever the host's row mode enforces on a value, so the two modes agree. */
	validateValue?: (key: string, value: string) => string | null;
}

export function EnvVarsDotEnvInput({
	theme,
	envVars,
	disabledEnvVars,
	onChange,
	onBlur,
	validateValue,
}: EnvVarsDotEnvInputProps) {
	const canPark = disabledEnvVars !== undefined;
	const [text, setText] = useState(() => serializeDotEnv(envVars, disabledEnvVars));
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	const parsed = useMemo(
		() => parseDotEnv(text, { parked: canPark, validateValue }),
		[text, canPark, validateValue]
	);
	const parsedFingerprint = envVarRecordsFingerprint(parsed.vars, parsed.disabledVars);
	const parsedFingerprintRef = useRef(parsedFingerprint);
	parsedFingerprintRef.current = parsedFingerprint;

	// Rebuild the text only when the records changed somewhere ELSE (the modal
	// reopened on another agent, a row was edited before switching modes). Our
	// own edit echoing back matches what the text already parses to, and
	// rebuilding then would wipe the user's comments and move the caret.
	useEffect(() => {
		if (envVarRecordsFingerprint(envVars, disabledEnvVars) !== parsedFingerprintRef.current) {
			setText(serializeDotEnv(envVars, disabledEnvVars));
		}
	}, [envVars, disabledEnvVars]);

	const handleChange = (nextText: string) => {
		setText(nextText);
		const next = parseDotEnv(nextText, { parked: canPark, validateValue });
		onChange(next.vars, next.disabledVars);
	};

	const lineCount = text.split('\n').length;
	const rows = Math.min(Math.max(lineCount + 1, MIN_ROWS), MAX_ROWS);

	return (
		<div data-testid="env-vars-dotenv">
			<div className="relative">
				<textarea
					ref={textareaRef}
					value={text}
					onChange={(e) => handleChange(e.target.value)}
					// Drop the FocusEvent: hosts' blur handlers take optional arguments, and
					// a forwarded event was once saved as a setting value (MAESTRO-11C).
					onBlur={() => onBlur?.()}
					rows={rows}
					spellCheck={false}
					autoCapitalize="off"
					autoCorrect="off"
					placeholder={'KEY=value\nexport OTHER_KEY=value'}
					aria-label="Environment variables in .env format"
					className="block w-full py-2 pr-2 rounded border bg-transparent outline-none text-xs font-mono leading-5 resize-none"
					style={{
						borderColor: parsed.errors.length > 0 ? theme.colors.error : theme.colors.border,
						color: theme.colors.textMain,
						paddingLeft: lineNumberGutterMetrics(text).textPaddingLeft,
					}}
					data-testid="env-vars-dotenv-textarea"
				/>
				{/* After the textarea on purpose. The gutter measures the textarea in a
				    layout effect, and React attaches a later sibling's ref after an
				    earlier sibling's layout effects have run - so rendered first, it
				    finds no textarea on mount and draws unmeasured, at the wrong size
				    and offset, until the first keystroke. It is absolutely positioned,
				    so the order changes nothing on screen. */}
				<TextareaLineNumbers
					textareaRef={textareaRef}
					value={text}
					theme={theme}
					testId="env-vars-dotenv-line-numbers"
				/>
			</div>
			{parsed.errors.length > 0 && (
				<ul className="text-xs mt-1 px-2 space-y-0.5" data-testid="env-vars-dotenv-errors">
					{parsed.errors.map((issue) => (
						<li key={`${issue.line}-${issue.message}`} style={{ color: theme.colors.error }}>
							Line {issue.line} not saved: {issue.message}
						</li>
					))}
				</ul>
			)}
			{parsed.warnings.length > 0 && (
				<ul className="text-xs mt-1 px-2 space-y-0.5" data-testid="env-vars-dotenv-warnings">
					{parsed.warnings.map((issue) => (
						<li key={`${issue.line}-${issue.message}`} style={{ color: theme.colors.warning }}>
							Line {issue.line}: {issue.message}
						</li>
					))}
				</ul>
			)}
			<p className="text-xs opacity-50 mt-2">
				One <span className="font-mono">KEY=value</span> per line; a leading{' '}
				<span className="font-mono">export</span> is fine and quotes are kept as typed.{' '}
				{canPark && (
					<>
						<span className="font-mono"># KEY=value</span> keeps a variable switched off.{' '}
					</>
				)}
				{canPark ? 'Other comments' : 'Comments'} and blank lines are not saved.
			</p>
		</div>
	);
}
