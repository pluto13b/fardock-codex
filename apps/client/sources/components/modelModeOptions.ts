import type { Metadata } from '@/sync/storageTypes';
import { hackModes } from '@/sync/modeHacks';
import { getCodeAgentDefaults } from '@/sync/agentDefaults';
import {
    getRigCurrentModel,
    getRigModels,
    getRigReasoningLevels,
    getRigSelectedModelKey,
    isRigMetadataV1,
} from '@/sync/rig';

export type ModeOption = {
    key: string;
    name: string;
    description?: string | null;
    semanticKind?: string | null;
    disabled?: boolean;
};

export type PermissionMode = ModeOption;
export type ModelMode = ModeOption & {
    modelId?: string;
    providerId?: string;
    providerName?: string;
    providerKind?: string;
    contextWindow?: number;
    serviceTiers?: string[];
    thinkingLevels?: string[];
    defaultThinkingLevel?: string | null;
    unavailable?: boolean;
};

export type EffortLevel = ModeOption;
export type PermissionModeKey = string;
export type ModelModeKey = string;

export type AgentFlavor = 'claude' | 'codex' | 'gemini' | string | null | undefined;

type Translate = (key: any) => string;

const CANONICAL_EFFORT_KEYS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

const EFFORT_LABELS: Record<string, Record<string, string>> = {
    en: {
        minimal: 'Minimal',
        low: 'Light',
        medium: 'Medium',
        high: 'High',
        xhigh: 'Extra high',
        max: 'Maximum',
        ultra: 'Ultra',
    },
    'zh-Hans': {
        minimal: '最低',
        low: '轻度',
        medium: '中',
        high: '高',
        xhigh: '极高',
        max: '最高',
        ultra: '极高',
    },
    'zh-Hant': {
        minimal: '最低',
        low: '輕度',
        medium: '中',
        high: '高',
        xhigh: '極高',
        max: '最高',
        ultra: '極高',
    },
};

/**
 * Localize only canonical fallback labels. Agent-provided display names and
 * descriptions remain authoritative, while protocol keys stay untouched.
 */
export function presentEffortLevel(level: EffortLevel, language: string): EffortLevel {
    const normalizedName = level.name.trim().toLowerCase();
    const shouldLocalize = CANONICAL_EFFORT_KEYS.has(level.key)
        && (normalizedName === level.key || CANONICAL_EFFORT_KEYS.has(normalizedName));
    const labels = EFFORT_LABELS[language] ?? EFFORT_LABELS.en;
    const ultraDescription = language === 'zh-Hans'
        ? '更快消耗使用额度'
        : language === 'zh-Hant'
            ? '更快消耗使用額度'
            : 'Uses quota faster';

    return {
        ...level,
        name: shouldLocalize ? labels[level.key] ?? level.name : level.name,
        description: level.description ?? (level.key === 'ultra' ? ultraDescription : null),
    };
}

type MetadataOption = {
    code: string;
    value: string;
    description?: string | null;
};

const GEMINI_MODEL_FALLBACKS: ModelMode[] = [
    { key: 'gemini-3.1-pro-preview', name: 'gemini 3.1 pro', description: 'latest & most capable' },
    { key: 'gemini-3-flash-preview', name: 'gemini 3 flash', description: 'latest & fast' },
    { key: 'gemini-3.1-flash-lite-preview', name: 'gemini 3.1 flash lite', description: 'latest & fastest' },
    { key: 'gemini-2.5-pro', name: 'gemini 2.5 pro', description: 'most capable' },
    { key: 'gemini-2.5-flash', name: 'gemini 2.5 flash', description: 'fast & efficient' },
    { key: 'gemini-2.5-flash-lite', name: 'gemini 2.5 flash lite', description: 'fastest' },
];

export function mapMetadataOptions(options?: MetadataOption[] | null): ModeOption[] {
    if (!options || options.length === 0) {
        return [];
    }

    return options.map((option) => ({
        key: option.code,
        name: option.value,
        description: option.description ?? null,
    }));
}

export function getClaudePermissionModes(translate: Translate): PermissionMode[] {
    return [
        { key: 'default', name: translate('agentInput.permissionMode.default'), description: null },
        { key: 'plan', name: translate('agentInput.permissionMode.plan'), description: null },
        { key: 'dontAsk', name: translate('agentInput.permissionMode.dontAsk'), description: null },
        { key: 'acceptEdits', name: translate('agentInput.permissionMode.acceptEdits'), description: null },
        { key: 'bypassPermissions', name: translate('agentInput.permissionMode.bypassPermissions'), description: null },
    ];
}

