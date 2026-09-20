import * as Clipboard from 'expo-clipboard';
import { Ionicons } from '@expo/vector-icons';
import * as React from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { useMachine, useSessionGitStatus, useSessionMessages } from '@/sync/storage';
import type { Session } from '@/sync/storageTypes';
import { resolveStatusBarGitBranch } from '@/utils/sessionStatusBar';
import { MobileBottomSheet } from './MobileBottomSheet';
import {
    extractSessionSources,
    getGitChangeStats,
    getPathShortName,
    getSubagentStats,
} from './sessionDesktopToolsData';

type SheetPage = 'overview' | 'location' | 'sources';

type SessionMobileTaskToolsProps = {
    sessionId: string;
    session: Session;
    canOpenChanges: boolean;
    changesUnavailableReason?: string;
    onOpenChanges: () => void;
};

function SheetRow(props: {
    icon: React.ComponentProps<typeof Ionicons>['name'];
    label: string;
    value?: string;
    description?: string;
    muted?: boolean;
    disabled?: boolean;
    trailingIcon?: React.ComponentProps<typeof Ionicons>['name'];
    onPress?: () => void;
}) {
    const { theme } = useUnistyles();
    const interactive = Boolean(props.onPress) && !props.disabled;
    const content = (
        <>
            <Ionicons name={props.icon} size={17} color={theme.colors.textSecondary} />
            <View style={styles.rowTextBlock}>
                <Text
                    numberOfLines={1}
                    style={[
                        styles.rowLabel,
                        { color: props.muted || props.disabled ? theme.colors.textSecondary : theme.colors.text },
                    ]}
                >
                    {props.label}
                </Text>
                {props.description ? (
                    <Text numberOfLines={2} style={[styles.rowDescription, { color: theme.colors.textSecondary }]}>
                        {props.description}
                    </Text>
                ) : null}
            </View>
            {props.value ? (
                <Text numberOfLines={1} style={[styles.rowValue, { color: theme.colors.textSecondary }]}>
                    {props.value}
                </Text>
            ) : null}
            {props.trailingIcon ? (
                <Ionicons name={props.trailingIcon} size={15} color={theme.colors.textSecondary} />
            ) : null}
        </>
    );

    if (!interactive) {
        return (
            <View
                accessibilityRole={props.disabled ? 'text' : undefined}
                accessibilityLabel={props.description ? `${props.label}，${props.description}` : props.label}
                style={[styles.row, (props.muted || props.disabled) && styles.muted]}
            >
                {content}
            </View>
        );
    }

    return (
        <Pressable
            accessibilityRole="button"
            accessibilityLabel={props.label}
            onPress={props.onPress}
            style={({ pressed }) => [
                styles.row,
                pressed && { backgroundColor: theme.dark ? '#3D3D3D' : theme.colors.surfaceHigh },
            ]}
        >
            {content}
        </Pressable>
    );
}

