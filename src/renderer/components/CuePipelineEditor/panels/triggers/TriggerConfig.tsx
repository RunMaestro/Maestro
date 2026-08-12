/**
 * TriggerConfig - Event-type-specific configuration fields for trigger nodes.
 *
 * Renders form fields based on the trigger's event type (heartbeat, scheduled,
 * file change, agent completed, GitHub PR/issue, task pending).
 */

import { useState, useEffect, useCallback } from 'react';
import type { Theme } from '../../../../types';
import type { PipelineNode, TriggerNodeData } from '../../../../../shared/cue-pipeline-types';
import { CUE_COLOR } from '../../../../../shared/cue-pipeline-types';
import { useDebouncedCallback } from '../../../../hooks/utils';
import { registerPendingEdit } from '../../../../hooks/cue/pendingEditsRegistry';
import { getInputStyle, getLabelStyle } from './triggerConfigStyles';
import { CueSelect } from '../CueSelect';

/** Sentinel value matching `cue-github-poller.UNLIMITED_NOTIFICATIONS`. */
const UNLIMITED_NOTIFICATIONS = 0;
const DEFAULT_MAX_NOTIFICATIONS = 10;
/** Inclusive bounds for the per-item cap slider. Values outside this range
 *  remain valid in YAML - the slider just clamps for visual display. */
const MAX_NOTIFICATIONS_SLIDER_MIN = 1;
const MAX_NOTIFICATIONS_SLIDER_MAX = 25;

interface TriggerConfigProps {
	node: PipelineNode;
	theme: Theme;
	onUpdateNode: (nodeId: string, data: Partial<TriggerNodeData>) => void;
}

