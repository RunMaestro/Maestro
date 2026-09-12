/**
 * Agent Flow overlay panel (`examples/plugins/agent-flow/panel.html`).
 *
 * The panel is a standalone document rendered in a locked-down <webview> guest,
 * so there is nothing to import: the test loads the real file, mounts its body
 * markup into jsdom and evaluates its inline script, then drives it exactly as
 * the host does - inbound `maestro:panelData` messages in, outbound
 * `maestro:invokeCommand` postMessages out.
 *
 * Covers the Phase 1 shared-canvas overlay: one node per agent, satellite tool
 * cards, click-to-jump on a node and on a FINISHED card only, the focused-agent
 * highlight from `snapshot.focusedSessionId`, and the metadata-only rule (tool
 * name + phase + duration, nothing else).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const PANEL_HTML = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'../../../examples/plugins/agent-flow/panel.html'
);

interface OutboundMessage {
	type: string;
	commandId: string;
	args?: { sessionId?: string };
}

let posted: OutboundMessage[] = [];

/** Mount the panel document and run its script, as the guest would. */
function mountPanel(): void {
	const html = fs.readFileSync(PANEL_HTML, 'utf8');
	const body = /<body>([\s\S]*?)<script>/.exec(html);
	const script = /<script>([\s\S]*?)<\/script>/.exec(html);
	if (!body || !script) throw new Error('panel.html shape changed: body/script not found');
	document.body.innerHTML = body[1];
	// `parent === window` in a top-level guest, so the outbound bridge lands here.
	vi.spyOn(window, 'postMessage').mockImplementation((message: unknown) => {
		posted.push(message as OutboundMessage);
	});
	new Function(script[1])();
}

/** Push a snapshot in the same shape `ui.panelPost` delivers. */
function pushSnapshot(data: unknown): void {
	window.dispatchEvent(new MessageEvent('message', { data: { type: 'maestro:panelData', data } }));
}

function lane(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		sessionId: 's1',
		title: 'Alpha',
		agentId: 'claude-code',
		status: 'busy',
		usage: null,
		nodes: [],
		lastActivityAt: Date.now(),
		runningToolCount: 0,
		awaiting: false,
		lastError: null,
		...overrides,
	};
}

function jumps(): (string | undefined)[] {
	return posted.filter((m) => m.commandId === 'jump').map((m) => m.args?.sessionId);
}

function agentNodes(): SVGGElement[] {
	return Array.from(document.querySelectorAll('.agent')) as unknown as SVGGElement[];
}

beforeEach(() => {
	posted = [];
	vi.useFakeTimers();
	mountPanel();
});

afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.restoreAllMocks();
	document.body.innerHTML = '';
});

