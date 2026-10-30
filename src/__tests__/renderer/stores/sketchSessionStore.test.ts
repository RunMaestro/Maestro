import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	SKETCH_CHAT_HISTORY_LIMIT,
	isRoomScreeningConfirmed,
	openReadySketchSession,
	pickPersistedAppState,
	useSketchSessionStore,
	type SketchRoomState,
} from '../../../renderer/stores/sketchSessionStore';
import { localConductorActor, sketchTextHash } from '../../../shared/sketch/attribution';
import type { SketchWireElement } from '../../../shared/sketch/payloads';
import type { SketchActor, SketchScene } from '../../../shared/sketch/types';

const SKETCH_ID = 'sketch-1';

const guest: SketchActor = { id: 'g1', kind: 'guest', name: 'Sam', role: 'rw' };
const bot: SketchActor = { id: 'agent:a1', kind: 'bot', name: 'Claude', role: 'conductor' };

function scene(elements: SketchWireElement[] = []): SketchScene {
	return {
		type: 'excalidraw',
		version: 2,
		source: 'maestro',
		elements,
		appState: { viewBackgroundColor: '#ffffff', gridSize: null },
		files: {},
	};
}

function el(id: string, version: number, extra: Record<string, unknown> = {}): SketchWireElement {
	return { id, version, type: 'rectangle', ...extra };
}

const sketchApi = {
	readScene: vi.fn<(id: string) => Promise<SketchScene>>(),
	writeScene: vi.fn<(id: string, scene: SketchScene) => Promise<void>>(),
};

function session() {
	return useSketchSessionStore.getState().sessions[SKETCH_ID];
}

async function openWith(initial: SketchScene) {
	sketchApi.readScene.mockResolvedValueOnce(initial);
	await useSketchSessionStore.getState().openSketchSession(SKETCH_ID);
}

