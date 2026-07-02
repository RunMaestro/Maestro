/**
 * asyncStorageAdapter - Native implementation of the storage contract for React Native
 *
 * This adapter implements the StorageAdapter interface defined in
 * src/web/hooks/useOfflineQueue.ts, allowing the useOfflineQueue hook to persist
 * queued commands to AsyncStorage on React Native.
 *
 * The interface contract:
 * - getItem(key): Promise<string | null>
 * - setItem(key, value): Promise<void>
 * - removeItem(key): Promise<void>
 *
 * This enables the same hook to work across web (localStorage) and mobile (AsyncStorage).
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { StorageAdapter } from '@maestro/web-hooks/useOfflineQueue';

/**
 * AsyncStorage adapter for React Native that implements the StorageAdapter interface.
 * Delegates directly to AsyncStorage methods with matching signatures.
 */
export const asyncStorageAdapter: StorageAdapter = {
	getItem: AsyncStorage.getItem,
	setItem: AsyncStorage.setItem,
	removeItem: AsyncStorage.removeItem,
};

export default asyncStorageAdapter;
