// === Orchestrator API types and HTTP helpers ===

import { API_BASE } from './config';
import { authHeaders } from './auth';

// ── Types ───────────────────────────────────────────────────────────────

export type OrchestratorState =
    | 'ANALYZING' | 'PLANNING' | 'AWAITING_APPROVAL' | 'EXECUTING'
    | 'RECOVERING' | 'REVIEWING' | 'COMPLETED' | 'FAILED'
    | 'CANCELLING' | 'CANCELLED';

export type SubtaskState =
    | 'pending' | 'running' | 'completed' | 'failed'
    | 'retrying' | 'clarification';

export type Strategy = 'parallel' | 'sequential' | 'phased';

export interface SubtaskDefinition {
    id: string;
    description: string;
    context?: string;
    affectedFiles?: string[];
}

export interface OrchestratorPlan {
    type: 'direct' | 'orchestrated';
    reason?: string;
    response?: string;
    subtasks?: SubtaskDefinition[];
    strategy?: Strategy;
    phases?: string[][];
    summary?: string;
}

export interface SubtaskStatus {
    state: SubtaskState;
    description: string;
    affectedFiles: string[];
    result: string | null;
    retries: number;
    startedAt: number | null;
    completedAt: number | null;
    reviewDecision: string | null;
    clarificationQuestion: string | null;
    sessionId: string | null;
}

export interface OrchestratorStatus {
    id: string;
    state: OrchestratorState;
    originalTask: string;
    workspace: string;
    plan: OrchestratorPlan | null;
    subtasks: Record<string, SubtaskStatus>;
    progress: number;
    elapsed: number;
    currentPhase?: number;
    totalPhases?: number;
    requiredSlots: number;
    availableSlots: number;
    recentEvents: OrchestratorEvent[];
}

export interface OrchestratorConfig {
    enabled: boolean;
    maxConcurrentOrchestrations: number;
    maxParallel: number;
    maxSubtasks: number;
    maxRetries: number;
    stuckTimeoutMs: number;
    orchestrationTimeoutMs: number;
    failureThreshold: number;
    plannerPrompt?: string;
}

export interface OrchestratorEvent {
    type: string;
    orchestrationId: string;
    timestamp: number;
    data: Record<string, unknown>;
}

export interface OrchestratorLog {
    type: string;
    message: string;
    orchestrationId: string;
    taskId: string | null;
    timestamp: number;
}

// ── HTTP Helpers ────────────────────────────────────────────────────────

export async function startOrchestration(task: string, workspace?: string, config?: { maxParallel?: number; maxSubtasks?: number }): Promise<OrchestratorStatus> {
    const res = await fetch(`${API_BASE}/api/orchestrator/start`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ task, workspace, config }),
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Start failed' }));
        throw new Error(err.error || `Start failed: ${res.status}`);
    }
    return res.json();
}

export async function executeOrchestration(id: string, configOverrides?: { maxParallel?: number }): Promise<{ state: string; message: string }> {
    const res = await fetch(`${API_BASE}/api/orchestrator/${id}/execute`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ configOverrides }),
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Execute failed' }));
        throw new Error(err.error || `Execute failed: ${res.status}`);
    }
    return res.json();
}

export async function revisePlan(id: string, feedback: string): Promise<OrchestratorStatus> {
    const res = await fetch(`${API_BASE}/api/orchestrator/${id}/revise-plan`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ feedback }),
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Revise failed' }));
        throw new Error(err.error || `Revise failed: ${res.status}`);
    }
    return res.json();
}

export async function getOrchestrationStatus(id: string): Promise<OrchestratorStatus> {
    const res = await fetch(`${API_BASE}/api/orchestrator/${id}/status`, { headers: authHeaders() });
    if (!res.ok) throw new Error(`Failed to fetch status: ${res.status}`);
    return res.json();
}

export async function cancelOrchestration(id: string): Promise<{ state: string }> {
    const res = await fetch(`${API_BASE}/api/orchestrator/${id}/cancel`, {
        method: 'POST',
        headers: authHeaders(),
    });
    if (!res.ok) throw new Error(`Cancel failed: ${res.status}`);
    return res.json();
}

export async function answerClarification(id: string, taskId: string, answer: string): Promise<{ state: string }> {
    const res = await fetch(`${API_BASE}/api/orchestrator/${id}/clarify`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ taskId, answer }),
    });
    if (!res.ok) throw new Error(`Clarify failed: ${res.status}`);
    return res.json();
}

export async function listOrchestrations(includeCompleted = false): Promise<{ orchestrations: OrchestratorStatus[] }> {
    const res = await fetch(`${API_BASE}/api/orchestrator/list?includeCompleted=${includeCompleted}`, { headers: authHeaders() });
    if (!res.ok) throw new Error(`List failed: ${res.status}`);
    return res.json();
}

export async function destroyOrchestration(id: string): Promise<void> {
    const res = await fetch(`${API_BASE}/api/orchestrator/${id}`, {
        method: 'DELETE',
        headers: authHeaders(),
    });
    if (!res.ok) throw new Error(`Destroy failed: ${res.status}`);
}

export async function fetchOrchestratorSettings(): Promise<OrchestratorConfig> {
    const res = await fetch(`${API_BASE}/api/orchestrator/settings`, { headers: authHeaders() });
    if (!res.ok) throw new Error(`Failed to fetch settings: ${res.status}`);
    return res.json();
}

export async function saveOrchestratorSettings(settings: Partial<OrchestratorConfig>): Promise<OrchestratorConfig> {
    const res = await fetch(`${API_BASE}/api/orchestrator/settings`, {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify(settings),
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Save failed' }));
        throw new Error(err.error || `Save failed: ${res.status}`);
    }
    return res.json();
}

export async function fetchPlannerPrompt(): Promise<{ prompt: string | null }> {
    const res = await fetch(`${API_BASE}/api/orchestrator/prompt`, { headers: authHeaders() });
    if (!res.ok) throw new Error(`Failed to fetch prompt: ${res.status}`);
    return res.json();
}

export async function savePlannerPrompt(prompt: string): Promise<{ prompt: string }> {
    const res = await fetch(`${API_BASE}/api/orchestrator/prompt`, {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify({ prompt }),
    });
    if (!res.ok) throw new Error(`Save prompt failed: ${res.status}`);
    return res.json();
}
