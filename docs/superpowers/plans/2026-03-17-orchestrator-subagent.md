# Orchestrator Sub-Agent System Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an orchestrator system that uses a planner cascade to decompose tasks into subtasks and spawn parallel sub-agent sessions.

**Architecture:** OrchestratorSession wraps a planner AgentSession (internal, not pooled) and spawns sub-agent AgentSessions (pooled) via the existing SessionManager. Communication flows through a dedicated `/ws/orchestrator` WebSocket endpoint and `/api/orchestrator/*` HTTP REST API. Frontend adds an Orchestrator tab to the existing Agent Hub.

**Tech Stack:** Node.js/Express backend, WebSocket (ws), Zod validation, Next.js 16/React 19 frontend, shadcn/ui, Tailwind 4.

**Spec:** `docs/superpowers/specs/2026-03-17-orchestrator-subagent-design.md`

---

## File Structure

### New Files
| File | Responsibility |
|------|---------------|
| `src/orchestrator-session.js` | Core orchestrator logic: state machine, planner cascade interaction, sub-agent lifecycle, retry/clarification/review flows |
| `src/orchestrator-manager.js` | Registry for concurrent orchestrations — shared state between HTTP routes and WS handler |
| `src/ws-orchestrator.js` | WebSocket `/ws/orchestrator` handler — message parsing, event wiring |
| `src/routes/orchestrator-api.js` | HTTP REST + SSE endpoints for orchestrator CRUD, settings, prompt |
| `orchestrator.settings.json` | Persisted orchestrator config (auto-created on first save) |
| `frontend/lib/orchestrator-api.ts` | TypeScript types + HTTP helpers for orchestrator API |
| `frontend/hooks/use-orchestrator-ws.ts` | React hook for orchestrator WebSocket state management |
| `frontend/components/agent-hub/orchestrator-panel.tsx` | Main orchestrator panel (task input, plan review, execution grid, logs) |
| `frontend/components/agent-hub/orchestrator-task-card.tsx` | Individual subtask card component |

### Modified Files
| File | Changes |
|------|---------|
| `src/config.js` | Add orchestrator settings load/save functions + exports |
| `src/agent-session.js` | Add `orchestrationId`, `role` fields to constructor + getStatus() |
| `src/agent-session-manager.js` | Add `getAvailableSlots()`, `parentOrchestrationId` support in createSession |
| `src/routes.js` | Register orchestrator-api routes |
| `server.js` | Add `/ws/orchestrator` WebSocket server + orchestrator startup |
| `frontend/lib/config.ts` | Add `getOrchestratorWsUrl()` function |
| `frontend/components/agent-hub-view.tsx` | Add Orchestrator tab |
| `frontend/components/agent-hub/config-panel.tsx` | Add Orchestrator Settings section |

---

## Task 1: Backend Config — Orchestrator Settings

**Files:**
- Modify: `src/config.js`

- [ ] **Step 1: Add orchestrator settings path and defaults to config.js**

After the existing `AGENT_API_SETTINGS_PATH` block (~line 20), add:

```javascript
const ORCHESTRATOR_SETTINGS_PATH = path.join(__dirname, '..', 'orchestrator.settings.json');
const DEFAULT_ORCHESTRATOR_SETTINGS = {
    enabled: true,
    maxConcurrentOrchestrations: 2,
    maxParallel: 5,
    maxSubtasks: 10,
    maxRetries: 2,
    stuckTimeoutMs: 300000,
    orchestrationTimeoutMs: 1800000,
    failureThreshold: 0.5,
    maxConcurrentApiCalls: 3,
    plannerStepLimit: 1000,
    historySize: 10,
    allowMultiTurn: false,
    maxMessagesPerSubtask: 5,
    retryDelayMs: 2000,
    maxClarificationRounds: 2,
    contextMaxChars: 5000,
    plannerPrompt: null,  // null = use DEFAULT_PLANNER_PROMPT from orchestrator-session.js
};
```

- [ ] **Step 2: Add load/save functions**

After the existing `getAgentApiSettings`/`saveAgentApiSettings` block, add:

```javascript
let _orchestratorSettings = null;

function getOrchestratorSettings() {
    if (_orchestratorSettings) return _orchestratorSettings;
    try {
        if (fs.existsSync(ORCHESTRATOR_SETTINGS_PATH)) {
            _orchestratorSettings = {
                ...DEFAULT_ORCHESTRATOR_SETTINGS,
                ...JSON.parse(fs.readFileSync(ORCHESTRATOR_SETTINGS_PATH, 'utf-8')),
            };
        } else {
            _orchestratorSettings = { ...DEFAULT_ORCHESTRATOR_SETTINGS };
        }
    } catch {
        _orchestratorSettings = { ...DEFAULT_ORCHESTRATOR_SETTINGS };
    }
    return _orchestratorSettings;
}

function saveOrchestratorSettings(updates) {
    _orchestratorSettings = { ...getOrchestratorSettings(), ...updates };
    fs.writeFileSync(ORCHESTRATOR_SETTINGS_PATH, JSON.stringify(_orchestratorSettings, null, 2), 'utf-8');
    return _orchestratorSettings;
}
```

- [ ] **Step 3: Add to module.exports**

Add `getOrchestratorSettings, saveOrchestratorSettings` to the exports object.

- [ ] **Step 4: Verify config loads correctly**

Run: `node -e "const c = require('./src/config'); console.log(JSON.stringify(c.getOrchestratorSettings(), null, 2))"`
Expected: JSON object with all default orchestrator settings.

- [ ] **Step 5: Commit**

```bash
git add src/config.js
git commit -m "feat(config): add orchestrator settings load/save"
```

---

## Task 2: AgentSession — Add Orchestration Fields

**Files:**
- Modify: `src/agent-session.js`

- [ ] **Step 1: Add orchestration fields to constructor**

In the constructor (~line 30-51), after `this._lastActivity = Date.now();`, add:

```javascript
this._orchestrationId = opts.orchestrationId || null;
this._role = opts.role || null; // 'planner' | 'subtask' | null
```

- [ ] **Step 2: Add getters**

After the existing getters block (~line 62), add:

```javascript
get orchestrationId() { return this._orchestrationId; }
get role() { return this._role; }
```

- [ ] **Step 3: Add fields to getStatus()**

In `getStatus()` (~line 244), add after `log: this._log.slice(-50),`:

```javascript
orchestrationId: this._orchestrationId,
role: this._role,
```

- [ ] **Step 4: Commit**

```bash
git add src/agent-session.js
git commit -m "feat(agent-session): add orchestrationId and role fields"
```

---

## Task 3: AgentSessionManager — Add Capacity Query + Orchestration Support

**Files:**
- Modify: `src/agent-session-manager.js`

- [ ] **Step 1: Add getAvailableSlots function**

After `listSessions()` (~line 118), add:

```javascript
/**
 * Get number of available session slots.
 * @returns {number}
 */
function getAvailableSlots() {
    return Math.max(0, _config.maxConcurrentSessions - sessions.size);
}

/**
 * Get current config values.
 * @returns {object}
 */
function getConfig() {
    return { ..._config };
}
```

- [ ] **Step 2: Pass orchestration fields through createSession**

In `createSession()` (~line 39), update the AgentSession constructor call to pass through orchestration opts:

```javascript
const session = new AgentSession(id, {
    workspace: opts.workspace,
    cascadeId: opts.cascadeId,
    stepSoftLimit: opts.stepSoftLimit || _config.defaultStepSoftLimit,
    lsInst: opts.lsInst || resolveLsInst(opts.workspace),
    transport: opts.transport || 'unknown',
    persist: () => {},
    orchestrationId: opts.orchestrationId || null,
    role: opts.role || null,
});
```

- [ ] **Step 3: Add to module.exports**

Add `getAvailableSlots, getConfig` to exports:

```javascript
module.exports = {
    createSession, getSession, destroySession,
    listSessions, configure, shutdownAll,
    getAvailableSlots, getConfig,
};
```

- [ ] **Step 4: Verify**

Run: `node -e "const sm = require('./src/agent-session-manager'); console.log('slots:', sm.getAvailableSlots())"`
Expected: `slots: 5` (default maxConcurrentSessions)

- [ ] **Step 5: Commit**

```bash
git add src/agent-session-manager.js
git commit -m "feat(session-manager): add getAvailableSlots and orchestration field passthrough"
```

---

## Task 4: OrchestratorSession — Core Logic

**Files:**
- Create: `src/orchestrator-session.js`

This is the largest task. The OrchestratorSession manages the full lifecycle: ANALYZING → PLANNING → AWAITING_APPROVAL → EXECUTING → REVIEWING → COMPLETED.

- [ ] **Step 1: Create file with class skeleton, constructor, and state constants**

```javascript
// === Orchestrator Session ===
// Manages task decomposition via a planner cascade and parallel sub-agent execution.
// Uses AgentSession for planner (internal, not pooled) and sub-agents (pooled via SessionManager).

const EventEmitter = require('events');
const { AgentSession } = require('./agent-session');
const sessionManager = require('./agent-session-manager');
const { resolveLsInst } = require('./ls-utils');

const STATES = {
    ANALYZING: 'ANALYZING',
    PLANNING: 'PLANNING',
    AWAITING_APPROVAL: 'AWAITING_APPROVAL',
    EXECUTING: 'EXECUTING',
    RECOVERING: 'RECOVERING',
    REVIEWING: 'REVIEWING',
    COMPLETED: 'COMPLETED',
    FAILED: 'FAILED',
    CANCELLING: 'CANCELLING',
    CANCELLED: 'CANCELLED',
};

const DEFAULT_PLANNER_PROMPT = `You are a task orchestrator. Analyze the given task and decide how to handle it.

If the task is simple enough for a single cascade to handle directly, respond with:
\`\`\`json
{"type":"direct","reason":"...","response":"..."}
\`\`\`

If the task needs decomposition into subtasks, first explore the project structure, then respond with:
\`\`\`json
{
  "type": "orchestrated",
  "subtasks": [
    {"id": "t1", "description": "...", "context": "...", "affectedFiles": ["path/to/file.js"]},
    {"id": "t2", "description": "...", "context": "...", "affectedFiles": ["path/to/other.js"]}
  ],
  "strategy": "parallel|sequential|phased",
  "phases": [["t1","t2"],["t3"]],
  "summary": "..."
}
\`\`\`

Rules:
- Minimize file overlap between subtasks. If two subtasks must touch the same file, put them in different phases.
- Each subtask should be completable in a single cascade turn.
- Include affectedFiles for every subtask.
- Maximum 10 subtasks.
- Respond ONLY with the JSON block, no other text.`;

const DEFAULT_SUB_AGENT_PROMPT = `You are a focused sub-agent handling one part of a larger task.

## Your Assignment
{description}

## Context
{context}

## Previous Phase Results
{phaseContext}

## Rules
- Focus ONLY on your assigned task
- Do not modify files outside your scope: {affectedFiles}
- When done, clearly state what you changed and the outcome`;

