/**
 * Tests for the TTSR interrupt toast (plan Phase 4a/4b verification).
 *
 * Two things must hold: the toast params are shaped so the renderer can resolve
 * the agent and jump to it (a composite process id would resolve to nothing),
 * and installing the runtime actually wires that toast to the same `safeSend`
 * that carries `ttsr:triggered` - so an interrupted turn is never silent.
 */

import { EventEmitter } from 'events';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildTtsrToast, emitTtsrTriggeredToast } from '../../../main/ttsr/ttsr-notify';
import { installTtsrRuntime, type TtsrProcessManagerLike } from '../../../main/ttsr';
import type { ParsedEventObserver } from '../../../main/process-manager/types';
import type { TtsrTriggeredPayload } from '../../../shared/ttsr-types';
import { TTSR_RULES_DIR } from '../../../shared/maestro-paths';

function payload(overrides: Partial<TtsrTriggeredPayload> = {}): TtsrTriggeredPayload {
	return {
		sessionId: 'sess-42-ai-tab-1',
		tabId: 'tab-1',
		agentId: 'claude-code',
		rules: [{ name: 'no-console-log', path: '.maestro/rules/no-console-log.md' }],
		injectionPrompt: '<system-interrupt>...</system-interrupt>',
		mode: 'resume',
		providerSessionId: 'prov-1',
		originalGoal: 'Refactor the auth module',
		contextMode: 'keep',
		...overrides,
	};
}

describe('buildTtsrToast', () => {
	it('is an orange sticky toast that jumps to the interrupted tab', () => {
		const toast = buildTtsrToast(payload());

		expect(toast.color).toBe('orange');
		expect(toast.dismissible).toBe(true);
		// The bare agent id, not the `{session}-ai-{tab}` process id: the renderer
		// looks sessions up by the former, so a composite loses both the header
		// strip name and click-to-jump.
		expect(toast.sessionId).toBe('sess-42');
		expect(toast.tabId).toBe('tab-1');
		expect(toast.clickAction).toEqual({
			kind: 'jump-session',
			sessionId: 'sess-42',
			tabId: 'tab-1',
		});
	});

	it('unwraps the forced-parallel session id suffix', () => {
		const toast = buildTtsrToast(payload({ sessionId: 'sess-42-ai-tab-1-fp-1730000000000' }));
		expect(toast.sessionId).toBe('sess-42');
	});

	it('names the agent and the rules that fired', () => {
		const toast = buildTtsrToast(
			payload({
				agentId: 'codex',
				rules: [
					{ name: 'no-console-log', path: 'a.md' },
					{ name: 'no-any', path: 'b.md' },
				],
			})
		);

		expect(toast.title).toBe('TTSR interrupted Codex');
		expect(toast.message).toContain('Rules no-console-log, no-any fired');
		expect(toast.message).toContain('Resuming');
	});

	it('says the turn restarts on the degraded fresh path', () => {
		const toast = buildTtsrToast(
			payload({ agentId: 'grok', mode: 'fresh', providerSessionId: undefined })
		);
		expect(toast.message).toContain('Restarting the turn');
	});
});

describe('emitTtsrTriggeredToast', () => {
	it('sends on the shared remote:notifyToast channel', () => {
		const safeSend = vi.fn();
		emitTtsrTriggeredToast(safeSend, payload());

		expect(safeSend).toHaveBeenCalledWith(
			'remote:notifyToast',
			expect.objectContaining({ color: 'orange', sessionId: 'sess-42' })
		);
	});

	it('swallows a send failure - the corrective turn matters more than the toast', () => {
		const safeSend = vi.fn(() => {
			throw new Error('renderer gone');
		});
		expect(() => emitTtsrTriggeredToast(safeSend, payload())).not.toThrow();
	});
});

/** A process manager stand-in with the three surfaces TTSR installs against. */
class FakeProcessManager extends EventEmitter {
	observer: ParsedEventObserver | null = null;
	interrupted: string[] = [];
	killed: string[] = [];