beforeEach(() => {
	useSketchSessionStore.setState({ sessions: {}, agentActivity: {} });
	sketchApi.readScene.mockReset();
	sketchApi.writeScene.mockReset().mockResolvedValue(undefined);
	(window.maestro as unknown as { sketch: typeof sketchApi }).sketch = sketchApi;
	// The text hash is WebCrypto sha256; jsdom does not always expose `subtle`.
	if (!globalThis.crypto?.subtle) vi.stubGlobal('crypto', webcrypto);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('openSketchSession', () => {
	it('reads the scene once and keeps the session ready', async () => {
		await openWith(scene([el('a', 1)]));
		await useSketchSessionStore.getState().openSketchSession(SKETCH_ID);
		expect(sketchApi.readScene).toHaveBeenCalledTimes(1);
		expect(session().status).toBe('ready');
		expect(session().scene?.elements).toEqual([el('a', 1)]);
		expect(session().dirty).toBe(false);
	});

	it('lets a second open await the read already in flight', async () => {
		let finishRead!: (value: SketchScene) => void;
		sketchApi.readScene.mockReturnValueOnce(
			new Promise<SketchScene>((resolve) => {
				finishRead = resolve;
			})
		);
		const first = useSketchSessionStore.getState().openSketchSession(SKETCH_ID);
		const second = useSketchSessionStore.getState().openSketchSession(SKETCH_ID);
		await Promise.resolve();
		expect(session().status).toBe('loading');

		finishRead(scene([el('a', 1)]));
		await second;
		expect(session().status).toBe('ready');
		await first;
		expect(sketchApi.readScene).toHaveBeenCalledTimes(1);
	});

	it('starts with an empty author map: a scene from disk has unknown authors', async () => {
		await openWith(scene([el('a', 1, { text: 'hello' })]));
		expect(session().authors).toEqual({});
	});

	it('records a read failure and reads again on the next open', async () => {
		sketchApi.readScene.mockRejectedValueOnce(new Error('scene-unreadable'));
		await useSketchSessionStore.getState().openSketchSession(SKETCH_ID);
		expect(session().status).toBe('error');
		expect(session().loadError).toContain('scene-unreadable');

		await openWith(scene());
		expect(session().status).toBe('ready');
		expect(session().loadError).toBeNull();
	});
});

describe('applyLocalChange', () => {
	it('stamps a new element and marks the session dirty without bumping its version', async () => {
		await openWith(scene());
		const result = useSketchSessionStore.getState().applyLocalChange(SKETCH_ID, {
			elements: [el('a', 3)],
			appState: { viewBackgroundColor: '#ffffff', gridSize: null },
			files: {},
		});
		expect(result.changed).toBe(true);
		expect(result.stamped).toHaveLength(1);
		const stamped = session().scene!.elements[0];
		expect(stamped.version).toBe(3);
		expect(stamped.customData).toMatchObject({
			createdBy: { kind: 'conductor' },
			lastEditedBy: { kind: 'conductor' },
		});
		expect(session().dirty).toBe(true);
		expect(session().revision).toBe(1);
	});

	it('ignores a change that keeps every version, the persisted appState and the files', async () => {
		await openWith(scene([el('a', 1)]));
		const result = useSketchSessionStore.getState().applyLocalChange(SKETCH_ID, {
			elements: [el('a', 1)],
			appState: {
				viewBackgroundColor: '#ffffff',
				gridSize: null,
				scrollX: 400,
				selectedElementIds: { a: true },
			},
			files: {},
		});
		expect(result).toEqual({ changed: false, stamped: [] });
		expect(session().dirty).toBe(false);
	});

	it('keeps a background color change without stamping any element', async () => {
		await openWith(scene([el('a', 1)]));
		const result = useSketchSessionStore.getState().applyLocalChange(SKETCH_ID, {
			elements: [el('a', 1)],
			appState: { viewBackgroundColor: '#000000', gridSize: null },
			files: {},
		});
		expect(result).toEqual({ changed: true, stamped: [] });
		expect(session().scene?.appState.viewBackgroundColor).toBe('#000000');
		expect(session().dirty).toBe(true);
	});

	it('records the local conductor in the author map with the text hash', async () => {
		await openWith(scene());
		useSketchSessionStore.getState().applyLocalChange(SKETCH_ID, {
			elements: [el('t', 2, { type: 'text', text: 'hi', originalText: 'hi' })],
			appState: {},
			files: {},
		});
		const expectedHash = await sketchTextHash(el('t', 2, { text: 'hi', originalText: 'hi' }));
		await vi.waitFor(() => expect(session().authors.t).toBeDefined());
		expect(session().authors.t).toEqual({
			version: 2,
			actor: localConductorActor(),
			textHash: expectedHash,
			guestTouched: false,
		});
	});

	it('does nothing before the scene is loaded', () => {
		const result = useSketchSessionStore.getState().applyLocalChange(SKETCH_ID, {
			elements: [el('a', 1)],
			appState: {},
			files: {},
		});
		expect(result).toEqual({ changed: false, stamped: [] });
	});
});

describe('recordAuthorship', () => {
	it('keeps guestTouched when the conductor or the bot later moves a guest element', async () => {
		await openWith(scene());
		const store = useSketchSessionStore.getState();
		store.recordAuthorship(SKETCH_ID, 'x', {
			version: 2,
			actor: guest,
			textHash: 'h1',
			opSeq: 10,
			ts: 1000,
		});
		store.recordAuthorship(SKETCH_ID, 'x', {
			version: 3,
			actor: localConductorActor(),
			textHash: 'h1',
		});
		store.recordAuthorship(SKETCH_ID, 'x', {
			version: 4,
			actor: bot,
			textHash: 'h1',
			opSeq: 12,
			ts: 3000,
		});
		expect(session().authors.x).toEqual({
			version: 4,
			actor: bot,
			opSeq: 12,
			textHash: 'h1',
			guestTextAt: 1000,
			guestTouched: true,
		});
	});

	it('moves guestTextAt to the server ts of the latest guest text change', async () => {
		await openWith(scene());
		const store = useSketchSessionStore.getState();
		store.recordAuthorship(SKETCH_ID, 'x', { version: 2, actor: guest, textHash: 'h1', ts: 1000 });
		store.recordAuthorship(SKETCH_ID, 'x', { version: 3, actor: guest, textHash: 'h1', ts: 2000 });
		expect(session().authors.x.guestTextAt).toBe(1000);
		store.recordAuthorship(SKETCH_ID, 'x', { version: 4, actor: guest, textHash: 'h2', ts: 4000 });
		expect(session().authors.x.guestTextAt).toBe(4000);
	});

	it('ignores a version older than the one already recorded', async () => {
		await openWith(scene());
		const store = useSketchSessionStore.getState();
		store.recordAuthorship(SKETCH_ID, 'x', { version: 5, actor: guest, textHash: 'h5', ts: 5 });
		store.recordAuthorship(SKETCH_ID, 'x', {
			version: 4,
			actor: localConductorActor(),
			textHash: 'h4',
		});
		expect(session().authors.x.version).toBe(5);
		expect(session().authors.x.textHash).toBe('h5');
	});
});

describe('saveSketchSession', () => {
	it('writes the stamped scene and clears dirty', async () => {
		await openWith(scene());
		useSketchSessionStore
			.getState()
			.applyLocalChange(SKETCH_ID, { elements: [el('a', 1)], appState: {}, files: {} });
		await useSketchSessionStore.getState().saveSketchSession(SKETCH_ID);
		expect(sketchApi.writeScene).toHaveBeenCalledTimes(1);
		const [id, written] = sketchApi.writeScene.mock.calls[0];
		expect(id).toBe(SKETCH_ID);
		expect(written.elements[0].customData).toBeDefined();
		expect(session().dirty).toBe(false);
	});

	it('skips the write when nothing changed', async () => {
		await openWith(scene());
		await useSketchSessionStore.getState().saveSketchSession(SKETCH_ID);
		expect(sketchApi.writeScene).not.toHaveBeenCalled();
	});

	it('stays dirty when a change lands while the write is in flight', async () => {
		await openWith(scene());
		const store = useSketchSessionStore.getState();
		store.applyLocalChange(SKETCH_ID, { elements: [el('a', 1)], appState: {}, files: {} });
		let release!: () => void;
		sketchApi.writeScene.mockImplementationOnce(
			() => new Promise<void>((resolve) => (release = resolve))
		);
		const saving = store.saveSketchSession(SKETCH_ID);
		await vi.waitFor(() => expect(sketchApi.writeScene).toHaveBeenCalledTimes(1));
		store.applyLocalChange(SKETCH_ID, { elements: [el('a', 2)], appState: {}, files: {} });
		release();
		await saving;
		expect(session().dirty).toBe(true);

		await store.saveSketchSession(SKETCH_ID);
		expect(sketchApi.writeScene).toHaveBeenCalledTimes(2);
		expect(sketchApi.writeScene.mock.calls[1][1].elements[0].version).toBe(2);
		expect(session().dirty).toBe(false);
	});

	it('never runs two writes of one sketch at once', async () => {
		await openWith(scene());
		const store = useSketchSessionStore.getState();
		let inFlight = 0;
		let maxInFlight = 0;
		sketchApi.writeScene.mockImplementation(async () => {
			inFlight += 1;
			maxInFlight = Math.max(maxInFlight, inFlight);
			await new Promise((resolve) => setTimeout(resolve, 5));
			inFlight -= 1;
		});
		const saves: Promise<void>[] = [];
		for (let version = 1; version <= 4; version += 1) {
			store.applyLocalChange(SKETCH_ID, { elements: [el('a', version)], appState: {}, files: {} });
			saves.push(store.saveSketchSession(SKETCH_ID));
		}
		await Promise.all(saves);
		expect(maxInFlight).toBe(1);
		expect(session().dirty).toBe(false);
	});

	it('keeps the change and reports why when the write fails', async () => {
		await openWith(scene());
		const store = useSketchSessionStore.getState();
		store.applyLocalChange(SKETCH_ID, { elements: [el('a', 1)], appState: {}, files: {} });
		sketchApi.writeScene.mockRejectedValueOnce(new Error('disk full'));
		await store.saveSketchSession(SKETCH_ID);
		expect(session().dirty).toBe(true);
		expect(session().saveError).toContain('disk full');

		await store.saveSketchSession(SKETCH_ID);
		expect(session().dirty).toBe(false);
		expect(session().saveError).toBeNull();
	});
});

describe('applyAgentChange', () => {
	const agent = { id: 'a1', name: 'Claude' };

	it('stamps the change as the agent, records it in the author map, saves, and tells the views', async () => {
		await openWith(scene([el('a', 1)]));
		const stamped = useSketchSessionStore
			.getState()
			.applyAgentChange(SKETCH_ID, [el('a', 1), el('b', 1)], agent);

		expect(stamped.map((element) => element.id)).toEqual(['b']);
		expect(stamped[0].customData).toMatchObject({
			createdBy: { id: 'agent:a1', name: 'Claude', kind: 'bot' },
			lastEditedBy: { id: 'agent:a1', name: 'Claude', kind: 'bot' },
		});
		expect(session().externalRevision).toBe(1);
		await vi.waitFor(() => expect(session().authors.b?.actor).toEqual(bot));
		await vi.waitFor(() => expect(sketchApi.writeScene).toHaveBeenCalledTimes(1));
		expect(sketchApi.writeScene.mock.calls[0][1].elements.map((e) => e.id)).toEqual(['a', 'b']);
	});

	it('makes nothing of a change that changes nothing', async () => {
		await openWith(scene([el('a', 1)]));
		expect(
			useSketchSessionStore.getState().applyAgentChange(SKETCH_ID, [el('a', 1)], agent)
		).toEqual([]);
		expect(session().externalRevision).toBe(0);
		expect(sketchApi.writeScene).not.toHaveBeenCalled();
	});
});

describe('focus requests and chat', () => {
	it('keeps the newest focus request until a view clears that one', async () => {
		await openWith(scene([el('a', 1)]));
		const store = useSketchSessionStore.getState();
		const first = store.requestSketchFocus(SKETCH_ID, ['a']);
		const second = store.requestSketchFocus(SKETCH_ID, ['a', 'b']);
		expect(session().focusRequest).toEqual(second);

		store.clearSketchFocus(SKETCH_ID, first!.nonce);
		expect(session().focusRequest).toEqual(second);
		store.clearSketchFocus(SKETCH_ID, second!.nonce);
		expect(session().focusRequest).toBeNull();
	});

	it('appends chat posts and keeps only the newest ones', async () => {
		await openWith(scene());
		const store = useSketchSessionStore.getState();
		for (let index = 0; index < SKETCH_CHAT_HISTORY_LIMIT + 2; index += 1) {
			store.postSketchChat(SKETCH_ID, { actor: bot, text: `m${index}` });
		}
		const chat = session().chat;
		expect(chat).toHaveLength(SKETCH_CHAT_HISTORY_LIMIT);
		expect(chat[0].text).toBe('m2');
		expect(chat[chat.length - 1]).toMatchObject({
			actor: bot,
			text: `m${SKETCH_CHAT_HISTORY_LIMIT + 1}`,
		});
	});

	it("keeps a room message's server ts", async () => {
		await openWith(scene());
		const message = useSketchSessionStore
			.getState()
			.postSketchChat(SKETCH_ID, { actor: guest, text: 'hello', ts: 1_234 });
		expect(message).toMatchObject({ ts: 1_234 });
		expect(session().chat[0].ts).toBe(1_234);
	});

	it('does nothing for a sketch with no session', () => {
		const store = useSketchSessionStore.getState();
		expect(store.requestSketchFocus('missing', ['a'])).toBeNull();
		expect(store.postSketchChat('missing', { actor: bot, text: 'hi' })).toBeNull();
	});
});

describe('bot requests', () => {
	const request = {
		replyTo: 'msg-1',
		actor: guest,
		text: 'add a box',
		ts: 1_000,
		status: 'awaiting_approval' as const,
		verdict: {
			status: 'clean' as const,
			score: 0.04,
			sourceLabel: 'Prompt Guard 2 22M',
			locality: 'local' as const,
		},
		posture: 'restricted' as const,
	};

	it('starts empty, adds, replaces by replyTo, updates in place and removes', async () => {
		await openWith(scene());
		const store = useSketchSessionStore.getState();
		expect(session().botRequests).toEqual([]);

		store.putSketchBotRequest(SKETCH_ID, request);
		store.putSketchBotRequest(SKETCH_ID, { ...request, replyTo: 'msg-2' });
		store.putSketchBotRequest(SKETCH_ID, { ...request, text: 'add a circle' });
		expect(session().botRequests.map((entry) => [entry.replyTo, entry.text])).toEqual([
			['msg-2', 'add a box'],
			['msg-1', 'add a circle'],
		]);

		store.updateSketchBotRequest(SKETCH_ID, 'msg-1', (entry) => ({ ...entry, status: 'running' }));
		expect(session().botRequests[1].status).toBe('running');

		store.removeSketchBotRequest(SKETCH_ID, 'msg-2');
		expect(session().botRequests.map((entry) => entry.replyTo)).toEqual(['msg-1']);
	});

	it('leaves the session alone for an unknown request', async () => {
		await openWith(scene());
		const store = useSketchSessionStore.getState();
		const before = session();
		store.updateSketchBotRequest(SKETCH_ID, 'nope', (entry) => ({ ...entry, status: 'running' }));
		store.removeSketchBotRequest(SKETCH_ID, 'nope');
		expect(session()).toBe(before);
	});
});

describe('agent activity', () => {
	it('keeps the latest call per sketch, before any session opens, stamped on arrival', () => {
		const store = useSketchSessionStore.getState();
		store.noteSketchAgentActivity({ agentId: 'a1', sketchId: SKETCH_ID, writes: false }, 10);
		store.noteSketchAgentActivity({ agentId: 'a1', sketchId: SKETCH_ID, writes: true }, 20);
		store.noteSketchAgentActivity({ agentId: 'a1', sketchId: 'sketch-2', writes: false }, 30);

		expect(useSketchSessionStore.getState().agentActivity).toEqual({
			[SKETCH_ID]: { agentId: 'a1', writes: true, at: 20 },
			'sketch-2': { agentId: 'a1', writes: false, at: 30 },
		});
		expect(session()).toBeUndefined();
	});

	it('forgets a deleted sketch with its session', async () => {
		await openWith(scene());
		const store = useSketchSessionStore.getState();
		store.noteSketchAgentActivity({ agentId: 'a1', sketchId: SKETCH_ID, writes: true }, 5);
		store.dropSketchSession(SKETCH_ID);

		expect(session()).toBeUndefined();
		expect(useSketchSessionStore.getState().agentActivity[SKETCH_ID]).toBeUndefined();
	});
});

describe('guest image approvals', () => {
	it('binds an approval to the image file and keeps it out of the saved scene', async () => {
		await openWith(scene([el('img', 1, { type: 'image', fileId: 'file-a' }), el('box', 1)]));
		const store = useSketchSessionStore.getState();
		expect(session().approvedImages).toEqual({});
		expect(store.approveSketchImage(SKETCH_ID, 'img')).toBe(true);
		expect(session().approvedImages).toEqual({ img: 'file-a' });
		expect(session().dirty).toBe(false);

		store.revokeSketchImageApproval(SKETCH_ID, 'img');
		expect(session().approvedImages).toEqual({});
	});

	it('approves only a live image with a file', async () => {
		await openWith(
			scene([
				el('box', 1),
				el('gone', 1, { type: 'image', fileId: 'file-a', isDeleted: true }),
				el('pending', 1, { type: 'image' }),
			])
		);
		const store = useSketchSessionStore.getState();
		for (const id of ['box', 'gone', 'pending', 'missing']) {
			expect(store.approveSketchImage(SKETCH_ID, id)).toBe(false);
		}
		expect(store.approveSketchImage('no-session', 'box')).toBe(false);
		expect(session().approvedImages).toEqual({});
	});
});

describe('openReadySketchSession', () => {
	it('reads the scene the first time and reuses the session after', async () => {
		sketchApi.readScene.mockResolvedValueOnce(scene([el('a', 1)]));
		const first = await openReadySketchSession(SKETCH_ID);
		const second = await openReadySketchSession(SKETCH_ID);
		expect(first.scene.elements).toEqual([el('a', 1)]);
		expect(second).toBe(first);
		expect(sketchApi.readScene).toHaveBeenCalledTimes(1);
	});

	it('throws the load error', async () => {
		sketchApi.readScene.mockRejectedValueOnce(new Error('unreadable'));
		await expect(openReadySketchSession(SKETCH_ID)).rejects.toThrow('unreadable');
	});
});

describe('applyRemoteElements', () => {
	it('takes the merged elements unstamped, saves, and pushes them to views', async () => {
		await openWith(scene([el('a', 1)]));
		const remote = el('b', 3, {
			customData: { lastEditedBy: { id: 'x', name: 'X', kind: 'bot' } },
		});
		expect(
			useSketchSessionStore.getState().applyRemoteElements(SKETCH_ID, [el('a', 1), remote])
		).toBe(true);
		expect(session().scene?.elements).toEqual([el('a', 1), remote]);
		expect(session().externalRevision).toBe(1);
		expect(session().authors).toEqual({});
		await vi.waitFor(() => expect(sketchApi.writeScene).toHaveBeenCalledTimes(1));
	});

	it('does nothing for a sketch with no scene', () => {
		expect(useSketchSessionStore.getState().applyRemoteElements('missing', [el('a', 1)])).toBe(
			false
		);
	});
});

describe('room state', () => {
	function room(
		reported: 'local' | 'cloud' | null,
		server: 'local' | 'cloud' | null
	): SketchRoomState {
		return {
			roomId: 'r1',
			connection: 'live',
			notice: null,
			actor: null,
			role: 'conductor',
			botPolicy: 'conductor',
			botOnline: false,
			guestEdited: false,
			headSeq: 0,
			keyEpoch: 1,
			syncedSeq: 0,
			screening: { reported, server, since: server ? 100 : null },
			botPolicyNotice: null,
			stats: null,
		};
	}

	it('starts empty and follows updateSketchRoom', async () => {
		await openWith(scene());
		expect(session().room).toBeNull();
		useSketchSessionStore.getState().updateSketchRoom(SKETCH_ID, () => room('local', null));
		expect(session().room?.roomId).toBe('r1');
		useSketchSessionStore.getState().updateSketchRoom(SKETCH_ID, () => null);
		expect(session().room).toBeNull();
	});

	it('confirms a screening value only when sent and echoed alike', () => {
		expect(isRoomScreeningConfirmed(room('cloud', 'cloud'), 'cloud')).toBe(true);
		expect(isRoomScreeningConfirmed(room('cloud', 'local'), 'cloud')).toBe(false);
		expect(isRoomScreeningConfirmed(room('local', 'cloud'), 'cloud')).toBe(false);
		expect(isRoomScreeningConfirmed(room(null, 'cloud'), 'cloud')).toBe(false);
		expect(isRoomScreeningConfirmed(null, 'local')).toBe(false);
	});
});

describe('session lifetime', () => {
	it('outlives any view and is dropped only on request', async () => {
		await openWith(scene([el('a', 1)]));
		expect(session()).toBeDefined();
		useSketchSessionStore.getState().dropSketchSession(SKETCH_ID);
		expect(session()).toBeUndefined();
	});
});

describe('pickPersistedAppState', () => {
	it('keeps the canvas settings and drops the per-user view', () => {
		expect(
			pickPersistedAppState({
				viewBackgroundColor: '#fff',
				gridSize: 20,
				gridStep: 5,
				gridModeEnabled: true,
				scrollX: 10,
				zoom: { value: 2 },
				selectedElementIds: {},
				theme: 'dark',
			})
		).toEqual({ viewBackgroundColor: '#fff', gridSize: 20, gridStep: 5, gridModeEnabled: true });
	});
});