class OrchestratorSession extends EventEmitter {
    constructor(id, opts = {}) {
        super();
        this.id = id;
        this._state = STATES.ANALYZING;
        this._originalTask = opts.task || '';
        this._workspace = opts.workspace || 'AntigravityAuto';
        this._lsInst = opts.lsInst || null;

        // Config
        this._config = {
            maxParallel: opts.maxParallel || 5,
            maxSubtasks: opts.maxSubtasks || 10,
            maxRetries: opts.maxRetries || 2,
            stuckTimeoutMs: opts.stuckTimeoutMs || 300000,
            orchestrationTimeoutMs: opts.orchestrationTimeoutMs || 1800000,
            failureThreshold: opts.failureThreshold || 0.5,
            maxConcurrentApiCalls: opts.maxConcurrentApiCalls || 3,
            plannerStepLimit: opts.plannerStepLimit || 1000,
            allowMultiTurn: opts.allowMultiTurn || false,
            maxMessagesPerSubtask: opts.maxMessagesPerSubtask || 5,
            retryDelayMs: opts.retryDelayMs || 2000,
            maxClarificationRounds: opts.maxClarificationRounds || 2,
            contextMaxChars: opts.contextMaxChars || 5000,
        };

        // Planner session (internal, not pooled)
        this._plannerSession = null;
        this._plannerPrompt = opts.plannerPrompt || DEFAULT_PLANNER_PROMPT;
        this._subAgentPrompt = opts.subAgentPrompt || DEFAULT_SUB_AGENT_PROMPT;

        // Plan
        this._plan = null;

        // Subtask state
        this._subtasks = new Map(); // taskId -> { definition, session, state, result, retries, ... }

        // Execution tracking
        this._startedAt = Date.now();
        this._completedAt = null;
        this._destroyed = false;
        this._overallTimeout = null;
        this._stuckCheckers = new Map();
        this._events = [];  // recent events buffer
        this._logs = [];

        // Semaphore for LS API calls
        this._apiQueue = [];
        this._activeApiCalls = 0;
    }

    // ── Read-only properties ─────────────────────────────────────
    get state() { return this._state; }
    get originalTask() { return this._originalTask; }
    get workspace() { return this._workspace; }
    get plan() { return this._plan; }
    get destroyed() { return this._destroyed; }
}

module.exports = { OrchestratorSession, STATES, DEFAULT_PLANNER_PROMPT, DEFAULT_SUB_AGENT_PROMPT };
```

- [ ] **Step 2: Verify file loads**

Run: `node -e "const { OrchestratorSession } = require('./src/orchestrator-session'); const o = new OrchestratorSession('test', { task: 'hello' }); console.log(o.state, o.originalTask)"`
Expected: `ANALYZING hello`

- [ ] **Step 3: Commit skeleton**

```bash
git add src/orchestrator-session.js
git commit -m "feat(orchestrator): add OrchestratorSession class skeleton"
```

- [ ] **Step 4: Add internal helper methods**

Add to OrchestratorSession class:

```javascript
// ── Internal helpers ─────────────────────────────────────────

_setState(newState) {
    if (this._state === newState) return;
    const old = this._state;
    this._state = newState;
    this._addEvent('state_change', { state: newState, previousState: old });
    this.emit('state_change', { state: newState, previousState: old });
}

_addLog(type, message, taskId = null) {
    const entry = { type, message, orchestrationId: this.id, taskId, timestamp: Date.now() };
    this._logs.push(entry);
    if (this._logs.length > 500) this._logs = this._logs.slice(-500);
    this.emit('log', entry);
}

_addEvent(type, data = {}) {
    const event = { type, orchestrationId: this.id, timestamp: Date.now(), data };
    this._events.push(event);
    if (this._events.length > 100) this._events = this._events.slice(-100);
}

_shortId(id) {
    return id ? id.substring(0, 8) : '--------';
}

_elapsed() {
    return Date.now() - this._startedAt;
}

_progress() {
    if (!this._plan || this._plan.type === 'direct') return 1;
    const total = this._subtasks.size;
    if (total === 0) return 0;
    let completed = 0;
    for (const st of this._subtasks.values()) {
        if (st.state === 'completed' || st.state === 'failed') completed++;
    }
    return completed / total;
}

_truncate(text, maxLen) {
    if (!text || text.length <= maxLen) return text;
    return text.substring(0, maxLen) + '... [truncated]';
}

_parseJson(text) {
    // Extract JSON from cascade response (may be wrapped in markdown code blocks)
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const jsonStr = jsonMatch ? jsonMatch[1].trim() : text.trim();
    return JSON.parse(jsonStr);
}

// ── API call semaphore ───────────────────────────────────────
// Throttles concurrent LS API calls to maxConcurrentApiCalls

async _acquireApiSlot() {
    if (this._activeApiCalls < this._config.maxConcurrentApiCalls) {
        this._activeApiCalls++;
        return;
    }
    // Wait for a slot
    return new Promise(resolve => {
        this._apiQueue.push(() => { this._activeApiCalls++; resolve(); });
    });
}

_releaseApiSlot() {
    this._activeApiCalls--;
    if (this._apiQueue.length > 0) {
        const next = this._apiQueue.shift();
        next();
    }
}

/**
 * Send a message to a session with API throttling.
 */
async _throttledSend(session, message) {
    await this._acquireApiSlot();
    try {
        return await session.sendMessage(message);
    } finally {
        this._releaseApiSlot();
    }
}
```

- [ ] **Step 5: Commit helpers**

```bash
git add src/orchestrator-session.js
git commit -m "feat(orchestrator): add internal helper methods"
```

- [ ] **Step 6: Add getStatus() and destroy()**

```javascript
// ── Status ───────────────────────────────────────────────────

getStatus() {
    const subtasks = {};
    for (const [taskId, st] of this._subtasks) {
        subtasks[taskId] = {
            state: st.state,
            description: st.definition.description,
            affectedFiles: st.definition.affectedFiles || [],
            result: st.result ? this._truncate(st.result, this._config.contextMaxChars) : null,
            retries: st.retries,
            startedAt: st.startedAt || null,
            completedAt: st.completedAt || null,
            reviewDecision: st.reviewDecision || null,
            clarificationQuestion: st.clarificationQuestion || null,
            sessionId: st.session ? st.session.id : null,
        };
    }

    const phases = this._plan && this._plan.phases ? this._plan.phases : [];
    let currentPhase = 0;
    if (this._state === 'EXECUTING' || this._state === 'RECOVERING') {
        for (let i = 0; i < phases.length; i++) {
            const allDone = phases[i].every(tid => {
                const st = this._subtasks.get(tid);
                return st && (st.state === 'completed' || st.state === 'failed');
            });
            if (!allDone) { currentPhase = i; break; }
            currentPhase = i + 1;
        }
    }

    return {
        id: this.id,
        state: this._state,
        originalTask: this._originalTask,
        workspace: this._workspace,
        plan: this._plan,
        subtasks,
        progress: this._progress(),
        elapsed: this._elapsed(),
        currentPhase: phases.length > 0 ? currentPhase : undefined,
        totalPhases: phases.length > 0 ? phases.length : undefined,
        requiredSlots: this._plan ? (this._plan.subtasks || []).length : 0,
        availableSlots: sessionManager.getAvailableSlots(),
        recentEvents: this._events.slice(-50),
    };
}

// ── Destroy ──────────────────────────────────────────────────

destroy() {
    if (this._destroyed) return;
    this._destroyed = true;

    // Clear timeout
    if (this._overallTimeout) {
        clearTimeout(this._overallTimeout);
        this._overallTimeout = null;
    }

    // Clear stuck checkers
    for (const timer of this._stuckCheckers.values()) {
        clearInterval(timer);
    }
    this._stuckCheckers.clear();

    // Destroy all sub-sessions
    for (const [taskId, st] of this._subtasks) {
        if (st.session && !st.session.destroyed) {
            st.session.destroy();
        }
    }

    // Destroy planner session
    if (this._plannerSession && !this._plannerSession.destroyed) {
        this._plannerSession.destroy();
    }

    this._addLog('system', 'Orchestration destroyed');
    this.emit('destroyed');
    this.removeAllListeners();
}
```

- [ ] **Step 7: Commit status/destroy**

```bash
git add src/orchestrator-session.js
git commit -m "feat(orchestrator): add getStatus and destroy methods"
```

- [ ] **Step 8: Add start() — the main entry point (ANALYZING → PLANNING → AWAITING_APPROVAL)**

```javascript
// ── Main entry point ─────────────────────────────────────────

async start() {
    if (this._destroyed) throw new Error('Orchestration destroyed');
    this._addLog('system', `Starting orchestration: "${this._truncate(this._originalTask, 100)}"`);

    // Start overall timeout
    this._overallTimeout = setTimeout(() => {
        this._addLog('error', `Orchestration timeout after ${this._config.orchestrationTimeoutMs}ms`);
        this._fail('Orchestration timeout');
    }, this._config.orchestrationTimeoutMs);

    // Create planner session (internal, not pooled)
    try {
        this._plannerSession = new AgentSession(`planner-${this.id}`, {
            workspace: this._workspace,
            stepSoftLimit: this._config.plannerStepLimit,
            lsInst: this._lsInst || resolveLsInst(this._workspace),
            transport: 'orchestrator-planner',
            orchestrationId: this.id,
            role: 'planner',
        });
    } catch (e) {
        return this._fail(`Cannot create planner session: ${e.message}`);
    }

    // ANALYZING: Send task to planner
    this._setState(STATES.ANALYZING);
    this._addLog('system', 'Analyzing task with planner cascade...');
    this.emit('orch_started', { orchestrationId: this.id, state: this._state });

    let plannerResponse;
    try {
        plannerResponse = await this._plannerSession.sendMessage(
            `${this._plannerPrompt}\n\n## Task\n${this._originalTask}`
        );
    } catch (e) {
        return this._fail(`Planner failed: ${e.message}`);
    }

    if (!plannerResponse.text) {
        return this._fail('Planner returned empty response');
    }

    // Parse planner output
    let plan;
    let parseAttempts = 0;
    const maxParseRetries = 3;

    while (parseAttempts < maxParseRetries) {
        try {
            plan = this._parseJson(plannerResponse.text);
            break;
        } catch (e) {
            parseAttempts++;
            this._addLog('warning', `JSON parse failed (attempt ${parseAttempts}/${maxParseRetries}): ${e.message}`);
            if (parseAttempts >= maxParseRetries) {
                // Fallback to direct
                plan = { type: 'direct', reason: 'Could not parse planner output', response: plannerResponse.text };
                break;
            }
            // Retry: ask planner to fix
            try {
                plannerResponse = await this._plannerSession.sendMessage(
                    'Your previous response was not valid JSON. Respond ONLY with the JSON block matching the schema.'
                );
            } catch (retryErr) {
                plan = { type: 'direct', reason: 'Planner retry failed', response: plannerResponse.text };
                break;
            }
        }
    }

    this._plan = plan;
    this.emit('orch_analysis', {
        orchestrationId: this.id,
        planType: plan.type,
        subtaskCount: plan.subtasks ? plan.subtasks.length : 0,
        reason: plan.reason || null,
    });

    // DIRECT: No sub-agents needed
    if (plan.type === 'direct') {
        this._addLog('system', `Direct response: ${plan.reason || 'simple task'}`);
        this._setState(STATES.COMPLETED);
        this._completedAt = Date.now();
        this._cleanup();
        this.emit('orch_completed', {
            orchestrationId: this.id,
            summary: plan.response || '',
            results: {},
        });
        return;
    }

    // ORCHESTRATED: Validate and prepare plan
    if (!plan.subtasks || plan.subtasks.length === 0) {
        return this._fail('Planner returned orchestrated plan with no subtasks');
    }

    // Cap subtasks
    if (plan.subtasks.length > this._config.maxSubtasks) {
        this._addLog('warning', `Plan has ${plan.subtasks.length} subtasks, capping to ${this._config.maxSubtasks}`);
        plan.subtasks = plan.subtasks.slice(0, this._config.maxSubtasks);
    }

    // Validate file overlap for parallel strategy
    if (plan.strategy === 'parallel') {
        const overlap = this._detectFileOverlap(plan.subtasks);
        if (overlap) {
            this._addLog('warning', `File overlap detected between ${overlap[0]} and ${overlap[1]}, overriding to sequential`);
            plan.strategy = 'sequential';
        }
    }

    // Ensure phases exist
    if (!plan.phases || plan.phases.length === 0) {
        if (plan.strategy === 'sequential') {
            plan.phases = plan.subtasks.map(t => [t.id]);
        } else {
            plan.phases = [plan.subtasks.map(t => t.id)];
        }
    }

    // Initialize subtask state
    for (const def of plan.subtasks) {
        this._subtasks.set(def.id, {
            definition: def,
            session: null,
            state: 'pending',
            result: null,
            retries: 0,
            startedAt: null,
            completedAt: null,
            reviewDecision: null,
            clarificationQuestion: null,
            clarificationRounds: 0,
        });
    }

    this._plan = plan;
    this._setState(STATES.AWAITING_APPROVAL);
    this._addLog('system', `Plan ready: ${plan.subtasks.length} subtasks, strategy: ${plan.strategy}`);

    this.emit('orch_plan', {
        orchestrationId: this.id,
        plan: this._plan,
        requiredSlots: plan.subtasks.length,
        availableSlots: sessionManager.getAvailableSlots(),
    });
    this.emit('orch_awaiting_approval', { orchestrationId: this.id });
}

