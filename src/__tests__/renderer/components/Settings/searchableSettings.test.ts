/**
 * Tests for searchableSettings.ts
 *
 * Tests the search algorithm, scoring, and registry completeness.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
	searchSettings,
	ALL_SEARCHABLE_SETTINGS,
} from '../../../../renderer/components/Settings/searchableSettings';

const RENDERER_ROOT = resolve(__dirname, '../../../../renderer');

function walkTsx(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		const st = statSync(full);
		if (st.isDirectory()) walkTsx(full, out);
		else if (full.endsWith('.tsx')) out.push(full);
	}
	return out;
}

function collectRenderedSettingIds(): { id: string; file: string }[] {
	const matches: { id: string; file: string }[] = [];
	const re = /data-setting-id=["']([a-z0-9-]+)["']/g;
	for (const file of walkTsx(RENDERER_ROOT)) {
		const src = readFileSync(file, 'utf8');
		for (const m of src.matchAll(re)) {
			matches.push({ id: m[1], file });
		}
	}
	return matches;
}

describe('searchableSettings', () => {
	describe('ALL_SEARCHABLE_SETTINGS', () => {
		it('should contain entries from all tabs', () => {
			const tabs = new Set(ALL_SEARCHABLE_SETTINGS.map((s) => s.tab));
			expect(tabs).toContain('general');
			expect(tabs).toContain('display');
			expect(tabs).toContain('shortcuts');
			expect(tabs).toContain('theme');
			expect(tabs).toContain('notifications');
			expect(tabs).toContain('aicommands');
			expect(tabs).toContain('ssh');
			expect(tabs).toContain('environment');
			expect(tabs).toContain('encore');
		});

		it('should have unique ids', () => {
			const ids = ALL_SEARCHABLE_SETTINGS.map((s) => s.id);
			expect(new Set(ids).size).toBe(ids.length);
		});

		it('should have non-empty labels and tabLabels', () => {
			for (const s of ALL_SEARCHABLE_SETTINGS) {
				expect(s.label.length).toBeGreaterThan(0);
				expect(s.tabLabel.length).toBeGreaterThan(0);
			}
		});
	});

	describe('searchSettings', () => {
		it('should return empty array for empty query', () => {
			expect(searchSettings('')).toEqual([]);
			expect(searchSettings('   ')).toEqual([]);
		});

		it('should match by label', () => {
			const results = searchSettings('Font Size');
			expect(results.some((s) => s.id === 'display-font-size')).toBe(true);
		});

		it('should match by description', () => {
			const results = searchSettings('desktop notifications');
			expect(results.some((s) => s.id === 'notifications-os')).toBe(true);
		});

		it('should match by keywords', () => {
			const results = searchSettings('gpu');
			expect(results.some((s) => s.id === 'general-rendering')).toBe(true);
		});

		it('should be case insensitive', () => {
			const lower = searchSettings('font');
			const upper = searchSettings('FONT');
			const mixed = searchSettings('Font');
			expect(lower.length).toBe(upper.length);
			expect(lower.length).toBe(mixed.length);
		});

		it('should match multiple terms (AND logic)', () => {
			const results = searchSettings('tab naming');
			expect(results.some((s) => s.id === 'general-tab-naming')).toBe(true);
			// Should not match things that only have one of the terms
			for (const r of results) {
				const all =
					`${r.label} ${r.description || ''} ${r.tabLabel} ${(r.keywords || []).join(' ')}`.toLowerCase();
				expect(all).toContain('tab');
				expect(all).toContain('naming');
			}
		});

		it('should return no results for gibberish', () => {
			expect(searchSettings('xyznonexistent123')).toEqual([]);
		});

		it('should rank label matches higher than keyword matches', () => {
			const results = searchSettings('font');
			// 'Font Family' and 'Font Size' should appear before items where 'font' is only a keyword
			const labelMatches = results.filter((s) => s.label.toLowerCase().includes('font'));
			const keywordOnly = results.filter(
				(s) =>
					!s.label.toLowerCase().includes('font') && !s.description?.toLowerCase().includes('font')
			);
			if (labelMatches.length > 0 && keywordOnly.length > 0) {
				const firstLabelIdx = results.indexOf(labelMatches[0]);
				const firstKwIdx = results.indexOf(keywordOnly[0]);
				expect(firstLabelIdx).toBeLessThan(firstKwIdx);
			}
		});

		// Each query below is a string a user would naturally type after seeing it
		// rendered in the Settings UI (section headings, sub-headings, button
		// labels). When you add a new setting, add the visible strings here so
		// they remain findable — keyword drift from UI text is silent otherwise.
		it.each([
			// General tab
			['Auto Run Inactivity Timeout', 'general-autorun-inactivity-timeout'],
			['refactor', 'general-autorun-inactivity-timeout'],
			['forced parallel execution', 'general-input-behavior'],
			['shift+enter', 'general-input-behavior'],
			['prompt composer', 'general-input-behavior'],
			['ai interaction mode', 'general-input-behavior'],
			['custom shell path', 'general-default-shell'],
			['pwsh', 'general-default-shell'],
			['worktree', 'general-gh-path'],
			['cue pipeline', 'general-power'],
			['ctrl+click', 'general-browser'],
			['context menu', 'general-browser'],
			['icloud drive', 'general-storage'],
			['environment variables', 'general-storage'],
			['migrate', 'general-storage'],
			['final response', 'general-thinking-mode'],

			// Display tab
			['x-large', 'display-font-size'],
			['medium', 'display-font-size'],
			['ai response', 'display-message-alignment'],
			['file indexing', 'display-file-indexing'],
			['file panel', 'display-file-indexing'],
			['File Panel Settings', 'display-file-indexing'],
			['max recursion depth', 'display-file-indexing'],
			['max file entries', 'display-file-indexing'],
			['load more', 'display-file-indexing'],
			['100k', 'display-file-indexing'],
			['ignore patterns', 'display-file-indexing'],
			['soft', 'display-bionify-reading-mode'],
			['strong', 'display-bionify-reading-mode'],
			['file preview', 'display-bionify-reading-mode'],
			['speed reading', 'display-bionify-reading-mode'],
			['alt menu bar', 'display-window-chrome'],
			['custom title bar', 'display-window-chrome'],
			['compaction', 'display-context-warnings'],
			['mindmap', 'display-document-graph'],
			['backlinks', 'display-document-graph'],

			// Notifications tab
			['idle notification', 'notifications-idle'],
			['festival', 'notifications-custom'],
			['voice', 'notifications-custom'],
			['dismiss', 'notifications-toast'],

			// AI Commands tab
			['slash command', 'aicommands-custom'],
			['built-in command', 'aicommands-custom'],

			// SSH tab
			['test connection', 'ssh-remotes'],

			// Encore tab
			['lookback', 'encore-usage-stats'],
			['coding activity', 'encore-usage-stats'],
			['github pr', 'encore-cue'],
			['cron', 'encore-cue'],
			['playbook registry', 'encore-symphony'],

			// Prompts tab
			['wizard prompt', 'prompts-editor'],
			['group chat', 'prompts-editor'],
			['inline wizard', 'prompts-editor'],
		])('should find "%s" and return id %s', (query, expectedId) => {
			const results = searchSettings(query);
			expect(
				results.some((s) => s.id === expectedId),
				`Expected "${query}" to surface ${expectedId}. ` +
					`Add the missing terms to that entry's keywords/label/description in searchableSettings.ts.`
			).toBe(true);
		});
	});

	describe('registry/DOM parity', () => {
		const renderedIds = collectRenderedSettingIds();
		const registryIds = new Set(ALL_SEARCHABLE_SETTINGS.map((s) => s.id));
		// shortcuts-tab is intentionally registered as a tab-level entry rather than a per-setting entry
		const KNOWN_TAB_LEVEL_ENTRIES = new Set(['shortcuts-tab']);

		it('every rendered data-setting-id should have a matching registry entry', () => {
			const orphanedRendered = renderedIds.filter(({ id }) => !registryIds.has(id));
			expect(
				orphanedRendered,
				`Found data-setting-id values in the DOM with no matching searchableSettings entry. ` +
					`Add them to src/renderer/components/Settings/searchableSettings.ts so they are findable via search:\n` +
					orphanedRendered.map((o) => `  - "${o.id}" in ${o.file}`).join('\n')
			).toEqual([]);
		});

		it('every registry entry should have a corresponding rendered data-setting-id', () => {
			const renderedSet = new Set(renderedIds.map((r) => r.id));
			const orphanedRegistry = ALL_SEARCHABLE_SETTINGS.filter(
				(s) => !renderedSet.has(s.id) && !KNOWN_TAB_LEVEL_ENTRIES.has(s.id)
			);
			expect(
				orphanedRegistry,
				`Found searchableSettings entries with no matching data-setting-id in the DOM. ` +
					`Either remove the entry or add data-setting-id="<id>" to the rendered control:\n` +
					orphanedRegistry.map((o) => `  - "${o.id}" (${o.tab} / ${o.label})`).join('\n')
			).toEqual([]);
		});
	});
});
