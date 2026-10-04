import React from 'react';
import { Box, Text } from 'ink';
import { formatTimestamp, type AgentRecord, type AutoRunIssue } from '../../shared/maestro-lib';
import { OverlayFrame } from '../app/OverlayFrame';
import { keysFor } from '../keymap';
import { highlightedDocument, type AutoRunViewState } from './state';

const ACCENT = '#9146FF';
/** `12/12` plus a gap. */
const COUNT_COLUMN = 8;
/** Most problem lines shown at once; the rest are counted. */
const MAX_ISSUE_LINES = 5;

const SEVERITY_COLORS: Record<AutoRunIssue['severity'], string> = {
	error: 'red',
	warning: 'yellow',
	info: 'cyan',
};

export interface AutoRunViewProps {
	agent: AgentRecord;
	state: AutoRunViewState;
	width: number;
	height: number;
}

function lastRunLine(state: AutoRunViewState): string {
	const { lastRun } = state;
	if (!lastRun) return 'Last run: never';
	const outcome = lastRun.success === false ? 'failed' : 'finished';
	return `Last run: ${outcome} ${formatTimestamp(lastRun.at)}`;
}

function issueLabel(issue: AutoRunIssue): string {
	return issue.line > 0 ? `line ${issue.line}: ${issue.message}` : issue.message;
}

/** The agent's Auto Run documents, with how many tasks are done, and what is wrong with the highlighted one. */
export function AutoRunView({ agent, state, width, height }: AutoRunViewProps): React.ReactElement {
	const { documents, cursor, issues } = state;
	const shownIssues = issues.slice(0, MAX_ISSUE_LINES);
	const issueRows = state.problem
		? 0
		: 1 + Math.max(1, shownIssues.length) + (issues.length > shownIssues.length ? 1 : 0);
	// Title row and border take three lines; the folder, last run, message, and footer take four more.
	const room = Math.max(1, height - 3 - 4 - issueRows);
	const start = Math.min(Math.max(0, cursor - room + 1), Math.max(0, documents.length - room));
	const document = highlightedDocument(state);
	return (
		<OverlayFrame title={`Auto Run: ${agent.name}`} width={width} height={height}>
			<Text dimColor wrap="truncate-start">
				{state.folder ?? ' '}
			</Text>
			<Text dimColor wrap="truncate-end">
				{lastRunLine(state)}
			</Text>
			{state.problem ? (
				<Text color="yellow" wrap="wrap">
					{state.problem}
				</Text>
			) : (
				<>
					{state.note ? (
						<Text color="yellow" wrap="truncate-end">
							{state.note}
						</Text>
					) : null}
					{documents.length === 0 && !state.note ? (
						<Text dimColor>No documents yet. {keysFor('newDocument')} creates one.</Text>
					) : null}
					{documents.slice(start, start + room).map((entry, offset) => {
						const index = start + offset;
						const done = entry.total > 0 && entry.unchecked === 0;
						return (
							<Box key={entry.file}>
								<Text color={ACCENT}>{index === cursor ? '›' : ' '}</Text>
								<Box flexGrow={1} flexShrink={1}>
									<Text wrap="truncate-end" bold={index === cursor}>
										{entry.name}
									</Text>
								</Box>
								<Box width={COUNT_COLUMN} flexShrink={0} justifyContent="flex-end">
									<Text color={done ? 'green' : undefined} dimColor={entry.total === 0}>
										{entry.checked}/{entry.total}
									</Text>
								</Box>
							</Box>
						);
					})}
					<Box flexGrow={1} />
					{document ? (
						<>
							<Text bold wrap="truncate-end">
								{document.name}:{' '}
								{issues.length === 0 ? 'no problems' : `${issues.length} to look at`}
							</Text>
							{issues.length === 0 ? (
								<Text dimColor>Every task uses "- [ ]" and no marker stops a run.</Text>
							) : null}
							{shownIssues.map((issue, index) => (
								<Text
									key={`${issue.line}:${index}`}
									color={SEVERITY_COLORS[issue.severity]}
									wrap="truncate-end"
								>
									{issueLabel(issue)}
								</Text>
							))}
							{issues.length > shownIssues.length ? (
								<Text dimColor>and {issues.length - shownIssues.length} more</Text>
							) : null}
						</>
					) : null}
				</>
			)}
			<Text
				wrap="truncate-end"
				color={state.naming?.error ? 'red' : undefined}
				dimColor={!state.naming?.error}
			>
				{state.naming ? (state.naming.error ?? ' ') : (state.message ?? ' ')}
			</Text>
			{state.naming ? (
				<Box>
					<Text color={ACCENT}>New document </Text>
					<Text wrap="truncate-start" dimColor={state.naming.text === ''}>
						{state.naming.text || 'name, or folder/name'}
					</Text>
					<Text inverse> </Text>
				</Box>
			) : (
				<Text wrap="truncate-end" dimColor>
					{keysFor('open')} edit {keysFor('newDocument')} new {keysFor('reloadDocuments')} reload
				</Text>
			)}
		</OverlayFrame>
	);
}
