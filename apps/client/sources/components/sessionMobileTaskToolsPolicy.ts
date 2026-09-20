import type { Metadata } from '@/sync/storageTypes';

type MobileChangesPolicyInput = {
    metadata: Metadata | null | undefined;
    presence: string | null | undefined;
    preview: boolean;
    hasGitSnapshot: boolean;
};

/**
 * Mobile diff mounts RPC-backed readers, so legacy/implicit capability
 * fallbacks are not sufficient. Only an explicit capability catalog may open it.
 */
export function hasExplicitMobileDiffCapabilities(metadata: Metadata | null | undefined): boolean {
    if ((metadata?.rigMetadataVersion ?? 0) < 1) return false;
    const capabilities = metadata?.capabilities;
    const methods = new Set(capabilities?.rpcMethods ?? []);
    return capabilities?.files?.browse === true
        && capabilities.files.read === true
        && capabilities.shell === true
        && methods.has('bash')
        && methods.has('readFile');
}

export function canOpenMobileTaskChanges(input: MobileChangesPolicyInput): boolean {
    return !input.preview
        && input.presence === 'online'
        && input.hasGitSnapshot
        && hasExplicitMobileDiffCapabilities(input.metadata);
}
