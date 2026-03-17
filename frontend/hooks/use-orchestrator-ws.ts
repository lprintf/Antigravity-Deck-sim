'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { getOrchestratorWsUrl } from '@/lib/config';
import { authWsUrl } from '@/lib/auth';
import type {
    OrchestratorState, OrchestratorPlan,
    SubtaskStatus, OrchestratorEvent, OrchestratorLog,
} from '@/lib/orchestrator-api';

export type WsConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error';

export interface UseOrchestratorReturn {
    connectionState: WsConnectionState;
    orchestrationId: string | null;
    state: OrchestratorState | null;
    plan: OrchestratorPlan | null;
    subtasks: Record<string, SubtaskStatus>;
    progress: number;
    elapsed: number;
    events: OrchestratorEvent[];
    logs: OrchestratorLog[];
    error: string | null;
    connect: () => Promise<void>;
    disconnect: () => void;
    orchestrate: (task: string, workspace?: string) => void;
    execute: (configOverrides?: Record<string, unknown>) => void;
    revisePlan: (feedback: string) => void;
    cancel: () => void;
    answerClarification: (taskId: string, answer: string) => void;
}

const MAX_RETRIES = 3;
const BACKOFF = [1000, 2000, 4000];

export function useOrchestratorWs(): UseOrchestratorReturn {
    const [connectionState, setConnectionState] = useState<WsConnectionState>('idle');
    const [orchestrationId, setOrchestrationId] = useState<string | null>(null);
    const [state, setOState] = useState<OrchestratorState | null>(null);
    const [plan, setPlan] = useState<OrchestratorPlan | null>(null);
    const [subtasks, setSubtasks] = useState<Record<string, SubtaskStatus>>({});
    const [progress, setProgress] = useState(0);
    const [elapsed, setElapsed] = useState(0);
    const [events, setEvents] = useState<OrchestratorEvent[]>([]);
    const [logs, setLogs] = useState<OrchestratorLog[]>([]);
    const [error, setError] = useState<string | null>(null);

    const wsRef = useRef<WebSocket | null>(null);
    const retryRef = useRef(0);
    const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const orchIdRef = useRef<string | null>(null);
    const mountedRef = useRef(true);

    useEffect(() => { orchIdRef.current = orchestrationId; }, [orchestrationId]);
    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
            if (wsRef.current) { wsRef.current.onclose = null; wsRef.current.close(); }
        };
    }, []);

    const wsSend = useCallback((data: Record<string, unknown>) => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify(data));
        }
    }, []);

    const addLog = useCallback((log: OrchestratorLog) => {
        setLogs(prev => [...prev.slice(-200), log]);
    }, []);

    const handleMessage = useCallback((event: MessageEvent) => {
        if (!mountedRef.current) return;
        let data: Record<string, unknown>;
        try { data = JSON.parse(event.data as string); } catch { return; }

        const type = data.type as string;

        switch (type) {
            case 'orch_started':
                setOrchestrationId(data.orchestrationId as string);
                setOState(data.state as OrchestratorState);
                setConnectionState('connected');
                break;

            case 'orch_analysis':
                setOState('ANALYZING');
                setEvents(prev => [...prev.slice(-50), { type, orchestrationId: data.orchestrationId as string, timestamp: Date.now(), data }]);
                break;

            case 'orch_plan':
                setPlan(data.plan as OrchestratorPlan);
                setOState('AWAITING_APPROVAL');
                break;

            case 'orch_awaiting_approval':
                setOState('AWAITING_APPROVAL');
                break;

            case 'orch_executing':
                setOState('EXECUTING');
                break;

            case 'orch_subtask_update':
                setSubtasks(prev => ({
                    ...prev,
                    [data.taskId as string]: {
                        ...prev[data.taskId as string],
                        state: data.state as SubtaskStatus['state'],
                        result: (data.result as string) ?? prev[data.taskId as string]?.result ?? null,
                    },
                }));
                break;

            case 'orch_phase_complete':
                setEvents(prev => [...prev.slice(-50), { type, orchestrationId: data.orchestrationId as string, timestamp: Date.now(), data }]);
                break;

            case 'orch_clarification':
                setSubtasks(prev => ({
                    ...prev,
                    [data.taskId as string]: {
                        ...prev[data.taskId as string],
                        state: 'clarification',
                        clarificationQuestion: data.question as string,
                    },
                }));
                break;

            case 'orch_review':
                setOState('REVIEWING');
                setEvents(prev => [...prev.slice(-50), { type, orchestrationId: data.orchestrationId as string, timestamp: Date.now(), data }]);
                break;

            case 'orch_progress':
                setProgress(data.progress as number);
                setElapsed(data.elapsed as number);
                break;

            case 'orch_completed':
                setOState('COMPLETED');
                break;

            case 'orch_failed':
                setOState('FAILED');
                setError(data.reason as string);
                break;

            case 'orch_cancelled':
                setOState('CANCELLED');
                break;

            case 'orch_log':
                addLog(data as unknown as OrchestratorLog);
                break;

            case 'orch_error':
                setError(data.message as string);
                break;

            case 'orch_status':
                // Full status restore (used after reconnect)
                setOState(data.state as OrchestratorState);
                setPlan(data.plan as OrchestratorPlan | null);
                setSubtasks(data.subtasks as Record<string, SubtaskStatus>);
                setProgress(data.progress as number);
                setElapsed(data.elapsed as number);
                break;
        }
    }, [addLog]);

    const attemptConnect = useCallback(async () => {
        try {
            const wsUrl = await getOrchestratorWsUrl();
            const url = authWsUrl(wsUrl);
            const ws = new WebSocket(url);
            wsRef.current = ws;

            ws.onopen = () => {
                if (!mountedRef.current) { ws.close(); return; }
                setConnectionState('connected');
                retryRef.current = 0;
                setError(null);

                if (orchIdRef.current) {
                    ws.send(JSON.stringify({ type: 'orchestrate_status', orchestrationId: orchIdRef.current }));
                }
            };

            ws.onmessage = handleMessage;

            ws.onclose = () => {
                if (!mountedRef.current) return;
                wsRef.current = null;
                setConnectionState(prev => {
                    if (prev === 'idle') return prev;
                    if (retryRef.current >= MAX_RETRIES) {
                        setError('Connection lost after 3 retries');
                        return 'error';
                    }
                    const delay = BACKOFF[retryRef.current] || 4000;
                    retryRef.current++;
                    retryTimerRef.current = setTimeout(() => {
                        if (mountedRef.current) attemptConnect();
                    }, delay);
                    return 'reconnecting';
                });
            };

            ws.onerror = () => { /* onclose handles it */ };
        } catch (e) {
            if (!mountedRef.current) return;
            setError(e instanceof Error ? e.message : 'Connection failed');
            setConnectionState('error');
        }
    }, [handleMessage]);

    const connect = useCallback(async () => {
        if (wsRef.current) { wsRef.current.onclose = null; wsRef.current.close(); }
        if (retryTimerRef.current) { clearTimeout(retryTimerRef.current); retryTimerRef.current = null; }
        retryRef.current = 0;
        setError(null);
        setConnectionState('connecting');
        await attemptConnect();
    }, [attemptConnect]);

    const disconnect = useCallback(() => {
        if (retryTimerRef.current) { clearTimeout(retryTimerRef.current); retryTimerRef.current = null; }
        retryRef.current = 0;
        if (wsRef.current) { wsRef.current.onclose = null; wsRef.current.close(); wsRef.current = null; }
        setConnectionState('idle');
        setOrchestrationId(null);
        setOState(null);
        setPlan(null);
        setSubtasks({});
        setProgress(0);
        setElapsed(0);
        setEvents([]);
        setLogs([]);
        setError(null);
    }, []);

    const orchestrate = useCallback((task: string, workspace?: string) => {
        wsSend({ type: 'orchestrate', task, workspace });
    }, [wsSend]);

    const execute = useCallback((configOverrides?: Record<string, unknown>) => {
        if (!orchIdRef.current) return;
        wsSend({ type: 'orchestrate_execute', orchestrationId: orchIdRef.current, configOverrides });
    }, [wsSend]);

    const doRevisePlan = useCallback((feedback: string) => {
        if (!orchIdRef.current) return;
        wsSend({ type: 'orchestrate_revise', orchestrationId: orchIdRef.current, feedback });
    }, [wsSend]);

    const cancel = useCallback(() => {
        if (!orchIdRef.current) return;
        wsSend({ type: 'orchestrate_cancel', orchestrationId: orchIdRef.current });
    }, [wsSend]);

    const doAnswerClarification = useCallback((taskId: string, answer: string) => {
        if (!orchIdRef.current) return;
        wsSend({ type: 'orchestrate_clarify', orchestrationId: orchIdRef.current, taskId, answer });
    }, [wsSend]);

    return {
        connectionState, orchestrationId, state, plan, subtasks,
        progress, elapsed, events, logs, error,
        connect, disconnect, orchestrate, execute,
        revisePlan: doRevisePlan, cancel, answerClarification: doAnswerClarification,
    };
}
