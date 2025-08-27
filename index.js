require('dotenv').config();
const { Client, GatewayIntentBits, Partials, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, Events, SlashCommandBuilder, Collection, MessageFlags } = require('discord.js');
const cron = require('node-cron');
const fs = require('fs');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMembers
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

const CHANNEL_ID = '1379889858264432670';
const MAX_USERS = 5;

// Super-Admin Konfiguration aus .env laden
const SUPER_ADMIN_ID = process.env.SUPER_ADMIN_ID;

// Hilfsfunktion: Prüft ob ein User Super-Admin ist
function isSuperAdmin(userId) {
    return userId === SUPER_ADMIN_ID;
}

// Hilfsfunktion: Prüft ob ein User Admin-Berechtigungen hat (entweder Discord-Admin oder Super-Admin)
async function hasAdminPermissions(member) {
    const isDiscordAdmin = member.permissions.has('Administrator');
    const isSuperAdminUser = isSuperAdmin(member.user.id);
    
    // Log für Super-Admin-Status (nur für Debugging)
    if (isSuperAdminUser) {
        console.log(`Super-Admin erkannt: ${member.user.username} (${member.user.id})`);
    }
    
    return isDiscordAdmin || isSuperAdminUser;
}

// Konstanten für die Tage (aus dem TypeScript Code übernommen)
const DAYS = ['Donnerstag', 'Samstag', 'Sonntag'];
const PRACTICE_DAYS = ['Mittwoch', 'Freitag'];

// Dynamische Konfiguration für Premier, Practice und Scrim
let premierConfig = {
    days: ['Donnerstag', 'Samstag', 'Sonntag'],
    times: ['19:00', '20:00', '19:00']
};

let practiceConfig = {
    days: ['Mittwoch', 'Freitag'],
    times: ['19:00', '19:00']
};

let scrimConfig = {
    day: 'Montag',
    time: '19:00',
    maxGames: 3
};

// Dynamische Anmeldungen - werden dynamisch initialisiert
let signups = {};
let practiceSignups = {};
let scrimSignups = []; // Wird zu einem Objekt mit Game1 und Game2 geändert

// --- DM-Status-Objekte für State-Tracking ---
let practiceDMStatus = {};
let premierDMStatus = {};
let scrimDMStatus = { state: 'waiting', lastReminder: 0, lastFound: 0, lastCancel: 0, pendingFound: false, pendingCancel: false, foundTimeout: null, cancelTimeout: null };

// Board States (Multi-Channel)
let premierBoards = {};
let practiceBoards = {};
let scrimBoards = {};
let practiceMessageId = null;
let practiceChannelId = null;
let practiceNextMessageId = null;

// Username-Cache für schnelle Anzeige
const userCache = {};

// Opt-out-Set für User, die keine DMs mehr wollen
const dmOptOut = new Set();

// Abwesenheiten-System
let abwesenheiten = [];

