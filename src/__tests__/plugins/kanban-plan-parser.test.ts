/**
 * @file kanban-plan-parser.test.ts
 * @description Adversarial suite for the Phase 07 plan contract inside
 * `examples/plugins/maestro-kanban/main.js`: `extractPlanJson`, `parsePlan`,
 * and `renderPlanPrompt`. All three are pure (a board context and a card
 * list in, a plan or a prompt out), so this suite loads `main.js` directly
 * via `createRequire`, the same way `kanban-board-model.test.ts` does, and
 * calls the functions straight through with no stub `maestro` SDK.
 *
 * Every rejection case also asserts the accepted subset beside it: a plan
 * that half-parses still has to tell the caller what it DID accept, not
 * only what it refused.
 */

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mainPath = require.resolve('../../../examples/plugins/maestro-kanban/main.js');

interface PlanCard {
	key: string;
	columnId?: string;
	projectPath?: string;
	sessionId?: string;
	tabId?: string;
	accessGranted?: boolean;
}

interface PlanBoardContext {
	global: boolean;
	globalBoard: null;
	projectBoards: null;
	wipCap: number;
}

interface PlanMoveEntry {
	cardKey: string;
	fromColumnId: string | null;
	toColumnId: string;
	why: string;
	overCap: boolean;
	capReason: string | null;
}

interface PlanMessageEntry {
	cardKey: string;
	sessionId: string;
	tabId: string;
	prompt: string;
	why: string;
	needsAccess: boolean;
	overCap: boolean;
	capReason: string | null;
}

interface PlanRejection {
	kind: 'move' | 'message';
	cardKey: string | null;
	reason: string;
	entry: string;
}

interface PlanResult {
	ok: boolean;
	error: string | null;
	raw: string | null;
	planId: string | null;
	version: number | null;
	rationale: string;
	moves: PlanMoveEntry[];
	messages: PlanMessageEntry[];
	rejected: PlanRejection[];
	cardsTouched: number;
	deferredCount: number;
	wipCap: number;
}

interface KanbanPlanParser {
	PLAN_CONTRACT_VERSION: number;
	extractPlanJson: (text: string) => { value?: unknown; error: string | null };
	parsePlan: (
		text: string,
		expectedPlanId: string,
		board: PlanBoardContext,
		cards: PlanCard[]
	) => PlanResult;
	renderPlanPrompt: (snapshot: Record<string, unknown>) => string;
}

/** Fresh module state per test, mirroring every other suite that loads
 * `main.js` directly: these functions are pure, but reloading keeps this
 * suite independent of load order relative to suites that mutate module
 * state elsewhere in the file. */
function loadMain(): KanbanPlanParser {
	delete require.cache[mainPath];
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	return require(mainPath) as KanbanPlanParser;
}

const EXPECTED_PLAN_ID = 'plan-test-0001';

function makeBoard(wipCap = 3): PlanBoardContext {
	return { global: false, globalBoard: null, projectBoards: null, wipCap: wipCap };
}

function makeCard(overrides: Partial<PlanCard> & { key: string }): PlanCard {
	return {
		columnId: 'backlog',
		projectPath: '/Users/example/code/my-app',
		sessionId: 'session-' + overrides.key,
		tabId: 'tab-' + overrides.key,
		accessGranted: true,
		...overrides,
	};
}

/** A minimal, valid plan body, as JSON text, with the given moves/messages
 * spliced in. `version` and `planId` are always the ones a real run would
 * ask for unless a test overrides them. */
function planText(body: Record<string, unknown>): string {
	return JSON.stringify({
		version: 1,
		planId: EXPECTED_PLAN_ID,
		rationale: 'test rationale',
		moves: [],
		messages: [],
		...body,
	});
}

