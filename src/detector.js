// === Language Server Auto-Detection ===
const { exec } = require('child_process');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { lsConfig, lsInstances, platform } = require('./config');

// Node 18+ native fetch() (Undici) silently ignores https.Agent — rejectUnauthorized
// never takes effect. Use http/https.request() directly so self-signed certs work.
function connectPost(url, headers, body, timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const isHttps = parsed.protocol === 'https:';
        const transport = isHttps ? https : http;
        const opts = {
            hostname: parsed.hostname.replace(/^\[|\]$/g, ''), // strip IPv6 brackets
            port: parsed.port,
            path: parsed.pathname,
            method: 'POST',
            headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
            timeout: timeoutMs,
        };
        if (isHttps) opts.rejectUnauthorized = false;

        const req = transport.request(opts, (res) => {
            const chunks = [];
            res.on('data', c => chunks.push(c.toString()));
            res.on('end', () => {
                resolve({
                    ok: res.statusCode >= 200 && res.statusCode < 300,
                    status: res.statusCode,
                    statusText: res.statusMessage,
                    text: () => Promise.resolve(chunks.join('')),
                    json: () => Promise.resolve(JSON.parse(chunks.join(''))),
                });
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('TimeoutError')); });
        req.write(body);
        req.end();
    });
}

// Lazy-load to avoid circular dependency (headless-ls requires config which is loaded here)
let _isHeadlessPid = null;
function isHeadlessPid(pid) {
    if (!_isHeadlessPid) {
        try { _isHeadlessPid = require('./headless-ls').isHeadlessPid; } catch { return false; }
    }
    return _isHeadlessPid(pid);
}

// Auto-detect Language Server process (macOS/Linux/Windows)
async function detectLanguageServers() {
    return new Promise((resolve) => {
        let cmd;
        if (platform === 'win32') {
            const tmpScript = path.join(os.tmpdir(), '_ls_detect.ps1');
            fs.writeFileSync(tmpScript,
                "Get-CimInstance Win32_Process | Where-Object { $_.Name -like '*language_server*' } | Select-Object ProcessId, CommandLine | Format-List\n"
            );
            // Use full path — powershell may not be in PATH (e.g. Git Bash, some RDP sessions)
            const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
            cmd = `"${ps}" -ExecutionPolicy Bypass -NoProfile -File "${tmpScript}"`;
        } else {
            cmd = `ps aux | grep 'language_server' | grep -v grep`;
        }

        exec(cmd, { timeout: 10000 }, (err, stdout) => {
            // macOS/Linux fallback: if 'language_server' not found, try 'csrf_token'
            // (Antigravity uses binary name 'antigravity_tools', not 'language_server')
            if (platform !== 'win32' && (err || !stdout.trim())) {
                exec(`ps aux | grep 'csrf_token' | grep -v grep`, { timeout: 10000 }, (err2, stdout2) => {
                    if (err2 || !stdout2.trim()) {
                        console.log('[!] Language server not found');
                        resolve([]);
                        return;
                    }
                    parseAndResolve(stdout2);
                });
                return;
            }

            if (err || !stdout.trim()) {
                console.log('[!] Language server not found');
                resolve([]);
                return;
            }

            parseAndResolve(stdout);
        });

        function parseAndResolve(stdout) {

            const instances = [];

            if (platform === 'win32') {
                const blocks = stdout.split(/\r?\n\r?\n/);
                for (const block of blocks) {
                    if (!block.trim()) continue;
                    const pidMatch = block.match(/ProcessId\s*:\s*(\d+)/);
                    const csrfMatch = block.match(/--csrf_token\s+([a-f0-9-]+)/);
                    const wsMatch = block.match(/--workspace_id\s+(\S+)/);
                    if (pidMatch && csrfMatch) {
                        instances.push({
                            pid: pidMatch[1],
                            csrfToken: csrfMatch[1],
                            workspaceId: wsMatch ? wsMatch[1] : null
                        });
                    }
                }
            } else {
                stdout.split('\n').forEach(line => {
                    if (!line.trim()) return;
                    const pidMatch = line.match(/\S+\s+(\d+)/);
                    const csrfMatch = line.match(/--csrf_token\s+([a-f0-9-]+)/);
                    const wsMatch = line.match(/--workspace_id\s+(\S+)/);
                    if (pidMatch && csrfMatch) {
                        instances.push({
                            pid: pidMatch[1],
                            csrfToken: csrfMatch[1],
                            workspaceId: wsMatch ? wsMatch[1] : null
                        });
                    }
                });
            }

            console.log(`[*] Found ${instances.length} language server instance(s)`);
            instances.forEach(inst => {
                console.log(`    PID: ${inst.pid}, CSRF: ${inst.csrfToken.substring(0, 8)}..., workspace: ${inst.workspaceId || 'none'}`);
            });
            resolve(instances);
        }
    });
}

