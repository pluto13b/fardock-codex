import * as React from 'react';
import { ActivityIndicator, Keyboard, LayoutChangeEvent, Modal as RNModal, Platform, Pressable, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';
import Animated, {
    Easing,
    Extrapolation,
    interpolate,
    runOnJS,
    useAnimatedStyle,
    useSharedValue,
    withTiming,
    type SharedValue,
} from 'react-native-reanimated';
import { MobileGlassSurface } from './MobileGlass';
import { BubblePressable } from './BubblePressable';
import { NativeOptionsPicker } from './NativeOptionsPicker';
import { ComposerControlMenu, type ComposerControlMenuSection } from './ComposerControlMenu';
import { AgentInputAttachmentStrip } from './AgentInputAttachmentStrip';
import { Typography } from '@/constants/Typography';
import { layout } from './layout';
import { getCurrentLanguage, t } from '@/text';
import { useNewSessionDraft } from '@/hooks/useNewSessionDraft';
import { useAllMachines, useSessions, useSetting } from '@/sync/storage';
import { resolveAgentDefaultConfig, resolveCodexRemotePermissionMode } from '@/sync/agentDefaults';
import { formatLastSeen, formatPathRelativeToHome } from '@/utils/sessionUtils';
import { isMachineOnline } from '@/utils/machineUtils';
import { resolveAbsolutePath } from '@/utils/pathUtils';
import { listWorktrees } from '@/utils/worktree';
import type { Machine, Session } from '@/sync/storageTypes';
import {
    getEffortLevelsForModel,
    getHardcodedModelModes,
    getHardcodedPermissionModes,
    getSupportsWorktree,
    presentEffortLevel,
    type ModeOption,
} from './modelModeOptions';
import { getComposerChoiceMenuWidth } from './composerControlMenuLayout';
import type { NewSessionAgentType } from '@/sync/persistence';
import { useImagePicker } from '@/hooks/useImagePicker';
import { Modal } from '@/modal';
import { resolveMultiTextInputLayout } from './multiTextInputLayout';
import { resolveCustomProjectPathSelection } from './homeDockInteraction';
import { resolveMachineAgent } from '@/utils/newSessionAgentSelection';
import { findConnectedRigMachine, getRigMachineSessionCreation } from '@/sync/rigSessionCreation';
import {
    MobileHeaderScrim,
    MOBILE_STRONG_HEADER_SCRIM_RESTING_OPACITY,
} from './navigation/MobileHeaderScrim';
import {
    MOBILE_COMPOSER_LAYOUT,
    MOBILE_COMPOSER_METRICS,
    resolveMobileComposerActionGeometry,
    resolveMobileComposerActionRowGeometry,
    resolveMobileCollapsedComposerGeometry,
    resolveMobileComposerHeight,
} from './agentInputLayout';

export const MOBILE_HOME_DOCK_CONTENT_INSET = 108;

type EnvironmentSetting = 'machine' | 'project';
type FocusedComposerMenu = 'add' | 'permission' | 'model' | 'effort';

const CUSTOM_PROJECT_PATH_KEY = '__custom_project_path__';

const AGENTS: Array<{ key: NewSessionAgentType; name: string }> = [
    { key: 'codex', name: 'Codex' },
];

const MOBILE_ACTION_ROW_GEOMETRY = resolveMobileComposerActionRowGeometry();
const MOBILE_ICON_ACTION_GEOMETRY = resolveMobileComposerActionGeometry('icon');
const MOBILE_PRIMARY_ACTION_GEOMETRY = resolveMobileComposerActionGeometry('primary');
const MOBILE_COLLAPSED_COMPOSER_GEOMETRY = resolveMobileCollapsedComposerGeometry();

const styles = StyleSheet.create((theme) => ({
    keyboardFollower: {
        width: '100%',
    },
    bottomBackdrop: {
        ...StyleSheet.absoluteFillObject,
        top: -36,
        opacity: MOBILE_STRONG_HEADER_SCRIM_RESTING_OPACITY,
    },
    safeArea: {
        paddingHorizontal: 16,
        paddingTop: 8,
    },
    composerSurface: {
        width: '100%',
        maxWidth: layout.maxWidth,
        height: MOBILE_COLLAPSED_COMPOSER_GEOMETRY.shellHeight,
        alignSelf: 'center',
        borderRadius: MOBILE_COLLAPSED_COMPOSER_GEOMETRY.shellRadius,
        overflow: 'hidden',
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.glass.border,
        // Frosted glass is supplied by MobileGlassSurface on native. The dense
        // material tint keeps backdrop detail from competing with this input.
        backgroundColor: Platform.select({
            ios: 'transparent',
            android: theme.colors.glass.backgroundStrong,
            default: theme.colors.glass.backgroundStrong,
        }),
    },
    composerContent: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        paddingLeft: MOBILE_COLLAPSED_COMPOSER_GEOMETRY.contentPaddingLeft,
        paddingRight: MOBILE_COLLAPSED_COMPOSER_GEOMETRY.contentPaddingRight,
        gap: 4,
    },
    sideButton: MOBILE_ICON_ACTION_GEOMETRY,
    sideButtonPressed: {
        backgroundColor: theme.colors.glass.backgroundSubtle,
    },
    input: {
        flex: 1,
        minWidth: 0,
        height: '100%',
        paddingLeft: MOBILE_COLLAPSED_COMPOSER_GEOMETRY.inputPaddingLeft,
        paddingRight: MOBILE_COLLAPSED_COMPOSER_GEOMETRY.inputPaddingRight,
        paddingVertical: 0,
        color: theme.colors.text,
        fontSize: 17,
        ...Typography.default(),
    },
    inputEntry: {
        flex: 1,
        minWidth: 0,
        height: '100%',
        justifyContent: 'center',
        paddingLeft: MOBILE_COLLAPSED_COMPOSER_GEOMETRY.inputPaddingLeft,
        paddingRight: MOBILE_COLLAPSED_COMPOSER_GEOMETRY.inputPaddingRight,
    },
    inputEntryText: {
        color: theme.colors.text,
        fontSize: 17,
        ...Typography.default(),
    },
    inputEntryPlaceholder: {
        color: theme.colors.textSecondary,
    },
    focusedComposerSurface: {
        width: '100%',
        maxWidth: layout.maxWidth,
        alignSelf: 'center',
        borderRadius: MOBILE_COMPOSER_METRICS.shellRadius,
        overflow: 'hidden',
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.glass.border,
        backgroundColor: Platform.select({
            ios: 'transparent',
            android: theme.colors.glass.backgroundStrong,
            default: theme.colors.glass.backgroundStrong,
        }),
    },
    focusedComposerAnimationShell: {
        width: '100%',
        maxWidth: layout.maxWidth,
        alignSelf: 'center',
        borderRadius: MOBILE_COMPOSER_METRICS.shellRadius,
        overflow: 'hidden',
    },
    focusedComposerAnchored: {
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
    },
    focusedComposerContent: {
        flex: 1,
        paddingHorizontal: MOBILE_COMPOSER_METRICS.shellInset,
        paddingTop: MOBILE_COMPOSER_METRICS.shellPaddingTop,
        paddingBottom: MOBILE_COMPOSER_METRICS.shellPaddingBottom,
    },
    focusedInput: {
        flex: 1,
        width: '100%',
        maxHeight: MOBILE_COMPOSER_METRICS.inputMaxHeight,
        paddingLeft: 0,
        paddingRight: 0,
        paddingTop: MOBILE_COMPOSER_METRICS.inputPaddingTop,
        paddingBottom: MOBILE_COMPOSER_METRICS.inputPaddingBottom,
        color: theme.colors.text,
        fontSize: MOBILE_COMPOSER_METRICS.inputFontSize,
        lineHeight: MOBILE_COMPOSER_METRICS.inputLineHeight,
        textAlignVertical: 'top',
        ...Platform.select({ web: { outlineStyle: 'none' } as any, default: {} }),
        ...Typography.default(),
    },
    focusedInputMeasurement: {
        position: 'absolute',
        left: MOBILE_COMPOSER_LAYOUT.inputContainerPaddingLeft,
        right: MOBILE_COMPOSER_LAYOUT.inputContainerPaddingRight,
        opacity: 0,
        paddingLeft: 0,
        paddingRight: 0,
        paddingTop: MOBILE_COMPOSER_METRICS.inputPaddingTop,
        paddingBottom: MOBILE_COMPOSER_METRICS.inputPaddingBottom,
        fontSize: MOBILE_COMPOSER_METRICS.inputFontSize,
        lineHeight: MOBILE_COMPOSER_METRICS.inputLineHeight,
        ...Typography.default(),
    },
    focusedInputReveal: {
        flexDirection: 'row',
        alignItems: 'center',
        minHeight: 0,
        paddingLeft: MOBILE_COMPOSER_LAYOUT.inputContainerPaddingLeft,
        paddingRight: MOBILE_COMPOSER_LAYOUT.inputContainerPaddingRight,
        paddingTop: MOBILE_COMPOSER_METRICS.inputPaddingTop,
        paddingBottom: MOBILE_COMPOSER_METRICS.inputPaddingBottom,
    },
    focusedComposerActions: MOBILE_ACTION_ROW_GEOMETRY,
    focusedControlButton: {
        height: 36,
        minWidth: 0,
        flexShrink: 1,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 4,
        paddingHorizontal: 6,
        borderRadius: 18,
    },
    focusedPermissionButton: {
        minWidth: 98,
        maxWidth: 105,
        flexShrink: 0,
        justifyContent: 'flex-start',
    },
    focusedModelButton: {
        maxWidth: 85,
    },
    focusedEffortButton: {
        maxWidth: 65,
    },
    focusedControlActive: {
        backgroundColor: theme.colors.surfaceSelected,
    },
    focusedControlText: {
        flexShrink: 1,
        minWidth: 0,
        color: theme.colors.text,
        fontSize: 14,
        ...Typography.default(),
    },
    focusedMenuPosition: {
        position: 'absolute',
        left: 16,
        right: 16,
        zIndex: 40,
    },
    focusedMenuLeft: {
        width: '100%',
        maxWidth: 440,
        alignSelf: 'flex-start',
    },
    focusedMenuRight: {
        width: '100%',
        maxWidth: 380,
        alignSelf: 'flex-end',
    },
    sendButton: {
        ...MOBILE_PRIMARY_ACTION_GEOMETRY,
        backgroundColor: theme.colors.surfaceHighest,
    },
    sendButtonActive: {
        backgroundColor: theme.dark ? '#F5F5F5' : theme.colors.button.primary.background,
    },
    modalRoot: {
        flex: 1,
    },
    modalBackdrop: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
    },
    focusBackdrop: {
        backgroundColor: 'rgba(0, 0, 0, 0.88)',
    },
    focusDock: {
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
    },
    focusConfig: {
        width: '100%',
        maxWidth: layout.maxWidth,
        alignSelf: 'center',
        paddingHorizontal: 24,
        paddingBottom: 10,
        gap: 8,
    },
    focusConfigGroup: {
        gap: 1,
    },
    focusConfigRevealRow: {
        width: '100%',
    },
    focusInlineSurface: {
        maxHeight: 220,
    },
    focusConfigRow: {
        minHeight: 42,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingHorizontal: 6,
        borderRadius: 12,
    },
    focusConfigIcon: {
        width: 24,
        alignItems: 'center',
    },
    focusConfigValue: {
        flex: 1,
        minWidth: 0,
        color: theme.colors.text,
        fontSize: 17,
        ...Typography.default(),
    },
    focusComposerArea: {
        paddingHorizontal: 16,
        paddingBottom: 8,
    },
    settingsPosition: {
        position: 'absolute',
        left: 16,
        right: 16,
    },
    settingsStack: {
        width: '100%',
        maxWidth: layout.maxWidth,
        alignSelf: 'center',
        gap: 10,
    },
    settingsSurface: {
        width: '100%',
        maxHeight: 270,
        borderRadius: 24,
        overflow: 'hidden',
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.glass.border,
        backgroundColor: Platform.select({
            ios: theme.colors.glass.overlay,
            default: theme.colors.glass.backgroundStrong,
        }),
        paddingVertical: 10,
        paddingHorizontal: 12,
    },
    settingsHeader: {
        minHeight: 40,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        paddingBottom: 4,
    },
    backButton: {
        width: 36,
        height: 36,
        borderRadius: 18,
        alignItems: 'center',
        justifyContent: 'center',
    },
    settingsTitle: {
        flex: 1,
        minWidth: 0,
        color: theme.colors.text,
        fontSize: 14,
        ...Typography.default('semiBold'),
    },
    optionList: {
        flexGrow: 0,
    },
    option: {
        minHeight: 48,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingHorizontal: 8,
        paddingVertical: 8,
        borderRadius: 14,
    },
    optionPressed: {
        backgroundColor: theme.colors.surfacePressedOverlay,
    },
    optionCopy: {
        flex: 1,
        minWidth: 0,
    },
    optionLabel: {
        color: theme.colors.textSecondary,
        fontSize: 12,
        ...Typography.default(),
    },
    optionValue: {
        color: theme.colors.text,
        fontSize: 15,
        ...Typography.default(),
    },
    optionDescription: {
        color: theme.colors.textSecondary,
        fontSize: 12,
        marginTop: 2,
        ...Typography.default(),
    },
}));

