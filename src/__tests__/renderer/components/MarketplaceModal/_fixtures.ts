import type {
	MarketplaceManifest,
	MarketplacePlaybook,
} from '../../../../shared/marketplace-types';
import type { Theme } from '../../../../renderer/types';

export const mockTheme: Theme = {
	id: 'test-theme',
	name: 'Test',
	mode: 'dark',
	colors: {
		bgMain: '#111',
		bgSidebar: '#222',
		bgActivity: '#333',
		border: '#444',
		textMain: '#fff',
		textDim: '#aaa',
		accent: '#5af',
		accentDim: '#5af880',
		accentText: '#5af',
		accentForeground: '#000',
		success: '#0f0',
		warning: '#ff0',
		error: '#f00',
		info: '#09f',
		textInverse: '#000',
	},
};

export function makePlaybook(overrides: Partial<MarketplacePlaybook> = {}): MarketplacePlaybook {
	return {
		id: 'test-playbook',
		title: 'Test Playbook',
		description: 'A playbook for tests',
		category: 'Development',
		subcategory: 'Quality',
		author: 'Maestro Team',
		authorLink: 'https://example.com/author',
		tags: ['test', 'automation'],
		lastUpdated: '2026-01-01',
		path: 'playbooks/test-playbook',
		documents: [
			{ filename: 'phase-1', resetOnCompletion: false },
			{ filename: 'phase-2', resetOnCompletion: true },
		],
		loopEnabled: true,
		maxLoops: 3,
		prompt: null,
		...overrides,
	};
}

export function makeManifest(playbooks: MarketplacePlaybook[]): MarketplaceManifest {
	return {
		lastUpdated: '2026-01-01',
		playbooks,
	};
}
