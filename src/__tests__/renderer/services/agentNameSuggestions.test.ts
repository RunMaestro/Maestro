import { describe, expect, it } from 'vitest';
import {
	getAllAgentNameSuggestions,
	suggestAgentName,
} from '../../../renderer/components/Wizard/services/agentNameSuggestions';

describe('agentNameSuggestions', () => {
	it('only ever suggests a name from the list', () => {
		const all = new Set(getAllAgentNameSuggestions());
		for (let i = 0; i < 200; i++) {
			expect(all.has(suggestAgentName())).toBe(true);
		}
	});

	it('never hands back the name already on screen', () => {
		// Re-rolling has to visibly change the field, so the excluded name must not
		// come back even when it is the one the shuffled queue would serve next.
		let current = suggestAgentName();
		for (let i = 0; i < 200; i++) {
			const next = suggestAgentName(current);
			expect(next).not.toBe(current);
			current = next;
		}
	});

	it('offers every name before repeating one', () => {
		const total = getAllAgentNameSuggestions().length;
		// Drain whatever is left of the current queue so the count starts on a
		// fresh shuffle rather than mid-cycle.
		const seen = new Set<string>();
		for (let i = 0; i < total * 2; i++) {
			seen.add(suggestAgentName());
		}
		expect(seen.size).toBe(total);
	});

	it('suggests single-word names that fit the Left Bar', () => {
		for (const name of getAllAgentNameSuggestions()) {
			expect(name).toMatch(/^[A-Z][A-Za-z]*$/);
		}
	});
});
