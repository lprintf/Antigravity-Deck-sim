// /api/shell/* — Execute shell commands in workspace context
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

module.exports = function registerShellRoutes(app) {
    const { getSettings, lsInstances } = require('../config');

    // Track running processes for kill support
    const runningProcs = new Map(); // id → { child, command, startTime }

    /** Resolve workspace cwd from name */
    function resolveWorkspaceCwd(workspace) {
        const settings = getSettings();
        let cwd = settings.defaultWorkspaceRoot || '/aiwsp';
        if (workspace) {
            const inst = lsInstances.find(i => i.workspaceName === workspace);
            if (inst?.workspaceFolderUri) {
                try {
                    cwd = decodeURIComponent(inst.workspaceFolderUri).replace(/^file:\/\//, '');
                } catch {}
            } else {
                cwd = path.join(settings.defaultWorkspaceRoot || '/aiwsp', workspace);
            }
        }
        return cwd;
    }

    /** Ensure .deck-shell/ exists in cwd; auto-gitignore */
    function ensureShellDir(cwd) {
        const shellDir = path.join(cwd, '.deck-shell');
        if (!fs.existsSync(shellDir)) fs.mkdirSync(shellDir, { recursive: true });
        // Auto-add to .gitignore
        try {
            const gi = path.join(cwd, '.gitignore');
            const existing = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
            if (!existing.includes('.deck-shell')) {
                fs.appendFileSync(gi, '\n# Deck shell output (auto-generated)\n.deck-shell/\n');
            }
        } catch {}
        return shellDir;
    }

    /**
     * POST /api/shell/exec
     * Body: { command, workspace?, timeout? }
     * Response: { exitCode, stdout, stderr, truncated, killed, cwd, outputFile, duration }
     */
    app.post('/api/shell/exec', (req, res) => {
        const { command, workspace, timeout = 30000 } = req.body || {};

        if (!command || typeof command !== 'string') {
            return res.status(400).json({ error: 'command is required' });
        }

        const cwd = resolveWorkspaceCwd(workspace);
        const shellDir = ensureShellDir(cwd);
        const startTime = Date.now();

        const MAX_OUTPUT = 64 * 1024; // 64KB max per stream
        let stdout = '';
        let stderr = '';
        let stdoutTruncated = false;
        let stderrTruncated = false;

        const child = spawn('bash', ['-c', command], {
            cwd,
            env: { ...process.env, TERM: 'dumb', COLUMNS: '200' },
            timeout: Math.min(timeout, 120000), // max 2 min
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        // Track for kill support
        const procId = `proc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        runningProcs.set(procId, { child, command, startTime });

        // Send procId header so client can kill
        res.setHeader('X-Shell-Proc-Id', procId);

        child.stdout.on('data', (chunk) => {
            if (stdout.length < MAX_OUTPUT) {
                stdout += chunk.toString();
                if (stdout.length > MAX_OUTPUT) {
                    stdout = stdout.slice(0, MAX_OUTPUT);
                    stdoutTruncated = true;
                }
            }
        });

        child.stderr.on('data', (chunk) => {
            if (stderr.length < MAX_OUTPUT) {
                stderr += chunk.toString();
                if (stderr.length > MAX_OUTPUT) {
                    stderr = stderr.slice(0, MAX_OUTPUT);
                    stderrTruncated = true;
                }
            }
        });

        child.on('close', (code, signal) => {
            runningProcs.delete(procId);
            const duration = Date.now() - startTime;

            // Save output to file for AI referencing
            let outputFile = null;
            try {
                const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
                const sanitized = command.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
                const filename = `${ts}_${sanitized}.txt`;
                const filePath = path.join(shellDir, filename);

                let content = `$ ${command}\n`;
                content += `# cwd: ${cwd}\n`;
                content += `# exit: ${code}${signal ? ` (signal: ${signal})` : ''}\n`;
                content += `# duration: ${duration}ms\n`;
                content += `# ---\n`;
                if (stdout) content += stdout;
                if (stderr) content += `\n# STDERR:\n${stderr}`;
                if (stdoutTruncated || stderrTruncated) content += '\n# (output truncated)\n';

                fs.writeFileSync(filePath, content);
                outputFile = `.deck-shell/${filename}`;
            } catch {} // non-critical

            res.json({
                exitCode: code,
                signal: signal || null,
                stdout,
                stderr,
                truncated: stdoutTruncated || stderrTruncated,
                killed: child.killed,
                cwd,
                outputFile,
                duration,
                procId,
            });
        });

        child.on('error', (err) => {
            runningProcs.delete(procId);
            res.status(500).json({
                error: `Failed to execute: ${err.message}`,
                exitCode: -1,
                stdout: '',
                stderr: '',
                duration: Date.now() - startTime,
            });
        });
    });

    /**
     * POST /api/shell/exec/stream
     * SSE streaming execution - sends output chunks as they arrive
     * Body: { command, workspace?, timeout? }
     */
    app.post('/api/shell/exec/stream', (req, res) => {
        const { command, workspace, timeout = 60000 } = req.body || {};

        if (!command || typeof command !== 'string') {
            return res.status(400).json({ error: 'command is required' });
        }

        const cwd = resolveWorkspaceCwd(workspace);
        const shellDir = ensureShellDir(cwd);
        const startTime = Date.now();

        // SSE headers — use res.set() to work with Express/Helmet middleware
        res.status(200);
        res.set({
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
        });
        res.flushHeaders();

        const MAX_OUTPUT = 64 * 1024;
        let fullStdout = '';
        let fullStderr = '';
        let truncated = false;
        let finished = false; // Track if process already completed

        const child = spawn('bash', ['-c', command], {
            cwd,
            env: { ...process.env, TERM: 'dumb', COLUMNS: '200' },
            timeout: Math.min(timeout, 120000),
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        const procId = `proc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        runningProcs.set(procId, { child, command, startTime });

        // Send procId immediately
        res.write(`data: ${JSON.stringify({ type: 'start', procId })}\n\n`);

        child.stdout.on('data', (chunk) => {
            const text = chunk.toString();
            if (fullStdout.length < MAX_OUTPUT) {
                fullStdout += text;
                if (fullStdout.length > MAX_OUTPUT) { fullStdout = fullStdout.slice(0, MAX_OUTPUT); truncated = true; }
            }
            try { res.write(`data: ${JSON.stringify({ type: 'stdout', text })}\n\n`); } catch {}
        });

        child.stderr.on('data', (chunk) => {
            const text = chunk.toString();
            if (fullStderr.length < MAX_OUTPUT) {
                fullStderr += text;
                if (fullStderr.length > MAX_OUTPUT) { fullStderr = fullStderr.slice(0, MAX_OUTPUT); truncated = true; }
            }
            try { res.write(`data: ${JSON.stringify({ type: 'stderr', text })}\n\n`); } catch {}
        });

        child.on('close', (code, signal) => {
            finished = true;
            runningProcs.delete(procId);
            const duration = Date.now() - startTime;

            // Save output file
            let outputFile = null;
            try {
                const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
                const sanitized = command.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
                const filename = `${ts}_${sanitized}.txt`;
                const filePath = path.join(shellDir, filename);

                let content = `$ ${command}\n# cwd: ${cwd}\n# exit: ${code}${signal ? ` (signal: ${signal})` : ''}\n# duration: ${duration}ms\n# ---\n`;
                if (fullStdout) content += fullStdout;
                if (fullStderr) content += `\n# STDERR:\n${fullStderr}`;
                if (truncated) content += '\n# (output truncated)\n';

                fs.writeFileSync(filePath, content);
                outputFile = `.deck-shell/${filename}`;
            } catch {}

            try {
                res.write(`data: ${JSON.stringify({ type: 'done', exitCode: code, signal: signal || null, killed: child.killed, duration, outputFile, truncated })}\n\n`);
                res.end();
            } catch {}
        });

        child.on('error', (err) => {
            finished = true;
            runningProcs.delete(procId);
            try {
                res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
                res.end();
            } catch {}
        });

        // Handle client disconnect — only kill if process is still running
        res.on('close', () => {
            if (!finished && runningProcs.has(procId)) {
                child.kill('SIGTERM');
                setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 2000);
                runningProcs.delete(procId);
            }
        });
    });

    /**
     * POST /api/shell/kill
     * Body: { procId }
     */
    app.post('/api/shell/kill', (req, res) => {
        const { procId } = req.body || {};
        const proc = runningProcs.get(procId);
        if (!proc) return res.json({ killed: false, error: 'Process not found or already finished' });

        try {
            proc.child.kill('SIGTERM');
            setTimeout(() => { try { proc.child.kill('SIGKILL'); } catch {} }, 2000);
            runningProcs.delete(procId);
            res.json({ killed: true });
        } catch (e) {
            res.json({ killed: false, error: e.message });
        }
    });

    /**
     * POST /api/shell/complete
     * Body: { prefix, workspace? }
     * Returns: { completions: string[] }
     */
    app.post('/api/shell/complete', (req, res) => {
        const { prefix, workspace } = req.body || {};
        if (!prefix || typeof prefix !== 'string') {
            return res.json({ completions: [] });
        }

        const cwd = resolveWorkspaceCwd(workspace);

        // Use bash compgen for file and command completion
        const script = `compgen -f -- ${JSON.stringify(prefix)} 2>/dev/null | head -20; compgen -c -- ${JSON.stringify(prefix)} 2>/dev/null | head -10`;
        const child = spawn('bash', ['-c', script], {
            cwd,
            env: { ...process.env },
            timeout: 3000,
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        let output = '';
        child.stdout.on('data', (chunk) => { output += chunk.toString(); });
        child.on('close', () => {
            const seen = new Set();
            const completions = output.split('\n')
                .map(l => l.trim())
                .filter(l => l && !seen.has(l) && seen.add(l))
                .slice(0, 20);
            res.json({ completions });
        });
        child.on('error', () => { res.json({ completions: [] }); });
    });

    /**
     * GET /api/shell/history?workspace=xxx
     * Returns list of saved shell output files (newest first)
     */
    app.get('/api/shell/history', (req, res) => {
        const workspace = req.query.workspace;
        const cwd = resolveWorkspaceCwd(workspace);
        const shellDir = ensureShellDir(cwd);

        try {
            const files = fs.readdirSync(shellDir)
                .filter(f => f.endsWith('.txt'))
                .sort()
                .reverse()
                .slice(0, 50);

            const entries = files.map(f => {
                const filePath = path.join(shellDir, f);
                const stat = fs.statSync(filePath);
                let command = f;
                let exitCode = 0;
                let duration = 0;
                try {
                    const text = fs.readFileSync(filePath, 'utf8');
                    const lines = text.split('\n');
                    if (lines[0]?.startsWith('$ ')) command = lines[0].slice(2);
                    const exitLine = lines.find(l => l.startsWith('# exit:'));
                    if (exitLine) exitCode = parseInt(exitLine.split(':')[1]) || 0;
                    const durLine = lines.find(l => l.startsWith('# duration:'));
                    if (durLine) duration = parseInt(durLine.split(':')[1]) || 0;
                } catch {}
                return {
                    filename: f,
                    path: `.deck-shell/${f}`,
                    command,
                    exitCode,
                    duration,
                    size: stat.size,
                    time: stat.mtime.toISOString(),
                };
            });

            res.json({ entries, cwd: resolveWorkspaceCwd(workspace) });
        } catch (e) {
            res.status(500).json({ error: e.message, entries: [] });
        }
    });

    /**
     * GET /api/shell/history/:filename?workspace=xxx
     * Returns content of a specific history file
     */
    app.get('/api/shell/history/:filename', (req, res) => {
        const workspace = req.query.workspace;
        const filename = req.params.filename;
        // Security: prevent path traversal
        if (filename.includes('..') || filename.includes('/')) {
            return res.status(403).json({ error: 'Invalid filename' });
        }
        const cwd = resolveWorkspaceCwd(workspace);
        const shellDir = ensureShellDir(cwd);
        const filePath = path.join(shellDir, filename);

        try {
            if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
            const content = fs.readFileSync(filePath, 'utf8');
            res.json({ content, filename });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    /**
     * DELETE /api/shell/history?workspace=xxx
     * Clear all shell output files
     */
    app.delete('/api/shell/history', (req, res) => {
        const workspace = req.query.workspace;
        const cwd = resolveWorkspaceCwd(workspace);
        const shellDir = ensureShellDir(cwd);

        try {
            const files = fs.readdirSync(shellDir).filter(f => f.endsWith('.txt'));
            files.forEach(f => fs.unlinkSync(path.join(shellDir, f)));
            res.json({ cleared: files.length });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
};
