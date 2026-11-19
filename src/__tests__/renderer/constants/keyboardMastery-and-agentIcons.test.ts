import { describe as __maestroMicrobenchDescribe } from 'vitest';
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { collectBoundShortcuts } from '../../../renderer/constants/keyboardMastery';
import { countUsedBoundShortcuts } from '../../../renderer/constants/keyboardMastery';
import type { Shortcut } from '../../../renderer/types';
import { AGENT_ICONS } from '../../../renderer/constants/agentIcons';
import { DEFAULT_AGENT_ICON } from '../../../renderer/constants/agentIcons';
import { getAgentIcon } from '../../../renderer/constants/agentIcons';
__maestroMicrobenchDescribe('keyboardMastery', () => {
	function shortcut(id: string, keys: string[]): Shortcut {
		return { id, label: id, keys, category: 'general' } as Shortcut;
	}

	describe('collectBoundShortcuts', () => {
		it('drops shortcuts with no chord bound', () => {
			const bound = collectBoundShortcuts({
				a: shortcut('a', ['Meta', 'A']),
				b: shortcut('b', []),
			});
			expect(bound.map((s) => s.id)).toEqual(['a']);
		});

		it('lets a later map override an earlier one by id', () => {
			const bound = collectBoundShortcuts(
				{ a: shortcut('a', ['Meta', 'A']) },
				{ a: shortcut('a', []) }
			);
			expect(bound).toEqual([]);
		});

		it('ignores undefined maps', () => {
			const bound = collectBoundShortcuts(undefined, { a: shortcut('a', ['Meta', 'A']) });
			expect(bound.map((s) => s.id)).toEqual(['a']);
		});
	});

	describe('countUsedBoundShortcuts', () => {
		const bound = [shortcut('a', ['Meta', 'A']), shortcut('b', ['Meta', 'B'])];

		it('counts only the used ones', () => {
			expect(countUsedBoundShortcuts(bound, ['a'])).toBe(1);
		});

		it('ignores used ids that are no longer bound, so it cannot exceed the total', () => {
			expect(countUsedBoundShortcuts(bound, ['a', 'b', 'retired', 'unbound'])).toBe(2);
		});
	});
});
__maestroMicrobenchDescribe('agentIcons', () => {
	describe('agentIcons', () => {
		it('returns a dedicated icon for grok (not the default fallback)', () => {
			expect(AGENT_ICONS.grok).toBeDefined();
			expect(getAgentIcon('grok')).toBe(AGENT_ICONS.grok);
			expect(getAgentIcon('grok')).not.toBe(DEFAULT_AGENT_ICON);
		});

		it('returns dedicated icons for the other active agents', () => {
			for (const id of ['claude-code', 'codex', 'opencode', 'factory-droid', 'terminal']) {
				expect(getAgentIcon(id)).not.toBe(DEFAULT_AGENT_ICON);
			}
		});

		it('falls back to the default icon for unknown agents', () => {
			expect(getAgentIcon('unknown-agent')).toBe(DEFAULT_AGENT_ICON);
		});
	});
});
