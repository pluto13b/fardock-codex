import { Redirect, Stack, useSegments } from 'expo-router';
import 'react-native-reanimated';
import * as React from 'react';
import { Typography } from '@/constants/Typography';
import { createHeader } from '@/components/navigation/Header';
import { Platform, View } from 'react-native';
import { isRunningOnMac } from '@/utils/platform';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { MobileGlassBackdrop } from '@/components/MobileGlass';
import { useAuth } from '@/auth/AuthContext';
import { frontendPreviewEnabled } from '@/demo/frontendPreview';

export const unstable_settings = {
    initialRouteName: 'index',
};

const BLOCKED_ROOT_ROUTES = new Set([
    'artifacts',
    'changelog',
    'dev',
    'friends',
    'inbox',
    'machine',
    'restore',
    'terminal',
    'text-selection',
    'user',
]);

const ALLOWED_SETTINGS_ROUTES = new Set(['appearance', 'index', 'language']);

function routeIsBlocked(segments: string[]): boolean {
    const groupIndex = segments.indexOf('(app)');
    const route = groupIndex >= 0 ? segments.slice(groupIndex + 1) : segments;
    const root = route[0];
    if (!root || root === 'index') {
        return false;
    }
    if (BLOCKED_ROOT_ROUTES.has(root)) {
        return true;
    }
    if (root === 'settings') {
        const child = route[1] ?? 'index';
        return !ALLOWED_SETTINGS_ROUTES.has(child);
    }
    return !['new', 'server', 'session'].includes(root);
}

export default function AppLayout() {
    const segments = useSegments();
    const auth = useAuth();
    const shouldUseCustomHeader = Platform.OS === 'android' || isRunningOnMac() || Platform.OS === 'web';
    const isDesktop = Platform.OS === 'web' || isRunningOnMac();
    const { theme } = useUnistyles();

    if (routeIsBlocked(segments as string[])) {
        return <Redirect href="/" />;
    }

    const groupIndex = (segments as string[]).indexOf('(app)');
    const route = groupIndex >= 0 ? (segments as string[]).slice(groupIndex + 1) : (segments as string[]);
    const rootRoute = route[0] ?? 'index';
    const isPublicPairingRoute = rootRoute === 'index' || rootRoute === 'server';
    if (!frontendPreviewEnabled && !auth.isAuthenticated && !isPublicPairingRoute) {
        return <Redirect href="/" />;
    }
    const isSessionInfoRoute = rootRoute === 'session' && route[2] === 'info';
    if (isSessionInfoRoute || (frontendPreviewEnabled && rootRoute === 'session' && route.length > 2)) {
        return <Redirect href="/" />;
    }

    return (
        <View
            style={{
                flex: 1,
                backgroundColor: isDesktop
                    ? theme.colors.surface
                    : theme.colors.groupped.background,
            }}
        >
            <MobileGlassBackdrop enabled={!isDesktop} />
            <Stack
                initialRouteName="index"
                screenOptions={{
                    header: shouldUseCustomHeader ? createHeader : undefined,
                    headerBackTitle: t('common.back'),
                    headerBackButtonDisplayMode: Platform.OS === 'ios' ? 'minimal' : undefined,
                    headerShadowVisible: false,
                    contentStyle: {
                        backgroundColor: isDesktop
                            ? theme.colors.surface
                            : theme.colors.groupped.background,
                    },
                    headerStyle: {
                        backgroundColor: isDesktop ? theme.colors.header.background : 'transparent',
                    },
                    headerTintColor: theme.colors.header.tint,
                    headerTitleStyle: {
                        color: theme.colors.header.tint,
                        ...Typography.default('semiBold'),
                    },
                }}
            >
                <Stack.Screen name="index" options={{ headerShown: false, headerTitle: '' }} />
                <Stack.Screen
                    name="settings/index"
                    options={{
                        headerShown: true,
                        headerTitle: t('settings.title'),
                        headerBackTitle: t('common.home'),
                    }}
                />
                <Stack.Screen name="settings/appearance" options={{ headerTitle: t('settings.appearance') }} />
                <Stack.Screen name="settings/language" options={{ headerTitle: t('settingsLanguage.title') }} />
                <Stack.Screen name="server" options={{ headerTitle: 'Relay' }} />
                <Stack.Screen name="new/index" options={{ headerTitle: t('newSession.title') }} />
                <Stack.Screen name="session/[id]" options={{ headerShown: false }} />
                <Stack.Screen
                    name="session/[id]/message/[messageId]"
                    options={{ headerTitle: t('common.message') }}
                />
                <Stack.Screen name="session/[id]/info" options={{ headerTitle: '' }} />
                <Stack.Screen name="session/[id]/files" options={{ headerTitle: t('common.files') }} />
                <Stack.Screen name="session/[id]/file" options={{ headerTitle: t('common.fileViewer') }} />
            </Stack>
        </View>
    );
}
