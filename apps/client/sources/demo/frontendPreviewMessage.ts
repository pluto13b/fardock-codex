import type { AttachmentPreview } from '@/sync/attachmentTypes';
import type { Message } from '@/sync/typesMessage';

/**
 * Builds local-only timeline records for a preview send. Attachment records
 * carry their picker URI so FileView can render them without an upload or
 * download request. They never enter the production wire pipeline.
 */
export function createFrontendPreviewUserMessages(
    text: string,
    attachments: readonly AttachmentPreview[] = [],
    now: number = Date.now(),
): Message[] {
    const attachmentMessages: Message[] = attachments.map((attachment, index) => ({
        id: `preview-file-${now}-${index}-${attachment.id}`,
        localId: `preview-file-local-${now}-${index}-${attachment.id}`,
        createdAt: now - index - 1,
        kind: 'tool-call',
        tool: {
            name: 'file',
            state: 'completed',
            input: {
                ref: `preview-local:${attachment.id}`,
                name: attachment.name,
                size: attachment.size,
                previewUri: attachment.uri,
                image: {
                    width: attachment.width,
                    height: attachment.height,
                    ...(attachment.thumbhash ? { thumbhash: attachment.thumbhash } : {}),
                },
            },
            createdAt: now,
            startedAt: now,
            completedAt: now,
            description: null,
        },
        children: [],
        meta: { sentFrom: 'codex_plus' },
    }));

    if (!text.trim()) {
        return attachmentMessages;
    }

    const textMessage: Message = {
        id: `preview-user-${now}`,
        localId: `preview-local-${now}`,
        createdAt: now,
        kind: 'user-text',
        text,
        meta: { sentFrom: 'codex_plus' },
    };
    return [textMessage, ...attachmentMessages];
}
