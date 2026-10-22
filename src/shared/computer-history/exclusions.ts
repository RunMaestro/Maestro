/**
 * Computer History - built-in exclusions (pure, always on, not editable).
 *
 * Apps on this list are sent to the helper as `blockApps` (it never reads
 * anything from them, not even an `app.activated`) and re-checked on every
 * ingested event in case a helper build ever gets it wrong. Users add their
 * own exclusions as rules; they cannot remove these.
 *
 * Each entry names an app once and lists how the helper identifies it per
 * platform (see Plans/computer-history-plan.md): macOS bundle ids, Windows
 * lowercase exe names, Linux desktop ids or lowercase exe names. `names` are
 * the app's display names, blocked wherever the entry applies: the helper
 * matches a block by id OR display name, so a name catches a build whose id
 * differs from the one listed here. Matching is case-insensitive, so everything is
 * kept lowercase except the display label.
 */

import type { ObservedPlatform } from './types';

export type BuiltInExclusionCategory =
	| 'password-manager'
	| 'authenticator'
	| 'crypto-wallet'
	| 'system-auth'
	| 'maestro';

/** Display order and headings for the categories. */
export const BUILT_IN_EXCLUSION_CATEGORIES: readonly {
	id: BuiltInExclusionCategory;
	label: string;
}[] = [
	{ id: 'password-manager', label: 'Password managers' },
	{ id: 'authenticator', label: 'Authenticators' },
	{ id: 'crypto-wallet', label: 'Crypto wallets' },
	{ id: 'system-auth', label: 'System password prompts' },
	{ id: 'maestro', label: 'Maestro' },
];

interface BuiltInExclusion {
	label: string;
	category: BuiltInExclusionCategory;
	/** Display names blocked wherever the entry applies (lowercase). */
	names?: readonly string[];
	ids: Partial<Record<ObservedPlatform, readonly string[]>>;
}

/** One built-in exclusion as shown to the user for one platform. */
export interface BuiltInExclusionView {
	label: string;
	category: BuiltInExclusionCategory;
}

