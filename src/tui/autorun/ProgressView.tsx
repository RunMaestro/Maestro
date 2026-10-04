import React from 'react';
import { Box, Text } from 'ink';
import type { AgentRecord, AutoRunRun } from '../../shared/maestro-lib';
import { OverlayFrame } from '../app/OverlayFrame';
import { keysFor, type KeyAction } from '../keymap';
import {
	availableRunControls,
	describeRun,
	tailRows,
	type RunControl,
	type RunStatus,
} from './progress';

const ACCENT = '#9146FF';

const STATUS_COLORS: Record<RunStatus, string | undefined> = {
	none: undefined,
	running: 'green',
	stopping: 'yellow',
	paused: 'yellow',
	gate: 'yellow',
	finished: 'cyan',
};

const CONTROL_ACTIONS: Record<RunControl, KeyAction> = {
	stop: 'stopRun',
	resume: 'resumeRun',
	skip: 'skipDocument',
	abort: 'abortRun',
};

export interface ProgressViewProps {
	agent: AgentRecord;
	run: AutoRunRun | undefined;
	now: number;
	/** A control is in flight, or the last one's answer. */
	busy?: string;
	message?: string;
	error?: string;
	width: number;
	height: number;
}

/** Rows the frame, the summary, and the footer take; the output tail gets the rest. */
const FIXED_ROWS = 14;

/** A run as it goes: where it is, what it has cost, the last of what it printed, and what can be done. */
export function ProgressView({
	agent,
	run,
	now,
	busy,
	message,
	error,
	width,
	height,
}: ProgressViewProps): React.ReactElement {
	const summary = describeRun(run, now);
	const controls = availableRunControls(run);
	const tail = tailRows(run, Math.max(1, height - FIXED_ROWS));
	return (
		<OverlayFrame title={`Auto Run progress: ${agent.name}`} width={width} height={height}>
			<Text bold color={STATUS_COLORS[summary.status]} wrap="truncate-end">
				{summary.headline}
			</Text>
			{summary.documentLine ? <Text wrap="truncate-end">{summary.documentLine}</Text> : null}
			{summary.taskLine ? (
				<Text wrap="truncate-end">
					{summary.taskLine}
					{summary.loopLine ? <Text dimColor> {summary.loopLine}</Text> : null}
				</Text>
			) : null}
			{summary.pauseLine ? (
				<Text color="yellow" wrap="wrap">
					{summary.pauseLine}
				</Text>
			) : null}
			{summary.status !== 'none' ? (
				<Text wrap="truncate-end">
					<Text dimColor>Clock </Text>
					{summary.clock}
					<Text dimColor> Tokens </Text>
					{summary.tokens}
					<Text dimColor> Cost </Text>
					{summary.cost}
				</Text>
			) : null}
			<Text> </Text>
			<Text color={ACCENT} bold>
				Output
			</Text>
			<Box flexDirection="column" flexGrow={1}>
				{tail.length === 0 ? (
					<Text dimColor>
						{summary.status === 'none' ? 'Nothing is running.' : 'Nothing printed yet.'}
					</Text>
				) : (
					tail.map((line, index) => (
						<Text key={`${index}:${line}`} wrap="truncate-end">
							{line}
						</Text>
					))
				)}
			</Box>
			<Text wrap="truncate-end" color={error ? 'red' : undefined} dimColor={!error}>
				{error ?? (busy ? `${busy}...` : (message ?? ' '))}
			</Text>
			<Text wrap="truncate-end" dimColor>
				{controls.length > 0
					? controls
							.map(
								(offer) => `${keysFor(CONTROL_ACTIONS[offer.control])} ${offer.label.toLowerCase()}`
							)
							.join('  ')
					: 'No controls: nothing is running.'}
			</Text>
		</OverlayFrame>
	);
}
