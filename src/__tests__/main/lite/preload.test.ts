// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { connectionPage } from '../../../main/lite/ui';
import type { LiteControlState } from '../../../shared/lite-control';

const ipc = vi.hoisted(() => ({
	invoke: vi.fn(),
	listeners: new Map<string, (...args: unknown[]) => void>(),
}));
vi.mock('electron', () => ({
	ipcRenderer: {
		invoke: ipc.invoke,
		on: (name: string, listener: (...args: unknown[]) => void) => ipc.listeners.set(name, listener),
	},
}));
let state: LiteControlState;
let documentListeners: Array<[string, EventListenerOrEventListenerObject]>;
const field = (id: string) => document.getElementById(id) as HTMLInputElement;
const emit = () => ipc.listeners.get('lite:state')?.({}, state);

beforeEach(async () => {
	vi.resetModules();
	ipc.listeners.clear();
	ipc.invoke.mockReset();
	documentListeners = [];
	document.body.innerHTML = new DOMParser().parseFromString(
		connectionPage,
		'text/html'
	).body.innerHTML;
	state = { status: 'Disconnected', picker: true, profiles: [], aliases: [] };
	ipc.invoke.mockImplementation(async (_channel, name, profile) => {
		if (name === 'save') {
			state = { ...state, profiles: [profile] };
			emit();
		}
	});
	let ready: EventListener | undefined;
	const addWindow = window.addEventListener.bind(window);
	vi.spyOn(window, 'addEventListener').mockImplementation((name, handler, options) => {
		if (name === 'DOMContentLoaded') ready = handler as EventListener;
		else addWindow(name, handler, options);
	});
	const addDocument = document.addEventListener.bind(document);
	vi.spyOn(document, 'addEventListener').mockImplementation((name, handler, options) => {
		documentListeners.push([name, handler]);
		addDocument(name, handler, options);
	});
	await import('../../../main/lite/preload');
	ready?.(new Event('DOMContentLoaded'));
	emit();
});
afterEach(() => {
	for (const [name, handler] of documentListeners) document.removeEventListener(name, handler);
	vi.restoreAllMocks();
});

describe('Lite connection first-use and recovery', () => {
	it('offers a visible return only when a remote view actually exists', () => {
		state = { ...state, selected: 'failed-host', picker: true, canReturn: false };
		emit();
		expect(field('return').hidden).toBe(true);
		state = { ...state, canReturn: true };
		emit();
		expect(field('return').hidden).toBe(false);
		field('return').click();
		expect(ipc.invoke).toHaveBeenCalledWith('lite:control', 'dismiss', undefined);
		state = { ...state, picker: false };
		emit();
		expect(field('return').hidden).toBe(true);
	});

	it('starts with HTTPS guidance and hides empty saved connections and advanced SSH', () => {
		expect(field('transport').value).toBe('https');
		expect(field('saved').hidden).toBe(true);
		expect(field('ssh').hidden).toBe(true);
		expect(field('reconnect').disabled).toBe(true);
		field('transport').value = 'ssh';
		field('transport').dispatchEvent(new Event('change'));
		expect(field('host').required).toBe(true);
		expect((field('advanced') as unknown as HTMLDetailsElement).open).toBe(false);
	});
	it('cancel and Escape do not request application close', () => {
		field('name').value = 'Unsaved';
		field('cancel').click();
		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
		expect(field('name').value).toBe('');
		expect(ipc.invoke.mock.calls.some((call) => call[1] === 'close' || call[1] === 'dismiss')).toBe(
			false
		);
	});
	it('saves once before connecting and prevents repeated submissions', async () => {
		let finishSave!: () => void;
		ipc.invoke.mockImplementation((_channel, action, profile) => {
			if (action === 'save')
				return new Promise<void>((resolve) => {
					finishSave = () => {
						state = { ...state, profiles: [profile] };
						emit();
						resolve();
					};
				});
			return Promise.resolve();
		});
		field('name').value = 'Office';
		field('url').value = 'https://host.example/token';
		const submit = () =>
			field('profile').dispatchEvent(
				new SubmitEvent('submit', { submitter: field('save-connect') })
			);
		submit();
		submit();
		expect(ipc.invoke.mock.calls.filter((call) => call[1] === 'save')).toHaveLength(1);
		expect(field('cancel').disabled).toBe(true);
		finishSave();
		await vi.waitFor(() =>
			expect(ipc.invoke.mock.calls.filter((call) => call[1] === 'connect')).toHaveLength(1)
		);
		expect(field('profile').hidden).toBe(true);
	});
	it('save for later never starts a connection', async () => {
		field('name').value = 'Office';
		field('url').value = 'https://host.example/token';
		field('profile').dispatchEvent(new SubmitEvent('submit', { submitter: field('save') }));
		await vi.waitFor(() => expect(field('profile').hidden).toBe(true));
		expect(ipc.invoke.mock.calls.some((call) => call[1] === 'connect')).toBe(false);
	});
	it('a failed save keeps the form open and never connects', async () => {
		ipc.invoke.mockRejectedValue(new Error('Direct connections require HTTPS.'));
		field('profile').dispatchEvent(new SubmitEvent('submit', { submitter: field('save-connect') }));
		await vi.waitFor(() => expect(field('error').textContent).toContain('HTTPS'));
		expect(field('profile').hidden).toBe(false);
		expect(field('save-connect').disabled).toBe(false);
		expect(ipc.invoke.mock.calls.some((call) => call[1] === 'connect')).toBe(false);
	});
	it('unchanged errors do not steal focus during connection-menu updates', () => {
		state = { ...state, error: 'Host unavailable' };
		emit();
		expect(document.activeElement).toBe(field('error'));
		field('palette').focus();
		emit();
		expect(document.activeElement).toBe(field('palette'));
	});
});
