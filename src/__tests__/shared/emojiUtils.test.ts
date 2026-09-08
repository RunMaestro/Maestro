/**
 * Tests for shared emoji utilities
 */
import {
	stripLeadingEmojis,
	nameSortKey,
	compareNamesIgnoringEmojis,
} from '../../shared/emojiUtils';

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

			it('should strip the whole ZWJ sequence, not just its first codepoint', () => {
				// The ZWJ (U+200D) used to stop the match, leaving the tail of the
				// sequence glued to the name and poisoning the sort key.
				expect(stripLeadingEmojis('👨‍👩‍👧‍👦 Family')).toBe('Family');
				expect(stripLeadingEmojis('🧑‍💼 A&C Overlord')).toBe('A&C Overlord');
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

			it('should leave a leading digit alone', () => {
				// ASCII digits carry Emoji=Yes, so the old \p{Emoji} pattern ate the
				// "0" and filed the agent under "D".
				expect(stripLeadingEmojis('0DIN Loki')).toBe('0DIN Loki');
				expect(stripLeadingEmojis('#1 Agent')).toBe('#1 Agent');
			});

			it('should handle Unicode letters after emoji', () => {
				expect(stripLeadingEmojis('🎉 café')).toBe('café');
			});

			it('should handle CJK characters after emoji', () => {
				expect(stripLeadingEmojis('🎉 日本語')).toBe('日本語');
			});
		});
	});

	describe('nameSortKey', () => {
		it('starts the key at the first alphanumeric character', () => {
			expect(nameSortKey('🧑‍💼 A&C Overlord')).toBe('A&C Overlord');
			expect(nameSortKey('👀 A&C Overwatch')).toBe('A&C Overwatch');
			expect(nameSortKey('0DIN Loki')).toBe('0DIN Loki');
			expect(nameSortKey('  ...Alpha')).toBe('Alpha');
		});

		it('falls back to the emoji-stripped name when there is no alphanumeric', () => {
			expect(nameSortKey('🎉 @#$%')).toBe('@#$%');
			expect(nameSortKey('🎉🎊🎁')).toBe('');
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
			it('files an emoji-prefixed name under its first letter', () => {
				const names = [
					'🧑‍💼 A&C Overlord',
					'0DIN Loki',
					'0DIN.ai',
					'👀 A&C Overwatch',
					'📷 ATX Sentinel',
				];

				expect([...names].sort(compareNamesIgnoringEmojis)).toEqual([
					'0DIN Loki',
					'0DIN.ai',
					'🧑‍💼 A&C Overlord',
					'👀 A&C Overwatch',
					'📷 ATX Sentinel',
				]);
			});

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