describe('agent-flow panel', () => {
	it('asks the sandbox for the current snapshot on load', () => {
		expect(posted).toEqual([{ type: 'maestro:invokeCommand', commandId: 'sync', args: undefined }]);
		expect(document.getElementById('empty')?.classList.contains('hidden')).toBe(false);
	});

	it('renders one node per agent on the shared canvas', () => {
		pushSnapshot({ v: 1, at: 0, lanes: [lane(), lane({ sessionId: 's2', title: 'Beta' })] });

		const nodes = agentNodes();
		expect(nodes.map((n) => n.getAttribute('data-session'))).toEqual(['s1', 's2']);
		expect(document.getElementById('empty')?.classList.contains('hidden')).toBe(true);
		// Both nodes share ONE canvas rather than getting a lane row each.
		expect(document.querySelectorAll('#viewport > .agent')).toHaveLength(2);
	});

	it('colours the node with the status language and pulses while connecting', () => {
		pushSnapshot({
			v: 1,
			at: 0,
			lanes: [
				lane({ sessionId: 'idle', status: 'idle' }),
				lane({ sessionId: 'conn', status: 'connecting' }),
				lane({ sessionId: 'err', status: 'error' }),
			],
		});

		const kindOf = (sid: string) =>
			document.querySelector(`.agent[data-session="${sid}"] .core`)?.getAttribute('class');
		expect(kindOf('idle')).toContain('k-idle');
		expect(kindOf('conn')).toContain('k-connecting');
		expect(kindOf('err')).toContain('k-error');

		const halo = document.querySelector('.agent[data-session="conn"] .halo');
		expect(halo?.getAttribute('class')).toContain('pulsing');
		expect(
			document.querySelector('.agent[data-session="idle"] .halo')?.getAttribute('class')
		).not.toContain('pulsing');
	});

	it('shows a cost pill and a token bar from the snapshot usage', () => {
		pushSnapshot({
			v: 1,
			at: 0,
			lanes: [
				lane({
					usage: {
						inputTokens: 4000,
						outputTokens: 1000,
						cacheReadInputTokens: 0,
						cacheCreationInputTokens: 0,
						totalCostUsd: 0.1234,
						contextWindow: 200000,
						reasoningTokens: 0,
					},
				}),
			],
		});

		const text = Array.from(document.querySelectorAll('#viewport text')).map((t) => t.textContent);
		expect(text).toContain('$0.1234');
		expect(text).toContain('5.0k tokens / 200k');
	});

	it('renders tool satellites with name, phase and duration only', () => {
		pushSnapshot({
			v: 1,
			at: 0,
			lanes: [
				lane({
					nodes: [
						{
							toolCallId: 'a',
							toolName: 'Bash',
							phase: 'completed',
							startedAt: 0,
							endedAt: 1500,
							durationMs: 1500,
						},
					],
				}),
			],
		});

		const card = document.querySelector('.sat');
		expect(card?.getAttribute('class')).toContain('done');
		const labels = Array.from(card?.querySelectorAll('text') ?? []).map((t) => t.textContent);
		expect(labels).toEqual(['Bash', 'completed · 1.5s']);
	});

	it('jumps to the agent session when its node is clicked', () => {
		pushSnapshot({ v: 1, at: 0, lanes: [lane(), lane({ sessionId: 's2' })] });

		agentNodes()[1].dispatchEvent(new MouseEvent('click', { bubbles: true }));

		expect(jumps()).toEqual(['s2']);
	});

	it('jumps from a finished tool card but not from a running one', () => {
		pushSnapshot({
			v: 1,
			at: 0,
			lanes: [
				lane({
					nodes: [
						{ toolCallId: 'a', toolName: 'Read', phase: 'running', startedAt: 0 },
						{
							toolCallId: 'b',
							toolName: 'Bash',
							phase: 'completed',
							startedAt: 0,
							endedAt: 10,
							durationMs: 10,
						},
					],
				}),
			],
		});

		const cards = Array.from(document.querySelectorAll('.sat'));
		expect(cards.map((c) => c.getAttribute('class'))).toEqual(['sat running', 'sat done']);

		// A running card carries no click handler; clicking it must not bubble a jump
		// out of the node group either, so it is dispatched non-bubbling.
		cards[0].dispatchEvent(new MouseEvent('click'));
		expect(jumps()).toEqual([]);

		cards[1].dispatchEvent(new MouseEvent('click'));
		expect(jumps()).toEqual(['s1']);
	});

	it('highlights the focused agent from the snapshot', () => {
		pushSnapshot({
			v: 1,
			at: 0,
			lanes: [lane(), lane({ sessionId: 's2' })],
			focusedSessionId: 's2',
		});

		expect(agentNodes()[0].getAttribute('class')).toBe('agent');
		expect(agentNodes()[1].getAttribute('class')).toBe('agent focused');
		expect(document.querySelectorAll('.focusRing')).toHaveLength(1);
	});

	it('advances the elapsed badge on the clock tick without re-rendering the graph', () => {
		pushSnapshot({
			v: 1,
			at: 0,
			lanes: [lane({ status: 'busy', lastActivityAt: Date.now() })],
			summary: { busyLanes: 1, runningTools: 0, awaitingLanes: 0, erroredLanes: 0 },
		});
		const core = document.querySelector('.core');

		vi.advanceTimersByTime(5000);

		const badges = Array.from(document.querySelectorAll('.health text')).map((t) => t.textContent);
		expect(badges[0]).toBe('Working · 5s');
		// Same element instance: the tick repaints badges only, so the node's CSS
		// animations are not restarted every second.
		expect(document.querySelector('.core')).toBe(core);
		expect(document.getElementById('summary')?.textContent).toContain('1 working');
	});

	it('warns when a working agent has gone quiet', () => {
		pushSnapshot({
			v: 1,
			at: 0,
			lanes: [lane({ status: 'busy', lastActivityAt: Date.now() - 45000 })],
		});

		const badges = Array.from(document.querySelectorAll('.health text')).map((t) => t.textContent);
		expect(badges.some((b) => b?.startsWith('No activity for'))).toBe(true);
	});

	it('dismisses the overlay through the plugin toggle on Escape', () => {
		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

		expect(posted.map((m) => m.commandId)).toContain('overlay');
	});

	it('clears the graph through the plugin command', () => {
		document.getElementById('clear')?.dispatchEvent(new MouseEvent('click'));

		expect(posted.map((m) => m.commandId)).toContain('clear');
	});
});

