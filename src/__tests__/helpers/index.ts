/**
 * Barrel export for shared test helpers.
 *
 * Import from here in tests to avoid duplicating factory definitions
 * across many test files.
 */

export { createMockAITab, createMockFileTab } from './mockTab';
export { createMockSession } from './mockSession';
export { installLocalStorageMock } from './mockLocalStorage';
export {
	createFakeAudioBuffer,
	createFakeAudioContext,
	createFakeGainNode,
	createFakeMediaStream,
	installAudioWorkletNodeMock,
	installMediaDevicesMock,
} from './mockWebAudio';
export { ALL_RENDERER_STORES, resetAllStores, resetStore, resetStores } from './resetStores';
