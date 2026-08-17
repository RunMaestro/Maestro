/**
 * VoiceInputPicker - choose which microphone A Cappella listens to.
 *
 * One component, two placements: `compact` for the HUD's control row, where it
 * sits beside the transcript and mute buttons, and the default for Voice Setup,
 * where it is a labelled row. Both write the same persisted setting, so the
 * "quick" picker is not a separate, temporary choice - changing it in the HUD IS
 * changing the default. Two selectors that disagreed about which microphone is
 * chosen would be worse than having only one.
 *
 * A native `<select>` on purpose. This list can be long (every input the OS
 * exposes, virtual devices included), it needs keyboard search, and the platform
 * control already scrolls and searches. A hand-rolled dropdown here would be a
 * worse version of it that also has to be positioned inside a floating widget.
 */

import type { Theme } from '../../types';
import { ACAPPELLA_SYSTEM_DEFAULT_INPUT } from '../../../shared/acappella/audio-host';
import { deviceLabel, type VoiceInputDevicesState } from './useVoiceInputDevices';

export interface VoiceInputPickerProps {
	theme: Theme;
	devices: VoiceInputDevicesState;
	/** HUD placement: no visible label, smaller type, fills its row. */
	compact?: boolean;
	/** Disabled while a session holds the floor, since a swap waits for the next capture. */
	disabled?: boolean;
}

export function VoiceInputPicker({
	theme,
	devices,
	compact = false,
	disabled = false,
}: VoiceInputPickerProps) {
	const select = (
		<select
			data-testid="voice-input-picker"
			value={devices.selectedId}
			disabled={disabled || devices.loading}
			onChange={(event) => void devices.select(event.target.value)}
			aria-label="Microphone"
			className={`rounded border bg-transparent outline-none ${
				compact ? 'text-[10px] px-1 py-0.5 w-full' : 'text-xs px-2 py-1 w-full'
			}`}
			style={{
				borderColor: theme.colors.border,
				color: theme.colors.textMain,
				backgroundColor: theme.colors.bgMain,
			}}
		>
			{/* Always first, and always present even with no devices enumerated: it is
			    the only option that is guaranteed to resolve to something. */}
			<option value={ACAPPELLA_SYSTEM_DEFAULT_INPUT}>System default</option>
			{devices.devices
				// The OS's own "default" entry is what the sentinel above already
				// means, so listing it again offers the same choice twice under two
				// names - and picking the wrong one pins the device that happens to be
				// default today.
				.filter((device) => device.deviceId && device.deviceId !== 'default')
				.map((device, index) => (
					<option key={device.deviceId} value={device.deviceId}>
						{deviceLabel(device, index)}
					</option>
				))}
		</select>
	);

	if (compact) return select;

	return (
		<label className="flex flex-col gap-1" data-setting-id="encore-a-cappella-input-device">
			<span className="text-xs font-medium" style={{ color: theme.colors.textMain }}>
				Microphone
			</span>
			{select}
			<span className="text-[11px]" style={{ color: theme.colors.textDim }}>
				{disabled
					? 'End the session to change the microphone.'
					: 'Applies to the next voice session.'}
			</span>
		</label>
	);
}
