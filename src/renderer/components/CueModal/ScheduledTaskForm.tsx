/**
 * ScheduledTaskForm - create or edit one Scheduled Task.
 *
 * Renders in place of the task list inside the Scheduled Tasks tab rather than
 * as a nested modal: the Cue modal already owns a layer, and a second layer for
 * a form this small buys nothing but Escape-handling ambiguity.
 *
 * Editing deliberately locks the agent and the recurrence kind. Both are
 * identity-ish on disk (the kind IS the Cue event, and the agent owns the
 * cue.yaml the task lives in), so changing either means deleting and recreating
 * - which the Cancel + New buttons already express honestly.
 */

import { useMemo, useState } from 'react';
import { Check, X } from 'lucide-react';
import type { Theme } from '../../types';
import { FormInput } from '../ui/FormInput';
import { ToggleSwitch } from '../ui/ToggleSwitch';
import { CUE_SCHEDULE_DAYS, type CueScheduleDay } from '../../../shared/cue/contracts';
import {
	DEFAULT_SCHEDULED_TASK_PIPELINE,
	MAX_SCHEDULE_MINUTES,
	normalizeScheduleTime,
	parseScheduleDuration,
	type ScheduledTask,
	type ScheduledTaskCreateInput,
	type ScheduledTaskKind,
	type ScheduledTaskUpdateInput,
} from '../../../shared/cue/scheduled-tasks';

export interface ScheduledTaskFormAgent {
	id: string;
	name: string;
}

export interface ScheduledTaskFormProps {
	theme: Theme;
	agents: ScheduledTaskFormAgent[];
	/** Agent pre-selected when creating. Ignored when editing. */
	defaultAgentId?: string;
	/** Task being edited; omit to create a new one. */
	task?: ScheduledTask;
	onCancel: () => void;
	onCreate: (input: ScheduledTaskCreateInput) => Promise<boolean>;
	onUpdate: (task: ScheduledTask, patch: ScheduledTaskUpdateInput) => Promise<boolean>;
}

const KIND_OPTIONS: { value: ScheduledTaskKind; label: string; hint: string }[] = [
	{ value: 'once', label: 'Once', hint: 'Fires a single time, then removes itself' },
	{ value: 'daily', label: 'At set times', hint: 'Fires at chosen times on chosen days' },
	{ value: 'interval', label: 'Every N minutes', hint: 'Fires on a fixed interval' },
];

