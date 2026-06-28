import { Keyboard } from 'lucide-react';
import type { Theme } from '../../../../../types';
import { formatShortcutKeys } from '../../../../../utils/shortcutFormatter';
import { KeyCaptureButton } from '../../../../ui/KeyCaptureButton';

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
			<div className="block text-xs font-bold opacity-70 uppercase mb-1 flex items-center gap-2">
				<Keyboard className="w-3 h-3" />
				Global Hotkey to Show Maestro
			</div>
			<p className="text-xs opacity-50 mb-2">
				System-wide shortcut that brings Maestro to the foreground from any app. Works on macOS,
				Windows, and Linux. Leave blank to disable. (Tip: pick something with two modifiers, e.g.{' '}
				{formatShortcutKeys(['Meta', 'Shift', 'M'])}, to avoid clashes.)
			</p>
			<KeyCaptureButton
				theme={theme}
				keys={globalShowHotkey}
				onKeysChange={setGlobalShowHotkey}
				emptyLabel="Click to set hotkey"
			/>
		</div>
	);
}
