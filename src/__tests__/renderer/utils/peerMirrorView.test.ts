/**
 * Tests for peerMirrorView: the one adapter from a Federation peer's library records to the view
 * types the tab strip and transcript render. It must build view objects only, and must not carry
 * fields that would point a local action at the host's data.
 */

import { describe, expect, it } from 'vitest';
import {
	createMirroredPeer,
	replacePeerAgents,
	type MirroredPeer,
} from '../../../shared/maestro-lib/client/peer-mirror';
import type { QueuedTurn } from '../../../shared/maestro-lib/client/types';
import type { LogEntryRecord } from '../../../shared/maestro-lib/store/transcript';
import {
	agentFederationStatus,
	canMoveToHost,
	isPeerFederated,
	mirrorLogEntry,
	mirrorQueuedItem,
	mirrorTab,
} from '../../../renderer/utils/peerMirrorView';

const entry = (id: string, text: string, extra: Partial<LogEntryRecord> = {}): LogEntryRecord => ({
	id,
	timestamp: 1,
	source: 'stdout',
	text,
	...extra,
});

describe('mirrorLogEntry', () => {
	it('copies the drawn fields and maps an unknown kind to a system line', () => {
		expect(mirrorLogEntry(entry('e1', 'hi', { source: 'future-kind' })).source).toBe('system');
		const mapped = mirrorLogEntry(
			entry('e2', 'done', {
				source: 'tool',
				turnModel: 'gpt-5',
				metadata: { toolState: { status: 'completed', input: { a: 1 } }, parentToolUseId: 'p1' },
			})
		);
		expect(mapped.metadata?.toolState?.status).toBe('completed');
		expect(mapped.metadata?.parentToolUseId).toBe('p1');
		expect(mapped.turnModel).toBe('gpt-5');
	});

	it("carries the host's session recovery card, so the tab draws the same one", () => {
		const recoveryAction = { lastUserPrompt: 'retry this', tabId: 't1' };
		expect(
			mirrorLogEntry(entry('e4', 'Session not found', { recoveryAction })).recoveryAction
		).toEqual(recoveryAction);
	});

	it("carries the host's error, so the error card draws the same details", () => {
		const agentError = {
			type: 'auth_expired',
			message: 'Login expired',
			recoverable: true,
			agentId: 'claude-code',
			timestamp: 7,
			parsedJson: { error: 'expired' },
		};
		expect(
			mirrorLogEntry(entry('e5', 'Login expired', { source: 'error', agentError } as never))
				.agentError
		).toEqual(agentError);
	});

	it('does not carry cross-agent jumps, malformed recovery actions, or malformed agent errors', () => {
		const mapped = mirrorLogEntry(
			entry('e3', 'x', {
				metadata: { crossAgent: { requestId: 'r', fromSessionId: 'host-agent' } },
				recoveryAction: { kind: 'resume' },
				agentError: { type: 'unknown', message: 'boom' },
			} as unknown as Partial<LogEntryRecord>)
		) as unknown as Record<string, unknown>;
		expect(mapped.recoveryAction).toBeUndefined();
		expect(mapped.agentError).toBeUndefined();
		expect((mapped.metadata as Record<string, unknown> | undefined)?.crossAgent).toBeUndefined();
	});
});

describe('tabs', () => {
	it('carries the host turn start only on a busy tab', () => {
		expect(mirrorTab({ id: 't1', state: 'busy', thinkingStartTime: 42 }).thinkingStartTime).toBe(
			42
		);
		expect(
			mirrorTab({ id: 't1', state: 'idle', thinkingStartTime: 42 }).thinkingStartTime
		).toBeUndefined();
		expect(mirrorTab({ id: 't1', thinkingStartTime: 42 }).thinkingStartTime).toBeUndefined();
	});
});

const queued = (itemId: string, extra: Partial<QueuedTurn> = {}): QueuedTurn => ({
	itemId,
	tabId: 't1',
	queuedAt: 100,
	kind: 'message',
	text: `text ${itemId}`,
	paused: false,
	...extra,
});

