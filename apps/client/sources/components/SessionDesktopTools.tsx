import * as Clipboard from 'expo-clipboard';
import { Ionicons } from '@expo/vector-icons';
import * as React from 'react';
import { Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { useMachine, useSessionGitStatus, useSessionMessages } from '@/sync/storage';
import type { Session } from '@/sync/storageTypes';
import {
    extractSessionSources,
    getGitChangeStats,
    getPathShortName,
    getSubagentStats,
} from './sessionDesktopToolsData';

type SessionDesktopToolsProps = {
    sessionId: string;
    session: Session;
    canUseFileSidebar: boolean;
    fileSidebarOpen: boolean;
    onToggleFileSidebar: () => void;
    onOpenChanges: () => void;
};

type OpenMenu = 'location' | 'environment' | null;

const PANEL_BACKGROUND_DARK = '#2D2D2D';
const PANEL_BORDER_DARK = '#3E3E3E';

function IconButton(props: {
    icon: React.ComponentProps<typeof Ionicons>['name'];
    label: string;
    active?: boolean;
    disabled?: boolean;
    transparent?: boolean;
    onPress: () => void;
}) {
    const { theme } = useUnistyles();
    return (
        <Pressable
            accessibilityRole="button"
            accessibilityLabel={props.label}
            accessibilityState={{ disabled: props.disabled, selected: props.active }}
            disabled={props.disabled}
            onPress={props.onPress}
            style={({ pressed }) => [
                styles.iconButton,
                !props.transparent && {
                    backgroundColor: props.active || pressed
                        ? theme.dark ? '#303030' : theme.colors.surfaceHigh
                        : theme.dark ? '#222222' : theme.colors.surface,
                },
                props.disabled && styles.disabled,
            ]}
        >
            <Ionicons
                name={props.icon}
                size={15}
                color={props.active ? theme.colors.text : theme.colors.textSecondary}
            />
        </Pressable>
    );
}

function EnvironmentRow(props: {
    icon: React.ComponentProps<typeof Ionicons>['name'];
    label: string;
    value?: string;
    muted?: boolean;
    onPress?: () => void;
    trailingIcon?: React.ComponentProps<typeof Ionicons>['name'];
}) {
    const { theme } = useUnistyles();
    const content = (
        <>
            <Ionicons name={props.icon} size={16} color={theme.colors.textSecondary} />
            <Text
                numberOfLines={1}
                style={[
                    styles.environmentRowLabel,
                    { color: props.muted ? theme.colors.textSecondary : theme.colors.text },
                ]}
            >
                {props.label}
            </Text>
            {props.value ? (
                <Text numberOfLines={1} style={[styles.environmentRowValue, { color: theme.colors.textSecondary }]}>
                    {props.value}
                </Text>
            ) : null}
            {props.trailingIcon ? (
                <Ionicons name={props.trailingIcon} size={14} color={theme.colors.textSecondary} />
            ) : null}
        </>
    );

    if (!props.onPress) {
        return <View style={[styles.environmentRow, props.muted && styles.muted]}>{content}</View>;
    }
    return (
        <Pressable
            accessibilityRole="button"
            accessibilityLabel={props.label}
            onPress={props.onPress}
            style={({ pressed }) => [
                styles.environmentRow,
                pressed && { backgroundColor: theme.dark ? '#373737' : theme.colors.surfaceHigh },
            ]}
        >
            {content}
        </Pressable>
    );
}

export const SessionDesktopTools = React.memo(function SessionDesktopTools({
    sessionId,
    session,
    canUseFileSidebar,
    fileSidebarOpen,
    onToggleFileSidebar,
    onOpenChanges,
}: SessionDesktopToolsProps) {
    const { theme } = useUnistyles();
    const [openMenu, setOpenMenu] = React.useState<OpenMenu>(null);
    const [copyState, setCopyState] = React.useState<'idle' | 'copied' | 'failed'>('idle');
    const gitStatus = useSessionGitStatus(sessionId);
    const { messages } = useSessionMessages(sessionId);
    const machine = useMachine(session.metadata?.machineId ?? '__missing-machine__');
    const workspacePath = session.metadata?.path?.trim() ?? '';

    const gitStats = React.useMemo(() => getGitChangeStats(gitStatus), [gitStatus]);
    const subagents = React.useMemo(
        () => getSubagentStats(session.metadata?.activity?.subagents),
        [session.metadata?.activity?.subagents],
    );
    const sources = React.useMemo(() => extractSessionSources(messages, 4), [messages]);

    React.useEffect(() => {
        setOpenMenu(null);
        setCopyState('idle');
    }, [sessionId]);

    const toggleMenu = React.useCallback((menu: Exclude<OpenMenu, null>) => {
        setOpenMenu((current) => current === menu ? null : menu);
        setCopyState('idle');
    }, []);

    const copyWorkspacePath = React.useCallback(async () => {
        if (!workspacePath) return;
        try {
            await Clipboard.setStringAsync(workspacePath);
            setCopyState('copied');
        } catch {
            setCopyState('failed');
        }
    }, [workspacePath]);

    if (Platform.OS !== 'web') return null;

    const panelBackground = theme.dark ? PANEL_BACKGROUND_DARK : theme.colors.surface;
    const panelBorder = theme.dark ? PANEL_BORDER_DARK : theme.colors.divider;
    const machineName = machine?.metadata?.displayName
        || machine?.metadata?.host
        || session.metadata?.host
        || '不可用';
    const workspaceName = getPathShortName(workspacePath);
    const branchLabel = gitStatus?.branch || '不可用';
    const changesLabel = gitStats
        ? `${gitStats.entryCount} 个文件  +${gitStats.linesAdded}  -${gitStats.linesRemoved}`
        : '不可用';
    const subagentLabel = subagents
        ? [
            subagents.completed ? `${subagents.completed} 完成` : null,
            subagents.running ? `${subagents.running} 运行中` : null,
            subagents.queued ? `${subagents.queued} 排队` : null,
        ].filter(Boolean).join(' · ') || '暂无活动'
        : '不可用';

    return (
        <View style={styles.root}>
            {openMenu ? (
                <Pressable
                    accessibilityLabel="关闭任务工具菜单"
                    onPress={() => setOpenMenu(null)}
                    style={styles.pageBackdrop}
                />
            ) : null}

            <View style={styles.buttonRow}>
                <View style={styles.locationAnchor}>
                    <Pressable
                        accessibilityRole="button"
                        accessibilityLabel="打开位置"
                        accessibilityState={{ expanded: openMenu === 'location', disabled: !workspacePath }}
                        disabled={!workspacePath}
                        onPress={() => toggleMenu('location')}
                        style={({ pressed }) => [
                            styles.locationButton,
                            {
                                backgroundColor: openMenu === 'location' || pressed
                                    ? theme.dark ? '#252525' : theme.colors.surfaceHigh
                                    : theme.dark ? '#1F1F1F' : theme.colors.surface,
                                borderColor: theme.dark ? '#313131' : theme.colors.divider,
                            },
                            !workspacePath && styles.disabled,
                        ]}
                    >
                        <Ionicons name="folder-open-outline" size={15} color={theme.colors.textSecondary} />
                        <Text style={[styles.locationButtonText, { color: theme.colors.text }]}>打开位置</Text>
                        <Ionicons name="chevron-down" size={12} color={theme.colors.textSecondary} />
                    </Pressable>

                    {openMenu === 'location' ? (
                        <View style={[styles.locationMenu, { backgroundColor: panelBackground, borderColor: panelBorder }]}>
                            <Text style={[styles.menuSectionTitle, { color: theme.colors.textSecondary }]}>工作区位置</Text>
                            <Text numberOfLines={2} selectable style={[styles.locationPath, { color: theme.colors.text }]}>
                                {workspacePath}
                            </Text>
                            <Pressable
                                accessibilityRole="button"
                                accessibilityLabel="复制工作区路径"
                                onPress={() => void copyWorkspacePath()}
                                style={({ pressed }) => [
                                    styles.locationMenuRow,
                                    pressed && { backgroundColor: theme.dark ? '#393939' : theme.colors.surfaceHigh },
                                ]}
                            >
                                <Ionicons
                                    name={copyState === 'copied' ? 'checkmark' : copyState === 'failed' ? 'alert-circle-outline' : 'copy-outline'}
                                    size={16}
                                    color={theme.colors.textSecondary}
                                />
                                <View style={styles.menuRowText}>
                                    <Text style={[styles.menuRowLabel, { color: theme.colors.text }]}>
                                        {copyState === 'copied' ? '已复制路径' : copyState === 'failed' ? '复制失败' : '复制路径'}
                                    </Text>
                                </View>
                            </Pressable>
                            <View style={[styles.locationMenuRow, styles.disabled]}>
                                <Ionicons name="desktop-outline" size={16} color={theme.colors.textSecondary} />
                                <View style={styles.menuRowText}>
                                    <Text style={[styles.menuRowLabel, { color: theme.colors.textSecondary }]}>在 Windows 上打开</Text>
                                    <Text style={[styles.menuRowDescription, { color: theme.colors.textSecondary }]}>等待本机 Agent 接通</Text>
                                </View>
                            </View>
                        </View>
                    ) : null}
                </View>

                <IconButton
                    icon="options-outline"
                    label="环境信息"
                    active={openMenu === 'environment'}
                    onPress={() => toggleMenu('environment')}
                />
                <IconButton
                    icon="albums-outline"
                    label={fileSidebarOpen ? '关闭文件侧栏' : '打开文件侧栏'}
                    active={fileSidebarOpen}
                    disabled={!canUseFileSidebar}
                    transparent
                    onPress={onToggleFileSidebar}
                />
            </View>

            {openMenu === 'environment' ? (
                <View
                    accessibilityRole="summary"
                    style={[
                        styles.environmentPanel,
                        { backgroundColor: panelBackground, borderColor: panelBorder },
                    ]}
                >
                    <ScrollView
                        bounces={false}
                        showsVerticalScrollIndicator={false}
                        contentContainerStyle={styles.environmentPanelContent}
                    >
                        <Text style={[styles.sectionTitle, { color: theme.colors.textSecondary }]}>环境信息</Text>
                        <EnvironmentRow
                            icon="git-compare-outline"
                            label="变更"
                            value={changesLabel}
                            onPress={canUseFileSidebar && gitStats ? onOpenChanges : undefined}
                            trailingIcon={canUseFileSidebar && gitStats ? 'chevron-forward' : undefined}
                            muted={!gitStats}
                        />
                        <EnvironmentRow icon="laptop-outline" label={machineName} value={workspaceName} />
                        <EnvironmentRow icon="git-branch-outline" label={branchLabel} muted={!gitStatus?.branch} />
                        <EnvironmentRow icon="git-commit-outline" label="提交或推送" value="等待本机 Agent" muted />
                        <EnvironmentRow icon="logo-github" label="拉取请求状态不可用" muted />

                        <View style={[styles.divider, { backgroundColor: panelBorder }]} />
                        <Text style={[styles.sectionTitle, { color: theme.colors.textSecondary }]}>子智能体</Text>
                        <View style={styles.subagentRow}>
                            <View style={styles.subagentDots}>
                                {['#A880FF', '#55B8D8', '#6E8DFF', '#D65A96'].map((color, index) => (
                                    <View key={color} style={[styles.subagentDot, { backgroundColor: color, opacity: index < Math.min(subagents?.total ?? 0, 4) ? 1 : 0.18 }]} />
                                ))}
                            </View>
                            <Text numberOfLines={1} style={[styles.subagentText, { color: theme.colors.textSecondary }]}>
                                {subagentLabel}
                            </Text>
                        </View>

                        <View style={[styles.divider, { backgroundColor: panelBorder }]} />
                        <Text style={[styles.sectionTitle, { color: theme.colors.textSecondary }]}>来源</Text>
                        {sources.length ? sources.map((source) => (
                            <View key={source.key} style={styles.sourceRow}>
                                <Ionicons
                                    name={source.kind === 'image' ? 'image-outline' : 'document-outline'}
                                    size={16}
                                    color={theme.colors.textSecondary}
                                />
                                <Text
                                    numberOfLines={1}
                                    accessibilityLabel={source.path}
                                    style={[styles.sourceLabel, { color: theme.colors.textSecondary }]}
                                >
                                    {source.label}
                                </Text>
                            </View>
                        )) : (
                            <View style={styles.sourceRow}>
                                <Ionicons name="link-outline" size={16} color={theme.colors.textSecondary} />
                                <Text style={[styles.sourceLabel, { color: theme.colors.textSecondary }]}>暂无已加载来源</Text>
                            </View>
                        )}
                    </ScrollView>
                </View>
            ) : null}
        </View>
    );
});

const styles = StyleSheet.create(() => ({
    root: {
        position: 'relative',
        zIndex: 4,
    },
    pageBackdrop: {
        position: Platform.OS === 'web' ? 'fixed' as any : 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        zIndex: 1,
    },
    buttonRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 7,
        position: 'relative',
        zIndex: 3,
    },
    locationAnchor: {
        position: 'relative',
        zIndex: 5,
    },
    locationButton: {
        height: 28,
        borderRadius: 10,
        borderWidth: 1,
        paddingHorizontal: 10,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 7,
    },
    locationButtonText: {
        fontSize: 14,
        lineHeight: 20,
        fontWeight: '500',
    },
    iconButton: {
        width: 28,
        height: 28,
        borderRadius: 9,
        alignItems: 'center',
        justifyContent: 'center',
    },
    disabled: {
        opacity: 0.42,
    },
    locationMenu: {
        position: 'absolute',
        top: 38,
        right: 0,
        width: 272,
        borderRadius: 16,
        borderWidth: 1,
        padding: 10,
        shadowColor: '#000000',
        shadowOffset: { width: 0, height: 8 },
        shadowOpacity: 0.28,
        shadowRadius: 24,
        zIndex: 8,
    },
    menuSectionTitle: {
        fontSize: 12,
        lineHeight: 18,
        fontWeight: '600',
        paddingHorizontal: 8,
        paddingTop: 4,
    },
    locationPath: {
        fontSize: 12,
        lineHeight: 18,
        paddingHorizontal: 8,
        paddingTop: 2,
        paddingBottom: 8,
    },
    locationMenuRow: {
        minHeight: 40,
        borderRadius: 10,
        paddingHorizontal: 8,
        paddingVertical: 7,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
    },
    menuRowText: {
        flex: 1,
        minWidth: 0,
    },
    menuRowLabel: {
        fontSize: 14,
        lineHeight: 19,
    },
    menuRowDescription: {
        fontSize: 11,
        lineHeight: 15,
    },
    environmentPanel: {
        position: 'absolute',
        top: 48,
        right: 0,
        width: 300,
        maxWidth: 'calc(100vw - 32px)' as any,
        maxHeight: 'calc(100vh - 64px)' as any,
        borderRadius: 24,
        borderWidth: StyleSheet.hairlineWidth,
        overflow: 'hidden',
        shadowColor: '#000000',
        shadowOffset: { width: 0, height: 8 },
        shadowOpacity: 0.28,
        shadowRadius: 24,
        zIndex: 8,
    },
    environmentPanelContent: {
        paddingHorizontal: 16,
        paddingVertical: 14,
    },
    sectionTitle: {
        fontSize: 14,
        lineHeight: 20,
        fontWeight: '600',
        marginBottom: 6,
    },
    environmentRow: {
        minHeight: 32,
        borderRadius: 9,
        paddingHorizontal: 2,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 11,
    },
    environmentRowLabel: {
        flexShrink: 1,
        minWidth: 0,
        fontSize: 14,
        lineHeight: 20,
    },
    environmentRowValue: {
        flex: 1,
        minWidth: 0,
        textAlign: 'right',
        fontSize: 12,
        lineHeight: 18,
    },
    muted: {
        opacity: 0.72,
    },
    divider: {
        height: StyleSheet.hairlineWidth,
        marginVertical: 15,
    },
    subagentRow: {
        minHeight: 32,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    subagentDots: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
    },
    subagentDot: {
        width: 11,
        height: 11,
        borderRadius: 6,
    },
    subagentText: {
        flex: 1,
        minWidth: 0,
        fontSize: 13,
        lineHeight: 18,
    },
    sourceRow: {
        minHeight: 32,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 11,
    },
    sourceLabel: {
        flex: 1,
        minWidth: 0,
        fontSize: 14,
        lineHeight: 20,
    },
}));
