/**
 * @file contextFootprint.test.ts
 * @description The context footprint audit over synthetic inventories: what is
 * an estimate and what is configured text, where activation and delivery stay
 * unknown, how candidates are chosen, and that nothing here is ever a saving or
 * a measure of what a provider loaded.
 */

import { describe, it, expect } from 'vitest';
import {
	CANDIDATE_LIMIT,
	CANDIDATE_MIN_TOKENS,
	FOOTPRINT_KINDS,
	auditContextFootprint,
	formatContextFootprint,
	type ConfiguredContributionInput,
	type ContextFootprintInput,
	type FootprintComponentInput,
} from '../../shared/contextFootprint';
import { estimateTokenCount } from '../../shared/formatters';

const SUBJECT = {
	agentId: 'agent-1',
	agentName: 'Docs Agent',
	toolType: 'claude-code',
	projectRoot: '/work/project',
	accountDir: '/accounts/main',
};

/** Four bytes to a token, so a size in tokens reads straight off the fixture. */
const tokensToBytes = (tokens: number) => tokens * 4;

function component(overrides: Partial<FootprintComponentInput> = {}): FootprintComponentInput {
	return {
		kind: 'instruction',
		scope: 'project',
		label: 'CLAUDE.md',
		path: '/work/project/CLAUDE.md',
		discoveredBy: 'project instruction files',
		bytes: tokensToBytes(1_500),
		...overrides,
	};
}

function configuredText(
	overrides: Partial<ConfiguredContributionInput> = {}
): ConfiguredContributionInput {
	return {
		id: 'maestro-system-prompt',
		label: 'Maestro system prompt',
		text: 'x'.repeat(4_000),
		frequency: 'each-spawn',
		source: 'the Maestro system prompt builder, assembled for this agent now',
		...overrides,
	};
}

function input(overrides: Partial<ContextFootprintInput> = {}): ContextFootprintInput {
	return { subject: SUBJECT, components: [], configured: [], notes: [], ...overrides };
}

function deepFreeze<T>(value: T): T {
	if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const child of Object.values(value)) deepFreeze(child);
	}
	return value;
}

/** Every key anywhere in a JSON value. */
function allKeys(value: unknown, keys = new Set<string>()): Set<string> {
	if (Array.isArray(value)) value.forEach((item) => allKeys(item, keys));
	else if (typeof value === 'object' && value !== null) {
		for (const [key, child] of Object.entries(value)) {
			keys.add(key);
			allKeys(child, keys);
		}
	}
	return keys;
}

/** The lines of one report section, from its heading to the next blank line. */
function section(text: string, heading: string): string {
	const start = text.indexOf(heading);
	if (start < 0) throw new Error(`no section ${heading}`);
	const end = text.indexOf('\n\n', start);
	return text.slice(start, end < 0 ? undefined : end);
}