_detectFileOverlap(subtasks) {
    for (let i = 0; i < subtasks.length; i++) {
        for (let j = i + 1; j < subtasks.length; j++) {
            const filesA = new Set(subtasks[i].affectedFiles || []);
            for (const f of (subtasks[j].affectedFiles || [])) {
                if (filesA.has(f)) return [subtasks[i].id, subtasks[j].id];
            }
        }
    }
    return null;
}

_fail(reason) {
    this._setState(STATES.FAILED);
    this._completedAt = Date.now();
    this._addLog('error', `Orchestration failed: ${reason}`);
    this._cleanup();

    const partialResults = {};
    for (const [taskId, st] of this._subtasks) {
        if (st.result) partialResults[taskId] = st.result;
    }

    this.emit('orch_failed', {
        orchestrationId: this.id,
        reason,
        partialResults,
    });
}

_cleanup() {
    if (this._overallTimeout) {
        clearTimeout(this._overallTimeout);
        this._overallTimeout = null;
    }
    if (this._progressInterval) {
        clearInterval(this._progressInterval);
        this._progressInterval = null;
    }
    for (const timer of this._stuckCheckers.values()) {
        clearInterval(timer);
    }
    this._stuckCheckers.clear();

    // Destroy sub-sessions (free pool slots)
    for (const [, st] of this._subtasks) {
        if (st.session && !st.session.destroyed) {
            st.session.destroy();
            st.session = null;
        }
    }
    // Destroy planner
    if (this._plannerSession && !this._plannerSession.destroyed) {
        this._plannerSession.destroy();
        this._plannerSession = null;
    }
}
```

- [ ] **Step 9: Commit start() method**

```bash
git add src/orchestrator-session.js
git commit -m "feat(orchestrator): add start() with analyzing, planning, and approval flow"
```

- [ ] **Step 10: Add execute() — begin EXECUTING phase**

```javascript
// ── Execute approved plan ────────────────────────────────────

async execute(configOverrides = {}) {
    if (this._state !== STATES.AWAITING_APPROVAL) {
        throw new Error(`Cannot execute: state is ${this._state}, expected AWAITING_APPROVAL`);
    }
    if (this._destroyed) throw new Error('Orchestration destroyed');

    // Apply config overrides
    if (configOverrides.maxParallel != null) {
        this._config.maxParallel = configOverrides.maxParallel;
    }

    this._setState(STATES.EXECUTING);
    this._addLog('system', 'Execution started');
    this.emit('orch_executing', { orchestrationId: this.id });

    // Start periodic progress emission
    this._progressInterval = setInterval(() => {
        if (this._state === STATES.EXECUTING || this._state === STATES.RECOVERING) {
            this.emit('orch_progress', {
                orchestrationId: this.id,
                progress: this._progress(),
                elapsed: this._elapsed(),
            });
        }
    }, 5000); // every 5 seconds

    // Execute phases sequentially
    try {
        for (let phaseIdx = 0; phaseIdx < this._plan.phases.length; phaseIdx++) {
            if (this._destroyed || this._state === STATES.CANCELLING) break;

            const phase = this._plan.phases[phaseIdx];
            this._addLog('system', `Starting phase ${phaseIdx + 1}/${this._plan.phases.length}: [${phase.join(', ')}]`);

            await this._executePhase(phase, phaseIdx);

            // Check failure threshold after each phase
            const failCount = Array.from(this._subtasks.values()).filter(s => s.state === 'failed').length;
            const total = this._subtasks.size;
            if (failCount / total > this._config.failureThreshold) {
                return this._fail(`Failure threshold exceeded: ${failCount}/${total} tasks failed`);
            }

            // Phase complete event
            const completedTasks = phase.filter(tid => {
                const st = this._subtasks.get(tid);
                return st && st.state === 'completed';
            });
            this.emit('orch_phase_complete', {
                orchestrationId: this.id,
                phase: phaseIdx,
                completedTasks,
            });

            // Get phase summary for next phase context (if not last phase)
            if (phaseIdx < this._plan.phases.length - 1) {
                await this._summarizePhaseForNext(phase, phaseIdx);
            }
        }
    } catch (e) {
        if (this._state !== STATES.FAILED && this._state !== STATES.CANCELLED) {
            return this._fail(`Execution error: ${e.message}`);
        }
        return;
    }

    if (this._state === STATES.CANCELLING || this._destroyed) return;

    // All phases done — move to reviewing
    await this._review();
}

async _executePhase(taskIds, phaseIdx) {
    // Run tasks in parallel, capped by maxParallel
    const queue = [...taskIds];
    const running = new Set();

    return new Promise((resolve, reject) => {
        const startNext = () => {
            if (this._destroyed || this._state === STATES.CANCELLING) {
                if (running.size === 0) resolve();
                return;
            }

            while (running.size < this._config.maxParallel && queue.length > 0) {
                const taskId = queue.shift();
                running.add(taskId);
                this._executeSubtask(taskId, phaseIdx)
                    .then(() => {
                        running.delete(taskId);
                        if (queue.length > 0) startNext();
                        else if (running.size === 0) resolve();
                    })
                    .catch(err => {
                        running.delete(taskId);
                        this._addLog('error', `Subtask ${taskId} error: ${err.message}`, taskId);
                        if (queue.length > 0) startNext();
                        else if (running.size === 0) resolve();
                    });
            }
        };
        startNext();
    });
}
```

- [ ] **Step 11: Commit execute method**

```bash
git add src/orchestrator-session.js
git commit -m "feat(orchestrator): add execute() with phased parallel execution"
```

- [ ] **Step 12: Add _executeSubtask() — single subtask lifecycle**

```javascript
async _executeSubtask(taskId, phaseIdx) {
    const st = this._subtasks.get(taskId);
    if (!st) return;

    st.state = 'running';
    st.startedAt = Date.now();
    this._addLog('system', `Subtask ${taskId} started: "${this._truncate(st.definition.description, 80)}"`, taskId);
    this.emit('orch_subtask_update', { orchestrationId: this.id, taskId, state: 'running' });

    // Create sub-agent session (pooled)
    try {
        st.session = sessionManager.createSession({
            workspace: this._workspace,
            // Use default step limit (from session manager config), NOT plannerStepLimit
            lsInst: this._lsInst || resolveLsInst(this._workspace),
            transport: 'orchestrator-subtask',
            orchestrationId: this.id,
            role: 'subtask',
        });
    } catch (e) {
        this._addLog('error', `Cannot create session for ${taskId}: ${e.message}`, taskId);
        st.state = 'failed';
        st.result = `Session creation failed: ${e.message}`;
        this.emit('orch_subtask_update', { orchestrationId: this.id, taskId, state: 'failed', result: st.result });
        return;
    }

    // Build sub-agent message
    const phaseContext = st._phaseContext || 'No previous phase context.';
    const message = this._subAgentPrompt
        .replace('{description}', st.definition.description)
        .replace('{context}', st.definition.context || '')
        .replace('{phaseContext}', phaseContext)
        .replace('{affectedFiles}', (st.definition.affectedFiles || []).join(', '));

    // Start stuck checker
    const stuckChecker = setInterval(() => {
        if (st.session && st.session.isBusy && (Date.now() - st.session.lastActivity) > this._config.stuckTimeoutMs) {
            this._addLog('warning', `Subtask ${taskId} stuck (busy > ${this._config.stuckTimeoutMs}ms), destroying`, taskId);
            clearInterval(stuckChecker);
            this._stuckCheckers.delete(taskId);
            this._retrySubtask(taskId, 'stuck timeout');
        }
    }, 30000); // check every 30s
    this._stuckCheckers.set(taskId, stuckChecker);

    // Send message and wait for response (throttled)
    let result;
    try {
        result = await this._throttledSend(st.session, message);
    } catch (e) {
        this._addLog('error', `Subtask ${taskId} sendMessage failed: ${e.message}`, taskId);
        clearInterval(stuckChecker);
        this._stuckCheckers.delete(taskId);
        return this._retrySubtask(taskId, e.message);
    }

    // Clear stuck checker
    clearInterval(stuckChecker);
    this._stuckCheckers.delete(taskId);

    if (!result.text) {
        return this._retrySubtask(taskId, 'empty response');
    }

    // Check if response is a question (clarification needed)
    if (this._looksLikeQuestion(result.text) && st.clarificationRounds < this._config.maxClarificationRounds) {
        await this._handleClarification(taskId, result.text);
        return;
    }

    // Subtask completed
    // NOTE: Do NOT destroy sub-session here — keep it alive for accept/reject during REVIEWING phase.
    // Sessions are cleaned up in _cleanup() after review completes.
    st.state = 'completed';
    st.result = result.text;
    st.completedAt = Date.now();
    this._addLog('system', `Subtask ${taskId} completed (${st.completedAt - st.startedAt}ms)`, taskId);
    this.emit('orch_subtask_update', {
        orchestrationId: this.id,
        taskId,
        state: 'completed',
        result: this._truncate(result.text, 500),
    });
}

_looksLikeQuestion(text) {
    if (!text) return false;
    const lines = text.trim().split('\n');
    const lastLine = lines[lines.length - 1].trim();
    // Heuristic: ends with ? or contains explicit question markers
    return lastLine.endsWith('?') ||
        /\b(which|should I|do you want|please clarify|could you)\b/i.test(lastLine);
}

