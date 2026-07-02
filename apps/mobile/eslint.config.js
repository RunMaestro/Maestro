// https://docs.expo.dev/guides/using-eslint/
// Browser globals lint rule per decision 9A
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
	expoConfig,
	{
		ignores: ['dist/*', '.expo/*', 'scripts/*'],
	},
	// Temporarily downgrade React Compiler hooks rules to warnings (v1 tech debt)
	// These patterns are established in the codebase and will be addressed in v2
	{
		files: ['**/*.ts', '**/*.tsx'],
		rules: {
			// Refs accessed during render - common pattern for stable callbacks
			'react-hooks/refs': 'warn',
			// setState in effects - intentional for auto-connect patterns
			'react-hooks/set-state-in-effect': 'warn',
			// Preserve manual memoization - compiler compatibility
			'react-hooks/preserve-manual-memoization': 'warn',
			// Immutability violations - hoisting issues with useCallback ordering
			'react-hooks/immutability': 'warn',
		},
	},
	// Browser globals restriction - prevents accidental use of web-only APIs
	{
		files: ['**/*.ts', '**/*.tsx'],
		ignores: ['shims/**/*'],
		rules: {
			'no-restricted-globals': [
				'error',
				{
					name: 'window',
					message:
						'window is not available in React Native. Use a shim in apps/mobile/shims/ if needed.',
				},
				{
					name: 'document',
					message: 'document is not available in React Native. Use React Native APIs instead.',
				},
				{
					name: 'localStorage',
					message:
						'localStorage is not available in React Native. Use AsyncStorage or expo-secure-store.',
				},
				{
					name: 'sessionStorage',
					message:
						'sessionStorage is not available in React Native. Use AsyncStorage or app state.',
				},
				{
					name: 'navigator',
					message:
						'navigator is not available in React Native. Use React Native APIs or expo-device.',
				},
			],
		},
	},
	// Shims directory is exempt - it provides platform-specific implementations
	{
		files: ['shims/**/*.ts', 'shims/**/*.tsx'],
		rules: {
			'no-restricted-globals': 'off',
		},
	},
]);
