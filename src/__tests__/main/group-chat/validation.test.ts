/**
 * @file validation.test.ts
 * @description Unit tests for Group Chat IPC input validation.
 *
 * Tests cover:
 * - UUID v4 validation for group chat IDs
 * - Participant name sanitization
 * - Message content size limits
 * - Base64 image size limits
 * - Custom args shell metachar rejection
 * - Custom env vars key/value validation
 */

import { describe, it, expect } from 'vitest';
import {
	validateGroupChatId,
	validateParticipantName,
	validateMessageContent,
	validateBase64Image,
	validateCustomArgs,
	sanitizeCustomEnvVars,
} from '../../../main/group-chat/validation';

describe('validateGroupChatId', () => {
	it('accepts a valid UUID v4', () => {
		const id = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
		expect(validateGroupChatId(id)).toBe(id);
	});

	it('accepts uppercase UUID', () => {
		const id = 'A1B2C3D4-E5F6-7890-ABCD-EF1234567890';
		expect(validateGroupChatId(id)).toBe(id);
	});

	it('rejects non-string input', () => {
		expect(() => validateGroupChatId(123)).toThrow('Invalid group chat ID: must be a valid UUID');
		expect(() => validateGroupChatId(null)).toThrow('Invalid group chat ID: must be a valid UUID');
		expect(() => validateGroupChatId(undefined)).toThrow('Invalid group chat ID: must be a valid UUID');
	});

	it('rejects non-UUID strings', () => {
		expect(() => validateGroupChatId('not-a-uuid')).toThrow('Invalid group chat ID: must be a valid UUID');
		expect(() => validateGroupChatId('')).toThrow('Invalid group chat ID: must be a valid UUID');
	});

	it('rejects path traversal attempts', () => {
		expect(() => validateGroupChatId('../../etc/passwd')).toThrow('Invalid group chat ID: must be a valid UUID');
		expect(() => validateGroupChatId('../../../foo')).toThrow('Invalid group chat ID: must be a valid UUID');
	});
});

describe('validateParticipantName', () => {
	it('accepts a valid name', () => {
		expect(validateParticipantName('Alice')).toBe('Alice');
	});

	it('trims whitespace', () => {
		expect(validateParticipantName('  Alice  ')).toBe('Alice');
	});

	it('rejects non-string input', () => {
		expect(() => validateParticipantName(123)).toThrow('must be a string');
		expect(() => validateParticipantName(null)).toThrow('must be a string');
	});

	it('rejects empty string', () => {
		expect(() => validateParticipantName('')).toThrow('must not be empty');
		expect(() => validateParticipantName('   ')).toThrow('must not be empty');
	});

	it('rejects names over 100 characters', () => {
		const longName = 'a'.repeat(101);
		expect(() => validateParticipantName(longName)).toThrow('must be 100 characters or fewer');
	});

	it('accepts names exactly 100 characters', () => {
		const name = 'a'.repeat(100);
		expect(validateParticipantName(name)).toBe(name);
	});

	it('rejects names with control characters', () => {
		expect(() => validateParticipantName('test\x00name')).toThrow('contains unsafe characters');
		expect(() => validateParticipantName('test\x1fname')).toThrow('contains unsafe characters');
	});

	it('rejects names with pipes', () => {
		expect(() => validateParticipantName('test|name')).toThrow('contains unsafe characters');
	});

	it('rejects names with path separators', () => {
		expect(() => validateParticipantName('test/name')).toThrow('contains unsafe characters');
		expect(() => validateParticipantName('test\\name')).toThrow('contains unsafe characters');
	});

	it('rejects names with newlines', () => {
		expect(() => validateParticipantName('test\nname')).toThrow('contains unsafe characters');
		expect(() => validateParticipantName('test\rname')).toThrow('contains unsafe characters');
	});

	it('accepts names with spaces, hyphens, dots', () => {
		expect(validateParticipantName('Agent Alpha-1')).toBe('Agent Alpha-1');
		expect(validateParticipantName('claude.code')).toBe('claude.code');
	});
});

describe('validateMessageContent', () => {
	it('accepts valid message content', () => {
		expect(validateMessageContent('Hello world')).toBe('Hello world');
	});

	it('rejects non-string input', () => {
		expect(() => validateMessageContent(123)).toThrow('must be a string');
		expect(() => validateMessageContent(null)).toThrow('must be a string');
	});

	it('rejects empty string', () => {
		expect(() => validateMessageContent('')).toThrow('must not be empty');
	});

	it('rejects content exceeding default max length', () => {
		const large = 'x'.repeat(512001);
		expect(() => validateMessageContent(large)).toThrow('Message too large');
	});

	it('accepts content at exactly max length', () => {
		const exact = 'x'.repeat(512000);
		expect(validateMessageContent(exact)).toBe(exact);
	});

	it('supports custom max length', () => {
		const content = 'x'.repeat(200);
		expect(() => validateMessageContent(content, 100)).toThrow('Message too large: 200 characters exceeds maximum of 100');
	});
});