function resolveOption(options: ModeOption[], preferred: Array<string | null | undefined>): ModeOption | null {
    for (const key of preferred) {
        const option = options.find((candidate) => candidate.key === key);
        if (option) return option;
    }
    return options[0] ?? null;
}

function getMachineName(machine: Machine): string {
    return machine.metadata?.displayName || machine.metadata?.host || 'Unknown machine';
}

function getPermissionIcon(mode: string): React.ComponentProps<typeof Ionicons>['name'] {
    if (mode === 'read-only') return 'lock-closed-outline';
    if (mode === 'safe-yolo') return 'shield-checkmark-outline';
    if (mode === 'yolo' || mode === 'bypassPermissions') return 'warning-outline';
    return 'hand-left-outline';
}

function FocusConfigRevealRow({
    progress,
    index,
    children,
}: {
    progress: SharedValue<number>;
    index: number;
    children: React.ReactNode;
}) {
    const revealStyle = useAnimatedStyle(() => {
        const start = 0.18 + index * 0.09;
        const end = start + 0.28;
        const reveal = interpolate(
            progress.value,
            [start, end],
            [0, 1],
            Extrapolation.CLAMP,
        );
        return {
            opacity: reveal,
            transform: [{ translateY: 10 * (1 - reveal) }],
        };
    }, [index]);

    return (
        <Animated.View style={[styles.focusConfigRevealRow, revealStyle]}>
            {children}
        </Animated.View>
    );
}

