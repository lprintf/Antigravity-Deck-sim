'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { cn } from '@/lib/utils';
import {
    shellExec, shellExecStream, shellKill, shellComplete,
    getShellHistory, getShellHistoryContent, clearShellHistory,
} from '@/lib/cascade-api';
import type { ShellExecResult, ShellHistoryEntry, ShellStreamEvent } from '@/lib/cascade-api';
import {
    Terminal, X, Trash2, RefreshCw, CheckCircle2, XCircle,
    Clock, ChevronDown, ChevronUp, Copy, Check, Send,
    Square, ArrowUp, ArrowDown, ArrowLeft, History, Play, Timer,
    Zap,
} from 'lucide-react';

interface ShellPanelProps {
    workspace: string;
    onClose: () => void;
}

type ShellTab = 'run' | 'history';

/** Single command entry in the live session */
interface ShellEntry {
    id: string;
    command: string;
    stdout: string;
    stderr: string;
    exitCode: number | null;
    signal: string | null;
    running: boolean;
    error?: string;
    outputFile?: string | null;
    duration?: number;
    procId?: string;
    startTime: number;
    abortController?: AbortController;
}

// ─── Quick Commands ─────────────────────────────────────────────────────────
const QUICK_COMMANDS = [
    { label: 'ls', cmd: 'ls -la' },
    { label: 'git st', cmd: 'git status -s' },
    { label: 'pwd', cmd: 'pwd' },
    { label: 'df', cmd: 'df -h' },
    { label: 'ps', cmd: 'ps aux | head -20' },
];

// ─── Main Panel ─────────────────────────────────────────────────────────────
export function ShellPanel({ workspace, onClose }: ShellPanelProps) {
    const [activeTab, setActiveTab] = useState<ShellTab>('run');

    // On mobile, virtual keyboard doesn't shrink dvh/vh.
    // Set --app-h CSS variable on the root element so the entire layout adjusts.
    useEffect(() => {
        const vv = window.visualViewport;
        if (!vv) return;
        const isTouchDevice = !window.matchMedia('(pointer: fine)').matches;
        if (!isTouchDevice) return;

        const root = document.documentElement;
        const update = () => {
            root.style.setProperty('--app-h', `${vv.height}px`);
        };
        const reset = () => {
            root.style.removeProperty('--app-h');
        };

        vv.addEventListener('resize', update);
        return () => {
            vv.removeEventListener('resize', update);
            reset();
        };
    }, []);

    return (
        <div className="h-full flex flex-col bg-background">
            {/* Header with tabs */}
            <div className="flex items-center justify-between px-3 h-10 border-b border-border/40 shrink-0 bg-muted/5">
                <div className="flex items-center gap-1">
                    <Terminal className="h-4 w-4 text-emerald-400 mr-1" />
                    <button
                        onClick={() => setActiveTab('run')}
                        className={cn(
                            'px-2.5 py-1 rounded text-xs font-medium transition-colors',
                            activeTab === 'run'
                                ? 'bg-emerald-500/15 text-emerald-400'
                                : 'text-muted-foreground/50 hover:text-muted-foreground'
                        )}
                    >
                        <Play className="h-3 w-3 inline mr-1" />Run
                    </button>
                    <button
                        onClick={() => setActiveTab('history')}
                        className={cn(
                            'px-2.5 py-1 rounded text-xs font-medium transition-colors',
                            activeTab === 'history'
                                ? 'bg-primary/15 text-primary'
                                : 'text-muted-foreground/50 hover:text-muted-foreground'
                        )}
                    >
                        <History className="h-3 w-3 inline mr-1" />History
                    </button>
                    <span className="text-[10px] text-muted-foreground/30 font-mono truncate max-w-[120px] ml-1 hidden sm:inline">{workspace}</span>
                </div>
                <button
                    onClick={onClose}
                    className="p-1.5 rounded hover:bg-muted/30 text-muted-foreground/40 hover:text-muted-foreground transition-colors"
                    title="Close shell"
                >
                    <X className="h-3.5 w-3.5" />
                </button>
            </div>

            {/* Tab content - must fill remaining space */}
            <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
                {activeTab === 'run' ? (
                    <RunTab workspace={workspace} />
                ) : (
                    <HistoryTab workspace={workspace} />
                )}
            </div>
        </div>
    );
}