async _retrySubtask(taskId, reason) {
    const st = this._subtasks.get(taskId);
    if (!st) return;

    // Destroy old session
    if (st.session && !st.session.destroyed) {
        st.session.destroy();
        st.session = null;
    }

    st.retries++;
    if (st.retries > this._config.maxRetries) {
        st.state = 'failed';
        st.result = `Failed after ${st.retries} retries. Last error: ${reason}`;
        st.completedAt = Date.now();
        this._addLog('error', `Subtask ${taskId} failed permanently: ${reason}`, taskId);
        this.emit('orch_subtask_update', { orchestrationId: this.id, taskId, state: 'failed', result: st.result });
        return;
    }

    st.state = 'retrying';
    this._addLog('warning', `Subtask ${taskId} retrying (${st.retries}/${this._config.maxRetries}): ${reason}`, taskId);
    this.emit('orch_subtask_update', { orchestrationId: this.id, taskId, state: 'retrying' });

    // Delay before retry
    await new Promise(r => setTimeout(r, this._config.retryDelayMs));

    if (this._destroyed || this._state === STATES.CANCELLING) return;

    // Re-execute (pass phaseIdx=0 for retry context; phase context already set)
    st.state = 'pending';
    st.startedAt = null;
    return this._executeSubtask(taskId, 0);
}
```

- [ ] **Step 13: Commit subtask execution**

```bash
git add src/orchestrator-session.js
git commit -m "feat(orchestrator): add subtask execution, stuck detection, retry logic"
```

- [ ] **Step 14: Add clarification flow**

```javascript
async _handleClarification(taskId, questionText) {
    const st = this._subtasks.get(taskId);
    if (!st) return;

    st.clarificationRounds++;
    this._addLog('system', `Subtask ${taskId} needs clarification (round ${st.clarificationRounds})`, taskId);

    // First try: ask planner if it can answer
    try {
        const plannerResponse = await this._plannerSession.sendMessage(
            `Sub-agent for task "${st.definition.description}" is asking:\n\n${questionText}\n\nCan you answer this? Respond with JSON:\n{"canAnswer": true, "answer": "..."} or {"canAnswer": false}`
        );

        if (plannerResponse.text) {
            try {
                const decision = this._parseJson(plannerResponse.text);
                if (decision.canAnswer && decision.answer) {
                    // Feed answer back to sub-agent
                    this._addLog('system', `Planner answered clarification for ${taskId}`, taskId);
                    const followUp = await st.session.sendMessage(decision.answer);
                    if (followUp.text) {
                        st.state = 'completed';
                        st.result = followUp.text;
                        st.completedAt = Date.now();
                        this.emit('orch_subtask_update', {
                            orchestrationId: this.id, taskId, state: 'completed',
                            result: this._truncate(followUp.text, 500),
                        });
                        // Keep session alive for review phase
                        return;
                    }
                }
            } catch { /* parse failed, escalate */ }
        }
    } catch { /* planner failed, escalate */ }

    // Escalate to user — set 5 min auto-skip timeout
    const CLARIFICATION_TIMEOUT = 5 * 60 * 1000;
    st._clarificationTimer = setTimeout(() => {
        if (st.state === 'clarification') {
            this._addLog('warning', `Clarification timeout for ${taskId}, marking failed`, taskId);
            st.state = 'failed';
            st.result = 'Clarification timeout (5 min)';
            st.completedAt = Date.now();
            st.clarificationQuestion = null;
            if (st.session && !st.session.destroyed) { st.session.destroy(); st.session = null; }
            this.emit('orch_subtask_update', { orchestrationId: this.id, taskId, state: 'failed', result: st.result });
        }
    }, CLARIFICATION_TIMEOUT);
    st.state = 'clarification';
    st.clarificationQuestion = questionText;
    this._addLog('system', `Escalating clarification for ${taskId} to user`, taskId);
    this.emit('orch_clarification', {
        orchestrationId: this.id,
        taskId,
        question: questionText,
    });

    // Other subtasks continue running — this one waits for user response
    // The answerClarification() method resumes it
}

/**
 * Answer a clarification question from a sub-agent.
 * Called from API/WS when user provides an answer.
 */
async answerClarification(taskId, answer) {
    const st = this._subtasks.get(taskId);
    if (!st || st.state !== 'clarification') {
        throw new Error(`Subtask ${taskId} is not awaiting clarification`);
    }

    // Clear auto-skip timer
    if (st._clarificationTimer) { clearTimeout(st._clarificationTimer); st._clarificationTimer = null; }

    st.state = 'running';
    st.clarificationQuestion = null;
    this._addLog('system', `User answered clarification for ${taskId}`, taskId);
    this.emit('orch_subtask_update', { orchestrationId: this.id, taskId, state: 'running' });

    try {
        const result = await st.session.sendMessage(answer);
        if (result.text) {
            st.state = 'completed';
            st.result = result.text;
            st.completedAt = Date.now();
            this.emit('orch_subtask_update', {
                orchestrationId: this.id, taskId, state: 'completed',
                result: this._truncate(result.text, 500),
            });
            // Keep session alive for review phase
        } else {
            return this._retrySubtask(taskId, 'empty response after clarification');
        }
    } catch (e) {
        return this._retrySubtask(taskId, `clarification response failed: ${e.message}`);
    }
}
```

- [ ] **Step 15: Commit clarification flow**

```bash
git add src/orchestrator-session.js
git commit -m "feat(orchestrator): add clarification flow with planner auto-answer + user escalation"
```

- [ ] **Step 16: Add review phase and phase context propagation**

```javascript
// ── Review phase ─────────────────────────────────────────────

async _review() {
    this._setState(STATES.REVIEWING);
    this._addLog('system', 'Reviewing subtask results...');
    this.emit('orch_review', { orchestrationId: this.id, decisions: [] });

    // Build review message for planner
    const resultsSummary = [];
    for (const [taskId, st] of this._subtasks) {
        resultsSummary.push({
            taskId,
            description: st.definition.description,
            state: st.state,
            result: st.state === 'completed'
                ? this._truncate(st.result, this._config.contextMaxChars)
                : `Failed: ${st.result || 'unknown error'}`,
        });
    }

    const failCount = resultsSummary.filter(r => r.state === 'failed').length;
    const reviewPrompt = failCount > 0
        ? `Review these subtask results. ${resultsSummary.length - failCount}/${resultsSummary.length} completed, ${failCount} failed.\nFor each completed task, decide: accept or reject.\nFor failed tasks, decide: retry_failed, accept_partial, or abort_all.\n\nResults:\n${JSON.stringify(resultsSummary, null, 2)}\n\nRespond with JSON:\n{"decisions":[{"taskId":"t1","action":"accept","reason":"..."},...],"overall":"accept_partial|abort_all|retry_failed"}`
        : `Review these subtask results. All ${resultsSummary.length} completed.\nFor each task, decide: accept or reject.\n\nResults:\n${JSON.stringify(resultsSummary, null, 2)}\n\nRespond with JSON:\n{"decisions":[{"taskId":"t1","action":"accept","reason":"..."},...],"overall":"complete"}`;

    let reviewResponse;
    try {
        reviewResponse = await this._plannerSession.sendMessage(reviewPrompt);
    } catch (e) {
        // If planner fails, auto-accept all completed
        this._addLog('warning', `Planner review failed: ${e.message}, auto-accepting completed tasks`);
        for (const [taskId, st] of this._subtasks) {
            if (st.state === 'completed') {
                st.reviewDecision = 'accepted';
                if (st.session && !st.session.destroyed) {
                    try { await st.session.accept(); } catch { /* ignore */ }
                }
            }
        }
        return this._complete();
    }

    // Parse review decisions
    let review;
    try {
        review = this._parseJson(reviewResponse.text);
    } catch {
        this._addLog('warning', 'Could not parse review response, auto-accepting completed tasks');
        for (const [taskId, st] of this._subtasks) {
            if (st.state === 'completed') st.reviewDecision = 'accepted';
        }
        return this._complete();
    }

    // Apply decisions
    if (review.decisions) {
        for (const dec of review.decisions) {
            const st = this._subtasks.get(dec.taskId);
            if (!st) continue;

            st.reviewDecision = dec.action;
            this._addLog('system', `Review: ${dec.taskId} → ${dec.action} (${dec.reason || ''})`, dec.taskId);

            if (dec.action === 'accept' && st.session && !st.session.destroyed) {
                try { await st.session.accept(); } catch (e) {
                    this._addLog('error', `Accept failed for ${dec.taskId}: ${e.message}`, dec.taskId);
                }
            } else if (dec.action === 'reject' && st.session && !st.session.destroyed) {
                try { await st.session.reject(); } catch (e) {
                    this._addLog('error', `Reject failed for ${dec.taskId}: ${e.message}`, dec.taskId);
                }
            }
        }
    }

    this.emit('orch_review', {
        orchestrationId: this.id,
        decisions: review.decisions || [],
    });

    // Handle overall decision
    if (review.overall === 'abort_all') {
        // Reject all
        for (const [, st] of this._subtasks) {
            if (st.session && !st.session.destroyed) {
                try { await st.session.reject(); } catch { /* ignore */ }
            }
        }
        return this._fail('Planner decided to abort all');
    }

    if (review.overall === 'retry_failed') {
        // Re-execute failed subtasks
        const failedIds = [];
        for (const [taskId, st] of this._subtasks) {
            if (st.state === 'failed') {
                st.state = 'pending';
                st.result = null;
                st.retries = 0;
                st.startedAt = null;
                st.completedAt = null;
                if (st.session && !st.session.destroyed) { st.session.destroy(); st.session = null; }
                failedIds.push(taskId);
            }
        }
        if (failedIds.length > 0) {
            this._addLog('system', `Retrying failed subtasks: [${failedIds.join(', ')}]`);
            this._setState(STATES.RECOVERING);
            await this._executePhase(failedIds, 0);
            // Re-review after retry
            return this._review();
        }
    }

    this._complete();
}

_complete() {
    this._setState(STATES.COMPLETED);
    this._completedAt = Date.now();
    this._addLog('system', `Orchestration completed in ${this._elapsed()}ms`);
    this._cleanup();

    const results = {};
    for (const [taskId, st] of this._subtasks) {
        results[taskId] = {
            state: st.state,
            result: st.result,
            reviewDecision: st.reviewDecision,
        };
    }

    const accepted = Array.from(this._subtasks.values()).filter(s => s.reviewDecision === 'accepted').length;
    const rejected = Array.from(this._subtasks.values()).filter(s => s.reviewDecision === 'rejected').length;

    this.emit('orch_completed', {
        orchestrationId: this.id,
        summary: `${accepted} accepted, ${rejected} rejected, ${this._subtasks.size} total. Elapsed: ${this._elapsed()}ms`,
        results,
    });
}

// ── Phase context propagation ────────────────────────────────

async _summarizePhaseForNext(phaseTaskIds, phaseIdx) {
    const results = phaseTaskIds.map(tid => {
        const st = this._subtasks.get(tid);
        return `- ${tid}: ${st.state === 'completed' ? this._truncate(st.result, 1000) : 'FAILED'}`;
    }).join('\n');

    try {
        const summaryResponse = await this._plannerSession.sendMessage(
            `Phase ${phaseIdx + 1} complete. Summarize the results below into a compact context for the next phase of subtasks. Be concise.\n\n${results}\n\nRespond with a brief summary paragraph only.`
        );

        if (summaryResponse.text) {
            // Attach context to next phase subtasks
            const nextPhase = this._plan.phases[phaseIdx + 1];
            if (nextPhase) {
                for (const tid of nextPhase) {
                    const st = this._subtasks.get(tid);
                    if (st) st._phaseContext = summaryResponse.text;
                }
            }
        }
    } catch (e) {
        this._addLog('warning', `Phase summary failed: ${e.message}, next phase runs without context`);
    }
}
```

- [ ] **Step 17: Commit review + phase context**

```bash
git add src/orchestrator-session.js
git commit -m "feat(orchestrator): add review phase, accept/reject, phase context propagation"
```

- [ ] **Step 18: Add cancel() and revisePlan()**

```javascript
// ── Cancel ───────────────────────────────────────────────────

async cancel() {
    if (this._destroyed) return;
    if (this._state === STATES.COMPLETED || this._state === STATES.FAILED || this._state === STATES.CANCELLED) {
        return;
    }

    this._setState(STATES.CANCELLING);
    this._addLog('system', 'Cancelling orchestration...');

    this._cleanup();

    this._setState(STATES.CANCELLED);
    this._completedAt = Date.now();

    const partialResults = {};
    for (const [taskId, st] of this._subtasks) {
        if (st.result) partialResults[taskId] = { state: st.state, result: st.result };
    }

    this.emit('orch_cancelled', {
        orchestrationId: this.id,
        partialResults,
    });
}

