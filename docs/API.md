# VALORANT Rank Verification & Auto-Role System
## Vollständige Implementierungsanleitung

Diese Dokumentation enthält alle notwendigen Informationen, um das VALORANT Rank-Verifizierungssystem mit automatischer Discord-Rollenzuweisung in dein eigenes Projekt zu integrieren.

---

## 📋 Inhaltsverzeichnis
1. [Systemarchitektur](#systemarchitektur)
2. [Dependencies](#dependencies)
3. [Datenbankstruktur](#datenbankstruktur)
4. [Implementation Schritte](#implementation-schritte)
5. [Code-Module](#code-module)
6. [API-Endpunkte](#api-endpunkte)
7. [Konfiguration](#konfiguration)
8. [WebSocket Integration](#websocket-integration)
9. [Fehlerbehandlung](#fehlerbehandlung)

---

## 🏗️ Systemarchitektur

### Ablauf der Rank-Verifizierung:

```
Benutzer                Discord Bot              Web Server              Riot API              Henrik API
   |                        |                         |                       |                       |
   |--[1. /autorole]------->|                         |                       |                       |
   |                        |                         |                       |                       |
   |<--[Link generiert]-----|                         |                       |                       |
   |                        |--[UUID in DB]---------->|                       |                       |
   |                        |                         |                       |                       |
   |--[2. Link öffnen]----->|------------------------>|                       |                       |
   |                        |                         |--[OAuth Redirect]---->|                       |
   |<-----------------------------------[Login Page]--|                       |                       |
   |                        |                         |                       |                       |
   |--[3. Login]----------->|------------------------>|----[Auth Token]------>|                       |
   |                        |                         |<--[Access Token]------|                       |
   |                        |                         |                       |                       |
   |                        |                         |--[4. Get PUUID]------>|                       |
   |                        |                         |<--[User Info]---------|                       |
   |                        |                         |                       |                       |
   |                        |                         |--[5. Get Rank]----------------------->|       |
   |                        |                         |<--[MMR Data]-------------------------|       |
   |                        |                         |                       |                       |
   |                        |<--[6. Role Update]------|                       |                       |
   |<--[Rolle zugewiesen]---|                         |                       |                       |
```

### Komponenten:
- **Discord Bot**: Generiert Links und weist Rollen zu
- **Web Server (Fastify)**: Handhabt OAuth-Flow und API-Calls
- **MongoDB**: Speichert User-Links und Logs
- **Riot RSO**: Authentifizierung
- **Henrik API**: VALORANT MMR/Rank Daten

---

## 📦 Dependencies

### Package.json
```json
{
  "dependencies": {
    "discord.js": "^14.x.x",
    "fastify": "^4.x.x",
    "socket.io": "^4.x.x",
    "mongodb": "^6.x.x",
    "axios": "^1.x.x",
    "axios-retry": "^4.x.x",
    "moment": "^2.x.x"
  }
}
```

### Installation:
```bash
npm install discord.js fastify socket.io mongodb axios axios-retry moment
```

---

## 🗄️ Datenbankstruktur

### MongoDB Collections:

#### 1. `state` Collection (Temporäre OAuth-States)
```javascript
{
  userid: "123456789012345678",      // Discord User ID
  guild: "987654321098765432",       // Discord Guild ID
  code: "uuid-v4-string",            // Eindeutiger State-Code
  type: "autorole",                  // Type: 'autorole' | 'link' | 'stats' | 'delete'
  expireAt: ISODate("2024-12-04"),   // Auto-Delete nach 24h
}
```

#### 2. `linkv2` Collection (User-Account-Verknüpfungen)
```javascript
{
  userid: "123456789012345678",      // Discord User ID
  puuid: "ingame-puuid-string",      // VALORANT In-Game PUUID
  rpuuid: "riot-account-puuid",      // Riot Account PUUID
  region: "eu",                      // Region: 'eu' | 'na' | 'ap' | 'kr' etc.
}
```

#### 3. `linkv2-logs` Collection (Audit Logs)
```javascript
{
  userid: "123456789012345678",
  date: ISODate("2024-12-04"),
  admin: null,                       // Bei manueller Zuweisung: Admin User ID
  guild: {
    id: "987654321098765432",
    name: "Server Name"
  },
  event: "add",                      // 'add' | 'update' | 'remove'
  type: "autorole",                  // 'autorole' | 'link' | 'stats'
  rank: {
    name: "Diamond",
    id: "role-id-string"
  },
  riotid: "PlayerName#TAG",
  rpuuid: "riot-account-puuid",
  puuid: "ingame-puuid"
}
```

#### 4. `settings` Collection (Guild-Einstellungen)
```javascript
{
  gid: "987654321098765432",         // Guild ID
  lang: "de",                        // Sprache
  prefix: "!",
  autoroles: [
    { name: "unranked", id: "role-id" },
    { name: "iron", id: "role-id" },
    { name: "bronze", id: "role-id" },
    { name: "silver", id: "role-id" },
    { name: "gold", id: "role-id" },
    { name: "platinum", id: "role-id" },
    { name: "diamond", id: "role-id" },
    { name: "ascendant", id: "role-id" },
    { name: "immortal", id: "role-id" },
    { name: "radiant", id: "role-id" }
  ]
}
```

#### 5. `rso` Collection (RSO Token Management)
```javascript
{
  puuid: "riot-account-puuid"        // Speichert welche Accounts RSO haben
}
```

### MongoDB Indexes:
```javascript
// Auto-Delete für State Collection
db.state.createIndex({ "expireAt": 1 }, { expireAfterSeconds: 86400 })

// Performance Indexes
db.linkv2.createIndex({ "userid": 1 })
db.linkv2.createIndex({ "puuid": 1 })
db.linkv2.createIndex({ "rpuuid": 1 })
db.settings.createIndex({ "gid": 1 })
```

---

## 🔧 Implementation Schritte

### Schritt 1: Basis-Setup

#### `methods.js` - Core Helper Functions
```javascript
import {MongoClient} from 'mongodb';
import axios from 'axios';
import axiosRetry from 'axios-retry';
import {readFileSync} from 'fs';

const basedata = JSON.parse(readFileSync('./basedata.json'));
const mongoclient = new MongoClient(basedata.mongoaccess);
await mongoclient.connect();

// Axios Retry Setup
axiosRetry(axios, {
    retries: 2,
    shouldResetTimeout: true,
    retryCondition: error => {
        return error.code === 'ECONNABORTED' || 
               error.code === 'ECONNRESET' || 
               error.code === 'ERR_REQUEST_ABORTED';
    },
});

// Rank-Definitionen
export const roles = [
    'unranked', 'iron', 'bronze', 'silver', 'gold', 
    'platinum', 'diamond', 'ascendant', 'immortal', 'radiant'
];

export const ranks = {
    0: { name: 'Unranked', tier: 0 },
    3: { name: 'Iron 1', tier: 1 },
    4: { name: 'Iron 2', tier: 2 },
    5: { name: 'Iron 3', tier: 3 },
    6: { name: 'Bronze 1', tier: 1 },
    7: { name: 'Bronze 2', tier: 2 },
    8: { name: 'Bronze 3', tier: 3 },
    9: { name: 'Silver 1', tier: 1 },
    10: { name: 'Silver 2', tier: 2 },
    11: { name: 'Silver 3', tier: 3 },
    12: { name: 'Gold 1', tier: 1 },
    13: { name: 'Gold 2', tier: 2 },
    14: { name: 'Gold 3', tier: 3 },
    15: { name: 'Platinum 1', tier: 1 },
    16: { name: 'Platinum 2', tier: 2 },
    17: { name: 'Platinum 3', tier: 3 },
    18: { name: 'Diamond 1', tier: 1 },
    19: { name: 'Diamond 2', tier: 2 },
    20: { name: 'Diamond 3', tier: 3 },
    21: { name: 'Ascendant 1', tier: 1 },
    22: { name: 'Ascendant 2', tier: 2 },
    23: { name: 'Ascendant 3', tier: 3 },
    24: { name: 'Immortal 1', tier: 1 },
    25: { name: 'Immortal 2', tier: 2 },
    26: { name: 'Immortal 3', tier: 3 },
    27: { name: 'Radiant', tier: 0 },
};

// UUID Generator
export const uuidv4 = function () {
    let dt = new Date().getTime();
    const uuid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        let r = (dt + Math.random() * 16) % 16 | 0;
        dt = Math.floor(dt / 16);
        return (c == 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
    return uuid;
};

// Database Helper
export const getDB = function (name) {
    return mongoclient.db('VALORANT-LABS').collection(name);
};

// Axios Export
export {axios};
export const riottoken = basedata.riottoken;
```

---

### Schritt 2: Discord Bot Commands

#### `commands/buttons/autoroles.js` - Discord Interaction Handler
```javascript
import {uuidv4, getDB, axios, roles} from '../../methods.js';

export async function execute({interaction, args, guilddata} = {}) {
    await interaction.deferReply({ephemeral: true});
    
    switch (args[1]) {
        case 'generate': {
            // Link für Rank-Verifizierung generieren
            const uuid = uuidv4();
            await getDB('state').insertOne({
                userid: interaction.user.id, 
                guild: interaction.guildId, 
                code: uuid, 
                expireAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 Stunden ab jetzt
                type: 'autorole'
            });
            
            return interaction.editReply({
                embeds: [{
                    title: '🔗 Verifizierungs-Link erstellt',
                    description: `Klicke auf den Link um deinen VALORANT Rang zu verifizieren:\n\nhttps://deine-domain.xyz/v1/rso/redirect/${uuid}`,
                    color: 0xff4654,
                    footer: { text: 'Link ist 24 Stunden gültig' }
                }]
            });
        }
        
        case 'update': {
            // Rank aktualisieren
            const link = await getDB('linkv2').findOne({userid: interaction.user.id});
            
            if (!link) {
                return interaction.editReply({
                    embeds: [{
                        title: '❌ Kein Account verknüpft',
                        description: 'Du musst zuerst deinen VALORANT Account verknüpfen!',
                        color: 0xff0000
                    }]
                });
            }
            
            // MMR abrufen
            const mmr = await axios.get(
                `https://api.henrikdev.xyz/valorant/v2/by-puuid/mmr/${link.region}/${link.puuid}?asia=true`
            ).catch(e => e);
            
            if (mmr.response) {
                return interaction.editReply({
                    embeds: [{
                        title: '❌ Fehler beim Abrufen des Ranks',
                        description: 'Versuche es später erneut.',
                        color: 0xff0000
                    }]
                });
            }
            
            // Unranked Check
            if (mmr.data.data.current_data.currenttier == null || 
                mmr.data.data.current_data.games_needed_for_rating != 0) {
                
                if (guilddata.autoroles.some(i => i.name == 'unranked')) {
                    await interaction.member.roles.remove(
                        guilddata.autoroles.filter(i => i.name != 'unranked').map(i => i.id)
                    );
                    await interaction.member.roles.add(
                        guilddata.autoroles.find(i => i.name == 'unranked').id
                    );
                }
                
                return interaction.editReply({
                    embeds: [{
                        title: '⚠️ Unranked',
                        description: 'Du hast noch keinen Rang. Spiele deine Platzierungsspiele!',
                        color: 0xffa500
                    }]
                });
            }
            
            // Rank-Rolle zuweisen
            const currentRank = mmr.data.data.current_data.currenttierpatched.split(' ')[0].toLowerCase();
            const roleToAdd = guilddata.autoroles.find(item => item.name === currentRank);
            const rolesToRemove = guilddata.autoroles
                .filter(item => item.name !== currentRank)
                .map(item => item.id);
            
            if (!roleToAdd) {
                return interaction.editReply({
                    embeds: [{
                        title: '❌ Rang nicht konfiguriert',
                        description: `Die Rolle für ${currentRank} ist nicht eingerichtet.`,
                        color: 0xff0000
                    }]
                });
            }
            
            await interaction.member.roles.remove(rolesToRemove);
            await interaction.member.roles.add(roleToAdd.id);
            
            // Log speichern
            await getDB('linkv2-logs').insertOne({
                userid: interaction.user.id,
                date: new Date(),
                admin: null,
                guild: {id: interaction.guildId, name: interaction.guild.name},
                event: 'update',
                type: 'autorole',
                rank: {
                    name: mmr.data.data.current_data.currenttierpatched.split(' ')[0],
                    id: roleToAdd.id,
                },
                riotid: `${interaction.user.tag}`,
                rpuuid: link.rpuuid,
                puuid: link.puuid,
            });
            
            return interaction.editReply({
                embeds: [{
                    title: '✅ Rang aktualisiert',
                    description: `Deine Rolle wurde auf **${mmr.data.data.current_data.currenttierpatched}** (${mmr.data.data.current_data.elo} ELO) aktualisiert!`,
                    color: 0x00ff00
                }]
            });
        }
        
        case 'remove': {
            // Alle Rank-Rollen entfernen
            await interaction.member.roles.remove(
                guilddata.autoroles.map(item => item.id)
            );
            
            await getDB('linkv2-logs').insertOne({
                userid: interaction.user.id,
                date: new Date(),
                admin: null,
                guild: {id: interaction.guildId, name: interaction.guild.name},
                event: 'remove',
                type: 'autorole',
                rank: null,
                riotid: null,
                rpuuid: null,
                puuid: null,
            });
            
            return interaction.editReply({
                embeds: [{
                    title: '🗑️ Rollen entfernt',
                    description: 'Alle Rank-Rollen wurden entfernt.',
                    color: 0x808080
                }]
            });
        }
    }
}

export const name = 'autoroles';
```

---

### Schritt 3: Web Server (RSO OAuth Flow)

#### `routes/rso.js` - OAuth & Role Assignment Handler
```javascript
import {getDB, axios} from '../methods.js';

export const steps = {
    autorole: [
        {step: 0, name: 'FETCH_TOKENS'},
        {step: 1, name: 'FETCH_USERINFO'},
        {step: 2, name: 'FETCH_REGION'},
        {step: 3, name: 'FETCH_ACCOUNT'},
        {step: 4, name: 'FETCH_MMR'},
        {step: 5, name: 'APPLY_ROLE'},
        {step: 6, name: 'SET_RSO_DB'},
        {step: 7, name: 'SET_LINK_DB'},
        {step: 8, name: 'WRITING_LOGS'},
        {step: 9, name: 'DELETE_STATE_DB'},
        {step: 10, name: 'DONE'},
    ],
};

export default async function (fastify, opts, done) {
    const basedata = {
        client_secret: 'YOUR_RIOT_CLIENT_ID:YOUR_RIOT_CLIENT_SECRET',
        riottoken: 'YOUR_RIOT_API_TOKEN'
    };
    
    // Redirect zu Riot OAuth
    fastify.get('/v1/rso/redirect/:state', async (req, res) => {
        const redirectUri = encodeURIComponent('https://deine-domain.xyz/oauth-finished.html');
        const riotAuthUrl = `https://auth.riotgames.com/authorize` +
            `?client_id=YOUR_CLIENT_ID` +
            `&redirect_uri=${redirectUri}` +
            `&response_type=code` +
            `&scope=openid offline_access` +
            `&state=${req.params.state}`;
        
        res.redirect(301, riotAuthUrl);
    });
    
    // OAuth Callback Handler
    fastify.get('/oauth-finished.html', async (req, res) => {
        const manager = fastify.discordClient.cluster;
        
        if (!req.query.state) {
            return res.redirect(`/rso?uuid=null`);
        }
        
        const fstate = await getDB('state').findOne({code: req.query.state});
        
        if (!fstate) {
            return res.redirect(`/rso?error=invalid_state`);
        }
        
        res.redirect(`/rso?uuid=${req.query.state}`);
        
        // STEP 0: Token Exchange
        const formData = new URLSearchParams();
        formData.append('grant_type', 'authorization_code');
        formData.append('code', req.query.code);
        formData.append('redirect_uri', 'https://deine-domain.xyz/oauth-finished.html');
        
        const tokens = await axios.post('https://auth.riotgames.com/token', formData, {
            headers: {
                'Authorization': `Basic ${Buffer.from(basedata.client_secret).toString('base64')}`,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
        }).catch(e => e);
        
        if (tokens.response) {
            console.error('Token Error:', tokens.response.data);
            return;
        }
        
        // STEP 1: Get User Info
        const userinfo = await axios.get(
            'https://americas.api.riotgames.com/riot/account/v1/accounts/me',
            {
                headers: {Authorization: `Bearer ${tokens.data.access_token}`},
            }
        ).catch(e => e);
        
        if (userinfo.response) {
            console.error('UserInfo Error:', userinfo.response.data);
            return;
        }
        
        // STEP 2: Get Region/Shard
        const region = await axios.get(
            `https://americas.api.riotgames.com/riot/account/v1/active-shards/by-game/val/by-puuid/${userinfo.data.puuid}`,
            {
                headers: {'X-Riot-Token': basedata.riottoken},
            }
        ).catch(e => e);
        
        if (region.response) {
            console.error('Region Error:', region.response.data);
            return;
        }
        
        // STEP 3: Get Account Data via Henrik API
        const accountData = await axios.get(
            `https://api.henrikdev.xyz/valorant/v1/account/${encodeURI(userinfo.data.gameName)}/${encodeURI(userinfo.data.tagLine)}?asia=true`
        ).catch(e => e);
        
        if (accountData.response) {
            console.error('Account Error:', accountData.response.data);
            return;
        }
        
        if (fstate.type === 'autorole') {
            const guilddata = await getDB('settings').findOne({gid: fstate.guild});
            
            // STEP 4: Get MMR/Rank
            const mmr = await axios.get(
                `https://api.henrikdev.xyz/valorant/v2/by-puuid/mmr/${region.data.activeShard}/${accountData.data.data.puuid}?asia=true`
            ).catch(e => e);
            
            if (mmr.response) {
                console.error('MMR Error:', mmr.response.data);
                return;
            }
            
            // STEP 5: Apply Role - Unranked Check
            if (mmr.data.data.current_data.currenttier == null || 
                mmr.data.data.current_data.games_needed_for_rating != 0) {
                
                if (guilddata.autoroles.some(i => i.name == 'unranked')) {
                    await manager.broadcastEval(
                        async (client, {user, guild, ra, rm}) => {
                            if (client.guilds.cache.has(guild)) {
                                const member = await client.guilds.cache
                                    .get(guild)
                                    .members.fetch(user)
                                    .catch(e => console.log(e));
                                
                                await member?.roles?.remove(rm).catch(e => console.log(e));
                                await member?.roles?.add(ra).catch(e => console.log(e));
                            }
                        },
                        {
                            context: {
                                user: fstate.userid,
                                guild: fstate.guild,
                                ra: guilddata.autoroles.find(i => i.name == 'unranked').id,
                                rm: guilddata.autoroles.filter(i => i.name != 'unranked').map(i => i.id),
                            },
                        }
                    );
                }
                
                await getDB('state').deleteOne({code: req.query.state});
                return;
            }
            
            // STEP 5: Apply Role - Ranked
            const currentRank = mmr.data.data.current_data.currenttierpatched.split(' ')[0].toLowerCase();
            
            if (!guilddata.autoroles.some(item => item.name === currentRank)) {
                console.error('Rank not configured:', currentRank);
                await getDB('state').deleteOne({code: req.query.state});
                return;
            }
            
            await manager.broadcastEval(
                async (client, {user, guild, ra, rm}) => {
                    if (client.guilds.cache.has(guild)) {
                        const member = await client.guilds.cache
                            .get(guild)
                            .members.fetch(user)
                            .catch(e => console.log(e));
                        
                        await member?.roles?.remove(rm).catch(e => console.log(e));
                        await member?.roles?.add(ra).catch(e => console.log(e));
                    }
                },
                {
                    context: {
                        user: fstate.userid,
                        guild: fstate.guild,
                        ra: guilddata.autoroles.find(item => item.name === currentRank).id,
                        rm: guilddata.autoroles
                            .filter(item => item.name !== currentRank)
                            .map(item => item.id),
                    },
                }
            ).catch(e => {
                console.error('Role Assignment Error:', e);
            });
            
            // STEP 6: Save RSO DB
            await getDB('rso').updateOne(
                {puuid: userinfo.data.puuid}, 
                {$set: {puuid: userinfo.data.puuid}}, 
                {upsert: true}
            );
            
            // STEP 7: Save Link DB
            await getDB('linkv2').updateOne(
                {userid: fstate.userid},
                {
                    $set: {
                        puuid: accountData.data.data.puuid,
                        rpuuid: userinfo.data.puuid,
                        region: region.data.activeShard
                    }
                },
                {upsert: true}
            );
            
            // STEP 8: Write Log
            await getDB('linkv2-logs').insertOne({
                userid: fstate.userid,
                date: new Date(),
                admin: null,
                guild: {id: fstate.guild, name: null},
                event: 'add',
                type: 'autorole',
                rank: {
                    name: mmr.data.data.current_data.currenttierpatched.split(' ')[0],
                    id: guilddata.autoroles.find(item => item.name === currentRank).id,
                },
                riotid: `${userinfo.data.gameName}#${userinfo.data.tagLine}`,
                rpuuid: userinfo.data.puuid,
                puuid: accountData.data.data.puuid,
            });
            
            // STEP 9: Delete State
            await getDB('state').deleteOne({code: req.query.state});
        }
        
        return;
    });
}
```

---

### Schritt 4: Helper Methods

#### `methods/getLink.js` - Get User Link
```javascript
import {getDB, axios, riottoken} from '../methods.js';

export const getLink = async function ({user} = {}) {
    const db = await getDB('linkv2').findOne({userid: user.id});
    
    if (!db) return null;
    
    const riot = await axios.get(
        `https://americas.api.riotgames.com/riot/account/v1/accounts/by-puuid/${db.rpuuid}`,
        {headers: {'X-Riot-Token': riottoken}}
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
};
```

#### `methods/getAutoRoles.js` - Get AutoRole Settings
```javascript
import {getDB, roles} from '../methods.js';

export const getAutoRoles = async function ({guildId} = {}) {
    const guilddata = await getDB('settings').findOne({gid: guildId});
    
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
};
```

---

## 🌐 API-Endpunkte

### Riot Games APIs:

#### 1. **OAuth Authorization**
```
GET https://auth.riotgames.com/authorize
Parameters:
  - client_id: Deine Riot Client ID
  - redirect_uri: Callback URL (URL-encoded)
  - response_type: "code"
  - scope: "openid offline_access"
  - state: UUID für State-Tracking
```

#### 2. **Token Exchange**
```
POST https://auth.riotgames.com/token
Headers:
  - Authorization: Basic base64(client_id:client_secret)
  - Content-Type: application/x-www-form-urlencoded
Body:
  - grant_type: "authorization_code"
  - code: Authorization Code
  - redirect_uri: Callback URL
```

#### 3. **Get User Info**
```
GET https://americas.api.riotgames.com/riot/account/v1/accounts/me
Headers:
  - Authorization: Bearer {access_token}
Response:
  {
    "puuid": "string",
    "gameName": "string",
    "tagLine": "string"
  }
```

#### 4. **Get Active Shard**
```
GET https://americas.api.riotgames.com/riot/account/v1/active-shards/by-game/val/by-puuid/{puuid}
Headers:
  - X-Riot-Token: {api_key}
Response:
  {
    "puuid": "string",
    "game": "val",
    "activeShard": "eu" | "na" | "ap" | "kr"
  }
```

### Henrik Dev APIs:

#### 5. **Get Account by Name**
```
GET https://api.henrikdev.xyz/valorant/v1/account/{name}/{tag}
Parameters:
  - asia: true (für bessere Performance)
Response:
  {
    "status": 200,
    "data": {
      "puuid": "string",
      "region": "string",
      "account_level": number,
      "name": "string",
      "tag": "string"
    }
  }
```

#### 6. **Get MMR by PUUID**
```
GET https://api.henrikdev.xyz/valorant/v2/by-puuid/mmr/{region}/{puuid}
Parameters:
  - asia: true
Response:
  {
    "status": 200,
    "data": {
      "current_data": {
        "currenttier": number,
        "currenttierpatched": "Diamond 2",
        "images": {...},
        "ranking_in_tier": number,
        "mmr_change_to_last_game": number,
        "elo": number,
        "games_needed_for_rating": number,
        "old": boolean
      },
      "name": "string",
      "tag": "string"
    }
  }
```

### Tier Mapping:
```javascript
const tierMapping = {
    0-2: 'Unranked',
    3-5: 'Iron',
    6-8: 'Bronze',
    9-11: 'Silver',
    12-14: 'Gold',
    15-17: 'Platinum',
    18-20: 'Diamond',
    21-23: 'Ascendant',
    24-26: 'Immortal',
    27: 'Radiant'
};
```

---

## ⚙️ Konfiguration

### `basedata.json` - Konfigurationsdatei
```json
{
  "mongoaccess": "mongodb://localhost:27017",
  "riottoken": "RGAPI-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "client_secret": "your-riot-client-id:your-riot-client-secret",
  "redirect_uri": "https://deine-domain.xyz/oauth-finished.html",
  "bot_token": "your-discord-bot-token"
}
```

### Riot Developer Portal Setup:

1. **Registriere deine App**: https://developer.riotgames.com/
2. **API Key erhalten**: Production API Key beantragen
3. **OAuth App erstellen**:
   - App Name: Dein Bot Name
   - Redirect URI: `https://deine-domain.xyz/oauth-finished.html`
   - Scopes: `openid`, `offline_access`
4. **Client ID & Secret** kopieren

### Discord Bot Permissions:
```
Required Permissions:
  - Manage Roles (268435456)
  - View Channels (1024)
  - Send Messages (2048)
  - Embed Links (16384)
  - Read Message History (65536)
  - Use Slash Commands (2147483648)

Bot Invite Link:
https://discord.com/api/oauth2/authorize?client_id=YOUR_BOT_ID&permissions=268503040&scope=bot%20applications.commands
```

---

## 🔌 WebSocket Integration (Optional)

Für Real-Time Status Updates während des OAuth-Flows:

### Server-Side (Fastify + Socket.io):
```javascript
import fastifySocketIO from 'fastify-socket.io';

// In deinem Fastify Setup
await fastify.register(fastifySocketIO, {
    cors: {
        origin: "https://deine-domain.xyz",
        methods: ["GET", "POST"]
    }
});

// Socket.IO Handler
fastify.io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);
    
    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
    });
});

// In RSO Route - Step Updates senden
const stepUpdate = async (socket, data, uuid) => {
    await socket.emit('STEP_UPDATE', data);
    // Optional: In DB speichern für persistence
};
```

### Client-Side (Frontend):
```html
<!DOCTYPE html>
<html>
<head>
    <title>VALORANT Verifizierung</title>
    <script src="/socket.io/socket.io.js"></script>
</head>
<body>
    <div id="status">Verbinde...</div>
    <div id="progress"></div>
    
    <script>
        const urlParams = new URLSearchParams(window.location.search);
        const uuid = urlParams.get('uuid');
        
        if (!uuid) {
            document.getElementById('status').textContent = 'Fehler: Kein State';
        } else {
            const socket = io('/', {
                query: { rso: uuid }
            });
            
            socket.on('connect', () => {
                document.getElementById('status').textContent = 'Verbunden';
            });
            
            socket.on('STEP_UPDATE', (data) => {
                console.log('Step:', data);
                document.getElementById('progress').innerHTML += 
                    `<p>[${data.step}] ${data.name}: ${data.success ? '✅' : '❌'}</p>`;
                
                if (data.name === 'DONE' && data.success) {
                    document.getElementById('status').textContent = 
                        '✅ Verifizierung erfolgreich! Du kannst Discord schließen.';
                }
            });
            
            socket.on('UNKNOWN_STATE', () => {
                document.getElementById('status').textContent = 
                    '❌ Ungültiger State - Bitte generiere einen neuen Link';
            });
        }
    </script>
</body>
</html>
```

---

## ⚠️ Fehlerbehandlung

### Häufige Fehler und Lösungen:

#### 1. **403 Forbidden - Riot API**
```javascript
if (response.status === 403) {
    // API Key ist ungültig oder abgelaufen
    console.error('Riot API Key ungültig');
    // Lösung: Neuen API Key generieren
}
```

#### 2. **429 Rate Limit**
```javascript
if (response.status === 429) {
    const retryAfter = response.headers['retry-after'];
    console.log(`Rate Limited. Retry nach ${retryAfter} Sekunden`);
    // Lösung: Axios-Retry implementiert automatisches Retry
}
```

#### 3. **404 Player Not Found**
```javascript
if (mmr.response?.status === 404) {
    // Spieler hat noch keine Competitive Games
    return {
        error: 'NO_COMPETITIVE_DATA',
        message: 'Spiele mindestens 1 Competitive Match'
    };
}
```

#### 4. **50013 Missing Permissions (Discord)**
```javascript
try {
    await member.roles.add(roleId);
} catch (error) {
    if (error.code === 50013) {
        // Bot-Rolle muss ÜBER den Rank-Rollen sein
        console.error('Bot hat keine Permission - Rolle zu hoch in Hierarchie');
    }
}
```

#### 5. **Invalid OAuth State**
```javascript
const fstate = await getDB('state').findOne({code: req.query.state});
if (!fstate) {
    // State ist abgelaufen (>24h) oder existiert nicht
    return res.redirect('/error?code=INVALID_STATE');
}
```

### Error Handler Function:
```javascript
export const handleAPIError = function(error, type) {
    const errorMap = {
        403: 'API Key ungültig',
        404: 'Ressource nicht gefunden',
        429: 'Rate Limit erreicht',
        500: 'Server Fehler',
        503: 'Service nicht verfügbar'
    };
    
    console.error(`[${type}] ${error.response?.status}: ${errorMap[error.response?.status] || 'Unbekannter Fehler'}`);
    
    return {
        success: false,
        status: error.response?.status || 500,
        message: errorMap[error.response?.status] || 'Ein Fehler ist aufgetreten',
        data: error.response?.data
    };
};
```

---

## 📝 Testing Checklist

### Pre-Production Tests:

- [ ] MongoDB Connection funktioniert
- [ ] Riot API Key ist gültig
- [ ] OAuth Redirect URI ist korrekt konfiguriert
- [ ] Discord Bot hat Manage Roles Permission
- [ ] Bot-Rolle ist ÜBER allen Rank-Rollen in der Hierarchie
- [ ] Alle 10 Rank-Rollen sind im `settings` document konfiguriert
- [ ] Link Generation funktioniert
- [ ] OAuth Flow redirected korrekt
- [ ] Token Exchange funktioniert
- [ ] User Info wird abgerufen
- [ ] Region wird erkannt
- [ ] MMR wird korrekt abgerufen
- [ ] Rollen werden korrekt zugewiesen
- [ ] Alte Rollen werden entfernt
- [ ] Unranked Case funktioniert
- [ ] Update Funktion funktioniert
- [ ] Remove Funktion funktioniert
- [ ] Logs werden korrekt gespeichert
- [ ] State wird nach 24h automatisch gelöscht

### Test Commands:
```bash
# MongoDB Connection Test
node -e "import('./methods.js').then(m => m.getDB('settings').findOne({})).then(console.log)"

# Riot API Test
curl -X GET "https://americas.api.riotgames.com/riot/account/v1/accounts/by-riot-id/TestUser/EUW" \
  -H "X-Riot-Token: YOUR_API_KEY"

# Henrik API Test
curl "https://api.henrikdev.xyz/valorant/v1/account/TestUser/EUW"
```

---

## 🚀 Deployment

### Server Requirements:
- **Node.js**: v18+ empfohlen
- **MongoDB**: v6.0+
- **RAM**: Minimum 512MB, empfohlen 1GB+
- **SSL**: HTTPS erforderlich für OAuth

### Environment Variables (.env):
```env
NODE_ENV=production
MONGO_URI=mongodb://localhost:27017/valorant-labs
RIOT_API_KEY=RGAPI-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
RIOT_CLIENT_ID=your-client-id
RIOT_CLIENT_SECRET=your-client-secret
DISCORD_BOT_TOKEN=your-bot-token
REDIRECT_URI=https://deine-domain.xyz/oauth-finished.html
PORT=3000
```

### PM2 Ecosystem (pm2.config.js):
```javascript
module.exports = {
  apps: [{
    name: 'valorant-bot',
    script: './index.js',
    instances: 1,
    exec_mode: 'fork',
    watch: false,
    max_memory_restart: '500M',
    env: {
      NODE_ENV: 'production'
    },
    error_file: './logs/err.log',
    out_file: './logs/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z'
  }]
};
```

### Start Commands:
```bash
# Development
npm run dev

# Production mit PM2
pm2 start pm2.config.js
pm2 save
pm2 startup

# Docker (Optional)
docker-compose up -d
```

### Nginx Reverse Proxy:
```nginx
server {
    listen 443 ssl http2;
    server_name deine-domain.xyz;
    
    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;
    
    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
    
    # WebSocket Support
    location /socket.io/ {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

---

## 📊 Monitoring & Logs

### Log Structure:
```javascript
// Winston Logger Setup
import winston from 'winston';

const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    transports: [
        new winston.transports.File({ filename: 'error.log', level: 'error' }),
        new winston.transports.File({ filename: 'combined.log' }),
        new winston.transports.Console({
            format: winston.format.simple()
        })
    ]
});

// Usage
logger.info('User verified', {
    userId: '123456789',
    rank: 'Diamond 2',
    elo: 2150
});

logger.error('OAuth failed', {
    error: error.message,
    state: uuid
});
```

### Metrics to Track:
- Erfolgreiche Verifizierungen pro Tag
- OAuth Fehlerrate
- API Response Times (Riot, Henrik)
- Rate Limit Hits
- Durchschnittliche Rank-Verteilung
- Aktive Verknüpfungen

---

## 🔒 Security Best Practices

1. **Niemals Tokens im Client speichern**
2. **State Codes haben 24h TTL**
3. **Riot API Keys rotieren** (alle 90 Tage)
4. **MongoDB Authentication aktivieren**
5. **Rate Limiting auf API Endpunkten**
6. **Input Validation für alle User Inputs**
7. **CORS korrekt konfigurieren**
8. **Sensitive Logs nicht loggen** (Tokens, Secrets)

---

## 📚 Additional Resources

### Official Documentation:
- [Riot Developer Portal](https://developer.riotgames.com/)
- [Riot Games API Docs](https://developer.riotgames.com/docs/portal)
- [Henrik Dev API Docs](https://docs.henrikdev.xyz/)
- [Discord.js Guide](https://discordjs.guide/)
- [Fastify Documentation](https://www.fastify.io/)

### Community:
- [Riot API Discord](https://discord.gg/riotgamesdevrel)
- [VALORANT API Discord](https://discord.gg/X3GaVkX2YN)

---

## 💡 Optimization Tips

### 1. Caching Strategy:
```javascript
// Redis Cache für MMR Data
import Redis from 'ioredis';
const redis = new Redis();

async function getCachedMMR(puuid, region) {
    const cacheKey = `mmr:${region}:${puuid}`;
    const cached = await redis.get(cacheKey);
    
    if (cached) {
        return JSON.parse(cached);
    }
    
    const mmr = await axios.get(`https://api.henrikdev.xyz/...`);
    await redis.setex(cacheKey, 300, JSON.stringify(mmr.data)); // 5 min cache
    
    return mmr.data;
}
```

### 2. Batch Role Updates:
```javascript
// Statt einzelne Updates, batch mehrere User
async function batchUpdateRoles(users) {
    const updates = users.map(user => 
        member.roles.set([...newRoles, ...existingRoles])
    );
    
    await Promise.all(updates);
}
```

### 3. Database Indexes:
```javascript
// Compound Index für schnellere Queries
db.linkv2.createIndex({ userid: 1, region: 1 });
db['linkv2-logs'].createIndex({ guild.id: 1, date: -1 });
```

---

## ✅ Fertig!

Du hast jetzt alle Informationen um das VALORANT Rank Verification System in dein eigenes Projekt zu integrieren!

### Quick Start:
1. Dependencies installieren
2. `basedata.json` konfigurieren
3. MongoDB setup
4. Riot Developer Portal App erstellen
5. Discord Bot erstellen
6. Code implementieren
7. Testen
8. Deployen

**Viel Erfolg! 🎮**

