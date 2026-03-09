// === Frontend Configuration ===
// API: always relative path '' → Next.js proxy → backend (no CORS ever)
// WS:  fetched at runtime from /api/ws-url → backend port always correct

export const API_BASE = '';

// WS URL is resolved lazily at runtime by websocket.ts via getWsUrl()
// This avoids relying on NEXT_PUBLIC_ build-time vars that require a full rebuild.
let _wsUrl: string | null = null;

export async function getWsUrl(): Promise<string> {
    if (_wsUrl) return _wsUrl;

    const isBrowser = typeof window !== 'undefined';
    if (!isBrowser) return 'ws://localhost:3500';

    const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

    if (isLocal) {
        // Fetch actual backend port at runtime — works regardless of port (3500 or 9807)
        try {
            const res = await fetch('/api/ws-url');
            const { wsPort } = await res.json();
            _wsUrl = `ws://localhost:${wsPort}`;
        } catch {
            _wsUrl = 'ws://localhost:3500'; // fallback
        }
    } else {
        // Remote tunnel: use NEXT_PUBLIC_BACKEND_URL if available, else derive from window.location
        const tunnel = process.env.NEXT_PUBLIC_BACKEND_URL || '';
        _wsUrl = tunnel
            ? tunnel.replace(/^http/, 'ws')
            : `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}`;
    }

    return _wsUrl;
}

// Legacy sync export (used as initial value — overridden when getWsUrl() resolves)
export const WS_URL = '';