describe('auditContextFootprint', () => {
	describe('estimates and configured text stay apart', () => {
		it('estimates a component from its size and configured text from its length', () => {
			const audit = auditContextFootprint(
				input({
					components: [component({ bytes: 4_001 })],
					configured: [configuredText({ text: 'abcdefghi' })],
				})
			);
			expect(audit.inventory.components[0].estimatedTokens).toBe(1_001);
			expect(audit.configured.contributions[0]).toMatchObject({
				chars: 9,
				estimatedTokens: estimateTokenCount('abcdefghi'),
				basis: 'configured-now',
			});
		});

		it('totals only the inventory: configured additions have no total, so frequencies never mix', () => {
			const audit = auditContextFootprint(
				input({
					components: [
						component({ label: 'a.md', bytes: tokensToBytes(100) }),
						component({ label: 'b.md', bytes: tokensToBytes(250) }),
					],
					configured: [
						configuredText({ text: 'y'.repeat(4_000) }),
						configuredText({
							id: 'new-session-message',
							frequency: 'first-message',
							text: 'z'.repeat(400),
						}),
						configuredText({
							id: 'nudge-message',
							frequency: 'every-message',
							text: 'n'.repeat(40),
						}),
					],
				})
			);
			expect(audit.inventory.estimatedTokens).toBe(350);
			expect(Object.keys(audit.configured)).toEqual(['contributions']);
			const keys = allKeys(audit);
			for (const key of ['total', 'grandTotal', 'combined', 'footprint', 'windowTotal', 'loaded']) {
				expect(keys.has(key), key).toBe(false);
			}
		});

		it('does not retain the configured text, only its size', () => {
			const audit = auditContextFootprint(
				input({ configured: [configuredText({ text: 'PRIVATE-CONDUCTOR-PROFILE '.repeat(40) })] })
			);
			expect(JSON.stringify(audit)).not.toContain('PRIVATE-CONDUCTOR-PROFILE');
			expect(allKeys(audit).has('text')).toBe(false);
		});

		it('keeps a component that has a bound record in the inventory, not among the configured text', () => {
			const audit = auditContextFootprint(
				input({
					components: [
						component({
							activation: {
								state: 'loaded',
								evidence: 'the provider listed it',
								boundTo: 'session-9',
							},
						}),
					],
				})
			);
			expect(audit.configured.contributions).toEqual([]);
			expect(audit.inventory.components[0].activation).toEqual({
				state: 'loaded',
				evidence: 'the provider listed it',
				boundTo: 'session-9',
			});
		});
	});

	describe('activation', () => {
		it('is unknown unless a bound record is supplied, and unknown is not recorded as not loaded', () => {
			const audit = auditContextFootprint(input({ components: [component()] }));
			expect(audit.inventory.components[0].activation).toEqual({ state: 'unknown' });
			expect(JSON.stringify(audit.inventory.components[0].activation)).not.toMatch(
				/not[- ]?loaded|unused|inactive/i
			);
		});

		it('counts only components without a record in the standing note', () => {
			const audit = auditContextFootprint(
				input({
					components: [
						component({ label: 'a.md' }),
						component({
							label: 'b.md',
							activation: { state: 'loaded', evidence: 'listed', boundTo: 'session-9' },
						}),
						component({ label: 'c.md' }),
					],
				})
			);
			const note = audit.unknowns.find((entry) => entry.code === 'activation-unknown');
			expect(note?.message).toContain('2 of 3 inventory components');
		});

		it('says nothing about activation when every component has a record or there are none', () => {
			const none = auditContextFootprint(input());
			const recorded = auditContextFootprint(
				input({
					components: [
						component({
							activation: { state: 'loaded', evidence: 'listed', boundTo: 'session-9' },
						}),
					],
				})
			);
			for (const audit of [none, recorded]) {
				expect(audit.unknowns.map((entry) => entry.code)).not.toContain('activation-unknown');
			}
		});
	});

	describe('configured text is not delivery', () => {
		/** What a prior launch carried is not in the input, so it can never be in the output. */
		const configured = [
			configuredText({ text: 'S'.repeat(8_000) }),
			configuredText({
				id: 'new-session-message',
				label: 'New session message',
				frequency: 'first-message',
				text: 'N'.repeat(400),
				source: "the agent's New Session Message setting, as saved now",
			}),
			configuredText({
				id: 'nudge-message',
				label: 'Nudge message',
				frequency: 'every-message',
				text: 'U'.repeat(120),
				source: "the agent's Nudge Message setting, as saved now",
			}),
		];

		it('leaves delivery and window unknown for a prompt assembled just now', () => {
			const audit = auditContextFootprint(input({ configured: [configured[0]] }));
			expect(audit.configured.contributions[0]).toMatchObject({
				id: 'maestro-system-prompt',
				basis: 'configured-now',
				delivery: { state: 'unknown' },
				window: { state: 'unknown' },
			});
			const text = formatContextFootprint(audit);
			expect(text).toContain('delivery unknown  window unknown');
			expect(text).not.toMatch(/KNOWN LOADED/i);
			expect(text).not.toMatch(/delivered \(|in-window \(/);
		});

		it('sizes a setting changed after a launch as it is now, and says that launch does not hold it', () => {
			// The nudge was saved after the agent launched. Its size is the new text's;
			// nothing says the launch, or any message already sent, carried it.
			const audit = auditContextFootprint(input({ configured: [configured[2]] }));
			expect(audit.configured.contributions[0]).toMatchObject({
				chars: 120,
				estimatedTokens: 30,
				delivery: { state: 'unknown' },
				window: { state: 'unknown' },
			});
			const note = audit.unknowns.find((entry) => entry.code === 'delivery-unknown');
			expect(note?.message).toContain('A setting changed after a launch is not in that launch');
			expect(note?.message).toContain('Maestro keeps no record of what it sent');
		});

		it('names a first-message setting for a new session only, so a resumed tab is not counted', () => {
			const audit = auditContextFootprint(input({ configured: [configured[1]] }));
			expect(audit.configured.contributions[0].frequency).toBe('first-message');
			const text = formatContextFootprint(audit);
			expect(text).toContain(
				'New session message  about 100 tokens  first message of a new session'
			);
			const note = audit.unknowns.find((entry) => entry.code === 'delivery-unknown');
			expect(note?.message).toContain(
				'a resumed session does not get the first-message text again'
			);
		});

		it('never adds the additions together, in the data or in the report', () => {
			const audit = auditContextFootprint(input({ configured }));
			const sum = audit.configured.contributions.reduce(
				(all, entry) => all + entry.estimatedTokens,
				0
			);
			expect(sum).toBe(2_000 + 100 + 30);
			// No number in the audit is that sum.
			const numbers = JSON.stringify(audit).match(/\d+/g) ?? [];
			expect(numbers).not.toContain(String(sum));
			const text = formatContextFootprint(audit);
			expect(section(text, 'MAESTRO-ADDED TEXT')).not.toMatch(/total/i);
			expect(text).toContain('These are separate additions and are not added together');
			expect(text).not.toContain(`${sum.toLocaleString('en-US')} tokens`);
		});

		it('shows a record bound to a launch where a caller supplies one, and only on its own line', () => {
			const audit = auditContextFootprint(
				input({
					configured: [
						configuredText({
							delivery: {
								state: 'delivered',
								evidence: 'the launch prompt matched',
								boundTo: 'launch-7',
							},
						}),
						configured[1],
					],
				})
			);
			const [prompt, newSession] = audit.configured.contributions;
			expect(prompt.delivery).toEqual({
				state: 'delivered',
				evidence: 'the launch prompt matched',
				boundTo: 'launch-7',
			});
			expect(prompt.window).toEqual({ state: 'unknown' });
			expect(newSession.delivery).toEqual({ state: 'unknown' });
			const text = formatContextFootprint(audit);
			expect(text).toContain(
				'delivery delivered (record bound to launch-7: the launch prompt matched)  window unknown'
			);
			expect(text).toContain('delivery unknown  window unknown');
			const note = audit.unknowns.find((entry) => entry.code === 'delivery-unknown');
			expect(note?.message).toContain('1 of 2 Maestro-added texts');
		});

		it('drops the delivery note when every addition has a record', () => {
			const audit = auditContextFootprint(
				input({
					configured: [
						configuredText({
							delivery: { state: 'delivered', evidence: 'matched', boundTo: 'launch-7' },
							window: { state: 'in-window', evidence: 'provider report', boundTo: 'session-9' },
						}),
					],
				})
			);
			expect(audit.unknowns.map((entry) => entry.code)).not.toContain('delivery-unknown');
			expect(formatContextFootprint(audit)).toContain(
				'window in-window (record bound to session-9: provider report)'
			);
		});

		it('keeps "known loaded" and a current-window total out of the contract', () => {
			const audit = auditContextFootprint(
				input({
					components: [component()],
					configured,
					notes: [{ code: 'truncated', message: 'x' }],
				})
			);
			expect(Object.keys(audit).sort()).toEqual([
				'accounting',
				'candidates',
				'configured',
				'inventory',
				'subject',
				'unknowns',
				'version',
			]);
			const keys = [...allKeys(audit)].join(' ');
			// `unknowns` is a key; `known...` or a window/current-context figure must not be.
			expect(keys).not.toMatch(/\bknown|windowTokens|currentContext/i);
			expect(formatContextFootprint(audit)).not.toMatch(/KNOWN LOADED/i);
			expect(formatContextFootprint(audit)).not.toMatch(/current context/i);
		});
	});

	describe('candidate overhead', () => {
		it('lists a component at the threshold and leaves one token below it out', () => {
			const audit = auditContextFootprint(
				input({
					components: [
						component({ label: 'at.md', bytes: tokensToBytes(CANDIDATE_MIN_TOKENS) }),
						component({ label: 'below.md', bytes: tokensToBytes(CANDIDATE_MIN_TOKENS - 1) }),
					],
				})
			);
			expect(audit.candidates.items.map((item) => item.label)).toEqual(['at.md']);
			expect(audit.candidates.minTokens).toBe(CANDIDATE_MIN_TOKENS);
		});

		it('ranks by estimate, breaks ties by id, and says how many more it left out', () => {
			const count = CANDIDATE_LIMIT + 3;
			const components = Array.from({ length: count }, (_, index) =>
				component({
					kind: 'skill',
					label: `skill-${String(index).padStart(2, '0')}`,
					bytes: tokensToBytes(CANDIDATE_MIN_TOKENS + (index % 2 === 0 ? 500 : 0)),
				})
			);
			const audit = auditContextFootprint(input({ components }));
			expect(audit.candidates.items).toHaveLength(CANDIDATE_LIMIT);
			expect(audit.candidates.omitted).toBe(3);
			expect(audit.candidates.limit).toBe(CANDIDATE_LIMIT);
			const estimates = audit.candidates.items.map((item) => item.estimatedTokens);
			expect([...estimates].sort((a, b) => b - a)).toEqual(estimates);
			// The larger half (even indexes) comes first, in id order.
			expect(audit.candidates.items[0].label).toBe('skill-00');
			expect(audit.candidates.items[1].label).toBe('skill-02');
		});

		it('carries its provenance, its basis and its activation', () => {
			const audit = auditContextFootprint(
				input({
					components: [
						component({
							kind: 'memory-index',
							scope: 'account',
							label: 'memory/MEMORY.md',
							path: '/accounts/main/projects/p/memory/MEMORY.md',
							discoveredBy: 'memory store listing',
							bytes: tokensToBytes(2_000),
						}),
					],
				})
			);
			expect(audit.candidates.items).toEqual([
				{
					id: 'account:memory-index:memory/MEMORY.md',
					kind: 'memory-index',
					scope: 'account',
					label: 'memory/MEMORY.md',
					path: '/accounts/main/projects/p/memory/MEMORY.md',
					discoveredBy: 'memory store listing',
					activation: { state: 'unknown' },
					estimatedTokens: 2_000,
					basis: 'file-size',
					reason: 'large-component',
				},
			]);
		});

		it('never invents an estimate for a component whose size is unknown', () => {
			const audit = auditContextFootprint(
				input({
					components: [component({ kind: 'mcp-server', label: '.mcp.json: docs', bytes: null })],
				})
			);
			expect(audit.inventory.components[0].estimatedTokens).toBeNull();
			expect(audit.candidates.items).toEqual([]);
			expect(audit.inventory.estimatedTokens).toBe(0);
		});

		it('does not list configured text as a candidate, however large', () => {
			const audit = auditContextFootprint(
				input({ configured: [configuredText({ text: 'z'.repeat(40_000) })] })
			);
			expect(audit.candidates.items).toEqual([]);
			expect(audit.configured.contributions[0].estimatedTokens).toBe(10_000);
		});
	});

	describe('rollups', () => {
		it('totals each kind that is present, in the fixed kind order, and counts unmeasured ones', () => {
			const audit = auditContextFootprint(
				input({
					components: [
						component({ kind: 'skill', label: 's1', bytes: tokensToBytes(30) }),
						component({ kind: 'instruction', label: 'i1', bytes: 400 }),
						component({ kind: 'skill', label: 's2', bytes: tokensToBytes(70) }),
						component({ kind: 'mcp-server', label: 'm1', bytes: null }),
						component({ kind: 'mcp-server', label: 'm2', bytes: null }),
					],
				})
			);
			expect(audit.inventory.byKind).toEqual([
				{ kind: 'instruction', count: 1, bytes: 400, estimatedTokens: 100, unmeasured: 0 },
				{ kind: 'skill', count: 2, bytes: 400, estimatedTokens: 100, unmeasured: 0 },
				{ kind: 'mcp-server', count: 2, bytes: 0, estimatedTokens: 0, unmeasured: 2 },
			]);
			const order = audit.inventory.byKind.map((total) => FOOTPRINT_KINDS.indexOf(total.kind));
			expect([...order].sort((a, b) => a - b)).toEqual(order);
		});

		it('sorts components by kind, then size, then id', () => {
			const audit = auditContextFootprint(
				input({
					components: [
						component({ kind: 'skill', label: 'b', bytes: 40 }),
						component({ kind: 'skill', label: 'a', bytes: 40 }),
						component({ kind: 'skill', label: 'big', bytes: 4_000 }),
						component({ kind: 'instruction', label: 'z', bytes: 4 }),
					],
				})
			);
			expect(audit.inventory.components.map((entry) => entry.label)).toEqual([
				'z',
				'big',
				'a',
				'b',
			]);
		});
	});

	describe('what it says it does not know', () => {
		it('always names the provider-side prompt, even for an empty inventory', () => {
			const audit = auditContextFootprint(input());
			expect(audit.unknowns.map((entry) => entry.code)).toEqual(['provider-prompt']);
		});

		it('names MCP tool definitions as unmeasured, with the right plural', () => {
			const one = auditContextFootprint(
				input({ components: [component({ kind: 'mcp-server', label: 'a', bytes: null })] })
			);
			const two = auditContextFootprint(
				input({
					components: [
						component({ kind: 'mcp-server', label: 'a', bytes: null }),
						component({ kind: 'mcp-server', label: 'b', bytes: null }),
					],
				})
			);
			const message = (audit: typeof one) =>
				audit.unknowns.find((entry) => entry.code === 'mcp-tool-definitions')?.message;
			expect(message(one)).toContain('1 MCP server is declared');
			expect(message(two)).toContain('2 MCP servers are declared');
			expect(message(two)).toContain('size is unknown');
		});

		it("keeps the collector's notes first and in order", () => {
			const audit = auditContextFootprint(
				input({
					notes: [
						{ code: 'truncated', message: 'first' },
						{ code: 'unreadable', message: 'second' },
					],
					components: [component()],
				})
			);
			expect(audit.unknowns.slice(0, 2).map((entry) => entry.message)).toEqual(['first', 'second']);
			expect(audit.unknowns.map((entry) => entry.code)).toContain('activation-unknown');
		});
	});

	describe('purity', () => {
		it('gives the same audit whatever order the components arrive in', () => {
			const components = [
				component({ kind: 'skill', label: 'one', bytes: 9_000 }),
				component({ kind: 'memory', label: 'two', bytes: 5_000 }),
				component({ kind: 'instruction', label: 'three', bytes: 7_000 }),
				component({ kind: 'skill', label: 'four', bytes: 9_000 }),
			];
			const forward = auditContextFootprint(input({ components }));
			const backward = auditContextFootprint(input({ components: [...components].reverse() }));
			expect(backward).toEqual(forward);
		});

		it('reads frozen input and shares no mutable state with it', () => {
			const frozen = deepFreeze(
				input({
					components: [
						component({
							aliases: ['AGENTS.md'],
							activation: { state: 'loaded', evidence: 'listed', boundTo: 'session-9' },
						}),
					],
					configured: [
						configuredText({
							delivery: { state: 'delivered', evidence: 'matched', boundTo: 'launch-7' },
						}),
					],
					notes: [{ code: 'truncated', message: 'cut' }],
				})
			);
			const audit = auditContextFootprint(frozen);
			audit.inventory.components[0].aliases?.push('changed');
			audit.subject.agentId = 'changed';
			(audit.configured.contributions[0].delivery as { evidence: string }).evidence = 'changed';
			expect(frozen.components[0].aliases).toEqual(['AGENTS.md']);
			expect(frozen.subject.agentId).toBe('agent-1');
			expect(frozen.configured[0].delivery).toMatchObject({ evidence: 'matched' });
		});

		it('gives a component an id made of its scope, kind and label', () => {
			const audit = auditContextFootprint(
				input({
					components: [component({ scope: 'account', kind: 'skill', label: '<account>/skills/x' })],
				})
			);
			expect(audit.inventory.components[0].id).toBe('account:skill:<account>/skills/x');
		});
	});

	describe('accounting', () => {
		it('is not a saving, in a field a consumer can check', () => {
			const audit = auditContextFootprint(input({ components: [component()] }));
			expect(audit.accounting.countsAsSavings).toBe(false);
			expect(audit.accounting.note).toMatch(/nothing here is added to token proxy savings/i);
		});

		it('uses no saving vocabulary anywhere else in its shape', () => {
			const audit = auditContextFootprint(
				input({
					components: [component(), component({ kind: 'mcp-server', label: 'm', bytes: null })],
					configured: [configuredText()],
					notes: [{ code: 'truncated', message: 'cut' }],
				})
			);
			const savingKeys = [...allKeys(audit)].filter((key) => /sav(e|ed|ing)/i.test(key));
			expect(savingKeys).toEqual(['countsAsSavings']);
		});
	});
});

describe('formatContextFootprint', () => {
	function fullAudit() {
		return auditContextFootprint(
			input({
				components: [
					component({ label: 'CLAUDE.md', bytes: tokensToBytes(5_200) }),
					component({
						kind: 'skill',
						scope: 'account',
						label: '<account>/skills/review',
						path: '/accounts/main/skills/review/SKILL.md',
						discoveredBy: 'account skills folder <account>/skills',
						bytes: tokensToBytes(2_400),
						activation: {
							state: 'loaded',
							evidence: 'the provider listed it',
							boundTo: 'session-9',
						},
					}),
					component({ kind: 'skill', label: '.claude/skills/small', bytes: 40 }),
					component({ kind: 'mcp-server', label: '.mcp.json: docs', bytes: null }),
				],
				configured: [
					configuredText(),
					configuredText({
						id: 'nudge-message',
						label: 'Nudge message',
						text: 'n'.repeat(120),
						frequency: 'every-message',
						source: "the agent's Nudge Message setting, as saved now",
					}),
				],
				notes: [{ code: 'truncated', message: 'The memory store has 900 entries.' }],
			})
		);
	}

	it('prints the sections in order: Maestro-added text, inventory, candidates, unknown', () => {
		const text = formatContextFootprint(fullAudit());
		const at = (heading: string) => text.indexOf(heading);
		expect(at('CONTEXT FOOTPRINT  Docs Agent (claude-code)')).toBe(0);
		expect(at('MAESTRO-ADDED TEXT')).toBeGreaterThan(0);
		expect(at('INVENTORY ON DISK')).toBeGreaterThan(at('MAESTRO-ADDED TEXT'));
		expect(at('CANDIDATE OVERHEAD')).toBeGreaterThan(at('INVENTORY ON DISK'));
		expect(at('UNKNOWN')).toBeGreaterThan(at('CANDIDATE OVERHEAD'));
	});

	it('says estimates, and not a measure of what a provider loaded, and mentions saving only to disclaim it', () => {
		const text = formatContextFootprint(fullAudit());
		expect(text).toContain('Estimates only.');
		expect(text).toContain('nothing here is a measure of what a provider loaded');
		expect(text).toContain('Nothing here is counted as compression savings');
		expect(text.match(/saving/gi)).toHaveLength(1);
	});

	it('sizes each addition on its own, with how often it arrives, its source and what is unknown', () => {
		const text = formatContextFootprint(fullAudit());
		expect(text).toContain('Maestro system prompt  about 1,000 tokens  each spawn');
		expect(text).toContain('Nudge message  about 30 tokens  every message');
		expect(text).toContain("source: the agent's Nudge Message setting, as saved now");
		expect(text).toContain('delivery unknown  window unknown');
		expect(text).not.toContain('KNOWN LOADED');
	});

	it('rolls the inventory up by kind and says "size unknown" where it is', () => {
		const text = formatContextFootprint(fullAudit());
		expect(text).toContain('1 instruction file: 5,200 tokens');
		expect(text).toContain('2 skills: 2,410 tokens');
		expect(text).toContain('1 MCP server: size unknown');
		expect(text).toContain('Total 7,610 tokens on disk');
	});

	it('writes a candidate with its kind, scope, size, activation, path and finder', () => {
		const text = formatContextFootprint(fullAudit());
		expect(text).toContain(
			'1. CLAUDE.md  [instruction, project]  about 5,200 tokens if loaded in full  activation unknown'
		);
		expect(text).toContain(
			'2. <account>/skills/review  [skill, account]  about 2,400 tokens if loaded in full  activation loaded (record bound to session-9: the provider listed it)'
		);
		expect(text).toContain(
			'/accounts/main/skills/review/SKILL.md  (found by account skills folder <account>/skills)'
		);
		expect(text).toContain('A candidate is not a finding.');
	});

	it('shows how many candidates it left out', () => {
		const components = Array.from({ length: CANDIDATE_LIMIT + 2 }, (_, index) =>
			component({ label: `file-${index}`, bytes: tokensToBytes(CANDIDATE_MIN_TOKENS) })
		);
		const text = formatContextFootprint(auditContextFootprint(input({ components })));
		expect(text).toContain('2 more at or above that size are not listed.');
	});

	it('reports each empty section as empty, not as healthy', () => {
		const text = formatContextFootprint(auditContextFootprint(input()));
		expect(text).toContain('none configured');
		expect(text).toContain('nothing found');
		expect(text).toMatch(/CANDIDATE OVERHEAD[^\n]*\n {2}none/);
		expect(text).toContain("provider's own system prompt");
	});

	it('lists every unknown as a line of its own', () => {
		const text = formatContextFootprint(fullAudit());
		expect(text).toContain('  - The memory store has 900 entries.');
		expect(text).toContain('  - 3 of 4 inventory components have no record');
		expect(text).toContain('  - 2 of 2 Maestro-added texts are sized as configured now');
	});

	it('is plain text with no dashes the repository bans, and no file content', () => {
		const text = formatContextFootprint(fullAudit());
		// Built from code points so this file itself carries neither banned dash.
		const bannedDashes = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);
		expect(text).not.toMatch(bannedDashes);
		expect(text).not.toMatch(/\u001b\[/);
		expect(text).not.toContain('x'.repeat(40));
	});

	it('names the agent by id when it has no name, and leaves out an account it does not have', () => {
		const text = formatContextFootprint(
			auditContextFootprint(
				input({ subject: { agentId: 'agent-9', toolType: 'codex', projectRoot: '/p' } })
			)
		);
		expect(text.startsWith('CONTEXT FOOTPRINT  agent-9 (codex)')).toBe(true);
		expect(text).not.toContain('Account  ');
	});
});
