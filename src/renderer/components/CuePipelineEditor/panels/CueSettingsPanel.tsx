/**
 * CueSettingsPanel — Popover panel for global Cue settings.
 *
 * Configures: timeout, failure behavior, concurrency, queue size.
 */

import React, { useRef, useEffect, useId, useState } from 'react';
import { HelpCircle } from 'lucide-react';
import type { Theme } from '../../../types';
import type { CueSettings } from '../../../../shared/cue';
import { useClickOutside } from '../../../hooks/ui';
import { CueSelect } from './CueSelect';

interface InfoTooltipProps {
	text: string;
	theme: Theme;
	placement?: 'above' | 'below';
}

function InfoTooltip({ text, theme, placement = 'above' }: InfoTooltipProps) {
	const [visible, setVisible] = useState(false);
	const tooltipId = useId();

	const verticalStyle: React.CSSProperties =
		placement === 'below' ? { top: 'calc(100% + 6px)' } : { bottom: 'calc(100% + 6px)' };

	return (
		<span
			style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}
			tabIndex={0}
			aria-describedby={visible ? tooltipId : undefined}
			aria-label={text}
			onMouseEnter={() => setVisible(true)}
			onMouseLeave={() => setVisible(false)}
			onFocus={() => setVisible(true)}
			onBlur={() => setVisible(false)}
		>
			<HelpCircle
				size={11}
				style={{ color: theme.colors.textDim, cursor: 'default', opacity: 0.55, flexShrink: 0 }}
				aria-hidden="true"
			/>
			{visible && (
				<div
					id={tooltipId}
					role="tooltip"
					style={{
						position: 'absolute',
						...verticalStyle,
						left: '50%',
						transform: 'translateX(-50%)',
						zIndex: 200,
						width: 220,
						backgroundColor: theme.colors.bgSidebar,
						border: `1px solid ${theme.colors.border}`,
						borderRadius: 6,
						padding: '7px 9px',
						color: theme.colors.textDim,
						fontSize: 11,
						lineHeight: 1.5,
						boxShadow: '0 4px 14px rgba(0,0,0,0.45)',
						pointerEvents: 'none',
						whiteSpace: 'normal',
					}}
				>
					{text}
				</div>
			)}
		</span>
	);
}

interface CueSettingsPanelProps {
	settings: CueSettings;
	theme: Theme;
	onChange: (settings: CueSettings) => void;
	onClose: () => void;
}

function CueSettingsPanelInner({ settings, theme, onChange, onClose }: CueSettingsPanelProps) {
	const panelRef = useRef<HTMLDivElement>(null);

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

	return (
		<div
			ref={panelRef}
			style={{
				position: 'absolute',
				top: 44,
				right: 8,
				zIndex: 20,
				width: 280,
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
					<div style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: 4 }}>
						<span>Timeout (minutes)</span>
						<InfoTooltip
							text="Maximum time a triggered run can execute before it's automatically stopped. Increase if your tasks regularly need more time."
							theme={theme}
							placement="below"
						/>
					</div>
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
				</div>

				{/* Timeout on fail */}
				<div>
					<div style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: 4 }}>
						<span>On Source Failure</span>
						<InfoTooltip
							text="What to do when a pipeline stage times out or errors. 'Break' stops the entire chain; 'Continue' skips the failed stage and proceeds to the next."
							theme={theme}
						/>
					</div>
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
				</div>

				{/* Max concurrent */}
				<div>
					<div style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: 4 }}>
						<span>Max Concurrent Runs</span>
						<InfoTooltip
							text="How many Cue-triggered runs can execute in parallel. Higher values increase throughput but agents may conflict on shared files. Default: 1."
							theme={theme}
						/>
					</div>
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
				</div>

				{/* Queue size */}
				<div>
					<div style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: 4 }}>
						<span>Event Queue Size</span>
						<InfoTooltip
							text="Events that arrive while the concurrent limit is reached are buffered here. When the queue is full, the oldest event is dropped. Set to 0 to disable buffering. Default: 10."
							theme={theme}
						/>
					</div>
					<input
						type="number"
						min={0}
						max={50}
						value={settings.queue_size}
						onChange={(e) =>
							onChange({
								...settings,
								queue_size: Math.min(50, Math.max(0, parseInt(e.target.value) || 10)),
							})
						}
						style={inputStyle}
					/>
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