export const HomeDock = React.memo(({
    prompt,
    onPromptChange,
    onSubmit,
    isSubmitting,
    showBottomBackdrop = true,
}: {
    prompt: string;
    onPromptChange: (prompt: string) => void;
    onSubmit: () => Promise<boolean>;
    isSubmitting: boolean;
    showBottomBackdrop?: boolean;
}) => {
    const { theme } = useUnistyles();
    const { width: viewportWidth } = useWindowDimensions();
    const currentLanguage = getCurrentLanguage();
    const narrowComposerControls = viewportWidth <= 380;
    const safeArea = useSafeAreaInsets();
    const keyboard = useReanimatedKeyboardAnimation();
    const inputRef = React.useRef<TextInput>(null);
    const focusedInputRef = React.useRef<TextInput>(null);
    const mountedRef = React.useRef(true);
    const focusAnimationTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const focusedMenuSelectionTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const focusPresentation = useSharedValue(0);
    const [isFocused, setIsFocused] = React.useState(false);
    const [focusModeVisible, setFocusModeVisible] = React.useState(false);
    const [focusedComposerMenu, setFocusedComposerMenu] = React.useState<FocusedComposerMenu | null>(null);
    const [focusedInputContentHeight, setFocusedInputContentHeight] = React.useState(0);
    const expImageUpload = useSetting('expImageUpload');
    const { selectedImages, pickImages, removeImage, clearImages } = useImagePicker();
    const agentType = useNewSessionDraft((state) => state.agentType);
    const selectedMachineId = useNewSessionDraft((state) => state.selectedMachineId);
    const selectedPath = useNewSessionDraft((state) => state.selectedPath);
    const sessionType = useNewSessionDraft((state) => state.sessionType);
    const worktreeKey = useNewSessionDraft((state) => state.worktreeKey);
    const permissionMode = useNewSessionDraft((state) => state.permissionMode);
    const modelMode = useNewSessionDraft((state) => state.modelMode);
    const effortLevel = useNewSessionDraft((state) => state.effortLevel);
    const setMachineId = useNewSessionDraft((state) => state.setMachineId);
    const setAgentType = useNewSessionDraft((state) => state.setAgentType);
    const setPath = useNewSessionDraft((state) => state.setPath);
    const setSessionType = useNewSessionDraft((state) => state.setSessionType);
    const setWorktreeKey = useNewSessionDraft((state) => state.setWorktreeKey);
    const setPermissionMode = useNewSessionDraft((state) => state.setPermissionMode);
    const setModelMode = useNewSessionDraft((state) => state.setModelMode);
    const setEffortLevel = useNewSessionDraft((state) => state.setEffortLevel);
    const defaultOverrides = useSetting('agentDefaultOverrides');
    const machines = useAllMachines({ includeOffline: true });
    const sessions = useSessions();
    const selectedMachine = React.useMemo(
        () => machines.find((machine) => machine.id === selectedMachineId) ?? null,
        [machines, selectedMachineId],
    );
    const machineOptions = React.useMemo<ModeOption[]>(() => (
        [...machines]
            .sort((left, right) => Number(isMachineOnline(right)) - Number(isMachineOnline(left)))
            .map((machine) => ({
                key: machine.id,
                name: getMachineName(machine),
                description: isMachineOnline(machine)
                    ? t('status.online')
                    : t('status.lastSeen', { time: formatLastSeen(machine.activeAt, false) }),
            }))
    ), [machines]);
    const currentMachine = resolveOption(machineOptions, [selectedMachineId]);

    React.useEffect(() => {
        if (!selectedMachineId && machineOptions[0]) {
            setMachineId(machineOptions[0].key);
        }
    }, [machineOptions, selectedMachineId, setMachineId]);

    const projectOptions = React.useMemo<ModeOption[]>(() => {
        const paths = new Set<string>();
        paths.add(selectedPath ?? '~');

        if (selectedMachineId && sessions) {
            for (const item of sessions) {
                if (typeof item === 'string') continue;
                const session = item as Session;
                if (session.metadata?.machineId === selectedMachineId && session.metadata.path) {
                    paths.add(session.metadata.path);
                }
            }
        }

        const homeDir = selectedMachine?.metadata?.homeDir;
        return Array.from(paths).map((path) => {
            const name = formatPathRelativeToHome(path, homeDir);
            return {
                key: path,
                name,
                description: name === path ? undefined : path,
            };
        });
    }, [selectedMachine, selectedMachineId, selectedPath, sessions]);
    const currentProject = resolveOption(projectOptions, [selectedPath, '~']);
    const selectedRigCreation = React.useMemo(
        () => getRigMachineSessionCreation(selectedMachine?.metadata),
        [selectedMachine?.metadata],
    );
    const connectedRigMachine = React.useMemo(
        () => findConnectedRigMachine(machines),
        [machines],
    );
    const selectedRigIsConnected = selectedRigCreation !== null
        && selectedMachine !== null
        && isMachineOnline(selectedMachine);
    const rigSelectionMachine = selectedRigIsConnected ? selectedMachine : connectedRigMachine;
    const rigSelectionCreation = selectedRigIsConnected
        ? selectedRigCreation
        : getRigMachineSessionCreation(connectedRigMachine?.metadata);
    const rigCreation = agentType === 'rig' ? rigSelectionCreation : null;
    const supportsWorktree = false;
    const selectedWorktreeKey = sessionType === 'worktree'
        ? worktreeKey ?? '__new__'
        : '__none__';
    const [existingWorktrees, setExistingWorktrees] = React.useState<ModeOption[]>([]);

    React.useEffect(() => {
        const path = resolveAbsolutePath(selectedPath ?? '~', selectedMachine?.metadata?.homeDir);
        if (!supportsWorktree || !selectedMachineId || !selectedMachine || !isMachineOnline(selectedMachine) || !path) {
            setExistingWorktrees([]);
            return;
        }

        let cancelled = false;
        listWorktrees(selectedMachineId, path).then((worktrees) => {
            if (cancelled) return;
            setExistingWorktrees(worktrees.map((worktree) => ({
                key: worktree.path,
                name: worktree.branch,
                description: worktree.path,
            })));
        });
        return () => {
            cancelled = true;
        };
    }, [selectedMachine, selectedMachineId, selectedPath, supportsWorktree]);

    React.useEffect(() => {
        if (!supportsWorktree && sessionType === 'worktree') {
            setSessionType('simple');
            setWorktreeKey(null);
        }
    }, [sessionType, setSessionType, setWorktreeKey, supportsWorktree]);

    const worktreeOptions = React.useMemo<ModeOption[]>(() => {
        if (!supportsWorktree) {
            return [{
                key: '__none__',
                name: 'No worktree',
                description: `Not supported by ${AGENTS.find((agent) => agent.key === agentType)?.name ?? agentType}`,
            }];
        }
        const options: ModeOption[] = [
            { key: '__none__', name: 'No worktree' },
            { key: '__new__', name: 'Create new worktree' },
            ...existingWorktrees,
        ];
        if (
            worktreeKey
            && !options.some((option) => option.key === worktreeKey)
        ) {
            options.push({ key: worktreeKey, name: worktreeKey });
        }
        return options;
    }, [agentType, existingWorktrees, supportsWorktree, worktreeKey]);
    const currentWorktree = resolveOption(worktreeOptions, [selectedWorktreeKey]);
    // Every agent stays listed so the picker always reads as a choice. The ones
    // the selected machine has no CLI for are disabled rather than hidden, which
    // otherwise leaves a single checked row that looks like it does nothing.
    const availableAgents = React.useMemo<ModeOption[]>(() => {
        const availability = selectedMachine?.metadata?.cliAvailability;
        return AGENTS.map((agent) => {
            const available = agent.key === 'rig'
                ? rigSelectionMachine !== null
                : !availability || availability[agent.key];
            return available
                ? agent
                : {
                    ...agent,
                    disabled: true,
                    description: agent.key === 'rig'
                        ? 'Select a connected Rig machine'
                        : 'Not installed on this machine',
                };
        });
    }, [rigSelectionMachine, selectedMachine]);
    const resolvedAgentType: NewSessionAgentType = 'codex';
    const defaults = React.useMemo(() => rigCreation
        ? {
            permissionMode: rigCreation.defaultPermissionMode ?? '',
            modelMode: rigCreation.defaultModelKey ?? '',
            effortLevel: rigCreation.defaultEffortForModel(rigCreation.defaultModelKey),
        }
        : resolveAgentDefaultConfig(defaultOverrides, agentType), [agentType, defaultOverrides, rigCreation]);
    const permissionOptions = React.useMemo(
        () => rigCreation?.permissionModes ?? getHardcodedPermissionModes(agentType, t),
        [agentType, rigCreation],
    );
    const modelOptions = React.useMemo(
        () => rigCreation?.models ?? getHardcodedModelModes(agentType, t),
        [agentType, rigCreation],
    );
    const currentPermission = resolveOption(permissionOptions, [
        resolveCodexRemotePermissionMode(permissionMode ?? defaults.permissionMode),
    ]);
    const currentModel = resolveOption(modelOptions, [modelMode, defaults.modelMode]);
    const effortOptions = React.useMemo(
        () => (rigCreation
            ? rigCreation.effortsForModel(currentModel?.key).map((key) => ({ key, name: key }))
            : getEffortLevelsForModel(agentType, currentModel?.key ?? 'default'))
            .map((level) => presentEffortLevel(level, currentLanguage)),
        [agentType, currentLanguage, currentModel?.key, rigCreation],
    );
    const currentEffortDefault = rigCreation?.defaultEffortForModel(currentModel?.key)
        ?? defaults.effortLevel;
    const currentEffort = resolveOption(effortOptions, [effortLevel, currentEffortDefault]);
    const currentAgent = AGENTS[0];
    const canSubmit = !isSubmitting && (
        prompt.trim().length > 0 || (expImageUpload && selectedImages.length > 0)
    );
    const focusedInputLayout = resolveMultiTextInputLayout({
        contentHeight: focusedInputContentHeight,
        hasText: prompt.length > 0,
        maxHeight: MOBILE_COMPOSER_METRICS.inputMaxHeight,
        lineHeight: MOBILE_COMPOSER_METRICS.inputLineHeight,
        paddingTop: MOBILE_COMPOSER_METRICS.inputPaddingTop,
        paddingBottom: MOBILE_COMPOSER_METRICS.inputPaddingBottom,
    });
    const focusedInputContainerHeight = Math.max(
        MOBILE_COMPOSER_METRICS.inputMinHeight,
        focusedInputLayout.height
            + MOBILE_COMPOSER_METRICS.inputPaddingTop
            + MOBILE_COMPOSER_METRICS.inputPaddingBottom,
    );
    const focusedComposerHeight = resolveMobileComposerHeight(
        focusedInputLayout.height,
        selectedImages.length > 0,
    );
    const handleFocusedInputMeasurement = React.useCallback((event: LayoutChangeEvent) => {
        const nextHeight = Math.ceil(event.nativeEvent.layout.height);
        setFocusedInputContentHeight((currentHeight) => (
            currentHeight === nextHeight ? currentHeight : nextHeight
        ));
    }, []);
    const keyboardStyle = useAnimatedStyle(() => ({
        // Keyboard height includes the bottom safe area on iOS. The resting
        // dock keeps that inset, then gives it back while the keyboard opens
        // so the composer stays the same 8px above either boundary.
        transform: [{
            translateY: keyboard.height.value + safeArea.bottom * keyboard.progress.value,
        }],
    }), [safeArea.bottom]);
    const focusBackdropStyle = useAnimatedStyle(() => ({
        opacity: interpolate(
            focusPresentation.value,
            [0, 0.35, 1],
            [0, 1, 1],
            Extrapolation.CLAMP,
        ),
    }));
    const focusedComposerAnimationStyle = useAnimatedStyle(() => ({
        height: interpolate(
            focusPresentation.value,
            [0, 1],
            [56, focusedComposerHeight],
            Extrapolation.CLAMP,
        ),
        opacity: interpolate(
            focusPresentation.value,
            [0, 0.12, 1],
            [0.72, 1, 1],
            Extrapolation.CLAMP,
        ),
        transform: [{
            scaleX: interpolate(
                focusPresentation.value,
                [0, 1],
                [0.96, 1],
                Extrapolation.CLAMP,
            ),
        }],
    }), [focusedComposerHeight]);
    const focusedInputRevealStyle = useAnimatedStyle(() => {
        const reveal = interpolate(
            focusPresentation.value,
            [0.22, 0.6],
            [0, 1],
            Extrapolation.CLAMP,
        );
        return {
            opacity: reveal,
            transform: [{ translateY: 8 * (1 - reveal) }],
        };
    });
    const focusedActionsRevealStyle = useAnimatedStyle(() => {
        const reveal = interpolate(
            focusPresentation.value,
            [0.46, 0.82],
            [0, 1],
            Extrapolation.CLAMP,
        );
        return {
            opacity: reveal,
            transform: [{ translateY: 7 * (1 - reveal) }],
        };
    });

    React.useEffect(() => {
        if (!focusModeVisible) return;
        const timeout = setTimeout(() => focusedInputRef.current?.focus(), 50);
        return () => clearTimeout(timeout);
    }, [focusModeVisible]);

    React.useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            if (focusAnimationTimerRef.current) {
                clearTimeout(focusAnimationTimerRef.current);
            }
            if (focusedMenuSelectionTimerRef.current) {
                clearTimeout(focusedMenuSelectionTimerRef.current);
            }
        };
    }, []);

    const closeFocusedComposerMenuAfterSelection = React.useCallback(() => {
        if (focusedMenuSelectionTimerRef.current) {
            clearTimeout(focusedMenuSelectionTimerRef.current);
        }
        focusedMenuSelectionTimerRef.current = setTimeout(() => {
            focusedMenuSelectionTimerRef.current = null;
            setFocusedComposerMenu(null);
        }, 170);
    }, []);

    React.useEffect(() => {
        if (!expImageUpload && selectedImages.length > 0) {
            clearImages();
            useNewSessionDraft.getState().setAttachments([]);
        }
    }, [clearImages, expImageUpload, selectedImages.length]);

    const openFocusMode = React.useCallback(() => {
        if (focusAnimationTimerRef.current) {
            clearTimeout(focusAnimationTimerRef.current);
        }
        focusPresentation.value = 0;
        setFocusedComposerMenu(null);
        setIsFocused(true);
        setFocusModeVisible(true);
        focusAnimationTimerRef.current = setTimeout(() => {
            focusPresentation.value = withTiming(1, {
                duration: 340,
                easing: Easing.out(Easing.cubic),
            });
            focusAnimationTimerRef.current = null;
        }, 16);
    }, [focusPresentation]);

    const finishCloseFocusMode = React.useCallback(() => {
        setFocusedComposerMenu(null);
        setIsFocused(false);
        setFocusModeVisible(false);
    }, []);

    const closeFocusMode = React.useCallback(() => {
        if (focusAnimationTimerRef.current) {
            clearTimeout(focusAnimationTimerRef.current);
            focusAnimationTimerRef.current = null;
        }
        focusedInputRef.current?.blur();
        inputRef.current?.blur();
        Keyboard.dismiss();
        focusPresentation.value = withTiming(0, {
            duration: 180,
            easing: Easing.in(Easing.cubic),
        }, (finished) => {
            if (finished) {
                runOnJS(finishCloseFocusMode)();
            }
        });
    }, [finishCloseFocusMode, focusPresentation]);

    const dismissFocusedMenuOrClose = React.useCallback(() => {
        if (focusedComposerMenu) {
            setFocusedComposerMenu(null);
            return;
        }
        closeFocusMode();
    }, [closeFocusMode, focusedComposerMenu]);

    const selectAgent = React.useCallback((agent: NewSessionAgentType) => {
        const nextRigCreation = agent === 'rig' ? rigSelectionCreation : null;
        const nextDefaults = nextRigCreation
            ? {
                permissionMode: nextRigCreation.defaultPermissionMode ?? '',
                modelMode: nextRigCreation.defaultModelKey ?? '',
                effortLevel: nextRigCreation.defaultEffortForModel(nextRigCreation.defaultModelKey),
            }
            : resolveAgentDefaultConfig(defaultOverrides, agent);
        if (agent === 'rig' && rigSelectionMachine && rigSelectionMachine.id !== selectedMachineId) {
            setMachineId(rigSelectionMachine.id);
        }
        setAgentType(agent);
        setPermissionMode(nextDefaults.permissionMode);
        setModelMode(nextDefaults.modelMode);
        if (nextDefaults.effortLevel) setEffortLevel(nextDefaults.effortLevel);
    }, [defaultOverrides, rigSelectionCreation, rigSelectionMachine, selectedMachineId, setAgentType, setEffortLevel, setMachineId, setModelMode, setPermissionMode]);

    React.useEffect(() => {
        if (agentType === 'rig' && rigSelectionMachine && rigSelectionMachine.id !== selectedMachineId) {
            setMachineId(rigSelectionMachine.id);
        }
    }, [agentType, rigSelectionMachine, selectedMachineId, setMachineId]);

    React.useEffect(() => {
        if (resolvedAgentType !== agentType) {
            selectAgent(resolvedAgentType);
        }
    }, [agentType, resolvedAgentType, selectAgent]);

    React.useEffect(() => {
        if (sessionType !== 'simple' || worktreeKey !== null) {
            setSessionType('simple');
            setWorktreeKey(null);
        }
    }, [sessionType, setSessionType, setWorktreeKey, worktreeKey]);

    type SettingsRow = {
        page: string;
        label: string;
        value: string;
        icon: React.ComponentProps<typeof Ionicons>['name'];
    };

    const environmentRows: SettingsRow[] = [
        { page: 'machine', label: 'MACHINE', value: currentMachine?.name ?? 'Select machine', icon: 'desktop-outline' },
        { page: 'project', label: 'PROJECT', value: currentProject?.name ?? '~', icon: 'folder-outline' },
    ];

    type PickerConfig = {
        title: string;
        options: ModeOption[];
        selectedKey: string | null | undefined;
        onSelect: (key: string) => void;
    };

    const requestCustomProjectPath = () => {
        Keyboard.dismiss();
        // Native menu actions are already deferred until dismissal by the
        // picker wrapper, so presenting another delayed task here creates a
        // stale prompt race when HomeDock unmounts.
        void (async () => {
            const path = await Modal.prompt(
                t('machineLauncher.enterCustomPath'),
                undefined,
                {
                    placeholder: '~/path/to/project',
                    defaultValue: selectedPath ?? '~',
                    confirmText: t('common.ok'),
                },
            );
            const selectedCustomPath = resolveCustomProjectPathSelection(path, mountedRef.current);
            if (selectedCustomPath) {
                setPath(selectedCustomPath);
            }
        })();
    };

    const getEnvironmentPickerConfig = (setting: EnvironmentSetting): PickerConfig => {
        if (setting === 'machine') {
            return { title: 'Machine', options: machineOptions, selectedKey: selectedMachineId, onSelect: setMachineId };
        }
        return {
            title: 'Project',
            options: [
                ...projectOptions,
                {
                    key: CUSTOM_PROJECT_PATH_KEY,
                    name: t('machineLauncher.enterCustomPath'),
                },
            ],
            selectedKey: currentProject?.key,
            onSelect: (key) => {
                if (key === CUSTOM_PROJECT_PATH_KEY) {
                    requestCustomProjectPath();
                    return;
                }
                setPath(key);
            },
        };
    };

    const renderNativePicker = (row: SettingsRow, config: PickerConfig, compact: boolean) => (
        <NativeOptionsPicker
            key={row.page}
            title={config.title}
            triggerLabel={row.value}
            systemImage={{
                machine: 'desktopcomputer',
                project: 'folder',
                worktree: 'arrow.triangle.branch',
                agent: 'cpu',
                model: 'cube',
                permission: 'shield',
                effort: 'bolt',
            }[row.page]}
            options={config.options.map((option) => ({ key: option.key, label: option.name }))}
            selectedKey={config.selectedKey}
            onSelect={config.onSelect}
        >
            <View style={compact ? styles.focusConfigRow : styles.option}>
                <View style={styles.focusConfigIcon}>
                    <Ionicons
                        name={row.icon}
                        size={compact ? 21 : 18}
                        color={theme.colors.text}
                    />
                </View>
                {compact ? (
                    <Text style={styles.focusConfigValue} numberOfLines={1}>{row.value}</Text>
                ) : (
                    <View style={styles.optionCopy}>
                        <Text style={styles.optionLabel}>{row.label}</Text>
                        <Text style={styles.optionValue} numberOfLines={1}>{row.value}</Text>
                    </View>
                )}
            </View>
        </NativeOptionsPicker>
    );

    const renderEnvironmentPickers = () => environmentRows.map((row, index) => (
        <FocusConfigRevealRow
            key={row.page}
            progress={focusPresentation}
            index={index}
        >
            {renderNativePicker(row, getEnvironmentPickerConfig(row.page as EnvironmentSetting), true)}
        </FocusConfigRevealRow>
    ));

    const focusedComposerMenuSections: ComposerControlMenuSection[] = (() => {
        if (focusedComposerMenu === 'add') {
            return [{
                key: 'add',
                items: [{
                    key: 'images',
                    label: t('settingsFeatures.imageUpload'),
                    description: expImageUpload
                        ? t('imageUpload.permissionMessage')
                        : t('imageUpload.notSupportedMessage'),
                    icon: 'image-outline',
                    disabled: !expImageUpload,
                    onPress: expImageUpload
                        ? () => {
                            setFocusedComposerMenu(null);
                            void pickImages();
                        }
                        : undefined,
                }],
            }];
        }
        if (focusedComposerMenu === 'permission') {
            return [{
                key: 'permission',
                label: t('agentInput.codexPermissionMode.title'),
                items: permissionOptions.map((option) => {
                    const disabled = 'disabled' in option && option.disabled === true;
                    return {
                        key: option.key,
                        label: option.name,
                        description: option.description,
                        icon: getPermissionIcon(option.key),
                        selected: option.key === currentPermission?.key,
                        disabled,
                        tone: option.key === 'safe-yolo' || option.key === 'yolo' || option.key === 'bypassPermissions'
                            ? 'warning' as const
                            : 'default' as const,
                        onPress: disabled
                            ? undefined
                            : () => {
                                setPermissionMode(option.key);
                                closeFocusedComposerMenuAfterSelection();
                            },
                    };
                }),
            }];
        }
        if (focusedComposerMenu === 'model') {
            return [{
                key: 'model',
                items: modelOptions.map((option) => {
                    const disabled = 'disabled' in option && option.disabled === true;
                    return {
                        key: option.key,
                        label: option.name,
                        description: option.description,
                        selected: option.key === currentModel?.key,
                        disabled,
                        onPress: disabled
                            ? undefined
                            : () => {
                                setModelMode(option.key);
                                closeFocusedComposerMenuAfterSelection();
                            },
                    };
                }),
            }];
        }
        if (focusedComposerMenu === 'effort') {
            return [{
                key: 'effort',
                label: t('agentInput.effort.title'),
                items: effortOptions.map((option) => {
                    const disabled = 'disabled' in option && option.disabled === true;
                    return {
                        key: option.key,
                        label: option.name,
                        description: 'description' in option && typeof option.description === 'string'
                            ? option.description
                            : undefined,
                        selected: option.key === currentEffort?.key,
                        disabled,
                        onPress: disabled
                            ? undefined
                            : () => {
                                setEffortLevel(option.key);
                                closeFocusedComposerMenuAfterSelection();
                            },
                    };
                }),
            }];
        }
        return [];
    })();

    const toggleFocusedComposerMenu = (menu: FocusedComposerMenu) => {
        if (focusedMenuSelectionTimerRef.current) {
            clearTimeout(focusedMenuSelectionTimerRef.current);
            focusedMenuSelectionTimerRef.current = null;
        }
        if (focusedComposerMenu !== menu && Platform.OS === 'web') {
            focusedInputRef.current?.blur();
        }
        setFocusedComposerMenu((current) => current === menu ? null : menu);
    };

    const renderComposer = ({
        ref,
        onFocus,
        onBlur,
        onSend,
        activateOnPress,
    }: {
        ref: React.RefObject<TextInput | null>;
        onFocus: () => void;
        onBlur: () => void;
        onSend: () => void;
        activateOnPress?: () => void;
    }) => (
        <MobileGlassSurface
            nativeEffect
            material="frosted"
            intensity={92}
            style={styles.composerSurface}
        >
            <View style={styles.composerContent}>
                {activateOnPress ? (
                    <Pressable onPress={activateOnPress} style={styles.inputEntry}>
                        <Text
                            style={[styles.inputEntryText, !prompt && styles.inputEntryPlaceholder]}
                            numberOfLines={1}
                        >
                            {prompt || 'Plan, ask, build…'}
                        </Text>
                    </Pressable>
                ) : (
                    <TextInput
                        ref={ref}
                        value={prompt}
                        onChangeText={onPromptChange}
                        onSubmitEditing={() => canSubmit && onSend()}
                        onFocus={onFocus}
                        onBlur={onBlur}
                        placeholder="Plan, ask, build…"
                        placeholderTextColor={theme.colors.textSecondary}
                        selectionColor={theme.colors.text}
                        returnKeyType="send"
                        autoCorrect
                        style={styles.input}
                    />
                )}
                <BubblePressable
                    onPress={onSend}
                    disabled={!canSubmit}
                    style={[styles.sendButton, canSubmit && styles.sendButtonActive]}
                    accessibilityRole="button"
                    accessibilityLabel="Send"
                >
                    {isSubmitting ? (
                        <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                    ) : (
                        <Ionicons
                            name="arrow-up"
                            size={16}
                            color={canSubmit
                                ? theme.dark ? '#111111' : theme.colors.button.primary.tint
                                : theme.colors.textSecondary}
                        />
                    )}
                </BubblePressable>
            </View>
        </MobileGlassSurface>
    );

    const submit = async () => {
        if (!canSubmit) return false;
        useNewSessionDraft.getState().setAttachments(expImageUpload ? selectedImages : []);
        const started = await onSubmit();
        if (started) clearImages();
        return started;
    };

    const submitFromFocusMode = () => {
        if (!canSubmit) return;
        setFocusedComposerMenu(null);
        setFocusModeVisible(false);
        setIsFocused(false);
        void submit();
    };

    const renderFocusedComposer = () => (
        <Animated.View style={[styles.focusedComposerAnimationShell, focusedComposerAnimationStyle]}>
            <MobileGlassSurface
                nativeEffect
                material="frosted"
                intensity={92}
                style={[
                    styles.focusedComposerSurface,
                    styles.focusedComposerAnchored,
                    { height: focusedComposerHeight },
                ]}
            >
                <View style={styles.focusedComposerContent}>
                    {expImageUpload && selectedImages.length > 0 && (
                        <Animated.View style={focusedInputRevealStyle}>
                            <AgentInputAttachmentStrip images={selectedImages} onRemove={removeImage} />
                        </Animated.View>
                    )}
                    <Animated.View style={[
                        styles.focusedInputReveal,
                        { height: focusedInputContainerHeight },
                        focusedInputRevealStyle,
                    ]}>
                        <Text
                            accessible={false}
                            pointerEvents="none"
                            onLayout={handleFocusedInputMeasurement}
                            style={styles.focusedInputMeasurement}
                        >
                            {prompt || ' '}
                        </Text>
                        <TextInput
                            ref={focusedInputRef}
                            value={prompt}
                            onChangeText={onPromptChange}
                            onFocus={() => setIsFocused(true)}
                            placeholder="Ask Codex"
                            placeholderTextColor={theme.colors.textSecondary}
                            selectionColor={theme.colors.text}
                            autoCorrect
                            multiline
                            scrollEnabled={focusedInputLayout.scrollEnabled}
                            style={[styles.focusedInput, { height: focusedInputLayout.height }]}
                        />
                    </Animated.View>
                    <Animated.View style={[styles.focusedComposerActions, focusedActionsRevealStyle]}>
                        <BubblePressable
                            onPress={() => toggleFocusedComposerMenu('add')}
                            style={({ pressed }) => [
                                styles.sideButton,
                                (pressed || focusedComposerMenu === 'add') && styles.focusedControlActive,
                            ]}
                            scaleFeedback={false}
                            accessibilityRole="button"
                            accessibilityLabel={t('settingsFeatures.imageUpload')}
                            accessibilityState={{ expanded: focusedComposerMenu === 'add' }}
                        >
                            <Ionicons
                                name="add"
                                size={MOBILE_COMPOSER_METRICS.addIconSize}
                                color={theme.colors.text}
                            />
                        </BubblePressable>
                        {currentPermission ? (
                            <BubblePressable
                                onPress={() => toggleFocusedComposerMenu('permission')}
                                style={({ pressed }) => [
                                    styles.focusedControlButton,
                                    styles.focusedPermissionButton,
                                    (pressed || focusedComposerMenu === 'permission') && styles.focusedControlActive,
                                ]}
                                scaleFeedback={false}
                                accessibilityRole="button"
                                accessibilityLabel={`${t('agentInput.codexPermissionMode.title')}: ${currentPermission.name}`}
                                accessibilityState={{ expanded: focusedComposerMenu === 'permission' }}
                            >
                                <Ionicons
                                    name={getPermissionIcon(currentPermission.key)}
                                    size={17}
                                    color={currentPermission.key === 'safe-yolo' || currentPermission.key === 'yolo'
                                        ? '#F97316'
                                        : theme.colors.text}
                                />
                                <Text
                                    style={[
                                        styles.focusedControlText,
                                        (currentPermission.key === 'safe-yolo' || currentPermission.key === 'yolo')
                                            && { color: '#F97316' },
                                    ]}
                                    numberOfLines={1}
                                >
                                    {currentPermission.name}
                                </Text>
                            </BubblePressable>
                        ) : null}
                        <View style={{ flex: 1 }} />
                        {currentModel ? (
                            <BubblePressable
                                onPress={() => toggleFocusedComposerMenu('model')}
                                style={({ pressed }) => [
                                    styles.focusedControlButton,
                                    styles.focusedModelButton,
                                    (pressed || focusedComposerMenu === 'model') && styles.focusedControlActive,
                                ]}
                                scaleFeedback={false}
                                accessibilityRole="button"
                                accessibilityLabel={`${t('agentInput.model.title')}: ${currentModel.name}`}
                                accessibilityState={{ expanded: focusedComposerMenu === 'model' }}
                            >
                                <Text style={styles.focusedControlText} numberOfLines={1}>
                                    {currentModel.name}
                                </Text>
                            </BubblePressable>
                        ) : (
                            <Text style={styles.focusedControlText} numberOfLines={1}>{currentAgent.name}</Text>
                        )}
                        {currentEffort ? (
                            <BubblePressable
                                onPress={() => toggleFocusedComposerMenu('effort')}
                                style={({ pressed }) => [
                                    styles.focusedControlButton,
                                    styles.focusedEffortButton,
                                    (pressed || focusedComposerMenu === 'effort') && styles.focusedControlActive,
                                ]}
                                scaleFeedback={false}
                                accessibilityRole="button"
                                accessibilityLabel={`${t('agentInput.effort.title')}: ${currentEffort.name}`}
                                accessibilityState={{ expanded: focusedComposerMenu === 'effort' }}
                            >
                                <Text style={styles.focusedControlText} numberOfLines={1}>
                                    {currentEffort.name}
                                </Text>
                                {!narrowComposerControls && (
                                    <Ionicons name="chevron-down" size={13} color={theme.colors.textSecondary} />
                                )}
                            </BubblePressable>
                        ) : null}
                        <BubblePressable
                            onPress={submitFromFocusMode}
                            disabled={!canSubmit}
                            style={[styles.sendButton, canSubmit && styles.sendButtonActive]}
                            accessibilityRole="button"
                            accessibilityLabel="Send"
                        >
                        {isSubmitting ? (
                            <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                        ) : (
                            <Ionicons
                                name="arrow-up"
                                size={16}
                                color={canSubmit
                                    ? theme.dark ? '#111111' : theme.colors.button.primary.tint
                                    : theme.colors.textSecondary}
                            />
                        )}
                        </BubblePressable>
                    </Animated.View>
                </View>
            </MobileGlassSurface>
        </Animated.View>
    );

    return (
        <>
            <Animated.View
                pointerEvents="box-none"
                style={[styles.keyboardFollower, keyboardStyle]}
            >
                {showBottomBackdrop && (
                    <View pointerEvents="none" style={styles.bottomBackdrop}>
                        <MobileHeaderScrim variant="strong" edge="bottom" />
                    </View>
                )}
                <View
                    pointerEvents="box-none"
                    style={[
                        styles.safeArea,
                        { paddingBottom: isFocused ? 8 : Math.max(10, safeArea.bottom) },
                    ]}
                >
                    {renderComposer({
                        ref: inputRef,
                        onFocus: openFocusMode,
                        onBlur: () => {
                            if (!focusModeVisible) setIsFocused(false);
                        },
                        onSend: submit,
                        activateOnPress: openFocusMode,
                    })}
                </View>
            </Animated.View>

            <RNModal
                visible={focusModeVisible}
                transparent
                animationType="none"
                onRequestClose={dismissFocusedMenuOrClose}
            >
                <View style={styles.modalRoot}>
                    <Animated.View
                        pointerEvents="box-none"
                        style={[styles.modalBackdrop, styles.focusBackdrop, focusBackdropStyle]}
                    >
                        <Pressable
                            style={styles.modalBackdrop}
                            onPress={dismissFocusedMenuOrClose}
                        />
                    </Animated.View>
                    {/* No back affordance here on purpose: tapping the backdrop
                        already closes focus mode, and a floating chevron over the
                        session list is redundant chrome. */}

                    <Animated.View style={[styles.focusDock, keyboardStyle]}>
                        <View style={styles.focusConfig}>
                            <View style={styles.focusConfigGroup}>
                                {renderEnvironmentPickers()}
                            </View>
                        </View>
                        <View style={[
                            styles.focusComposerArea,
                            { paddingBottom: safeArea.bottom + 8 },
                        ]}>
                            {focusedComposerMenu ? (
                                <View
                                    style={[
                                        styles.focusedMenuPosition,
                                        { bottom: focusedComposerHeight + safeArea.bottom + 20 },
                                    ]}
                                >
                                    <ComposerControlMenu
                                        accessibilityLabel={
                                            focusedComposerMenu === 'add'
                                                ? t('settingsFeatures.imageUpload')
                                                : focusedComposerMenu === 'permission'
                                                    ? t('agentInput.codexPermissionMode.title')
                                                    : focusedComposerMenu === 'model'
                                                        ? t('agentInput.model.title')
                                                        : t('agentInput.effort.title')
                                        }
                                        sections={focusedComposerMenuSections}
                                        maxHeight={360}
                                        presentation={focusedComposerMenu === 'model' || focusedComposerMenu === 'effort'
                                            ? 'choice'
                                            : 'default'}
                                        style={focusedComposerMenu === 'model' || focusedComposerMenu === 'effort'
                                            ? {
                                                width: getComposerChoiceMenuWidth(focusedComposerMenu, viewportWidth),
                                                alignSelf: 'flex-end',
                                            }
                                            : styles.focusedMenuLeft}
                                    />
                                </View>
                            ) : null}
                            {renderFocusedComposer()}
                        </View>
                    </Animated.View>
                </View>
            </RNModal>

        </>
    );
});