export const SessionMobileTaskTools = React.memo(function SessionMobileTaskTools({
    sessionId,
    session,
    canOpenChanges,
    changesUnavailableReason = '当前任务未声明文件浏览与 shell 能力',
    onOpenChanges,
}: SessionMobileTaskToolsProps) {
    const { theme } = useUnistyles();
    const [visible, setVisible] = React.useState(false);
    const [page, setPage] = React.useState<SheetPage>('overview');
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
    const allSources = React.useMemo(() => extractSessionSources(messages, 80), [messages]);
    const recentSources = allSources.slice(0, 4);

    React.useEffect(() => {
        setVisible(false);
        setPage('overview');
        setCopyState('idle');
    }, [sessionId]);

    const closeSheet = React.useCallback(() => {
        setVisible(false);
        setPage('overview');
        setCopyState('idle');
    }, []);

    const openSheet = React.useCallback(() => {
        setPage('overview');
        setCopyState('idle');
        setVisible(true);
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

    const openChanges = React.useCallback(() => {
        if (!canOpenChanges || !gitStats) return;
        closeSheet();
        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(onOpenChanges);
        } else {
            setTimeout(onOpenChanges, 0);
        }
    }, [canOpenChanges, closeSheet, gitStats, onOpenChanges]);

    const machineName = machine?.metadata?.displayName
        || machine?.metadata?.host
        || session.metadata?.host
        || '不可用';
    const workspaceName = getPathShortName(workspacePath);
    const metadataBranch = typeof session.metadata?.gitBranch === 'string'
        ? session.metadata.gitBranch
        : undefined;
    const branch = resolveStatusBarGitBranch(gitStatus?.branch, metadataBranch);
    const branchLabel = branch || '不可用';
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
    const hasAttention = session.presence !== 'online' || Boolean(subagents?.running || subagents?.queued);

    const title = page === 'location' ? '工作区位置' : page === 'sources' ? '全部来源' : '环境信息';

    return (
        <View style={styles.root}>
            <Pressable
                accessibilityRole="button"
                accessibilityLabel={hasAttention ? '环境信息，有状态更新' : '环境信息'}
                accessibilityState={{ expanded: visible }}
                onPress={openSheet}
                style={({ pressed }) => [
                    styles.trigger,
                    { backgroundColor: pressed || visible ? theme.dark ? '#303030' : theme.colors.surfaceHigh : 'transparent' },
                ]}
            >
                <Ionicons name="options-outline" size={20} color={theme.colors.header.tint} />
                {hasAttention ? <View style={[styles.attentionDot, { backgroundColor: session.presence === 'online' ? '#3B82F6' : '#F59E0B' }]} /> : null}
            </Pressable>

            <MobileBottomSheet visible={visible} title={title} onClose={closeSheet}>
                {page === 'overview' ? (
                    <ScrollView
                        bounces={false}
                        showsVerticalScrollIndicator={false}
                        keyboardShouldPersistTaps="handled"
                        contentContainerStyle={styles.content}
                    >
                        <SheetRow
                            icon="git-compare-outline"
                            label="变更"
                            value={changesLabel}
                            description={!canOpenChanges && gitStats ? changesUnavailableReason : undefined}
                            onPress={canOpenChanges && gitStats ? openChanges : undefined}
                            trailingIcon={canOpenChanges && gitStats ? 'chevron-forward' : undefined}
                            muted={!gitStats || !canOpenChanges}
                            disabled={!canOpenChanges && Boolean(gitStats)}
                        />
                        <SheetRow
                            icon="laptop-outline"
                            label={machineName}
                            value={workspaceName}
                            onPress={workspacePath ? () => setPage('location') : undefined}
                            trailingIcon={workspacePath ? 'chevron-forward' : undefined}
                            muted={!workspacePath}
                        />
                        <SheetRow icon="git-branch-outline" label={branchLabel} muted={!branch} />
                        <SheetRow icon="git-commit-outline" label="提交或推送" value="等待本机 Agent" muted disabled />
                        <SheetRow icon="logo-github" label="拉取请求状态不可用" muted disabled />

                        <View style={[styles.divider, { backgroundColor: theme.dark ? '#3E3E3E' : theme.colors.divider }]} />
                        <Text style={[styles.sectionTitle, { color: theme.colors.textSecondary }]}>子智能体</Text>
                        <View style={styles.subagentRow}>
                            <View style={styles.subagentDots}>
                                {['#A880FF', '#55B8D8', '#6E8DFF', '#D65A96'].map((color, index) => (
                                    <View
                                        key={color}
                                        style={[
                                            styles.subagentDot,
                                            { backgroundColor: color, opacity: index < Math.min(subagents?.total ?? 0, 4) ? 1 : 0.18 },
                                        ]}
                                    />
                                ))}
                            </View>
                            <Text numberOfLines={1} style={[styles.subagentText, { color: theme.colors.textSecondary }]}>
                                {subagentLabel}
                            </Text>
                        </View>

                        <View style={[styles.divider, { backgroundColor: theme.dark ? '#3E3E3E' : theme.colors.divider }]} />
                        <Text style={[styles.sectionTitle, { color: theme.colors.textSecondary }]}>来源</Text>
                        {recentSources.length ? recentSources.map((source) => (
                            <View key={source.key} style={styles.sourceRow}>
                                <Ionicons
                                    name={source.kind === 'image' ? 'image-outline' : 'document-outline'}
                                    size={17}
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
                                <Ionicons name="link-outline" size={17} color={theme.colors.textSecondary} />
                                <Text style={[styles.sourceLabel, { color: theme.colors.textSecondary }]}>暂无已加载来源</Text>
                            </View>
                        )}
                        {allSources.length ? (
                            <SheetRow
                                icon="link-outline"
                                label="查看全部"
                                value={`${allSources.length}`}
                                trailingIcon="chevron-forward"
                                onPress={() => setPage('sources')}
                            />
                        ) : null}
                    </ScrollView>
                ) : page === 'location' ? (
                    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
                        <Pressable
                            accessibilityRole="button"
                            accessibilityLabel="返回环境信息"
                            onPress={() => setPage('overview')}
                            style={({ pressed }) => [styles.subpageBack, pressed && { backgroundColor: theme.dark ? '#3D3D3D' : theme.colors.surfaceHigh }]}
                        >
                            <Ionicons name="arrow-back" size={19} color={theme.colors.textSecondary} />
                            <Text style={[styles.subpageBackText, { color: theme.colors.text }]}>返回环境信息</Text>
                        </Pressable>
                        <Text selectable style={[styles.pathText, { color: theme.colors.text }]}>{workspacePath || '不可用'}</Text>
                        <SheetRow
                            icon={copyState === 'copied' ? 'checkmark' : copyState === 'failed' ? 'alert-circle-outline' : 'copy-outline'}
                            label={copyState === 'copied' ? '已复制路径' : copyState === 'failed' ? '复制失败' : '复制路径'}
                            onPress={workspacePath ? () => void copyWorkspacePath() : undefined}
                            muted={!workspacePath}
                        />
                        <SheetRow
                            icon="desktop-outline"
                            label="在工作电脑打开"
                            description="等待 Windows Agent 接通真实打开能力"
                            muted
                            disabled
                        />
                    </ScrollView>
                ) : (
                    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
                        <Pressable
                            accessibilityRole="button"
                            accessibilityLabel="返回环境信息"
                            onPress={() => setPage('overview')}
                            style={({ pressed }) => [styles.subpageBack, pressed && { backgroundColor: theme.dark ? '#3D3D3D' : theme.colors.surfaceHigh }]}
                        >
                            <Ionicons name="arrow-back" size={19} color={theme.colors.textSecondary} />
                            <Text style={[styles.subpageBackText, { color: theme.colors.text }]}>返回环境信息</Text>
                        </Pressable>
                        {allSources.map((source) => (
                            <View key={source.key} style={styles.sourceRowTall}>
                                <Ionicons
                                    name={source.kind === 'image' ? 'image-outline' : 'document-outline'}
                                    size={17}
                                    color={theme.colors.textSecondary}
                                />
                                <View style={styles.rowTextBlock}>
                                    <Text numberOfLines={1} style={[styles.rowLabel, { color: theme.colors.text }]}>{source.label}</Text>
                                    <Text numberOfLines={2} selectable style={[styles.rowDescription, { color: theme.colors.textSecondary }]}>{source.path}</Text>
                                </View>
                            </View>
                        ))}
                    </ScrollView>
                )}
            </MobileBottomSheet>
        </View>
    );
});

const styles = StyleSheet.create(() => ({
    root: {
        position: 'relative',
    },
    trigger: {
        width: 44,
        height: 44,
        borderRadius: 14,
        alignItems: 'center',
        justifyContent: 'center',
    },
    attentionDot: {
        position: 'absolute',
        top: 8,
        right: 8,
        width: 6,
        height: 6,
        borderRadius: 3,
    },
    content: {
        paddingHorizontal: 16,
        paddingBottom: 16,
    },
    row: {
        minHeight: 44,
        borderRadius: 10,
        paddingHorizontal: 2,
        paddingVertical: 7,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 11,
    },
    rowTextBlock: {
        flex: 1,
        minWidth: 0,
    },
    rowLabel: {
        fontSize: 14,
        lineHeight: 20,
    },
    rowDescription: {
        marginTop: 1,
        fontSize: 12,
        lineHeight: 17,
    },
    rowValue: {
        maxWidth: '46%',
        minWidth: 0,
        flexShrink: 1,
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
    sectionTitle: {
        fontSize: 14,
        lineHeight: 20,
        fontWeight: '600',
        marginBottom: 6,
    },
    subagentRow: {
        minHeight: 44,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 9,
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
        minHeight: 44,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 11,
    },
    sourceRowTall: {
        minHeight: 56,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 11,
        paddingVertical: 7,
    },
    sourceLabel: {
        flex: 1,
        minWidth: 0,
        fontSize: 14,
        lineHeight: 20,
    },
    subpageBack: {
        minHeight: 44,
        borderRadius: 10,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        marginBottom: 8,
        paddingHorizontal: 2,
    },
    subpageBackText: {
        fontSize: 14,
        lineHeight: 20,
        fontWeight: '500',
    },
    pathText: {
        borderRadius: 12,
        backgroundColor: 'rgba(127, 127, 127, 0.12)',
        paddingHorizontal: 12,
        paddingVertical: 10,
        fontSize: 13,
        lineHeight: 19,
        marginBottom: 8,
    },
}));