// ── Revise plan (during AWAITING_APPROVAL) ───────────────────

async revisePlan(feedback) {
    if (this._state !== STATES.AWAITING_APPROVAL) {
        throw new Error(`Cannot revise: state is ${this._state}, expected AWAITING_APPROVAL`);
    }

    this._setState(STATES.PLANNING);
    this._addLog('system', `Revising plan: "${this._truncate(feedback, 100)}"`);

    try {
        const response = await this._plannerSession.sendMessage(
            `The user wants changes to the plan:\n\n${feedback}\n\nRevise the plan and respond with the updated JSON block.`
        );

        if (!response.text) {
            this._setState(STATES.AWAITING_APPROVAL);
            throw new Error('Planner returned empty response');
        }

        const newPlan = this._parseJson(response.text);

        // Re-validate
        if (newPlan.type === 'orchestrated' && newPlan.subtasks) {
            if (newPlan.subtasks.length > this._config.maxSubtasks) {
                newPlan.subtasks = newPlan.subtasks.slice(0, this._config.maxSubtasks);
            }
            if (newPlan.strategy === 'parallel') {
                const overlap = this._detectFileOverlap(newPlan.subtasks);
                if (overlap) newPlan.strategy = 'sequential';
            }
            if (!newPlan.phases || newPlan.phases.length === 0) {
                if (newPlan.strategy === 'sequential') {
                    newPlan.phases = newPlan.subtasks.map(t => [t.id]);
                } else {
                    newPlan.phases = [newPlan.subtasks.map(t => t.id)];
                }
            }
        }

        // Reset subtask state
        this._subtasks.clear();
        if (newPlan.subtasks) {
            for (const def of newPlan.subtasks) {
                this._subtasks.set(def.id, {
                    definition: def, session: null, state: 'pending', result: null,
                    retries: 0, startedAt: null, completedAt: null,
                    reviewDecision: null, clarificationQuestion: null, clarificationRounds: 0,
                });
            }
        }

        this._plan = newPlan;
        this._setState(STATES.AWAITING_APPROVAL);

        this.emit('orch_plan', {
            orchestrationId: this.id,
            plan: this._plan,
            requiredSlots: (newPlan.subtasks || []).length,
            availableSlots: sessionManager.getAvailableSlots(),
        });
    } catch (e) {
        this._setState(STATES.AWAITING_APPROVAL);
        throw e;
    }
}
```

- [ ] **Step 19: Commit cancel + revisePlan**

```bash
git add src/orchestrator-session.js
git commit -m "feat(orchestrator): add cancel and revisePlan methods"
```

- [ ] **Step 20: Verify OrchestratorSession loads completely**

Run: `node -e "const { OrchestratorSession, STATES } = require('./src/orchestrator-session'); console.log(Object.keys(STATES)); const o = new OrchestratorSession('test-id', { task: 'test task', workspace: 'TestWS' }); console.log(o.getStatus())"`
Expected: All states listed, status object with correct shape.

---

## Task 5: Orchestrator Manager (Shared State)

**Files:**
- Create: `src/orchestrator-manager.js`

The HTTP routes and WebSocket handler both need access to the same orchestration instances. This module is the shared registry — same pattern as `agent-session-manager.js`.

- [ ] **Step 1: Create orchestrator-manager.js**

```javascript
// === Orchestrator Manager ===
// Registry for concurrent OrchestratorSession instances.
// Shared between HTTP routes and WebSocket handler.

const crypto = require('crypto');
const { OrchestratorSession } = require('./orchestrator-session');
const { resolveLsInst } = require('./ls-utils');
const { getOrchestratorSettings } = require('./config');

const orchestrations = new Map(); // id -> OrchestratorSession
const history = [];               // completed orchestrations (metadata only)
let _config = null;

function _getConfig() {
    if (!_config) _config = getOrchestratorSettings();
    return _config;
}

function createOrchestration(opts = {}) {
    const cfg = _getConfig();
    if (!cfg.enabled) throw new Error('Orchestrator is disabled');

    // Check concurrent limit
    const active = Array.from(orchestrations.values()).filter(
        o => !['COMPLETED', 'FAILED', 'CANCELLED'].includes(o.state)
    );
    if (active.length >= cfg.maxConcurrentOrchestrations) {
        throw new Error(`Max concurrent orchestrations reached (${cfg.maxConcurrentOrchestrations})`);
    }

    const id = crypto.randomUUID();
    const orch = new OrchestratorSession(id, {
        task: opts.task,
        workspace: opts.workspace,
        lsInst: opts.lsInst || resolveLsInst(opts.workspace),
        ...cfg,
        ...(opts.config || {}), // user overrides
    });

    orchestrations.set(id, orch);

    orch.on('destroyed', () => {
        // Move to history before removing
        _archiveToHistory(id, orch);
        orchestrations.delete(id);
        _broadcast('orchestration_destroyed', { orchestrationId: id });
    });

    // Forward key events to UI broadcast
    for (const evt of ['orch_started', 'orch_analysis', 'orch_plan', 'orch_awaiting_approval',
        'orch_executing', 'orch_subtask_update', 'orch_phase_complete', 'orch_clarification',
        'orch_review', 'orch_completed', 'orch_failed', 'orch_cancelled', 'log', 'state_change']) {
        orch.on(evt, (data) => _broadcast(evt, { orchestrationId: id, ...data }));
    }

    _broadcast('orchestration_created', { orchestrationId: id, task: opts.task, workspace: opts.workspace });
    return orch;
}

function getOrchestration(id) { return orchestrations.get(id) || null; }

function destroyOrchestration(id) {
    const orch = orchestrations.get(id);
    if (orch) orch.destroy();
}

function listOrchestrations(includeCompleted = false) {
    const active = Array.from(orchestrations.values()).map(o => o.getStatus());
    if (includeCompleted) {
        return [...active, ...history.slice(-(_getConfig().historySize || 10))];
    }
    return active;
}

function configure(config) {
    _config = { ..._getConfig(), ...config };
}

function shutdownAll() {
    for (const orch of orchestrations.values()) orch.destroy();
    orchestrations.clear();
}

function _archiveToHistory(id, orch) {
    const cfg = _getConfig();
    history.push({
        id,
        state: orch.state,
        originalTask: orch.originalTask,
        workspace: orch.workspace,
        completedAt: Date.now(),
        progress: 1,
    });
    while (history.length > (cfg.historySize || 10)) history.shift();
}

function _broadcast(event, data) {
    try {
        const { broadcastAll } = require('./ws');
        broadcastAll({ type: 'orchestrator', event, ...data });
    } catch { /* ws not ready */ }
}

module.exports = {
    createOrchestration, getOrchestration, destroyOrchestration,
    listOrchestrations, configure, shutdownAll,
};
```

- [ ] **Step 2: Verify**

Run: `node -e "const om = require('./src/orchestrator-manager'); console.log(om.listOrchestrations())"`
Expected: `[]`

- [ ] **Step 3: Commit**

```bash
git add src/orchestrator-manager.js
git commit -m "feat(orchestrator): add orchestrator manager registry"
```

---

## Task 6: HTTP REST API Routes

**Files:**
- Create: `src/routes/orchestrator-api.js`
- Modify: `src/routes.js`

- [ ] **Step 1: Create orchestrator-api.js with all endpoints**

```javascript
const { Router } = require('express');
const { z } = require('zod');
const orchestratorManager = require('../orchestrator-manager');
const { getOrchestratorSettings, saveOrchestratorSettings } = require('../config');

const router = Router();

// ── Zod Schemas ──────────────────────────────────────────────

const StartSchema = z.object({
    task: z.string().min(1).max(10000),
    workspace: z.string().max(200).optional(),
    config: z.object({
        maxParallel: z.number().int().min(1).max(10).optional(),
        maxSubtasks: z.number().int().min(1).max(20).optional(),
    }).strict().optional(),
}).strict();

const ExecuteSchema = z.object({
    configOverrides: z.object({
        maxParallel: z.number().int().min(1).max(10).optional(),
    }).strict().optional(),
}).strict();

const ReviseSchema = z.object({
    feedback: z.string().min(1).max(10000),
}).strict();

const ClarifySchema = z.object({
    taskId: z.string().min(1).max(100),
    answer: z.string().min(1).max(10000),
}).strict();

const SettingsSchema = z.object({
    enabled: z.boolean().optional(),
    maxConcurrentOrchestrations: z.number().int().min(1).max(10).optional(),
    maxParallel: z.number().int().min(1).max(10).optional(),
    maxSubtasks: z.number().int().min(1).max(20).optional(),
    maxRetries: z.number().int().min(0).max(5).optional(),
    stuckTimeoutMs: z.number().int().min(60000).max(3600000).optional(),
    orchestrationTimeoutMs: z.number().int().min(60000).max(86400000).optional(),
    failureThreshold: z.number().min(0).max(1).optional(),
}).strict();

// ── Routes ───────────────────────────────────────────────────

// POST /api/orchestrator/start
router.post('/start', async (req, res) => {
    try {
        const body = StartSchema.parse(req.body || {});
        const orch = orchestratorManager.createOrchestration({
            task: body.task,
            workspace: body.workspace,
            config: body.config,
        });

        // Start analysis+planning (async, non-blocking for SSE; blocking for JSON)
        const isSSE = req.headers.accept === 'text/event-stream';
        if (isSSE) {
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
            const send = (evt, data) => res.write(`event: ${evt}\ndata: ${JSON.stringify(data)}\n\n`);

            // Wire listeners BEFORE calling start() to avoid missing early events
            orch.on('orch_analysis', d => send('analysis', d));
            orch.on('orch_plan', d => send('plan', d));
            orch.on('orch_awaiting_approval', () => send('awaiting_approval', orch.getStatus()));
            orch.on('orch_completed', d => send('completed', d));
            orch.on('orch_failed', d => send('failed', d));
            orch.on('log', d => send('log', d));

            // Send initial event before async start
            send('started', { orchestrationId: orch.id, state: orch.state });

            await orch.start();
            send('done', orch.getStatus());
            res.end();
        } else {
            await orch.start();
            res.json(orch.getStatus());
        }
    } catch (e) {
        if (e instanceof z.ZodError) return res.status(400).json({ error: 'Invalid request', details: e.issues });
        res.status(500).json({ error: e.message, code: 'START_FAILED' });
    }
});

// POST /api/orchestrator/:id/execute
router.post('/:id/execute', async (req, res) => {
    try {
        const orch = orchestratorManager.getOrchestration(req.params.id);
        if (!orch) return res.status(404).json({ error: 'Not found', code: 'ORCHESTRATION_NOT_FOUND' });
        const body = ExecuteSchema.parse(req.body || {});
        // Execute runs async — return immediately
        orch.execute(body.configOverrides || {}).catch(e => {
            console.error(`[Orchestrator] Execute error: ${e.message}`);
        });
        res.json({ state: 'EXECUTING', message: 'Execution started' });
    } catch (e) {
        if (e instanceof z.ZodError) return res.status(400).json({ error: 'Invalid request', details: e.issues });
        res.status(500).json({ error: e.message });
    }
});

// POST /api/orchestrator/:id/revise-plan
router.post('/:id/revise-plan', async (req, res) => {
    try {
        const orch = orchestratorManager.getOrchestration(req.params.id);
        if (!orch) return res.status(404).json({ error: 'Not found', code: 'ORCHESTRATION_NOT_FOUND' });
        const body = ReviseSchema.parse(req.body || {});
        await orch.revisePlan(body.feedback);
        res.json(orch.getStatus());
    } catch (e) {
        if (e instanceof z.ZodError) return res.status(400).json({ error: 'Invalid request', details: e.issues });
        res.status(e.message.includes('Cannot revise') ? 409 : 500).json({ error: e.message });
    }
});

