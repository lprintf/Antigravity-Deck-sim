// === Conversation → Workspace Persistent Map ===
// Tracks which workspace each cascade conversation belongs to.
// The LS API does not reliably bind conversations to workspaces (workspaces field is often empty),
// so Deck maintains its own mapping, persisted to disk.

const fs = require("fs");
const path = require("path");
const { DATA_DIR } = require("./config");

const MAP_PATH = path.join(DATA_DIR, "conv-ws-map.json");

// In-memory map: cascadeId → workspaceName
const convWsMap = new Map();

// --- Persistence ---

let saveTimer = null;

function loadFromDisk() {
    try {
        if (fs.existsSync(MAP_PATH)) {
            const data = JSON.parse(fs.readFileSync(MAP_PATH, "utf-8"));
            if (data && typeof data === "object") {
                for (const [k, v] of Object.entries(data)) {
                    convWsMap.set(k, v);
                }
            }
            console.log(`[ConvMap] Loaded ${convWsMap.size} bindings from disk`);
        }
    } catch (e) {
        console.warn(`[ConvMap] Failed to load: ${e.message}`);
    }
}

function saveToDisk() {
    // Debounced: coalesce rapid writes
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
        saveTimer = null;
        try {
            const obj = Object.fromEntries(convWsMap);
            fs.writeFileSync(MAP_PATH, JSON.stringify(obj, null, 2), "utf-8");
        } catch (e) {
            console.warn(`[ConvMap] Failed to save: ${e.message}`);
        }
    }, 100);
}

// --- Public API ---

/**
 * Bind a conversation to a workspace.
 * @param {string} cascadeId
 * @param {string} workspaceName
 */
function bind(cascadeId, workspaceName) {
    if (!cascadeId || !workspaceName) return;
    const existing = convWsMap.get(cascadeId);
    if (existing === workspaceName) return; // no-op
    convWsMap.set(cascadeId, workspaceName);
    saveToDisk();
}

/**
 * Get the workspace name for a conversation.
 * @param {string} cascadeId
 * @returns {string|null}
 */
function getWorkspace(cascadeId) {
    return convWsMap.get(cascadeId) || null;
}

/**
 * Remove binding for a conversation (e.g. on delete).
 * @param {string} cascadeId
 */
function unbind(cascadeId) {
    if (convWsMap.delete(cascadeId)) {
        saveToDisk();
    }
}

/**
 * Get all bindings as a plain object.
 * @returns {Object<string, string>}
 */
function getAll() {
    return Object.fromEntries(convWsMap);
}

// Load on module init
loadFromDisk();

module.exports = { bind, getWorkspace, unbind, getAll };