// Try HTTPS first (LS typically uses self-signed cert), then fall back to HTTP
async function detectPorts(pid) {
    return new Promise((resolve) => {
        let cmd;
        if (platform === 'win32') {
            // netstat -ano: ~29ms vs PowerShell ~1250ms
            cmd = `netstat -ano`;
        } else {
            cmd = `lsof -iTCP -sTCP:LISTEN -P -n -p ${pid} 2>/dev/null`;
        }

        const { exec } = require('child_process');
        exec(cmd, { timeout: 5000 }, (err, stdout) => {
            if (err || !stdout.trim()) { resolve([]); return; }
            const ports = [];
            const pidStr = String(pid);
            stdout.split('\n').forEach(line => {
                if (!line.trim()) return;
                if (platform === 'win32') {
                    // "  TCP    0.0.0.0:42150    0.0.0.0:0    LISTENING    12345"
                    // Or on some locales: "  TCP    0.0.0.0:42150    0.0.0.0:0    ĐANG NGHE    12345"
                    // We just split by whitespace and check if the last token matches the PID
                    const parts = line.trim().split(/\s+/);
                    if (parts.length >= 4 && parts[parts.length - 1] === pidStr) {
                        const addrPort = parts[1]; // "0.0.0.0:42150"
                        if (addrPort) {
                           const port = parseInt(addrPort.split(':').pop(), 10);
                           if (!isNaN(port)) ports.push(port);
                        }
                    }
                } else {
                    const cols = line.trim().split(/\s+/);
                    if (cols.length >= 2 && cols[1] === String(pid)) {
                        const m = line.match(/:(\d+)\s+\(LISTEN\)/);
                        if (m) ports.push(parseInt(m[1]));
                    }
                }
            });
            ports.sort((a, b) => a - b);
            resolve([...new Set(ports)]); // Return unique ports only
        });
    });
}

