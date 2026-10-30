/**
 * Tests for the Sketch Book preload API (`window.maestro.sketch`): one
 * `sketch:*` channel per method, with optional arguments sent as `{}` so the
 * main process always receives an object.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockInvoke = vi.fn();
const mockOn = vi.fn();
const mockRemoveListener = vi.fn();
const mockSend = vi.fn();

vi.mock('electron', () => ({
	ipcRenderer: {
		invoke: (...args: unknown[]) => mockInvoke(...args),
		on: (...args: unknown[]) => mockOn(...args),
		removeListener: (...args: unknown[]) => mockRemoveListener(...args),
		send: (...args: unknown[]) => mockSend(...args),
	},
}));

import { createSketchApi } from '../../../main/preload/sketch';

const SKETCH_ID = '11111111-2222-4333-8444-555555555555';
const scene = {
	type: 'excalidraw' as const,
	version: 2,
	elements: [],
	appState: {},
	files: {},
};

describe('Sketch Book Preload API', () => {
	let api: ReturnType<typeof createSketchApi>;

	beforeEach(() => {
		vi.clearAllMocks();
		api = createSketchApi();
	});

	it('creates a sketch with one request object', async () => {
		await api.create({ ownerAgentId: 'agent-1', name: 'Board' });
		expect(mockInvoke).toHaveBeenCalledWith('sketch:create', {
			ownerAgentId: 'agent-1',
			name: 'Board',
		});
	});

	it('lists every sketch or one owner', async () => {
		await api.list();
		expect(mockInvoke).toHaveBeenCalledWith('sketch:list', {});
		await api.list({ ownerAgentId: 'agent-1' });
		expect(mockInvoke).toHaveBeenLastCalledWith('sketch:list', { ownerAgentId: 'agent-1' });
	});

	it('reads, writes, renames and deletes by sketch id', async () => {
		await api.get(SKETCH_ID);
		expect(mockInvoke).toHaveBeenLastCalledWith('sketch:get', SKETCH_ID);
		await api.readScene(SKETCH_ID);
		expect(mockInvoke).toHaveBeenLastCalledWith('sketch:readScene', SKETCH_ID);
		await api.writeScene(SKETCH_ID, scene);
		expect(mockInvoke).toHaveBeenLastCalledWith('sketch:writeScene', SKETCH_ID, scene);
		await api.rename(SKETCH_ID, 'Renamed');
		expect(mockInvoke).toHaveBeenLastCalledWith('sketch:rename', SKETCH_ID, 'Renamed');
		await api.delete(SKETCH_ID);
		expect(mockInvoke).toHaveBeenLastCalledWith('sketch:delete', SKETCH_ID);
		await api.open(SKETCH_ID);
		expect(mockInvoke).toHaveBeenLastCalledWith('sketch:open', SKETCH_ID);
	});

	it('saves to a project with or without options', async () => {
		mockInvoke.mockResolvedValue('/project/Board.excalidraw');
		await expect(api.saveToProject(SKETCH_ID, '/project')).resolves.toBe(
			'/project/Board.excalidraw'
		);
		expect(mockInvoke).toHaveBeenLastCalledWith('sketch:saveToProject', SKETCH_ID, '/project', {});
		await api.saveToProject(SKETCH_ID, '/project', {
			fileName: 'plan.excalidraw',
			overwrite: true,
		});
		expect(mockInvoke).toHaveBeenLastCalledWith('sketch:saveToProject', SKETCH_ID, '/project', {
			fileName: 'plan.excalidraw',
			overwrite: true,
		});
	});

	it('reaches the sharing and owner channels, optional arguments as {}', async () => {
		await api.ownerStatus();
		expect(mockInvoke).toHaveBeenLastCalledWith('sketch:ownerStatus');
		await api.registerOwner('a@example.com');
		expect(mockInvoke).toHaveBeenLastCalledWith('sketch:registerOwner', 'a@example.com');
		await api.waitForOwner();
		expect(mockInvoke).toHaveBeenLastCalledWith('sketch:waitForOwner', {});
		await api.signOutOwner();
		expect(mockInvoke).toHaveBeenLastCalledWith('sketch:signOutOwner');
		await api.share(SKETCH_ID);
		expect(mockInvoke).toHaveBeenLastCalledWith('sketch:share', SKETCH_ID, {});
		await api.share(SKETCH_ID, { role: 'ro', expiresInDays: 3 });
		expect(mockInvoke).toHaveBeenLastCalledWith('sketch:share', SKETCH_ID, {
			role: 'ro',
			expiresInDays: 3,
		});
		await api.unshare(SKETCH_ID);
		expect(mockInvoke).toHaveBeenLastCalledWith('sketch:unshare', SKETCH_ID);
		await api.revokeLink(SKETCH_ID, 'cap-1');
		expect(mockInvoke).toHaveBeenLastCalledWith('sketch:revokeLink', SKETCH_ID, 'cap-1');
		await api.link(SKETCH_ID, 'cap-1');
		expect(mockInvoke).toHaveBeenLastCalledWith('sketch:link', SKETCH_ID, 'cap-1');
		await api.resetLink(SKETCH_ID, 'cap-1');
		expect(mockInvoke).toHaveBeenLastCalledWith('sketch:resetLink', SKETCH_ID, 'cap-1');
		await api.rotate(SKETCH_ID);
		expect(mockInvoke).toHaveBeenLastCalledWith('sketch:rotate', SKETCH_ID);
		await api.uploadSnapshot(SKETCH_ID, { scene, baseSeq: 4 });
		expect(mockInvoke).toHaveBeenLastCalledWith('sketch:uploadSnapshot', SKETCH_ID, {
			scene,
			baseSeq: 4,
		});
		await api.roomConnection(SKETCH_ID);
		expect(mockInvoke).toHaveBeenLastCalledWith('sketch:roomConnection', SKETCH_ID);
		const request = {
			replyTo: 'msg-1',
			ts: 1_000,
			actor: { id: 'guest-1', kind: 'guest' as const, name: 'Sam', role: 'rw' as const },
			text: 'add a box',
		};
		await api.screenBotRequest(SKETCH_ID, request);
		expect(mockInvoke).toHaveBeenLastCalledWith('sketch:screenBotRequest', SKETCH_ID, request);
		await api.prepareBotTurn(SKETCH_ID, 'restricted');
		expect(mockInvoke).toHaveBeenLastCalledWith('sketch:prepareBotTurn', SKETCH_ID, 'restricted');
		await api.screenBotReply(SKETCH_ID, 'Done.');
		expect(mockInvoke).toHaveBeenLastCalledWith('sketch:screenBotReply', SKETCH_ID, 'Done.');
		await api.setBotSessionId(SKETCH_ID, null);
		expect(mockInvoke).toHaveBeenLastCalledWith('sketch:setBotSessionId', SKETCH_ID, null);
	});

	it("listens for main's remote commands and hands the request and reply channel on", () => {
		const callback = vi.fn();
		const unsubscribe = api.onRemoteCommand(callback);

		expect(mockOn).toHaveBeenCalledWith('remote:sketchCommand', expect.any(Function));
		const handler = mockOn.mock.calls[0][1] as (...args: unknown[]) => void;
		const request = { action: 'export', format: 'svg', scene };
		handler({}, request, 'remote:sketchCommand:response:1');
		expect(callback).toHaveBeenCalledWith(request, 'remote:sketchCommand:response:1');

		unsubscribe();
		expect(mockRemoveListener).toHaveBeenCalledWith('remote:sketchCommand', handler);
	});

	it('maps each B2 policy method to its channel', async () => {
		await api.botPolicyStatus(SKETCH_ID);
		expect(mockInvoke).toHaveBeenLastCalledWith('sketch:botPolicyStatus', SKETCH_ID);
		await api.setBotPolicy(SKETCH_ID, 'writers');
		expect(mockInvoke).toHaveBeenLastCalledWith('sketch:setBotPolicy', SKETCH_ID, 'writers');
		await api.noteRoomBotPolicy(SKETCH_ID, 'conductor');
		expect(mockInvoke).toHaveBeenLastCalledWith('sketch:noteRoomBotPolicy', SKETCH_ID, 'conductor');
		await api.installScreen();
		expect(mockInvoke).toHaveBeenLastCalledWith('sketch:installScreen');
		await api.localScreenOption();
		expect(mockInvoke).toHaveBeenLastCalledWith('sketch:localScreenOption');
		await api.switchScreenToLocal();
		expect(mockInvoke).toHaveBeenLastCalledWith('sketch:switchScreenToLocal');
	});

	it('maps each Room panel method to its channel', async () => {
		await api.roomStats(SKETCH_ID);
		expect(mockInvoke).toHaveBeenLastCalledWith('sketch:roomStats', SKETCH_ID);
		await api.roomAction(SKETCH_ID, 'unsuspend', { capId: 'Cap000000001' });
		expect(mockInvoke).toHaveBeenLastCalledWith('sketch:roomAction', SKETCH_ID, 'unsuspend', {
			capId: 'Cap000000001',
		});
		await api.roomAudit(SKETCH_ID);
		expect(mockInvoke).toHaveBeenLastCalledWith('sketch:roomAudit', SKETCH_ID);
	});

	it('passes the host the confirmation named with a consent grant', async () => {
		await api.grantScreeningConsent('openjev', 'jev.example.com');
		expect(mockInvoke).toHaveBeenLastCalledWith(
			'sketch:grantScreeningConsent',
			'openjev',
			'jev.example.com'
		);
	});

	it('listens for B2 policy changes and stops on unsubscribe', () => {
		const callback = vi.fn();
		const unsubscribe = api.onBotPolicyChanged(callback);

		expect(mockOn).toHaveBeenCalledWith('sketch:botPolicyChanged', expect.any(Function));
		const handler = mockOn.mock.calls[0][1] as (...args: unknown[]) => void;
		handler({}, { sketchId: SKETCH_ID });
		expect(callback).toHaveBeenCalledWith({ sketchId: SKETCH_ID });

		unsubscribe();
		expect(mockRemoveListener).toHaveBeenCalledWith('sketch:botPolicyChanged', handler);
	});

	it('listens for sleep, wake and quit presence pushes and stops on unsubscribe', () => {
		const callback = vi.fn();
		const unsubscribe = api.onPresence(callback);

		expect(mockOn).toHaveBeenCalledWith('sketch:presence', expect.any(Function));
		const handler = mockOn.mock.calls[0][1] as (...args: unknown[]) => void;
		handler({}, { online: false, reason: 'quit' });
		expect(callback).toHaveBeenCalledWith({ online: false, reason: 'quit' });

		unsubscribe();
		expect(mockRemoveListener).toHaveBeenCalledWith('sketch:presence', handler);
	});

	it('listens for agent tool-call activity and stops on unsubscribe', () => {
		const callback = vi.fn();
		const unsubscribe = api.onAgentActivity(callback);

		expect(mockOn).toHaveBeenCalledWith('sketch:agentActivity', expect.any(Function));
		const handler = mockOn.mock.calls[0][1] as (...args: unknown[]) => void;
		const activity = { agentId: 'agent-1', sketchId: 'sk-1', writes: true };
		handler({}, activity);
		expect(callback).toHaveBeenCalledWith(activity);

		unsubscribe();
		expect(mockRemoveListener).toHaveBeenCalledWith('sketch:agentActivity', handler);
	});

	it('answers on the response channel main named', () => {
		api.sendRemoteCommandResponse('remote:sketchCommand:response:1', {
			success: true,
			tabId: 'tab-1',
		});
		expect(mockSend).toHaveBeenCalledWith('remote:sketchCommand:response:1', {
			success: true,
			tabId: 'tab-1',
		});
	});
});
