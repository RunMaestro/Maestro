/**
 * Regression guard: chat screens must route to a real Maestro agent.
 *
 * The bug: the home screen (`/`, index.tsx) shipped its own `useMockChat` path
 * gated behind `EXPO_PUBLIC_USE_MAESTRO`. That env var is never set, so the
 * screen always streamed hardcoded `MOCK_RESPONSES` placeholder text instead of
 * talking to Maestro - the user saw a "strange answer" from the initial chat
 * while the drawer's session screens worked. The fix routes the home screen
 * through the shared `useSessionChat` hook (the same one `/session/[sessionId]`
 * uses), targeting the active session.
 *
 * There is no screen-render harness in this project (tests are deliberately
 * logic-only: pure reducers + dispatch mirrors), so we guard the bug class at
 * the source level: a chat screen must use the shared hook and must NOT define
 * its own mock/placeholder response path. Mirrors the "kept in sync
 * intentionally" guard style used by messageRouting.test.ts.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const APP_DIR = join(__dirname, '..');

function read(relPath: string): string {
	return readFileSync(join(APP_DIR, relPath), 'utf8');
}

describe('chat screens route to a real agent (no mock/placeholder path)', () => {
	const screens: Array<{ label: string; file: string }> = [
		{ label: 'home screen', file: 'index.tsx' },
		{ label: 'session screen', file: 'session/[sessionId].tsx' },
	];

	for (const { label, file } of screens) {
		describe(label, () => {
			const source = read(file);

			it('uses the shared useSessionChat hook', () => {
				expect(source).toContain("from '@/hooks/useSessionChat'");
				expect(source).toMatch(/useSessionChat\(/);
			});

			it('does not define a hardcoded mock-response path', () => {
				// These are the exact symptoms of the original bug. Reintroducing any
				// of them means a screen is faking replies instead of routing to
				// Maestro.
				expect(source).not.toContain('MOCK_RESPONSES');
				expect(source).not.toContain('useMockChat');
				expect(source).not.toContain('mockStreamResponse');
				expect(source).not.toContain('EXPO_PUBLIC_USE_MAESTRO');
			});
		});
	}
});
