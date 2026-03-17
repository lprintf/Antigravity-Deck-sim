# Agent Hub Frontend Design

**Date:** 2026-03-17
**Status:** Draft
**Scope:** Replace the Discord-only Agent Bridge View with a unified Agent Hub that supports all transport types (Discord, WebSocket, HTTP) and includes a built-in agent chat client.

---

## Problem

The current `AgentBridgeView` only surfaces Discord bot interactions. The backend now supports three transport types (Discord, WebSocket, HTTP REST) via the refactored `AgentSession` + `SessionManager` architecture, but the frontend has no way to:

1. View sessions from non-Discord transports
2. Send messages as an agent directly from the dashboard
3. Configure the Agent API settings
4. See unified logs across all transports

## Solution

Replace `AgentBridgeView` with **Agent Hub** — a tabbed view that unifies agent session management, provides a built-in chat client, exposes configuration, and streams logs from all transports.

**Approach:** WebSocket-first real-time. The UI connects to the existing UI WebSocket (`/ws`) for session updates and logs, and opens a dedicated Agent WebSocket (`/ws/agent`) for the chat panel — acting as a real agent client that dogfoods the protocol.

---

## Architecture

### Component Tree

```
AgentHubView (replaces AgentBridgeView)
├── Tabs (shadcn Tabs)
│   ├── "Sessions"  → AgentSessionsPanel
│   │   ├── SessionCard[]
│   │   └── EmptyState
│   ├── "Chat"      → AgentChatPanel
│   │   ├── WorkspaceSelector
│   │   ├── ConnectButton
│   │   ├── MessageList
│   │   ├── ChatInput
│   │   └── SessionControls
│   ├── "Config"    → AgentConfigPanel
│   │   ├── Enable/Disable toggle
│   │   ├── Max sessions input
│   │   ├── Timeout input
│   │   └── Step limit input
│   └── "Logs"      → AgentLogsPanel
│       ├── Transport filter
│       ├── Level filter
│       └── LogEntries (auto-scroll)
```

### Data Flow

```
Backend                              Frontend
───────                              ────────
SessionManager ──_broadcast──→ UI WS (/ws) ──→ useWebSocket hook
  type: 'agent_sessions'                       ↓
  event: 'session_created'               AgentHubView
       | 'session_destroyed'             ├── Sessions panel (reads session list)
       | 'session_log'                   ├── Logs panel (reads log events)
                                         └── Chat panel ──→ Agent WS (/ws/agent)
                                                            ↕ (connect/send/response)
                                                          AgentSession
```

**Existing broadcast format** (already implemented in `agent-session-manager.js`):
```json
{ "type": "agent_sessions", "event": "session_created", "sessionId": "...", ...status }
{ "type": "agent_sessions", "event": "session_destroyed", "sessionId": "..." }
```
New events to add: `session_status_change`, `session_log` — same `type: 'agent_sessions'` envelope.

**Two WebSocket connections when chat is active:**
1. **UI WS** (`/ws`) — existing connection, already broadcasts `agent_sessions` events; extend with log events
2. **Agent WS** (`/ws/agent`) — opened only when Chat tab is active; UI acts as a real agent client

### Files

**New (frontend):**
- `components/agent-hub-view.tsx` — main container with Tabs
- `components/agent-hub/sessions-panel.tsx` — active sessions list
- `components/agent-hub/chat-panel.tsx` — built-in agent chat
- `components/agent-hub/config-panel.tsx` — API settings
- `components/agent-hub/logs-panel.tsx` — unified log stream
- `hooks/use-agent-ws.ts` — custom hook for Agent WS connection
- `lib/agent-api.ts` — TypeScript types + HTTP helpers for agent API

**Modified (frontend):**
- `app/page.tsx` — replace `showBridge`/`AgentBridgeView` with `showAgentHub`/`AgentHubView`
- `components/app-sidebar.tsx` — rename Bridge button to Agent Hub, update icon

**Modified (backend):**
- `src/agent-session-manager.js` — extend existing `_broadcast()` with `session_status_change` and `session_log` events
- `src/ws-agent.js` — accept optional `transport` field in `connect` message
- `src/routes/agent-api.js` — add `GET/PUT /api/agent-api/settings` endpoints

---

## Sessions Panel

### Session Card

Each card displays:
- **Session ID** — truncated UUID (e.g., `a3f2...c891`)
- **Transport badge** — color-coded by transport string from backend:
  - `discord` → purple
  - `websocket` → green (external agent WS connections)
  - `websocket-ui` → orange (dashboard Chat panel connections)
  - `http` → blue
- **Status indicator** — mapped from `AgentSession.state` (backend enum: `IDLE`, `ACTIVE`, `TRANSITIONING`):
  - `ACTIVE` + `isBusy=false` → green dot (Ready)
  - `ACTIVE` + `isBusy=true` → yellow dot (Busy)
  - `IDLE` → gray dot
  - `TRANSITIONING` → yellow dot (Transitioning)
  - Session in error (from error events) → red dot
