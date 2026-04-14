'use client';

import { cn } from '@/lib/utils';
import { Terminal, CheckCircle2, XCircle, Clock, ChevronDown, ChevronUp } from 'lucide-react';
import { useState } from 'react';

interface ShellResultProps {
    command: string;
    result: {
        exitCode: number;
        stdout: string;
        stderr: string;
        cwd: string;
        truncated?: boolean;
        killed?: boolean;
        signal?: string | null;
    };
}

export function ShellResult({ command, result }: ShellResultProps) {
    const [expanded, setExpanded] = useState(true);
    const isError = result.exitCode !== 0;
    const output = result.stdout || result.stderr || '(no output)';
    const lines = output.split('\n');
    const isLong = lines.length > 30;
    const [showFull, setShowFull] = useState(!isLong);

    return (
        <div className="my-3 max-w-4xl mx-auto">
            <div className={cn(
                "rounded-lg border overflow-hidden",
                isError ? "border-red-500/20 bg-red-500/5" : "border-emerald-500/20 bg-emerald-500/5"
            )}>
                {/* Header */}
                <button
                    onClick={() => setExpanded(!expanded)}
                    className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-muted/20 transition-colors"
                >
                    <Terminal className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    <code className="text-xs font-mono text-foreground/90 flex-1 truncate">
                        ! {command}
                    </code>
                    <div className="flex items-center gap-1.5 shrink-0">
                        {result.killed ? (
                            <span className="text-[10px] text-amber-400 flex items-center gap-1">
                                <Clock className="h-3 w-3" /> timeout
                            </span>
                        ) : isError ? (
                            <span className="text-[10px] text-red-400 flex items-center gap-1">
                                <XCircle className="h-3 w-3" /> exit {result.exitCode}
                            </span>
                        ) : (
                            <span className="text-[10px] text-emerald-400 flex items-center gap-1">
                                <CheckCircle2 className="h-3 w-3" /> ok
                            </span>
                        )}
                        {expanded ? <ChevronUp className="h-3 w-3 text-muted-foreground/50" /> : <ChevronDown className="h-3 w-3 text-muted-foreground/50" />}
                    </div>
                </button>

                {/* Output */}
                {expanded && (
                    <div className="border-t border-border/30">
                        <pre className={cn(
                            "px-3 py-2 text-xs font-mono whitespace-pre-wrap break-all overflow-auto text-foreground/80",
                            !showFull && "max-h-[400px]"
                        )}>
                            {showFull ? output : lines.slice(0, 30).join('\n')}
                        </pre>
                        {isLong && (
                            <button
                                onClick={() => setShowFull(!showFull)}
                                className="w-full px-3 py-1.5 text-[10px] text-muted-foreground hover:text-foreground border-t border-border/20 transition-colors"
                            >
                                {showFull ? `Collapse (${lines.length} lines)` : `Show all ${lines.length} lines`}
                            </button>
                        )}
                        {result.truncated && (
                            <div className="px-3 py-1 text-[10px] text-amber-400/70 border-t border-border/20">
                                ⚠ Output truncated (64KB limit)
                            </div>
                        )}
                        <div className="px-3 py-1 text-[10px] text-muted-foreground/40 border-t border-border/10">
                            {result.cwd}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