// Hilfsfunktion: Gibt die aktuelle deutsche Zeit zurück
function getGermanTime() {
    return new Date().toLocaleString("en-US", {timeZone: "Europe/Berlin"});
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
    const germanTime = getGermanTime();
    return new Date(germanTime);
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

// Hilfsfunktion: Initialisiert dynamische Anmeldungen basierend auf Konfiguration
function initializeDynamicSignups() {
    // Premier Signups initialisieren
    signups = {};
    premierDMStatus = {};
    for (let i = 0; i < premierConfig.days.length; i++) {
        const day = premierConfig.days[i];
        signups[day] = [];
        premierDMStatus[day] = { 
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
    
    // Practice Signups initialisieren
    practiceSignups = {};
    practiceDMStatus = {};
    for (let i = 0; i < practiceConfig.days.length; i++) {
        const day = practiceConfig.days[i];
        practiceSignups[day] = [];
        practiceDMStatus[day] = { 
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

// Hilfsfunktion: Gibt Montag und Sonntag einer Woche zurück
function getWeekRange(date) {
    const dayOfWeek = date.getDay();
    const monday = new Date(date);
    monday.setDate(date.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1));
    
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    
    return { monday, sunday };
}

// Funktion zum Bereinigen abgelaufener Scrim-Nachrichten
async function cleanupExpiredScrimMessages() {
    const now = Date.now();
    const expiredChannels = [];
    
    for (const [channelId, board] of Object.entries(scrimBoards)) {
        if (board.expiryDate && board.expiryDate <= now) {
            expiredChannels.push(channelId);
        }
    }
    
    for (const channelId of expiredChannels) {
        await deleteScrimMessage(channelId);
    }
    
    if (expiredChannels.length > 0) {
        console.log(`${expiredChannels.length} abgelaufene Scrim-Nachrichten wurden beim Start gelöscht`);
    }
}

// Hilfsfunktion: Validiert und bereinigt die Anmeldungsdaten
function validateSignupData() {
    for (const day of DAYS) {
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
function clearPastSignups() {
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
    
    // Backup nach dem Leeren speichern
    saveSignupBackup();
}

// Hilfsfunktion: Manueller Trigger zum Leeren vergangener Anmeldungen
function manualClearPastSignups() {
    console.log('Manuelles Leeren vergangener Anmeldungen...');
    clearPastSignups();
    console.log('Manuelles Leeren abgeschlossen.');
}

// Hilfsfunktion: Findet User-ID anhand Username oder Mention
async function findUserIdByUsername(client, username, interaction) {
    // Wenn Username eine Mention ist (<@1234567890> oder <@!1234567890>)
    const mentionMatch = username.match(/^<@!?(\d+)>$/);
    if (mentionMatch) {
        return mentionMatch[1];
    }
    try {
        // Suche in der aktuellen Guild, falls Interaction übergeben
        if (interaction && interaction.guild) {
            const member = interaction.guild.members.cache.find(m => 
                m.user.username.toLowerCase() === username.toLowerCase() ||
                m.displayName.toLowerCase() === username.toLowerCase()
            );
            if (member) return member.user.id;
        }
        // Fallback: Suche in allen Guilds
        for (const guild of client.guilds.cache.values()) {
            const member = guild.members.cache.find(m => 
                m.user.username.toLowerCase() === username.toLowerCase() ||
                m.displayName.toLowerCase() === username.toLowerCase()
            );
            if (member) return member.user.id;
        }
        return null;
    } catch (error) {
        console.error('Fehler beim Suchen des Users:', error);
        return null;
    }
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
async function getSignupEmbed(client, viewerId = null) {
    // Erstelle Beschreibung mit Zeiten
    let description = 'Anmeldung Premier Spieltage! Maximal 5 Leute sind möglich pro Tag.\n';
    
    // Sortiere Tage nach Wochentag
    const sortedDays = sortDaysByWeekday([...premierConfig.days]);
    
    // Füge Zeiten zur Beschreibung hinzu
    let timesText = '';
    sortedDays.forEach((day, index) => {
        const timeIndex = premierConfig.days.indexOf(day);
        const time = timeIndex >= 0 && premierConfig.times[timeIndex] ? premierConfig.times[timeIndex] : '19:00';
        timesText += `${day}: ${time} Uhr `;
    });
    
    description += timesText;
    
    const embed = new EmbedBuilder()
        .setTitle('Premier Anmeldung')
        .setDescription(description)
        .setColor(0x00AE86);
    
    const fields = await Promise.all(sortedDays.map(async (day, index) => {
        const today = getGermanDate();
        const dayIndex = getDayIndex(day);
        const currentDayIndex = today.getDay();
        let daysUntilNext = dayIndex - currentDayIndex;
        if (daysUntilNext < 0) daysUntilNext += 7;
        const targetDate = new Date(today);
        targetDate.setDate(today.getDate() + daysUntilNext);
        const dayWithDate = getDayWithDate(day, targetDate);
        
        // Sortiere: Eigener Eintrag (viewerId) immer oben
        let ids = [...(signups[day] || [])];
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
    DAYS.forEach(day => {
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
function getButtonRow(userId) {
    const sortedDays = sortDaysByWeekday([...premierConfig.days]);
    
    const addButtons = sortedDays.map(day =>
        new ButtonBuilder()
            .setCustomId(`signup_${day}`)
            .setLabel(`${day} +`)
            .setStyle(ButtonStyle.Success)
            .setDisabled(false)
    );
    const removeButtons = sortedDays.map(day =>
        new ButtonBuilder()
            .setCustomId(`unsign_${day}`)
            .setLabel(`${day} -`)
            .setStyle(ButtonStyle.Danger)
            .setDisabled(false)
    );
    return [
        new ActionRowBuilder().addComponents(...addButtons),
        new ActionRowBuilder().addComponents(...removeButtons),
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('refresh_board')
                .setLabel('Aktualisieren')
                .setEmoji('🔄')
                .setStyle(ButtonStyle.Secondary)
        )
    ];
}

// Hilfsfunktion: Gibt eine User-ID zurück, die im Board eingetragen ist, oder null
function getFirstSignedUpUserId() {
    const sortedDays = sortDaysByWeekday([...premierConfig.days]);
    for (const day of sortedDays) {
        if (signups[day] && signups[day].length > 0) {
            return signups[day][0];
        }
    }
    return null;
}

// Refresh-Button ActionRow
function getRefreshButtonRow() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('refresh_board')
            .setLabel('Aktualisieren')
            .setEmoji('🔄')
            .setStyle(ButtonStyle.Secondary)
    );
}

// Hilfsfunktion: Überprüft ob eine Nachricht noch existiert und funktioniert
async function isMessageValid(channelId, messageId) {
    try {
        const channel = await client.channels.fetch(channelId);
        const msg = await channel.messages.fetch(messageId);
        // Prüfe ob die Nachricht älter als 7 Tage ist
        const messageAge = Date.now() - msg.createdTimestamp;
        const sevenDaysInMs = 7 * 24 * 60 * 60 * 1000;
        return messageAge < sevenDaysInMs;
    } catch (error) {
        console.log('Nachricht nicht mehr verfügbar oder zu alt:', error.message);
        return false;
    }
}

// Hilfsfunktion: Überprüft ob alle Anmeldungen korrekt sind
function verifySignupIntegrity() {
    let totalSignups = 0;
    
    // Dynamisch basierend auf konfigurierten Tagen
    for (const day of premierConfig.days) {
        if (Array.isArray(signups[day])) {
            totalSignups += signups[day].length;
        }
    }
    
    console.log(`Anmeldungen-Integrität: ${totalSignups} Spieler`);
    
    // Prüfe auf Duplikate
    for (const day of premierConfig.days) {
        if (Array.isArray(signups[day])) {
            const uniqueSignups = new Set(signups[day]);
            
            if (uniqueSignups.size !== signups[day].length) {
                console.warn(`Duplikate in ${day} gefunden!`);
                signups[day] = [...uniqueSignups];
            }
        }
    }
}

// Hilfsfunktion: Speichert Anmeldungen in eine Backup-Datei
function saveSignupBackup() {
    try {
        const backupData = {
            signups: signups,
            practiceSignups: practiceSignups,
            scrimSignups: scrimSignups,
            abwesenheiten: abwesenheiten,
            // Konfigurationen speichern
            premierConfig: premierConfig,
            practiceConfig: practiceConfig,
            scrimConfig: scrimConfig,
            timestamp: getGermanDate().toISOString()
        };
        fs.writeFileSync('premier_backup.json', JSON.stringify(backupData, null, 2));
    } catch (error) {
        console.error('Fehler beim Speichern des Backups:', error);
    }
}

// Hilfsfunktion: Lädt Anmeldungen aus einer Backup-Datei
async function loadSignupBackup() {
    try {
        if (fs.existsSync('premier_backup.json')) {
            const backupData = JSON.parse(fs.readFileSync('premier_backup.json', 'utf8'));
            
            // Konfigurationen laden
            premierConfig = backupData.premierConfig || premierConfig;
            practiceConfig = backupData.practiceConfig || practiceConfig;
            scrimConfig = backupData.scrimConfig || scrimConfig;
            
            // Anmeldungen laden
            signups = backupData.signups || {};
            practiceSignups = backupData.practiceSignups || {};
            scrimSignups = backupData.scrimSignups || { game1: [], game2: [] };
            abwesenheiten = backupData.abwesenheiten || abwesenheiten;
            
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
    for (const day of premierConfig.days) {
        if (!Array.isArray(signups[day])) signups[day] = [];
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

// Hilfsfunktion: Erstellt eine neue Nachricht wenn die alte nicht mehr funktioniert
async function recreatePremierMessageIfNeeded() {
    const channelId = interaction.channel.id;
    if (!premierBoards[channelId]?.messageId || !premierBoards[channelId]?.channelId) return;
    
    const isValid = await isMessageValid(premierBoards[channelId]?.channelId, premierBoards[channelId]?.messageId);
    if (!isValid) {
        console.log('Premier-Nachricht ist nicht mehr gültig, erstelle neue...');
        try {
            // Sichere die aktuellen Anmeldungen vor dem Neuerstellen
            const currentSignups = JSON.parse(JSON.stringify(signups));
            
            console.log('Aktuelle Anmeldungen werden übernommen:');
            console.log('Anmeldungen:', currentSignups);
            
            const channel = await client.channels.fetch(premierBoards[channelId]?.channelId);
            await postPremierSignupWithDelete(channel);
            
            // Stelle sicher, dass die Anmeldungen erhalten bleiben
            signups = currentSignups;
            
            // Validiere die übernommenen Daten
            validateSignupData();
            
            // Überprüfe die Integrität der Anmeldungen
            verifySignupIntegrity();
            
            // Erstelle ein Backup der Anmeldungen
            saveSignupBackup();
            
            console.log('Neue Premier-Nachricht erstellt - alle Anmeldungen übernommen');
        } catch (error) {
            console.error('Fehler beim Erstellen der neuen Nachricht:', error);
        }
    }
}

// Command-Registrierung (jetzt /create, /clear, /premier, /dm mit Auswahloption und /cc für Admins)
client.once(Events.ClientReady, async () => {
    console.log(`Bot online als ${client.user.tag}`);
    
    // Initialisiere dynamische Strukturen
    initializeDynamicSignups();
    
    // Versuche Backup zu laden beim Start
    if (await loadSignupBackup()) {
        console.log('Anmeldungen aus Backup wiederhergestellt');
        ensureAllDays();
        verifySignupIntegrity();
        
        // Lösche abgelaufene Scrim-Nachrichten beim Start
        await cleanupExpiredScrimMessages();
        // DEBUG: Zeige geladene Backup-Daten
        console.log('DEBUG: signups nach Backup-Laden:', JSON.stringify(signups, null, 2));
        console.log('DEBUG: practiceSignups nach Backup-Laden:', JSON.stringify(practiceSignups, null, 2));
        
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
        
        // Lösche abgelaufene Scrim-Nachrichten beim Start
        await cleanupExpiredScrimMessages();
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
    const data = [
        new SlashCommandBuilder()
            .setName('premier')
            .setDescription('Erstellt sofort eine Premier-Anmeldung')
            .toJSON(),
        new SlashCommandBuilder()
            .setName('premier-config')
            .setDescription('Konfiguriert die Premier-Tage und Zeiten')
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
                    .setRequired(true)
                    .addChoices(...getDayChoices()))
            .addStringOption(option =>
                option.setName('daytime_2')
                    .setDescription('Zeit für zweiten Tag')
                    .setRequired(true)
                    .addChoices(...getTimeChoices()))
            .addStringOption(option =>
                option.setName('day_3')
                    .setDescription('Dritter Tag')
                    .setRequired(true)
                    .addChoices(...getDayChoices()))
                        .addStringOption(option =>
                option.setName('daytime_3')
                    .setDescription('Zeit für dritten Tag')
                    .setRequired(true)
                    .addChoices(...getTimeChoices()))
            .toJSON(),
        new SlashCommandBuilder()
            .setName('clear')
            .setDescription('Löscht die letzte Premier-Anmeldung')
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
                            .setDescription('Spieler, der hinzugefügt werden soll')
                            .setRequired(true)
                            .setAutocomplete(true))
                    
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
                            .setDescription('Spieler, der entfernt werden soll')
                            .setRequired(true)
                            .setAutocomplete(true))
                    
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
        new SlashCommandBuilder()
            .setName('backup')
            .setDescription('Erstellt sofort ein Backup der aktuellen Anmeldungen')
            .toJSON(),
        new SlashCommandBuilder()
            .setName('pastbackup')
            .setDescription('Lädt das letzte Backup und überschreibt das aktuelle Board')
            .toJSON(),
        new SlashCommandBuilder()
            .setName('practice')
            .setDescription('Erstellt sofort eine Practice-Anmeldung')
            .toJSON(),
        new SlashCommandBuilder()
            .setName('practice-config')
            .setDescription('Konfiguriert die Practice-Tage und Zeiten (nur 2 Tage)')
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
                    .setRequired(true)
                    .addChoices(...getDayChoices()))
            .addStringOption(option =>
                option.setName('daytime_2')
                    .setDescription('Zeit für zweiten Tag')
                    .setRequired(true)
                    .addChoices(...getTimeChoices()))
            .toJSON(),
        new SlashCommandBuilder()
            .setName('scrim')
            .setDescription('Erstellt eine Scrim-Anmeldung mit 1-5 Games')
            .addStringOption(option =>
                option.setName('day')
                    .setDescription('Tag für Scrim (z.B. Montag)')
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
                option.setName('daytime')
                    .setDescription('Zeit für Scrim')
                    .setRequired(true)
                    .addChoices(
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
            .toJSON(),
        new SlashCommandBuilder()
            .setName('scrim-config')
            .setDescription('Konfiguriert die Scrim-Einstellungen')
            .addStringOption(option =>
                option.setName('day')
                    .setDescription('Tag für Scrim')
                    .setRequired(true)
                    .addChoices(...getDayChoices()))
            .addStringOption(option =>
                option.setName('daytime')
                    .setDescription('Zeit für Scrim')
                    .setRequired(true)
                    .addChoices(...getTimeChoices()))
            .addIntegerOption(option =>
                option.setName('max_games')
                    .setDescription('Maximale Anzahl Spiele')
                    .setRequired(true)
                    .addChoices(...getGameChoices()))
            .toJSON(),
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
            .setName('abwesend-admin')
            .setDescription('Admin-Befehle für Abwesenheiten')
            .addSubcommand(subcommand => {
                subcommand
                    .setName('add')
                    .setDescription('Markiert einen Spieler als abwesend für einen bestimmten Zeitraum')
                    .addStringOption(option =>
                        option.setName('start')
                            .setDescription('Startdatum (DD.MM.YYYY)')
                            .setRequired(true))
                    .addStringOption(option =>
                        option.setName('end')
                            .setDescription('Enddatum (DD.MM.YYYY)')
                            .setRequired(true))
                    .addStringOption(option =>
                        option.setName('user')
                            .setDescription('Spieler, der als abwesend markiert werden soll')
                            .setRequired(true)
                            .setAutocomplete(true));
                return subcommand;
            })
            .addSubcommand(subcommand => {
                subcommand
                    .setName('delete')
                    .setDescription('Löscht Abwesenheiten eines Spielers')
                    .addStringOption(option =>
                        option.setName('type')
                            .setDescription('Was soll gelöscht werden?')
                            .setRequired(true)
                            .addChoices(
                                { name: 'Alle Abwesenheiten', value: 'all' },
                                { name: 'Letzte Abwesenheit', value: 'last' }
                            ))
                    .addStringOption(option =>
                        option.setName('user')
                            .setDescription('Spieler, dessen Abwesenheiten gelöscht werden sollen')
                            .setRequired(true)
                            .setAutocomplete(true));
                return subcommand;
            })
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

// Premier-Anmeldung posten (und alte löschen)
async function postPremierSignupWithDelete(channel) {
    const channelId = channel.id;
    if (premierBoards[channelId] && premierBoards[channelId].messageId) {
        try {
            const msg = await channel.messages.fetch(premierBoards[channelId].messageId);
            await msg.delete();
        } catch (e) {}
    }
    // viewerId ist Bot selbst, da kein User-Kontext
    const embed = await getSignupEmbed(client, client.user.id);
    const userId = getFirstSignedUpUserId() || client.user.id;
    const buttonRows = getButtonRow(userId);
    const msg = await channel.send({ embeds: [embed], components: buttonRows });
    premierBoards[channelId] = {
        messageId: msg.id,
        channelId: channelId
    };
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

// Practice-Embed
// Anpassung: Eigener Name immer oben und fett
async function getPracticeSignupEmbed(client, viewerId = null) {
    // Erstelle Beschreibung mit Zeiten
    let description = 'Anmeldung Practice! Maximal 5 Leute sind möglich pro Tag.\n';
    
    // Sortiere Tage nach Wochentag
    const sortedDays = sortDaysByWeekday([...practiceConfig.days]);
    
    // Füge Zeiten zur Beschreibung hinzu
    let timesText = '';
    sortedDays.forEach((day, index) => {
        const timeIndex = practiceConfig.days.indexOf(day);
        const time = timeIndex >= 0 && practiceConfig.times[timeIndex] ? practiceConfig.times[timeIndex] : '19:00';
        timesText += `${day}: ${time} Uhr `;
    });
    
    description += timesText;
    
    const embed = new EmbedBuilder()
        .setTitle('Practice Anmeldung')
        .setDescription(description)
        .setColor(0x00AE86);
    
    const fields = await Promise.all(sortedDays.map(async (day, index) => {
        const today = getGermanDate();
        const dayIndex = getDayIndex(day);
        const currentDayIndex = today.getDay();
        let daysUntilNext = dayIndex - currentDayIndex;
        if (daysUntilNext < 0) daysUntilNext += 7;
        const targetDate = new Date(today);
        targetDate.setDate(today.getDate() + daysUntilNext);
        const dayWithDate = getDayWithDate(day, targetDate);
        
        // Zeit aus der Konfiguration holen
        const timeIndex = practiceConfig.days.indexOf(day);
        const time = timeIndex >= 0 && practiceConfig.times[timeIndex] ? practiceConfig.times[timeIndex] : '19:00';
        
        // Sortiere: Eigener Eintrag (viewerId) immer oben
        let ids = [...(practiceSignups[day] || [])];
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
function getPracticeButtonRowsWithControls(userId) {
    const sortedDays = sortDaysByWeekday([...practiceConfig.days]);
    
    const addButtons = sortedDays.map(day =>
        new ButtonBuilder()
            .setCustomId(`practice_signup_${day}`)
            .setLabel(`${day} +`)
            .setStyle(ButtonStyle.Success)
            .setDisabled(false)
    );
    const removeButtons = sortedDays.map(day =>
        new ButtonBuilder()
            .setCustomId(`practice_unsign_${day}`)
            .setLabel(`${day} -`)
            .setStyle(ButtonStyle.Danger)
            .setDisabled(false)
    );
    return [
        new ActionRowBuilder().addComponents(...addButtons),
        new ActionRowBuilder().addComponents(...removeButtons),
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('practice_refresh_board')
                .setLabel('Aktualisieren')
                .setEmoji('🔄')
                .setStyle(ButtonStyle.Secondary)
        )
    ];
}
// Practice-Board posten
async function postPracticeSignupWithDelete(channel) {
    const channelId = channel.id;
    if (practiceBoards[channelId] && practiceBoards[channelId].messageId) {
        try {
            const msg = await channel.messages.fetch(practiceBoards[channelId].messageId);
            await msg.delete();
        } catch (e) {}
    }
    // viewerId ist Bot selbst, da kein User-Kontext
    const embed = await getPracticeSignupEmbed(client, client.user.id);
    const userId = client.user.id;
    const buttonRows = getPracticeButtonRowsWithControls(userId);
    const msg = await channel.send({ embeds: [embed], components: buttonRows });
    practiceBoards[channelId] = {
        messageId: msg.id,
        channelId: channelId
    };
}

// Scrim-Embed für 2 Games
async function getScrimSignupEmbed(client, viewerId = null) {
    const embed = new EmbedBuilder()
        .setTitle(`Anmeldung Scrim am ${scrimConfig.day} um ${scrimConfig.time} Uhr!`)
        .setColor(0x00AE86);
    
    const today = getGermanDate();
    const dayIndex = getDayIndex(scrimConfig.day);
    const currentDayIndex = today.getDay();
    let daysUntilNext = dayIndex - currentDayIndex;
    if (daysUntilNext < 0) daysUntilNext += 7;
    const targetDate = new Date(today);
    targetDate.setDate(today.getDate() + daysUntilNext);
    const dayWithDate = getDayWithDate(scrimConfig.day, targetDate);
    
    // Stelle sicher, dass scrimSignups ein Objekt mit dynamischen Games ist
    if (!scrimSignups || typeof scrimSignups !== 'object') {
        scrimSignups = { game1: [] };
    }
    
    // Erstelle ein einzelnes Feld mit allen Games nebeneinander
    let allGamesContent = '';
    for (let i = 1; i <= scrimConfig.maxGames; i++) {
        const gameKey = `game${i}`;
        if (!scrimSignups[gameKey]) scrimSignups[gameKey] = [];
        
        let gameIds = [...scrimSignups[gameKey]];
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

// Scrim-ButtonRows für dynamische Games
function getScrimButtonRowsWithControls(userId) {
    const rows = [];
    
    // Erste Reihe: Signup Buttons (max 5 pro Reihe)
    const signupRow = new ActionRowBuilder();
    for (let i = 1; i <= Math.min(scrimConfig.maxGames, 4); i++) {
        signupRow.addComponents(
            new ButtonBuilder()
                .setCustomId(`scrim_signup_game${i}`)
                .setLabel(`Game ${i} +`)
                .setStyle(ButtonStyle.Success)
                .setDisabled(false)
        );
    }
    // All Games Button (nur wenn Platz ist)
    if (scrimConfig.maxGames <= 4) {
        signupRow.addComponents(
            new ButtonBuilder()
                .setCustomId('scrim_signup_all')
                .setLabel(`All Games +`)
                .setStyle(ButtonStyle.Primary)
                .setDisabled(false)
        );
    }
    rows.push(signupRow);
    
    // Zweite Reihe: Restliche Signup Buttons (falls mehr als 4 Games)
    if (scrimConfig.maxGames > 4) {
        const signupRow2 = new ActionRowBuilder();
        for (let i = 5; i <= scrimConfig.maxGames; i++) {
            signupRow2.addComponents(
                new ButtonBuilder()
                    .setCustomId(`scrim_signup_game${i}`)
                    .setLabel(`Game ${i} +`)
                    .setStyle(ButtonStyle.Success)
                    .setDisabled(false)
            );
        }
        // All Games Button
        signupRow2.addComponents(
            new ButtonBuilder()
                .setCustomId('scrim_signup_all')
                .setLabel(`All Games +`)
                .setStyle(ButtonStyle.Primary)
                .setDisabled(false)
        );
        rows.push(signupRow2);
    }
    
    // Dritte Reihe: Unsign Buttons (max 5 pro Reihe)
    const unsignRow = new ActionRowBuilder();
    for (let i = 1; i <= Math.min(scrimConfig.maxGames, 4); i++) {
        unsignRow.addComponents(
            new ButtonBuilder()
                .setCustomId(`scrim_unsign_game${i}`)
                .setLabel(`Game ${i} -`)
                .setStyle(ButtonStyle.Danger)
                .setDisabled(false)
        );
    }
    // Clear All Button (nur wenn Platz ist)
    if (scrimConfig.maxGames <= 4) {
        unsignRow.addComponents(
            new ButtonBuilder()
                .setCustomId('scrim_unsign_all')
                .setLabel(`Clear All`)
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(false)
        );
    }
    rows.push(unsignRow);
    
    // Vierte Reihe: Restliche Unsign Buttons (falls mehr als 4 Games)
    if (scrimConfig.maxGames > 4) {
        const unsignRow2 = new ActionRowBuilder();
        for (let i = 5; i <= scrimConfig.maxGames; i++) {
            unsignRow2.addComponents(
                new ButtonBuilder()
                    .setCustomId(`scrim_unsign_game${i}`)
                    .setLabel(`Game ${i} -`)
                    .setStyle(ButtonStyle.Danger)
                    .setDisabled(false)
            );
        }
        // Clear All Button
        unsignRow2.addComponents(
            new ButtonBuilder()
                .setCustomId('scrim_unsign_all')
                .setLabel(`Clear All`)
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(false)
        );
        rows.push(unsignRow2);
    }
    
    // Letzte Reihe: Refresh Button
    rows.push(
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('scrim_refresh_board')
                .setLabel('Aktualisieren')
                .setEmoji('🔄')
                .setStyle(ButtonStyle.Secondary)
        )
    );
    
    return rows;
}

// Scrim-Board posten
async function postScrimSignupWithDelete(channel) {
    const channelId = channel.id;
    if (scrimBoards[channelId] && scrimBoards[channelId].messageId) {
        try {
            const msg = await channel.messages.fetch(scrimBoards[channelId].messageId);
            await msg.delete();
        } catch (e) {}
    }
    // viewerId ist Bot selbst, da kein User-Kontext
    const embed = await getScrimSignupEmbed(client, client.user.id);
    const buttonRows = getScrimButtonRowsWithControls(client.user.id);
    const msg = await channel.send({ embeds: [embed], components: buttonRows });
    // Berechne Verfallsdatum (nächster Tag um 00:00 Uhr deutsche Zeit)
    const today = getGermanDate();
    const dayIndex = getDayIndex(scrimConfig.day);
    const currentDayIndex = today.getDay();
    let daysUntilNext = dayIndex - currentDayIndex;
    if (daysUntilNext < 0) daysUntilNext += 7;
    
    const expiryDate = new Date(today);
    expiryDate.setDate(today.getDate() + daysUntilNext + 1); // +1 für nächsten Tag
    expiryDate.setHours(0, 0, 0, 0); // 00:00:00 Uhr
    
    scrimBoards[channelId] = {
        messageId: msg.id,
        channelId: channelId,
        expiryDate: expiryDate.getTime()
    };
    
    // Timer für automatisches Löschen setzen
    const timeUntilExpiry = expiryDate.getTime() - Date.now();
    if (timeUntilExpiry > 0) {
        setTimeout(async () => {
            try {
                await deleteScrimMessage(channelId);
                console.log(`Scrim-Nachricht für ${scrimConfig.day} wurde automatisch gelöscht (Verfallsdatum erreicht)`);
            } catch (error) {
                console.error('Fehler beim automatischen Löschen der Scrim-Nachricht:', error);
            }
        }, timeUntilExpiry);
    }
}

// Funktion zum Löschen von Scrim-Nachrichten
async function deleteScrimMessage(channelId) {
    if (scrimBoards[channelId] && scrimBoards[channelId].messageId) {
        try {
            const channel = await client.channels.fetch(scrimBoards[channelId].channelId);
            const msg = await channel.messages.fetch(scrimBoards[channelId].messageId);
            await msg.delete();
            delete scrimBoards[channelId];
            console.log(`Scrim-Nachricht in Channel ${channelId} wurde gelöscht`);
        } catch (error) {
            console.error('Fehler beim Löschen der Scrim-Nachricht:', error);
            // Auch bei Fehler das Board aus dem Cache entfernen
            delete scrimBoards[channelId];
        }
    }
}

// --- PATCH: Sende DM sofort, wenn 5 Spieler eingetragen sind ---
async function sendPremierFoundDM(day) {
    const now = Date.now();
    const status = premierDMStatus[day];
    if (now - status.lastFound < 60 * 60 * 1000) {
        // Spam-Schutz aktiv: pending setzen und Timer starten, falls nicht schon gesetzt
        status.pendingFound = true;
        if (!status.foundTimeout) {
            status.foundTimeout = setTimeout(async () => {
                if (status.pendingFound) {
                    status.pendingFound = false;
                    status.lastFound = Date.now();
                    const data = signups[day];
                    if (data.length === 5) {
                        for (const userId of data) {
                            if (dmOptOut.has(userId)) continue;
                            if (isUserAbwesendToday(userId)) continue; // Abwesende User überspringen
                            try {
                                const user = await client.users.fetch(userId);
                                await user.send(`\`\`\`\nHey ${user.username}, es haben sich 5 Spieler für ${day} gefunden (${getPremierTime(day)}). Bitte sei pünktlich!\n\`\`\``);
                            } catch (e) { console.error(`Konnte DM an User ${userId} nicht senden:`, e); }
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
    const data = signups[day];
    if (data.length === 5) {
        for (const userId of data) {
            if (dmOptOut.has(userId)) continue;
            if (isUserAbwesendToday(userId)) continue; // Abwesende User überspringen
            try {
                const user = await client.users.fetch(userId);
                await user.send(`\`\`\`\nHey ${user.username}, es haben sich 5 Spieler für ${day} gefunden (${getPremierTime(day)}). Bitte sei pünktlich!\n\`\`\``);
            } catch (e) { console.error(`Konnte DM an User ${userId} nicht senden:`, e); }
        }
    }
}

// --- Practice-DM sofort bei 5 ---
async function sendPracticeFoundDM(day) {
    const now = Date.now();
    const status = practiceDMStatus[day];
    if (now - status.lastFound < 60 * 60 * 1000) {
        status.pendingFound = true;
        if (!status.foundTimeout) {
            status.foundTimeout = setTimeout(async () => {
                if (status.pendingFound) {
                    status.pendingFound = false;
                    status.lastFound = Date.now();
                    const data = practiceSignups[day];
                    if (data.length === 5) {
                        for (const userId of data) {
                            if (dmOptOut.has(userId)) continue;
                            if (isUserAbwesendToday(userId)) continue; // Abwesende User überspringen
                            try {
                                const user = await client.users.fetch(userId);
                                await user.send(`\`\`\`\nHey ${user.username}, es haben sich 5 Leute für Practice gefunden am ${day} (${getPremierTime(day)}). Bitte sei pünktlich!\n\`\`\``);
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
    const data = practiceSignups[day];
    if (data.length === 5) {
        for (const userId of data) {
            if (dmOptOut.has(userId)) continue;
            if (isUserAbwesendToday(userId)) continue; // Abwesende User überspringen
            try {
                const user = await client.users.fetch(userId);
                await user.send(`\`\`\`\nHey ${user.username}, es haben sich 5 Leute für Practice gefunden am ${day} (${getPremierTime(day)}). Bitte sei pünktlich!\n\`\`\``);
            } catch (e) { console.error(`Konnte DM an User ${userId} nicht senden:`, e); }
        }
    }
}

// --- Practice: Sende Absage-DM bei weniger als 5 (max 1x pro Stunde) ---
async function sendPracticeCancelDM(day, removedUserName = null) {
    const now = Date.now();
    const status = practiceDMStatus[day];
    if (now - status.lastCancel < 60 * 60 * 1000) {
        status.pendingCancel = true;
        if (!status.cancelTimeout) {
            status.cancelTimeout = setTimeout(async () => {
                if (status.pendingCancel) {
                    status.pendingCancel = false;
                    status.lastCancel = Date.now();
                    const data = practiceSignups[day];
                    if (data.length < MAX_USERS && data.length > 0) {
                        const msg = `\`\`\`\nLeider findet am ${day} ${getPremierTime(day)} doch kein Practice statt.${removedUserName ? `\n${removedUserName} hat sich ausgetragen.` : ''}\n\`\`\``;
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
    const data = practiceSignups[day];
    if (data.length < MAX_USERS && data.length > 0) {
        const msg = `\`\`\`\nLeider findet am ${day} ${getPremierTime(day)} doch kein Practice statt.${removedUserName ? `\n${removedUserName} hat sich ausgetragen.` : ''}\n\`\`\``;
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
                            if (dmOptOut.has(userId)) continue;
                            if (isUserAbwesendToday(userId)) continue; // Abwesende User überspringen
                            try {
                                const user = await client.users.fetch(userId);
                                await user.send(`\`\`\`\nHey ${user.username}, es haben sich ${scrimConfig.maxGames} Leute für Scrim gefunden am ${scrimConfig.day} (${scrimConfig.time}). Bitte sei pünktlich!\n\`\`\``);
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
            if (dmOptOut.has(userId)) continue;
            if (isUserAbwesendToday(userId)) continue; // Abwesende User überspringen
            try {
                const user = await client.users.fetch(userId);
                await user.send(`\`\`\`\nHey ${user.username}, es haben sich ${scrimConfig.maxGames} Leute für Scrim gefunden am ${scrimConfig.day} (${scrimConfig.time}). Bitte sei pünktlich!\n\`\`\``);
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
                            if (dmOptOut.has(userId)) continue;
                            if (isUserAbwesendToday(userId)) continue; // Abwesende User überspringen
                            try {
                                const user = await client.users.fetch(userId);
                                await user.send(msg);
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
            if (dmOptOut.has(userId)) continue;
            if (isUserAbwesendToday(userId)) continue; // Abwesende User überspringen
            try {
                const user = await client.users.fetch(userId);
                await user.send(msg);
            } catch (e) { console.error('Fehler beim Senden der Scrim-Absage-DM:', e); }
        }
    }
}

// --- Premier: Sende Absage-DM bei weniger als 5 (max 1x pro Stunde) ---
async function sendPremierCancelDM(day, removedUserName = null) {
    const now = Date.now();
    const status = premierDMStatus[day];
    if (now - status.lastCancel < 60 * 60 * 1000) {
        status.pendingCancel = true;
        if (!status.cancelTimeout) {
            status.cancelTimeout = setTimeout(async () => {
                if (status.pendingCancel) {
                    status.pendingCancel = false;
                    status.lastCancel = Date.now();
                    const data = signups[day];
                    if (data.length < MAX_USERS && data.length > 0) {
                        const msg = `\`\`\`\nLeider findet am ${day} ${getPremierTime(day)} doch kein Premier statt.${removedUserName ? `\n${removedUserName} hat sich ausgetragen.` : ''}\n\`\`\``;
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
    const data = signups[day];
    if (data.length < MAX_USERS && data.length > 0) {
        const msg = `\`\`\`\nLeider findet am ${day} ${getPremierTime(day)} doch kein Premier statt.${removedUserName ? `\n${removedUserName} hat sich ausgetragen.` : ''}\n\`\`\``;
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
async function sendPremierReminderDM(day) {
    const now = Date.now();
    const today = getGermanDate();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    if (premierDMStatus[day].lastReminder && new Date(premierDMStatus[day].lastReminder).toISOString().slice(0, 10) === todayStr) return;
    const data = signups[day];
    if (data.length === MAX_USERS) {
        for (const userId of data) {
            if (dmOptOut.has(userId)) continue;
            if (isUserAbwesendToday(userId)) continue; // Abwesende User überspringen
            try {
                const user = await client.users.fetch(userId);
                await user.send(`\`\`\`\nHey ${user.username}, denk dran: Heute ist Premiere. (${day}: (${getPremierTime(day)}))\n\`\`\``);
            } catch (e) {}
        }
        premierDMStatus[day].lastReminder = now;
    }
}

// --- Scrim: Erinnerungs-DM am Tag des Matches (max 1x pro Tag) ---
async function sendScrimReminderDM() {
    const now = Date.now();
    const today = getGermanDate();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    if (scrimDMStatus.lastReminder && new Date(scrimDMStatus.lastReminder).toISOString().slice(0, 10) === todayStr) return;
    if (scrimSignups.length === scrimConfig.maxGames) {
        for (const userId of scrimSignups) {
            if (dmOptOut.has(userId)) continue;
            if (isUserAbwesendToday(userId)) continue; // Abwesende User überspringen
            try {
                const user = await client.users.fetch(userId);
                await user.send(`\`\`\`\nHey ${user.username}, denk dran: Heute ist Scrim. (${scrimConfig.day}: ${scrimConfig.time})\n\`\`\``);
            } catch (e) {}
        }
        scrimDMStatus.lastReminder = now;
    }
}

// --- Practice: Sende DM bei 5 gefunden (nur beim Übergang auf 5 User) ---
async function sendPracticeFoundDM(day) {
    const data = practiceSignups[day];
    if (practiceDMStatus[day].state !== 'waiting') return;
    if (data.length === 5) {
        for (const userId of data) {
            if (dmOptOut.has(userId)) continue;
            try {
                const user = await client.users.fetch(userId);
                await user.send(`\`\`\`\nHey ${user.username}, es haben sich 5 Leute für Practice gefunden am ${day} (${getPremierTime(day)}).\n\`\`\``);
            } catch (e) {}
        }
        practiceDMStatus[day].state = 'full';
    }
}
// --- Practice: Sende Absage-DM bei weniger als 5 (nur beim Übergang von 5 auf <5, stündlich) ---
async function sendPracticeCancelDM(day, removedUserName = null) {
    const data = practiceSignups[day];
    if (practiceDMStatus[day].state !== 'full') return;
    if (data.length < 5) {
        for (const userId of data) {
            if (dmOptOut.has(userId)) continue;
            try {
                const user = await client.users.fetch(userId);
                await user.send(`\`\`\`\nHey ${user.username}, leider wird das Practice Match abgesagt, jemand hat sich ausgetragen.\n\`\`\``);
            } catch (e) {}
        }
        practiceDMStatus[day].state = 'cancelled';
    }
}
// --- Premier: Sende DM bei 5 gefunden (nur beim Übergang auf 5 User) ---
async function sendPremierFoundDM(day) {
    const data = signups[day];
    if (premierDMStatus[day].state !== 'waiting') return;
    if (data.length === 5) {
        for (const userId of data) {
            if (dmOptOut.has(userId)) continue;
            try {
                const user = await client.users.fetch(userId);
                await user.send(`\`\`\`\nHey ${user.username}, es haben sich 5 Spieler für ${day} gefunden (${getPremierTime(day)}).\n\`\`\``);
            } catch (e) {}
        }
        premierDMStatus[day].state = 'full';
    }
}
// --- Practice: Reset state, wenn wieder 5 erreicht werden ---
function updatePracticeState(day) {
    const data = practiceSignups[day];
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
cron.schedule('0 12 * * *', async () => {
    await executeBackupCheckWithRetry();
}, {
    scheduled: true,
    timezone: "Europe/Berlin"
});

// Zentrale Funktion für Backup-Erstellung mit Retry
async function executeBackupCheckWithRetry() {
    try {
        console.log('Erstelle tägliches Backup der Anmeldungen...');
        saveSignupBackup();
        console.log('Tägliches Backup erfolgreich erstellt.');
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

// --- Cronjob: Erinnerungs-DM immer um 12 Uhr am Tag des Matches ---
cron.schedule('0 12 * * *', async () => {
    // Practice: Erinnerungs-DM
    const now = getGermanDate();
    const weekday = now.getDay();
    for (const day of practiceConfig.days) {
        const dayIndex = getDayIndex(day);
        if (weekday === dayIndex) {
            await sendPracticeReminderDM(day);
        }
    }
    // Premier: Erinnerungs-DM
    for (const day of premierConfig.days) {
        const dayIndex = getDayIndex(day);
        if (weekday === dayIndex) {
            await sendPremierReminderDM(day);
        }
    }
    // Scrim: Erinnerungs-DM
    const scrimDayIndex = getDayIndex(scrimConfig.day);
    if (weekday === scrimDayIndex) {
        await sendScrimReminderDM();
    }
});


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
        clearPastSignups();
        
        // Aktualisiere alle Boards nach dem Leeren
        for (const channelId in premierBoards) {
            if (premierBoards[channelId]?.messageId && premierBoards[channelId]?.channelId) {
                try {
                    const channel = await client.channels.fetch(premierBoards[channelId]?.channelId);
                    const embed = await getSignupEmbed(client);
                    const userId = getFirstSignedUpUserId() || client.user.id;
                    const buttonRows = getButtonRow(userId);
                    const msg = await channel.messages.fetch(premierBoards[channelId]?.messageId);
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
                    const embed = await getPracticeSignupEmbed(client);
                    const buttonRows = getPracticeButtonRowsWithControls(client.user.id);
                    const msg = await channel.messages.fetch(practiceBoards[channelId]?.messageId);
                    await msg.edit({ embeds: [embed], components: buttonRows });
                    console.log(`[00:00] Practice-Board in Channel ${channelId} nach Mitternacht aktualisiert.`);
                } catch (error) {
                    console.error(`[00:00] Fehler beim Aktualisieren des Practice-Boards in Channel ${channelId}:`, error);
                }
            }
        }
        
        for (const channelId in scrimBoards) {
            if (scrimBoards[channelId]?.messageId && scrimBoards[channelId]?.channelId) {
                try {
                    const channel = await client.channels.fetch(scrimBoards[channelId]?.channelId);
                    const embed = await getScrimSignupEmbed(client);
                    const buttonRows = getScrimButtonRowsWithControls(client.user.id);
                    const msg = await channel.messages.fetch(scrimBoards[channelId]?.messageId);
                    await msg.edit({ embeds: [embed], components: buttonRows });
                    console.log(`[00:00] Scrim-Board in Channel ${channelId} nach Mitternacht aktualisiert.`);
                } catch (error) {
                    console.error(`[00:00] Fehler beim Aktualisieren des Scrim-Boards in Channel ${channelId}:`, error);
                }
            }
        }
        
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

// --- NEU: Montags-Reminder für alle User, wenn NICHT eingetragen ---
cron.schedule('0 12 * * 1', async () => {
    for (const guild of client.guilds.cache.values()) {
        await guild.members.fetch();
        const allMembers = guild.members.cache.map(m => m.user.id);
        const eingetragenPremier = new Set();
        for (const day of premierConfig.days) {
            for (const userId of signups[day] || []) {
                eingetragenPremier.add(userId);
            }
        }
        const eingetragenPractice = new Set();
        for (const day of practiceConfig.days) {
            for (const userId of practiceSignups[day] || []) {
                eingetragenPractice.add(userId);
            }
        }
        const eingetragenScrim = new Set();
        // Sammle alle Scrim-Teilnehmer
        for (let i = 1; i <= scrimConfig.maxGames; i++) {
            const gameKey = `game${i}`;
            if (scrimSignups[gameKey]) {
                for (const userId of scrimSignups[gameKey]) {
                    eingetragenScrim.add(userId);
                }
            }
        }
        
        for (const userId of allMembers) {
            if (dmOptOut.has(userId)) continue;
            if (isUserAbwesendToday(userId)) continue;
            if (!eingetragenPremier.has(userId) && !eingetragenPractice.has(userId) && !eingetragenScrim.has(userId)) {
                try {
                    const user = await client.users.fetch(userId);
                    await user.send(`\`\`\`\nHey ${user.username}, du bist diese Woche noch nicht für Premier, Practice oder Scrim eingetragen. Bitte trage dich ein, damit deine Mitspieler planen können!\n\`\`\``);
                } catch (e) { console.error('Fehler beim Senden des Montags-Reminders:', e); }
            }
        }
    }
});

// Kombinierter Handler für alle Interaktionen (Autocomplete + Commands + Buttons)
client.on(Events.InteractionCreate, async interaction => {
    // AUTOCOMPLETE HANDLER
    if (interaction.isAutocomplete()) {
        const focusedOption = interaction.options.getFocused(true);
        
        // Handler für 'user' Parameter (premier-admin, abwesend-admin)
        if (focusedOption.name === 'user') {
            try {
                // Hole alle Mitglieder der aktuellen Guild (auch offline)
                await interaction.guild.members.fetch();
                const members = interaction.guild.members.cache;
                
                // Wenn keine Eingabe, zeige alle Mitglieder
                let filteredMembers;
                if (!focusedOption.value || focusedOption.value.trim() === '') {
                    filteredMembers = Array.from(members.values()).slice(0, 25);
                } else {
                    // Filtere nach der Eingabe (Username oder Display Name)
                    filteredMembers = Array.from(members.values())
                        .filter(member => 
                            member.user.username.toLowerCase().includes(focusedOption.value.toLowerCase()) ||
                            member.displayName.toLowerCase().includes(focusedOption.value.toLowerCase())
                        )
                        .slice(0, 25); // Discord erlaubt max 25 Optionen
                }
                
                const choices = filteredMembers.map(member => ({
                    name: `${member.displayName} (@${member.user.username})`,
                    value: member.user.id
                }));
                
                await interaction.respond(choices);
            } catch (error) {
                console.error('Fehler beim Autocomplete:', error);
                try {
                    await interaction.respond([]);
                } catch (e) {
                    // Interaction bereits beantwortet - ignorieren
                }
            }
        }
        
        // Handler für 'username' Parameter (andere Befehle)
        else if (focusedOption.name === 'username' && 
                (interaction.commandName === 'premier' || interaction.commandName === 'abwesend-admin')) {
            try {
                // Hole alle Mitglieder der aktuellen Guild (auch offline)
                await interaction.guild.members.fetch();
                const choices = Array.from(interaction.guild.members.cache.values()).map(member => ({
                    name: `${member.displayName} (@${member.user.username})`,
                    value: `<@${member.user.id}>`
                }));
                
                // Filter nach Eingabe
                const filtered = choices.filter(choice =>
                    choice.name.toLowerCase().includes(focusedOption.value.toLowerCase())
                ).slice(0, 25); // Discord erlaubt max. 25 Vorschläge
                
                await interaction.respond(filtered);
            } catch (error) {
                console.error('Fehler beim Autocomplete:', error);
                try {
                    await interaction.respond([]);
                } catch (e) {
                    // Interaction bereits beantwortet - ignorieren
                }
            }
        }
        return; // Wichtig: Autocomplete-Handler beenden
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
    // Premier-Buttons
    if (interaction.isButton() && !interaction.customId.startsWith('practice_') && !interaction.customId.startsWith('scrim_')) {
        const channelId = interaction.channel.id;
        if (!premierBoards[channelId] || interaction.message.id !== premierBoards[channelId].messageId) return;
        const userId = interaction.user.id;
        let updated = false;
        
        for (const day of premierConfig.days) {
            if (interaction.customId === `signup_${day}`) {
                if (!signups[day].includes(userId) && signups[day].length < MAX_USERS) {
                    // SOFORT die Interaktion bestätigen (innerhalb von 3 Sekunden)
                    try {
                        await interaction.deferUpdate();
                    } catch (error) {
                        console.error('Fehler beim deferUpdate für Premier:', error);
                        return;
                    }
                    
                    signups[day].push(userId);
                    validateSignupData();
                    updated = true;
                    await sendPremierFoundDM(day);
                    console.log(`Eingetragen: ${interaction.user.tag} für ${day}`);
                } else if (signups[day].includes(userId)) {
                    await interaction.reply({ content: 'Du bist bereits für diesen Tag angemeldet!', flags: [MessageFlags.Ephemeral] });
                    return;
                } else {
                    await interaction.reply({ content: `Das Team für ${day} ist bereits voll (5/5 Spieler)`, flags: [MessageFlags.Ephemeral] });
                    return;
                }
            }
            if (interaction.customId === `unsign_${day}`) {
                if (signups[day].includes(userId)) {
                    // SOFORT die Interaktion bestätigen (innerhalb von 3 Sekunden)
                    try {
                        await interaction.deferUpdate();
                    } catch (error) {
                        console.error('Fehler beim deferUpdate für Premier:', error);
                        return;
                    }
                    
                    const wasFull = signups[day].length === MAX_USERS;
                    signups[day] = signups[day].filter(u => u !== userId);
                    validateSignupData();
                    updated = true;
                    console.log(`Entfernt: ${interaction.user.tag} von ${day}`);
                    if (wasFull && signups[day].length === MAX_USERS - 1) {
                        await sendPremierCancelDM(day, interaction.user.username);
                    }
                } else {
                    await interaction.reply({ content: 'Du bist nicht für diesen Tag angemeldet!', flags: [MessageFlags.Ephemeral] });
                    return;
                }
            }
        }

        
        if (updated && interaction.message.id === premierBoards[channelId].messageId) {
            for (const key in userCache) delete userCache[key];
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
                    console.error('Fehler beim Aktualisieren des Boards:', e);
                }
            }, 100);
        }
        return;
    }
    // Practice-Buttons
    if (interaction.isButton() && interaction.customId.startsWith('practice_')) {
        const channelId = interaction.channel.id;
        if (!practiceBoards[channelId] || interaction.message.id !== practiceBoards[channelId].messageId) return;
        const userId = interaction.user.id;
        let updated = false;
        
        // SOFORT die Interaktion bestätigen (innerhalb von 3 Sekunden)
        try {
            await interaction.deferUpdate();
        } catch (error) {
            console.error('Fehler beim deferUpdate für Practice:', error);
            return;
        }
        for (const day of practiceConfig.days) {
            if (interaction.customId === `practice_signup_${day}`) {
                if (!practiceSignups[day].includes(userId) && practiceSignups[day].length < MAX_USERS) {
                    practiceSignups[day].push(userId);
                    updated = true;
                    await sendPracticeFoundDM(day);
                    console.log(`Eingetragen: ${interaction.user.tag} für ${day}`);
                }
            }
            if (interaction.customId === `practice_unsign_${day}`) {
                if (practiceSignups[day].includes(userId)) {
                    const wasFull = practiceSignups[day].length === MAX_USERS;
                    practiceSignups[day] = practiceSignups[day].filter(u => u !== userId);
                    updated = true;
                    console.log(`Entfernt: ${interaction.user.tag} von ${day}`);
                    if (wasFull && practiceSignups[day].length === MAX_USERS - 1) {
                        await sendPracticeCancelDM(day, interaction.user.username);
                    }
                }
            }
            updatePracticeState(day);
        }

        
        if (updated && interaction.message.id === practiceBoards[channelId].messageId) {
            for (const key in userCache) delete userCache[key];
            setTimeout(async () => {
                try {
                    const channel = await client.channels.fetch(practiceBoards[channelId].channelId);
                    const embed = await getPracticeSignupEmbed(client);
                    const userId = client.user.id;
                    const buttonRows = getPracticeButtonRowsWithControls(userId);
                    await channel.messages.fetch(practiceBoards[channelId].messageId).then(msg =>
                        msg.edit({ embeds: [embed], components: buttonRows })
                    );
                } catch (e) {}
            }, 100);
        }
        return;
    }
    // Scrim-Buttons
    if (interaction.isButton() && interaction.customId.startsWith('scrim_')) {
        const channelId = interaction.channel.id;
        if (!scrimBoards[channelId] || interaction.message.id !== scrimBoards[channelId].messageId) return;
        const userId = interaction.user.id;
        let updated = false;
        
        // Stelle sicher, dass scrimSignups ein Objekt mit dynamischen Games ist
        if (!scrimSignups || typeof scrimSignups !== 'object') {
            scrimSignups = { game1: [] };
        }
        
        // SOFORT die Interaktion bestätigen (innerhalb von 3 Sekunden)
        try {
            await interaction.deferUpdate();
        } catch (error) {
            console.error('Fehler beim deferUpdate für Scrim:', error);
            return;
        }
        
        // Dynamische Game-Signup Handler
        if (interaction.customId.startsWith('scrim_signup_game') && interaction.customId !== 'scrim_signup_all') {
            const gameNumber = interaction.customId.replace('scrim_signup_game', '');
            const gameKey = `game${gameNumber}`;
            
            if (!scrimSignups[gameKey]) scrimSignups[gameKey] = [];
            
            if (!scrimSignups[gameKey].includes(userId)) {
                scrimSignups[gameKey].push(userId);
                updated = true;
                console.log(`Eingetragen: ${interaction.user.tag} für Scrim Game ${gameNumber}`);
            } else {
                console.log(`${interaction.user.tag} ist bereits für Scrim Game ${gameNumber} eingetragen`);
            }
        }
        
        if (interaction.customId === 'scrim_signup_all') {
            let added = false;
            for (let i = 1; i <= scrimConfig.maxGames; i++) {
                const gameKey = `game${i}`;
                if (!scrimSignups[gameKey]) scrimSignups[gameKey] = [];
                
                if (!scrimSignups[gameKey].includes(userId)) {
                    scrimSignups[gameKey].push(userId);
                    added = true;
                }
            }
            if (added) {
                updated = true;
                console.log(`Eingetragen: ${interaction.user.tag} für alle Scrim Games`);
            } else {
                console.log(`${interaction.user.tag} ist bereits für alle Scrim Games eingetragen`);
            }
        }
        
        // Dynamische Game-Unsign Handler
        if (interaction.customId.startsWith('scrim_unsign_game') && interaction.customId !== 'scrim_unsign_all') {
            const gameNumber = interaction.customId.replace('scrim_unsign_game', '');
            const gameKey = `game${gameNumber}`;
            
            if (scrimSignups[gameKey] && scrimSignups[gameKey].includes(userId)) {
                scrimSignups[gameKey] = scrimSignups[gameKey].filter(u => u !== userId);
                updated = true;
                console.log(`Entfernt: ${interaction.user.tag} von Scrim Game ${gameNumber}`);
            } else {
                console.log(`${interaction.user.tag} ist nicht für Scrim Game ${gameNumber} eingetragen`);
            }
        }
        
        if (interaction.customId === 'scrim_unsign_all') {
            let removed = false;
            for (let i = 1; i <= scrimConfig.maxGames; i++) {
                const gameKey = `game${i}`;
                if (scrimSignups[gameKey] && scrimSignups[gameKey].includes(userId)) {
                    scrimSignups[gameKey] = scrimSignups[gameKey].filter(u => u !== userId);
                    removed = true;
                }
            }
            if (removed) {
                updated = true;
                console.log(`Entfernt: ${interaction.user.tag} von allen Scrim Games`);
            } else {
                console.log(`${interaction.user.tag} ist nicht für Scrim Games eingetragen`);
            }
        }
        
        // Refresh Board Handler
        if (interaction.customId === 'scrim_refresh_board') {
            updated = true;
            console.log(`Scrim Board Refresh von ${interaction.user.tag}`);
        }
        
        // Board aktualisieren wenn nötig
        if (updated && interaction.message.id === scrimBoards[channelId].messageId) {
            for (const key in userCache) delete userCache[key];
            setTimeout(async () => {
                try {
                    const channel = await client.channels.fetch(scrimBoards[channelId].channelId);
                    const embed = await getScrimSignupEmbed(client);
                    const buttonRows = getScrimButtonRowsWithControls(client.user.id);
                    await channel.messages.fetch(scrimBoards[channelId].messageId).then(msg =>
                        msg.edit({ embeds: [embed], components: buttonRows })
                    );
                } catch (e) {
                    console.error('Fehler beim Aktualisieren des Scrim-Boards:', e);
                }
            }, 100);
        }
        return;
    }
    // Slash Commands
    if (interaction.isChatInputCommand()) {
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
        if (interaction.commandName === 'backup') {
            // Admin-Prüfung
            const member = await interaction.guild.members.fetch(interaction.user.id);
            if (!(await hasAdminPermissions(member))) {
                await interaction.reply({ content: 'Nur Administratoren dürfen diesen Befehl ausführen.', flags: [MessageFlags.Ephemeral] });
                return;
            }
            
            saveSignupBackup();
            await interaction.reply({ content: 'Backup wurde erfolgreich erstellt.', flags: [MessageFlags.Ephemeral] });
            return;
        }
        if (interaction.commandName === 'pastbackup') {
            // Admin-Prüfung
            const member = await interaction.guild.members.fetch(interaction.user.id);
            if (!(await hasAdminPermissions(member))) {
                await interaction.reply({ content: 'Nur Administratoren dürfen diesen Befehl ausführen.', flags: [MessageFlags.Ephemeral] });
                return;
            }
            
            if (await loadSignupBackup()) {
                verifySignupIntegrity();
                ensureAllDays();
                // Sofort dem User antworten
                await interaction.reply({ content: 'Backup wurde erfolgreich geladen und das Board wird aktualisiert.', flags: [MessageFlags.Ephemeral] });
                // Board nach 0,1s aktualisieren
                const channelId = interaction.channel.id;
                if (premierBoards[channelId]?.messageId && premierBoards[channelId]?.channelId) {
                                    setTimeout(async () => {
                    try {
                        const channel = await client.channels.fetch(premierBoards[channelId]?.channelId);
                        const embed = await getSignupEmbed(client);
                        const userId = getFirstSignedUpUserId() || client.user.id;
                        const buttonRows = getButtonRow(userId);
                        await channel.messages.fetch(premierBoards[channelId]?.messageId).then(msg => msg.edit({ embeds: [embed], components: buttonRows }));
                    } catch (e) {}
                }, 100);
                }
            } else {
                await interaction.reply({ content: 'Kein Backup gefunden oder Fehler beim Laden.', flags: [MessageFlags.Ephemeral] });
            }
            return;
        }
        if (interaction.commandName === 'clearpast') {
            // Admin-Prüfung
            const member = await interaction.guild.members.fetch(interaction.user.id);
            if (!(await hasAdminPermissions(member))) {
                await interaction.reply({ content: 'Nur Administratoren dürfen diesen Befehl ausführen.', flags: [MessageFlags.Ephemeral] });
                return;
            }
            
            // Sofortige Antwort um Timeout zu vermeiden
            await interaction.reply({ content: 'Clearpast wird ausgeführt...', ephemeral: true });
            
            const subcommand = interaction.options.getSubcommand();
            const channelId = interaction.channel.id;
            
            if (subcommand === 'premier') {
                // Alle Premier-Anmeldungen löschen
                let totalCleared = 0;
                for (const day of DAYS) {
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
                for (const day of PRACTICE_DAYS) {
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
            await interaction.reply({ content: 'Premier-Konfiguration wird aktualisiert...', ephemeral: true });
            
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
            
            const day3 = interaction.options.getString('day_3');
            const time3 = interaction.options.getString('daytime_3');
            if (day3 && time3) {
                days.push(day3);
                times.push(time3);
            }
            
            // Validiere Zeiten (HH:MM Format)
            for (const time of times) {
                if (!/^\d{1,2}:\d{2}$/.test(time)) {
                    await interaction.editReply({ content: 'Ungültiges Zeitformat! Verwende HH:MM (z.B. 19:00)', ephemeral: true });
                    return;
                }
            }
            
            // Aktualisiere Konfiguration
            premierConfig.days = days;
            premierConfig.times = times;
            
            // Initialisiere dynamische Strukturen neu
            initializeDynamicSignups();
            
            // Backup speichern
            saveSignupBackup();
            
            // Sofortige Antwort senden
            await interaction.editReply({ 
                content: `Premier-Konfiguration aktualisiert!\nTage: ${days.join(', ')}\nZeiten: ${times.join(', ')}\n\nAlle Premier-Boards werden im Hintergrund aktualisiert...`, 
                ephemeral: true 
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
            await interaction.reply({ content: 'Practice-Konfiguration wird aktualisiert...', ephemeral: true });
            
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
            
            // Validiere Zeiten (HH:MM Format)
            for (const time of times) {
                if (!/^\d{1,2}:\d{2}$/.test(time)) {
                    await interaction.editReply({ content: 'Ungültiges Zeitformat! Verwende HH:MM (z.B. 19:00)', ephemeral: true });
                    return;
                }
            }
            
            // Aktualisiere Konfiguration
            practiceConfig.days = days;
            practiceConfig.times = times;
            
            // Initialisiere dynamische Strukturen neu
            initializeDynamicSignups();
            
            // Backup speichern
            saveSignupBackup();
            
            await interaction.editReply({ 
                content: `Practice-Konfiguration aktualisiert!\nTage: ${days.join(', ')}\nZeiten: ${times.join(', ')}`, 
                ephemeral: true 
            });
        }
        
        if (interaction.commandName === 'scrim-config') {
            // Admin-Prüfung
            const member = await interaction.guild.members.fetch(interaction.user.id);
            if (!(await hasAdminPermissions(member))) {
                await interaction.reply({ content: 'Nur Administratoren dürfen diesen Befehl ausführen.', flags: [MessageFlags.Ephemeral] });
                return;
            }
            
            // Sofortige Antwort um Timeout zu vermeiden
            await interaction.reply({ content: 'Scrim-Konfiguration wird aktualisiert...', ephemeral: true });
            
            const day = interaction.options.getString('day');
            const time = interaction.options.getString('daytime');
            const maxGames = interaction.options.getInteger('max_games') || 3;
            
            // Validiere Zeit (HH:MM Format)
            if (!/^\d{1,2}:\d{2}$/.test(time)) {
                await interaction.editReply({ content: 'Ungültiges Zeitformat! Verwende HH:MM (z.B. 19:00)', ephemeral: true });
                return;
            }
            
            // Aktualisiere Konfiguration
            scrimConfig.day = day;
            scrimConfig.time = time;
            scrimConfig.maxGames = maxGames;
            
            // Backup speichern
            saveSignupBackup();
            
            await interaction.editReply({ 
                content: `Scrim-Konfiguration aktualisiert!\nTag: ${day}\nZeit: ${time}\nMax Spiele: ${maxGames}`, 
                ephemeral: true 
            });
        }
        
        if (interaction.commandName === 'scrim') {
            // Sofortige Antwort um Timeout zu vermeiden
            await interaction.reply({ content: 'Scrim wird erstellt...', ephemeral: true });
            
            // Hole die Parameter
            const day = interaction.options.getString('day');
            const daytime = interaction.options.getString('daytime');
            const games = interaction.options.getInteger('games');
            
            // Konfiguriere Scrim automatisch
            scrimConfig.day = day;
            scrimConfig.time = daytime;
            scrimConfig.maxGames = games;
            
            // Initialisiere scrimSignups als Objekt mit dynamischen Games
            scrimSignups = {};
            for (let i = 1; i <= games; i++) {
                scrimSignups[`game${i}`] = [];
            }
            
            // Lösche alte Scrim-Boards
            for (const key in userCache) delete userCache[key];
            await postScrimSignupWithDelete(interaction.channel);
            
            setTimeout(async () => {
                const embed = await getScrimSignupEmbed(client);
                const buttonRows = getScrimButtonRowsWithControls(client.user.id);
                const channelId = interaction.channel.id;
                if (scrimBoards[channelId]?.messageId && scrimBoards[channelId]?.channelId) {
                    try {
                        const channel = await client.channels.fetch(scrimBoards[channelId]?.channelId);
                        const msg = await channel.messages.fetch(scrimBoards[channelId]?.messageId);
                        await msg.edit({ embeds: [embed], components: buttonRows });
                    } catch (e) {}
                }
            }, 100);
            
            try {
                await interaction.editReply({ 
                    content: `Scrim-Anmeldung wurde erstellt für ${day} um ${daytime} mit ${games} Games.` 
                });
            } catch (error) {
                await handleInteractionError('scrim editReply', error);
            }
        }
        
        if (interaction.commandName === 'practice') {
            // Sofortige Antwort um Timeout zu vermeiden
            await interaction.reply({ content: 'Practice wird erstellt...', ephemeral: true });
            for (const key in userCache) delete userCache[key];
            await postPracticeSignupWithDelete(interaction.channel);
            setTimeout(async () => {
                const embed = await getPracticeSignupEmbed(client);
                const buttonRows = getPracticeButtonRowsWithControls(client.user.id);
                if (practiceMessageId && practiceChannelId) {
                    try {
                        const channel = await client.channels.fetch(practiceChannelId);
                        const msg = await channel.messages.fetch(practiceBoards[channelId].messageId);
                        await msg.edit({ embeds: [embed], components: buttonRows });
                    } catch (e) {}
                }
            }, 100);
            try {
                await interaction.editReply({ content: 'Practice-Anmeldung wurde erstellt.' });
            } catch (error) {
                await handleInteractionError('practice editReply', error);
            }
        }
        if (interaction.commandName === 'abwesend') {
            if (!interaction.guild) {
                await interaction.reply({ 
                    content: 'Dieser Befehl kann nur in einem Server verwendet werden.', 
                    flags: [MessageFlags.Ephemeral] 
                });
                return;
            }
            
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
                    await interaction.reply({ 
                        content: 'Ungültiges Datumsformat! Verwende DD.MM.YYYY (z.B. 17.06.2025)', 
                        flags: [MessageFlags.Ephemeral] 
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
                    await interaction.reply({ 
                        content: 'Ungültiges Datum!', 
                        ephemeral: true 
                    });
                    return;
                }
                
                if (startDate > endDate) {
                    await interaction.reply({ 
                        content: 'Startdatum muss vor dem Enddatum liegen!', 
                        ephemeral: true 
                    });
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
                    await interaction.reply({ 
                        content: 'Du hast bereits eine Abwesenheit für diesen Zeitraum eingetragen!', 
                        ephemeral: true 
                    });
                    return;
                }
                
                // Abwesenheit hinzufügen
                abwesenheiten.push({
                    userId: userId,
                    startDate: startDateISO,
                    endDate: endDateISO,
                    addedAt: getGermanDate().toISOString()
                });
                
                // Backup speichern
                saveSignupBackup();
                
                await interaction.reply({ 
                    content: `Du bist als abwesend markiert von ${startDateStr} bis ${endDateStr}. Du erhältst in dieser Zeit keine DMs oder Erinnerungen.`, 
                    ephemeral: true 
                });
                
                console.log(`Abwesenheit hinzugefügt: ${interaction.user.tag} von ${startDateStr} bis ${endDateStr}`);
                
                // Board nach 0,15 Sekunden aktualisieren
                setTimeout(async () => {
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
                            console.error('Fehler beim Aktualisieren des Premier-Boards nach Abwesenheit hinzufügen:', e);
                        }
                    }
                }, 150);
            }
            
            if (subcommand === 'delete') {
                const deleteType = interaction.options.getString('type');
                // Normale User können nur ihre eigenen Abwesenheiten löschen
                let deleteUserId = interaction.user.id;
                if (deleteType === 'all') {
                    const userAbwesenheiten = abwesenheiten.filter(abw => abw.userId === deleteUserId);
                    if (userAbwesenheiten.length === 0) {
                        await interaction.reply({ 
                            content: 'Du hast keine Abwesenheiten eingetragen.', 
                            ephemeral: true 
                        });
                        return;
                    }
                    abwesenheiten = abwesenheiten.filter(abw => abw.userId !== deleteUserId);
                    saveSignupBackup();
                    await interaction.reply({ 
                        content: `Alle deine Abwesenheiten (${userAbwesenheiten.length} Einträge) wurden gelöscht.`, 
                        ephemeral: true 
                    });
                    console.log(`Alle Abwesenheiten gelöscht: ${interaction.user.tag} (${userAbwesenheiten.length} Einträge)`);
                    setTimeout(async () => {
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
                    }, 150);
                }
                if (deleteType === 'last') {
                    const userAbwesenheiten = abwesenheiten.filter(abw => abw.userId === deleteUserId);
                    if (userAbwesenheiten.length === 0) {
                        await interaction.reply({ 
                            content: 'Du hast keine Abwesenheiten eingetragen.', 
                            ephemeral: true 
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
                        await interaction.reply({ 
                            content: `Deine letzte Abwesenheit (${startFormatted} - ${endFormatted}) wurde gelöscht.`, 
                            ephemeral: true 
                        });
                        console.log(`Letzte Abwesenheit gelöscht: ${interaction.user.tag} (${startFormatted} - ${endFormatted})`);
                        setTimeout(async () => {
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
                        }, 150);
                    } else {
                        await interaction.reply({ 
                            content: 'Fehler beim Löschen der letzten Abwesenheit.', 
                            ephemeral: true 
                        });
                    }
                }
            }
        }

        if (interaction.commandName === 'clear') {
            // Admin-Prüfung
            const member = await interaction.guild.members.fetch(interaction.user.id);
            if (!(await hasAdminPermissions(member))) {
                await interaction.reply({ content: 'Nur Administratoren dürfen diesen Befehl ausführen.', flags: [MessageFlags.Ephemeral] });
                return;
            }
            // Sofortige Antwort um Timeout zu vermeiden
            await interaction.reply({ content: 'Premier-Anmeldung wird gelöscht...', ephemeral: true });
            // User-Cache leeren
            for (const key in userCache) delete userCache[key];
            const channelId = interaction.channel.id;
            if (premierBoards[channelId]?.messageId) {
                await deletePremierMessage();
                setTimeout(async () => {
                    const userId = getFirstSignedUpUserId() || client.user.id;
                    const embed = await getSignupEmbed(client);
                    const buttonRows = getButtonRow(userId);
                    if (premierBoards[channelId]?.messageId && premierBoards[channelId]?.channelId) {
                        try {
                            const channel = await client.channels.fetch(premierBoards[channelId]?.channelId);
                            const msg = await channel.messages.fetch(premierBoards[channelId]?.messageId);
                            await msg.edit({ embeds: [embed], components: buttonRows });
                        } catch (e) {}
                    }
                }, 100);
                await interaction.editReply({ content: 'Premier-Anmeldung gelöscht.' });
            } else {
                await interaction.editReply({ content: 'Keine Premier-Anmeldung gefunden.' });
            }
        }
        if (interaction.commandName === 'premier') {
            // Sofortige Antwort um Timeout zu vermeiden
            await interaction.reply({ content: 'Premier wird erstellt...', ephemeral: true });
            // User-Cache leeren
            for (const key in userCache) delete userCache[key];
            await postPremierSignupWithDelete(interaction.channel);
            const userId = getFirstSignedUpUserId() || client.user.id;
            setTimeout(async () => {
                const embed = await getSignupEmbed(client);
                const buttonRows = getButtonRow(userId);
                const channelId = interaction.channel.id;
                if (premierBoards[channelId]?.messageId && premierBoards[channelId]?.channelId) {
                    try {
                        const channel = await client.channels.fetch(premierBoards[channelId]?.channelId);
                        const msg = await channel.messages.fetch(premierBoards[channelId]?.messageId);
                        await msg.edit({ embeds: [embed], components: buttonRows });
                    } catch (e) {}
                }
            }, 100);
            try {
                await interaction.editReply({ content: 'Premier-Anmeldung wurde erstellt.' });
            } catch (error) {
                await handleInteractionError('premier editReply', error);
            }
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
                // Sofortige Antwort um Timeout zu vermeiden
                await interaction.reply({ content: 'Spieler wird hinzugefügt...', ephemeral: true });
                const userId = interaction.options.getString('user');
                const day = interaction.options.getString('day');
                
                // User-Objekt für Username holen
                let user;
                try {
                    user = await client.users.fetch(userId);
                } catch (error) {
                    await interaction.editReply({ content: 'Spieler wurde nicht gefunden!' });
                    return;
                }
                
                if (signups[day].includes(userId)) {
                    await interaction.editReply({ content: `Spieler ist bereits für ${day} angemeldet!` });
                } else if (signups[day].length < MAX_USERS) {
                    signups[day].push(userId);
                    validateSignupData();
                    // User-Cache leeren
                    for (const key in userCache) delete userCache[key];
                    await sendPremierFoundDM(day);
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
                            } catch (e) {}
                        }
                    }, 100);
                    await interaction.editReply({ content: `Spieler wurde erfolgreich für ${day} hinzugefügt!` });
                } else {
                    await interaction.editReply({ content: `Leider ist kein Platz mehr für ${day} verfügbar!` });
                }
            } else if (subcommand === 'delete') {
                // Sofortige Antwort um Timeout zu vermeiden
                await interaction.reply({ content: 'Spieler wird entfernt...', ephemeral: true });
                const userId = interaction.options.getString('user');
                const day = interaction.options.getString('day');
                
                // User-Objekt für Username holen
                let user;
                try {
                    user = await client.users.fetch(userId);
                } catch (error) {
                    await interaction.editReply({ content: 'Spieler wurde nicht gefunden!' });
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
                            } catch (e) {}
                        }
                    }, 100);
                    await interaction.editReply({ content: `Spieler wurde erfolgreich von ${day} entfernt!` });
                } else {
                    await interaction.editReply({ content: `Spieler ist nicht für ${day} angemeldet!` });
                }
            }
        }
        if (interaction.commandName === 'abwesend-admin') {
            // Admin-Prüfung
            const member = await interaction.guild.members.fetch(interaction.user.id);
            if (!(await hasAdminPermissions(member))) {
                await interaction.reply({ content: 'Nur Administratoren dürfen diesen Befehl ausführen.', flags: [MessageFlags.Ephemeral] });
                return;
            }
            
            const subcommand = interaction.options.getSubcommand();
            if (subcommand === 'add') {
                // Sofortige Antwort um Timeout zu vermeiden
                await interaction.reply({ content: 'Abwesenheit wird hinzugefügt...', ephemeral: true });
                const startDateStr = interaction.options.getString('start');
                const endDateStr = interaction.options.getString('end');
                const userId = interaction.options.getString('user');
                
                // User-Objekt für Username holen
                let user;
                try {
                    user = await client.users.fetch(userId);
                } catch (error) {
                    await interaction.editReply({ content: 'Spieler wurde nicht gefunden!', ephemeral: true });
                    return;
                }
                
                // Datum validieren (DD.MM.YYYY)
                const dateRegex = /^(\d{2})\.(\d{2})\.(\d{4})$/;
                const startMatch = startDateStr.match(dateRegex);
                const endMatch = endDateStr.match(dateRegex);
                
                if (!startMatch || !endMatch) {
                    await interaction.editReply({ 
                        content: 'Ungültiges Datumsformat! Verwende DD.MM.YYYY (z.B. 17.06.2025)', 
                        ephemeral: true 
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
                        content: 'Ungültiges Datum!', 
                        ephemeral: true 
                    });
                    return;
                }
                
                if (startDate > endDate) {
                    await interaction.editReply({ 
                        content: 'Startdatum muss vor dem Enddatum liegen!', 
                        ephemeral: true 
                    });
                    return;
                }
                
                // Verwende lokale Datumsformatierung um Zeitzonenprobleme zu vermeiden
                const startDateISO = `${startDate.getFullYear()}-${String(startDate.getMonth() + 1).padStart(2, '0')}-${String(startDate.getDate()).padStart(2, '0')}`;
                const endDateISO = `${endDate.getFullYear()}-${String(endDate.getMonth() + 1).padStart(2, '0')}-${String(endDate.getDate()).padStart(2, '0')}`;
                
                if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
                    await interaction.editReply({ 
                        content: 'Ungültiges Datum!', 
                        ephemeral: true 
                    });
                    return;
                }
                
                if (startDate > endDate) {
                    await interaction.editReply({ 
                        content: 'Startdatum muss vor dem Enddatum liegen!', 
                        ephemeral: true 
                    });
                    return;
                }
                
                // Prüfe ob bereits eine Abwesenheit für diesen Zeitraum existiert
                const existingIndex = abwesenheiten.findIndex(abw => 
                    abw.userId === userId && 
                    ((abw.startDate <= startDateISO && abw.endDate >= startDateISO) ||
                     (abw.startDate <= endDateISO && abw.endDate >= endDateISO) ||
                     (abw.startDate >= startDateISO && abw.endDate <= endDateISO))
                );
                
                if (existingIndex !== -1) {
                    await interaction.editReply({ 
                        content: 'Der Spieler hat bereits eine Abwesenheit für diesen Zeitraum eingetragen!', 
                        ephemeral: true 
                    });
                    return;
                }
                
                // Abwesenheit hinzufügen
                abwesenheiten.push({
                    userId: userId,
                    startDate: startDateISO,
                    endDate: endDateISO,
                    addedAt: getGermanDate().toISOString()
                });
                
                // Backup speichern
                saveSignupBackup();
                
                await interaction.editReply({ 
                    content: `${user.username} ist als abwesend markiert von ${startDateStr} bis ${endDateStr}.`, 
                    ephemeral: true 
                });
                
                console.log(`Admin-Abwesenheit hinzugefügt: ${user.username} von ${startDateStr} bis ${endDateStr}`);
                
                // Board nach 0,15 Sekunden aktualisieren
                setTimeout(async () => {
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
                            console.error('Fehler beim Aktualisieren des Premier-Boards nach Admin-Abwesenheit hinzufügen:', e);
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
                            console.error('Fehler beim Aktualisieren des Practice-Boards nach Admin-Abwesenheit hinzufügen:', e);
                        }
                    }
                }, 150);
            }
            
            if (subcommand === 'delete') {
                // Sofortige Antwort um Timeout zu vermeiden
                await interaction.reply({ content: 'Abwesenheiten werden gelöscht...', ephemeral: true });
                const deleteType = interaction.options.getString('type');
                const userId = interaction.options.getString('user');
                
                // User-Objekt für Username holen
                let user;
                try {
                    user = await client.users.fetch(userId);
                } catch (error) {
                    await interaction.editReply({ content: 'Spieler wurde nicht gefunden!', ephemeral: true });
                    return;
                }
                
                if (deleteType === 'all') {
                    const userAbwesenheiten = abwesenheiten.filter(abw => abw.userId === userId);
                    if (userAbwesenheiten.length === 0) {
                        await interaction.editReply({ 
                            content: `${user.username} hat keine Abwesenheiten eingetragen.`, 
                            ephemeral: true 
                        });
                        return;
                    }
                    abwesenheiten = abwesenheiten.filter(abw => abw.userId !== userId);
                    saveSignupBackup();
                    await interaction.editReply({ 
                        content: `Alle Abwesenheiten von ${user.username} (${userAbwesenheiten.length} Einträge) wurden gelöscht.`, 
                        ephemeral: true 
                    });
                    console.log(`Admin: Alle Abwesenheiten gelöscht: ${user.username} (${userAbwesenheiten.length} Einträge)`);
                    setTimeout(async () => {
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
                                console.error('Fehler beim Aktualisieren des Premier-Boards nach Admin-Abwesenheit löschen (all):', e);
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
                                console.error('Fehler beim Aktualisieren des Practice-Boards nach Admin-Abwesenheit löschen (all):', e);
                            }
                        }
                    }, 150);
                }
                if (deleteType === 'last') {
                    const userAbwesenheiten = abwesenheiten.filter(abw => abw.userId === userId);
                    if (userAbwesenheiten.length === 0) {
                        await interaction.editReply({ 
                            content: `${user.username} hat keine Abwesenheiten eingetragen.`, 
                            ephemeral: true 
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
                        abw.userId === userId && 
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
                            content: `Die letzte Abwesenheit von ${user.username} (${startFormatted} - ${endFormatted}) wurde gelöscht.`, 
                            ephemeral: true 
                        });
                        console.log(`Admin: Letzte Abwesenheit gelöscht: ${user.username} (${startFormatted} - ${endFormatted})`);
                        setTimeout(async () => {
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
                                    console.error('Fehler beim Aktualisieren des Premier-Boards nach Admin-Abwesenheit löschen (last):', e);
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
                                    console.error('Fehler beim Aktualisieren des Practice-Boards nach Admin-Abwesenheit löschen (last):', e);
                                }
                            }
                        }, 150);
                    } else {
                        await interaction.editReply({ 
                            content: 'Fehler beim Löschen der letzten Abwesenheit.', 
                            ephemeral: true 
                        });
                    }
                }
            }
        }
    }
});

client.login(process.env.DISCORD_TOKEN); 