// Try Connect protocol (gRPC-Web/JSON) on all address variants.
// Fix for issue #68: Windows LS may bind ::1 (IPv6) instead of 127.0.0.1 (IPv4).
// Fix for issue #86: Uses connectPost() instead of fetch() — native fetch() silently
// ignores https.Agent so rejectUnauthorized never took effect on self-signed certs.
async function findApiPort(ports, csrfToken) {
    if (!ports || !ports.length || !csrfToken) return null;
    const headers = { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', 'X-Codeium-Csrf-Token': csrfToken };
    const endpoint = '/exa.language_server_pb.LanguageServerService/GetUserStatus';

    const probes = [
        { label: 'HTTPS/IPv4',    url: (p) => `https://127.0.0.1:${p}${endpoint}`,  tls: true },
        { label: 'HTTP/localhost', url: (p) => `http://localhost:${p}${endpoint}`,    tls: false },
        { label: 'HTTPS/IPv6',    url: (p) => `https://[::1]:${p}${endpoint}`,       tls: true },
        { label: 'HTTP/IPv6',     url: (p) => `http://[::1]:${p}${endpoint}`,        tls: false },
    ];

    for (const port of ports) {
        console.log(`[~] Probing port ${port} (${probes.length} strategies)...`);
        for (const probe of probes) {
            try {
                const res = await connectPost(probe.url(port), headers, '{}', 3000);
                if (res.ok) {
                    console.log(`[✓] API on port ${port} (${probe.label})`);
                    return { port, useTls: probe.tls };
                }
                console.log(`[~] Port ${port} ${probe.label}: responded ${res.status} ${res.statusText}`);
            } catch (err) {
                const reason = err?.cause?.code || err?.code || err?.message || String(err);
                console.log(`[~] Port ${port} ${probe.label}: ${reason}`);
            }
        }
    }
    return null;
}

// Helper: get workspace name + category + folderUri from LS instance via GetWorkspaceInfos API
async function getWorkspaceInfo(port, csrfToken, useTls, workspaceId) {
    try {
        const protocol = useTls ? 'https' : 'http';
        const host = useTls ? '127.0.0.1' : 'localhost';
        const headers = { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', 'X-Codeium-Csrf-Token': csrfToken };
        const res = await connectPost(`${protocol}://${host}:${port}/exa.language_server_pb.LanguageServerService/GetWorkspaceInfos`, headers, '{}', 5000);
        if (!res.ok) return { name: 'unknown', category: 'workspace', folderUri: null };
        const data = await res.json();
        const uris = (data.workspaceInfos || []).map(w => w.workspaceUri);
        if (uris.length > 0) {
            const uri = uris[0];
            const decoded = decodeURIComponent(uri);
            const parts = decoded.replace(/\/$/, '').split('/');
            const name = parts[parts.length - 1] || 'unknown';
            const isPlayground = decoded.includes('antigravity/playground') || decoded.includes('ag_skills');
            return { name, category: isPlayground ? 'playground' : 'workspace', folderUri: uri };
        }
    } catch { }

    // Fallback: derive URI from workspaceId process arg
    // Windows: "file_c_3A_Users_johndoe_Projects_MyProject" → "file:///c:/Users/johndoe/Projects/MyProject"
    // macOS:   "file__Users_johndoe_Projects_MyProject"     → "file:///Users/johndoe/Projects/MyProject"
    if (workspaceId) {
        let decoded;
        if (/_3A_/.test(workspaceId)) {
            // Windows-style: has drive letter encoding
            decoded = workspaceId
                .replace(/^file_/, 'file:///')
                .replace(/_3A_/, ':/')
                .replace(/_/g, '/');
        } else {
            // macOS/Linux-style: no drive letter
            decoded = workspaceId
                .replace(/^file_/, 'file://')
                .replace(/_/g, '/');
        }
        const parts = decoded.replace(/\/$/, '').split('/');
        const name = parts[parts.length - 1] || 'unknown';
        const isPlayground = decoded.includes('antigravity/playground') || decoded.includes('ag_skills');
        return { name, category: isPlayground ? 'playground' : 'workspace', folderUri: decoded };
    }

    return { name: 'unknown', category: 'workspace', folderUri: null };
}

// Initialize: detect ALL LS instances, resolve ports, connect to first one
async function init(onReady) {
    console.log(`[*] Detecting Language Server on ${platform}...`);
    const instances = await detectLanguageServers();

    if (!instances.length) {
        console.log('[!] No language server instances found');
        if (onReady) onReady();
        return;
    }

    // Resolve ports for ALL instances and store them (dedup by workspaceFolderUri)
    lsInstances.length = 0;
    const seenFolderUris = new Set();
    for (const inst of instances) {
        const ports = await detectPorts(inst.pid);
        if (!ports.length) {
            console.log(`[!] PID ${inst.pid}: no listening ports found`);
            continue;
        }
        console.log(`[~] PID ${inst.pid}: found ${ports.length} candidate port(s): ${ports.join(', ')}`);

        const result = await findApiPort(ports, inst.csrfToken);
        if (result) {
            const { name, category, folderUri } = await getWorkspaceInfo(result.port, inst.csrfToken, result.useTls, inst.workspaceId);
            // Allow instances without workspace folder — use fallback name
            // (macOS Antigravity may not expose workspace via process args or API)
            // Skip duplicate folder URIs (e.g. two LS processes for same workspace)
            if (seenFolderUris.has(folderUri)) {
                console.log(`[~] Skipping duplicate workspace: ${name} (PID: ${inst.pid}, same folder as existing)`);
                continue;
            }
            const finalName = name || `LS-${inst.pid}`;
            const finalUri = folderUri || `detached://${inst.pid}`;

            if (folderUri) seenFolderUris.add(folderUri);
            lsInstances.push({
                pid: inst.pid,
                csrfToken: inst.csrfToken,
                workspaceId: inst.workspaceId,
                workspaceName: finalName,
                workspaceFolderUri: finalUri,
                category: category || 'workspace',
                port: result.port,
                useTls: result.useTls,
                active: false
            });
        }
    }

    if (lsInstances.length === 0) {
        console.log('[!] Could not find working API port on any instance');
        if (onReady) onReady();
        return;
    }

    // Activate first instance
    switchToInstance(0);
    lastDetectedState = true;
    // Broadcast detection status to all connected clients (they may have connected before init finished)
    try {
        const { broadcastAll } = require('./ws');
        broadcastAll({ type: 'status', detected: true, port: lsInstances[0]?.port || null });
    } catch { }
    if (onReady) onReady();
}

// Switch active connection to a different LS instance
function switchToInstance(index) {
    if (index < 0 || index >= lsInstances.length) return false;

    // Deactivate all
    lsInstances.forEach(i => i.active = false);

    // Activate selected
    const inst = lsInstances[index];
    inst.active = true;
    lsConfig.port = inst.port;
    lsConfig.csrfToken = inst.csrfToken;
    lsConfig.detected = true;
    lsConfig.useTls = inst.useTls;

    console.log(`[✓] Switched to: ${inst.workspaceName} (PID: ${inst.pid}, Port: ${inst.port})`);
    return true;
}

// Periodic re-scan for new LS instances (Adaptive)
const NORMAL_RESCAN_INTERVAL = 10000;
const FAST_RESCAN_INTERVAL = 2000;
let rescanTimer = null;
let lastDetectedState = false; // track detection state transitions

function startAutoRescan() {
    if (rescanTimer) clearTimeout(rescanTimer);
    rescanTimer = setTimeout(rescanLoop, lsInstances.length === 0 ? FAST_RESCAN_INTERVAL : NORMAL_RESCAN_INTERVAL);
}

async function rescanLoop() {
    await rescanNow();
    rescanTimer = setTimeout(rescanLoop, lsInstances.length === 0 ? FAST_RESCAN_INTERVAL : NORMAL_RESCAN_INTERVAL);
}

async function rescanNow() {
    try {
        const instances = await detectLanguageServers();
        const knownPids = new Set(lsInstances.map(i => i.pid));
        let changed = false;

        for (const inst of instances) {
            if (knownPids.has(inst.pid)) {
                // Already known — but if headless, verify port is still reachable
                if (isHeadlessPid(inst.pid)) {
                    const existing = lsInstances.find(i => i.pid === inst.pid);
                    if (existing) {
                        try {
                            // Quick connectivity check (3s timeout)
                            const { callApi } = require('./api');
                            await callApi('GetUserStatus', {}, existing);
                        } catch {
                            // Port is dead — re-probe
                            const ports = await detectPorts(inst.pid);
                            if (ports.length) {
                                const result = await findApiPort(ports, existing.csrfToken);
                                if (result && (String(result.port) !== String(existing.port) || result.useTls !== existing.useTls)) {
                                    const oldPort = existing.port;
                                    existing.port = result.port;
                                    existing.useTls = result.useTls;
                                    changed = true;
                                    console.log(`[~] Headless port updated: ${existing.workspaceName} (PID: ${existing.pid}, ${oldPort} → ${result.port})`);
                                    // Update global lsConfig if this is the active instance
                                    if (existing.active) switchToInstance(lsInstances.indexOf(existing));
                                }
                            }
                        }
                    }
                }
                continue;
            }
            if (isHeadlessPid(inst.pid)) continue; // new headless PID not yet in lsInstances — managed by headless-ls module

            const ports = await detectPorts(inst.pid);
            if (!ports.length) continue;

            const result = await findApiPort(ports, inst.csrfToken);
            if (result) {
                const { name, category, folderUri } = await getWorkspaceInfo(result.port, inst.csrfToken, result.useTls, inst.workspaceId);
                // Allow instances without workspace folder — use fallback
                // (macOS Antigravity may not expose workspace via process args or API)
                const finalName = name || `LS-${inst.pid}`;
                const finalUri = folderUri || `detached://${inst.pid}`;

                // Dedup: if same workspaceFolderUri already exists, replace the old one (PID may have changed after restart)
                const existingIdx = folderUri ? lsInstances.findIndex(i => i.workspaceFolderUri === folderUri && i.pid !== inst.pid) : -1;
                if (existingIdx >= 0) {
                    const old = lsInstances[existingIdx];
                    console.log(`[~] Replacing stale workspace: ${old.workspaceName} (PID: ${old.pid} → ${inst.pid})`);
                    // Cleanup old instance's cascade state before replacing
                    const { cleanupByInstance } = require('./cleanup');
                    cleanupByInstance(old);
                    const wasActive = old.active;
                    lsInstances[existingIdx] = {
                        pid: inst.pid,
                        csrfToken: inst.csrfToken,
                        workspaceId: inst.workspaceId,
                        workspaceName: finalName,
                        workspaceFolderUri: finalUri,
                        category: category || 'workspace',
                        port: result.port,
                        useTls: result.useTls,
                        active: wasActive
                    };
                    if (wasActive) switchToInstance(existingIdx);
                    changed = true;
                } else {
                    lsInstances.push({
                        pid: inst.pid,
                        csrfToken: inst.csrfToken,
                        workspaceId: inst.workspaceId,
                        workspaceName: finalName,
                        workspaceFolderUri: finalUri,
                        category: category || 'workspace',
                        port: result.port,
                        useTls: result.useTls,
                        active: false
                    });
                    changed = true;
                    console.log(`[+] New workspace detected: ${finalName} (PID: ${inst.pid}, Port: ${result.port})`);
                }
            }
        }

        // Also remove instances whose PID no longer exists
        for (let i = lsInstances.length - 1; i >= 0; i--) {
            if (!instances.find(inst => inst.pid === lsInstances[i].pid)) {
                const removed = lsInstances[i];
                console.log(`[-] Workspace gone: ${removed.workspaceName} (PID: ${removed.pid})${removed.headless ? ' [headless]' : ''}`);
                // Cleanup cascade state for this dead instance before removing
                const { cleanupByInstance } = require('./cleanup');
                cleanupByInstance(removed);
                // If headless, also clean up headless tracking state
                if (removed.headless) {
                    try {
                        const { _cleanupDeadHeadless } = require('./headless-ls');
                        if (_cleanupDeadHeadless) _cleanupDeadHeadless(removed.pid);
                    } catch { }
                }
                // If this was the active instance, switch to another
                if (removed.active && lsInstances.length > 1) {
                    const nextIdx = i === 0 ? 1 : 0;
                    switchToInstance(nextIdx > i ? nextIdx - 1 : nextIdx);
                }
                lsInstances.splice(i, 1);
                changed = true;
            }
        }

        // Auto-activate first instance if none is active (Deck started before IDE)
        if (lsInstances.length > 0 && !lsInstances.some(i => i.active)) {
            switchToInstance(0);
            changed = true;
            console.log(`[~] Auto-activated first instance: ${lsInstances[0].workspaceName} (PID: ${lsInstances[0].pid})`);
        }

        // Notify frontend when workspace list changes
        if (changed) {
            try {
                const { broadcastAll } = require('./ws');
                broadcastAll({ type: 'conversations_updated' });
            } catch { }
        }

        // Broadcast detection status when state transitions (detected ↔ not detected)
        const nowDetected = lsInstances.length > 0;
        if (nowDetected !== lastDetectedState) {
            lastDetectedState = nowDetected;
            try {
                const { broadcastAll } = require('./ws');
                // If profile swap is in progress, include swapping flag so frontend keeps showing swap UI
                const { isSwapping } = require('./profile-manager');
                const msg = { type: 'status', detected: nowDetected, port: lsInstances[0]?.port || null };
                if (!nowDetected && isSwapping()) msg.swapping = true;
                broadcastAll(msg);
                console.log(`[WS] status broadcast: detected=${nowDetected}${msg.swapping ? ' swapping=true' : ''}`);
            } catch { }
        }
    } catch { }
}

// --- Instance resolution helpers ---

function getInstanceByName(name) {
    const { lsInstances } = require('./config');
    return lsInstances.find(i => i.workspaceName.toLowerCase() === name.toLowerCase()) || null;
}

function getFirstActiveInstance() {
    const { lsInstances } = require('./config');
    // Prefer headless instances over IDE workspace (avoid routing to internal wsp/0)
    const headless = lsInstances.filter(i => i.headless);
    if (headless.length > 0) {
        return headless.find(i => i.active) || headless[0];
    }
    return lsInstances.find(i => i.active) || lsInstances[0] || null;
}

module.exports = { detectLanguageServers, detectPorts, findApiPort, init, switchToInstance, startAutoRescan, getInstanceByName, getFirstActiveInstance };

