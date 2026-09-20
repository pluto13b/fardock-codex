import { Ionicons, Octicons } from '@expo/vector-icons';
import * as React from 'react';
import { Keyboard, View, Platform, useWindowDimensions, Text, ActivityIndicator } from 'react-native';
import { Image } from 'expo-image';
import { AgentInputAttachmentStrip } from './AgentInputAttachmentStrip';
import type { AttachmentPreview } from '@/sync/attachmentTypes';
import { generateThumbhash } from '@/utils/thumbhash';
import { layout } from './layout';
import { MultiTextInput, KeyPressEvent } from './MultiTextInput';
import { Typography } from '@/constants/Typography';
import { PermissionMode, ModelMode } from './PermissionModeSelector';
import { EffortLevel, presentEffortLevel } from './modelModeOptions';
import { hapticsLight, hapticsError } from './haptics';
import { Shaker, ShakeInstance } from './Shaker';
import { StatusDot } from './StatusDot';
import { useActiveWord } from './autocomplete/useActiveWord';
import { useActiveSuggestions } from './autocomplete/useActiveSuggestions';
import { AgentInputAutocomplete } from './AgentInputAutocomplete';
import { TextInputState, MultiTextInputHandle } from './MultiTextInput';
import { applySuggestion } from './autocomplete/applySuggestion';
import { GitStatusBadge, useHasMeaningfulGitStatus } from './GitStatusBadge';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useSetting } from '@/sync/storage';
import { hackMode, hackModes } from '@/sync/modeHacks';
import { Theme } from '@/theme';
import { getCurrentLanguage, t } from '@/text';
import { Metadata } from '@/sync/storageTypes';
import { isRunningOnMac } from '@/utils/platform';
import { MobileGlassSurface } from './MobileGlass';
import { AnimatedClickAwayBackdrop } from './AnimatedOverlay';
import { BubblePressable } from './BubblePressable';
import { resolveAgentInputPrimaryAction } from './agentInputPrimaryAction';
import { ComposerControlMenu, type ComposerControlMenuSection } from './ComposerControlMenu';
import { getComposerChoiceMenuWidth } from './composerControlMenuLayout';
import { isRigMetadata } from '@/sync/rig';
import {
    MOBILE_COMPOSER_LAYOUT,
    MOBILE_COMPOSER_METRICS,
    resolveMobileComposerActionGeometry,
    resolveMobileComposerActionRowGeometry,
} from './agentInputLayout';

interface AgentInputProps {
    // `initialValue` seeds the uncontrolled textarea once; keystrokes never
    // round-trip back into it via React, which is what keeps fast typing/
    // deletion crisp. The parent reads the live text via the imperative ref.
    initialValue: string;
    placeholder: string;
    // Fires on every keystroke so the parent can sync derived state (drafts,
    // hasText) — typically wrapped in startTransition / debounce by the caller.
    onChangeText?: (text: string) => void;
    sessionId?: string;
    onSend: () => void;
    sendIcon?: React.ReactNode;
    onMicPress?: () => void;
    isMicActive?: boolean;
    permissionMode?: PermissionMode | null;
    availableModes?: PermissionMode[];
    onPermissionModeChange?: (mode: PermissionMode) => void;
    modelMode?: ModelMode | null;
    availableModels?: ModelMode[];
    onModelModeChange?: (mode: ModelMode) => void;
    effortLevel?: EffortLevel | null;
    availableEffortLevels?: EffortLevel[];
    onEffortLevelChange?: (level: EffortLevel) => void;
    metadata?: Metadata | null;
    onAbort?: () => void | Promise<void>;
    showAbortButton?: boolean;
    connectionStatus?: {
        text: string;
        color: string;
        dotColor: string;
        isPulsing?: boolean;
        cliStatus?: {
            claude: boolean | null;
            codex: boolean | null;
            gemini?: boolean | null;
        };
    };
    autocompletePrefixes: string[];
    autocompleteSuggestions: (query: string) => Promise<{ key: string, text: string, component: React.ElementType }[]>;
    usageData?: {
        inputTokens: number;
        outputTokens: number;
        cacheCreation: number;
        cacheRead: number;
        contextSize: number;
        contextWindow?: number;
    };
    alwaysShowContextSize?: boolean;
    showSessionStatusInfoInSettings?: boolean;
    /** Hide the auxiliary connection/mode row while reading older messages. */
    showStatusDetails?: boolean;
    sessionStatusGitBranch?: string | null;
    sessionStatusModelLabel?: string | null;
    sessionStatusEffortLabel?: string | null;
    onFileViewerPress?: () => void;
    agentType?: 'claude' | 'codex' | 'gemini' | 'openclaw' | 'agy';
    onAgentClick?: () => void;
    machineName?: string | null;
    onMachineClick?: () => void;
    currentPath?: string | null;
    onPathClick?: () => void;
    blockSend?: boolean;
    isSendDisabled?: boolean;
    isSending?: boolean;
    minHeight?: number;
    zenMode?: boolean;
    /** Image attachments waiting to be sent (expImageUpload feature). */
    selectedImages?: AttachmentPreview[];
    onPickImages?: () => void;
    onRemoveImage?: (id: string) => void;
    onAddImages?: (images: AttachmentPreview[]) => void;
}

function permissionKindIcon(kind: string | null | undefined): React.ComponentProps<typeof Ionicons>['name'] {
    if (kind === 'read-only') return 'lock-closed-outline';
    if (kind === 'safe-yolo') return 'shield-checkmark-outline';
    if (kind === 'yolo' || kind === 'bypassPermissions') return 'warning-outline';
    return 'hand-left-outline';
}

const MOBILE_ACTION_ROW_GEOMETRY = resolveMobileComposerActionRowGeometry();
const MOBILE_ICON_ACTION_GEOMETRY = resolveMobileComposerActionGeometry('icon');
const MOBILE_PRIMARY_ACTION_GEOMETRY = resolveMobileComposerActionGeometry('primary');

