import React from 'react';
import { Box, Text } from 'ink';
import type { AgentRecord } from '../../shared/maestro-lib';
import { OverlayFrame } from '../app/OverlayFrame';
import { keysFor } from '../keymap';
import {
	launchFields,
	type LaunchField,
	type LaunchFormState,
	type LaunchLookups,
} from './launchForm';

const ACCENT = '#9146FF';
const LABEL_WIDTH = 15;
/** Most documents listed before the rest are counted. */
const MAX_DOCUMENT_ROWS = 6;

export interface LaunchViewProps {
	agent: AgentRecord;
	form: LaunchFormState;
	lookups: LaunchLookups;
	submitting: boolean;
	/** Why the last start did not go through: the form's own check, or the host's refusal. */
	error?: string;
	width: number;
	height: number;
}

function valueText(
	field: LaunchField,
	form: LaunchFormState
): { text: string; placeholder: boolean } {
	const { values } = form;
	switch (field.kind) {
		case 'toggle': {
			const on = field.id === 'loop' ? values.loop : values.reset;
			return { text: on ? 'on' : 'off', placeholder: !on };
		}
		case 'choice': {
			const current = field.id === 'model' ? values.model : values.effort;
			return current === ''
				? { text: '‹ agent default ›', placeholder: true }
				: { text: `‹ ${current} ›`, placeholder: false };
		}
		default: {
			const text = values[field.id as keyof typeof values];
			return typeof text === 'string' && text !== ''
				? { text, placeholder: false }
				: { text: field.hint ?? '', placeholder: true };
		}
	}
}

/** Configures one run: the documents it will take, in order, and the few choices that shape it. */
export function LaunchView({
	agent,
	form,
	lookups,
	submitting,
	error,
	width,
	height,
}: LaunchViewProps): React.ReactElement {
	const fields = launchFields(form, agent, lookups);
	const shown = form.documents.slice(0, MAX_DOCUMENT_ROWS);
	const hidden = form.documents.length - shown.length;
	const title = form.mode === 'goal' ? `Goal-driven run: ${agent.name}` : `Auto Run: ${agent.name}`;
	return (
		<OverlayFrame title={title} width={width} height={height}>
			{form.mode === 'spec' ? (
				<>
					<Text bold wrap="truncate-end">
						Runs {form.documents.length} {form.documents.length === 1 ? 'document' : 'documents'},
						in this order
					</Text>
					{shown.map((document, index) => (
						<Text key={document.file} wrap="truncate-end">
							<Text dimColor>{index + 1}. </Text>
							{document.name}
						</Text>
					))}
					{hidden > 0 ? <Text dimColor>and {hidden} more</Text> : null}
					<Text> </Text>
				</>
			) : null}
			{fields.map((field) => {
				const focused = form.focus === field.id;
				const value = valueText(field, form);
				return (
					<Box key={field.id}>
						<Text color={ACCENT}>{focused ? '›' : ' '}</Text>
						<Box width={LABEL_WIDTH} flexShrink={0}>
							<Text bold={focused}>{field.label}</Text>
						</Box>
						<Box flexShrink={1} flexGrow={1}>
							<Text wrap="truncate-start" dimColor={value.placeholder}>
								{value.text}
							</Text>
							{focused && (field.kind === 'text' || field.kind === 'number') ? (
								<Text inverse> </Text>
							) : null}
						</Box>
					</Box>
				);
			})}
			<Box flexGrow={1} />
			<Text wrap="truncate-end" color={error ? 'red' : undefined} dimColor={!error}>
				{error ?? (submitting ? 'Starting...' : ' ')}
			</Text>
			<Text wrap="truncate-end" dimColor>
				{keysFor('open')} start Tab next {keysFor('choicePrev')} {keysFor('choiceNext')} change
				(Space too)
			</Text>
		</OverlayFrame>
	);
}