export function getCodexPermissionModes(translate: Translate): PermissionMode[] {
    return [
        { key: 'default', name: translate('agentInput.codexPermissionMode.default'), description: translate('agentInput.codexPermissionMode.defaultDescription') },
        { key: 'read-only', name: translate('agentInput.codexPermissionMode.readOnly'), description: translate('agentInput.codexPermissionMode.readOnlyDescription') },
        // Remote clients may display elevated modes reported by the Agent, but
        // must not activate them until a Windows-local capability says so.
        { key: 'safe-yolo', name: translate('agentInput.codexPermissionMode.safeYolo'), description: translate('agentInput.codexPermissionMode.safeYoloDescription'), disabled: true },
        { key: 'yolo', name: translate('agentInput.codexPermissionMode.yolo'), description: translate('agentInput.codexPermissionMode.yoloDescription'), disabled: true },
    ];
}

export function getGeminiPermissionModes(translate: Translate): PermissionMode[] {
    return [
        { key: 'default', name: translate('agentInput.geminiPermissionMode.default'), description: null },
        { key: 'auto_edit', name: translate('agentInput.geminiPermissionMode.autoEdit'), description: null },
        { key: 'yolo', name: translate('agentInput.geminiPermissionMode.yolo'), description: null },
        { key: 'plan', name: translate('agentInput.geminiPermissionMode.plan'), description: null },
    ];
}

export function getClaudeModelModes(): ModelMode[] {
    return [
        { key: 'default', name: 'default model', description: null },
        // Full model ID, not the `opus-5` short alias: the alias is not in the
        // CLI's alias table yet (`claude --model opus-5` errors on 2.1.199),
        // while the full ID passes straight through to the API.
        { key: 'claude-opus-5', name: 'opus 5', description: null },
        { key: 'opus', name: 'opus 4.8', description: null },
        { key: 'fable', name: 'fable 5', description: null },
        { key: 'sonnet', name: 'sonnet 4.6', description: null },
        { key: 'haiku', name: 'haiku 4.5', description: null },
    ];
}

export function getCodexModelModes(): ModelMode[] {
    return [
        { key: 'default', name: 'Default', description: null },
        { key: 'gpt-5.6-sol', name: '5.6 Sol', description: null },
        { key: 'gpt-5.6-terra', name: '5.6 Terra', description: null },
        { key: 'gpt-5.6-luna', name: '5.6 Luna', description: null },
        { key: 'gpt-5.5', name: '5.5', description: null },
        { key: 'gpt-5.4', name: '5.4', description: null },
        { key: 'gpt-5.3-codex', name: '5.3 Codex', description: null },
        { key: 'gpt-5.2-codex', name: '5.2 Codex', description: null },
        { key: 'gpt-5.1-codex-max', name: '5.1 Codex Max', description: null },
        { key: 'gpt-5.2', name: '5.2', description: null },
        { key: 'gpt-5.1-codex-mini', name: '5.1 Codex Mini', description: null },
    ];
}

export function getGeminiModelModes(): ModelMode[] {
    return GEMINI_MODEL_FALLBACKS;
}

export function getOpenClawPermissionModes(translate: Translate): PermissionMode[] {
    return [
        { key: 'default', name: translate('agentInput.permissionMode.default'), description: null },
        { key: 'bypassPermissions', name: translate('agentInput.permissionMode.bypassPermissions'), description: null },
    ];
}

// agy --print only distinguishes --sandbox (default) from --dangerously-skip-permissions,
// so only these two modes are offered.
export function getAgyPermissionModes(translate: Translate): PermissionMode[] {
    return [
        { key: 'default', name: translate('agentInput.permissionMode.default'), description: null },
        { key: 'bypassPermissions', name: translate('agentInput.permissionMode.bypassPermissions'), description: null },
    ];
}

export function getHardcodedPermissionModes(flavor: AgentFlavor, translate: Translate): PermissionMode[] {
    if (flavor === 'codex') {
        return getCodexPermissionModes(translate);
    }
    if (flavor === 'gemini') {
        return getGeminiPermissionModes(translate);
    }
    if (flavor === 'openclaw') {
        return getOpenClawPermissionModes(translate);
    }
    if (flavor === 'agy') {
        return getAgyPermissionModes(translate);
    }
    return getClaudePermissionModes(translate);
}