const stylesheet = StyleSheet.create((theme, runtime) => ({
    container: {
        alignItems: 'center',
        paddingBottom: 8,
        paddingTop: 8,
    },
    innerContainer: {
        width: '100%',
        position: 'relative',
    },
    unifiedPanel: {
        backgroundColor: theme.colors.input.background,
        borderRadius: 16,
        overflow: 'hidden',
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.glass.border,
        paddingTop: 4,
        paddingBottom: 8,
        paddingHorizontal: 10,
    },
    unifiedPanelShadow: {
        borderRadius: 16,
        shadowColor: theme.colors.shadow.color,
        shadowOffset: { width: 0, height: 6 },
        shadowOpacity: 0.22,
        shadowRadius: 16,
        elevation: 4,
    },
    mobileUnifiedPanel: {
        // The frosted material is supplied by MobileGlassSurface. The dense
        // tint keeps the transcript illegible behind it without losing glass.
        backgroundColor: Platform.select({
            ios: 'transparent',
            android: theme.colors.glass.backgroundStrong,
            default: theme.colors.input.background,
        }),
        borderRadius: MOBILE_COMPOSER_METRICS.shellRadius,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.glass.border,
        paddingHorizontal: MOBILE_COMPOSER_METRICS.shellInset,
        paddingTop: MOBILE_COMPOSER_METRICS.shellPaddingTop,
        paddingBottom: MOBILE_COMPOSER_METRICS.shellPaddingBottom,
    },
    mobileUnifiedPanelShadow: {
        borderRadius: MOBILE_COMPOSER_METRICS.shellRadius,
    },
    inputContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        borderWidth: 0,
        paddingLeft: 2,
        paddingRight: 8,
        paddingVertical: 4,
        minHeight: 40,
    },
    mobileInputContainer: {
        alignItems: 'center',
        // Keep a one-line composer compact while aligning its caret with the
        // add glyph below. The previous 60pt slot left a full blank line below
        // an empty input on phones.
        minHeight: MOBILE_COMPOSER_METRICS.inputMinHeight,
        // 18pt from the outer edge: 10pt shell inset plus the 8pt inset from
        // the add button edge to the 26pt glyph.
        paddingLeft: MOBILE_COMPOSER_LAYOUT.inputContainerPaddingLeft,
        paddingRight: MOBILE_COMPOSER_LAYOUT.inputContainerPaddingRight,
        paddingTop: MOBILE_COMPOSER_METRICS.inputPaddingTop,
        paddingBottom: MOBILE_COMPOSER_METRICS.inputPaddingBottom,
    },

    // Overlay styles
    autocompleteOverlay: {
        position: 'absolute',
        bottom: '100%',
        left: 0,
        right: 0,
        marginBottom: 8,
        zIndex: 1000,
    },
    settingsOverlay: {
        position: 'absolute',
        bottom: '100%',
        left: 0,
        right: 0,
        marginBottom: 12,
        zIndex: 1000,
    },
    overlayBackdrop: {
        // Negative extents make Web include the click-away layer in document
        // overflow; closing a menu can then leave the whole chat horizontally
        // shifted. A fixed viewport layer has the same click-away semantics
        // without changing scroll geometry.
        position: Platform.OS === 'web' ? ('fixed' as any) : 'absolute',
        top: Platform.OS === 'web' ? 0 : -1000,
        left: Platform.OS === 'web' ? 0 : -1000,
        right: Platform.OS === 'web' ? 0 : -1000,
        bottom: Platform.OS === 'web' ? 0 : -1000,
        zIndex: 999,
    },
    overlaySection: {
        paddingVertical: 8,
    },
    settingsStatusInfo: {
        paddingTop: 6,
        paddingBottom: 4,
        paddingHorizontal: 8,
    },
    overlaySectionTitle: {
        fontSize: 12,
        fontWeight: '600',
        color: theme.colors.textSecondary,
        paddingHorizontal: 16,
        paddingBottom: 4,
        ...Typography.default('semiBold'),
    },
    overlayDivider: {
        height: 1,
        backgroundColor: theme.colors.glass.divider,
        marginHorizontal: 16,
    },

    // Selection styles
    selectionItem: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 8,
        backgroundColor: 'transparent',
    },
    selectionItemPressed: {
        backgroundColor: theme.colors.surfacePressed,
    },
    radioButton: {
        width: 16,
        height: 16,
        borderRadius: 8,
        borderWidth: 2,
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: 12,
    },
    radioButtonActive: {
        borderColor: theme.colors.radio.active,
    },
    radioButtonInactive: {
        borderColor: theme.colors.radio.inactive,
    },
    radioButtonDot: {
        width: 6,
        height: 6,
        borderRadius: 3,
        backgroundColor: theme.colors.radio.dot,
    },
    selectionLabel: {
        fontSize: 14,
        ...Typography.default(),
    },
    selectionLabelActive: {
        color: theme.colors.radio.active,
    },
    selectionLabelInactive: {
        color: theme.colors.text,
    },

    // Status styles
    statusContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 16,
        paddingBottom: 4,
    },
    statusRow: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    statusText: {
        fontSize: 11,
        ...Typography.default(),
    },
    permissionModeContainer: {
        flexDirection: 'column',
        alignItems: 'flex-end',
    },
    permissionModeText: {
        fontSize: 11,
        ...Typography.default(),
    },
    contextWarningText: {
        fontSize: 11,
        marginLeft: 8,
        ...Typography.default(),
    },

    // Button styles
    actionButtonsContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 0,
    },
    mobileActionButtonsContainer: MOBILE_ACTION_ROW_GEOMETRY,
    mobileIconButton: MOBILE_ICON_ACTION_GEOMETRY,
    mobileModeButton: {
        flexShrink: 1,
        minWidth: 0,
        maxWidth: 148,
        height: MOBILE_COMPOSER_METRICS.secondaryActionHeight,
        borderRadius: MOBILE_COMPOSER_METRICS.secondaryActionHeight / 2,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-end',
        paddingHorizontal: 9,
        gap: 5,
    },
    mobileEffortButton: {
        minWidth: 54,
        maxWidth: 72,
        flexShrink: 0,
        height: MOBILE_COMPOSER_METRICS.secondaryActionHeight,
        borderRadius: MOBILE_COMPOSER_METRICS.secondaryActionHeight / 2,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-start',
        paddingHorizontal: 8,
        gap: 4,
    },
    mobilePermissionButton: {
        flexShrink: 0,
        minWidth: 98,
        maxWidth: 132,
        height: MOBILE_COMPOSER_METRICS.secondaryActionHeight,
        borderRadius: MOBILE_COMPOSER_METRICS.secondaryActionHeight / 2,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-start',
        paddingHorizontal: 9,
        gap: 6,
    },
    mobileControlActive: {
        backgroundColor: theme.colors.glass.backgroundSubtle,
    },
    mobileControlText: {
        minWidth: 0,
        flexShrink: 1,
        color: theme.colors.text,
        fontSize: 14,
        ...Typography.default(),
    },
    mobileModeText: {
        flexShrink: 1,
        minWidth: 0,
        fontSize: 14,
        color: theme.colors.text,
        ...Typography.default(),
    },
    mobileModeSeparator: {
        flexShrink: 0,
        color: theme.colors.textSecondary,
        fontSize: 14,
        ...Typography.default(),
    },
    actionButtonsLeft: {
        flexDirection: 'row',
        gap: 8,
        flex: 1,
        overflow: 'hidden',
    },
    actionButton: {
        flexDirection: 'row',
        alignItems: 'center',
        borderRadius: Platform.select({ default: 16, android: 20 }),
        paddingHorizontal: 8,
        paddingVertical: 6,
        justifyContent: 'center',
        height: 32,
    },
    actionButtonPressed: {
        opacity: 0.7,
    },
    actionButtonIcon: {
        color: theme.colors.button.secondary.tint,
    },
    sendButton: {
        width: 32,
        height: 32,
        borderRadius: 16,
        justifyContent: 'center',
        alignItems: 'center',
        flexShrink: 0,
        marginLeft: 8,
    },
    mobilePrimaryButton: MOBILE_PRIMARY_ACTION_GEOMETRY,
    mobilePrimaryButtonActive: {
        backgroundColor: theme.colors.surfaceHighest,
    },
    mobilePrimaryButtonInactive: {
        backgroundColor: theme.dark ? '#3A3A3C' : '#D1D1D6',
    },
    mobileStopButton: {
        backgroundColor: theme.dark ? '#F5F5F5' : theme.colors.button.primary.background,
    },
    sendButtonActive: {
        backgroundColor: theme.colors.button.primary.background,
    },
    sendButtonInactive: {
        backgroundColor: theme.colors.button.primary.disabled,
    },
    sendButtonLocked: {
        backgroundColor: theme.colors.surfaceHigh,
        borderWidth: 1,
        borderColor: theme.colors.divider,
    },
    sendButtonInner: {
        width: '100%',
        height: '100%',
        alignItems: 'center',
        justifyContent: 'center',
    },
    sendButtonInnerPressed: {
        opacity: 0.7,
    },
    sendButtonIcon: {
        color: theme.colors.button.primary.tint,
    },
}));

