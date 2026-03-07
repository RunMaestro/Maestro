import { describe, it, expect } from 'vitest';
import {
	containsEmoji,
	formatAgentName,
	safeString,
	getToolDetail,
} from '../../../../../renderer/components/Wizard/shared/wizardHelpers';

describe('wizardHelpers', () => {
	describe('containsEmoji', () => {
		it('returns true for strings with emoji', () => {
			expect(containsEmoji('🤖 Agent')).toBe(true);
			expect(containsEmoji('Hello 🌍')).toBe(true);
			expect(containsEmoji('🚀')).toBe(true);
		});

		it('returns true for newer emoji blocks', () => {
			expect(containsEmoji('🪄 Magic')).toBe(true);
			expect(containsEmoji('🫠 Melting')).toBe(true);
			expect(containsEmoji('🪩 Disco')).toBe(true);
		});

		it('returns false for strings without emoji', () => {
			expect(containsEmoji('Hello World')).toBe(false);
			expect(containsEmoji('')).toBe(false);
			expect(containsEmoji('Claude Code')).toBe(false);
		});
	});

	describe('formatAgentName', () => {
		it('adds robot emoji prefix when no emoji present', () => {
			expect(formatAgentName('Claude')).toBe('🤖 Claude');
			expect(formatAgentName('Agent')).toBe('🤖 Agent');
		});

		it('returns name as-is when it already contains emoji', () => {
			expect(formatAgentName('🤖 Claude')).toBe('🤖 Claude');
			expect(formatAgentName('🚀 Rocket Agent')).toBe('🚀 Rocket Agent');
		});

		it('returns default when name is empty', () => {
			expect(formatAgentName('')).toBe('🤖 Agent');
		});
	});

	describe('safeString', () => {
		it('returns the string for string values', () => {
			expect(safeString('hello')).toBe('hello');
			expect(safeString('')).toBe('');
		});

		it('returns null for non-string values', () => {
			expect(safeString(42)).toBeNull();
			expect(safeString(null)).toBeNull();
			expect(safeString(undefined)).toBeNull();
			expect(safeString({})).toBeNull();
			expect(safeString([])).toBeNull();
		});
	});

	describe('getToolDetail', () => {
		it('extracts command from tool input', () => {
			expect(getToolDetail({ command: 'npm test' })).toBe('npm test');
		});

		it('extracts pattern from tool input', () => {
			expect(getToolDetail({ pattern: '*.tsx' })).toBe('*.tsx');
		});

		it('extracts file_path from tool input', () => {
			expect(getToolDetail({ file_path: '/src/index.ts' })).toBe('/src/index.ts');
		});

		it('extracts query from tool input', () => {
			expect(getToolDetail({ query: 'search term' })).toBe('search term');
		});

		it('extracts path from tool input', () => {
			expect(getToolDetail({ path: '/tmp' })).toBe('/tmp');
		});

		it('prefers command over other properties', () => {
			expect(getToolDetail({ command: 'ls', pattern: '*.ts', path: '/tmp' })).toBe('ls');
		});

		it('returns null for non-object input', () => {
			expect(getToolDetail(null)).toBeNull();
			expect(getToolDetail(undefined)).toBeNull();
			expect(getToolDetail('string')).toBeNull();
			expect(getToolDetail(42)).toBeNull();
		});

		it('returns null when no recognized properties exist', () => {
			expect(getToolDetail({ foo: 'bar' })).toBeNull();
		});

		it('ignores non-string property values', () => {
			expect(getToolDetail({ command: { nested: true } })).toBeNull();
			expect(getToolDetail({ command: 42 })).toBeNull();
		});
	});
});