export function TriggerConfig({ node, theme, onUpdateNode }: TriggerConfigProps) {
	const data = node.data as TriggerNodeData;
	const [localConfig, setLocalConfig] = useState(data.config);
	const [localCustomLabel, setLocalCustomLabel] = useState(data.customLabel ?? '');

	const themedInputStyle = getInputStyle(theme);
	const themedLabelStyle = getLabelStyle(theme);

	useEffect(() => {
		setLocalConfig(data.config);
	}, [data.config]);

	useEffect(() => {
		setLocalCustomLabel(data.customLabel ?? '');
	}, [data.customLabel]);

	const { debouncedCallback: debouncedUpdate, flush: flushConfig } = useDebouncedCallback(
		(...args: unknown[]) => {
			const config = args[0] as TriggerNodeData['config'];
			onUpdateNode(node.id, { config } as Partial<TriggerNodeData>);
		},
		300
	);

	const { debouncedCallback: debouncedUpdateLabel, flush: flushLabel } = useDebouncedCallback(
		(...args: unknown[]) => {
			const customLabel = (args[0] as string) || undefined;
			onUpdateNode(node.id, { customLabel } as Partial<TriggerNodeData>);
		},
		300
	);

	// Flush pending debounced edits on unmount AND register with the
	// pending-edits registry so `handleSave` can flush before reading
	// pipelineState. Without this, toggling a checkbox (or editing the
	// custom label) and immediately closing the panel or saving inside
	// the 300ms window silently drops the edit - the user-visible
	// "re-trigger toggle won't stick across restarts" symptom.
	useEffect(() => {
		const unregister = registerPendingEdit(() => {
			flushConfig();
			flushLabel();
		});
		return () => {
			flushConfig();
			flushLabel();
			unregister();
		};
	}, [flushConfig, flushLabel]);

	const handleCustomLabelChange = useCallback(
		(e: React.ChangeEvent<HTMLInputElement>) => {
			setLocalCustomLabel(e.target.value);
			debouncedUpdateLabel(e.target.value);
		},
		[debouncedUpdateLabel]
	);

	const updateConfig = useCallback(
		(key: string, value: string | number) => {
			const updated = { ...localConfig, [key]: value };
			setLocalConfig(updated);
			debouncedUpdate(updated);
		},
		[localConfig, debouncedUpdate]
	);

	/**
	 * Handle numeric input changes that need to support a blank state. Empty
	 * input drops the key from config (so the runtime falls back to its
	 * default), otherwise stores the parsed integer. Non-numeric junk is
	 * ignored entirely so transient typing states don't clobber the value.
	 * The keys here match TriggerNodeData['config'] entries; the cast keeps
	 * the index signature happy without enumerating each one.
	 */
	const updateNumericConfig = useCallback(
		(key: keyof TriggerNodeData['config'], raw: string) => {
			const next = { ...localConfig } as Record<string, unknown>;
			if (raw === '') {
				delete next[key as string];
			} else {
				const parsed = parseInt(raw, 10);
				if (!Number.isFinite(parsed)) return;
				next[key as string] = parsed;
			}
			const updated = next as TriggerNodeData['config'];
			setLocalConfig(updated);
			debouncedUpdate(updated);
		},
		[localConfig, debouncedUpdate]
	);

	const updateFilter = useCallback(
		(key: string, value: string) => {
			const updated = {
				...localConfig,
				filter: { ...(localConfig.filter ?? {}), [key]: value },
			};
			setLocalConfig(updated);
			debouncedUpdate(updated);
		},
		[localConfig, debouncedUpdate]
	);

	const nameField = (
		<label style={themedLabelStyle}>
			Name
			<input
				type="text"
				value={localCustomLabel}
				onChange={handleCustomLabelChange}
				placeholder={data.label}
				style={themedInputStyle}
			/>
		</label>
	);

	switch (data.eventType) {
		case 'time.heartbeat':
			return (
				<div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
					{nameField}
					<label style={themedLabelStyle}>
						Run every N minutes
						<input
							type="number"
							min={1}
							value={localConfig.interval_minutes ?? ''}
							onChange={(e) => updateNumericConfig('interval_minutes', e.target.value)}
							placeholder="30"
							style={themedInputStyle}
						/>
					</label>
				</div>
			);
		case 'time.scheduled':
			return (
				<div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
					{nameField}
					<label style={themedLabelStyle}>
						Times (HH:MM, comma-separated)
						<input
							type="text"
							value={(localConfig.schedule_times ?? []).join(', ')}
							onChange={(e) => {
								const times = e.target.value
									.split(',')
									.map((t) => t.trim())
									.filter(Boolean);
								const updated = { ...localConfig, schedule_times: times };
								setLocalConfig(updated);
								debouncedUpdate(updated);
							}}
							placeholder="09:00, 17:00"
							style={themedInputStyle}
						/>
					</label>
					<label style={themedLabelStyle}>
						Days (leave empty for every day)
						<div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 4 }}>
							{['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((day) => {
								const days = localConfig.schedule_days ?? [];
								const isActive = days.includes(day);
								return (
									<button
										key={day}
										type="button"
										onClick={() => {
											const newDays = isActive
												? days.filter((d: string) => d !== day)
												: [...days, day];
											const updated = { ...localConfig, schedule_days: newDays };
											setLocalConfig(updated);
											debouncedUpdate(updated);
										}}
										style={{
											...themedInputStyle,
											width: 'auto',
											padding: '2px 8px',
											cursor: 'pointer',
											fontSize: 11,
											textTransform: 'capitalize',
											backgroundColor: isActive ? theme.colors.accent : theme.colors.bgActivity,
											color: isActive ? theme.colors.accentForeground : theme.colors.textDim,
											border: `1px solid ${isActive ? theme.colors.accent : theme.colors.border}`,
										}}
									>
										{day}
									</button>
								);
							})}
						</div>
					</label>
				</div>
			);
		case 'file.changed':
			return (
				<div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
					{nameField}
					<label style={themedLabelStyle}>
						Watch pattern
						<input
							type="text"
							value={localConfig.watch ?? ''}
							onChange={(e) => updateConfig('watch', e.target.value)}
							placeholder="**/*.ts"
							style={themedInputStyle}
						/>
					</label>
					<label htmlFor="cue-change-type-select" style={themedLabelStyle}>
						Change type
						<CueSelect
							id="cue-change-type-select"
							value={(localConfig.filter?.changeType as string) ?? 'any'}
							options={[
								{ value: 'any', label: 'Any' },
								{ value: 'created', label: 'Created' },
								{ value: 'modified', label: 'Modified' },
								{ value: 'deleted', label: 'Deleted' },
							]}
							onChange={(v) => updateFilter('changeType', v)}
							theme={theme}
						/>
					</label>
				</div>
			);
		case 'agent.completed':
			return (
				<div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
					{nameField}
					<div style={{ color: theme.colors.textDim, fontSize: 12, fontStyle: 'italic' }}>
						Source agent is determined by incoming edges. Connect a trigger or agent node to
						configure the source.
					</div>
				</div>
			);
		case 'github.pull_request':
		case 'github.issue': {
			const retriggerEnabled = localConfig.retrigger_on_comments === true;
			return (
				<div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
					{nameField}
					<label style={themedLabelStyle}>
						Repository
						<input
							type="text"
							value={localConfig.repo ?? ''}
							onChange={(e) => updateConfig('repo', e.target.value)}
							placeholder="owner/repo"
							style={themedInputStyle}
						/>
					</label>
					<label style={themedLabelStyle}>
						Poll every N minutes
						<input
							type="number"
							min={1}
							value={localConfig.poll_minutes ?? ''}
							onChange={(e) => updateNumericConfig('poll_minutes', e.target.value)}
							placeholder="5"
							style={themedInputStyle}
						/>
					</label>
					<label
						style={{
							...themedLabelStyle,
							display: 'flex',
							flexDirection: 'row',
							alignItems: 'center',
							gap: 6,
							cursor: 'pointer',
						}}
					>
						<input
							type="checkbox"
							checked={retriggerEnabled}
							onChange={(e) => {
								const next = {
									...localConfig,
									retrigger_on_comments: e.target.checked,
								};
								// Drop max_notifications when the toggle goes off so the
								// YAML stays clean - the cap is meaningless without it.
								if (!e.target.checked) delete next.max_notifications;
								setLocalConfig(next);
								debouncedUpdate(next);
							}}
							style={{ accentColor: CUE_COLOR }}
						/>
						<span>Re-trigger on new activity (comments, edits, reviews)</span>
					</label>
					{retriggerEnabled && (
						<MaxNotificationsControl
							key={node.id}
							entityLabel={data.eventType === 'github.pull_request' ? 'PR' : 'issue'}
							stored={localConfig.max_notifications}
							theme={theme}
							onChange={(value) => updateConfig('max_notifications', value)}
							labelStyle={themedLabelStyle}
						/>
					)}
				</div>
			);
		}
		case 'task.pending':
			return (
				<div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
					{nameField}
					<label style={themedLabelStyle}>
						Scan pattern
						<input
							type="text"
							value={localConfig.watch ?? ''}
							onChange={(e) => updateConfig('watch', e.target.value)}
							placeholder="**/*.md"
							style={themedInputStyle}
						/>
					</label>
				</div>
			);
		case 'app.startup':
			return (
				<div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
					{nameField}
					<div style={{ color: theme.colors.textDim, fontSize: 12, fontStyle: 'italic' }}>
						Fires once when the Maestro application starts. No additional configuration needed.
					</div>
				</div>
			);
		case 'cli.trigger':
			return (
				<div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
					{nameField}
					<div style={{ color: theme.colors.textDim, fontSize: 12, fontStyle: 'italic' }}>
						Triggered manually via{' '}
						<code>maestro-cli cue trigger "{data.customLabel || data.label || 'name'}"</code>.
						Supports an optional <code>--prompt</code> override.
					</div>
				</div>
			);
		default:
			return null;
	}
}

