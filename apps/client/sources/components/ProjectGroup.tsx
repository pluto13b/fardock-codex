import React from 'react';
import { View, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { ProjectGroupData, ProjectWorkspaceGroup, useAllMachines, useLocalSettingMutable } from '@/sync/storage';
import { CompactSessionRow } from './ActiveSessionsGroupCompact';

interface ProjectGroupProps {
    project: ProjectGroupData;
    selectedSessionId?: string;
    presentation?: 'default' | 'sidebar';
}

/**
 * One project and its sessions. Rig projects may contain named worktrees;
 * Happy CLI projects use a single workspace derived from their working path.
 */
export const ProjectGroup = React.memo(({ project, selectedSessionId, presentation = 'default' }: ProjectGroupProps) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const machines = useAllMachines();
    const [collapsedProjects, setCollapsedProjects] = useLocalSettingMutable('collapsedProjects');
    const collapsed = !!collapsedProjects[project.id];
    const sidebarPresentation = presentation === 'sidebar';

    const toggleCollapsed = React.useCallback(() => {
        setCollapsedProjects({ ...collapsedProjects, [project.id]: !collapsed });
    }, [collapsed, collapsedProjects, project.id, setCollapsedProjects]);

    const machineName = React.useMemo(() => {
        if (!project.machineId) return null;
        const machine = machines.find(m => m.id === project.machineId);
        return machine?.metadata?.displayName || machine?.metadata?.host || null;
    }, [machines, project.machineId]);

    // Worktrees only need naming when the project actually has more than one
    const showWorkspaceLabels = project.workspaces.length > 1;

    return (
        <View style={[styles.container, sidebarPresentation && styles.sidebarContainer]}>
            <Pressable
                style={[styles.header, sidebarPresentation && styles.sidebarHeader]}
                onPress={toggleCollapsed}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityState={{ expanded: !collapsed }}
            >
                <Ionicons
                    name={sidebarPresentation
                        ? (collapsed ? 'folder-outline' : 'folder-open-outline')
                        : (collapsed ? 'chevron-forward' : 'chevron-down')}
                    size={sidebarPresentation ? 15 : 16}
                    color={theme.colors.textSecondary}
                    style={sidebarPresentation ? styles.sidebarFolderIcon : styles.chevron}
                />
                <View style={styles.headerText}>
                    <Text style={[styles.title, sidebarPresentation && styles.sidebarTitle]} numberOfLines={1}>
                        {project.name}
                    </Text>
                    {!sidebarPresentation && machineName && (
                        <Text style={styles.subtitle} numberOfLines={1}>
                            {machineName}
                        </Text>
                    )}
                </View>
                {!sidebarPresentation && (
                    <Text style={styles.count}>
                        {project.activeCount > 0 ? `${project.activeCount}/${project.sessionCount}` : project.sessionCount}
                    </Text>
                )}
            </Pressable>

            {!collapsed && project.workspaces.map(workspace => (
                <WorkspaceSection
                    key={workspace.id || 'primary'}
                    workspace={workspace}
                    showLabel={showWorkspaceLabels}
                    selectedSessionId={selectedSessionId}
                    presentation={presentation}
                />
            ))}
        </View>
    );
});

const WorkspaceSection = React.memo(({ workspace, showLabel, selectedSessionId, presentation = 'default' }: {
    workspace: ProjectWorkspaceGroup;
    showLabel: boolean;
    selectedSessionId?: string;
    presentation?: 'default' | 'sidebar';
}) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const sidebarPresentation = presentation === 'sidebar';

    return (
        <View style={[styles.workspace, sidebarPresentation && styles.sidebarWorkspace]}>
            {showLabel && (
                <View style={[styles.workspaceHeader, sidebarPresentation && styles.sidebarWorkspaceHeader]}>
                    <Ionicons
                        name={workspace.name ? 'git-branch-outline' : 'folder-outline'}
                        size={13}
                        color={theme.colors.textSecondary}
                    />
                    <Text style={styles.workspaceTitle} numberOfLines={1}>
                        {workspace.name ?? 'main'}
                    </Text>
                </View>
            )}
            {workspace.sessions.map((session, index) => (
                <CompactSessionRow
                    key={session.id}
                    session={session}
                    selected={session.id === selectedSessionId}
                    showBorder={index > 0}
                    presentation={presentation}
                />
            ))}
        </View>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        backgroundColor: theme.colors.surface,
        marginHorizontal: 8,
        marginBottom: 8,
        borderRadius: 12,
        overflow: 'hidden',
    },
    sidebarContainer: {
        backgroundColor: 'transparent',
        marginHorizontal: 0,
        marginBottom: 4,
        borderRadius: 0,
        overflow: 'visible',
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 12,
        paddingVertical: 10,
        gap: 6,
    },
    sidebarHeader: {
        minHeight: 34,
        paddingHorizontal: 14,
        paddingVertical: 6,
        gap: 8,
    },
    chevron: {
        width: 16,
    },
    sidebarFolderIcon: {
        width: 16,
    },
    headerText: {
        flex: 1,
        minWidth: 0,
    },
    title: {
        fontSize: 15,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    sidebarTitle: {
        fontSize: 13,
        lineHeight: 18,
        fontWeight: '500',
        ...Typography.default('regular'),
    },
    subtitle: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        marginTop: 1,
        ...Typography.default(),
    },
    count: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    workspace: {
        paddingLeft: 10,
    },
    sidebarWorkspace: {
        paddingLeft: 0,
    },
    workspaceHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
        paddingHorizontal: 12,
        paddingTop: 8,
        paddingBottom: 4,
    },
    sidebarWorkspaceHeader: {
        paddingHorizontal: 38,
        paddingTop: 4,
        paddingBottom: 2,
    },
    workspaceTitle: {
        flex: 1,
        fontSize: 12,
        color: theme.colors.textSecondary,
        ...Typography.default('semiBold'),
    },
}));