export function getOpenClawModelModes(): ModelMode[] {
    return [
        { key: 'default', name: 'default model', description: null },
    ];
}

// Keys are the exact display names `agy --model` accepts (as printed by `agy models`).
export function getAgyModelModes(): ModelMode[] {
    return [
        { key: 'Gemini 3.6 Flash (High)', name: 'gemini 3.6 flash (high)', description: null },
        { key: 'Gemini 3.6 Flash (Medium)', name: 'gemini 3.6 flash (medium)', description: null },
        { key: 'Gemini 3.6 Flash (Low)', name: 'gemini 3.6 flash (low)', description: null },
        { key: 'Gemini 3.1 Pro (High)', name: 'gemini 3.1 pro (high)', description: null },
        { key: 'Gemini 3.1 Pro (Low)', name: 'gemini 3.1 pro (low)', description: null },
        { key: 'Gemini 3.5 Flash (High)', name: 'gemini 3.5 flash (high)', description: null },
        { key: 'Gemini 3.5 Flash (Medium)', name: 'gemini 3.5 flash (medium)', description: null },
        { key: 'Gemini 3.5 Flash (Low)', name: 'gemini 3.5 flash (low)', description: null },
        { key: 'Claude Opus 4.6 (Thinking)', name: 'claude opus 4.6 (thinking)', description: null },
        { key: 'Claude Sonnet 4.6 (Thinking)', name: 'claude sonnet 4.6 (thinking)', description: null },
        { key: 'GPT-OSS 120B (Medium)', name: 'gpt-oss 120b (medium)', description: null },
    ];
}

export function getHardcodedModelModes(flavor: AgentFlavor, _translate: Translate): ModelMode[] {
    if (flavor === 'codex') {
        return getCodexModelModes();
    }
    if (flavor === 'gemini') {
        return getGeminiModelModes();
    }
    if (flavor === 'openclaw') {
        return getOpenClawModelModes();
    }
    if (flavor === 'agy') {
        return getAgyModelModes();
    }
    return getClaudeModelModes();
}

export function getAvailableModels(
    flavor: AgentFlavor,
    metadata: Metadata | null | undefined,
    translate: Translate,
    selectedKey?: string | null,
): ModelMode[] {
    if (isRigMetadataV1(metadata)) {
        const models: ModelMode[] = getRigModels(metadata).map((model) => ({
            key: model.key,
            name: model.name,
            description: model.providerName,
            modelId: model.id,
            providerId: model.providerId,
            providerName: model.providerName,
            providerKind: model.providerKind,
            contextWindow: model.contextWindow,
            serviceTiers: model.serviceTiers,
            thinkingLevels: model.thinkingLevels,
            defaultThinkingLevel: model.defaultThinkingLevel,
        }));
        const current = getRigCurrentModel(metadata);
        if (current?.unavailable && !models.some((model) => model.key === current.key)) {
            models.unshift({
                key: current.key,
                name: current.name,
                description: `${current.providerName} · unavailable`,
                modelId: current.id,
                providerId: current.providerId,
                providerName: current.providerName,
                providerKind: current.providerKind,
                thinkingLevels: [],
                serviceTiers: [],
                unavailable: true,
                disabled: true,
            });
        }
        const locallySelectedKey = selectedKey ?? metadata?.modelMode;
        if (locallySelectedKey && locallySelectedKey.includes(':') && !models.some((model) => model.key === locallySelectedKey)) {
            const separator = locallySelectedKey.indexOf(':');
            const providerId = locallySelectedKey.slice(0, separator);
            const modelId = locallySelectedKey.slice(separator + 1);
            models.unshift({
                key: locallySelectedKey,
                name: modelId,
                description: `${providerId} · unavailable`,
                modelId,
                providerId,
                providerName: providerId,
                providerKind: 'custom',
                unavailable: true,
                disabled: true,
            });
        }
        return models;
    }
    const metadataModels = mapMetadataOptions(metadata?.models);
    if (metadataModels.length > 0) {
        return metadataModels;
    }
    return getHardcodedModelModes(flavor, translate);
}