// GET /api/orchestrator/:id/status
router.get('/:id/status', (req, res) => {
    const orch = orchestratorManager.getOrchestration(req.params.id);
    if (!orch) return res.status(404).json({ error: 'Not found', code: 'ORCHESTRATION_NOT_FOUND' });
    res.json(orch.getStatus());
});

// POST /api/orchestrator/:id/cancel
router.post('/:id/cancel', async (req, res) => {
    const orch = orchestratorManager.getOrchestration(req.params.id);
    if (!orch) return res.status(404).json({ error: 'Not found', code: 'ORCHESTRATION_NOT_FOUND' });
    await orch.cancel();
    res.json({ state: orch.state });
});

// POST /api/orchestrator/:id/clarify
router.post('/:id/clarify', async (req, res) => {
    try {
        const orch = orchestratorManager.getOrchestration(req.params.id);
        if (!orch) return res.status(404).json({ error: 'Not found', code: 'ORCHESTRATION_NOT_FOUND' });
        const body = ClarifySchema.parse(req.body || {});
        await orch.answerClarification(body.taskId, body.answer);
        res.json({ state: 'running' });
    } catch (e) {
        if (e instanceof z.ZodError) return res.status(400).json({ error: 'Invalid request', details: e.issues });
        res.status(400).json({ error: e.message });
    }
});

// GET /api/orchestrator/:id/events — SSE stream
router.get('/:id/events', (req, res) => {
    const orch = orchestratorManager.getOrchestration(req.params.id);
    if (!orch) return res.status(404).json({ error: 'Not found', code: 'ORCHESTRATION_NOT_FOUND' });

    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const send = (evt, data) => res.write(`event: ${evt}\ndata: ${JSON.stringify(data)}\n\n`);

    const events = ['orch_subtask_update', 'orch_phase_complete', 'orch_clarification',
        'orch_review', 'orch_completed', 'orch_failed', 'orch_cancelled', 'log', 'state_change'];
    const listeners = events.map(evt => {
        const fn = (data) => send(evt, data);
        orch.on(evt, fn);
        return { evt, fn };
    });

    req.on('close', () => listeners.forEach(({ evt, fn }) => orch.removeListener(evt, fn)));
});

// GET /api/orchestrator/:id/subtask/:taskId
router.get('/:id/subtask/:taskId', (req, res) => {
    const orch = orchestratorManager.getOrchestration(req.params.id);
    if (!orch) return res.status(404).json({ error: 'Not found', code: 'ORCHESTRATION_NOT_FOUND' });
    const status = orch.getStatus();
    const subtask = status.subtasks[req.params.taskId];
    if (!subtask) return res.status(404).json({ error: 'Subtask not found' });
    res.json(subtask);
});

// GET /api/orchestrator/:id/subtask/:taskId/log
router.get('/:id/subtask/:taskId/log', (req, res) => {
    const orch = orchestratorManager.getOrchestration(req.params.id);
    if (!orch) return res.status(404).json({ error: 'Not found', code: 'ORCHESTRATION_NOT_FOUND' });
    const logs = orch._logs.filter(l => l.taskId === req.params.taskId);
    res.json({ logs });
});

// GET /api/orchestrator/list
router.get('/list', (req, res) => {
    const includeCompleted = req.query.includeCompleted === 'true';
    res.json({ orchestrations: orchestratorManager.listOrchestrations(includeCompleted) });
});

// DELETE /api/orchestrator/:id
router.delete('/:id', (req, res) => {
    orchestratorManager.destroyOrchestration(req.params.id);
    res.json({ ok: true });
});

// GET /api/orchestrator/settings
router.get('/settings', (req, res) => {
    res.json(getOrchestratorSettings());
});

// PUT /api/orchestrator/settings
router.put('/settings', (req, res) => {
    try {
        const body = SettingsSchema.parse(req.body || {});
        const saved = saveOrchestratorSettings(body);
        orchestratorManager.configure(saved);
        res.json(saved);
    } catch (e) {
        if (e instanceof z.ZodError) return res.status(400).json({ error: 'Invalid settings', details: e.issues });
        res.status(500).json({ error: e.message });
    }
});

// GET /api/orchestrator/prompt
router.get('/prompt', (req, res) => {
    const settings = getOrchestratorSettings();
    res.json({ prompt: settings.plannerPrompt || null });
});

// PUT /api/orchestrator/prompt
router.put('/prompt', (req, res) => {
    const { prompt } = req.body || {};
    if (typeof prompt !== 'string') return res.status(400).json({ error: 'Missing "prompt" string field' });
    const saved = saveOrchestratorSettings({ plannerPrompt: prompt });
    res.json({ prompt: saved.plannerPrompt });
});

module.exports = (app) => {
    app.use('/api/orchestrator', router);
};
```

- [ ] **Step 2: Register in routes.js**

Add to `src/routes.js` after the `agent-api` line:
```javascript
require('./routes/orchestrator-api')(app);
```

- [ ] **Step 3: Verify**

Run: `node -e "const express = require('express'); const app = express(); require('./src/routes/orchestrator-api')(app); console.log('OK')"`
Expected: `OK`

- [ ] **Step 4: Commit**

```bash
git add src/routes/orchestrator-api.js src/routes.js
git commit -m "feat(api): add orchestrator HTTP REST API with all endpoints"
```

---

## Task 7: WebSocket Handler

**Files:**
- Create: `src/ws-orchestrator.js`

- [ ] **Step 1: Create ws-orchestrator.js with full implementation**

```javascript
// === WebSocket Orchestrator Protocol ===
// Dedicated WebSocket endpoint for orchestrator at /ws/orchestrator.
// Separate from /ws (UI) and /ws/agent (agent sessions).
//
// Protocol:
//   Client → Server: orchestrate, orchestrate_execute, orchestrate_revise,
//                    orchestrate_cancel, orchestrate_clarify, orchestrate_status
//   Server → Client: orch_started, orch_analysis, orch_plan, orch_awaiting_approval,
//                    orch_executing, orch_subtask_update, orch_phase_complete,
//                    orch_clarification, orch_review, orch_progress, orch_completed,
//                    orch_failed, orch_cancelled, orch_log, orch_error

const orchestratorManager = require('./orchestrator-manager');

/**
 * Set up the orchestrator WebSocket server.
 * @param {import('ws').WebSocketServer} wss
 */
function setupOrchestratorWebSocket(wss) {
    wss.on('connection', (ws, req) => {
        // Auth check (same pattern as ws-agent.js)
        const authKey = process.env.AUTH_KEY || '';
        if (authKey) {
            const ip = req.socket.remoteAddress || '';
            const isLocal = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
            if (!isLocal) {
                const url = new URL(req.url, 'http://localhost');
                const key = url.searchParams.get('auth_key');
                if (key !== authKey) {
                    ws.close(4401, 'Unauthorized');
                    return;
                }
            }
        }

        // Track which orchestrations this WS connection is subscribed to
        const subscriptions = new Map(); // orchestrationId → cleanup function

        console.log('[WS-Orchestrator] New connection');

        ws.on('message', async (raw) => {
            let msg;
            try {
                msg = JSON.parse(raw.toString());
            } catch {
                _send(ws, { type: 'orch_error', message: 'Invalid JSON' });
                return;
            }

            try {
                switch (msg.type) {
                    case 'orchestrate': {
                        if (!msg.task) {
                            _send(ws, { type: 'orch_error', message: 'Missing "task" field' });
                            break;
                        }

                        const orch = orchestratorManager.createOrchestration({
                            task: msg.task,
                            workspace: msg.workspace,
                            config: msg.config,
                        });

                        // Wire events for this orchestration
                        const cleanup = _wireOrchestratorEvents(ws, orch);
                        subscriptions.set(orch.id, cleanup);

                        _send(ws, { type: 'orch_started', orchestrationId: orch.id, state: orch.state });

                        // Start analysis+planning (async — events stream as they happen)
                        orch.start().catch(e => {
                            _send(ws, { type: 'orch_error', orchestrationId: orch.id, message: e.message });
                        });
                        break;
                    }

                    case 'orchestrate_execute': {
                        const orch = _getOrch(ws, msg.orchestrationId);
                        if (!orch) break;

                        // Ensure we're subscribed
                        if (!subscriptions.has(orch.id)) {
                            const cleanup = _wireOrchestratorEvents(ws, orch);
                            subscriptions.set(orch.id, cleanup);
                        }

                        orch.execute(msg.configOverrides || {}).catch(e => {
                            _send(ws, { type: 'orch_error', orchestrationId: orch.id, message: e.message });
                        });
                        _send(ws, { type: 'orch_executing', orchestrationId: orch.id });
                        break;
                    }

                    case 'orchestrate_revise': {
                        const orch = _getOrch(ws, msg.orchestrationId);
                        if (!orch) break;

                        if (!msg.feedback) {
                            _send(ws, { type: 'orch_error', orchestrationId: orch.id, message: 'Missing "feedback" field' });
                            break;
                        }

                        orch.revisePlan(msg.feedback).catch(e => {
                            _send(ws, { type: 'orch_error', orchestrationId: orch.id, message: e.message });
                        });
                        break;
                    }

                    case 'orchestrate_cancel': {
                        const orch = _getOrch(ws, msg.orchestrationId);
                        if (!orch) break;

                        await orch.cancel();
                        // orch_cancelled event emitted by _wireOrchestratorEvents
                        break;
                    }

                    case 'orchestrate_clarify': {
                        const orch = _getOrch(ws, msg.orchestrationId);
                        if (!orch) break;

                        if (!msg.taskId || !msg.answer) {
                            _send(ws, { type: 'orch_error', orchestrationId: orch.id, message: 'Missing "taskId" or "answer" field' });
                            break;
                        }

                        await orch.answerClarification(msg.taskId, msg.answer);
                        break;
                    }

                    case 'orchestrate_status': {
                        const orch = _getOrch(ws, msg.orchestrationId);
                        if (!orch) break;

                        _send(ws, { type: 'orch_status', orchestrationId: orch.id, ...orch.getStatus() });
                        break;
                    }

                    default:
                        _send(ws, { type: 'orch_error', message: `Unknown message type: ${msg.type}` });
                }
            } catch (e) {
                _send(ws, { type: 'orch_error', orchestrationId: msg.orchestrationId, message: e.message });
            }
        });

        ws.on('close', () => {
            console.log('[WS-Orchestrator] Connection closed — cleaning up subscriptions');
            for (const cleanup of subscriptions.values()) {
                cleanup();
            }
            subscriptions.clear();
        });

        ws.on('error', (err) => {
            console.error('[WS-Orchestrator] WebSocket error:', err.message);
        });
    });
}

// ── Internal ─────────────────────────────────────────────────────────────────

/**
 * Look up orchestration by ID; send error and return null if not found.
 */
function _getOrch(ws, orchestrationId) {
    if (!orchestrationId) {
        _send(ws, { type: 'orch_error', message: 'Missing "orchestrationId" field' });
        return null;
    }
    const orch = orchestratorManager.getOrchestration(orchestrationId);
    if (!orch) {
        _send(ws, { type: 'orch_error', orchestrationId, message: 'Orchestration not found' });
        return null;
    }
    return orch;
}

/**
 * Wire OrchestratorSession events → WebSocket messages.
 * Returns a cleanup function that removes all listeners.
 */
