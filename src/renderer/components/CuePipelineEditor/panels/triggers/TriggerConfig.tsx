/**
 * TriggerConfig — Event-type-specific configuration fields for trigger nodes.
 *
 * Renders form fields based on the trigger's event type (heartbeat, scheduled,
 * file change, agent completed, GitHub PR/issue, task pending).
 */

import { useState, useEffect, useCallback } from 'react';
import type { Theme } from '../../../../types';
import type { PipelineNode, TriggerNodeData } from '../../../../../shared/cue-pipeline-types';
import { useDebouncedCallback } from '../../../../hooks/utils';
import { getInputStyle, getLabelStyle } from './triggerConfigStyles';
import { CueSelect } from '../CueSelect';

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

	const { debouncedCallback: debouncedUpdate } = useDebouncedCallback((...args: unknown[]) => {
		const config = args[0] as TriggerNodeData['config'];
		onUpdateNode(node.id, { config } as Partial<TriggerNodeData>);
	}, 300);

	const { debouncedCallback: debouncedUpdateLabel } = useDebouncedCallback((...args: unknown[]) => {
		const customLabel = (args[0] as string) || undefined;
		onUpdateNode(node.id, { customLabel } as Partial<TriggerNodeData>);
	}, 300);

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
							onChange={(e) => updateConfig('interval_minutes', parseInt(e.target.value) || 1)}
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
		case 'github.issue':
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
							onChange={(e) => updateConfig('poll_minutes', parseInt(e.target.value) || 5)}
							placeholder="5"
							style={themedInputStyle}
						/>
					</label>
				</div>
			);
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
