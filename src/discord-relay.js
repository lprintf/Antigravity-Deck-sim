// === Discord Relay ===
// Real WebSocket via discord.js.
//
// Two event streams:
//   interactionCreate → slash commands (/help, /listws, /setws)
//   messageCreate     → @mention messages → relay to Antigravity cascade

const { Client, GatewayIntentBits, Partials, REST, Routes, SlashCommandBuilder, AttachmentBuilder } = require('discord.js');

let client = null;
let channelId = null;
let botUserId = null;
let onReplyCallback = null;
let onCommandCallback = null;   // async (commandName, options, deferReplyFn) → void
let onEventCallback = null;
let isReady = false;

// ── Format helpers ──────────────────────────────────────────────────────────

function formatNotifyUser({ workspaceName, cascadeIdShort, stepCount, softLimit, content, mentionUserId, mentionUserName }) {
    const lines = [];
    if (mentionUserId) lines.push(`<@${mentionUserId}>`);
    lines.push(
        `🤖 **[ANTIGRAVITY AGENT]**`,
        `\`━━━━━━━━━━━━━━━━━━━━━━\``,
        `**Project:** ${workspaceName}`,
        `**Cascade:** #${cascadeIdShort} (step ${stepCount}/~${softLimit})`,
        `\`━━━━━━━━━━━━━━━━━━━━━━\``,
        ``,
        content,
    );
    return lines.join('\n');
}

function formatCascadeSwitch({ oldShort, newShort, stepCount }) {
    return [
        `🔄 **[CASCADE SWITCHED]**`,
        `\`━━━━━━━━━━━━━━━━━━━━━━\``,
        `**Old:** #${oldShort} → ${stepCount} steps`,
        `**New:** #${newShort} → fresh start`,
        `\`━━━━━━━━━━━━━━━━━━━━━━\``,
        ``,
        `Please re-inject your plan context into the new cascade.`,
    ].join('\n');
}

function formatBridgeStatus(msg) {
    return `ℹ️ **[BRIDGE]** ${msg}`;
}

// ── Parse Pi's reply (for @mention messages) ────────────────────────────────

function parsePiReply(text) {
    if (!text) return null;
    const actionMatch = text.match(/\[ACTION:\s*(accept|reject|none)\]/i);
    const action = actionMatch ? actionMatch[1].toLowerCase() : null;
    let reply = text
        .replace(/^\[REPLY\]\s*/i, '')
        .replace(/\[ACTION:\s*(?:accept|reject|none)\]\s*/gi, '')
        .trim();
    if (!reply) return null;
    return { reply, action: action === 'none' ? null : action };
}


// ── Auto-register slash commands ──────────────────────────────────────────────
// Called once on bot ready. Idempotent — safe to run on every server start.

async function autoRegisterCommands(token, guildId) {
    const CLIENT_ID = Buffer.from(token.split('.')[0], 'base64').toString('ascii');
    const commands = [
        new SlashCommandBuilder().setName('help').setDescription('Show Agent Bridge commands and current status'),
        new SlashCommandBuilder().setName('listws').setDescription('List running workspaces and available folders'),
        new SlashCommandBuilder().setName('setws').setDescription('Switch to a workspace (opens if needed)').addStringOption(o => o.setName('name').setDescription('Workspace folder name').setRequired(true)),
        new SlashCommandBuilder().setName('createws').setDescription('Create a new workspace and open in Antigravity').addStringOption(o => o.setName('name').setDescription('New workspace name').setRequired(true)),
    ].map(c => c.toJSON());

    try {
        const rest = new REST({ version: '10' }).setToken(token);
        if (guildId) {
            await rest.put(Routes.applicationGuildCommands(CLIENT_ID, guildId), { body: commands });
        } else {
            await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
        }
        console.log(`[Discord] ✓ Slash commands registered (${commands.length})`);
    } catch (e) {
        console.warn(`[Discord] Slash command registration failed: ${e.message}`);
    }
}

// ── Bot lifecycle ─────────────────────────────────────────────────────────

async function init(token, targetChannelId, guildId, eventHook = null) {
    if (client) await stop();
    channelId = String(targetChannelId);
    onEventCallback = eventHook;

    client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent,
            GatewayIntentBits.DirectMessages,
        ],
        partials: [Partials.Channel],
    });

    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Discord login timeout (30s)')), 30000);

        client.once('ready', async () => {
            clearTimeout(timeout);
            botUserId = client.user.id;
            isReady = true;
            console.log(`[Discord] Bot: ${client.user.tag}, channel: ${channelId}`);
            if (onEventCallback) onEventCallback('ready', { tag: client.user.tag, channelId });
            // Auto-register slash commands on every start
            autoRegisterCommands(token, guildId).catch(() => { });
            resolve();
        });

        client.on('error', e => {
            console.error('[Discord] Client error:', e.message);
            if (onEventCallback) onEventCallback('error', { message: e.message });
        });

        client.login(token).catch(e => {
            clearTimeout(timeout);
            reject(e);
        });
    });
}

