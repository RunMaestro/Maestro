import { HostReceiptLedgerClient } from './host-receipt-ledger-client';
/** Relay operations share the bounded host-private worker transport. */
export class RelayLedgerClient extends HostReceiptLedgerClient {
	get(key: string): Promise<string | null> {
		return this.call('get', key);
	}
	set(key: string, value: string): Promise<void> {
		return this.call('set', key, value);
	}
	reserveTurn(key: string, value: string, mappingKey?: string, mapping?: string): Promise<void> {
		return this.call('reserveTurn', key, value, mappingKey, mapping);
	}
	finishTurn(
		receiptKey: string,
		receipt: string,
		mappingKey: string,
		mapping: string
	): Promise<void> {
		return this.call('finishTurn', receiptKey, receipt, mappingKey, mapping);
	}
	mappingKeys(): Promise<string[]> {
		return this.call('mappingKeys');
	}
	assertProviderAvailable(agent: string, provider: string, conversation: string): Promise<void> {
		return this.call('assertProviderAvailable', agent, provider, conversation);
	}
	settleTurn(key: string, providerId?: string): Promise<void> {
		return this.call('settleTurn', key, providerId);
	}
	deletePending(key: string): Promise<void> {
		return this.call('deletePending', key);
	}
	purgeMappings(): Promise<void> {
		return this.call('purgeMappings');
	}
}
