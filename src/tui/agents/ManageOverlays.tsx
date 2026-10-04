import React from 'react';
import { Box, Text } from 'ink';
import { OverlayFrame } from '../app/OverlayFrame';
import { keysFor } from '../keymap';
import {
	confirmText,
	promptFields,
	promptProblem,
	promptTitle,
	type ConfirmState,
	type GroupChoice,
	type PromptState,
} from './manage';

const ACCENT = '#9146FF';
const LABEL_WIDTH = 8;

export interface PromptOverlayProps {
	prompt: PromptState;
	submitting: boolean;
	/** The host's refusal of the last send. */
	error?: string;
	width: number;
	height: number;
}

/** A small form of one or two text boxes: rename an agent or a group, or name a new group. */
export function PromptOverlay({
	prompt,
	submitting,
	error,
	width,
	height,
}: PromptOverlayProps): React.ReactElement {
	const fields = promptFields(prompt);
	const problem = promptProblem(prompt);
	return (
		<OverlayFrame title={promptTitle(prompt)} width={width} height={height}>
			{fields.map((field) => {
				const focused = prompt.focus === field.id;
				return (
					<Box key={field.id}>
						<Text color={ACCENT}>{focused ? '›' : ' '}</Text>
						<Box width={LABEL_WIDTH}>
							<Text bold={focused}>{field.label}</Text>
						</Box>
						<Box flexShrink={1} flexGrow={1}>
							<Text wrap="truncate-start" dimColor={field.value === ''}>
								{field.value || field.placeholder}
							</Text>
							{focused ? <Text inverse> </Text> : null}
						</Box>
					</Box>
				);
			})}
			<Box flexGrow={1} />
			<Text wrap="truncate-end" color={error ? 'red' : undefined} dimColor={!error}>
				{error ?? (submitting ? 'Saving...' : (problem ?? ' '))}
			</Text>
			<Text wrap="truncate-end" dimColor>
				{keysFor('open')} {prompt.kind === 'newGroup' ? 'create' : 'save'}
				{fields.length > 1 ? '  Tab next box' : ''}
			</Text>
		</OverlayFrame>
	);
}

export interface ConfirmOverlayProps {
	confirm: ConfirmState;
	submitting: boolean;
	error?: string;
	width: number;
	height: number;
}

/** Says what a delete removes and what it keeps, then waits for a yes. */
export function ConfirmOverlay({
	confirm,
	submitting,
	error,
	width,
	height,
}: ConfirmOverlayProps): React.ReactElement {
	const text = confirmText(confirm);
	return (
		<OverlayFrame title={text.title} width={width} height={height}>
			<Text color="red" bold>
				Removes
			</Text>
			{text.removes.map((line) => (
				<Text key={line} wrap="truncate-end">
					{'  - '}
					{line}
				</Text>
			))}
			<Text color="green" bold>
				Keeps
			</Text>
			{text.keeps.map((line) => (
				<Text key={line} wrap="truncate-end">
					{'  - '}
					{line}
				</Text>
			))}
			{text.warning ? (
				<Text color="yellow" wrap="truncate-end">
					{text.warning}
				</Text>
			) : null}
			<Box flexGrow={1} />
			<Text wrap="truncate-end" color={error ? 'red' : undefined} dimColor={!error}>
				{error ?? (submitting ? 'Deleting...' : ' ')}
			</Text>
			<Text wrap="truncate-end" dimColor>
				{keysFor('confirm')} delete {keysFor('closeOverlay')} cancel
			</Text>
		</OverlayFrame>
	);
}

export interface GroupPickerOverlayProps {
	agentName: string;
	choices: readonly GroupChoice[];
	cursor: number;
	/** The index of the group the agent is in now. */
	currentIndex: number;
	width: number;
	height: number;
}

/** Where to file an agent: ungrouped, or one of the groups. */
export function GroupPickerOverlay({
	agentName,
	choices,
	cursor,
	currentIndex,
	width,
	height,
}: GroupPickerOverlayProps): React.ReactElement {
	return (
		<OverlayFrame title={`Move to group: ${agentName}`} width={width} height={height}>
			{choices.map((choice, index) => (
				<Box key={choice.groupId ?? 'ungrouped'}>
					<Text color={ACCENT}>{index === cursor ? '›' : ' '}</Text>
					<Box flexGrow={1} flexShrink={1}>
						<Text wrap="truncate-end" bold={index === cursor}>
							{choice.label}
						</Text>
					</Box>
					{index === currentIndex ? (
						<Box flexShrink={0} marginLeft={1}>
							<Text dimColor>current</Text>
						</Box>
					) : null}
				</Box>
			))}
		</OverlayFrame>
	);
}
