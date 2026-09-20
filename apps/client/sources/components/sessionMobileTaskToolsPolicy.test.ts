import { describe, expect, it } from 'vitest';
import type { Metadata } from '@/sync/storageTypes';
import {
    canOpenMobileTaskChanges,
    hasExplicitMobileDiffCapabilities,
} from './sessionMobileTaskToolsPolicy';

const explicitMetadata = {
    path: 'C:\\Projects\\codex-plus',
    host: 'windows-test',
    rigMetadataVersion: 1,
    capabilities: {
        abort: true,
        attachments: { enabled: true, maxBytes: 10_000_000, mediaTypes: ['image/png'] },
        files: { browse: true, read: true, search: true, write: false },
        shell: true,
        modelSelection: true,
        reasoningSelection: true,
        permissionModeSelection: true,
        resume: true,
        rpcMethods: ['bash', 'readFile'],
        steering: true,
    },
} as Metadata;

describe('mobile task changes policy', () => {
    it('requires an explicit browse/read/shell RPC catalog', () => {
        expect(hasExplicitMobileDiffCapabilities(explicitMetadata)).toBe(true);
        expect(hasExplicitMobileDiffCapabilities({} as Metadata)).toBe(false);
        expect(hasExplicitMobileDiffCapabilities({
            ...explicitMetadata,
            capabilities: {
                ...explicitMetadata.capabilities!,
                rpcMethods: ['bash'],
            },
        })).toBe(false);
    });

    it('fails closed for preview, offline, or missing git state', () => {
        const base = {
            metadata: explicitMetadata,
            presence: 'online',
            preview: false,
            hasGitSnapshot: true,
        };
        expect(canOpenMobileTaskChanges(base)).toBe(true);
        expect(canOpenMobileTaskChanges({ ...base, preview: true })).toBe(false);
        expect(canOpenMobileTaskChanges({ ...base, presence: 'offline' })).toBe(false);
        expect(canOpenMobileTaskChanges({ ...base, hasGitSnapshot: false })).toBe(false);
        expect(canOpenMobileTaskChanges({ ...base, metadata: undefined })).toBe(false);
    });
});
