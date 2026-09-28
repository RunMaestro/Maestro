import { Keyboard } from 'lucide-react';
import type { Theme } from '../../../../../types';
import { formatShortcutKeys } from '../../../../../utils/shortcutFormatter';
import { KeyCaptureButton } from '../../../../ui/KeyCaptureButton';
import { SettingsSectionHeading } from '../../../SettingsSectionHeading';

interface GlobalHotkeySectionProps {
	theme: Theme;
	globalShowHotkey: string[];
	setGlobalShowHotkey: (keys: string[]) => void;
}

export function GlobalHotkeySection({
	theme,
	globalShowHotkey,
	setGlobalShowHotkey,
}: GlobalHotkeySectionProps) {
	return (
		<div data-setting-id="general-global-show-hotkey">
			<SettingsSectionHeading icon={Keyboard}>Global Hotkey to Show Maestro</SettingsSectionHeading>
			<p className="text-xs opacity-70 mb-2">
				System-wide shortcut that brings Maestro to the foreground from any app. Works on macOS,
				Windows, and Linux. Leave blank to disable. (Tip: pick something with two modifiers, e.g.{' '}
				{formatShortcutKeys(['Meta', 'Shift', 'M'])}, to avoid clashes.)
			</p>
			<div className="flex justify-center">
				<KeyCaptureButton
					theme={theme}
					keys={globalShowHotkey}
					onKeysChange={setGlobalShowHotkey}
					emptyLabel="Click to set hotkey"
				/>
			</div>
		</div>
	);
}