// ─── Run Tab ────────────────────────────────────────────────────────────────
function RunTab({ workspace }: { workspace: string }) {
    const [input, setInput] = useState('');
    const [entries, setEntries] = useState<ShellEntry[]>([]);
    const [sending, setSending] = useState(false);
    const [completions, setCompletions] = useState<string[]>([]);
    const [showCompletions, setShowCompletions] = useState(false);
    const [selectedCompletion, setSelectedCompletion] = useState(0);
    const inputRef = useRef<HTMLInputElement>(null);
    const scrollRef = useRef<HTMLDivElement>(null);
    const cmdHistoryRef = useRef<string[]>([]);
    const cmdIdxRef = useRef(-1);
    const completionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Helper: only focus on desktop — on mobile, programmatic focus triggers soft keyboard
    const focusInput = useCallback(() => {
        if (window.matchMedia('(pointer: fine)').matches) {
            inputRef.current?.focus();
        }
    }, []);

    useEffect(() => { focusInput(); }, [focusInput]);

    // Scroll to bottom on new entries
    useEffect(() => {
        requestAnimationFrame(() => {
            scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
        });
    }, [entries]);

    // Tab completion debounce
    const fetchCompletions = useCallback(async (text: string) => {
        if (!text.trim()) { setCompletions([]); setShowCompletions(false); return; }
        const parts = text.split(/\s+/);
        const prefix = parts[parts.length - 1];
        if (!prefix) { setCompletions([]); setShowCompletions(false); return; }
        try {
            const results = await shellComplete(prefix, workspace);
            setCompletions(results);
            setShowCompletions(results.length > 0);
            setSelectedCompletion(0);
        } catch { setCompletions([]); setShowCompletions(false); }
    }, [workspace]);

    const handleInputChange = useCallback((val: string) => {
        setInput(val);
        cmdIdxRef.current = -1;
        if (completionTimerRef.current) clearTimeout(completionTimerRef.current);
        completionTimerRef.current = setTimeout(() => fetchCompletions(val), 300);
    }, [fetchCompletions]);

    const applyCompletion = useCallback((completion: string) => {
        const parts = input.split(/\s+/);
        parts[parts.length - 1] = completion;
        setInput(parts.join(' ') + (completion.endsWith('/') ? '' : ' '));
        setShowCompletions(false);
        focusInput();
    }, [input]);

    /** Execute via SSE stream, with fallback to regular exec */
    const handleExec = useCallback((cmdOverride?: string) => {
        const cmd = (cmdOverride || input).trim();
        if (!cmd) return;

        // Save to command history
        cmdHistoryRef.current = [cmd, ...cmdHistoryRef.current.filter(c => c !== cmd)].slice(0, 50);
        cmdIdxRef.current = -1;

        const entryId = `cmd-${Date.now()}`;
        const newEntry: ShellEntry = {
            id: entryId, command: cmd, stdout: '', stderr: '',
            exitCode: null, signal: null, running: true,
            startTime: Date.now(),
        };

        setEntries(prev => [...prev, newEntry]);
        setInput('');
        setShowCompletions(false);
        setSending(true);

        let sseWorked = false;

        // Attempt SSE streaming
        try {
            const controller = shellExecStream(cmd, workspace, (event: ShellStreamEvent) => {
                sseWorked = true;
                setEntries(prev => prev.map(e => {
                    if (e.id !== entryId) return e;
                    switch (event.type) {
                        case 'start':
                            return { ...e, procId: event.procId };
                        case 'stdout':
                            return { ...e, stdout: e.stdout + (event.text || '') };
                        case 'stderr':
                            return { ...e, stderr: e.stderr + (event.text || '') };
                        case 'done':
                            return {
                                ...e, running: false,
                                exitCode: event.exitCode ?? null,
                                signal: event.signal ?? null,
                                outputFile: event.outputFile,
                                duration: event.duration,
                            };
                        case 'error':
                            // SSE error → try fallback
                            if (!sseWorked) {
                                execFallback(entryId, cmd);
                                return e;
                            }
                            return { ...e, running: false, error: event.message };
                        default: return e;
                    }
                }));
                if (event.type === 'done' || event.type === 'error') {
                    setSending(false);
                    focusInput();
                }
            });

            // Store abort controller
            setEntries(prev => prev.map(e =>
                e.id === entryId ? { ...e, abortController: controller } : e
            ));
        } catch {
            // SSE not available, use fallback
            execFallback(entryId, cmd);
        }
    }, [input, workspace]);

    /** Fallback: use regular POST /api/shell/exec */
    const execFallback = useCallback(async (entryId: string, cmd: string) => {
        try {
            const result = await shellExec(cmd, workspace);
            setEntries(prev => prev.map(e =>
                e.id === entryId ? {
                    ...e,
                    running: false,
                    stdout: result.stdout || '',
                    stderr: result.stderr || '',
                    exitCode: result.exitCode,
                    signal: result.signal,
                    outputFile: result.outputFile,
                    duration: result.duration,
                } : e
            ));
        } catch (err: any) {
            setEntries(prev => prev.map(e =>
                e.id === entryId ? { ...e, running: false, error: err.message || 'exec failed' } : e
            ));
        } finally {
            setSending(false);
            focusInput();
        }
    }, [workspace]);

    const handleStop = useCallback(async (entry: ShellEntry) => {
        if (entry.procId) {
            await shellKill(entry.procId);
        }
        entry.abortController?.abort();
    }, []);

    const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
        if (showCompletions && completions.length > 0) {
            if (e.key === 'Tab') {
                e.preventDefault();
                // Accept selected completion on Tab
                applyCompletion(completions[selectedCompletion]);
                return;
            }
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                setSelectedCompletion(prev => (prev + 1) % completions.length);
                return;
            }
            if (e.key === 'ArrowUp') {
                e.preventDefault();
                setSelectedCompletion(prev => (prev - 1 + completions.length) % completions.length);
                return;
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                setShowCompletions(false);
                return;
            }
            // Enter falls through — always execute command
        }

        if (e.key === 'Tab') {
            e.preventDefault();
            fetchCompletions(input);
            return;
        }
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleExec();
        } else if (e.key === 'ArrowUp' && !showCompletions) {
            e.preventDefault();
            const hist = cmdHistoryRef.current;
            if (hist.length > 0) {
                const next = Math.min(cmdIdxRef.current + 1, hist.length - 1);
                cmdIdxRef.current = next;
                setInput(hist[next]);
            }
        } else if (e.key === 'ArrowDown' && !showCompletions) {
            e.preventDefault();
            const next = cmdIdxRef.current - 1;
            if (next < 0) { cmdIdxRef.current = -1; setInput(''); }
            else { cmdIdxRef.current = next; setInput(cmdHistoryRef.current[next]); }
        } else if (e.key === 'l' && e.ctrlKey) {
            e.preventDefault();
            setEntries([]);
        } else if (e.key === 'c' && e.ctrlKey && sending) {
            e.preventDefault();
            const running = entries.find(e => e.running);
            if (running) handleStop(running);
        }
    }, [handleExec, showCompletions, completions, selectedCompletion, applyCompletion, fetchCompletions, input, sending, entries, handleStop]);

    const navigateHistory = useCallback((direction: 'up' | 'down') => {
        const hist = cmdHistoryRef.current;
        if (direction === 'up') {
            if (hist.length > 0) {
                const next = Math.min(cmdIdxRef.current + 1, hist.length - 1);
                cmdIdxRef.current = next;
                setInput(hist[next]);
            }
        } else {
            const next = cmdIdxRef.current - 1;
            if (next < 0) { cmdIdxRef.current = -1; setInput(''); }
            else { cmdIdxRef.current = next; setInput(hist[next]); }
        }
    }, []);

    return (
        <div className="flex-1 flex flex-col min-h-0">
            {/* Output area — grows to fill, pushes input to bottom */}
            <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-3 py-2 font-mono text-xs space-y-1">
                {entries.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-12 text-muted-foreground/20 gap-2">
                        <Terminal className="h-8 w-8" />
                        <p className="text-xs">Type a command below</p>
                        <p className="text-[10px] text-muted-foreground/15">Output saved to .deck-shell/ for AI reference</p>
                    </div>
                ) : (
                    entries.map(entry => (
                        <StreamingEntry key={entry.id} entry={entry} onStop={handleStop} />
                    ))
                )}
            </div>

            {/* Completion dropdown — above input */}
            {showCompletions && completions.length > 0 && (
                <div className="mx-3 mb-1 border border-border/40 rounded-md bg-popover shadow-lg max-h-[120px] overflow-y-auto shrink-0">
                    {completions.map((c, i) => (
                        <button
                            key={c}
                            onClick={() => applyCompletion(c)}
                            className={cn(
                                'w-full text-left px-3 py-1 text-xs font-mono transition-colors',
                                i === selectedCompletion
                                    ? 'bg-primary/15 text-primary'
                                    : 'text-foreground/70 hover:bg-muted/30'
                            )}
                        >
                            {c}
                        </button>
                    ))}
                </div>
            )}

            {/* Input area — pinned to bottom */}
            <div className="shrink-0 border-t border-border/30 bg-muted/5">
                {/* Quick commands toolbar */}
                <div className="flex items-center gap-1 px-3 pt-1.5 pb-1 overflow-x-auto scrollbar-none">
                    {QUICK_COMMANDS.map(q => (
                        <button
                            key={q.cmd}
                            onClick={() => handleExec(q.cmd)}
                            className="px-2 py-0.5 rounded border border-border/20 text-[10px] font-mono text-muted-foreground/40 hover:text-foreground/70 hover:border-border/50 hover:bg-muted/20 active:bg-muted/40 transition-all whitespace-nowrap shrink-0"
                        >
                            <Zap className="h-2.5 w-2.5 inline mr-0.5 opacity-40" />{q.label}
                        </button>
                    ))}
                    <button
                        onClick={() => setEntries([])}
                        className="px-2 py-0.5 rounded text-[10px] text-muted-foreground/30 hover:text-muted-foreground/60 transition-colors whitespace-nowrap shrink-0 ml-auto"
                        title="Clear terminal (Ctrl+L)"
                    >
                        <Trash2 className="h-2.5 w-2.5 inline mr-0.5" />clear
                    </button>
                </div>
                {/* Input line */}
                <div className="flex items-center gap-1.5 px-3 pb-2 pt-0.5">
                    <span className="text-emerald-400 text-xs font-bold shrink-0">$</span>
                    <input
                        ref={inputRef}
                        type="text"
                        value={input}
                        onChange={e => handleInputChange(e.target.value)}
                        onKeyDown={handleKeyDown}
                        placeholder="Enter command..."
                        className="flex-1 bg-transparent border-none outline-none text-xs font-mono text-foreground placeholder:text-muted-foreground/30 min-w-0"
                        autoComplete="off"
                        spellCheck={false}
                    />
                    <button
                        onClick={() => navigateHistory('up')}
                        className="p-1.5 rounded hover:bg-muted/30 text-muted-foreground/40 active:text-foreground transition-colors sm:p-1"
                        title="Previous command"
                    >
                        <ArrowUp className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
                    </button>
                    <button
                        onClick={() => navigateHistory('down')}
                        className="p-1.5 rounded hover:bg-muted/30 text-muted-foreground/40 active:text-foreground transition-colors sm:p-1"
                        title="Next command"
                    >
                        <ArrowDown className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
                    </button>
                    {sending ? (
                        <button
                            onClick={() => { const r = entries.find(e => e.running); if (r) handleStop(r); }}
                            className="p-1.5 rounded bg-red-500/20 text-red-400 hover:bg-red-500/30 active:bg-red-500/40 transition-colors sm:p-1"
                            title="Stop (Ctrl+C)"
                        >
                            <Square className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
                        </button>
                    ) : (
                        <button
                            onClick={() => handleExec()}
                            disabled={!input.trim()}
                            className="p-1.5 rounded hover:bg-emerald-500/20 text-muted-foreground/50 hover:text-emerald-400 disabled:opacity-30 active:bg-emerald-500/30 transition-colors sm:p-1"
                        >
                            <Send className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}

// ─── Streaming Entry ────────────────────────────────────────────────────────
function StreamingEntry({ entry, onStop }: { entry: ShellEntry; onStop: (e: ShellEntry) => void }) {
    const [collapsed, setCollapsed] = useState(false);
    const [copied, setCopied] = useState(false);
    const { command, stdout, stderr, exitCode, running, error, duration, outputFile } = entry;
    const output = stdout || stderr || '';
    const lines = output.split('\n');
    const isLong = lines.length > 60;
    const [showFull, setShowFull] = useState(true);
    const elapsedRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const [elapsed, setElapsed] = useState(0);

    // Live elapsed timer
    useEffect(() => {
        if (running) {
            elapsedRef.current = setInterval(() => {
                setElapsed(Date.now() - entry.startTime);
            }, 200);
            return () => { if (elapsedRef.current) clearInterval(elapsedRef.current); };
        } else {
            if (elapsedRef.current) clearInterval(elapsedRef.current);
        }
    }, [running, entry.startTime]);

    const handleCopy = () => {
        navigator.clipboard.writeText(output).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        });
    };

    const formatDuration = (ms: number) => {
        if (ms < 1000) return `${ms}ms`;
        if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
        return `${Math.floor(ms / 60000)}m${Math.floor((ms % 60000) / 1000)}s`;
    };

    return (
        <div className="group">
            {/* Command line */}
            <div className="flex items-center gap-1.5 py-0.5 flex-wrap">
                <span className="text-emerald-400 font-bold shrink-0">$</span>
                <span className="text-foreground/90 flex-1 min-w-0 break-all">{command}</span>
                <div className="flex items-center gap-1 shrink-0">
                    {running && (
                        <>
                            <span className="text-[10px] text-amber-400/70 tabular-nums">
                                {formatDuration(elapsed)}
                            </span>
                            <button
                                onClick={() => onStop(entry)}
                                className="p-0.5 rounded bg-red-500/20 text-red-400 hover:bg-red-500/30"
                                title="Stop"
                            >
                                <Square className="h-3 w-3" />
                            </button>
                        </>
                    )}
                    {!running && duration != null && (
                        <span className="text-[9px] text-muted-foreground/30 flex items-center gap-0.5">
                            <Timer className="h-2.5 w-2.5" />{formatDuration(duration)}
                        </span>
                    )}
                    {!running && exitCode !== null && exitCode !== 0 && (
                        <span className="text-[9px] px-1 py-0.5 rounded bg-red-500/15 text-red-400/80">
                            exit {exitCode}
                        </span>
                    )}
                    {!running && exitCode === 0 && (
                        <CheckCircle2 className="h-3 w-3 text-emerald-400/40" />
                    )}
                    {!running && output && (
                        <>
                            <button onClick={handleCopy} className="p-0.5 hover:bg-muted/30 rounded" title="Copy output">
                                {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3 text-muted-foreground/30" />}
                            </button>
                            <button onClick={() => setCollapsed(v => !v)} className="p-0.5 hover:bg-muted/30 rounded">
                                {collapsed ? <ChevronDown className="h-3 w-3 text-muted-foreground/30" /> : <ChevronUp className="h-3 w-3 text-muted-foreground/30" />}
                            </button>
                        </>
                    )}
                </div>
            </div>

            {/* Output */}
            {error && (
                <div className="pl-4 text-red-400/80 text-[11px] py-0.5">{error}</div>
            )}
            {!collapsed && output && (
                <div className="pl-4 text-foreground/60 whitespace-pre-wrap break-all text-[11px]">
                    {showFull || !isLong ? output : lines.slice(0, 60).join('\n')}
                    {isLong && (
                        <button
                            onClick={() => setShowFull(v => !v)}
                            className="block text-[9px] text-primary/60 hover:text-primary mt-0.5"
                        >
                            {showFull ? `▲ Collapse (${lines.length} lines)` : `▼ Show all ${lines.length} lines`}
                        </button>
                    )}
                </div>
            )}
            {outputFile && (
                <div className="pl-4 flex items-center gap-1 mt-0.5">
                    <span className="text-[9px] text-muted-foreground/25">→</span>
                    <CopyablePath path={outputFile} />
                </div>
            )}
        </div>
    );
}

