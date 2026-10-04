import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import { OverlayFrame } from '../app/OverlayFrame';
import { windowRows } from '../app/agentRows';
import { keysFor } from '../keymap';
import {
	cwdCandidates,
	fieldValueText,
	formFields,
	unsetEnvKeys,
	validateForm,
	type FieldSpec,
	type FormContext,
	type FormState,
} from './form';

export interface AgentFormProps {
	context: FormContext;
	state: FormState;
	/** A save is in flight: the button says so and a second Enter does nothing. */
	submitting: boolean;
	/** The host's lookups are still loading (providers, SSH remotes). */
	loading: boolean;
	width: number;
	height: number;
}

type FormRow =
	| { key: string; kind: 'divider'; text: string }
	| { key: string; kind: 'field'; spec: FieldSpec }
	| { key: string; kind: 'note'; text: string; color?: string }
	| { key: string; kind: 'submit' };

const LABEL_WIDTH = 16;
const ACCENT = '#9146FF';

/** Shown dim in an empty text field, so a blank box says what blank means. */
const PLACEHOLDERS: Partial<Record<FieldSpec['id'], string>> = {
	cwd: '/path/to/project',
	customPath: 'provider default',
	customArgs: 'none',
	autoRunFolder: '.maestro/playbooks under the directory',
	nudge: 'none',
	newSession: 'none',
	model: 'provider default',
	effort: 'provider default',
};

/** Lines the frame spends on its border (2) and title (1), plus the hint and status lines below the list (2). */
const CHROME_LINES = 5;

/** How many path completions to list under the Directory field. */
const MAX_CANDIDATES = 4;

function rowsFor(context: FormContext, state: FormState, candidates: readonly string[]): FormRow[] {
	const rows: FormRow[] = [];
	let advancedStarted = false;
	for (const spec of formFields(context, state)) {
		if (spec.advanced && !advancedStarted) {
			advancedStarted = true;
			rows.push({ key: 'divider:advanced', kind: 'divider', text: 'Advanced' });
		}
		rows.push({ key: spec.id, kind: 'field', spec });
		const focused = state.focus === spec.id;
		if (spec.note && (focused || spec.kind === 'readonly')) {
			rows.push({ key: `${spec.id}:note`, kind: 'note', text: spec.note, color: 'yellow' });
		}
		if (focused && spec.id === 'cwd') {
			candidates.slice(0, MAX_CANDIDATES).forEach((candidate, at) => {
				rows.push({
					key: `cwd:candidate:${at}`,
					kind: 'note',
					text: `${at === 0 ? keysFor('choiceNext') : ' '} ${candidate}`,
				});
			});
		}
		if (focused && spec.id === 'env') {
			rows.push({
				key: 'env:hint',
				kind: 'note',
				text: 'KEY=value, Enter adds a row, Backspace on an empty box removes the last. A blank value means unset.',
			});
			const unset = unsetEnvKeys(state);
			if (unset.length > 0) {
				rows.push({
					key: 'env:unset',
					kind: 'note',
					text: `Not sent (blank): ${unset.join(', ')}`,
				});
			}
		}
	}
	rows.push({ key: 'submit', kind: 'submit' });
	return rows;
}

/** The form for AG-2 (create), AG-3 (advanced), and AG-4 (edit). */
export function AgentForm({
	context,
	state,
	submitting,
	loading,
	width,
	height,
}: AgentFormProps): React.ReactElement {
	// Completion reads the disk, so it runs when the Directory text changes, not on every render.
	const cwd = state.values.cwd;
	const remote = state.values.ssh !== '';
	const candidates = useMemo(
		() => (state.focus === 'cwd' ? cwdCandidates(cwd, remote) : []),
		[state.focus, cwd, remote]
	);
	const rows = rowsFor(context, state, candidates);
	const { rows: visible } = windowRows(rows, state.focus, Math.max(1, height - CHROME_LINES));
	const problems = validateForm(context, state);
	const title =
		context.mode === 'create' ? 'New agent' : `Edit agent: ${context.agent?.name ?? ''}`;
	const verb = context.mode === 'create' ? 'Create agent' : 'Save changes';

	return (
		<OverlayFrame title={title} width={width} height={height}>
			{visible.map((row) => {
				switch (row.kind) {
					case 'divider':
						return (
							<Text key={row.key} dimColor>
								{'── '}
								{row.text}
								{' ──'}
							</Text>
						);
					case 'note':
						return (
							<Box key={row.key} paddingLeft={LABEL_WIDTH + 2}>
								<Text wrap="truncate-end" color={row.color} dimColor={!row.color}>
									{row.text}
								</Text>
							</Box>
						);
					case 'submit': {
						const focused = state.focus === 'submit';
						return (
							<Box key={row.key} marginTop={0}>
								<Text color={ACCENT}>{focused ? '›' : ' '}</Text>
								<Text bold={focused} inverse={focused}>
									{' '}
									{submitting ? 'Saving...' : verb}{' '}
								</Text>
								{problems.length > 0 ? (
									<Text dimColor>
										{'  '}
										{problems.length} to fix
									</Text>
								) : null}
							</Box>
						);
					}
					case 'field': {
						const { spec } = row;
						const focused = state.focus === spec.id;
						const shown = fieldValueText(context, state, spec);
						const problem = problems.find((candidate) => candidate.field === spec.id);
						const editing = focused && (spec.kind === 'text' || spec.kind === 'env');
						const placeholder = shown.placeholder || (!shown.text && !editing);
						const text = shown.text || (placeholder ? (PLACEHOLDERS[spec.id] ?? '') : '');
						return (
							<Box key={row.key}>
								<Text color={ACCENT}>{focused ? '›' : ' '}</Text>
								<Box width={LABEL_WIDTH}>
									<Text bold={focused} wrap="truncate-end">
										{spec.label}
									</Text>
								</Box>
								<Box flexShrink={1} flexGrow={1}>
									<Text
										wrap="truncate-start"
										color={problem ? 'red' : undefined}
										dimColor={placeholder}
									>
										{spec.kind === 'choice' && focused ? '‹ ' : ''}
										{text}
										{spec.kind === 'choice' && focused ? ' ›' : ''}
										{spec.kind === 'readonly' ? ' (read-only)' : ''}
									</Text>
									{spec.id === 'env' && focused ? <Text>{state.envDraft}</Text> : null}
									{editing ? <Text inverse> </Text> : null}
								</Box>
							</Box>
						);
					}
				}
			})}
			<Box flexGrow={1} />
			<Text wrap="truncate-end" color={state.error ? 'red' : undefined} dimColor={!state.error}>
				{state.error ?? firstProblem(problems, state) ?? (loading ? 'Loading providers...' : ' ')}
			</Text>
			<Text wrap="truncate-end" dimColor>
				Tab/↓ next ↑ back {keysFor('choicePrev')}/{keysFor('choiceNext')} choose{' '}
				{keysFor('submitForm')} save
			</Text>
		</OverlayFrame>
	);
}

/** The problem on the field the cursor is on, so the line under the form explains the highlighted row. */
function firstProblem(
	problems: ReadonlyArray<{ field: string; message: string }>,
	state: FormState
): string | undefined {
	return problems.find((problem) => problem.field === state.focus)?.message;
}
