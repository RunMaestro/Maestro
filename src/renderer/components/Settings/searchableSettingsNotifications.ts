/**
 * Notifications and AI Commands tab searchable-settings entries.
 *
 * Part of the searchableSettings.ts domain-file split, mirroring the
 * settingsStore.ts / settingsMetadata.ts slice decomposition (see
 * settingsAnnotatorSlice.ts for that pattern).
 */

import type { SearchableSetting } from './searchableSettings';

export const NOTIFICATION_SETTINGS: SearchableSetting[] = [
	{
		id: 'notifications-os',
		tab: 'notifications',
		tabLabel: 'Notifications',
		label: 'OS Notifications',
		description: 'Show desktop notifications when tasks complete or require attention',
		keywords: ['notification', 'desktop', 'os', 'alert', 'system'],
	},
	{
		id: 'notifications-custom',
		tab: 'notifications',
		tabLabel: 'Notifications',
		label: 'Custom Notification',
		description:
			'Execute a custom command (text-to-speech, festival, say, espeak, pipe to log) when AI tasks complete. Includes a Test button.',
		keywords: [
			'audio',
			'sound',
			'tts',
			'text to speech',
			'say',
			'espeak',
			'festival',
			'command',
			'custom',
			'pipe',
			'test',
			'feedback',
			'voice',
			'speak',
		],
	},
	{
		id: 'notifications-idle',
		tab: 'notifications',
		tabLabel: 'Notifications',
		label: 'Idle Notification',
		description:
			'Execute a custom command when all agents and Auto Runs finish and Maestro becomes idle. Includes a Test button.',
		keywords: [
			'idle',
			'finish',
			'done',
			'complete',
			'fleet',
			'quiet',
			'all done',
			'command',
			'test',
		],
	},
	{
		id: 'notifications-toast',
		tab: 'notifications',
		tabLabel: 'Notifications',
		label: 'Toast Notification Duration',
		description:
			'How long toast notifications remain on screen before they are auto-dismissed; 0 keeps them until manually dismissed',
		keywords: [
			'toast',
			'duration',
			'timeout',
			'popup',
			'banner',
			'dismiss',
			'auto-dismiss',
			'sticky',
			'persist',
		],
	},
	{
		id: 'notifications-toast-width',
		tab: 'notifications',
		tabLabel: 'Notifications',
		label: 'Toast Notification Width',
		description:
			'Width of toast notifications: Small, Medium, Large, or Dynamic (match the Right Bar)',
		keywords: [
			'toast',
			'notification',
			'width',
			'size',
			'small',
			'medium',
			'large',
			'dynamic',
			'right bar',
			'panel',
		],
	},
];

// ---------------------------------------------------------------------------
// AI Commands Tab
// ---------------------------------------------------------------------------
export const AI_COMMANDS_SETTINGS: SearchableSetting[] = [
	{
		id: 'aicommands-custom',
		tab: 'aicommands',
		tabLabel: 'AI Commands',
		label: 'Custom AI Commands',
		description:
			'Create custom slash commands with configurable prompts and template variables. Available in AI terminal mode alongside built-in commands.',
		keywords: [
			'ai',
			'command',
			'slash',
			'slash command',
			'custom',
			'prompt',
			'template',
			'variable',
			'terminal',
			'built-in',
			'builtin',
		],
	},
	{
		id: 'aicommands-speckit',
		tab: 'aicommands',
		tabLabel: 'AI Commands',
		label: 'Spec-Kit Commands',
		description:
			'Built-in specification toolkit commands. Toggle to hide them from slash command autocomplete.',
		keywords: [
			'speckit',
			'spec',
			'specification',
			'toolkit',
			'enable',
			'disable',
			'hide',
			'show',
			'autocomplete',
			'slash',
		],
	},
	{
		id: 'aicommands-openspec',
		tab: 'aicommands',
		tabLabel: 'AI Commands',
		label: 'OpenSpec Commands',
		description: 'Built-in OpenSpec commands. Toggle to hide them from slash command autocomplete.',
		keywords: [
			'openspec',
			'open',
			'spec',
			'enable',
			'disable',
			'hide',
			'show',
			'autocomplete',
			'slash',
		],
	},
	{
		id: 'aicommands-bmad',
		tab: 'aicommands',
		tabLabel: 'AI Commands',
		label: 'BMAD Commands',
		description: 'Built-in BMAD commands. Toggle to hide them from slash command autocomplete.',
		keywords: ['bmad', 'enable', 'disable', 'hide', 'show', 'autocomplete', 'slash'],
	},
];