/** `YYYY-MM-DDTHH:MM` in local time, which is what `datetime-local` wants. */
function toLocalInputValue(date: Date): string {
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Quick-pick offsets for a one-shot, expressed as CLI-style durations. */
const QUICK_OFFSETS = ['15m', '1h', '4h', '1d'];

export function ScheduledTaskForm({
	theme,
	agents,
	defaultAgentId,
	task,
	onCancel,
	onCreate,
	onUpdate,
}: ScheduledTaskFormProps) {
	const isEdit = task !== undefined;

	const [agentId, setAgentId] = useState(
		() => task?.agentId ?? defaultAgentId ?? agents[0]?.id ?? ''
	);
	const [kind, setKind] = useState<ScheduledTaskKind>(task?.kind ?? 'once');
	const [fireAtLocal, setFireAtLocal] = useState(() =>
		toLocalInputValue(task?.fireAt ? new Date(task.fireAt) : new Date(Date.now() + 15 * 60_000))
	);
	const [times, setTimes] = useState(() => (task?.scheduleTimes ?? ['09:00']).join(', '));
	const [days, setDays] = useState<CueScheduleDay[]>(() => task?.scheduleDays ?? []);
	const [intervalMinutes, setIntervalMinutes] = useState(() => String(task?.intervalMinutes ?? 60));
	const [prompt, setPrompt] = useState(() =>
		task?.action === 'notify' ? '' : (task?.prompt ?? '')
	);
	const [notifyEnabled, setNotifyEnabled] = useState(() => task?.action === 'notify');
	const [notifyMessage, setNotifyMessage] = useState(() => task?.notifyMessage ?? '');
	const [notifySticky, setNotifySticky] = useState(() => task?.notifySticky === true);
	const [label, setLabel] = useState(() => task?.label ?? '');
	const [pipeline, setPipeline] = useState(() => task?.pipelineName ?? '');
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const parsedTimes = useMemo(() => {
		const entries = times
			.split(',')
			.map((entry) => entry.trim())
			.filter((entry) => entry.length > 0);
		const normalized: string[] = [];
		for (const entry of entries) {
			const value = normalizeScheduleTime(entry);
			if (!value) return null;
			normalized.push(value);
		}
		return normalized.length > 0 ? normalized : null;
	}, [times]);

	const validationError = useMemo(() => {
		if (!agentId) return 'Pick an agent to run the task.';
		if (!prompt.trim() && !notifyEnabled) return 'Add a prompt, a notification, or both.';
		if (notifyEnabled && !notifyMessage.trim() && !prompt.trim()) {
			return 'A notification needs a message.';
		}
		if (kind === 'once' && !fireAtLocal) return 'Pick a date and time.';
		if (kind === 'daily' && !parsedTimes) return 'Times must be HH:MM, separated by commas.';
		if (kind === 'interval') {
			const minutes = Number(intervalMinutes);
			if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_SCHEDULE_MINUTES) {
				return `Interval must be a whole number of minutes between 1 and ${MAX_SCHEDULE_MINUTES}.`;
			}
		}
		return null;
	}, [
		agentId,
		prompt,
		notifyEnabled,
		notifyMessage,
		kind,
		fireAtLocal,
		parsedTimes,
		intervalMinutes,
	]);

	function applyQuickOffset(duration: string) {
		const ms = parseScheduleDuration(duration);
		if (ms === null) return;
		setFireAtLocal(toLocalInputValue(new Date(Date.now() + ms)));
	}

	function toggleDay(day: CueScheduleDay) {
		setDays((prev) =>
			prev.includes(day)
				? prev.filter((entry) => entry !== day)
				: CUE_SCHEDULE_DAYS.filter((entry) => entry === day || prev.includes(entry))
		);
	}

	async function handleSubmit() {
		if (validationError) {
			setError(validationError);
			return;
		}
		setError(null);
		setSaving(true);
		try {
			const notify = notifyEnabled
				? { message: notifyMessage.trim() || prompt.trim(), sticky: notifySticky }
				: undefined;

			if (isEdit && task) {
				const patch: ScheduledTaskUpdateInput = {
					label: label.trim() || undefined,
				};
				if (task.action === 'notify') {
					if (notify) patch.notify = notify;
				} else {
					patch.prompt = prompt;
				}
				if (kind === 'once') patch.fireAt = new Date(fireAtLocal).toISOString();
				if (kind === 'daily') {
					patch.scheduleTimes = parsedTimes ?? undefined;
					patch.scheduleDays = days;
				}
				if (kind === 'interval') patch.intervalMinutes = Number(intervalMinutes);
				const ok = await onUpdate(task, patch);
				if (ok) onCancel();
				return;
			}

			const input: ScheduledTaskCreateInput = {
				agentId,
				kind,
				fireAt: kind === 'once' ? new Date(fireAtLocal).toISOString() : undefined,
				scheduleTimes: kind === 'daily' ? (parsedTimes ?? undefined) : undefined,
				scheduleDays: kind === 'daily' && days.length > 0 ? days : undefined,
				intervalMinutes: kind === 'interval' ? Number(intervalMinutes) : undefined,
				prompt: prompt.trim() ? prompt : undefined,
				notify,
				label: label.trim() || undefined,
				pipelineName: pipeline.trim() || undefined,
			};
			const ok = await onCreate(input);
			if (ok) onCancel();
		} finally {
			setSaving(false);
		}
	}

	const fieldStyle = {
		backgroundColor: theme.colors.bgActivity,
		borderColor: theme.colors.border,
		color: theme.colors.textMain,
	};

	return (
		<div className="flex flex-col gap-4 select-text">
			<div className="flex items-center justify-between">
				<h3 className="text-sm font-semibold" style={{ color: theme.colors.textMain }}>
					{isEdit ? `Edit "${task?.name}"` : 'New scheduled task'}
				</h3>
				<button
					onClick={onCancel}
					className="flex items-center gap-1 px-2 py-1 rounded text-xs"
					style={{ color: theme.colors.textDim }}
				>
					<X className="w-3.5 h-3.5" />
					Cancel
				</button>
			</div>

			{/* Agent */}
			<label className="flex flex-col gap-1">
				<span className="text-xs font-medium" style={{ color: theme.colors.textDim }}>
					Agent
				</span>
				<select
					value={agentId}
					onChange={(e) => setAgentId(e.target.value)}
					disabled={isEdit}
					className="px-2 py-1.5 rounded border text-sm disabled:opacity-60"
					style={fieldStyle}
				>
					{agents.map((agent) => (
						<option key={agent.id} value={agent.id}>
							{agent.name}
						</option>
					))}
				</select>
			</label>

			{/* Recurrence */}
			<div className="flex flex-col gap-1">
				<span className="text-xs font-medium" style={{ color: theme.colors.textDim }}>
					Repeats
				</span>
				<div className="flex gap-2">
					{KIND_OPTIONS.map((option) => {
						const isActive = kind === option.value;
						return (
							<button
								key={option.value}
								onClick={() => setKind(option.value)}
								disabled={isEdit}
								title={option.hint}
								className="px-3 py-1.5 rounded text-xs font-medium disabled:opacity-60"
								style={{
									backgroundColor: isActive ? `${theme.colors.accent}20` : theme.colors.bgActivity,
									color: isActive ? theme.colors.accent : theme.colors.textDim,
									border: `1px solid ${isActive ? theme.colors.accent : theme.colors.border}`,
								}}
							>
								{option.label}
							</button>
						);
					})}
				</div>
			</div>

			{/* Timing */}
			{kind === 'once' && (
				<div className="flex flex-col gap-2">
					<label className="flex flex-col gap-1">
						<span className="text-xs font-medium" style={{ color: theme.colors.textDim }}>
							Fires at
						</span>
						<input
							type="datetime-local"
							value={fireAtLocal}
							onChange={(e) => setFireAtLocal(e.target.value)}
							className="px-2 py-1.5 rounded border text-sm"
							style={fieldStyle}
						/>
					</label>
					<div className="flex items-center gap-2">
						<span className="text-xs" style={{ color: theme.colors.textDim }}>
							In
						</span>
						{QUICK_OFFSETS.map((offset) => (
							<button
								key={offset}
								onClick={() => applyQuickOffset(offset)}
								className="px-2 py-0.5 rounded text-xs"
								style={{
									backgroundColor: theme.colors.bgActivity,
									color: theme.colors.textDim,
									border: `1px solid ${theme.colors.border}`,
								}}
							>
								{offset}
							</button>
						))}
					</div>
				</div>
			)}

			{kind === 'daily' && (
				<div className="flex flex-col gap-2">
					<FormInput
						theme={theme}
						label="Times (HH:MM, comma separated)"
						value={times}
						onChange={setTimes}
						placeholder="09:00, 17:30"
						error={parsedTimes ? undefined : 'Use 24-hour HH:MM values.'}
					/>
					<div className="flex flex-col gap-1">
						<span className="text-xs font-medium" style={{ color: theme.colors.textDim }}>
							Days (none selected = every day)
						</span>
						<div className="flex gap-1">
							{CUE_SCHEDULE_DAYS.map((day) => {
								const isActive = days.includes(day);
								return (
									<button
										key={day}
										onClick={() => toggleDay(day)}
										className="px-2 py-1 rounded text-xs uppercase"
										style={{
											backgroundColor: isActive
												? `${theme.colors.accent}20`
												: theme.colors.bgActivity,
											color: isActive ? theme.colors.accent : theme.colors.textDim,
											border: `1px solid ${isActive ? theme.colors.accent : theme.colors.border}`,
										}}
									>
										{day}
									</button>
								);
							})}
						</div>
					</div>
				</div>
			)}

			{kind === 'interval' && (
				<FormInput
					theme={theme}
					label="Every (minutes)"
					value={intervalMinutes}
					onChange={setIntervalMinutes}
					placeholder="60"
					helperText={`1 to ${MAX_SCHEDULE_MINUTES} minutes (7 days).`}
				/>
			)}

			{/* Action */}
			<label className="flex flex-col gap-1">
				<span className="text-xs font-medium" style={{ color: theme.colors.textDim }}>
					Prompt to send
				</span>
				<textarea
					value={prompt}
					onChange={(e) => setPrompt(e.target.value)}
					rows={3}
					placeholder="Summarize what landed on rc today and post it to the log."
					className="px-2 py-1.5 rounded border text-sm resize-y"
					style={fieldStyle}
				/>
			</label>

			<div className="flex flex-col gap-2">
				<div className="flex items-center gap-2">
					<ToggleSwitch
						checked={notifyEnabled}
						onChange={setNotifyEnabled}
						theme={theme}
						ariaLabel="Show a notification when this task fires"
					/>
					<span className="text-xs" style={{ color: theme.colors.textMain }}>
						Also show a toast notification
					</span>
				</div>
				{notifyEnabled && (
					<div className="flex flex-col gap-2 pl-1">
						<FormInput
							theme={theme}
							value={notifyMessage}
							onChange={setNotifyMessage}
							placeholder="Notification text (defaults to the prompt)"
						/>
						<div className="flex items-center gap-2">
							<ToggleSwitch
								checked={notifySticky}
								onChange={setNotifySticky}
								theme={theme}
								ariaLabel="Keep the notification until dismissed"
							/>
							<span className="text-xs" style={{ color: theme.colors.textDim }}>
								Keep it on screen until dismissed
							</span>
						</div>
					</div>
				)}
			</div>

			<div className="grid grid-cols-2 gap-3">
				<FormInput
					theme={theme}
					label="Label (optional)"
					value={label}
					onChange={setLabel}
					placeholder="Shown in the task list"
				/>
				{!isEdit && (
					<FormInput
						theme={theme}
						label="Pipeline (optional)"
						value={pipeline}
						onChange={setPipeline}
						placeholder={DEFAULT_SCHEDULED_TASK_PIPELINE}
					/>
				)}
			</div>

			{(error || validationError) && (
				<div className="text-xs" style={{ color: theme.colors.error }}>
					{error ?? validationError}
				</div>
			)}

			<div className="flex justify-end gap-2">
				<button
					onClick={onCancel}
					className="px-3 py-1.5 rounded text-xs"
					style={{ color: theme.colors.textDim, border: `1px solid ${theme.colors.border}` }}
				>
					Cancel
				</button>
				<button
					onClick={handleSubmit}
					disabled={saving || validationError !== null}
					className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium disabled:opacity-50"
					style={{ backgroundColor: theme.colors.accent, color: theme.colors.bgMain }}
				>
					<Check className="w-3.5 h-3.5" />
					{isEdit ? 'Save changes' : 'Schedule task'}
				</button>
			</div>
		</div>
	);
}
