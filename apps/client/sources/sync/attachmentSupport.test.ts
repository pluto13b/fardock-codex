import { describe, expect, it } from 'vitest';

import {
    getImageAttachmentSendPlan,
    isAttachmentAllowedByPolicy,
    resolveAttachmentUploadBatch,
    supportsImageAttachmentsForFlavor,
} from './attachmentSupport';

describe('supportsImageAttachmentsForFlavor', () => {
    it('supports legacy sessions, Claude, and Codex', () => {
        expect(supportsImageAttachmentsForFlavor(undefined)).toBe(true);
        expect(supportsImageAttachmentsForFlavor(null)).toBe(true);
        expect(supportsImageAttachmentsForFlavor('claude')).toBe(true);
        expect(supportsImageAttachmentsForFlavor('codex')).toBe(true);
    });

    it('rejects Gemini, OpenClaw, and unknown explicit flavors', () => {
        expect(supportsImageAttachmentsForFlavor('gemini')).toBe(false);
        expect(supportsImageAttachmentsForFlavor('openclaw')).toBe(false);
        expect(supportsImageAttachmentsForFlavor('custom-agent')).toBe(false);
    });
});

describe('getImageAttachmentSendPlan', () => {
    it('uses attachments and sends text for Codex', () => {
        expect(getImageAttachmentSendPlan({
            flavor: 'codex',
            text: '',
            attachmentCount: 1,
        })).toEqual({
            supportsAttachments: true,
            shouldUseAttachments: true,
            shouldShowUnsupportedAlert: false,
            shouldSendText: true,
        });
    });

    it('warns but still sends non-empty text for unsupported agents', () => {
        expect(getImageAttachmentSendPlan({
            flavor: 'gemini',
            text: 'describe this',
            attachmentCount: 1,
        })).toEqual({
            supportsAttachments: false,
            shouldUseAttachments: false,
            shouldShowUnsupportedAlert: true,
            shouldSendText: true,
        });
    });

    it('warns and sends nothing for unsupported image-only messages', () => {
        expect(getImageAttachmentSendPlan({
            flavor: 'openclaw',
            text: '   ',
            attachmentCount: 2,
        })).toEqual({
            supportsAttachments: false,
            shouldUseAttachments: false,
            shouldShowUnsupportedAlert: true,
            shouldSendText: false,
        });
    });
});

describe('Rig attachment policy', () => {
    it('lets capability metadata override provider flavor inference', () => {
        expect(getImageAttachmentSendPlan({
            flavor: 'custom',
            text: '',
            attachmentCount: 1,
            supportsAttachments: true,
        }).shouldUseAttachments).toBe(true);
    });

    it('honors media type wildcards and max bytes', () => {
        const policy = { maxBytes: 10, mediaTypes: ['image/*'] };
        expect(isAttachmentAllowedByPolicy({ mimeType: 'image/png', size: 10 }, policy)).toBe(true);
        expect(isAttachmentAllowedByPolicy({ mimeType: 'image/png', size: 11 }, policy)).toBe(false);
        expect(isAttachmentAllowedByPolicy({ mimeType: 'application/pdf', size: 5 }, policy)).toBe(false);
    });
});

describe('resolveAttachmentUploadBatch', () => {
    it('commits only when every requested attachment uploaded', () => {
        expect(resolveAttachmentUploadBatch(2, 2, 0)).toEqual({
            complete: true,
            failureCount: 0,
        });
    });

    it('fails the whole batch when one upload fails after another succeeds', () => {
        expect(resolveAttachmentUploadBatch(2, 1, 1)).toEqual({
            complete: false,
            failureCount: 1,
        });
    });

    it('fails closed when uploaded and requested counts are inconsistent', () => {
        expect(resolveAttachmentUploadBatch(2, 1, 0)).toEqual({
            complete: false,
            failureCount: 1,
        });
    });
});
