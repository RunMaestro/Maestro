import * as opaque from '@serenity-kit/opaque';
import { displayName } from '../discovery/types';
import {
	token,
	hash,
	requireToken,
	fail,
	identifiers,
	binding,
	grantBody,
	mac,
	verifies,
	PROTOCOL,
	SCOPE,
	CONNECT_PATH,
	CONNECTION_CAPABILITIES,
	PIN_TTL,
	GRANT_TTL,
	type PairingTransport,
	type Route,
	type Descriptor,
	type Challenge,
	type Grant,
	type Metadata,
	type RemoteStatus,
} from './protocol';
import type { ClientState } from '../../../shared/lite-discovery';
/** Client holds no host object and has no PIN-display or approval API. Never persists trust or credentials. */
export class PairingClient {
	private challenge?: Challenge;
	private capability = '';
	private key = '';
	private grant?: Grant;
	private counter = 0;
	private revision = 0;
	private abort = new AbortController();
	private busy = false;
	private state: ClientState = { phase: 'idle' };
	constructor(
		private transport: PairingTransport,
		private route: Route,
		private name: string,
		private now = Date.now
	) {
		this.name = displayName(name);
	}
	snapshot(): ClientState {
		if (
			!['cancelled', 'expired', 'locked', 'connection-lost', 'network-changed'].includes(
				this.state.phase
			) &&
			this.state.expiresAt &&
			this.state.expiresAt <= this.now()
		)
			this.invalidate('expired');
		return { ...this.state };
	}
	private invalidate(phase: string): void {
		this.revision++;
		this.abort.abort();
		this.key = '';
		this.grant = undefined;
		this.state = { ...this.state, phase, metadata: undefined };
	}
	private payload(extra: object = {}) {
		return { id: this.challenge?.requestId, capability: this.capability, ...extra };
	}
	private async active<T>(run: () => Promise<T>): Promise<T> {
		if (this.busy) fail('operation-in-progress');
		this.busy = true;
		const revision = this.revision;
		try {
			const result = await run();
			if (revision !== this.revision) fail('cancelled');
			return result;
		} catch (error) {
			if (revision === this.revision)
				this.state.error = error instanceof Error ? error.message : 'pairing-failed';
			throw error;
		} finally {
			this.busy = false;
		}
	}
	async begin(expectedInstanceId?: string): Promise<void> {
		if (this.state.phase !== 'idle') fail('cancel-before-retry');
		return this.active(async () => {
			const revision = this.revision;
			this.state.phase = 'requesting';
			await opaque.ready;
			if (revision !== this.revision) fail('cancelled');
			const descriptor = await this.transport.call<Descriptor>('describe', {}, this.abort.signal);
			if (
				descriptor.protocol !== PROTOCOL ||
				descriptor.scope !== SCOPE ||
				typeof descriptor.hostKey !== 'string' ||
				descriptor.hostKey.length > 1024 ||
				typeof descriptor.instanceId !== 'string' ||
				descriptor.instanceId.length > 256
			)
				fail('incompatible-host');
			requireToken(descriptor.epoch);
			if (expectedInstanceId && expectedInstanceId !== descriptor.instanceId)
				fail('host-identity-changed');
			if (revision !== this.revision) fail('cancelled');
			const capability = token(),
				nonce = token();
			this.capability = capability;
			const c = await this.transport.call<Challenge>(
				'begin',
				{
					clientName: this.name,
					clientNonce: nonce,
					capabilityHash: hash(capability),
					scope: SCOPE,
					epoch: descriptor.epoch,
				},
				this.abort.signal
			);
			// If cancellation races a received response, revoke the newly allocated host request.
			if (revision !== this.revision) {
				await this.transport.call('cancel', { id: c.requestId, capability }).catch(() => undefined);
				fail('cancelled');
			}
			requireToken(c.requestId);
			requireToken(c.hostNonce);
			if (
				c.protocol !== PROTOCOL ||
				c.clientNonce !== nonce ||
				c.clientName !== this.name ||
				c.hostKey !== descriptor.hostKey ||
				c.instanceId !== descriptor.instanceId ||
				c.epoch !== descriptor.epoch ||
				c.endpoint !== this.route.endpoint ||
				c.source !== this.route.source ||
				c.scope !== SCOPE ||
				!Number.isSafeInteger(c.expiresAt) ||
				c.expiresAt <= this.now() ||
				c.expiresAt > this.now() + PIN_TTL
			)
				fail('channel-mismatch');
			this.challenge = c;
			this.state = {
				phase: 'awaiting-host',
				hostKey: c.hostKey,
				instanceId: c.instanceId,
				expiresAt: c.expiresAt,
			};
		});
	}
	async poll(): Promise<void> {
		if (
			!this.challenge ||
			this.busy ||
			['cancelled', 'expired', 'locked'].includes(this.snapshot().phase)
		)
			return;
		const revision = this.revision;
		const status = await this.transport.call<RemoteStatus>(
			'status',
			this.payload(),
			this.abort.signal
		);
		if (revision !== this.revision) return;
		if (
			![
				'awaiting-host',
				'pin-issued',
				'awaiting-confirmation',
				'approved',
				'paired',
				'cancelled',
				'expired',
				'locked',
			].includes(status.state)
		)
			fail('invalid-host-response');
		if (['cancelled', 'expired', 'locked'].includes(status.state)) {
			this.invalidate(status.state);
			return;
		}
		if (status.state === 'approved' && this.key && !this.grant) await this.claim();
		else if (status.state !== 'paired') this.state.phase = status.state;
	}
	async submit(pin: string): Promise<void> {
		if (!/^\d{6}$/.test(pin) || !this.challenge || this.snapshot().phase !== 'pin-issued')
			fail('six-digits-and-host-approval-required');
		return this.active(async () => {
			const revision = this.revision;
			const login = opaque.client.startLogin({ password: pin });
			const response = await this.transport.call<{ attemptId: string; loginResponse: string }>(
				'start',
				this.payload({ message: login.startLoginRequest }),
				this.abort.signal
			);
			if (revision !== this.revision) fail('cancelled');
			let result: ReturnType<typeof opaque.client.finishLogin>;
			try {
				result = opaque.client.finishLogin({
					clientLoginState: login.clientLoginState,
					loginResponse: response.loginResponse,
					password: pin,
					identifiers: identifiers(this.challenge!),
				});
			} catch {
				result = undefined;
			}
			if (!result || result.serverStaticPublicKey !== this.challenge!.hostKey) {
				await this.transport.call(
					'reject',
					this.payload({ attemptId: response.attemptId }),
					this.abort.signal
				);
				fail('wrong-pin-or-host');
			}
			await this.transport.call(
				'finish',
				this.payload({ attemptId: response.attemptId, message: result.finishLoginRequest }),
				this.abort.signal
			);
			if (revision !== this.revision) fail('cancelled');
			this.key = result.sessionKey;
			this.state.phase = 'awaiting-confirmation';
			this.state.error = undefined;
		});
	}
	private async claim(): Promise<void> {
		return this.active(async () => {
			const revision = this.revision;
			const challenge = this.challenge!;
			const response = await this.transport.call<{ grant: Grant; proof: string }>(
				'claim',
				this.payload({ proof: mac(this.key, ['claim', binding(challenge)]) }),
				this.abort.signal
			);
			if (revision !== this.revision) fail('cancelled');
			const g = response.grant;
			if (
				!g ||
				g.scope !== SCOPE ||
				g.hostKey !== challenge.hostKey ||
				g.requestId !== challenge.requestId ||
				g.binding !== binding(challenge) ||
				!Number.isSafeInteger(g.expiresAt) ||
				g.expiresAt <= this.now() ||
				g.expiresAt > this.now() + GRANT_TTL ||
				!verifies(this.key, response.proof, ['grant', ...grantBody(g)])
			)
				fail('channel-mismatch');
			this.grant = g;
			this.state = { ...this.state, phase: 'paired', expiresAt: g.expiresAt, error: undefined };
		});
	}
	async read(): Promise<Metadata> {
		if (this.snapshot().phase !== 'paired' || !this.grant || !this.key) fail('not-paired');
		return this.active(async () => {
			const revision = this.revision,
				g = this.grant!,
				counter = this.counter + 1;
			const response = await this.transport.call<{ value: Metadata; proof: string }>(
				'read',
				this.payload({
					grantId: g.id,
					counter,
					method: SCOPE,
					proof: mac(this.key, ['operation', ...grantBody(g), counter, SCOPE]),
				}),
				this.abort.signal
			);
			if (revision !== this.revision) fail('cancelled');
			if (
				!verifies(this.key, response.proof, ['result', g.id, counter, response.value]) ||
				response.value.instanceId !== this.challenge!.instanceId ||
				response.value.connection?.path !== CONNECT_PATH ||
				response.value.connection.authentication !== 'device-pairing' ||
				!CONNECTION_CAPABILITIES.every((capability) =>
					response.value.connection.capabilities?.includes(capability)
				) ||
				response.value.hostKey !== this.challenge!.hostKey
			)
				fail('channel-mismatch');
			this.counter = counter;
			this.state.metadata = response.value;
			return response.value;
		});
	}
	connectionAdmission(): string {
		if (this.snapshot().phase !== 'paired' || !this.grant || !this.key || !this.state.metadata)
			fail('not-paired');
		return this.grant.id + '.' + mac(this.key, ['device', ...grantBody(this.grant)]);
	}
	async cancel(reason = 'cancelled'): Promise<void> {
		const payload = this.payload();
		this.invalidate(reason);
		this.capability = '';
		if (payload.id && payload.capability)
			await this.transport.call('cancel', payload).catch(() => {
				this.state.error =
					'Cancellation could not reach host; access expires automatically. Host can revoke immediately.';
			});
	}
}
