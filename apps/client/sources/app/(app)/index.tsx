import * as React from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '@/auth/AuthContext';
import { RoundButton } from '@/components/RoundButton';
import { HomeHeaderNotAuth } from '@/components/HomeHeader';
import { MainView } from '@/components/MainView';
import { Typography } from '@/constants/Typography';
import { frontendPreviewEnabled } from '@/demo/frontendPreview';
import { getServerInfo } from '@/sync/serverConfig';
import { getCurrentLanguage } from '@/text';

const styles = StyleSheet.create((theme) => ({
    screen: {
        flex: 1,
        backgroundColor: theme.colors.groupped.background,
    },
    content: {
        flexGrow: 1,
        width: '100%',
        maxWidth: 520,
        alignSelf: 'center',
        justifyContent: 'center',
        paddingHorizontal: 24,
        paddingTop: 28,
        paddingBottom: 32,
    },
    mark: {
        width: 56,
        height: 56,
        borderRadius: 18,
        alignItems: 'center',
        justifyContent: 'center',
        alignSelf: 'center',
        backgroundColor: theme.colors.surfaceHighest,
        marginBottom: 22,
    },
    title: {
        color: theme.colors.text,
        fontSize: 28,
        lineHeight: 36,
        letterSpacing: -0.7,
        textAlign: 'center',
        ...Typography.default('semiBold'),
    },
    subtitle: {
        color: theme.colors.textSecondary,
        fontSize: 16,
        lineHeight: 24,
        textAlign: 'center',
        marginTop: 10,
        marginBottom: 28,
        ...Typography.default(),
    },
    inputLabel: {
        color: theme.colors.text,
        fontSize: 14,
        marginBottom: 8,
        ...Typography.default('semiBold'),
    },
    input: {
        minHeight: 50,
        borderRadius: 14,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.input.background,
        color: theme.colors.input.text,
        paddingHorizontal: 16,
        fontSize: 16,
        ...Typography.mono(),
    },
    primaryButton: {
        marginTop: 14,
        width: '100%',
    },
    divider: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        marginVertical: 22,
    },
    dividerLine: {
        flex: 1,
        height: StyleSheet.hairlineWidth,
        backgroundColor: theme.colors.divider,
    },
    dividerText: {
        color: theme.colors.textSecondary,
        fontSize: 13,
        ...Typography.default(),
    },
    actionList: {
        borderRadius: 16,
        overflow: 'hidden',
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surface,
    },
    actionRow: {
        minHeight: 58,
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        gap: 12,
    },
    actionRowPressed: {
        backgroundColor: theme.colors.surfacePressed,
    },
    actionIcon: {
        width: 32,
        height: 32,
        borderRadius: 10,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.surfaceHighest,
    },
    actionText: {
        flex: 1,
        color: theme.colors.text,
        fontSize: 15,
        ...Typography.default('semiBold'),
    },
    actionDetail: {
        color: theme.colors.textSecondary,
        fontSize: 12,
        maxWidth: 180,
        ...Typography.default(),
    },
    rowDivider: {
        height: StyleSheet.hairlineWidth,
        marginLeft: 60,
        backgroundColor: theme.colors.divider,
    },
    notice: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 8,
        marginTop: 16,
        padding: 12,
        borderRadius: 12,
        backgroundColor: theme.colors.surface,
    },
    noticeText: {
        flex: 1,
        color: theme.colors.textSecondary,
        fontSize: 13,
        lineHeight: 19,
        ...Typography.default(),
    },
    privacy: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 8,
        marginTop: 20,
        paddingHorizontal: 4,
    },
    privacyText: {
        flex: 1,
        color: theme.colors.textSecondary,
        fontSize: 12,
        lineHeight: 18,
        ...Typography.default(),
    },
}));

function copyForCurrentLanguage() {
    const chinese = getCurrentLanguage().startsWith('zh');
    return chinese ? {
        title: '连接 Windows 上的 Codex',
        subtitle: '扫描电脑上的配对码，或粘贴一次性连接码。连接后即可在手机查看任务、发送消息和处理审批。',
        codeLabel: '一次性连接码',
        codePlaceholder: '粘贴连接码或连接链接',
        connect: '连接',
        or: '或者',
        scan: '扫描二维码',
        relay: 'Relay 服务器',
        privacy: 'OpenAI 登录仅保留在 Windows Codex 中。手机与 Relay 不会索取或保存 OpenAI token。',
        pending: 'Windows Agent 与 Relay 接通后才能完成配对；当前页面只验证前端交互，不会发送连接码。',
        scanPending: '二维码扫描将在 Windows Agent 配对服务接入后启用。',
    } : {
        title: 'Connect Codex on Windows',
        subtitle: 'Scan the pairing code on your computer or paste a one-time code to view tasks, send messages, and handle approvals.',
        codeLabel: 'One-time connection code',
        codePlaceholder: 'Paste a code or connection link',
        connect: 'Connect',
        or: 'or',
        scan: 'Scan QR code',
        relay: 'Relay server',
        privacy: 'Your OpenAI sign-in stays inside Codex on Windows. The phone and Relay never request or store an OpenAI token.',
        pending: 'Pairing becomes available after the Windows Agent and Relay are connected. This frontend build will not transmit the code.',
        scanPending: 'QR scanning becomes available with the Windows Agent pairing service.',
    };
}

