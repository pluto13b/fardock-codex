import { MMKV } from 'react-native-mmkv';
import { frontendPreviewEnabled } from '@/demo/previewFlag';

// Separate MMKV instance for server config that persists across logouts
const serverConfigStorage = new MMKV({
    id: frontendPreviewEnabled ? 'codex-plus-preview-server-config' : 'codex-plus-server-config',
});

const SERVER_KEY = 'relay-url-v1';
const LOG_SERVER_KEY = 'log-server-url-v1';
// Never fall back to Happy's hosted service. Until a Codex Plus Relay URL is
// configured, the imported client can only try the loopback development Relay.
const DEFAULT_SERVER_URL = 'http://127.0.0.1:8787';

export function getServerUrl(): string {
    return serverConfigStorage.getString(SERVER_KEY) ||
           (globalThis as any).__CODEX_PLUS_CONFIG__?.serverUrl ||
           process.env.EXPO_PUBLIC_CODEX_PLUS_SERVER_URL ||
           DEFAULT_SERVER_URL;
}

export function setServerUrl(url: string | null): void {
    if (url && url.trim()) {
        serverConfigStorage.set(SERVER_KEY, url.trim());
    } else {
        serverConfigStorage.delete(SERVER_KEY);
    }
}

export function getLogServerUrl(): string | null {
    if (frontendPreviewEnabled) {
        return null;
    }
    return serverConfigStorage.getString(LOG_SERVER_KEY) ||
           process.env.EXPO_PUBLIC_LOG_SERVER_URL ||
           null;
}

export function setLogServerUrl(url: string | null): void {
    if (url && url.trim()) {
        serverConfigStorage.set(LOG_SERVER_KEY, url.trim());
    } else {
        serverConfigStorage.delete(LOG_SERVER_KEY);
    }
}

export function isUsingCustomServer(): boolean {
    return getServerUrl() !== DEFAULT_SERVER_URL;
}

export function getServerInfo(): { hostname: string; port?: number; isCustom: boolean } {
    const url = getServerUrl();
    const isCustom = isUsingCustomServer();
    
    try {
        const parsed = new URL(url);
        const port = parsed.port ? parseInt(parsed.port) : undefined;
        return {
            hostname: parsed.hostname,
            port,
            isCustom
        };
    } catch {
        // Fallback if URL parsing fails
        return {
            hostname: url,
            port: undefined,
            isCustom
        };
    }
}

export function validateServerUrl(url: string): { valid: boolean; error?: string } {
    if (!url || !url.trim()) {
        return { valid: false, error: 'Server URL cannot be empty' };
    }
    
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return { valid: false, error: 'Server URL must use HTTP or HTTPS protocol' };
        }
        const isLoopback = parsed.hostname === '127.0.0.1'
            || parsed.hostname === 'localhost'
            || parsed.hostname === '::1';
        if (parsed.protocol !== 'https:' && !isLoopback) {
            return { valid: false, error: 'Non-loopback servers must use HTTPS' };
        }
        return { valid: true };
    } catch {
        return { valid: false, error: 'Invalid URL format' };
    }
}
