import { describe, expect, it } from 'vitest';

import type { AttachmentPreview } from '@/sync/attachmentTypes';
import { createFrontendPreviewUserMessages } from './frontendPreviewMessage';

const image: AttachmentPreview = {
    id: 'picked-1',
    uri: 'blob:https://preview.test/local-image',
    width: 640,
    height: 480,
    mimeType: 'image/png',
    size: 1234,
    name: 'screen.png',
    thumbhash: 'thumb',
};

describe('createFrontendPreviewUserMessages', () => {
    it('keeps the exact text and adds a local-only file record for each selected image', () => {
        const messages = createFrontendPreviewUserMessages('  inspect this\n', [image], 1000);

        expect(messages).toHaveLength(2);
        expect(messages[0]).toMatchObject({
            kind: 'user-text',
            text: '  inspect this\n',
        });
        expect(messages[1]).toMatchObject({
            kind: 'tool-call',
            tool: {
                name: 'file',
                input: {
                    ref: 'preview-local:picked-1',
                    name: 'screen.png',
                    previewUri: image.uri,
                    image: { width: 640, height: 480, thumbhash: 'thumb' },
                },
            },
        });
    });

    it('represents an attachment-only send without an empty text bubble', () => {
        const messages = createFrontendPreviewUserMessages('   ', [image], 1000);

        expect(messages).toHaveLength(1);
        expect(messages[0].kind).toBe('tool-call');
    });
});