- **Workspace name** + cascade ID (shown when session has an active cascade)
- **Step count** vs soft limit (e.g., `42 / 500`)
- **Last activity** — relative timestamp
- **Destroy action** — trash icon → confirmation dialog ("Destroy session {id}? This will terminate the agent connection.") → calls `DELETE /api/agent/:sessionId`

### Real-time Updates

- Backend broadcasts `{ type: 'agent_sessions', event: 'session_created'|'session_destroyed'|'session_status_change' }` via UI WS
- Frontend listens for `type: 'agent_sessions'` and dispatches by `event` field to update the session list
- Fallback: HTTP poll `GET /api/agent/sessions` on WS reconnect

### Empty State

- Text: "No active agent sessions"
- Subtitle: "Connect from the Chat tab or from an external agent via WebSocket/HTTP API"

---

## Chat Panel

### UX Flow

**State 1 — Not connected:**
- Workspace dropdown selector (populated from existing workspace list)
- Connect button
- Help text: "Select a workspace and connect to start"

**State 2 — Connected, ready:**
- Session info bar (session ID, status dot, workspace name)
- Message list area (scrollable)
- Text input + send button
- Session controls: Accept, Reject, New Cascade, Disconnect

**State 3 — Waiting for response:**
- Input disabled
- Processing indicator on latest agent message bubble
- Status dot changes to yellow (BUSY)

### Message Rendering

- **User messages:** right-aligned bubble, muted background
- **Agent responses:** left-aligned bubble, rendered as markdown via `react-markdown` (already a project dependency)
- **System events:** centered inline text, small font (cascade transitions, errors, warnings)

### Session Controls

Below the input area:
- **Accept** — accept code diff (sends WS `accept` message)
- **Reject** — reject code diff (sends WS `reject` message)
- **New Cascade** ↺ — sends WS `switch_workspace` message with the current workspace name (backend creates a new cascade as side-effect). Note: there is no dedicated `new_cascade` WS message type; workspace switch achieves the same result.
- **Disconnect** — close session with confirmation dialog

### Hook: `useAgentWs`

```typescript
interface UseAgentWs {
  connected: boolean;
  sessionId: string | null;
  cascadeId: string | null;
  messages: AgentMessage[];
  isBusy: boolean;
  error: string | null;
  connect: (workspace: string) => Promise<void>;
  send: (text: string) => Promise<void>;
  accept: () => void;
  reject: () => void;
  newCascade: () => void;   // sends switch_workspace with current workspace
  disconnect: () => void;
}

interface AgentMessage {
  id: string;
  role: 'user' | 'agent' | 'system';
  content: string;
  timestamp: number;
  // For agent responses, extra metadata:
  stepIndex?: number;
  stepCount?: number;
  stepType?: string;
}
```

**Response event mapping:** The backend `AgentSession` emits `response` events with shape:
```json
{ "text": "...", "stepIndex": 42, "stepCount": 43, "stepType": "NOTIFY_USER" }
```
The hook maps this to an `AgentMessage` with `role: 'agent'`, `content: text`, and metadata fields.

**Transport identification:** The Chat panel's `connect` message includes `transport: 'websocket-ui'` so the backend can distinguish dashboard sessions from external agent WS connections in the Sessions and Logs panels.

**Connection lifecycle:**
1. Opens WebSocket to `/ws/agent?auth_key=...`
2. Sends `{ type: 'connect', workspace: '...', transport: 'websocket-ui' }` message
3. Receives `{ type: 'connected', sessionId, cascadeId, workspace }` confirmation
4. Sends `{ type: 'send', message: '...' }` messages (note: field is `message`, not `text`), receives `{ type: 'response', text, stepIndex, stepCount, stepType }` events
5. Also receives: `{ type: 'cascade_transition', oldId, newId, reason, ... }`, `{ type: 'status_change', state: 'ACTIVE'|'IDLE'|'TRANSITIONING' }`, `{ type: 'error', message }`, `{ type: 'busy', isBusy: boolean }` (note: type is `busy` not `busy_change`), `{ type: 'step_limit_warning', stepCount, softLimit }`
6. Cleans up on disconnect or component unmount

**Reconnection behavior:** The backend destroys the session on WS close (`ws-agent.js` line 157-160), so reconnection means creating a new session. Message history from the previous session is preserved in the local `messages` array (UI state), but the backend session and cascade are new. Backoff intervals: 1s, 2s, 4s. After 3 failed retries, show permanent error state with manual "Reconnect" button.

---

## Config Panel

Matches the existing `SettingsView` visual style.

| Field | UI Element | Default | Validation |
|-------|-----------|---------|------------|
| Enable Agent API | Switch toggle | ON | — |
| Max Concurrent Sessions | Number input | 5 | min: 1, max: 20 |
| Session Timeout | Number input (minutes) | 30 | min: 1, max: 1440 |
| Step Soft Limit | Number input | 500 | min: 10, max: 10000 |