export function getAvailablePermissionModes(
    flavor: AgentFlavor,
    metadata: Metadata | null | undefined,
    translate: Translate,
    selectedKey?: string | null,
): PermissionMode[] {
    if (isRigMetadataV1(metadata)) {
        const modes: PermissionMode[] = (metadata?.operatingModes ?? []).map((mode) => ({
            key: mode.code,
            name: mode.value,
            description: mode.description ?? null,
            semanticKind: mode.kind ?? null,
        }));
        const current = selectedKey
            ?? metadata?.currentOperatingModeCode
            ?? metadata?.permissionMode
            ?? metadata?.session?.permissionMode;
        if (current && !modes.some((mode) => mode.key === current)) {
            modes.unshift({
                key: current,
                name: current,
                description: 'Unavailable in the current Rig mode catalog',
                semanticKind: null,
                disabled: true,
            });
        }
        return modes;
    }
    if (flavor === 'claude' || flavor === 'codex' || flavor === 'openclaw' || flavor === 'agy') {
        return hackModes(getHardcodedPermissionModes(flavor, translate));
    }

    const metadataModes = mapMetadataOptions(metadata?.operatingModes);
    if (metadataModes.length > 0) {
        return hackModes(metadataModes);
    }

    return hackModes(getHardcodedPermissionModes(flavor, translate));
}

export function findOptionByKey<T extends ModeOption>(options: T[], key: string | null | undefined): T | null {
    if (!key) {
        return null;
    }
    return options.find((option) => option.key === key) ?? null;
}

export function resolveCurrentOption<T extends ModeOption>(
    options: T[],
    preferredKeys: Array<string | null | undefined>,
): T | null {
    for (const key of preferredKeys) {
        const option = findOptionByKey(options, key);
        if (option) {
            return option;
        }
    }
    return null;
}

export function getDefaultModelKey(flavor: AgentFlavor): string {
    return getCodeAgentDefaults(flavor).modelMode;
}

export function getDefaultPermissionModeKey(flavor: AgentFlavor): string {
    return getCodeAgentDefaults(flavor).permissionMode;
}

// Effort levels per agent type

export function getClaudeEffortLevels(): EffortLevel[] {
    return [
        { key: 'low', name: 'low' },
        { key: 'medium', name: 'medium' },
        { key: 'high', name: 'high' },
        { key: 'xhigh', name: 'xhigh' },
        { key: 'max', name: 'max' },
    ];
}

export function getCodexEffortLevels(): EffortLevel[] {
    return [
        { key: 'low', name: 'low' },
        { key: 'medium', name: 'medium' },
        { key: 'high', name: 'high' },
        { key: 'xhigh', name: 'xhigh' },
    ];
}

export function getHardcodedEffortLevels(flavor: AgentFlavor): EffortLevel[] {
    if (flavor === 'claude') return getClaudeEffortLevels();
    if (flavor === 'codex') return getCodexEffortLevels();
    return [];
}

export function getDefaultEffortKey(flavor: AgentFlavor): string | null {
    return getCodeAgentDefaults(flavor).effortLevel;
}

// Per-model effort: returns effort levels for a specific model, or empty if the model has no effort
export function getEffortLevelsForModel(
    flavor: AgentFlavor,
    modelKey: string,
    metadata?: Metadata | null,
): EffortLevel[] {
    if (isRigMetadataV1(metadata)) {
        return getRigReasoningLevels(metadata, modelKey).map((level) => ({
            key: level,
            name: level,
        }));
    }
    const metadataLevels = mapMetadataOptions(metadata?.thoughtLevels);
    if (metadataLevels.length > 0) {
        return metadataLevels;
    }
    // Claude and Codex expose effort/thought levels regardless of which
    // specific model is picked — the same low/medium/high/max scale applies
    // to the whole flavor (mirrors how Codex already worked, which the user
    // asked Claude to match).
    if (flavor === 'claude') {
        return getClaudeEffortLevels();
    }
    if (flavor === 'codex') {
        return getCodexEffortLevels();
    }
    return [];
}

export function getRigCurrentModelOptionKey(metadata: Metadata | null | undefined): string | null {
    return getRigSelectedModelKey(metadata);
}

// Default effort for a model — highest the model allows
export function getDefaultEffortKeyForModel(flavor: AgentFlavor, modelKey: string): string | null {
    const levels = getEffortLevelsForModel(flavor, modelKey);
    if (levels.length === 0) return null;
    return getCodeAgentDefaults(flavor).effortLevel ?? levels[levels.length - 1].key;
}

export function getSupportsWorktree(flavor: AgentFlavor): boolean {
    if (flavor === 'openclaw') return false;
    return true;
}
