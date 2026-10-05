import React from 'react';
import { Box, Text } from 'ink';
import { getAgentDisplayName, type AgentRecord } from '../../shared/maestro-lib';
import { OverlayFrame } from '../app/OverlayFrame';
import { keysFor } from '../keymap';
import { chatFieldKey, chatFormFields, type ChatFormField, type ChatFormState } from './state';

const ACCENT = '#9146FF';
const LABEL_WIDTH = 17;

export interface GroupChatFormViewProps {
	agents: readonly AgentRecord[];
	form: ChatFormState;
	submitting: boolean;
	width: number;
	height: number;
}

function moderatorText(form: ChatFormState, agents: readonly AgentRecord[]): string {
	if (form.moderator === '') return '‹ first participant ›';
	const agent = agents.find((candidate) => candidate.id === form.moderator);
	return agent ? `‹ ${agent.name} (${getAgentDisplayName(agent.toolType)}) ›` : '‹ agent is gone ›';
}

/** Names a chat, picks its moderator, and picks the agents that join (GC-1). */
export function GroupChatFormView({
	agents,
	form,
	submitting,
	width,
	height,
}: GroupChatFormViewProps): React.ReactElement {
	const fields = chatFormFields(agents);
	const focusAt = Math.max(
		0,
		fields.findIndex((field) => chatFieldKey(field) === form.focus)
	);
	// Title and border take three lines; the opening rows, the picked count, an error line, and the footer take more.
	const textRows = fields.filter((field) => field.kind !== 'participant');
	const room = Math.max(1, height - 3 - textRows.length - 3);
	const participants = fields.filter((field) => field.kind === 'participant');
	const focusInList = Math.max(0, focusAt - textRows.length);
	const start = Math.min(
		Math.max(0, focusInList - room + 1),
		Math.max(0, participants.length - room)
	);
	const shown = participants.slice(start, start + room);

	const row = (field: ChatFormField) => {
		const key = chatFieldKey(field);
		const focused = key === form.focus;
		if (field.kind === 'participant') {
			const on = form.picked.includes(field.agentId);
			return (
				<Box key={key}>
					<Text color={ACCENT}>{focused ? '›' : ' '}</Text>
					<Box flexGrow={1} flexShrink={1}>
						<Text wrap="truncate-end" bold={focused} color={on ? 'green' : undefined}>
							{on ? '[x] ' : '[ ] '}
							{field.label}
						</Text>
					</Box>
					{on ? (
						<Box flexShrink={0} marginLeft={1}>
							<Text dimColor>{form.picked.indexOf(field.agentId) + 1}</Text>
						</Box>
					) : null}
				</Box>
			);
		}
		const value =
			field.kind === 'moderator'
				? { text: moderatorText(form, agents), placeholder: form.moderator === '' }
				: field.id === 'name'
					? { text: form.name || field.hint, placeholder: form.name === '' }
					: { text: form.message || field.hint, placeholder: form.message === '' };
		return (
			<Box key={key}>
				<Text color={ACCENT}>{focused ? '›' : ' '}</Text>
				<Box width={LABEL_WIDTH} flexShrink={0}>
					<Text bold={focused}>{field.label}</Text>
				</Box>
				<Box flexShrink={1} flexGrow={1}>
					<Text wrap="truncate-start" dimColor={value.placeholder}>
						{value.text}
					</Text>
					{focused && field.kind === 'text' ? <Text inverse> </Text> : null}
				</Box>
			</Box>
		);
	};

	return (
		<OverlayFrame title="New group chat" width={width} height={height}>
			{textRows.map(row)}
			<Text bold wrap="truncate-end">
				Participants{' '}
				<Text dimColor>
					({form.picked.length} picked; {keysFor('choicePrev')} {keysFor('choiceNext')} or space
					picks)
				</Text>
			</Text>
			{participants.length === 0 ? <Text dimColor>No agent can join a chat.</Text> : null}
			{shown.map(row)}
			<Box flexGrow={1} />
			<Text wrap="truncate-end" color={form.error ? 'red' : undefined} dimColor={!form.error}>
				{form.error ?? (submitting ? 'Creating...' : ' ')}
			</Text>
			<Text wrap="truncate-end" dimColor>
				{keysFor('submitForm')} create Tab next field {keysFor('open')} next or pick
			</Text>
		</OverlayFrame>
	);
}