const BUILT_IN_EXCLUSIONS: readonly BuiltInExclusion[] = [
	// Password managers and credential stores
	{
		label: '1Password',
		category: 'password-manager',
		names: ['1password', '1password 7'],
		ids: {
			// 1Password 8, 7, and older, plus the browser and Safari helpers.
			macos: [
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
			],
			windows: ['1password.exe', '1password-browsersupport.exe', 'agilebits.onepassword.exe'],
			linux: ['1password', 'com.1password.1password'],
		},
	},
	{
		label: 'Bitwarden',
		category: 'password-manager',
		names: ['bitwarden'],
		ids: {
			macos: ['com.bitwarden.desktop', 'com.bitwarden.desktop.safari'],
			windows: ['bitwarden.exe'],
			linux: ['bitwarden', 'com.bitwarden.desktop'],
		},
	},
	{
		label: 'Dashlane',
		category: 'password-manager',
		names: ['dashlane'],
		ids: {
			macos: ['com.dashlane.dashlane', 'com.dashlane.dashlanephonefinal'],
			windows: ['dashlane.exe', 'dashlaneplugin.exe'],
		},
	},
	{
		label: 'LastPass',
		category: 'password-manager',
		names: ['lastpass'],
		ids: {
			macos: ['com.lastpass.lastpass', 'com.lastpass.lastpassmacdesktop'],
			windows: ['lastpass.exe'],
		},
	},
	{
		label: 'Proton Pass',
		category: 'password-manager',
		names: ['proton pass'],
		ids: {
			macos: ['me.proton.pass.electron'],
			windows: ['proton pass.exe', 'protonpass.exe'],
			linux: ['proton-pass', 'proton.pass'],
		},
	},
	{
		label: 'NordPass',
		category: 'password-manager',
		names: ['nordpass'],
		ids: {
			macos: ['com.nordsec.nordpass'],
			windows: ['nordpass.exe'],
			linux: ['nordpass'],
		},
	},
	{
		label: 'Keeper',
		category: 'password-manager',
		names: ['keeper password manager'],
		ids: {
			macos: ['com.keepersecurity.passwordmanager', 'com.callpod.keepermac.lite'],
			windows: ['keeperpasswordmanager.exe'],
		},
	},
	{
		label: 'Enpass',
		category: 'password-manager',
		names: ['enpass'],
		ids: {
			macos: ['in.sinew.enpass-desktop', 'in.sinew.walletx'],
			windows: ['enpass.exe'],
			linux: ['enpass'],
		},
	},
	{
		label: 'RoboForm',
		category: 'password-manager',
		names: ['roboform'],
		ids: {
			macos: ['com.siber.roboform'],
			windows: ['roboform.exe', 'robotaskbaricon.exe'],
		},
	},
	{
		label: 'KeePassXC',
		category: 'password-manager',
		names: ['keepassxc'],
		ids: {
			macos: ['org.keepassxc.keepassxc'],
			windows: ['keepassxc.exe'],
			linux: ['keepassxc', 'org.keepassxc.keepassxc'],
		},
	},
	{
		label: 'KeePass',
		category: 'password-manager',
		names: ['keepass'],
		ids: { windows: ['keepass.exe'], linux: ['keepass2'] },
	},
	{
		label: 'KeePassium',
		category: 'password-manager',
		names: ['keepassium'],
		ids: { macos: ['com.keepassium.ios'] },
	},
	{
		label: 'Strongbox',
		category: 'password-manager',
		names: ['strongbox'],
		ids: { macos: ['com.markmcguill.strongbox.mac', 'com.markmcguill.strongbox.mac.pro'] },
	},
	{
		label: 'MacPass',
		category: 'password-manager',
		names: ['macpass'],
		ids: { macos: ['com.hicknhacksoftware.macpass'] },
	},
	{
		label: 'Secrets',
		category: 'password-manager',
		ids: { macos: ['com.outercorner.secrets'] },
	},
	{
		label: 'Apple Passwords',
		category: 'password-manager',
		names: ['passwords'],
		ids: { macos: ['com.apple.passwords'] },
	},
	{
		label: 'Keychain Access',
		category: 'password-manager',
		names: ['keychain access'],
		ids: { macos: ['com.apple.keychainaccess'] },
	},
	{
		label: 'Windows Credential Manager',
		category: 'password-manager',
		ids: { windows: ['credwiz.exe', 'credentialenrollmentmanager.exe'] },
	},
	{
		label: 'GNOME Passwords and Keys',
		category: 'password-manager',
		names: ['passwords and keys'],
		ids: { linux: ['seahorse', 'org.gnome.seahorse.application'] },
	},
	{
		label: 'KDE Wallet',
		category: 'password-manager',
		names: ['kwalletmanager'],
		ids: {
			linux: [
				'kwalletmanager',
				'kwalletmanager5',
				'org.kde.kwalletmanager5',
				'org.kde.kwalletmanager',
			],
		},
	},

	// Authenticators (one-time codes)
	{
		label: 'Authy',
		category: 'authenticator',
		names: ['authy desktop', 'authy'],
		ids: {
			macos: ['com.authy.authy-mac'],
			windows: ['authy desktop.exe'],
			linux: ['authy'],
		},
	},
	{
		label: 'Yubico Authenticator',
		category: 'authenticator',
		names: ['yubico authenticator'],
		ids: { macos: ['com.yubico.authenticator', 'com.yubico.yubioath'] },
	},
	{ label: 'Ente Auth', category: 'authenticator', names: ['ente auth'], ids: {} },
	{ label: '2FAS', category: 'authenticator', names: ['2fas'], ids: {} },
	{ label: 'Step Two', category: 'authenticator', names: ['step two'], ids: {} },
	{ label: 'OTP Auth', category: 'authenticator', names: ['otp auth'], ids: {} },
	{ label: 'Raivo OTP', category: 'authenticator', names: ['raivo otp'], ids: {} },

	// Crypto wallets (seed phrases and keys on screen)
	{
		label: 'Ledger Live',
		category: 'crypto-wallet',
		names: ['ledger live'],
		ids: {
			macos: ['com.ledger.live'],
			windows: ['ledger live.exe'],
			linux: ['ledger-live-desktop'],
		},
	},
	{
		label: 'Trezor Suite',
		category: 'crypto-wallet',
		names: ['trezor suite'],
		ids: {
			macos: ['io.trezor.trezorsuite'],
			windows: ['trezor suite.exe'],
			linux: ['trezor-suite'],
		},
	},
	{
		label: 'Exodus',
		category: 'crypto-wallet',
		names: ['exodus'],
		ids: { macos: ['com.electron.exodus'], windows: ['exodus.exe'], linux: ['exodus'] },
	},
	{
		label: 'Electrum',
		category: 'crypto-wallet',
		names: ['electrum'],
		ids: { macos: ['org.electrum.electrum'], windows: ['electrum.exe'], linux: ['electrum'] },
	},
	{
		label: 'Sparrow Wallet',
		category: 'crypto-wallet',
		ids: { macos: ['com.sparrowwallet.sparrow'], windows: ['sparrow.exe'], linux: ['sparrow'] },
	},
	{ label: 'Wasabi Wallet', category: 'crypto-wallet', names: ['wasabi wallet'], ids: {} },

	// The OS asking for a password, Touch ID, or an admin approval
	{
		label: 'Touch ID and password prompts',
		category: 'system-auth',
		names: ['coreautha', 'securityagent'],
		ids: { macos: ['com.apple.localauthentication.uiagent', 'com.apple.securityagent'] },
	},
	{
		label: 'Windows sign-in and UAC prompts',
		category: 'system-auth',
		ids: { windows: ['credentialuibroker.exe', 'consent.exe', 'logonui.exe'] },
	},
	{
		label: 'Polkit authentication agents',
		category: 'system-auth',
		ids: {
			linux: [
				'polkit-gnome-authentication-agent-1',
				'polkit-kde-authentication-agent-1',
				'org.kde.polkit-kde-authentication-agent-1',
				'lxpolkit',
			],
		},
	},

	// D9: never record Maestro itself.
	{
		label: 'Maestro',
		category: 'maestro',
		ids: {
			macos: ['com.maestro.app'],
			windows: ['maestro.exe'],
			linux: ['maestro', 'com.maestro.app'],
		},
	},
];

