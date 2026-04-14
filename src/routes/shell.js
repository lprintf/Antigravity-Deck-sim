// /api/shell/* — Execute shell commands in workspace context
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

module.exports = function registerShellRoutes(app) {
    const { getSettings, lsInstances } = require('../config');

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
     * Body: { command: string, workspace?: string, timeout?: number }
     * Response: { exitCode, stdout, stderr, truncated, killed, cwd, outputFile }
     */
    app.post('/api/shell/exec', (req, res) => {
        const { command, workspace, timeout = 30000 } = req.body || {};

        if (!command || typeof command !== 'string') {
            return res.status(400).json({ error: 'command is required' });
        }

        const cwd = resolveWorkspaceCwd(workspace);
        const shellDir = ensureShellDir(cwd);

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
            });
        });

        child.on('error', (err) => {
            res.status(500).json({
                error: `Failed to execute: ${err.message}`,
                exitCode: -1,
                stdout: '',
                stderr: '',
            });
        });
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
                .slice(0, 50); // max 50 entries

            const entries = files.map(f => {
                const filePath = path.join(shellDir, f);
                const stat = fs.statSync(filePath);
                // Parse command from first line
                let command = f;
                try {
                    const first = fs.readFileSync(filePath, 'utf8').split('\n')[0];
                    if (first.startsWith('$ ')) command = first.slice(2);
                } catch {}
                // Parse exit code from third line
                let exitCode = 0;
                try {
                    const lines = fs.readFileSync(filePath, 'utf8').split('\n');
                    const exitLine = lines.find(l => l.startsWith('# exit:'));
                    if (exitLine) exitCode = parseInt(exitLine.split(':')[1]) || 0;
                } catch {}
                return {
                    filename: f,
                    path: `.deck-shell/${f}`,
                    command,
                    exitCode,
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