function startListening(replyCallback, commandCallback = null) {
    if (!client || !isReady) throw new Error('Discord client not ready');
    onReplyCallback = replyCallback;
    onCommandCallback = commandCallback;

    // ── Slash command interactions ──────────────────────────────────────────
    client.on('interactionCreate', async (interaction) => {
        if (!interaction.isChatInputCommand()) return;

        const { commandName, options, user } = interaction;
        console.log(`[Discord] Slash: /${commandName} from @${user.username}`);
        if (onEventCallback) onEventCallback('command', { command: commandName, from: user.username });

        if (!onCommandCallback) {
            await interaction.reply({ content: '❌ Bridge not handling commands.', ephemeral: true });
            return;
        }

        // Defer reply so we have time to process
        await interaction.deferReply();

        // Build a replyFn that edits the deferred reply
        const replyFn = async (content) => {
            try {
                await interaction.editReply(content);
            } catch (e) {
                console.warn('[Discord] editReply failed:', e.message);
            }
        };

        // Collect slash command options into simple args array + named map
        const args = [];
        const namedOpts = {};
        if (options?.data) {
            for (const opt of options.data) {
                args.push(String(opt.value));
                namedOpts[opt.name] = opt.value;
            }
        }

        await onCommandCallback(commandName, args, replyFn, namedOpts);
    });

    // ── @mention messages → relay to cascade ───────────────────────────────
    client.on('messageCreate', async (message) => {
        // Always ignore own messages (prevent loops)
        if (message.author.id === botUserId) return;
        // For other bots: check whitelist from settings
        if (message.author.bot) {
            const { getSettings } = require('./config');
            const allowed = getSettings().agentBridge?.allowedBotIds || [];
            if (!allowed.includes(message.author.id)) return;
        }

        const msgChannelId = message.channelId;
        const from = message.author.username;
        const text = message.content;
        const isDM = message.guild === null;

        // Only configured channel or DMs
        if (!isDM && msgChannelId !== channelId) return;

        console.log(`[Discord] Message from @${from}: "${text.substring(0, 60)}"`);
        if (onEventCallback) onEventCallback('update', { channel: msgChannelId, from, text: text.substring(0, 60) });

        // Guild: require @mention
        if (!isDM && !message.mentions.users.has(botUserId)) {
            return;
        }

        const cleanText = text.replace(/<@!?[0-9]+>/g, '').trim();
        if (!cleanText) return;

        console.log(`[Discord] ✓ Relay from @${from}: "${cleanText.substring(0, 60)}"`);

        const parsed = parsePiReply(cleanText);
        if (parsed && onReplyCallback) {
            parsed.authorId = message.author.id;
            parsed.authorName = message.member?.displayName || message.author.displayName || message.author.username;
            if (onEventCallback) onEventCallback('reply', { action: parsed.action });
            await onReplyCallback(parsed);
        } else {
            if (onEventCallback) onEventCallback('ignored', { reason: 'empty', text: cleanText });
        }
    });

    console.log('[Discord] Listening (slash commands + @mentions)...');
    if (onEventCallback) onEventCallback('listening', { channelId });
}

async function sendTyping() {
    if (!client || !isReady) return;
    try {
        const channel = await client.channels.fetch(channelId);
        if (channel) await channel.sendTyping();
    } catch { }
}

async function sendMessage(text) {
    if (!client || !isReady) throw new Error('Discord client not ready');
    const channel = await client.channels.fetch(channelId);
    if (!channel) throw new Error(`Channel ${channelId} not found`);

    if (text.length <= 2000) {
        await channel.send(text);
    } else {
        const chunks = text.match(/.{1,1990}/gs) || [text];
        for (const chunk of chunks) await channel.send(chunk);
    }
}

// Send agent response — long content (>1800 chars) attached as .md file
async function sendResponse(params) {
    if (!client || !isReady) throw new Error('Discord client not ready');
    const channel = await client.channels.fetch(channelId);
    if (!channel) throw new Error(`Channel ${channelId} not found`);

    const { content } = params;

    if (content.length > 1800) {
        // Long message → attach as file
        const header = formatNotifyUser({
            ...params,
            content: '📄 Message too long, see attached file.',
        });
        const attachment = new AttachmentBuilder(
            Buffer.from(content, 'utf-8'),
            { name: 'response.md' }
        );
        await channel.send({ content: header, files: [attachment] });
    } else {
        // Short message → inline
        const text = formatNotifyUser(params);
        await channel.send(text);
    }
}

async function stop() {
    onReplyCallback = null;
    onCommandCallback = null;
    isReady = false;
    if (client) {
        client.removeAllListeners();
        await client.destroy().catch(() => { });
        client = null;
    }
    console.log('[Discord] Client stopped');
}

module.exports = {
    init, stop,
    sendMessage, sendTyping, sendResponse,
    startListening,
    formatNotifyUser, formatCascadeSwitch, formatBridgeStatus,
    parsePiReply,
};
