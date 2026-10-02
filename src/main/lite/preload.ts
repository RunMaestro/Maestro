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
	const report = (error: unknown) => {
		element('error').textContent = error instanceof Error ? error.message : String(error);
		element('error').focus();
	};
	function refresh(): void {
		const saved = profiles.length > 0;
		element<HTMLButtonElement>('cancel').disabled = saving;
		element<HTMLSelectElement>('profiles').disabled = pending;
		element('saved').hidden = !saved;
		for (const id of ['connect', 'edit', 'remove'])
			element<HTMLButtonElement>(id).disabled = pending || !saved;
		for (const id of ['new', 'save', 'save-connect'])
			element<HTMLButtonElement>(id).disabled = pending;
		element<HTMLButtonElement>('reconnect').disabled =
			pending || !profiles.some((profile) => profile.id === state?.selected);
		element<HTMLButtonElement>('disconnect').disabled = !state?.selected;
		element('disconnect').textContent = pending ? 'Cancel connection' : 'Disconnect';
		element('profile').setAttribute('aria-busy', String(pending));
		element('connect').textContent = pending ? 'Connecting...' : 'Connect';
		document.querySelectorAll<HTMLButtonElement>('[data-action]').forEach((button) => {
			const action = button.dataset.action;
			button.disabled =
				action === 'reconnect'
					? pending || !profiles.some((profile) => profile.id === state?.selected)
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
			? "Paste the host's Remote Control link using localhost or 127.0.0.1. The tunnel connects to it on the host."
			: 'Paste the complete HTTPS link from the host. You will sign in after connecting.';
	}
	function edit(profile?: LiteProfile): void {
		selected = profile?.id;
		element('profile').hidden = false;
		element('form-title').textContent = profile
			? 'Edit connection'
			: profiles.length
				? 'Add connection'
				: 'Add your first connection';
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
		element('error').textContent = '';
		element('notice').textContent = '';
	}
	async function connect(name: 'connect' | 'reconnect', id?: string): Promise<void> {
		if (pending) return;
		pending = true;
		element('error').textContent = '';
		element('notice').textContent =
			'Connecting to your host. You can cancel using the button above.';
		refresh();
		try {
			await action(name, id);
		} finally {
			pending = false;
			element('notice').textContent = '';
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
		if (profiles.length) {
			element('profile').hidden = true;
			element('connect').focus();
		} else {
			element('notice').textContent =
				'Setup canceled. You can add a connection whenever you are ready.';
			input('name').focus();
		}
	}
	ipcRenderer.on('lite:state', (_event, next: LiteControlState) => {
		state = next;
		element('status').textContent = state.status;
		element('status').title = state.status;
		element('picker').hidden = !state.picker;
		element('return').hidden = !state.picker || !state.canReturn;
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
				element('profile').hidden = profiles.length > 0;
				element<HTMLDetailsElement>('setup-help').open = profiles.length === 0;
				initialized = true;
			} else if (!profiles.length) edit();
		}
		const profile = profiles.find(
			(entry) => entry.id === element<HTMLSelectElement>('profiles').value
		);
		element('identity-details').hidden = !profile?.instanceId;
		element('identity').textContent = profile?.instanceId
			? `Verified host: ${profile.instanceId}`
			: '';
		element('trust').hidden = !profile?.instanceId;
		if (state.error && element('error').textContent !== state.error) report(state.error);
		else if (!state.picker || state.status.startsWith('Disconnected'))
			element('error').textContent = '';
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
		} else if (pending || !element('profile').hidden) cancelEdit();
		else void action('dismiss');
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
			element<HTMLDetailsElement>('setup-help').open = false;
			element('notice').textContent = 'Connection saved. Choose Connect when you are ready.';
			element('connect').focus();
			if (connectAfterSave) await connect('connect', id);
		} catch (error) {
			report(error);
		}
	});
	edit();
	void action('ready');
});