describe('agent-flow panel "current agent only" filter', () => {
	function toggleFilter(): void {
		document.getElementById('focusOnly')?.dispatchEvent(new MouseEvent('click'));
	}

	function filterHint(): HTMLElement | null {
		return document.getElementById('filterHint');
	}

	function pushThree(focusedSessionId: string): void {
		pushSnapshot({
			v: 1,
			at: 0,
			lanes: [
				lane(),
				lane({ sessionId: 's2', title: 'Beta' }),
				lane({ sessionId: 's3', title: 'Gamma' }),
			],
			focusedSessionId,
		});
	}

	it('is off by default so the fleet view renders untouched', () => {
		pushThree('s2');

		expect(agentNodes()).toHaveLength(3);
		expect(document.getElementById('focusOnly')?.getAttribute('aria-pressed')).toBe('false');
		expect(filterHint()?.classList.contains('hidden')).toBe(true);
		// The all-agents view keeps its focused-agent highlight.
		expect(agentNodes()[1].getAttribute('class')).toBe('agent focused');
	});

	it('renders only the focused agent when toggled on, and restores the fleet when off', () => {
		pushThree('s2');

		toggleFilter();

		const filtered = agentNodes();
		expect(filtered).toHaveLength(1);
		expect(filtered[0].getAttribute('data-session')).toBe('s2');
		expect(document.getElementById('focusOnly')?.getAttribute('aria-pressed')).toBe('true');
		expect(filterHint()?.classList.contains('hidden')).toBe(true);

		toggleFilter();

		expect(agentNodes().map((n) => n.getAttribute('data-session'))).toEqual(['s1', 's2', 's3']);
	});

	it('keeps the filter across snapshots and follows the focus as it moves', () => {
		pushThree('s2');
		toggleFilter();

		pushThree('s3');

		expect(agentNodes().map((n) => n.getAttribute('data-session'))).toEqual(['s3']);
	});

	it('falls back to showing every agent with a hint when nothing is focused', () => {
		pushThree('');

		toggleFilter();

		expect(agentNodes()).toHaveLength(3);
		expect(filterHint()?.classList.contains('hidden')).toBe(false);
		expect(filterHint()?.textContent).toContain('showing all');
	});

	it('falls back with the hint when the focused agent has no lane yet', () => {
		pushThree('s9');

		toggleFilter();

		expect(agentNodes()).toHaveLength(3);
		expect(filterHint()?.classList.contains('hidden')).toBe(false);
	});
});