- Loads current values from `GET /api/agent-api/settings` on mount
- Save button calls `PUT /api/agent-api/settings`
- Toast notification on save success/failure
- Changes take effect immediately (session manager reconfigured on save)
- Settings are persisted to `agent-api.settings.json` on disk (existing `config.js` mechanism) and survive server restarts

### Settings API Schema

**GET /api/agent-api/settings** response:
```json
{
  "enabled": true,
  "maxConcurrentSessions": 5,
  "sessionTimeoutMs": 1800000,
  "defaultStepSoftLimit": 500
}
```

**PUT /api/agent-api/settings** request body (partial updates OK):
```json
{
  "enabled": true,
  "maxConcurrentSessions": 5,
  "sessionTimeoutMs": 1800000,
  "defaultStepSoftLimit": 500
}
```

**Unit conversion:** The UI shows timeout in minutes. The frontend converts: `minutes * 60 * 1000` before sending to backend, and `ms / 60000` when displaying. The backend always stores and returns milliseconds.

---

## Logs Panel

### Log Entry Format

```
[HH:MM:SS] [Transport] [SessionID] Message
```

Examples:
```
[14:32:05] [WS]      [a3f2] Connected — workspace: MyProject
[14:32:08] [WS]      [a3f2] → "Fix the auth bug in login.ts"
[14:32:15] [WS]      [a3f2] ← Response (1,247 chars, 3 steps)
[14:33:01] [Discord]  [bridge] → "Deploy the new feature"
[14:33:02] [HTTP]    [b7e1] Session created
```

### Filters

- **Transport:** All | Discord | WebSocket | HTTP | UI
- **Level:** All | Info | Warn | Error

### Behavior

- Receives `{ type: 'agent_sessions', event: 'session_log', ... }` events via UI WS (new — backend must add log broadcasting to `_broadcast`)
- Max 500 entries in buffer (FIFO — oldest dropped)
- Auto-scroll to bottom by default
- "Scroll to bottom" button appears when user scrolls up
- Clear button to reset log buffer
- Color-coded: transport badge color + red for errors, yellow for warnings

---

## Backend Changes

### 1. SessionManager — extend existing broadcast

`src/agent-session-manager.js` already has `_broadcast()` that sends `{ type: 'agent_sessions', event: '...', ...data }` via `ws.broadcastAll()`. Currently only broadcasts `session_created` and `session_destroyed`.

**Add these broadcasts:**
- `session_status_change` — `{ sessionId, oldState, newState, isBusy }` (wire to `AgentSession` `status_change` + `busy_change` events)
- `session_log` — `{ sessionId, transport, level, message, timestamp }` (wire to `AgentSession` `log` event, plus log connect/disconnect/send/response at the manager level)

All use the existing `_broadcast()` function — no new EventEmitter needed.

### 2. UI WS Broadcast

Already works via `_broadcast()` → `ws.broadcastAll()`. No changes needed for `session_created`/`session_destroyed`. The new `session_status_change` and `session_log` events automatically broadcast through the same path.

Frontend listens for `type: 'agent_sessions'` messages and dispatches by `event` field.

### 3. Settings Endpoints

`src/routes/agent-api.js` adds two endpoints using existing `config.js` persistence (`getAgentApiSettings`/`saveAgentApiSettings` already exist):

- `GET /api/agent-api/settings` — returns `getAgentApiSettings()` as JSON
- `PUT /api/agent-api/settings` — validates body with Zod, calls `saveAgentApiSettings(body)`, then `sessionManager.configure(...)` to apply immediately

### 4. ws-agent.js — support `transport` field in connect

Accept optional `transport` field in the `connect` message (default: `'websocket'`). The Chat panel sends `transport: 'websocket-ui'` to distinguish itself from external agents.

### 5. Consolidate `_resolveLsInst` helper

Currently duplicated across `ws-agent.js`, `agent-api.js`, and `agent-session-manager.js`. Extract to a shared utility in `src/ls-utils.js` or similar.

---

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Agent WS disconnect mid-chat | Reconnect banner, auto-retry 3x (1s, 2s, 4s backoff). Backend destroys session on close, so reconnect creates new session. Local message history preserved in UI state. After 3 failures: permanent error with manual "Reconnect" button. |
| Session destroyed externally | Chat panel notification, input disabled, "Session ended" message |
| Max sessions reached | Connect button disabled, tooltip explains limit |
| Backend offline | Sessions panel shows "Backend not responding", retry indicator |
| Send fails (busy) | Toast error: "Agent is busy processing a previous message" |
| Auth key missing/invalid | Redirect to connection status, show auth error |

---

## Testing Strategy

- **Unit:** Hook `useAgentWs` — mock WebSocket, verify state transitions
- **Integration:** Agent Hub tabs render correctly with mock data
- **E2E:** Connect from Chat tab → send message → verify response appears (requires running Antigravity IDE)
- **Visual:** Verify dark theme consistency, responsive behavior on mobile
