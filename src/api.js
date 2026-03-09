// === API Call Helpers ===
const http = require('http');
const https = require('https');
const { lsConfig } = require('./config');
const { encodeStepsRequest } = require('./protobuf');

// --- Internal: resolve connection params ---
function resolveConn(inst) {
    const cfg = inst || lsConfig;
    if (!cfg.port || !cfg.csrfToken) throw new Error('Not configured');
    const useTls = cfg.useTls;
    return {
        protocol: useTls ? 'https' : 'http',
        host: useTls ? '127.0.0.1' : 'localhost',
        port: cfg.port,
        csrfToken: cfg.csrfToken,
        useTls,
    };
}

function makeUrl(conn, method) {
    return `${conn.protocol}://${conn.host}:${conn.port}/exa.language_server_pb.LanguageServerService/${method}`;
}

function baseHeaders(conn) {
    return {
        'Content-Type': 'application/json',
        'Connect-Protocol-Version': '1',
        'X-Codeium-Csrf-Token': conn.csrfToken,
    };
}

// --- JSON API call (Connect Protocol) ---
// inst is optional — if omitted, uses global lsConfig
async function callApi(method, body = {}, inst = null) {
    const conn = resolveConn(inst);
    const fetchOpts = {
        method: 'POST',
        headers: baseHeaders(conn),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(inst ? 10000 : 30000),
    };
    if (conn.useTls) {
        fetchOpts.agent = new https.Agent({ rejectUnauthorized: false });
    }
    const res = await fetch(makeUrl(conn, method), fetchOpts);
    if (!res.ok) throw new Error(`API ${res.status}`);
    return res.json();
}

// --- Fire-and-forget for streaming RPCs ---
// HandleCascadeUserInteraction closes stream after processing.
// "socket hang up" / "ECONNRESET" are treated as SUCCESS.
// inst is optional — if omitted, uses global lsConfig
function callApiFireAndForget(method, body = {}, inst = null) {
    return new Promise((resolve) => {
        let conn;
        try { conn = resolveConn(inst); }
        catch { resolve({ ok: false, error: 'Not configured' }); return; }

        const data = JSON.stringify(body);
        const transport = conn.useTls ? https : http;
        const req = transport.request({
            hostname: conn.host, port: conn.port,
            path: `/exa.language_server_pb.LanguageServerService/${method}`,
            method: 'POST',
            headers: { ...baseHeaders(conn), 'Content-Length': Buffer.byteLength(data) },
            timeout: 3000,
            rejectUnauthorized: false,
        }, (res) => {
            const chunks = [];
            res.on('data', c => chunks.push(c.toString()));
            res.on('end', () => resolve({ ok: res.statusCode < 400, status: res.statusCode, data: chunks.join('') }));
        });
        // Connection close/reset = LS processed the request and closed the stream → success
        req.on('error', (e) => {
            if (e.code === 'ECONNRESET' || e.message.includes('socket hang up')) {
                resolve({ ok: true, status: 0, data: 'stream_closed' });
            } else {
                resolve({ ok: false, error: e.message });
            }
        });
        req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
        req.write(data);
        req.end();
    });
}

// --- Binary Protobuf API call for paginated step fetching ---
// Antigravity LS JSON API may ignore startIndex/endIndex and return a capped number of steps (~598). This applies to both macOS and Windows.
// Binary protobuf requests (Content-Type: application/proto) correctly respect pagination.
function callApiBinary(cascadeId, startIndex, endIndex, inst = null) {
    return new Promise((resolve, reject) => {
        const conn = resolveConn(inst);
        const body = encodeStepsRequest(cascadeId, startIndex, endIndex);
        const transport = conn.useTls ? https : http;
        const req = transport.request({
            hostname: conn.host, port: conn.port,
            path: '/exa.language_server_pb.LanguageServerService/GetCascadeTrajectorySteps',
            method: 'POST',
            headers: {
                'Content-Type': 'application/proto',
                'Connect-Protocol-Version': '1',
                'x-codeium-csrf-token': conn.csrfToken,
                'Content-Length': body.length,
            },
            timeout: 30000, rejectUnauthorized: false,
        }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks)));
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Binary RPC timeout')); });
        req.write(body);
        req.end();
    });
}

// --- Raw HTTP streaming request (for server-streaming RPCs like SendUserCascadeMessage) ---
function callApiStream(method, body = {}, timeoutMs = 60000, inst = null) {
    return new Promise((resolve, reject) => {
        const conn = resolveConn(inst);
        const data = JSON.stringify(body);
        const transport = conn.useTls ? https : http;
        const req = transport.request({
            hostname: conn.host, port: conn.port,
            path: `/exa.language_server_pb.LanguageServerService/${method}`,
            method: 'POST',
            headers: { ...baseHeaders(conn), 'Content-Length': Buffer.byteLength(data) },
            timeout: timeoutMs,
            rejectUnauthorized: false,
        }, (res) => {
            const chunks = [];
            res.on('data', (c) => { chunks.push(c.toString()); });
            res.on('end', () => {
                const full = chunks.join('');
                resolve({ status: res.statusCode, data: full });
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Stream RPC timeout')); });
        req.write(data);
        req.end();
    });
}

// --- Backward-compatible aliases ---
const callApiOnInstance = (inst, method, body = {}) => callApi(method, body, inst);
const callApiFireAndForgetOnInstance = (inst, method, body = {}) => callApiFireAndForget(method, body, inst);

module.exports = {
    callApi,
    callApiOnInstance,
    callApiBinary,
    callApiStream,
    callApiFireAndForget,
    callApiFireAndForgetOnInstance,
};
