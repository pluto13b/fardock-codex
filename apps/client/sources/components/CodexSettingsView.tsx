import * as React from 'react';
import { NativeScrollEvent, NativeSyntheticEvent, Platform, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { frontendPreviewEnabled } from '@/demo/frontendPreview';
import { Modal } from '@/modal';
import {
    getServerInfo,
    getServerUrl,
    setServerUrl,
    validateServerUrl,
} from '@/sync/serverConfig';
import {
    useAllMachines,
    useIsDataReady,
    useLocalSetting,
    useSocketStatus,
} from '@/sync/storage';
import { getCurrentLanguage, getLanguageNativeName } from '@/text';
import { openExternalUrl } from '@/utils/openExternalUrl';
import { Item } from './Item';
import { ItemGroup } from './ItemGroup';
import { ItemList } from './ItemList';
import { layout } from './layout';
import { Text } from './StyledText';

const HAPPY_LICENSE_URL = 'https://github.com/slopus/happy/blob/main/LICENSE';
const CODEX_LICENSE_URL = 'https://github.com/openai/codex/blob/main/LICENSE';

const stylesheet = StyleSheet.create((theme) => ({
    headerContainer: {
        width: '100%',
        maxWidth: layout.maxWidth,
        alignSelf: 'center',
        paddingHorizontal: Platform.select({ ios: 16, default: 12 }),
        paddingTop: 16,
    },
    headerCard: {
        alignItems: 'center',
        backgroundColor: theme.colors.surface,
        borderColor: theme.colors.divider,
        borderRadius: Platform.select({ web: 18, default: 16 }),
        borderWidth: Platform.OS === 'web' ? 0 : StyleSheet.hairlineWidth,
        paddingHorizontal: 24,
        paddingVertical: 24,
    },
    mark: {
        alignItems: 'center',
        justifyContent: 'center',
        width: 54,
        height: 54,
        borderRadius: 17,
        backgroundColor: theme.colors.surfaceHighest,
        marginBottom: 14,
    },
    title: {
        color: theme.colors.text,
        fontSize: 24,
        fontWeight: '600',
        lineHeight: 30,
    },
    statusRow: {
        alignItems: 'center',
        flexDirection: 'row',
        gap: 7,
        marginTop: 7,
    },
    statusDot: {
        width: 8,
        height: 8,
        borderRadius: 4,
    },
    statusText: {
        color: theme.colors.textSecondary,
        fontSize: 14,
        lineHeight: 20,
    },
}));

type Copy = {
    connection: string;
    connected: string;
    connecting: string;
    connectionError: string;
    disconnected: string;
    hostOffline: string;
    loading: string;
    localPreview: string;
    windowsHosts: string;
    noHost: string;
    noHostSubtitle: string;
    online: string;
    offline: string;
    lastOnline: string;
    relay: string;
    relaySubtitle: string;
    relayEditTitle: string;
    relayEditMessage: string;
    relayInvalid: string;
    relaySaved: string;
    save: string;
    display: string;
    appearance: string;
    appearanceSubtitle: string;
    language: string;
    languageSubtitle: string;
    adaptive: string;
    light: string;
    dark: string;
    security: string;
    securityBoundary: string;
    securityBoundarySubtitle: string;
    approvals: string;
    approvalsSubtitle: string;
    about: string;
    version: string;
    happyLicense: string;
    happyLicenseSubtitle: string;
    codexLicense: string;
    codexLicenseSubtitle: string;
    aboutFooter: string;
};

const COPY: Record<'en' | 'zh', Copy> = {
    en: {
        connection: 'Connection',
        connected: 'Connected',
        connecting: 'Connecting',
        connectionError: 'Connection error',
        disconnected: 'Not connected',
        hostOffline: 'Windows host offline',
        loading: 'Reading connection status',
        localPreview: 'Local preview',
        windowsHosts: 'Windows hosts',
        noHost: 'No Windows host connected',
        noHostSubtitle: 'Pair this device from the connection screen before sending tasks.',
        online: 'Online',
        offline: 'Offline',
        lastOnline: 'Last online',
        relay: 'Relay address',
        relaySubtitle: 'Traffic is sent only through your configured self-hosted Relay.',
        relayEditTitle: 'Relay address',
        relayEditMessage: 'Use HTTPS for remote addresses. HTTP is accepted only for loopback development.',
        relayInvalid: 'Invalid Relay address',
        relaySaved: 'Relay address saved',
        save: 'Save',
        display: 'Display',
        appearance: 'Appearance',
        appearanceSubtitle: 'Theme and conversation presentation',
        language: 'Language',
        languageSubtitle: 'Language used by this client',
        adaptive: 'System',
        light: 'Light',
        dark: 'Dark',
        security: 'Security',
        securityBoundary: 'Credentials stay on Windows',
        securityBoundarySubtitle: 'Codex Plus never asks for your OpenAI token. Account sign-in remains inside the Windows Codex client.',
        approvals: 'Fail-closed controls',
        approvalsSubtitle: 'When connection or approval state is unclear, remote actions stay read-only.',
        about: 'About and open source',
        version: 'Version',
        happyLicense: 'Happy client source (MIT)',
        happyLicenseSubtitle: 'The mobile client foundation is reused under the MIT license.',
        codexLicense: 'OpenAI Codex source (Apache-2.0)',
        codexLicenseSubtitle: 'Codex protocol and interface references follow the upstream license.',
        aboutFooter: 'Codex Plus is an independent, self-hosted client and is not an official OpenAI product.',
    },
    zh: {
        connection: '连接',
        connected: '已连接',
        connecting: '正在连接',
        connectionError: '连接错误',
        disconnected: '未连接',
        hostOffline: 'Windows 主机离线',
        loading: '正在读取连接状态',
        localPreview: '本地预览',
        windowsHosts: 'Windows 主机',
        noHost: '尚未连接 Windows 主机',
        noHostSubtitle: '请先从连接页完成配对，再发送任务。',
        online: '在线',
        offline: '离线',
        lastOnline: '最后在线',
        relay: 'Relay 地址',
        relaySubtitle: '流量只经过你配置的自托管 Relay。',
        relayEditTitle: 'Relay 地址',
        relayEditMessage: '远程地址必须使用 HTTPS；仅回环开发地址可使用 HTTP。',
        relayInvalid: 'Relay 地址无效',
        relaySaved: 'Relay 地址已保存',
        save: '保存',
        display: '显示',
        appearance: '外观',
        appearanceSubtitle: '主题与对话显示方式',
        language: '语言',
        languageSubtitle: '此客户端使用的界面语言',
        adaptive: '跟随系统',
        light: '浅色',
        dark: '深色',
        security: '安全',
        securityBoundary: '凭据只留在 Windows',
        securityBoundarySubtitle: 'Codex Plus 不会索取 OpenAI token；账户登录始终留在 Windows Codex 客户端中。',
        approvals: '不确定时只读',
        approvalsSubtitle: '连接或审批状态不明确时，远程操作自动保持只读。',
        about: '关于与开源许可',
        version: '版本',
        happyLicense: 'Happy 客户端源码（MIT）',
        happyLicenseSubtitle: '移动客户端基础依照 MIT 许可复用。',
        codexLicense: 'OpenAI Codex 源码（Apache-2.0）',
        codexLicenseSubtitle: 'Codex 协议与界面参考遵循上游许可。',
        aboutFooter: 'Codex Plus 是独立的自托管客户端，并非 OpenAI 官方产品。',
    },
};

function platformLabel(platform?: string): string {
    if (!platform) {
        return 'Windows';
    }
    return platform.toLowerCase().includes('win') ? 'Windows' : platform;
}

export const CodexSettingsView = React.memo(function CodexSettingsView({
    topContentInset = 0,
    bottomContentInset = 0,
    onScroll,
}: {
    topContentInset?: number;
    bottomContentInset?: number;
    onScroll?: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
}) {
    const router = useRouter();
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const copy = getCurrentLanguage().startsWith('zh') ? COPY.zh : COPY.en;
    const machines = useAllMachines({ includeOffline: true });
    const dataReady = useIsDataReady();
    const socket = useSocketStatus();
    const themePreference = useLocalSetting('themePreference');
    const [relayUrl, setRelayUrlState] = React.useState(getServerUrl);

    const anyHostOnline = frontendPreviewEnabled || (
        socket.status === 'connected' && machines.some((machine) => machine.active)
    );
    const status = React.useMemo(() => {
        if (frontendPreviewEnabled) {
            return { label: copy.localPreview, color: theme.colors.status.connecting };
        }
        if (!dataReady || socket.status === 'connecting') {
            return { label: copy.loading, color: theme.colors.status.connecting };
        }
        if (socket.status === 'error') {
            return { label: copy.connectionError, color: theme.colors.status.error };
        }
        if (anyHostOnline) {
            return { label: copy.connected, color: theme.colors.status.connected };
        }
        if (machines.length > 0) {
            return { label: copy.hostOffline, color: theme.colors.status.disconnected };
        }
        return { label: copy.disconnected, color: theme.colors.status.disconnected };
    }, [anyHostOnline, copy, dataReady, machines.length, socket.status, theme.colors.status]);

    const relayInfo = React.useMemo(() => getServerInfo(), [relayUrl]);
    const relayDetail = relayInfo.port ? `${relayInfo.hostname}:${relayInfo.port}` : relayInfo.hostname;
    const version = Constants.expoConfig?.version || '1.0.0';
    const language = getLanguageNativeName(getCurrentLanguage());
    const themeDetail = themePreference === 'light'
        ? copy.light
        : themePreference === 'dark'
            ? copy.dark
            : copy.adaptive;

    const editRelay = React.useCallback(async () => {
        const nextUrl = await Modal.prompt(copy.relayEditTitle, copy.relayEditMessage, {
            defaultValue: relayUrl,
            placeholder: 'https://relay.example.com',
            confirmText: copy.save,
        });
        if (nextUrl === null) {
            return;
        }

        const normalized = nextUrl.trim();
        const validation = validateServerUrl(normalized);
        if (!validation.valid) {
            Modal.alert(copy.relayInvalid, validation.error);
            return;
        }

        setServerUrl(normalized);
        setRelayUrlState(getServerUrl());
        Modal.alert(copy.relaySaved, normalized);
    }, [copy, relayUrl]);

    return (
        <ItemList
            style={{ paddingTop: 0 }}
            containerStyle={{ paddingTop: topContentInset, paddingBottom: bottomContentInset }}
            onScroll={onScroll}
            scrollEventThrottle={16}
        >
            <View style={styles.headerContainer}>
                <View style={styles.headerCard}>
                    <View style={styles.mark}>
                        <Ionicons name="code-slash" size={30} color={theme.colors.text} />
                    </View>
                    <Text style={styles.title}>Codex Plus</Text>
                    <View style={styles.statusRow}>
                        <View style={[styles.statusDot, { backgroundColor: status.color }]} />
                        <Text style={styles.statusText}>{status.label}</Text>
                    </View>
                </View>
            </View>

            <ItemGroup title={copy.connection}>
                <Item
                    title={copy.relay}
                    subtitle={copy.relaySubtitle}
                    subtitleLines={2}
                    detail={relayDetail}
                    icon={<Ionicons name="server-outline" size={29} color={theme.colors.status.connecting} />}
                    onPress={editRelay}
                />
            </ItemGroup>

            <ItemGroup title={copy.windowsHosts}>
                {!dataReady && !frontendPreviewEnabled ? (
                    <Item
                        title={copy.loading}
                        icon={<Ionicons name="desktop-outline" size={29} color={theme.colors.status.disconnected} />}
                        loading
                        showChevron={false}
                    />
                ) : machines.length === 0 ? (
                    <Item
                        title={copy.noHost}
                        subtitle={copy.noHostSubtitle}
                        subtitleLines={0}
                        icon={<Ionicons name="desktop-outline" size={29} color={theme.colors.status.disconnected} />}
                        showChevron={false}
                    />
                ) : machines.map((machine) => {
                    const hostOnline = frontendPreviewEnabled || (
                        socket.status === 'connected' && machine.active
                    );
                    const name = machine.metadata?.displayName || machine.metadata?.host || copy.noHost;
                    const host = machine.metadata?.host;
                    const subtitleParts = [
                        host && host !== name ? host : undefined,
                        platformLabel(machine.metadata?.platform),
                        frontendPreviewEnabled
                            ? copy.localPreview
                            : hostOnline
                                ? copy.online
                                : `${copy.lastOnline} ${new Date(machine.activeAt).toLocaleString()}`,
                    ].filter(Boolean);

                    return (
                        <Item
                            key={machine.id}
                            title={name}
                            subtitle={subtitleParts.join(' · ')}
                            subtitleLines={0}
                            detail={frontendPreviewEnabled ? copy.localPreview : hostOnline ? copy.online : copy.offline}
                            icon={(
                                <Ionicons
                                    name="desktop-outline"
                                    size={29}
                                    color={hostOnline ? theme.colors.status.connected : theme.colors.status.disconnected}
                                />
                            )}
                            showChevron={false}
                        />
                    );
                })}
            </ItemGroup>

            <ItemGroup title={copy.display}>
                <Item
                    title={copy.appearance}
                    subtitle={copy.appearanceSubtitle}
                    detail={themeDetail}
                    icon={<Ionicons name="contrast-outline" size={29} color="#5856D6" />}
                    onPress={() => router.push('/settings/appearance')}
                />
                <Item
                    title={copy.language}
                    subtitle={copy.languageSubtitle}
                    detail={language}
                    icon={<Ionicons name="language-outline" size={29} color="#007AFF" />}
                    onPress={() => router.push('/settings/language')}
                />
            </ItemGroup>

            <ItemGroup title={copy.security}>
                <Item
                    title={copy.securityBoundary}
                    subtitle={copy.securityBoundarySubtitle}
                    subtitleLines={0}
                    icon={<Ionicons name="key-outline" size={29} color={theme.colors.status.connected} />}
                    showChevron={false}
                />
                <Item
                    title={copy.approvals}
                    subtitle={copy.approvalsSubtitle}
                    subtitleLines={0}
                    icon={<Ionicons name="shield-checkmark-outline" size={29} color={theme.colors.status.connecting} />}
                    showChevron={false}
                />
            </ItemGroup>

            <ItemGroup title={copy.about} footer={copy.aboutFooter}>
                <Item
                    title={copy.version}
                    detail={version}
                    icon={<Ionicons name="information-circle-outline" size={29} color={theme.colors.textSecondary} />}
                    showChevron={false}
                />
                <Item
                    title={copy.happyLicense}
                    subtitle={copy.happyLicenseSubtitle}
                    subtitleLines={0}
                    icon={<Ionicons name="document-text-outline" size={29} color={theme.colors.textSecondary} />}
                    onPress={() => openExternalUrl(HAPPY_LICENSE_URL)}
                />
                <Item
                    title={copy.codexLicense}
                    subtitle={copy.codexLicenseSubtitle}
                    subtitleLines={0}
                    icon={<Ionicons name="document-text-outline" size={29} color={theme.colors.textSecondary} />}
                    onPress={() => openExternalUrl(CODEX_LICENSE_URL)}
                />
            </ItemGroup>
        </ItemList>
    );
});
