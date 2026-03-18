'use client';

import { useState, memo } from 'react';
import { cn } from '@/lib/utils';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Loader2, CheckCircle2, XCircle, HelpCircle, RotateCcw } from 'lucide-react';
import type { SubtaskStatus } from '@/lib/orchestrator-api';

const STATE_CONFIG: Record<string, { icon: typeof Loader2; color: string; bg: string; label: string }> = {
    pending:        { icon: Loader2,       color: 'text-muted-foreground', bg: 'bg-muted/5',    label: 'Pending' },
    running:        { icon: Loader2,       color: 'text-blue-400',        bg: 'bg-blue-500/5',  label: 'Running' },
    completed:      { icon: CheckCircle2,  color: 'text-emerald-400',     bg: 'bg-emerald-500/5', label: 'Done' },
    failed:         { icon: XCircle,       color: 'text-red-400',         bg: 'bg-red-500/5',   label: 'Failed' },
    retrying:       { icon: RotateCcw,     color: 'text-amber-400',       bg: 'bg-amber-500/5', label: 'Retrying' },
    clarification:  { icon: HelpCircle,    color: 'text-purple-400',      bg: 'bg-purple-500/5', label: 'Needs Input' },
};

export const OrchestratorTaskCard = memo(function OrchestratorTaskCard({
    taskId,
    status,
    onClarify,
}: {
    taskId: string;
    status: SubtaskStatus;
    onClarify?: (taskId: string, answer: string) => void;
}) {
    const conf = STATE_CONFIG[status.state] || STATE_CONFIG.pending;
    const Icon = conf.icon;
    const [answer, setAnswer] = useState('');

    return (
        <Card className={cn('border-border/20', conf.bg)}>
            <CardContent className="p-3 space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                        <Icon className={cn('h-3.5 w-3.5 shrink-0', conf.color,
                            (status.state === 'running' || status.state === 'retrying') && 'animate-spin'
                        )} />
                        <span className="text-[10px] font-mono text-foreground/60 shrink-0">{taskId}</span>
                        <Badge variant="outline" className={cn('text-[9px] px-1.5 py-0', conf.color)}>
                            {conf.label}
                        </Badge>
                    </div>
                    {status.retries > 0 && (
                        <span className="text-[9px] text-amber-400">retry {status.retries}</span>
                    )}
                </div>

                <p className="text-[10px] text-foreground/70 line-clamp-2">
                    {status.description}
                </p>

                {status.affectedFiles.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                        {status.affectedFiles.map(f => (
                            <span key={f} className="text-[9px] font-mono text-foreground/40 bg-muted/10 px-1 rounded">
                                {f}
                            </span>
                        ))}
                    </div>
                )}

                {status.state === 'clarification' && status.clarificationQuestion && onClarify && (
                    <div className="space-y-1.5 pt-1 border-t border-border/20">
                        <p className="text-[10px] text-purple-300">{status.clarificationQuestion}</p>
                        <div className="flex gap-1.5">
                            <Input
                                value={answer}
                                onChange={e => setAnswer(e.target.value)}
                                className="h-6 text-[10px] bg-background/50"
                                placeholder="Your answer..."
                                onKeyDown={e => {
                                    if (e.key === 'Enter' && answer.trim()) {
                                        onClarify(taskId, answer.trim());
                                        setAnswer('');
                                    }
                                }}
                            />
                            <Button
                                size="sm"
                                className="h-6 text-[10px] px-2"
                                disabled={!answer.trim()}
                                onClick={() => { onClarify(taskId, answer.trim()); setAnswer(''); }}
                            >
                                Send
                            </Button>
                        </div>
                    </div>
                )}

                {status.result && status.state === 'completed' && (
                    <p className="text-[9px] text-foreground/40 line-clamp-2 mt-1">{status.result}</p>
                )}

                {status.reviewDecision && (
                    <Badge variant="outline" className={cn('text-[9px] px-1.5 py-0',
                        status.reviewDecision === 'accepted' ? 'text-emerald-400' :
                        status.reviewDecision === 'rejected' ? 'text-red-400' : 'text-muted-foreground'
                    )}>
                        {status.reviewDecision}
                    </Badge>
                )}
            </CardContent>
        </Card>
    );
});
