/**
 * The mock provider tier: the trio that makes A Cappella runnable with no
 * model, no device, and no network. It is also the fallback the registry falls
 * back TO, never away from, which is why it has to stay dependency-free.
 */

import type { VoiceProviderTrio } from '../../../../shared/acappella/providers';
import { MockBrainProvider } from './mock-brain';
import { MockSttProvider } from './mock-stt';
import { MockTtsProvider } from './mock-tts';
import type { MockSttOptions } from './mock-stt';
import type { MockTtsOptions } from './mock-tts';

export { MockBrainProvider } from './mock-brain';
export { MockSttProvider } from './mock-stt';
export { MockTtsProvider } from './mock-tts';
export type { MockSttOptions } from './mock-stt';
export type { MockTtsOptions } from './mock-tts';

export interface MockProviderOptions {
	stt?: MockSttOptions;
	tts?: MockTtsOptions;
}

/** A fresh mock trio. Providers hold per-session state, so never share one. */
export function createMockProviderTrio(options: MockProviderOptions = {}): VoiceProviderTrio {
	return {
		stt: new MockSttProvider(options.stt),
		tts: new MockTtsProvider(options.tts),
		brain: new MockBrainProvider(),
	};
}
