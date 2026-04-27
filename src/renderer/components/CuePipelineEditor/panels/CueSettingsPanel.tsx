/**
 * CueSettingsPanel — Popover panel for global Cue settings.
 *
 * Configures: timeout, failure behavior, concurrency, queue size.
 */

import React, { useRef, useEffect, useState } from 'react';
import type { Theme } from '../../../types';
import type { CueSettings } from '../../../../shared/cue';
import { useClickOutside } from '../../../hooks/ui';
import { CueSelect } from './CueSelect';

interface CueSettingsPanelProps {
	settings: CueSettings;
	theme: Theme;
	onChange: (settings: CueSettings) => void;
	onClose: () => void;
}

function CueSettingsPanelInner({ settings, theme, onChange, onClose }: CueSettingsPanelProps) {
	const panelRef = useRef<HTMLDivElement>(null);

	// Local string state so the user can clear the field while typing without
	// the controlled-input round-trip snapping the value back to a number.
	const [queueSizeStr, setQueueSizeStr] = useState(String(settings.queue_size));
	useEffect(() => {
		setQueueSizeStr(String(settings.queue_size));
	}, [settings.queue_size]);

	useClickOutside(panelRef, onClose);

	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === 'Escape') onClose();
		};
		document.addEventListener('keydown', handleKeyDown);
		return () => document.removeEventListener('keydown', handleKeyDown);
	}, [onClose]);

	const inputStyle: React.CSSProperties = {
		backgroundColor: theme.colors.bgActivity,
		border: `1px solid ${theme.colors.border}`,
		borderRadius: 4,
		color: theme.colors.textMain,
		padding: '4px 8px',
		fontSize: 12,
		width: '100%',
		outline: 'none',
	};

	const labelStyle: React.CSSProperties = {
		color: theme.colors.textDim,
		fontSize: 11,
		fontWeight: 500,
		marginBottom: 2,
	};

	const descriptionStyle: React.CSSProperties = {
		color: theme.colors.textDim,
		fontSize: 10,
		lineHeight: 1.4,
		marginTop: 4,
		opacity: 0.75,
	};

	return (
		<div
			ref={panelRef}
			style={{
				position: 'absolute',
				top: 44,
				right: 8,
				zIndex: 20,
				width: 320,
				backgroundColor: theme.colors.bgSidebar,
				border: `1px solid ${theme.colors.border}`,
				borderRadius: 8,
				boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
				padding: 16,
			}}
		>
			<div
				style={{
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'space-between',
					marginBottom: 12,
				}}
			>
				<span style={{ color: theme.colors.textMain, fontSize: 13, fontWeight: 600 }}>
					Cue Settings
				</span>
				<button
					onClick={onClose}
					style={{
						backgroundColor: 'transparent',
						border: 'none',
						color: theme.colors.textDim,
						cursor: 'pointer',
						fontSize: 16,
						lineHeight: 1,
						padding: '0 4px',
					}}
				>
					&times;
				</button>
			</div>

			<div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
				{/* Timeout */}
				<div>
					<div style={labelStyle}>Timeout (minutes)</div>
					<input
						type="number"
						min={1}
						max={1440}
						value={settings.timeout_minutes}
						onChange={(e) =>
							onChange({
								...settings,
								timeout_minutes: Math.max(1, parseInt(e.target.value) || 30),
							})
						}
						style={inputStyle}
					/>
					<div style={descriptionStyle}>
						Maximum time a triggered run can execute before it's automatically stopped. Increase if
						your tasks regularly need more time.
					</div>
				</div>

				{/* Timeout on fail */}
				<div>
					<div style={labelStyle}>On Source Failure</div>
					<CueSelect
						value={settings.timeout_on_fail}
						options={[
							{ value: 'break', label: 'Break (stop chain)' },
							{ value: 'continue', label: 'Continue (skip failed)' },
						]}
						onChange={(v) =>
							onChange({
								...settings,
								timeout_on_fail: v as 'break' | 'continue',
							})
						}
						theme={theme}
					/>
					<div style={descriptionStyle}>
						What to do when a pipeline stage times out or errors. "Break" stops the entire chain;
						"Continue" skips the failed stage and proceeds to the next.
					</div>
				</div>

				{/* Max concurrent */}
				<div>
					<div style={labelStyle}>Max Concurrent Runs</div>
					<input
						type="number"
						min={1}
						max={10}
						value={settings.max_concurrent}
						onChange={(e) =>
							onChange({
								...settings,
								max_concurrent: Math.min(10, Math.max(1, parseInt(e.target.value) || 1)),
							})
						}
						style={inputStyle}
					/>
					<div style={descriptionStyle}>
						How many Cue-triggered runs can execute in parallel. Higher values increase throughput
						but agents may conflict on shared files. Default: 1.
					</div>
				</div>

				{/* Queue size */}
				<div>
					<div style={labelStyle}>Event Queue Size</div>
					<input
						type="number"
						min={0}
						max={50}
						value={queueSizeStr}
						onChange={(e) => {
							const raw = e.target.value;
							setQueueSizeStr(raw);
							const parsed = raw === '' ? 0 : parseInt(raw, 10);
							if (!Number.isNaN(parsed)) {
								onChange({
									...settings,
									queue_size: Math.min(50, Math.max(0, parsed)),
								});
							}
						}}
						onBlur={() => setQueueSizeStr(String(settings.queue_size))}
						style={inputStyle}
					/>
					<div style={descriptionStyle}>
						Events that arrive while the concurrent limit is reached are buffered here. When the
						queue is full, the oldest event is dropped. Set to 0 to disable buffering. Default: 0.
					</div>
				</div>
			</div>

			<div
				style={{
					marginTop: 12,
					paddingTop: 8,
					borderTop: `1px solid ${theme.colors.border}`,
					color: theme.colors.textDim,
					fontSize: 10,
					lineHeight: 1.4,
				}}
			>
				Settings are saved to .maestro/cue.yaml when you save the pipeline.
			</div>
		</div>
	);
}

// Phase 14B — memoized so the panel doesn't re-render on canvas drag ticks.
export const CueSettingsPanel = React.memo(CueSettingsPanelInner);
