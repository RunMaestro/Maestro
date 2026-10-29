import { describe, expect, it, vi } from 'vitest';
const ipcRenderer = vi.hoisted(() => ({
	invoke: vi.fn(async () => ({})),
	on: vi.fn(),
	removeListener: vi.fn(),
}));
vi.mock('electron', () => ({ ipcRenderer }));
import { createMemoryApi } from '../../../main/preload/memory';

describe('memory command preload transport', () => {
	it('uses the host-owned workflow channels and removes the owner event subscription', async () => {
		const api = createMemoryApi();
		await api.commandAvailability('generator');
		expect(ipcRenderer.invoke).toHaveBeenLastCalledWith('memory:command:availability', 'generator');
		await api.commandStatus('viewer', 'request');
		expect(ipcRenderer.invoke).toHaveBeenLastCalledWith(
			'memory:command:status',
			'viewer',
			'request'
		);
		await api.cancelCommand('viewer', 'request');
		expect(ipcRenderer.invoke).toHaveBeenLastCalledWith(
			'memory:command:cancel',
			'viewer',
			'request'
		);
		await api.closeCommandViewer('viewer');
		expect(ipcRenderer.invoke).toHaveBeenLastCalledWith('memory:command:close', 'viewer');
		const callback = vi.fn();
		const off = api.onCommandDraft(callback);
		const [channel, listener] = ipcRenderer.on.mock.calls[0];
		const payload = {
			viewerId: 'viewer',
			requestId: 'request',
			draft: { command: 'synthetic', description: 'Synthetic', prompt: 'Synthetic prompt' },
		};
		await api.saveCommand('viewer', 'request', payload.draft);
		expect(ipcRenderer.invoke).toHaveBeenLastCalledWith(
			'memory:command:save',
			'viewer',
			'request',
			payload.draft
		);
		listener({}, payload);
		expect(callback).toHaveBeenCalledExactlyOnceWith(payload);
		const editorCallback = vi.fn();
		const offEditor = api.onCommandEditor(editorCallback);
		const [editorChannel, editorListener] = ipcRenderer.on.mock.calls.at(-1)!;
		expect(editorChannel).toBe('memory:command:editor');
		const editorPreview = { ...payload, viewerId: 'host-issued-alias', background: true };
		editorListener({}, editorPreview);
		expect(editorCallback).toHaveBeenCalledExactlyOnceWith(editorPreview);
		offEditor();
		expect(ipcRenderer.removeListener).toHaveBeenCalledWith(editorChannel, editorListener);
		off();
		expect(ipcRenderer.removeListener).toHaveBeenCalledWith(channel, listener);
	});
});