	setParsedEventObserver(observer: ParsedEventObserver | null): void {
		this.observer = observer;
	}
	interrupt(sessionId: string): boolean {
		this.interrupted.push(sessionId);
		return true;
	}
	kill(sessionId: string): boolean {
		this.killed.push(sessionId);
		return true;
	}
}

describe('installTtsrRuntime notification wiring', () => {
	let projectRoot: string;

	beforeEach(() => {
		projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ttsr-notify-'));
		const dir = path.join(projectRoot, TTSR_RULES_DIR);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			path.join(dir, 'no-console-log.md'),
			[
				'---',
				'description: Flag stray console.log',
				'condition:',
				'  - "console\\\\.log\\\\("',
				'scope: [text]',
				'interruptMode: always',
				'---',
				'Use the project logger.',
			].join('\n'),
			'utf-8'
		);
	});

	afterEach(() => {
		fs.rmSync(projectRoot, { recursive: true, force: true });
	});

	async function interruptOnce(options: { notifyOnInterrupt?: boolean } = {}) {
		const safeSend = vi.fn();
		const pm = new FakeProcessManager();
		const runtime = installTtsrRuntime(pm as unknown as TtsrProcessManagerLike, {
			isGloballyEnabled: () => true,
			safeSend,
			persistence: null,
			...options,
		});

		pm.emit('spawn', {
			sessionId: 'sess-42-ai-tab-1',
			toolType: 'claude-code',
			cwd: projectRoot,
			prompt: 'Refactor the auth module',
			tabId: 'tab-1',
		});
		pm.emit('session-id', 'sess-42-ai-tab-1', 'prov-1');
		pm.observer?.('sess-42-ai-tab-1', { type: 'text', text: 'adding console.log(x)' });
		// The driver holds the corrective payload until the aborted turn exits.
		runtime.driver?.noteExit('sess-42-ai-tab-1');
		await runtime.flushInterrupts();

		return { safeSend, pm, runtime };
	}

	it('raises the toast alongside ttsr:triggered when a turn is interrupted', async () => {
		const { safeSend, pm } = await interruptOnce();

		expect(pm.interrupted).toEqual(['sess-42-ai-tab-1']);
		const channels = safeSend.mock.calls.map((call) => call[0]);
		expect(channels).toContain('ttsr:triggered');
		expect(channels).toContain('remote:notifyToast');
		// The renderer must be told to respawn before it is told about the toast.
		expect(channels.indexOf('ttsr:triggered')).toBeLessThan(channels.indexOf('remote:notifyToast'));

		const toast = safeSend.mock.calls.find((call) => call[0] === 'remote:notifyToast')?.[1];
		expect(toast).toMatchObject({
			color: 'orange',
			dismissible: true,
			sessionId: 'sess-42',
			tabId: 'tab-1',
		});
		expect(toast.message).toContain('no-console-log');
	});

	it('still reinjects when notifications are turned off', async () => {
		const { safeSend } = await interruptOnce({ notifyOnInterrupt: false });

		const channels = safeSend.mock.calls.map((call) => call[0]);
		expect(channels).toContain('ttsr:triggered');
		expect(channels).not.toContain('remote:notifyToast');
	});

	it('raises nothing while the feature gate is off', async () => {
		const safeSend = vi.fn();
		const pm = new FakeProcessManager();
		installTtsrRuntime(pm as unknown as TtsrProcessManagerLike, {
			isGloballyEnabled: () => false,
			safeSend,
			persistence: null,
		});

		pm.emit('spawn', {
			sessionId: 'sess-42-ai-tab-1',
			toolType: 'claude-code',
			cwd: projectRoot,
			prompt: 'Refactor the auth module',
			tabId: 'tab-1',
		});
		pm.observer?.('sess-42-ai-tab-1', { type: 'text', text: 'adding console.log(x)' });

		expect(safeSend).not.toHaveBeenCalled();
		expect(pm.interrupted).toEqual([]);
	});
});
