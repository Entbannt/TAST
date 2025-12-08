const { MongoClient } = require('mongodb');
const axios = require('axios');
const axiosRetry = require('axios-retry');
const fs = require('fs');

// Lade Konfiguration
const basedata = JSON.parse(fs.readFileSync('./basedata.json', 'utf8'));

// MongoDB Client Setup
const mongoclient = new MongoClient(basedata.mongoaccess);
let mongoConnected = false;

// MongoDB Connection mit Error Handling
async function connectMongo() {
    if (!mongoConnected) {
        try {
            await mongoclient.connect();
            mongoConnected = true;
            console.log('✅ MongoDB verbunden');
        } catch (error) {
            console.error('❌ MongoDB Connection Fehler:', error);
            throw error;
        }
    }
    return mongoclient;
}

// Axios Retry Setup für bessere Stabilität
axiosRetry(axios, {
    retries: 3,
    retryDelay: axiosRetry.exponentialDelay,
    shouldResetTimeout: true,
    retryCondition: error => {
        return error.code === 'ECONNABORTED' || 
               error.code === 'ECONNRESET' || 
               error.code === 'ERR_REQUEST_ABORTED' ||
               error.code === 'ETIMEDOUT' ||
               (error.response && error.response.status === 429);
    },
});

// Rank-Definitionen für VALORANT
const roles = [
    'unranked', 'iron', 'bronze', 'silver', 'gold', 
    'platinum', 'diamond', 'ascendant', 'immortal', 'radiant'
];

// Detaillierte Rank-Mappings
const ranks = {
    0: { name: 'Unranked', tier: 0, category: 'unranked' },
    3: { name: 'Iron 1', tier: 1, category: 'iron' },
    4: { name: 'Iron 2', tier: 2, category: 'iron' },
    5: { name: 'Iron 3', tier: 3, category: 'iron' },
    6: { name: 'Bronze 1', tier: 1, category: 'bronze' },
    7: { name: 'Bronze 2', tier: 2, category: 'bronze' },
    8: { name: 'Bronze 3', tier: 3, category: 'bronze' },
    9: { name: 'Silver 1', tier: 1, category: 'silver' },
    10: { name: 'Silver 2', tier: 2, category: 'silver' },
    11: { name: 'Silver 3', tier: 3, category: 'silver' },
    12: { name: 'Gold 1', tier: 1, category: 'gold' },
    13: { name: 'Gold 2', tier: 2, category: 'gold' },
    14: { name: 'Gold 3', tier: 3, category: 'gold' },
    15: { name: 'Platinum 1', tier: 1, category: 'platinum' },
    16: { name: 'Platinum 2', tier: 2, category: 'platinum' },
    17: { name: 'Platinum 3', tier: 3, category: 'platinum' },
    18: { name: 'Diamond 1', tier: 1, category: 'diamond' },
    19: { name: 'Diamond 2', tier: 2, category: 'diamond' },
    20: { name: 'Diamond 3', tier: 3, category: 'diamond' },
    21: { name: 'Ascendant 1', tier: 1, category: 'ascendant' },
    22: { name: 'Ascendant 2', tier: 2, category: 'ascendant' },
    23: { name: 'Ascendant 3', tier: 3, category: 'ascendant' },
    24: { name: 'Immortal 1', tier: 1, category: 'immortal' },
    25: { name: 'Immortal 2', tier: 2, category: 'immortal' },
    26: { name: 'Immortal 3', tier: 3, category: 'immortal' },
    27: { name: 'Radiant', tier: 0, category: 'radiant' },
};