// ─── History Tab ────────────────────────────────────────────────────────────
function HistoryTab({ workspace }: { workspace: string }) {
    const [history, setHistory] = useState<ShellHistoryEntry[]>([]);
    const [loading, setLoading] = useState(true);
    const [selectedFile, setSelectedFile] = useState<string | null>(null);
    const [selectedCmd, setSelectedCmd] = useState<string>('');
    const [content, setContent] = useState<string | null>(null);
    const [contentLoading, setContentLoading] = useState(false);
    const [mobileListOpen, setMobileListOpen] = useState(true);

    const loadHistory = useCallback(async () => {
        setLoading(true);
        try {
            const data = await getShellHistory(workspace);
            setHistory(data.entries);
        } catch {}
        finally { setLoading(false); }
    }, [workspace]);

    useEffect(() => { loadHistory(); }, [loadHistory]);

    const handleSelect = useCallback(async (entry: ShellHistoryEntry) => {
        setSelectedFile(entry.filename);
        setSelectedCmd(entry.command);
        setContentLoading(true);
        setContent(null);
        setMobileListOpen(false); // auto-collapse list on mobile when file selected
        try {
            const text = await getShellHistoryContent(entry.filename, workspace);
            setContent(text);
        } catch (e: any) {
            setContent(`Error: ${e.message}`);
        }
        finally { setContentLoading(false); }
    }, [workspace]);

    const handleClear = useCallback(async () => {
        try {
            await clearShellHistory(workspace);
            setHistory([]);
            setSelectedFile(null);
            setContent(null);
        } catch {}
    }, [workspace]);

    const formatDuration = (ms: number) => {
        if (!ms) return '';
        if (ms < 1000) return `${ms}ms`;
        if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
        return `${Math.floor(ms / 60000)}m${Math.floor((ms % 60000) / 1000)}s`;
    };

    return (
        <div className="flex-1 flex min-h-0 overflow-hidden relative">
            {/* Left: history list — desktop: always visible, mobile: slide in/out */}
            <div className={cn(
                'shrink-0 border-r border-border/30 flex flex-col min-h-0 overflow-hidden transition-all duration-200',
                // Desktop: always shown fixed width
                'md:w-[220px] xl:w-[260px] md:translate-x-0 md:relative md:flex',
                // Mobile: slide in/out
                mobileListOpen
                    ? 'w-[220px] flex absolute inset-y-0 left-0 z-10 bg-background'
                    : 'w-0 hidden',
            )}>
                <div className="flex items-center justify-between px-2 h-8 border-b border-border/20 shrink-0">
                    <span className="text-[10px] text-muted-foreground/50 font-medium">
                        {history.length} saved output{history.length !== 1 ? 's' : ''}
                    </span>
                    <div className="flex items-center gap-1">
                        <button onClick={loadHistory} className="p-0.5 rounded hover:bg-muted/30 text-muted-foreground/30" title="Refresh">
                            <RefreshCw className="h-2.5 w-2.5" />
                        </button>
                        {history.length > 0 && (
                            <button onClick={handleClear} className="p-0.5 rounded hover:bg-red-500/20 text-muted-foreground/30 hover:text-red-400" title="Clear all">
                                <Trash2 className="h-2.5 w-2.5" />
                            </button>
                        )}
                        {/* Mobile: close panel button */}
                        <button
                            onClick={() => setMobileListOpen(false)}
                            className="md:hidden p-0.5 rounded hover:bg-muted/30 text-muted-foreground/30"
                            title="Close list"
                        >
                            <X className="h-2.5 w-2.5" />
                        </button>
                    </div>
                </div>
                <div className="flex-1 min-h-0 overflow-y-auto py-0.5">
                    {loading && (
                        <div className="px-3 py-6 text-center text-[10px] text-muted-foreground/20">Loading…</div>
                    )}
                    {!loading && history.length === 0 && (
                        <div className="px-3 py-6 text-center text-[10px] text-muted-foreground/20">No saved outputs</div>
                    )}
                    {history.map(h => (
                        <button
                            key={h.filename}
                            onClick={() => handleSelect(h)}
                            className={cn(
                                'w-full text-left px-2 py-1.5 transition-colors',
                                selectedFile === h.filename
                                    ? 'bg-primary/10 border-l-2 border-primary'
                                    : 'hover:bg-muted/20 border-l-2 border-transparent'
                            )}
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
                                {h.duration > 0 && (
                                    <span className="flex items-center gap-0.5">
                                        <Timer className="h-2 w-2" />{formatDuration(h.duration)}
                                    </span>
                                )}
                            </div>
                            <div className="pl-3.5 mt-0.5">
                                <CopyablePath path={h.path} />
                            </div>
                        </button>
                    ))}
                </div>
            </div>

            {/* Right: content preview */}
            <div className="flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden">
                {selectedFile ? (
                    <>
                        {/* Header with back button on mobile */}
                        <div className="flex items-center border-b border-border/20 bg-muted/5 shrink-0 h-8">
                            <button
                                onClick={() => setMobileListOpen(v => !v)}
                                className="md:hidden flex items-center gap-1 px-2 py-1.5 text-muted-foreground/60 hover:text-muted-foreground hover:bg-muted/30 transition-colors border-r border-border/30 shrink-0"
                                title="Toggle history list"
                            >
                                <ArrowLeft className="w-3.5 h-3.5" />
                                <span className="text-[10px] font-medium">List</span>
                            </button>
                            <span className="px-2 text-[10px] font-mono text-foreground/50 truncate">
                                $ {selectedCmd}
                            </span>
                        </div>
                        {contentLoading ? (
                            <div className="flex-1 flex items-center justify-center text-muted-foreground/20 text-xs">
                                <Clock className="h-4 w-4 animate-spin mr-2" />Loading…
                            </div>
                        ) : (
                            <div className="flex-1 min-h-0 overflow-y-auto p-3 font-mono text-[11px] text-foreground/70 whitespace-pre-wrap break-all">
                                {content}
                            </div>
                        )}
                    </>
                ) : (
                    <div className="flex-1 flex items-center justify-center text-muted-foreground/15 text-xs">
                        Select an entry to view output
                    </div>
                )}
            </div>
        </div>
    );
}

// ─── Utility Components ─────────────────────────────────────────────────────

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
            onClick={(e) => { e.stopPropagation(); handleCopy(); }}
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
