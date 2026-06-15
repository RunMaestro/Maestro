import type { AgentTile } from '../types';

export const AGENT_TILES: AgentTile[] = [
	{
		id: 'claude-code',
		name: 'Claude Code',
		supported: true,
		description: "Anthropic's AI coding assistant",
		brandColor: '#D97757',
	},
	{
		id: 'codex',
		name: 'Codex',
		supported: true,
		description: "OpenAI's AI coding assistant",
		brandColor: '#10A37F',
	},
	{
		id: 'opencode',
		name: 'OpenCode',
		supported: true,
		description: 'Open-source AI coding assistant',
		brandColor: '#F97316',
	},
	{
		id: 'factory-droid',
		name: 'Factory Droid',
		supported: true,
		description: "Factory's AI coding assistant",
		brandColor: '#3B82F6',
	},
	{
		id: 'copilot-cli',
		name: 'Copilot-CLI',
		supported: true,
		description: "GitHub's AI coding assistant",
		brandColor: '#24292F',
	},
];
