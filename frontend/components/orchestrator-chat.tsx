'use client';

import { memo, useRef, useEffect, useState, useCallback } from 'react';
import { Send, Loader2 } from 'lucide-react';
import { OrchestratorTextMessage } from './orchestrator-chat/orchestrator-text-message';
import { OrchestratorPlanMessage } from './orchestrator-chat/orchestrator-plan-message';
import { OrchestratorProgressMessage } from './orchestrator-chat/orchestrator-progress-message';
import { OrchestratorStatusMessage } from './orchestrator-chat/orchestrator-status-message';
import type { OrchestratorChatMessage } from '@/lib/orchestrator-chat-types';
import type { UseOrchestratorReturn } from '@/hooks/use-orchestrator-ws';

interface Props {
    orch: UseOrchestratorReturn;
}

export const OrchestratorChat = memo(function OrchestratorChat({ orch }: Props) {
    const [input, setInput] = useState('');
    const [reviseMode, setReviseMode] = useState(false);
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const scrollContainerRef = useRef<HTMLDivElement>(null);
    const userScrolled = useRef(false);

    // Auto-scroll
    useEffect(() => {
        if (!userScrolled.current) {
            messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
        }
    }, [orch.messages]);

    const handleScroll = useCallback(() => {
        const el = scrollContainerRef.current;
        if (!el) return;
        const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
        userScrolled.current = !atBottom;
    }, []);

    const handleSend = useCallback(() => {
        if (!input.trim() || orch.activityState === 'thinking') return;

        let intent: string | undefined;
        if (reviseMode) {
            intent = 'revise';
            setReviseMode(false);
        }

        // Auto-attach replyTo if single pending clarification
        let replyTo: string | undefined;
        if (orch.pendingClarifications.length === 1) {
            replyTo = orch.pendingClarifications[0].taskId;
        }

        orch.sendMessage(input, { intent, replyTo });
        setInput('');
    }, [input, orch, reviseMode]);

    const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    }, [handleSend]);

    const handleAction = useCallback((action: string) => {
        switch (action) {
            case 'approve':
                orch.sendMessage('Plan approved', { intent: 'approve', silent: true });
                break;
            case 'revise':
                setReviseMode(true);
                break;
            case 'cancel':
                orch.sendMessage('Cancel orchestration', { intent: 'cancel', silent: true });
                break;
            case 'reset':
                orch.resetChat();
                break;
            case 'retry':
                // Re-send the original task — for now just reset
                orch.resetChat();
                break;
        }
    }, [orch]);

    const renderMessage = (message: OrchestratorChatMessage) => {
        switch (message.messageType) {
            case 'plan':
                return (
                    <OrchestratorPlanMessage
                        key={message.id}
                        message={message}
                        onAction={handleAction}
                        disabled={orch.state !== 'AWAITING_APPROVAL'}
                    />
                );
            case 'progress':
                return (
                    <OrchestratorProgressMessage
                        key={message.id}
                        message={message}
                        onAction={handleAction}
                    />
                );
            case 'completed':
            case 'failed':
            case 'cancelled':
            case 'error':
                return (
                    <OrchestratorStatusMessage
                        key={message.id}
                        message={message}
                        onAction={handleAction}
                    />
                );
            default:
                return (
                    <OrchestratorTextMessage
                        key={message.id}
                        message={message}
                    />
                );
        }
    };

    return (
        <div className="flex flex-col h-full">
            {/* Message list */}
            <div
                ref={scrollContainerRef}
                onScroll={handleScroll}
                className="flex-1 overflow-y-auto p-3 space-y-1"
            >
                {/* Welcome message */}
                {orch.messages.length === 0 && (
                    <div className="text-xs text-muted-foreground text-center py-8">
                        Describe a task or ask a question. I&apos;ll decide whether to handle it
                        directly or break it into subtasks for parallel execution.
                    </div>
                )}

                {orch.messages.map(renderMessage)}

                {/* Activity indicator */}
                {orch.activityState === 'thinking' && (
                    <div className="flex justify-start mb-2">
                        <div className="bg-purple-600/10 rounded-lg px-3 py-2 text-xs text-muted-foreground">
                            <Loader2 className="h-3 w-3 animate-spin inline mr-1" />
                            Analyzing...
                        </div>
                    </div>
                )}
                {orch.activityState === 'reviewing' && (
                    <div className="flex justify-start mb-2">
                        <div className="bg-purple-600/10 rounded-lg px-3 py-2 text-xs text-muted-foreground">
                            <Loader2 className="h-3 w-3 animate-spin inline mr-1" />
                            Reviewing results...
                        </div>
                    </div>
                )}

                <div ref={messagesEndRef} />
            </div>

            {/* Input bar */}
            <div className={`border-t border-border/20 p-2 ${reviseMode ? 'border-amber-500/50' : ''}`}>
                {reviseMode && (
                    <div className="text-[10px] text-amber-400 mb-1 flex items-center justify-between">
                        <span>Revision mode — describe your changes</span>
                        <button onClick={() => setReviseMode(false)} className="text-muted-foreground hover:text-foreground">
                            Cancel
                        </button>
                    </div>
                )}
                {orch.pendingClarifications.length > 0 && (
                    <div className="text-[10px] text-purple-400 mb-1">
                        Replying to: {orch.pendingClarifications.map(c => c.taskId).join(', ')}
                    </div>
                )}
                <div className="flex gap-2">
                    <textarea
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        onKeyDown={handleKeyDown}
                        placeholder={reviseMode ? 'Describe plan changes...' : 'Send a message...'}
                        className="flex-1 bg-muted/10 border border-border/20 rounded px-2 py-1.5 text-xs resize-none min-h-[32px] max-h-[120px] focus:outline-none focus:border-border/40"
                        rows={1}
                        disabled={orch.activityState === 'thinking'}
                    />
                    <button
                        onClick={handleSend}
                        disabled={!input.trim() || orch.activityState === 'thinking'}
                        className="px-2 py-1.5 rounded bg-blue-600/20 text-blue-400 hover:bg-blue-600/30 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        <Send className="h-3.5 w-3.5" />
                    </button>
                </div>
                {orch.activityState === 'queued' && (
                    <div className="text-[10px] text-muted-foreground mt-1">Message queued</div>
                )}
            </div>
        </div>
    );
});
