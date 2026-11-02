import path from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalJson } from '../../shared/canonicalJson';
import { HostReceiptLedgerClient } from '../plugins/host-receipt-ledger-client';
import { PluginAuthorityError } from '../plugins/plugin-authority';
import type { AuthorizationStore, AuthIdentity } from '../plugins/authorization-ledger';
import type { PluginEventReceiptRow } from '../plugins/plugin-cue-events';
import type { CueReceiptBaseline, CueStoredReceipt } from './cue-receipt-ledger';

export interface PluginCueReceiptStore {
	read(pluginId: string, key: string): Promise<CueStoredReceipt | null>;
	historical(
		pluginId: string,
		current: AuthIdentity,
		consumerId: string,
		eventId: string,
		payloadHash: string
	): Promise<string | null>;
	reserve(
		pluginId: string,
		key: string,
		row: PluginEventReceiptRow,
		attempt: string
	): Promise<void>;
	dispatch(pluginId: string, key: string, attempt: string): Promise<void>;
	accepted(pluginId: string, key: string, attempt: string, filtered?: boolean): Promise<void>;
	cancelPublish(pluginId: string, key: string, attempt: string): Promise<void>;
	claim(
		pluginId: string,
		key: string,
		receiptId: string,
		owner: string,
		runId: string
	): Promise<boolean>;
	settle(
		pluginId: string,
		key: string,
		receiptId: string,
		owner: string,
		runId: string,
		started: boolean
	): Promise<void>;
}

export class CueReceiptStore extends HostReceiptLedgerClient implements PluginCueReceiptStore {
	constructor(
		baseDir: string,
		cueDbPath: string,
		private readonly store: AuthorizationStore,
		private readonly baseline: (
			pluginId: string
		) => CueReceiptBaseline | Promise<CueReceiptBaseline>,
		script = path.join(__dirname, 'cue-receipt-worker.js')
	) {
		super(baseDir, undefined, script, { cueDbPath });
	}
	protected override async call<T>(method: string, ...args: unknown[]): Promise<T> {
		try {
			return await super.call<T>(method, ...args);
		} catch (error) {
			throw new PluginAuthorityError(
				error instanceof Error && /capacity|limit/.test(error.message)
					? 'PLUGIN_LIMIT'
					: error instanceof Error && /conflict|changed/.test(error.message)
						? 'PLUGIN_CONFLICT'
						: 'PLUGIN_UNAVAILABLE'
			);
		}
	}
	private async prepare(pluginId: string): Promise<void> {
		const state = await this.call<{ phase: string } | null>('transitionState', pluginId);
		if (state?.phase === 'stable') return;
		await this.call('prepare', pluginId, await this.baseline(pluginId));
	}
	async read(pluginId: string, key: string): Promise<CueStoredReceipt | null> {
		await this.prepare(pluginId);
		return this.call('read', pluginId, key);
	}
	async historical(
		pluginId: string,
		current: AuthIdentity,
		consumerId: string,
		eventId: string,
		payloadHash: string
	): Promise<string | null> {
		await this.prepare(pluginId);
		const state = await this.call<{ identities: AuthIdentity[] }>('transitionState', pluginId);
		const keys = state.identities.map(
			(identity) =>
				'legacy:' +
				createHash('sha256')
					.update(canonicalJson([pluginId, identity, consumerId, eventId]))
					.digest('hex')
		);
		const rows = await this.call<
			{ key: string; value: { receipt: PluginEventReceiptRow; historicalIdentity: AuthIdentity } }[]
		>('historical', pluginId, keys);
		const verified = await this.store.authenticatePluginReceiptRows(
			pluginId,
			current,
			rows.map(({ key, value }) => ({
				id: key.slice('legacy:'.length),
				row: value.receipt,
				identity: value.historicalIdentity,
				purpose: 'event',
			}))
		);
		if (verified.some((value) => !value)) throw new PluginAuthorityError('PLUGIN_INTEGRITY');
		let receiptId: string | null = null;
		for (const { value } of rows) {
			const row = value.receipt,
				identity = value.historicalIdentity;
			if (identity.signerKey !== current.signerKey) continue;
			if (row.payloadHash !== payloadHash || (receiptId && receiptId !== row.receiptId))
				throw new PluginAuthorityError('PLUGIN_CONFLICT');
			receiptId = row.receiptId;
		}
		return receiptId;
	}
	async reserve(
		pluginId: string,
		key: string,
		row: PluginEventReceiptRow,
		attempt: string
	): Promise<void> {
		await this.prepare(pluginId);
		return this.call('reserve', pluginId, key, row, attempt);
	}
	dispatch(pluginId: string, key: string, attempt: string): Promise<void> {
		return this.call('dispatch', pluginId, key, attempt);
	}
	accepted(pluginId: string, key: string, attempt: string, filtered?: boolean): Promise<void> {
		return this.call('accepted', pluginId, key, attempt, filtered);
	}
	cancelPublish(pluginId: string, key: string, attempt: string): Promise<void> {
		return this.call('cancelPublish', pluginId, key, attempt);
	}
	claim(
		pluginId: string,
		key: string,
		receiptId: string,
		owner: string,
		runId: string
	): Promise<boolean> {
		return this.call('claim', pluginId, key, receiptId, owner, runId);
	}
	settle(
		pluginId: string,
		key: string,
		receiptId: string,
		owner: string,
		runId: string,
		started: boolean
	): Promise<void> {
		return this.call('settle', pluginId, key, receiptId, owner, runId, started);
	}
}
