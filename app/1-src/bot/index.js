require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { Client, GatewayIntentBits, Partials, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, Events, SlashCommandBuilder, Collection, MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder, StringSelectMenuOptionBuilder } = require('discord.js');
const cron = require('node-cron');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMembers
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

const MAX_USERS = 5;

// ===== DATEIPFADE FÜR DATA-ORDNER =====
const DATA_DIR = path.join(__dirname, '..', '..', '2-data');
const ROLES_JSON = path.join(DATA_DIR, 'roles.json');
const WARNINGS_JSON = path.join(DATA_DIR, 'warnings.json');
const ABWESENHEITEN_JSON = path.join(DATA_DIR, 'abwesenheiten.json');
const MVP_VOTES_JSON = path.join(DATA_DIR, 'mvp_votes.json');
const PREMIER_BACKUP_JSON = path.join(DATA_DIR, 'premier_backup.json');

// ===== BEWERBUNGSSYSTEM KONFIGURATION =====
const BEWERBUNGS_KATEGORIE_ID = '1399136926358962266'; // Kategorie-ID für Bewerbungs-Tickets


const BEWERBUNGS_CHANNELS = {
    'sun': '1444897966392344576', // Sun Bewerbungs-Channel
    'rising': '1444897916488650813', // Rising Bewerbungs-Channel
    'moon': '1444897966392344576', // Moon Bewerbungs-Channel
    'main': '1444897726000267527' // Main Bewerbungs-Channel
};

// Tryout-Rollen für die Teams
const TRYOUT_ROLLEN = {
    'sun': '1402222294612316310', // Tryout Sun
    'rising': '1436387072158994473', // Tryout Rising
    'moon': '1439717436508082197', // Tryout Moon
    'main': '1399133902341148742' // Tryout Main
};

// Custom Nachrichten für Bewerbungs-Annahme/Ablehnung (gespeichert pro Team)
let customBewerbungsMessages = {
    'sun': { accept: null, reject: null },
    'rising': { accept: null, reject: null },
    'moon': { accept: null, reject: null },
    'main': { accept: null, reject: null }
};

// Hilfsfunktion: Prüft ob ein User Admin-Berechtigungen hat (Discord-Admin)
async function hasAdminPermissions(member) {
    return member.permissions.has('Administrator');
}

// Hilfsfunktion: Holt Display-Namen (Server-Nickname) mit Fallback auf Username
async function getDisplayName(userId, guildId = null) {
    // Prüfe Cache
    if (displayNameCache[userId]) {
        return displayNameCache[userId];
    }
    
    try {
        // Versuche Guild Member zu holen (für Server-Nickname)
        if (guildId) {
            try {
                const guild = await client.guilds.fetch(guildId);
                const member = await guild.members.fetch(userId);
                const displayName = member.displayName || member.user.username;
                displayNameCache[userId] = displayName;
                return displayName;
            } catch (guildError) {
                // Fallback: Guild nicht gefunden oder Member nicht in Guild
            }
        }
        
        // Fallback: Suche in allen Guilds des Bots
        for (const guild of client.guilds.cache.values()) {
            try {
                const member = await guild.members.fetch(userId);
                const displayName = member.displayName || member.user.username;
                displayNameCache[userId] = displayName;
                return displayName;
            } catch {
                continue;
            }
        }
        
        // Letzter Fallback: Username vom User-Objekt
        const user = await client.users.fetch(userId);
        const username = user.username;
        displayNameCache[userId] = username;
        return username;
        
    } catch (error) {
        console.error(`Fehler beim Holen des Display-Namens für User ${userId}:`, error);
        return 'Unbekannt';
    }
}

// Hilfsfunktion: Prüft ob ein User die erforderliche Rolle für Reminder hat
async function hasReminderRole(userId) {
    // Reminder-DMs werden an ALLE Benutzer gesendet, die sich eingetragen haben
    // Keine Rollenprüfung für Reminder - jeder bekommt Erinnerungen
    return true;
}

// Hilfsfunktion: Findet einen Benutzer basierend auf Username, Displayname oder @mention
async function findUserByInput(guild, input) {
    // Entferne @ falls vorhanden
    const cleanInput = input.replace(/[<@!>]/g, '');
    
    // Versuche zuerst User-ID
    if (/^\d+$/.test(cleanInput)) {
        try {
            return await guild.members.fetch(cleanInput);
        } catch (error) {
            // User-ID nicht gefunden, weiter mit anderen Methoden
        }
    }
    
    // Definiere die bevorzugten Rollen
    const preferredRoleIds = ['1398810174873010289', '1399133902341148742'];
    
    // Suche zuerst nach Benutzern mit den bevorzugten Rollen
    const preferredMember = guild.members.cache.find(m => {
        const hasPreferredRole = preferredRoleIds.some(roleId => m.roles.cache.has(roleId));
        if (!hasPreferredRole) return false;
        
        return m.user.username.toLowerCase() === input.toLowerCase() ||
               m.displayName.toLowerCase() === input.toLowerCase() ||
               m.user.username.toLowerCase().includes(input.toLowerCase()) ||
               m.displayName.toLowerCase().includes(input.toLowerCase());
    });
    
    if (preferredMember) {
        return preferredMember;
    }
    
    // Falls kein bevorzugter Benutzer gefunden, suche allgemein
    const member = guild.members.cache.find(m => 
        m.user.username.toLowerCase() === input.toLowerCase() ||
        m.displayName.toLowerCase() === input.toLowerCase() ||
        m.user.username.toLowerCase().includes(input.toLowerCase()) ||
        m.displayName.toLowerCase().includes(input.toLowerCase())
    );
    
    return member || null;
}

// Hilfsfunktion: Holt alle Benutzer mit spezifischen Rollen (auch offline)
async function getUsersWithRoles(guild, roleIds) {
    try {
        console.log(`[DEBUG] getUsersWithRoles aufgerufen mit Rollen: ${roleIds.join(', ')}`);
        
        // Lade alle Mitglieder (aber nur einmal)
        await guild.members.fetch();
        
        // Sammle alle Mitglieder mit den spezifischen Rollen
        const eligibleMembers = [];
        const seenIds = new Set();
        
        for (const roleId of roleIds) {
            try {
                const role = guild.roles.cache.get(roleId);
                if (role) {
                    console.log(`[DEBUG] Prüfe Rolle: ${role.name} (${roleId})`);
                    
                    // role.members ist bereits eine Collection - kein fetch() nötig
                    for (const [memberId, member] of role.members) {
                        if (!member.user.bot && !seenIds.has(memberId)) {
                            eligibleMembers.push(member);
                            seenIds.add(memberId);
                            console.log(`[DEBUG] Benutzer mit Rolle gefunden: ${member.displayName || member.user.username} (${member.user.id})`);
                        }
                    }
                } else {
                    console.log(`[DEBUG] Rolle ${roleId} nicht gefunden`);
                }
            } catch (roleError) {
                console.error(`[DEBUG] Fehler beim Laden der Rolle ${roleId}:`, roleError);
            }
        }
        
        console.log(`[DEBUG] Gesamt gefundene Benutzer mit Rollen: ${eligibleMembers.length}`);
        
        // Sortiere nach Displayname
        const sortedMembers = eligibleMembers.sort((a, b) => {
            const nameA = (a.displayName || a.user.username).toLowerCase();
            const nameB = (b.displayName || b.user.username).toLowerCase();
            return nameA.localeCompare(nameB);
        });
        
        return sortedMembers;
    } catch (error) {
        console.error('Fehler beim Laden der Benutzer mit Rollen:', error);
        return [];
    }
}

// Hilfsfunktion: Lädt Rollenkonfiguration aus JSON
function loadRolesConfig() {
    try {
        return JSON.parse(require('fs').readFileSync(ROLES_JSON, 'utf8'));
    } catch (error) {
        console.error('Fehler beim Laden der Rollenkonfiguration:', error);
        // Fallback auf neue Konfiguration (minimal)
        return {
            admin_roles: {
                id: []
            },
            interaction_boards: []
        };
    }
}

// Hilfsfunktion: Gibt alle Rollen-IDs für einen spezifischen Befehl zurück
function getCommandRoleIds(commandName, permissionType = 'bot_commands') {
    try {
        const rolesConfig = loadRolesConfig();
        // Seit der neuen Struktur nutzen wir interaction_boards für Button-/Interaktions-Rollen
        const interactionBoards = rolesConfig.interaction_boards || [];
        const boardConfig = interactionBoards.find(b => b.type === commandName);

        if (!boardConfig) {
            return [];
        }

        // Unterstütze sowohl altes Feld role als auch neues roles-Array
        const roles = boardConfig.roles || (boardConfig.role ? [boardConfig.role] : []);
        const roleIds = roles
            .map(r => r && r.id)
            .filter(Boolean);

        return [...new Set(roleIds)];
    } catch (error) {
        console.error(`Fehler beim Laden der Rollen für Befehl ${commandName}:`, error);
        return []; // Fallback leer
    }
}

// Hilfsfunktion: Gibt alle verfügbaren Rollen-IDs zurück (für allgemeine Befehle)
function getAllAvailableRoleIds() {
    try {
        const rolesConfig = loadRolesConfig();
        const interactionBoards = rolesConfig.interaction_boards || [];

        const roleIds = new Set();
        for (const board of interactionBoards) {
            const roles = board.roles || (board.role ? [board.role] : []);
            for (const r of roles) {
                if (r && r.id) roleIds.add(r.id);
            }
        }

        return Array.from(roleIds);
    } catch (error) {
        console.error('Fehler beim Laden aller Rollen:', error);
        return []; // Fallback leer
    }
}

// Hilfsfunktion: Zentrale Rollenprüfung mit JSON-Konfiguration
async function hasRequiredRole(interaction, permissionType = 'bot_commands', commandName = null) {
    // Admin-Befehle: erlaubte Admin-Rollen
    if (permissionType === 'admin_commands') {
        const rolesConfig = loadRolesConfig();
        const adminRoleIds = Array.isArray(rolesConfig.admin_roles.id) 
            ? rolesConfig.admin_roles.id 
            : [rolesConfig.admin_roles.id];
        
        if (!interaction.guild) {
            return false;
        }
        
        let member = interaction.member;
        if (!member) {
            member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
        }
        
        if (member) {
            for (const adminRoleId of adminRoleIds) {
                if (member.roles.cache.has(adminRoleId)) {
                    return true;
                }
            }
        }
        
        return false;
    }
    
    try {
        if (!interaction.guild) {
            return false; // Bot funktioniert nur in Guilds
        }
        
        // Bestimme erlaubte Rollen basierend auf Befehl und Berechtigungstyp (nur neue Struktur)
        let allowedRoles;
        if (commandName) {
            allowedRoles = getCommandRoleIds(commandName);
        } else {
            allowedRoles = getAllAvailableRoleIds();
        }
        
        // Verwende cached member wenn möglich
        let member = interaction.member;
        if (!member) {
            member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
        }
        
        if (member) {
            // Prüfe ob User eine der erlaubten Rollen hat
            for (const roleId of allowedRoles) {
                if (member.roles.cache.has(roleId)) {
                    return true;
                }
            }
        }
        
        return false;
    } catch (error) {
        console.error(`Fehler beim Prüfen der Rollen für User ${interaction.user.id}:`, error);
        return false;
    }
}

// Hilfsfunktion: Extrahiert User-ID aus Input und validiert Berechtigung
async function parseAndValidateUser(guild, userInput) {
    // Extrahiere User-ID aus verschiedenen Formaten
    let userId = userInput.trim();
    
    // @mention Format: <@123456789> oder <@!123456789> -> 123456789
    if (userId.startsWith('<@') && userId.endsWith('>')) {
        userId = userId.slice(2, -1);
        if (userId.startsWith('!')) {
            userId = userId.slice(1); // Nickname mention: <@!123456789>
        }
    }
    
    // Hole Member
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) {
        return { success: false, error: 'Benutzer nicht gefunden.' };
    }
    
    // Prüfe Berechtigung mit allen verfügbaren Rollen
    const allowedRoles = getAllAvailableRoleIds();
    
    let hasRole = false;
    for (const roleId of allowedRoles) {
        if (member.roles.cache.has(roleId)) {
            hasRole = true;
            break;
        }
    }
    
    if (!hasRole) {
        return { 
            success: false, 
            error: `${member.displayName} hat nicht die erforderliche Berechtigung für diesen Bot.` 
        };
    }
    
    return { 
        success: true, 
        member: member,
        userId: member.user.id 
    };
}

// Funktion: Lade berechtigte Benutzer für Dropdown-Choices
async function getAuthorizedUserChoices() {
    // Lade alle verfügbaren Rollen
    const allowedRoles = getAllAvailableRoleIds();
    
    
    const choices = [];
    
    try {
        console.log(`📡 Guilds im Cache: ${client.guilds.cache.size}`);
        
        // Gehe durch alle Guilds
        for (const guild of client.guilds.cache.values()) {
            console.log(`\n🏰 Verarbeite Guild: ${guild.name} (ID: ${guild.id})`);
            
            try {
                // Lade alle Member (mit Limit für Performance)
                console.log('📥 Fetching Members...');
                await guild.members.fetch({ limit: 200 });
                console.log(`👥 Member im Cache: ${guild.members.cache.size}`);
                
                // Debug: Zeige alle Member mit ihren Rollen
                let totalMembers = 0;
                let nonBotMembers = 0;
                let membersWithRole = 0;
                
                for (const member of guild.members.cache.values()) {
                    totalMembers++;
                    if (!member.user.bot) {
                        nonBotMembers++;
                        let hasRole = false;
                        for (const roleId of allowedRoles) {
                            if (member.roles.cache.has(roleId)) {
                                hasRole = true;
                                break;
                            }
                        }
                        
                        if (hasRole) {
                            membersWithRole++;
                            console.log(`✅ ${member.displayName} (@${member.user.username}) - Role: ${hasRole}`);
                        }
                    }
                }
                
                console.log(`📊 Total: ${totalMembers}, Non-Bot: ${nonBotMembers}, Mit Rolle: ${membersWithRole}`);
                
                // Filtere berechtigte Member
                const authorizedMembers = guild.members.cache
                    .filter(member => {
                        if (member.user.bot) return false;
                        
                        // Prüfe ob User eine der erlaubten Rollen hat
                        for (const roleId of allowedRoles) {
                            if (member.roles.cache.has(roleId)) {
                                return true;
                            }
                        }
                        return false;
                    })
                    .map(member => ({
                        name: member.displayName.length > 80 ? 
                              member.displayName.substring(0, 77) + '...' : 
                              member.displayName,
                        value: member.user.id
                    }))
                    .slice(0, 25); // Discord erlaubt max 25 Choices
                
                choices.push(...authorizedMembers);
                console.log(`✅ Gefunden: ${authorizedMembers.length} berechtigte Benutzer in ${guild.name}`);
                
            } catch (error) {
                console.error(`❌ Fehler beim Laden der Member in Guild ${guild.name}:`, error);
            }
        }
        
        // Entferne Duplikate (falls User in mehreren Guilds)
        const uniqueChoices = choices.filter((choice, index, self) => 
            index === self.findIndex(c => c.value === choice.value)
        );
        
        console.log(`\n🎯 FINAL RESULT:`);
        console.log(`📝 Gesamt: ${uniqueChoices.length} eindeutige berechtigte Benutzer geladen`);
        
        if (uniqueChoices.length === 0) {
            console.log('⚠️  WARNUNG: Keine berechtigten Benutzer gefunden!');
            return [{ name: 'Keine berechtigten Benutzer gefunden', value: 'no_users' }];
        }
        
        uniqueChoices.forEach((choice, index) => {
            console.log(`${index + 1}. ${choice.name} (${choice.value})`);
        });
        
        return uniqueChoices.slice(0, 25); // Discord Limit
        
    } catch (error) {
        console.error('❌ Fehler beim Laden der berechtigten Benutzer:', error);
        return [{ name: 'Fehler beim Laden', value: 'error' }];
    }
}


// Hilfsfunktion: Rollengeschützte DM-Funktion
async function sendProtectedDM(userId, message, reason = 'DM') {
    try {
        // Prüfe ob User die erforderliche Rolle hat
        if (!(await hasReminderRole(userId))) {
            console.log(`❌ [${reason}] DM nicht gesendet an User ${userId} - Fehlende Rolle`);
            return false;
        }
        
        // Prüfe DM Opt-Out
        if (dmOptOut.has(userId)) {
            console.log(`❌ [${reason}] DM nicht gesendet an User ${userId} - DM Opt-Out`);
            return false;
        }
        
        // Prüfe Abwesenheit
        if (isUserAbwesendToday(userId)) {
            console.log(`❌ [${reason}] DM nicht gesendet an User ${userId} - Abwesend`);
            return false;
        }
        
        // Sende DM
        const user = await client.users.fetch(userId);
        await user.send(message);
        console.log(`✅ [${reason}] Protected DM gesendet an ${user.username} (${userId})`);
        return true;
        
    } catch (error) {
        console.error(`❌ [${reason}] Fehler beim Senden der Protected DM an User ${userId}:`, error.message || error);
        return false;
    }
}


// Dynamische Konfiguration für Premier, Practice und Scrim
let premierConfig = {
    main: {
        days: ['Donnerstag', 'Samstag', 'Sonntag'],
        times: ['19:00', '20:00', '19:00']
    },
    academy: {
        days: ['Donnerstag', 'Samstag', 'Sonntag'],
        times: ['19:00', '20:00', '19:00']
    }
};

let practiceConfig = {
    main: {
        days: ['Mittwoch', 'Freitag'],
        times: ['19:00', '19:00']
    },
    academy: {
        days: ['Mittwoch', 'Freitag'],
        times: ['19:00', '19:00']
    }
};

// Hilfsfunktionen für Team-spezifische Konfiguration
function getPremierConfig(team = 'main') {
    if (!premierConfig[team]) {
        console.warn(`Premier-Konfiguration für Team '${team}' nicht gefunden, verwende Main-Team`);
        return premierConfig.main;
    }
    return premierConfig[team];
}

function getPracticeConfig(team = 'main') {
    if (!practiceConfig[team]) {
        console.warn(`Practice-Konfiguration für Team '${team}' nicht gefunden, verwende Main-Team`);
        return practiceConfig.main;
    }
    return practiceConfig[team];
}

// Initialisiere Team-Konfigurationen falls sie fehlen
function initializeTeamConfigs() {
    // Stelle sicher, dass alle Team-Konfigurationen existieren
    if (!premierConfig.main) {
        premierConfig.main = { days: ['Donnerstag', 'Samstag', 'Sonntag'], times: ['19:00', '20:00', '19:00'] };
    }
    if (!premierConfig.academy) {
        premierConfig.academy = { days: ['Donnerstag', 'Samstag', 'Sonntag'], times: ['19:00', '20:00', '19:00'] };
    }
    
    if (!practiceConfig.main) {
        practiceConfig.main = { days: ['Mittwoch', 'Freitag'], times: ['19:00', '19:00'] };
    }
    if (!practiceConfig.academy) {
        practiceConfig.academy = { days: ['Mittwoch', 'Freitag'], times: ['19:00', '19:00'] };
    }
    
    if (!tournamentConfig.main) {
        tournamentConfig.main = {
            dates: ['28.09.2025', '29.09.2025', '30.09.2025', '03.10.2025', '04.10.2025', '05.10.2025', '06.10.2025'],
            times: ['19:00', '19:00', '19:00', '19:00', '19:00', '19:00', '19:00'],
            labels: ['Runde 1', 'Runde 2', 'Runde 3', 'Viertelfinale', 'Halbfinale 1', 'Halbfinale 2', 'Finale'],
            groups: [],
            currentPage: 0
        };
    }
    if (!tournamentConfig.academy) {
        tournamentConfig.academy = {
            dates: ['28.09.2025', '29.09.2025', '30.09.2025', '03.10.2025', '04.10.2025', '05.10.2025', '06.10.2025'],
            times: ['19:00', '19:00', '19:00', '19:00', '19:00', '19:00', '19:00'],
            labels: ['Runde 1', 'Runde 2', 'Runde 3', 'Viertelfinale', 'Halbfinale 1', 'Halbfinale 2', 'Finale'],
            groups: [],
            currentPage: 0
        };
    }
}

// Bereinige alte Channel-basierte Strukturen
function cleanupOldChannelBasedStructures() {
    console.log('Bereinige alte Channel-basierte Strukturen...');
    
    // Lösche alle Channel-basierten Einträge aus den Board-States
    const oldPremierBoards = { ...premierBoards };
    const oldPracticeBoards = { ...practiceBoards };
    const oldTournamentBoards = { ...tournamentBoards };
    
    // Lösche Channel-basierte Einträge (haben channelId als Key)
    for (const [key, value] of Object.entries(oldPremierBoards)) {
        if (key.length > 18) { // Discord Message IDs sind 18 Zeichen, Channel IDs sind 17-19 Zeichen
            // Das ist wahrscheinlich eine Channel-ID, lösche es
            delete premierBoards[key];
            console.log(`Alte Premier Channel-Struktur entfernt: ${key}`);
        }
    }
    
    for (const [key, value] of Object.entries(oldPracticeBoards)) {
        if (key.length > 18) {
            delete practiceBoards[key];
            console.log(`Alte Practice Channel-Struktur entfernt: ${key}`);
        }
    }
    
    for (const [key, value] of Object.entries(oldTournamentBoards)) {
        if (key.length > 18) {
            delete tournamentBoards[key];
            console.log(`Alte Tournament Channel-Struktur entfernt: ${key}`);
        }
    }
    
    console.log('Bereinigung der alten Channel-Strukturen abgeschlossen');
}

// Backward compatibility - Standard-Team ist 'main'
Object.defineProperty(premierConfig, 'days', {
    get: () => {
        if (!premierConfig.main || !Array.isArray(premierConfig.main.days)) {
            // Fallback auf Standardwerte wenn nicht verfügbar
            if (!premierConfig.main) {
                premierConfig.main = { days: ['Donnerstag', 'Samstag', 'Sonntag'], times: ['19:00', '20:00', '19:00'] };
            } else if (!Array.isArray(premierConfig.main.days)) {
                premierConfig.main.days = ['Donnerstag', 'Samstag', 'Sonntag'];
            }
        }
        return premierConfig.main.days;
    },
    set: (value) => { 
        if (!premierConfig.main) {
            premierConfig.main = { days: [], times: [] };
        }
        premierConfig.main.days = value; 
    }
});

Object.defineProperty(premierConfig, 'times', {
    get: () => premierConfig.main.times,
    set: (value) => { premierConfig.main.times = value; }
});

Object.defineProperty(practiceConfig, 'days', {
    get: () => {
        if (!practiceConfig.main || !Array.isArray(practiceConfig.main.days)) {
            // Fallback auf Standardwerte wenn nicht verfügbar
            if (!practiceConfig.main) {
                practiceConfig.main = { days: ['Mittwoch', 'Freitag'], times: ['19:00', '19:00'] };
            } else if (!Array.isArray(practiceConfig.main.days)) {
                practiceConfig.main.days = ['Mittwoch', 'Freitag'];
            }
        }
        return practiceConfig.main.days;
    },
    set: (value) => { 
        if (!practiceConfig.main) {
            practiceConfig.main = { days: [], times: [] };
        }
        practiceConfig.main.days = value; 
    }
});

Object.defineProperty(practiceConfig, 'times', {
    get: () => practiceConfig.main.times,
    set: (value) => { practiceConfig.main.times = value; }
});

let scrimConfig = {
    day: 'Montag',
    time: '19:00',
    maxGames: 3
};

let tournamentConfig = {
    main: {
        dates: ['28.09.2025', '29.09.2025', '30.09.2025', '03.10.2025', '04.10.2025', '05.10.2025', '06.10.2025'],
        times: ['19:00', '19:00', '19:00', '19:00', '19:00', '19:00', '19:00'],
        labels: ['Runde 1', 'Runde 2', 'Runde 3', 'Viertelfinale', 'Halbfinale 1', 'Halbfinale 2', 'Finale'],
        groups: [],  // Wird dynamisch basierend auf Anzahl Runden generiert
        currentPage: 0
    },
    academy: {
        dates: ['28.09.2025', '29.09.2025', '30.09.2025', '03.10.2025', '04.10.2025', '05.10.2025', '06.10.2025'],
        times: ['19:00', '19:00', '19:00', '19:00', '19:00', '19:00', '19:00'],
        labels: ['Runde 1', 'Runde 2', 'Runde 3', 'Viertelfinale', 'Halbfinale 1', 'Halbfinale 2', 'Finale'],
        groups: [],  // Wird dynamisch basierend auf Anzahl Runden generiert
        currentPage: 0
    }
};

// Hilfsfunktion für Tournament-Konfiguration
function getTournamentConfig(team = 'main') {
    if (!tournamentConfig[team]) {
        console.warn(`Tournament-Konfiguration für Team '${team}' nicht gefunden, verwende Main-Team`);
        return tournamentConfig.main;
    }
    return tournamentConfig[team];
}

// Backward compatibility
Object.defineProperty(tournamentConfig, 'dates', {
    get: () => tournamentConfig.main.dates,
    set: (value) => { tournamentConfig.main.dates = value; }
});

Object.defineProperty(tournamentConfig, 'times', {
    get: () => tournamentConfig.main.times,
    set: (value) => { tournamentConfig.main.times = value; }
});

Object.defineProperty(tournamentConfig, 'labels', {
    get: () => tournamentConfig.main.labels,
    set: (value) => { tournamentConfig.main.labels = value; }
});

Object.defineProperty(tournamentConfig, 'groups', {
    get: () => tournamentConfig.main.groups,
    set: (value) => { tournamentConfig.main.groups = value; }
});

Object.defineProperty(tournamentConfig, 'currentPage', {
    get: () => tournamentConfig.main.currentPage,
    set: (value) => { tournamentConfig.main.currentPage = value; }
});

// Funktion zur dynamischen Generierung der Tournament-Groups
function generateTournamentGroups(team = 'main') {
    const config = getTournamentConfig(team);
    const totalRounds = config.dates.length;
    
    if (totalRounds <= 6) {
        // Bis 6 Runden: 2 Seiten - erste 3 auf Seite 1, Rest auf Seite 2
        const firstPageCount = Math.min(3, totalRounds);
        const groups = [
            { name: 'Gruppenphase', indices: Array.from({length: firstPageCount}, (_, i) => i) }
        ];
        
        if (totalRounds > 3) {
            const remainingIndices = Array.from({length: totalRounds - 3}, (_, i) => i + 3);
            groups.push({ name: 'K.O.-Phase', indices: remainingIndices });
        }
        
        return groups;
    } else {
        // Ab 7+ Runden: 3 Seiten aufteilen
        const groups = [
            { name: 'Gruppenphase', indices: [0, 1, 2] },
            { name: 'Viertelfinale', indices: [3] },
            { name: 'Halbfinale & Finale', indices: Array.from({length: totalRounds - 4}, (_, i) => i + 4) }
        ];
        
        return groups;
    }
}

// Tournament-Groups initial generieren
tournamentConfig.groups = generateTournamentGroups();

// Dynamische Anmeldungen - werden dynamisch initialisiert
// Alle Signups sind jetzt per Message-ID organisiert (wie Scrim)
let premierSignups = {}; // { messageId: { Montag: [], Dienstag: [], ... } }
let practiceSignups = {}; // { messageId: { Montag: [], Dienstag: [], ... } }
let tournamentSignups = {}; // { messageId: { game1: [], game2: [], ... } }
let scrimSignups = {}; // { messageId: { game1: [], game2: [], ... } }
// Wochen-Scrim System: Stores weekly scrim data
// Structure: { messageId: { style: 'wochen_scrim'|'wochen_scrim_single', days: { Montag: { players: [], time: '19:00', timeChangeRequests: [] }, ... }, currentPage: 0 } }
let wochenScrimData = {};

// --- VEREINFACHTES MESSAGE-TRACKING ---
// Kein Custom-ID-System mehr - nutzt Discord Message IDs direkt

function getMessageByDiscordId(discordMessageId) {
    // Suche in allen Board-States nach der Discord Message ID (jetzt alle per Message-ID organisiert)
    
    // Premier Boards
    if (premierBoards[discordMessageId]) {
        return { 
            discordMessageId, 
            type: 'premier', 
            channelId: premierBoards[discordMessageId].channelId, 
            board: premierBoards[discordMessageId] 
        };
    }
    
    // Practice Boards
    if (practiceBoards[discordMessageId]) {
        return { 
            discordMessageId, 
            type: 'practice', 
            channelId: practiceBoards[discordMessageId].channelId, 
            board: practiceBoards[discordMessageId] 
        };
    }
    
    // Tournament Boards
    if (tournamentBoards[discordMessageId]) {
        return { 
            discordMessageId, 
            type: 'tournament', 
            channelId: tournamentBoards[discordMessageId].channelId, 
            board: tournamentBoards[discordMessageId] 
        };
    }
    
    // Scrim Boards
    if (scrimBoards[discordMessageId]) {
        return { 
            discordMessageId, 
            type: 'scrim', 
            channelId: scrimBoards[discordMessageId].channelId, 
            board: scrimBoards[discordMessageId] 
        };
    }
    
    return null;
}

// --- DM-Status-Objekte für State-Tracking ---
let practiceDMStatus = {};
let premierDMStatus = {};
let tournamentDMStatus = {};
let scrimDMStatus = { state: 'waiting', lastReminder: 0, lastFound: 0, lastCancel: 0, pendingFound: false, pendingCancel: false, foundTimeout: null, cancelTimeout: null };

// Board States - Alle sind jetzt per Message-ID organisiert (wie Scrim)
let premierBoards = {}; // { messageId: { channelId, day, time, maxGames, ... } }
let practiceBoards = {}; // { messageId: { channelId, day, time, ... } }
let tournamentBoards = {}; // { messageId: { channelId, page, ... } }
let scrimBoards = {}; // { messageId: { channelId, day, time, maxGames, ... } }
let boardState = {}; // { premier: {}, practice: {}, tournament: {}, scrim: {} }

// Username-Cache für schnelle Anzeige
const userCache = {};
const displayNameCache = {}; // Cache für Display-Namen

// Opt-out-Set für User, die keine DMs mehr wollen
const dmOptOut = new Set();

// Silent-Mode Set für User, die keine Ephemeral-Nachrichten sehen wollen
const silentMode = new Set();

// Hilfsfunktion: Prüft ob User im Silent Mode ist und ob Nachricht gesendet werden soll
function shouldSendEphemeral(userId, context = '') {
    // Verwarnungen und kritische Fehler IMMER senden
    const alwaysSendContexts = ['verwarnungen', 'warnung', 'warning', 'error', 'fehler'];
    if (alwaysSendContexts.some(ctx => context.toLowerCase().includes(ctx))) {
        return true;
    }
    
    // Wenn User im Silent Mode ist, keine Nachricht senden
    if (silentMode.has(userId)) {
        console.log(`🔇 [Silent Mode] Ephemeral-Nachricht unterdrückt für User ${userId} (Context: ${context})`);
        return false;
    }
    
    return true;
}

// Wrapper-Funktion für Ephemeral-Nachrichten mit Silent-Mode-Prüfung
async function safeEphemeralReply(interaction, content, context = '') {
    // Prüfe ob Nachricht gesendet werden soll
    if (!shouldSendEphemeral(interaction.user.id, content + ' ' + context)) {
        // Silent Mode aktiv - Interaction trotzdem beantworten (unsichtbar)
        try {
            if (!interaction.replied && !interaction.deferred) {
                // Unterscheide zwischen Command- und Component-Interactions
                // Bei Buttons/SelectMenus: deferUpdate verwenden
                if (interaction.isButton() || interaction.isStringSelectMenu() || interaction.isSelectMenu()) {
                    await interaction.deferUpdate();
                } else {
                    // Bei Commands: Leere ephemeral reply senden
                    await interaction.reply({ content: '✓', flags: [MessageFlags.Ephemeral] });
                }
            } else if (interaction.deferred) {
                // Wenn bereits deferred: Leere Antwort senden
                await interaction.editReply({ content: '✓' }).catch(() => {});
            }
        } catch (e) {
            console.error('Fehler beim Behandeln der Interaction im Silent Mode:', e);
        }
        return false;
    }
    
    // Normale Ephemeral-Nachricht senden
    try {
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ content, flags: [MessageFlags.Ephemeral] });
        } else if (interaction.deferred) {
            await interaction.editReply({ content });
        } else {
            await interaction.followUp({ content, flags: [MessageFlags.Ephemeral] });
        }
        return true;
    } catch (error) {
        console.error('Fehler beim Senden der Ephemeral-Nachricht:', error);
        return false;
    }
}

// Wrapper für editReply mit Silent-Mode-Prüfung (für deferred interactions)
async function safeEditReply(interaction, content, context = '') {
    // Prüfe ob Nachricht gesendet werden soll
    if (!shouldSendEphemeral(interaction.user.id, content + ' ' + context)) {
        console.log(`🔇 [Silent Mode] editReply unterdrückt für User ${interaction.user.id}`);
        // Wenn die Interaction bereits deferred ist, MUSS sie beantwortet werden
        // Sende eine minimale Antwort im Silent Mode
        try {
            if (interaction.deferred) {
                await interaction.editReply({ content: '✓' });
            }
        } catch (error) {
            console.error('Fehler beim Beantworten der deferred Interaction:', error);
        }
        return false;
    }
    
    // Normale editReply senden
    try {
        await interaction.editReply({ content });
        return true;
    } catch (error) {
        console.error('Fehler beim editReply:', error);
        return false;
    }
}

// Abwesenheiten-System
let abwesenheiten = [];

// Performance-Optimierung: Flag für Integrität-Checks
let signupDataChanged = false;

// Mutex für Signup-Operationen zur Vermeidung von Race Conditions
const signupMutex = {
    premier: new Set(),
    practice: new Set(),
    tournament: new Set(),
    scrim: new Set()
};

// Bewerbungssystem - Speichert Bewerbungsdaten pro User
// { userId: { channelId, name, trackerLink, alter, rang, agents, erfahrung, verfuegbarkeit, motivation, teamwahl, staerken, schwaechen, arbeiten, zusaetzlicheInfos } }
let bewerbungen = {};

// Speichert die Message-IDs der Bewerbungsvorschau-Nachrichten (für Updates)
// { userId: { messageId, channelId } }
let bewerbungsvorschauMessages = {};

// Button-Cooldown für Bewerbungssystem (verhindert Spam und Berechtigungsfehler)
// { userId: timestamp }
let bewerbungButtonCooldown = {};

// MVP-Votes System - Global initialisieren um Fehler zu vermeiden
if (!global.mvpVotes) {
    global.mvpVotes = {};
}

// Hilfsfunktion: Prüft ob eine Signup-Operation bereits läuft
function isSignupLocked(type, userId) {
    return signupMutex[type].has(userId);
}

// Hilfsfunktion: Sperrt eine Signup-Operation
function lockSignup(type, userId) {
    signupMutex[type].add(userId);
}

// Hilfsfunktion: Entsperrt eine Signup-Operation
function unlockSignup(type, userId) {
    signupMutex[type].delete(userId);
}

// Hilfsfunktion: Bereinigt alle setTimeout-Objekte in DM-Status
function cleanupTimeouts() {
    let cleanedCount = 0;
    
    // Premier DM Status Timeouts bereinigen
    Object.values(premierDMStatus).forEach(status => {
        if (status.foundTimeout) {
            clearTimeout(status.foundTimeout);
            status.foundTimeout = null;
            cleanedCount++;
        }
        if (status.cancelTimeout) {
            clearTimeout(status.cancelTimeout);
            status.cancelTimeout = null;
            cleanedCount++;
        }
    });
    
    // Practice DM Status Timeouts bereinigen
    Object.values(practiceDMStatus).forEach(status => {
        if (status.foundTimeout) {
            clearTimeout(status.foundTimeout);
            status.foundTimeout = null;
            cleanedCount++;
        }
        if (status.cancelTimeout) {
            clearTimeout(status.cancelTimeout);
            status.cancelTimeout = null;
            cleanedCount++;
        }
    });
    
    // Scrim DM Status Timeouts bereinigen
    if (scrimDMStatus.foundTimeout) {
        clearTimeout(scrimDMStatus.foundTimeout);
        scrimDMStatus.foundTimeout = null;
        cleanedCount++;
    }
    if (scrimDMStatus.cancelTimeout) {
        clearTimeout(scrimDMStatus.cancelTimeout);
        scrimDMStatus.cancelTimeout = null;
        cleanedCount++;
    }
    
    if (cleanedCount > 0) {
        console.log(`Timeout-Cleanup: ${cleanedCount} Timeouts bereinigt`);
    }
}


// Hilfsfunktion: Generiert Zeit-Choices für Dropdown-Menüs
function getTimeChoices() {
    return [
        { name: '01:00', value: '01:00' },
        { name: '02:00', value: '02:00' },
        { name: '03:00', value: '03:00' },
        { name: '04:00', value: '04:00' },
        { name: '05:00', value: '05:00' },
        { name: '06:00', value: '06:00' },
        { name: '07:00', value: '07:00' },
        { name: '08:00', value: '08:00' },
        { name: '09:00', value: '09:00' },
        { name: '10:00', value: '10:00' },
        { name: '11:00', value: '11:00' },
        { name: '12:00', value: '12:00' },
        { name: '13:00', value: '13:00' },
        { name: '14:00', value: '14:00' },
        { name: '15:00', value: '15:00' },
        { name: '16:00', value: '16:00' },
        { name: '17:00', value: '17:00' },
        { name: '18:00', value: '18:00' },
        { name: '19:00', value: '19:00' },
        { name: '20:00', value: '20:00' },
        { name: '21:00', value: '21:00' },
        { name: '22:00', value: '22:00' },
        { name: '23:00', value: '23:00' },
        { name: '00:00', value: '00:00' }
    ];
}

// Hilfsfunktion: Generiert Tag-Choices für Dropdown-Menüs
function getDayChoices() {
    return [
        { name: 'Montag', value: 'Montag' },
        { name: 'Dienstag', value: 'Dienstag' },
        { name: 'Mittwoch', value: 'Mittwoch' },
        { name: 'Donnerstag', value: 'Donnerstag' },
        { name: 'Freitag', value: 'Freitag' },
        { name: 'Samstag', value: 'Samstag' },
        { name: 'Sonntag', value: 'Sonntag' }
    ];
}

// Hilfsfunktion: Generiert Game-Choices für Dropdown-Menüs
function getGameChoices() {
    return [
        { name: '1 Game', value: 1 },
        { name: '2 Games', value: 2 },
        { name: '3 Games', value: 3 },
        { name: '4 Games', value: 4 },
        { name: '5 Games', value: 5 }
    ];
}

// Hilfsfunktion: Gibt ein Date-Objekt in deutscher Zeit zurück
function getGermanDate() {
    return new Date();
}

// Hilfsfunktion: Formatiert ein Datum als DD.MM
function formatDate(date) {
    const day = date.getDate().toString().padStart(2, '0');
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    return `${day}.${month}`;
}

// Hilfsfunktion: Gibt den aktuellen Tag mit Datum zurück
function getCurrentDayWithDate() {
    const today = getGermanDate();
    const dayNames = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
    const dayName = dayNames[today.getDay()];
    const dateStr = formatDate(today);
    return `${dayName} (${dateStr})`;
}

// Hilfsfunktion: Gibt den Tag mit Datum für einen bestimmten Tag zurück
function getDayWithDate(dayName, date) {
    const dateStr = formatDate(date);
    return `${dayName} (${dateStr})`;
}

// Hilfsfunktion: Konvertiert Dropdown-Datum-Optionen zu YYYY-MM-DD Format
function convertDropdownDateToISO(dateOption) {
    const today = getGermanDate();
    
    switch (dateOption) {
        case 'today':
            return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
        case 'tomorrow':
            const tomorrow = new Date(today);
            tomorrow.setDate(today.getDate() + 1);
            return `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`;
        case 'day_after_tomorrow':
            const dayAfterTomorrow = new Date(today);
            dayAfterTomorrow.setDate(today.getDate() + 2);
            return `${dayAfterTomorrow.getFullYear()}-${String(dayAfterTomorrow.getMonth() + 1).padStart(2, '0')}-${String(dayAfterTomorrow.getDate()).padStart(2, '0')}`;
        case 'next_monday':
            const nextMonday = new Date(today);
            const daysUntilMonday = (8 - today.getDay()) % 7;
            nextMonday.setDate(today.getDate() + daysUntilMonday);
            return `${nextMonday.getFullYear()}-${String(nextMonday.getMonth() + 1).padStart(2, '0')}-${String(nextMonday.getDate()).padStart(2, '0')}`;
        case 'next_tuesday':
            const nextTuesday = new Date(today);
            const daysUntilTuesday = (9 - today.getDay()) % 7;
            nextTuesday.setDate(today.getDate() + daysUntilTuesday);
            return `${nextTuesday.getFullYear()}-${String(nextTuesday.getMonth() + 1).padStart(2, '0')}-${String(nextTuesday.getDate()).padStart(2, '0')}`;
        case 'next_wednesday':
            const nextWednesday = new Date(today);
            const daysUntilWednesday = (10 - today.getDay()) % 7;
            nextWednesday.setDate(today.getDate() + daysUntilWednesday);
            return `${nextWednesday.getFullYear()}-${String(nextWednesday.getMonth() + 1).padStart(2, '0')}-${String(nextWednesday.getDate()).padStart(2, '0')}`;
        case 'next_thursday':
            const nextThursday = new Date(today);
            const daysUntilThursday = (11 - today.getDay()) % 7;
            nextThursday.setDate(today.getDate() + daysUntilThursday);
            return `${nextThursday.getFullYear()}-${String(nextThursday.getMonth() + 1).padStart(2, '0')}-${String(nextThursday.getDate()).padStart(2, '0')}`;
        case 'next_friday':
            const nextFriday = new Date(today);
            const daysUntilFriday = (12 - today.getDay()) % 7;
            nextFriday.setDate(today.getDate() + daysUntilFriday);
            return `${nextFriday.getFullYear()}-${String(nextFriday.getMonth() + 1).padStart(2, '0')}-${String(nextFriday.getDate()).padStart(2, '0')}`;
        case 'next_saturday':
            const nextSaturday = new Date(today);
            const daysUntilSaturday = (13 - today.getDay()) % 7;
            nextSaturday.setDate(today.getDate() + daysUntilSaturday);
            return `${nextSaturday.getFullYear()}-${String(nextSaturday.getMonth() + 1).padStart(2, '0')}-${String(nextSaturday.getDate()).padStart(2, '0')}`;
        case 'next_sunday':
            const nextSunday = new Date(today);
            const daysUntilSunday = (14 - today.getDay()) % 7;
            nextSunday.setDate(today.getDate() + daysUntilSunday);
            return `${nextSunday.getFullYear()}-${String(nextSunday.getMonth() + 1).padStart(2, '0')}-${String(nextSunday.getDate()).padStart(2, '0')}`;
        case 'custom':
            return null; // Wird durch start_custom/end_custom behandelt
        default:
            return null;
    }
}

// Hilfsfunktion: Konvertiert benutzerdefiniertes Datum (DD.MM.YYYY) zu YYYY-MM-DD
function convertCustomDateToISO(customDate) {
    if (!customDate) return null;
    
    const parts = customDate.split('.');
    if (parts.length !== 3) return null;
    
    const day = parseInt(parts[0]);
    const month = parseInt(parts[1]);
    const year = parseInt(parts[2]);
    
    if (isNaN(day) || isNaN(month) || isNaN(year)) return null;
    
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// Hilfsfunktion: Prüft ob ein User an einem bestimmten Tag abwesend ist
function isUserAbwesend(userId, targetDate) {
    const targetDateStr = `${targetDate.getFullYear()}-${String(targetDate.getMonth() + 1).padStart(2, '0')}-${String(targetDate.getDate()).padStart(2, '0')}`;
    return abwesenheiten.some(abw => 
        abw.userId === userId && 
        abw.startDate <= targetDateStr && 
        abw.endDate >= targetDateStr
    );
}

// Hilfsfunktion: Prüft ob ein User heute abwesend ist
function isUserAbwesendToday(userId) {
    const today = getGermanDate();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    return abwesenheiten.some(abw => 
        abw.userId === userId && 
        abw.startDate <= todayStr && 
        abw.endDate >= todayStr
    );
}

// Hilfsfunktion: Gibt Abwesenheits-Info für einen User zurück
function getUserAbwesenheitInfo(userId) {
    const today = getGermanDate();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    
    const abwesenheit = abwesenheiten.find(abw => 
        abw.userId === userId && 
        abw.startDate <= todayStr && 
        abw.endDate >= todayStr
    );
    
    if (!abwesenheit) return null;
    
    // Formatiere Datum und Uhrzeit
    let info = `${abwesenheit.startDate}`;
    if (abwesenheit.startTime) {
        info += ` ${abwesenheit.startTime}`;
    }
    info += ` - ${abwesenheit.endDate}`;
    if (abwesenheit.endTime) {
        info += ` ${abwesenheit.endTime}`;
    }
    
    return info;
}
// Hilfsfunktion: Prüft Button-Berechtigung für Board-Interaktionen
async function hasButtonPermission(interaction, boardType) {
    try {
        const rolesConfig = loadRolesConfig();
        const interactionBoards = rolesConfig.interaction_boards || [];
        const boardConfig = interactionBoards.find(board => board.type === boardType);

        if (!boardConfig) {
            return { hasPermission: false, requiredRole: 'Unbekannt' };
        }

        if (!interaction.guild) {
            return { hasPermission: false, requiredRole: boardConfig.role.name };
        }

        let member = interaction.member;
        if (!member) {
            member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
        }

        if (member) {
            // Prüfe alle erlaubten Rollen
            const allowedRoles = boardConfig.roles || [boardConfig.role];
            for (const role of allowedRoles) {
                if (member.roles.cache.has(role.id)) {
                    // Message-ID zur Liste hinzufügen wenn noch nicht vorhanden
                    await addMessageIdToBoard(boardType, interaction.message.id);
                    return { hasPermission: true };
                }
            }
        }

        // Erstelle Liste aller erlaubten Rollen für Fehlermeldung
        const allowedRoles = boardConfig.roles || [boardConfig.role];
        const roleNames = allowedRoles.map(role => role.name).join(' oder ');
        return { hasPermission: false, requiredRole: roleNames };
    } catch (error) {
        console.error('Fehler beim Prüfen der Button-Berechtigung:', error);
        return { hasPermission: false, requiredRole: 'Unbekannt' };
    }
}

// Hilfsfunktion: Fügt Message-ID zu Board-Konfiguration hinzu
async function addMessageIdToBoard(boardType, messageId) {
    try {
        const rolesConfig = loadRolesConfig();
        const interactionBoards = rolesConfig.interaction_boards || [];
        const boardIndex = interactionBoards.findIndex(board => board.type === boardType);
        
        if (boardIndex !== -1) {
            // Prüfe ob Message-ID bereits existiert
            if (!interactionBoards[boardIndex].message_ids.includes(messageId)) {
                interactionBoards[boardIndex].message_ids.push(messageId);
                
                // Speichere aktualisierte Konfiguration
                const fs = require('fs');
                fs.writeFileSync(ROLES_JSON, JSON.stringify(rolesConfig, null, 2));
                console.log(`Message-ID ${messageId} zu ${boardType} Board hinzugefügt`);
            }
        }
    } catch (error) {
        console.error('Fehler beim Hinzufügen der Message-ID:', error);
    }
}

// Hilfsfunktion: Entfernt Message-ID aus Board-Konfiguration
async function removeMessageIdFromBoard(boardType, messageId) {
    try {
        const rolesConfig = loadRolesConfig();
        const interactionBoards = rolesConfig.interaction_boards || [];
        const boardIndex = interactionBoards.findIndex(board => board.type === boardType);
        
        if (boardIndex !== -1) {
            const messageIds = interactionBoards[boardIndex].message_ids;
            const idIndex = messageIds.indexOf(messageId);
            
            if (idIndex !== -1) {
                messageIds.splice(idIndex, 1);
                
                // Speichere aktualisierte Konfiguration
                const fs = require('fs');
                fs.writeFileSync(ROLES_JSON, JSON.stringify(rolesConfig, null, 2));
                console.log(`Message-ID ${messageId} aus ${boardType} Board entfernt`);
            }
        }
    } catch (error) {
        console.error('Fehler beim Entfernen der Message-ID:', error);
    }
}

// Hilfsfunktion: Gibt den Index des Wochentags zurück (0=Sonntag, 1=Montag, ..., 6=Samstag)
function getDayIndex(day) {
    const dayMap = {
        'Sonntag': 0, 'Montag': 1, 'Dienstag': 2, 'Mittwoch': 3,
        'Donnerstag': 4, 'Freitag': 5, 'Samstag': 6
    };
    return dayMap[day] || 0;
}

// Hilfsfunktion: Sortiert Tage nach Wochentag (Montag = 1, Sonntag = 0)
function sortDaysByWeekday(days) {
    return days.sort((a, b) => {
        let dayA = getDayIndex(a);
        let dayB = getDayIndex(b);
        // Montag (1) soll vor Sonntag (0) kommen
        if (dayA === 0) dayA = 7;
        if (dayB === 0) dayB = 7;
        return dayA - dayB;
    });
}

// Slot-Helfer
function getPremierKey(index) { return `prem_${index}`; }
function getPracticeKey(index) { return `prac_${index}`; }
function getPremierSlots(team = 'main') {
    const config = getPremierConfig(team);
    if (!config || !config.days || !config.times) {
        console.error(`Ungültige Premier-Konfiguration für Team '${team}':`, config);
        return [];
    }
    const slots = [];
    for (let i = 0; i < config.days.length; i++) {
        slots.push({ index: i, day: config.days[i], time: config.times[i] });
    }
    return slots;
}
function getPracticeSlots(team = 'main') {
    const config = getPracticeConfig(team);
    if (!config || !config.days || !config.times) {
        console.error(`Ungültige Practice-Konfiguration für Team '${team}':`, config);
        return [];
    }
    const slots = [];
    for (let i = 0; i < config.days.length; i++) {
        slots.push({ index: i, day: config.days[i], time: config.times[i] });
    }
    return slots;
}
function getTournamentKey(index) { return `tourn_${index}`; }
function getTournamentSlots() {
    const slots = [];
    for (let i = 0; i < tournamentConfig.dates.length; i++) {
        slots.push({ 
            index: i, 
            date: tournamentConfig.dates[i], 
            time: tournamentConfig.times[i], 
            label: tournamentConfig.labels[i] 
        });
    }
    return slots;
}

// Hilfsfunktion: Initialisiert dynamische Anmeldungen basierend auf Konfiguration
function initializeDynamicSignups() {
    // Premier Signups initialisieren (index-basiert)
    signups = {};
    premierDMStatus = {};
    for (let i = 0; i < premierConfig.days.length; i++) {
        const key = getPremierKey(i);
        signups[key] = [];
        premierDMStatus[key] = { 
            state: 'waiting', 
            lastReminder: 0, 
            lastFound: 0, 
            lastCancel: 0, 
            pendingFound: false, 
            pendingCancel: false, 
            foundTimeout: null, 
            cancelTimeout: null 
        };
    }
    
    // Practice Signups initialisieren (index-basiert)
    practiceSignups = {};
    practiceDMStatus = {};
    for (let i = 0; i < practiceConfig.days.length; i++) {
        const key = getPracticeKey(i);
        practiceSignups[key] = [];
        practiceDMStatus[key] = { 
            state: 'waiting', 
            lastReminder: 0, 
            lastFound: 0, 
            lastCancel: 0, 
            pendingFound: false, 
            pendingCancel: false, 
            foundTimeout: null, 
            cancelTimeout: null 
        };
    }
    
    // Tournament Signups initialisieren (index-basiert, feste Termine)
    tournamentSignups = {};
    tournamentDMStatus = {};
    for (let i = 0; i < tournamentConfig.dates.length; i++) {
        const key = getTournamentKey(i);
        tournamentSignups[key] = [];
        tournamentDMStatus[key] = { 
            state: 'waiting', 
            lastReminder: 0, 
            lastFound: 0, 
            lastCancel: 0, 
            pendingFound: false, 
            pendingCancel: false, 
            foundTimeout: null, 
            cancelTimeout: null 
        };
    }
    
    // Scrim Signups initialisieren
    scrimSignups = [];
}

// Hilfsfunktion: Prüft ob eine Abwesenheit in der aktuellen Board-Woche liegt
function isAbwesenheitInBoardWeek(abw) {
    const today = getGermanDate();
    const currentDayIndex = today.getDay();
    
    // Finde den nächsten Donnerstag (Tag 4)
    let daysUntilThursday = 4 - currentDayIndex;
    if (daysUntilThursday < 0) {
        daysUntilThursday += 7;
    }
    
    // Der Donnerstag der Board-Woche
    const boardThursday = new Date(today);
    boardThursday.setDate(today.getDate() + daysUntilThursday);
    
    // Montag der Board-Woche (3 Tage vor Donnerstag)
    const boardMonday = new Date(boardThursday);
    boardMonday.setDate(boardThursday.getDate() - 3);
    
    // Sonntag der Board-Woche (3 Tage nach Donnerstag)
    const boardSunday = new Date(boardThursday);
    boardSunday.setDate(boardThursday.getDate() + 3);
    
    const abwStart = new Date(abw.startDate);
    const abwEnd = new Date(abw.endDate);
    

    
    // Prüfe ob die Abwesenheit mit der Board-Woche überlappt
    return (abwStart <= boardSunday && abwEnd >= boardMonday);
}



// Hilfsfunktion: Validiert und bereinigt die Anmeldungsdaten
function validateSignupData() {
    for (const day of premierConfig.days) {
        // Entferne Duplikate
        signups[day] = [...new Set(signups[day])];
        // Begrenze auf MAX_USERS
        if (signups[day].length > MAX_USERS) {
            signups[day] = signups[day].slice(0, MAX_USERS);
        }
    }
}

// Hilfsfunktion: Überprüft ob ein Tag in der Vergangenheit liegt
function isDayInPast(day) {
    const now = getGermanDate();
    const today = now.getDay();
    const dayIndex = getDayIndex(day);
    
    // Wenn heute der gleiche Tag ist, ist er nicht in der Vergangenheit
    if (today === dayIndex) return false;
    
    // Wenn heute nach dem Tag liegt, ist er in der Vergangenheit
    if (today > dayIndex) return true;
    
    // Spezialfall: Wenn heute Sonntag ist und der Tag ist Donnerstag oder Samstag
    if (today === 0 && (dayIndex === 4 || dayIndex === 6)) return true;
    
    return false;
}

// Hilfsfunktion: Überprüft ob ein Tag genau gestern war (für das Leeren der Anmeldungen)
function isDayJustPassed(day) {
    const now = getGermanDate();
    const todayIndex = now.getDay();
    const dayIndex = getDayIndex(day);
    // Gestern berechnen (0=Sonntag, 1=Montag, ..., 6=Samstag)
    const yesterdayIndex = (todayIndex + 6) % 7;
    return dayIndex === yesterdayIndex;
}

// NEU: Leert die Anmeldungen für vergangene Tage (nur wenn Tag genau gestern war)
async function clearPastSignups() {
    console.log('Überprüfe vergangene Anmeldungen...');
    const today = getGermanDate();
    const todayIndex = today.getDay();
    
    for (const day of premierConfig.days) {
        const dayIndex = getDayIndex(day);
        // Berechne das Datum des nächsten Vorkommens dieses Tages
        let daysUntilNext = dayIndex - todayIndex;
        if (daysUntilNext < 0) daysUntilNext += 7;
        const nextOccurrence = new Date(today);
        nextOccurrence.setDate(today.getDate() + daysUntilNext);
        
        // Wenn das nächste Vorkommen heute oder in der Vergangenheit liegt, aber der Tag ist nicht heute
        if (nextOccurrence <= today && todayIndex !== dayIndex) {
            if (signups[day].length > 0) {
                console.log(`Anmeldungen für ${day} werden geleert, da der Tag vorbei ist. (${signups[day].length} Spieler entfernt)`);
                signups[day] = [];
            }
        }
    }
    
    for (const day of practiceConfig.days) {
        const dayIndex = getDayIndex(day);
        // Berechne das Datum des nächsten Vorkommens dieses Practice-Tages
        let daysUntilNext = dayIndex - todayIndex;
        if (daysUntilNext < 0) daysUntilNext += 7;
        const nextOccurrence = new Date(today);
        nextOccurrence.setDate(today.getDate() + daysUntilNext);
        
        // Wenn das nächste Vorkommen heute oder in der Vergangenheit liegt, aber der Tag ist nicht heute
        if (nextOccurrence <= today && todayIndex !== dayIndex) {
            if (practiceSignups[day].length > 0) {
                console.log(`Practice-Anmeldungen für ${day} werden geleert, da der Tag vorbei ist. (${practiceSignups[day].length} Spieler entfernt)`);
                practiceSignups[day] = [];
            }
        }
    }
    
    // Scrim Anmeldungen leeren wenn der Tag vorbei ist
    const scrimDayIndex = getDayIndex(scrimConfig.day);
    let daysUntilNextScrim = scrimDayIndex - todayIndex;
    if (daysUntilNextScrim < 0) daysUntilNextScrim += 7;
    const nextScrimOccurrence = new Date(today);
    nextScrimOccurrence.setDate(today.getDate() + daysUntilNextScrim);
    
    if (nextScrimOccurrence <= today && todayIndex !== scrimDayIndex) {
        if (scrimSignups.length > 0) {
            console.log(`Scrim-Anmeldungen für ${scrimConfig.day} werden geleert, da der Tag vorbei ist. (${scrimSignups.length} Spieler entfernt)`);
            scrimSignups = [];
        }
    }
    
    // Wochen-Scrim: Auto-Reset wird jetzt stündlich geprüft (siehe executeWeeklyScrimResetCheck)
    // Diese Logik wurde ausgelagert, um bessere Nachhole-Logik zu ermöglichen
    
    // Backup nach dem Leeren speichern
    saveSignupBackup();
}



// Hilfsfunktion: Gibt den Wochenbereich (Montag–Sonntag) für ein Datum zurück
function getWeekRange(date) {
    // Kopie des Datums
    const d = new Date(date);
    // Wochentag (0=Sonntag, 1=Montag, ...)
    const day = d.getDay();
    // Montag finden
    const monday = new Date(d);
    monday.setDate(d.getDate() - ((day + 6) % 7));
    monday.setHours(0, 0, 0, 0);
    // Sonntag finden
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    sunday.setHours(23, 59, 59, 999);
    return { monday, sunday };
}

// Asynchrone Embed-Generierung: Zeige - username statt <@userid>, mit Cache
// Anpassung: Eigener Name immer oben und fett
async function getSignupEmbed(client, viewerId = null, messageId = null, team = 'main') {
    // Erstelle Beschreibung mit Zeiten
    const teamName = team === 'academy' ? 'Academy-Team' : 'Main-Team';
    let description = `Anmeldung Premier Spieltage (${teamName})! Maximal 5 Leute sind möglich pro Tag.\n`;
    
    // Slots bilden und nach Wochentag sortieren
    const slots = getPremierSlots(team);
    const sortedSlots = slots.sort((a, b) => {
        let da = getDayIndex(a.day); if (da === 0) da = 7;
        let db = getDayIndex(b.day); if (db === 0) db = 7;
        return da - db;
    });
    
    // Füge Zeiten zur Beschreibung hinzu
    let timesText = '';
    sortedSlots.forEach(slot => {
        const time = slot.time || '19:00';
        timesText += `${slot.day}: ${time} Uhr `;
    });
    
    description += timesText;
    
    const embed = new EmbedBuilder()
        .setTitle('Premier Anmeldung')
        .setDescription(description)
        .setColor(0x00AE86);
    
    // Füge Discord Message ID hinzu wenn verfügbar
    if (messageId) {
        embed.setFooter({ text: `ID: ${messageId}` });
    }
    
    const fields = await Promise.all(sortedSlots.map(async (slot) => {
        const today = getGermanDate();
        const dayIndex = getDayIndex(slot.day);
        const currentDayIndex = today.getDay();
        let daysUntilNext = dayIndex - currentDayIndex;
        if (daysUntilNext < 0) daysUntilNext += 7;
        const targetDate = new Date(today);
        targetDate.setDate(today.getDate() + daysUntilNext);
        const dayWithDate = getDayWithDate(slot.day, targetDate);
        
        // Sortiere: Eigener Eintrag (viewerId) immer oben
        const key = getPremierKey(slot.index);
        // Verwende Message-ID-basierte Signups wenn verfügbar, sonst Fallback auf alte Struktur
        let ids = [];
        if (messageId && premierSignups[messageId] && premierSignups[messageId][slot.day]) {
            ids = [...premierSignups[messageId][slot.day]];
        } else {
            // Fallback für alte Struktur
            ids = [...(signups[key] || [])];
        }
        if (viewerId && ids.includes(viewerId)) {
            ids = [viewerId, ...ids.filter(id => id !== viewerId)];
        }
        const usernames = await Promise.all(
            ids.map(async id => {
                let name = userCache[id] || null;
                if (!name) {
                    try {
                        const user = await client.users.fetch(id);
                        name = user.username;
                        userCache[id] = name;
                    } catch {
                        name = 'Unbekannt';
                    }
                }
                // Fett, wenn viewerId
                if (viewerId && id === viewerId) {
                    return `- **${name}**`;
                }
                return `- ${name}`;
            })
        );
        return {
            name: `**${dayWithDate}**`,
            value: usernames.length > 0 ? usernames.join('\n') : '-',
            inline: true
        };
    }));
    embed.addFields(fields);
    // --- NEU: Abwesenheiten nur anzeigen, wenn sie in der Woche des nächsten Spieltags liegen ---
    const shownWeeks = new Set();
    premierConfig.days.forEach(day => {
        const today = getGermanDate();
        const dayIndex = getDayIndex(day);
        const currentDayIndex = today.getDay();
        let daysUntilNext = dayIndex - currentDayIndex;
        if (daysUntilNext < 0) daysUntilNext += 7;
        const targetDate = new Date(today);
        targetDate.setDate(today.getDate() + daysUntilNext);
        const { monday, sunday } = getWeekRange(targetDate);
        const mondayStr = `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, '0')}-${String(monday.getDate()).padStart(2, '0')}`;
        const sundayStr = `${sunday.getFullYear()}-${String(sunday.getMonth() + 1).padStart(2, '0')}-${String(sunday.getDate()).padStart(2, '0')}`;
        shownWeeks.add(mondayStr + '_' + sundayStr);
    });
    const abwesenheitenToShow = abwesenheiten.filter(abw => {
        return Array.from(shownWeeks).some(weekKey => {
            const [mondayStr, sundayStr] = weekKey.split('_');
            return abw.startDate <= sundayStr && abw.endDate >= mondayStr;
        });
    });
    if (abwesenheitenToShow.length > 0) {
        const abwesenheitenList = await Promise.all(
            abwesenheitenToShow.map(async abw => {
                let username = userCache[abw.userId] || 'Unbekannt';
                if (!userCache[abw.userId]) {
                    try {
                        const user = await client.users.fetch(abw.userId);
                        username = user.username;
                        userCache[abw.userId] = username;
                    } catch {
                        username = 'Unbekannt';
                    }
                }
                const startDate = new Date(abw.startDate);
                const endDate = new Date(abw.endDate);
                const startFormatted = formatDate(startDate) + '.' + startDate.getFullYear();
                const endFormatted = formatDate(endDate) + '.' + endDate.getFullYear();
                return `- ${username} (${startFormatted} - ${endFormatted})`;
            })
        );
        embed.addFields({
            name: '**Abwesend**',
            value: abwesenheitenList.join('\n'),
            inline: true
        });
    }
    return embed;
}

// Eine ActionRow mit Buttons für alle konfigurierten Tage (Hinzufügen und Entfernen)
function getButtonRow(userId, isAdmin = false, messageId = null) {
    const slots = getPremierSlots();
    const sortedSlots = slots.sort((a, b) => {
        let da = getDayIndex(a.day); if (da === 0) da = 7;
        let db = getDayIndex(b.day); if (db === 0) db = 7;
        return da - db;
    });
    
    const addButtons = sortedSlots.map(slot =>
        new ButtonBuilder()
            .setCustomId(`signup_${slot.index}`)
            .setLabel(`${slot.day} ${slot.time} +`)
            .setStyle(ButtonStyle.Success)
            .setDisabled(false)
    );
    const removeButtons = sortedSlots.map(slot =>
        new ButtonBuilder()
            .setCustomId(`unsign_${slot.index}`)
            .setLabel(`${slot.day} ${slot.time} -`)
            .setStyle(ButtonStyle.Danger)
            .setDisabled(false)
    );
    
    const controlButtons = [
        new ButtonBuilder()
            .setCustomId(`premier_refresh_board${messageId ? `_${messageId}` : ''}`)
            .setLabel('Aktualisieren')
            .setEmoji('🔄')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('abwesend_modal')
            .setLabel('Abwesend')
            .setEmoji('📅')
            .setStyle(ButtonStyle.Secondary)
    ];

    // Teile Buttons in Chunks von maximal 5 auf
    const chunkArray = (array, chunkSize) => {
        const chunks = [];
        for (let i = 0; i < array.length; i += chunkSize) {
            chunks.push(array.slice(i, i + chunkSize));
        }
        return chunks;
    };
    
    const addButtonChunks = chunkArray(addButtons, 5);
    const removeButtonChunks = chunkArray(removeButtons, 5);
    
    const rows = [];
    
    // Füge Add-Button-Chunks hinzu
    addButtonChunks.forEach(chunk => {
        rows.push(new ActionRowBuilder().addComponents(...chunk));
    });
    
    // Füge Remove-Button-Chunks hinzu
    removeButtonChunks.forEach(chunk => {
        rows.push(new ActionRowBuilder().addComponents(...chunk));
    });
    
    // Füge Control-Buttons hinzu (maximal 5)
    if (controlButtons.length <= 5) {
        rows.push(new ActionRowBuilder().addComponents(...controlButtons));
    } else {
        // Teile auch Control-Buttons auf falls nötig
        const controlChunks = chunkArray(controlButtons, 5);
        controlChunks.forEach(chunk => {
            rows.push(new ActionRowBuilder().addComponents(...chunk));
        });
    }
    
    return rows;
}

// Hilfsfunktion: Gibt eine User-ID zurück, die im Board eingetragen ist, oder null
function getFirstSignedUpUserId() {
    const slots = getPremierSlots().sort((a, b) => {
        let da = getDayIndex(a.day); if (da === 0) da = 7;
        let db = getDayIndex(b.day); if (db === 0) db = 7;
        return da - db;
    });
    for (const slot of slots) {
        const key = getPremierKey(slot.index);
        if (signups[key] && signups[key].length > 0) return signups[key][0];
    }
    return null;
}


// Hilfsfunktion: Überprüft ob alle Anmeldungen korrekt sind (Performance-optimiert)
function verifySignupIntegrity(force = false) {
    // Nur ausführen wenn Daten geändert wurden oder erzwungen
    if (!force && !signupDataChanged) {
        return;
    }
    
    let totalSignups = 0;
    let duplicatesFound = false;
    
    // Dynamisch basierend auf konfigurierten Tagen
    for (const day of premierConfig.days) {
        if (Array.isArray(signups[day])) {
            totalSignups += signups[day].length;
    
    // Prüfe auf Duplikate
            const uniqueSignups = new Set(signups[day]);
            if (uniqueSignups.size !== signups[day].length) {
                console.warn(`Duplikate in ${day} gefunden!`);
                signups[day] = [...uniqueSignups];
                duplicatesFound = true;
            }
        }
    }
    
    if (duplicatesFound || force) {
        console.log(`Anmeldungen-Integrität geprüft: ${totalSignups} Spieler`);
    }
    
    // Flag zurücksetzen
    signupDataChanged = false;
}

// Hilfsfunktion: Markiert Signup-Daten als geändert
function markSignupDataChanged() {
    signupDataChanged = true;
}


// Simple flag to prevent duplicate MVP vote creation
let mvpVoteInProgress = false;

// Globale Interaction-Wrapper-Funktion
async function safeInteractionReply(interaction, content, options = {}) {
    try {
        if (interaction.replied || interaction.deferred) {
            console.log('Interaction bereits bearbeitet - überspringe Reply');
            return false;
        }
        
        await interaction.reply({ content, ...options });
        return true;
    } catch (error) {
        const errorCode = (error && error.code) || (error && error.rawError && error.rawError.code);
        if (errorCode === 10062 || errorCode === 40060 || (error && error.status === 404)) {
            console.log('Interaction bereits bearbeitet oder abgelaufen - überspringe Reply');
            return false;
        }
        console.error('Unerwarteter Fehler beim Interaction Reply:', error);
        return false;
    }
}

async function safeInteractionEditReply(interaction, content, options = {}) {
    try {
        if (!interaction.replied && !interaction.deferred) {
            console.log('Interaction nicht bearbeitet - kann nicht editReply verwenden');
            return false;
        }
        
        await interaction.editReply({ content, ...options });
        return true;
    } catch (error) {
        const errorCode = (error && error.code) || (error && error.rawError && error.rawError.code);
        if (errorCode === 10062 || errorCode === 40060 || (error && error.status === 404)) {
            console.log('Interaction bereits bearbeitet oder abgelaufen - überspringe EditReply');
            return false;
        }
        console.error('Unerwarteter Fehler beim Interaction EditReply:', error);
        return false;
    }
}

async function safeInteractionDeferReply(interaction, options = {}) {
    try {
        if (interaction.replied || interaction.deferred) {
            console.log('Interaction bereits bearbeitet - überspringe DeferReply');
            return false;
        }
        
        await interaction.deferReply(options);
        return true;
    } catch (error) {
        const errorCode = (error && error.code) || (error && error.rawError && error.rawError.code);
        if (errorCode === 10062 || errorCode === 40060 || (error && error.status === 404)) {
            console.log('Interaction bereits bearbeitet oder abgelaufen - überspringe DeferReply');
            return false;
        }
        console.error('Unerwarteter Fehler beim Interaction DeferReply:', error);
        return false;
    }
}

// Hilfsfunktion: Speichert Anmeldungen in eine Backup-Datei
function saveSignupBackup() {
    try {
        const backupData = {
            signups: signups,
            practiceSignups: practiceSignups,
            scrimSignups: scrimSignups,
            wochenScrimData: wochenScrimData,
            abwesenheiten: abwesenheiten,
            // Konfigurationen speichern
            premierConfig: premierConfig,
            practiceConfig: practiceConfig,
            scrimConfig: scrimConfig,
            // Board-States für Persistenz nach Neustart
            boardState: {
                premier: premierBoards,
                practice: practiceBoards,
                tournament: tournamentBoards,
                scrim: scrimBoards
            },
            // Message-ID-basierte Signups (neue Struktur)
            premierSignups: premierSignups,
            practiceSignups: practiceSignups,
            tournamentSignups: tournamentSignups,
            timestamp: getGermanDate().toISOString()
        };
        fs.writeFileSync(PREMIER_BACKUP_JSON, JSON.stringify(backupData, null, 2));
    } catch (error) {
        console.error('Fehler beim Speichern des Backups:', error);
    }
}

// MVP Vote Auswertungsfunktion
async function finalizeMVPVote(messageId) {
    try {
        const voteData = global.mvpVotes[messageId];
        if (!voteData || !voteData.active) {
            console.log(`MVP-Vote ${messageId} ist nicht aktiv oder existiert nicht`);
            return;
        }
        
        console.log(`Finalisiere MVP-Vote ${messageId}`);
        voteData.active = false;
        
        const guild = await client.guilds.fetch(voteData.guildId);
        const channel = await guild.channels.fetch(voteData.channelId);
        const message = await channel.messages.fetch(voteData.messageId);
        
        // Zähle Stimmen für alle 3 Kategorien
        const effortVotes = {};
        const commsVotes = {};
        const impactVotes = {};
        const totalVotes = {};
        
        // Zähle Stimmen pro Kategorie
        for (const votedId of Object.values(voteData.votes.effort)) {
            effortVotes[votedId] = (effortVotes[votedId] || 0) + 1;
            totalVotes[votedId] = (totalVotes[votedId] || 0) + 1;
        }
        
        for (const votedId of Object.values(voteData.votes.comms)) {
            commsVotes[votedId] = (commsVotes[votedId] || 0) + 1;
            totalVotes[votedId] = (totalVotes[votedId] || 0) + 1;
        }
        
        for (const votedId of Object.values(voteData.votes.impact)) {
            impactVotes[votedId] = (impactVotes[votedId] || 0) + 1;
            totalVotes[votedId] = (totalVotes[votedId] || 0) + 1;
        }
        
        // Finde Gewinner für jede Kategorie und Gesamt-MVP
        const sortedEffortVotes = Object.entries(effortVotes).sort((a, b) => b[1] - a[1]);
        const sortedCommsVotes = Object.entries(commsVotes).sort((a, b) => b[1] - a[1]);
        const sortedImpactVotes = Object.entries(impactVotes).sort((a, b) => b[1] - a[1]);
        const sortedTotalVotes = Object.entries(totalVotes).sort((a, b) => b[1] - a[1]);
        
        if (sortedTotalVotes.length === 0) {
            // Keine Stimmen abgegeben
            const embed = new EmbedBuilder()
                .setTitle('🏆 ═══ MVP ABSTIMMUNG BEENDET ═══ 🏆')
                .setDescription('❌ **Keine Stimmen abgegeben!**\n\nDie Abstimmung wurde ohne Ergebnis beendet.')
                .setColor(0xFF0000)
                .setTimestamp();
            
            await message.edit({ embeds: [embed], components: [] });
            saveMVPVotes();
            return;
        }
        
        // Hole Gewinner-Daten
        const overallWinnerId = sortedTotalVotes[0][0];
        const overallWinnerVotes = sortedTotalVotes[0][1];
        const overallWinnerMember = await guild.members.fetch(overallWinnerId);
        
        // Dynamische Texte
        const styleTextGen = voteData.style === 'weekly' ? 'der Woche' : 
                            voteData.style === 'monthly' ? 'des Monats' : 'des Jahres';
        
        // Erstelle Ergebnis-Embed mit allen Kategorien
        const resultEmbed = new EmbedBuilder()
            .setTitle('🏆 ═══ MVP ABSTIMMUNG BEENDET ═══ 🏆')
            .setDescription(
                `# 🎊 HERZLICHEN GLÜCKWUNSCH! 🎊\n\n` +
                `## 🌟 GESAMT-MVP ${styleTextGen}: 🌟\n` +
                `# ⭐ **${overallWinnerMember.displayName}** ⭐\n\n` +
                `**Punkte gesamt:** ${overallWinnerVotes}/3`
            )
            .setColor(0xFFD700)
            .setTimestamp();
        
        // Kategorie-Gewinner
        const categoryResults = [];
        
        // Effort Gewinner
        if (sortedEffortVotes.length > 0) {
            const [effortWinnerId, effortVotes] = sortedEffortVotes[0];
            try {
                const effortWinner = await guild.members.fetch(effortWinnerId);
                categoryResults.push(`💪 **Effort MVP:** ${effortWinner.displayName} (${effortVotes} Stimmen)`);
            } catch (error) {
                categoryResults.push(`💪 **Effort MVP:** Unbekannt (${effortVotes} Stimmen)`);
            }
        }
        
        // Comms Gewinner
        if (sortedCommsVotes.length > 0) {
            const [commsWinnerId, commsVotes] = sortedCommsVotes[0];
            try {
                const commsWinner = await guild.members.fetch(commsWinnerId);
                categoryResults.push(`🗣️ **Comms MVP:** ${commsWinner.displayName} (${commsVotes} Stimmen)`);
            } catch (error) {
                categoryResults.push(`🗣️ **Comms MVP:** Unbekannt (${commsVotes} Stimmen)`);
            }
        }
        
        // Impact Gewinner
        if (sortedImpactVotes.length > 0) {
            const [impactWinnerId, impactVotes] = sortedImpactVotes[0];
            try {
                const impactWinner = await guild.members.fetch(impactWinnerId);
                categoryResults.push(`💥 **Impact MVP:** ${impactWinner.displayName} (${impactVotes} Stimmen)`);
            } catch (error) {
                categoryResults.push(`💥 **Impact MVP:** Unbekannt (${impactVotes} Stimmen)`);
            }
        }
        
        if (categoryResults.length > 0) {
            resultEmbed.addFields({
                name: '🏆 ═══ KATEGORIE-GEWINNER ═══ 🏆',
                value: categoryResults.join('\n')
            });
        }
        
        // Top 3 Gesamt-Spieler
        if (sortedTotalVotes.length > 0) {
            const topResults = [];
            for (let i = 0; i < Math.min(3, sortedTotalVotes.length); i++) {
                const [userId, count] = sortedTotalVotes[i];
                try {
                    const member = await guild.members.fetch(userId);
                    const medals = ['🥇', '🥈', '🥉'];
                    topResults.push(`${medals[i]} **${member.displayName}** - ${count}/3 Punkte`);
                } catch (error) {
                    topResults.push(`${i + 1}. Unbekannt - ${count}/3 Punkte`);
                }
            }
            resultEmbed.addFields({
                name: '📊 ═══ TOP GESAMT-SPIELER ═══ 📊',
                value: topResults.join('\n')
            });
        }
        
        // Abstimmungsdetails
        const totalPlayers = voteData.players.length;
        const effortVoters = Object.keys(voteData.votes.effort).length;
        const commsVoters = Object.keys(voteData.votes.comms).length;
        const impactVoters = Object.keys(voteData.votes.impact).length;
        
        resultEmbed.addFields({
            name: '📈 Abstimmungsdetails',
            value: `**Effort:** ${effortVoters}/${totalPlayers} | **Comms:** ${commsVoters}/${totalPlayers} | **Impact:** ${impactVoters}/${totalPlayers}`
        });
        
        // Update Nachricht
        try {
            await message.edit({ embeds: [resultEmbed], components: [] });
        } catch (editError) {
            console.error('Fehler beim Bearbeiten der MVP-Vote Nachricht:', editError);
        }
        
        try {
            saveMVPVotes();
            console.log(`MVP-Vote beendet: ${overallWinnerMember.displayName} gewann mit ${overallWinnerVotes}/3 Punkten`);
        } catch (saveError) {
            console.error('Fehler beim Speichern der MVP-Votes:', saveError);
        }
        
    } catch (error) {
        console.error('Fehler beim Finalisieren der MVP-Abstimmung:', error);
    }
}

// MVP Votes Speicher- und Ladefunktionen
function saveMVPVotes() {
    try {
        const voteData = {
            votes: global.mvpVotes || {},
            timestamp: new Date().toISOString()
        };
        fs.writeFileSync(MVP_VOTES_JSON, JSON.stringify(voteData, null, 2));
    } catch (error) {
        console.error('Fehler beim Speichern der MVP-Votes:', error);
    }
}

function loadMVPVotes() {
    try {
        if (fs.existsSync(MVP_VOTES_JSON)) {
            const voteData = JSON.parse(fs.readFileSync(MVP_VOTES_JSON, 'utf8'));
            global.mvpVotes = voteData.votes || {};
            
            // Stelle Timer für zeitbasierte Abstimmungen wieder her
            let activeCount = 0;
            let expiredCount = 0;
            let deletedCount = 0;
            
            for (const [messageId, vote] of Object.entries(global.mvpVotes)) {
                if (!vote.active) continue;
                
                if (vote.endDate) {
                    const remainingTime = vote.endDate - Date.now();
                    
                    if (remainingTime > 0) {
                        // Timer noch aktiv
                        setTimeout(() => finalizeMVPVote(messageId), remainingTime);
                        activeCount++;
                        console.log(`MVP-Vote Timer wiederhergestellt: ${messageId} (${Math.ceil(remainingTime / 1000 / 60)} Minuten verbleibend)`);
                    } else {
                        // Timer abgelaufen - sofort beenden
                        setTimeout(() => finalizeMVPVote(messageId), 3000); // 3 Sekunden Verzögerung
                        expiredCount++;
                        console.log(`MVP-Vote abgelaufen, wird beendet: ${messageId}`);
                    }
                } else {
                    // "Bis alle abgestimmt haben" - bleibt aktiv
                    activeCount++;
                }
            }
            
            console.log(`MVP-Votes geladen: ${activeCount} aktiv, ${expiredCount} abgelaufen`);
            return true;
        } else {
            global.mvpVotes = {};
            return false;
        }
    } catch (error) {
        console.error('Fehler beim Laden der MVP-Votes:', error);
        global.mvpVotes = {};
        return false;
    }
}

// Funktion zum Überprüfen und Bereinigen von MVP Votes
async function cleanupMVPVotes() {
    try {
        console.log('Starte MVP-Vote Cleanup...');
        
        // Sicherheitsprüfung: Initialisiere mvpVotes falls nicht vorhanden
        if (!global.mvpVotes) {
            console.log('MVP-Votes nicht initialisiert - überspringe Cleanup');
            return 0;
        }
        
        let cleanedCount = 0;
        const votesToDelete = [];
        
        for (const [messageId, vote] of Object.entries(global.mvpVotes)) {
            if (!vote.active) continue;
            
            try {
                // Prüfe ob Guild noch existiert
                const guild = await client.guilds.fetch(vote.guildId);
                if (!guild) {
                    console.log(`Guild ${vote.guildId} nicht gefunden - lösche Vote ${messageId}`);
                    votesToDelete.push(messageId);
                    continue;
                }
                
                // Prüfe ob Channel noch existiert
                const channel = await guild.channels.fetch(vote.channelId);
                if (!channel) {
                    console.log(`Channel ${vote.channelId} nicht gefunden - lösche Vote ${messageId}`);
                    votesToDelete.push(messageId);
                    continue;
                }
                
                // Prüfe ob Message noch existiert
                const message = await channel.messages.fetch(vote.messageId);
                if (!message) {
                    console.log(`Message ${vote.messageId} nicht gefunden - lösche Vote ${messageId}`);
                    votesToDelete.push(messageId);
                    continue;
                }
                
                // Prüfe ob Message vom Bot ist
                if (message.author.id !== client.user.id) {
                    console.log(`Message ${vote.messageId} nicht vom Bot - lösche Vote ${messageId}`);
                    votesToDelete.push(messageId);
                    continue;
                }
                
                // Prüfe ob Message noch MVP Vote Komponenten hat
                if (!message.components || message.components.length === 0) {
                    console.log(`Message ${vote.messageId} hat keine Komponenten mehr - lösche Vote ${messageId}`);
                    votesToDelete.push(messageId);
                    continue;
                }
                
                // Prüfe ob Message noch MVP Vote Embed hat
                if (!message.embeds || message.embeds.length === 0 || !message.embeds[0].title?.includes('MVP')) {
                    console.log(`Message ${vote.messageId} hat kein MVP Vote Embed mehr - lösche Vote ${messageId}`);
                    votesToDelete.push(messageId);
                    continue;
                }
                
            } catch (error) {
                console.log(`Fehler beim Überprüfen von Vote ${messageId}:`, error.message);
                votesToDelete.push(messageId);
            }
        }
        
        // Lösche gefundene Votes
        for (const messageId of votesToDelete) {
            delete global.mvpVotes[messageId];
            cleanedCount++;
        }
        
        if (cleanedCount > 0) {
            console.log(`MVP-Vote Cleanup: ${cleanedCount} Votes gelöscht`);
            saveMVPVotes();
        } else {
            console.log('MVP-Vote Cleanup: Keine Votes zu bereinigen');
        }
        
        return cleanedCount;
        
    } catch (error) {
        console.error('Fehler beim MVP-Vote Cleanup:', error);
        return 0;
    }
}

// ==================== VERWARNUNGS-SYSTEM ====================

// Verwarnungen Speicher- und Ladefunktionen
function saveWarnings() {
    try {
        const warningsData = {
            warnings: global.warnings || {},
            timestamp: new Date().toISOString()
        };
        fs.writeFileSync(WARNINGS_JSON, JSON.stringify(warningsData, null, 2));
        console.log('Verwarnungen gespeichert');
    } catch (error) {
        console.error('Fehler beim Speichern der Verwarnungen:', error);
    }
}

function loadWarnings() {
    try {
        if (fs.existsSync(WARNINGS_JSON)) {
            const warningsData = JSON.parse(fs.readFileSync(WARNINGS_JSON, 'utf8'));
            global.warnings = warningsData.warnings || {};
            console.log(`Verwarnungen geladen: ${Object.keys(global.warnings).length} Spieler`);
            return true;
        } else {
            global.warnings = {};
            return false;
        }
    } catch (error) {
        console.error('Fehler beim Laden der Verwarnungen:', error);
        global.warnings = {};
        return false;
    }
}

// Verwarnungen initialisieren
if (!global.warnings) {
    global.warnings = {};
}

// ==================== ENDE VERWARNUNGS-SYSTEM ====================

// Hilfsfunktion: Lädt Anmeldungen aus einer Backup-Datei
async function loadSignupBackup() {
    try {
        if (fs.existsSync(PREMIER_BACKUP_JSON)) {
            const backupData = JSON.parse(fs.readFileSync(PREMIER_BACKUP_JSON, 'utf8'));
            
            // Konfigurationen laden - handle both old flat format and new team-based format
            // WICHTIG: Überschreibe NICHT das gesamte Objekt, da Getter-Properties verloren gehen würden!
            if (backupData.premierConfig) {
                if (backupData.premierConfig.main || backupData.premierConfig.academy) {
                    // New team-based format - aktualisiere nur die Eigenschaften
                    if (backupData.premierConfig.main) {
                        premierConfig.main = {
                            days: Array.isArray(backupData.premierConfig.main.days) ? backupData.premierConfig.main.days : ['Donnerstag', 'Samstag', 'Sonntag'],
                            times: Array.isArray(backupData.premierConfig.main.times) ? backupData.premierConfig.main.times : ['19:00', '20:00', '19:00']
                        };
                    }
                    if (backupData.premierConfig.academy) {
                        premierConfig.academy = {
                            days: Array.isArray(backupData.premierConfig.academy.days) ? backupData.premierConfig.academy.days : ['Donnerstag', 'Samstag', 'Sonntag'],
                            times: Array.isArray(backupData.premierConfig.academy.times) ? backupData.premierConfig.academy.times : ['19:00', '20:00', '19:00']
                        };
                    }
                } else {
                    // Old flat format - convert to team-based format
                    premierConfig.main = {
                        days: Array.isArray(backupData.premierConfig.days) ? backupData.premierConfig.days : ['Donnerstag', 'Samstag', 'Sonntag'],
                        times: Array.isArray(backupData.premierConfig.times) ? backupData.premierConfig.times : ['19:00', '20:00', '19:00']
                    };
                    if (!premierConfig.academy) {
                        premierConfig.academy = {
                            days: ['Donnerstag', 'Samstag', 'Sonntag'],
                            times: ['19:00', '20:00', '19:00']
                        };
                    }
                }
            }
            
            if (backupData.practiceConfig) {
                if (backupData.practiceConfig.main || backupData.practiceConfig.academy) {
                    // New team-based format - aktualisiere nur die Eigenschaften
                    if (backupData.practiceConfig.main) {
                        practiceConfig.main = {
                            days: Array.isArray(backupData.practiceConfig.main.days) ? backupData.practiceConfig.main.days : ['Mittwoch', 'Freitag'],
                            times: Array.isArray(backupData.practiceConfig.main.times) ? backupData.practiceConfig.main.times : ['19:00', '19:00']
                        };
                    }
                    if (backupData.practiceConfig.academy) {
                        practiceConfig.academy = {
                            days: Array.isArray(backupData.practiceConfig.academy.days) ? backupData.practiceConfig.academy.days : ['Mittwoch', 'Freitag'],
                            times: Array.isArray(backupData.practiceConfig.academy.times) ? backupData.practiceConfig.academy.times : ['19:00', '19:00']
                        };
                    }
                } else {
                    // Old flat format - convert to team-based format
                    practiceConfig.main = {
                        days: Array.isArray(backupData.practiceConfig.days) ? backupData.practiceConfig.days : ['Mittwoch', 'Freitag'],
                        times: Array.isArray(backupData.practiceConfig.times) ? backupData.practiceConfig.times : ['19:00', '19:00']
                    };
                    if (!practiceConfig.academy) {
                        practiceConfig.academy = {
                            days: ['Mittwoch', 'Freitag'],
                            times: ['19:00', '19:00']
                        };
                    }
                }
            }
            
            scrimConfig = backupData.scrimConfig || scrimConfig;
            
            // Ensure team configurations are properly initialized
            initializeTeamConfigs();
            
            // Additional safety check - ensure backward compatibility properties work
            if (!premierConfig.main || !premierConfig.main.days || !Array.isArray(premierConfig.main.days)) {
                console.warn('Premier config main team missing or invalid, reinitializing...');
                premierConfig.main = {
                    days: ['Donnerstag', 'Samstag', 'Sonntag'],
                    times: ['19:00', '20:00', '19:00']
                };
            }
            
            if (!practiceConfig.main || !practiceConfig.main.days || !Array.isArray(practiceConfig.main.days)) {
                console.warn('Practice config main team missing or invalid, reinitializing...');
                practiceConfig.main = {
                    days: ['Mittwoch', 'Freitag'],
                    times: ['19:00', '19:00']
                };
            }
            
            // Anmeldungen laden
            signups = backupData.signups || {};
            practiceSignups = backupData.practiceSignups || {};
            scrimSignups = backupData.scrimSignups || {}; // Message-ID-basiertes Format: { messageId: { game1: [], game2: [] } }
            wochenScrimData = backupData.wochenScrimData || {};
            abwesenheiten = backupData.abwesenheiten || abwesenheiten;
            
            // Board-States für Persistenz laden (Message-ID-basiert)
            if (backupData.boardState) {
                premierBoards = backupData.boardState.premier || {};
                practiceBoards = backupData.boardState.practice || {};
                tournamentBoards = backupData.boardState.tournament || {};
                scrimBoards = backupData.boardState.scrim || {};
            }
            
            // Stelle sicher, dass alle Board-States initialisiert sind
            if (!premierBoards || typeof premierBoards !== 'object') {
                premierBoards = {};
            }
            if (!practiceBoards || typeof practiceBoards !== 'object') {
                practiceBoards = {};
            }
            if (!tournamentBoards || typeof tournamentBoards !== 'object') {
                tournamentBoards = {};
            }
            if (!scrimBoards || typeof scrimBoards !== 'object') {
                scrimBoards = {};
            }
            
            // Lade auch die neuen Message-ID-basierten Signups
            if (backupData.premierSignups) {
                premierSignups = backupData.premierSignups;
            }
            if (backupData.practiceSignups) {
                practiceSignups = backupData.practiceSignups;
            }
            if (backupData.tournamentSignups) {
                tournamentSignups = backupData.tournamentSignups;
            }
            
            // Stelle sicher, dass alle Message-ID-basierten Signups initialisiert sind
            if (!premierSignups || typeof premierSignups !== 'object') {
                premierSignups = {};
            }
            if (!practiceSignups || typeof practiceSignups !== 'object') {
                practiceSignups = {};
            }
            if (!tournamentSignups || typeof tournamentSignups !== 'object') {
                tournamentSignups = {};
            }
            
            // Stelle sicher, dass scrimSignups Message-ID-basiert sind
            if (!scrimSignups || typeof scrimSignups !== 'object') {
                scrimSignups = {};
            }
            
            // Initialisiere fehlende scrimSignups für alle vorhandenen scrimBoards
            for (const messageId in scrimBoards) {
                if (!scrimSignups[messageId]) {
                    const maxGames = scrimBoards[messageId].maxGames || 2;
                    scrimSignups[messageId] = {};
                    for (let g = 1; g <= maxGames; g++) {
                        scrimSignups[messageId][`game${g}`] = [];
                    }
                    console.log(`✅ Initialisiert scrimSignups für Message ${messageId} (${maxGames} Games)`);
                }
            }
            
            // Initialisiere fehlende scrimSignups für alle wochenScrimData
            for (const messageId in wochenScrimData) {
                if (!scrimSignups[messageId]) {
                    const maxGames = wochenScrimData[messageId].maxGames || 2;
                    scrimSignups[messageId] = {};
                    for (let g = 1; g <= maxGames; g++) {
                        scrimSignups[messageId][`game${g}`] = [];
                    }
                    console.log(`✅ Initialisiert scrimSignups für WochenScrim ${messageId} (${maxGames} Games)`);
                }
            }
            
            // Stelle sicher, dass alle benötigten Tage existieren (ohne Daten zu überschreiben)
            ensureAllDays();

            // Logging: Nur User und Tag
            // Premier - Dynamisch basierend auf konfigurierten Tagen
            for (const day of premierConfig.days) {
                if (Array.isArray(signups[day])) {
                    for (const userId of signups[day]) {
                        let username = userCache[userId] || 'Unbekannt';
                        if (!userCache[userId] && client && client.users) {
                            try {
                                const user = await client.users.fetch(userId);
                                username = user.username;
                                userCache[userId] = username;
                            } catch {}
                        }
                        console.log(`Eingetragen: ${username} für ${day}`);
                    }
                }
            }
            // Practice - Dynamisch basierend auf konfigurierten Tagen
            for (const day of practiceConfig.days) {
                if (Array.isArray(practiceSignups[day])) {
                    for (const userId of practiceSignups[day]) {
                        let username = userCache[userId] || 'Unbekannt';
                        if (!userCache[userId] && client && client.users) {
                            try {
                                const user = await client.users.fetch(userId);
                                username = user.username;
                                userCache[userId] = username;
                            } catch {}
                        }
                        console.log(`Eingetragen: ${username} für ${day}`);
                    }
                }
            }
            // Abwesenheiten-Logging
            for (const abw of abwesenheiten) {
                let username = userCache[abw.userId] || 'Unbekannt';
                if (!userCache[abw.userId] && client && client.users) {
                    try {
                        const user = await client.users.fetch(abw.userId);
                        username = user.username;
                        userCache[abw.userId] = username;
                    } catch {}
                }
                console.log(`Abwesend: ${username} von ${abw.startDate} bis ${abw.endDate}`);
            }
            return true;
        }
    } catch (error) {
        console.error('Fehler beim Laden des Backups:', error);
    }
    return false;
}

// Hilfsfunktion: Löscht abgelaufene Abwesenheiten
function cleanupExpiredAbwesenheiten() {
    const today = getGermanDate();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const beforeCount = abwesenheiten.length;
    abwesenheiten = abwesenheiten.filter(abw => abw.endDate >= todayStr);
    const afterCount = abwesenheiten.length;
    if (beforeCount !== afterCount) {
        console.log(`Abgelaufene Abwesenheiten gelöscht: ${beforeCount - afterCount} Einträge`);
        saveSignupBackup(); // Backup aktualisieren
    }
}

// Hilfsfunktion: Stellt sicher, dass signups für alle konfigurierten Tage existieren
function ensureAllDays() {
    // Stelle sicher, dass Team-Konfigurationen initialisiert sind
    initializeTeamConfigs();
    
    // Prüfe ob premierConfig.main.days existiert und iterierbar ist
    if (!premierConfig.main || !Array.isArray(premierConfig.main.days)) {
        console.error('premierConfig.main.days ist nicht verfügbar, initialisiere Standardwerte');
        initializeTeamConfigs();
    }
    
    for (const day of premierConfig.days) {
        if (!Array.isArray(signups[day])) signups[day] = [];
    }
    
    // Prüfe ob practiceConfig.main.days existiert und iterierbar ist
    if (!practiceConfig.main || !Array.isArray(practiceConfig.main.days)) {
        console.error('practiceConfig.main.days ist nicht verfügbar, initialisiere Standardwerte');
        initializeTeamConfigs();
    }
    
    for (const day of practiceConfig.days) {
        if (!Array.isArray(practiceSignups[day])) practiceSignups[day] = [];
    }
    if (!scrimSignups || typeof scrimSignups !== 'object') {
        scrimSignups = { game1: [] };
    }
    // Stelle sicher, dass alle Games Arrays sind
    for (let i = 1; i <= scrimConfig.maxGames; i++) {
        const gameKey = `game${i}`;
        if (!Array.isArray(scrimSignups[gameKey])) {
            scrimSignups[gameKey] = [];
        }
    }
}
// Einmalige Wiederherstellung von Board-States für alte Backups ohne boardState
async function recoverMissingBoardStates() {
    let recoveredMessages = 0;
    let processedChannels = 0;
    const totalGuilds = client.guilds.cache.size;
    
    console.log(`🔍 EINMALIGE Wiederherstellung: Suche nach Bot-Nachrichten in ${totalGuilds} Guilds...`);
    
    try {
        // Gehe durch alle Guilds und Channels
        for (const guild of client.guilds.cache.values()) {
            const guildChannels = guild.channels.cache.filter(ch => ch.type === 0); // Nur Text-Channels
            console.log(`🔍 Prüfe Guild "${guild.name}" mit ${guildChannels.size} Text-Channels...`);
            
            for (const channel of guildChannels.values()) {
                processedChannels++;
                
                try {
                    // Hole nur die neuesten Nachrichten (bessere Performance)
                    let allMessages = new Map();
                    let lastMessageId = null;
                    let batchCount = 0;
                    const MAX_BATCHES = 5; // Reduziert für bessere Performance
                    
                    while (batchCount < MAX_BATCHES) {
                        const fetchOptions = { limit: 50 }; // Reduziert von 100 auf 50
                        if (lastMessageId) {
                            fetchOptions.before = lastMessageId;
                        }
                        
                        const messages = await channel.messages.fetch(fetchOptions);
                        if (messages.size === 0) break;
                        
                        // Füge Nachrichten zur Collection hinzu
                        for (const [id, message] of messages) {
                            allMessages.set(id, message);
                        }
                        
                        lastMessageId = messages.last()?.id;
                        batchCount++;
                    }
                    
                    // Stilles Durchsuchen ohne Logging
                    
                    for (const message of allMessages.values()) {
                        // Prüfe ob es eine Bot-Nachricht mit Embeds und Buttons ist
                        if (message.author.id !== client.user.id) continue;
                        if (!message.embeds.length || !message.components.length) continue;
                        
                        const embed = message.embeds[0];
                        if (!embed || !embed.footer || !embed.footer.text) continue;
                        
                        // Erkenne Message-Typ anhand des Embed-Titels
                        const title = embed.title || '';
                        const footer = embed.footer.text;
                        
                        // Extrahiere Message ID aus Footer (Format: "ID: 1234567890")
                        const idMatch = footer.match(/ID:\s*(\d+)/);
                        if (!idMatch) continue;
                        
                        const messageId = message.id;
                        const channelId = channel.id;
                        
                        // Erkenne Message-Typ und stelle Board-State wieder her (Message-ID-basiert)
                        if (title.includes('Premier League') || title.includes('Premier')) {
                            if (!premierBoards[messageId]) {
                                premierBoards[messageId] = {
                                    channelId: channelId,
                                    type: 'premier',
                                    team: 'main' // Standard-Team, kann später angepasst werden
                                };
                                recoveredMessages++;
                                console.log(`✅ Premier Board wiederhergestellt: Message ${messageId}`);
                            }
                        } else if (title.includes('Practice')) {
                            if (!practiceBoards[messageId]) {
                                practiceBoards[messageId] = {
                                    channelId: channelId,
                                    type: 'practice',
                                    team: 'main' // Standard-Team, kann später angepasst werden
                                };
                                recoveredMessages++;
                                console.log(`✅ Practice Board wiederhergestellt: Message ${messageId}`);
                            }
                        } else if (title.includes('Tournament') || title.includes('Turnier')) {
                            if (!tournamentBoards[messageId]) {
                                tournamentBoards[messageId] = {
                                    channelId: channelId,
                                    type: 'tournament',
                                    team: 'main', // Standard-Team, kann später angepasst werden
                                    page: 0
                                };
                                recoveredMessages++;
                                console.log(`✅ Tournament Board wiederhergestellt: Message ${messageId}`);
                            }
                        } else if (title.includes('Scrim')) {
                            if (!scrimBoards[messageId]) {
                                scrimBoards[messageId] = {
                                    channelId: channelId,
                                    day: 'Unbekannt',
                                    time: 'Unbekannt',
                                    expiryDate: new Date(Date.now() + 24 * 60 * 60 * 1000) // 24h Standard
                                };
                                
                                // Initialisiere Scrim-Signups falls sie nicht existieren
                                if (!scrimSignups[messageId]) {
                                    scrimSignups[messageId] = {};
                                    for (let i = 1; i <= scrimConfig.maxGames; i++) {
                                        scrimSignups[messageId][`game${i}`] = [];
                                    }
                                }
                                
                                recoveredMessages++;
                                console.log(`✅ Scrim Board wiederhergestellt: Message ${messageId}, Channel ${channelId}`);
                            }
                        }
                    }
                } catch (error) {
                    // Fehler beim Zugriff auf Channel ignorieren (keine Berechtigung, etc.)
                    if (error.code !== 50013 && error.code !== 50001) {
                        console.warn(`Warnung beim Durchsuchen von Channel ${channel.id}:`, error.message);
                    }
                }
            }
        }
        
        console.log(`🔍 Wiederherstellung abgeschlossen. ${processedChannels} Channels durchsucht.`);
        
        if (recoveredMessages > 0) {
            console.log(`🎉 ${recoveredMessages} Board-States automatisch wiederhergestellt!`);
            saveSignupBackup(); // Speichere das wiederhergestellte Board-State
        } else {
            console.log(`ℹ️ Keine verlorenen Board-States gefunden.`);
        }
        
    } catch (error) {
        console.error('Fehler bei der automatischen Board-State-Wiederherstellung:', error);
    }
}

// Aktualisiert alle wiederhergestellten Nachrichten
async function refreshAllRecoveredMessages() {
    try {
        // Premier Boards aktualisieren
        for (const [channelId, board] of Object.entries(premierBoards)) {
            try {
                const channel = await client.channels.fetch(channelId);
                const message = await channel.messages.fetch(board.messageId);
                
                const embed = await getSignupEmbed(client, null, board.messageId);
                const buttonRows = getButtonRow(null, true, board.messageId);
                
                await message.edit({ embeds: [embed], components: buttonRows });
                console.log(`✅ Premier Board aktualisiert: ${channelId}`);
            } catch (error) {
                console.warn(`Fehler beim Aktualisieren von Premier Board ${channelId}:`, error.message);
            }
        }
        
        // Practice Boards aktualisieren
        for (const [channelId, board] of Object.entries(practiceBoards)) {
            try {
                const channel = await client.channels.fetch(channelId);
                const message = await channel.messages.fetch(board.messageId);
                
                const embed = await getPracticeSignupEmbed(client, null, board.messageId);
                const buttonRows = getPracticeButtonRowsWithControls(null, true, board.messageId);
                
                await message.edit({ embeds: [embed], components: buttonRows });
                console.log(`✅ Practice Board aktualisiert: ${channelId}`);
            } catch (error) {
                console.warn(`Fehler beim Aktualisieren von Practice Board ${channelId}:`, error.message);
            }
        }
        
        // Tournament Boards aktualisieren
        for (const [channelId, board] of Object.entries(tournamentBoards)) {
            try {
                const channel = await client.channels.fetch(channelId);
                const message = await channel.messages.fetch(board.messageId);
                
                const embed = await getTournamentSignupEmbed(client, null, board.page || 0, board.messageId);
                const buttonRows = getTournamentButtonRowsWithControls(null, true, board.page || 0);
                
                await message.edit({ embeds: [embed], components: buttonRows });
                console.log(`✅ Tournament Board aktualisiert: ${channelId}`);
            } catch (error) {
                console.warn(`Fehler beim Aktualisieren von Tournament Board ${channelId}:`, error.message);
            }
        }
        
        // Scrim Boards aktualisieren
        for (const [messageId, board] of Object.entries(scrimBoards)) {
            try {
                const channel = await client.channels.fetch(board.channelId);
                const message = await channel.messages.fetch(messageId);
                
                const embed = await getScrimSignupEmbed(client, null, messageId);
                const buttonRows = getScrimButtonRowsWithControls(null, true, messageId);
                
                await message.edit({ embeds: [embed], components: buttonRows });
                console.log(`✅ Scrim Board aktualisiert: ${messageId}`);
            } catch (error) {
                console.warn(`Fehler beim Aktualisieren von Scrim Board ${messageId}:`, error.message);
            }
        }
        
    } catch (error) {
        console.error('Fehler beim Aktualisieren der wiederhergestellten Nachrichten:', error);
    }
}

// Bereinige nicht mehr existierende Nachrichten aus dem Backup
async function cleanupDeletedMessages() {
    console.log('🧹 Starte Cleanup: Prüfe auf gelöschte Nachrichten...');
    
    let totalChecked = 0;
    let totalDeleted = 0;
    
    try {
        // Sammle alle Message-IDs aus allen Boards
        const allMessageIds = new Set([
            ...Object.keys(premierBoards),
            ...Object.keys(practiceBoards),
            ...Object.keys(tournamentBoards),
            ...Object.keys(scrimBoards),
            ...Object.keys(wochenScrimData)
        ]);
        
        console.log(`📋 Prüfe ${allMessageIds.size} Nachrichten...`);
        
        for (const messageId of allMessageIds) {
            totalChecked++;
            
            try {
                // Finde die Channel-ID für diese Message
                let channelId = null;
                
                if (premierBoards[messageId]) {
                    channelId = premierBoards[messageId].channelId;
                } else if (practiceBoards[messageId]) {
                    channelId = practiceBoards[messageId].channelId;
                } else if (tournamentBoards[messageId]) {
                    channelId = tournamentBoards[messageId].channelId;
                } else if (scrimBoards[messageId]) {
                    channelId = scrimBoards[messageId].channelId;
                }
                
                if (!channelId) {
                    // Wenn keine channelId gefunden wurde, lösche aus allen Strukturen
                    console.log(`⚠️ Keine channelId für Message ${messageId} gefunden - bereinige...`);
                    delete premierBoards[messageId];
                    delete premierSignups[messageId];
                    delete practiceBoards[messageId];
                    delete practiceSignups[messageId];
                    delete tournamentBoards[messageId];
                    delete tournamentSignups[messageId];
                    delete scrimBoards[messageId];
                    delete scrimSignups[messageId];
                    delete wochenScrimData[messageId];
                    totalDeleted++;
                    continue;
                }
                
                // Versuche die Nachricht zu finden
                const channel = await client.channels.fetch(channelId).catch(() => null);
                
                if (!channel) {
                    // Channel existiert nicht mehr - lösche Message
                    console.log(`🗑️ Channel ${channelId} existiert nicht mehr - lösche Message ${messageId}`);
                    delete premierBoards[messageId];
                    delete premierSignups[messageId];
                    delete practiceBoards[messageId];
                    delete practiceSignups[messageId];
                    delete tournamentBoards[messageId];
                    delete tournamentSignups[messageId];
                    delete scrimBoards[messageId];
                    delete scrimSignups[messageId];
                    delete wochenScrimData[messageId];
                    totalDeleted++;
                    continue;
                }
                
                const message = await channel.messages.fetch(messageId).catch(() => null);
                
                if (!message) {
                    // Message existiert nicht mehr - lösche aus allen Strukturen
                    console.log(`🗑️ Message ${messageId} existiert nicht mehr - bereinige aus Backup`);
                    delete premierBoards[messageId];
                    delete premierSignups[messageId];
                    delete practiceBoards[messageId];
                    delete practiceSignups[messageId];
                    delete tournamentBoards[messageId];
                    delete tournamentSignups[messageId];
                    delete scrimBoards[messageId];
                    delete scrimSignups[messageId];
                    delete wochenScrimData[messageId];
                    totalDeleted++;
                }
                
            } catch (error) {
                // Bei Fehler (z.B. keine Berechtigung) - lösche die Message aus dem Backup
                if (error.code === 10008 || error.code === 50001 || error.code === 50013) {
                    console.log(`🗑️ Message ${messageId} nicht erreichbar (Fehler ${error.code}) - bereinige aus Backup`);
                    delete premierBoards[messageId];
                    delete premierSignups[messageId];
                    delete practiceBoards[messageId];
                    delete practiceSignups[messageId];
                    delete tournamentBoards[messageId];
                    delete tournamentSignups[messageId];
                    delete scrimBoards[messageId];
                    delete scrimSignups[messageId];
                    delete wochenScrimData[messageId];
                    totalDeleted++;
                } else {
                    console.warn(`⚠️ Fehler beim Prüfen von Message ${messageId}:`, error.message);
                }
            }
        }
        
        console.log(`✅ Cleanup abgeschlossen: ${totalChecked} geprüft, ${totalDeleted} gelöscht`);
        
        if (totalDeleted > 0) {
            saveSignupBackup();
            console.log('💾 Backup gespeichert nach Cleanup');
        }
        
    } catch (error) {
        console.error('❌ Fehler beim Cleanup:', error);
    }
}


// Command-Registrierung (aktualisiert)
client.once(Events.ClientReady, async () => {
    console.log(`Bot online als ${client.user.tag}`);
    
    // Initialisiere Team-Konfigurationen
    initializeTeamConfigs();
    
    // Bereinige alte Channel-basierte Strukturen
    cleanupOldChannelBasedStructures();
    
    // Initialisiere dynamische Strukturen
    initializeDynamicSignups();
    
    // Timeout-Cleanup beim Start
    cleanupTimeouts();
    
    // Lade MVP-Votes (mit await um sicherzustellen dass es fertig ist)
    await loadMVPVotes();
    
    // Lade Verwarnungen
    loadWarnings();
    
    // Versuche Backup zu laden beim Start
    if (await loadSignupBackup()) {
        console.log('Anmeldungen aus Backup wiederhergestellt');
        ensureAllDays();
        verifySignupIntegrity();
        
        // Bereinige gelöschte Nachrichten aus dem Backup
        await cleanupDeletedMessages();
        
        // Board-States Info - KEINE automatische Wiederherstellung
        const boardCount = Object.keys(premierBoards).length + Object.keys(practiceBoards).length + 
                          Object.keys(tournamentBoards).length + Object.keys(scrimBoards).length;
        
        if (boardCount > 0) {
            console.log(`✅ ${boardCount} Board-States aus Backup geladen.`);
        } else {
            console.log('ℹ️ Keine aktiven Board-States im Backup - erstelle neue Nachrichten mit /premier, /practice, etc.');
            console.log('💡 Tipp: Verwende /recover um existierende Bot-Nachrichten wiederherzustellen.');
        }
        
        // LOG: Zeige Inhalt des geladenen Backups
        let totalPremierPlayers = 0;
        for (const day of premierConfig.days) {
            const daySignups = signups[day] || [];
            totalPremierPlayers += daySignups.length;
            console.log(`[Startup] Premier ${day}: ${daySignups.length > 0 ? daySignups.join(', ') : 'leer'}`);
        }
        console.log(`[Startup] Premier Total: ${totalPremierPlayers} Spieler`);
        
        let totalPracticePlayers = 0;
        for (const day of practiceConfig.days) {
            const daySignups = practiceSignups[day] || [];
            totalPracticePlayers += daySignups.length;
            console.log(`[Startup] Practice ${day}: ${daySignups.length > 0 ? daySignups.join(', ') : 'leer'}`);
        }
        console.log(`[Startup] Practice Total: ${totalPracticePlayers} Spieler`);
        
        // Dynamisches Scrim-Logging
        for (let i = 1; i <= scrimConfig.maxGames; i++) {
            const gameKey = `game${i}`;
            console.log(`[Startup] Scrim Game ${i}: ${scrimSignups[gameKey] ? scrimSignups[gameKey].join(', ') : '[]'}`);
        }
    } else {
        ensureAllDays();
        console.log('Kein Backup geladen. Starte mit leeren Anmeldungen.');
        
        for (const day of premierConfig.days) {
            console.log(`[Startup] Premier ${day}: ${signups[day] ? signups[day].join(', ') : '[]'}`);
        }
        for (const day of practiceConfig.days) {
            console.log(`[Startup] Practice ${day}: ${practiceSignups[day] ? practiceSignups[day].join(', ') : '[]'}`);
        }
        // Dynamisches Scrim-Logging
        for (let i = 1; i <= scrimConfig.maxGames; i++) {
            const gameKey = `game${i}`;
            console.log(`[Startup] Scrim Game ${i}: ${scrimSignups[gameKey] ? scrimSignups[gameKey].join(', ') : '[]'}`);
        }
    }
    
    // Lade berechtigte Benutzer für Dropdown-Choices
    console.log('Lade berechtigte Benutzer für Command-Choices...');
    const userChoices = await getAuthorizedUserChoices();
    console.log(`${userChoices.length} berechtigte Benutzer für Dropdowns geladen`);
    
    const data = [
        new SlashCommandBuilder()
            .setName('premier')
            .setDescription('Erstellt sofort eine Premier-Anmeldung')
            .addStringOption(option =>
                option.setName('team')
                    .setDescription('Team auswählen')
                    .setRequired(true)
                    .addChoices(
                        { name: 'Main-Team', value: 'main' },
                        { name: 'Academy-Team', value: 'academy' }
                    ))
            .toJSON(),
        new SlashCommandBuilder()
            .setName('premier-config')
            .setDescription('Konfiguriert die Premier-Tage und Zeiten (1 Pflicht, 2 optional)')
            .addStringOption(option =>
                option.setName('team')
                    .setDescription('Team auswählen')
                    .setRequired(true)
                    .addChoices(
                        { name: 'Main-Team', value: 'main' },
                        { name: 'Academy-Team', value: 'academy' }
                    ))
            .addStringOption(option =>
                option.setName('day_1')
                    .setDescription('Erster Tag')
                    .setRequired(true)
                    .addChoices(...getDayChoices()))
            .addStringOption(option =>
                option.setName('daytime_1')
                    .setDescription('Zeit für ersten Tag')
                    .setRequired(true)
                    .addChoices(...getTimeChoices()))
            .addStringOption(option =>
                option.setName('day_2')
                    .setDescription('Zweiter Tag')
                    .setRequired(false)
                    .addChoices(...getDayChoices()))
            .addStringOption(option =>
                option.setName('daytime_2')
                    .setDescription('Zeit für zweiten Tag')
                    .setRequired(false)
                    .addChoices(...getTimeChoices()))
            .addStringOption(option =>
                option.setName('day_3')
                    .setDescription('Dritter Tag')
                    .setRequired(false)
                    .addChoices(...getDayChoices()))
                        .addStringOption(option =>
                option.setName('daytime_3')
                    .setDescription('Zeit für dritten Tag')
                    .setRequired(false)
                    .addChoices(...getTimeChoices()))
            .toJSON(),
        new SlashCommandBuilder()
            .setName('tournament')
            .setDescription('Erstellt sofort eine Turnier-Anmeldung mit festen Terminen')
            .addStringOption(option =>
                option.setName('team')
                    .setDescription('Team auswählen')
                    .setRequired(true)
                    .addChoices(
                        { name: 'Main-Team', value: 'main' },
                        { name: 'Academy-Team', value: 'academy' }
                    ))
            .toJSON(),
        new SlashCommandBuilder()
            .setName('tournament-add')
            .setDescription('Fügt einen User zu einer spezifischen Turnier-Runde hinzu')
            .addUserOption(option =>
                option.setName('user')
                    .setDescription('Der User der hinzugefügt werden soll')
                    .setRequired(true))
            .addStringOption(option =>
                option.setName('datum')
                    .setDescription('Datum der Runde (DD.MM.YYYY)')
                    .setRequired(true))
            .addStringOption(option =>
                option.setName('id')
                    .setDescription('Discord Message ID der Tournament-Nachricht')
                    .setRequired(true))
            .toJSON(),
        new SlashCommandBuilder()
            .setName('tournament-config')
            .setDescription('Konfiguriert die Turnier-Termine (bis zu 7 feste Daten)')
            .addStringOption(option =>
                option.setName('team')
                    .setDescription('Team auswählen')
                    .setRequired(true)
                    .addChoices(
                        { name: 'Main-Team', value: 'main' },
                        { name: 'Academy-Team', value: 'academy' }
                    ))
            .addStringOption(option =>
                option.setName('date_1')
                    .setDescription('Erstes Datum (DD.MM.YYYY)')
                    .setRequired(true))
            .addStringOption(option =>
                option.setName('time_1')
                    .setDescription('Zeit für ersten Termin')
                    .setRequired(true)
                    .addChoices(...getTimeChoices()))
            .addStringOption(option =>
                option.setName('label_1')
                    .setDescription('Label für ersten Termin (z.B. "Runde 1")')
                    .setRequired(true))
            .addStringOption(option =>
                option.setName('date_2')
                    .setDescription('Zweites Datum (DD.MM.YYYY)')
                    .setRequired(false))
            .addStringOption(option =>
                option.setName('time_2')
                    .setDescription('Zeit für zweiten Termin')
                    .setRequired(false)
                    .addChoices(...getTimeChoices()))
            .addStringOption(option =>
                option.setName('label_2')
                    .setDescription('Label für zweiten Termin')
                    .setRequired(false))
            .addStringOption(option =>
                option.setName('date_3')
                    .setDescription('Drittes Datum (DD.MM.YYYY)')
                    .setRequired(false))
            .addStringOption(option =>
                option.setName('time_3')
                    .setDescription('Zeit für dritten Termin')
                    .setRequired(false)
                    .addChoices(...getTimeChoices()))
            .addStringOption(option =>
                option.setName('label_3')
                    .setDescription('Label für dritten Termin')
                    .setRequired(false))
            .addStringOption(option =>
                option.setName('date_4')
                    .setDescription('Viertes Datum (DD.MM.YYYY)')
                    .setRequired(false))
            .addStringOption(option =>
                option.setName('time_4')
                    .setDescription('Zeit für vierten Termin')
                    .setRequired(false)
                    .addChoices(...getTimeChoices()))
            .addStringOption(option =>
                option.setName('label_4')
                    .setDescription('Label für vierten Termin')
                    .setRequired(false))
            .addStringOption(option =>
                option.setName('date_5')
                    .setDescription('Fünftes Datum (DD.MM.YYYY)')
                    .setRequired(false))
            .addStringOption(option =>
                option.setName('time_5')
                    .setDescription('Zeit für fünften Termin')
                    .setRequired(false)
                    .addChoices(...getTimeChoices()))
            .addStringOption(option =>
                option.setName('label_5')
                    .setDescription('Label für fünften Termin')
                    .setRequired(false))
            .addStringOption(option =>
                option.setName('date_6')
                    .setDescription('Sechstes Datum (DD.MM.YYYY)')
                    .setRequired(false))
            .addStringOption(option =>
                option.setName('time_6')
                    .setDescription('Zeit für sechsten Termin')
                    .setRequired(false)
                    .addChoices(...getTimeChoices()))
            .addStringOption(option =>
                option.setName('label_6')
                    .setDescription('Label für sechsten Termin')
                    .setRequired(false))
            .addStringOption(option =>
                option.setName('date_7')
                    .setDescription('Siebtes Datum (DD.MM.YYYY)')
                    .setRequired(false))
            .addStringOption(option =>
                option.setName('time_7')
                    .setDescription('Zeit für siebten Termin')
                    .setRequired(false)
                    .addChoices(...getTimeChoices()))
            .addStringOption(option =>
                option.setName('label_7')
                    .setDescription('Label für siebten Termin')
                    .setRequired(false))
            .toJSON(),
        new SlashCommandBuilder()
            .setName('premier-admin')
            .setDescription('Admin-Befehle für Premier-Anmeldungen')
            .addSubcommand(subcommand =>
                subcommand
                    .setName('add')
                    .setDescription('Fügt einen Spieler zu einem Tag hinzu')
                    .addStringOption(option =>
                        option.setName('user')
                            .setDescription('Berechtigter Spieler')
                            .setRequired(true)
                            .addChoices(...userChoices))
                    
                    .addStringOption(option =>
                        option.setName('day')
                            .setDescription('Tag für die Anmeldung')
                            .setRequired(true)
                            .addChoices(
                                { name: 'Donnerstag', value: 'Donnerstag' },
                                { name: 'Samstag', value: 'Samstag' },
                                { name: 'Sonntag', value: 'Sonntag' },
                                { name: 'Mittwoch', value: 'Mittwoch' },
                                { name: 'Freitag', value: 'Freitag' }
                            )))
            .addSubcommand(subcommand =>
                subcommand
                    .setName('delete')
                    .setDescription('Entfernt einen Spieler von einem Tag')
                    .addStringOption(option =>
                        option.setName('user')
                            .setDescription('Berechtigter Spieler')
                            .setRequired(true)
                            .addChoices(...userChoices))
                    
                    .addStringOption(option =>
                        option.setName('day')
                            .setDescription('Tag für die Abmeldung')
                            .setRequired(true)
                            .addChoices(
                                { name: 'Donnerstag', value: 'Donnerstag' },
                                { name: 'Samstag', value: 'Samstag' },
                                { name: 'Sonntag', value: 'Sonntag' },
                                { name: 'Mittwoch', value: 'Mittwoch' },
                                { name: 'Freitag', value: 'Freitag' }
                            )))
            .toJSON(),
        new SlashCommandBuilder()
            .setName('dm')
            .setDescription('Opt-in/out für Premier-DMs')
            .addStringOption(option =>
                option.setName('modus')
                    .setDescription('DM-Benachrichtigungen aktivieren oder deaktivieren')
                    .setRequired(true)
                    .addChoices(
                        { name: 'Benachrichtigungen AUS', value: 'off' },
                        { name: 'Benachrichtigungen AN', value: 'on' }
                    )
            )
            .toJSON(),
        new SlashCommandBuilder()
            .setName('cc')
            .setDescription('Löscht alle Nachrichten im aktuellen Channel')
            .toJSON(),
        // entfernt: backup
        // entfernt: pastbackup
        new SlashCommandBuilder()
            .setName('practice')
            .setDescription('Erstellt sofort eine Practice-Anmeldung')
            .addStringOption(option =>
                option.setName('team')
                    .setDescription('Team auswählen')
                    .setRequired(true)
                    .addChoices(
                        { name: 'Main-Team', value: 'main' },
                        { name: 'Academy-Team', value: 'academy' }
                    ))
            .toJSON(),
        new SlashCommandBuilder()
            .setName('practice-config')
            .setDescription('Konfiguriert die Practice-Tage und Zeiten (1 Pflicht, 2 optional)')
            .addStringOption(option =>
                option.setName('team')
                    .setDescription('Team auswählen')
                    .setRequired(true)
                    .addChoices(
                        { name: 'Main-Team', value: 'main' },
                        { name: 'Academy-Team', value: 'academy' }
                    ))
            .addStringOption(option =>
                option.setName('day_1')
                    .setDescription('Erster Tag')
                    .setRequired(true)
                    .addChoices(...getDayChoices()))
            .addStringOption(option =>
                option.setName('daytime_1')
                    .setDescription('Zeit für ersten Tag')
                    .setRequired(true)
                    .addChoices(...getTimeChoices()))
            .addStringOption(option =>
                option.setName('day_2')
                    .setDescription('Zweiter Tag')
                    .setRequired(false)
                    .addChoices(...getDayChoices()))
            .addStringOption(option =>
                option.setName('daytime_2')
                    .setDescription('Zeit für zweiten Tag')
                    .setRequired(false)
                    .addChoices(...getTimeChoices()))
            .addStringOption(option =>
                option.setName('day_3')
                    .setDescription('Dritter Tag (optional)')
                    .setRequired(false)
                    .addChoices(...getDayChoices()))
            .addStringOption(option =>
                option.setName('daytime_3')
                    .setDescription('Zeit für dritten Tag (optional)')
                    .setRequired(false)
                    .addChoices(...getTimeChoices()))
            .toJSON(),
        new SlashCommandBuilder()
            .setName('practice-admin')
            .setDescription('Admin-Befehle für Practice-Anmeldungen')
            .addSubcommand(subcommand => {
                subcommand
                    .setName('add')
                    .setDescription('Fügt einen Spieler zu einem Practice-Tag hinzu')
                    .addStringOption(option =>
                        option.setName('user')
                            .setDescription('Berechtigter Spieler')
                            .setRequired(true)
                            .addChoices(...userChoices))
                    .addStringOption(option =>
                        option.setName('day')
                            .setDescription('Practice-Tag')
                            .setRequired(true)
                            .addChoices(...(practiceConfig.days || []).map(d => ({ name: d, value: d }))));
                return subcommand;
            })
            .addSubcommand(subcommand => {
                subcommand
                    .setName('delete')
                    .setDescription('Entfernt einen Spieler von einem Practice-Tag')
                    .addStringOption(option =>
                        option.setName('user')
                            .setDescription('Berechtigter Spieler')
                            .setRequired(true)
                            .addChoices(...userChoices))
                    .addStringOption(option =>
                        option.setName('day')
                            .setDescription('Practice-Tag')
                            .setRequired(true)
                            .addChoices(...(practiceConfig.days || []).map(d => ({ name: d, value: d }))));
                return subcommand;
            })
            .toJSON(),
        new SlashCommandBuilder()
            .setName('scrim')
            .setDescription('Erstellt eine Scrim-Anmeldung')
            .addStringOption(option =>
                option.setName('style')
                    .setDescription('Scrim-Style')
                    .setRequired(true)
                    .addChoices(
                        { name: 'Single Message (1 Tag)', value: 'single_message' },
                        { name: 'Wochen Scrim (7 Seiten)', value: 'wochen_scrim' },
                        { name: 'Wochen Scrim (7 Messages)', value: 'wochen_scrim_multi' }
                    ))
            .addStringOption(option =>
                option.setName('zeit')
                    .setDescription('Zeit für Scrim(s)')
                    .setRequired(true)
                    .addChoices(
                        { name: '12:30', value: '12:30' },
                        { name: '13:00', value: '13:00' },
                        { name: '13:30', value: '13:30' },
                        { name: '14:00', value: '14:00' },
                        { name: '14:30', value: '14:30' },
                        { name: '15:00', value: '15:00' },
                        { name: '15:30', value: '15:30' },
                        { name: '16:00', value: '16:00' },
                        { name: '16:30', value: '16:30' },
                        { name: '17:00', value: '17:00' },
                        { name: '17:30', value: '17:30' },
                        { name: '18:00', value: '18:00' },
                        { name: '18:30', value: '18:30' },
                        { name: '19:00', value: '19:00' },
                        { name: '19:30', value: '19:30' },
                        { name: '20:00', value: '20:00' },
                        { name: '20:30', value: '20:30' },
                        { name: '21:00', value: '21:00' },
                        { name: '21:30', value: '21:30' },
                        { name: '22:00', value: '22:00' },
                        { name: '22:30', value: '22:30' },
                        { name: '23:00', value: '23:00' },
                        { name: '23:30', value: '23:30' },
                        { name: '00:00', value: '00:00' },
                        { name: '00:30', value: '00:30' }
                    ))
            .addIntegerOption(option =>
                option.setName('games')
                    .setDescription('Anzahl Games')
                    .setRequired(true)
                    .addChoices(
                        { name: '1 Game', value: 1 },
                        { name: '2 Games', value: 2 },
                        { name: '3 Games', value: 3 },
                        { name: '4 Games', value: 4 },
                        { name: '5 Games', value: 5 }
                    ))
            .addStringOption(option =>
                option.setName('wochentag')
                    .setDescription('Wochentag (nur bei Single Message)')
                    .setRequired(false)
                    .addChoices(
                        { name: 'Montag', value: 'Montag' },
                        { name: 'Dienstag', value: 'Dienstag' },
                        { name: 'Mittwoch', value: 'Mittwoch' },
                        { name: 'Donnerstag', value: 'Donnerstag' },
                        { name: 'Freitag', value: 'Freitag' },
                        { name: 'Samstag', value: 'Samstag' },
                        { name: 'Sonntag', value: 'Sonntag' }
                    ))
            .addStringOption(option =>
                option.setName('ausnahme_tag')
                    .setDescription('Ausnahme-Wochentag (optional)')
                    .setRequired(false)
                    .addChoices(
                        { name: 'Montag', value: 'Montag' },
                        { name: 'Dienstag', value: 'Dienstag' },
                        { name: 'Mittwoch', value: 'Mittwoch' },
                        { name: 'Donnerstag', value: 'Donnerstag' },
                        { name: 'Freitag', value: 'Freitag' },
                        { name: 'Samstag', value: 'Samstag' },
                        { name: 'Sonntag', value: 'Sonntag' }
                    ))
            .addStringOption(option =>
                option.setName('ausnahme_zeit')
                    .setDescription('Ausnahme-Zeit (optional)')
                    .setRequired(false)
                    .addChoices(
                        { name: '12:30', value: '12:30' },
                        { name: '13:00', value: '13:00' },
                        { name: '13:30', value: '13:30' },
                        { name: '14:00', value: '14:00' },
                        { name: '14:30', value: '14:30' },
                        { name: '15:00', value: '15:00' },
                        { name: '15:30', value: '15:30' },
                        { name: '16:00', value: '16:00' },
                        { name: '16:30', value: '16:30' },
                        { name: '17:00', value: '17:00' },
                        { name: '17:30', value: '17:30' },
                        { name: '18:00', value: '18:00' },
                        { name: '18:30', value: '18:30' },
                        { name: '19:00', value: '19:00' },
                        { name: '19:30', value: '19:30' },
                        { name: '20:00', value: '20:00' },
                        { name: '20:30', value: '20:30' },
                        { name: '21:00', value: '21:00' },
                        { name: '21:30', value: '21:30' },
                        { name: '22:00', value: '22:00' },
                        { name: '22:30', value: '22:30' },
                        { name: '23:00', value: '23:00' },
                        { name: '23:30', value: '23:30' },
                        { name: '00:00', value: '00:00' },
                        { name: '00:30', value: '00:30' }
                    ))
            .addStringOption(option =>
                option.setName('ausnahme_beschreibung')
                    .setDescription('Ausnahme-Beschreibung (optional)')
                    .setRequired(false))
            .toJSON(),
        new SlashCommandBuilder()
            .setName('change')
            .setDescription('Ändert Tag und Zeit eines Scrim anhand der Discord Message ID')
            .addStringOption(option =>
                option.setName('id')
                    .setDescription('Discord Message ID der Scrim-Nachricht die geändert werden soll')
                    .setRequired(true))
            .addStringOption(option =>
                option.setName('day')
                    .setDescription('Neuer Tag für Scrim')
                    .setRequired(true)
                    .addChoices(
                        { name: 'Montag', value: 'Montag' },
                        { name: 'Dienstag', value: 'Dienstag' },
                        { name: 'Mittwoch', value: 'Mittwoch' },
                        { name: 'Donnerstag', value: 'Donnerstag' },
                        { name: 'Freitag', value: 'Freitag' },
                        { name: 'Samstag', value: 'Samstag' },
                        { name: 'Sonntag', value: 'Sonntag' }
                    ))
            .addStringOption(option =>
                option.setName('time')
                    .setDescription('Neue Zeit für Scrim (z.B. 19:00)')
                    .setRequired(true))
            .toJSON(),
        new SlashCommandBuilder()
            .setName('scrim-admin')
            .setDescription('Admin-Befehle für Scrim-Anmeldungen')
            .addSubcommand(subcommand => {
                subcommand
                    .setName('add')
                    .setDescription('Fügt einen Spieler zu einem Wochen-Scrim hinzu (via Message-ID)')
                    .addStringOption(option =>
                        option.setName('user')
                            .setDescription('Berechtigter Spieler')
                            .setRequired(true)
                            .addChoices(...userChoices))
                    .addStringOption(option =>
                        option.setName('message_id')
                            .setDescription('Discord Message-ID des Wochen-Scrim-Boards')
                            .setRequired(true));
                return subcommand;
            })
            .addSubcommand(subcommand => {
                subcommand
                    .setName('delete')
                    .setDescription('Entfernt einen Spieler aus einem Scrim-Game')
                    .addStringOption(option =>
                        option.setName('user')
                            .setDescription('Berechtigter Spieler')
                            .setRequired(true)
                            .addChoices(...userChoices))
                    .addIntegerOption(option =>
                        option.setName('game')
                            .setDescription('Game-Nummer (1-5)')
                            .setRequired(true)
                            .addChoices(
                                { name: 'Game 1', value: 1 },
                                { name: 'Game 2', value: 2 },
                                { name: 'Game 3', value: 3 },
                                { name: 'Game 4', value: 4 },
                                { name: 'Game 5', value: 5 }
                            )
                    );
                return subcommand;
            })
            .addSubcommand(subcommand => {
                subcommand
                    .setName('refresh')
                    .setDescription('Repariert eine kaputte Scrim-Nachricht, indem sie komplett neu geladen wird')
                    .addStringOption(option =>
                        option.setName('message_id')
                            .setDescription('Discord Message-ID der zu reparierenden Nachricht')
                            .setRequired(true));
                return subcommand;
            })
            .toJSON(),
        // entfernt: scrim-config
        new SlashCommandBuilder()
            .setName('abwesend')
            .setDescription('Verwaltet deine Abwesenheiten')
            .addSubcommand(subcommand => {
                subcommand
                    .setName('add')
                    .setDescription('Markiert dich als abwesend für einen bestimmten Zeitraum')
                    .addStringOption(option =>
                        option.setName('start')
                            .setDescription('Startdatum (DD.MM.YYYY)')
                            .setRequired(true))
                    .addStringOption(option =>
                        option.setName('end')
                            .setDescription('Enddatum (DD.MM.YYYY)')
                            .setRequired(true));
                return subcommand;
            })
            .addSubcommand(subcommand => {
                subcommand
                    .setName('delete')
                    .setDescription('Löscht deine Abwesenheiten')
                    .addStringOption(option =>
                        option.setName('type')
                            .setDescription('Was soll gelöscht werden?')
                            .setRequired(true)
                            .addChoices(
                                { name: 'Alle Abwesenheiten', value: 'all' },
                                { name: 'Letzte Abwesenheit', value: 'last' }
                            ));
                return subcommand;
            })
            .toJSON(),
        new SlashCommandBuilder()
            .setName('silent')
            .setDescription('Steuert deine persönlichen Bot-Benachrichtigungen')
            .addStringOption(option =>
                option.setName('modus')
                    .setDescription('Silent Mode aktivieren/deaktivieren')
                    .setRequired(true)
                    .addChoices(
                        { name: 'ON - Keine Nachrichten erhalten', value: 'on' },
                        { name: 'OFF - Nachrichten erhalten (Standard)', value: 'off' }
                    ))
            .toJSON(),
        new SlashCommandBuilder()
            .setName('clearpast')
            .setDescription('Löscht manuell vergangene Anmeldungen')
            .addSubcommand(subcommand =>
                subcommand
                    .setName('premier')
                    .setDescription('Löscht alle Premier-Anmeldungen (alle Tage)')
            )
            .addSubcommand(subcommand =>
                subcommand
                    .setName('practice')
                    .setDescription('Löscht alle Practice-Anmeldungen (alle Tage)')
            )
            .toJSON(),
        new SlashCommandBuilder()
            .setName('recover')
            .setDescription('Stellt verlorene Board-States wieder her (für Admins)')
            .toJSON(),
        new SlashCommandBuilder()
            .setName('force-backup')
            .setDescription('Erstellt sofort ein Backup mit aktuellen Board-States (für Admins)')
            .toJSON(),
        new SlashCommandBuilder()
            .setName('mvp_vote')
            .setDescription('Erstellt eine MVP-Abstimmung (nur für berechtigte Rollen)')
            .addStringOption(option =>
                option.setName('style')
                    .setDescription('Abstimmungstyp')
                    .setRequired(true)
                    .addChoices(
                        { name: 'Wöchentlich', value: 'weekly' },
                        { name: 'Monatlich', value: 'monthly' },
                        { name: 'Jährlich', value: 'yearly' }
                    ))
            .addStringOption(option =>
                option.setName('time')
                    .setDescription('Abstimmungsdauer')
                    .setRequired(true)
                    .addChoices(
                        { name: 'Bis alle abgestimmt haben', value: 'all_voted' },
                        { name: '1 Tag', value: '1day' },
                        { name: '3 Tage', value: '3days' },
                        { name: '7 Tage', value: '7days' }
                    ))
            .toJSON(),
        new SlashCommandBuilder()
            .setName('mvp_cleanup')
            .setDescription('Bereinigt gelöschte MVP-Votes aus der Datenbank (nur für Admins)')
            .toJSON(),
        new SlashCommandBuilder()
            .setName('verwarnung')
            .setDescription('Verwarnung an einen Spieler erteilen (nur für Admins)')
            .addStringOption(option =>
                option.setName('spieler')
                    .setDescription('Gib den Namen oder @mention des Spielers ein (Valorant Main)')
                    .setRequired(true))
            .addStringOption(option =>
                option.setName('grund')
                    .setDescription('Grund für die Verwarnung')
                    .setRequired(true))
            .toJSON(),
        new SlashCommandBuilder()
            .setName('show-verwarnung')
            .setDescription('Zeigt den Link zum Verwarnungs-System')
            .toJSON(),
        new SlashCommandBuilder()
            .setName('test')
            .setDescription('Testet das Bewerbungssystem im aktuellen Channel')
            .toJSON(),
        new SlashCommandBuilder()
            .setName('bewerbung')
            .setDescription('Wähle ein Team für deine Bewerbung aus')
            .addStringOption(option =>
                option.setName('team')
                    .setDescription('Wähle das Team für deine Bewerbung')
                    .setRequired(true)
                    .addChoices(
                        { name: 'Main (Asc–Immortal)', value: 'main' },
                        { name: 'Rising (Platin–Diamond)', value: 'rising' },
                        { name: 'Sun (Silber–Gold)', value: 'sun' },
                        { name: 'Moon (Silber–Gold)', value: 'moon' }
                    ))
            .toJSON(),
        
    ];
    await client.application.commands.set(data);
});

// Hilfsfunktion: Lösche alte Premier-Anmeldung
async function deletePremierMessage() {
    const channelId = interaction.channel.id;
    if (premierBoards[channelId]?.messageId) {
        try {
            const channel = await client.channels.fetch(premierBoards[channelId]?.channelId);
            const msg = await channel.messages.fetch(premierBoards[channelId]?.messageId);
            await msg.delete();
        } catch (e) {
            // Nachricht existiert nicht mehr oder Fehler ignorieren
        }
        premierBoards[channelId].messageId = null;
    }
}

// Premier-Anmeldung posten (neues Message-ID-basiertes System)
async function postPremierSignupWithDelete(channel, team = 'main') {
    const channelId = channel.id;
    
    // Lösche nur alte Premier-Nachrichten für das gleiche Team in diesem Channel
    for (const [messageId, board] of Object.entries(premierBoards)) {
        if (board.channelId === channelId && board.team === team) {
            try {
                const msg = await channel.messages.fetch(messageId);
                await msg.delete();
            } catch (e) {
                console.warn('Fehler beim Löschen der Premier-Nachricht:', e.message);
            }
            delete premierBoards[messageId];
            delete premierSignups[messageId];
        }
    }
    
    // Erstelle neue Premier-Nachricht
    const embed = await getSignupEmbed(client, client.user.id, null, team);
    const userId = getFirstSignedUpUserId() || client.user.id;
    const tempButtonRows = getButtonRow(userId, true); // Bot ist immer Admin
    const msg = await channel.send({ embeds: [embed], components: tempButtonRows });
    
    // Aktualisiere Embed mit Discord Message ID
    const embedWithId = await getSignupEmbed(client, client.user.id, msg.id, team);
    const buttonRowsWithId = getButtonRow(userId, true, msg.id);
    await msg.edit({ embeds: [embedWithId], components: buttonRowsWithId });
    
    // Speichere neue Board-Info per Message-ID
    premierBoards[msg.id] = {
        channelId: channelId,
        type: 'premier',
        team: team
    };
    
    // Initialisiere Signups für diese Message
    premierSignups[msg.id] = {};
    const config = getPremierConfig(team);
    for (const day of config.days) {
        premierSignups[msg.id][day] = [];
    }
    
    // Backup sofort speichern nach Nachrichtenerstellung
    saveSignupBackup();
}



// Hilfsfunktion: Gibt die Premier-Zeit für einen Tag zurück
function getPremierTime(day) {
    const timeIndex = premierConfig.days.indexOf(day);
    if (timeIndex >= 0 && premierConfig.times[timeIndex]) {
        const time = premierConfig.times[timeIndex];
        // Konvertiere 19:00 zu 19:00 bis 20:00 Uhr
        const hour = parseInt(time.split(':')[0]);
        const endHour = hour + 1;
        return `${time} bis ${endHour.toString().padStart(2, '0')}:00 Uhr`;
    }
    return '19:00 bis 20:00 Uhr';
}

// Index/Key-basierte Helfer
function getPremierTimeByKey(key) {
    const index = parseInt(String(key).split('_').pop(), 10);
    const time = premierConfig.times[index];
    const hour = parseInt((time || '19:00').split(':')[0]);
    const endHour = hour + 1;
    return `${time || '19:00'} bis ${endHour.toString().padStart(2, '0')}:00 Uhr`;
}

// Hilfsfunktion: Gibt die Practice-Zeit für einen Tag zurück
function getPracticeTime(day) {
    const timeIndex = practiceConfig.days.indexOf(day);
    if (timeIndex >= 0 && practiceConfig.times[timeIndex]) {
        const time = practiceConfig.times[timeIndex];
        // Konvertiere 19:00 zu 19:00 bis 20:00 Uhr
        const hour = parseInt(time.split(':')[0]);
        const endHour = hour + 1;
        return `${time} bis ${endHour.toString().padStart(2, '0')}:00 Uhr`;
    }
    return '19:00 bis 20:00 Uhr';
}

function getPracticeTimeByKey(key) {
    const index = parseInt(String(key).split('_').pop(), 10);
    const time = practiceConfig.times[index];
    const hour = parseInt((time || '19:00').split(':')[0]);
    const endHour = hour + 1;
    return `${time || '19:00'} bis ${endHour.toString().padStart(2, '0')}:00 Uhr`;
}

// Hilfsfunktion: Gibt die Premier-Zeit für einen spezifischen Tag zurück (für DM-Nachrichten)
function getPremierDayText(day) {
    const timeIndex = premierConfig.days.indexOf(day);
    const time = timeIndex >= 0 && premierConfig.times[timeIndex] ? premierConfig.times[timeIndex] : '19:00';
    return `${day}: ${time} Uhr`;
}

function getPremierDayTextByKey(key) {
    const index = parseInt(String(key).split('_').pop(), 10);
    const day = premierConfig.days[index];
    const time = premierConfig.times[index] || '19:00';
    return `${day}: ${time} Uhr`;
}

// Hilfsfunktion: Gibt die Practice-Zeit für einen spezifischen Tag zurück (für DM-Nachrichten)
function getPracticeDayText(day) {
    const timeIndex = practiceConfig.days.indexOf(day);
    const time = timeIndex >= 0 && practiceConfig.times[timeIndex] ? practiceConfig.times[timeIndex] : '19:00';
    return `${day}: ${time} Uhr`;
}

function getPracticeDayTextByKey(key) {
    const index = parseInt(String(key).split('_').pop(), 10);
    const day = practiceConfig.days[index];
    const time = practiceConfig.times[index] || '19:00';
    return `${day}: ${time} Uhr`;
}

// Tournament Helper-Funktionen
function getTournamentDayTextByKey(key) {
    const index = parseInt(String(key).split('_').pop(), 10);
    const date = tournamentConfig.dates[index];
    const time = tournamentConfig.times[index] || '19:00';
    const label = tournamentConfig.labels[index];
    return `${label}: ${date} um ${time} Uhr`;
}

function getTournamentTimeByKey(key) {
    const index = parseInt(String(key).split('_').pop(), 10);
    const time = tournamentConfig.times[index];
    const hour = parseInt((time || '19:00').split(':')[0]);
    const endHour = hour + 1;
    return `${time || '19:00'} bis ${endHour.toString().padStart(2, '0')}:00 Uhr`;
}

// Hilfsfunktion: Erstellt eine Liste der angemeldeten Spieler mit Discord-Namen
async function getPlayerListText(userIds) {
    const playerNames = [];
    for (const userId of userIds) {
        try {
            let name = userCache[userId];
            if (!name) {
                const user = await client.users.fetch(userId);
                name = user.username;
                userCache[userId] = name;
            }
            playerNames.push(name);
        } catch (e) {
            console.error(`Fehler beim Abrufen des Benutzers ${userId}:`, e);
            playerNames.push('Unbekannt');
        }
    }
    return playerNames.join(', ');
}

// Practice-Embed
// Anpassung: Eigener Name immer oben und fett
async function getPracticeSignupEmbed(client, viewerId = null, messageId = null, team = 'main') {
    // Erstelle Beschreibung mit Zeiten
    const teamName = team === 'academy' ? 'Academy-Team' : 'Main-Team';
    let description = `Anmeldung Practice (${teamName})! Maximal 5 Leute sind möglich pro Tag.\n`;
    
    // Slots bilden und nach Wochentag sortieren
    const slots = getPracticeSlots(team);
    const sortedSlots = slots.sort((a, b) => {
        let da = getDayIndex(a.day); if (da === 0) da = 7;
        let db = getDayIndex(b.day); if (db === 0) db = 7;
        return da - db;
    });
    
    // Füge Zeiten zur Beschreibung hinzu
    let timesText = '';
    sortedSlots.forEach(slot => {
        const time = slot.time || '19:00';
        timesText += `${slot.day}: ${time} Uhr `;
    });
    
    description += timesText;
    
    const embed = new EmbedBuilder()
        .setTitle('Practice Anmeldung')
        .setDescription(description)
        .setColor(0x00AE86);
    
    // Füge Discord Message ID hinzu wenn verfügbar
    if (messageId) {
        embed.setFooter({ text: `ID: ${messageId}` });
    }
    
    const fields = await Promise.all(sortedSlots.map(async (slot) => {
        const today = getGermanDate();
        const dayIndex = getDayIndex(slot.day);
        const currentDayIndex = today.getDay();
        let daysUntilNext = dayIndex - currentDayIndex;
        if (daysUntilNext < 0) daysUntilNext += 7;
        const targetDate = new Date(today);
        targetDate.setDate(today.getDate() + daysUntilNext);
        const dayWithDate = getDayWithDate(slot.day, targetDate);
        
        // Zeit aus der Konfiguration holen
        const time = slot.time || '19:00';
        
        // Sortiere: Eigener Eintrag (viewerId) immer oben
        const key = getPracticeKey(slot.index);
        // Verwende Message-ID-basierte Signups wenn verfügbar, sonst Fallback auf alte Struktur
        let ids = [];
        if (messageId && practiceSignups[messageId] && practiceSignups[messageId][slot.day]) {
            ids = [...practiceSignups[messageId][slot.day]];
        } else {
            // Fallback für alte Struktur
            ids = [...(practiceSignups[key] || [])];
        }
        if (viewerId && ids.includes(viewerId)) {
            ids = [viewerId, ...ids.filter(id => id !== viewerId)];
        }
        const usernames = await Promise.all(
            ids.map(async id => {
                let name = userCache[id] || null;
                if (!name) {
                    try {
                        const user = await client.users.fetch(id);
                        name = user.username;
                        userCache[id] = name;
                    } catch {
                        name = 'Unbekannt';
                    }
                }
                // Fett, wenn viewerId
                if (viewerId && id === viewerId) {
                    return `- **${name}**`;
                }
                return `- ${name}`;
            })
        );
        return {
            name: `**${dayWithDate}**`,
            value: usernames.length > 0 ? usernames.join('\n') : '-',
            inline: true
        };
    }));
    embed.addFields(fields);
    // --- NEU: Abwesenheiten nur anzeigen, wenn sie in der Woche des nächsten Practice-Tags liegen ---
    const shownWeeks = new Set();
    practiceConfig.days.forEach(day => {
        const today = getGermanDate();
        const dayIndex = getDayIndex(day);
        const currentDayIndex = today.getDay();
        let daysUntilNext = dayIndex - currentDayIndex;
        if (daysUntilNext < 0) daysUntilNext += 7;
        const targetDate = new Date(today);
        targetDate.setDate(today.getDate() + daysUntilNext);
        const { monday, sunday } = getWeekRange(targetDate);
        const mondayStr = `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, '0')}-${String(monday.getDate()).padStart(2, '0')}`;
        const sundayStr = `${sunday.getFullYear()}-${String(sunday.getMonth() + 1).padStart(2, '0')}-${String(sunday.getDate()).padStart(2, '0')}`;
        shownWeeks.add(mondayStr + '_' + sundayStr);
    });
    const abwesenheitenToShow = abwesenheiten.filter(abw => {
        return Array.from(shownWeeks).some(weekKey => {
            const [mondayStr, sundayStr] = weekKey.split('_');
            return abw.startDate <= sundayStr && abw.endDate >= mondayStr;
        });
    });
    if (abwesenheitenToShow.length > 0) {
        const abwesenheitenList = await Promise.all(
            abwesenheitenToShow.map(async abw => {
                let username = userCache[abw.userId] || 'Unbekannt';
                if (!userCache[abw.userId]) {
                    try {
                        const user = await client.users.fetch(abw.userId);
                        username = user.username;
                        userCache[abw.userId] = username;
                    } catch {
                        username = 'Unbekannt';
                    }
                }
                const startDate = new Date(abw.startDate);
                const endDate = new Date(abw.endDate);
                const startFormatted = formatDate(startDate) + '.' + startDate.getFullYear();
                const endFormatted = formatDate(endDate) + '.' + endDate.getFullYear();
                return `- ${username} (${startFormatted} - ${endFormatted})`;
            })
        );
        embed.addFields({
            name: '**Abwesend**',
            value: abwesenheitenList.join('\n'),
            inline: true
        });
    }
    return embed;
}
// Practice-ButtonRows
function getPracticeButtonRowsWithControls(userId, isAdmin = false, messageId = null) {
    const slots = getPracticeSlots();
    const sortedSlots = slots.sort((a, b) => {
        let da = getDayIndex(a.day); if (da === 0) da = 7;
        let db = getDayIndex(b.day); if (db === 0) db = 7;
        return da - db;
    });
    
    const addButtons = sortedSlots.map(slot =>
        new ButtonBuilder()
            .setCustomId(`practice_signup_${slot.index}`)
            .setLabel(`${slot.day} ${slot.time} +`)
            .setStyle(ButtonStyle.Success)
            .setDisabled(false)
    );
    const removeButtons = sortedSlots.map(slot =>
        new ButtonBuilder()
            .setCustomId(`practice_unsign_${slot.index}`)
            .setLabel(`${slot.day} ${slot.time} -`)
            .setStyle(ButtonStyle.Danger)
            .setDisabled(false)
    );
    
    const controlButtons = [
        new ButtonBuilder()
            .setCustomId(`practice_refresh_board${messageId ? `_${messageId}` : ''}`)
            .setLabel('Aktualisieren')
            .setEmoji('🔄')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('abwesend_modal')
            .setLabel('Abwesend')
            .setEmoji('📅')
            .setStyle(ButtonStyle.Secondary)
    ];


    return [
        new ActionRowBuilder().addComponents(...addButtons),
        new ActionRowBuilder().addComponents(...removeButtons),
        new ActionRowBuilder().addComponents(...controlButtons)
    ];
}

// Tournament-ButtonRows - mit Gruppen und Navigation
function getTournamentButtonRowsWithControls(userId, isAdmin = false, page = 0) {
    const currentGroup = tournamentConfig.groups[page];
    const totalPages = tournamentConfig.groups.length;
    
    // Buttons nur für aktuelle Gruppe
    const addButtons = currentGroup.indices.map(index => {
        const label = tournamentConfig.labels[index];
        return new ButtonBuilder()
            .setCustomId(`tournament_signup_${index}`)
            .setLabel(`${label} +`)
            .setStyle(ButtonStyle.Success)
            .setDisabled(false);
    });
    
    const removeButtons = currentGroup.indices.map(index => {
        const label = tournamentConfig.labels[index];
        return new ButtonBuilder()
            .setCustomId(`tournament_unsign_${index}`)
            .setLabel(`${label} -`)
            .setStyle(ButtonStyle.Danger)
            .setDisabled(false);
    });
    
    // Navigation Buttons
    const navButtons = [];
    if (page > 0) {
        navButtons.push(
            new ButtonBuilder()
                .setCustomId('tournament_prev_page')
                .setLabel('◀ Zurück')
                .setStyle(ButtonStyle.Secondary)
        );
    }
    if (page < totalPages - 1) {
        navButtons.push(
            new ButtonBuilder()
                .setCustomId('tournament_next_page')
                .setLabel('Weiter ▶')
                .setStyle(ButtonStyle.Secondary)
        );
    }
    
    const controlButtons = [
        new ButtonBuilder()
            .setCustomId('tournament_refresh_board')
            .setLabel('Aktualisieren')
            .setEmoji('🔄')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('abwesend_modal')
            .setLabel('Abwesend')
            .setEmoji('📅')
            .setStyle(ButtonStyle.Secondary)
    ];


    const rows = [
        new ActionRowBuilder().addComponents(...addButtons),
        new ActionRowBuilder().addComponents(...removeButtons)
    ];
    
    // Navigation Row (wenn nötig)
    if (navButtons.length > 0) {
        rows.push(new ActionRowBuilder().addComponents(...navButtons));
    }
    
    // Control Row
    rows.push(new ActionRowBuilder().addComponents(...controlButtons));
    
    return rows;
}

// Practice-Board posten (neues Message-ID-basiertes System)
async function postPracticeSignupWithDelete(channel, team = 'main') {
    const channelId = channel.id;
    
    // Lösche nur alte Practice-Nachrichten für das gleiche Team in diesem Channel
    for (const [messageId, board] of Object.entries(practiceBoards)) {
        if (board.channelId === channelId && board.team === team) {
            try {
                const msg = await channel.messages.fetch(messageId);
                await msg.delete();
            } catch (e) {
                console.warn('Fehler beim Löschen der Practice-Nachricht:', e.message);
            }
            delete practiceBoards[messageId];
            delete practiceSignups[messageId];
        }
    }
    
    // Erstelle neue Practice-Nachricht
    const embed = await getPracticeSignupEmbed(client, client.user.id, null, team);
    const userId = client.user.id;
    const tempButtonRows = getPracticeButtonRowsWithControls(userId, true); // Bot ist immer Admin
    const msg = await channel.send({ embeds: [embed], components: tempButtonRows });
    
    // Aktualisiere Embed mit Discord Message ID
    const embedWithId = await getPracticeSignupEmbed(client, client.user.id, msg.id, team);
    const buttonRowsWithId = getPracticeButtonRowsWithControls(userId, true, msg.id);
    await msg.edit({ embeds: [embedWithId], components: buttonRowsWithId });
    
    // Speichere neue Board-Info per Message-ID
    practiceBoards[msg.id] = {
        channelId: channelId,
        type: 'practice',
        team: team
    };
    
    // Initialisiere Signups für diese Message
    practiceSignups[msg.id] = {};
    const config = getPracticeConfig(team);
    for (const day of config.days) {
        practiceSignups[msg.id][day] = [];
    }
    
    // Backup sofort speichern nach Nachrichtenerstellung
    saveSignupBackup();
}

// Tournament-Embed - mit Gruppen und Navigation
async function getTournamentSignupEmbed(client, viewerId = null, page = 0, messageId = null, team = 'main') {
    const config = getTournamentConfig(team);
    const currentGroup = config.groups[page];
    const totalPages = config.groups.length;
    
    // Erstelle Beschreibung mit aktueller Gruppe
    let description = `🏆 **${currentGroup.name}** 🏆\nMaximal 5 Leute sind möglich pro Runde.\n**Jede Runde sendet automatisch DMs wenn 5 Spieler sich anmelden!**\n\n`;
    
    // Zeige nur Termine der aktuellen Gruppe
    let scheduleText = '**Termine dieser Phase:**\n';
    currentGroup.indices.forEach(index => {
        const date = tournamentConfig.dates[index];
        const time = tournamentConfig.times[index];
        const label = tournamentConfig.labels[index];
        scheduleText += `${label}: ${date} um ${time} Uhr\n`;
    });
    
    description += scheduleText;
    description += `\n📄 Seite ${page + 1} von ${totalPages}`;
    
    const embed = new EmbedBuilder()
        .setTitle('🏆 Turnier Anmeldung')
        .setDescription(description)
        .setColor(0xFFD700); // Goldfarbe für Turnier
    
    // Füge Discord Message ID hinzu wenn verfügbar
    if (messageId) {
        embed.setFooter({ text: `ID: ${messageId}` });
    }
    
    // Erstelle Fields nur für die aktuelle Gruppe
    const fields = await Promise.all(currentGroup.indices.map(async (index) => {
        const key = getTournamentKey(index);
        const date = tournamentConfig.dates[index];
        const time = tournamentConfig.times[index];
        const label = tournamentConfig.labels[index];
        
        // Verwende Message-ID-basierte Signups wenn verfügbar, sonst Fallback auf alte Struktur
        let userIds = [];
        if (messageId && tournamentSignups[messageId] && tournamentSignups[messageId][key]) {
            userIds = [...tournamentSignups[messageId][key]];
        } else {
            // Fallback für alte Struktur
            userIds = [...(tournamentSignups[key] || [])];
        }
        
        // Viewer an die erste Stelle setzen
        if (viewerId && userIds.includes(viewerId)) {
            userIds = [viewerId, ...userIds.filter(id => id !== viewerId)];
        }
        
        const usernames = await Promise.all(
            userIds.map(async id => {
                let name = userCache[id] || null;
                if (!name) {
                    try {
                        const user = await client.users.fetch(id);
                        name = user.username;
                        userCache[id] = name;
                    } catch {
                        name = 'Unbekannt';
                    }
                }
                if (viewerId && id === viewerId) {
                    return `- **${name}**`;
                }
                return `- ${name}`;
            })
        );
        
        const playerList = usernames.length > 0 ? usernames.join('\n') : '**-**';
        const countEmoji = usernames.length === 5 ? '✅' : '📋';
        
        return {
            name: `${countEmoji} ${label} (${date} ${time})`,
            value: playerList,
            inline: true
        };
    }));
    
    embed.addFields(...fields);
    
    // Abwesenheiten anzeigen
    const today = getGermanDate();
    const { monday, sunday } = getWeekRange(today);
    const mondayStr = `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, '0')}-${String(monday.getDate()).padStart(2, '0')}`;
    const sundayStr = `${sunday.getFullYear()}-${String(sunday.getMonth() + 1).padStart(2, '0')}-${String(sunday.getDate()).padStart(2, '0')}`;
    
    const abwesenheitenToShow = abwesenheiten.filter(abw => 
        abw.startDate <= sundayStr && abw.endDate >= mondayStr
    );
    
    if (abwesenheitenToShow.length > 0) {
        const abwesenheitenList = await Promise.all(
            abwesenheitenToShow.map(async abw => {
                let username = userCache[abw.userId] || 'Unbekannt';
                if (!userCache[abw.userId]) {
                    try {
                        const user = await client.users.fetch(abw.userId);
                        username = user.username;
                        userCache[abw.userId] = username;
                    } catch {
                        username = 'Unbekannt';
                    }
                }
                const startDate = new Date(abw.startDate);
                const endDate = new Date(abw.endDate);
                const startFormatted = formatDate(startDate) + '.' + startDate.getFullYear();
                const endFormatted = formatDate(endDate) + '.' + endDate.getFullYear();
                return `- ${username} (${startFormatted} - ${endFormatted})`;
            })
        );
        embed.addFields({
            name: '**Abwesend**',
            value: abwesenheitenList.join('\n'),
            inline: true
        });
    }
    return embed;
}

// Tournament-Board posten (neues Message-ID-basiertes System)
async function postTournamentSignupWithDelete(channel, team = 'main') {
    const channelId = channel.id;
    
    // Lösche nur alte Tournament-Nachrichten für das gleiche Team in diesem Channel
    for (const [messageId, board] of Object.entries(tournamentBoards)) {
        if (board.channelId === channelId && board.team === team) {
            try {
                const msg = await channel.messages.fetch(messageId);
                await msg.delete();
            } catch (e) {
                console.warn('Fehler beim Löschen der Tournament-Nachricht:', e.message);
            }
            delete tournamentBoards[messageId];
            delete tournamentSignups[messageId];
        }
    }
    
    // Regeneriere Tournament-Groups basierend auf aktueller Konfiguration
    const config = getTournamentConfig(team);
    config.groups = generateTournamentGroups(team);
    
    // Starte mit Seite 0
    const currentPage = 0;
    const embed = await getTournamentSignupEmbed(client, client.user.id, currentPage, null, team);
    const userId = client.user.id;
    const buttonRows = getTournamentButtonRowsWithControls(userId, true, currentPage); // Bot ist immer Admin
    const msg = await channel.send({ embeds: [embed], components: buttonRows });
    
    // Aktualisiere Embed mit Discord Message ID
    const embedWithId = await getTournamentSignupEmbed(client, client.user.id, currentPage, msg.id, team);
    await msg.edit({ embeds: [embedWithId], components: buttonRows });
    
    // Speichere neue Board-Info per Message-ID
    tournamentBoards[msg.id] = {
        channelId: channelId,
        page: currentPage,
        type: 'tournament',
        team: team
    };
    
    // Initialisiere Signups für diese Message
    tournamentSignups[msg.id] = {};
    for (let i = 0; i < config.dates.length; i++) {
        const key = getTournamentKey(i);
        tournamentSignups[msg.id][key] = [];
    }
    
    // Backup sofort speichern nach Nachrichtenerstellung
    saveSignupBackup();
}

// Scrim-Embed mit flexiblen Parametern (für unabhängige Boards)
async function getScrimSignupEmbed(client, viewerId = null, day = null, time = null, maxGames = null, messageId = null) {
    // Fallback auf Default-Config wenn keine Parameter übergeben
    const scrimDay = day || scrimConfig.day;
    const scrimTime = time || scrimConfig.time;
    const scrimMaxGames = maxGames || scrimConfig.maxGames;
    
    const embed = new EmbedBuilder()
        .setTitle(`Anmeldung Scrim am ${scrimDay} um ${scrimTime} Uhr!`)
        .setColor(0x00AE86);
    
    // Füge Discord Message ID hinzu wenn verfügbar
    if (messageId) {
        embed.setFooter({ text: `ID: ${messageId}` });
    }
    
    const today = getGermanDate();
    const dayIndex = getDayIndex(scrimDay);
    const currentDayIndex = today.getDay();
    let daysUntilNext = dayIndex - currentDayIndex;
    if (daysUntilNext < 0) daysUntilNext += 7;
    const targetDate = new Date(today);
    targetDate.setDate(today.getDate() + daysUntilNext);
    const dayWithDate = getDayWithDate(scrimDay, targetDate);
    
    // Ermittle Signups für diese spezifische Message
    let currentSignups = scrimSignups[messageId] || { game1: [] };
        if (!currentSignups || typeof currentSignups !== 'object') {
            currentSignups = { game1: [] };
    }
    
    // Erstelle ein einzelnes Feld mit allen Games nebeneinander
    let allGamesContent = '';
    for (let i = 1; i <= scrimMaxGames; i++) {
        const gameKey = `game${i}`;
        if (!currentSignups[gameKey]) currentSignups[gameKey] = [];
        
        let gameIds = [...currentSignups[gameKey]];
        if (viewerId && gameIds.includes(viewerId)) {
            gameIds = [viewerId, ...gameIds.filter(id => id !== viewerId)];
        }
        
        const gameUsernames = await Promise.all(
            gameIds.map(async id => {
                let name = userCache[id] || null;
                if (!name) {
                    try {
                        const user = await client.users.fetch(id);
                        name = user.username;
                        userCache[id] = name;
                    } catch {
                        name = 'Unbekannt';
                    }
                }
                if (viewerId && id === viewerId) {
                    return `- **${name}**`;
                }
                return `- ${name}`;
            })
        );
        
        const gameContent = gameUsernames.length > 0 ? gameUsernames.join('\n') : '**-**';
        allGamesContent += `**Game ${i}**\n${gameContent}\n\n`;
    }
    
    embed.addFields({
        name: '\u200b', // Unsichtbares Zeichen
        value: allGamesContent.trim(),
        inline: false
    });
    
    // Abwesenheiten anzeigen
    const { monday, sunday } = getWeekRange(targetDate);
    const mondayStr = `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, '0')}-${String(monday.getDate()).padStart(2, '0')}`;
    const sundayStr = `${sunday.getFullYear()}-${String(sunday.getMonth() + 1).padStart(2, '0')}-${String(sunday.getDate()).padStart(2, '0')}`;
    
    const abwesenheitenToShow = abwesenheiten.filter(abw => 
        abw.startDate <= sundayStr && abw.endDate >= mondayStr
    );
    
    if (abwesenheitenToShow.length > 0) {
        const abwesenheitenList = await Promise.all(
            abwesenheitenToShow.map(async abw => {
                let username = userCache[abw.userId] || 'Unbekannt';
                if (!userCache[abw.userId]) {
                    try {
                        const user = await client.users.fetch(abw.userId);
                        username = user.username;
                        userCache[abw.userId] = username;
                    } catch {
                        username = 'Unbekannt';
                    }
                }
                const startDate = new Date(abw.startDate);
                const endDate = new Date(abw.endDate);
                const startFormatted = formatDate(startDate) + '.' + startDate.getFullYear();
                const endFormatted = formatDate(endDate) + '.' + endDate.getFullYear();
                return `- ${username} (${startFormatted} - ${endFormatted})`;
            })
        );
        embed.addFields({
            name: '**Abwesend**',
            value: abwesenheitenList.join('\n'),
            inline: true
        });
    }
    
    return embed;
}
// Scrim-ButtonRows für dynamische Games (mit Message-spezifischen Parametern)
function getScrimButtonRowsWithControls(userId, isAdmin = false, maxGames = null, messageId = null) {
    const rows = [];
    const scrimMaxGames = maxGames || scrimConfig.maxGames;
    
    // Erste Reihe: Signup Buttons (max 4 pro Reihe + All Button)
    const signupRow = new ActionRowBuilder();
    for (let i = 1; i <= Math.min(scrimMaxGames, 4); i++) {
        signupRow.addComponents(
            new ButtonBuilder()
                .setCustomId(`scrim_signup_game${i}${messageId ? `_${messageId}` : ''}`)
                .setLabel(`Game ${i} +`)
                .setStyle(ButtonStyle.Success)
                .setDisabled(false)
        );
    }
    // All Games Button (nur wenn Platz ist und nicht mehr als 4 Games)
    if (scrimMaxGames <= 4) {
        signupRow.addComponents(
            new ButtonBuilder()
                .setCustomId(`scrim_signup_all${messageId ? `_${messageId}` : ''}`)
                .setLabel(`All Games +`)
                .setStyle(ButtonStyle.Success)
                .setDisabled(false)
        );
    }
    rows.push(signupRow);
    
    // Zweite Reihe: Restliche Signup Buttons (falls mehr als 4 Games)
    if (scrimMaxGames > 4) {
        const signupRow2 = new ActionRowBuilder();
        for (let i = 5; i <= scrimMaxGames; i++) {
            signupRow2.addComponents(
                new ButtonBuilder()
                    .setCustomId(`scrim_signup_game${i}${messageId ? `_${messageId}` : ''}`)
                    .setLabel(`Game ${i} +`)
                    .setStyle(ButtonStyle.Success)
                    .setDisabled(false)
            );
        }
        // All Games Button (wenn Platz ist)
        if (scrimMaxGames <= 5) {
        signupRow2.addComponents(
            new ButtonBuilder()
                    .setCustomId(`scrim_signup_all${messageId ? `_${messageId}` : ''}`)
                .setLabel(`All Games +`)
                .setStyle(ButtonStyle.Success)
                .setDisabled(false)
        );
        }
        rows.push(signupRow2);
    }
    
    // Dritte Reihe: Unsign Buttons (max 4 pro Reihe + Clear All)
    const unsignRow = new ActionRowBuilder();
    for (let i = 1; i <= Math.min(scrimMaxGames, 4); i++) {
        unsignRow.addComponents(
            new ButtonBuilder()
                .setCustomId(`scrim_unsign_game${i}${messageId ? `_${messageId}` : ''}`)
                .setLabel(`Game ${i} -`)
                .setStyle(ButtonStyle.Danger)
                .setDisabled(false)
        );
    }
    // Clear All Button (nur wenn Platz ist und nicht mehr als 4 Games)
    if (scrimMaxGames <= 4) {
        unsignRow.addComponents(
            new ButtonBuilder()
                .setCustomId(`scrim_unsign_all${messageId ? `_${messageId}` : ''}`)
                .setLabel(`Clear All`)
                .setStyle(ButtonStyle.Danger)
                .setDisabled(false)
        );
    }
    rows.push(unsignRow);
    
    // Vierte Reihe: Restliche Unsign Buttons (falls mehr als 4 Games)
    if (scrimMaxGames > 4) {
        const unsignRow2 = new ActionRowBuilder();
        for (let i = 5; i <= scrimMaxGames; i++) {
            unsignRow2.addComponents(
                new ButtonBuilder()
                    .setCustomId(`scrim_unsign_game${i}${messageId ? `_${messageId}` : ''}`)
                    .setLabel(`Game ${i} -`)
                    .setStyle(ButtonStyle.Danger)
                    .setDisabled(false)
            );
        }
        // Clear All Button (wenn Platz ist)
        if (scrimMaxGames <= 5) {
        unsignRow2.addComponents(
            new ButtonBuilder()
                    .setCustomId(`scrim_unsign_all${messageId ? `_${messageId}` : ''}`)
                .setLabel(`Clear All`)
                .setStyle(ButtonStyle.Danger)
                .setDisabled(false)
        );
        }
        rows.push(unsignRow2);
    }
    
    // Letzte Reihe: Refresh, Abwesend und Delete Button (Delete nur für Admins)
    const controlButtons = [
            new ButtonBuilder()
            .setCustomId(`scrim_refresh_board${messageId ? `_${messageId}` : ''}`)
                .setLabel('Aktualisieren')
                .setEmoji('🔄')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('abwesend_modal')
            .setLabel('Abwesend')
            .setEmoji('📅')
                .setStyle(ButtonStyle.Secondary)
        ,
        new ButtonBuilder()
            .setCustomId(`scrim_cancel${messageId ? `_${messageId}` : ''}`)
            .setLabel('Absagen')
            .setEmoji('❌')
            .setStyle(ButtonStyle.Secondary)
    ];


    rows.push(new ActionRowBuilder().addComponents(...controlButtons));
    
    return rows;
}

// Helper function to check if user is admin (async)
async function checkUserAdminStatus(userId, guildId) {
    try {
        if (!guildId || !userId) return false;
        const guild = client.guilds.cache.get(guildId);
        if (!guild) return false;
        const member = await guild.members.fetch(userId);
        return await hasAdminPermissions(member);
    } catch (error) {
        console.error('Fehler beim Prüfen des Admin-Status:', error);
        return false;
    }
}

// ===== WOCHEN-SCRIM SYSTEM =====
const WEEKDAYS = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];

// Initialize weekly scrim data structure
function initializeWochenScrimData(messageId, style, defaultTime, maxGames, specificDay = null, exception = null) {
    wochenScrimData[messageId] = {
        style: style,
        currentPage: 0,
        maxGames: maxGames,
        days: {},
        originalTimes: {}, // Store original times for weekly reset
        weekStartDate: null, // Track when current week started
        groupId: null, // For multi-message scrims, track which group this belongs to
        exceptions: {} // Store exceptions per day { day: { time: '19:00', description: 'Sondertermin' } }
    };
    
    // For single_message, only initialize the specific day
    const daysToInit = specificDay ? [specificDay] : WEEKDAYS;
    
    for (const day of daysToInit) {
        wochenScrimData[messageId].days[day] = {
            players: [],
            subs: [],
            time: defaultTime,
            timeChangeRequests: []
        };
        // Store original time for weekly reset
        wochenScrimData[messageId].originalTimes[day] = defaultTime;
    }
    
    // Set exception if provided
    if (exception && exception.day && exception.time) {
        wochenScrimData[messageId].exceptions[exception.day] = {
            time: exception.time,
            description: exception.description || null
        };
        
        // If the exception day exists in days, update its time
        if (wochenScrimData[messageId].days[exception.day]) {
            wochenScrimData[messageId].days[exception.day].time = exception.time;
        }
    }
    
    // Set week start date
    wochenScrimData[messageId].weekStartDate = getWeekStartDate();
    
    return wochenScrimData[messageId];
}

// Helper function to get week start date (Monday)
function getWeekStartDate() {
    const today = new Date();
    const dayOfWeek = today.getDay(); // 0 = Sunday, 1 = Monday, etc.
    const monday = new Date(today);
    monday.setDate(today.getDate() - ((dayOfWeek + 6) % 7)); // Go back to Monday
    monday.setHours(0, 0, 0, 0);
    return monday;
}

// Helper function to get next date for a weekday
function getNextDateForWeekday(weekdayName) {
    const today = new Date();
    const targetDayIndex = WEEKDAYS.indexOf(weekdayName);
    const currentDayIndex = (today.getDay() + 6) % 7; // Convert Sunday=0 to Monday=0
    
    let daysUntil = targetDayIndex - currentDayIndex;
    if (daysUntil < 0) daysUntil += 7; // Next week if already passed
    
    const targetDate = new Date(today);
    targetDate.setDate(today.getDate() + daysUntil);
    
    const day = String(targetDate.getDate()).padStart(2, '0');
    const month = String(targetDate.getMonth() + 1).padStart(2, '0');
    const year = targetDate.getFullYear();
    
    return `${day}.${month}.${year}`;
}


// Neue Funktion: Findet Sonntag-Scrim-Zeit für eine Gruppe
function findSundayScrimTime(groupId, messageId) {
    // Prüfe erst ob es ein wochen_scrim (1 Message) ist
    const singleData = wochenScrimData[messageId];
    if (singleData && singleData.style === 'wochen_scrim') {
        // Single Message mit 7 Seiten
        const sundayDay = WEEKDAYS[6]; // "Sonntag"
        
        if (!singleData.days || !singleData.days[sundayDay]) return null;
        
        const scrimTime = singleData.days[sundayDay].time;
        if (!scrimTime) return null;
        
        const [hours, minutes] = scrimTime.split(':').map(Number);
        const weekStart = new Date(singleData.weekStartDate);
        const sundayDate = new Date(weekStart);
        sundayDate.setDate(weekStart.getDate() + 6); // Sonntag ist 6 Tage nach Montag
        sundayDate.setHours(hours, minutes, 0, 0);
        
        return sundayDate;
    }
    
    // Finde alle Messages dieser Gruppe (wochen_scrim_multi)
    const groupMessages = Object.entries(wochenScrimData).filter(([id, data]) => 
        data.style === 'wochen_scrim_multi' && data.groupId === groupId
    );
    
    if (groupMessages.length === 0) return null;
    
    // Finde Sonntag-Message (Index 6 = Sonntag)
    const sundayMessage = groupMessages.find(([id, data]) => data.currentPage === 6);
    
    if (!sundayMessage) return null;
    
    const [msgId, data] = sundayMessage;
    const sundayDay = WEEKDAYS[6]; // "Sonntag"
    
    if (!data.days || !data.days[sundayDay]) return null;
    
    // Hole aktuelle Zeit (mit Zeit-Änderungen)
    const scrimTime = data.days[sundayDay].time;
    
    if (!scrimTime) return null;
    
    // Parse Zeit (Format: "19:00")
    const [hours, minutes] = scrimTime.split(':').map(Number);
    
    // Erstelle Datum für diesen Sonntag
    const weekStart = new Date(data.weekStartDate);
    const sundayDate = new Date(weekStart);
    sundayDate.setDate(weekStart.getDate() + 6); // Sonntag ist 6 Tage nach Montag
    sundayDate.setHours(hours, minutes, 0, 0);
    
    return sundayDate;
}

// Neue Funktion: Prüft ob Wochen-Scrim resettet werden soll (1h nach Sonntag-Scrim)
function shouldResetWeeklyScrim(messageId) {
    const data = wochenScrimData[messageId];
    
    if (!data) return false;
    
    // Nur für Wochen-Scrims (nicht für single_message, da diese nur einen Tag haben)
    if (data.style === 'single_message') return false;
    
    // Für wochen_scrim (1 Message mit Seiten) und wochen_scrim_multi (7 Messages)
    const groupId = data.style === 'wochen_scrim_multi' ? data.groupId : messageId;
    
    // Finde Sonntag-Scrim-Zeit (übergebe auch messageId für wochen_scrim)
    const sundayScrimTime = findSundayScrimTime(groupId, messageId);
    
    if (!sundayScrimTime) return false;
    
    // Berechne 1 Stunde nach Sonntag-Scrim
    const resetTime = new Date(sundayScrimTime);
    resetTime.setHours(resetTime.getHours() + 1);
    
    const now = new Date();
    
    // Prüfe ob wir nach dem Reset-Zeitpunkt sind
    if (now < resetTime) return false;
    
    // Sicherheits-Logik: Prüfe ob bereits diese Woche resettet wurde
    // Verwende die Woche als Identifier (ISO Week)
    const getWeekIdentifier = (date) => {
        const d = new Date(date);
        const dayNum = d.getUTCDay() || 7;
        d.setUTCDate(d.getUTCDate() + 4 - dayNum);
        const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
        return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
    };
    
    const currentWeek = getWeekIdentifier(now);
    const currentYear = now.getFullYear();
    const weekId = `${currentYear}-W${currentWeek}`;
    
    // Prüfe ob bereits resettet
    if (data.lastResetWeek === weekId) {
        return false; // Bereits diese Woche resettet
    }
    
    return true; // Reset durchführen
}

// Function to reset weekly scrim data for next week
async function resetWeeklyScrimData(messageId) {
    if (!wochenScrimData[messageId]) return;
    
    const data = wochenScrimData[messageId];
    
    // Only reset if it's a 7-page scrim or 7-message scrim (not single)
    if (data.style === 'wochen_scrim' || data.style === 'wochen_scrim_multi') {
        if (data.style === 'wochen_scrim_multi') {
            // For multi-message scrims, reset all messages in the group
            const multiMessages = Object.keys(wochenScrimData).filter(id => 
                wochenScrimData[id].style === 'wochen_scrim_multi' && 
                wochenScrimData[id].groupId === data.groupId
            );
            
            for (const msgId of multiMessages) {
                const msgData = wochenScrimData[msgId];
                // Safety check: ensure msgData.days exists
                if (!msgData || !msgData.days) continue;
                
                // Reset all player registrations
                for (const day in msgData.days) {
                    // Safety check: ensure msgData.days[day] exists
                    if (!msgData.days[day]) continue;
                    
                    msgData.days[day].players = [];
                    msgData.days[day].subs = [];
                    msgData.days[day].timeChangeRequests = [];
                    
                    // Reset time to exception time if exists, otherwise to original time
                    if (msgData.exceptions && msgData.exceptions[day] && msgData.exceptions[day].time) {
                        msgData.days[day].time = msgData.exceptions[day].time;
                    } else {
                        msgData.days[day].time = msgData.originalTimes[day];
                    }
                }
                
                // Update week start date
                msgData.weekStartDate = getWeekStartDate();
            }
        } else {
            // For single-message scrims, reset normally
            // Safety check: ensure data.days exists
            if (!data.days) {
                console.warn(`Wochen-Scrim ${messageId}: data.days fehlt, kann nicht zurücksetzen.`);
                return;
            }
            
            // Reset all player registrations
            for (const day in data.days) {
                // Safety check: ensure data.days[day] exists
                if (!data.days[day]) continue;
                
                data.days[day].players = [];
                data.days[day].subs = [];
                data.days[day].timeChangeRequests = [];
                
                // Reset time to exception time if exists, otherwise to original time
                if (data.exceptions && data.exceptions[day] && data.exceptions[day].time) {
                    data.days[day].time = data.exceptions[day].time;
                } else {
                    data.days[day].time = data.originalTimes[day];
                }
            }
            
            // Update week start date
            data.weekStartDate = getWeekStartDate();
        }
        
        // Update message display to show next week
        try {
            if (data.style === 'wochen_scrim') {
                // Single message with pages - update current page
                const channel = await client.channels.fetch(scrimBoards[messageId]?.channelId);
                if (channel) {
                    const message = await channel.messages.fetch(messageId);
                    const embed = await getWochenScrimEmbed(messageId, data.currentPage);
                    const buttons = getWochenScrimButtons(messageId, data.currentPage);
                    await message.edit({ embeds: [embed], components: buttons });
                    console.log(`Scrim message ${messageId} updated for new week`);
                }
            } else if (data.style === 'wochen_scrim_multi') {
                // Multiple messages - update all 7 messages
                // Find all messages that belong to this multi-scrim group
                const multiMessages = Object.keys(wochenScrimData).filter(id => 
                    wochenScrimData[id].style === 'wochen_scrim_multi' && 
                    wochenScrimData[id].groupId === data.groupId
                );
                
                for (const dayMessageId of multiMessages) {
                    const dayData = wochenScrimData[dayMessageId];
                    const dayIndex = dayData.currentPage;
                    
                    try {
                        const channel = await client.channels.fetch(scrimBoards[dayMessageId]?.channelId);
                        if (channel) {
                            const message = await channel.messages.fetch(dayMessageId);
                            const embed = await getWochenScrimEmbed(dayMessageId, dayIndex);
                            const buttons = getWochenScrimButtons(dayMessageId, dayIndex);
                            await message.edit({ embeds: [embed], components: buttons });
                            console.log(`Scrim message ${dayMessageId} (${WEEKDAYS[dayIndex]}) updated for new week`);
                        }
                    } catch (error) {
                        console.error(`Error updating multi-scrim message ${dayMessageId}:`, error);
                    }
                }
            }
        } catch (error) {
            console.error(`Error updating scrim message ${messageId}:`, error);
        }
        
        console.log(`Weekly reset completed for scrim ${messageId}`);
        return true;
    }
    
    return false;
}

// Get embed for a specific day in weekly scrim
async function getWochenScrimEmbed(messageId, dayIndex, specificDay = null) {
    const data = wochenScrimData[messageId];
    if (!data) return null;
    
    const day = specificDay || WEEKDAYS[dayIndex];
    const dayData = data.days[day];
    if (!dayData) return null;
    
    const maxGames = data.maxGames || 1;
    const dateStr = getNextDateForWeekday(day);
    
    // Check if there's an exception for this day
    const hasException = data.exceptions && data.exceptions[day];
    const exceptionDescription = hasException && data.exceptions[day].description 
        ? data.exceptions[day].description 
        : null;
    
    // Build larger description with more spacing
    const descriptionParts = [
        ``,
        `🕐 **Uhrzeit:** ${dayData.time} Uhr`
    ];
    
    // Add exception description if it exists
    if (hasException && exceptionDescription) {
        descriptionParts.push(`🔔 **Hinweis: ${exceptionDescription}**`);
    }
    
    // Add games info only if no exception exists
    if (!hasException) {
        descriptionParts.push(`🎮 **Games:** ${maxGames}`);
    }
    
    descriptionParts.push(
        `👥 **Anmeldungen:** ${dayData.players.length}/5 Spieler` + (dayData.subs.length > 0 ? ` + ${dayData.subs.length} Sub${dayData.subs.length > 1 ? 's' : ''}` : ''),
        ``,
        `━━━━━━━━━━━━━━━━━━━━`
    );
    
    const description = descriptionParts.join('\n');
    
    const embed = new EmbedBuilder()
        .setTitle(`📅 ${day} (${dateStr})`)
        .setColor(hasException ? '#FFA500' : '#00FF00') // Orange if exception, green otherwise
        .setDescription(description)
        .setFooter({ text: specificDay ? `Single Message` : `Seite ${dayIndex + 1}/7` });
    
    // Show main players with empty slots
    const playerList = [];
    for (let i = 0; i < 5; i++) {
        if (i < dayData.players.length) {
            const userId = dayData.players[i];
            try {
                const displayName = await getDisplayName(userId);
                playerList.push(`✅ **${i + 1}.** ${displayName}`);
            } catch (error) {
                playerList.push(`✅ **${i + 1}.** Unbekannt`);
            }
        } else {
            playerList.push(`**${i + 1}.** _Frei_`);
        }
    }
    
    embed.addFields({ 
        name: '👥 Hauptspieler', 
        value: playerList.join('\n') + '\n\u200B', 
        inline: false 
    });
    
    // Show subs
    if (dayData.subs && dayData.subs.length > 0) {
        const subList = [];
        for (let i = 0; i < dayData.subs.length; i++) {
            const userId = dayData.subs[i];
            try {
                const displayName = await getDisplayName(userId);
                subList.push(`🔄 **${i + 1}.** ${displayName}`);
            } catch (error) {
                subList.push(`🔄 **${i + 1}.** Unbekannt`);
            }
        }
        const subTitle = dayData.subs.length === 1 ? '🔄 Ersatzspieler' : '🔄 Ersatzspieler';
        embed.addFields({ name: subTitle, value: subList.join('\n') + '\n\u200B', inline: false });
    }
    
    // Add absences section if there are any absences for this day
    const today = getGermanDate();
    const targetDayIndex = getDayIndex(day);
    const currentDayIndex = today.getDay();
    let daysUntilNext = targetDayIndex - currentDayIndex;
    if (daysUntilNext < 0) daysUntilNext += 7;
    const targetDate = new Date(today);
    targetDate.setDate(today.getDate() + daysUntilNext);
    const targetDateStr = `${targetDate.getFullYear()}-${String(targetDate.getMonth() + 1).padStart(2, '0')}-${String(targetDate.getDate()).padStart(2, '0')}`;
    
    // Find absences that overlap with this day
    const abwesenheitenForDay = abwesenheiten.filter(abw => {
        return abw.startDate <= targetDateStr && abw.endDate >= targetDateStr;
    });
    
    if (abwesenheitenForDay.length > 0) {
        const abwesenheitenList = await Promise.all(
            abwesenheitenForDay.map(async abw => {
                let username = userCache[abw.userId] || null;
                if (!username) {
                    try {
                        const user = await client.users.fetch(abw.userId);
                        username = user.username;
                        userCache[abw.userId] = username;
                    } catch {
                        username = 'Unbekannt';
                    }
                }
                const startDate = new Date(abw.startDate);
                const endDate = new Date(abw.endDate);
                const startFormatted = formatDate(startDate) + '.' + startDate.getFullYear();
                const endFormatted = formatDate(endDate) + '.' + endDate.getFullYear();
                return `📅 ${username} (${startFormatted} - ${endFormatted})`;
            })
        );
        
        embed.addFields({ 
            name: '━━━━━━━━━━━━━━━━━━━━', 
            value: '\u200B', 
            inline: false 
        });
        
        embed.addFields({ 
            name: 'Abwesendheit:', 
            value: abwesenheitenList.join('\n'), 
            inline: false 
        });
    }
    
    return embed;
}

// Get buttons for weekly scrim (with navigation)
function getWochenScrimButtons(messageId, dayIndex) {
    const data = wochenScrimData[messageId];
    if (!data) return [];
    
    const day = WEEKDAYS[dayIndex];
    const dayData = data.days[day];
    
    // Registration buttons (Mobile-optimized: shorter labels)
    // Button is never disabled - after 5 players, users become subs
    const registerButton = new ButtonBuilder()
        .setCustomId(`wochen_scrim_signup_${messageId}_${dayIndex}`)
        .setLabel('+ Eintragen')
        .setStyle(ButtonStyle.Success);
    
    const unregisterButton = new ButtonBuilder()
        .setCustomId(`wochen_scrim_unsign_${messageId}_${dayIndex}`)
        .setLabel('- Austragen')
        .setStyle(ButtonStyle.Danger);
    
    const zeitChangeButton = new ButtonBuilder()
        .setCustomId(`wochen_scrim_zeitchange_${messageId}_${dayIndex}`)
        .setLabel('⏰ Zeit')
        .setStyle(ButtonStyle.Secondary);
    
    const abwesendButton = new ButtonBuilder()
        .setCustomId('abwesend_modal')
        .setLabel('📅 Abwesend')
        .setStyle(ButtonStyle.Secondary);
    
    const warnungenButton = new ButtonBuilder()
        .setCustomId(`wochen_scrim_verwarnungen_${messageId}_${dayIndex}`)
        .setLabel('⚠️ Verwarnungen ⚠️')
        .setStyle(ButtonStyle.Secondary);
    
    const refreshButton = new ButtonBuilder()
        .setCustomId(`wochen_scrim_refresh_${messageId}_${dayIndex}`)
        .setLabel('Aktualisieren')
        .setEmoji('🔄')
        .setStyle(ButtonStyle.Secondary);
    
    const rows = [];
    
    // Row 1: Register/Unregister
    rows.push(new ActionRowBuilder().addComponents(registerButton, unregisterButton));
    
    // Row 2: Zeit + Abwesend + Verwarnungen
    rows.push(new ActionRowBuilder().addComponents(zeitChangeButton, abwesendButton, warnungenButton));
    
    // Row 3: Refresh Button
    rows.push(new ActionRowBuilder().addComponents(refreshButton));
    
    // Row 3: Navigation buttons (only for multi-page style)
    if (data.style === 'wochen_scrim') {
        const navRow = new ActionRowBuilder();
        
        if (dayIndex > 0) {
            navRow.addComponents(
                new ButtonBuilder()
                    .setCustomId(`wochen_scrim_prev_${messageId}`)
                    .setLabel('◀')
                    .setStyle(ButtonStyle.Secondary)
            );
        }
        
        if (dayIndex < WEEKDAYS.length - 1) {
            navRow.addComponents(
                new ButtonBuilder()
                    .setCustomId(`wochen_scrim_next_${messageId}`)
                    .setLabel('▶')
                    .setStyle(ButtonStyle.Secondary)
            );
        }
        
        // Only add navigation row if there are buttons
        if (navRow.components.length > 0) {
            rows.push(navRow);
        }
    }
    
    return rows;
}

// Post weekly scrim (single or multiple messages)
async function postWochenScrim(channel, style, defaultTime, maxGames, specificDay = null, exception = null) {
    const messages = [];
    
    if (style === 'single_message') {
        // Single message for ONE specific day
        if (!specificDay) {
            throw new Error('specificDay is required for single_message style');
        }
        
        const msg = await channel.send({ 
            content: 'Lade Scrim...', 
            components: [] 
        });
        
        initializeWochenScrimData(msg.id, style, defaultTime, maxGames, specificDay, exception);
        
        // Register in scrimBoards
        scrimBoards[msg.id] = {
            channelId: channel.id,
            day: specificDay,
            time: defaultTime,
            maxGames: maxGames
        };
        
        // Initialize scrimSignups for this message
        if (!scrimSignups[msg.id]) {
            scrimSignups[msg.id] = {};
            for (let g = 1; g <= maxGames; g++) {
                scrimSignups[msg.id][`game${g}`] = [];
            }
        }
        
        const dayIndex = WEEKDAYS.indexOf(specificDay);
        const embed = await getWochenScrimEmbed(msg.id, dayIndex, specificDay);
        const buttons = getWochenScrimButtons(msg.id, dayIndex);
        
        await msg.edit({ 
            content: '', 
            embeds: [embed], 
            components: buttons 
        });
        
        messages.push(msg);
    } else if (style === 'wochen_scrim') {
        // Single message with pages (7 days)
        const msg = await channel.send({ 
            content: 'Lade Wochen-Scrim...', 
            components: [] 
        });
        
        initializeWochenScrimData(msg.id, style, defaultTime, maxGames, null, exception);
        
        // Register in scrimBoards (use first day for compatibility)
        scrimBoards[msg.id] = {
            channelId: channel.id,
            day: WEEKDAYS[0],
            time: defaultTime,
            maxGames: maxGames
        };
        
        // Initialize scrimSignups for this message
        if (!scrimSignups[msg.id]) {
            scrimSignups[msg.id] = {};
            for (let g = 1; g <= maxGames; g++) {
                scrimSignups[msg.id][`game${g}`] = [];
            }
        }
        
        const embed = await getWochenScrimEmbed(msg.id, 0);
        const buttons = getWochenScrimButtons(msg.id, 0);
        
        await msg.edit({ 
            content: '', 
            embeds: [embed], 
            components: buttons 
        });
        
        messages.push(msg);
    } else if (style === 'wochen_scrim_multi') {
        // Multiple messages (one per day)
        const tempMsg = await channel.send({ content: 'Erstelle Wochen-Scrim Messages...' });
        const tempId = tempMsg.id;
        initializeWochenScrimData(tempId, style, defaultTime, maxGames, null, exception);
        
        // Generate a unique group ID for this multi-message scrim
        const groupId = `multi_${Date.now()}`;
        wochenScrimData[tempId].groupId = groupId;
        
        for (let i = 0; i < WEEKDAYS.length; i++) {
            const msg = await channel.send({ 
                content: 'Lade...', 
                components: [] 
            });
            
            // Copy data to new message ID
            wochenScrimData[msg.id] = JSON.parse(JSON.stringify(wochenScrimData[tempId]));
            wochenScrimData[msg.id].currentPage = i;
            wochenScrimData[msg.id].groupId = groupId;
            
            // Register in scrimBoards for channel tracking
            scrimBoards[msg.id] = {
                channelId: channel.id,
                day: WEEKDAYS[i],
                time: defaultTime,
                maxGames: maxGames
            };
            
            // Initialize scrimSignups for this message
            if (!scrimSignups[msg.id]) {
                scrimSignups[msg.id] = {};
                for (let g = 1; g <= maxGames; g++) {
                    scrimSignups[msg.id][`game${g}`] = [];
                }
            }
            
            const embed = await getWochenScrimEmbed(msg.id, i);
            const buttons = getWochenScrimButtons(msg.id, i);
            
            await msg.edit({ 
                content: '', 
                embeds: [embed], 
                components: buttons 
            });
            
            messages.push(msg);
            
            // Sofort nach jeder Message speichern, um Datenverlust zu vermeiden
            saveSignupBackup();
        }
        
        // Delete temp message and data
        await tempMsg.delete();
        delete wochenScrimData[tempId];
        saveSignupBackup(); // Final save after cleanup
    }
    
    saveSignupBackup();
    return messages;
}

// Funktion zum Löschen von Scrim-Nachrichten (jetzt per Message-ID)
async function deleteScrimMessage(messageId) {
    if (scrimBoards[messageId]) {
        try {
            const channel = await client.channels.fetch(scrimBoards[messageId].channelId);
            const msg = await channel.messages.fetch(messageId);
            await msg.delete();
            delete scrimBoards[messageId];
            delete scrimSignups[messageId];
            console.log(`Scrim-Nachricht ${messageId} wurde gelöscht`);
        } catch (error) {
            console.error('Fehler beim Löschen der Scrim-Nachricht:', error);
            // Auch bei Fehler das Board aus dem Cache entfernen
            delete scrimBoards[messageId];
            delete scrimSignups[messageId];
        }
    }
}

// --- PATCH: Sende DM sofort, wenn 5 Spieler eingetragen sind ---
async function sendPremierFoundDMByKey(key) {
    const now = Date.now();
    const status = premierDMStatus[key];
    if (now - status.lastFound < 60 * 60 * 1000) {
        // Spam-Schutz aktiv: pending setzen und Timer starten, falls nicht schon gesetzt
        status.pendingFound = true;
        if (!status.foundTimeout) {
            status.foundTimeout = setTimeout(async () => {
                if (status.pendingFound) {
                    status.pendingFound = false;
                    status.lastFound = Date.now();
                    const data = signups[key];
                    if (data.length === 5) {
                        for (const userId of data) {
                            const dayText = getPremierDayTextByKey(key);
                            const playerList = await getPlayerListText(data);
                            const user = await client.users.fetch(userId);
                            const message = `\`\`\`\nHey ${user.username}, es haben sich 5 Spieler gefunden (${getPremierTimeByKey(key)}).\n\nAktueller Premier-Tag: ${dayText}\n\nAktuelle Spieler: ${playerList}\n\nBitte sei pünktlich und finde dich bitte 30 Minuten bis 1 Stunde vorher ein!\n\`\`\``;
                            await sendProtectedDM(userId, message, `Premier Found ${key}`);
                        }
                    }
                }
                status.foundTimeout = null;
            }, 60 * 60 * 1000 - (now - status.lastFound));
        }
        return;
    }
    // Spam-Schutz nicht aktiv: DM sofort senden
    status.lastFound = now;
    status.pendingFound = false;
    if (status.foundTimeout) { clearTimeout(status.foundTimeout); status.foundTimeout = null; }
    const data = signups[key];
    if (data.length === 5) {
        for (const userId of data) {
            const dayText = getPremierDayTextByKey(key);
            const playerList = await getPlayerListText(data);
            const user = await client.users.fetch(userId);
            const message = `\`\`\`\nHey ${user.username}, es haben sich 5 Spieler gefunden (${getPremierTimeByKey(key)}).\n\nAktueller Premier-Tag: ${dayText}\n\nAktuelle Spieler: ${playerList}\n\nBitte sei pünktlich und finde dich bitte 30 Minuten bis 1 Stunde vorher ein!\n\`\`\``;
            await sendProtectedDM(userId, message, `Premier Found Direct ${key}`);
        }
    }
}

// --- Practice-DM sofort bei 5 ---
async function sendPracticeFoundDM(day) {
    const key = String(day).startsWith('prac_') ? day : getPracticeKey(practiceConfig.days.indexOf(day));
    const now = Date.now();
    const status = practiceDMStatus[key];
    
    // Sicherheitsprüfungen hinzufügen
    if (!status) {
        console.warn(`sendPracticeFoundDM: practiceDMStatus[${key}] ist undefined für day: ${day}`);
        return;
    }
    if (now - status.lastFound < 60 * 60 * 1000) {
        status.pendingFound = true;
        if (!status.foundTimeout) {
            status.foundTimeout = setTimeout(async () => {
                if (status.pendingFound) {
                    status.pendingFound = false;
                    status.lastFound = Date.now();
                    const data = practiceSignups[key];
                    if (data.length === 5) {
                        for (const userId of data) {
                            const dayText = getPracticeDayTextByKey(key);
                            const playerList = await getPlayerListText(data);
                            const user = await client.users.fetch(userId);
                            const message = `\`\`\`\nHey ${user.username}, es haben sich 5 Leute für Practice gefunden (${getPracticeTimeByKey(key)}).\n\nAktueller Practice-Tag: ${dayText}\n\nAktuelle Spieler: ${playerList}\n\nBitte sei pünktlich und finde dich bitte 30 Minuten bis 1 Stunde vorher ein!\n\`\`\``;
                            await sendProtectedDM(userId, message, `Practice Found ${key}`);
                        }
                    }
                }
                status.foundTimeout = null;
            }, 60 * 60 * 1000 - (now - status.lastFound));
        }
        return;
    }
    status.lastFound = now;
    status.pendingFound = false;
    if (status.foundTimeout) { clearTimeout(status.foundTimeout); status.foundTimeout = null; }
    const data = practiceSignups[key];
    if (data.length === 5) {
        for (const userId of data) {
            if (dmOptOut.has(userId)) continue;
            if (isUserAbwesendToday(userId)) continue; // Abwesende User überspringen
            try {
                const user = await client.users.fetch(userId);
                const dayText = getPracticeDayTextByKey(key);
                const playerList = await getPlayerListText(data);
                await user.send(`\`\`\`\nHey ${user.username}, es haben sich 5 Leute für Practice gefunden (${getPracticeTimeByKey(key)}).\n\nAktueller Practice-Tag: ${dayText}\n\nAktuelle Spieler: ${playerList}\n\nBitte sei pünktlich und finde dich bitte 30 Minuten bis 1 Stunde vorher ein!\n\`\`\``);
            } catch (e) { console.error(`Konnte DM an User ${userId} nicht senden:`, e); }
        }
    }
}

// --- Practice: Sende Absage-DM bei weniger als 5 (max 1x pro Stunde) ---
async function sendPracticeCancelDM(day, removedUserName = null) {
    const key = String(day).startsWith('prac_') ? day : getPracticeKey(practiceConfig.days.indexOf(day));
    const now = Date.now();
    const status = practiceDMStatus[key];
    
    // Sicherheitsprüfungen hinzufügen
    if (!status) {
        console.warn(`sendPracticeCancelDM: practiceDMStatus[${key}] ist undefined für day: ${day}`);
        return;
    }
    if (now - status.lastCancel < 60 * 60 * 1000) {
        status.pendingCancel = true;
        if (!status.cancelTimeout) {
            status.cancelTimeout = setTimeout(async () => {
                if (status.pendingCancel) {
                    status.pendingCancel = false;
                    status.lastCancel = Date.now();
                    const data = practiceSignups[key];
                    if (data.length < MAX_USERS && data.length > 0) {
                        const dayText = getPracticeDayTextByKey(key);
                        const playerList = data.length > 0 ? await getPlayerListText(data) : 'Keine Spieler';
                        const msg = `\`\`\`\nLeider findet am ${day} (${getPracticeTime(day)}) doch kein Practice statt.${removedUserName ? `\n\n${removedUserName} hat sich ausgetragen.` : ''}\n\nAktueller Practice-Tag: ${dayText}\n\nVerbleibende Spieler: ${playerList}\n\`\`\``;
                        for (const userId of data) {
                            if (dmOptOut.has(userId)) continue;
                            if (isUserAbwesendToday(userId)) continue; // Abwesende User überspringen
                            try {
                                const user = await client.users.fetch(userId);
                                await user.send(msg);
                            } catch (e) { console.error('Fehler beim Senden der Absage-DM:', e); }
                        }
                    }
                }
                status.cancelTimeout = null;
            }, 60 * 60 * 1000 - (now - status.lastCancel));
        }
        return;
    }
    status.lastCancel = now;
    status.pendingCancel = false;
    if (status.cancelTimeout) { clearTimeout(status.cancelTimeout); status.cancelTimeout = null; }
    const data = practiceSignups[key];
    if (data.length < MAX_USERS && data.length > 0) {
        const dayText = getPracticeDayTextByKey(key);
        const playerList = data.length > 0 ? await getPlayerListText(data) : 'Keine Spieler';
        const msg = `\`\`\`\nLeider findet am ${day} (${getPracticeTime(day)}) doch kein Practice statt.${removedUserName ? `\n\n${removedUserName} hat sich ausgetragen.` : ''}\n\nAktueller Practice-Tag: ${dayText}\n\nVerbleibende Spieler: ${playerList}\n\`\`\``;
        for (const userId of data) {
            if (dmOptOut.has(userId)) continue;
            if (isUserAbwesendToday(userId)) continue; // Abwesende User überspringen
            try {
                const user = await client.users.fetch(userId);
                await user.send(msg);
            } catch (e) { console.error('Fehler beim Senden der Absage-DM:', e); }
        }
    }
}

// --- Tournament-DM sofort bei 5 (pro Tag) ---
async function sendTournamentFoundDM(day) {
    const key = String(day).startsWith('tourn_') ? day : getTournamentKey(tournamentConfig.days.indexOf(day));
    const now = Date.now();
    const status = tournamentDMStatus[key];
    
    // Sicherheitsprüfungen hinzufügen
    if (!status) {
        console.warn(`sendTournamentFoundDM: tournamentDMStatus[${key}] ist undefined für day: ${day}`);
        return;
    }
    if (now - status.lastFound < 60 * 60 * 1000) {
        status.pendingFound = true;
        if (!status.foundTimeout) {
            status.foundTimeout = setTimeout(async () => {
                if (status.pendingFound) {
                    status.pendingFound = false;
                    status.lastFound = Date.now();
                    const data = tournamentSignups[key];
                    if (data.length === 5) {
                        for (const userId of data) {
                            const dayText = getTournamentDayTextByKey(key);
                            const playerList = await getPlayerListText(data);
                            const user = await client.users.fetch(userId);
                            const message = `\`\`\`\n🏆 TURNIER TEAM GEFUNDEN! 🏆\n\nHey ${user.username}, es haben sich 5 Leute für das Turnier gefunden (${getTournamentTimeByKey(key)}).\n\nTurnier-Tag: ${dayText}\n\nTurnier-Team: ${playerList}\n\nBitte sei pünktlich und finde dich bitte 30 Minuten bis 1 Stunde vorher ein!\n\`\`\``;
                            await sendProtectedDM(userId, message, `Tournament Found ${key}`);
                        }
                    }
                }
                status.foundTimeout = null;
            }, 60 * 60 * 1000 - (now - status.lastFound));
        }
        return;
    }
    status.lastFound = now;
    status.pendingFound = false;
    if (status.foundTimeout) { clearTimeout(status.foundTimeout); status.foundTimeout = null; }
    const data = tournamentSignups[key];
    if (data.length === 5) {
        for (const userId of data) {
            if (dmOptOut.has(userId)) continue;
            if (isUserAbwesendToday(userId)) continue; // Abwesende User überspringen
            try {
                const user = await client.users.fetch(userId);
                const dayText = getTournamentDayTextByKey(key);
                const playerList = await getPlayerListText(data);
                await user.send(`\`\`\`\n🏆 TURNIER TEAM GEFUNDEN! 🏆\n\nHey ${user.username}, es haben sich 5 Leute für das Turnier gefunden (${getTournamentTimeByKey(key)}).\n\nTurnier-Tag: ${dayText}\n\nTurnier-Team: ${playerList}\n\nBitte sei pünktlich und finde dich bitte 30 Minuten bis 1 Stunde vorher ein!\n\`\`\``);
            } catch (e) { console.error(`Konnte Tournament-DM an User ${userId} nicht senden:`, e); }
        }
    }
}

// --- Scrim-DM sofort bei maxGames ---
async function sendScrimFoundDM() {
    const now = Date.now();
    const status = scrimDMStatus;
    if (now - status.lastFound < 60 * 60 * 1000) {
        status.pendingFound = true;
        if (!status.foundTimeout) {
            status.foundTimeout = setTimeout(async () => {
                if (status.pendingFound) {
                    status.pendingFound = false;
                    status.lastFound = Date.now();
                    if (scrimSignups.length === scrimConfig.maxGames) {
                        for (const userId of scrimSignups) {
                            try {
                                const user = await client.users.fetch(userId);
                                const message = `\`\`\`\nHey ${user.username}, es haben sich ${scrimConfig.maxGames} Leute für Scrim gefunden am ${scrimConfig.day} (${scrimConfig.time}). Bitte sei pünktlich!\n\`\`\``;
                                await sendProtectedDM(userId, message, 'Scrim Found Legacy');
                            } catch (e) { console.error(`Konnte DM an User ${userId} nicht senden:`, e); }
                        }
                    }
                }
                status.foundTimeout = null;
            }, 60 * 60 * 1000 - (now - status.lastFound));
        }
        return;
    }
    status.lastFound = now;
    status.pendingFound = false;
    if (status.foundTimeout) { clearTimeout(status.foundTimeout); status.foundTimeout = null; }
    if (scrimSignups.length === scrimConfig.maxGames) {
        for (const userId of scrimSignups) {
            try {
                const user = await client.users.fetch(userId);
                const message = `\`\`\`\nHey ${user.username}, es haben sich ${scrimConfig.maxGames} Leute für Scrim gefunden am ${scrimConfig.day} (${scrimConfig.time}). Bitte sei pünktlich!\n\`\`\``;
                await sendProtectedDM(userId, message, 'Scrim Found Legacy Direct');
            } catch (e) { console.error(`Konnte DM an User ${userId} nicht senden:`, e); }
        }
    }
}

// --- Scrim: Sende Absage-DM bei weniger als maxGames (max 1x pro Stunde) ---
async function sendScrimCancelDM(removedUserName = null) {
    const now = Date.now();
    const status = scrimDMStatus;
    if (now - status.lastCancel < 60 * 60 * 1000) {
        status.pendingCancel = true;
        if (!status.cancelTimeout) {
            status.cancelTimeout = setTimeout(async () => {
                if (status.pendingCancel) {
                    status.pendingCancel = false;
                    status.lastCancel = Date.now();
                    if (scrimSignups.length < scrimConfig.maxGames && scrimSignups.length > 0) {
                        const msg = `\`\`\`\nLeider findet am ${scrimConfig.day} ${scrimConfig.time} doch kein Scrim statt.${removedUserName ? `\n${removedUserName} hat sich ausgetragen.` : ''}\n\`\`\``;
                        for (const userId of scrimSignups) {
                            try {
                                await sendProtectedDM(userId, msg, 'Scrim Cancel Legacy');
                            } catch (e) { console.error('Fehler beim Senden der Scrim-Absage-DM:', e); }
                        }
                    }
                }
                status.cancelTimeout = null;
            }, 60 * 60 * 1000 - (now - status.lastCancel));
        }
        return;
    }
    status.lastCancel = now;
    status.pendingCancel = false;
    if (status.cancelTimeout) { clearTimeout(status.cancelTimeout); status.cancelTimeout = null; }
    if (scrimSignups.length < scrimConfig.maxGames && scrimSignups.length > 0) {
        const msg = `\`\`\`\nLeider findet am ${scrimConfig.day} ${scrimConfig.time} doch kein Scrim statt.${removedUserName ? `\n${removedUserName} hat sich ausgetragen.` : ''}\n\`\`\``;
        for (const userId of scrimSignups) {
            try {
                await sendProtectedDM(userId, msg, 'Scrim Cancel Legacy Direct');
            } catch (e) { console.error('Fehler beim Senden der Scrim-Absage-DM:', e); }
        }
    }
}

// --- Premier: Sende Absage-DM bei weniger als 5 (max 1x pro Stunde) ---
async function sendPremierCancelDMByKey(key, removedUserName = null) {
    const now = Date.now();
    const status = premierDMStatus[key];
    if (now - status.lastCancel < 60 * 60 * 1000) {
        status.pendingCancel = true;
        if (!status.cancelTimeout) {
            status.cancelTimeout = setTimeout(async () => {
                if (status.pendingCancel) {
                    status.pendingCancel = false;
                    status.lastCancel = Date.now();
                    const data = signups[key];
                    if (data.length < MAX_USERS && data.length > 0) {
                        const dayText = getPremierDayTextByKey(key);
                        const playerList = data.length > 0 ? await getPlayerListText(data) : 'Keine Spieler';
                        const msg = `\`\`\`\nLeider findet das Premier doch nicht statt (${getPremierTimeByKey(key)}).${removedUserName ? `\n\n${removedUserName} hat sich ausgetragen.` : ''}\n\nAktueller Premier-Tag: ${dayText}\n\nVerbleibende Spieler: ${playerList}\n\`\`\``;
                        for (const userId of data) {
                            if (dmOptOut.has(userId)) continue;
                            if (isUserAbwesendToday(userId)) continue; // Abwesende User überspringen
                            try {
                                const user = await client.users.fetch(userId);
                                await user.send(msg);
                            } catch (e) { console.error('Fehler beim Senden der Absage-DM:', e); }
                        }
                    }
                }
                status.cancelTimeout = null;
            }, 60 * 60 * 1000 - (now - status.lastCancel));
        }
        return;
    }
    status.lastCancel = now;
    status.pendingCancel = false;
    if (status.cancelTimeout) { clearTimeout(status.cancelTimeout); status.cancelTimeout = null; }
    const data = signups[key];
    if (data.length < MAX_USERS && data.length > 0) {
        const dayText = getPremierDayTextByKey(key);
        const playerList = data.length > 0 ? await getPlayerListText(data) : 'Keine Spieler';
        const msg = `\`\`\`\nLeider findet das Premier doch nicht statt (${getPremierTimeByKey(key)}).${removedUserName ? `\n\n${removedUserName} hat sich ausgetragen.` : ''}\n\nAktueller Premier-Tag: ${dayText}\n\nVerbleibende Spieler: ${playerList}\n\`\`\``;
        for (const userId of data) {
            if (dmOptOut.has(userId)) continue;
            if (isUserAbwesendToday(userId)) continue; // Abwesende User überspringen
            try {
                const user = await client.users.fetch(userId);
                await user.send(msg);
            } catch (e) { console.error('Fehler beim Senden der Absage-DM:', e); }
        }
    }
}

// --- Premier: Erinnerungs-DM am Tag des Matches (max 1x pro Tag) ---
async function sendPremierReminderDMByKey(key) {
    const now = Date.now();
    const today = getGermanDate();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    if (premierDMStatus[key].lastReminder && new Date(premierDMStatus[key].lastReminder).toISOString().slice(0, 10) === todayStr) {
        console.log(`Premier Reminder für ${key} wurde heute bereits gesendet (${new Date(premierDMStatus[key].lastReminder).toISOString()})`);
        return;
    }
    const data = signups[key];
    if (data.length === MAX_USERS) {
        console.log(`Sende Premier Reminder für ${key} an ${data.length} User`);
        for (const userId of data) {
            if (dmOptOut.has(userId)) continue;
            if (isUserAbwesendToday(userId)) continue; // Abwesende User überspringen
            const user = await client.users.fetch(userId);
            const dayText = getPremierDayTextByKey(key);
            const playerList = await getPlayerListText(data);
            const message = `\`\`\`\nHey ${user.username}, denk dran: Heute ist Premier (${getPremierTimeByKey(key)}).\n\nAktueller Premier-Tag: ${dayText}\n\nAktuelle Spieler: ${playerList}\n\nBitte sei pünktlich und finde dich bitte 30 Minuten bis 1 Stunde vorher ein!\n\`\`\``;
            await sendProtectedDM(userId, message, `Premier Reminder ${key}`);
        }
        premierDMStatus[key].lastReminder = now;
        console.log(`Premier Reminder Zeitstempel gesetzt für ${key}: ${new Date(now).toISOString()}`);
    }
}

// --- Practice: Erinnerungs-DM am Tag des Matches (max 1x pro Tag) ---
async function sendPracticeReminderDM(day) {
    const now = Date.now();
    const today = getGermanDate();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const key = String(day).startsWith('prac_') ? day : getPracticeKey(practiceConfig.days.indexOf(day));
    
    // Sicherheitsprüfungen hinzufügen
    if (!practiceDMStatus[key]) {
        console.warn(`sendPracticeReminderDM: practiceDMStatus[${key}] ist undefined für day: ${day}`);
        return;
    }
    if (!practiceSignups[key]) {
        console.warn(`sendPracticeReminderDM: practiceSignups[${key}] ist undefined für day: ${day}`);
        return;
    }
    
    if (practiceDMStatus[key].lastReminder && new Date(practiceDMStatus[key].lastReminder).toISOString().slice(0, 10) === todayStr) {
        console.log(`Practice Reminder für ${key} wurde heute bereits gesendet (${new Date(practiceDMStatus[key].lastReminder).toISOString()})`);
        return;
    }
    const data = practiceSignups[key];
    if (data.length === MAX_USERS) {
        console.log(`Sende Practice Reminder für ${key} an ${data.length} User`);
        for (const userId of data) {
            if (dmOptOut.has(userId)) continue;
            if (isUserAbwesendToday(userId)) continue; // Abwesende User überspringen
            const user = await client.users.fetch(userId);
            const dayText = getPracticeDayTextByKey(key);
            const playerList = await getPlayerListText(data);
            const message = `\`\`\`\nHey ${user.username}, denk dran: Heute ist Practice (${getPracticeTimeByKey(key)}).\n\nAktueller Practice-Tag: ${dayText}\n\nAktuelle Spieler: ${playerList}\n\nBitte sei pünktlich und finde dich bitte 30 Minuten bis 1 Stunde vorher ein!\n\`\`\``;
            await sendProtectedDM(userId, message, `Practice Reminder ${key}`);
        }
        practiceDMStatus[key].lastReminder = now;
        console.log(`Practice Reminder Zeitstempel gesetzt für ${key}: ${new Date(now).toISOString()}`);
    }
}

// --- Scrim: Erinnerungs-DM am Tag des Matches (max 1x pro Tag) ---
async function sendScrimReminderDM() {
    const now = Date.now();
    const today = getGermanDate();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    if (scrimDMStatus.lastReminder && new Date(scrimDMStatus.lastReminder).toISOString().slice(0, 10) === todayStr) {
        console.log(`Scrim Reminder wurde heute bereits gesendet (${new Date(scrimDMStatus.lastReminder).toISOString()})`);
        return;
    }
    
    // Gehe durch alle Scrim-Boards und sende Reminder für volle Games
    let totalReminders = 0;
    for (const messageId in scrimBoards) {
        const boardInfo = scrimBoards[messageId];
        if (!boardInfo || !scrimSignups[messageId]) continue;
        
        const maxGames = boardInfo.maxGames || 1;
        
        // Prüfe jedes Game in diesem Board
        for (let i = 1; i <= maxGames; i++) {
            const gameKey = `game${i}`;
            const gameSignups = scrimSignups[messageId][gameKey] || [];
            
            if (gameSignups.length === 5) {
                console.log(`Sende Scrim Reminder für ${boardInfo.day} ${boardInfo.time} (Game ${i}) an ${gameSignups.length} User`);
                
                for (const userId of gameSignups) {
                    if (dmOptOut.has(userId)) continue;
                    if (isUserAbwesendToday(userId)) continue;
                    
                    try {
                        const user = await client.users.fetch(userId);
                        const message = `\`\`\`\nHey ${user.username}, denk dran: Heute ist Scrim. (${boardInfo.day}: ${boardInfo.time} - Game ${i})\n\`\`\``;
                        await sendProtectedDM(userId, message, `Scrim Reminder Game ${i}`);
                        totalReminders++;
                    } catch (e) {
                        console.error(`Fehler beim Senden des Scrim Reminders an User ${userId}:`, e);
                    }
                }
            }
        }
    }
    
    if (totalReminders > 0) {
        scrimDMStatus.lastReminder = now;
        console.log(`Scrim Reminder Zeitstempel gesetzt: ${new Date(now).toISOString()} - ${totalReminders} Reminders gesendet`);
    }
}

// --- Practice: Reset state, wenn wieder 5 erreicht werden ---
function updatePracticeState(day) {
    // Überprüfe ob practiceDMStatus[day] existiert
    if (!practiceDMStatus[day]) {
        console.warn(`updatePracticeState: practiceDMStatus[${day}] ist undefined`);
        return;
    }
    
    const data = practiceSignups[day];
    if (!data) {
        console.warn(`updatePracticeState: practiceSignups[${day}] ist undefined`);
        return;
    }
    
    if (data.length < 5) {
        practiceDMStatus[day].state = 'waiting';
    }
}
// --- Premier: Reset state, wenn wieder 5 erreicht werden ---
function updatePremierState(day) {
    const data = signups[day];
    if (data.length < 5) {
        premierDMStatus[day].state = 'waiting';
    }
}

// --- Robuste Abwesenheiten-Bereinigung mit Retry-Mechanismus ---
let cleanupRetryCount = 0;
const MAX_CLEANUP_RETRIES = 1;

// Haupt-Cron-Job für Abwesenheiten-Bereinigung
cron.schedule('1 0 * * *', async () => {
    await executeCleanupCheckWithRetry();
}, {
    scheduled: true,
    timezone: "Europe/Berlin"
});

// Zentrale Funktion für Abwesenheiten-Bereinigung mit Retry
async function executeCleanupCheckWithRetry() {
    try {
        console.log('Tägliche Abwesenheiten-Bereinigung gestartet...');
        cleanupExpiredAbwesenheiten();
        console.log('Tägliche Abwesenheiten-Bereinigung abgeschlossen.');
        cleanupRetryCount = 0; // Reset retry count on success
        
    } catch (error) {
        console.error('Fehler bei Abwesenheiten-Bereinigung:', error);
        
        // Retry nach 5 Minuten, maximal 1x
        if (cleanupRetryCount < MAX_CLEANUP_RETRIES) {
            cleanupRetryCount++;
            console.log(`Retry ${cleanupRetryCount}/${MAX_CLEANUP_RETRIES} in 5 Minuten...`);
            
            setTimeout(async () => {
                try {
                    console.log('Führe Retry für Abwesenheiten-Bereinigung aus...');
                    await executeCleanupCheckWithRetry();
                } catch (retryError) {
                    console.error('ERROR: Could not load your Day - Abwesenheiten-Bereinigung fehlgeschlagen nach Retry');
                    cleanupRetryCount = 0; // Reset für nächsten Tag
                }
            }, 5 * 60 * 1000); // 5 Minuten
        } else {
            console.error('ERROR: Could not load your Day - Abwesenheiten-Bereinigung endgültig fehlgeschlagen');
            cleanupRetryCount = 0; // Reset für nächsten Tag
        }
    }
}

// --- Robuste Backup-Erstellung mit Retry-Mechanismus ---
let backupRetryCount = 0;
const MAX_BACKUP_RETRIES = 1;

// Haupt-Cron-Job für Backup
cron.schedule('0 */6 * * *', async () => {
    await executeBackupCheckWithRetry();
    // Timeout-Cleanup alle 6 Stunden
    cleanupTimeouts();
}, {
    scheduled: true,
    timezone: "Europe/Berlin"
});

// Zentrale Funktion für Backup-Erstellung mit Retry
async function executeBackupCheckWithRetry() {
    try {
        console.log('Erstelle 6-stündliches Backup der Anmeldungen...');
        saveSignupBackup();
        console.log('6-stündliches Backup erfolgreich erstellt.');
        backupRetryCount = 0; // Reset retry count on success
        
    } catch (error) {
        console.error('Fehler bei Backup-Erstellung:', error);
        
        // Retry nach 5 Minuten, maximal 1x
        if (backupRetryCount < MAX_BACKUP_RETRIES) {
            backupRetryCount++;
            console.log(`Retry ${backupRetryCount}/${MAX_BACKUP_RETRIES} in 5 Minuten...`);
            
            setTimeout(async () => {
                try {
                    console.log('Führe Retry für Backup-Erstellung aus...');
                    await executeBackupCheckWithRetry();
                } catch (retryError) {
                    console.error('ERROR: Could not load your Day - Backup-Erstellung fehlgeschlagen nach Retry');
                    backupRetryCount = 0; // Reset für nächsten Tag
                }
            }, 5 * 60 * 1000); // 5 Minuten
        } else {
            console.error('ERROR: Could not load your Day - Backup-Erstellung endgültig fehlgeschlagen');
            backupRetryCount = 0; // Reset für nächsten Tag
        }
    }
}

// --- Cronjob: Erinnerungs-DM immer um 12:05 Uhr am Tag des Matches ---
cron.schedule('5 12 * * *', async () => {
    // Practice: Erinnerungs-DM
    const now = getGermanDate();
    const weekday = now.getDay();
    for (let i = 0; i < practiceConfig.days.length; i++) {
        const day = practiceConfig.days[i];
        const dayIndex = getDayIndex(day);
        if (weekday === dayIndex) {
            await sendPracticeReminderDM(day);
        }
    }
    // Premier: Erinnerungs-DM
    for (let i = 0; i < premierConfig.days.length; i++) {
        const day = premierConfig.days[i];
        const dayIndex = getDayIndex(day);
        if (weekday === dayIndex) {
            await sendPremierReminderDMByKey(getPremierKey(i));
        }
    }
    // Scrim: Erinnerungs-DM
    const scrimDayIndex = getDayIndex(scrimConfig.day);
    if (weekday === scrimDayIndex) {
        await sendScrimReminderDM();
    }
});

// --- Cronjob: Stündliche Prüfung für Wochen-Scrim Auto-Reset und Scrim-Board-Refresh ---
cron.schedule('0 * * * *', async () => {
    await executeWeeklyScrimResetCheck();
    await executeScrimBoardRefreshCheck();
}, {
    scheduled: true,
    timezone: "Europe/Berlin"
});

// Funktion für stündliche Scrim-Board-Refresh-Prüfung (nur Sonntag, 1h nach Scrim-Zeit)
async function executeScrimBoardRefreshCheck() {
    try {
        const now = getGermanDate();
        const currentDay = now.getDay(); // 0 = Sonntag
        const currentHour = now.getHours();
        
        // Prüfe nur Sonntag (0)
        if (currentDay !== 0) {
            return;
        }
        
        console.log('[Stündlich] Prüfe Scrim-Board-Refresh (Sonntag)...');
        
        let refreshCount = 0;
        
        for (const messageId in scrimBoards) {
            if (!scrimBoards[messageId]?.channelId) continue;
            
            const boardInfo = scrimBoards[messageId];
            const scrimTime = boardInfo.time; // z.B. "20:00"
            
            if (!scrimTime) continue;
            
            // Parse Scrim-Zeit
            const [scrimHour, scrimMinute] = scrimTime.split(':').map(Number);
            
            // Berechne 1 Stunde nach Scrim-Zeit
            const refreshHour = scrimHour + 1;
            
            // Prüfe ob es jetzt Zeit ist zu refreshen (1 Stunde nach Scrim-Zeit)
            if (currentHour === refreshHour) {
                try {
                    console.log(`[Sonntag ${currentHour}:00] Aktualisiere Scrim-Board ${messageId} (Scrim war um ${scrimTime})`);
                    
                    const channel = await client.channels.fetch(boardInfo.channelId);
                    const embed = await getScrimSignupEmbed(client, client.user.id, boardInfo.day, boardInfo.time, boardInfo.maxGames, messageId);
                    const buttonRows = getScrimButtonRowsWithControls(client.user.id, true, boardInfo.maxGames, messageId);
                    const msg = await channel.messages.fetch(messageId);
                    
                    // Warte 2 Sekunden zwischen den Updates, damit alles geladen werden kann
                    await new Promise(resolve => setTimeout(resolve, 2000));
                    
                    await msg.edit({ embeds: [embed], components: buttonRows });
                    console.log(`✅ Scrim-Board ${messageId} erfolgreich aktualisiert`);
                    refreshCount++;
                } catch (error) {
                    console.error(`❌ Fehler beim Aktualisieren des Scrim-Boards ${messageId}:`, error);
                }
            }
        }
        
        if (refreshCount > 0) {
            console.log(`✅ ${refreshCount} Scrim-Board(s) erfolgreich aktualisiert (Sonntag Refresh)`);
        }
        
    } catch (error) {
        console.error('❌ Fehler bei stündlicher Scrim-Board-Refresh-Prüfung:', error);
    }
}

// Funktion für stündliche Wochen-Scrim-Reset-Prüfung
async function executeWeeklyScrimResetCheck() {
    try {
        console.log('[Stündlich] Prüfe Wochen-Scrim Auto-Reset...');
        
        const processedGroups = new Set();
        let resetCount = 0;
        
        for (const messageId in wochenScrimData) {
            const data = wochenScrimData[messageId];
            
            // Prüfe ob Reset nötig ist (1h nach Sonntag + Nachhole-Logik)
            if (shouldResetWeeklyScrim(messageId)) {
                // Safety check
                if (!data || !data.days) {
                    console.warn(`Wochen-Scrim ${messageId}: data.days fehlt, überspringe...`);
                    continue;
                }
                
                // Verhindere doppeltes Processing bei Multi-Scrims
                const groupId = data.style === 'wochen_scrim_multi' ? data.groupId : messageId;
                if (processedGroups.has(groupId)) continue;
                processedGroups.add(groupId);
                
                const scrimTypeLabel = data.style === 'wochen_scrim' ? 'Wochen-Scrim (1 Message)' : 'Wochen-Scrim-Multi (7 Messages)';
                console.log(`✅ ${scrimTypeLabel} Reset ausgelöst für Gruppe ${groupId}`);
                
                // Führe Reset durch für alle Messages der Gruppe
                let totalCleared = 0;
                
                if (data.style === 'wochen_scrim') {
                    // Single Message mit 7 Seiten - nur diese Message resetten
                    for (const day in data.days) {
                        if (!data.days[day]) continue;
                        const count = data.days[day].players.length + data.days[day].subs.length;
                        data.days[day].players = [];
                        data.days[day].subs = [];
                        totalCleared += count;
                    }
                } else if (data.style === 'wochen_scrim_multi') {
                    // 7 separate Messages - alle Messages der Gruppe resetten
                    for (const msgId in wochenScrimData) {
                        const msgData = wochenScrimData[msgId];
                        if (msgData.style === 'wochen_scrim_multi' && msgData.groupId === groupId) {
                            for (const day in msgData.days) {
                                if (!msgData.days[day]) continue;
                                const count = msgData.days[day].players.length + msgData.days[day].subs.length;
                                msgData.days[day].players = [];
                                msgData.days[day].subs = [];
                                totalCleared += count;
                            }
                        }
                    }
                }
                
                if (totalCleared > 0) {
                    console.log(`  → ${totalCleared} Anmeldungen entfernt`);
                }
                
                // Markiere als resettet
                const now = new Date();
                const getWeekIdentifier = (date) => {
                    const d = new Date(date);
                    const dayNum = d.getUTCDay() || 7;
                    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
                    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
                    return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
                };
                const currentWeek = getWeekIdentifier(now);
                const currentYear = now.getFullYear();
                const weekId = `${currentYear}-W${currentWeek}`;
                
                // Markiere alle Messages dieser Gruppe als resettet
                if (data.style === 'wochen_scrim') {
                    data.lastResetWeek = weekId;
                } else if (data.style === 'wochen_scrim_multi') {
                    for (const msgId in wochenScrimData) {
                        const msgData = wochenScrimData[msgId];
                        if (msgData.style === 'wochen_scrim_multi' && msgData.groupId === groupId) {
                            msgData.lastResetWeek = weekId;
                        }
                    }
                }
                
                // Reset für nächste Woche (Datum aktualisieren)
                if (data.style === 'wochen_scrim' || data.style === 'wochen_scrim_multi') {
                    await resetWeeklyScrimData(messageId);
                }
                
                resetCount++;
            }
        }
        
        if (resetCount > 0) {
            console.log(`✅ ${resetCount} Wochen-Scrim-Gruppe(n) erfolgreich resettet`);
            saveSignupBackup();
        } else {
            console.log('[Stündlich] Kein Wochen-Scrim-Reset nötig');
        }
        
    } catch (error) {
        console.error('❌ Fehler bei stündlicher Wochen-Scrim-Reset-Prüfung:', error);
    }
}

// --- Robuste Mitternacht-Überprüfung mit Retry-Mechanismus ---
let midnightRetryCount = 0;
const MAX_MIDNIGHT_RETRIES = 1;

// Haupt-Cron-Job für Mitternacht
cron.schedule('0 0 * * *', async () => {
    await executeMidnightCheckWithRetry();
}, {
    scheduled: true,
    timezone: "Europe/Berlin"
});
// Zentrale Funktion für Mitternacht-Überprüfung mit Retry
async function executeMidnightCheckWithRetry() {
    try {
        console.log('Mitternacht - Überprüfe und leere vergangene Anmeldungen...');
        await clearPastSignups();
        
        // Aktualisiere alle Boards nach dem Leeren
        for (const channelId in premierBoards) {
            if (premierBoards[channelId]?.messageId && premierBoards[channelId]?.channelId) {
                try {
                    const channel = await client.channels.fetch(premierBoards[channelId]?.channelId);
                    const premierMessageId = premierBoards[channelId]?.messageId;
                    const embed = await getSignupEmbed(client, null, premierMessageId);
                    const userId = getFirstSignedUpUserId() || client.user.id;
                    const buttonRows = getButtonRow(userId, false, premierMessageId);
                    const msg = await channel.messages.fetch(premierMessageId);
                    await msg.edit({ embeds: [embed], components: buttonRows });
                    console.log(`[00:00] Premier-Board in Channel ${channelId} nach Mitternacht aktualisiert.`);
                } catch (error) {
                    console.error(`[00:00] Fehler beim Aktualisieren des Premier-Boards in Channel ${channelId}:`, error);
                }
            }
        }
        
        for (const channelId in practiceBoards) {
            if (practiceBoards[channelId]?.messageId && practiceBoards[channelId]?.channelId) {
                try {
                    const channel = await client.channels.fetch(practiceBoards[channelId]?.channelId);
                    const practiceMessageId = practiceBoards[channelId]?.messageId;
                    const embed = await getPracticeSignupEmbed(client, null, practiceMessageId);
                    const buttonRows = getPracticeButtonRowsWithControls(client.user.id, false, practiceMessageId);
                    const msg = await channel.messages.fetch(practiceMessageId);
                    await msg.edit({ embeds: [embed], components: buttonRows });
                    console.log(`[00:00] Practice-Board in Channel ${channelId} nach Mitternacht aktualisiert.`);
                } catch (error) {
                    console.error(`[00:00] Fehler beim Aktualisieren des Practice-Boards in Channel ${channelId}:`, error);
                }
            }
        }
        
        // Scrim-Boards werden NICHT mehr um Mitternacht aktualisiert
        // Sie werden nur noch Sonntag 1 Stunde nach Scrim-Zeit aktualisiert (siehe stündliche Prüfung)
        
        console.log('Mitternacht-Überprüfung erfolgreich abgeschlossen.');
        midnightRetryCount = 0; // Reset retry count on success
        
    } catch (error) {
        console.error('Fehler bei Mitternacht-Überprüfung:', error);
        
        // Retry nach 5 Minuten, maximal 1x
        if (midnightRetryCount < MAX_MIDNIGHT_RETRIES) {
            midnightRetryCount++;
            console.log(`Retry ${midnightRetryCount}/${MAX_MIDNIGHT_RETRIES} in 5 Minuten...`);
            
            setTimeout(async () => {
                try {
                    console.log('Führe Retry für Mitternacht-Überprüfung aus...');
                    await executeMidnightCheckWithRetry();
                } catch (retryError) {
                    console.error('ERROR: Could not load your Day - Mitternacht-Überprüfung fehlgeschlagen nach Retry');
                    midnightRetryCount = 0; // Reset für nächsten Tag
                }
            }, 5 * 60 * 1000); // 5 Minuten
        } else {
            console.error('ERROR: Could not load your Day - Mitternacht-Überprüfung endgültig fehlgeschlagen');
            midnightRetryCount = 0; // Reset für nächsten Tag
        }
    }
}


// ===== BEWERBUNGSSYSTEM =====

// Hilfsfunktion: Sendet die Bewerbungsnachricht in einen Channel
async function sendBewerbungsNachricht(channel, userId) {
    console.log(`[Bewerbung] sendBewerbungsNachricht wird aufgerufen! Channel: ${channel.name} (${channel.id}), Parent: ${channel.parentId}, User: ${userId}`);
    
    // STRIKTE PRÜFUNG: Hole Channel-Objekt neu vom Server (keine Caches)
    try {
        const freshChannel = await channel.guild.channels.fetch(channel.id);
        console.log(`[Bewerbung] Fresh Channel geholt - Parent-ID: ${freshChannel.parentId}, Erwartet: ${BEWERBUNGS_KATEGORIE_ID}`);
        
        // WICHTIG: Prüfe ob der Channel in der Bewerbungs-Kategorie ist
        if (freshChannel.parentId !== BEWERBUNGS_KATEGORIE_ID) {
            console.log(`[Bewerbung] ❌ ABBRUCH in sendBewerbungsNachricht: Channel ${freshChannel.name} ist nicht in der Bewerbungs-Kategorie (Parent: ${freshChannel.parentId}, Erwartet: ${BEWERBUNGS_KATEGORIE_ID})`);
            return false;
        }
        
        // Verwende den frisch geholten Channel für alle weiteren Operationen
        channel = freshChannel;
    } catch (error) {
        console.error(`[Bewerbung] Fehler beim Refetchen des Channels:`, error);
        return false;
    }
    
    console.log(`[Bewerbung] ✅ Kategorie korrekt, sende Bewerbungsnachricht...`);
    
    // Initialisiere Bewerbungsdaten für diesen User
    bewerbungen[userId] = {
        channelId: channel.id,
        ign: null,
        realName: null,
        trackerLink: null,
        alter: null,
        rang: null,
        agents: null,
        erfahrung: null,
        verfuegbarkeit: null,
        motivation: null,
        teamwahl: null,
        staerken: null,
        schwaechen: null,
        arbeiten: null,
        zusaetzlicheInfos: null
    };

    // Sende Nachricht mit "Bewerbung Starten" Button im Channel
    try {
        const user = await client.users.fetch(userId);
        const embed = new EmbedBuilder()
            .setTitle('Team-Bewerbung')
            .setDescription(`Willkommen im Bewerbungs-Ticket! Klicke auf den Button unten, um deine Bewerbung zu starten.`)
            .setColor(0x5865F2)
            .setTimestamp();

        const startButton = new ButtonBuilder()
            .setCustomId('bewerbung_starten')
            .setLabel('Bewerbung Starten')
            .setStyle(ButtonStyle.Primary)
            .setEmoji('📝');

        const row = new ActionRowBuilder().addComponents(startButton);

        await channel.send({
            embeds: [embed],
            components: [row]
        });

        console.log(`[Bewerbung] ✅ Nachricht erfolgreich im Channel ${channel.name} gesendet`);
        return true;
    } catch (error) {
        console.error(`[Bewerbung] Fehler beim Senden der Nachricht im Channel:`, error);
        return false;
    }
}

// ChannelCreate Event Handler - Erkennt Ticket-XXXX Channels
client.on(Events.ChannelCreate, async channel => {
    try {
        console.log(`[Bewerbung] ChannelCreate Event für Channel: ${channel.name} (ID: ${channel.id})`);
        
        // Prüfe ob Channel-Name dem Pattern "Ticket-XXXX" entspricht
        const ticketPattern = /^Ticket-\d{4}$/i;
        if (!ticketPattern.test(channel.name)) {
            console.log(`[Bewerbung] ${channel.name} ist kein Ticket-Channel, überspringe...`);
            return;
        }

        console.log(`[Bewerbung] Ticket-Channel erkannt: ${channel.name}`);
        console.log(`[Bewerbung] Initiale Parent-ID: ${channel.parentId}`);

        // Versuche den Ticket-Ersteller zu finden
        // Methode 1: Prüfe Audit Logs (wenn verfügbar)
        let ticketCreator = null;
        try {
            const auditLogs = await channel.guild.fetchAuditLogs({
                type: 10, // CHANNEL_CREATE
                limit: 1
            });
            
            const entry = auditLogs.entries.first();
            if (entry && entry.target.id === channel.id) {
                ticketCreator = entry.executor;
            }
        } catch (error) {
            console.log('[Bewerbung] Audit Logs nicht verfügbar, versuche alternative Methode');
        }

        // Methode 2: Falls Audit Logs fehlschlagen, warte kurz und prüfe Channel-Mitglieder
        if (!ticketCreator) {
            // Warte 2 Sekunden damit der Ticket-Bot den Channel einrichten kann
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            try {
                // Hole alle Mitglieder des Channels
                const members = await channel.members.fetch();
                // Filtere Bots aus
                const humanMembers = members.filter(m => !m.user.bot);
                
                if (humanMembers.size > 0) {
                    // Nimm den ersten menschlichen Benutzer (meist der Ticket-Ersteller)
                    ticketCreator = humanMembers.first().user;
                }
            } catch (error) {
                console.error('[Bewerbung] Fehler beim Abrufen der Channel-Mitglieder:', error);
            }
        }

        if (!ticketCreator) {
            console.log('[Bewerbung] Konnte Ticket-Ersteller nicht ermitteln');
            return;
        }

        console.log(`[Bewerbung] Ticket-Ersteller gefunden: ${ticketCreator.tag} (${ticketCreator.id})`);

        // Warte 5 Sekunden damit der Ticket-Bot den Channel vollständig einrichten und verschieben kann
        console.log(`[Bewerbung] Warte 5 Sekunden auf Channel-Einrichtung und potentielle Kategorie-Verschiebung...`);
        await new Promise(resolve => setTimeout(resolve, 3000));

        // WICHTIG: Hole den Channel neu und prüfe die Kategorie NACH der Wartezeit
        console.log(`[Bewerbung] Prüfe jetzt die finale Kategorie nach 5 Sekunden Wartezeit...`);
        let channelRefreshed = await channel.fetch();
        console.log(`[Bewerbung] Channel nach Wartezeit: ${channelRefreshed.name}, Parent-ID: ${channelRefreshed.parentId}`);
        
        // STRIKTE PRÜFUNG: Nur wenn Parent-ID EXAKT mit der Bewerbungs-Kategorie übereinstimmt
        if (channelRefreshed.parentId !== BEWERBUNGS_KATEGORIE_ID) {
            console.log(`[Bewerbung] ❌ ABBRUCH: Ticket ${channelRefreshed.name} ist NICHT in der Bewerbungs-Kategorie (Parent: ${channelRefreshed.parentId}, Erwartet: ${BEWERBUNGS_KATEGORIE_ID})`);
            return;
        }
        
        // ZUSÄTZLICHE SICHERHEITSPRÜFUNG: Warte nochmal 1 Sekunde und prüfe erneut
        console.log(`[Bewerbung] Warte 1 weitere Sekunde zur finalen Bestätigung...`);
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // Finaler Refetch vor dem Senden
        channelRefreshed = await channel.fetch();
        console.log(`[Bewerbung] Finale Channel-Prüfung: ${channelRefreshed.name}, Parent-ID: ${channelRefreshed.parentId}`);
        
        if (channelRefreshed.parentId !== BEWERBUNGS_KATEGORIE_ID) {
            console.log(`[Bewerbung] ❌ FINALE ABBRUCH: Channel wurde in andere Kategorie verschoben (Parent: ${channelRefreshed.parentId}, Erwartet: ${BEWERBUNGS_KATEGORIE_ID})`);
            return;
        }
        
        console.log(`[Bewerbung] ✅ Kategorie final bestätigt! Sende Bewerbungsnachricht...`);

        // Verwende Hilfsfunktion zum Senden der Bewerbungsnachricht
        await sendBewerbungsNachricht(channelRefreshed, ticketCreator.id);
    } catch (error) {
        console.error('[Bewerbung] Fehler im ChannelCreate Handler:', error);
    }
});

// Hilfsfunktion: Gibt den Team-Namen für eine Team-Auswahl zurück
function getTeamName(teamKey) {
    const teamNames = {
        'main': 'Main (Asc–Immortal)',
        'rising': 'Rising (Platin–Diamond)',
        'sun': 'Sun (Silber–Gold)',
        'moon': 'Moon (Silber–Gold)'
    };
    return teamNames[teamKey] || teamKey;
}

// Funktion: Erstellt das Bewerbungsvorschau-Embed
function getBewerbungsvorschauEmbed(userId) {
    const bewerbung = bewerbungen[userId] || {};
    
    const embed = new EmbedBuilder()
        .setTitle('📄 Team – Bewerbung')
        .setColor(0x5865F2)
        .setTimestamp();

    let description = '';
    
    // In Game Name (IGN)
    description += `**🎮 In Game Name (IGN):** ${bewerbung.ign || '*Nicht ausgefüllt*'}\n\n`;
    
    // Real Name
    description += `**👤 Real Name:** ${bewerbung.realName || '*Nicht ausgefüllt*'}\n\n`;
    
    // Tracker-Link
    description += `**🔗 Tracker-Link:** ${bewerbung.trackerLink || '*Nicht ausgefüllt*'}\n\n`;
    
    // Alter
    description += `**Alter:** ${bewerbung.alter || '*Nicht ausgefüllt*'}\n\n`;
    
    // Rang
    description += `**Rang (Aktuell / Peak):** ${bewerbung.rang || '*Nicht ausgefüllt*'}\n\n`;
    
    // Agents
    description += `**Agents (Main / Secondary Agents):** ${bewerbung.agents || '*Nicht ausgefüllt*'}\n\n`;
    
    // Erfahrung
    description += `**Erfahrung (Teams, Scrims, Premier):** ${bewerbung.erfahrung ? '✅ Ausgefüllt' : '*Nicht ausgefüllt*'}\n\n`;
    
    // Verfügbarkeit
    description += `**Verfügbarkeit:** ${bewerbung.verfuegbarkeit ? '✅ Ausgefüllt' : '*Nicht ausgefüllt*'}\n\n`;
    
    // Motivation
    description += `**Motivation:** ${bewerbung.motivation ? '✅ Ausgefüllt' : '*Nicht ausgefüllt*'}\n\n`;
    
    // Teamwahl
    let teamwahlText = '*Nicht ausgefüllt*';
    if (bewerbung.teamwahl) {
        const teams = [];
        if (bewerbung.teamwahl.main) teams.push('✅ Main (Asc–Immortal)');
        else teams.push('☐ Main (Asc–Immortal)');
        if (bewerbung.teamwahl.rising) teams.push('✅ Rising (Platin–Diamond)');
        else teams.push('☐ Rising (Platin–Diamond)');
        if (bewerbung.teamwahl.sun) teams.push('✅ Sun (Silber–Gold)');
        else teams.push('☐ Sun (Silber–Gold)');
        if (bewerbung.teamwahl.moon) teams.push('✅ Moon (Silber–Gold)');
        else teams.push('☐ Moon (Silber–Gold)');
        teamwahlText = teams.join('\n');
    } else {
        teamwahlText = '☐ Main (Asc–Immortal)\n☐ Rising (Platin–Diamond)\n☐ Sun (Silber–Gold)\n☐ Moon (Silber–Gold)';
    }
    description += `**Teamwahl:**\n${teamwahlText}\n\n`;
    
    // Stärken
    description += `**Stärken:** ${bewerbung.staerken ? '✅ Ausgefüllt' : '*Nicht ausgefüllt*'}\n\n`;
    
    // Schwächen
    description += `**Schwächen:** ${bewerbung.schwaechen ? '✅ Ausgefüllt' : '*Nicht ausgefüllt*'}\n\n`;
    
    // Woran arbeiten
    description += `**Woran möchtest du arbeiten?** ${bewerbung.arbeiten ? '✅ Ausgefüllt' : '*Nicht ausgefüllt*'}\n\n`;
    
    // Zusätzliche Infos
    description += `**Zusätzliche Infos (optional):** ${bewerbung.zusaetzlicheInfos || '*Nicht ausgefüllt*'}\n`;

    embed.setDescription(description);

    return embed;
}

// Funktion: Prüft ob alle Pflichtfelder ausgefüllt sind
function isBewerbungVollstaendig(userId) {
    const bewerbung = bewerbungen[userId];
    if (!bewerbung) return false;

    return !!(
        bewerbung.ign &&
        bewerbung.realName &&
        bewerbung.trackerLink &&
        bewerbung.alter &&
        bewerbung.rang &&
        bewerbung.agents &&
        bewerbung.erfahrung &&
        bewerbung.verfuegbarkeit &&
        bewerbung.motivation &&
        bewerbung.teamwahl &&
        (bewerbung.teamwahl.main || bewerbung.teamwahl.rising || bewerbung.teamwahl.sun || bewerbung.teamwahl.moon) &&
        bewerbung.staerken &&
        bewerbung.schwaechen &&
        bewerbung.arbeiten
    );
}

// Funktion: Erstellt Buttons für die Bewerbungsvorschau
function getBewerbungsButtons(userId) {
    const bewerbung = bewerbungen[userId] || {};
    const rows = [];

    // Erste Reihe: Kombinierte Basis-Informationen
    const basicRow = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId(`bewerbung_persoenlich_${userId}`)
                .setLabel('Persönliche Daten')
                .setStyle((bewerbung.ign && bewerbung.realName && bewerbung.alter) ? ButtonStyle.Success : ButtonStyle.Secondary)
                .setEmoji('👤'),
            new ButtonBuilder()
                .setCustomId(`bewerbung_rangtracker_${userId}`)
                .setLabel('Rang & Tracker')
                .setStyle((bewerbung.rang && bewerbung.trackerLink) ? ButtonStyle.Success : ButtonStyle.Secondary)
                .setEmoji('📊'),
            new ButtonBuilder()
                .setCustomId(`bewerbung_agents_${userId}`)
                .setLabel('Agents')
                .setStyle(bewerbung.agents ? ButtonStyle.Success : ButtonStyle.Secondary)
                .setEmoji('🎮'),
            new ButtonBuilder()
                .setCustomId(`bewerbung_erfahrung_${userId}`)
                .setLabel('Erfahrung')
                .setStyle(bewerbung.erfahrung ? ButtonStyle.Success : ButtonStyle.Secondary)
                .setEmoji('💼')
        );
    rows.push(basicRow);

    // Zweite Reihe: Kombinierte Langtext-Felder
    const longTextRow = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId(`bewerbung_verfuegmotiv_${userId}`)
                .setLabel('Verfügbarkeit & Motivation')
                .setStyle((bewerbung.verfuegbarkeit && bewerbung.motivation) ? ButtonStyle.Success : ButtonStyle.Secondary)
                .setEmoji('💪'),
            new ButtonBuilder()
                .setCustomId(`bewerbung_staerkeschwaeche_${userId}`)
                .setLabel('Stärken, Schwächen & Arbeit')
                .setStyle((bewerbung.staerken && bewerbung.schwaechen && bewerbung.arbeiten) ? ButtonStyle.Success : ButtonStyle.Secondary)
                .setEmoji('⭐'),
            new ButtonBuilder()
                .setCustomId(`bewerbung_teamwahl_${userId}`)
                .setLabel('Teamwahl')
                .setStyle(bewerbung.teamwahl && (bewerbung.teamwahl.main || bewerbung.teamwahl.rising || bewerbung.teamwahl.sun || bewerbung.teamwahl.moon) ? ButtonStyle.Success : ButtonStyle.Secondary)
                .setEmoji('👥'),
            new ButtonBuilder()
                .setCustomId(`bewerbung_zusaetzlich_${userId}`)
                .setLabel('Zusätzliche Infos')
                .setStyle(ButtonStyle.Secondary)
                .setEmoji('📝')
        );
    rows.push(longTextRow);

    // Dritte Reihe: Submit Button
    const submitRow = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId(`bewerbung_abschicken_${userId}`)
                .setLabel('Bewerbung Abschicken')
                .setStyle(ButtonStyle.Primary)
                .setEmoji('✅')
                .setDisabled(!isBewerbungVollstaendig(userId))
        );
    rows.push(submitRow);

    return rows;
}

// Kombinierter Handler für alle Interaktionen (Autocomplete + Commands + Buttons)
client.on(Events.InteractionCreate, async interaction => {
    // GLOBALE FEHLERBEHANDLUNG - Verhindert Bot-Abstürze
    try {

    // EARLY: Abwesend modal open before any other button logic to avoid prior acknowledgement
    if (interaction.isButton() && interaction.customId === 'abwesend_modal') {
        // Sofortige Prüfung und Beantwortung um Race Conditions zu vermeiden
        if (interaction.replied || interaction.deferred) {
            return;
        }
        
        // Kein deferReply nötig, da wir showModal verwenden
        
        try {
            const modal = new ModalBuilder()
                .setCustomId('abwesend_form_v2')
                .setTitle('Abwesenheit eintragen');

            const startDateInput = new TextInputBuilder()
                .setCustomId('start_date')
                .setLabel('Startdatum (DD.MM.YYYY)')
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('z.B. 25.12.2024')
                .setRequired(true)
                .setMaxLength(10);

            const endDateInput = new TextInputBuilder()
                .setCustomId('end_date')
                .setLabel('Enddatum (DD.MM.YYYY)')
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('z.B. 02.01.2025')
                .setRequired(true)
                .setMaxLength(10);

            const startTimeInput = new TextInputBuilder()
                .setCustomId('start_time')
                .setLabel('Startzeit (HH:MM) - Optional')
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('z.B. 09:00')
                .setRequired(false)
                .setMaxLength(5);

            const endTimeInput = new TextInputBuilder()
                .setCustomId('end_time')
                .setLabel('Endzeit (HH:MM) - Optional')
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('z.B. 17:00')
                .setRequired(false)
                .setMaxLength(5);

            modal.addComponents(
                new ActionRowBuilder().addComponents(startDateInput),
                new ActionRowBuilder().addComponents(endDateInput),
                new ActionRowBuilder().addComponents(startTimeInput),
                new ActionRowBuilder().addComponents(endTimeInput)
            );

            // Öffne Modal direkt
            await interaction.showModal(modal);
            return;
        } catch (error) {
            console.error('[DEBUG] Fehler beim Öffnen des Modals:', error);
            console.error('[DEBUG] Fehler-Stack:', error.stack);
            console.error('[DEBUG] Fehler-Details:', {
                name: error.name,
                message: error.message,
                code: error.code
            });
            try {
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply({ content: '❌ Fehler beim Öffnen des Formulars.', flags: [MessageFlags.Ephemeral] });
                } else {
                    await interaction.followUp({ content: '❌ Fehler beim Öffnen des Formulars.', flags: [MessageFlags.Ephemeral] });
                }
            } catch (e) {
                console.error('[DEBUG] Fehler beim Senden der Fehlermeldung:', e);
            }
            return;
        }
    }
    
    // MVP Vote Select Menu Handler für 3 Kategorien
    if (interaction.isStringSelectMenu() && (interaction.customId === 'mvp_effort_select' || interaction.customId === 'mvp_comms_select' || interaction.customId === 'mvp_impact_select')) {
        try {
            const messageId = interaction.message.id;
            const voteData = global.mvpVotes[messageId];
            
            if (!voteData || !voteData.active) {
                await safeInteractionReply(interaction, '❌ Diese Abstimmung ist nicht mehr aktiv.', { flags: [MessageFlags.Ephemeral] });
                return;
            }
            
            const voterId = interaction.user.id;
            const votedForId = interaction.values[0];
            const category = interaction.customId.split('_')[1]; // effort, comms, oder impact
            
            // Prüfe ob User für sich selbst stimmt
            if (voterId === votedForId) {
                await safeInteractionReply(interaction, '❌ Du kannst nicht für dich selbst stimmen!', { flags: [MessageFlags.Ephemeral] });
                return;
            }
            
            // Prüfe ob User ein berechtigter Spieler ist
            if (!voteData.players.includes(voterId)) {
                await safeInteractionReply(interaction, '❌ Du bist nicht berechtigt, bei dieser Abstimmung teilzunehmen!', { flags: [MessageFlags.Ephemeral] });
                return;
            }
            
            // Speichere oder aktualisiere Vote für die spezifische Kategorie
            const previousVote = voteData.votes[category][voterId];
            voteData.votes[category][voterId] = votedForId;
            saveMVPVotes();
            
            // Hole Benutzername für Feedback
            let votedForUser;
            try {
                votedForUser = await interaction.guild.members.fetch(votedForId);
            } catch (error) {
                votedForUser = { displayName: 'Unbekannt' };
            }
            
            const categoryEmojis = {
                effort: '💪',
                comms: '🗣️',
                impact: '💥'
            };
            
            const categoryNames = {
                effort: 'Effort',
                comms: 'Comms',
                impact: 'Impact'
            };
            
            const message = previousVote 
                ? `✅ Deine ${categoryNames[category]} Stimme wurde geändert zu: **${votedForUser.displayName}** ${categoryEmojis[category]}`
                : `✅ Du hast für **${votedForUser.displayName}** als ${categoryNames[category]} MVP gestimmt! ${categoryEmojis[category]}`;
            
            // Sende Feedback-Nachricht sicher
            await safeInteractionReply(interaction, message, { flags: [MessageFlags.Ephemeral] });
            
            // Prüfe ob alle für alle 3 Kategorien abgestimmt haben
            const effortVoters = Object.keys(voteData.votes.effort).length;
            const commsVoters = Object.keys(voteData.votes.comms).length;
            const impactVoters = Object.keys(voteData.votes.impact).length;
            const totalPlayers = voteData.players.length;
            
            if (voteData.time === 'all_voted' && effortVoters >= totalPlayers && commsVoters >= totalPlayers && impactVoters >= totalPlayers) {
                // Alle haben für alle Kategorien abgestimmt - beende Abstimmung sofort
                console.log('Alle Spieler haben für alle Kategorien abgestimmt - beende MVP-Vote');
                try {
                    await finalizeMVPVote(messageId);
                } catch (finalizeError) {
                    console.error('Fehler beim Finalisieren der MVP-Abstimmung:', finalizeError);
                }
                return;
            }
            
            // Aktualisiere nur den Footer mit Abstimmungsfortschritt (GEHEIM - keine Ergebnisse)
            const styleTextGen = voteData.style === 'weekly' ? 'der Woche' : 
                                voteData.style === 'monthly' ? 'des Monats' : 'des Jahres';
            
            // Berechne verbleibende Zeit
            let durationText = '';
            let progressText = '';
            if (voteData.endDate) {
                const remainingMs = voteData.endDate - Date.now();
                const remainingDays = Math.ceil(remainingMs / (24 * 60 * 60 * 1000));
                const remainingHours = Math.ceil(remainingMs / (60 * 60 * 1000));
                
                if (remainingDays > 1) {
                    durationText = `\n📅 **Endet in: ${remainingDays} Tagen**`;
                } else if (remainingHours > 1) {
                    durationText = `\n📅 **Endet in: ${remainingHours} Stunden**`;
                } else {
                    durationText = `\n📅 **Endet: Bald**`;
                }
                progressText = `\n📊 **Effort:** ${effortVoters}/${totalPlayers} | **Comms:** ${commsVoters}/${totalPlayers} | **Impact:** ${impactVoters}/${totalPlayers}`;
            } else {
                // Bei "bis alle abgestimmt haben" nur Fortschritt anzeigen
                progressText = `\n📊 **Effort:** ${effortVoters}/${totalPlayers} | **Comms:** ${commsVoters}/${totalPlayers} | **Impact:** ${impactVoters}/${totalPlayers}`;
            }
            
            const embed = new EmbedBuilder()
                .setTitle(`🏆 ═══ Abstimmung: MVP ${styleTextGen} ═══ 🏆`)
                .setDescription(
                    `🌟 Wähle den besten Spieler ${styleTextGen} in 3 Kategorien! 🌟\n\n` +
                    `💪 **Effort MVP** - Wer zeigt die meiste Anstrengung?\n` +
                    `🗣️ **Comms MVP** - Wer kommuniziert am besten?\n` +
                    `💥 **Impact MVP** - Wer hat den größten Einfluss?\n\n` +
                    `⚠️ Du kannst nicht für dich selbst stimmen! ⚠️${durationText}${progressText}`
                )
                .setColor(0xFFD700)
                .setTimestamp()
                .setFooter({ text: `Effort: ${effortVoters} | Comms: ${commsVoters} | Impact: ${impactVoters}` });
            
            // Füge Kandidaten hinzu
            const playerMembers = [];
            for (const playerId of voteData.players) {
                try {
                    const member = await interaction.guild.members.fetch(playerId);
                    playerMembers.push(member);
                } catch (error) {
                    // User nicht mehr verfügbar
                }
            }
            playerMembers.sort((a, b) => a.displayName.localeCompare(b.displayName));
            
            embed.addFields({
                name: '═══ Kandidaten ═══',
                value: playerMembers.map((m, idx) => `⭐ **${m.displayName}**`).join('\n') || 'Keine Spieler'
            });
            
            // KEINE Ergebnisse anzeigen - GEHEIM!
            
            // Aktualisiere die Nachricht
            try {
                await interaction.message.edit({ embeds: [embed] });
            } catch (error) {
                console.error('Fehler beim Aktualisieren der Vote-Nachricht:', error);
                // Versuche es mit den ursprünglichen Komponenten
                try {
                    await interaction.message.edit({ 
                        embeds: [embed],
                        components: interaction.message.components 
                    });
                } catch (retryError) {
                    console.error('Fehler beim Retry der Vote-Nachricht:', retryError);
                }
            }
            
        } catch (error) {
            console.error('Fehler beim Verarbeiten des MVP-Votes:', error);
            await safeInteractionReply(interaction, '❌ Fehler beim Verarbeiten deiner Stimme!', { flags: [MessageFlags.Ephemeral] });
        }
        return;
    }

    // ROLLENPRÜFUNG NUR FÜR BUTTONS (Commands haben eigene Prüfung)
    if (interaction.isButton()) {
        // Abwesend-Button, DM Voting Buttons und Bewerbungs-Buttons haben keine Rollenprüfung - überspringe diese
        if (interaction.customId === 'abwesend_modal' || 
            interaction.customId.startsWith('wochen_scrim_vote_') || 
            interaction.customId.startsWith('bewerbung_')) {
            // Keine Berechtigungsprüfung für diese Buttons
        } else {
            // Für alle anderen Buttons: Berechtigung prüfen
            const hasRole = await hasRequiredRole(interaction);
            if (!hasRole) {
                try {
                    if (!interaction.replied && !interaction.deferred) {
                        await interaction.reply({ 
                            content: '❌ Du hast nicht die erforderliche Berechtigung, um diese Aktion auszuführen.', 
                            flags: [MessageFlags.Ephemeral] 
                        });
                    }
                    console.log(`Button-Zugriff verweigert für User ${interaction.user.tag} (${interaction.user.id}) - Fehlende Rolle`);
                    return;
                } catch (error) {
                    console.error('Fehler beim Senden der Button-Berechtigungs-Nachricht:', error);
                    return;
                }
            }
        }
    }
    
    // ===== WOCHEN-SCRIM BUTTON HANDLERS =====
    // Navigation: Previous page
    if (interaction.isButton() && interaction.customId.startsWith('wochen_scrim_prev_')) {
        const messageId = interaction.customId.split('_')[3];
        let data = wochenScrimData[messageId];
        
        // Fallback: Wenn Daten fehlen, versuche aus gleicher Gruppe wiederherzustellen
        if (!data) {
            console.log(`Versuche Daten für Message ${messageId} wiederherzustellen...`);
            for (const [otherId, otherData] of Object.entries(wochenScrimData)) {
                if (otherData && otherData.groupId && otherData.style === 'wochen_scrim') {
                    wochenScrimData[messageId] = JSON.parse(JSON.stringify(otherData));
                    data = wochenScrimData[messageId];
                    saveSignupBackup();
                    console.log(`Daten wiederhergestellt für Message ${messageId} von ${otherId}`);
                    break;
                }
            }
        }
        
        if (!data) {
            await interaction.reply({ content: '❌ Scrim-Daten nicht gefunden. Bitte erstelle ein neues Scrim mit /scrim', flags: [MessageFlags.Ephemeral] });
            return;
        }
        
        if (data.currentPage > 0) {
            data.currentPage--;
            const displayName = await getDisplayName(interaction.user.id, interaction.guild?.id);
            const prevDay = WEEKDAYS[data.currentPage];
            console.log(`◀️ [Wochen-Scrim] ${displayName} → Navigation zurück zu ${prevDay} | Message: ${messageId}`);
            
            const embed = await getWochenScrimEmbed(messageId, data.currentPage);
            const buttons = getWochenScrimButtons(messageId, data.currentPage);
            try {
                await interaction.update({ embeds: [embed], components: buttons });
            } catch (updateError) {
                console.error('Fehler beim Update:', updateError);
                // Fallback: Verwende editReply
                try {
                    await interaction.editReply({ embeds: [embed], components: buttons });
                } catch (editError) {
                    console.error('Fehler beim EditReply:', editError);
                }
            }
            saveSignupBackup();
        }
        return;
    }
    
    // Navigation: Next page
    if (interaction.isButton() && interaction.customId.startsWith('wochen_scrim_next_')) {
        const messageId = interaction.customId.split('_')[3];
        let data = wochenScrimData[messageId];
        
        // Fallback: Wenn Daten fehlen, versuche aus gleicher Gruppe wiederherzustellen
        if (!data) {
            console.log(`Versuche Daten für Message ${messageId} wiederherzustellen...`);
            for (const [otherId, otherData] of Object.entries(wochenScrimData)) {
                if (otherData && otherData.groupId && otherData.style === 'wochen_scrim') {
                    wochenScrimData[messageId] = JSON.parse(JSON.stringify(otherData));
                    data = wochenScrimData[messageId];
                    saveSignupBackup();
                    console.log(`Daten wiederhergestellt für Message ${messageId} von ${otherId}`);
                    break;
                }
            }
        }
        
        if (!data) {
            await interaction.reply({ content: '❌ Scrim-Daten nicht gefunden. Bitte erstelle ein neues Scrim mit /scrim', flags: [MessageFlags.Ephemeral] });
            return;
        }
        
        if (data.currentPage < WEEKDAYS.length - 1) {
            data.currentPage++;
            const displayName = await getDisplayName(interaction.user.id, interaction.guild?.id);
            const nextDay = WEEKDAYS[data.currentPage];
            console.log(`▶️ [Wochen-Scrim] ${displayName} → Navigation vorwärts zu ${nextDay} | Message: ${messageId}`);
            
            const embed = await getWochenScrimEmbed(messageId, data.currentPage);
            const buttons = getWochenScrimButtons(messageId, data.currentPage);
            try {
                await interaction.update({ embeds: [embed], components: buttons });
            } catch (updateError) {
                console.error('Fehler beim Update:', updateError);
                // Fallback: Verwende editReply
                try {
                    await interaction.editReply({ embeds: [embed], components: buttons });
                } catch (editError) {
                    console.error('Fehler beim EditReply:', editError);
                }
            }
            saveSignupBackup();
        }
        return;
    }
    
    // Signup: Register for all games
    if (interaction.isButton() && interaction.customId.startsWith('wochen_scrim_signup_')) {
        const parts = interaction.customId.split('_');
        const messageId = parts[3];
        const dayIndex = parseInt(parts[4]);
        let data = wochenScrimData[messageId];
        
        // Fallback: Wenn Daten fehlen, versuche aus gleicher Gruppe wiederherzustellen
        if (!data) {
            console.log(`Versuche Daten für Message ${messageId} wiederherzustellen...`);
            // Suche nach einer Message mit gleichem groupId
            for (const [otherId, otherData] of Object.entries(wochenScrimData)) {
                if (otherData && otherData.groupId && otherData.style === 'wochen_scrim_multi') {
                    // Kopiere Daten und setze richtige currentPage
                    wochenScrimData[messageId] = JSON.parse(JSON.stringify(otherData));
                    wochenScrimData[messageId].currentPage = dayIndex;
                    data = wochenScrimData[messageId];
                    saveSignupBackup();
                    console.log(`Daten wiederhergestellt für Message ${messageId} von ${otherId}`);
                    break;
                }
            }
        }
        
        if (!data) {
            await interaction.reply({ content: '❌ Scrim-Daten nicht gefunden. Bitte erstelle ein neues Scrim mit /scrim', flags: [MessageFlags.Ephemeral] });
            return;
        }
        
        const day = WEEKDAYS[dayIndex];
        const dayData = data.days[day];
        if (!dayData) {
            // For single_message, get the first (and only) day
            const firstDay = Object.keys(data.days)[0];
            const dayData = data.days[firstDay];
            const userId = interaction.user.id;
            
            // Check if already registered as player or sub
            if (dayData.players.includes(userId) || dayData.subs.includes(userId)) {
                await interaction.deferUpdate();
                return;
            }
            
            // SOFORT deferUpdate aufrufen (innerhalb 3 Sekunden!)
            try {
                await interaction.deferUpdate();
            } catch (deferError) {
                console.error('Fehler beim deferUpdate:', deferError);
                return;
            }
            
            const previousPlayerCount = dayData.players.length;
            const displayName = await getDisplayName(userId, interaction.guild?.id);
            
            // Add to main players if space available, otherwise to subs
            if (dayData.players.length < 5) {
                dayData.players.push(userId);
                console.log(`✅ [Wochen-Scrim] ${displayName} → Hauptspieler (${firstDay}) | ${dayData.players.length}/5 | Message: ${messageId}`);
            } else {
                dayData.subs.push(userId);
                console.log(`🔄 [Wochen-Scrim] ${displayName} → Sub (${firstDay}) | Subs: ${dayData.subs.length} | Message: ${messageId}`);
            }
            
            // Board SOFORT aktualisieren
            const embed = await getWochenScrimEmbed(messageId, 0, firstDay);
            const buttons = getWochenScrimButtons(messageId, 0);
            try {
                const message = await interaction.message.fetch();
                await message.edit({ embeds: [embed], components: buttons });
            } catch (updateError) {
                console.error('Fehler beim Board-Update:', updateError);
            }
            
            saveSignupBackup();
            
            // DM-Benachrichtigung asynchron (nach 5 Sekunden) wenn genau 5 Spieler erreicht wurden
            if (previousPlayerCount < 5 && dayData.players.length === 5) {
                console.log(`📢 [Wochen-Scrim] 5 Spieler erreicht für ${firstDay}! DMs werden in 5 Sekunden gesendet...`);
                
                // Asynchrone DM-Funktion (fire and forget)
                setTimeout(async () => {
                    const scrimTime = dayData.time || '19:00';
                    const scrimDate = `${firstDay} um ${scrimTime}`;
                    
                    const userList = await Promise.all(dayData.players.map(async (uid) => {
                        try {
                            return await getDisplayName(uid, interaction.guild?.id);
                        } catch (e) {
                            return 'Unbekannt';
                        }
                    }));
                    
                    for (const uid of dayData.players) {
                        try {
                            const playerDisplayName = await getDisplayName(uid, interaction.guild?.id);
                            const dmMessage = `Hey ${playerDisplayName}, das Scrim am **${scrimDate}** findet statt!\n\n` +
                                `Folgende User sind eingetragen:\n${userList.map(u => `• ${u}`).join('\n')}`;
                            const dmSent = await sendProtectedDM(uid, dmMessage, `Wochen-Scrim Found ${firstDay}`);
                            if (dmSent) {
                                console.log(`✅ [DM] Bestätigungs-DM an ${playerDisplayName} gesendet (${firstDay})`);
                            }
                        } catch (dmError) {
                            console.error(`❌ [DM] Konnte DM nicht an User ${uid} senden:`, dmError.message);
                        }
                    }
                }, 3000); // 3 Sekunden Verzögerung
            }
            
            return;
        }
        
        const userId = interaction.user.id;
        
        // Check if already registered as player or sub
        if (dayData.players.includes(userId) || dayData.subs.includes(userId)) {
            await interaction.deferUpdate();
            return;
        }
        
        // SOFORT deferUpdate aufrufen (innerhalb 3 Sekunden!)
        try {
            await interaction.deferUpdate();
        } catch (deferError) {
            console.error('Fehler beim deferUpdate:', deferError);
            return;
        }
        
        const previousPlayerCount = dayData.players.length;
        const displayName = await getDisplayName(userId, interaction.guild?.id);
        
        // Add to main players if space available, otherwise to subs
        if (dayData.players.length < 5) {
            dayData.players.push(userId);
            console.log(`✅ [Wochen-Scrim] ${displayName} → Hauptspieler (${day}) | ${dayData.players.length}/5 | Message: ${messageId}`);
        } else {
            dayData.subs.push(userId);
            console.log(`🔄 [Wochen-Scrim] ${displayName} → Sub (${day}) | Subs: ${dayData.subs.length} | Message: ${messageId}`);
        }
        
        // Board SOFORT aktualisieren
        const embed = await getWochenScrimEmbed(messageId, dayIndex);
        const buttons = getWochenScrimButtons(messageId, dayIndex);
        try {
            const message = await interaction.message.fetch();
            await message.edit({ embeds: [embed], components: buttons });
        } catch (updateError) {
            console.error('Fehler beim Board-Update:', updateError);
        }
        
        saveSignupBackup();
        
        // DM-Benachrichtigung asynchron (nach 5 Sekunden) wenn genau 5 Spieler erreicht wurden
        if (previousPlayerCount < 5 && dayData.players.length === 5) {
            console.log(`📢 [Wochen-Scrim] 5 Spieler erreicht für ${day}! DMs werden in 5 Sekunden gesendet...`);
            
            // Asynchrone DM-Funktion (fire and forget)
            setTimeout(async () => {
                const scrimTime = dayData.time || '19:00';
                const scrimDate = `${day} um ${scrimTime}`;
                
                const userList = await Promise.all(dayData.players.map(async (uid) => {
                    try {
                        return await getDisplayName(uid, interaction.guild?.id);
                    } catch (e) {
                        return 'Unbekannt';
                    }
                }));
                
                for (const uid of dayData.players) {
                    try {
                        const playerDisplayName = await getDisplayName(uid, interaction.guild?.id);
                        const dmMessage = `Hey ${playerDisplayName}, das Scrim am **${scrimDate}** findet statt!\n\n` +
                            `Folgende User sind eingetragen:\n${userList.map(u => `• ${u}`).join('\n')}`;
                        const dmSent = await sendProtectedDM(uid, dmMessage, `Wochen-Scrim Found ${day}`);
                        if (dmSent) {
                            console.log(`✅ [DM] Bestätigungs-DM an ${playerDisplayName} gesendet (${day})`);
                        }
                    } catch (dmError) {
                        console.error(`❌ [DM] Konnte DM nicht an User ${uid} senden:`, dmError.message);
                    }
                }
            }, 3000); // 3 Sekunden Verzögerung
        }
        
        return;
    }
    
    // Unsign: Unregister from all games
    if (interaction.isButton() && interaction.customId.startsWith('wochen_scrim_unsign_')) {
        const parts = interaction.customId.split('_');
        const messageId = parts[3];
        const dayIndex = parseInt(parts[4]);
        let data = wochenScrimData[messageId];
        
        // Fallback: Wenn Daten fehlen, versuche aus gleicher Gruppe wiederherzustellen
        if (!data) {
            console.log(`Versuche Daten für Message ${messageId} wiederherzustellen...`);
            for (const [otherId, otherData] of Object.entries(wochenScrimData)) {
                if (otherData && otherData.groupId && otherData.style === 'wochen_scrim_multi') {
                    wochenScrimData[messageId] = JSON.parse(JSON.stringify(otherData));
                    wochenScrimData[messageId].currentPage = dayIndex;
                    data = wochenScrimData[messageId];
                    saveSignupBackup();
                    console.log(`Daten wiederhergestellt für Message ${messageId} von ${otherId}`);
                    break;
                }
            }
        }
        
        if (!data) {
            await interaction.reply({ content: '❌ Scrim-Daten nicht gefunden. Bitte erstelle ein neues Scrim mit /scrim', flags: [MessageFlags.Ephemeral] });
            return;
        }
        
        const day = WEEKDAYS[dayIndex];
        let dayData = data.days[day];
        
        // For single_message, get the first (and only) day
        if (!dayData) {
            const firstDay = Object.keys(data.days)[0];
            dayData = data.days[firstDay];
        }
        
        // SOFORT deferUpdate aufrufen (innerhalb 3 Sekunden!)
        try {
            await interaction.deferUpdate();
        } catch (deferError) {
            console.error('Fehler beim deferUpdate:', deferError);
            return;
        }
        
        const userId = interaction.user.id;
        const previousPlayerCount = dayData.players.length;
        const wasAtFive = previousPlayerCount >= 5;
        const displayName = await getDisplayName(userId, interaction.guild?.id);
        
        // Try to remove from main players first
        const playerIndex = dayData.players.indexOf(userId);
        if (playerIndex !== -1) {
            dayData.players.splice(playerIndex, 1);
            console.log(`❌ [Wochen-Scrim] ${displayName} ← Hauptspieler entfernt (${day}) | ${dayData.players.length}/5 | Message: ${messageId}`);
            
            // If there are subs, promote the first sub to main player
            if (dayData.subs.length > 0) {
                const firstSub = dayData.subs.shift();
                dayData.players.push(firstSub);
                const promotedName = await getDisplayName(firstSub, interaction.guild?.id);
                console.log(`⬆️ [Wochen-Scrim] ${promotedName} → Sub zu Hauptspieler befördert (${day})`);
            }
        } else {
            // Try to remove from subs
            const subIndex = dayData.subs.indexOf(userId);
            if (subIndex !== -1) {
                dayData.subs.splice(subIndex, 1);
                console.log(`❌ [Wochen-Scrim] ${displayName} ← Sub entfernt (${day}) | Subs: ${dayData.subs.length} | Message: ${messageId}`);
            } else {
                return; // User war nicht eingetragen
            }
        }
        
        // Board SOFORT aktualisieren
        const embed = await getWochenScrimEmbed(messageId, dayIndex, day !== WEEKDAYS[dayIndex] ? day : null);
        const buttons = getWochenScrimButtons(messageId, dayIndex);
        try {
            const message = await interaction.message.fetch();
            await message.edit({ embeds: [embed], components: buttons });
        } catch (updateError) {
            console.error('Fehler beim Board-Update:', updateError);
        }
        
        saveSignupBackup();
        
        // DM-Absage asynchron (nach 5 Sekunden) wenn von 5+ auf unter 5 gefallen UND verbliebene Spieler vorhanden
        if (wasAtFive && dayData.players.length < 5 && dayData.players.length > 0) {
            console.log(`⚠️ [Wochen-Scrim] Absage für ${day}! Von 5 auf ${dayData.players.length} Spieler gefallen. DMs werden in 5 Sekunden gesendet...`);
            
            // Asynchrone DM-Funktion (fire and forget)
            setTimeout(async () => {
                const scrimTime = dayData.time || '19:00';
                const scrimDate = `${day} um ${scrimTime}`;
                
                const userList = await Promise.all(dayData.players.map(async (uid) => {
                    try {
                        return await getDisplayName(uid, interaction.guild?.id);
                    } catch (e) {
                        return 'Unbekannt';
                    }
                }));
                
                for (const uid of dayData.players) {
                    try {
                        const playerDisplayName = await getDisplayName(uid, interaction.guild?.id);
                        const dmMessage = `⚠️ **Scrim Absage** für ${scrimDate}\n\n` +
                            `**${displayName}** hat sich ausgetragen. Es sind nur noch ${dayData.players.length} Spieler eingetragen:\n` +
                            `${userList.map(u => `• ${u}`).join('\n')}`;
                        const dmSent = await sendProtectedDM(uid, dmMessage, `Wochen-Scrim Cancelled ${day}`);
                        if (dmSent) {
                            console.log(`✅ [DM] Absage-DM an ${playerDisplayName} gesendet (${day})`);
                        }
                    } catch (dmError) {
                        console.error(`❌ [DM] Konnte Absage-DM nicht an User ${uid} senden:`, dmError.message);
                    }
                }
            }, 3000); // 3 Sekunden Verzögerung
        }
        
        return;
    }
    
    // Verwarnungen Button: Show warnings system
    if (interaction.isButton() && interaction.customId.startsWith('wochen_scrim_verwarnungen_')) {
        try {
            // Rollenprüfung: Nur Valorant Main
            const valorantMainRoleId = '1398810174873010289';
            
            const member = await interaction.guild.members.fetch(interaction.user.id);
            const hasValorantRole = member.roles.cache.has(valorantMainRoleId);
            
            if (!hasValorantRole) {
                await interaction.reply({ 
                    content: '❌ Du benötigst die Valorant Main Rolle, um auf das Verwarnungs-System zuzugreifen.', 
                    flags: [MessageFlags.Ephemeral] 
                });
                return;
            }
            
            // Hole die aktuelle ngrok-URL dynamisch
            let webUrl = process.env.WEB_URL || 'http://localhost:3000';
            try {
                const currentUrl = await getCurrentNgrokUrl();
                webUrl = currentUrl;
                process.env.WEB_URL = currentUrl; // Update für zukünftige Verwendung
            } catch (ngrokError) {
                // Falls ngrok nicht erreichbar, nutze gespeicherte URL oder localhost
                console.log('ngrok URL konnte nicht abgerufen werden, nutze gespeicherte URL');
            }
            
            // Direkt Link zur Team-Übersicht
            await interaction.reply({ 
                content: `⚠️ **Verwarnungs-System** ⚠️\n\nHier kannst du alle Verwarnungen des Main Teams einsehen.\nKlicke auf einen Spieler für detaillierte Informationen.\n\n👥 [→ Team-Übersicht öffnen](${webUrl}/warnings.html)`, 
                flags: [MessageFlags.Ephemeral] 
            });
        } catch (error) {
            console.error('Fehler beim Verwarnungen Button:', error);
            try {
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply({ 
                        content: '❌ Fehler beim Abrufen des Verwarnungs-Systems!', 
                        flags: [MessageFlags.Ephemeral] 
                    });
                }
            } catch (replyError) {
                // Silent error handling
            }
        }
        return;
    }
    
    // Zeit Change: Open modal for time change
    if (interaction.isButton() && interaction.customId.startsWith('wochen_scrim_zeitchange_')) {
        if (interaction.replied || interaction.deferred) {
            return;
        }
        
        const parts = interaction.customId.split('_');
        const messageId = parts[3];
        const dayIndex = parseInt(parts[4]);
        
        const modal = new ModalBuilder()
            .setCustomId(`wochen_scrim_zeitchange_form_${messageId}_${dayIndex}`)
            .setTitle('Neue Zeit anfragen');
        
        const zeitInput = new TextInputBuilder()
            .setCustomId('neue_zeit')
            .setLabel('Neue Zeit (HH:MM)')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('z.B. 19:30')
            .setRequired(true)
            .setMaxLength(5);
        
        modal.addComponents(new ActionRowBuilder().addComponents(zeitInput));
        
        await interaction.showModal(modal);
        return;
    }
    
    // Refresh: Refresh Wochen-Scrim display
    if (interaction.isButton() && interaction.customId.startsWith('wochen_scrim_refresh_')) {
        const parts = interaction.customId.split('_');
        const messageId = parts[3];
        const dayIndex = parseInt(parts[4]);
        let data = wochenScrimData[messageId];
        
        // Fallback: Wenn Daten fehlen, versuche aus gleicher Gruppe wiederherzustellen
        if (!data) {
            console.log(`Versuche Daten für Message ${messageId} wiederherzustellen...`);
            for (const [otherId, otherData] of Object.entries(wochenScrimData)) {
                if (otherData && otherData.groupId && otherData.style === 'wochen_scrim_multi') {
                    wochenScrimData[messageId] = JSON.parse(JSON.stringify(otherData));
                    wochenScrimData[messageId].currentPage = dayIndex;
                    data = wochenScrimData[messageId];
                    saveSignupBackup();
                    console.log(`Daten wiederhergestellt für Message ${messageId} von ${otherId}`);
                    break;
                }
            }
        }
        
        if (!data) {
            await interaction.reply({ content: '❌ Scrim-Daten nicht gefunden. Bitte erstelle ein neues Scrim mit /scrim', flags: [MessageFlags.Ephemeral] });
            return;
        }
        
        const displayName = await getDisplayName(interaction.user.id, interaction.guild?.id);
        const day = WEEKDAYS[dayIndex];
        console.log(`🔄 [Wochen-Scrim] ${displayName} → Aktualisierung (${day}) | Message: ${messageId}`);
        
        try {
            await interaction.deferUpdate();
        } catch (error) {
            console.error('Fehler beim deferUpdate für Wochen-Scrim Refresh:', error);
            return;
        }
        
        const embed = await getWochenScrimEmbed(messageId, dayIndex);
        const buttons = getWochenScrimButtons(messageId, dayIndex);
        await interaction.editReply({ embeds: [embed], components: buttons });
        console.log(`Wochen-Scrim Board Refresh von ${interaction.user.tag}`);
        return;
    }


    // SCRIM ABSAGEN BUTTON HANDLER (nur Admins)
    if (interaction.isButton() && interaction.customId.startsWith('scrim_cancel')) {
        try {
            // Admin-Prüfung
            const member = await interaction.guild.members.fetch(interaction.user.id);
            if (!(await hasAdminPermissions(member))) {
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply({ content: '❌ Nur Administratoren dürfen absagen.', flags: [MessageFlags.Ephemeral] });
                } else {
                    await interaction.followUp({ content: '❌ Nur Administratoren dürfen absagen.', flags: [MessageFlags.Ephemeral] });
                }
                return;
            }
            if (interaction.replied || interaction.deferred) {
                // Bereits bestätigt; Modal kann nicht mehr angezeigt werden
                return;
            }

            const modal = new ModalBuilder()
                .setCustomId(`scrim_cancel_form${interaction.message?.id ? `_${interaction.message.id}` : ''}`)
                .setTitle('Scrim absagen');

            const reasonPreset = new TextInputBuilder()
                .setCustomId('reason_preset')
                .setLabel('Grund (1=Mangel | 2=Technik | 3=Sonstiges)')
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('1 | 2 | 3 (optional)')
                .setRequired(false)
                .setMaxLength(1);

            const reasonCustom = new TextInputBuilder()
                .setCustomId('reason_custom')
                .setLabel('Eigener Grund (optional)')
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('z.B. Gegner abgesprungen')
                .setRequired(false)
                .setMaxLength(120);

            const extraMessage = new TextInputBuilder()
                .setCustomId('extra_message')
                .setLabel('Zusatznachricht (optional)')
                .setStyle(TextInputStyle.Paragraph)
                .setPlaceholder('Weitere Details...')
                .setRequired(false)
                .setMaxLength(500);

            const extraRecipients = new TextInputBuilder()
                .setCustomId('extra_recipients')
                .setLabel('Zusätzliche Empfänger (IDs, optional)')
                .setStyle(TextInputStyle.Paragraph)
                .setPlaceholder('123,456,789')
                .setRequired(false)
                .setMaxLength(500);

            modal.addComponents(
                new ActionRowBuilder().addComponents(reasonPreset),
                new ActionRowBuilder().addComponents(reasonCustom),
                new ActionRowBuilder().addComponents(extraMessage),
                new ActionRowBuilder().addComponents(extraRecipients)
            );

            await interaction.showModal(modal);
            return;
        } catch (error) {
            console.error('Fehler im Absagen-Button Handler:', error);
            try {
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply({ content: '❌ Fehler beim Öffnen des Absage-Formulars.', flags: [MessageFlags.Ephemeral] });
                } else {
                    await interaction.followUp({ content: '❌ Fehler beim Öffnen des Absage-Formulars.', flags: [MessageFlags.Ephemeral] });
                }
            } catch {}
            return;
        }
    }

    // COMMANDS UND BUTTONS HANDLER
    // Prüfe ob die Interaktion bereits verarbeitet wurde
    if (interaction.replied || interaction.deferred) {
        // Unterdrücke diese Nachricht - sie ist normal beim Startup
        return;
    }
    
    // Globales Error-Handling für alle Interaktionen
    const handleInteractionError = async (operation, error) => {
        if (error.code === 10062) {
            // Unterdrücke diese Nachricht - sie ist normal beim Startup
            return;
        }
        if (error.code === 40060) {
            // Unterdrücke diese Nachricht - sie ist normal beim Startup
            return;
        }
        console.error(`Fehler bei ${operation}:`, error);
    };

    // ===== BEWERBUNGS-BUTTON HANDLERS =====
    
    // Bewerbungs-Buttons (wie Scrim, aber ohne Berechtigungsprüfung)
    if (interaction.isButton() && interaction.customId.startsWith('bewerbung_')) {
        const userId = interaction.user.id;
        
        // Cooldown-Check (1.5 Sekunden zwischen Button-Klicks)
        const now = Date.now();
        const cooldownTime = 1500; // 1.5 Sekunden
        
        if (bewerbungButtonCooldown[userId]) {
            const timeSinceLastClick = now - bewerbungButtonCooldown[userId];
            if (timeSinceLastClick < cooldownTime) {
                // Noch im Cooldown - ignoriere den Klick
                try {
                    if (!interaction.replied && !interaction.deferred) {
                        await interaction.reply({
                            content: '⏳ Bitte warte einen Moment, bevor du den Button erneut klickst.',
                            flags: [MessageFlags.Ephemeral]
                        });
                    }
                } catch (error) {
                    console.log('[Bewerbung] Cooldown-Nachricht konnte nicht gesendet werden:', error.message);
                }
                return;
            }
        }
        
        // Setze Cooldown-Zeitstempel
        bewerbungButtonCooldown[userId] = now;
        
        // Bewerbung "Starten" Button
        if (interaction.customId === 'bewerbung_starten') {
            // Defer die Antwort sofort um Zeitüberschreitungen zu vermeiden
            if (!interaction.replied && !interaction.deferred) {
                await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
            }
            
            // Prüfe ob es ein Ticket-Channel ist
            const ticketPattern = /^Ticket-\d{4}$/i;
            if (!ticketPattern.test(interaction.channel.name)) {
                await interaction.editReply({ 
                    content: '❌ Dieser Befehl kann nur in einem Ticket-Channel verwendet werden.'
                });
                return;
            }
            
            // Initialisiere Bewerbungsdaten für diesen User falls noch nicht vorhanden
            if (!bewerbungen[userId]) {
                bewerbungen[userId] = {
                    channelId: interaction.channel.id,
                    ign: null,
                    realName: null,
                    trackerLink: null,
                    alter: null,
                    rang: null,
                    agents: null,
                    erfahrung: null,
                    verfuegbarkeit: null,
                    motivation: null,
                    teamwahl: null,
                    staerken: null,
                    schwaechen: null,
                    arbeiten: null,
                    zusaetzlicheInfos: null
                };
            } else {
                // Aktualisiere channelId falls User in einem anderen Ticket ist
                bewerbungen[userId].channelId = interaction.channel.id;
            }

            // Zeige Bewerbungsvorschau als normale Nachricht
            const embed = getBewerbungsvorschauEmbed(userId);
            const buttons = getBewerbungsButtons(userId);

            try {
                // Lösche alte Vorschau-Nachricht falls vorhanden
                if (bewerbungsvorschauMessages[userId]) {
                    try {
                        const oldMsgData = bewerbungsvorschauMessages[userId];
                        const oldChannel = await client.channels.fetch(oldMsgData.channelId);
                        const oldMessage = await oldChannel.messages.fetch(oldMsgData.messageId);
                        await oldMessage.delete();
                    } catch (e) {
                        // Ignoriere Fehler beim Löschen alter Nachricht
                    }
                }

                // Sende neue Vorschau-Nachricht
                const vorschauMessage = await interaction.channel.send({
                    embeds: [embed],
                    components: buttons
                });

                // Speichere Message-ID für spätere Updates
                bewerbungsvorschauMessages[userId] = {
                    messageId: vorschauMessage.id,
                    channelId: interaction.channel.id
                };

                // Lösche die ephemeral Nachricht (unsichtbar abschließen)
                await interaction.deleteReply();
            } catch (error) {
                console.error('[Bewerbung] Fehler beim Anzeigen der Vorschau:', error);
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply({ 
                        content: '❌ Fehler beim Anzeigen der Bewerbungsvorschau.',
                        flags: [MessageFlags.Ephemeral]
                    });
                } else {
                    await interaction.editReply({ 
                        content: '❌ Fehler beim Anzeigen der Bewerbungsvorschau.'
                    });
                }
            }
            return;
        }
        
        // Erfahrung (bleibt einzeln)
        if (interaction.customId.startsWith('bewerbung_erfahrung_')) {
            const buttonUserId = interaction.customId.split('_')[2];

            if (userId !== buttonUserId) {
                await interaction.reply({ 
                    content: '❌ Diese Bewerbung gehört nicht dir!',
                    flags: [MessageFlags.Ephemeral]
                });
                return;
            }

            const bewerbung = bewerbungen[userId] || {};

            const modal = new ModalBuilder()
                .setCustomId(`bewerbung_modal_erfahrung_${userId}`)
                .setTitle('Erfahrung');

            const erfahrungInput = new TextInputBuilder()
                .setCustomId('description')
                .setLabel('Erfahrung (Teams, Scrims, Premier) *')
                .setStyle(TextInputStyle.Paragraph)
                .setPlaceholder('Beschreibe deine Erfahrung... (max. 1000 Zeichen)')
                .setRequired(true)
                .setMaxLength(1000)
                .setValue(bewerbung.erfahrung || '');

            modal.addComponents(
                new ActionRowBuilder().addComponents(erfahrungInput)
            );

            try {
                await interaction.showModal(modal);
            } catch (error) {
                console.error('[Bewerbung] Fehler beim Öffnen des Modals:', error);
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply({ 
                        content: '❌ Fehler beim Öffnen des Formulars.',
                        flags: [MessageFlags.Ephemeral]
                    });
                }
            }
            return;
        }

        // Verfügbarkeit & Motivation (kombiniert)
        if (interaction.customId.startsWith('bewerbung_verfuegmotiv_')) {
            const buttonUserId = interaction.customId.split('_')[2];

            if (userId !== buttonUserId) {
                await interaction.reply({ 
                    content: '❌ Diese Bewerbung gehört nicht dir!',
                    flags: [MessageFlags.Ephemeral]
                });
                return;
            }

            const bewerbung = bewerbungen[userId] || {};

            const modal = new ModalBuilder()
                .setCustomId(`bewerbung_modal_verfuegmotiv_${userId}`)
                .setTitle('Verfügbarkeit & Motivation');

            const verfuegbarkeitInput = new TextInputBuilder()
                .setCustomId('verfuegbarkeit')
                .setLabel('Verfügbarkeit *')
                .setStyle(TextInputStyle.Paragraph)
                .setPlaceholder('Wann bist du verfügbar? (max. 500 Zeichen)')
                .setRequired(true)
                .setMaxLength(500)
                .setValue(bewerbung.verfuegbarkeit || '');

            const motivationInput = new TextInputBuilder()
                .setCustomId('motivation')
                .setLabel('Motivation *')
                .setStyle(TextInputStyle.Paragraph)
                .setPlaceholder('Was motiviert dich? (max. 500 Zeichen)')
                .setRequired(true)
                .setMaxLength(500)
                .setValue(bewerbung.motivation || '');

            modal.addComponents(
                new ActionRowBuilder().addComponents(verfuegbarkeitInput),
                new ActionRowBuilder().addComponents(motivationInput)
            );

            try {
                await interaction.showModal(modal);
            } catch (error) {
                console.error('[Bewerbung] Fehler beim Öffnen des Modals:', error);
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply({ 
                        content: '❌ Fehler beim Öffnen des Formulars.',
                        flags: [MessageFlags.Ephemeral]
                    });
                }
            }
            return;
        }

        // Stärken, Schwächen & Woran arbeiten (kombiniert)
        if (interaction.customId.startsWith('bewerbung_staerkeschwaeche_')) {
            const buttonUserId = interaction.customId.split('_')[2];

            if (userId !== buttonUserId) {
                await interaction.reply({ 
                    content: '❌ Diese Bewerbung gehört nicht dir!',
                    flags: [MessageFlags.Ephemeral]
                });
                return;
            }

            const bewerbung = bewerbungen[userId] || {};

            const modal = new ModalBuilder()
                .setCustomId(`bewerbung_modal_staerkeschwaeche_${userId}`)
                .setTitle('Stärken, Schwächen & Arbeit');

            const staerkenInput = new TextInputBuilder()
                .setCustomId('staerken')
                .setLabel('Stärken *')
                .setStyle(TextInputStyle.Paragraph)
                .setPlaceholder('Deine Stärken... (max. 500 Zeichen)')
                .setRequired(true)
                .setMaxLength(500)
                .setValue(bewerbung.staerken || '');

            const schwaechenInput = new TextInputBuilder()
                .setCustomId('schwaechen')
                .setLabel('Schwächen *')
                .setStyle(TextInputStyle.Paragraph)
                .setPlaceholder('Deine Schwächen... (max. 500 Zeichen)')
                .setRequired(true)
                .setMaxLength(500)
                .setValue(bewerbung.schwaechen || '');

            const arbeitenInput = new TextInputBuilder()
                .setCustomId('arbeiten')
                .setLabel('Woran möchtest du arbeiten? *')
                .setStyle(TextInputStyle.Paragraph)
                .setPlaceholder('Woran möchtest du arbeiten? (max. 500 Zeichen)')
                .setRequired(true)
                .setMaxLength(500)
                .setValue(bewerbung.arbeiten || '');

            modal.addComponents(
                new ActionRowBuilder().addComponents(staerkenInput),
                new ActionRowBuilder().addComponents(schwaechenInput),
                new ActionRowBuilder().addComponents(arbeitenInput)
            );

            try {
                await interaction.showModal(modal);
            } catch (error) {
                console.error('[Bewerbung] Fehler beim Öffnen des Modals:', error);
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply({ 
                        content: '❌ Fehler beim Öffnen des Formulars.',
                        flags: [MessageFlags.Ephemeral]
                    });
                }
            }
            return;
        }
        
        // ===== BEWERBUNG KOMBINIERTE MODALS =====
        
        // Persönliche Daten (IGN, Name, Alter)
        if (interaction.customId.startsWith('bewerbung_persoenlich_')) {
            const buttonUserId = interaction.customId.split('_')[2];

            if (userId !== buttonUserId) {
                await interaction.reply({ 
                    content: '❌ Diese Bewerbung gehört nicht dir!',
                    flags: [MessageFlags.Ephemeral]
                });
                return;
            }

            const bewerbung = bewerbungen[userId] || {};

            const modal = new ModalBuilder()
                .setCustomId(`bewerbung_modal_persoenlich_${userId}`)
                .setTitle('Persönliche Daten');

            const ignInput = new TextInputBuilder()
                .setCustomId('ign')
                .setLabel('In Game Name (IGN) *')
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('Dein IGN eingeben...')
                .setRequired(true)
                .setValue(bewerbung.ign || '');

            const realNameInput = new TextInputBuilder()
                .setCustomId('realname')
                .setLabel('Real Name *')
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('Dein echter Name...')
                .setRequired(true)
                .setValue(bewerbung.realName || '');

            const alterInput = new TextInputBuilder()
                .setCustomId('alter')
                .setLabel('Alter *')
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('z.B. 18')
                .setRequired(true)
                .setValue(bewerbung.alter || '');

            modal.addComponents(
                new ActionRowBuilder().addComponents(ignInput),
                new ActionRowBuilder().addComponents(realNameInput),
                new ActionRowBuilder().addComponents(alterInput)
            );

            try {
                await interaction.showModal(modal);
            } catch (error) {
                console.error('[Bewerbung] Fehler beim Öffnen des Modals:', error);
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply({ 
                        content: '❌ Fehler beim Öffnen des Formulars.',
                        flags: [MessageFlags.Ephemeral]
                    });
                }
            }
            return;
        }

        // Rang & Tracker
        if (interaction.customId.startsWith('bewerbung_rangtracker_')) {
            const buttonUserId = interaction.customId.split('_')[2];

            if (userId !== buttonUserId) {
                await interaction.reply({ 
                    content: '❌ Diese Bewerbung gehört nicht dir!',
                    flags: [MessageFlags.Ephemeral]
                });
                return;
            }

            const bewerbung = bewerbungen[userId] || {};

            const modal = new ModalBuilder()
                .setCustomId(`bewerbung_modal_rangtracker_${userId}`)
                .setTitle('Rang & Tracker');

            const rangInput = new TextInputBuilder()
                .setCustomId('rang')
                .setLabel('Rang (Aktuell / Peak) *')
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('z.B. Diamond 2 / Immortal 1')
                .setRequired(true)
                .setValue(bewerbung.rang || '');

            const trackerInput = new TextInputBuilder()
                .setCustomId('tracker')
                .setLabel('Tracker-Link *')
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('tracker.gg Link...')
                .setRequired(true)
                .setValue(bewerbung.trackerLink || '');

            modal.addComponents(
                new ActionRowBuilder().addComponents(rangInput),
                new ActionRowBuilder().addComponents(trackerInput)
            );

            try {
                await interaction.showModal(modal);
            } catch (error) {
                console.error('[Bewerbung] Fehler beim Öffnen des Modals:', error);
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply({ 
                        content: '❌ Fehler beim Öffnen des Formulars.',
                        flags: [MessageFlags.Ephemeral]
                    });
                }
            }
            return;
        }

        // Agents (bleibt einzeln)
        if (interaction.customId.startsWith('bewerbung_agents_')) {
            const buttonUserId = interaction.customId.split('_')[2];

            if (userId !== buttonUserId) {
                await interaction.reply({ 
                    content: '❌ Diese Bewerbung gehört nicht dir!',
                    flags: [MessageFlags.Ephemeral]
                });
                return;
            }

            const bewerbung = bewerbungen[userId] || {};

            const modal = new ModalBuilder()
                .setCustomId(`bewerbung_modal_agents_${userId}`)
                .setTitle('Agents');

            const agentsInput = new TextInputBuilder()
                .setCustomId('value')
                .setLabel('Agents (Main / Secondary) *')
                .setStyle(TextInputStyle.Paragraph)
                .setPlaceholder('z.B. Main: Jett, Reyna | Secondary: Sage, KJ')
                .setRequired(true)
                .setValue(bewerbung.agents || '');

            modal.addComponents(
                new ActionRowBuilder().addComponents(agentsInput)
            );

            try {
                await interaction.showModal(modal);
            } catch (error) {
                console.error('[Bewerbung] Fehler beim Öffnen des Modals:', error);
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply({ 
                        content: '❌ Fehler beim Öffnen des Formulars.',
                        flags: [MessageFlags.Ephemeral]
                    });
                }
            }
            return;
        }

        // Zusätzliche Infos (bleibt einzeln)
        if (interaction.customId.startsWith('bewerbung_zusaetzlich_')) {
            const buttonUserId = interaction.customId.split('_')[2];

            if (userId !== buttonUserId) {
                await interaction.reply({ 
                    content: '❌ Diese Bewerbung gehört nicht dir!',
                    flags: [MessageFlags.Ephemeral]
                });
                return;
            }

            const bewerbung = bewerbungen[userId] || {};

            const modal = new ModalBuilder()
                .setCustomId(`bewerbung_modal_zusaetzlich_${userId}`)
                .setTitle('Zusätzliche Infos');

            const zusaetzlichInput = new TextInputBuilder()
                .setCustomId('value')
                .setLabel('Zusätzliche Infos')
                .setStyle(TextInputStyle.Paragraph)
                .setPlaceholder('Zusätzliche Informationen... (optional)')
                .setRequired(false)
                .setMaxLength(1000)
                .setValue(bewerbung.zusaetzlicheInfos || '');

            modal.addComponents(
                new ActionRowBuilder().addComponents(zusaetzlichInput)
            );

            try {
                await interaction.showModal(modal);
            } catch (error) {
                console.error('[Bewerbung] Fehler beim Öffnen des Modals:', error);
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply({ 
                        content: '❌ Fehler beim Öffnen des Formulars.',
                        flags: [MessageFlags.Ephemeral]
                    });
                }
            }
            return;
        }
        
        // Bewerbung Teamwahl Button
        if (interaction.customId.startsWith('bewerbung_teamwahl_')) {
            // SOFORT die Interaktion bestätigen (innerhalb von 3 Sekunden)
            try {
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.deferUpdate();
                }
            } catch (error) {
                console.error('Fehler beim deferUpdate für Bewerbung:', error);
                return;
            }
            
            const buttonUserId = interaction.customId.split('_')[2];

            if (userId !== buttonUserId) {
                await interaction.editReply({ 
                    content: '❌ Diese Bewerbung gehört nicht dir!' 
                });
                return;
            }

            if (!bewerbungen[userId]) {
                bewerbungen[userId] = {
                    channelId: null,
                    ign: null,
                    realName: null,
                    trackerLink: null,
                    alter: null,
                    rang: null,
                    agents: null,
                    erfahrung: null,
                    verfuegbarkeit: null,
                    motivation: null,
                    teamwahl: { main: false, rising: false, sun: false, moon: false },
                    staerken: null,
                    schwaechen: null,
                    arbeiten: null,
                    zusaetzlicheInfos: null
                };
            }

            if (!bewerbungen[userId].teamwahl) {
                bewerbungen[userId].teamwahl = { main: false, rising: false, sun: false, moon: false };
            }

            const selectMenu = new StringSelectMenuBuilder()
                .setCustomId(`bewerbung_teamwahl_select_${userId}`)
                .setPlaceholder('Wähle ein Team aus')
                .setMinValues(1)
                .setMaxValues(1)
                .addOptions(
                    new StringSelectMenuOptionBuilder()
                        .setLabel('Main (Asc–Immortal)')
                        .setValue('main')
                        .setDescription('Main Team')
                        .setDefault(bewerbungen[userId].teamwahl.main),
                    new StringSelectMenuOptionBuilder()
                        .setLabel('Rising (Platin–Diamond)')
                        .setValue('rising')
                        .setDescription('Rising Team')
                        .setDefault(bewerbungen[userId].teamwahl.rising),
                    new StringSelectMenuOptionBuilder()
                        .setLabel('Sun (Silber–Gold)')
                        .setValue('sun')
                        .setDescription('Sun Team')
                        .setDefault(bewerbungen[userId].teamwahl.sun),
                    new StringSelectMenuOptionBuilder()
                        .setLabel('Moon (Silber–Gold)')
                        .setValue('moon')
                        .setDescription('Moon Team')
                        .setDefault(bewerbungen[userId].teamwahl.moon)
                );

            const row = new ActionRowBuilder().addComponents(selectMenu);

            try {
                await interaction.editReply({ 
                    content: 'Wähle deine Teamwahl aus:', 
                    components: [row]
                });
            } catch (error) {
                console.error('[Bewerbung] Fehler beim Anzeigen der Teamwahl:', error);
            }
            return;
        }
        
        // Bewerbung Abschicken Button
        if (interaction.customId.startsWith('bewerbung_abschicken_')) {
            // SOFORT die Interaktion bestätigen (innerhalb von 3 Sekunden)
            try {
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.deferReply({ ephemeral: true });
                }
            } catch (error) {
                console.error('Fehler beim deferReply für Bewerbung:', error);
                return;
            }
            
            const buttonUserId = interaction.customId.split('_')[2];

            if (userId !== buttonUserId) {
                await interaction.editReply({ 
                    content: '❌ Diese Bewerbung gehört nicht dir!' 
                });
                return;
            }

            if (!bewerbungen[userId]) {
                await interaction.editReply({ 
                    content: '❌ Bewerbungsdaten nicht gefunden.' 
                });
                return;
            }

            // Prüfe ob alle Felder ausgefüllt sind
            if (!isBewerbungVollstaendig(userId)) {
                await interaction.editReply({ 
                    content: '❌ Bitte fülle alle Pflichtfelder aus, bevor du die Bewerbung abschickst.' 
                });
                return;
            }

            const bewerbung = bewerbungen[userId];
            const channelId = bewerbung.channelId;

            if (!channelId) {
                await interaction.editReply({ 
                    content: '❌ Ticket-Channel nicht gefunden. Bitte erstelle ein neues Ticket.' 
                });
                return;
            }

            try {
                // Lösche Vorschau-Nachricht bevor die finale Bewerbung gesendet wird
                if (bewerbungsvorschauMessages[userId]) {
                    try {
                        const msgData = bewerbungsvorschauMessages[userId];
                        const vorschauChannel = await client.channels.fetch(msgData.channelId);
                        const vorschauMessage = await vorschauChannel.messages.fetch(msgData.messageId);
                        await vorschauMessage.delete();
                        delete bewerbungsvorschauMessages[userId];
                    } catch (e) {
                        // Ignoriere Fehler beim Löschen der Vorschau
                        console.error('[Bewerbung] Fehler beim Löschen der Vorschau:', e);
                    }
                }

                const channel = await client.channels.fetch(channelId);
                
                // Erstelle finales Bewerbungs-Embed
                const finalEmbed = new EmbedBuilder()
                    .setTitle('📄 Team – Bewerbung')
                    .setColor(0x5865F2)
                    .setTimestamp()
                    .setAuthor({ 
                        name: interaction.user.tag, 
                        iconURL: interaction.user.displayAvatarURL() 
                    });

                let description = '';
                description += `**🎮 In Game Name (IGN):** ${bewerbung.ign}\n\n`;
                description += `**👤 Real Name:** ${bewerbung.realName}\n\n`;
                description += `**🔗 Tracker-Link:** ${bewerbung.trackerLink}\n\n`;
                description += `**Alter:** ${bewerbung.alter}\n\n`;
                description += `**Rang (Aktuell / Peak):** ${bewerbung.rang}\n\n`;
                description += `**Agents (Main / Secondary Agents):** ${bewerbung.agents}\n\n`;
                description += `**Erfahrung (Teams, Scrims, Premier):**\n${bewerbung.erfahrung}\n\n`;
                description += `**Verfügbarkeit:**\n${bewerbung.verfuegbarkeit}\n\n`;
                description += `**Motivation:**\n${bewerbung.motivation}\n\n`;
                
                // Teamwahl
                const teams = [];
                if (bewerbung.teamwahl.main) teams.push('✅ Main (Asc–Immortal)');
                if (bewerbung.teamwahl.rising) teams.push('✅ Rising (Platin–Diamond)');
                if (bewerbung.teamwahl.sun) teams.push('✅ Sun (Silber–Gold)');
                if (bewerbung.teamwahl.moon) teams.push('✅ Moon (Silber–Gold)');
                description += `**Teamwahl:**\n${teams.join('\n')}\n\n`;
                
                description += `**Stärken:**\n${bewerbung.staerken}\n\n`;
                description += `**Schwächen:**\n${bewerbung.schwaechen}\n\n`;
                description += `**Woran möchtest du arbeiten?**\n${bewerbung.arbeiten}\n\n`;
                
                if (bewerbung.zusaetzlicheInfos) {
                    description += `**Zusätzliche Infos:**\n${bewerbung.zusaetzlicheInfos}\n`;
                }

                finalEmbed.setDescription(description);

                // Sende Bewerbung in den Ticket-Channel
                await channel.send({ embeds: [finalEmbed] });

                await interaction.editReply({ 
                    content: '✅ Bewerbung erfolgreich abgeschickt!' 
                });

                // Poste Bewerbung in den Team-spezifischen Bewerbungs-Channel
                try {
                    // Bestimme welches Team ausgewählt wurde
                    let teamKey = bewerbung.team || null;
                    
                    // Fallback: Prüfe teamwahl wenn team nicht gesetzt ist
                    if (!teamKey) {
                        if (bewerbung.teamwahl.main) teamKey = 'main';
                        else if (bewerbung.teamwahl.rising) teamKey = 'rising';
                        else if (bewerbung.teamwahl.sun) teamKey = 'sun';
                        else if (bewerbung.teamwahl.moon) teamKey = 'moon';
                    }

                    console.log(`[Bewerbung] Poste Bewerbung für Team: ${teamKey}`);

                    if (teamKey && BEWERBUNGS_CHANNELS[teamKey]) {
                        const bewerbungsChannelId = BEWERBUNGS_CHANNELS[teamKey];
                        const bewerbungsChannel = await client.channels.fetch(bewerbungsChannelId);
                        
                        if (bewerbungsChannel) {
                            // Erstelle Accept/Reject Buttons
                            const actionRow = new ActionRowBuilder()
                                .addComponents(
                                    new ButtonBuilder()
                                        .setCustomId(`bewerbung_accept_${userId}_${teamKey}`)
                                        .setLabel('Annehmen')
                                        .setStyle(ButtonStyle.Success)
                                        .setEmoji('✅'),
                                    new ButtonBuilder()
                                        .setCustomId(`bewerbung_reject_${userId}_${teamKey}`)
                                        .setLabel('Ablehnen')
                                        .setStyle(ButtonStyle.Danger)
                                        .setEmoji('❌'),
                                    new ButtonBuilder()
                                        .setCustomId(`bewerbung_custom_${userId}_${teamKey}`)
                                        .setLabel('Custom Message')
                                        .setStyle(ButtonStyle.Primary)
                                        .setEmoji('✏️')
                                );

                            // Poste Bewerbung in Team-Channel
                            await bewerbungsChannel.send({ 
                                content: `**Neue Bewerbung für ${getTeamName(teamKey)}**\nBewerber: <@${userId}> (${interaction.user.tag})\nTicket: <#${channelId}>`,
                                embeds: [finalEmbed],
                                components: [actionRow]
                            });
                            
                            console.log(`[Bewerbung] ✅ Bewerbung erfolgreich in Channel ${bewerbungsChannelId} gepostet`);
                        } else {
                            console.error(`[Bewerbung] ❌ Bewerbungs-Channel ${bewerbungsChannelId} nicht gefunden!`);
                        }
                    } else {
                        console.log('[Bewerbung] ⚠️ Kein Bewerbungs-Channel für dieses Team definiert');
                    }
                } catch (postError) {
                    console.error('[Bewerbung] ❌ Fehler beim Posten der Bewerbung in Team-Channel:', postError);
                    console.error('[Bewerbung] Stack Trace:', postError.stack);
                }

            } catch (error) {
                console.error('[Bewerbung] Fehler beim Abschicken:', error);
                await interaction.editReply({ 
                    content: '❌ Fehler beim Abschicken der Bewerbung. Bitte versuche es erneut oder kontaktiere einen Admin.' 
                });
            }
            return;
        }
    }

    // ===== BEWERBUNGS-ANNAHME/ABLEHNUNG BUTTONS =====
    // KEINE ROLLENPRÜFUNG - Jeder mit Zugriff auf den Channel kann Bewerbungen bearbeiten
    
    // Bewerbung Annehmen Button
    if (interaction.isButton() && interaction.customId.startsWith('bewerbung_accept_')) {
        // KEIN instant respond - die Verarbeitung kann sich Zeit lassen
        const parts = interaction.customId.split('_');
        const bewerberId = parts[2];
        const teamKey = parts[3];
        
        console.log(`[Bewerbung] Accept für Bewerber ${bewerberId}, Team: ${teamKey}`);
        
        try {
            // Hole den Bewerber
            const guild = interaction.guild;
            const bewerber = await guild.members.fetch(bewerberId);
            
            if (!bewerber) {
                await interaction.reply({ 
                    content: '❌ Bewerber nicht gefunden!', 
                    flags: [MessageFlags.Ephemeral] 
                });
                return;
            }
            
            // Vergebe Tryout-Rolle
            const tryoutRoleId = TRYOUT_ROLLEN[teamKey];
            if (tryoutRoleId) {
                try {
                    await bewerber.roles.add(tryoutRoleId);
                    console.log(`[Bewerbung] Tryout-Rolle ${tryoutRoleId} an ${bewerber.user.tag} vergeben`);
                } catch (roleError) {
                    console.error(`[Bewerbung] Fehler beim Vergeben der Rolle:`, roleError);
                }
            }
            
            // Sende Nachricht an Bewerber (Default oder Custom)
            const customMessage = customBewerbungsMessages[teamKey]?.accept;
            const defaultMessage = `<@${bewerberId}>, herzlichen Glückwunsch! Sie wurden in das Tryout aufgenommen. Die Rolle für Tryout und die Berechtigung haben Sie hiermit soeben erhalten. Bitte fragen Sie im Team-Chat oder Ihren Manager, wann Ihr Tryout beginnt.`;
            const messageToSend = customMessage || defaultMessage;
            
            try {
                await bewerber.send(messageToSend);
                console.log(`[Bewerbung] Annahme-Nachricht an ${bewerber.user.tag} gesendet`);
            } catch (dmError) {
                console.error(`[Bewerbung] Konnte DM nicht senden:`, dmError);
            }
            
            // Update die Bewerbungs-Nachricht
            await interaction.message.edit({
                content: interaction.message.content + `\n\n✅ **ANGENOMMEN** von <@${interaction.user.id}>`,
                components: [] // Entferne Buttons
            });
            
            // Lösche das Ticket-Channel SOFORT nach Annahme
            try {
                // Extrahiere Ticket-Channel-ID aus der Nachricht (Format: "Ticket: <#CHANNEL_ID>")
                const ticketChannelMatch = interaction.message.content.match(/Ticket: <#(\d+)>/);
                if (ticketChannelMatch) {
                    const ticketChannelId = ticketChannelMatch[1];
                    const ticketChannel = await guild.channels.fetch(ticketChannelId);
                    
                    if (ticketChannel) {
                        await ticketChannel.delete('Bewerbung wurde angenommen');
                        console.log(`[Bewerbung] Ticket-Channel ${ticketChannelId} wurde sofort gelöscht (Annahme)`);
                    }
                }
            } catch (deleteError) {
                console.error('[Bewerbung] Fehler beim Löschen des Ticket-Channels:', deleteError);
            }
            
            // Erst NACH der Verarbeitung antworten
            await interaction.reply({ 
                content: `✅ Bewerbung von <@${bewerberId}> wurde angenommen, die Tryout-Rolle wurde vergeben und das Ticket wurde gelöscht!`,
                flags: [MessageFlags.Ephemeral]
            });
        } catch (error) {
            console.error('[Bewerbung] Fehler beim Annehmen:', error);
            try {
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply({ 
                        content: '❌ Fehler beim Annehmen der Bewerbung.',
                        flags: [MessageFlags.Ephemeral]
                    });
                }
            } catch (e) {
                console.error('[Bewerbung] Fehler beim Senden der Fehler-Nachricht:', e);
            }
        }
        return;
    }
    
    // Bewerbung Ablehnen Button
    if (interaction.isButton() && interaction.customId.startsWith('bewerbung_reject_')) {
        // KEIN instant respond - die Verarbeitung kann sich Zeit lassen
        const parts = interaction.customId.split('_');
        const bewerberId = parts[2];
        const teamKey = parts[3];
        
        console.log(`[Bewerbung] Reject für Bewerber ${bewerberId}, Team: ${teamKey}`);
        
        try {
            // Hole den Bewerber
            const guild = interaction.guild;
            const bewerber = await guild.members.fetch(bewerberId);
            
            if (!bewerber) {
                await interaction.reply({ 
                    content: '❌ Bewerber nicht gefunden!',
                    flags: [MessageFlags.Ephemeral]
                });
                return;
            }
            
            // Sende Nachricht an Bewerber (Default oder Custom)
            const customMessage = customBewerbungsMessages[teamKey]?.reject;
            const defaultMessage = `Guten Tag <@${bewerberId}>, ich muss Ihnen leider mitteilen, dass Sie abgelehnt wurden, da Ihr Profil leider nicht zum Team aktuell passt. Wir wünschen Ihnen dennoch viel Erfolg bei ihrer Team Suche! Mit freundlichen Grüßen ~Blue Cloud Gaming.`;
            const messageToSend = customMessage || defaultMessage;
            
            try {
                await bewerber.send(messageToSend);
                console.log(`[Bewerbung] Ablehnungs-Nachricht an ${bewerber.user.tag} gesendet`);
            } catch (dmError) {
                console.error(`[Bewerbung] Konnte DM nicht senden:`, dmError);
            }
            
            // Update die Bewerbungs-Nachricht
            await interaction.message.edit({
                content: interaction.message.content + `\n\n❌ **ABGELEHNT** von <@${interaction.user.id}>\n⏰ Ticket wird in 24 Stunden gelöscht`,
                components: [] // Entferne Buttons
            });
            
            // Lösche das Ticket-Channel NACH 24 Stunden (1 Tag)
            try {
                // Extrahiere Ticket-Channel-ID aus der Nachricht (Format: "Ticket: <#CHANNEL_ID>")
                const ticketChannelMatch = interaction.message.content.match(/Ticket: <#(\d+)>/);
                if (ticketChannelMatch) {
                    const ticketChannelId = ticketChannelMatch[1];
                    
                    // Setze Timer für 24 Stunden (86400000 ms)
                    setTimeout(async () => {
                        try {
                            const ticketChannel = await guild.channels.fetch(ticketChannelId);
                            if (ticketChannel) {
                                await ticketChannel.delete('Bewerbung wurde abgelehnt - 24 Stunden vergangen');
                                console.log(`[Bewerbung] Ticket-Channel ${ticketChannelId} wurde nach 24 Stunden gelöscht (Ablehnung)`);
                            }
                        } catch (deleteError) {
                            console.error('[Bewerbung] Fehler beim verzögerten Löschen des Ticket-Channels:', deleteError);
                        }
                    }, 86400000); // 24 Stunden = 86400000 ms
                    
                    console.log(`[Bewerbung] Timer gesetzt: Ticket ${ticketChannelId} wird in 24 Stunden gelöscht`);
                }
            } catch (timerError) {
                console.error('[Bewerbung] Fehler beim Setzen des Lösch-Timers:', timerError);
            }
            
            // Erst NACH der Verarbeitung antworten
            await interaction.reply({ 
                content: `❌ Bewerbung von <@${bewerberId}> wurde abgelehnt. Das Ticket wird in 24 Stunden automatisch gelöscht.`,
                flags: [MessageFlags.Ephemeral]
            });
        } catch (error) {
            console.error('[Bewerbung] Fehler beim Ablehnen:', error);
            try {
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply({ 
                        content: '❌ Fehler beim Ablehnen der Bewerbung.',
                        flags: [MessageFlags.Ephemeral]
                    });
                }
            } catch (e) {
                console.error('[Bewerbung] Fehler beim Senden der Fehler-Nachricht:', e);
            }
        }
        return;
    }
    
    // Custom Message Button - Öffnet Modal zum Setzen der Custom Message
    if (interaction.isButton() && interaction.customId.startsWith('bewerbung_custom_')) {
        try {
            const parts = interaction.customId.split('_');
            const bewerberId = parts[2];
            const teamKey = parts[3];
            
            // Erstelle Modal für Custom Message
            const modal = new ModalBuilder()
                .setCustomId(`bewerbung_custom_modal_${bewerberId}_${teamKey}`)
                .setTitle(`Custom Message für ${getTeamName(teamKey)}`);
            
            const acceptInput = new TextInputBuilder()
                .setCustomId('custom_accept')
                .setLabel('Annahme-Nachricht (leer = keine Änderung)')
                .setStyle(TextInputStyle.Paragraph)
                .setPlaceholder('Nachricht bei Annahme...')
                .setRequired(false)
                .setValue(customBewerbungsMessages[teamKey]?.accept || '');
            
            const rejectInput = new TextInputBuilder()
                .setCustomId('custom_reject')
                .setLabel('Ablehnungs-Nachricht (leer = keine Änderung)')
                .setStyle(TextInputStyle.Paragraph)
                .setPlaceholder('Nachricht bei Ablehnung...')
                .setRequired(false)
                .setValue(customBewerbungsMessages[teamKey]?.reject || '');
            
            const firstRow = new ActionRowBuilder().addComponents(acceptInput);
            const secondRow = new ActionRowBuilder().addComponents(rejectInput);
            
            modal.addComponents(firstRow, secondRow);
            
            await interaction.showModal(modal);
        } catch (error) {
            console.error('[Bewerbung] Fehler beim Öffnen des Custom Message Modals:', error);
        }
        return;
    }
    
    // ===== BEWERBUNG MODAL SUBMISSIONS =====
    
    // Custom Message Modal Submission
    if (interaction.isModalSubmit() && interaction.customId.startsWith('bewerbung_custom_modal_')) {
        // KEIN instant respond - die Verarbeitung kann sich Zeit lassen
        const parts = interaction.customId.split('_');
        const teamKey = parts[4];
        
        try {
            const customAccept = interaction.fields.getTextInputValue('custom_accept');
            const customReject = interaction.fields.getTextInputValue('custom_reject');
            
            let acceptStatus = '';
            let rejectStatus = '';
            
            // Update Custom Messages
            // Wenn leer → Default verwenden (null setzen)
            // Wenn Text → Custom Message setzen
            if (customAccept.trim()) {
                customBewerbungsMessages[teamKey].accept = customAccept.trim();
                acceptStatus = '✅ Custom Message gesetzt';
            } else {
                customBewerbungsMessages[teamKey].accept = null;
                acceptStatus = '🔄 Auf Default zurückgesetzt';
            }
            
            if (customReject.trim()) {
                customBewerbungsMessages[teamKey].reject = customReject.trim();
                rejectStatus = '✅ Custom Message gesetzt';
            } else {
                customBewerbungsMessages[teamKey].reject = null;
                rejectStatus = '🔄 Auf Default zurückgesetzt';
            }
            
            console.log(`[Bewerbung] Custom Messages für ${teamKey} aktualisiert`);
            
            // Erst NACH der Verarbeitung antworten
            await interaction.reply({ 
                content: `✅ Einstellungen für **${getTeamName(teamKey)}** gespeichert!\n\n` +
                         `**Annahme-Nachricht:** ${acceptStatus}\n` +
                         `**Ablehnungs-Nachricht:** ${rejectStatus}\n\n` +
                         `💡 **Tipp:** Lasse das Feld leer um zur Standard-Nachricht zurückzukehren.`,
                flags: [MessageFlags.Ephemeral]
            });
        } catch (error) {
            console.error('[Bewerbung] Fehler beim Speichern der Custom Messages:', error);
            try {
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply({ 
                        content: '❌ Fehler beim Speichern der Custom Messages.',
                        flags: [MessageFlags.Ephemeral]
                    });
                }
            } catch (e) {
                console.error('[Bewerbung] Fehler beim Senden der Fehler-Nachricht:', e);
            }
        }
        return;
    }
    
    // Bewerbung Modal Submission Handler
    if (interaction.isModalSubmit() && interaction.customId.startsWith('bewerbung_modal_')) {
        const parts = interaction.customId.split('_');
        const fieldType = parts[2]; // persoenlich, rangtracker, agents, erfahrung, verfuegmotiv, staerkeschwaeche, zusaetzlich
        const userId = parts[3];

        if (interaction.user.id !== userId) {
            await interaction.reply({ 
                content: '❌ Diese Bewerbung gehört nicht dir!', 
                flags: [MessageFlags.Ephemeral] 
            });
            return;
        }

        if (!interaction.replied && !interaction.deferred) {
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
        }

        // Initialisiere Bewerbung falls nicht vorhanden
        if (!bewerbungen[userId]) {
            bewerbungen[userId] = {
                channelId: null,
                ign: null,
                realName: null,
                trackerLink: null,
                alter: null,
                rang: null,
                agents: null,
                erfahrung: null,
                verfuegbarkeit: null,
                motivation: null,
                teamwahl: null,
                staerken: null,
                schwaechen: null,
                arbeiten: null,
                zusaetzlicheInfos: null
            };
        }

        // Verarbeite die verschiedenen Modal-Typen
        if (fieldType === 'persoenlich') {
            // Persönliche Daten: IGN, Name, Alter
            bewerbungen[userId].ign = interaction.fields.getTextInputValue('ign');
            bewerbungen[userId].realName = interaction.fields.getTextInputValue('realname');
            bewerbungen[userId].alter = interaction.fields.getTextInputValue('alter');
        } else if (fieldType === 'rangtracker') {
            // Rang & Tracker
            bewerbungen[userId].rang = interaction.fields.getTextInputValue('rang');
            bewerbungen[userId].trackerLink = interaction.fields.getTextInputValue('tracker');
        } else if (fieldType === 'agents') {
            // Agents (einzeln)
            bewerbungen[userId].agents = interaction.fields.getTextInputValue('value');
        } else if (fieldType === 'erfahrung') {
            // Erfahrung (einzeln)
            bewerbungen[userId].erfahrung = interaction.fields.getTextInputValue('description');
        } else if (fieldType === 'verfuegmotiv') {
            // Verfügbarkeit & Motivation
            bewerbungen[userId].verfuegbarkeit = interaction.fields.getTextInputValue('verfuegbarkeit');
            bewerbungen[userId].motivation = interaction.fields.getTextInputValue('motivation');
        } else if (fieldType === 'staerkeschwaeche') {
            // Stärken, Schwächen & Woran arbeiten
            bewerbungen[userId].staerken = interaction.fields.getTextInputValue('staerken');
            bewerbungen[userId].schwaechen = interaction.fields.getTextInputValue('schwaechen');
            bewerbungen[userId].arbeiten = interaction.fields.getTextInputValue('arbeiten');
        } else if (fieldType === 'zusaetzlich') {
            // Zusätzliche Infos (einzeln, optional)
            bewerbungen[userId].zusaetzlicheInfos = interaction.fields.getTextInputValue('value');
        }

        // Aktualisiere Vorschau-Nachricht falls vorhanden
        const embed = getBewerbungsvorschauEmbed(userId);
        const buttons = getBewerbungsButtons(userId);

        try {
            // Versuche die bestehende Vorschau-Nachricht zu aktualisieren
            if (bewerbungsvorschauMessages[userId]) {
                const msgData = bewerbungsvorschauMessages[userId];
                try {
                    const channel = await client.channels.fetch(msgData.channelId);
                    const message = await channel.messages.fetch(msgData.messageId);
                    await message.edit({ 
                        embeds: [embed], 
                        components: buttons 
                    });
                    // Stumme Bestätigung - lösche ephemeral Antwort
                    try {
                        await interaction.deleteReply();
                    } catch (e) {
                        // Ignoriere Fehler beim Löschen
                    }
                    return; // Wichtig: Beende hier, damit keine weitere Nachricht gesendet wird
                } catch (msgError) {
                    // Falls Nachricht nicht mehr existiert (Error 10008), erstelle neue im Channel
                    if (msgError.code === 10008 || msgError.code === 10003) {
                        // Unknown Message oder Unknown Channel - erstelle neue Nachricht
                        // Lösche alte Message-ID aus dem Cache, da sie nicht mehr existiert
                        delete bewerbungsvorschauMessages[userId];
                        try {
                            const channel = await client.channels.fetch(msgData.channelId);
                            const newMessage = await channel.send({
                                embeds: [embed],
                                components: buttons
                            });
                            bewerbungsvorschauMessages[userId] = {
                                messageId: newMessage.id,
                                channelId: channel.id
                            };
                            // Lösche ephemeral Antwort
                            try {
                                await interaction.deleteReply();
                            } catch (e) {
                                // Ignoriere Fehler beim Löschen
                            }
                            return; // Wichtig: Beende hier
                        } catch (channelError) {
                            // Falls Channel auch nicht mehr existiert, verwende aktuellen Channel
                            const newMessage = await interaction.channel.send({
                                embeds: [embed],
                                components: buttons
                            });
                            bewerbungsvorschauMessages[userId] = {
                                messageId: newMessage.id,
                                channelId: interaction.channel.id
                            };
                            try {
                                await interaction.deleteReply();
                            } catch (e) {
                                // Ignoriere Fehler beim Löschen
                            }
                            return; // Wichtig: Beende hier
                        }
                    } else {
                        // Anderer Fehler - logge und versuche es im aktuellen Channel
                        console.error('[Bewerbung] Fehler beim Aktualisieren der Vorschau-Nachricht:', msgError);
                        // Lösche alte Message-ID aus dem Cache
                        delete bewerbungsvorschauMessages[userId];
                        const newMessage = await interaction.channel.send({
                            embeds: [embed],
                            components: buttons
                        });
                        bewerbungsvorschauMessages[userId] = {
                            messageId: newMessage.id,
                            channelId: interaction.channel.id
                        };
                        try {
                            await interaction.deleteReply();
                        } catch (e) {
                            // Ignoriere Fehler beim Löschen
                        }
                        return; // Wichtig: Beende hier
                    }
                }
            } else {
                // Keine bestehende Nachricht, erstelle neue im Channel
                const newMessage = await interaction.channel.send({
                    embeds: [embed],
                    components: buttons
                });
                bewerbungsvorschauMessages[userId] = {
                    messageId: newMessage.id,
                    channelId: interaction.channel.id
                };
                // Lösche ephemeral Antwort
                try {
                    await interaction.deleteReply();
                } catch (e) {
                    // Ignoriere Fehler beim Löschen
                }
            }
        } catch (error) {
            console.error('[Bewerbung] Fehler beim Aktualisieren der Vorschau:', error);
            // Stumme Fehlerbehandlung - lösche ephemeral Antwort
            try {
                await interaction.deleteReply();
            } catch (e) {
                // Ignoriere Fehler
            }
        }
        return;
    }

    // Bewerbung Teamwahl Select Menu Handler
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('bewerbung_teamwahl_select_')) {
        const userId = interaction.customId.split('_')[3];

        if (interaction.user.id !== userId) {
            await interaction.reply({ 
                content: '❌ Diese Bewerbung gehört nicht dir!', 
                flags: [MessageFlags.Ephemeral] 
            });
            return;
        }

        if (!interaction.replied && !interaction.deferred) {
            await interaction.deferUpdate();
        }

        // Initialisiere Bewerbung falls nicht vorhanden
        if (!bewerbungen[userId]) {
            bewerbungen[userId] = {
                channelId: null,
                ign: null,
                realName: null,
                trackerLink: null,
                alter: null,
                rang: null,
                agents: null,
                erfahrung: null,
                verfuegbarkeit: null,
                motivation: null,
                teamwahl: { main: false, rising: false, sun: false, moon: false },
                staerken: null,
                schwaechen: null,
                arbeiten: null,
                zusaetzlicheInfos: null
            };
        }

        if (!bewerbungen[userId].teamwahl) {
            bewerbungen[userId].teamwahl = { main: false, rising: false, sun: false, moon: false };
        }

        // Setze Teamwahl basierend auf Auswahl (nur eine Auswahl möglich)
        const selected = interaction.values[0]; // Nur erste Auswahl, da maxValues(1)
        bewerbungen[userId].teamwahl = {
            main: selected === 'main',
            rising: selected === 'rising',
            sun: selected === 'sun',
            moon: selected === 'moon'
        };

        // Aktualisiere Vorschau-Nachricht falls vorhanden
        const embed = getBewerbungsvorschauEmbed(userId);
        const buttons = getBewerbungsButtons(userId);

        try {
            // Versuche die bestehende Vorschau-Nachricht zu aktualisieren
            if (bewerbungsvorschauMessages[userId]) {
                const msgData = bewerbungsvorschauMessages[userId];
                try {
                    const channel = await client.channels.fetch(msgData.channelId);
                    const message = await channel.messages.fetch(msgData.messageId);
                    await message.edit({ 
                        embeds: [embed], 
                        components: buttons 
                    });
                    // Select Menu hat keine Reply, daher nichts zu löschen
                    return; // Wichtig: Beende hier, damit keine weitere Nachricht gesendet wird
                } catch (msgError) {
                    // Falls Nachricht nicht mehr existiert (Error 10008), erstelle neue im Channel
                    if (msgError.code === 10008 || msgError.code === 10003) {
                        // Unknown Message oder Unknown Channel - erstelle neue Nachricht
                        // Lösche alte Message-ID aus dem Cache, da sie nicht mehr existiert
                        delete bewerbungsvorschauMessages[userId];
                        try {
                            const channel = await client.channels.fetch(msgData.channelId);
                            const newMessage = await channel.send({
                                embeds: [embed],
                                components: buttons
                            });
                            bewerbungsvorschauMessages[userId] = {
                                messageId: newMessage.id,
                                channelId: channel.id
                            };
                            return; // Wichtig: Beende hier
                        } catch (channelError) {
                            // Falls Channel auch nicht mehr existiert, verwende aktuellen Channel
                            const newMessage = await interaction.channel.send({
                                embeds: [embed],
                                components: buttons
                            });
                            bewerbungsvorschauMessages[userId] = {
                                messageId: newMessage.id,
                                channelId: interaction.channel.id
                            };
                            return; // Wichtig: Beende hier
                        }
                    } else {
                        // Anderer Fehler - logge und versuche es im aktuellen Channel
                        console.error('[Bewerbung] Fehler beim Aktualisieren der Vorschau-Nachricht:', msgError);
                        // Lösche alte Message-ID aus dem Cache
                        delete bewerbungsvorschauMessages[userId];
                        const newMessage = await interaction.channel.send({
                            embeds: [embed],
                            components: buttons
                        });
                        bewerbungsvorschauMessages[userId] = {
                            messageId: newMessage.id,
                            channelId: interaction.channel.id
                        };
                        return; // Wichtig: Beende hier
                    }
                }
            } else {
                // Keine bestehende Nachricht, erstelle neue im Channel
                const newMessage = await interaction.channel.send({
                    embeds: [embed],
                    components: buttons
                });
                bewerbungsvorschauMessages[userId] = {
                    messageId: newMessage.id,
                    channelId: interaction.channel.id
                };
            }
        } catch (error) {
            console.error('[Bewerbung] Fehler beim Aktualisieren der Vorschau:', error);
        }
        return;
    }

    // Modal Submission Handler
    if (interaction.isModalSubmit() && (interaction.customId === 'abwesend_form_v2' || interaction.customId === 'abwesend_form_admin_v2')) {
        // Sofortiges deferReply um Timeout zu vermeiden (behebt Unknown interaction 10062)
        const interactionAgeMs = Date.now() - interaction.createdTimestamp;
        if (interactionAgeMs > 2500) {
            return;
        }

        if (!interaction.replied && !interaction.deferred) {
            try {
                await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
            } catch (e) {
                console.error('Fehler beim deferReply für Modal-Abwesenheit:', e);
                return;
            }
        }

        const startDateStr = interaction.fields.getTextInputValue('start_date');
        const endDateStr = interaction.fields.getTextInputValue('end_date');
        const startTimeStr = interaction.fields.getTextInputValue('start_time') || null;
        const endTimeStr = interaction.fields.getTextInputValue('end_time') || null;
        
        // User trägt Abwesenheit für sich selbst ein
        const userId = interaction.user.id;
        const targetUser = null;
        const reason = null; // Kein Grund-Feld im aktuellen Modal

        try {
            // Datum validieren (DD.MM.YYYY)
            const dateRegex = /^(\d{2})\.(\d{2})\.(\d{4})$/;
            const startMatch = startDateStr.match(dateRegex);
            const endMatch = endDateStr.match(dateRegex);

            if (!startMatch || !endMatch) {
                await interaction.editReply({ 
                    content: '❌ Ungültiges Datumsformat! Verwende DD.MM.YYYY (z.B. 17.06.2025)'
                });
                return;
            }

            const startDate = new Date(
                parseInt(startMatch[3]), 
                parseInt(startMatch[2]) - 1, 
                parseInt(startMatch[1])
            );
            const endDate = new Date(
                parseInt(endMatch[3]), 
                parseInt(endMatch[2]) - 1, 
                parseInt(endMatch[1])
            );

            if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
                await interaction.editReply({ 
                    content: '❌ Ungültiges Datum!'
                });
                return;
            }

            if (startDate > endDate) {
                await interaction.editReply({ 
                    content: '❌ Startdatum muss vor dem Enddatum liegen!'
                });
                return;
            }

            // Uhrzeit validieren (HH:MM Format)
            let startTime = null;
            let endTime = null;
            
            if (startTimeStr) {
                const timeRegex = /^(\d{1,2}):(\d{2})$/;
                const startTimeMatch = startTimeStr.match(timeRegex);
                if (!startTimeMatch) {
                    await interaction.editReply({ 
                        content: '❌ Ungültiges Startzeit-Format! Verwende HH:MM (z.B. 09:00)'
                    });
                    return;
                }
                startTime = startTimeStr;
            }
            
            if (endTimeStr) {
                const timeRegex = /^(\d{1,2}):(\d{2})$/;
                const endTimeMatch = endTimeStr.match(timeRegex);
                if (!endTimeMatch) {
                    await interaction.editReply({ 
                        content: '❌ Ungültiges Endzeit-Format! Verwende HH:MM (z.B. 17:00)'
                    });
                    return;
                }
                endTime = endTimeStr;
            }

            // Verwende lokale Datumsformatierung um Zeitzonenprobleme zu vermeiden
            const startDateISO = `${startDate.getFullYear()}-${String(startDate.getMonth() + 1).padStart(2, '0')}-${String(startDate.getDate()).padStart(2, '0')}`;
            const endDateISO = `${endDate.getFullYear()}-${String(endDate.getMonth() + 1).padStart(2, '0')}-${String(endDate.getDate()).padStart(2, '0')}`;

            // Prüfe ob bereits eine Abwesenheit für diesen Zeitraum existiert
            const existingIndex = abwesenheiten.findIndex(abw => 
                abw.userId === userId && 
                ((abw.startDate <= startDateISO && abw.endDate >= startDateISO) ||
                 (abw.startDate <= endDateISO && abw.endDate >= endDateISO) ||
                 (abw.startDate >= startDateISO && abw.endDate <= endDateISO))
            );

            if (existingIndex !== -1) {
                await interaction.editReply({ 
                    content: '❌ Du hast bereits eine Abwesenheit für diesen Zeitraum eingetragen!'
                });
                return;
            }

            // Abwesenheit hinzufügen
            abwesenheiten.push({
                userId: userId,
                startDate: startDateISO,
                endDate: endDateISO,
                startTime: startTime,
                endTime: endTime,
                reason: reason,
                addedAt: getGermanDate().toISOString()
            });

            // Backup speichern
            saveSignupBackup();

            // Antwort
            let responseText;
            if (false) { // targetUser is always null now
                responseText = `✅ ${targetUser.displayName || targetUser.username} ist als abwesend markiert von ${startDateStr} bis ${endDateStr}`;
            } else {
                responseText = `✅ Du bist als abwesend markiert von ${startDateStr} bis ${endDateStr}`;
            }
            if (reason) {
                responseText += ` (Grund: ${reason})`;
            }
            responseText += `. ${targetUser ? 'Er/Sie' : 'Du'} erhält${targetUser ? '' : 'st'} in dieser Zeit keine DMs oder Erinnerungen.`;

            await interaction.editReply({ 
                content: responseText
            });

            // Console-Logging mit Grund
            let logMessage;
            if (targetUser) {
                logMessage = `Abwesenheit über Modal hinzugefügt (Admin): ${targetUser.tag} von ${startDateStr} bis ${endDateStr} (eingetragen von ${interaction.user.tag})`;
            } else {
                logMessage = `Abwesenheit über Modal hinzugefügt: ${interaction.user.tag} von ${startDateStr} bis ${endDateStr}`;
            }
            if (reason) {
                logMessage += ` - Grund: "${reason}"`;
            }
            console.log(logMessage);

            // Board nach 0,5 Sekunden aktualisieren (separater try-catch um Hauptinteraktion nicht zu beeinträchtigen)
            setTimeout(async () => {
                try {
                    const channelId = interaction.channel.id;
                
                // Premier Board aktualisieren
                if (premierBoards[channelId]?.messageId && premierBoards[channelId]?.channelId) {
                    try {
                        const channel = await client.channels.fetch(premierBoards[channelId]?.channelId);
                        const premierMessageId = premierBoards[channelId]?.messageId;
                        const embed = await getSignupEmbed(client, null, premierMessageId);
                        const userId = getFirstSignedUpUserId() || client.user.id;
                        const buttonRows = getButtonRow(userId, false, premierMessageId);
                        await channel.messages.fetch(premierMessageId).then(msg => 
                            msg.edit({ embeds: [embed], components: buttonRows })
                        );
                    } catch (e) {
                        console.error('Fehler beim Aktualisieren des Premier-Boards nach Modal-Abwesenheit:', e);
                    }
                }
                
                // Practice Board aktualisieren
                if (practiceBoards[channelId]?.messageId && practiceBoards[channelId]?.channelId) {
                    try {
                        const channel = await client.channels.fetch(practiceBoards[channelId]?.channelId);
                        const practiceMessageId = practiceBoards[channelId]?.messageId;
                        const embed = await getPracticeSignupEmbed(client, null, practiceMessageId);
                        const buttonRows = getPracticeButtonRowsWithControls(client.user.id, false, practiceMessageId);
                        await channel.messages.fetch(practiceMessageId).then(msg =>
                            msg.edit({ embeds: [embed], components: buttonRows })
                        );
                    } catch (e) {
                        console.error('Fehler beim Aktualisieren des Practice-Boards nach Modal-Abwesenheit:', e);
                    }
                }
                
                // Tournament Board aktualisieren
                if (tournamentBoards[channelId]?.messageId && tournamentBoards[channelId]?.channelId) {
                    try {
                        const channel = await client.channels.fetch(tournamentBoards[channelId]?.channelId);
                        const embed = await getTournamentSignupEmbed(client, null, tournamentBoards[channelId]?.page || 0, tournamentBoards[channelId]?.messageId);
                        const buttonRows = getTournamentButtonRowsWithControls(null, true, tournamentBoards[channelId]?.page || 0);
                        await channel.messages.fetch(tournamentBoards[channelId]?.messageId).then(msg =>
                            msg.edit({ embeds: [embed], components: buttonRows })
                        );
                    } catch (e) {
                        console.error('Fehler beim Aktualisieren des Tournament-Boards nach Modal-Abwesenheit:', e);
                    }
                }
                
                // Scrim Boards aktualisieren (alle in diesem Channel)
                for (const [messageId, board] of Object.entries(scrimBoards)) {
                    if (board.channelId === channelId) {
                        try {
                            const channel = await client.channels.fetch(board.channelId);
                            const embed = await getScrimSignupEmbed(client, null, board.day, board.time, null, messageId);
                            const buttonRows = getScrimButtonRowsWithControls(null, true, null, messageId);
                            await channel.messages.fetch(messageId).then(msg =>
                                msg.edit({ embeds: [embed], components: buttonRows })
                            );
                        } catch (e) {
                            console.error(`Fehler beim Aktualisieren des Scrim-Boards ${messageId} nach Modal-Abwesenheit:`, e);
                        }
                    }
                }
                
                // Wochen-Scrim Boards aktualisieren (alle in diesem Channel)
                for (const [wochenMessageId, wochenData] of Object.entries(wochenScrimData)) {
                    if (scrimBoards[wochenMessageId]?.channelId === channelId) {
                        try {
                            const channel = await client.channels.fetch(scrimBoards[wochenMessageId]?.channelId);
                            const message = await channel.messages.fetch(wochenMessageId);
                            
                            if (wochenData.style === 'wochen_scrim' || wochenData.style === 'single_message') {
                                // Single message or single message style
                                const dayIndex = wochenData.style === 'single_message' 
                                    ? WEEKDAYS.indexOf(Object.keys(wochenData.days)[0])
                                    : wochenData.currentPage || 0;
                                const specificDay = wochenData.style === 'single_message' 
                                    ? Object.keys(wochenData.days)[0]
                                    : null;
                                const embed = await getWochenScrimEmbed(wochenMessageId, dayIndex, specificDay);
                                const buttons = getWochenScrimButtons(wochenMessageId, dayIndex);
                                await message.edit({ embeds: [embed], components: buttons });
                            } else if (wochenData.style === 'wochen_scrim_multi') {
                                // Multiple messages - update all messages in this group
                                const groupId = wochenData.groupId;
                                const multiMessages = Object.keys(wochenScrimData).filter(id => 
                                    wochenScrimData[id].style === 'wochen_scrim_multi' && 
                                    wochenScrimData[id].groupId === groupId
                                );
                                
                                for (const dayMessageId of multiMessages) {
                                    try {
                                        const dayData = wochenScrimData[dayMessageId];
                                        const dayIndex = dayData.currentPage || 0;
                                        const dayChannel = await client.channels.fetch(scrimBoards[dayMessageId]?.channelId);
                                        const dayMessage = await dayChannel.messages.fetch(dayMessageId);
                                        const embed = await getWochenScrimEmbed(dayMessageId, dayIndex);
                                        const buttons = getWochenScrimButtons(dayMessageId, dayIndex);
                                        await dayMessage.edit({ embeds: [embed], components: buttons });
                                    } catch (e) {
                                        console.error(`Fehler beim Aktualisieren des Wochen-Scrim-Boards ${dayMessageId}:`, e);
                                    }
                                }
                            }
                        } catch (e) {
                            console.error(`Fehler beim Aktualisieren des Wochen-Scrim-Boards ${wochenMessageId} nach Modal-Abwesenheit:`, e);
                        }
                    }
                }
                } catch (e) {
                    console.error('Fehler beim Board-Update nach Modal-Abwesenheit:', e);
                }
            }, 500);

        } catch (error) {
            console.error('Fehler beim Verarbeiten der Modal-Abwesenheit:', error);
            try {
                // Da wir deferReply verwenden, können wir editReply verwenden
                await interaction.editReply({ 
                    content: '❌ Fehler beim Verarbeiten der Abwesenheit. Bitte versuche es erneut.'
                });
            } catch (e) {
                console.error('Fehler beim Senden der Fehlermeldung:', e);
            }
        }
        return;
    }

    // Scrim Absage Modal Submit
    if (interaction.isModalSubmit() && interaction.customId.startsWith('scrim_cancel_form')) {
        try {
            // Admin-Prüfung
            const member = await interaction.guild.members.fetch(interaction.user.id);
            if (!(await hasAdminPermissions(member))) {
                await interaction.reply({ content: '❌ Nur Administratoren dürfen absagen.', flags: [MessageFlags.Ephemeral] });
                return;
            }

            const [, messageId] = interaction.customId.split('_form_');
            const targetMessageId = messageId || (interaction.message?.id);

            if (!targetMessageId || !scrimBoards[targetMessageId]) {
                await interaction.reply({ content: '❌ Konnte das Scrim-Board nicht finden.', flags: [MessageFlags.Ephemeral] });
                return;
            }

            const preset = (interaction.fields.getTextInputValue('reason_preset') || '').trim();
            const customReason = (interaction.fields.getTextInputValue('reason_custom') || '').trim();
            const extraMsg = (interaction.fields.getTextInputValue('extra_message') || '').trim();
            const extraRecipientsRaw = (interaction.fields.getTextInputValue('extra_recipients') || '').trim();

            let reason = '';
            if (customReason) {
                reason = customReason;
            } else if (preset === '1') {
                reason = 'Spieler Mangel';
            } else if (preset === '2') {
                reason = 'Technische Probleme';
            } else if (preset === '3') {
                reason = 'Sonstiges';
            } else {
                reason = 'Absage';
            }

            const board = scrimBoards[targetMessageId];
            const channel = await client.channels.fetch(board.channelId);

            // Sammle alle eingetragenen Spieler über alle Games
            const signupMap = scrimSignups[targetMessageId] || {};
            const uniqueUserIds = new Set();
            for (const users of Object.values(signupMap)) {
                for (const uid of users) uniqueUserIds.add(uid);
            }

            // Zusätzliche Empfänger verarbeiten (IDs, Komma/Leerzeichen getrennt)
            if (extraRecipientsRaw) {
                extraRecipientsRaw.split(/[\s,]+/).forEach(id => {
                    const trimmed = id.trim();
                    if (trimmed.match(/^\d{5,}$/)) uniqueUserIds.add(trimmed);
                });
            }

            // Liste der angemeldeten Spieler (für die Nachricht)
            const signedUpList = await getPlayerListText(Array.from(uniqueUserIds));

            const day = board.day;
            const time = board.time;
            let announcement = `❌ Scrim abgesagt (${day} ${time})\nGrund: ${reason}`;
            if (extraMsg) announcement += `\n\n${extraMsg}`;
            if (signedUpList) announcement += `\n\nEingetragen waren: ${signedUpList}`;

            // Post in Channel
            await interaction.reply({ content: announcement });

            // Optional: DMs senden an alle Betroffenen (respect DM guards)
            for (const uid of uniqueUserIds) {
                await sendProtectedDM(uid, `Scrim abgesagt (${day} ${time}). Grund: ${reason}${extraMsg ? `\n\n${extraMsg}` : ''}`, 'Scrim Absage');
            }

            return;
        } catch (error) {
            console.error('Fehler beim Verarbeiten der Scrim-Absage:', error);
            try {
                await interaction.reply({ content: '❌ Fehler beim Verarbeiten der Absage.', flags: [MessageFlags.Ephemeral] });
            } catch {}
            return;
        }
    }
    
    // Wochen-Scrim Zeit Change Modal Submit
    if (interaction.isModalSubmit() && interaction.customId.startsWith('wochen_scrim_zeitchange_form_')) {
        try {
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
            
            const parts = interaction.customId.split('_');
            const messageId = parts[4];
            const dayIndex = parseInt(parts[5]);
            let data = wochenScrimData[messageId];
            
            // Fallback: Wenn Daten fehlen, versuche aus gleicher Gruppe wiederherzustellen
            if (!data) {
                console.log(`Versuche Daten für Message ${messageId} wiederherzustellen...`);
                for (const [otherId, otherData] of Object.entries(wochenScrimData)) {
                    if (otherData && otherData.groupId && otherData.style === 'wochen_scrim_multi') {
                        wochenScrimData[messageId] = JSON.parse(JSON.stringify(otherData));
                        wochenScrimData[messageId].currentPage = dayIndex;
                        data = wochenScrimData[messageId];
                        saveSignupBackup();
                        console.log(`Daten wiederhergestellt für Message ${messageId} von ${otherId}`);
                        break;
                    }
                }
            }
            
            if (!data) {
                await interaction.editReply({ content: '❌ Scrim-Daten nicht gefunden. Bitte erstelle ein neues Scrim mit /scrim' });
                return;
            }
            
            const neueZeit = interaction.fields.getTextInputValue('neue_zeit').trim();
            
            // Validate time format (HH:MM)
            const timeRegex = /^([0-1]?[0-9]|2[0-3]):([0-5][0-9])$/;
            if (!timeRegex.test(neueZeit)) {
                await interaction.editReply({ content: '❌ Ungültiges Zeitformat! Verwende HH:MM (z.B. 19:30)' });
                return;
            }
            
            const day = WEEKDAYS[dayIndex];
            const dayData = data.days[day];
            const requesterId = interaction.user.id;
            const requesterName = interaction.user.username;
            
            // Send DMs to all registered players for voting
            const votingId = `${messageId}_${dayIndex}_${Date.now()}`;
            dayData.timeChangeRequests.push({
                id: votingId,
                requester: requesterId,
                newTime: neueZeit,
                votes: { accept: [], decline: [], suggest: [] },
                suggestions: {}
            });
            
            await interaction.editReply({ content: `✅ Zeit-Änderungs-Anfrage gesendet! Warte auf Abstimmung der Spieler.` });
            
            // Send DM to all registered players
            for (const playerId of dayData.players) {
                if (playerId === requesterId) continue; // Don't send to requester
                
                try {
                    const embed = new EmbedBuilder()
                        .setTitle('⏰ Zeit-Änderungs-Anfrage')
                        .setDescription(`${requesterName} möchte die Zeit für **${day}** ändern.`)
                        .addFields(
                            { name: 'Aktuelle Zeit', value: dayData.time, inline: true },
                            { name: 'Neue Zeit', value: neueZeit, inline: true }
                        )
                        .setColor('#FFA500');
                    
                    const voteButtons = new ActionRowBuilder().addComponents(
                        new ButtonBuilder()
                            .setCustomId(`wochen_scrim_vote_accept_${votingId}`)
                            .setLabel('✅ Zustimmen')
                            .setStyle(ButtonStyle.Success),
                        new ButtonBuilder()
                            .setCustomId(`wochen_scrim_vote_decline_${votingId}`)
                            .setLabel('❌ Ablehnen')
                            .setStyle(ButtonStyle.Danger),
                        new ButtonBuilder()
                            .setCustomId(`wochen_scrim_vote_suggest_${votingId}`)
                            .setLabel('💡 Zeit vorschlagen')
                            .setStyle(ButtonStyle.Primary)
                    );
                    
                    const user = await client.users.fetch(playerId);
                    await user.send({ embeds: [embed], components: [voteButtons] });
                } catch (error) {
                    console.error(`Fehler beim Senden der Voting-DM an ${playerId}:`, error);
                }
            }
            
            saveSignupBackup();
        } catch (error) {
            console.error('Fehler beim Verarbeiten der Zeit-Änderung:', error);
            try {
                await interaction.editReply({ content: '❌ Fehler beim Verarbeiten der Zeit-Änderung.' });
            } catch {}
        }
        return;
    }
    
    // Voting Buttons in DMs
    if (interaction.isButton() && interaction.customId.startsWith('wochen_scrim_vote_')) {
        const parts = interaction.customId.split('_');
        const voteType = parts[3]; // accept, decline, suggest
        const votingId = parts.slice(4).join('_');
        
        // Find the request
        let foundData = null;
        let foundDayIndex = -1;
        let foundRequest = null;
        
        for (const msgId in wochenScrimData) {
            const data = wochenScrimData[msgId];
            // Safety check: ensure data.days exists
            if (!data || !data.days) continue;
            
            for (let i = 0; i < WEEKDAYS.length; i++) {
                const day = WEEKDAYS[i];
                // Safety check: ensure data.days[day] exists and has timeChangeRequests
                if (!data.days[day] || !data.days[day].timeChangeRequests) continue;
                
                const request = data.days[day].timeChangeRequests.find(r => r.id === votingId);
                if (request) {
                    foundData = data;
                    foundDayIndex = i;
                    foundRequest = request;
                    break;
                }
            }
            if (foundData) break;
        }
        
        if (!foundRequest) {
            await interaction.reply({ content: '❌ Abstimmung nicht gefunden oder bereits abgeschlossen.', flags: [MessageFlags.Ephemeral] });
            return;
        }
        
        const userId = interaction.user.id;
        
        // Berechtigungsprüfung: Prüfe ob User für diesen Tag registriert ist oder die entsprechende Rolle hat
        const day = WEEKDAYS[foundDayIndex];
        const dayData = foundData.days[day];
        
        // ZUERST: Prüfe ob User für diesen Tag registriert ist (wichtigster Check - funktioniert auch bei DMs!)
        if (dayData.players && dayData.players.includes(userId)) {
            // User ist für diesen Tag registriert - darf voten ✅
        } else {
            // User ist NICHT registriert - prüfe Rollen (nur in Guild möglich)
            if (interaction.guild) {
                let member = interaction.member;
                if (!member) {
                    member = await interaction.guild.members.fetch(userId).catch(() => null);
                }
                
                if (member) {
                    // Erlaubte Rollen für Scrim-Voting: Valorant Main und andere Scrim-Rollen
                    const allowedRoleIds = [
                        '1414241851963342848', // Valorant Main
                        '1398810174873010289', // Main Team
                        '1399133902341148742', // Tryout Main
                        '1402222026655010887', // Academy Team
                        '1402222294612316310'  // Academy Tryout
                    ];
                    
                    const hasAllowedRole = allowedRoleIds.some(roleId => member.roles.cache.has(roleId));
                    
                    if (!hasAllowedRole) {
                        await interaction.reply({ 
                            content: '❌ Du hast nicht die erforderliche Berechtigung, um diese Aktion auszuführen.', 
                            flags: [MessageFlags.Ephemeral] 
                        });
                        return;
                    }
                } else {
                    await interaction.reply({ 
                        content: '❌ Du hast nicht die erforderliche Berechtigung, um diese Aktion auszuführen.', 
                        flags: [MessageFlags.Ephemeral] 
                    });
                    return;
                }
            } else {
                // DM-Interaktion und User ist NICHT registriert - keine Berechtigung
                await interaction.reply({ 
                    content: '❌ Du bist nicht für diesen Tag registriert und kannst daher nicht abstimmen.', 
                    flags: [MessageFlags.Ephemeral] 
                });
                return;
            }
        }
        
        // Remove from other vote categories
        foundRequest.votes.accept = foundRequest.votes.accept.filter(id => id !== userId);
        foundRequest.votes.decline = foundRequest.votes.decline.filter(id => id !== userId);
        foundRequest.votes.suggest = foundRequest.votes.suggest.filter(id => id !== userId);
        
        if (voteType === 'accept') {
            foundRequest.votes.accept.push(userId);
            await interaction.reply({ content: '✅ Du hast der Zeit-Änderung zugestimmt.', flags: [MessageFlags.Ephemeral] });
        } else if (voteType === 'decline') {
            foundRequest.votes.decline.push(userId);
            await interaction.reply({ content: '❌ Du hast die Zeit-Änderung abgelehnt.', flags: [MessageFlags.Ephemeral] });
        } else if (voteType === 'suggest') {
            // Open modal for time suggestion
            if (interaction.replied || interaction.deferred) {
                return;
            }
            
            const modal = new ModalBuilder()
                .setCustomId(`wochen_scrim_suggest_time_${votingId}`)
                .setTitle('Zeit vorschlagen');
            
            const zeitInput = new TextInputBuilder()
                .setCustomId('suggested_time')
                .setLabel('Deine vorgeschlagene Zeit (HH:MM)')
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('z.B. 20:00')
                .setRequired(true)
                .setMaxLength(5);
            
            modal.addComponents(new ActionRowBuilder().addComponents(zeitInput));
            await interaction.showModal(modal);
            return;
        }
        
        saveSignupBackup();
        
        // Check if all players voted
        // day and dayData are already defined in the permission check above
        const totalVotes = foundRequest.votes.accept.length + foundRequest.votes.decline.length + foundRequest.votes.suggest.length;
        
        if (totalVotes >= dayData.players.length - 1) { // -1 because requester doesn't vote
            // All voted - determine result
            if (foundRequest.votes.accept.length > foundRequest.votes.decline.length) {
                // Accept the change
                dayData.time = foundRequest.newTime;
                
                // Notify all players
                try {
                    const requester = await client.users.fetch(foundRequest.requester);
                    await requester.send(`✅ Deine Zeit-Änderung für **${day}** wurde angenommen! Neue Zeit: ${foundRequest.newTime}`);
                } catch {}
                
                for (const playerId of dayData.players) {
                    if (playerId === foundRequest.requester) continue;
                    try {
                        const user = await client.users.fetch(playerId);
                        await user.send(`✅ Zeit-Änderung für **${day}** wurde angenommen! Neue Zeit: ${foundRequest.newTime}`);
                    } catch {}
                }
            } else {
                // Decline the change
                try {
                    const requester = await client.users.fetch(foundRequest.requester);
                    await requester.send(`❌ Deine Zeit-Änderung für **${day}** wurde abgelehnt.`);
                } catch {}
            }
            
            // Remove the request
            dayData.timeChangeRequests = dayData.timeChangeRequests.filter(r => r.id !== votingId);
            saveSignupBackup();
        }
        
        return;
    }
    
    // Time Suggestion Modal Submit
    if (interaction.isModalSubmit() && interaction.customId.startsWith('wochen_scrim_suggest_time_')) {
        try {
            const votingId = interaction.customId.split('_').slice(4).join('_');
            const suggestedTime = interaction.fields.getTextInputValue('suggested_time').trim();
            
            // Validate time format
            const timeRegex = /^([0-1]?[0-9]|2[0-3]):([0-5][0-9])$/;
            if (!timeRegex.test(suggestedTime)) {
                await interaction.reply({ content: '❌ Ungültiges Zeitformat! Verwende HH:MM (z.B. 20:00)', flags: [MessageFlags.Ephemeral] });
                return;
            }
            
            // Find the request
            let foundRequest = null;
            for (const msgId in wochenScrimData) {
                const data = wochenScrimData[msgId];
                // Safety check: ensure data.days exists
                if (!data || !data.days) continue;
                
                for (const day of WEEKDAYS) {
                    // Safety check: ensure data.days[day] exists and has timeChangeRequests
                    if (!data.days[day] || !data.days[day].timeChangeRequests) continue;
                    
                    const request = data.days[day].timeChangeRequests.find(r => r.id === votingId);
                    if (request) {
                        foundRequest = request;
                        foundRequest.votes.suggest.push(interaction.user.id);
                        foundRequest.suggestions[interaction.user.id] = suggestedTime;
                        break;
                    }
                }
                if (foundRequest) break;
            }
            
            if (!foundRequest) {
                await interaction.reply({ content: '❌ Abstimmung nicht gefunden.', flags: [MessageFlags.Ephemeral] });
                return;
            }
            
            await interaction.reply({ content: `✅ Du hast die Zeit ${suggestedTime} vorgeschlagen.`, flags: [MessageFlags.Ephemeral] });
            saveSignupBackup();
        } catch (error) {
            console.error('Fehler beim Verarbeiten des Zeit-Vorschlags:', error);
            try {
                await interaction.reply({ content: '❌ Fehler beim Verarbeiten des Vorschlags.', flags: [MessageFlags.Ephemeral] });
            } catch {}
        }
        return;
    }

    // Tournament-Buttons
    if (interaction.isButton() && interaction.customId.startsWith('tournament_')) {
        // ZUERST: Button-Berechtigung prüfen (Rollencheck)
        const permissionCheck = await hasButtonPermission(interaction, 'tournament');
        if (!permissionCheck.hasPermission) {
            await interaction.reply({ 
                content: `❌ Kein Zugriff - benötigte Rolle: ${permissionCheck.requiredRole}`, 
                flags: [MessageFlags.Ephemeral] 
            });
            return;
        }
        
        // DANN: Board-Existenz prüfen
        const messageId = interaction.message.id;
        if (!tournamentBoards[messageId]) return;
        
        const userId = interaction.user.id;
        let updated = false;
        
        // Stelle sicher, dass tournamentSignups für diese Message existiert
        if (!tournamentSignups[messageId] || typeof tournamentSignups[messageId] !== 'object') {
            tournamentSignups[messageId] = {};
            for (let i = 0; i < tournamentConfig.dates.length; i++) {
                const key = getTournamentKey(i);
                tournamentSignups[messageId][key] = [];
            }
        }
        
        for (let i = 0; i < tournamentConfig.dates.length; i++) {
            const key = getTournamentKey(i);
            if (interaction.customId === `tournament_signup_${i}`) {
                // Race Condition Schutz
                if (isSignupLocked('tournament', userId)) {
                    await interaction.deferUpdate();
                    return;
                }
                
                const current = tournamentSignups[messageId][key] || [];
                if (!current.includes(userId) && current.length < MAX_USERS) {
                    lockSignup('tournament', userId);
                    try {
                        // SOFORT die Interaktion bestätigen (innerhalb von 3 Sekunden)
                        try {
                            await interaction.deferUpdate();
                        } catch (error) {
                            console.error('Fehler beim deferUpdate für Tournament:', error);
                            return;
                        }
                        
                        tournamentSignups[messageId][key].push(userId);
                        markSignupDataChanged();
                        validateSignupData();
                        updated = true;
                        console.log(`Eingetragen: ${interaction.user.tag} für Tournament ${tournamentConfig.labels[i]} (Message ${messageId})`);
                        
                        if (tournamentSignups[messageId][key].length === MAX_USERS) {
                            console.log(`Tournament ${tournamentConfig.labels[i]} ist voll! Sende DMs...`);
                            await sendTournamentFoundDM(key);
                        }
                    } finally {
                        unlockSignup('tournament', userId);
                    }
                }
            }
            if (interaction.customId === `tournament_unsign_${i}`) {
                // SOFORT die Interaktion bestätigen (innerhalb von 3 Sekunden)
                try {
                    await interaction.deferUpdate();
                } catch (error) {
                    console.error('Fehler beim deferUpdate für Tournament Unsign:', error);
                    return;
                }
                
                const current = tournamentSignups[messageId][key] || [];
                if (current.includes(userId)) {
                    tournamentSignups[messageId][key] = current.filter(u => u !== userId);
                    markSignupDataChanged();
                    validateSignupData();
                    updated = true;
                    console.log(`Entfernt: ${interaction.user.tag} von Tournament ${tournamentConfig.labels[i]} (Message ${messageId})`);
                }
            }
        }
        
        // Navigation Handlers
        if (interaction.customId === 'tournament_prev_page') {
            try {
                await interaction.deferUpdate();
            } catch (error) {
                console.error('Fehler beim deferUpdate für Tournament Prev:', error);
                return;
            }
            const currentPage = tournamentBoards[messageId].page || 0;
            if (currentPage > 0) {
                tournamentBoards[messageId].page = currentPage - 1;
                updated = true;
            }
        }
        
        if (interaction.customId === 'tournament_next_page') {
            try {
                await interaction.deferUpdate();
            } catch (error) {
                console.error('Fehler beim deferUpdate für Tournament Next:', error);
                return;
            }
            const currentPage = tournamentBoards[messageId].page || 0;
            if (currentPage < tournamentConfig.groups.length - 1) {
                tournamentBoards[messageId].page = currentPage + 1;
                updated = true;
            }
        }
        
        // Refresh Button
        if (interaction.customId === 'tournament_refresh_board') {
            try {
                await interaction.deferUpdate();
            } catch (error) {
                console.error('Fehler beim deferUpdate für Tournament Refresh:', error);
                return;
            }
            updated = true;
            console.log(`Tournament Board Refresh von ${interaction.user.tag}`);
        }
        
        // Delete Board Handler (nur für Admins)
        if (interaction.customId === 'delete_tournament_board') {
            // Admin-Prüfung
            const member = await interaction.guild.members.fetch(interaction.user.id);
            if (!(await hasAdminPermissions(member))) {
                try {
                    await interaction.followUp({ content: '❌ Nur Administratoren können Boards löschen.', flags: [MessageFlags.Ephemeral] });
                } catch (e) {
                    console.error('Fehler beim Senden der Admin-Prüfungs-Nachricht:', e);
                }
                return;
            }
            
            try {
                // Lösche die Nachricht
                const msg = await interaction.channel.messages.fetch(messageId);
                await msg.delete();
                delete tournamentBoards[messageId];
                delete tournamentSignups[messageId];
                
                // Message-ID aus roles.json entfernen
                await removeMessageIdFromBoard('tournament', messageId);
                
                console.log(`Tournament Board manuell gelöscht von Admin: ${interaction.user.tag}`);
            } catch (error) {
                console.error('Fehler beim manuellen Löschen des Tournament-Boards:', error);
            }
            return;
        }
        
        // Board aktualisieren wenn nötig
        if (updated && tournamentBoards[messageId]) {
            for (const key in userCache) delete userCache[key];
            setTimeout(async () => {
                try {
                    const channel = await client.channels.fetch(tournamentBoards[messageId].channelId);
                    const currentPage = tournamentBoards[messageId].page || 0;
                    const embed = await getTournamentSignupEmbed(client, interaction.user.id, currentPage, messageId);
                    // Prüfe Admin-Status für den AKTUELLEN User (der die Interaktion ausführt)
                    const isAdmin = await checkUserAdminStatus(interaction.user.id, interaction.guild?.id);
                    const buttonRows = getTournamentButtonRowsWithControls(interaction.user.id, isAdmin, currentPage);
                    await channel.messages.fetch(messageId).then(msg => 
                        msg.edit({ embeds: [embed], components: buttonRows })
                    );
                } catch (e) {
                    // Wenn Nachricht nicht gefunden wird (gelöscht), Board-Eintrag bereinigen
                    if (e.code === 10008) {
                        console.log(`Tournament-Board ${messageId} wurde gelöscht - bereinige Board-Cache`);
                        delete tournamentBoards[messageId];
                        delete tournamentSignups[messageId];
                    } else {
                        console.error('Fehler beim Aktualisieren des Tournament-Boards:', e);
                    }
                }
            }, 100);
        }
        return;
    }

    // Premier-Buttons
    if (interaction.isButton() && !interaction.customId.startsWith('practice_') && !interaction.customId.startsWith('scrim_') && !interaction.customId.startsWith('tournament_')) {
        // ZUERST: Button-Berechtigung prüfen (Rollencheck)
        const permissionCheck = await hasButtonPermission(interaction, 'premier');
        if (!permissionCheck.hasPermission) {
            await interaction.reply({ 
                content: `❌ Kein Zugriff - benötigte Rolle: ${permissionCheck.requiredRole}`, 
                flags: [MessageFlags.Ephemeral] 
            });
            return;
        }
        
        // DANN: Board-Existenz prüfen
        const messageId = interaction.message.id;
        if (!premierBoards[messageId]) return;
        
        const userId = interaction.user.id;
        let updated = false;
        
        // Stelle sicher, dass premierSignups für diese Message existiert
        if (!premierSignups[messageId] || typeof premierSignups[messageId] !== 'object') {
            premierSignups[messageId] = {};
            for (const day of premierConfig.days) {
                premierSignups[messageId][day] = [];
            }
        }
        
        for (let i = 0; i < premierConfig.days.length; i++) {
            const day = premierConfig.days[i];
            const key = getPremierKey(i);
            if (interaction.customId === `signup_${i}`) {
                // Race Condition Schutz
                if (isSignupLocked('premier', userId)) {
                    await interaction.deferUpdate();
                    return;
                }
                
                const current = premierSignups[messageId][day] || [];
                if (!current.includes(userId) && current.length < MAX_USERS) {
                    lockSignup('premier', userId);
                    try {
                        // SOFORT die Interaktion bestätigen (innerhalb von 3 Sekunden)
                        try {
                            await interaction.deferUpdate();
                        } catch (error) {
                            console.error('Fehler beim deferUpdate für Premier:', error);
                            return;
                        }
                        
                        premierSignups[messageId][day].push(userId);
                        markSignupDataChanged();
                        validateSignupData();
                        updated = true;
                        await sendPremierFoundDMByKey(key);
                        console.log(`Eingetragen: ${interaction.user.tag} für Premier ${day} (Message ${messageId})`);
                    } finally {
                        unlockSignup('premier', userId);
                    }
                } else if (current.includes(userId)) {
                    await interaction.deferUpdate();
                    return;
                } else {
                    await interaction.deferUpdate();
                    return;
                }
            }
            if (interaction.customId === `unsign_${i}`) {
                const current = premierSignups[messageId][day] || [];
                if (current.includes(userId)) {
                    // SOFORT die Interaktion bestätigen (innerhalb von 3 Sekunden)
                    try {
                        await interaction.deferUpdate();
                    } catch (error) {
                        console.error('Fehler beim deferUpdate für Premier:', error);
                        return;
                    }
                    
                    const wasFull = current.length === MAX_USERS;
                    premierSignups[messageId][day] = current.filter(u => u !== userId);
                    validateSignupData();
                    updated = true;
                    console.log(`Entfernt: ${interaction.user.tag} von Premier ${day} (Message ${messageId})`);
                    if (wasFull && premierSignups[messageId][day].length === MAX_USERS - 1) {
                        await sendPremierCancelDMByKey(key, interaction.user.username);
                    }
                } else {
                    await interaction.deferUpdate();
                    return;
                }
            }
        }
        
        // Delete Premier Board Handler (nur für Admins)
        if (interaction.customId === 'delete_premier_board') {
            // Admin-Prüfung
            const member = await interaction.guild.members.fetch(interaction.user.id);
            if (!(await hasAdminPermissions(member))) {
                try {
                    await interaction.followUp({ content: '❌ Nur Administratoren können Boards löschen.', flags: [MessageFlags.Ephemeral] });
                } catch (e) {
                    console.error('Fehler beim Senden der Admin-Prüfungs-Nachricht:', e);
                }
                return;
            }
            
            try {
                // Lösche die Nachricht
                const msg = await interaction.channel.messages.fetch(messageId);
                await msg.delete();
                delete premierBoards[messageId];
                delete premierSignups[messageId];
                
                // Message-ID aus roles.json entfernen
                await removeMessageIdFromBoard('premier', messageId);
                
                console.log(`Premier Board manuell gelöscht von Admin: ${interaction.user.tag}`);
            } catch (error) {
                console.error('Fehler beim manuellen Löschen des Premier-Boards:', error);
                try {
                    await interaction.followUp({ content: '❌ Fehler beim Löschen des Boards.', flags: [MessageFlags.Ephemeral] });
                } catch (e) {}
            }
            return;
        }

        // ENTFERNT: Doppelter Abwesend-Button-Handler (wird vom ersten Handler abgefangen)

        // Refresh Button
        if (interaction.customId.startsWith('premier_refresh_board')) {
            updated = true;
            console.log(`Premier Board Refresh von ${interaction.user.tag}`);
        }
        
        if (updated && premierBoards[messageId]) {
            for (const key in userCache) delete userCache[key];
            setTimeout(async () => {
                try {
                    const channel = await client.channels.fetch(premierBoards[messageId].channelId);
                    const embed = await getSignupEmbed(client, null, messageId);
                    const userId = getFirstSignedUpUserId() || client.user.id;
                    // Prüfe Admin-Status für den AKTUELLEN User (der die Interaktion ausführt)
                    const isAdmin = await checkUserAdminStatus(interaction.user.id, interaction.guild?.id);
                    const buttonRows = getButtonRow(userId, isAdmin, messageId);
                    await channel.messages.fetch(messageId).then(msg => 
                        msg.edit({ embeds: [embed], components: buttonRows })
                    );
                } catch (e) {
                    // Wenn Nachricht nicht gefunden wird (gelöscht), Board-Eintrag bereinigen
                    if (e.code === 10008) {
                        console.log(`Premier-Board ${messageId} wurde gelöscht - bereinige Board-Cache`);
                        delete premierBoards[messageId];
                        delete premierSignups[messageId];
                    } else {
                        console.error('Fehler beim Aktualisieren des Premier-Boards:', e);
                    }
                }
            }, 100);
        }
        return;
    }
    // Practice-Buttons
    if (interaction.isButton() && interaction.customId.startsWith('practice_')) {
        // ZUERST: Button-Berechtigung prüfen (Rollencheck)
        const permissionCheck = await hasButtonPermission(interaction, 'practice');
        if (!permissionCheck.hasPermission) {
            await interaction.reply({ 
                content: `❌ Kein Zugriff - benötigte Rolle: ${permissionCheck.requiredRole}`, 
                flags: [MessageFlags.Ephemeral] 
            });
            return;
        }
        
        // DANN: Board-Existenz prüfen
        const messageId = interaction.message.id;
        if (!practiceBoards[messageId]) return;
        
        const userId = interaction.user.id;
        let updated = false;
        
        // SOFORT die Interaktion bestätigen (innerhalb von 3 Sekunden)
        try {
            await interaction.deferUpdate();
        } catch (error) {
            console.error('Fehler beim deferUpdate für Practice:', error);
            return;
        }
        // Stelle sicher, dass practiceSignups für diese Message existiert
        if (!practiceSignups[messageId] || typeof practiceSignups[messageId] !== 'object') {
            practiceSignups[messageId] = {};
            for (const day of practiceConfig.days) {
                practiceSignups[messageId][day] = [];
            }
        }
        
        for (let i = 0; i < practiceConfig.days.length; i++) {
            const day = practiceConfig.days[i];
            const key = getPracticeKey(i);
            if (interaction.customId === `practice_signup_${i}`) {
                const current = practiceSignups[messageId][day] || [];
                if (!current.includes(userId) && current.length < MAX_USERS) {
                    practiceSignups[messageId][day].push(userId);
                    updated = true;
                    await sendPracticeFoundDM(key);
                    console.log(`Eingetragen: ${interaction.user.tag} für Practice ${day} (Message ${messageId})`);
                }
            }
            if (interaction.customId === `practice_unsign_${i}`) {
                const current = practiceSignups[messageId][day] || [];
                if (current.includes(userId)) {
                    const wasFull = current.length === MAX_USERS;
                    practiceSignups[messageId][day] = current.filter(u => u !== userId);
                    updated = true;
                    console.log(`Entfernt: ${interaction.user.tag} von Practice ${day} (Message ${messageId})`);
                    if (wasFull && practiceSignups[messageId][day].length === MAX_USERS - 1) {
                        await sendPracticeCancelDM(key, interaction.user.username);
                    }
                }
            }
            updatePracticeState(key);
        }
        
        // Delete Practice Board Handler (nur für Admins)
        if (interaction.customId === 'delete_practice_board') {
            // Admin-Prüfung
            const member = await interaction.guild.members.fetch(interaction.user.id);
            if (!(await hasAdminPermissions(member))) {
                try {
                    await interaction.followUp({ content: '❌ Nur Administratoren können Boards löschen.', flags: [MessageFlags.Ephemeral] });
                } catch (e) {
                    console.error('Fehler beim Senden der Admin-Prüfungs-Nachricht:', e);
                }
                return;
            }
            
            try {
                // Lösche die Nachricht
                const msg = await interaction.channel.messages.fetch(messageId);
                await msg.delete();
                delete practiceBoards[messageId];
                delete practiceSignups[messageId];
                
                // Message-ID aus roles.json entfernen
                await removeMessageIdFromBoard('practice', messageId);
                
                console.log(`Practice Board manuell gelöscht von Admin: ${interaction.user.tag}`);
            } catch (error) {
                console.error('Fehler beim manuellen Löschen des Practice-Boards:', error);
                try {
                    await interaction.followUp({ content: '❌ Fehler beim Löschen des Boards.', flags: [MessageFlags.Ephemeral] });
                } catch (e) {}
            }
            return;
        }
        
        // Refresh Button
        if (interaction.customId.startsWith('practice_refresh_board')) {
            updated = true;
            console.log(`Practice Board Refresh von ${interaction.user.tag}`);
        }
        
        if (updated && practiceBoards[messageId]) {
            for (const key in userCache) delete userCache[key];
            setTimeout(async () => {
                try {
                    const channel = await client.channels.fetch(practiceBoards[messageId].channelId);
                    const embed = await getPracticeSignupEmbed(client, null, messageId);
                    const userId = client.user.id;
                    // Prüfe Admin-Status für den AKTUELLEN User (der die Interaktion ausführt)
                    const isAdmin = await checkUserAdminStatus(interaction.user.id, interaction.guild?.id);
                    const buttonRows = getPracticeButtonRowsWithControls(userId, isAdmin, messageId);
                    await channel.messages.fetch(messageId).then(msg =>
                        msg.edit({ embeds: [embed], components: buttonRows })
                    );
                } catch (e) {
                    // Wenn Nachricht nicht gefunden wird (gelöscht), Board-Eintrag bereinigen
                    if (e.code === 10008) {
                        console.log(`Practice-Board ${messageId} wurde gelöscht - bereinige Board-Cache`);
                        delete practiceBoards[messageId];
                        delete practiceSignups[messageId];
                    } else {
                        console.warn('Fehler beim Aktualisieren der Practice-Nachricht:', e.message);
                    }
                }
            }, 100);
        }
        return;
    }
    // Scrim-Buttons
    if (interaction.isButton() && interaction.customId.startsWith('scrim_')) {
        // ZUERST: Button-Berechtigung prüfen (Rollencheck)
        const permissionCheck = await hasButtonPermission(interaction, 'scrim');
        if (!permissionCheck.hasPermission) {
            await interaction.reply({ 
                content: `❌ Kein Zugriff - benötigte Rolle: ${permissionCheck.requiredRole}`, 
                flags: [MessageFlags.Ephemeral] 
            });
            return;
        }
        
        // DANN: Board-Existenz prüfen
        const messageId = interaction.message.id;
        if (!scrimBoards[messageId]) return;
        
        const userId = interaction.user.id;
        let updated = false;
        
        // Stelle sicher, dass scrimSignups für diese Message existiert
        if (!scrimSignups[messageId] || typeof scrimSignups[messageId] !== 'object') {
            const maxGames = scrimBoards[messageId].maxGames || 2;
            scrimSignups[messageId] = {};
            for (let g = 1; g <= maxGames; g++) {
                scrimSignups[messageId][`game${g}`] = [];
            }
            console.log(`⚠️ Initialisiert fehlende scrimSignups für Message ${messageId} (${maxGames} Games)`);
        }
        
        // SOFORT die Interaktion bestätigen (innerhalb von 3 Sekunden)
        try {
            if (!interaction.replied && !interaction.deferred) {
                await interaction.deferUpdate();
            }
        } catch (error) {
            console.error('Fehler beim deferUpdate für Scrim:', error);
            return;
        }
        
        // Dynamische Game-Signup Handler (mit Message-ID-Scoping)
        if (interaction.customId.startsWith('scrim_signup_game') && !interaction.customId.includes('scrim_signup_all')) {
            // Extrahiere Game-Nummer aus customId - neue Struktur: scrim_signup_game1_messageId
                const parts = interaction.customId.split('_');
            const gameNumber = parts[2].replace('game', ''); // game1 -> 1
            const gameKey = `game${gameNumber}`;
            
            // Verwende messageId-basierte Signups
            if (!scrimSignups[messageId][gameKey]) {
                scrimSignups[messageId][gameKey] = [];
            }
            
            const previousCount = scrimSignups[messageId][gameKey].length;
            
            if (!scrimSignups[messageId][gameKey].includes(userId)) {
                scrimSignups[messageId][gameKey].push(userId);
                updated = true;
                console.log(`Eingetragen: ${interaction.user.tag} für Scrim Game ${gameNumber} (Message ${messageId})`);
                
                // Prüfe ob genau 5 Leute eingetragen sind
                if (scrimSignups[messageId][gameKey].length === 5 && previousCount < 5) {
                    // Sende DM an alle 5 eingetragenen User
                    const boardInfo = scrimBoards[messageId];
                    if (boardInfo) {
                        const scrimDate = `${boardInfo.day} um ${boardInfo.time}`;
                        const userList = await Promise.all(scrimSignups[messageId][gameKey].map(async (uid) => {
                            try {
                                return await getDisplayName(uid, interaction.guild?.id);
                            } catch (e) {
                                return 'Unbekannt';
                            }
                        }));
                        
                        for (const uid of scrimSignups[messageId][gameKey]) {
                            try {
                                const displayName = await getDisplayName(uid, interaction.guild?.id);
                                const message = `Hey ${displayName}, das Scrim am **${scrimDate}** (Game ${gameNumber}) findet statt!\n\n` +
                                    `Folgende User sind eingetragen:\n${userList.map(u => `• ${u}`).join('\n')}`;
                                const dmSent = await sendProtectedDM(uid, message, `Scrim Found Game ${gameNumber}`);
                                if (dmSent) {
                                    console.log(`[Scrim] ✅ Bestätigungs-DM an ${displayName} gesendet (5 Spieler erreicht)`);
                                }
                            } catch (dmError) {
                                console.error(`[Scrim] ❌ Konnte DM nicht an User ${uid} senden:`, dmError.message);
                            }
                        }
                    }
                }
            } else {
                console.log(`${interaction.user.tag} ist bereits für Scrim Game ${gameNumber} eingetragen (Message ${messageId})`);
            }
        }
        
        if (interaction.customId.startsWith('scrim_signup_all')) {
            // Verwende messageId-basierte Signups
            const maxGames = scrimBoards[messageId].maxGames;
            
            let added = false;
            const gamesToNotify = []; // Games die genau 5 Spieler erreicht haben
            
            for (let i = 1; i <= maxGames; i++) {
                const gameKey = `game${i}`;
                if (!scrimSignups[messageId][gameKey]) {
                    scrimSignups[messageId][gameKey] = [];
                }
                
                const previousCount = scrimSignups[messageId][gameKey].length;
                
                if (!scrimSignups[messageId][gameKey].includes(userId)) {
                    scrimSignups[messageId][gameKey].push(userId);
                    added = true;
                    
                    // Prüfe ob dieses Game jetzt genau 5 Spieler hat
                    if (scrimSignups[messageId][gameKey].length === 5 && previousCount < 5) {
                        gamesToNotify.push({ gameNumber: i, gameKey });
                    }
                }
            }
            
            // Sende Benachrichtigungen für alle Games die 5 Spieler erreicht haben
            if (gamesToNotify.length > 0) {
                const boardInfo = scrimBoards[messageId];
                if (boardInfo) {
                    const scrimDate = `${boardInfo.day} um ${boardInfo.time}`;
                    
                    for (const { gameNumber, gameKey } of gamesToNotify) {
                        const userList = await Promise.all(scrimSignups[messageId][gameKey].map(async (uid) => {
                            try {
                                return await getDisplayName(uid, interaction.guild?.id);
                            } catch (e) {
                                return 'Unbekannt';
                            }
                        }));
                        
                        for (const uid of scrimSignups[messageId][gameKey]) {
                            try {
                                const displayName = await getDisplayName(uid, interaction.guild?.id);
                                const message = `Hey ${displayName}, das Scrim am **${scrimDate}** (Game ${gameNumber}) findet statt!\n\n` +
                                    `Folgende User sind eingetragen:\n${userList.map(u => `• ${u}`).join('\n')}`;
                                const dmSent = await sendProtectedDM(uid, message, `Scrim Found All Games ${gameNumber}`);
                                if (dmSent) {
                                    console.log(`[Scrim] ✅ Bestätigungs-DM an ${displayName} gesendet (5 Spieler erreicht, Game ${gameNumber})`);
                                }
                            } catch (dmError) {
                                console.error(`[Scrim] ❌ Konnte DM nicht an User ${uid} senden:`, dmError.message);
                            }
                        }
                    }
                }
            }
            
            if (added) {
                updated = true;
                console.log(`Eingetragen: ${interaction.user.tag} für alle Scrim Games (Message ${messageId})`);
            } else {
                console.log(`${interaction.user.tag} ist bereits für alle Scrim Games eingetragen (Message ${messageId})`);
            }
        }
        
        // Dynamische Game-Unsign Handler (mit Message-ID-Scoping)
        if (interaction.customId.startsWith('scrim_unsign_game') && !interaction.customId.includes('scrim_unsign_all')) {
            // Extrahiere Game-Nummer aus customId - neue Struktur: scrim_unsign_game1_messageId
                const parts = interaction.customId.split('_');
            const gameNumber = parts[2].replace('game', ''); // game1 -> 1
            const gameKey = `game${gameNumber}`;
            
            // Verwende messageId-basierte Signups
            if (scrimSignups[messageId][gameKey] && scrimSignups[messageId][gameKey].includes(userId)) {
                const previousCount = scrimSignups[messageId][gameKey].length;
                const wasAtFive = previousCount >= 5;
                
                scrimSignups[messageId][gameKey] = scrimSignups[messageId][gameKey].filter(u => u !== userId);
                updated = true;
                console.log(`Entfernt: ${interaction.user.tag} von Scrim Game ${gameNumber} (Message ${messageId})`);
                
                // Prüfe ob von 5+ auf unter 5 gefallen
                if (wasAtFive && scrimSignups[messageId][gameKey].length < 5) {
                    // Sende Absage-DM an alle verbliebenen User
                    const boardInfo = scrimBoards[messageId];
                    if (boardInfo && scrimSignups[messageId][gameKey].length > 0) {
                        const scrimDate = `${boardInfo.day} um ${boardInfo.time}`;
                        const userList = await Promise.all(scrimSignups[messageId][gameKey].map(async (uid) => {
                            try {
                                return await getDisplayName(uid, interaction.guild?.id);
                            } catch (e) {
                                return 'Unbekannt';
                            }
                        }));
                        
                        const unsignedUser = await getDisplayName(userId, interaction.guild?.id);
                        
                        for (const uid of scrimSignups[messageId][gameKey]) {
                            try {
                                const displayName = await getDisplayName(uid, interaction.guild?.id);
                                const message = `⚠️ **Scrim Absage** für ${scrimDate}\n\n` +
                                    `**${unsignedUser}** hat sich ausgetragen. Es sind nur noch ${scrimSignups[messageId][gameKey].length} Spieler eingetragen:\n` +
                                    `${userList.map(u => `• ${u}`).join('\n')}`;
                                const dmSent = await sendProtectedDM(uid, message, `Scrim Cancelled`);
                                if (dmSent) {
                                    console.log(`[Scrim] ✅ Absage-DM an ${displayName} gesendet (unter 5 Spieler)`);
                                }
                            } catch (dmError) {
                                console.error(`[Scrim] ❌ Konnte Absage-DM nicht an User ${uid} senden:`, dmError.message);
                            }
                        }
                    }
                }
            } else {
                console.log(`${interaction.user.tag} ist nicht für Scrim Game ${gameNumber} eingetragen (Message ${messageId})`);
            }
        }
        
        if (interaction.customId.startsWith('scrim_unsign_all')) {
            // Verwende messageId-basierte Signups
            const maxGames = scrimBoards[messageId].maxGames;
            
            let removed = false;
            const gamesToNotify = []; // Games die unter 5 Spieler gefallen sind
            
            for (let i = 1; i <= maxGames; i++) {
                const gameKey = `game${i}`;
                if (scrimSignups[messageId][gameKey] && scrimSignups[messageId][gameKey].includes(userId)) {
                    const previousCount = scrimSignups[messageId][gameKey].length;
                    const wasAtFive = previousCount >= 5;
                    
                    scrimSignups[messageId][gameKey] = scrimSignups[messageId][gameKey].filter(u => u !== userId);
                    removed = true;
                    
                    // Prüfe ob von 5+ auf unter 5 gefallen
                    if (wasAtFive && scrimSignups[messageId][gameKey].length < 5 && scrimSignups[messageId][gameKey].length > 0) {
                        gamesToNotify.push({ gameNumber: i, gameKey });
                    }
                }
            }
            
            // Sende Absage-Benachrichtigungen für alle betroffenen Games
            if (gamesToNotify.length > 0) {
                const boardInfo = scrimBoards[messageId];
                if (boardInfo) {
                    const scrimDate = `${boardInfo.day} um ${boardInfo.time}`;
                    const unsignedUser = await getDisplayName(userId, interaction.guild?.id);
                    
                    for (const { gameNumber, gameKey } of gamesToNotify) {
                        const userList = await Promise.all(scrimSignups[messageId][gameKey].map(async (uid) => {
                            try {
                                return await getDisplayName(uid, interaction.guild?.id);
                            } catch (e) {
                                return 'Unbekannt';
                            }
                        }));
                        
                        for (const uid of scrimSignups[messageId][gameKey]) {
                            try {
                                const displayName = await getDisplayName(uid, interaction.guild?.id);
                                const message = `⚠️ **Scrim Absage** für ${scrimDate}\n\n` +
                                    `**${unsignedUser}** hat sich ausgetragen. Es sind nur noch ${scrimSignups[messageId][gameKey].length} Spieler eingetragen:\n` +
                                    `${userList.map(u => `• ${u}`).join('\n')}`;
                                const dmSent = await sendProtectedDM(uid, message, `Scrim Cancelled`);
                                if (dmSent) {
                                    console.log(`[Scrim] ✅ Absage-DM an ${displayName} gesendet (unter 5 Spieler)`);
                                }
                            } catch (dmError) {
                                console.error(`[Scrim] ❌ Konnte Absage-DM nicht an User ${uid} senden:`, dmError.message);
                            }
                        }
                    }
                }
            }
            
            if (removed) {
                updated = true;
                console.log(`Entfernt: ${interaction.user.tag} von allen Scrim Games (Message ${messageId})`);
            } else {
                console.log(`${interaction.user.tag} ist nicht für Scrim Games eingetragen (Message ${messageId})`);
            }
        }
        
        // Refresh Board Handler (mit Message-ID-Scoping)
        if (interaction.customId.startsWith('scrim_refresh_board')) {
            updated = true;
            console.log(`Scrim Board Refresh von ${interaction.user.tag}`);
        }
        
        // Delete Board Handlers (nur für Admins, mit Message-ID-Scoping)
        if (interaction.customId.startsWith('delete_scrim_board')) {
            // Admin-Prüfung
            const member = await interaction.guild.members.fetch(interaction.user.id);
            if (!(await hasAdminPermissions(member))) {
                try {
                    await interaction.followUp({ content: '❌ Nur Administratoren können Boards löschen.', flags: [MessageFlags.Ephemeral] });
                } catch (e) {
                    console.error('Fehler beim Senden der Admin-Prüfungs-Nachricht:', e);
                }
                return;
            }
            
            // Extrahiere Message-ID aus customId (wenn vorhanden)
            let messageId = null;
            if (interaction.customId.includes('_', 19)) { // "delete_scrim_board".length = 19
                const parts = interaction.customId.split('_');
                messageId = parts[3];
            }
            
            try {
                const targetMessageId = messageId || interaction.message.id;
                await deleteScrimMessage(targetMessageId);
                console.log(`Scrim Board manuell gelöscht von Admin: ${interaction.user.tag} (Message: ${targetMessageId})`);
            } catch (error) {
                console.error('Fehler beim manuellen Löschen des Scrim-Boards:', error);
            }
            return;
        }
        
        // Board aktualisieren wenn nötig (mit Message-ID-Scoping)
        if (updated) {
            const messageId = interaction.message.id;
            const boardInfo = scrimBoards[messageId];
            
            if (boardInfo) {
            for (const key in userCache) delete userCache[key];
            setTimeout(async () => {
                try {
                        const channel = await client.channels.fetch(boardInfo.channelId);
                        const embed = await getScrimSignupEmbed(client, interaction.user.id, boardInfo.day, boardInfo.time, boardInfo.maxGames, messageId);
                        // Prüfe Admin-Status für den AKTUELLEN User (der die Interaktion ausführt)
                        const isAdmin = await checkUserAdminStatus(interaction.user.id, interaction.guild?.id);
                        const buttonRows = getScrimButtonRowsWithControls(interaction.user.id, isAdmin, boardInfo.maxGames, messageId);
                        await channel.messages.fetch(messageId).then(msg =>
                        msg.edit({ embeds: [embed], components: buttonRows })
                    );
                } catch (e) {
                        // Wenn Nachricht nicht gefunden wird (gelöscht), Board-Eintrag bereinigen
                        if (e.code === 10008) {
                            console.log(`Scrim-Board ${messageId} wurde gelöscht - bereinige Board-Cache`);
                            delete scrimBoards[messageId];
                            delete scrimSignups[messageId];
                        } else {
                    console.error('Fehler beim Aktualisieren des Scrim-Boards:', e);
                        }
                }
            }, 100);
            }
        }
        return;
    }
    // Slash Commands
    if (interaction.isChatInputCommand()) {
        // EINFACHE ROLLENPRÜFUNG FÜR ALLE COMMANDS (außer dm)
        if (interaction.commandName !== 'dm') {
            if (!(await hasRequiredRole(interaction))) {
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply({ 
                        content: '❌ Du hast nicht die erforderliche Berechtigung, um diesen Bot zu verwenden.', 
                        flags: [MessageFlags.Ephemeral] 
                    });
                }
                return;
            }
            
            // SOFORTIGES deferReply für kritische Commands um Timeout zu vermeiden
            const criticalCommands = ['premier', 'practice', 'scrim', 'abwesend', 'premier-admin', 'abwesend-admin', 'scrim-admin', 'practice-admin', 'backup', 'pastbackup', 'clearpast'];
            if (criticalCommands.includes(interaction.commandName)) {
                // Vermeide späte Defers auf abgelaufenen Interaktionen (behebt Unknown interaction 10062)
                const interactionAgeMs = Date.now() - interaction.createdTimestamp;
                if (interactionAgeMs > 2500) {
                    return;
                }

                if (!interaction.replied && !interaction.deferred) {
                    try {
                        await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
                        console.log(`Universelles deferReply für ${interaction.commandName} erfolgreich`);
                    } catch (error) {
                        // Unterdrücke bekannte Fehler für bereits bearbeitete Interaktionen
                        const errorCode = (error && error.code) || (error && error.rawError && error.rawError.code);
                        if (errorCode === 10062 || errorCode === 40060 || (error && error.status === 404)) {
                            console.log(`Interaction für ${interaction.commandName} bereits bearbeitet oder abgelaufen`);
                            return;
                        }
                        console.error(`Konnte ${interaction.commandName} nicht defer-en:`, error);
                        return;
                    }
                }
            }
        }
        
        if (interaction.commandName === 'dm') {
            console.log('DM-Command received');
            if (!interaction.guild) {
                await interaction.reply({ content: 'Dieser Befehl kann nur in einem Server verwendet werden.', flags: [MessageFlags.Ephemeral] });
                return;
            }
            const modus = interaction.options.getString('modus');
            if (modus === 'off') {
                dmOptOut.add(interaction.user.id);
                await interaction.reply({ content: 'Du erhältst ab jetzt keine Premier-DMs mehr.', flags: [MessageFlags.Ephemeral] });
            } else if (modus === 'on') {
                dmOptOut.delete(interaction.user.id);
                await interaction.reply({ content: 'Du erhältst ab jetzt wieder Premier-DMs.', flags: [MessageFlags.Ephemeral] });
            } else {
                await interaction.reply({ content: 'Ungültige Auswahl.', flags: [MessageFlags.Ephemeral] });
            }
        }
        if (interaction.commandName === 'cc') {
            // Admin-Prüfung
            const member = await interaction.guild.members.fetch(interaction.user.id);
            if (!(await hasAdminPermissions(member))) {
                await interaction.reply({ content: 'Nur Administratoren dürfen diesen Befehl ausführen.', flags: [MessageFlags.Ephemeral] });
                return;
            }
            
            // Nachrichten löschen
            const channel = interaction.channel;
            try {
                let fetched;
                do {
                    fetched = await channel.messages.fetch({ limit: 100 });
                    if (fetched.size > 0) {
                        await channel.bulkDelete(fetched, true);
                    }
                } while (fetched.size >= 2); // Discord lässt max. 100 auf einmal zu, und keine älter als 14 Tage
            } catch (e) {
                // Keine Antwort senden
            }
            return;
        }
        // entfernt: backup, pastbackup
        if (interaction.commandName === 'clearpast') {
            // Admin-Prüfung
            const member = await interaction.guild.members.fetch(interaction.user.id);
            if (!(await hasAdminPermissions(member))) {
                await interaction.reply({ content: 'Nur Administratoren dürfen diesen Befehl ausführen.', flags: [MessageFlags.Ephemeral] });
                return;
            }
            // Bereits globales deferReply aktiv; hier sichere Bearbeitung
            if (!interaction.deferred && !interaction.replied) {
                try {
                    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
                } catch {}
            }
            await interaction.editReply({ content: 'Clearpast wird ausgeführt...', flags: [MessageFlags.Ephemeral] });
            
            const subcommand = interaction.options.getSubcommand();
            const channelId = interaction.channel.id;
            
            if (subcommand === 'premier') {
                // Alle Premier-Anmeldungen löschen
                let totalCleared = 0;
                for (const day of premierConfig.days) {
                    if (signups[day].length > 0) {
                        totalCleared += signups[day].length;
                        console.log(`Premier-Anmeldungen für ${day} werden geleert. (${signups[day].length} Spieler entfernt)`);
                        signups[day] = [];
                    }
                }
                
                // Premier-Board aktualisieren
                if (premierBoards[channelId]?.messageId && premierBoards[channelId]?.channelId) {
                    setTimeout(async () => {
                        try {
                            const channel = await client.channels.fetch(premierBoards[channelId]?.channelId);
                            const embed = await getSignupEmbed(client);
                            const userId = getFirstSignedUpUserId() || client.user.id;
                            const buttonRows = getButtonRow(userId);
                            await channel.messages.fetch(premierBoards[channelId]?.messageId).then(msg => 
                                msg.edit({ embeds: [embed], components: buttonRows })
                            );
                        } catch (e) {
                            console.error('Fehler beim Aktualisieren des Premier-Boards nach clearpast premier:', e);
                        }
                    }, 100);
                }
                
                // Backup speichern
                saveSignupBackup();
                await interaction.editReply({ content: `Alle Premier-Anmeldungen wurden erfolgreich gelöscht. (${totalCleared} Spieler entfernt)` });
                
            } else if (subcommand === 'practice') {
                // Alle Practice-Anmeldungen löschen
                let totalCleared = 0;
                for (const day of practiceConfig.days) {
                    if (practiceSignups[day].length > 0) {
                        totalCleared += practiceSignups[day].length;
                        console.log(`Practice-Anmeldungen für ${day} werden geleert. (${practiceSignups[day].length} Spieler entfernt)`);
                        practiceSignups[day] = [];
                    }
                }
                
                // Practice-Board aktualisieren
                if (practiceBoards[channelId]?.messageId && practiceBoards[channelId]?.channelId) {
                    setTimeout(async () => {
                        try {
                            const channel = await client.channels.fetch(practiceBoards[channelId]?.channelId);
                            const embed = await getPracticeSignupEmbed(client);
                            const buttonRows = getPracticeButtonRowsWithControls(client.user.id);
                            await channel.messages.fetch(practiceBoards[channelId]?.messageId).then(msg =>
                                msg.edit({ embeds: [embed], components: buttonRows })
                            );
                        } catch (e) {
                            console.error('Fehler beim Aktualisieren des Practice-Boards nach clearpast practice:', e);
                        }
                    }, 100);
                }
                
                // Backup speichern
                saveSignupBackup();
                await interaction.editReply({ content: `Alle Practice-Anmeldungen wurden erfolgreich gelöscht. (${totalCleared} Spieler entfernt)` });
            }
            
            return;
        }
        if (interaction.commandName === 'premier-config') {
            // Admin-Prüfung
            const member = await interaction.guild.members.fetch(interaction.user.id);
            if (!(await hasAdminPermissions(member))) {
                await interaction.reply({ content: 'Nur Administratoren dürfen diesen Befehl ausführen.', flags: [MessageFlags.Ephemeral] });
                return;
            }
            
            // Sofortige Antwort um Timeout zu vermeiden
            await interaction.reply({ content: 'Premier-Konfiguration wird aktualisiert...', flags: [MessageFlags.Ephemeral] });
            
            // Team-Auswahl verarbeiten
            const team = interaction.options.getString('team');
            const teamSuffix = team === 'academy' ? '_academy' : '';
            
            // Sammle alle Tage und Zeiten
            const days = [];
            const times = [];
            
            const day1 = interaction.options.getString('day_1');
            const time1 = interaction.options.getString('daytime_1');
            if (day1 && time1) {
                days.push(day1);
                times.push(time1);
            }
            
            const day2 = interaction.options.getString('day_2');
            const time2 = interaction.options.getString('daytime_2');
            if (day2 && time2) {
                days.push(day2);
                times.push(time2);
            }
            
            // Optionaler dritter Tag
            const day3 = interaction.options.getString('day_3');
            const time3 = interaction.options.getString('daytime_3');
            if (day3 && time3) {
                days.push(day3);
                times.push(time3);
            }
            
            // Validiere Zeiten (HH:MM Format)
            for (const time of times) {
                if (!/^\d{1,2}:\d{2}$/.test(time)) {
                    await interaction.editReply({ content: 'Ungültiges Zeitformat! Verwende HH:MM (z.B. 19:00)', flags: [MessageFlags.Ephemeral] });
                    return;
                }
            }
            // Erlaube gleiche Tage nur mit unterschiedlichen Zeiten
            const dayToTimesMap = {};
            for (let i = 0; i < days.length; i++) {
                const d = days[i];
                const t = times[i];
                if (!dayToTimesMap[d]) dayToTimesMap[d] = new Set();
                if (dayToTimesMap[d].has(t)) {
                    await interaction.editReply({ content: `Der Tag "${d}" wurde mehrfach mit derselben Zeit ("${t}") angegeben. Bitte wähle unterschiedliche Zeiten für denselben Tag.`, flags: [MessageFlags.Ephemeral] });
                    return;
                }
                dayToTimesMap[d].add(t);
            }
            
            // Aktualisiere Konfiguration für das gewählte Team
            if (!premierConfig[team]) {
                premierConfig[team] = {
                    days: [],
                    times: []
                };
            }
            premierConfig[team].days = days;
            premierConfig[team].times = times;
            
            // Initialisiere dynamische Strukturen neu
            initializeDynamicSignups();
            
            // Backup speichern
            saveSignupBackup();
            
            // Sofortige Antwort senden
            await interaction.editReply({ 
                content: `Premier-Konfiguration aktualisiert!\nTage: ${days.join(', ')}\nZeiten: ${times.join(', ')}\n\nAlle Premier-Boards werden im Hintergrund aktualisiert...`, 
                flags: [MessageFlags.Ephemeral] 
            });
            
            // Aktualisiere alle Premier-Boards mit der neuen Konfiguration (im Hintergrund)
            setTimeout(async () => {
                for (const channelId in premierBoards) {
                    if (premierBoards[channelId]?.messageId && premierBoards[channelId]?.channelId) {
                        try {
                            const channel = await client.channels.fetch(premierBoards[channelId]?.channelId);
                            const embed = await getSignupEmbed(client);
                            const userId = getFirstSignedUpUserId() || client.user.id;
                            const buttonRows = getButtonRow(userId);
                            const msg = await channel.messages.fetch(premierBoards[channelId]?.messageId);
                            await msg.edit({ embeds: [embed], components: buttonRows });
                            console.log(`Premier-Board in Channel ${channelId} nach Konfiguration aktualisiert`);
                        } catch (error) {
                            console.error(`Fehler beim Aktualisieren des Premier-Boards in Channel ${channelId}:`, error);
                        }
                    }
                }
                console.log('Alle Premier-Boards wurden erfolgreich aktualisiert!');
            }, 1000);
        }
        
        if (interaction.commandName === 'practice-config') {
            // Admin-Prüfung
            const member = await interaction.guild.members.fetch(interaction.user.id);
            if (!(await hasAdminPermissions(member))) {
                await interaction.reply({ content: 'Nur Administratoren dürfen diesen Befehl ausführen.', flags: [MessageFlags.Ephemeral] });
                return;
            }
            
            // Sofortige Antwort um Timeout zu vermeiden
            await interaction.reply({ content: 'Practice-Konfiguration wird aktualisiert...', flags: [MessageFlags.Ephemeral] });
            
            // Team-Auswahl verarbeiten
            const team = interaction.options.getString('team');
            
            // Sammle alle Tage und Zeiten
            const days = [];
            const times = [];
            
            const day1 = interaction.options.getString('day_1');
            const time1 = interaction.options.getString('daytime_1');
            if (day1 && time1) {
                days.push(day1);
                times.push(time1);
            }
            
            const day2 = interaction.options.getString('day_2');
            const time2 = interaction.options.getString('daytime_2');
            if (day2 && time2) {
                days.push(day2);
                times.push(time2);
            }
            
            // Optionaler dritter Tag
            const day3 = interaction.options.getString('day_3');
            const time3 = interaction.options.getString('daytime_3');
            if (day3 && time3) {
                days.push(day3);
                times.push(time3);
            }
            
            // Validiere Zeiten (HH:MM Format)
            for (const time of times) {
                if (!/^\d{1,2}:\d{2}$/.test(time)) {
                    await interaction.editReply({ content: 'Ungültiges Zeitformat! Verwende HH:MM (z.B. 19:00)', flags: [MessageFlags.Ephemeral] });
                    return;
                }
            }
            // Erlaube gleiche Tage nur mit unterschiedlichen Zeiten
            const pDayToTimesMap = {};
            for (let i = 0; i < days.length; i++) {
                const d = days[i];
                const t = times[i];
                if (!pDayToTimesMap[d]) pDayToTimesMap[d] = new Set();
                if (pDayToTimesMap[d].has(t)) {
                    await interaction.editReply({ content: `Der Tag "${d}" wurde mehrfach mit derselben Zeit ("${t}") angegeben. Bitte wähle unterschiedliche Zeiten für denselben Tag.`, flags: [MessageFlags.Ephemeral] });
                    return;
                }
                pDayToTimesMap[d].add(t);
            }
            
            // Aktualisiere Konfiguration für das gewählte Team
            practiceConfig[team].days = days;
            practiceConfig[team].times = times;
            
            // Initialisiere dynamische Strukturen neu
            initializeDynamicSignups();
            
            // Backup speichern
            saveSignupBackup();
            
            await interaction.editReply({ 
                content: `Practice-Konfiguration aktualisiert!\n(Max. 3 Tage: 1 Pflicht, 2 optional)\nAnzahl Tage: ${days.length}\nTage: ${days.join(', ')}\nZeiten: ${times.join(', ')}`, 
                flags: [MessageFlags.Ephemeral] 
            });
        }
        
        
        if (interaction.commandName === 'change') {
            // Admin-Prüfung
            const member = await interaction.guild.members.fetch(interaction.user.id);
            if (!(await hasAdminPermissions(member))) {
                await interaction.reply({ content: 'Nur Administratoren dürfen diesen Befehl ausführen.', flags: [MessageFlags.Ephemeral] });
                return;
            }
            
            const discordMessageId = interaction.options.getString('id');
            const newDay = interaction.options.getString('day');
            const newTime = interaction.options.getString('time');
            
            // Finde die Nachricht anhand der Discord Message ID
            const messageData = getMessageByDiscordId(discordMessageId);
            if (!messageData) {
                await interaction.reply({ 
                    content: `Keine Nachricht mit ID ${discordMessageId} gefunden.`, 
                    flags: [MessageFlags.Ephemeral] 
                });
                return;
            }
            
            // Prüfe ob es ein Scrim ist
            if (messageData.type !== 'scrim') {
                await interaction.reply({ 
                    content: `ID ${discordMessageId} gehört zu einer ${messageData.type}-Nachricht, nicht zu einem Scrim.`, 
                    flags: [MessageFlags.Ephemeral] 
                });
                return;
            }
            
            // Validiere Zeit-Format
            const timeRegex = /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/;
            if (!timeRegex.test(newTime)) {
                await interaction.reply({ 
                    content: 'Ungültiges Zeitformat. Verwende z.B. 19:00', 
                    flags: [MessageFlags.Ephemeral] 
                });
                return;
            }
            
            try {
                // Lade die Discord-Nachricht
                const channel = await client.channels.fetch(messageData.channelId);
                const msg = await channel.messages.fetch(messageData.discordMessageId);
                
                    // Aktualisiere die Scrim-Board-Daten
                    if (scrimBoards[discordMessageId]) {
                        scrimBoards[discordMessageId].day = newDay;
                        scrimBoards[discordMessageId].time = newTime;
                    
                    // Berechne neues Verfallsdatum
                    const today = getGermanDate();
                    const dayIndex = getDayIndex(newDay);
                    const currentDayIndex = today.getDay();
                    let daysUntilNext = dayIndex - currentDayIndex;
                    if (daysUntilNext < 0) daysUntilNext += 7;
                    
                    const expiryDate = new Date(today);
                    expiryDate.setDate(today.getDate() + daysUntilNext);
                    
                    const [hours, minutes] = newTime.split(':').map(Number);
                    expiryDate.setHours(hours, minutes, 0, 0);
                    
                    const gamesDuration = scrimBoards[discordMessageId].maxGames * 45;
                    expiryDate.setMinutes(expiryDate.getMinutes() + gamesDuration);
                    
                        scrimBoards[discordMessageId].expiryDate = expiryDate.getTime();
                    }

                    // Erstelle neues Embed mit aktualisierten Daten
                    const maxGames = scrimBoards[discordMessageId]?.maxGames || 3;
                    const embedWithId = await getScrimSignupEmbed(client, client.user.id, newDay, newTime, maxGames, discordMessageId);
                    const buttonRows = getScrimButtonRowsWithControls(client.user.id, true, maxGames, discordMessageId);
                
                // Aktualisiere die Nachricht
                await msg.edit({ embeds: [embedWithId], components: buttonRows });
                
                // Backup aktualisieren
                saveSignupBackup();
                
                await interaction.reply({ 
                    content: `Scrim ID ${discordMessageId} wurde erfolgreich geändert:\nNeuer Tag: ${newDay}\nNeue Zeit: ${newTime}`, 
                    flags: [MessageFlags.Ephemeral] 
                });
                
            } catch (error) {
                console.error('Fehler beim Ändern des Scrims:', error);
                await interaction.reply({ 
                    content: 'Fehler beim Ändern des Scrims. Nachricht möglicherweise gelöscht.', 
                    flags: [MessageFlags.Ephemeral] 
                });
            }
        }
        
        if (interaction.commandName === 'scrim') {
            await safeEditReply(interaction, 'Scrim wird erstellt...', 'scrim');
            
            // Hole die Parameter
            const style = interaction.options.getString('style');
            const defaultTime = interaction.options.getString('zeit');
            const maxGames = interaction.options.getInteger('games');
            const wochentag = interaction.options.getString('wochentag');
            const ausnahmeTag = interaction.options.getString('ausnahme_tag');
            const ausnahmeZeit = interaction.options.getString('ausnahme_zeit');
            const ausnahmeBeschreibung = interaction.options.getString('ausnahme_beschreibung');
            
            try {
                // Validierung für single_message
                if (style === 'single_message' && !wochentag) {
                    await interaction.editReply({ 
                        content: '❌ Für "Single Message" musst du einen Wochentag angeben!' 
                    });
                    return;
                }
                
                // Validierung für Ausnahme-Parameter
                if (ausnahmeTag && !ausnahmeZeit) {
                    await interaction.editReply({ 
                        content: '❌ Wenn du einen Ausnahme-Tag angibst, musst du auch eine Ausnahme-Zeit angeben!' 
                    });
                    return;
                }
                if (ausnahmeZeit && !ausnahmeTag) {
                    await interaction.editReply({ 
                        content: '❌ Wenn du eine Ausnahme-Zeit angibst, musst du auch einen Ausnahme-Tag angeben!' 
                    });
                    return;
                }
                
                // Erstelle Ausnahme-Objekt falls vorhanden
                const exception = (ausnahmeTag && ausnahmeZeit) ? {
                    day: ausnahmeTag,
                    time: ausnahmeZeit,
                    description: ausnahmeBeschreibung || null
                } : null;
                
                // Erstelle neues Scrim-Board
                const messages = await postWochenScrim(interaction.channel, style, defaultTime, maxGames, wochentag, exception);
                
                // Frühe Bestätigung senden
                let confirmMessage = '';
                if (style === 'single_message') {
                    confirmMessage = `Single Message Scrim für ${wochentag} erstellt! Zeit: ${defaultTime}, Games: ${maxGames}. ID: ${messages[0].id}`;
                } else if (style === 'wochen_scrim') {
                    confirmMessage = `Wochen-Scrim (7 Seiten) erstellt! Zeit: ${defaultTime}, Games: ${maxGames}. ID: ${messages[0].id}`;
                } else {
                    confirmMessage = `Wochen-Scrim (7 Messages) erstellt! Zeit: ${defaultTime}, Games: ${maxGames}.`;
                }
                
                // Ausnahme-Info anhängen
                if (exception) {
                    confirmMessage += `\n🔔 Ausnahme: ${exception.day} - ${exception.time}${exception.description ? ` (${exception.description})` : ''}`;
                }
                
                // Bestätigung senden (nur wenn nicht im Silent Mode)
                await safeEditReply(interaction, confirmMessage, 'scrim erstellt');
                
            } catch (error) {
                console.error('Fehler beim Scrim Command:', error);
                try {
                    await interaction.editReply({ content: 'Fehler beim Erstellen der Scrim-Anmeldung.' });
                } catch (editError) {
                    console.error('Fehler beim editReply:', editError);
                }
            }
        }
        
        if (interaction.commandName === 'practice') {
            // Rollenprüfung für Practice-Befehl (nur Admins)
            const hasRole = await hasRequiredRole(interaction, 'admin_commands', 'practice');
            if (!hasRole) {
                await interaction.editReply({ 
                    content: 'Du hast nicht die erforderliche Berechtigung für Practice-Befehle.', 
                    flags: [MessageFlags.Ephemeral] 
                });
                return;
            }
            
            // Team-Auswahl verarbeiten
            const team = interaction.options.getString('team');
            
            await safeEditReply(interaction, `Practice wird für ${team === 'academy' ? 'Academy-Team' : 'Main-Team'} erstellt...`, 'practice');
            
            try {
                for (const key in userCache) delete userCache[key];
                await postPracticeSignupWithDelete(interaction.channel, team);
                
                // Message-ID zu roles.json hinzufügen
                const channelId = interaction.channel.id;
                // Finde die neue Message-ID in practiceBoards
                for (const [messageId, board] of Object.entries(practiceBoards)) {
                    if (board.channelId === channelId) {
                        await addMessageIdToBoard('practice', messageId);
                        break;
                    }
                }
                
                // Frühe Bestätigung senden (nur wenn nicht im Silent Mode)
                await safeEditReply(interaction, 'Practice-Anmeldung wurde erstellt.', 'practice erstellt');
                
                setTimeout(async () => {
                    const channelId = interaction.channel.id;
                    // Finde die neue Message-ID in practiceBoards
                    for (const [messageId, board] of Object.entries(practiceBoards)) {
                        if (board.channelId === channelId) {
                            try {
                                const channel = await client.channels.fetch(board.channelId);
                                const embed = await getPracticeSignupEmbed(client, null, messageId);
                                const buttonRows = getPracticeButtonRowsWithControls(client.user.id);
                                const msg = await channel.messages.fetch(messageId);
                                await msg.edit({ embeds: [embed], components: buttonRows });
                            } catch (e) {
                                console.error('Fehler beim Aktualisieren des Practice-Boards:', e);
                            }
                            break;
                        }
                    }
                }, 100);
            } catch (error) {
                console.error('Fehler beim Practice Command:', error);
                try {
                    await interaction.editReply({ content: 'Fehler beim Erstellen der Practice-Anmeldung.' });
                } catch (editError) {
                    console.error('Fehler beim editReply:', editError);
                }
            }
        }
        if (interaction.commandName === 'silent') {
            const modus = interaction.options.getString('modus');
            
            if (modus === 'on') {
                // Silent Mode ON = Keine Nachrichten
                silentMode.add(interaction.user.id);
                // Direkte Reply ohne safeEphemeralReply - dieser Command soll immer antworten
                try {
                    await interaction.reply({ 
                        content: '🔇 **Silent Mode aktiviert**\n\nDu erhältst ab jetzt keine Ephemeral-Benachrichtigungen mehr.\n\n**Ausnahmen:**\n• Verwarnungs-System\n• Fehlermeldungen\n\nZum Deaktivieren: `/self modus:OFF`',
                        flags: [MessageFlags.Ephemeral]
                    });
                } catch (e) {
                    console.error('Fehler beim Aktivieren des Silent Mode:', e);
                }
            } else if (modus === 'off') {
                // Silent Mode OFF = Nachrichten erhalten
                silentMode.delete(interaction.user.id);
                // Direkte Reply ohne safeEphemeralReply - dieser Command soll immer antworten
                try {
                    await interaction.reply({ 
                        content: '🔔 **Silent Mode deaktiviert**\n\nDu erhältst wieder alle Bot-Benachrichtigungen.',
                        flags: [MessageFlags.Ephemeral]
                    });
                } catch (e) {
                    console.error('Fehler beim Deaktivieren des Silent Mode:', e);
                }
            }
            return;
        }
        
        if (interaction.commandName === 'abwesend') {
            if (!interaction.guild) {
                await interaction.editReply({ content: 'Dieser Befehl kann nur in einem Server verwendet werden.' });
                return;
            }
            
            await interaction.editReply({ content: 'Abwesenheit wird verarbeitet...' });
            
            const subcommand = interaction.options.getSubcommand();
            // Normale User können nur sich selbst als abwesend markieren
            let userId = interaction.user.id;
            if (subcommand === 'add') {
                // ... Rest wie gehabt, aber für userId ...
                const startDateStr = interaction.options.getString('start');
                const endDateStr = interaction.options.getString('end');
                
                // Datum validieren (DD.MM.YYYY)
                const dateRegex = /^(\d{2})\.(\d{2})\.(\d{4})$/;
                const startMatch = startDateStr.match(dateRegex);
                const endMatch = endDateStr.match(dateRegex);
                
                if (!startMatch || !endMatch) {
                    await interaction.editReply({ content: 'Ungültiges Datumsformat! Verwende DD.MM.YYYY (z.B. 17.06.2025)' });
                    return;
                }
                
                const startDate = new Date(
                    parseInt(startMatch[3]), 
                    parseInt(startMatch[2]) - 1, 
                    parseInt(startMatch[1])
                );
                const endDate = new Date(
                    parseInt(endMatch[3]), 
                    parseInt(endMatch[2]) - 1, 
                    parseInt(endMatch[1])
                );
                
                if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
                    await interaction.editReply({ content: 'Ungültiges Datum!' });
                    return;
                }
                
                if (startDate > endDate) {
                    await interaction.editReply({ content: 'Startdatum muss vor dem Enddatum liegen!' });
                    return;
                }
                
                // Verwende lokale Datumsformatierung um Zeitzonenprobleme zu vermeiden
                const startDateISO = `${startDate.getFullYear()}-${String(startDate.getMonth() + 1).padStart(2, '0')}-${String(startDate.getDate()).padStart(2, '0')}`;
                const endDateISO = `${endDate.getFullYear()}-${String(endDate.getMonth() + 1).padStart(2, '0')}-${String(endDate.getDate()).padStart(2, '0')}`;
                
                // Prüfe ob bereits eine Abwesenheit für diesen Zeitraum existiert
                const existingIndex = abwesenheiten.findIndex(abw => 
                    abw.userId === userId && 
                    ((abw.startDate <= startDateISO && abw.endDate >= startDateISO) ||
                     (abw.startDate <= endDateISO && abw.endDate >= endDateISO) ||
                     (abw.startDate >= startDateISO && abw.endDate <= endDateISO))
                );
                
                if (existingIndex !== -1) {
                    await interaction.editReply({ content: 'Du hast bereits eine Abwesenheit für diesen Zeitraum eingetragen!' });
                    return;
                }
                
                // Abwesenheit hinzufügen
                abwesenheiten.push({
                    userId: userId,
                    startDate: startDateISO,
                    endDate: endDateISO,
                    reason: null, // Slash Command hat keinen Grund
                    addedAt: getGermanDate().toISOString()
                });
                
                // Backup speichern
                saveSignupBackup();
                
                await interaction.editReply({ content: `Du bist als abwesend markiert von ${startDateStr} bis ${endDateStr}. Du erhältst in dieser Zeit keine DMs oder Erinnerungen.` });
                
                console.log(`Abwesenheit hinzugefügt: ${interaction.user.tag} von ${startDateStr} bis ${endDateStr}`);
                
                // Board nach 0,15 Sekunden aktualisieren (separater try-catch um Hauptinteraktion nicht zu beeinträchtigen)
                setTimeout(async () => {
                    try {
                        const channelId = interaction.channel.id;
                        if (premierBoards[channelId]?.messageId && premierBoards[channelId]?.channelId) {
                            try {
                                const channel = await client.channels.fetch(premierBoards[channelId]?.channelId);
                                const embed = await getSignupEmbed(client);
                                const userId = getFirstSignedUpUserId() || client.user.id;
                                const isAdmin = await checkUserAdminStatus(interaction.user.id, interaction.guild?.id);
                                const buttonRows = getButtonRow(userId, isAdmin);
                                await channel.messages.fetch(premierBoards[channelId]?.messageId).then(msg => 
                                    msg.edit({ embeds: [embed], components: buttonRows })
                                );
                            } catch (e) {
                                if (e.code === 10008) {
                                    console.log(`Premier-Board in Channel ${channelId} wurde gelöscht - bereinige Board-Cache`);
                                    delete premierBoards[channelId];
                                } else {
                                console.error('Fehler beim Aktualisieren des Premier-Boards nach Abwesenheit hinzufügen:', e);
                                }
                            }
                        }
                    } catch (e) {
                        console.error('Fehler beim Board-Update nach Abwesenheit hinzufügen:', e);
                    }
                }, 150);
            }
            
            if (subcommand === 'delete') {
                // Sofortiges deferReply um Timeout zu vermeiden
                if (!interaction.replied && !interaction.deferred) {
                    try {
                        await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
                    } catch (e) {
                        console.error('Fehler beim deferReply für abwesend delete:', e);
                        return;
                    }
                }

                const deleteType = interaction.options.getString('type');
                // Normale User können nur ihre eigenen Abwesenheiten löschen
                let deleteUserId = interaction.user.id;
                if (deleteType === 'all') {
                    const userAbwesenheiten = abwesenheiten.filter(abw => abw.userId === deleteUserId);
                    if (userAbwesenheiten.length === 0) {
                        await interaction.editReply({ 
                            content: 'Du hast keine Abwesenheiten eingetragen.'
                        });
                        return;
                    }
                    abwesenheiten = abwesenheiten.filter(abw => abw.userId !== deleteUserId);
                    saveSignupBackup();
                    await interaction.editReply({ 
                        content: `Alle deine Abwesenheiten (${userAbwesenheiten.length} Einträge) wurden gelöscht.`
                    });
                    console.log(`Alle Abwesenheiten gelöscht: ${interaction.user.tag} (${userAbwesenheiten.length} Einträge)`);
                    setTimeout(async () => {
                        try {
                            const channelId = interaction.channel.id;
                            if (premierBoards[channelId]?.messageId && premierBoards[channelId]?.channelId) {
                                try {
                                    const channel = await client.channels.fetch(premierBoards[channelId]?.channelId);
                                    const embed = await getSignupEmbed(client);
                                    const userId = getFirstSignedUpUserId() || client.user.id;
                                    const buttonRows = getButtonRow(userId);
                                    await channel.messages.fetch(premierBoards[channelId]?.messageId).then(msg => 
                                        msg.edit({ embeds: [embed], components: buttonRows })
                                    );
                                } catch (e) {
                                    console.error('Fehler beim Aktualisieren des Premier-Boards nach Abwesenheit löschen (all):', e);
                                }
                            }
                            if (practiceBoards[channelId]?.messageId && practiceBoards[channelId]?.channelId) {
                                try {
                                    const channel = await client.channels.fetch(practiceBoards[channelId]?.channelId);
                                    const embed = await getPracticeSignupEmbed(client);
                                    const buttonRows = getPracticeButtonRowsWithControls(client.user.id);
                                    await channel.messages.fetch(practiceBoards[channelId]?.messageId).then(msg =>
                                        msg.edit({ embeds: [embed], components: buttonRows })
                                    );
                                } catch (e) {
                                    console.error('Fehler beim Aktualisieren des Practice-Boards nach Abwesenheit löschen (all):', e);
                                }
                            }
                        } catch (e) {
                            console.error('Fehler beim Board-Update nach Abwesenheit löschen (all):', e);
                        }
                    }, 150);
                }
                if (deleteType === 'last') {
                    const userAbwesenheiten = abwesenheiten.filter(abw => abw.userId === deleteUserId);
                    if (userAbwesenheiten.length === 0) {
                        await interaction.editReply({ 
                            content: 'Du hast keine Abwesenheiten eingetragen.'
                        });
                        return;
                    }
                    // Finde die letzte Abwesenheit (sortiert nach addedAt)
                    const sortedAbwesenheiten = userAbwesenheiten.sort((a, b) => 
                        new Date(b.addedAt) - new Date(a.addedAt)
                    );
                    const lastAbwesenheit = sortedAbwesenheiten[0];
                    // Entferne die letzte Abwesenheit
                    const indexToRemove = abwesenheiten.findIndex(abw => 
                        abw.userId === deleteUserId && 
                        abw.startDate === lastAbwesenheit.startDate && 
                        abw.endDate === lastAbwesenheit.endDate && 
                        abw.addedAt === lastAbwesenheit.addedAt
                    );
                    if (indexToRemove !== -1) {
                        abwesenheiten.splice(indexToRemove, 1);
                        saveSignupBackup();
                        // Formatiere Datum für Anzeige
                        const startDate = new Date(lastAbwesenheit.startDate);
                        const endDate = new Date(lastAbwesenheit.endDate);
                        const startFormatted = formatDate(startDate) + '.' + startDate.getFullYear();
                        const endFormatted = formatDate(endDate) + '.' + endDate.getFullYear();
                        await interaction.editReply({ 
                            content: `Deine letzte Abwesenheit (${startFormatted} - ${endFormatted}) wurde gelöscht.`
                        });
                        console.log(`Letzte Abwesenheit gelöscht: ${interaction.user.tag} (${startFormatted} - ${endFormatted})`);
                        setTimeout(async () => {
                            try {
                                const channelId = interaction.channel.id;
                                if (premierBoards[channelId]?.messageId && premierBoards[channelId]?.channelId) {
                                    try {
                                        const channel = await client.channels.fetch(premierBoards[channelId]?.channelId);
                                        const embed = await getSignupEmbed(client);
                                        const userId = getFirstSignedUpUserId() || client.user.id;
                                        const buttonRows = getButtonRow(userId);
                                        await channel.messages.fetch(premierBoards[channelId]?.messageId).then(msg => 
                                            msg.edit({ embeds: [embed], components: buttonRows })
                                        );
                                    } catch (e) {
                                        console.error('Fehler beim Aktualisieren des Premier-Boards nach Abwesenheit löschen (last):', e);
                                    }
                                }
                                if (practiceBoards[channelId]?.messageId && practiceBoards[channelId]?.channelId) {
                                    try {
                                        const channel = await client.channels.fetch(practiceBoards[channelId]?.channelId);
                                        const embed = await getPracticeSignupEmbed(client);
                                        const buttonRows = getPracticeButtonRowsWithControls(client.user.id);
                                        await channel.messages.fetch(practiceBoards[channelId]?.messageId).then(msg =>
                                            msg.edit({ embeds: [embed], components: buttonRows })
                                        );
                                    } catch (e) {
                                        console.error('Fehler beim Aktualisieren des Practice-Boards nach Abwesenheit löschen (last):', e);
                                    }
                                }
                            } catch (e) {
                                console.error('Fehler beim Board-Update nach Abwesenheit löschen (last):', e);
                            }
                        }, 150);
                    } else {
                        await interaction.editReply({ 
                            content: 'Fehler beim Löschen der letzten Abwesenheit.'
                        });
                    }
                }
            }
        }

        if (interaction.commandName === 'premier') {
            // Rollenprüfung für Premier-Befehl (nur Admins)
            const hasRole = await hasRequiredRole(interaction, 'admin_commands', 'premier');
            if (!hasRole) {
                await interaction.editReply({ 
                    content: 'Du hast nicht die erforderliche Berechtigung für Premier-Befehle.', 
                    flags: [MessageFlags.Ephemeral] 
                });
                return;
            }
            
            // Team-Auswahl verarbeiten
            const team = interaction.options.getString('team');
            
            await safeEditReply(interaction, `Premier wird für ${team === 'academy' ? 'Academy-Team' : 'Main-Team'} erstellt...`, 'premier');
            
            try {
                // User-Cache leeren
                for (const key in userCache) delete userCache[key];
                await postPremierSignupWithDelete(interaction.channel, team);
                
                // Message-ID zu roles.json hinzufügen
                const channelId = interaction.channel.id;
                // Finde die neue Message-ID in premierBoards
                for (const [messageId, board] of Object.entries(premierBoards)) {
                    if (board.channelId === channelId) {
                        await addMessageIdToBoard('premier', messageId);
                        break;
                    }
                }
                
                // Frühe Bestätigung senden (nur wenn nicht im Silent Mode)
                await safeEditReply(interaction, 'Premier-Anmeldung wurde erstellt.', 'premier erstellt');
                
                const userId = getFirstSignedUpUserId() || client.user.id;
                setTimeout(async () => {
                    const channelId = interaction.channel.id;
                    // Finde die neue Message-ID in premierBoards
                    for (const [messageId, board] of Object.entries(premierBoards)) {
                        if (board.channelId === channelId) {
                            try {
                                const channel = await client.channels.fetch(board.channelId);
                                const embed = await getSignupEmbed(client, null, messageId);
                                const buttonRows = getButtonRow(userId);
                                const msg = await channel.messages.fetch(messageId);
                                await msg.edit({ embeds: [embed], components: buttonRows });
                            } catch (e) {
                                console.error('Fehler beim Aktualisieren des Premier-Boards:', e);
                            }
                            break;
                        }
                    }
                }, 100);
            } catch (error) {
                console.error('Fehler beim Premier Command:', error);
                try {
                    await interaction.editReply({ content: 'Fehler beim Erstellen der Premier-Anmeldung.' });
                } catch (editError) {
                    console.error('Fehler beim editReply:', editError);
                }
            }
        }
        
        if (interaction.commandName === 'recover') {
            try {
                // Admin-Prüfung
                const member = await interaction.guild.members.fetch(interaction.user.id);
                if (!(await hasAdminPermissions(member))) {
                    await interaction.reply({ content: 'Nur Administratoren dürfen diesen Befehl ausführen.', flags: [MessageFlags.Ephemeral] });
                    return;
                }
                
                // Prüfe ob Interaction bereits abgelaufen ist
                const interactionAgeMs = Date.now() - interaction.createdTimestamp;
                if (interactionAgeMs > 2500) {
                    console.log('Interaction zu alt für /recover Command');
                    return;
                }
                
                // Sofortige Antwort um Timeout zu vermeiden
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply({ content: '🔍 Starte Wiederherstellung... Dies kann einen Moment dauern.', flags: [MessageFlags.Ephemeral] });
                }
                
                // Starte Wiederherstellung im Hintergrund
                const beforeCount = Object.keys(premierBoards).length + Object.keys(practiceBoards).length + 
                                   Object.keys(tournamentBoards).length + Object.keys(scrimBoards).length;
                
                // Führe Wiederherstellung asynchron aus
                recoverMissingBoardStates().then(async () => {
                    try {
                        const afterCount = Object.keys(premierBoards).length + Object.keys(practiceBoards).length + 
                                          Object.keys(tournamentBoards).length + Object.keys(scrimBoards).length;
                        
                        const recovered = afterCount - beforeCount;
                        
                        if (recovered > 0) {
                            await interaction.editReply({ 
                                content: `✅ ${recovered} Board-States erfolgreich wiederhergestellt! Die Nachrichten sollten jetzt wieder funktionieren.`, 
                                flags: [MessageFlags.Ephemeral] 
                            });
                        } else {
                            await interaction.editReply({ 
                                content: 'ℹ️ Keine verlorenen Board-States gefunden. Alle Nachrichten sind bereits verfügbar.', 
                                flags: [MessageFlags.Ephemeral] 
                            });
                        }
                    } catch (editError) {
                        console.log('Konnte Edit-Reply nicht senden (Interaction möglicherweise abgelaufen)');
                    }
                }).catch(async (recoveryError) => {
                    try {
                        await interaction.editReply({ 
                            content: '❌ Fehler bei der Wiederherstellung. Bitte versuche es erneut.', 
                            flags: [MessageFlags.Ephemeral] 
                        });
                    } catch (editError) {
                        console.log('Konnte Error-Reply nicht senden (Interaction möglicherweise abgelaufen)');
                    }
                    console.error('Fehler bei der Wiederherstellung:', recoveryError);
                });
                
            } catch (error) {
                // Unterdrücke bekannte 10062/404 Fehler für abgelaufene/ungültige Interaktionen
                const errorCode = (error && error.code) || (error && error.rawError && error.rawError.code);
                if (errorCode === 10062 || (error && error.status === 404)) {
                    console.log('Interaction für /recover bereits abgelaufen');
                    return;
                }
                console.error('Fehler beim /recover Command:', error);
            }
        }
        
        if (interaction.commandName === 'force-backup') {
            // Admin-Prüfung
            const member = await interaction.guild.members.fetch(interaction.user.id);
            if (!(await hasAdminPermissions(member))) {
                await interaction.reply({ content: 'Nur Administratoren dürfen diesen Befehl ausführen.', flags: [MessageFlags.Ephemeral] });
                return;
            }
            
            const beforeBackup = {
                premier: Object.keys(premierBoards).length,
                practice: Object.keys(practiceBoards).length,
                tournament: Object.keys(tournamentBoards).length,
                scrim: Object.keys(scrimBoards).length
            };
            
            saveSignupBackup();
            
            await interaction.reply({ 
                content: `✅ Backup erstellt mit Board-States:\n` +
                        `• Premier: ${beforeBackup.premier} Boards\n` +
                        `• Practice: ${beforeBackup.practice} Boards\n` +
                        `• Tournament: ${beforeBackup.tournament} Boards\n` +
                        `• Scrim: ${beforeBackup.scrim} Boards\n\n` +
                        `Das Backup enthält jetzt alle aktiven Board-States und wird bei Bot-Neustarts korrekt geladen.`, 
                flags: [MessageFlags.Ephemeral] 
            });
        }
        
        if (interaction.commandName === 'tournament-add') {
            // Admin-Prüfung
            const member = await interaction.guild.members.fetch(interaction.user.id);
            if (!(await hasAdminPermissions(member))) {
                await interaction.reply({ content: 'Nur Administratoren dürfen diesen Befehl ausführen.', flags: [MessageFlags.Ephemeral] });
                return;
            }
            
            const user = interaction.options.getUser('user');
            const datum = interaction.options.getString('datum');
            const discordMessageId = interaction.options.getString('id');
            
            // Finde die Tournament-Nachricht anhand der Discord Message ID
            const messageData = getMessageByDiscordId(discordMessageId);
            if (!messageData) {
                await interaction.reply({ 
                    content: `Keine Nachricht mit ID ${discordMessageId} gefunden.`, 
                    flags: [MessageFlags.Ephemeral] 
                });
                return;
            }
            
            // Prüfe ob es ein Tournament ist
            if (messageData.type !== 'tournament') {
                await interaction.reply({ 
                    content: `ID ${discordMessageId} gehört zu einer ${messageData.type}-Nachricht, nicht zu einem Tournament.`, 
                    flags: [MessageFlags.Ephemeral] 
                });
                return;
            }
            
            // Validiere Datum-Format
            const dateRegex = /^(\d{2})\.(\d{2})\.(\d{4})$/;
            const dateMatch = datum.match(dateRegex);
            if (!dateMatch) {
                await interaction.reply({ 
                    content: 'Ungültiges Datumformat. Verwende DD.MM.YYYY (z.B. 28.09.2025)', 
                    flags: [MessageFlags.Ephemeral] 
                });
                return;
            }
            
            // Prüfe ob der hinzuzufügende User bereits die erforderliche Rolle hat
            const targetMember = await interaction.guild.members.fetch(user.id).catch(() => null);
            if (!targetMember) {
                await interaction.reply({ 
                    content: `User ${user.displayName} nicht gefunden im Server.`, 
                    flags: [MessageFlags.Ephemeral] 
                });
                return;
            }
            
            // Lade alle verfügbaren Rollen
            const allowedRoles = getAllAvailableRoleIds();
            
            let hasRole = false;
            for (const roleId of allowedRoles) {
                if (targetMember.roles.cache.has(roleId)) {
                    hasRole = true;
                    break;
                }
            }
            if (!hasRole) {
                await interaction.reply({ 
                    content: `${user.displayName} hat nicht die erforderliche Berechtigung für diesen Bot.`, 
                    flags: [MessageFlags.Ephemeral] 
                });
                return;
            }
            
            // Finde den Tournament-Rundenschlüssel für das Datum
            const tournamentKey = tournamentConfig.dates.findIndex(date => date === datum);
            if (tournamentKey === -1) {
                await interaction.reply({ 
                    content: `Datum ${datum} ist nicht in der Tournament-Konfiguration vorhanden.\nVerfügbare Daten: ${tournamentConfig.dates.join(', ')}`, 
                    flags: [MessageFlags.Ephemeral] 
                });
                return;
            }
            
            const key = getTournamentKey(tournamentKey);
            
            // Prüfe ob User bereits eingetragen ist
            if (tournamentSignups[key] && tournamentSignups[key].includes(user.id)) {
                await interaction.reply({ 
                    content: `${user.displayName} ist bereits für ${tournamentConfig.labels[tournamentKey]} (${datum}) eingetragen.`, 
                    flags: [MessageFlags.Ephemeral] 
                });
                return;
            }
            
            // Prüfe ob noch Platz ist (max 5)
            if (!tournamentSignups[key]) {
                tournamentSignups[key] = [];
            }
            
            if (tournamentSignups[key].length >= 5) {
                await interaction.reply({ 
                    content: `${tournamentConfig.labels[tournamentKey]} (${datum}) ist bereits voll (5/5 Spieler).`, 
                    flags: [MessageFlags.Ephemeral] 
                });
                return;
            }
            
            try {
                // Füge User hinzu
                tournamentSignups[key].push(user.id);
                
                // Backup aktualisieren
                saveSignupBackup();
                
                // Tournament-Board aktualisieren
                const channel = await client.channels.fetch(messageData.channelId);
                const msg = await channel.messages.fetch(messageData.discordMessageId);
                
                    if (tournamentBoards[messageData.channelId]) {
                        const currentPage = tournamentBoards[messageData.channelId].currentPage || 0;
                        const embed = await getTournamentSignupEmbed(client, client.user.id, currentPage, discordMessageId);
                        const buttonRows = getTournamentButtonRowsWithControls(client.user.id, true, currentPage);
                        await msg.edit({ embeds: [embed], components: buttonRows });
                    }
                
                await interaction.reply({ 
                    content: `✅ ${user.displayName} wurde erfolgreich zu ${tournamentConfig.labels[tournamentKey]} (${datum}) hinzugefügt.\n**Aktueller Stand:** ${tournamentSignups[key].length}/5 Spieler`, 
                    flags: [MessageFlags.Ephemeral] 
                });
                
                // Sende Tournament-Found-DM wenn 5 Spieler erreicht
                if (tournamentSignups[key].length === 5) {
                    await sendTournamentFoundDM(key);
                }
                
            } catch (error) {
                console.error('Fehler beim Hinzufügen zum Tournament:', error);
                await interaction.reply({ 
                    content: 'Fehler beim Hinzufügen zum Tournament. Nachricht möglicherweise gelöscht.', 
                    flags: [MessageFlags.Ephemeral] 
                });
            }
        }
        
        if (interaction.commandName === 'tournament') {
            // Rollenprüfung für Tournament-Befehl (nur Admins)
            const hasRole = await hasRequiredRole(interaction, 'admin_commands', 'tournament');
            if (!hasRole) {
                await interaction.reply({ 
                    content: 'Du hast nicht die erforderliche Berechtigung für Tournament-Befehle.', 
                    flags: [MessageFlags.Ephemeral] 
                });
                return;
            }
            
            // Team-Auswahl verarbeiten
            const team = interaction.options.getString('team');
            
            await safeEphemeralReply(interaction, `Turnier wird für ${team === 'academy' ? 'Academy-Team' : 'Main-Team'} erstellt...`, 'tournament');
            
            try {
                // User-Cache leeren
                for (const key in userCache) delete userCache[key];
                await postTournamentSignupWithDelete(interaction.channel, team);
                
                // Message-ID zu roles.json hinzufügen
                const channelId = interaction.channel.id;
                // Finde die neue Message-ID in tournamentBoards
                for (const [messageId, board] of Object.entries(tournamentBoards)) {
                    if (board.channelId === channelId) {
                        await addMessageIdToBoard('tournament', messageId);
                        break;
                    }
                }
                
                // Frühe Bestätigung senden (nur wenn nicht im Silent Mode)
                await safeEditReply(interaction, 'Turnier-Anmeldung wurde erstellt!', 'tournament erstellt');
                
                const userId = getFirstSignedUpUserId() || client.user.id;
                setTimeout(async () => {
                    const channelId = interaction.channel.id;
                    // Finde die neue Message-ID in tournamentBoards
                    for (const [messageId, board] of Object.entries(tournamentBoards)) {
                        if (board.channelId === channelId) {
                            try {
                                const channel = await client.channels.fetch(board.channelId);
                                const embed = await getTournamentSignupEmbed(client, null, board.page || 0, messageId);
                                const buttonRows = getTournamentButtonRowsWithControls(userId, true, board.page || 0);
                                const msg = await channel.messages.fetch(messageId);
                                await msg.edit({ embeds: [embed], components: buttonRows });
                            } catch (e) {
                                console.error('Fehler beim Aktualisieren des Tournament-Boards:', e);
                            }
                            break;
                        }
                    }
                }, 100);
            } catch (error) {
                console.error('Fehler beim Tournament Command:', error);
                try {
                    await interaction.editReply({ content: 'Fehler beim Erstellen der Turnier-Anmeldung.' });
                } catch (editError) {
                    console.error('Fehler beim editReply:', editError);
                }
            }
        }
        
        if (interaction.commandName === 'tournament-config') {
            // Admin-Prüfung
            const member = await interaction.guild.members.fetch(interaction.user.id);
            if (!(await hasAdminPermissions(member))) {
                await interaction.reply({ content: 'Nur Administratoren dürfen diesen Befehl ausführen.', flags: [MessageFlags.Ephemeral] });
                return;
            }
            
            // Sofortige Antwort um Timeout zu vermeiden
            await interaction.reply({ content: 'Turnier-Konfiguration wird aktualisiert...', flags: [MessageFlags.Ephemeral] });
            
            // Team-Auswahl verarbeiten
            const team = interaction.options.getString('team');
            
            const newDates = [];
            const newTimes = [];
            const newLabels = [];
            
            // Sammle alle eingegebenen Termine (erweitert auf 7)
            for (let i = 1; i <= 7; i++) {
                const date = interaction.options.getString(`date_${i}`);
                const time = interaction.options.getString(`time_${i}`);
                const label = interaction.options.getString(`label_${i}`);
                
                if (date && time && label) {
                    // Validiere Datum (DD.MM.YYYY Format)
                    const dateRegex = /^(\d{2})\.(\d{2})\.(\d{4})$/;
                    if (!dateRegex.test(date)) {
                        await interaction.editReply({ content: `❌ Ungültiges Datumsformat für Termin ${i}! Verwende DD.MM.YYYY (z.B. 28.09.2025)`, flags: [MessageFlags.Ephemeral] });
                        return;
                    }
                    
                    newDates.push(date);
                    newTimes.push(time);
                    newLabels.push(label);
                }
            }
            
            if (newDates.length === 0) {
                await interaction.editReply({ content: '❌ Mindestens ein Turnier-Termin muss angegeben werden!', flags: [MessageFlags.Ephemeral] });
                return;
            }
            
            // Aktualisiere Konfiguration für das gewählte Team
            tournamentConfig[team].dates = newDates;
            tournamentConfig[team].times = newTimes;
            tournamentConfig[team].labels = newLabels;
            
            // Erstelle automatische Gruppen basierend auf Anzahl
            const groups = [];
            if (newDates.length <= 3) {
                groups.push({ name: 'Turnier', indices: Array.from({length: newDates.length}, (_, i) => i) });
            } else if (newDates.length <= 5) {
                groups.push({ name: 'Gruppenphase', indices: [0, 1, 2] });
                if (newDates.length >= 4) groups.push({ name: 'Finale', indices: newDates.length === 4 ? [3] : [3, 4] });
            } else {
                // 6-7 Termine: Gruppenphase, Viertelfinale, Halbfinale, Finale
                groups.push({ name: 'Gruppenphase', indices: [0, 1, 2] });
                groups.push({ name: 'Viertelfinale', indices: [3] });
                if (newDates.length >= 6) groups.push({ name: 'Halbfinale', indices: [4, 5] });
                if (newDates.length >= 7) groups.push({ name: 'Finale', indices: [6] });
            }
            
            tournamentConfig[team].groups = groups;
            tournamentConfig[team].currentPage = 0;
            
            // Initialisiere Tournament-Signups neu
            initializeDynamicSignups();
            
            // Backup speichern
            saveSignupBackup();
            
            let configText = `**Turnier-Konfiguration aktualisiert!**\n\n**${newDates.length} Termine in ${groups.length} Gruppen:**\n`;
            const groupText = groups.map(g => `**${g.name}**: ${g.indices.map(i => newLabels[i]).join(', ')}`).join('\n');
            configText += groupText + '\n\n**Termine:**\n';
            for (let i = 0; i < newDates.length; i++) {
                configText += `${newLabels[i]}: ${newDates[i]} um ${newTimes[i]} Uhr\n`;
            }
            
            await interaction.editReply({ 
                content: configText, 
                flags: [MessageFlags.Ephemeral] 
            });
        }
        
        if (interaction.commandName === 'premier-admin') {
            // Admin-Prüfung
            const member = await interaction.guild.members.fetch(interaction.user.id);
            if (!(await hasAdminPermissions(member))) {
                await interaction.reply({ content: 'Nur Administratoren dürfen diesen Befehl ausführen.', flags: [MessageFlags.Ephemeral] });
                return;
            }
            
            const subcommand = interaction.options.getSubcommand();
            if (subcommand === 'add') {
                // Universelles deferReply bereits erledigt
                await interaction.editReply({ content: 'Spieler wird hinzugefügt...' });
                const userId = interaction.options.getString('user'); // Direkt User-ID aus Dropdown
                const day = interaction.options.getString('day');
                
                // Hole User-Objekt für Display-Zwecke
                let user;
                try {
                    user = await client.users.fetch(userId);
                } catch (error) {
                    await interaction.editReply({ content: '❌ Fehler beim Laden des Benutzers.' });
                    return;
                }
                
                if (signups[day].includes(userId)) {
                    await interaction.editReply({ content: `Spieler ist bereits für ${day} angemeldet!` });
                } else if (signups[day].length < MAX_USERS) {
                    signups[day].push(userId);
                    validateSignupData();
                    // User-Cache leeren
                    for (const key in userCache) delete userCache[key];
                    await sendPremierFoundDMByKey(day);
                    // Kurz-Log
                    console.log(`Eingetragen: ${user.username} für ${day}`);
                    // Board für den Command-User nach 0,1 Sekunde aktualisieren
                    setTimeout(async () => {
                        const cmdUserId = interaction.user.id;
                        const embed = await getSignupEmbed(client);
                        const buttonRows = getButtonRow(cmdUserId);
                        const channelId = interaction.channel.id;
                        if (premierBoards[channelId]?.messageId && premierBoards[channelId]?.channelId) {
                            try {
                                const channel = await client.channels.fetch(premierBoards[channelId]?.channelId);
                                const msg = await channel.messages.fetch(premierBoards[channelId]?.messageId);
                                await msg.edit({ embeds: [embed], components: buttonRows });
                            } catch (e) {
                                console.warn('Fehler beim Aktualisieren der Premier-Nachricht (Hinzufügen):', e.message);
                            }
                        }
                    }, 100);
                    await interaction.editReply({ content: `Spieler wurde erfolgreich für ${day} hinzugefügt!` });
                } else {
                    await interaction.editReply({ content: `Leider ist kein Platz mehr für ${day} verfügbar!` });
                }
            } else if (subcommand === 'delete') {
                // Universelles deferReply bereits erledigt
                await interaction.editReply({ content: 'Spieler wird entfernt...' });
                const userId = interaction.options.getString('user'); // Direkt User-ID aus Dropdown
                const day = interaction.options.getString('day');
                
                // Hole User-Objekt für Display-Zwecke
                let user;
                try {
                    user = await client.users.fetch(userId);
                } catch (error) {
                    await interaction.editReply({ content: '❌ Fehler beim Laden des Benutzers.' });
                    return;
                }
                
                if (signups[day].includes(userId)) {
                    const wasFull = signups[day].length === MAX_USERS; // Vorher 5?
                    signups[day] = signups[day].filter(u => u !== userId);
                    validateSignupData();
                    // User-Cache leeren
                    for (const key in userCache) delete userCache[key];
                    // Kurz-Log
                    console.log(`Entfernt: ${user.username} von ${day}`);
                    // --- NEU: Absage-DM sofort bei Abmeldung, wenn vorher 5, jetzt weniger ---
                    if (wasFull && signups[day].length === MAX_USERS - 1) {
                        await sendPremierCancelDM(day, user.username);
                    }
                    // Board für den Command-User nach 0,1 Sekunde aktualisieren
                    setTimeout(async () => {
                        const cmdUserId = interaction.user.id;
                        const embed = await getSignupEmbed(client);
                        const buttonRows = getButtonRow(cmdUserId);
                        const channelId = interaction.channel.id;
                        if (premierBoards[channelId]?.messageId && premierBoards[channelId]?.channelId) {
                            try {
                                const channel = await client.channels.fetch(premierBoards[channelId]?.channelId);
                                const msg = await channel.messages.fetch(premierBoards[channelId]?.messageId);
                                await msg.edit({ embeds: [embed], components: buttonRows });
                            } catch (e) {
                                console.warn('Fehler beim Aktualisieren der Premier-Nachricht (Entfernen):', e.message);
                            }
                        }
                    }, 100);
                    await interaction.editReply({ content: `Spieler wurde erfolgreich von ${day} entfernt!` });
                } else {
                    await interaction.editReply({ content: `Spieler ist nicht für ${day} angemeldet!` });
                }
            }
        }
        if (interaction.commandName === 'scrim-admin') {
            // Admin-Prüfung
            const member = await interaction.guild.members.fetch(interaction.user.id);
            if (!(await hasAdminPermissions(member))) {
                await interaction.reply({ content: 'Nur Administratoren dürfen diesen Befehl ausführen.', flags: [MessageFlags.Ephemeral] });
                return;
            }
            
            const subcommand = interaction.options.getSubcommand();
            if (subcommand === 'add') {
                // Universelles deferReply bereits erledigt
                await interaction.editReply({ content: 'Spieler wird zum Scrim hinzugefügt...' });
                const userId = interaction.options.getString('user'); // Direkt User-ID aus Dropdown
                const game = interaction.options.getString('game');
                
                // Hole User-Objekt für Display-Zwecke
                let user;
                try {
                    user = await client.users.fetch(userId);
                } catch (error) {
                    await interaction.editReply({ content: '❌ Fehler beim Laden des Benutzers.' });
                    return;
                }
                
                // Stelle sicher, dass das Game-Array existiert
                if (!scrimSignups[game]) scrimSignups[game] = [];
                
                if (scrimSignups[game].includes(userId)) {
                    await interaction.editReply({ content: `Spieler ist bereits für ${game} angemeldet!` });
                } else if (scrimSignups[game].length < MAX_USERS) {
                    scrimSignups[game].push(userId);
                    markSignupDataChanged();
                    validateSignupData();
                    // User-Cache leeren
                    for (const key in userCache) delete userCache[key];
                    console.log(`Eingetragen: ${user.username} für Scrim ${game}`);
                    
                    // Board für den Command-User nach 0,1 Sekunde aktualisieren
                    setTimeout(async () => {
                        const cmdUserId = interaction.user.id;
                        const embed = await getScrimSignupEmbed(client);
                        const buttonRows = getScrimButtonRowsWithControls(cmdUserId);
                        const channelId = interaction.channel.id;
                        if (scrimBoards[channelId]?.messageId && scrimBoards[channelId]?.channelId) {
                            try {
                                const channel = await client.channels.fetch(scrimBoards[channelId]?.channelId);
                                const msg = await channel.messages.fetch(scrimBoards[channelId]?.messageId);
                                await msg.edit({ embeds: [embed], components: buttonRows });
                            } catch (e) {
                                console.warn('Fehler beim Aktualisieren der Scrim-Nachricht (Hinzufügen):', e.message);
                            }
                        }
                    }, 100);
                    await interaction.editReply({ content: `Spieler wurde erfolgreich für ${game} hinzugefügt!` });
                } else {
                    await interaction.editReply({ content: `Leider ist kein Platz mehr für ${game} verfügbar!` });
                }
            } else if (subcommand === 'delete') {
                // Universelles deferReply bereits erledigt
                await interaction.editReply({ content: 'Spieler wird vom Scrim entfernt...' });
                const userId = interaction.options.getString('user'); // Direkt User-ID aus Dropdown
                const game = interaction.options.getString('game');
                
                // Hole User-Objekt für Display-Zwecke
                let user;
                try {
                    user = await client.users.fetch(userId);
                } catch (error) {
                    await interaction.editReply({ content: '❌ Fehler beim Laden des Benutzers.' });
                    return;
                }
                
                // Stelle sicher, dass das Game-Array existiert
                if (!scrimSignups[game]) scrimSignups[game] = [];
                
                if (scrimSignups[game].includes(userId)) {
                    scrimSignups[game] = scrimSignups[game].filter(u => u !== userId);
                    markSignupDataChanged();
                    validateSignupData();
                    // User-Cache leeren
                    for (const key in userCache) delete userCache[key];
                    console.log(`Entfernt: ${user.username} von Scrim ${game}`);
                    
                    // Board für den Command-User nach 0,1 Sekunde aktualisieren
                    setTimeout(async () => {
                        const cmdUserId = interaction.user.id;
                        const embed = await getScrimSignupEmbed(client);
                        const buttonRows = getScrimButtonRowsWithControls(cmdUserId);
                        const channelId = interaction.channel.id;
                        if (scrimBoards[channelId]?.messageId && scrimBoards[channelId]?.channelId) {
                            try {
                                const channel = await client.channels.fetch(scrimBoards[channelId]?.channelId);
                                const msg = await channel.messages.fetch(scrimBoards[channelId]?.messageId);
                                await msg.edit({ embeds: [embed], components: buttonRows });
                            } catch (e) {
                                console.warn('Fehler beim Aktualisieren der Scrim-Nachricht (Entfernen):', e.message);
                            }
                        }
                    }, 100);
                    await interaction.editReply({ content: `Spieler wurde erfolgreich von ${game} entfernt!` });
                } else {
                    await interaction.editReply({ content: `Spieler ist nicht für ${game} angemeldet!` });
                }
            }
        }
        if (interaction.commandName === 'practice-admin') {
            // Admin-Prüfung
            const member = await interaction.guild.members.fetch(interaction.user.id);
            if (!(await hasAdminPermissions(member))) {
                await interaction.reply({ content: 'Nur Administratoren dürfen diesen Befehl ausführen.', flags: [MessageFlags.Ephemeral] });
                return;
            }

            const subcommand = interaction.options.getSubcommand();
            if (subcommand === 'add') {
                // Universelles deferReply bereits erledigt
                await interaction.editReply({ content: 'Spieler wird zum Practice hinzugefügt...' });
                const userId = interaction.options.getString('user');
                const day = interaction.options.getString('day');

                // Sicherheitscheck: practiceSignups-Struktur sicherstellen
                if (!practiceSignups || typeof practiceSignups !== 'object') {
                    practiceSignups = {};
                }
                if (!Array.isArray(practiceSignups[day])) {
                    practiceSignups[day] = [];
                }

                let user;
                try {
                    user = await client.users.fetch(userId);
                } catch (error) {
                    await interaction.editReply({ content: '❌ Fehler beim Laden des Benutzers.' });
                    return;
                }

                if (practiceSignups[day].includes(userId)) {
                    await interaction.editReply({ content: `Spieler ist bereits für ${day} eingetragen!` });
                } else {
                    practiceSignups[day].push(userId);
                    // User-Cache leeren
                    for (const key in userCache) delete userCache[key];
                    console.log(`Eingetragen (Practice): ${user.username} für ${day}`);

                    // Board nach 0,1 Sekunde aktualisieren
                    setTimeout(async () => {
                        const embed = await getPracticeSignupEmbed(client);
                        const buttonRows = getPracticeButtonRowsWithControls(client.user.id);
                        const channelId = interaction.channel.id;
                        if (practiceBoards[channelId]?.messageId && practiceBoards[channelId]?.channelId) {
                            try {
                                const channel = await client.channels.fetch(practiceBoards[channelId].channelId);
                                const msg = await channel.messages.fetch(practiceBoards[channelId].messageId);
                                await msg.edit({ embeds: [embed], components: buttonRows });
                            } catch (e) {
                                console.error('Fehler beim Aktualisieren des Practice-Boards:', e);
                            }
                        }
                    }, 100);
                    await interaction.editReply({ content: `Spieler wurde für ${day} hinzugefügt.` });
                }
            }
            if (subcommand === 'delete') {
                // Universelles deferReply bereits erledigt
                await interaction.editReply({ content: 'Spieler wird vom Practice entfernt...' });
                const userId = interaction.options.getString('user');
                const day = interaction.options.getString('day');

                // Sicherheitscheck: practiceSignups-Struktur sicherstellen
                if (!practiceSignups || typeof practiceSignups !== 'object') {
                    practiceSignups = {};
                }
                if (!Array.isArray(practiceSignups[day])) {
                    practiceSignups[day] = [];
                }

                let user;
                try {
                    user = await client.users.fetch(userId);
                } catch (error) {
                    await interaction.editReply({ content: '❌ Fehler beim Laden des Benutzers.' });
                    return;
                }

                if (!practiceSignups[day].includes(userId)) {
                    await interaction.editReply({ content: `Spieler ist nicht für ${day} eingetragen!` });
                } else {
                    practiceSignups[day] = practiceSignups[day].filter(id => id !== userId);
                    // User-Cache leeren
                    for (const key in userCache) delete userCache[key];
                    console.log(`Entfernt (Practice): ${user.username} von ${day}`);

                    // Board nach 0,1 Sekunde aktualisieren
                    setTimeout(async () => {
                        const embed = await getPracticeSignupEmbed(client);
                        const buttonRows = getPracticeButtonRowsWithControls(client.user.id);
                        const channelId = interaction.channel.id;
                        if (practiceBoards[channelId]?.messageId && practiceBoards[channelId]?.channelId) {
                            try {
                                const channel = await client.channels.fetch(practiceBoards[channelId].channelId);
                                const msg = await channel.messages.fetch(practiceBoards[channelId].messageId);
                                await msg.edit({ embeds: [embed], components: buttonRows });
                            } catch (e) {
                                console.error('Fehler beim Aktualisieren des Practice-Boards:', e);
                            }
                        }
                    }, 100);
                    await interaction.editReply({ content: `Spieler wurde von ${day} entfernt.` });
                }
            }
        }
        if (interaction.commandName === 'scrim-admin') {
            // Admin-Prüfung
            const member = await interaction.guild.members.fetch(interaction.user.id);
            if (!(await hasAdminPermissions(member))) {
                await interaction.reply({ content: 'Nur Administratoren dürfen diesen Befehl ausführen.', flags: [MessageFlags.Ephemeral] });
                return;
            }

            const subcommand = interaction.options.getSubcommand();
            if (subcommand === 'add') {
                // Universelles deferReply bereits erledigt
                await interaction.editReply({ content: 'Spieler wird zum Wochen-Scrim hinzugefügt...' });
                const userId = interaction.options.getString('user');
                const messageId = interaction.options.getString('message_id');

                // Prüfe ob Wochen-Scrim existiert
                if (!wochenScrimData[messageId]) {
                    await interaction.editReply({ content: `❌ Wochen-Scrim mit Message-ID ${messageId} nicht gefunden!\n\nHinweis: Dieser Command funktioniert nur mit Wochen-Scrims.` });
                    return;
                }

                let user;
                try {
                    user = await client.users.fetch(userId);
                } catch (error) {
                    await interaction.editReply({ content: '❌ Fehler beim Laden des Benutzers.' });
                    return;
                }

                const wochenData = wochenScrimData[messageId];
                const dayIndex = wochenData.currentPage || 0;
                const day = wochenData.style === 'single_message' ? Object.keys(wochenData.days)[0] : WEEKDAYS[dayIndex];
                const dayData = wochenData.days[day];

                if (!dayData) {
                    await interaction.editReply({ content: `❌ Keine Daten für ${day} gefunden!` });
                    return;
                }

                // Prüfe ob User bereits eingetragen ist
                if (dayData.players.includes(userId)) {
                    await interaction.editReply({ content: `Spieler ist bereits als Hauptspieler für ${day} eingetragen!` });
                    return;
                }
                if (dayData.subs.includes(userId)) {
                    await interaction.editReply({ content: `Spieler ist bereits als Sub für ${day} eingetragen!` });
                    return;
                }

                // Füge User hinzu (Hauptspieler wenn < 5, sonst Sub)
                let addedAs = '';
                if (dayData.players.length < 5) {
                    dayData.players.push(userId);
                    addedAs = 'Hauptspieler';
                } else {
                    dayData.subs.push(userId);
                    addedAs = 'Sub';
                }

                for (const key in userCache) delete userCache[key];
                for (const key in displayNameCache) delete displayNameCache[key];
                
                const displayName = await getDisplayName(userId, interaction.guild?.id);
                console.log(`Hinzugefügt (Wochen-Scrim): ${displayName} als ${addedAs} für ${day} (Message ${messageId})`);

                // Aktualisiere Board
                setTimeout(async () => {
                    try {
                        const channel = await client.channels.fetch(scrimBoards[messageId]?.channelId || interaction.channel.id);
                        const embed = await getWochenScrimEmbed(messageId, dayIndex);
                        const buttons = getWochenScrimButtons(messageId, dayIndex);
                        const msg = await channel.messages.fetch(messageId);
                        await msg.edit({ embeds: [embed], components: buttons });
                    } catch (e) {
                        console.error('Fehler beim Aktualisieren des Wochen-Scrim-Boards:', e);
                    }
                }, 100);
                
                saveSignupBackup();
                await interaction.editReply({ content: `✅ ${displayName} wurde als **${addedAs}** für **${day}** hinzugefügt!` });
            }
            
            if (subcommand === 'delete') {
                // Universelles deferReply bereits erledigt
                await interaction.editReply({ content: 'Spieler wird aus dem Scrim entfernt...' });
                const userId = interaction.options.getString('user');
                const gameNumber = interaction.options.getInteger('game');
                const gameKey = `game${gameNumber}`;

                // Sicherheitscheck
                if (!scrimSignups || typeof scrimSignups !== 'object') {
                    scrimSignups = {};
                }
                if (!Array.isArray(scrimSignups[gameKey])) {
                    scrimSignups[gameKey] = [];
                }

                let user;
                try {
                    user = await client.users.fetch(userId);
                } catch (error) {
                    await interaction.editReply({ content: '❌ Fehler beim Laden des Benutzers.' });
                    return;
                }

                if (!scrimSignups[gameKey].includes(userId)) {
                    await interaction.editReply({ content: `Spieler ist nicht in Game ${gameNumber} eingetragen!` });
                } else {
                    scrimSignups[gameKey] = scrimSignups[gameKey].filter(id => id !== userId);
                    for (const key in userCache) delete userCache[key];
                    console.log(`Entfernt (Scrim): ${user.username} aus Game ${gameNumber}`);

                    setTimeout(async () => {
                        const embed = await getScrimSignupEmbed(client);
                        const buttonRows = getScrimButtonRowsWithControls(client.user.id);
                        const channelId = interaction.channel.id;
                        if (scrimBoards[channelId]?.messageId && scrimBoards[channelId]?.channelId) {
                            try {
                                const channel = await client.channels.fetch(scrimBoards[channelId]?.channelId);
                                const msg = await channel.messages.fetch(scrimBoards[channelId]?.messageId);
                                await msg.edit({ embeds: [embed], components: buttonRows });
                            } catch (e) {
                                console.error('Fehler beim Aktualisieren des Scrim-Boards:', e);
                            }
                        }
                    }, 100);
                    await interaction.editReply({ content: `Spieler wurde aus Game ${gameNumber} entfernt.` });
                }
            }
            
            if (subcommand === 'refresh') {
                // Universelles deferReply bereits erledigt
                const messageId = interaction.options.getString('message_id');
                
                // Prüfe ob es ein Scrim Board ist
                if (!scrimBoards[messageId]) {
                    await interaction.editReply({ content: `❌ Scrim-Board mit Message-ID ${messageId} nicht gefunden!\n\nHinweis: Nutze die Message-ID aus dem Footer der Nachricht.` });
                    return;
                }
                
                // Bestätige Interaktion sofort
                await interaction.editReply({ content: '✅ Reparatur gestartet! Die Nachricht wird in wenigen Sekunden neu geladen...' });
                
                // Führe die eigentliche Arbeit asynchron aus
                (async () => {
                    try {
                        const boardInfo = scrimBoards[messageId];
                        const channel = await client.channels.fetch(boardInfo.channelId);
                        
                        console.log(`🔄 Starte Reparatur von Scrim-Nachricht ${messageId}...`);
                        
                        // Warte 1 Sekunde
                        await new Promise(resolve => setTimeout(resolve, 1000));
                        
                        // Versuche die alte Nachricht zu löschen
                        try {
                            const oldMsg = await channel.messages.fetch(messageId);
                            await oldMsg.delete();
                            console.log(`🗑️ Alte Scrim-Nachricht ${messageId} wurde gelöscht`);
                        } catch (e) {
                            console.warn(`⚠️ Konnte alte Nachricht ${messageId} nicht löschen:`, e.message);
                        }
                        
                        // Warte 2 Sekunden bevor neue Nachricht erstellt wird
                        await new Promise(resolve => setTimeout(resolve, 2000));
                        
                        // Erstelle neue Nachricht mit denselben Daten
                        const maxGames = boardInfo.maxGames || 1;
                        const day = boardInfo.day;
                        const time = boardInfo.time;
                        
                        console.log(`📝 Erstelle neue Scrim-Nachricht für ${day} ${time}...`);
                        
                        // Erstelle neues Embed
                        const embed = await getScrimSignupEmbed(client, null, day, time, maxGames, null);
                        const buttonRows = getScrimButtonRowsWithControls(null, true, maxGames, null);
                        
                        // Sende neue Nachricht
                        const newMsg = await channel.send({ embeds: [embed], components: buttonRows });
                        
                        // Warte 2 Sekunden
                        await new Promise(resolve => setTimeout(resolve, 2000));
                        
                        console.log(`🔄 Aktualisiere neue Nachricht ${newMsg.id} mit Message-ID...`);
                        
                        // Aktualisiere die Message-ID im Footer
                        const embedWithId = await getScrimSignupEmbed(client, null, day, time, maxGames, newMsg.id);
                        const buttonRowsWithId = getScrimButtonRowsWithControls(null, true, maxGames, newMsg.id);
                        await newMsg.edit({ embeds: [embedWithId], components: buttonRowsWithId });
                        
                        // Warte 1 Sekunde
                        await new Promise(resolve => setTimeout(resolve, 1000));
                        
                        // Übertrage Signups von alter auf neue Message-ID
                        if (scrimSignups[messageId]) {
                            scrimSignups[newMsg.id] = scrimSignups[messageId];
                            delete scrimSignups[messageId];
                            console.log(`✅ Signups übertragen`);
                        }
                        
                        // Übertrage Wochen-Scrim-Daten falls vorhanden
                        if (wochenScrimData[messageId]) {
                            wochenScrimData[newMsg.id] = wochenScrimData[messageId];
                            delete wochenScrimData[messageId];
                            console.log(`✅ Wochen-Scrim-Daten übertragen`);
                        }
                        
                        // Aktualisiere Board-Info mit neuer Message-ID
                        scrimBoards[newMsg.id] = {
                            ...boardInfo,
                            messageId: newMsg.id
                        };
                        delete scrimBoards[messageId];
                        
                        // Speichere Backup
                        saveSignupBackup();
                        
                        console.log(`✅ Scrim-Nachricht erfolgreich repariert: ${messageId} → ${newMsg.id}`);
                        
                    } catch (error) {
                        console.error('❌ Fehler beim Reparieren der Scrim-Nachricht:', error);
                    }
                })();
            }
        }
        
        if (interaction.commandName === 'mvp_vote') {
            // ULTRA-SCHUTZ: Prüfe ob bereits verarbeitet
            const interactionKey = `mvp_vote_${interaction.id}`;
            if (global.mvpVoteTracker && global.mvpVoteTracker.has(interactionKey)) {
                console.log(`MVP Vote Interaction ${interaction.id} bereits verarbeitet - ignoriere`);
                return;
            }
            
            // Setze Tracker SOFORT
            if (!global.mvpVoteTracker) global.mvpVoteTracker = new Set();
            global.mvpVoteTracker.add(interactionKey);
            
            // Zusätzlicher Schutz
            if (mvpVoteInProgress) {
                console.log('MVP Vote bereits in Bearbeitung - ignoriere Interaction');
                return;
            }
            
            // Setze Flag SOFORT
            mvpVoteInProgress = true;
            console.log(`MVP Vote gestartet für Interaction ${interaction.id} - Flag gesetzt`);
            
            try {
                
                // Berechtigungsprüfung: Admins oder Benutzer mit der Rolle 1414241851963342848
                const member = await interaction.guild.members.fetch(interaction.user.id);
                const hasPermission = (await hasAdminPermissions(member)) || member.roles.cache.has('1414241851963342848');
                
                if (!hasPermission) {
                    mvpVoteInProgress = false; // Reset flag
                    console.log('MVP Vote - Keine Berechtigung, Flag zurückgesetzt');
                    if (!interaction.replied && !interaction.deferred) {
                        await interaction.reply({ content: '❌ Du hast keine Berechtigung, MVP-Abstimmungen zu erstellen.', flags: [MessageFlags.Ephemeral] });
                    }
                    return;
                }

                // MVP-Abstimmung synchron erstellen
                const style = interaction.options.getString('style');
                const time = interaction.options.getString('time');
                const targetChannel = interaction.channel;

                // Definiere die Rollen-IDs für Spieler
                const playerRoleIds = ['1414241851963342848', '1402222026655010887', '1402222294612316310'];
                
                // Hole alle Spieler mit diesen Rollen - optimiert
                const playerMembers = [];
                const seenIds = new Set();
                
                // Verwende cached members wenn möglich, sonst fetch nur wenn nötig
                for (const roleId of playerRoleIds) {
                    const role = interaction.guild.roles.cache.get(roleId);
                    if (role) {
                        // Verwende cached members wenn verfügbar
                        if (role.members.size > 0) {
                            role.members.forEach(member => {
                                if (!seenIds.has(member.id) && !member.user.bot) {
                                    playerMembers.push(member);
                                    seenIds.add(member.id);
                                }
                            });
                        } else {
                            // Nur wenn keine cached members verfügbar sind, fetch spezifisch
                            try {
                                const members = await interaction.guild.members.fetch({ query: '', limit: 1000 });
                                members.forEach(member => {
                                    if (member.roles.cache.has(roleId) && !seenIds.has(member.id) && !member.user.bot) {
                                        playerMembers.push(member);
                                        seenIds.add(member.id);
                                    }
                                });
                            } catch (fetchError) {
                                console.log(`Konnte Mitglieder für Rolle ${roleId} nicht laden:`, fetchError);
                            }
                        }
                    }
                }

                if (playerMembers.length < 2) {
                    await interaction.reply({ content: '❌ Es müssen mindestens 2 Spieler mit den erforderlichen Rollen vorhanden sein!', flags: [MessageFlags.Ephemeral] });
                    mvpVoteInProgress = false;
                    return;
                }

                // Sortiere Spieler alphabetisch
                playerMembers.sort((a, b) => a.displayName.localeCompare(b.displayName));

                // Dynamische Texte basierend auf style
                const styleText = style === 'weekly' ? 'Woche' : 
                                 style === 'monthly' ? 'Monat' : 'Jahr';
                const styleTextGen = style === 'weekly' ? 'der Woche' : 
                                    style === 'monthly' ? 'des Monats' : 'des Jahres';
                
                // Berechne Enddatum
                let endDate = null;
                let durationText = '';
                if (time === '1day') {
                    endDate = new Date(Date.now() + 24 * 60 * 60 * 1000);
                    durationText = '\n📅 **Endet in: 1 Tag**';
                } else if (time === '3days') {
                    endDate = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
                    durationText = '\n📅 **Endet in: 3 Tagen**';
                } else if (time === '7days') {
                    endDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
                    durationText = '\n📅 **Endet in: 7 Tagen**';
                }
                
                // Erstelle das Embed mit verbessertem Design
                const embed = new EmbedBuilder()
                    .setTitle(`🏆 ═══ Abstimmung: MVP ${styleTextGen} ═══ 🏆`)
                    .setDescription(
                        `🌟 Wähle den besten Spieler ${styleTextGen} in 3 Kategorien! 🌟\n\n` +
                        `💪 **Effort MVP** - Wer zeigt die meiste Anstrengung?\n` +
                        `🗣️ **Comms MVP** - Wer kommuniziert am besten?\n` +
                        `💥 **Impact MVP** - Wer hat den größten Einfluss?\n\n` +
                        `⚠️ Du kannst nicht für dich selbst stimmen! ⚠️${durationText}`
                    )
                    .setColor(0xFFD700) // Gold
                    .addFields({
                        name: '═══ Kandidaten ═══',
                        value: playerMembers.map((m, idx) => `⭐ **${m.displayName}**`).join('\n')
                    })
                    .setTimestamp()
                    .setFooter({ text: `Abstimmung gestartet von ${interaction.user.username}` });

                // Erstelle 3 separate Select Menus für Effort, Comms und Impact
                const maxOptions = Math.min(playerMembers.length, 25);
                
                // Effort Select Menu
                const effortSelect = new StringSelectMenuBuilder()
                    .setCustomId('mvp_effort_select')
                    .setPlaceholder('💪 Wähle Effort MVP...')
                    .addOptions(
                        playerMembers.slice(0, maxOptions).map((member) => ({
                            label: member.displayName,
                            value: member.id,
                            description: `Effort MVP: ${member.displayName}`,
                            emoji: '💪'
                        }))
                    );

                // Comms Select Menu
                const commsSelect = new StringSelectMenuBuilder()
                    .setCustomId('mvp_comms_select')
                    .setPlaceholder('🗣️ Wähle Comms MVP...')
                    .addOptions(
                        playerMembers.slice(0, maxOptions).map((member) => ({
                            label: member.displayName,
                            value: member.id,
                            description: `Comms MVP: ${member.displayName}`,
                            emoji: '🗣️'
                        }))
                    );

                // Impact Select Menu
                const impactSelect = new StringSelectMenuBuilder()
                    .setCustomId('mvp_impact_select')
                    .setPlaceholder('💥 Wähle Impact MVP...')
                    .addOptions(
                        playerMembers.slice(0, maxOptions).map((member) => ({
                            label: member.displayName,
                            value: member.id,
                            description: `Impact MVP: ${member.displayName}`,
                            emoji: '💥'
                        }))
                    );

                const row1 = new ActionRowBuilder().addComponents(effortSelect);
                const row2 = new ActionRowBuilder().addComponents(commsSelect);
                const row3 = new ActionRowBuilder().addComponents(impactSelect);

                // Sende die Abstimmungs-Nachricht mit allen 3 Kategorien
                const voteMessage = await targetChannel.send({
                    embeds: [embed],
                    components: [row1, row2, row3]
                });

                // Speichere die Vote-Daten
                if (!global.mvpVotes) {
                    global.mvpVotes = {};
                }

                global.mvpVotes[voteMessage.id] = {
                    style: style,
                    time: time,
                    endDate: endDate ? endDate.getTime() : null,
                    channelId: targetChannel.id,
                    guildId: interaction.guild.id,
                    messageId: voteMessage.id,
                    players: playerMembers.map(m => m.id),
                    votes: {
                        effort: {}, // userId: votedForUserId
                        comms: {}, // userId: votedForUserId
                        impact: {} // userId: votedForUserId
                    },
                    createdAt: Date.now(),
                    createdBy: interaction.user.id,
                    active: true
                };

                // Speichere MVP Votes in Datei
                saveMVPVotes();
                
                // Starte Timer für zeitbasierte Abstimmungen
                if (endDate) {
                    const timeoutMs = endDate.getTime() - Date.now();
                    setTimeout(() => finalizeMVPVote(voteMessage.id), timeoutMs);
                }

                // Bestätige die Erstellung
                if (!interaction.replied && !interaction.deferred) {
                    try {
                        await interaction.reply({ content: '✅ MVP-Abstimmung wurde erfolgreich erstellt!', flags: [MessageFlags.Ephemeral] });
                    } catch (replyError) {
                        console.log('MVP Vote - Fehler beim Reply:', replyError.message);
                    }
                } else {
                    console.log('MVP Vote - Interaction bereits bearbeitet, überspringe Reply');
                }
                
                // Reset flag
                mvpVoteInProgress = false;
                console.log('MVP Vote erfolgreich erstellt - Flag zurückgesetzt');
                
                // Cleanup Tracker nach 5 Minuten
                setTimeout(() => {
                    if (global.mvpVoteTracker) {
                        global.mvpVoteTracker.delete(interactionKey);
                    }
                }, 5 * 60 * 1000);
            } catch (error) {
                // Reset flag to allow future MVP vote creation
                mvpVoteInProgress = false;
                console.log('MVP Vote Fehler - Flag zurückgesetzt:', error.message);
                
                // Cleanup Tracker auch bei Fehlern
                setTimeout(() => {
                    if (global.mvpVoteTracker) {
                        global.mvpVoteTracker.delete(interactionKey);
                    }
                }, 5 * 60 * 1000);
                // Sende Fehlermeldung an den User
                try {
                    if (!interaction.replied && !interaction.deferred) {
                        await interaction.reply({ content: '❌ Fehler beim Erstellen der Abstimmung!', flags: [MessageFlags.Ephemeral] });
                    } else {
                        await interaction.editReply({ content: '❌ Fehler beim Erstellen der Abstimmung!' });
                    }
                } catch (sendError) {
                    console.log('MVP Vote Fehler - Interaction bereits bearbeitet, überspringe Fehlermeldung');
                }
            }
        }
        
        if (interaction.commandName === 'mvp_cleanup') {
            try {
                // Berechtigungsprüfung: Nur Admins
                const member = await interaction.guild.members.fetch(interaction.user.id);
                const hasPermission = await hasAdminPermissions(member);
                
                if (!hasPermission) {
                    await interaction.reply({ content: '❌ Du hast keine Berechtigung, diesen Befehl zu verwenden.', flags: [MessageFlags.Ephemeral] });
                    return;
                }
                
                await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
                
                const cleanedCount = await cleanupMVPVotes();
                
                if (cleanedCount > 0) {
                    await interaction.editReply({ content: `✅ MVP-Vote Cleanup abgeschlossen! ${cleanedCount} gelöschte Votes wurden aus der Datenbank entfernt.` });
                } else {
                    await interaction.editReply({ content: '✅ MVP-Vote Cleanup abgeschlossen! Keine Votes zu bereinigen gefunden.' });
                }
                
            } catch (error) {
                console.error('Fehler beim MVP-Vote Cleanup Command:', error);
                try {
                    await interaction.editReply({ content: '❌ Fehler beim Bereinigen der MVP-Votes!' });
                } catch (editError) {
                    // Silent error handling
                }
            }
        }
        
        // /verwarnung Command
        if (interaction.commandName === 'verwarnung') {
            try {
                // Berechtigungsprüfung: Nur Admins
                const member = await interaction.guild.members.fetch(interaction.user.id);
                const hasPermission = await hasAdminPermissions(member);
                
                if (!hasPermission) {
                    await interaction.reply({ content: '❌ Du hast keine Berechtigung, diesen Befehl zu verwenden.', flags: [MessageFlags.Ephemeral] });
                    return;
                }
                
                const spielerInput = interaction.options.getString('spieler');
                const grund = interaction.options.getString('grund');
                
                // Hole die Rollen-ID für Valorant Main
                const valorantMainRoleId = '1398810174873010289';
                
                // Finde den Spieler basierend auf Input
                const guildMember = await findUserByInput(interaction.guild, spielerInput);
                
                if (!guildMember) {
                    await interaction.reply({ 
                        content: `❌ Spieler "${spielerInput}" wurde nicht gefunden. Versuche es mit dem vollständigen Namen oder @mention.`, 
                        flags: [MessageFlags.Ephemeral] 
                    });
                    return;
                }
                
                // Prüfe ob der Spieler die Valorant Main Rolle hat
                const hasValorantRole = guildMember.roles.cache.has(valorantMainRoleId);
                
                if (!hasValorantRole) {
                    await interaction.reply({ 
                        content: `❌ ${guildMember.displayName} hat nicht die Valorant Main Rolle und kann daher keine Verwarnung erhalten.`, 
                        flags: [MessageFlags.Ephemeral] 
                    });
                    return;
                }
                
                const spieler = guildMember.user;
                
                // Initialisiere Verwarnungen für Spieler falls nicht vorhanden
                if (!global.warnings[spieler.id]) {
                    global.warnings[spieler.id] = {
                        username: spieler.username,
                        displayName: guildMember.displayName,
                        warnings: []
                    };
                }
                
                // Füge Verwarnung hinzu
                const warningEntry = {
                    grund: grund,
                    timestamp: new Date().toISOString(),
                    issuedBy: interaction.user.id,
                    issuedByName: interaction.user.username
                };
                
                global.warnings[spieler.id].warnings.push(warningEntry);
                global.warnings[spieler.id].username = spieler.username;
                global.warnings[spieler.id].displayName = guildMember.displayName;
                
                saveWarnings();
                
                // Erstelle Embed für die Bestätigung
                const confirmEmbed = new EmbedBuilder()
                    .setColor('#DC143C')
                    .setTitle('⚠️ Verwarnung erteilt ⚠️')
                    .setDescription(`**${guildMember.displayName}** wurde verwarnt!`)
                    .addFields(
                        { name: '👤 Spieler', value: `<@${spieler.id}>`, inline: true },
                        { name: '📝 Verwarnungen gesamt', value: `${global.warnings[spieler.id].warnings.length}`, inline: true },
                        { name: '📋 Grund', value: grund }
                    )
                    .setTimestamp();
                
                await interaction.reply({ embeds: [confirmEmbed], flags: [MessageFlags.Ephemeral] });
                
            } catch (error) {
                console.error('Fehler beim Verwarnung Command:', error);
                try {
                    if (!interaction.replied && !interaction.deferred) {
                        await interaction.reply({ content: '❌ Fehler beim Erteilen der Verwarnung!', flags: [MessageFlags.Ephemeral] });
                    } else {
                        await interaction.editReply({ content: '❌ Fehler beim Erteilen der Verwarnung!' });
                    }
                } catch (editError) {
                    // Silent error handling
                }
            }
        }
        
        // /bewerbung Command - Neues Bewerbungssystem mit Team-Auswahl
        if (interaction.commandName === 'bewerbung') {
            try {
                await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
                
                const teamChoice = interaction.options.getString('team');
                const userId = interaction.user.id;
                
                // Initialisiere Bewerbungsdaten für diesen User
                bewerbungen[userId] = {
                    channelId: interaction.channel.id,
                    team: teamChoice, // Speichere das gewählte Team
                    ign: null,
                    realName: null,
                    trackerLink: null,
                    alter: null,
                    rang: null,
                    agents: null,
                    erfahrung: null,
                    verfuegbarkeit: null,
                    motivation: null,
                    teamwahl: { [teamChoice]: true }, // Automatisch das gewählte Team setzen
                    staerken: null,
                    schwaechen: null,
                    arbeiten: null,
                    zusaetzlicheInfos: null
                };
                
                // Sende Bewerbungsvorschau-Nachricht
                const embed = getBewerbungsvorschauEmbed(userId);
                const buttons = getBewerbungsButtons(userId);
                
                const message = await interaction.channel.send({ 
                    embeds: [embed], 
                    components: buttons 
                });
                
                // Speichere Message-ID für Updates
                bewerbungsvorschauMessages[userId] = {
                    messageId: message.id,
                    channelId: interaction.channel.id
                };
                
                await interaction.editReply({ 
                    content: `✅ Bewerbung für **${getTeamName(teamChoice)}** gestartet! Fülle nun alle Felder aus.` 
                });
            } catch (error) {
                console.error('[Bewerbung] Fehler beim /bewerbung Command:', error);
                try {
                    await interaction.editReply({ 
                        content: '❌ Fehler beim Starten der Bewerbung.' 
                    });
                } catch (e) {
                    // Silent error handling
                }
            }
            return;
        }
        
        // /test Command - Testet das Bewerbungssystem
        if (interaction.commandName === 'test') {
            try {
                await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
                
                const channel = interaction.channel;
                const userId = interaction.user.id;
                
                // Sende Bewerbungsnachricht im aktuellen Channel
                const success = await sendBewerbungsNachricht(channel, userId);
                
                if (success) {
                    await interaction.editReply({ 
                        content: '✅ Bewerbungsnachricht wurde erfolgreich im Channel gesendet!' 
                    });
                } else {
                    await interaction.editReply({ 
                        content: '❌ Fehler beim Senden der Bewerbungsnachricht.' 
                    });
                }
            } catch (error) {
                console.error('[Bewerbung] Fehler beim /test Command:', error);
                try {
                    await interaction.editReply({ 
                        content: '❌ Fehler beim Ausführen des Test-Commands.' 
                    });
                } catch (e) {
                    // Silent error handling
                }
            }
            return;
        }
        
        // /show-verwarnung Command
        if (interaction.commandName === 'show-verwarnung') {
            try {
                // Rollenprüfung: Nur Valorant Main
                const valorantMainRoleId = '1398810174873010289';
                
                const member = await interaction.guild.members.fetch(interaction.user.id);
                const hasValorantRole = member.roles.cache.has(valorantMainRoleId);
                
                if (!hasValorantRole) {
                    await interaction.reply({ 
                        content: '❌ Du benötigst die Valorant Main Rolle, um auf das Verwarnungs-System zuzugreifen.', 
                        flags: [MessageFlags.Ephemeral] 
                    });
                    return;
                }
                
                // Hole die aktuelle ngrok-URL dynamisch
                let webUrl = process.env.WEB_URL || 'http://localhost:3000';
                try {
                    const currentUrl = await getCurrentNgrokUrl();
                    webUrl = currentUrl;
                    process.env.WEB_URL = currentUrl; // Update für zukünftige Verwendung
                } catch (ngrokError) {
                    // Falls ngrok nicht erreichbar, nutze gespeicherte URL oder localhost
                    console.log('ngrok URL konnte nicht abgerufen werden, nutze gespeicherte URL');
                }
                
            // Direkt Link zur Team-Übersicht
            await interaction.reply({ 
                content: `⚠️ **Verwarnungs-System** ⚠️\n\nHier kannst du alle Verwarnungen des Main Teams einsehen.\nKlicke auf einen Spieler für detaillierte Informationen.\n\n👥 [→ Team-Übersicht öffnen](${webUrl}/warnings.html)`, 
                flags: [MessageFlags.Ephemeral] 
            });
                
            } catch (error) {
                console.error('Fehler beim Show-Verwarnung Command:', error);
                try {
                    if (!interaction.replied && !interaction.deferred) {
                        await interaction.reply({ 
                            content: '❌ Fehler beim Abrufen der Links!', 
                            flags: [MessageFlags.Ephemeral] 
                        });
                    }
                } catch (editError) {
                    // Silent error handling
                }
            }
        }
    }
    
    } catch (error) {
        // GLOBALE FEHLERBEHANDLUNG - Verhindert Bot-Abstürze
        console.error('Fehler im InteractionCreate Handler:', error);
        
        // Versuche trotzdem eine Antwort zu senden, falls möglich
        try {
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({ 
                    content: '❌ Ein Fehler ist aufgetreten. Bitte versuche es erneut.', 
                    flags: [MessageFlags.Ephemeral] 
                });
            } else if (interaction.replied || interaction.deferred) {
                await interaction.editReply({ 
                    content: '❌ Ein Fehler ist aufgetreten. Bitte versuche es erneut.' 
                });
            }
        } catch (replyError) {
            console.error('Fehler beim Senden der Fehlermeldung:', replyError);
        }
    }
});

// MVP-Vote Cleanup beim Bot-Start
setTimeout(async () => {
    try {
        console.log('Starte MVP-Vote Cleanup beim Bot-Start...');
        const cleanedCount = await cleanupMVPVotes();
        if (cleanedCount > 0) {
            console.log(`MVP-Vote Cleanup beim Start: ${cleanedCount} Votes bereinigt`);
        } else {
            console.log('MVP-Vote Cleanup beim Start: Keine Votes zu bereinigen');
        }
    } catch (error) {
        console.error('Fehler beim MVP-Vote Cleanup beim Start:', error);
    }
}, 10000); // 10 Sekunden nach Bot-Start

// Event Handler für das Löschen von Nachrichten - automatisches Backup-Update
client.on(Events.MessageDelete, async (message) => {
    try {
        const messageId = message.id;
        let messageType = '';
        let boardDeleted = false;
        
        // Prüfe in allen Board-States, ob diese Nachricht existiert
        
        // Premier Boards (Message-ID-basiert)
        if (premierBoards[messageId]) {
            delete premierBoards[messageId];
            delete premierSignups[messageId];
            messageType = 'premier';
            boardDeleted = true;
        }
        
        // Practice Boards (Message-ID-basiert)
        if (!boardDeleted && practiceBoards[messageId]) {
            delete practiceBoards[messageId];
            delete practiceSignups[messageId];
            messageType = 'practice';
            boardDeleted = true;
        }
        
        // Tournament Boards (Message-ID-basiert)
        if (!boardDeleted && tournamentBoards[messageId]) {
            delete tournamentBoards[messageId];
            delete tournamentSignups[messageId];
            messageType = 'tournament';
            boardDeleted = true;
        }
        
        // Scrim Boards
        if (!boardDeleted && scrimBoards[messageId]) {
            delete scrimBoards[messageId];
            delete scrimSignups[messageId];
            messageType = 'scrim';
            boardDeleted = true;
        }
        
        // Wochen-Scrim Data (kann zusammen mit scrimBoards existieren)
        if (wochenScrimData[messageId]) {
            delete wochenScrimData[messageId];
            if (!boardDeleted) {
                messageType = 'wochen-scrim';
                boardDeleted = true;
            }
        }
        
        // Backup aktualisieren falls eine Board-Nachricht gelöscht wurde
        if (boardDeleted) {
            saveSignupBackup();
            console.log(`${messageType}-Nachricht ${messageId} wurde gelöscht - Board-State und Backup aktualisiert`);
        }
    } catch (error) {
        console.error('Fehler beim Verarbeiten der gelöschten Nachricht:', error);
    }
});

// Globales Error-Handling für unbehandelte Promise Rejections
process.on('unhandledRejection', (reason, promise) => {
    // Unterdrücke bekannte Discord 10062 Fehler
    if (reason && reason.code === 10062) {
        console.log('Unterdrücke bekannten 10062 Fehler');
        return;
    }
    console.error('Error:', reason);
});

// Globales Error-Handling für uncaught exceptions  
process.on('uncaughtException', (error) => {
    // Unterdrücke bekannte Discord 10062 Fehler
    if (error && error.code === 10062) {
        console.log('Unterdrücke bekannten 10062 Fehler');
        return;
    }
    console.error('Error:', error);
    process.exit(1);
});

// ==================== EXPRESS WEB-SERVER FÜR VERWARNUNGEN ====================

const app = express();
app.use(cors());
app.use(express.json());

// Serve static files aus dem public Ordner
app.use(express.static('public'));

// API Endpoint: Hole alle Verwarnungen für Team-Übersicht
app.get('/api/warnings', async (req, res) => {
    try {
        const valorantMainRoleId = '1398810174873010289';
        const allPlayersData = [];
        let totalValorantMainMembers = 0;
        
        // Hole alle Mitglieder mit Valorant Main Rolle
        try {
            const guilds = client.guilds.cache;
            
            for (const guild of guilds.values()) {
                // Verwende bereits gecachte Members statt neu zu fetchen
                const role = guild.roles.cache.get(valorantMainRoleId);
                if (role) {
                    totalValorantMainMembers = role.members.size;
                    
                    // Erstelle Liste mit allen Valorant Main Mitgliedern
                    role.members.forEach(member => {
                        const userId = member.user.id;
                        const warningData = global.warnings[userId];
                        
                        allPlayersData.push({
                            userId: userId,
                            username: member.user.username,
                            displayName: member.displayName,
                            warningCount: warningData ? warningData.warnings.length : 0
                        });
                    });
                    break;
                }
            }
        } catch (error) {
            console.error('Fehler beim Laden der Valorant Main Mitglieder:', error);
        }
        
        // Sortiere nach Anzahl der Verwarnungen (absteigend), dann alphabetisch
        allPlayersData.sort((a, b) => {
            if (b.warningCount !== a.warningCount) {
                return b.warningCount - a.warningCount;
            }
            return a.displayName.localeCompare(b.displayName);
        });
        
        res.json({
            success: true,
            data: allPlayersData,
            totalValorantMainMembers: totalValorantMainMembers
        });
    } catch (error) {
        console.error('Fehler beim Abrufen der Verwarnungen:', error);
        res.status(500).json({
            success: false,
            error: 'Fehler beim Abrufen der Verwarnungen'
        });
    }
});

// API Endpoint: Hole detaillierte Verwarnungen für einen bestimmten Spieler
app.get('/api/warnings/:userId', async (req, res) => {
    try {
        const userId = req.params.userId;
        const userData = global.warnings[userId];
        
        if (!userData) {
            return res.status(404).json({
                success: false,
                error: 'Spieler nicht gefunden'
            });
        }
        
        res.json({
            success: true,
            data: {
                userId: userId,
                username: userData.username,
                displayName: userData.displayName,
                warnings: userData.warnings
            }
        });
    } catch (error) {
        console.error('Fehler beim Abrufen der Spieler-Verwarnungen:', error);
        res.status(500).json({
            success: false,
            error: 'Fehler beim Abrufen der Spieler-Verwarnungen'
        });
    }
});

// Globale Variable für ngrok-Prozess
let ngrokProcess = null;

// Funktion zum Beenden aller ngrok-Prozesse
function killAllNgrok() {
    return new Promise((resolve) => {
        const { exec } = require('child_process');
        exec('taskkill /F /IM ngrok.exe', (error) => {
            // Ignoriere Fehler (ngrok läuft möglicherweise nicht)
            setTimeout(resolve, 500); // Warte kurz bis Prozess beendet ist
        });
    });
}

// Funktion zum Abrufen der aktuellen ngrok-URL
function getCurrentNgrokUrl() {
    return new Promise((resolve, reject) => {
        http.get('http://127.0.0.1:4040/api/tunnels', (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    const tunnels = JSON.parse(data);
                    if (tunnels.tunnels && tunnels.tunnels.length > 0) {
                        const publicUrl = tunnels.tunnels[0].public_url;
                        resolve(publicUrl);
                    } else {
                        reject(new Error('Keine ngrok Tunnel gefunden'));
                    }
                } catch (error) {
                    reject(error);
                }
            });
        }).on('error', (error) => {
            reject(error);
        });
    });
}

// Funktion zum Starten von ngrok
function startNgrok(port) {
    return new Promise((resolve, reject) => {
        console.log('🚀 Starte ngrok...');
        
        // Prüfe zuerst, ob ngrok bereits läuft
        http.get('http://127.0.0.1:4040/api/tunnels', (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    const tunnels = JSON.parse(data);
                    if (tunnels.tunnels && tunnels.tunnels.length > 0) {
                        const tunnel = tunnels.tunnels[0];
                        const tunnelAddr = tunnel.config?.addr || '';
                        const expectedAddr = `http://localhost:${port}`;
                        
                        // Prüfe ob der Tunnel auf den richtigen Port zeigt
                        if (tunnelAddr === expectedAddr || tunnelAddr === `http://127.0.0.1:${port}`) {
                            const publicUrl = tunnel.public_url;
                            process.env.WEB_URL = publicUrl;
                            console.log(`✅ ngrok läuft bereits auf Port ${port}!`);
                            console.log(`🌐 Öffentliche URL: ${publicUrl}`);
                            console.log(`📊 Verwarnungen: ${publicUrl}/warnings.html`);
                            resolve(publicUrl);
                        } else {
                            console.log(`⚠️ ngrok läuft, aber auf falschem Port (${tunnelAddr} statt ${expectedAddr})`);
                            console.log(`🔄 Beende ngrok und starte neu mit Port ${port}...`);
                            // Beende alle ngrok-Prozesse
                            killAllNgrok().then(() => {
                                startNewNgrok(port, resolve, reject);
                            });
                        }
                    } else {
                        // ngrok läuft, aber kein Tunnel - starte neuen
                        startNewNgrok(port, resolve, reject);
                    }
                } catch (error) {
                    // ngrok API nicht erreichbar - starte neuen
                    startNewNgrok(port, resolve, reject);
                }
            });
        }).on('error', () => {
            // ngrok läuft nicht - starte neuen
            startNewNgrok(port, resolve, reject);
        });
    });
}

// Funktion zum Starten eines neuen ngrok-Prozesses
function startNewNgrok(port, resolve, reject) {
    ngrokProcess = spawn('ngrok', ['http', port.toString()], {
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: true
    });
    
    ngrokProcess.on('error', (error) => {
        console.error('❌ ngrok konnte nicht gestartet werden:', error.message);
        console.error('💡 Bitte installiere ngrok: https://ngrok.com/');
        console.error('💡 Oder starte ngrok manuell: ngrok http ' + port);
        reject(error);
    });
    
    // Warte kurz und hole dann die URL von der ngrok API
    setTimeout(() => {
        http.get('http://127.0.0.1:4040/api/tunnels', (res) => {
            let data = '';
            
            res.on('data', (chunk) => {
                data += chunk;
            });
            
            res.on('end', () => {
                try {
                    const tunnels = JSON.parse(data);
                    if (tunnels.tunnels && tunnels.tunnels.length > 0) {
                        const publicUrl = tunnels.tunnels[0].public_url;
                        process.env.WEB_URL = publicUrl;
                        console.log(`✅ ngrok gestartet!`);
                        console.log(`🌐 Öffentliche URL: ${publicUrl}`);
                        console.log(`📊 Verwarnungen: ${publicUrl}/warnings.html`);
                        resolve(publicUrl);
                    } else {
                        console.warn('⚠️ ngrok läuft, aber keine Tunnel gefunden');
                        reject(new Error('Keine ngrok Tunnel gefunden'));
                    }
                } catch (error) {
                    console.error('❌ Fehler beim Abrufen der ngrok URL:', error.message);
                    reject(error);
                }
            });
        }).on('error', (error) => {
            console.error('❌ Fehler beim Verbinden zur ngrok API:', error.message);
            console.log('💡 Stelle sicher, dass ngrok läuft: ngrok http ' + port);
            reject(error);
        });
    }, 2000); // Warte 2 Sekunden bis ngrok bereit ist
}

// Cleanup beim Beenden
process.on('SIGINT', () => {
    console.log('\n🛑 Beende Bot...');
    if (ngrokProcess) {
        ngrokProcess.kill();
        console.log('✅ ngrok beendet');
    }
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\n🛑 Beende Bot...');
    if (ngrokProcess) {
        ngrokProcess.kill();
        console.log('✅ ngrok beendet');
    }
    process.exit(0);
});

// Starte Express Server
const PORT = process.env.WEB_PORT || 3000;
const server = app.listen(PORT, async () => {
    console.log(`🌐 Web-Interface läuft auf Port ${PORT}`);
    console.log(`📊 Verwarnungen Team-Übersicht: http://localhost:${PORT}/warnings.html`);
    console.log(`👤 Verwarnungen Spieler-Details: http://localhost:${PORT}/player.html`);
    
    // Starte ngrok automatisch, wenn WEB_URL nicht gesetzt ist
    if (!process.env.WEB_URL || process.env.WEB_URL.includes('localhost')) {
        try {
            await startNgrok(PORT);
        } catch (error) {
            console.log('\n⚠️ ngrok konnte nicht automatisch gestartet werden.');
            console.log('💡 Starte ngrok manuell: ngrok http ' + PORT);
            console.log('💡 Dann setze WEB_URL in deiner .env Datei\n');
        }
    } else {
        console.log(`✅ Öffentliche URL bereits gesetzt: ${process.env.WEB_URL}`);
    }
});

// Fehlerbehandlung für Port bereits belegt
server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
        console.log(`\n⚠️ Port ${PORT} ist bereits belegt. Web-Interface wird nicht gestartet.`);
        console.log(`💡 Der Discord-Bot läuft trotzdem weiter.`);
        console.log(`💡 Um das Web-Interface zu nutzen, beende den anderen Prozess auf Port ${PORT} oder ändere WEB_PORT in der .env\n`);
    } else {
        console.error('❌ Fehler beim Starten des Web-Servers:', error);
    }
});

client.login(process.env.DISCORD_TOKEN); 