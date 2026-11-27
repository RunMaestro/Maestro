/**
 * Shared test factories for tab mocks.
 *
 * Use these factories in tests instead of hand-rolling local `createMockTab`
 * or `createMockAITab` helpers. The defaults cover all required fields on
 * `AITab` / `FilePreviewTab`; pass overrides for any fields your test exercises.
 *
 * If your test depends on a specific default (e.g. a non-null `agentSessionId`
 * or pre-seeded `logs`), pass it explicitly via `overrides` at the call site
 * rather than adding project-wide drift to the defaults below.
 */

import type { AITab, FilePreviewTab, StagedDesignPick } from '../../renderer/types';

/**
 * Create a mock `AITab` with sensible defaults for all required fields.
 *
 * Defaults: idle state, null agentSessionId, null name, empty logs,
 * empty inputValue, empty stagedImages, fresh createdAt timestamp.
 *
 * Tests that need a specific non-default value should pass it via `overrides`.
 */
export function createMockAITab(overrides: Partial<AITab> = {}): AITab {
	return {
		id: 'tab-1',
		agentSessionId: null,
		name: null,
		starred: false,
		logs: [],
		inputValue: '',
		stagedImages: [],
		createdAt: Date.now(),
		state: 'idle',
		...overrides,
	} as AITab;
}

/**
 * Create a mock `StagedDesignPick`: a Design Mode chip staged on an AI tab's
 * composer (`AITab.stagedDesignPicks`).
 *
 * Defaults: an element chip with a short label, the one-word block `BLOCK`,
 * no note, and no screenshot.
 */
export function createMockDesignPick(overrides: Partial<StagedDesignPick> = {}): StagedDesignPick {
	return {
		id: 'pick-1',
		kind: 'element',
		label: 'button.cta "Sign up"',
		url: 'https://example.com',
		note: '',
		text: 'BLOCK',
		screenshot: null,
		createdAt: 1,
		...overrides,
	};
}

/**
 * Create a mock `FilePreviewTab` with sensible defaults for all required fields.
 */
export function createMockFileTab(overrides: Partial<FilePreviewTab> = {}): FilePreviewTab {
	return {
		id: 'file-tab-1',
		path: '/test/file.ts',
		name: 'file',
		extension: '.ts',
		content: '// test content',
		scrollTop: 0,
		searchQuery: '',
		editMode: false,
		editContent: undefined,
		createdAt: Date.now(),
		lastModified: Date.now(),
		...overrides,
	} as FilePreviewTab;
}
