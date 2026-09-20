import * as React from 'react';
import { KeyboardAvoidingView, Platform, TextInput, View } from 'react-native';
import { Stack } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { RoundButton } from '@/components/RoundButton';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { layout } from '@/components/layout';
import { getCurrentLanguage } from '@/text';
import { getServerUrl, setServerUrl, validateServerUrl } from '@/sync/serverConfig';

const styles = StyleSheet.create((theme) => ({
    keyboardAvoidingView: { flex: 1 },
    list: { flex: 1 },
    content: {
        width: '100%',
        maxWidth: layout.maxWidth,
        alignSelf: 'center',
        paddingHorizontal: 16,
        paddingVertical: 16,
        backgroundColor: Platform.select({ web: theme.colors.surface, default: 'transparent' }),
    },
    label: {
        color: theme.colors.text,
        fontSize: 14,
        marginBottom: 8,
        ...Typography.default('semiBold'),
    },
    input: {
        minHeight: 50,
        borderRadius: 12,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.input.background,
        color: theme.colors.input.text,
        paddingHorizontal: 14,
        fontSize: 15,
        ...Typography.mono(),
    },
    error: {
        color: theme.colors.textDestructive,
        fontSize: 13,
        lineHeight: 19,
        marginTop: 8,
        ...Typography.default(),
    },
    status: {
        color: theme.colors.status.connected,
        fontSize: 13,
        lineHeight: 19,
        marginTop: 8,
        ...Typography.default(),
    },
    buttons: {
        flexDirection: 'row',
        gap: 12,
        marginTop: 16,
    },
    button: { flex: 1 },
}));

function currentCopy() {
    return getCurrentLanguage().startsWith('zh') ? {
        title: 'Relay 服务器',
        group: '自托管 Relay',
        label: 'Relay 地址',
        helper: '远程地址必须使用 HTTPS；仅 localhost / 127.0.0.1 / ::1 可使用 HTTP。地址保存在本设备上，正式连接由配对流程验证。',
        placeholder: 'https://relay.example.com',
        reset: '恢复本地地址',
        save: '保存',
        saved: 'Relay 地址已保存。',
    } : {
        title: 'Relay server',
        group: 'Self-hosted Relay',
        label: 'Relay URL',
        helper: 'Remote addresses must use HTTPS. HTTP is accepted only for localhost, 127.0.0.1, or ::1. The URL is stored on this device and verified during pairing.',
        placeholder: 'https://relay.example.com',
        reset: 'Use local address',
        save: 'Save',
        saved: 'Relay URL saved.',
    };
}

export default function RelaySettingsScreen() {
    const { theme } = useUnistyles();
    const copy = currentCopy();
    const [inputUrl, setInputUrl] = React.useState(getServerUrl);
    const [error, setError] = React.useState<string | null>(null);
    const [saved, setSaved] = React.useState(false);

    const save = React.useCallback(() => {
        const validation = validateServerUrl(inputUrl);
        if (!validation.valid) {
            setError(validation.error ?? 'Invalid Relay URL');
            setSaved(false);
            return;
        }
        setServerUrl(inputUrl);
        setInputUrl(getServerUrl());
        setError(null);
        setSaved(true);
    }, [inputUrl]);

    const reset = React.useCallback(() => {
        setServerUrl(null);
        setInputUrl(getServerUrl());
        setError(null);
        setSaved(true);
    }, []);

    return (
        <>
            <Stack.Screen options={{ headerShown: true, headerTitle: copy.title }} />
            <KeyboardAvoidingView
                style={styles.keyboardAvoidingView}
                behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            >
                <ItemList style={styles.list}>
                    <ItemGroup title={copy.group} footer={copy.helper}>
                        <View style={styles.content}>
                            <Text style={styles.label}>{copy.label}</Text>
                            <TextInput
                                value={inputUrl}
                                onChangeText={(value) => {
                                    setInputUrl(value);
                                    setError(null);
                                    setSaved(false);
                                }}
                                placeholder={copy.placeholder}
                                placeholderTextColor={theme.colors.input.placeholder}
                                autoCapitalize="none"
                                autoCorrect={false}
                                keyboardType="url"
                                style={styles.input}
                            />
                            {error && <Text style={styles.error}>{error}</Text>}
                            {saved && <Text style={styles.status}>{copy.saved}</Text>}
                            <View style={styles.buttons}>
                                <RoundButton
                                    title={copy.reset}
                                    size="normal"
                                    display="inverted"
                                    onPress={reset}
                                    style={styles.button}
                                />
                                <RoundButton
                                    title={copy.save}
                                    size="normal"
                                    onPress={save}
                                    style={styles.button}
                                />
                            </View>
                        </View>
                    </ItemGroup>
                </ItemList>
            </KeyboardAvoidingView>
        </>
    );
}
