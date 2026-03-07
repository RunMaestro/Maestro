/**
 * CueSettingsPanel — Popover panel for global Cue settings.
 *
 * Configures: timeout, failure behavior, concurrency, queue size.
 */

import type { CueSettings } from '../../../../main/cue/cue-types';

const inputStyle: React.CSSProperties = {
	backgroundColor: '#2a2a3e',
	border: '1px solid #444',
	borderRadius: 4,
	color: '#e4e4e7',
	padding: '4px 8px',
	fontSize: 12,
	width: '100%',
	outline: 'none',
};

const selectStyle: React.CSSProperties = {
	...inputStyle,
	cursor: 'pointer',
};

const labelStyle: React.CSSProperties = {
	color: '#9ca3af',
	fontSize: 11,
	fontWeight: 500,
	marginBottom: 2,
};

interface CueSettingsPanelProps {
	settings: CueSettings;
	onChange: (settings: CueSettings) => void;
	onClose: () => void;
}

export function CueSettingsPanel({ settings, onChange, onClose }: CueSettingsPanelProps) {
	return (
		<div
			style={{
				position: 'absolute',
				top: 44,
				right: 8,
				zIndex: 20,
				width: 280,
				backgroundColor: '#1e1e2e',
				border: '1px solid #444',
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
				<span style={{ color: '#e4e4e7', fontSize: 13, fontWeight: 600 }}>Cue Settings</span>
				<button
					onClick={onClose}
					style={{
						backgroundColor: 'transparent',
						border: 'none',
						color: '#6b7280',
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
				</div>

				{/* Timeout on fail */}
				<div>
					<div style={labelStyle}>On Source Failure</div>
					<select
						value={settings.timeout_on_fail}
						onChange={(e) =>
							onChange({
								...settings,
								timeout_on_fail: e.target.value as 'break' | 'continue',
							})
						}
						style={selectStyle}
					>
						<option value="break">Break (stop chain)</option>
						<option value="continue">Continue (skip failed)</option>
					</select>
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
				</div>

				{/* Queue size */}
				<div>
					<div style={labelStyle}>Event Queue Size</div>
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
					borderTop: '1px solid #333',
					color: '#6b7280',
					fontSize: 10,
					lineHeight: 1.4,
				}}
			>
				Settings are saved to .maestro/cue.yaml when you save the pipeline.
			</div>
		</div>
	);
}
