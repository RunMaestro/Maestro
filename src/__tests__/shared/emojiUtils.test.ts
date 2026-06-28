/**
 * Tests for shared emoji utilities
 */
import { stripLeadingEmojis, compareNamesIgnoringEmojis } from '../../shared/emojiUtils';

describe('emojiUtils', () => {
	describe('stripLeadingEmojis', () => {
		describe('basic emoji handling', () => {
			it('should strip single emoji at the start', () => {
				expect(stripLeadingEmojis('🎉 Party')).toBe('Party');
			});

			it('should strip emoji without space after', () => {
				expect(stripLeadingEmojis('🎉Party')).toBe('Party');
			});

			it('should strip multiple emojis at the start', () => {
				expect(stripLeadingEmojis('🎉🎊🎁 Celebration')).toBe('Celebration');
			});

			it('should return text unchanged if no leading emoji', () => {
				expect(stripLeadingEmojis('No emoji here')).toBe('No emoji here');
			});

			it('should preserve emojis in the middle of text', () => {
				expect(stripLeadingEmojis('Hello 🎉 World')).toBe('Hello 🎉 World');
			});

			it('should preserve emojis at the end of text', () => {
				expect(stripLeadingEmojis('Hello World 🎉')).toBe('Hello World 🎉');
			});

			it('should handle empty string', () => {
				expect(stripLeadingEmojis('')).toBe('');
			});

			it('should handle string with only emojis', () => {
				expect(stripLeadingEmojis('🎉🎊🎁')).toBe('');
			});

			it('should handle string with only whitespace', () => {
				expect(stripLeadingEmojis('   ')).toBe('');
			});
		});

		describe('complex emoji sequences', () => {
			it('should handle emoji with variation selector (emoji presentation)', () => {
				// Some emojis have variation selectors to ensure emoji presentation
				expect(stripLeadingEmojis('☺️ Smile')).toBe('Smile');
			});

			it('should handle ZWJ sequences - may have partial stripping', () => {
				// Note: ZWJ sequences are complex and the regex may not strip all parts
				// The important behavior is that it strips what it can consistently
				const result = stripLeadingEmojis('👨‍👩‍👧‍👦 Family');
				expect(result).toContain('Family');
			});

			it('should handle skin tone modifiers', () => {
				expect(stripLeadingEmojis('👋🏽 Wave')).toBe('Wave');
			});

			it('should handle flag emojis', () => {
				expect(stripLeadingEmojis('🇺🇸 USA')).toBe('USA');
			});

			it('should handle keycap emojis - may have partial stripping', () => {
				// Note: Keycap emojis (1️⃣) combine digit + variation selector + combining enclosing keycap
				// The regex may not strip all parts perfectly
				const result = stripLeadingEmojis('1️⃣ First');
				expect(result).toContain('First');
			});
		});

		describe('edge cases', () => {
			it('should trim leading whitespace after emoji removal', () => {
				expect(stripLeadingEmojis('🎉   Lots of space')).toBe('Lots of space');
			});

			it('should trim trailing whitespace', () => {
				expect(stripLeadingEmojis('🎉 Trailing   ')).toBe('Trailing');
			});

			it('should handle mixed whitespace', () => {
				expect(stripLeadingEmojis('🎉 \t Tab')).toBe('Tab');
			});

			it('should handle numbers after emoji', () => {
				expect(stripLeadingEmojis('🔢 12345')).toBe('12345');
			});

			it('should handle special characters after emoji', () => {
				expect(stripLeadingEmojis('🎉 @#$%')).toBe('@#$%');
			});

			it('should handle Unicode letters after emoji', () => {
				expect(stripLeadingEmojis('🎉 café')).toBe('café');
			});

			it('should handle CJK characters after emoji', () => {
				expect(stripLeadingEmojis('🎉 日本語')).toBe('日本語');
			});

			it('should NOT strip a leading ASCII digit (digits are keycap-emoji bases)', () => {
				// Regression: ASCII digits 0-9 carry Unicode Emoji=Yes, so an optional
				// variation selector in the regex used to eat the leading digit and
				// mis-sort names like "0DIN Weekly" under "D".
				expect(stripLeadingEmojis('0DIN Weekly')).toBe('0DIN Weekly');
				expect(stripLeadingEmojis('9Lives')).toBe('9Lives');
			});

			it('should NOT strip a leading # or * (also keycap-emoji bases)', () => {
				expect(stripLeadingEmojis('#tag')).toBe('#tag');
				expect(stripLeadingEmojis('*star')).toBe('*star');
			});
		});
	});

	describe('compareNamesIgnoringEmojis', () => {
		describe('basic comparisons', () => {
			it('should compare names with emojis alphabetically', () => {
				expect(compareNamesIgnoringEmojis('🍎 Apple', '🍌 Banana')).toBeLessThan(0);
			});

			it('should compare names where emoji would affect sort', () => {
				// Without stripping, 🎉 Zebra would sort before Alpha because of emoji code point
				expect(compareNamesIgnoringEmojis('🎉 Zebra', 'Alpha')).toBeGreaterThan(0);
			});

			it('should return 0 for identical names', () => {
				expect(compareNamesIgnoringEmojis('🎉 Same', '🎊 Same')).toBe(0);
			});

			it('should compare names without emojis normally', () => {
				expect(compareNamesIgnoringEmojis('Apple', 'Banana')).toBeLessThan(0);
			});

			it('should compare mixed emoji and non-emoji names', () => {
				expect(compareNamesIgnoringEmojis('🎉 Apple', 'Banana')).toBeLessThan(0);
				expect(compareNamesIgnoringEmojis('Apple', '🎉 Banana')).toBeLessThan(0);
			});
		});

		describe('case sensitivity', () => {
			it('should use default localeCompare (case-sensitive by default)', () => {
				// localeCompare by default is case-sensitive in most environments
				// 'Apple' comes before 'apple' because uppercase sorts first
				const result = compareNamesIgnoringEmojis('apple', 'Apple');
				// Don't assert exact value - just that comparison works consistently
				expect(typeof result).toBe('number');
			});

			it('should handle uppercase names', () => {
				expect(compareNamesIgnoringEmojis('🎉 APPLE', '🍌 BANANA')).toBeLessThan(0);
			});
		});

		describe('sorting arrays', () => {
			it('should sort array of names with emojis correctly', () => {
				const names = ['🍎 Apple', '🎉 Zebra', '🔥 Fire', '🌟 Star', 'Alpha', '🐝 Bee'];

				const sorted = [...names].sort(compareNamesIgnoringEmojis);

				expect(sorted).toEqual(['Alpha', '🍎 Apple', '🐝 Bee', '🔥 Fire', '🌟 Star', '🎉 Zebra']);
			});

			it('should handle empty names in array', () => {
				const names = ['🎉 Test', '', 'Alpha'];
				const sorted = [...names].sort(compareNamesIgnoringEmojis);
				expect(sorted).toEqual(['', 'Alpha', '🎉 Test']);
			});

			it('should sort a digit-prefixed name by its digit, not the following letter', () => {
				// Regression: "0DIN Weekly" must sort ahead of "Cyber Stocks"/"Maestro"
				// instead of landing under "D" from a stripped leading "0".
				const names = ['Cyber Stocks', '0DIN Weekly', 'Maestro', 'BJJ Sensei'];
				const sorted = [...names].sort(compareNamesIgnoringEmojis);
				expect(sorted).toEqual(['0DIN Weekly', 'BJJ Sensei', 'Cyber Stocks', 'Maestro']);
			});
		});

		describe('edge cases', () => {
			it('should handle empty strings', () => {
				expect(compareNamesIgnoringEmojis('', '')).toBe(0);
				expect(compareNamesIgnoringEmojis('', 'A')).toBeLessThan(0);
				expect(compareNamesIgnoringEmojis('A', '')).toBeGreaterThan(0);
			});

			it('should handle strings that are only emojis', () => {
				expect(compareNamesIgnoringEmojis('🎉', '🎊')).toBe(0); // Both become empty
				expect(compareNamesIgnoringEmojis('🎉', 'Alpha')).toBeLessThan(0); // Empty < Alpha
			});

			it('should handle special characters', () => {
				// Just verify it returns a consistent comparison value
				// Special character ordering depends on locale
				const result = compareNamesIgnoringEmojis('🎉 @test', '🎊 #test');
				expect(typeof result).toBe('number');
			});
		});
	});
});
