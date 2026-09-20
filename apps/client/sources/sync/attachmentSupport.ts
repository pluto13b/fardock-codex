export type ImageAttachmentFlavor = string | null | undefined;

export type ImageAttachmentSendPlan = {
    supportsAttachments: boolean;
    shouldUseAttachments: boolean;
    shouldShowUnsupportedAlert: boolean;
    shouldSendText: boolean;
};

export function supportsImageAttachmentsForFlavor(flavor: ImageAttachmentFlavor): boolean {
    return !flavor || flavor === 'claude' || flavor === 'codex';
}

export function getImageAttachmentSendPlan(opts: {
    flavor: ImageAttachmentFlavor;
    text: string;
    attachmentCount: number;
    supportsAttachments?: boolean;
}): ImageAttachmentSendPlan {
    const hasAttachments = opts.attachmentCount > 0;
    const supportsAttachments = opts.supportsAttachments ?? supportsImageAttachmentsForFlavor(opts.flavor);
    const shouldShowUnsupportedAlert = hasAttachments && !supportsAttachments;

    return {
        supportsAttachments,
        shouldUseAttachments: hasAttachments && supportsAttachments,
        shouldShowUnsupportedAlert,
        shouldSendText: !shouldShowUnsupportedAlert || opts.text.trim().length > 0,
    };
}

export function isAttachmentAllowedByPolicy(
    attachment: { mimeType: string; size: number },
    policy: { maxBytes: number; mediaTypes: string[] },
): boolean {
    const sizeAllowed = attachment.size <= 0 || attachment.size <= policy.maxBytes;
    const mediaAllowed = policy.mediaTypes.some((allowed) => (
        allowed === attachment.mimeType
        || (allowed.endsWith('/*') && attachment.mimeType.startsWith(allowed.slice(0, -1)))
    ));
    return sizeAllowed && mediaAllowed;
}

export type AttachmentUploadBatchDecision =
    | { complete: true; failureCount: 0 }
    | { complete: false; failureCount: number };

/**
 * An attachment send may only commit when every requested upload succeeded.
 * The count cross-check fails closed if an uploader ever returns an
 * inconsistent result without incrementing its explicit failure counter.
 */
export function resolveAttachmentUploadBatch(
    requestedCount: number,
    uploadedCount: number,
    reportedFailureCount: number,
): AttachmentUploadBatchDecision {
    if (reportedFailureCount === 0 && uploadedCount === requestedCount) {
        return { complete: true, failureCount: 0 };
    }

    return {
        complete: false,
        failureCount: Math.max(
            1,
            reportedFailureCount,
            requestedCount - uploadedCount,
        ),
    };
}