export default function Home() {
    const auth = useAuth();
    if (frontendPreviewEnabled) {
        return <MainView variant="phone" />;
    }
    if (auth.isAuthenticated) {
        return <MainView variant="phone" />;
    }
    return <PairingView />;
}

function PairingView() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const insets = useSafeAreaInsets();
    const serverInfo = getServerInfo();
    const copy = copyForCurrentLanguage();
    const [connectionCode, setConnectionCode] = React.useState('');
    const [notice, setNotice] = React.useState<string | null>(null);

    const relayLabel = serverInfo.hostname + (serverInfo.port ? `:${serverInfo.port}` : '');

    return (
        <View style={styles.screen}>
            <HomeHeaderNotAuth />
            <ScrollView
                keyboardShouldPersistTaps="handled"
                contentContainerStyle={[
                    styles.content,
                    { paddingBottom: Math.max(32, insets.bottom + 20) },
                ]}
            >
                <View style={styles.mark}>
                    <Ionicons name="code-slash" size={28} color={theme.colors.text} />
                </View>
                <Text style={styles.title}>{copy.title}</Text>
                <Text style={styles.subtitle}>{copy.subtitle}</Text>

                <Text style={styles.inputLabel}>{copy.codeLabel}</Text>
                <TextInput
                    value={connectionCode}
                    onChangeText={(value) => {
                        setConnectionCode(value);
                        setNotice(null);
                    }}
                    placeholder={copy.codePlaceholder}
                    placeholderTextColor={theme.colors.input.placeholder}
                    autoCapitalize="none"
                    autoCorrect={false}
                    spellCheck={false}
                    returnKeyType="go"
                    onSubmitEditing={() => connectionCode.length > 0 && setNotice(copy.pending)}
                    style={styles.input}
                    accessibilityLabel={copy.codeLabel}
                />
                <RoundButton
                    title={copy.connect}
                    disabled={connectionCode.length === 0}
                    onPress={() => setNotice(copy.pending)}
                    style={styles.primaryButton}
                />

                <View style={styles.divider}>
                    <View style={styles.dividerLine} />
                    <Text style={styles.dividerText}>{copy.or}</Text>
                    <View style={styles.dividerLine} />
                </View>

                <View style={styles.actionList}>
                    <Pressable
                        onPress={() => setNotice(copy.scanPending)}
                        style={({ pressed }) => [styles.actionRow, pressed && styles.actionRowPressed]}
                        accessibilityRole="button"
                    >
                        <View style={styles.actionIcon}>
                            <Ionicons name="qr-code-outline" size={19} color={theme.colors.text} />
                        </View>
                        <Text style={styles.actionText}>{copy.scan}</Text>
                        <Ionicons name="chevron-forward" size={18} color={theme.colors.textSecondary} />
                    </Pressable>
                    <View style={styles.rowDivider} />
                    <Pressable
                        onPress={() => router.push('/server')}
                        style={({ pressed }) => [styles.actionRow, pressed && styles.actionRowPressed]}
                        accessibilityRole="button"
                    >
                        <View style={styles.actionIcon}>
                            <Ionicons name="server-outline" size={19} color={theme.colors.text} />
                        </View>
                        <Text style={styles.actionText}>{copy.relay}</Text>
                        <Text style={styles.actionDetail} numberOfLines={1}>{relayLabel}</Text>
                        <Ionicons name="chevron-forward" size={18} color={theme.colors.textSecondary} />
                    </Pressable>
                </View>

                {notice && (
                    <View style={styles.notice} accessibilityLiveRegion="polite">
                        <Ionicons name="information-circle-outline" size={18} color={theme.colors.textSecondary} />
                        <Text style={styles.noticeText}>{notice}</Text>
                    </View>
                )}

                <View style={styles.privacy}>
                    <Ionicons name="shield-checkmark-outline" size={17} color={theme.colors.textSecondary} />
                    <Text style={styles.privacyText}>{copy.privacy}</Text>
                </View>
            </ScrollView>
        </View>
    );
}
