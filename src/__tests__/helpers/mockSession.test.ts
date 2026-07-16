import { describe, expect, it } from 'vitest';
import { createMockSession } from './mockSession';
import { createMockAITab, createMockFileTab } from './mockTab';

describe('mock session factories', () => {
	it('returns deterministic defaults', () => {
		expect(createMockSession()).toEqual(createMockSession());
		expect(createMockAITab()).toEqual(createMockAITab());
		expect(createMockFileTab()).toEqual(createMockFileTab());
		expect(createMockAITab().createdAt).toBe(0);
		expect(createMockFileTab()).toMatchObject({ createdAt: 0, lastModified: 0 });
	});
	it('applies overrides after defaults', () => {
		const tabs = [createMockAITab({ id: 'override-tab' })];
		const session = createMockSession({ id: 'override-session', aiTabs: tabs });
		const aiTab = createMockAITab({ id: 'override-ai-tab', state: 'busy' });
		const fileTab = createMockFileTab({ id: 'override-file-tab', content: 'override content' });

		expect(session.id).toBe('override-session');
		expect(session.aiTabs).toBe(tabs);
		expect(aiTab).toMatchObject({ id: 'override-ai-tab', state: 'busy' });
		expect(fileTab).toMatchObject({ id: 'override-file-tab', content: 'override content' });
	});

	it('isolates default nested arrays between calls', () => {
		const firstSession = createMockSession();
		const secondSession = createMockSession();
		const firstAITab = createMockAITab();
		const secondAITab = createMockAITab();

		firstSession.fileExplorerExpanded.push('/mutated');
		firstSession.aiTabs.push(firstAITab);
		firstAITab.stagedImages.push('mutated-image');

		expect(secondSession.fileExplorerExpanded).toEqual([]);
		expect(secondSession.aiTabs).toEqual([]);
		expect(secondAITab.stagedImages).toEqual([]);
		expect(firstSession.aiTabs).not.toBe(secondSession.aiTabs);
		expect(firstAITab.stagedImages).not.toBe(secondAITab.stagedImages);
	});
});
