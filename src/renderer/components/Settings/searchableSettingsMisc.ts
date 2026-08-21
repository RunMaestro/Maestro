/**
 * Shortcuts, Theme, SSH, Environment, Prompts, and About tab searchable-settings entries.
 *
 * Part of the searchableSettings.ts domain-file split, mirroring the
 * settingsStore.ts / settingsMetadata.ts slice decomposition (see
 * settingsAnnotatorSlice.ts for that pattern).
 */

import type { SearchableSetting } from './searchableSettings';

export const SHORTCUTS_SETTINGS: SearchableSetting[] = [
	{
		id: 'shortcuts-tab',
		tab: 'shortcuts',
		tabLabel: 'Shortcuts',
		label: 'Keyboard Shortcuts',
		description: 'Configure keyboard shortcuts for general and AI tab actions',
		keywords: ['keyboard', 'shortcut', 'hotkey', 'keybind', 'binding', 'key'],
	},
];

// ---------------------------------------------------------------------------
// Theme Tab
// ---------------------------------------------------------------------------
export const THEME_SETTINGS: SearchableSetting[] = [
	{
		id: 'theme-picker',
		tab: 'theme',
		tabLabel: 'Themes',
		label: 'Theme Selection',
		description: 'Choose from dark, light, and vibe themes or create a custom theme',
		keywords: ['theme', 'dark', 'light', 'vibe', 'color', 'appearance', 'mode', 'custom'],
	},
];
export const SSH_SETTINGS: SearchableSetting[] = [
	{
		id: 'ssh-remotes',
		tab: 'ssh',
		tabLabel: 'SSH Hosts',
		label: 'SSH Remote Hosts',
		description:
			'Configure SSH hosts for remote agent execution; test connections before assigning them to agents',
		keywords: [
			'ssh',
			'remote',
			'host',
			'server',
			'connection',
			'agent',
			'execute',
			'test',
			'remote execution',
			'tunnel',
		],
	},
	{
		id: 'ssh-ignore-patterns',
		tab: 'ssh',
		tabLabel: 'SSH Hosts',
		label: 'SSH Remote Ignore Patterns',
		description: 'Glob patterns for folders to exclude when indexing remote files',
		keywords: ['ssh', 'ignore', 'patterns', 'remote', 'glob', 'gitignore'],
	},
];

// ---------------------------------------------------------------------------
// Environment Tab
// ---------------------------------------------------------------------------
export const ENVIRONMENT_SETTINGS: SearchableSetting[] = [
	{
		id: 'environment-global-vars',
		tab: 'environment',
		tabLabel: 'Environment',
		label: 'Global Environment Variables',
		description: 'Variables that apply to all terminal sessions and AI agents',
		keywords: ['env', 'environment', 'variable', 'api key', 'proxy', 'path', 'global'],
	},
];
export const PROMPTS_SETTINGS: SearchableSetting[] = [
	{
		id: 'prompts-editor',
		tab: 'prompts',
		tabLabel: 'Maestro Prompts',
		label: 'Maestro Prompts',
		description:
			'Edit core system prompts by category - Wizard, Inline Wizard, Auto Run, Group Chat, Context, and other Maestro reference includes',
		keywords: [
			'prompt',
			'system prompt',
			'wizard prompt',
			'autorun prompt',
			'auto run prompt',
			'customize',
			'wizard',
			'inline wizard',
			'group chat',
			'context',
			'category',
			'reference',
			'include',
			'maestro prompts',
		],
	},
];

// ---------------------------------------------------------------------------
// About Tab
// ---------------------------------------------------------------------------
export const ABOUT_SETTINGS: SearchableSetting[] = [
	{
		id: 'about-maestro',
		tab: 'about',
		tabLabel: 'About',
		label: 'About Maestro',
		description: 'Maestro version, tagline, and origin - born on Nov 26, 2025 in Austin, TX',
		keywords: [
			'about',
			'version',
			'maestro',
			'tagline',
			'origin',
			'austin',
			'texas',
			'born',
			'commit',
			'build',
		],
	},
];
