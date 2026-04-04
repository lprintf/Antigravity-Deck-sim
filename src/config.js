// === Shared State & Constants ===
const os = require('os');
const fs = require('fs');
const path = require('path');

// Runtime data directory — allows code to be mounted read-only
// while runtime state (settings, logs) goes to a writable location.
const DATA_DIR = process.env.DECK_DATA_DIR || path.join(__dirname, '..');
if (DATA_DIR !== path.join(__dirname, '..')) {
    // Ensure the data directory exists
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

const lsConfig = { port: null, csrfToken: null, detected: false, useTls: false };
const lsInstances = []; // All detected LS instances: { pid, csrfToken, workspaceId, port, useTls, active }
const platform = os.platform(); // 'darwin', 'win32', 'linux'

let portOverride = null;
const portIdx = process.argv.indexOf('--port');
if (portIdx > -1 && process.argv[portIdx + 1]) {
    portOverride = parseInt(process.argv[portIdx + 1], 10);
}

const PORT = portOverride || parseInt(process.env.PORT, 10) || 3500;
const POLL_INTERVAL = 3000;
const FAST_POLL_INTERVAL = 1000;  // Active cascade (running / waiting for user)
const SLOW_POLL_INTERVAL = 5000;  // Idle
const BATCH_SIZE = 200;
const STEP_WINDOW_SIZE = 500;       // max steps to hold in memory per conversation
const STEP_LOAD_CHUNK = 200;        // how many older steps to load on scroll-up

// --- Persistent settings ---
const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');
const DEFAULT_SETTINGS = {
    defaultWorkspaceRoot: '',
    defaultModel: 'MODEL_PLACEHOLDER_M26', // Claude Opus 4.6 (Thinking)
    activeProfile: null,   // string | null — currently active profile name for profile swap
    profilesDir: null,     // string | null — custom profiles directory (default: %APPDATA%/AntigravityDeck/profiles)
    lsBinaryPath: '',
};

let _settings = null;

function loadSettings() {
    if (_settings) return _settings;
    try {
        if (fs.existsSync(SETTINGS_PATH)) {
            _settings = { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8')) };
        } else {
            // Auto-create from sample if available, otherwise use defaults
            const samplePath = path.join(__dirname, '..', 'settings.sample.json');
            if (fs.existsSync(samplePath)) {
                fs.copyFileSync(samplePath, SETTINGS_PATH);
            }
            _settings = { ...DEFAULT_SETTINGS };
            saveSettings(_settings);
        }
    } catch {
        _settings = { ...DEFAULT_SETTINGS };
    }

    // If defaultWorkspaceRoot is empty, do NOT auto-populate it anymore.
    // The frontend will receive empty string and launch the onboarding modal.
    _settings.suggestedWorkspaceRoot = path.join(os.homedir(), 'AntigravityWorkspace');

    // Allow environment variable override (useful for containerized deployments)
    if (process.env.DECK_WORKSPACE_ROOT) {
        _settings.defaultWorkspaceRoot = process.env.DECK_WORKSPACE_ROOT;
    }
    if (process.env.DECK_LS_BINARY_PATH) {
        _settings.lsBinaryPath = process.env.DECK_LS_BINARY_PATH;
    }

    return _settings;
}

function saveSettings(updates) {
    _settings = { ...loadSettings(), ...updates };
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(_settings, null, 2), 'utf-8');
    return _settings;
}

function getSettings() { return loadSettings(); }

// --- Bridge-specific settings (bridge.settings.json) ---
const BRIDGE_SETTINGS_PATH = path.join(DATA_DIR, 'bridge.settings.json');
const DEFAULT_BRIDGE_SETTINGS = {
    discordBotToken: '',
    discordChannelId: '',
    discordGuildId: '',
    stepSoftLimit: 500,
    allowedBotIds: [],
    autoStart: false,
    currentWorkspace: '',
    lastCascadeId: '',
    lastStepCount: 0,
    lastRelayedStepIndex: -1,
};

let _bridgeSettings = null;

function loadBridgeSettings() {
    if (_bridgeSettings) return _bridgeSettings;
    try {
        if (fs.existsSync(BRIDGE_SETTINGS_PATH)) {
            _bridgeSettings = { ...DEFAULT_BRIDGE_SETTINGS, ...JSON.parse(fs.readFileSync(BRIDGE_SETTINGS_PATH, 'utf-8')) };
        } else {
            _bridgeSettings = { ...DEFAULT_BRIDGE_SETTINGS };
        }
    } catch {
        _bridgeSettings = { ...DEFAULT_BRIDGE_SETTINGS };
    }
    return _bridgeSettings;
}

function saveBridgeSettings(updates) {
    _bridgeSettings = { ...loadBridgeSettings(), ...updates };
    fs.writeFileSync(BRIDGE_SETTINGS_PATH, JSON.stringify(_bridgeSettings, null, 2), 'utf-8');
    return _bridgeSettings;
}

function getBridgeSettings() { return loadBridgeSettings(); }

// --- Agent API settings (agent-api.settings.json) ---
const AGENT_API_SETTINGS_PATH = path.join(DATA_DIR, 'agent-api.settings.json');
const DEFAULT_AGENT_API_SETTINGS = {
    enabled: true,
    maxConcurrentSessions: 5,
    sessionTimeoutMs: 30 * 60 * 1000, // 30 minutes
    defaultStepSoftLimit: 500,
};

let _agentApiSettings = null;

function loadAgentApiSettings() {
    if (_agentApiSettings) return _agentApiSettings;
    try {
        if (fs.existsSync(AGENT_API_SETTINGS_PATH)) {
            _agentApiSettings = { ...DEFAULT_AGENT_API_SETTINGS, ...JSON.parse(fs.readFileSync(AGENT_API_SETTINGS_PATH, 'utf-8')) };
        } else {
            _agentApiSettings = { ...DEFAULT_AGENT_API_SETTINGS };
        }
    } catch {
        _agentApiSettings = { ...DEFAULT_AGENT_API_SETTINGS };
    }
    return _agentApiSettings;
}

function saveAgentApiSettings(updates) {
    _agentApiSettings = { ...loadAgentApiSettings(), ...updates };
    fs.writeFileSync(AGENT_API_SETTINGS_PATH, JSON.stringify(_agentApiSettings, null, 2), 'utf-8');
    return _agentApiSettings;
}

function getAgentApiSettings() { return loadAgentApiSettings(); }

// --- Orchestrator settings (orchestrator.settings.json) ---
const ORCHESTRATOR_SETTINGS_PATH = path.join(DATA_DIR, 'orchestrator.settings.json');
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

module.exports = {
    lsConfig, lsInstances, platform, PORT, DATA_DIR,
    POLL_INTERVAL, FAST_POLL_INTERVAL, SLOW_POLL_INTERVAL, BATCH_SIZE,
    STEP_WINDOW_SIZE, STEP_LOAD_CHUNK,
    getSettings, saveSettings,
    getBridgeSettings, saveBridgeSettings,
    getAgentApiSettings, saveAgentApiSettings,
    getOrchestratorSettings, saveOrchestratorSettings,
};
