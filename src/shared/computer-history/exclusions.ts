/**
 * Computer History - built-in exclusions (pure, always on, not editable).
 *
 * Apps on this list are sent to the helper as `blockApps` (it never reads
 * anything from them, not even an `app.activated`) and re-checked on every
 * ingested event in case a helper build ever gets it wrong. Users add their
 * own exclusions as rules; they cannot remove these.
 *
 * Ids follow the helper's `app.id` convention per platform (see
 * Plans/computer-history-plan.md): macOS bundle ids, Windows lowercase exe
 * names, Linux desktop ids or lowercase exe names. Matching is
 * case-insensitive, so the lists are kept lowercase.
 */

import type { ObservedPlatform } from './types';

/** Password managers and credential stores. */
const PASSWORD_MANAGERS: Readonly<Record<ObservedPlatform, readonly string[]>> = {
	macos: [
		// 1Password 8, 7, and older, plus the browser and Safari helpers.
		'com.1password.1password',
		'com.1password.browser-helper',
		'2bua8c4s2c.com.1password.browser-helper',
		'com.1password.safari',
		'com.agilebits.onepassword7',
		'com.agilebits.onepassword7-helper',
		'com.agilebits.onepassword-osx',
		'com.agilebits.onepassword4',
		'com.agilebits.onepassword4-helper',
		'2bua8c4s2c.com.agilebits.onepassword4-helper',
		// Bitwarden
		'com.bitwarden.desktop',
		'com.bitwarden.desktop.safari',
		// Dashlane
		'com.dashlane.dashlane',
		'com.dashlane.dashlanephonefinal',
		// LastPass
		'com.lastpass.lastpass',
		'com.lastpass.lastpassmacdesktop',
		// KeePassXC
		'org.keepassxc.keepassxc',
		// Apple Keychain Access and the Passwords app
		'com.apple.keychainaccess',
		'com.apple.passwords',
	],
	windows: [
		'1password.exe',
		'1password-browsersupport.exe',
		'agilebits.onepassword.exe',
		'bitwarden.exe',
		'dashlane.exe',
		'dashlaneplugin.exe',
		'lastpass.exe',
		'keepassxc.exe',
		// Windows Credential Manager and the credential prompt broker.
		'credwiz.exe',
		'credentialuibroker.exe',
		'credentialenrollmentmanager.exe',
	],
	linux: [
		'1password',
		'com.1password.1password',
		'bitwarden',
		'com.bitwarden.desktop',
		'keepassxc',
		'org.keepassxc.keepassxc',
		// GNOME Passwords and Keys (Seahorse), KDE Wallet
		'seahorse',
		'org.gnome.seahorse.application',
		'kwalletmanager',
		'kwalletmanager5',
		'org.kde.kwalletmanager5',
		'org.kde.kwalletmanager',
	],
};

/** Maestro's own app id per platform (D9: never record Maestro itself). */
const MAESTRO_APP_IDS: Readonly<Record<ObservedPlatform, readonly string[]>> = {
	macos: ['com.maestro.app'],
	windows: ['maestro.exe'],
	linux: ['maestro', 'com.maestro.app'],
};

/** Built-in blocked app ids for one platform (lowercase). */
export function builtInBlockedApps(platform: ObservedPlatform): string[] {
	return [...PASSWORD_MANAGERS[platform], ...MAESTRO_APP_IDS[platform]];
}

/** Every built-in id on every platform (lowercase). Used for re-checks. */
export const ALL_BUILT_IN_BLOCKED_APPS: ReadonlySet<string> = new Set(
	(Object.keys(PASSWORD_MANAGERS) as ObservedPlatform[]).flatMap((p) => builtInBlockedApps(p))
);

/** Map a Node `process.platform` to the helper's platform name. */
export function observedPlatformFor(nodePlatform: string): ObservedPlatform {
	if (nodePlatform === 'darwin') return 'macos';
	if (nodePlatform === 'win32') return 'windows';
	return 'linux';
}

/**
 * Window-title markers of private / incognito browser windows
 * (case-insensitive substring match).
 */
export const PRIVATE_WINDOW_MARKERS: readonly string[] = [
	'incognito',
	'private browsing',
	'inprivate',
	'private window',
];
