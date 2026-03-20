/**
 * EdgePromptRow — Per-edge prompt editor for multi-trigger agent nodes.
 *
 * Shows trigger label, config summary, textarea with char count.
 * Debounces updates to avoid excessive pipeline state writes.
 */

import { useState, useEffect, useCallback } from 'react';
import type { IncomingTriggerEdgeInfo } from './NodeConfigPanel';
import { useDebouncedCallback } from '../../../hooks/utils';
import { inputStyle, labelStyle } from './triggers/triggerConfigStyles';

interface EdgePromptRowProps {
	edgeInfo: IncomingTriggerEdgeInfo;
	onUpdateEdgePrompt: (edgeId: string, prompt: string) => void;
	expanded?: boolean;
}

export function EdgePromptRow({ edgeInfo, onUpdateEdgePrompt, expanded }: EdgePromptRowProps) {
	const [localPrompt, setLocalPrompt] = useState(edgeInfo.prompt);

	useEffect(() => {
		setLocalPrompt(edgeInfo.prompt);
	}, [edgeInfo.prompt]);

	const { debouncedCallback: debouncedUpdate } = useDebouncedCallback((...args: unknown[]) => {
		onUpdateEdgePrompt(edgeInfo.edgeId, args[0] as string);
	}, 300);

	const handleChange = useCallback(
		(e: React.ChangeEvent<HTMLTextAreaElement>) => {
			setLocalPrompt(e.target.value);
			debouncedUpdate(e.target.value);
		},
		[debouncedUpdate]
	);

	return (
		<div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
			<label
				style={{
					...labelStyle,
					flex: expanded ? 1 : undefined,
					display: 'flex',
					flexDirection: 'column',
					minHeight: 0,
				}}
			>
				<span style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
					<span style={{ color: '#e4e4e7', fontWeight: 600, fontSize: 11 }}>
						{edgeInfo.triggerLabel}
					</span>
					{edgeInfo.configSummary && (
						<span style={{ color: '#6b7280', fontSize: 10 }}>{edgeInfo.configSummary}</span>
					)}
				</span>
				<textarea
					value={localPrompt}
					onChange={handleChange}
					rows={expanded ? undefined : 2}
					placeholder="Prompt for this trigger..."
					style={{
						...inputStyle,
						resize: 'vertical',
						fontFamily: 'inherit',
						lineHeight: 1.4,
						marginTop: 4,
						...(expanded ? { flex: 1, minHeight: 0 } : { minHeight: 56 }),
					}}
				/>
			</label>
			<div style={{ color: '#6b7280', fontSize: 10, textAlign: 'right', flexShrink: 0 }}>
				{localPrompt.length} chars
			</div>
		</div>
	);
}
