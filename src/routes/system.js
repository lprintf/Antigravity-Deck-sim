// === System Routes ===
// /api/status, /api/launch-ide, /api/kill-ide
// NOTE: GET /api/ws-url is intentionally NOT here — it lives in server.js (before auth middleware)

const { spawn } = require('child_process');

// Private helper — get parent PID of a process (cross-platform)
// Only used by /api/kill-ide handler below
function getParentPid(pid) {
    const { execSync } = require('child_process');
    const { platform } = require('../config');
    try {
        if (platform === 'darwin' || platform === 'linux') {
            // ps -o ppid= -p <pid> → returns parent PID
            const ppid = execSync(`ps -o ppid= -p ${pid}`, { encoding: 'utf8', timeout: 5000 }).trim();
            return ppid || null;
        } else if (platform === 'win32') {
            // wmic is fast and reliable for getting parent PID
            const out = execSync(`wmic process where ProcessId=${pid} get ParentProcessId /value`, { encoding: 'utf8', timeout: 5000 });
            const match = out.match(/ParentProcessId=(\d+)/);
            return match ? match[1] : null;
        }
    } catch { }
    return null;
}

module.exports = function setupSystemRoutes(app) {
    // Status
    app.get('/api/status', (req, res) => {
        const { lsInstances } = require('../config');
        const firstInst = lsInstances[0];
        res.json({ detected: lsInstances.length > 0, port: firstInst?.port || null });
    });

    // Launch IDE — fire-and-forget, opens the Antigravity IDE application
    // Security: no user input, rate-limited via strictLimiter in server.js, auth-protected
    app.post('/api/launch-ide', async (req, res) => {
        const { platform, getSettings } = require('../config');
        const path = require('path');
        const fs = require('fs');
        console.log(`[*] Launch IDE requested (platform: ${platform})`);

        try {
            if (platform === 'darwin') {
                // macOS: open Antigravity app
                const child = spawn('open', ['-a', 'Antigravity'], {
                    timeout: 10000,
                    detached: true,
                    stdio: 'ignore'
                });
                child.on('error', (e) => console.error('[!] Failed to open Antigravity:', e.message));
                child.unref();
            } else if (platform === 'linux') {
                // Linux: resolve IDE binary and ensure Wayland display
                const settings = getSettings();
                let ideBin = 'antigravity';
                if (settings.lsBinaryPath) {
                    const appDir = path.resolve(path.dirname(settings.lsBinaryPath), '..', '..', '..', '..');
                    const candidate = path.join(appDir, 'bin', 'antigravity');
                    if (fs.existsSync(candidate)) ideBin = candidate;
                }

                const xdgRuntime = process.env.XDG_RUNTIME_DIR || '/run/user/1000';
                const env = { ...process.env, XDG_RUNTIME_DIR: xdgRuntime };
                const args = ['--ozone-platform=wayland'];
                const HEADLESS_DISPLAY = 'wayland-headless';

                // Check if waypipe Wayland display exists (user connected via waypipe)
                const waypipeSocket = path.join(xdgRuntime, 'wayland-0');
                if (fs.existsSync(waypipeSocket)) {
                    // Waypipe is connected — use its display (renders to user's screen)
                    env.WAYLAND_DISPLAY = 'wayland-0';
                    console.log('[*] Using waypipe display (wayland-0)');
                } else {
                    // No waypipe — start headless weston with named socket
                    const headlessSocket = path.join(xdgRuntime, HEADLESS_DISPLAY);
                    if (!fs.existsSync(headlessSocket)) {
                        const weston = spawn('weston', ['--backend=headless', '--shell=desktop', `--socket=${HEADLESS_DISPLAY}`], {
                            detached: true, stdio: 'ignore', env,
                        });
                        weston.unref();
                        await new Promise(r => setTimeout(r, 1500));
                        console.log(`[*] Started headless weston (${HEADLESS_DISPLAY})`);
                    }
                    env.WAYLAND_DISPLAY = HEADLESS_DISPLAY;
                }

                const child = spawn(ideBin, args, {
                    detached: true,
                    stdio: 'ignore',
                    env,
                });
                child.on('error', (err) => console.error('[!] Failed to launch antigravity:', err.message));
                child.unref();
            } else {
                // Windows
                const child = spawn('antigravity', [], {
                    timeout: 10000,
                    detached: true,
                    stdio: 'ignore',
                    shell: true,
                });
                child.on('error', (err) => console.error('[!] Failed to launch antigravity:', err.message));
                child.unref();
            }

            res.json({ launched: true, platform });
        } catch (e) {
            console.error('[!] Launch IDE error:', e.message);
            res.status(500).json({ error: 'Failed to launch IDE' });
        }
    });

    // Kill IDE — terminate all Antigravity IDE processes (precise PID-based)
    // Strategy: find parent PID of each LS instance (= IDE app) → kill exactly those
    // Security: no user input, rate-limited via strictLimiter in server.js, auth-protected
    app.post('/api/kill-ide', (req, res) => {
        const { exec, execSync } = require('child_process');
        const { platform, lsInstances } = require('../config');
        console.log(`[*] Kill IDE requested (platform: ${platform}, active instances: ${lsInstances.length})`);

        try {
            // Collect unique parent PIDs (IDE processes) from all LS instances
            const parentPids = new Set();
            for (const inst of lsInstances) {
                const ppid = getParentPid(inst.pid);
                if (ppid && ppid !== '0' && ppid !== '1') {
                    parentPids.add(ppid);
                    console.log(`[*] LS PID ${inst.pid} → parent IDE PID ${ppid}`);
                }
            }

            if (parentPids.size > 0) {
                // Kill precisely: only the IDE parent processes
                for (const ppid of parentPids) {
                    try {
                        if (platform === 'win32') {
                            // /T = kill tree (IDE + child LS), /F = force
                            execSync(`taskkill /PID ${ppid} /T /F`, { stdio: 'ignore', timeout: 5000 });
                        } else {
                            // macOS: graceful quit via AppleScript first, then force kill
                            exec('osascript -e \'quit app "Antigravity"\' 2>/dev/null', { timeout: 5000 }, () => {});
                            // Force kill after short delay if still alive
                            setTimeout(() => {
                                try { execSync(`kill -9 ${ppid}`, { stdio: 'ignore', timeout: 3000 }); } catch { }
                                // Also kill any remaining Antigravity processes
                                try { execSync('pkill -9 -i "^Antigravity" 2>/dev/null', { stdio: 'ignore', timeout: 3000 }); } catch { }
                            }, 2000);
                        }
                        console.log(`[*] Killed IDE PID ${ppid}`);
                    } catch (e) {
                        console.log(`[!] Failed to kill PID ${ppid}: ${e.message}`);
                    }
                }
            } else {
                // Fallback: no LS instances detected, use app-level kill
                console.log('[*] No LS instances — using fallback kill');
                if (platform === 'darwin') {
                    // Graceful quit via AppleScript, then force kill if needed
                    exec('osascript -e \'quit app "Antigravity"\' 2>/dev/null', { timeout: 5000 }, () => {});
                    // Also try pkill without -f (match process NAME only, not full cmd line)
                    setTimeout(() => {
                        exec('pkill -i "^Antigravity" 2>/dev/null', { timeout: 5000 }, () => {});
                    }, 2000);
                } else if (platform === 'win32') {
                    const path = require('path');
                    const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
                    exec(`"${ps}" -NoProfile -Command "Get-Process | Where-Object { $_.ProcessName -match '^antigravity' } | Stop-Process -Force -ErrorAction SilentlyContinue"`, { timeout: 10000 }, () => {});
                } else {
                    exec('pkill -i "^antigravity" 2>/dev/null', { timeout: 10000 }, () => {});
                }
            }

            // Clear all LS instances since we killed the processes
            const killedCount = lsInstances.length;
            lsInstances.length = 0;

            // Also kill any headless instances
            try {
                const { killAllHeadless } = require('../headless-ls');
                if (killAllHeadless) killAllHeadless();
            } catch { }

            console.log(`[*] Kill IDE: cleared ${killedCount} LS instances`);
            res.json({ killed: true, platform, instancesCleared: killedCount, preciseKill: parentPids.size > 0, pidCount: parentPids.size });
        } catch (e) {
            console.error('[!] Kill IDE error:', e.message);
            res.status(500).json({ error: 'Failed to kill IDE' });
        }
    });
};
