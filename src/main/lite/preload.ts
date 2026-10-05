import { installDiscoveryControls, readableError } from './discovery/preload';
import { ipcRenderer } from 'electron';
import type { LiteProfile } from './profiles';
import type { LiteControlState } from '../../shared/lite-control';
import { generateUUID } from '../../shared/uuid';

window.addEventListener('DOMContentLoaded', () => {
	const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
	const input = (id: string) => element<HTMLInputElement>(id);
	let profiles: LiteProfile[] = [];
	let selected: string | undefined;
	let state: LiteControlState | undefined;
	let pending = false;
	let saving = false;
	let initialized = false;
	let forgottenError = '';
	const setError = (text: string) => {
		if (element('error').textContent !== text) element('error').textContent = text;
		element('error-actions').hidden = !/forget this pairing/i.test(text);
	};
	const report = (error: unknown) => {
		const text = readableError(error);
		setError(text);
		if (text) element('error').focus();
	};
	const discovery = installDiscoveryControls(report);
	function refresh(): void {
		const saved = profiles.length > 0;
		element('saved').hidden = !saved || !element('profile').hidden;
		element('manual-new').hidden = !saved || !element('profile').hidden;
		element<HTMLButtonElement>('guide-back').disabled = pending;
		element<HTMLButtonElement>('cancel').disabled = saving;
		element<HTMLSelectElement>('profiles').disabled = pending;
		element('saved').hidden = !saved;
		element('manual-new').hidden = saved;
		for (const id of ['connect', 'edit', 'remove'])
			element<HTMLButtonElement>(id).disabled = pending || !saved;
		for (const id of ['new', 'save', 'save-connect'])
			element<HTMLButtonElement>(id).disabled = pending;
		const reconnectable =
			profiles.some((profile) => profile.id === state?.selected) ||
			(!!state?.selected && state.discoveryPairing?.pairing.phase === 'connected');
		element<HTMLButtonElement>('reconnect').disabled = pending || !reconnectable;
		element<HTMLButtonElement>('disconnect').disabled = !state?.selected;
		element('disconnect').textContent = pending ? 'Cancel connection' : 'Disconnect';
		element('profile').setAttribute('aria-busy', String(pending));
		element('connect').textContent = pending ? 'Connecting…' : 'Connect';
		document.querySelectorAll<HTMLButtonElement>('[data-action]').forEach((button) => {
			const action = button.dataset.action;
			button.disabled =
				action === 'reconnect'
					? pending || !reconnectable
					: action === 'disconnect'
						? !state?.selected
						: false;
		});
	}
	async function action(name: string, payload?: unknown): Promise<boolean> {
		try {
			await ipcRenderer.invoke('lite:control', name, payload);
			return true;
		} catch (error) {
			report(error);
			return false;
		}
	}
	function transportChanged(): void {
		const ssh = element<HTMLSelectElement>('transport').value === 'ssh';
		element('ssh').hidden = !ssh;
		input('host').required = ssh;
		input('url').placeholder = ssh
			? 'http://127.0.0.1:8080/your-link/desktop'
			: 'https://your-host.example/your-link/desktop';
		element('url-help').textContent = ssh
			? "Paste the host's Remote Control link that starts with localhost or 127.0.0.1. The tunnel opens it on the host."
			: "In Maestro on the host, open Remote Control and copy its link. You'll sign in after connecting.";
	}
	function edit(profile?: LiteProfile): void {
		selected = profile?.id;
		element('profile').hidden = false;
		discovery.showManual();
		element('form-title').textContent = profile ? 'Edit connection' : 'Add a connection';
		input('name').value = profile?.name ?? '';
		input('url').value = profile?.url ?? '';
		element<HTMLSelectElement>('transport').value = profile?.transport ?? 'https';
		input('host').value = profile?.ssh?.host ?? '';
		input('username').value = profile?.ssh?.username ?? '';
		input('port').value = String(profile?.ssh?.port ?? 22);
		input('key').value = profile?.ssh?.privateKeyPath ?? '';
		input('config').checked = profile?.ssh?.useSshConfig ?? true;
		element<HTMLTextAreaElement>('options').value = JSON.stringify(
			profile?.ssh?.sshOptions ?? {},
			null,
			2
		);
		element<HTMLDetailsElement>('advanced').open = false;
		transportChanged();
		refresh();
		element('notice').textContent = '';
	}
	async function connect(name: 'connect' | 'reconnect', id?: string): Promise<void> {
		if (pending) return;
		pending = true;
		setError('');
		element('notice').textContent = '';
		refresh();
		try {
			await action(name, id);
		} finally {
			pending = false;
			refresh();
		}
	}
	function cancelEdit(): void {
		if (saving) return;
		if (pending) {
			void action('disconnect');
			return;
		}
		edit(profiles.find((profile) => profile.id === element<HTMLSelectElement>('profiles').value));
		element('profile').hidden = true;
		if (profiles.length) element('connect').focus();
		else discovery.showHosts();
		refresh();
	}
	ipcRenderer.on('lite:state', (_event, next: LiteControlState) => {
		state = next;
		const statusText = state.status.charAt(0).toUpperCase() + state.status.slice(1);
		if (element('status').textContent !== statusText) {
			element('status').textContent = statusText;
			element('status').title = statusText;
		}
		element('picker').hidden = !state.picker;
		element('return').hidden = !state.picker || !state.canReturn;
		element('connections').hidden = state.picker;
		element('palette').hidden = state.picker && !state.commandsVisible;
		element('reconnect').hidden = state.picker;
		element('disconnect').hidden = state.picker;
		element('commands').classList.toggle('open', state.commandsVisible === true);
		element('palette').setAttribute('aria-expanded', String(state.commandsVisible === true));
		const old = element<HTMLSelectElement>('profiles').value;
		const changed = JSON.stringify(profiles) !== JSON.stringify(state.profiles);
		profiles = state.profiles;
		if (changed || !initialized) {
			element('profiles').replaceChildren(
				...profiles.map((profile) => {
					const option = document.createElement('option');
					option.value = profile.id;
					option.textContent = profile.name;
					return option;
				})
			);
			const choice =
				profiles.find((profile) => profile.id === selected) ??
				profiles.find((profile) => profile.id === old) ??
				profiles[0];
			if (choice) element<HTMLSelectElement>('profiles').value = choice.id;
			if (!initialized) {
				edit(choice);
				element('profile').hidden = true;
				discovery.showHosts(false);
				initialized = true;
			}
		}
		const profile = profiles.find(
			(entry) => entry.id === element<HTMLSelectElement>('profiles').value
		);
		element('identity-details').hidden = !profile?.instanceId;
		element('identity').textContent = profile?.instanceId
			? `Verified host ID: ${profile.instanceId}`
			: '';
		element('trust').hidden = !profile?.instanceId;
		const shownError = readableError(state.error);
		if (shownError !== forgottenError) forgottenError = '';
		if (shownError && shownError !== forgottenError && element('error').textContent !== shownError)
			report(state.error);
		else if (!state.picker || state.status.startsWith('Disconnected')) setError('');
		element('aliases').replaceChildren(
			...state.aliases.map((alias) => {
				const option = document.createElement('option');
				option.value = alias;
				return option;
			})
		);
		refresh();
	});
	element('profiles').addEventListener('change', () => {
		edit(profiles.find((profile) => profile.id === element<HTMLSelectElement>('profiles').value));
		element('profile').hidden = true;
		void action('ready');
	});
	element('new').addEventListener('click', () => {
		edit();
		input('name').focus();
	});
	element('edit').addEventListener('click', () => {
		edit(profiles.find((profile) => profile.id === element<HTMLSelectElement>('profiles').value));
		input('name').focus();
	});
	element('connect').addEventListener(
		'click',
		() => void connect('connect', element<HTMLSelectElement>('profiles').value)
	);
	element('remove').addEventListener(
		'click',
		() => void action('remove', element<HTMLSelectElement>('profiles').value)
	);
	element('trust').addEventListener(
		'click',
		() => void action('trust', element<HTMLSelectElement>('profiles').value)
	);
	element('manual-new').addEventListener('click', () => {
		edit();
		input('name').focus();
	});
	element('cancel').addEventListener('click', cancelEdit);
	element('transport').addEventListener('change', transportChanged);
	element('reconnect').addEventListener('click', () => void connect('reconnect'));
	for (const name of ['connections', 'disconnect', 'close'])
		element(name).addEventListener('click', () => void action(name));
	element('return').addEventListener('click', () => void action('dismiss'));
	element('palette').addEventListener('click', () => void action('commands'));
	ipcRenderer.on('lite:commands', () =>
		document.querySelector<HTMLButtonElement>('[data-action]')?.focus()
	);
	document.querySelectorAll<HTMLButtonElement>('[data-action]').forEach((button) =>
		button.addEventListener('click', () => {
			if (button.dataset.action === 'reconnect') void connect('reconnect');
			else void action(button.dataset.action!);
		})
	);
	document.addEventListener('keydown', (event) => {
		if (event.key !== 'Escape') return;
		event.preventDefault();
		if (state?.commandsVisible) {
			void action('dismiss');
			element('palette').focus();
		} else if (pending || (!element('manual-connections').hidden && !element('profile').hidden))
			cancelEdit();
		else if (discovery.escape()) return;
		else if (state?.canReturn) void action('dismiss');
		else {
			discovery.showHosts();
		}
	});
	element('profile').addEventListener('submit', async (event) => {
		event.preventDefault();
		if (pending) return;
		const connectAfterSave = (event as SubmitEvent).submitter?.id !== 'save';
		try {
			const transport = element<HTMLSelectElement>('transport').value as LiteProfile['transport'];
			const id = selected ?? generateUUID();
			const profile: LiteProfile = {
				id,
				name: input('name').value.trim(),
				url: input('url').value.trim(),
				transport,
			};
			if (transport === 'ssh') {
				let options: unknown;
				try {
					options = JSON.parse(element<HTMLTextAreaElement>('options').value);
				} catch {
					throw new Error('Extra SSH options must be valid JSON, for example {}.');
				}
				if (!options || typeof options !== 'object' || Array.isArray(options))
					throw new Error('Extra SSH options must be a JSON object, for example {}.');
				profile.ssh = {
					id,
					name: profile.name,
					host: input('host').value.trim(),
					username: input('username').value.trim(),
					port: Number(input('port').value),
					privateKeyPath: input('key').value.trim(),
					useSshConfig: input('config').checked,
					enabled: true,
					sshOptions: options as Record<string, string>,
				};
			}
			pending = true;
			saving = true;
			refresh();
			const saved = await action('save', profile);
			pending = false;
			saving = false;
			refresh();
			if (!saved) return;
			selected = id;
			element<HTMLSelectElement>('profiles').value = id;
			element('profile').hidden = true;
			element('notice').textContent = connectAfterSave ? '' : 'Connection saved.';
			element('connect').focus();
			if (connectAfterSave) await connect('connect', id);
		} catch (error) {
			report(error);
		}
	});
	element('error-forget').addEventListener('click', async () => {
		forgottenError = element('error').textContent ?? '';
		setError('');
		if (!(await action('pair-forget'))) {
			forgottenError = '';
			return;
		}
		element('notice').textContent = 'Pairing forgotten. Choose the host to pair again.';
		element('discovery-heading').focus();
	});
	edit();
	element('profile').hidden = true;
	discovery.showHosts(false);
	void action('ready');
});
