import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useApp, useInput } from 'ink';
import type { MaestroPaths } from '../shared/maestro-lib';
import { Shell } from './app/Shell';
import { buildPaneRows, initialCursorKey, moveCursor, isSectionCollapsed } from './app/agentRows';
import { loadAgentData } from './app/loadAgentData';
import { useTerminalSize } from './app/useTerminalSize';
import { useViewState } from './app/useViewState';
import { AGENTS_PANE_AUTO_HIDE_BELOW } from './app/layout';
import { tuiStateFilePath } from './store/view-state';

export interface AppProps {
	paths: Pick<
		MaestroPaths,
		'userDataDir' | 'sessionsFile' | 'groupsFile' | 'settingsFile' | 'agentConfigsFile'
	>;
}

/** Who owns the data directory. This phase only ever reads. */
const HOST_LABEL = 'read-only';

export function App({ paths }: AppProps): React.ReactElement {
	const { exit } = useApp();
	const size = useTerminalSize();

	const data = useMemo(() => loadAgentData(paths), [paths]);
	const [view, setView] = useViewState(tuiStateFilePath(paths.userDataDir));
	// The user's toggle for the Agents pane. Not persisted: whether it fits depends on the window.
	const [agentsPaneOverride, setAgentsPaneOverride] = useState<boolean | undefined>(undefined);

	const rows = useMemo(
		() => buildPaneRows(data.sections, view.collapsedSections),
		[data.sections, view.collapsedSections]
	);
	// The cursor lives in a ref as well as in state: keys arrive faster than React
	// renders (a held `j`), and a handler reading only state would act on a stale
	// cursor and drop moves.
	const cursorRef = useRef(initialCursorKey(rows, view.selectedAgentId));
	const rowsRef = useRef(rows);
	rowsRef.current = rows;
	const [, setCursorKey] = useState(cursorRef.current);
	// A fold can remove the row the cursor stood on; fall back to the first row.
	const cursorRow = rows.find((row) => row.key === cursorRef.current) ?? rows[0];
	cursorRef.current = cursorRow?.key;

	const moveBy = (delta: number) => {
		cursorRef.current = moveCursor(rowsRef.current, cursorRef.current, delta);
		setCursorKey(cursorRef.current);
	};

	// Remember which agent the cursor is on. Standing on a group header leaves it as it was.
	const cursorAgentId = cursorRow?.kind === 'agent' ? cursorRow.agent.id : undefined;
	useEffect(() => {
		if (cursorAgentId === undefined) return;
		setView((current) =>
			current.selectedAgentId === cursorAgentId
				? current
				: { ...current, selectedAgentId: cursorAgentId }
		);
	}, [cursorAgentId, setView]);

	useInput((input, key) => {
		if (input === 'q') {
			exit();
		} else if (key.ctrl && input === 'b') {
			setAgentsPaneOverride((current) => !(current ?? size.columns >= AGENTS_PANE_AUTO_HIDE_BELOW));
		} else if (input === 'j' || key.downArrow) {
			moveBy(1);
		} else if (input === 'k' || key.upArrow) {
			moveBy(-1);
		} else if (key.return) {
			const row = rowsRef.current.find((candidate) => candidate.key === cursorRef.current);
			if (row?.kind !== 'section') return;
			const { section } = row;
			setView((current) => ({
				...current,
				collapsedSections: {
					...current.collapsedSections,
					[section.key]: !isSectionCollapsed(section, current.collapsedSections),
				},
			}));
		}
	});

	return (
		<Shell
			size={size}
			userDataDir={paths.userDataDir}
			hostLabel={HOST_LABEL}
			rows={rows}
			cursorKey={cursorRow?.key}
			agent={cursorRow?.kind === 'agent' ? cursorRow.agent : undefined}
			agentsPaneOverride={agentsPaneOverride}
			agentsPaneWidth={view.agentsPaneWidth}
			problems={data.problems}
		/>
	);
}