describe('validateBase64Image', () => {
	it('accepts valid base64 data', () => {
		const data = 'SGVsbG8gV29ybGQ=';
		expect(validateBase64Image(data)).toBe(data);
	});

	it('rejects non-string input', () => {
		expect(() => validateBase64Image(123)).toThrow('must be a string');
		expect(() => validateBase64Image(null)).toThrow('must be a string');
	});

	it('rejects image exceeding 20MB decoded', () => {
		// 20MB = 20 * 1024 * 1024 bytes. Base64 is ~4/3 ratio,
		// so we need a string longer than maxSizeBytes / 0.75
		const oversizedLength = Math.ceil((20 * 1024 * 1024) / 0.75) + 100;
		const largeData = 'A'.repeat(oversizedLength);
		expect(() => validateBase64Image(largeData)).toThrow('Image too large');
	});

	it('supports custom max size', () => {
		// 100 bytes max. Need string > 100/0.75 ≈ 134 chars
		const data = 'A'.repeat(200);
		expect(() => validateBase64Image(data, 100)).toThrow('Image too large');
	});
});

describe('validateCustomArgs', () => {
	it('returns undefined for null/undefined', () => {
		expect(validateCustomArgs(null)).toBeUndefined();
		expect(validateCustomArgs(undefined)).toBeUndefined();
	});

	it('accepts safe args', () => {
		expect(validateCustomArgs('--model gpt-4 --temperature 0.7')).toBe('--model gpt-4 --temperature 0.7');
	});

	it('rejects non-string input', () => {
		expect(() => validateCustomArgs(123)).toThrow('Custom args must be a string');
	});

	it('rejects backticks', () => {
		expect(() => validateCustomArgs('`whoami`')).toThrow('Custom args contain unsafe characters');
	});

	it('rejects $() subshell', () => {
		expect(() => validateCustomArgs('$(cat /etc/passwd)')).toThrow('Custom args contain unsafe characters');
	});

	it('rejects ${} expansion', () => {
		expect(() => validateCustomArgs('${HOME}')).toThrow('Custom args contain unsafe characters');
	});

	it('rejects && chaining', () => {
		expect(() => validateCustomArgs('--flag && rm -rf /')).toThrow('Custom args contain unsafe characters');
	});

	it('rejects || chaining', () => {
		expect(() => validateCustomArgs('--flag || malicious')).toThrow('Custom args contain unsafe characters');
	});

	it('rejects semicolons', () => {
		expect(() => validateCustomArgs('--flag; rm -rf /')).toThrow('Custom args contain unsafe characters');
	});

	it('rejects redirects', () => {
		expect(() => validateCustomArgs('--flag > /tmp/out')).toThrow('Custom args contain unsafe characters');
		expect(() => validateCustomArgs('--flag < /etc/passwd')).toThrow('Custom args contain unsafe characters');
	});

	it('rejects pipe', () => {
		expect(() => validateCustomArgs('--flag | grep secret')).toThrow('Custom args contain unsafe characters');
	});
});

describe('sanitizeCustomEnvVars', () => {
	it('returns undefined for null/undefined', () => {
		expect(sanitizeCustomEnvVars(null)).toBeUndefined();
		expect(sanitizeCustomEnvVars(undefined)).toBeUndefined();
	});

	it('accepts valid env vars', () => {
		const vars = { NODE_ENV: 'production', _CUSTOM_VAR: 'value' };
		expect(sanitizeCustomEnvVars(vars)).toEqual(vars);
	});

	it('rejects non-object input', () => {
		expect(() => sanitizeCustomEnvVars('string')).toThrow('must be an object');
		expect(() => sanitizeCustomEnvVars(123)).toThrow('must be an object');
	});

	it('rejects arrays', () => {
		expect(() => sanitizeCustomEnvVars(['a', 'b'])).toThrow('must be an object');
	});

	it('rejects keys starting with numbers', () => {
		expect(() => sanitizeCustomEnvVars({ '1BAD': 'value' })).toThrow("Invalid environment variable key: '1BAD'");
	});

	it('rejects keys with special characters', () => {
		expect(() => sanitizeCustomEnvVars({ 'MY-VAR': 'value' })).toThrow("Invalid environment variable key: 'MY-VAR'");
		expect(() => sanitizeCustomEnvVars({ 'MY VAR': 'value' })).toThrow("Invalid environment variable key: 'MY VAR'");
	});

	it('rejects non-string values', () => {
		expect(() => sanitizeCustomEnvVars({ MY_VAR: 123 })).toThrow("must have a string value");
	});

	it('accepts empty object', () => {
		expect(sanitizeCustomEnvVars({})).toEqual({});
	});
});
