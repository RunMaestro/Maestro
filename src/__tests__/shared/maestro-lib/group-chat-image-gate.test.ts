import { describe, expect, it } from 'vitest';

import {
	MODERATOR_CANNOT_READ_IMAGES_REASON,
	moderatorImagesRefusal,
} from '../../../shared/maestro-lib/groupchat/image-gate';
import {
	agentCanReadImages,
	agentIdCanReadImages,
} from '../../../shared/maestro-lib/providers/capabilities';

describe('moderatorImagesRefusal', () => {
	it('never refuses a text-only send, even from a text-only provider', () => {
		expect(moderatorImagesRefusal({ moderatorAgentId: 'terminal' }, undefined)).toBeNull();
		expect(moderatorImagesRefusal({ moderatorAgentId: 'terminal' }, [])).toBeNull();
	});

	it('allows when the chat or moderator is missing', () => {
		expect(moderatorImagesRefusal(null, ['/images/a.png'])).toBeNull();
		expect(moderatorImagesRefusal(undefined, ['/images/a.png'])).toBeNull();
		expect(moderatorImagesRefusal({}, ['/images/a.png'])).toBeNull();
		expect(moderatorImagesRefusal({ moderatorAgentId: null }, ['/images/a.png'])).toBeNull();
	});

	it('allows a provider that is not in the registry', () => {
		expect(
			moderatorImagesRefusal({ moderatorAgentId: 'not-a-provider' }, ['/images/a.png'])
		).toBeNull();
		expect(agentIdCanReadImages('not-a-provider')).toBe(true);
	});

	it('allows a provider whose capabilities are known to include image input', () => {
		expect(
			moderatorImagesRefusal({ moderatorAgentId: 'claude-code' }, ['/images/a.png'])
		).toBeNull();
		expect(agentIdCanReadImages('claude-code')).toBe(true);
	});

	it('refuses only a known text-only provider, with the user-facing reason', () => {
		expect(moderatorImagesRefusal({ moderatorAgentId: 'terminal' }, ['/images/a.png'])).toBe(
			MODERATOR_CANNOT_READ_IMAGES_REASON
		);
		expect(MODERATOR_CANNOT_READ_IMAGES_REASON).toBe(
			"This room's moderator can't read images. Remove this message and send it again without images."
		);
		expect(agentIdCanReadImages('terminal')).toBe(false);
	});
});

describe('agentCanReadImages', () => {
	it('treats an unknown capability object as allowed', () => {
		expect(agentCanReadImages(undefined)).toBe(true);
		expect(agentCanReadImages(null)).toBe(true);
	});

	it('reads the known flag', () => {
		expect(agentCanReadImages({ supportsImageInput: false })).toBe(false);
		expect(agentCanReadImages({ supportsImageInput: true })).toBe(true);
	});
});
