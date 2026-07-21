import type { Theme } from '../../types';
import { isMacOSPlatform } from '../../utils/platformUtils';
import { formatShortcutKeys } from '../../utils/shortcutFormatter';

export interface ShortcutHintProps {
	keys: string[];
	theme: Theme;
	/**
	 * The hint supplements an adjacent action label, so `note` is the useful
	 * semantic role. Omit it only when the containing control already names the
	 * shortcut without relying on this visual hint.
	 */
	metadataRole?: 'note';
}

function formatShortcutAriaLabel(keys: string[]): string {
	const isMac = isMacOSPlatform();

	return keys
		.map((key) => {
			switch (key.toLowerCase()) {
				case 'meta':
				case 'command':
				case 'cmd':
					return isMac ? 'Command' : 'Ctrl';
				case 'control':
				case 'ctrl':
					return 'Control';
				case 'alt':
					return isMac ? 'Option' : 'Alt';
				case 'shift':
					return 'Shift';
				case 'arrowup':
					return 'Arrow Up';
				case 'arrowdown':
					return 'Arrow Down';
				case 'arrowleft':
					return 'Arrow Left';
				case 'arrowright':
					return 'Arrow Right';
				case 'backspace':
					return 'Backspace';
				case 'delete':
					return 'Delete';
				case 'enter':
				case 'return':
					return 'Enter';
				case 'escape':
					return 'Escape';
				case 'space':
					return 'Space';
				default:
					return key.length === 1 ? key.toUpperCase() : key;
			}
		})
		.join(' ');
}

export function ShortcutHint({ keys, theme, metadataRole = 'note' }: ShortcutHintProps) {
	return (
		<span
			role={metadataRole}
			aria-label={metadataRole ? `Keyboard shortcut: ${formatShortcutAriaLabel(keys)}` : undefined}
			className="ml-auto text-[10px] font-mono px-1.5 py-0.5 rounded"
			style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textDim }}
		>
			{formatShortcutKeys(keys)}
		</span>
	);
}