const getContextWarning = (contextSize: number, alwaysShow: boolean = false, theme: Theme, contextWindow?: number) => {
    // Until the session reports its window there is no honest denominator, so
    // nothing is shown rather than dividing by a guess — a percentage that
    // later corrects itself upward reads as the context refilling.
    if (typeof contextWindow !== 'number' || !Number.isFinite(contextWindow) || contextWindow <= 0) {
        return null;
    }
    const maxContextSize = contextWindow;
    const percentageUsed = (contextSize / maxContextSize) * 100;
    const percentageRemaining = Math.max(0, Math.min(100, 100 - percentageUsed));

    if (percentageRemaining <= 5) {
        return { text: t('agentInput.context.remaining', { percent: Math.round(percentageRemaining) }), color: theme.colors.warningCritical };
    } else if (percentageRemaining <= 10) {
        return { text: t('agentInput.context.remaining', { percent: Math.round(percentageRemaining) }), color: theme.colors.warning };
    } else if (alwaysShow) {
        // Show context remaining in neutral color when not near limit
        return { text: t('agentInput.context.remaining', { percent: Math.round(percentageRemaining) }), color: theme.colors.warning };
    }
    return null; // No display needed
};

// Stable sub-trees extracted from AgentInput so they don't reconcile when
// the input's keystroke-derived state (hasText / inputState) flips. Their
// props are derived from session metadata, not from the textarea content,
// so memo skips re-render on typing entirely.

type StatusRowProps = {
    connectionStatus?: AgentInputProps['connectionStatus'];
    contextWarning: { text: string; color: string } | null;
};

const AgentInputStatusRow = React.memo(function AgentInputStatusRow(p: StatusRowProps) {
    const { theme } = useUnistyles();
    if (!p.connectionStatus && !p.contextWarning) {
        return null;
    }
    return (
        <View style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingHorizontal: 16,
            paddingBottom: 4,
            minHeight: 20,
        }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1, gap: 11 }}>
                {p.connectionStatus && (
                    <>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                            <StatusDot
                                color={p.connectionStatus.dotColor}
                                isPulsing={p.connectionStatus.isPulsing}
                                size={6}
                            />
                            <Text style={{
                                fontSize: 11,
                                color: p.connectionStatus.color,
                                ...Typography.default()
                            }}>
                                {p.connectionStatus.text}
                            </Text>
                        </View>
                        {p.connectionStatus.cliStatus && (
                            <>
                                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                                    <Text style={{
                                        fontSize: 11,
                                        color: p.connectionStatus.cliStatus.claude ? theme.colors.success : theme.colors.textDestructive,
                                        ...Typography.default()
                                    }}>
                                        {p.connectionStatus.cliStatus.claude ? '✓' : '✗'}
                                    </Text>
                                    <Text style={{
                                        fontSize: 11,
                                        color: p.connectionStatus.cliStatus.claude ? theme.colors.success : theme.colors.textDestructive,
                                        ...Typography.default()
                                    }}>
                                        claude
                                    </Text>
                                </View>
                                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                                    <Text style={{
                                        fontSize: 11,
                                        color: p.connectionStatus.cliStatus.codex ? theme.colors.success : theme.colors.textDestructive,
                                        ...Typography.default()
                                    }}>
                                        {p.connectionStatus.cliStatus.codex ? '✓' : '✗'}
                                    </Text>
                                    <Text style={{
                                        fontSize: 11,
                                        color: p.connectionStatus.cliStatus.codex ? theme.colors.success : theme.colors.textDestructive,
                                        ...Typography.default()
                                    }}>
                                        codex
                                    </Text>
                                </View>
                                {p.connectionStatus.cliStatus.gemini !== undefined && (
                                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                                        <Text style={{
                                            fontSize: 11,
                                            color: p.connectionStatus.cliStatus.gemini ? theme.colors.success : theme.colors.textDestructive,
                                            ...Typography.default()
                                        }}>
                                            {p.connectionStatus.cliStatus.gemini ? '✓' : '✗'}
                                        </Text>
                                        <Text style={{
                                            fontSize: 11,
                                            color: p.connectionStatus.cliStatus.gemini ? theme.colors.success : theme.colors.textDestructive,
                                            ...Typography.default()
                                        }}>
                                            gemini
                                        </Text>
                                    </View>
                                )}
                            </>
                        )}
                    </>
                )}
                {p.contextWarning && (
                    <Text style={{
                        fontSize: 11,
                        color: p.contextWarning.color,
                        marginLeft: p.connectionStatus ? 8 : 0,
                        ...Typography.default()
                    }}>
                        {p.connectionStatus ? '• ' : ''}{p.contextWarning.text}
                    </Text>
                )}
            </View>
        </View>
    );
});

type ContextChipsProps = {
    machineName?: string | null;
    onMachineClick?: () => void;
    currentPath?: string | null;
    onPathClick?: () => void;
};

const AgentInputContextChips = React.memo(function AgentInputContextChips(p: ContextChipsProps) {
    const { theme } = useUnistyles();
    if (p.machineName === undefined && !p.currentPath) {
        return null;
    }
    return (
        <View style={{
            backgroundColor: theme.colors.surfacePressed,
            borderRadius: 12,
            padding: 8,
            marginBottom: 8,
            gap: 4,
        }}>
            {p.machineName !== undefined && p.onMachineClick && (
                <BubblePressable
                    onPress={() => {
                        hapticsLight();
                        p.onMachineClick?.();
                    }}
                    hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                    style={(s) => ({
                        flexDirection: 'row',
                        alignItems: 'center',
                        borderRadius: Platform.select({ default: 16, android: 20 }),
                        paddingHorizontal: 10,
                        paddingVertical: 6,
                        height: 32,
                        opacity: s.pressed ? 0.7 : 1,
                        gap: 6,
                    })}
                >
                    <Ionicons name="desktop-outline" size={14} color={theme.colors.textSecondary} />
                    <Text style={{
                        fontSize: 13,
                        color: theme.colors.text,
                        fontWeight: '600',
                        ...Typography.default('semiBold'),
                    }}>
                        {p.machineName === null ? t('agentInput.noMachinesAvailable') : p.machineName}
                    </Text>
                </BubblePressable>
            )}
            {p.currentPath && p.onPathClick && (
                <BubblePressable
                    onPress={() => {
                        hapticsLight();
                        p.onPathClick?.();
                    }}
                    hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                    style={(s) => ({
                        flexDirection: 'row',
                        alignItems: 'center',
                        borderRadius: Platform.select({ default: 16, android: 20 }),
                        paddingHorizontal: 10,
                        paddingVertical: 6,
                        height: 32,
                        opacity: s.pressed ? 0.7 : 1,
                        gap: 6,
                    })}
                >
                    <Ionicons name="folder-outline" size={14} color={theme.colors.textSecondary} />
                    <Text style={{
                        fontSize: 13,
                        color: theme.colors.text,
                        fontWeight: '600',
                        ...Typography.default('semiBold'),
                    }}>
                        {p.currentPath}
                    </Text>
                </BubblePressable>
            )}
        </View>
    );
});

