'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { cn } from '@/lib/utils';
import { shellExec, getShellHistory, clearShellHistory } from '@/lib/cascade-api';
import type { ShellExecResult, ShellHistoryEntry } from '@/lib/cascade-api';
import {
    Terminal, X, Trash2, RefreshCw, CheckCircle2, XCircle,
    Clock, ChevronDown, ChevronUp, Copy, Check, Send,
} from 'lucide-react';

interface ShellPanelProps {
    workspace: string;
    onClose: () => void;
}

/** Single command entry in the live session */
interface ShellEntry {
    id: string;
    command: string;
    result: ShellExecResult | null;
    running: boolean;
    error?: string;
}

export function ShellPanel({ workspace, onClose }: ShellPanelProps) {
    const [input, setInput] = useState('');
    const [entries, setEntries] = useState<ShellEntry[]>([]);
    const [history, setHistory] = useState<ShellHistoryEntry[]>([]);
    const [showHistory, setShowHistory] = useState(false);
    const [sending, setSending] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);
    const scrollRef = useRef<HTMLDivElement>(null);
    // Command history navigation
    const cmdHistoryRef = useRef<string[]>([]);
    const cmdIdxRef = useRef(-1);

    // Auto-focus input
    useEffect(() => { inputRef.current?.focus(); }, []);

    // Scroll to bottom on new entries
    useEffect(() => {
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    }, [entries]);

    // Load file history
    const loadHistory = useCallback(async () => {
        try {
            const data = await getShellHistory(workspace);
            setHistory(data.entries);
        } catch {}
    }, [workspace]);

    useEffect(() => { loadHistory(); }, [loadHistory]);

    const handleExec = useCallback(async () => {
        const cmd = input.trim();
        if (!cmd || sending) return;

        // Save to command history
        cmdHistoryRef.current = [cmd, ...cmdHistoryRef.current.filter(c => c !== cmd)].slice(0, 50);
        cmdIdxRef.current = -1;

        const entryId = `cmd-${Date.now()}`;
        setEntries(prev => [...prev, { id: entryId, command: cmd, result: null, running: true }]);
        setInput('');
        setSending(true);

        try {
            const result = await shellExec(cmd, workspace);
            setEntries(prev => prev.map(e =>
                e.id === entryId ? { ...e, result, running: false } : e
            ));
            // Refresh file history
            loadHistory();
        } catch (err: any) {
            setEntries(prev => prev.map(e =>
                e.id === entryId ? { ...e, running: false, error: err.message || 'exec failed' } : e
            ));
        } finally {
            setSending(false);
            inputRef.current?.focus();
        }
    }, [input, sending, workspace, loadHistory]);

    const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleExec();
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            const hist = cmdHistoryRef.current;
            if (hist.length > 0) {
                const next = Math.min(cmdIdxRef.current + 1, hist.length - 1);
                cmdIdxRef.current = next;
                setInput(hist[next]);
            }
        } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            const hist = cmdHistoryRef.current;
            const next = cmdIdxRef.current - 1;
            if (next < 0) {
                cmdIdxRef.current = -1;
                setInput('');
            } else {
                cmdIdxRef.current = next;
                setInput(hist[next]);
            }
        } else if (e.key === 'l' && e.ctrlKey) {
            e.preventDefault();
            setEntries([]);
        }
    }, [handleExec]);

    const handleClearHistory = useCallback(async () => {
        try {
            await clearShellHistory(workspace);
            setHistory([]);
        } catch {}
    }, [workspace]);

    return (
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden bg-background">
            {/* Header */}
            <div className="flex items-center justify-between px-3 h-10 border-b border-border/40 shrink-0 bg-muted/5">
                <div className="flex items-center gap-2">
                    <Terminal className="h-4 w-4 text-emerald-400" />
                    <span className="text-sm font-medium text-foreground/80">Shell</span>
                    <span className="text-[10px] text-muted-foreground/40 font-mono truncate max-w-[200px]">{workspace}</span>
                </div>
                <div className="flex items-center gap-1">
                    <button
                        onClick={() => setShowHistory(v => !v)}
                        className={cn(
                            "px-2 py-1 rounded text-[10px] transition-colors",
                            showHistory ? "bg-primary/20 text-primary" : "text-muted-foreground/50 hover:text-muted-foreground"
                        )}
                        title="Toggle saved outputs"
                    >
                        History ({history.length})
                    </button>
                    <button
                        onClick={() => setEntries([])}
                        className="p-1.5 rounded hover:bg-muted/30 text-muted-foreground/40 hover:text-muted-foreground transition-colors"
                        title="Clear terminal (Ctrl+L)"
                    >
                        <Trash2 className="h-3.5 w-3.5" />
                    </button>
                    <button
                        onClick={onClose}
                        className="p-1.5 rounded hover:bg-muted/30 text-muted-foreground/40 hover:text-muted-foreground transition-colors"
                        title="Close shell"
                    >
                        <X className="h-3.5 w-3.5" />
                    </button>
                </div>
            </div>

            <div className="flex-1 flex min-h-0 overflow-hidden">
                {/* Main terminal output */}
                <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
                    <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-2 font-mono text-xs space-y-1">
                        {entries.length === 0 && (
                            <div className="flex flex-col items-center justify-center h-full text-muted-foreground/20 gap-2">
                                <Terminal className="h-8 w-8" />
                                <p className="text-xs">Type a command below</p>
                                <p className="text-[10px] text-muted-foreground/15">Output is saved to .deck-shell/ for AI reference</p>
                            </div>
                        )}
                        {entries.map(entry => (
                            <CommandEntry key={entry.id} entry={entry} />
                        ))}
                    </div>

                    {/* Input line */}
                    <div className="border-t border-border/30 px-3 py-2 flex items-center gap-2 shrink-0 bg-muted/5">
                        <span className="text-emerald-400 text-xs font-bold shrink-0">$</span>
                        <input
                            ref={inputRef}
                            type="text"
                            value={input}
                            onChange={e => setInput(e.target.value)}
                            onKeyDown={handleKeyDown}
                            placeholder="Enter command..."
                            className="flex-1 bg-transparent border-none outline-none text-xs font-mono text-foreground placeholder:text-muted-foreground/30"
                            disabled={sending}
                            autoComplete="off"
                            spellCheck={false}
                        />
                        <button
                            onClick={handleExec}
                            disabled={!input.trim() || sending}
                            className="p-1 rounded hover:bg-muted/30 text-muted-foreground/50 hover:text-foreground disabled:opacity-30 transition-colors"
                        >
                            <Send className="h-3.5 w-3.5" />
                        </button>
                    </div>
                </div>

                {/* History sidebar */}
                {showHistory && (
                    <div className="w-[220px] border-l border-border/30 flex flex-col overflow-hidden shrink-0">
                        <div className="flex items-center justify-between px-2 h-8 border-b border-border/20 shrink-0">
                            <span className="text-[10px] text-muted-foreground/50 font-medium">Saved Outputs</span>
                            <div className="flex items-center gap-1">
                                <button onClick={loadHistory} className="p-0.5 rounded hover:bg-muted/30 text-muted-foreground/30" title="Refresh">
                                    <RefreshCw className="h-2.5 w-2.5" />
                                </button>
                                {history.length > 0 && (
                                    <button onClick={handleClearHistory} className="p-0.5 rounded hover:bg-red-500/20 text-muted-foreground/30 hover:text-red-400" title="Clear all">
                                        <Trash2 className="h-2.5 w-2.5" />
                                    </button>
                                )}
                            </div>
                        </div>
                        <div className="flex-1 overflow-y-auto py-1">
                            {history.length === 0 ? (
                                <div className="px-3 py-6 text-center text-[10px] text-muted-foreground/20">No saved outputs</div>
                            ) : (
                                history.map(h => (
                                    <div
                                        key={h.filename}
                                        className="px-2 py-1.5 hover:bg-muted/20 transition-colors cursor-default"
                                        title={`${h.path}\n${h.command}`}
                                    >
                                        <div className="flex items-center gap-1 mb-0.5">
                                            {h.exitCode === 0 ? (
                                                <CheckCircle2 className="h-2.5 w-2.5 text-emerald-400/60 shrink-0" />
                                            ) : (
                                                <XCircle className="h-2.5 w-2.5 text-red-400/60 shrink-0" />
                                            )}
                                            <span className="text-[10px] font-mono text-foreground/60 truncate">{h.command}</span>
                                        </div>
                                        <div className="flex items-center gap-2 text-[9px] text-muted-foreground/30 pl-3.5">
                                            <span>{new Date(h.time).toLocaleTimeString()}</span>
                                            <CopyablePath path={h.path} />
                                        </div>
                                    </div>
                                ))
                            )}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}

/** Single command + output display */
function CommandEntry({ entry }: { entry: ShellEntry }) {
    const [collapsed, setCollapsed] = useState(false);
    const [copied, setCopied] = useState(false);
    const { command, result, running, error } = entry;
    const output = result ? (result.stdout || result.stderr || '') : '';
    const lines = output.split('\n');
    const isLong = lines.length > 40;
    const [showFull, setShowFull] = useState(!isLong);

    const handleCopy = () => {
        navigator.clipboard.writeText(output).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        });
    };

    return (
        <div className="group">
            {/* Command line */}
            <div className="flex items-center gap-1.5 py-0.5">
                <span className="text-emerald-400 font-bold shrink-0">$</span>
                <span className="text-foreground/90 flex-1">{command}</span>
                {running && (
                    <span className="flex items-center gap-1 text-[10px] text-amber-400/70">
                        <Clock className="h-3 w-3 animate-spin" /> running...
                    </span>
                )}
                {result && (
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button onClick={handleCopy} className="p-0.5 hover:bg-muted/30 rounded" title="Copy output">
                            {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3 text-muted-foreground/40" />}
                        </button>
                        <button onClick={() => setCollapsed(v => !v)} className="p-0.5 hover:bg-muted/30 rounded">
                            {collapsed ? <ChevronDown className="h-3 w-3 text-muted-foreground/40" /> : <ChevronUp className="h-3 w-3 text-muted-foreground/40" />}
                        </button>
                        {result.exitCode !== 0 && (
                            <span className="text-[9px] text-red-400/70 ml-0.5">exit {result.exitCode}</span>
                        )}
                    </div>
                )}
            </div>

            {/* Output */}
            {error && !result && (
                <div className="pl-4 text-red-400/80 text-[11px] py-0.5">{error}</div>
            )}
            {result && !collapsed && output && (
                <div className="pl-4 text-foreground/60 whitespace-pre-wrap break-all">
                    {showFull ? output : lines.slice(0, 40).join('\n')}
                    {isLong && (
                        <button
                            onClick={() => setShowFull(v => !v)}
                            className="block text-[9px] text-primary/60 hover:text-primary mt-0.5"
                        >
                            {showFull ? `▲ Collapse (${lines.length} lines)` : `▼ Show all ${lines.length} lines`}
                        </button>
                    )}
                    {result.truncated && (
                        <span className="text-[9px] text-amber-400/50 block">⚠ truncated (64KB limit)</span>
                    )}
                </div>
            )}
            {result && result.outputFile && (
                <OutputFilePath path={result.outputFile} />
            )}
        </div>
    );
}

/** Output file path with copy button */
function OutputFilePath({ path }: { path: string }) {
    return (
        <div className="pl-4 flex items-center gap-1 mt-0.5">
            <span className="text-[9px] text-muted-foreground/25">→</span>
            <CopyablePath path={path} />
        </div>
    );
}

/** Clickable path with always-visible copy icon */
function CopyablePath({ path }: { path: string }) {
    const [copied, setCopied] = useState(false);
    const handleCopy = () => {
        navigator.clipboard.writeText(path).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        });
    };
    return (
        <button
            onClick={handleCopy}
            className="inline-flex items-center gap-1 text-[9px] text-muted-foreground/30 hover:text-muted-foreground/60 font-mono transition-colors"
            title="Copy path"
        >
            <span className={copied ? 'text-emerald-400' : ''}>{copied ? 'Copied!' : path}</span>
            {copied
                ? <Check className="h-2.5 w-2.5 text-emerald-400 shrink-0" />
                : <Copy className="h-2.5 w-2.5 shrink-0" />
            }
        </button>
    );
}
