export interface ShortcutMatchEvent {
	key: string;
	code?: string;
	metaKey: boolean;
	ctrlKey: boolean;
	altKey: boolean;
	shiftKey: boolean;
}

export interface ShortcutMatchOptions {
	/** Require the physical Meta and Control keys instead of treating them as aliases. */
	requirePhysicalMetaAndCtrl?: boolean;
}

const META_ALIASES: Record<string, true> = {
	meta: true,
	ctrl: true,
	control: true,
	command: true,
	cmd: true,
};
const SHIFTED_PUNCTUATION: Record<string, string> = {
	'{': '[',
	'}': ']',
	'<': ',',
	'>': '.',
	'!': '1',
	'@': '2',
	'#': '3',
	$: '4',
	'%': '5',
	'^': '6',
	'&': '7',
	'*': '8',
	'(': '9',
	')': '0',
};
const CODE_TO_KEY: Record<string, string> = {
	Comma: ',',
	Period: '.',
	Slash: '/',
	Backslash: '\\',
	BracketLeft: '[',
	BracketRight: ']',
	Semicolon: ';',
	Quote: "'",
	Backquote: '`',
	Minus: '-',
	Equal: '=',
};

function getCodeKey(code: string): string | null {
	if (code.startsWith('Key')) return code.slice(3).toLowerCase();
	if (code.startsWith('Digit')) return code.slice(5);
	return CODE_TO_KEY[code] ?? null;
}

/**
 * Match a keyboard event to configured key tokens without making any decision
 * about shortcut dispatch, repeated events, or editable targets.
 */
export function matchesShortcut(
	event: ShortcutMatchEvent,
	shortcutKeys: string[],
	options: ShortcutMatchOptions = {}
): boolean {
	if (shortcutKeys.length === 0) return false;

	const keys = shortcutKeys.map((key) => key.toLowerCase());
	const wantsMeta = keys.some((key) => META_ALIASES[key] === true);
	const wantsShift = keys.includes('shift');
	const wantsAlt = keys.includes('alt');

	if (options.requirePhysicalMetaAndCtrl) {
		const wantsCtrl = keys.includes('ctrl') || keys.includes('control');
		const wantsCommand = keys.includes('meta') || keys.includes('command') || keys.includes('cmd');
		if (!wantsCtrl || !wantsCommand || !event.ctrlKey || !event.metaKey) return false;
	} else if ((event.metaKey || event.ctrlKey) !== wantsMeta) {
		return false;
	}

	if (event.shiftKey !== wantsShift || event.altKey !== wantsAlt) return false;

	const mainKey = keys.at(-1);
	if (!mainKey) return false;

	const key = event.key.toLowerCase();
	if (key === mainKey || SHIFTED_PUNCTUATION[key] === mainKey) return true;

	// Layouts can rewrite e.key when Alt/Option is held (including AltGr). The
	// recorder stores the matching physical code in this case, so compare it
	// symmetrically rather than dispatching against a layout-specific character.
	if (event.altKey && event.code) {
		return getCodeKey(event.code) === mainKey;
	}

	return false;
}
