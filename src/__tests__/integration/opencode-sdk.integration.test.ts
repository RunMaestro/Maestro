/**
 * Live integration test for the OpenCode SDK execution path.
 *
 * Unlike the unit tests (which feed hand-built SDK events through the translator),
 * this test stands up a REAL `opencode serve` via `@opencode-ai/sdk`, sends a real
 * prompt, and drives the actual production translator + parser over the live SSE
 * stream. It proves the end-to-end contract that unit tests can't: that the real
 * server's event/Part shapes match what `OpencodeEventTranslator` expects and that
 * the round-trip yields a usable result + usage.
 *
 * This is the pure-Node slice of the SDK path (server manager logic + translator +
 * parser) - it needs neither Electron nor the app's native modules, so it runs on
 * any machine with `opencode` installed and authenticated.
 *
 * Opt-in only (real network + token cost + local binary): it is SKIPPED unless
 *   OPENCODE_LIVE=1
 * is set. Run with:
 *   OPENCODE_LIVE=1 npm run test:integration -- opencode-sdk.integration.test.ts
 */

import { describe, it, expect } from 'vitest';
import { createOpencodeServer, createOpencodeClient, type Event } from '@opencode-ai/sdk';
import { OpencodeEventTranslator } from '../../main/opencode-server/event-translator';
import { OpenCodeOutputParser } from '../../main/parsers/opencode-output-parser';
import type { ParsedEvent } from '../../main/parsers';

const LIVE = process.env.OPENCODE_LIVE === '1';

describe.skipIf(!LIVE)('OpenCode SDK live integration', () => {
	it('drives a real turn through the production translator + parser', async () => {
		const server = await createOpencodeServer({
			hostname: '127.0.0.1',
			port: 0,
			timeout: 20000,
		});

		try {
			const client = createOpencodeClient({ baseUrl: server.url });

			const created = await client.session.create({ query: { directory: process.cwd() } });
			const sessionId = created.data?.id;
			expect(sessionId, 'session.create should return an id').toBeTruthy();

			const translator = new OpencodeEventTranslator(sessionId as string);
			const parser = new OpenCodeOutputParser();

			// Exactly the production pipeline: SSE Event -> translator -> JSONL line ->
			// parser -> normalized ParsedEvent.
			const parsedEvents: ParsedEvent[] = [];
			const rawEventTypes: string[] = [];

			const subscription = await client.event.subscribe();
			const pump = (async () => {
				for await (const event of subscription.stream as AsyncIterable<Event>) {
					rawEventTypes.push(event.type);
					const { lines, idle, errored } = translator.handle(event);
					for (const line of lines) {
						const parsed = parser.parseJsonLine(line);
						if (parsed) parsedEvents.push(parsed);
					}
					if (idle || errored) break;
				}
			})();

			await client.session.promptAsync({
				path: { id: sessionId as string },
				query: { directory: process.cwd() },
				body: { parts: [{ type: 'text', text: 'Reply with exactly one word: PONG' }] },
			});

			await Promise.race([
				pump,
				new Promise((_, reject) =>
					setTimeout(() => reject(new Error('timed out waiting for session.idle')), 120000)
				),
			]);

			// The translator must have emitted a step_start (-> init) at minimum.
			expect(parsedEvents.some((e) => e.type === 'init')).toBe(true);

			// A real result must round-trip out with the model's text.
			const result = parsedEvents.find((e) => e.type === 'result');
			expect(result, 'expected a result event from the text part').toBeDefined();
			expect(result?.text).toBeTruthy();
			expect(result?.text?.toUpperCase()).toContain('PONG');

			// And the step-finish must round-trip into usage stats.
			const withUsage = parsedEvents.find((e) => e.type === 'system' && e.usage);
			expect(withUsage, 'expected a system event carrying usage').toBeDefined();
			expect(withUsage?.usage?.inputTokens).toBeGreaterThanOrEqual(0);
			expect(withUsage?.usage?.outputTokens).toBeGreaterThan(0);

			// Every parsed event must carry our session id (proves stream filtering).
			for (const e of parsedEvents) {
				if (e.sessionId) expect(e.sessionId).toBe(sessionId);
			}
		} finally {
			server.close();
		}
	});
});