function _wireOrchestratorEvents(ws, orch) {
    const listeners = [];

    function on(event, handler) {
        orch.on(event, handler);
        listeners.push({ event, handler });
    }

    on('orch_analysis', (data) => {
        _send(ws, { type: 'orch_analysis', orchestrationId: orch.id, ...data });
    });

    on('orch_plan', (data) => {
        _send(ws, { type: 'orch_plan', orchestrationId: orch.id, ...data });
    });

    on('orch_awaiting_approval', () => {
        _send(ws, { type: 'orch_awaiting_approval', orchestrationId: orch.id });
    });

    on('orch_executing', () => {
        _send(ws, { type: 'orch_executing', orchestrationId: orch.id });
    });

    on('orch_subtask_update', (data) => {
        _send(ws, { type: 'orch_subtask_update', orchestrationId: orch.id, ...data });
    });

    on('orch_phase_complete', (data) => {
        _send(ws, { type: 'orch_phase_complete', orchestrationId: orch.id, ...data });
    });

    on('orch_clarification', (data) => {
        _send(ws, { type: 'orch_clarification', orchestrationId: orch.id, ...data });
    });

    on('orch_review', (data) => {
        _send(ws, { type: 'orch_review', orchestrationId: orch.id, ...data });
    });

    on('orch_progress', (data) => {
        _send(ws, { type: 'orch_progress', orchestrationId: orch.id, ...data });
    });

    on('orch_completed', (data) => {
        _send(ws, { type: 'orch_completed', orchestrationId: orch.id, ...data });
    });

    on('orch_failed', (data) => {
        _send(ws, { type: 'orch_failed', orchestrationId: orch.id, ...data });
    });

    on('orch_cancelled', () => {
        _send(ws, { type: 'orch_cancelled', orchestrationId: orch.id });
    });

    on('log', (data) => {
        _send(ws, { type: 'orch_log', orchestrationId: orch.id, taskId: data.taskId, logType: data.type, message: data.message });
    });

    on('error', (err) => {
        _send(ws, { type: 'orch_error', orchestrationId: orch.id, message: err.message });
    });

    // Return cleanup function
    return () => {
        for (const { event, handler } of listeners) {
            orch.removeListener(event, handler);
        }
    };
}

function _send(ws, data) {
    if (ws.readyState === 1) {
        ws.send(JSON.stringify(data));
    }
}

module.exports = { setupOrchestratorWebSocket };
```

- [ ] **Step 2: Verify module loads**

Run: `node -e "require('./src/ws-orchestrator'); console.log('OK')"`
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add src/ws-orchestrator.js
git commit -m "feat(ws): add WebSocket /ws/orchestrator handler"
```

---

## Task 8: Server Integration

**Files:**
- Modify: `server.js`

- [ ] **Step 1: Add WebSocket server for /ws/orchestrator**

In server.js, after the existing `agentWss` declaration (~line 23), add:
```javascript
const orchestratorWss = new WebSocketServer({ noServer: true });
```

Replace the existing `upgrade` handler (~line 25-32):
```javascript
server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname === '/ws/orchestrator') {
    orchestratorWss.handleUpgrade(req, socket, head, ws => orchestratorWss.emit('connection', ws, req));
  } else if (pathname === '/ws/agent') {
    agentWss.handleUpgrade(req, socket, head, ws => agentWss.emit('connection', ws, req));
  } else {
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  }
});
```

After the existing `setupAgentWebSocket` call (~line 249), add:
```javascript
// Orchestrator WebSocket — orchestrator protocol at /ws/orchestrator
const { setupOrchestratorWebSocket } = require('./src/ws-orchestrator');
setupOrchestratorWebSocket(orchestratorWss);
```

- [ ] **Step 2: Verify server starts**

Run: `node server.js` (Ctrl+C after it starts)
Expected: No errors related to orchestrator modules.

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat(server): add /ws/orchestrator WebSocket endpoint"
```

---

## Task 9: Frontend Types + API Client

**Files:**
- Create: `frontend/lib/orchestrator-api.ts`

- [ ] **Step 1: Create types and HTTP helpers**

```typescript
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
```

- [ ] **Step 2: Commit**

```bash
git add frontend/lib/orchestrator-api.ts
git commit -m "feat(frontend): add orchestrator TypeScript types and API client"
```

---

## Task 10: Frontend Config URL

**Files:**
- Modify: `frontend/lib/config.ts`

- [ ] **Step 1: Add getOrchestratorWsUrl function**

Add after the existing `getAgentWsUrl` function (~line 60):
```typescript
/**
 * Orchestrator WebSocket URL — derived from UI WS URL.
 * Example: ws://localhost:3500 → ws://localhost:3500/ws/orchestrator
 */
export async function getOrchestratorWsUrl(): Promise<string> {
    const uiWsUrl = await getWsUrl();
    return `${uiWsUrl}/ws/orchestrator`;
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/lib/config.ts
git commit -m "feat(frontend): add orchestrator WebSocket URL helper"
```

---

## Task 11: Frontend WebSocket Hook

**Files:**
- Create: `frontend/hooks/use-orchestrator-ws.ts`

- [ ] **Step 1: Create the hook**

```typescript
'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { getOrchestratorWsUrl } from '@/lib/config';
import { authWsUrl } from '@/lib/auth';
import type {
    OrchestratorState, OrchestratorStatus, OrchestratorPlan,
    SubtaskStatus, OrchestratorEvent, OrchestratorLog,
} from '@/lib/orchestrator-api';
import { getOrchestrationStatus } from '@/lib/orchestrator-api';

// ── State machine ──────────────────────────────────────────────────
//   idle → connecting → (server states mirror OrchestratorState)
//   On WS close: attempt reconnect → restore from /api/orchestrator/:id/status

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

                // If we had an active orchestration, request status recovery
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
```

- [ ] **Step 2: Commit**

```bash
git add frontend/hooks/use-orchestrator-ws.ts
git commit -m "feat(frontend): add useOrchestratorWs hook"
```

---

## Task 12: Frontend Orchestrator Panel

**Files:**
- Create: `frontend/components/agent-hub/orchestrator-task-card.tsx`
- Create: `frontend/components/agent-hub/orchestrator-panel.tsx`

- [ ] **Step 1: Create orchestrator-task-card.tsx**

```tsx
'use client';

import { useState, memo } from 'react';
import { cn } from '@/lib/utils';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Loader2, CheckCircle2, XCircle, AlertTriangle, HelpCircle, RotateCcw } from 'lucide-react';
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
```

- [ ] **Step 2: Create orchestrator-panel.tsx**

```tsx
'use client';

import { useState, useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Loader2, Play, XCircle, RotateCcw, ChevronDown, ChevronRight } from 'lucide-react';
import { useOrchestratorWs } from '@/hooks/use-orchestrator-ws';
import { OrchestratorTaskCard } from './orchestrator-task-card';
import { API_BASE } from '@/lib/config';
import { authHeaders } from '@/lib/auth';