/** Whether an entry applies on `platform`: it has ids there, or matches by name only. */
function appliesOn(entry: BuiltInExclusion, platform: ObservedPlatform): boolean {
	return (entry.ids[platform]?.length ?? 0) > 0 || Object.keys(entry.ids).length === 0;
}

/**
 * Built-in blocked values for one platform (lowercase): the ids and display
 * names of the entries that apply there, so this is exactly what
 * `builtInExclusions(platform)` shows. Sent to the helper as `blockApps`.
 */
export function builtInBlockedApps(platform: ObservedPlatform): string[] {
	const out = new Set<string>();
	for (const entry of BUILT_IN_EXCLUSIONS) {
		if (!appliesOn(entry, platform)) continue;
		for (const id of entry.ids[platform] ?? []) out.add(id);
		for (const name of entry.names ?? []) out.add(name);
	}
	return [...out];
}

/** The built-in exclusions that apply on `platform` (grouped by category). */
export function builtInExclusions(platform: ObservedPlatform): BuiltInExclusionView[] {
	return BUILT_IN_EXCLUSIONS.filter((e) => appliesOn(e, platform)).map(({ label, category }) => ({
		label,
		category,
	}));
}

const ALL_BUILT_IN_IDS: ReadonlySet<string> = new Set(
	BUILT_IN_EXCLUSIONS.flatMap((e) => Object.values(e.ids).flat())
);
const ALL_BUILT_IN_NAMES: ReadonlySet<string> = new Set(
	BUILT_IN_EXCLUSIONS.flatMap((e) => e.names ?? [])
);

/**
 * The ingest re-check, a platform-agnostic backstop behind the helper: the
 * app's id is a built-in id on ANY platform, or its display name is any
 * built-in name. Ids never match names, so a Linux id that is a plain word
 * cannot block a same-named app on macOS.
 */
export function isBuiltInBlockedApp(app: { id?: string; name?: string }): boolean {
	const id = app.id?.trim().toLowerCase();
	const name = app.name?.trim().toLowerCase();
	return (!!id && ALL_BUILT_IN_IDS.has(id)) || (!!name && ALL_BUILT_IN_NAMES.has(name));
}

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