// UUID v4 Generator
function uuidv4() {
    let dt = new Date().getTime();
    const uuid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        let r = (dt + Math.random() * 16) % 16 | 0;
        dt = Math.floor(dt / 16);
        return (c == 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
    return uuid;
}

// Database Helper - Gibt Collection zurück
function getDB(name) {
    return mongoclient.db('VALORANT-LABS').collection(name);
}

// Get User Link from Database
async function getLink(user) {
    try {
        const db = await getDB('linkv2').findOne({ userid: user.id });
        
        if (!db) return null;
        
        const riot = await axios.get(
            `https://americas.api.riotgames.com/riot/account/v1/accounts/by-puuid/${db.rpuuid}`,
            { headers: { 'X-Riot-Token': basedata.riottoken } }
        ).catch(e => e);
        
        if (riot.response) {
            return {
                error: riot.response.status, 
                data: riot.response.data, 
                link: db
            };
        }
        
        return {
            error: false, 
            name: riot.data.gameName, 
            tag: riot.data.tagLine, 
            link: db
        };
    } catch (error) {
        console.error('getLink Error:', error);
        return null;
    }
}

// Get AutoRole Settings for Guild
async function getAutoRoles(guildId) {
    try {
        const guilddata = await getDB('settings').findOne({ gid: guildId });
        
        if (!guilddata || !guilddata.autoroles) {
            return roles.map(role => ({
                name: role,
                id: null,
                configured: false
            }));
        }
        
        return roles.map(role => {
            const roleData = guilddata.autoroles.find(r => r.name === role);
            return {
                name: role,
                id: roleData?.id || null,
                configured: !!roleData
            };
        });
    } catch (error) {
        console.error('getAutoRoles Error:', error);
        return roles.map(role => ({
            name: role,
            id: null,
            configured: false
        }));
    }
}

// Get or Create Guild Settings
async function getGuildSettings(guildId) {
    try {
        let settings = await getDB('settings').findOne({ gid: guildId });
        
        if (!settings) {
            // Erstelle Default Settings
            settings = {
                gid: guildId,
                lang: 'de',
                prefix: '!',
                autoroles: []
            };
            await getDB('settings').insertOne(settings);
        }
        
        return settings;
    } catch (error) {
        console.error('getGuildSettings Error:', error);
        return null;
    }
}

// API Error Handler
function handleAPIError(error, type) {
    const errorMap = {
        403: 'API Key ungültig oder keine Berechtigung',
        404: 'Ressource nicht gefunden',
        429: 'Rate Limit erreicht - zu viele Anfragen',
        500: 'Interner Server Fehler',
        503: 'Service vorübergehend nicht verfügbar'
    };
    
    const status = error.response?.status || 500;
    console.error(`[${type}] API Fehler ${status}: ${errorMap[status] || 'Unbekannter Fehler'}`);
    
    return {
        success: false,
        status: status,
        message: errorMap[status] || 'Ein unbekannter Fehler ist aufgetreten',
        data: error.response?.data
    };
}

// Get Rank Category from Tier Number
function getRankCategory(tierNumber) {
    if (tierNumber == null || tierNumber === 0) return 'unranked';
    
    const rankData = ranks[tierNumber];
    return rankData ? rankData.category : 'unranked';
}

// Initialize MongoDB Indexes
async function initializeDatabase() {
    try {
        await connectMongo();
        
        // State Collection - Auto-Delete nach 24h
        await getDB('state').createIndex(
            { "expireAt": 1 }, 
            { expireAfterSeconds: 0 }
        );
        
        // Performance Indexes
        await getDB('linkv2').createIndex({ "userid": 1 });
        await getDB('linkv2').createIndex({ "puuid": 1 });
        await getDB('linkv2').createIndex({ "rpuuid": 1 });
        await getDB('settings').createIndex({ "gid": 1 });
        await getDB('linkv2-logs').createIndex({ "userid": 1 });
        await getDB('linkv2-logs').createIndex({ "date": -1 });
        
        console.log('✅ MongoDB Indexes erstellt');
        return true;
    } catch (error) {
        console.error('❌ Database Initialization Fehler:', error);
        return false;
    }
}

module.exports = {
    connectMongo,
    mongoclient,
    axios,
    roles,
    ranks,
    uuidv4,
    getDB,
    getLink,
    getAutoRoles,
    getGuildSettings,
    handleAPIError,
    getRankCategory,
    initializeDatabase,
    basedata
};

