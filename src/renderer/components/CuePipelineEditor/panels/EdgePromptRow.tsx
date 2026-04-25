/**
 * EdgePromptRow — Per-edge prompt editor for multi-trigger agent nodes.
 *
 * Shows trigger label, config summary, textarea with char count.
 * Debounces updates to avoid excessive pipeline state writes.
 */

import { useState, useEffect, useCallback } from 'react';
import type { Theme } from '../../../types';
import type { IncomingTriggerEdgeInfo } from './NodeConfigPanel';
import { useDebouncedCallback } from '../../../hooks/utils';
import { getInputStyle, getLabelStyle } from './triggers/triggerConfigStyles';

interface EdgePromptRowProps {
	edgeInfo: IncomingTriggerEdgeInfo;
	theme: Theme;
	onUpdateEdgePrompt: (edgeId: string, prompt: string) => void;
	expanded?: boolean;
}

export function EdgePromptRow({
	edgeInfo,
	theme,
	onUpdateEdgePrompt,
	expanded,
}: EdgePromptRowProps) {
	const [localPrompt, setLocalPrompt] = useState(edgeInfo.prompt);

	const themedInputStyle = getInputStyle(theme);
	const themedLabelStyle = getLabelStyle(theme);

	useEffect(() => {
		setLocalPrompt(edgeInfo.prompt);
	}, [edgeInfo.prompt]);

	const { debouncedCallback: debouncedUpdate, flush } = useDebouncedCallback(
		(...args: unknown[]) => {
			onUpdateEdgePrompt(edgeInfo.edgeId, args[0] as string);
		},
		300
	);

	// Flush pending writes on unmount so the last keystroke commits to THIS edge
	// before the row tears down (row remount when agent selection changes).
	useEffect(() => {
		return () => {
			flush();
		};
	}, [flush]);

	const handleChange = useCallback(
		(e: React.ChangeEvent<HTMLTextAreaElement>) => {
			setLocalPrompt(e.target.value);
			debouncedUpdate(e.target.value);
		},
		[debouncedUpdate]
	);

	// Sizing policy:
	//
	// - Expanded mode: row takes flex: 1 of the available column height and the
	//   textarea fills the row (flex: 1 / minHeight: 0). Multiple rows split
	//   the column evenly.
	// - Collapsed mode: row uses INTRINSIC content height (flexShrink: 0, no
	//   flex grow). The parent column in AgentConfigPanel sets overflowY: auto
	//   so additional rows scroll instead of squeezing each other below their
	//   min content size — that squeezing was what caused the bottom row's
	//   title to visually overlap the textarea above it when 3+ triggers were
	//   attached. Each row reserves a stable ~140px (label + textarea + count)
	//   so the layout is predictable.
	//
	// `flexShrink: 0` on the title span and the char count, plus `marginBottom`
	// on the title, are load-bearing: without them flex would still try to
	// shrink the inner spans when vertical space is tight. Do not remove.
	const isCollapsed = !expanded;
	return (
		<div
			style={{
				display: 'flex',
				flexDirection: 'column',
				minHeight: 0,
				...(expanded ? { flex: 1 } : { flexShrink: 0 }),
			}}
		>
			<label
				style={{
					...themedLabelStyle,
					flex: expanded ? 1 : undefined,
					display: 'flex',
					flexDirection: 'column',
					minHeight: 0,
					marginBottom: 0,
				}}
			>
				<span
					style={{
						display: 'flex',
						alignItems: 'center',
						gap: 6,
						flexShrink: 0,
						marginBottom: 4,
					}}
				>
					<span style={{ color: theme.colors.textMain, fontWeight: 600, fontSize: 11 }}>
						{edgeInfo.triggerLabel}
					</span>
					{edgeInfo.configSummary && (
						<span style={{ color: theme.colors.textDim, fontSize: 10 }}>
							{edgeInfo.configSummary}
						</span>
					)}
				</span>
				<textarea
					value={localPrompt}
					onChange={handleChange}
					rows={isCollapsed ? 3 : undefined}
					placeholder="Prompt for this trigger..."
					style={{
						...themedInputStyle,
						resize: 'vertical',
						fontFamily: 'inherit',
						lineHeight: 1.4,
						...(expanded ? { flex: 1, minHeight: 0 } : { minHeight: 72, flexShrink: 0 }),
					}}
				/>
			</label>
			<div
				style={{
					color: theme.colors.textDim,
					fontSize: 10,
					textAlign: 'right',
					flexShrink: 0,
					marginTop: 2,
				}}
			>
				{localPrompt.length} chars
			</div>
		</div>
	);
}
