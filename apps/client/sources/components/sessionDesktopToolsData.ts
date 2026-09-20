import type { GitStatus } from '@/sync/storageTypes';

export type SessionSourceKind = 'file' | 'image';

export type SessionSource = {
    key: string;
    kind: SessionSourceKind;
    label: string;
    path: string;
};

export type SourceMessageLike = {
    kind: string;
    tool?: {
        name?: unknown;
        input?: unknown;
    };
    children?: readonly SourceMessageLike[];
};

export type GitChangeStats = {
    entryCount: number;
    linesAdded: number;
    linesRemoved: number;
};

export type SubagentStats = {
    running: number;
    queued: number;
    completed: number;
    total: number;
};

const IMAGE_EXTENSION = /\.(?:avif|bmp|gif|heic|heif|jpe?g|png|svg|webp)$/i;
const PATH_KEYS = new Set([
    'file',
    'file_path',
    'filepath',
    'image',
    'image_path',
    'imagepath',
    'local_path',
    'localpath',
    'path',
]);
const PATH_COLLECTION_KEYS = new Set(['files', 'images', 'locations', 'paths']);

function finiteCount(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.max(0, Math.floor(value))
        : 0;
}

/** Return the last path segment without assuming Windows or POSIX separators. */
export function getPathShortName(path: string | null | undefined): string {
    const raw = path?.trim();
    if (!raw) return '不可用';

    if (/^[A-Za-z]:[\\/]?$/.test(raw)) {
        return `${raw[0]?.toUpperCase()}:\\`;
    }
    if (/^[\\/]+$/.test(raw)) return '/';

    const withoutTrailingSeparators = raw.replace(/[\\/]+$/, '');
    const parts = withoutTrailingSeparators.split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] ?? raw;
}

/** Summarize the information already present in the read-only git snapshot. */
export function getGitChangeStats(status: GitStatus | null | undefined): GitChangeStats | null {
    if (!status) return null;
    return {
        entryCount: finiteCount(status.modifiedCount)
            + finiteCount(status.untrackedCount)
            + finiteCount(status.stagedCount),
        linesAdded: finiteCount(status.linesAdded),
        linesRemoved: finiteCount(status.linesRemoved),
    };
}

/** Derive completed agents conservatively from the aggregate activity counters. */
export function getSubagentStats(activity: unknown): SubagentStats | null {
    if (!activity || typeof activity !== 'object') return null;
    const value = activity as Record<string, unknown>;
    const running = finiteCount(value.running);
    const queued = finiteCount(value.queued);
    const advertisedTotal = finiteCount(value.total);
    const total = Math.max(advertisedTotal, running + queued);
    return {
        running,
        queued,
        completed: Math.max(0, total - running - queued),
        total,
    };
}

function normalizedToolName(name: unknown): string {
    if (typeof name !== 'string') return '';
    const segments = name.toLowerCase().split(/[.:/]/);
    return segments[segments.length - 1] ?? '';
}

function toolSourceKind(name: unknown): SessionSourceKind | null {
    const normalized = normalizedToolName(name);
    if (!normalized) return null;
    if (normalized.includes('image')) return 'image';
    if (
        normalized === 'file'
        || normalized === 'open'
        || normalized === 'read'
        || normalized === 'read_file'
        || normalized === 'readfile'
        || normalized === 'view_file'
        || normalized === 'viewfile'
    ) {
        return 'file';
    }
    return null;
}

function normalizeCandidate(value: string): string | null {
    const candidate = value.trim();
    if (!candidate || /^(?:data|https?):/i.test(candidate)) return null;
    if (/^file:\/\//i.test(candidate)) {
        try {
            return decodeURIComponent(candidate.replace(/^file:\/\//i, ''));
        } catch {
            return candidate.replace(/^file:\/\//i, '');
        }
    }
    return candidate;
}

function collectExplicitPaths(input: unknown): string[] {
    if (!input || typeof input !== 'object') return [];
    const found: string[] = [];
    const record = input as Record<string, unknown>;

    for (const [rawKey, value] of Object.entries(record)) {
        const key = rawKey.toLowerCase();
        if (PATH_KEYS.has(key) && typeof value === 'string') {
            const candidate = normalizeCandidate(value);
            if (candidate) found.push(candidate);
            continue;
        }
        if (!PATH_COLLECTION_KEYS.has(key) || !Array.isArray(value)) continue;
        for (const entry of value) {
            if (typeof entry === 'string') {
                const candidate = normalizeCandidate(entry);
                if (candidate) found.push(candidate);
            } else if (entry && typeof entry === 'object') {
                found.push(...collectExplicitPaths(entry));
            }
        }
    }
    return found;
}

function getAttachmentSource(input: unknown): { path: string; kind: SessionSourceKind } | null {
    if (!input || typeof input !== 'object') return null;
    const record = input as Record<string, unknown>;
    const hasAttachmentMarker = typeof record.ref === 'string'
        || typeof record.previewUri === 'string'
        || typeof record.size === 'number'
        || (record.image !== null && typeof record.image === 'object')
        || record.image === true;
    if (!hasAttachmentMarker || typeof record.name !== 'string') return null;
    const path = normalizeCandidate(record.name);
    if (!path) return null;
    return {
        path,
        kind: record.image ? 'image' : IMAGE_EXTENSION.test(path) ? 'image' : 'file',
    };
}

function sourceKey(path: string): string {
    return path.replace(/\\/g, '/').toLocaleLowerCase();
}

/**
 * Extract only explicit file/image inputs from tool calls already visible in
 * the current transcript. It deliberately ignores command text, results,
 * URLs, environment values and arbitrary nested strings.
 */
export function extractSessionSources(
    messages: readonly SourceMessageLike[],
    maxSources = 5,
): SessionSource[] {
    if (maxSources <= 0) return [];
    const sources: SessionSource[] = [];
    const seen = new Set<string>();

    const visit = (items: readonly SourceMessageLike[]) => {
        // Session messages (and grouped children) are stored newest first.
        for (let index = 0; index < items.length && sources.length < maxSources; index += 1) {
            const message = items[index];
            if (!message) continue;
            if (message.children?.length) visit(message.children);
            if (sources.length >= maxSources || message.kind !== 'tool-call' || !message.tool) continue;

            const fallbackKind = toolSourceKind(message.tool.name);
            if (!fallbackKind) continue;
            const attachment = normalizedToolName(message.tool.name) === 'file'
                ? getAttachmentSource(message.tool.input)
                : null;
            const candidates = attachment
                ? [attachment.path, ...collectExplicitPaths(message.tool.input)]
                : collectExplicitPaths(message.tool.input);
            for (const path of candidates) {
                const key = sourceKey(path);
                if (seen.has(key)) continue;
                seen.add(key);
                sources.push({
                    key,
                    kind: attachment?.path === path
                        ? attachment.kind
                        : fallbackKind === 'image' || IMAGE_EXTENSION.test(path) ? 'image' : 'file',
                    label: getPathShortName(path),
                    path,
                });
                if (sources.length >= maxSources) break;
            }
        }
    };

    visit(messages);
    return sources;
}