describe('mirrorQueuedItem', () => {
	it('maps a waiting host message onto a queued card item', () => {
		expect(mirrorQueuedItem(queued('q1'))).toEqual({
			id: 'q1',
			timestamp: 100,
			tabId: 't1',
			type: 'message',
			text: 'text q1',
		});
	});

	it('marks a held host command paused and draws it as the command card a local one is', () => {
		expect(
			mirrorQueuedItem(queued('q2', { kind: 'command', text: ' /x  y z ', paused: true }))
		).toEqual({
			id: 'q2',
			timestamp: 100,
			tabId: 't1',
			type: 'command',
			command: '/x',
			commandArgs: 'y z',
			paused: true,
		});
		expect(mirrorQueuedItem(queued('q3', { kind: 'command', text: '/clear' }))).toMatchObject({
			command: '/clear',
			commandArgs: '',
		});
	});

	it('carries the images the host queued it with, so the card draws its thumbnails', () => {
		const images = ['data:image/png;base64,AAAA', 'data:image/jpeg;base64,BBBB'];
		expect(mirrorQueuedItem(queued('q5', { images })).images).toEqual(images);
		expect(mirrorQueuedItem(queued('q6', { images: [] }))).not.toHaveProperty('images');
		expect(mirrorQueuedItem(queued('q7'))).not.toHaveProperty('images');
	});

	it('carries the model and effort the host will run it with', () => {
		expect(
			mirrorQueuedItem(queued('q4', { turnSettings: { model: 'm', effort: 'high' } })).turnSettings
		).toEqual({ model: 'm', effort: 'high' });
		expect(mirrorQueuedItem(queued('q5'))).not.toHaveProperty('turnSettings');
	});
});

describe('Federation status of a local agent', () => {
	const peer = (connection: MirroredPeer['connection'], synced = false): MirroredPeer => {
		const base = createMirroredPeer({ peerId: 'build', remoteId: 'r1', name: 'build' });
		const withAgents = synced ? replacePeerAgents(base, [], [], 1).peer : base;
		return { ...withAgents, connection };
	};
	const ssh = { sessionSshRemoteConfig: { enabled: true, remoteId: 'r1' } };

	it('shows a peer in the Left Bar only once it has a host', () => {
		expect(isPeerFederated(peer('connected'))).toBe(true);
		expect(isPeerFederated(peer('reconnecting'))).toBe(true);
		// Probed, no host: a plain SSH remote.
		expect(isPeerFederated(peer('connecting'))).toBe(false);
		expect(isPeerFederated(peer('not-installed'))).toBe(false);
		expect(isPeerFederated(peer('host-down'))).toBe(false);
		// Seen once, now away: shown dimmed.
		expect(isPeerFederated(peer('host-down', true))).toBe(true);
		expect(isPeerFederated(peer('lost', true))).toBe(true);
	});

	it('tells a local agent, an SSH agent, and one that moved apart', () => {
		expect(agentFederationStatus({}, [peer('connected')])).toEqual({ kind: 'local' });
		expect(
			agentFederationStatus({ sessionSshRemoteConfig: { enabled: false, remoteId: 'r1' } }, [
				peer('connected'),
			])
		).toEqual({ kind: 'local' });
		expect(
			agentFederationStatus({ liftedTo: { peer: 'build', agentId: 'a1', at: 1 } }, [])
		).toEqual({ kind: 'moved', peerId: 'build', agentId: 'a1' });
		// A hosted agent carries its peer, so the badge can show the host's connection.
		expect(
			agentFederationStatus({ liftedTo: { peer: 'build', agentId: 'a1', at: 1 } }, [
				peer('lost', true),
			])
		).toMatchObject({ kind: 'moved', peerId: 'build', peer: { connection: 'lost' } });
		expect(agentFederationStatus(ssh, [peer('connected')])).toMatchObject({
			kind: 'ssh',
			remoteId: 'r1',
			hostReady: true,
		});
	});

	it('offers Move to Host for an SSH agent whose remote takes part, with or without a host', () => {
		// No host yet: the same action sets one up first.
		expect(canMoveToHost(agentFederationStatus(ssh, [peer('not-installed')]))).toBe(true);
		expect(canMoveToHost(agentFederationStatus(ssh, [peer('host-down')]))).toBe(true);
		expect(canMoveToHost(agentFederationStatus(ssh, [peer('connected')]))).toBe(true);
		// The remote opted out (no mirror entry): it stays an SSH agent.
		expect(canMoveToHost(agentFederationStatus(ssh, []))).toBe(false);
		expect(canMoveToHost({ kind: 'local' })).toBe(false);
		expect(canMoveToHost({ kind: 'moved', peerId: 'build', agentId: 'a1' })).toBe(false);
	});
});
