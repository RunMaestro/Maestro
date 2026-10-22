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
		description:
			'Configure keyboard shortcuts for general and AI tab actions, and pick the keyboard mode (default or Vim) the bindings come from',
		keywords: [
			'keyboard',
			'shortcut',
			'hotkey',
			'keybind',
			'binding',
			'key',
			'vim',
			'mode',
			'keyboard mode',
			'vim mode',
			'modal',
		],
	},
	{
		id: 'shortcuts-keyboard-mode',
		tab: 'shortcuts',
		tabLabel: 'Shortcuts',
		label: 'Keyboard Mode',
		description:
			'Switch between the Default and Vim key sets. Only one is active at a time, each keeps its own customizations and its own reset, and Vim mode keeps every default chord it does not replace',
		keywords: [
			'keyboard mode',
			'vim',
			'vim mode',
			'default',
			'modal editing',
			'reset to defaults',
			'reset shortcuts',
			'switch',
			'toggle',
		],
	},
	{
		id: 'shortcuts-vim-editor',
		tab: 'shortcuts',
		tabLabel: 'Shortcuts',
		label: 'Vim Keys In The Markdown Editor',
		description:
			'Real Vim editing in the markdown editor - operators, motions, counts and registers, so ciw and dd and 3dw all work. Only read in Vim mode; switch it off to keep Vim navigation everywhere else and type in the editor with the ordinary keys',
		keywords: [
			'vim',
			'vim mode',
			'vim editor',
			'markdown editor',
			'file editor',
			'editor',
			'codemirror',
			'modal editing',
			'normal mode',
			'insert mode',
			'visual mode',
			'operator',
			'motion',
			'register',
			'ciw',
			'dd',
			'text editing',
			'turn off vim editing',
		],
	},
	{
		id: 'shortcuts-vim-insert-escape',
		tab: 'shortcuts',
		tabLabel: 'Shortcuts',
		label: 'Insert Mode Escape',
		description:
			'The characters that leave a text field in Vim mode ("jk" by default), typed in quick succession. They are taken back out of the field and it is blurred, so the normal-mode keys work again. Empty switches it off, and it never applies in the file editor or a terminal',
		keywords: [
			'jk',
			'insert mode',
			'escape',
			'esc',
			'vim',
			'vim mode',
			'blur',
			'text field',
			'composer',
			'normal mode',
			'leave input',
			'exit insert',
		],
	},
];

// ---------------------------------------------------------------------------
// Theme Tab
// ---------------------------------------------------------------------------
export const THEME_SETTINGS: SearchableSetting[] = [
	{
		id: 'theme-surface-gloss',
		tab: 'theme',
		tabLabel: 'Themes',
		label: 'Surface Gloss',
		description:
			'Add a light source to the app chrome so panels read as stacked layers instead of one flat sheet',
		keywords: [
			'gloss',
			'glossy',
			'sheen',
			'shine',
			'intensity',
			'depth',
			'elevation',
			'shadow',
			'highlight',
			'flat',
			'ashy',
			'dull',
			'pop',
			'contrast',
			'chrome',
			'surface',
			'off',
			'strong',
			'max',
		],
	},
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
		id: 'environment-host-media',
		tab: 'environment',
		tabLabel: 'Environment',
		label: 'Host media tools',
		description: 'Configure the local Whisper model directory and check actual host media status',
		keywords: [
			'whisper',
			'model directory',
			'speech recognition',
			'transcription',
			'relay',
			'discord',
			'ffmpeg',
			'ffprobe',
			'whisper-cli',
			'model-directory',
			'MAESTRO_MEDIA_MODEL_DIR',
			'host media tools',
			'available profiles',
			'available models',
			'missing prerequisites',
			'check status',
			'save directory',
			'base',
			'small',
		],
	},
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
