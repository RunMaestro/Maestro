import { describe, it, expect } from 'vitest';
import { agentInitialCandidates, buildAgentInitials } from '../../shared/agentInitials';

/** Labels for a list of names, in input order. */
function labelsFor(...names: string[]): string[] {
	const labels = buildAgentInitials(names.map((name, i) => ({ id: String(i), name })));
	return names.map((_, i) => labels.get(String(i))!);
}

describe('shared/agentInitials', () => {
	describe('agentInitialCandidates', () => {
		it('prefers word initials for a multi-word name', () => {
			expect(agentInitialCandidates('Maestro RC')[0]).toBe('MR');
			expect(agentInitialCandidates('Greg Fitzgerald')[0]).toBe('GF');
			expect(agentInitialCandidates('claude-code')[0]).toBe('CC');
			expect(agentInitialCandidates('docs_site')[0]).toBe('DS');
		});

		it('splits camelCase and acronym runs into words', () => {
			expect(agentInitialCandidates('PedCast')[0]).toBe('PC');
			expect(agentInitialCandidates('HTTPServer')[0]).toBe('HS');
			expect(agentInitialCandidates('iPhone')[0]).toBe('IP');
		});

		it('takes the first two letters of a single word, keeping the typed case of the second', () => {
			expect(agentInitialCandidates('Maestro')[0]).toBe('Ma');
			expect(agentInitialCandidates('maestro')[0]).toBe('Ma');
			expect(agentInitialCandidates('API')[0]).toBe('AP');
		});

		it('honors a bracketed tag the user wrote', () => {
			expect(agentInitialCandidates('[ARP] Auditoria Pessoal')[0]).toBe('AR');
			expect(agentInitialCandidates('[rc] Maestro')[0]).toBe('RC');
		});

		it('drops leading numbering but keeps a trailing number', () => {
			expect(agentInitialCandidates('[1] Maestro Docs')[0]).toBe('MD');
			expect(agentInitialCandidates('2 - Maestro')[0]).toBe('Ma');
			expect(agentInitialCandidates('Agent 2')[0]).toBe('A2');
		});

		it('treats an apostrophe as part of the word', () => {
			expect(agentInitialCandidates("Pedram's Agent")[0]).toBe('PA');
			expect(agentInitialCandidates('Pedram’s Agent')[0]).toBe('PA');
		});

		it('ignores emoji and punctuation around a real name', () => {
			expect(agentInitialCandidates('\u{1F680} Rocket')[0]).toBe('Ro');
			expect(agentInitialCandidates('  (Maestro)  ')[0]).toBe('Ma');
		});

		it('handles names with nothing to abbreviate', () => {
			expect(agentInitialCandidates('X')[0]).toBe('X');
			expect(agentInitialCandidates('')[0]).toBe('?');
			expect(agentInitialCandidates('   ')[0]).toBe('?');
			expect(agentInitialCandidates('\u{1F3B5}')[0]).toBe('\u{1F3B5}');
			expect(agentInitialCandidates('日本語')[0]).toBe('日本');
		});

		it('never repeats a candidate, comparing case-insensitively', () => {
			const candidates = agentInitialCandidates('Mr Robot');
			const keys = candidates.map((c) => c.toUpperCase());
			expect(new Set(keys).size).toBe(keys.length);
			// "Mr" (first word's letters) is the same label as "MR" (word initials).
			expect(keys.filter((k) => k === 'MR')).toHaveLength(1);
		});
	});

	describe('buildAgentInitials', () => {
		it('gives every agent its first choice when nothing collides', () => {
			expect(labelsFor('Maestro', 'Greg Fitzgerald', 'PedCast')).toEqual(['Ma', 'GF', 'PC']);
		});

		it('lets the agent listed first keep a contested label', () => {
			const [first, second] = labelsFor('Maestro', 'Marketing');
			expect(first).toBe('Ma');
			expect(second).toBe('Mr');
		});

		it('produces unique labels for agents that share a prefix', () => {
			const labels = labelsFor('Maestro', 'Maestro RC', 'Maestro Docs', 'MaestroRun', 'Marketing');
			const keys = labels.map((l) => l.toUpperCase());
			expect(new Set(keys).size).toBe(keys.length);
			expect(labels.slice(0, 3)).toEqual(['Ma', 'MR', 'MD']);
		});

		// "Mr Robot" is the only agent that wants MR, so the Maestro/Marketing
		// collision must not spill onto it.
		it('never takes an uncontested label away to settle a collision between others', () => {
			const [, marketing, robot] = labelsFor('Maestro', 'Marketing', 'Mr Robot');
			expect(robot).toBe('MR');
			expect(marketing.toUpperCase()).not.toBe('MR');
			expect(marketing.toUpperCase()).not.toBe('MA');
		});

		it('tells identically named agents apart', () => {
			const labels = labelsFor('Maestro', 'Maestro', 'Maestro');
			expect(new Set(labels).size).toBe(3);
			expect(labels[0]).toBe('Ma');
		});

		it('falls back to a digit once a short name runs out of letters', () => {
			expect(labelsFor('Al', 'Al', 'Al')).toEqual(['Al', 'A2', 'A3']);
		});

		it('shares a label rather than leaving an agent unlabeled', () => {
			const labels = labelsFor(...Array.from({ length: 12 }, () => 'X'));
			expect(labels.every((l) => l.length > 0)).toBe(true);
			expect(labels[0]).toBe('X');
		});

		it('returns an empty map for no agents', () => {
			expect(buildAgentInitials([]).size).toBe(0);
		});
	});
});