export const AgentInput = React.memo(React.forwardRef<MultiTextInputHandle, AgentInputProps>((props, ref) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const screenWidth = useWindowDimensions().width;
    // Phone browsers are a primary client, so narrow Web and Android/iOS share
    // the same compact composer. Platform checks below remain only for APIs
    // such as drag/drop and the native keyboard.
    const runningOnMac = isRunningOnMac();
    const compactMobileComposer = !runningOnMac && screenWidth <= 900;
    const activeSendIconColor = compactMobileComposer ? theme.colors.text : theme.colors.button.primary.tint;
    const isSendBlocked = props.blockSend ?? false;

    // `hasText` drives only the send-button appearance/enabled state. It's
    // updated via startTransition from the keystroke handler so a busy reducer
    // never blocks the next character from landing in the textarea.
    const [hasText, setHasText] = React.useState(() => props.initialValue.trim().length > 0);
    const hasImages = (props.selectedImages?.length ?? 0) > 0;
    const hasComposerContent = hasText || hasImages;

    // Check if this is a Codex, Gemini, or OpenClaw session
    // Use metadata.flavor for existing sessions, agentType prop for new sessions
    const isRig = isRigMetadata(props.metadata);
    const isCodex = !isRig && (props.metadata?.flavor === 'codex' || props.agentType === 'codex');
    const isGemini = props.metadata?.flavor === 'gemini' || props.agentType === 'gemini';
    const isOpenClaw = props.metadata?.flavor === 'openclaw' || props.agentType === 'openclaw';
    const displayPermissionMode = React.useMemo(() => (
        props.permissionMode ? hackMode(props.permissionMode) : null
    ), [props.permissionMode]);
    const permissionModeKey = displayPermissionMode?.key ?? 'default';
    const availableModes = React.useMemo(() => (
        hackModes(props.availableModes ?? [])
    ), [props.availableModes]);
    const availableModels = props.availableModels ?? [];
    const currentLanguage = getCurrentLanguage();
    const availableEffortLevels = React.useMemo(
        () => (props.availableEffortLevels ?? []).map((level) => presentEffortLevel(level, currentLanguage)),
        [currentLanguage, props.availableEffortLevels],
    );
    const modelLabel = props.modelMode?.name ?? t('agentInput.model.title');
    const effortLabel = props.effortLevel
        ? presentEffortLevel(props.effortLevel, currentLanguage).name
        : undefined;
    const canOpenModelPicker = availableModels.length > 0 && !!props.onModelModeChange;
    const canOpenEffortPicker = availableEffortLevels.length > 0 && !!props.onEffortLevelChange;
    const isSandboxEnabled = React.useMemo(() => {
        const sandbox = props.metadata?.sandbox as unknown;
        if (!sandbox) {
            return false;
        }
        if (typeof sandbox === 'object' && sandbox !== null && 'enabled' in sandbox) {
            return Boolean((sandbox as { enabled?: unknown }).enabled);
        }
        return true;
    }, [props.metadata?.sandbox]);
    const isSandboxedYoloMode = isSandboxEnabled && (
        permissionModeKey === 'bypassPermissions' || permissionModeKey === 'yolo'
    );

    const withSandboxSuffix = React.useCallback((label: string, modeKey?: string) => {
        if (!isSandboxEnabled) {
            return label;
        }
        if (modeKey === 'bypassPermissions' || modeKey === 'yolo') {
            return `${label} (sandboxed)`;
        }
        return label;
    }, [isSandboxEnabled]);

    // Calculate context warning
    const contextWarning = props.usageData?.contextSize
        ? getContextWarning(props.usageData.contextSize, props.alwaysShowContextSize ?? false, theme, props.usageData.contextWindow)
        : null;

    const agentInputEnterToSend = useSetting('agentInputEnterToSend');


    // Abort button state
    const [isAborting, setIsAborting] = React.useState(false);
    const [stopRequested, setStopRequested] = React.useState(false);
    const shakerRef = React.useRef<ShakeInstance>(null);
    const sendBlockShakerRef = React.useRef<ShakeInstance>(null);
    const inputRef = React.useRef<MultiTextInputHandle>(null);
    const primaryAction = resolveAgentInputPrimaryAction({
        hasComposerContent,
        isSendBlocked,
        isSendDisabled: props.isSendDisabled ?? false,
        showAbortButton: props.showAbortButton ?? false,
        canAbort: !!props.onAbort && !stopRequested,
        // Only the mobile composer folds the mic into the primary button; the
        // desktop layout keeps its own send/mic resolution below. A live voice
        // session stays in this state so the same button can end it.
        canVoice: compactMobileComposer && !!props.onMicPress,
    });
    const shouldShowStopButton = primaryAction === 'stop';
    const shouldShowVoiceButton = primaryAction === 'voice';
    const canSendMessage = primaryAction === 'send';
    const mobileCanPressSendButton = !isAborting && primaryAction !== 'idle';
    const canPressSendButton = mobileCanPressSendButton;

    // A local acknowledgement avoids leaving Stop visible forever when the
    // session-status update arrives after the abort RPC has completed. The next
    // agent turn, or the eventual idle update, makes Stop eligible again.
    React.useEffect(() => {
        if (!props.showAbortButton) {
            setStopRequested(false);
        }
    }, [props.showAbortButton]);

    // Forward ref to the MultiTextInput
    React.useImperativeHandle(ref, () => inputRef.current!, []);

    // Web paste/drag — intercept image pastes and file drops for the
    // attachment feature. Both handlers funnel through props.onAddImages.
    React.useEffect(() => {
        if (Platform.OS !== 'web' || !props.onAddImages) return;

        const handlePaste = async (e: ClipboardEvent) => {
            // Only handle pastes targeted at a focused text-editable element.
            // The listener is attached to document, so without this guard a
            // paste in the URL bar, another modal, or any focused-elsewhere
            // input would steal images intended for somewhere else.
            const active = document.activeElement;
            const isEditableTarget = active instanceof HTMLInputElement
                || active instanceof HTMLTextAreaElement
                || (active instanceof HTMLElement && active.isContentEditable);
            if (!isEditableTarget) return;

            const { getImagesFromClipboard, fileToAttachmentPreview } = await import('@/utils/pasteImages.web');
            const files = getImagesFromClipboard(e);
            if (!files.length) return;
            e.preventDefault();
            const previews = (await Promise.all(
                files.map((f) => fileToAttachmentPreview(f, generateThumbhash))
            )).filter(Boolean) as Omit<AttachmentPreview, 'id'>[];
            if (previews.length) {
                props.onAddImages!(previews.map((p) => ({
                    ...p,
                    id: `paste_${Date.now()}_${Math.random().toString(36).slice(2)}`,
                })));
            }
        };

        // dragover must call preventDefault for drop to fire; we gate on
        // `types.includes('Files')` so we don't hijack drag-text/HTML in the
        // rest of the app.
        const isFileDrag = (e: DragEvent) => {
            const types = e.dataTransfer?.types;
            if (!types) return false;
            // DataTransferItemList vs DOMStringList — both expose .includes-ish.
            for (let i = 0; i < types.length; i++) {
                if (types[i] === 'Files') return true;
            }
            return false;
        };

        const handleDragOver = (e: DragEvent) => {
            if (!isFileDrag(e)) return;
            e.preventDefault();
            if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
        };

        const handleDrop = async (e: DragEvent) => {
            if (!isFileDrag(e)) return;
            e.preventDefault();
            const { getImagesFromDrop, fileToAttachmentPreview } = await import('@/utils/pasteImages.web');
            const files = getImagesFromDrop(e);
            if (!files.length) return;
            const previews = (await Promise.all(
                files.map((f) => fileToAttachmentPreview(f, generateThumbhash))
            )).filter(Boolean) as Omit<AttachmentPreview, 'id'>[];
            if (previews.length) {
                props.onAddImages!(previews.map((p) => ({
                    ...p,
                    id: `drop_${Date.now()}_${Math.random().toString(36).slice(2)}`,
                })));
            }
        };

        document.addEventListener('paste', handlePaste as any);
        document.addEventListener('dragover', handleDragOver);
        document.addEventListener('drop', handleDrop);
        return () => {
            document.removeEventListener('paste', handlePaste as any);
            document.removeEventListener('dragover', handleDragOver);
            document.removeEventListener('drop', handleDrop);
        };
    }, [props.onAddImages]);

    // Autocomplete state — text + selection. Updated via startTransition so
    // typing renders the character immediately and the autocomplete pipeline
    // catches up on the next idle frame instead of blocking input.
    const [inputState, setInputState] = React.useState<TextInputState>(() => ({
        text: props.initialValue,
        selection: { start: props.initialValue.length, end: props.initialValue.length }
    }));

    const onChangeTextProp = props.onChangeText;
    const handleTextChange = React.useCallback((text: string) => {
        React.startTransition(() => {
            setHasText(text.trim().length > 0);
        });
        onChangeTextProp?.(text);
    }, [onChangeTextProp]);

    const handleInputStateChange = React.useCallback((newState: TextInputState) => {
        React.startTransition(() => {
            setInputState(newState);
        });
    }, []);

    // Use the tracked selection from inputState
    const activeWord = useActiveWord(inputState.text, inputState.selection, props.autocompletePrefixes);
    // Using default options: clampSelection=true, autoSelectFirst=true, wrapAround=true
    // To customize: useActiveSuggestions(activeWord, props.autocompleteSuggestions, { clampSelection: false, wrapAround: false })
    const [suggestions, selected, moveUp, moveDown] = useActiveSuggestions(activeWord, props.autocompleteSuggestions, { clampSelection: true, wrapAround: true });

    // Debug logging
    // React.useEffect(() => {
    //     console.log('🔍 Autocomplete Debug:', JSON.stringify({
    //         value: props.value,
    //         inputState,
    //         activeWord,
    //         suggestionsCount: suggestions.length,
    //         selected,
    //         prefixes: props.autocompletePrefixes
    //     }, null, 2));
    // }, [props.value, inputState, activeWord, suggestions.length, selected]);

    // Handle suggestion selection
    const handleSuggestionSelect = React.useCallback((index: number) => {
        if (!suggestions[index] || !inputRef.current) return;

        const suggestion = suggestions[index];

        // Apply the suggestion
        const result = applySuggestion(
            inputState.text,
            inputState.selection,
            suggestion.text,
            props.autocompletePrefixes,
            true // add space after
        );

        // Use imperative API to set text and selection
        inputRef.current.setTextAndSelection(result.text, {
            start: result.cursorPosition,
            end: result.cursorPosition
        });

        // console.log('Selected suggestion:', suggestion.text);

        // Small haptic feedback
        hapticsLight();
    }, [suggestions, inputState, props.autocompletePrefixes]);

    // The compact composer has separate controls for permission, model, and
    // effort. Keep a single popup state so only one selection surface is ever
    // visible, including while we dismiss the keyboard on mobile.
    type ComposerPicker = 'add' | 'permission' | 'model' | 'effort';
    const [openPicker, setOpenPicker] = React.useState<ComposerPicker | null>(null);
    const pickerOpeningRef = React.useRef<ComposerPicker | null>(null);
    const pickerKeyboardSubscriptionRef = React.useRef<ReturnType<typeof Keyboard.addListener> | null>(null);
    const pickerOpenTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const pickerSelectionTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

    const cancelPendingPickerOpen = React.useCallback(() => {
        pickerOpeningRef.current = null;
        pickerKeyboardSubscriptionRef.current?.remove();
        pickerKeyboardSubscriptionRef.current = null;
        if (pickerOpenTimerRef.current) {
            clearTimeout(pickerOpenTimerRef.current);
            pickerOpenTimerRef.current = null;
        }
        if (pickerSelectionTimerRef.current) {
            clearTimeout(pickerSelectionTimerRef.current);
            pickerSelectionTimerRef.current = null;
        }
    }, []);

    const closePicker = React.useCallback(() => {
        cancelPendingPickerOpen();
        setOpenPicker(null);
    }, [cancelPendingPickerOpen]);

    React.useEffect(() => cancelPendingPickerOpen, [cancelPendingPickerOpen]);

    const closePickerAfterSelection = React.useCallback(() => {
        if (pickerSelectionTimerRef.current) {
            clearTimeout(pickerSelectionTimerRef.current);
        }
        pickerSelectionTimerRef.current = setTimeout(() => {
            pickerSelectionTimerRef.current = null;
            closePicker();
        }, 170);
    }, [closePicker]);

    const handlePickerPress = React.useCallback((picker: ComposerPicker) => {
        hapticsLight();
        if (openPicker === picker || pickerOpeningRef.current === picker) {
            closePicker();
            return;
        }

        closePicker();
        if (Platform.OS === 'web') {
            // Android Chrome is still the Web build. Explicitly release the
            // textarea so its virtual keyboard cannot cover the menu.
            inputRef.current?.blur();
            setOpenPicker(picker);
            return;
        }
        if (!Keyboard.isVisible()) {
            setOpenPicker(picker);
            return;
        }

        pickerOpeningRef.current = picker;
        const finishOpening = () => {
            const pickerToOpen = pickerOpeningRef.current;
            cancelPendingPickerOpen();
            if (pickerToOpen) {
                setOpenPicker(pickerToOpen);
            }
        };
        pickerKeyboardSubscriptionRef.current = Keyboard.addListener('keyboardDidHide', finishOpening);
        pickerOpenTimerRef.current = setTimeout(finishOpening, 420);
        inputRef.current?.blur();
        Keyboard.dismiss();
    }, [cancelPendingPickerOpen, closePicker, openPicker]);

    const handleSettingsPress = React.useCallback(() => {
        handlePickerPress('permission');
    }, [handlePickerPress]);

    const handleModelPress = React.useCallback(() => {
        if (!canOpenModelPicker) return;
        handlePickerPress('model');
    }, [canOpenModelPicker, handlePickerPress]);

    const handleEffortPress = React.useCallback(() => {
        if (!canOpenEffortPicker) return;
        handlePickerPress('effort');
    }, [canOpenEffortPicker, handlePickerPress]);

    // Handle settings selection
    const handleSettingsSelect = React.useCallback((mode: PermissionMode) => {
        hapticsLight();
        props.onPermissionModeChange?.(mode);
        closePickerAfterSelection();
    }, [closePickerAfterSelection, props.onPermissionModeChange]);

    // Handle abort button press
    const handleAbortPress = React.useCallback(async () => {
        if (!props.onAbort) return;

        hapticsError();
        setStopRequested(true);
        setIsAborting(true);
        const startTime = Date.now();

        try {
            await props.onAbort?.();

            // Ensure minimum 300ms loading time
            const elapsed = Date.now() - startTime;
            if (elapsed < 300) {
                await new Promise(resolve => setTimeout(resolve, 300 - elapsed));
            }
        } catch (error) {
            // Shake on error
            setStopRequested(false);
            shakerRef.current?.shake();
            console.error('Abort RPC call failed:', error);
        } finally {
            setIsAborting(false);
        }
    }, [props.onAbort]);

    const handleBlockedSendAttempt = React.useCallback(() => {
        if (!isSendBlocked || !hasText || props.isSending) return;
        hapticsError();
        sendBlockShakerRef.current?.shake();
    }, [hasText, isSendBlocked, props.isSending]);

    const handleSendPress = React.useCallback(() => {
        if (isSendBlocked) {
            handleBlockedSendAttempt();
            return;
        }
        if (props.isSendDisabled) return;

        hapticsLight();
        // Live read avoids stalling behind the transitioned `hasText`.
        const liveHasText = (inputRef.current?.getText() ?? '').trim().length > 0;
        if (liveHasText || hasImages) {
            setStopRequested(false);
            props.onSend();
        } else if (!compactMobileComposer) {
            props.onMicPress?.();
        }
    }, [compactMobileComposer, handleBlockedSendAttempt, hasImages, isSendBlocked, props.isSendDisabled, props.onMicPress, props.onSend]);

    const handleMicrophonePress = React.useCallback(() => {
        if (!props.onMicPress || props.isSendDisabled) return;
        hapticsLight();
        props.onMicPress();
    }, [props.isSendDisabled, props.onMicPress]);

    // Stop, voice and send share one button, so which one fires is resolved from
    // the live text rather than from `hasText`, which is set in a transition and
    // lags a fast type-then-tap. Without the live read that tap would abort the
    // agent or open dictation instead of sending what was just typed.
    const handleMobilePrimaryPress = React.useCallback(() => {
        const liveHasContent = (inputRef.current?.getText() ?? '').trim().length > 0 || hasImages;
        if (!liveHasContent && shouldShowStopButton) {
            handleAbortPress();
            return;
        }
        if (!liveHasContent && shouldShowVoiceButton) {
            handleMicrophonePress();
            return;
        }
        handleSendPress();
    }, [
        handleAbortPress,
        handleMicrophonePress,
        handleSendPress,
        hasImages,
        shouldShowStopButton,
        shouldShowVoiceButton,
    ]);

    const addMenuSections = React.useMemo<ComposerControlMenuSection[]>(() => [{
        key: 'add',
        label: '添加',
        items: [{
            key: 'files',
            label: t('settingsFeatures.imageUpload'),
            description: props.onPickImages
                ? t('settingsFeatures.imageUploadSubtitle')
                : t('imageUpload.notSupportedMessage'),
            icon: 'attach-outline',
            disabled: !props.onPickImages,
            onPress: props.onPickImages ? () => {
                closePicker();
                props.onPickImages?.();
            } : undefined,
        }],
    }], [closePicker, props.onPickImages]);

    const permissionMenuSections = React.useMemo<ComposerControlMenuSection[]>(() => [{
        key: 'permission',
        label: isCodex
            ? t('agentInput.codexPermissionMode.title')
            : isGemini
                ? t('agentInput.geminiPermissionMode.title')
                : t('agentInput.permissionMode.title'),
        items: availableModes.map((mode) => ({
            key: mode.key,
            label: withSandboxSuffix(mode.name, mode.key),
            description: mode.description,
            icon: permissionKindIcon(mode.semanticKind ?? mode.key),
            selected: permissionModeKey === mode.key,
            disabled: !props.onPermissionModeChange || mode.disabled,
            tone: mode.key === 'yolo' || mode.key === 'bypassPermissions' ? 'warning' : 'default',
            onPress: props.onPermissionModeChange && !mode.disabled
                ? () => handleSettingsSelect(mode)
                : undefined,
        })),
    }], [availableModes, handleSettingsSelect, isCodex, isGemini, permissionModeKey, props.onPermissionModeChange, withSandboxSuffix]);

    const modelMenuSections = React.useMemo<ComposerControlMenuSection[]>(() => [{
        key: 'model',
        items: availableModels.length > 0 ? availableModels.map((model) => ({
            key: model.key,
            label: model.name,
            description: model.description ?? model.providerName ?? null,
            selected: props.modelMode?.key === model.key,
            disabled: !props.onModelModeChange || model.disabled,
            onPress: props.onModelModeChange && !model.disabled ? () => {
                hapticsLight();
                props.onModelModeChange?.(model);
                closePickerAfterSelection();
            } : undefined,
        })) : [{
            key: 'unavailable',
            label: t('agentInput.model.configureInCli'),
            disabled: true,
        }],
    }], [availableModels, closePickerAfterSelection, props.modelMode?.key, props.onModelModeChange]);

    const effortMenuSections = React.useMemo<ComposerControlMenuSection[]>(() => [{
        key: 'effort',
        label: t('agentInput.effort.title'),
        items: availableEffortLevels.map((level) => ({
            key: level.key,
            label: level.name,
            description: level.description,
            selected: props.effortLevel?.key === level.key,
            disabled: !props.onEffortLevelChange || level.disabled,
            onPress: props.onEffortLevelChange && !level.disabled ? () => {
                hapticsLight();
                props.onEffortLevelChange?.(level);
                closePickerAfterSelection();
            } : undefined,
        })),
    }], [availableEffortLevels, closePickerAfterSelection, props.effortLevel?.key, props.onEffortLevelChange]);

    const activeMenuSections = openPicker === 'add'
        ? addMenuSections
        : openPicker === 'permission'
            ? permissionMenuSections
            : openPicker === 'model'
                ? modelMenuSections
                : effortMenuSections;

    const renderModelValue = () => (
        <>
            <Text style={styles.mobileModeText} numberOfLines={1}>{modelLabel}</Text>
            {screenWidth > 380 ? (
                <Ionicons name="chevron-down" size={13} color={theme.colors.textSecondary} />
            ) : null}
        </>
    );

    const renderEffortValue = () => (
        <>
            <Text style={styles.mobileModeText} numberOfLines={1}>
                {effortLabel ?? t('agentInput.effort.title')}
            </Text>
            {screenWidth > 380 ? (
                <Ionicons name="chevron-down" size={13} color={theme.colors.textSecondary} />
            ) : null}
        </>
    );

    // Handle keyboard navigation
    const handleKeyPress = React.useCallback((event: KeyPressEvent): boolean => {
        // Handle autocomplete navigation first
        if (suggestions.length > 0) {
            if (event.key === 'ArrowUp') {
                moveUp();
                return true;
            } else if (event.key === 'ArrowDown') {
                moveDown();
                return true;
            } else if ((event.key === 'Enter' || (event.key === 'Tab' && !event.shiftKey))) {
                // Both Enter and Tab select the current suggestion
                // If none selected (selected === -1), select the first one
                const indexToSelect = selected >= 0 ? selected : 0;
                handleSuggestionSelect(indexToSelect);
                return true;
            } else if (event.key === 'Escape') {
                // Clear suggestions by collapsing selection (triggers activeWord to clear)
                if (inputRef.current) {
                    const cursorPos = inputState.selection.start;
                    inputRef.current.setTextAndSelection(inputState.text, {
                        start: cursorPos,
                        end: cursorPos
                    });
                }
                return true;
            }
        }

        // Handle Escape for abort when no suggestions are visible
        if (event.key === 'Escape' && props.showAbortButton && props.onAbort && !isAborting) {
            handleAbortPress();
            return true;
        }

        // Original key handling
        if (Platform.OS === 'web') {
            // On mobile web (touch devices), Enter should insert a newline since
            // there's no Shift key available. Users send via the send button instead.
            // Use pointer:coarse media query instead of ontouchstart/maxTouchPoints
            // to avoid false positives on Windows touch-screen laptops with keyboards.
            const isTouchDevice = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;
            if (agentInputEnterToSend && event.key === 'Enter' && !event.shiftKey && !isTouchDevice) {
                // Read live text from the textarea — `hasText` is debounced via
                // startTransition and would lag behind a quick type-then-Enter.
                const liveText = inputRef.current?.getText() ?? '';
                if (liveText.trim()) {
                    if (isSendBlocked) {
                        handleBlockedSendAttempt();
                    } else if (!props.isSendDisabled) {
                        props.onSend();
                    }
                    return true; // Key was handled
                }
            }
        }
        return false; // Key was not handled
    }, [suggestions, moveUp, moveDown, selected, handleSuggestionSelect, props.showAbortButton, props.onAbort, isAborting, handleAbortPress, agentInputEnterToSend, props.onSend, isSendBlocked, handleBlockedSendAttempt, props.isSendDisabled]);

    const permissionControlLabel = displayPermissionMode
        ? withSandboxSuffix(displayPermissionMode.name, permissionModeKey)
        : t('agentInput.codexPermissionMode.default');
    const permissionPresentationKind = displayPermissionMode?.semanticKind ?? permissionModeKey;
    const permissionIsWarning = isSandboxedYoloMode
        || permissionPresentationKind === 'yolo'
        || permissionPresentationKind === 'bypassPermissions';
    const permissionControlColor = permissionIsWarning ? '#F97316' : theme.colors.text;

    const composerPickerOverlay = openPicker ? (
        <>
            <AnimatedClickAwayBackdrop
                onPress={closePicker}
                style={styles.overlayBackdrop}
            />
            <View style={[
                styles.settingsOverlay,
                { paddingHorizontal: screenWidth > 700 ? 0 : 8 },
            ]}>
                <ComposerControlMenu
                    accessibilityLabel={openPicker === 'model'
                        ? t('agentInput.model.title')
                        : openPicker === 'effort'
                            ? t('agentInput.effort.title')
                            : activeMenuSections[0]?.label ?? 'Composer menu'}
                    sections={activeMenuSections}
                    maxHeight={400}
                    presentation={openPicker === 'model' || openPicker === 'effort' ? 'choice' : 'default'}
                    style={{
                        width: openPicker === 'model' || openPicker === 'effort'
                            ? getComposerChoiceMenuWidth(openPicker, screenWidth)
                            : '100%',
                        maxWidth: openPicker === 'add' || openPicker === 'permission' ? 440 : undefined,
                        alignSelf: openPicker === 'model' || openPicker === 'effort'
                            ? 'flex-end'
                            : 'flex-start',
                    }}
                />
            </View>
        </>
    ) : null;

    const composerActionControls = (
        <View style={[
            styles.actionButtonsContainer,
            styles.mobileActionButtonsContainer,
        ]}>
            {!props.zenMode ? (
                <>
                    <BubblePressable
                        onPress={() => handlePickerPress('add')}
                        hitSlop={6}
                        style={({ pressed }) => [
                            styles.mobileIconButton,
                            (pressed || openPicker === 'add') && styles.mobileControlActive,
                        ]}
                        accessibilityRole="button"
                        accessibilityLabel="添加"
                        accessibilityState={{ expanded: openPicker === 'add' }}
                    >
                        <Ionicons
                            name="add"
                            size={MOBILE_COMPOSER_METRICS.addIconSize}
                            color={(props.selectedImages?.length ?? 0) > 0
                                ? theme.colors.radio.active
                                : theme.colors.text}
                        />
                    </BubblePressable>

                    {availableModes.length > 0 ? (
                        <BubblePressable
                            onPress={handleSettingsPress}
                            disabled={!props.onPermissionModeChange}
                            hitSlop={6}
                            style={({ pressed }) => [
                                styles.mobilePermissionButton,
                                (pressed || openPicker === 'permission') && styles.mobileControlActive,
                                !props.onPermissionModeChange && { opacity: 0.5 },
                            ]}
                            accessibilityRole="button"
                            accessibilityLabel={`${isCodex
                                ? t('agentInput.codexPermissionMode.title')
                                : t('agentInput.permissionMode.title')}: ${permissionControlLabel}`}
                            accessibilityState={{ expanded: openPicker === 'permission' }}
                        >
                            <Ionicons
                                name={permissionKindIcon(permissionPresentationKind)}
                                size={17}
                                color={permissionControlColor}
                            />
                            <Text
                                style={[styles.mobileControlText, { color: permissionControlColor }]}
                                numberOfLines={1}
                            >
                                {permissionControlLabel}
                            </Text>
                        </BubblePressable>
                    ) : null}

                    <View style={{ flex: 1, minWidth: 0 }} />

                    <BubblePressable
                        onPress={handleModelPress}
                        disabled={!canOpenModelPicker}
                        hitSlop={6}
                        style={({ pressed }) => [
                            styles.mobileModeButton,
                            screenWidth <= 380 && { paddingHorizontal: 4, gap: 2 },
                            (pressed || openPicker === 'model') && canOpenModelPicker && styles.mobileControlActive,
                            !canOpenModelPicker && { opacity: 0.5 },
                        ]}
                        accessibilityRole="button"
                        accessibilityLabel={`${t('agentInput.model.title')}: ${modelLabel}`}
                        accessibilityState={{ expanded: openPicker === 'model' }}
                    >
                        {renderModelValue()}
                    </BubblePressable>

                    {availableEffortLevels.length > 0 ? (
                        <BubblePressable
                            onPress={handleEffortPress}
                            disabled={!canOpenEffortPicker}
                            hitSlop={6}
                            style={({ pressed }) => [
                                styles.mobileEffortButton,
                                screenWidth <= 380 && { paddingHorizontal: 5, gap: 2 },
                                (pressed || openPicker === 'effort') && canOpenEffortPicker && styles.mobileControlActive,
                                !canOpenEffortPicker && { opacity: 0.5 },
                            ]}
                            accessibilityRole="button"
                            accessibilityLabel={`${t('agentInput.effort.title')}: ${effortLabel ?? t('agentInput.effort.title')}`}
                            accessibilityState={{ expanded: openPicker === 'effort' }}
                        >
                            {renderEffortValue()}
                        </BubblePressable>
                    ) : null}
                </>
            ) : (
                <View style={{ flex: 1 }} />
            )}

            <Shaker ref={shakerRef}>
                <View
                    style={[
                        styles.sendButton,
                        styles.mobilePrimaryButton,
                        shouldShowStopButton ? styles.mobileStopButton
                            : isSendBlocked ? styles.sendButtonLocked
                                : canSendMessage || shouldShowVoiceButton ? styles.mobilePrimaryButtonActive
                                    : styles.mobilePrimaryButtonInactive,
                    ]}
                >
                    <BubblePressable
                        style={({ pressed }) => ({
                            width: '100%',
                            height: '100%',
                            alignItems: 'center',
                            justifyContent: 'center',
                            opacity: pressed ? 0.7 : 1,
                        })}
                        hitSlop={6}
                        onPress={handleMobilePrimaryPress}
                        disabled={!canPressSendButton}
                        accessibilityRole="button"
                        accessibilityLabel={shouldShowStopButton ? 'Stop'
                            : shouldShowVoiceButton ? 'Voice'
                                : 'Send'}
                    >
                        {isAborting ? (
                            <ActivityIndicator
                                size="small"
                                color={shouldShowStopButton && theme.dark ? '#000000' : activeSendIconColor}
                            />
                        ) : shouldShowStopButton ? (
                            <Ionicons
                                name="stop"
                                size={15}
                                color={theme.dark ? '#000000' : '#FFFFFF'}
                            />
                        ) : isSendBlocked ? (
                            <Ionicons
                                name="lock-closed"
                                size={14}
                                color={theme.colors.textSecondary}
                            />
                        ) : shouldShowVoiceButton ? (
                            props.isMicActive ? (
                                <Ionicons name="mic" size={20} color={activeSendIconColor} />
                            ) : (
                                <Image
                                    source={require('@/assets/images/icon-voice-white.png')}
                                    style={{ width: 22, height: 22 }}
                                    tintColor={activeSendIconColor}
                                />
                            )
                        ) : (
                            <Octicons
                                name="arrow-up"
                                size={16}
                                color={canPressSendButton ? activeSendIconColor : theme.colors.textSecondary}
                                style={{
                                    color: canPressSendButton ? activeSendIconColor : theme.colors.textSecondary,
                                    marginTop: Platform.OS === 'web' ? 2 : 0,
                                }}
                            />
                        )}
                    </BubblePressable>
                </View>
            </Shaker>
        </View>
    );
    return (
        <View style={[
            styles.container,
            { paddingHorizontal: screenWidth > 700 ? 12 : 8 }
        ]}>
            <View style={[
                styles.innerContainer,
                { maxWidth: layout.maxWidth }
            ]}>
                {/* Autocomplete suggestions overlay */}
                {suggestions.length > 0 && (
                    <View style={[
                        styles.autocompleteOverlay,
                        { paddingHorizontal: screenWidth > 700 ? 0 : 8 }
                    ]}>
                        <AgentInputAutocomplete
                            suggestions={suggestions.map(s => {
                                const Component = s.component;
                                return <Component key={s.key} />;
                            })}
                            selectedIndex={selected}
                            onSelect={handleSuggestionSelect}
                            itemHeight={48}
                        />
                    </View>
                )}

                {composerPickerOverlay}
                {props.showStatusDetails !== false && (
                    <>
                        <AgentInputStatusRow
                            connectionStatus={props.connectionStatus}
                            contextWarning={contextWarning}
                        />

                        <AgentInputContextChips
                            machineName={props.machineName}
                            onMachineClick={props.onMachineClick}
                            currentPath={props.currentPath}
                            onPathClick={props.onPathClick}
                        />
                    </>
                )}

                {/* Box 2: Action Area (Input + Send) */}
                <Shaker ref={sendBlockShakerRef}>
                    <View style={[
                        compactMobileComposer && styles.unifiedPanelShadow,
                        compactMobileComposer && styles.mobileUnifiedPanelShadow,
                    ]}>
                        <MobileGlassSurface
                            enabled={compactMobileComposer}
                            nativeEffect
                            material="frosted"
                            intensity={92}
                            style={[
                                styles.unifiedPanel,
                                compactMobileComposer && styles.mobileUnifiedPanel,
                            ]}
                        >
                    {/* Attachment preview strip */}
                    {props.selectedImages && props.selectedImages.length > 0 && (
                        <AgentInputAttachmentStrip
                            images={props.selectedImages}
                            onRemove={props.onRemoveImage ?? (() => {})}
                        />
                    )}
                    {/* Input field */}
                    <View style={[
                        styles.inputContainer,
                        compactMobileComposer && styles.mobileInputContainer,
                        props.minHeight ? { minHeight: props.minHeight } : undefined,
                    ]}>
                        <MultiTextInput
                            ref={inputRef}
                            defaultValue={props.initialValue}
                            paddingTop={compactMobileComposer
                                ? MOBILE_COMPOSER_METRICS.inputPaddingTop
                                : Platform.OS === 'web' ? 10 : 8}
                            paddingBottom={compactMobileComposer
                                ? MOBILE_COMPOSER_METRICS.inputPaddingBottom
                                : Platform.OS === 'web' ? 10 : 8}
                            onChangeText={handleTextChange}
                            placeholder={props.placeholder}
                            onKeyPress={handleKeyPress}
                            onStateChange={handleInputStateChange}
                            maxHeight={Platform.OS === 'web' ? 480 : MOBILE_COMPOSER_METRICS.inputMaxHeight}
                            lineHeight={compactMobileComposer ? MOBILE_COMPOSER_METRICS.inputLineHeight : undefined}
                        />
                    </View>

                    {composerActionControls}
                        </MobileGlassSurface>
                    </View>
                </Shaker>
            </View>
        </View>
    );
}));

// Git Status Button Component
function GitStatusButton({ sessionId, onPress }: { sessionId?: string, onPress?: () => void }) {
    const hasMeaningfulGitStatus = useHasMeaningfulGitStatus(sessionId || '');
    const styles = stylesheet;
    const { theme } = useUnistyles();

    if (!sessionId || !onPress) {
        return null;
    }

    return (
        <BubblePressable
            style={(p) => ({
                flexDirection: 'row',
                alignItems: 'center',
                borderRadius: Platform.select({ default: 16, android: 20 }),
                paddingHorizontal: 8,
                paddingVertical: 6,
                height: 32,
                opacity: p.pressed ? 0.7 : 1,
                flex: 1,
                overflow: 'hidden',
            })}
            hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
            onPress={() => {
                hapticsLight();
                onPress?.();
            }}
        >
            {hasMeaningfulGitStatus ? (
                <GitStatusBadge sessionId={sessionId} />
            ) : (
                <Octicons
                    name="git-branch"
                    size={16}
                    color={theme.colors.button.secondary.tint}
                />
            )}
        </BubblePressable>
    );
}