export function OrchestratorPanel() {
    const orch = useOrchestratorWs();
    const [task, setTask] = useState('');
    const [workspace, setWorkspace] = useState('');
    const [workspaces, setWorkspaces] = useState<string[]>([]);
    const [feedback, setFeedback] = useState('');
    const [logsOpen, setLogsOpen] = useState(false);
    const logsEndRef = useRef<HTMLDivElement>(null);

    // Auto-connect WS on mount
    useEffect(() => { orch.connect(); }, []);

    // Fetch workspaces
    useEffect(() => {
        (async () => {
            try {
                const res = await fetch(`${API_BASE}/api/workspaces`, { headers: authHeaders() });
                if (res.ok) {
                    const data = await res.json();
                    const names = Array.isArray(data) ? data.map((w: { name?: string }) => w.name || '').filter(Boolean) : [];
                    setWorkspaces(names);
                    if (names.length > 0 && !workspace) setWorkspace(names[0]);
                }
            } catch { /* silent */ }
        })();
    }, []);

    // Auto-scroll logs
    useEffect(() => {
        if (logsOpen) logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [orch.logs.length, logsOpen]);

    const handleStart = () => {
        if (!task.trim()) return;
        orch.orchestrate(task.trim(), workspace || undefined);
        setTask('');
    };

    const isIdle = !orch.state;
    const isAnalyzing = orch.state === 'ANALYZING' || orch.state === 'PLANNING';
    const isAwaiting = orch.state === 'AWAITING_APPROVAL';
    const isExecuting = orch.state === 'EXECUTING' || orch.state === 'RECOVERING';
    const isReviewing = orch.state === 'REVIEWING';
    const isDone = orch.state === 'COMPLETED' || orch.state === 'FAILED' || orch.state === 'CANCELLED';

    return (
        <div className="flex flex-col h-full overflow-hidden">
            <div className="flex-1 overflow-y-auto p-3 space-y-3">
                {/* Connection status */}
                {orch.connectionState !== 'connected' && orch.connectionState !== 'idle' && (
                    <div className="text-[10px] text-amber-400 text-center py-1">
                        {orch.connectionState === 'connecting' && 'Connecting...'}
                        {orch.connectionState === 'reconnecting' && 'Reconnecting...'}
                        {orch.connectionState === 'error' && `Connection error: ${orch.error}`}
                    </div>
                )}

                {/* Idle: Task input */}
                {isIdle && (
                    <Card className="bg-muted/5 border-border/20">
                        <CardContent className="p-3 space-y-2">
                            <Textarea
                                value={task}
                                onChange={e => setTask(e.target.value)}
                                placeholder="Describe the task to orchestrate..."
                                className="min-h-[80px] text-[11px] bg-background/50 resize-none"
                                onKeyDown={e => { if (e.key === 'Enter' && e.metaKey) handleStart(); }}
                            />
                            <div className="flex items-center gap-2">
                                <select
                                    value={workspace}
                                    onChange={e => setWorkspace(e.target.value)}
                                    className="h-7 text-[10px] bg-background/50 border border-border/30 rounded px-2"
                                >
                                    {workspaces.map(w => (
                                        <option key={w} value={w}>{w}</option>
                                    ))}
                                </select>
                                <Button
                                    size="sm"
                                    className="h-7 text-[10px] px-3 ml-auto"
                                    disabled={!task.trim()}
                                    onClick={handleStart}
                                >
                                    <Play className="h-3 w-3 mr-1" /> Orchestrate
                                </Button>
                            </div>
                        </CardContent>
                    </Card>
                )}

                {/* Analyzing/Planning spinner */}
                {isAnalyzing && (
                    <div className="flex flex-col items-center gap-2 py-8">
                        <Loader2 className="h-6 w-6 text-blue-400 animate-spin" />
                        <span className="text-[10px] text-foreground/60">
                            {orch.state === 'ANALYZING' ? 'Analyzing task...' : 'Planning subtasks...'}
                        </span>
                    </div>
                )}

                {/* Awaiting approval: plan review */}
                {isAwaiting && orch.plan && (
                    <Card className="bg-muted/5 border-border/20">
                        <CardContent className="p-3 space-y-3">
                            <div className="flex items-center justify-between">
                                <span className="text-[11px] font-semibold text-foreground/80">Plan Review</span>
                                <Badge variant="outline" className="text-[9px] px-1.5 py-0 text-blue-400">
                                    {orch.plan.strategy} &middot; {orch.plan.subtasks?.length || 0} tasks
                                </Badge>
                            </div>

                            {orch.plan.summary && (
                                <p className="text-[10px] text-foreground/60">{orch.plan.summary}</p>
                            )}

                            <div className="space-y-2">
                                {orch.plan.subtasks?.map(st => (
                                    <div key={st.id} className="flex items-start gap-2 text-[10px]">
                                        <span className="font-mono text-foreground/40 shrink-0">{st.id}</span>
                                        <span className="text-foreground/70">{st.description}</span>
                                    </div>
                                ))}
                            </div>

                            {/* Feedback input */}
                            <div className="flex gap-1.5">
                                <Input
                                    value={feedback}
                                    onChange={e => setFeedback(e.target.value)}
                                    className="h-7 text-[10px] bg-background/50"
                                    placeholder="Request changes (optional)..."
                                />
                                <Button
                                    size="sm"
                                    variant="outline"
                                    className="h-7 text-[10px] px-2 shrink-0"
                                    disabled={!feedback.trim()}
                                    onClick={() => { orch.revisePlan(feedback); setFeedback(''); }}
                                >
                                    <RotateCcw className="h-3 w-3 mr-1" /> Revise
                                </Button>
                            </div>

                            <div className="flex gap-2 pt-1">
                                <Button size="sm" className="h-7 text-[10px] px-3" onClick={() => orch.execute()}>
                                    <Play className="h-3 w-3 mr-1" /> Execute
                                </Button>
                                <Button size="sm" variant="outline" className="h-7 text-[10px] px-3 text-red-400" onClick={orch.cancel}>
                                    <XCircle className="h-3 w-3 mr-1" /> Cancel
                                </Button>
                            </div>
                        </CardContent>
                    </Card>
                )}

                {/* Executing: progress bar + subtask grid */}
                {(isExecuting || isReviewing) && (
                    <>
                        {/* Progress bar */}
                        <div className="space-y-1">
                            <div className="flex items-center justify-between text-[9px] text-foreground/50">
                                <span>{orch.state === 'REVIEWING' ? 'Reviewing...' : 'Executing...'}</span>
                                <span>{Math.round(orch.progress * 100)}% &middot; {Math.round(orch.elapsed / 1000)}s</span>
                            </div>
                            <div className="h-1 bg-muted/20 rounded-full overflow-hidden">
                                <div
                                    className="h-full bg-blue-500 rounded-full transition-all duration-500"
                                    style={{ width: `${orch.progress * 100}%` }}
                                />
                            </div>
                        </div>

                        {/* Subtask cards */}
                        <div className="space-y-2">
                            {Object.entries(orch.subtasks).map(([taskId, st]) => (
                                <OrchestratorTaskCard
                                    key={taskId}
                                    taskId={taskId}
                                    status={st}
                                    onClarify={orch.answerClarification}
                                />
                            ))}
                        </div>

                        {isExecuting && (
                            <Button size="sm" variant="outline" className="h-7 text-[10px] px-3 text-red-400" onClick={orch.cancel}>
                                <XCircle className="h-3 w-3 mr-1" /> Cancel
                            </Button>
                        )}
                    </>
                )}

                {/* Done: summary */}
                {isDone && (
                    <Card className={cn('border-border/20',
                        orch.state === 'COMPLETED' ? 'bg-emerald-500/5' :
                        orch.state === 'FAILED' ? 'bg-red-500/5' : 'bg-muted/5'
                    )}>
                        <CardContent className="p-3 space-y-2">
                            <div className="flex items-center gap-2">
                                <Badge variant="outline" className={cn('text-[10px] px-2 py-0.5',
                                    orch.state === 'COMPLETED' ? 'text-emerald-400' :
                                    orch.state === 'FAILED' ? 'text-red-400' : 'text-muted-foreground'
                                )}>
                                    {orch.state}
                                </Badge>
                                <span className="text-[9px] text-foreground/40">{Math.round(orch.elapsed / 1000)}s elapsed</span>
                            </div>

                            {orch.error && (
                                <p className="text-[10px] text-red-400">{orch.error}</p>
                            )}

                            {Object.keys(orch.subtasks).length > 0 && (
                                <div className="space-y-2">
                                    {Object.entries(orch.subtasks).map(([taskId, st]) => (
                                        <OrchestratorTaskCard key={taskId} taskId={taskId} status={st} />
                                    ))}
                                </div>
                            )}

                            <Button size="sm" variant="outline" className="h-7 text-[10px] px-3 mt-2" onClick={orch.disconnect}>
                                New Orchestration
                            </Button>
                        </CardContent>
                    </Card>
                )}
            </div>

            {/* Collapsible logs */}
            <div className="border-t border-border/20 shrink-0">
                <button
                    className="flex items-center gap-1 w-full px-3 py-1.5 text-[10px] text-foreground/50 hover:text-foreground/70"
                    onClick={() => setLogsOpen(o => !o)}
                >
                    {logsOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                    Logs ({orch.logs.length})
                </button>
                {logsOpen && (
                    <div className="max-h-32 overflow-y-auto px-3 pb-2 space-y-0.5">
                        {orch.logs.map((log, i) => (
                            <div key={i} className="text-[9px] font-mono text-foreground/40">
                                <span className={cn(
                                    log.type === 'error' && 'text-red-400',
                                    log.type === 'warning' && 'text-amber-400',
                                )}>
                                    [{log.type}]
                                </span>{' '}
                                {log.taskId && <span className="text-foreground/30">[{log.taskId}] </span>}
                                {log.message}
                            </div>
                        ))}
                        <div ref={logsEndRef} />
                    </div>
                )}
            </div>
        </div>
    );
}
```

- [ ] **Step 3: Commit**

```bash
git add frontend/components/agent-hub/orchestrator-panel.tsx frontend/components/agent-hub/orchestrator-task-card.tsx
git commit -m "feat(frontend): add orchestrator panel and task card components"
```

---

## Task 13: Frontend Agent Hub Integration

**Files:**
- Modify: `frontend/components/agent-hub-view.tsx`
- Modify: `frontend/components/agent-hub/config-panel.tsx`

- [ ] **Step 1: Add Orchestrator tab to agent-hub-view.tsx**

Add import at top:
```typescript
import { Workflow } from 'lucide-react';
import { OrchestratorPanel } from '@/components/agent-hub/orchestrator-panel';
```

Add a new `TabsTrigger` after the "Logs" trigger (~line 61):
```tsx
<TabsTrigger value="orchestrator" className="text-[10px] h-6 gap-1 px-2 data-[state=active]:bg-muted/10">
    <Workflow className="h-3 w-3" /> Orchestrator
</TabsTrigger>
```

Add matching `TabsContent` after the logs content (~line 79):
```tsx
<TabsContent value="orchestrator" className="flex-1 min-h-0 m-0">
    <OrchestratorPanel />
</TabsContent>
```

- [ ] **Step 2: Add Orchestrator Settings section to config-panel.tsx**

Import at top of config-panel.tsx:
```typescript
import { fetchOrchestratorSettings, saveOrchestratorSettings, fetchPlannerPrompt, savePlannerPrompt } from '@/lib/orchestrator-api';
import type { OrchestratorConfig } from '@/lib/orchestrator-api';
```

Add state and load effect (inside the component, alongside existing settings state):
```typescript
const [orchSettings, setOrchSettings] = useState<OrchestratorConfig | null>(null);
const [orchDirty, setOrchDirty] = useState(false);
const [orchPrompt, setOrchPrompt] = useState('');

useEffect(() => {
    fetchOrchestratorSettings().then(setOrchSettings).catch(() => {});
    fetchPlannerPrompt().then(d => setOrchPrompt(d.prompt || '')).catch(() => {});
}, []);

const saveOrch = async () => {
    if (!orchSettings) return;
    try {
        const saved = await saveOrchestratorSettings(orchSettings);
        setOrchSettings(saved);
        setOrchDirty(false);
    } catch { /* toast error */ }
};

const savePrompt = async () => {
    try { await savePlannerPrompt(orchPrompt); } catch { /* toast error */ }
};
```

Add a collapsible "Orchestrator" section after the existing Discord Bridge section in the JSX (follow the existing collapsible pattern used for other sections):
```tsx
{/* Orchestrator Settings */}
<CollapsibleSection title="Orchestrator" defaultOpen={false}>
    {orchSettings && (
        <div className="space-y-3 text-[10px]">
            <label className="flex items-center justify-between">
                <span className="text-foreground/70">Enabled</span>
                <input type="checkbox" checked={orchSettings.enabled}
                    onChange={e => { setOrchSettings({ ...orchSettings, enabled: e.target.checked }); setOrchDirty(true); }} />
            </label>
            <label className="flex items-center justify-between">
                <span className="text-foreground/70">Max Parallel Sub-agents</span>
                <input type="number" min={1} max={10} value={orchSettings.maxParallel}
                    className="w-16 h-6 text-[10px] bg-background/50 border border-border/30 rounded px-2"
                    onChange={e => { setOrchSettings({ ...orchSettings, maxParallel: +e.target.value }); setOrchDirty(true); }} />
            </label>
            <label className="flex items-center justify-between">
                <span className="text-foreground/70">Max Subtasks</span>
                <input type="number" min={1} max={20} value={orchSettings.maxSubtasks}
                    className="w-16 h-6 text-[10px] bg-background/50 border border-border/30 rounded px-2"
                    onChange={e => { setOrchSettings({ ...orchSettings, maxSubtasks: +e.target.value }); setOrchDirty(true); }} />
            </label>
            <label className="flex items-center justify-between">
                <span className="text-foreground/70">Max Concurrent Orchestrations</span>
                <input type="number" min={1} max={10} value={orchSettings.maxConcurrentOrchestrations}
                    className="w-16 h-6 text-[10px] bg-background/50 border border-border/30 rounded px-2"
                    onChange={e => { setOrchSettings({ ...orchSettings, maxConcurrentOrchestrations: +e.target.value }); setOrchDirty(true); }} />
            </label>
            <label className="flex items-center justify-between">
                <span className="text-foreground/70">Failure Threshold</span>
                <input type="number" min={0} max={1} step={0.1} value={orchSettings.failureThreshold}
                    className="w-16 h-6 text-[10px] bg-background/50 border border-border/30 rounded px-2"
                    onChange={e => { setOrchSettings({ ...orchSettings, failureThreshold: +e.target.value }); setOrchDirty(true); }} />
            </label>
            {orchDirty && (
                <Button size="sm" className="h-6 text-[10px] px-3" onClick={saveOrch}>
                    Save Settings
                </Button>
            )}

            {/* Planner prompt */}
            <div className="space-y-1.5 pt-2 border-t border-border/20">
                <span className="text-foreground/70">Planner Prompt</span>
                <Textarea
                    value={orchPrompt}
                    onChange={e => setOrchPrompt(e.target.value)}
                    className="min-h-[100px] text-[10px] bg-background/50 resize-y font-mono"
                />
                <Button size="sm" variant="outline" className="h-6 text-[10px] px-3" onClick={savePrompt}>
                    Save Prompt
                </Button>
            </div>
        </div>
    )}
</CollapsibleSection>
```

- [ ] **Step 3: Commit**

```bash
git add frontend/components/agent-hub-view.tsx frontend/components/agent-hub/config-panel.tsx
git commit -m "feat(frontend): integrate orchestrator tab and settings into Agent Hub"
```

---

## Task 14: Final Integration Test

- [ ] **Step 1: Verify backend starts without errors**

Run: `node server.js`
Expected: Server starts, no orchestrator-related errors in console.

- [ ] **Step 2: Verify frontend builds**

Run: `cd frontend && npm run build`
Expected: Build succeeds with no TypeScript errors.

- [ ] **Step 3: Verify orchestrator settings API**

Run: `curl http://localhost:3500/api/orchestrator/settings`
Expected: JSON with default orchestrator config.

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "feat: complete orchestrator sub-agent system integration"
```