describe('maestro-kanban main.js: Phase 07 plan contract', () => {
	describe('parsePlan: a clean plan', () => {
		it('accepts a move and a message that both obey the rules', () => {
			const { parsePlan } = loadMain();
			const cardA = makeCard({ key: 'card-a', columnId: 'backlog' });
			const cardB = makeCard({ key: 'card-b', columnId: 'in-progress' });
			const text = planText({
				moves: [{ cardKey: 'card-a', toColumnId: 'review', why: 'ready for review' }],
				messages: [{ cardKey: 'card-b', prompt: 'please add a test', why: 'coverage gap' }],
			});
			const result = parsePlan(text, EXPECTED_PLAN_ID, makeBoard(3), [cardA, cardB]);
			expect(result.ok).toBe(true);
			expect(result.error).toBeNull();
			expect(result.rejected).toEqual([]);
			expect(result.moves).toEqual([
				{
					cardKey: 'card-a',
					fromColumnId: 'backlog',
					toColumnId: 'review',
					why: 'ready for review',
					overCap: false,
					capReason: null,
				},
			]);
			expect(result.messages).toEqual([
				{
					cardKey: 'card-b',
					sessionId: 'session-card-b',
					tabId: 'tab-card-b',
					prompt: 'please add a test',
					why: 'coverage gap',
					needsAccess: false,
					overCap: false,
					capReason: null,
				},
			]);
			expect(result.cardsTouched).toBe(2);
			expect(result.deferredCount).toBe(0);
		});
	});

	describe('parsePlan: chatty prose around one fenced block', () => {
		it('still parses the plan out of surrounding commentary', () => {
			const { parsePlan } = loadMain();
			const cardA = makeCard({ key: 'card-a', columnId: 'backlog' });
			const body = planText({
				moves: [{ cardKey: 'card-a', toColumnId: 'review', why: 'ready for review' }],
			});
			const text =
				'Here is my plan for this board, I thought it through carefully.\n\n```json\n' +
				body +
				'\n```\n\nLet me know if you want changes.\n';
			const result = parsePlan(text, EXPECTED_PLAN_ID, makeBoard(3), [cardA]);
			expect(result.ok).toBe(true);
			expect(result.rejected).toEqual([]);
			expect(result.moves).toHaveLength(1);
			expect(result.moves[0].cardKey).toBe('card-a');
			expect(result.moves[0].toColumnId).toBe('review');
		});
	});

	describe('parsePlan: no JSON at all', () => {
		it('rejects the whole plan and keeps the accepted subset empty', () => {
			const { parsePlan } = loadMain();
			const cardA = makeCard({ key: 'card-a' });
			const text = 'I reviewed the board and decided not to change anything right now.';
			const result = parsePlan(text, EXPECTED_PLAN_ID, makeBoard(3), [cardA]);
			expect(result.ok).toBe(false);
			expect(result.error).toContain('there is no JSON plan');
			expect(result.moves).toEqual([]);
			expect(result.messages).toEqual([]);
			expect(result.raw).toContain('I reviewed the board');
		});
	});

	describe('parsePlan: two JSON blocks', () => {
		it('refuses to guess which fenced block is the plan', () => {
			const { parsePlan } = loadMain();
			const cardA = makeCard({ key: 'card-a' });
			const text =
				'A draft, then a revision:\n\n```json\n{"a":1}\n```\n\nActually, use this one instead:\n\n```json\n{"b":2}\n```\n';
			const result = parsePlan(text, EXPECTED_PLAN_ID, makeBoard(3), [cardA]);
			expect(result.ok).toBe(false);
			expect(result.error).toContain('2 JSON blocks');
			expect(result.moves).toEqual([]);
			expect(result.messages).toEqual([]);
		});
	});

	describe('parsePlan: a mismatched planId', () => {
		it('rejects a plan answering a different request', () => {
			const { parsePlan } = loadMain();
			const cardA = makeCard({ key: 'card-a' });
			const text = planText({ planId: 'plan-some-other-request' });
			const result = parsePlan(text, EXPECTED_PLAN_ID, makeBoard(3), [cardA]);
			expect(result.ok).toBe(false);
			expect(result.error).toContain('a different request');
			expect(result.moves).toEqual([]);
			expect(result.messages).toEqual([]);
			expect(result.raw).not.toBeNull();
		});
	});

	describe('parsePlan: a card key that does not exist', () => {
		it('rejects the bad entry and still accepts a valid sibling', () => {
			const { parsePlan } = loadMain();
			const cardA = makeCard({ key: 'card-a', columnId: 'backlog' });
			const text = planText({
				moves: [
					{ cardKey: 'card-a', toColumnId: 'review', why: 'ready' },
					{ cardKey: 'card-does-not-exist', toColumnId: 'review', why: 'ready' },
				],
			});
			const result = parsePlan(text, EXPECTED_PLAN_ID, makeBoard(3), [cardA]);
			expect(result.ok).toBe(true);
			expect(result.moves).toHaveLength(1);
			expect(result.moves[0].cardKey).toBe('card-a');
			expect(result.rejected).toHaveLength(1);
			expect(result.rejected[0]).toMatchObject({
				kind: 'move',
				cardKey: 'card-does-not-exist',
			});
			expect(result.rejected[0].reason).toContain('no card "card-does-not-exist"');
		});
	});

	describe('parsePlan: an illegal column for a legal card', () => {
		it('rejects a move to a column that card may not occupy', () => {
			const { parsePlan } = loadMain();
			const cardA = makeCard({ key: 'card-a', columnId: 'backlog' });
			const cardB = makeCard({ key: 'card-b', columnId: 'in-progress' });
			const text = planText({
				moves: [
					{ cardKey: 'card-a', toColumnId: 'review', why: 'ready' },
					{ cardKey: 'card-b', toColumnId: 'nonexistent-column', why: 'ready' },
				],
			});
			const result = parsePlan(text, EXPECTED_PLAN_ID, makeBoard(3), [cardA, cardB]);
			expect(result.ok).toBe(true);
			expect(result.moves).toHaveLength(1);
			expect(result.moves[0].cardKey).toBe('card-a');
			expect(result.rejected).toHaveLength(1);
			expect(result.rejected[0].kind).toBe('move');
			expect(result.rejected[0].cardKey).toBe('card-b');
			expect(result.rejected[0].reason).toContain('may not be moved to');
			expect(result.rejected[0].reason).toContain('nonexistent-column');
		});
	});

	describe('parsePlan: a message with an empty prompt', () => {
		it('rejects the empty message and still accepts a valid sibling', () => {
			const { parsePlan } = loadMain();
			const cardA = makeCard({ key: 'card-a' });
			const cardB = makeCard({ key: 'card-b' });
			const text = planText({
				messages: [
					{ cardKey: 'card-a', prompt: 'a real question', why: 'checking in' },
					{ cardKey: 'card-b', prompt: '', why: 'checking in' },
				],
			});
			const result = parsePlan(text, EXPECTED_PLAN_ID, makeBoard(3), [cardA, cardB]);
			expect(result.ok).toBe(true);
			expect(result.messages).toHaveLength(1);
			expect(result.messages[0].cardKey).toBe('card-a');
			expect(result.rejected).toHaveLength(1);
			expect(result.rejected[0]).toMatchObject({ kind: 'message', cardKey: 'card-b' });
			expect(result.rejected[0].reason).toContain('no prompt to send');
		});
	});

	describe('parsePlan: a message to an ungranted card', () => {
		it('accepts the message but marks it needsAccess rather than rejecting it', () => {
			const { parsePlan } = loadMain();
			const cardC = makeCard({ key: 'card-c', accessGranted: false });
			const text = planText({
				messages: [{ cardKey: 'card-c', prompt: 'please add a test', why: 'coverage gap' }],
			});
			const result = parsePlan(text, EXPECTED_PLAN_ID, makeBoard(3), [cardC]);
			expect(result.ok).toBe(true);
			expect(result.rejected).toEqual([]);
			expect(result.messages).toHaveLength(1);
			expect(result.messages[0]).toMatchObject({ cardKey: 'card-c', needsAccess: true });
		});
	});

	describe('parsePlan: a plan exceeding the WIP cap', () => {
		it('holds the excess as pending rather than rejecting or dropping it', () => {
			const { parsePlan } = loadMain();
			const cardA = makeCard({ key: 'card-a', columnId: 'backlog' });
			const cardB = makeCard({ key: 'card-b', columnId: 'in-progress' });
			const text = planText({
				moves: [
					{ cardKey: 'card-a', toColumnId: 'review', why: 'ready' },
					{ cardKey: 'card-b', toColumnId: 'blocked', why: 'blocked on review' },
				],
			});
			const result = parsePlan(text, EXPECTED_PLAN_ID, makeBoard(1), [cardA, cardB]);
			expect(result.ok).toBe(true);
			expect(result.rejected).toEqual([]);
			expect(result.moves).toHaveLength(2);
			expect(result.moves[0]).toMatchObject({ cardKey: 'card-a', overCap: false, capReason: null });
			expect(result.moves[1].cardKey).toBe('card-b');
			expect(result.moves[1].overCap).toBe(true);
			expect(result.moves[1].capReason).toContain('held as pending');
			expect(result.cardsTouched).toBe(1);
			expect(result.deferredCount).toBe(1);
		});
	});

	describe('parsePlan: a plan proposing card creation', () => {
		it('rejects an unknown top-level key that would create a card', () => {
			const { parsePlan } = loadMain();
			const cardA = makeCard({ key: 'card-a' });
			const text = planText({ cards: [{ title: 'A brand new card' }] });
			const result = parsePlan(text, EXPECTED_PLAN_ID, makeBoard(3), [cardA]);
			expect(result.ok).toBe(false);
			expect(result.error).toContain('"cards"');
			expect(result.moves).toEqual([]);
			expect(result.messages).toEqual([]);
		});

		it('rejects an entry carrying an unknown key that would create a card', () => {
			const { parsePlan } = loadMain();
			const cardA = makeCard({ key: 'card-a', columnId: 'backlog' });
			const cardB = makeCard({ key: 'card-b', columnId: 'in-progress' });
			const text = planText({
				moves: [
					{ cardKey: 'card-a', toColumnId: 'review', why: 'ready' },
					{ cardKey: 'card-b', toColumnId: 'review', why: 'ready', createCard: true },
				],
			});
			const result = parsePlan(text, EXPECTED_PLAN_ID, makeBoard(3), [cardA, cardB]);
			expect(result.ok).toBe(true);
			expect(result.moves).toHaveLength(1);
			expect(result.moves[0].cardKey).toBe('card-a');
			expect(result.rejected).toHaveLength(1);
			expect(result.rejected[0]).toMatchObject({ kind: 'move', cardKey: 'card-b' });
			expect(result.rejected[0].reason).toContain('"createCard"');
		});
	});

	describe('parsePlan: malformed JSON', () => {
		it('rejects a plan file that is not valid JSON', () => {
			const { parsePlan } = loadMain();
			const cardA = makeCard({ key: 'card-a' });
			const text = '{ "version": 1, "planId": "plan-test-0001", not valid json here';
			const result = parsePlan(text, EXPECTED_PLAN_ID, makeBoard(3), [cardA]);
			expect(result.ok).toBe(false);
			expect(result.error).toContain('not valid JSON');
			expect(result.moves).toEqual([]);
			expect(result.messages).toEqual([]);
		});
	});

	describe('renderPlanPrompt: a plan large enough to blow the snapshot budget', () => {
		it('trims the card list and says how many cards did not fit', () => {
			const { renderPlanPrompt } = loadMain();
			const cardCount = 300;
			const cards = Array.from({ length: cardCount }, (_, i) => ({
				key: 'card-' + i,
				title: 'Card number ' + i,
				agentId: 'agent-' + i,
				projectName: 'Example Project',
				projectPath: '/Users/example/code/my-app',
				columnId: 'backlog',
				status: 'idle',
				lastActivityAt: Date.now(),
				accessGranted: true,
				movableTo: ['backlog', 'in-progress', 'review', 'blocked', 'done'],
				description:
					'A long description of what this card is for, written to realistically fill space in the rendered prompt rather than being a one-word placeholder. '.repeat(
						2
					),
				comments: [],
				history: [],
			}));
			const snapshot = {
				boardName: 'Example Board',
				boardId: 'board-1',
				mode: 'plan-approve',
				global: false,
				boardError: null,
				columns: [{ id: 'backlog', title: 'Backlog', cardCount: cardCount }],
				wipCap: 3,
				halted: false,
				haltedAt: null,
				planFile: 'plans/plan-test-0001.json',
				planId: EXPECTED_PLAN_ID,
				now: Date.now(),
				cards: cards,
			};
			const prompt = renderPlanPrompt(snapshot);
			expect(prompt).toContain('### `card-0`');
			expect(prompt).not.toContain('### `card-299`');
			expect(prompt).toMatch(
				/\d+ further card\(s\) are on this board but did not fit in this prompt/
			);
		});
	});
});
