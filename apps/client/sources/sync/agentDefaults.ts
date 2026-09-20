import * as z from 'zod';

export const agentKeys = ['claude', 'codex', 'gemini', 'openclaw', 'agy'] as const;
export type AgentKey = typeof agentKeys[number];

export const AgentDefaultOverrideSchema = z.object({
    permissionMode: z.string().optional(),
    modelMode: z.string().optional(),
    effortLevel: z.string().optional(),
}).passthrough();

export const AgentDefaultOverridesSchema = z.object({
    claude: AgentDefaultOverrideSchema.optional(),
    codex: AgentDefaultOverrideSchema.optional(),
    gemini: AgentDefaultOverrideSchema.optional(),
    openclaw: AgentDefaultOverrideSchema.optional(),
    agy: AgentDefaultOverrideSchema.optional(),
}).passthrough().default({});

export type AgentDefaultOverride = z.infer<typeof AgentDefaultOverrideSchema>;
export type AgentDefaultOverrides = z.infer<typeof AgentDefaultOverridesSchema>;
export type AgentDefaultField = keyof Pick<AgentDefaultOverride, 'permissionMode' | 'modelMode' | 'effortLevel'>;

export type AgentDefaultConfig = {
    permissionMode: string;
    modelMode: string;
    effortLevel: string | null;
};

export type CodexRemotePermissionMode = 'default' | 'read-only';

export function isCodexRemotePermissionMode(value: unknown): value is CodexRemotePermissionMode {
    return value === 'default' || value === 'read-only';
}

/**
 * Remote clients may lower a Codex task to read-only or use ask-first.
 * Missing values use ask-first; stale/unknown/elevated values fail closed.
 */
export function resolveCodexRemotePermissionMode(value: unknown): CodexRemotePermissionMode {
    if (value === null || value === undefined || value === '') return 'default';
    return isCodexRemotePermissionMode(value) ? value : 'read-only';
}

/**
 * Codex Plus is Codex-only. Treat missing/legacy flavor metadata as Codex so
 * an ambiguous task cannot bypass the remote permission boundary. Explicit
 * non-Codex/Rig metadata remains untouched for imported upstream fixtures.
 */
export function shouldGuardCodexRemotePermissions(
    metadata: {
        flavor?: unknown;
        codexThreadId?: unknown;
        client?: { id?: unknown } | null;
    } | null | undefined,
): boolean {
    if (metadata?.client?.id === 'rig') {
        return false;
    }
    if (typeof metadata?.codexThreadId === 'string' && metadata.codexThreadId.length > 0) {
        return true;
    }
    const explicitlySupportedNonCodexFlavor = metadata?.flavor === 'claude'
        || metadata?.flavor === 'gemini'
        || metadata?.flavor === 'openclaw'
        || metadata?.flavor === 'agy';
    return !explicitlySupportedNonCodexFlavor;
}

export function isExplicitCodexSessionMetadata(
    metadata: {
        flavor?: unknown;
        codexThreadId?: unknown;
        client?: { id?: unknown } | null;
    } | null | undefined,
): boolean {
    if (metadata?.client?.id === 'rig') {
        return false;
    }
    return metadata?.flavor === 'codex'
        || (typeof metadata?.codexThreadId === 'string' && metadata.codexThreadId.length > 0);
}

const codeAgentDefaults: Record<AgentKey, AgentDefaultConfig> = {
    // The Claude UI key for YOLO is `bypassPermissions`; the CLI also accepts
    // `yolo` and maps it to the Claude SDK's bypass mode.
    claude: { permissionMode: 'bypassPermissions', modelMode: 'opus', effortLevel: 'medium' },
    // Keep the imported UI fail-closed. The Windows Agent will supply the
    // effective per-turn policy after an explicit local authorization.
    codex: { permissionMode: 'default', modelMode: 'default', effortLevel: null },
    gemini: { permissionMode: 'default', modelMode: 'gemini-2.5-pro', effortLevel: null },
    openclaw: { permissionMode: 'default', modelMode: 'default', effortLevel: null },
    agy: { permissionMode: 'default', modelMode: 'Gemini 3.1 Pro (High)', effortLevel: null },
};

export function normalizeAgentKey(flavor: string | null | undefined): AgentKey {
    if (flavor === 'codex' || flavor === 'gemini' || flavor === 'openclaw' || flavor === 'agy') {
        return flavor;
    }
    return 'claude';
}

export function getCodeAgentDefaults(flavor: string | null | undefined): AgentDefaultConfig {
    return codeAgentDefaults[normalizeAgentKey(flavor)];
}

export function getAgentDefaultOverride(
    overrides: AgentDefaultOverrides | null | undefined,
    flavor: string | null | undefined,
): AgentDefaultOverride {
    const key = normalizeAgentKey(flavor);
    const override = overrides?.[key] ?? {};
    if (key !== 'codex' || override.permissionMode === undefined) {
        return override;
    }
    return {
        ...override,
        permissionMode: resolveCodexRemotePermissionMode(override.permissionMode),
    };
}

export function resolveAgentDefaultConfig(
    overrides: AgentDefaultOverrides | null | undefined,
    flavor: string | null | undefined,
): AgentDefaultConfig {
    const codeDefaults = getCodeAgentDefaults(flavor);
    const userOverride = getAgentDefaultOverride(overrides, flavor);
    const permissionMode = userOverride.permissionMode ?? codeDefaults.permissionMode;
    return {
        permissionMode: normalizeAgentKey(flavor) === 'codex'
            ? resolveCodexRemotePermissionMode(permissionMode)
            : permissionMode,
        modelMode: userOverride.modelMode ?? codeDefaults.modelMode,
        effortLevel: userOverride.effortLevel ?? codeDefaults.effortLevel,
    };
}

export function hasAgentDefaultOverride(
    overrides: AgentDefaultOverrides | null | undefined,
    flavor: string | null | undefined,
    field: AgentDefaultField,
): boolean {
    return getAgentDefaultOverride(overrides, flavor)[field] !== undefined;
}

export function getAgentDefaultOverrideValue(
    overrides: AgentDefaultOverrides | null | undefined,
    flavor: string | null | undefined,
    field: AgentDefaultField,
): string | undefined {
    return getAgentDefaultOverride(overrides, flavor)[field];
}

export function setAgentDefaultOverride(
    overrides: AgentDefaultOverrides | null | undefined,
    flavor: string | null | undefined,
    field: AgentDefaultField,
    value: string | null | undefined,
): AgentDefaultOverrides {
    const key = normalizeAgentKey(flavor);
    const next: AgentDefaultOverrides = { ...(overrides ?? {}) };
    const current: AgentDefaultOverride = { ...(next[key] ?? {}) };

    if (value === null || value === undefined) {
        delete current[field];
    } else {
        current[field] = key === 'codex' && field === 'permissionMode'
            ? resolveCodexRemotePermissionMode(value)
            : value;
    }

    if (current.permissionMode === undefined && current.modelMode === undefined && current.effortLevel === undefined) {
        delete next[key];
    } else {
        next[key] = current;
    }

    return next;
}