interface MaxNotificationsControlProps {
	entityLabel: 'PR' | 'issue';
	/** Current `max_notifications` value from the trigger config.
	 *  - `undefined` → user hasn't set a value; default of 10 applies at runtime.
	 *  - `0`         → infinite sentinel.
	 *  - positive    → explicit cap. */
	stored: number | undefined;
	theme: Theme;
	onChange: (value: number) => void;
	labelStyle: React.CSSProperties;
}

/**
 * Slider + "Infinite" checkbox for the per-item re-trigger cap.
 *
 * Mounted with `key={node.id}` so the local `lastFinite` memory resets when
 * the user switches to a different trigger node, preventing one trigger's
 * prior slider position from leaking into another.
 *
 * Values from YAML that fall outside [1, 25] (e.g. hand-edited `100`) display
 * clamped on the slider track but are preserved in the count label until the
 * user drags - at which point the slider value wins.
 */
function MaxNotificationsControl({
	entityLabel,
	stored,
	theme,
	onChange,
	labelStyle,
}: MaxNotificationsControlProps) {
	const isInfinite = stored === UNLIMITED_NOTIFICATIONS;
	const initialFinite =
		stored === undefined || stored === UNLIMITED_NOTIFICATIONS
			? DEFAULT_MAX_NOTIFICATIONS
			: clampSliderValue(stored);
	// `lastFinite` remembers the slider position so unchecking Infinite
	// restores it instead of always snapping back to the default.
	const [lastFinite, setLastFinite] = useState(initialFinite);
	const sliderValue = isInfinite
		? lastFinite
		: clampSliderValue(stored ?? DEFAULT_MAX_NOTIFICATIONS);
	// Display the raw stored value when it sits outside the slider's range so
	// legacy hand-edited YAML doesn't appear to silently truncate.
	const displayValue =
		!isInfinite && stored !== undefined && stored > MAX_NOTIFICATIONS_SLIDER_MAX
			? stored
			: sliderValue;
	const percent =
		((sliderValue - MAX_NOTIFICATIONS_SLIDER_MIN) /
			(MAX_NOTIFICATIONS_SLIDER_MAX - MAX_NOTIFICATIONS_SLIDER_MIN)) *
		100;

	return (
		<div style={labelStyle}>
			<div
				style={{
					display: 'flex',
					justifyContent: 'space-between',
					alignItems: 'baseline',
					marginBottom: 4,
				}}
			>
				<span>Max re-triggers per {entityLabel}</span>
				<span
					style={{
						fontVariantNumeric: 'tabular-nums',
						color: isInfinite ? theme.colors.accent : theme.colors.textMain,
						fontSize: 14,
					}}
				>
					{isInfinite ? '∞' : displayValue}
				</span>
			</div>
			<input
				type="range"
				min={MAX_NOTIFICATIONS_SLIDER_MIN}
				max={MAX_NOTIFICATIONS_SLIDER_MAX}
				step={1}
				value={sliderValue}
				disabled={isInfinite}
				onChange={(e) => {
					const v = parseInt(e.target.value, 10);
					setLastFinite(v);
					onChange(v);
				}}
				style={{
					width: '100%',
					height: 4,
					borderRadius: 4,
					appearance: 'none',
					accentColor: CUE_COLOR,
					cursor: isInfinite ? 'not-allowed' : 'pointer',
					opacity: isInfinite ? 0.35 : 1,
					background: `linear-gradient(to right, ${CUE_COLOR} 0%, ${CUE_COLOR} ${percent}%, ${theme.colors.bgActivity} ${percent}%, ${theme.colors.bgActivity} 100%)`,
				}}
			/>
			<label
				style={{
					display: 'flex',
					alignItems: 'center',
					gap: 6,
					marginTop: 6,
					cursor: 'pointer',
					fontSize: 12,
					color: theme.colors.textDim,
				}}
			>
				<input
					type="checkbox"
					checked={isInfinite}
					onChange={(e) => onChange(e.target.checked ? UNLIMITED_NOTIFICATIONS : lastFinite)}
					style={{ accentColor: CUE_COLOR }}
				/>
				<span>Infinite</span>
			</label>
		</div>
	);
}

function clampSliderValue(n: number): number {
	if (n < MAX_NOTIFICATIONS_SLIDER_MIN) return MAX_NOTIFICATIONS_SLIDER_MIN;
	if (n > MAX_NOTIFICATIONS_SLIDER_MAX) return MAX_NOTIFICATIONS_SLIDER_MAX;
	return n;
}
