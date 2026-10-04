import { describe, expect, it } from 'vitest';
import { effectiveAgentsPaneWidth, isAgentsPaneVisible, isTerminalTooSmall } from '../layout';

describe('layout rules', () => {
	it('treats anything under 80x24 as too small', () => {
		expect(isTerminalTooSmall({ columns: 80, rows: 24 })).toBe(false);
		expect(isTerminalTooSmall({ columns: 79, rows: 24 })).toBe(true);
		expect(isTerminalTooSmall({ columns: 80, rows: 23 })).toBe(true);
	});

	it('shows the Agents pane from 100 columns unless the user toggled it', () => {
		expect(isAgentsPaneVisible(100, undefined)).toBe(true);
		expect(isAgentsPaneVisible(99, undefined)).toBe(false);
		expect(isAgentsPaneVisible(99, true)).toBe(true);
		expect(isAgentsPaneVisible(140, false)).toBe(false);
	});

	it('leaves the Conversation pane its minimum width', () => {
		expect(effectiveAgentsPaneWidth(140, 28)).toBe(28);
		expect(effectiveAgentsPaneWidth(80, 50)).toBe(40);
		expect(effectiveAgentsPaneWidth(30, 28)).toBe(0);
	});
});
