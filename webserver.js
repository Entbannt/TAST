const fastify = require('fastify')({ logger: false });
const path = require('path');
const { getDB, axios, basedata, getGuildSettings, getRankCategory } = require('./methods.js');

// Serve Static Files
fastify.register(require('@fastify/static'), {
    root: path.join(__dirname, 'public'),
    prefix: '/',
});

// CORS Support
fastify.register(require('@fastify/cors'), {
    origin: true,
    credentials: true
});

// Socket.IO für Real-Time Updates (optional)
fastify.register(require('fastify-socket.io'), {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// OAuth Steps Definition
const steps = {
    autorole: [
        { step: 0, name: 'FETCH_TOKENS' },
        { step: 1, name: 'FETCH_USERINFO' },
        { step: 2, name: 'FETCH_REGION' },
        { step: 3, name: 'FETCH_ACCOUNT' },
        { step: 4, name: 'FETCH_MMR' },
        { step: 5, name: 'APPLY_ROLE' },
        { step: 6, name: 'SET_RSO_DB' },
        { step: 7, name: 'SET_LINK_DB' },
        { step: 8, name: 'WRITING_LOGS' },
        { step: 9, name: 'DELETE_STATE_DB' },
        { step: 10, name: 'DONE' },
    ],
};

// Redirect zu Riot OAuth
fastify.get('/v1/rso/redirect/:state', async (req, res) => {
    try {
        const state = req.params.state;
        
        // Prüfe ob State existiert
        const fstate = await getDB('state').findOne({ code: state });
        
        if (!fstate) {
            return res.redirect('/rso?error=invalid_state');
        }
        
        const redirectUri = encodeURIComponent(`${basedata.domain}/oauth-finished.html`);
        const riotAuthUrl = 
            `https://auth.riotgames.com/authorize` +
            `?client_id=${basedata.client_id}` +
            `&redirect_uri=${redirectUri}` +
            `&response_type=code` +
            `&scope=openid offline_access` +
            `&state=${state}`;
        
        return res.redirect(riotAuthUrl);
    } catch (error) {
        console.error('Redirect Error:', error);
        return res.redirect('/rso?error=server_error');
    }
});

// OAuth Callback Handler
fastify.get('/oauth-finished.html', async (req, res) => {
    try {
        const { code, state } = req.query;
        
        if (!state || !code) {
            return res.redirect('/rso?error=missing_params');
        }
        
        const fstate = await getDB('state').findOne({ code: state });
        
        if (!fstate) {
            return res.redirect('/rso?error=invalid_state');
        }
        
        // Starte OAuth Flow im Hintergrund
        processOAuthFlow(code, state, fstate, fastify.io).catch(console.error);
        
        // Redirect zu Status-Seite
        return res.redirect(`/rso?uuid=${state}`);
        
    } catch (error) {
        console.error('OAuth Callback Error:', error);
        return res.redirect('/rso?error=server_error');
    }
});

// OAuth Flow Processor
async function processOAuthFlow(code, state, fstate, io) {
    const client = fastify.discordClient;
    
    try {
        // STEP 0: Token Exchange
        console.log(`[${state}] Step 0: Fetching Tokens`);
        
        const formData = new URLSearchParams();
        formData.append('grant_type', 'authorization_code');
        formData.append('code', code);
        formData.append('redirect_uri', `${basedata.domain}/oauth-finished.html`);
        
        const authString = `${basedata.client_id}:${basedata.client_secret}`;
        const base64Auth = Buffer.from(authString).toString('base64');
        
        const tokens = await axios.post('https://auth.riotgames.com/token', formData, {
            headers: {
                'Authorization': `Basic ${base64Auth}`,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
        }).catch(e => {
            console.error('Token Error:', e.response?.data || e.message);
            return e;
        });
        
        if (tokens.response) {
            io.emit('STEP_UPDATE', { step: 0, name: 'FETCH_TOKENS', success: false });
            return;
        }
        
        io.emit('STEP_UPDATE', { step: 0, name: 'FETCH_TOKENS', success: true });
        
        // STEP 1: Get User Info
        console.log(`[${state}] Step 1: Fetching UserInfo`);
        
        const userinfo = await axios.get(
            'https://americas.api.riotgames.com/riot/account/v1/accounts/me',
            {
                headers: { Authorization: `Bearer ${tokens.data.access_token}` },
            }
        ).catch(e => {
            console.error('UserInfo Error:', e.response?.data || e.message);
            return e;
        });
        
        if (userinfo.response) {
            io.emit('STEP_UPDATE', { step: 1, name: 'FETCH_USERINFO', success: false });
            return;
        }
        
        io.emit('STEP_UPDATE', { step: 1, name: 'FETCH_USERINFO', success: true });
        
        // STEP 2: Get Region/Shard
        console.log(`[${state}] Step 2: Fetching Region`);
        
        const region = await axios.get(
            `https://americas.api.riotgames.com/riot/account/v1/active-shards/by-game/val/by-puuid/${userinfo.data.puuid}`,
            {
                headers: { 'X-Riot-Token': basedata.riottoken },
            }
        ).catch(e => {
            console.error('Region Error:', e.response?.data || e.message);
            return e;
        });
        
        if (region.response) {
            io.emit('STEP_UPDATE', { step: 2, name: 'FETCH_REGION', success: false });
            return;
        }
        
        io.emit('STEP_UPDATE', { step: 2, name: 'FETCH_REGION', success: true });
        
        // STEP 3: Get Account Data via Henrik API
        console.log(`[${state}] Step 3: Fetching Account`);
        
        const accountData = await axios.get(
            `https://api.henrikdev.xyz/valorant/v1/account/${encodeURI(userinfo.data.gameName)}/${encodeURI(userinfo.data.tagLine)}`,
            { params: { asia: 'true' } }
        ).catch(e => {
            console.error('Account Error:', e.response?.data || e.message);
            return e;
        });
        
        if (accountData.response) {
            io.emit('STEP_UPDATE', { step: 3, name: 'FETCH_ACCOUNT', success: false });
            return;
        }
        
        io.emit('STEP_UPDATE', { step: 3, name: 'FETCH_ACCOUNT', success: true });
        
        // Handle AutoRole Flow
        if (fstate.type === 'autorole') {
            const guilddata = await getGuildSettings(fstate.guild);
            
            if (!guilddata || !guilddata.autoroles || guilddata.autoroles.length === 0) {
                console.log(`[${state}] No autoroles configured`);
                await getDB('state').deleteOne({ code: state });
                return;
            }
            
            // STEP 4: Get MMR/Rank
            console.log(`[${state}] Step 4: Fetching MMR`);
            
            const mmr = await axios.get(
                `https://api.henrikdev.xyz/valorant/v2/by-puuid/mmr/${region.data.activeShard}/${accountData.data.data.puuid}`,
                { params: { asia: 'true' } }
            ).catch(e => {
                console.error('MMR Error:', e.response?.data || e.message);
                return e;
            });
            
            if (mmr.response) {
                io.emit('STEP_UPDATE', { step: 4, name: 'FETCH_MMR', success: false });
                return;
            }
            
            io.emit('STEP_UPDATE', { step: 4, name: 'FETCH_MMR', success: true });
            
            const currentData = mmr.data.data.current_data;
            
            // STEP 5: Apply Role
            console.log(`[${state}] Step 5: Applying Role`);
            
            // Unranked Check
            if (currentData.currenttier == null || currentData.games_needed_for_rating != 0) {
                const unrankedRole = guilddata.autoroles.find(i => i.name === 'unranked');
                
                if (unrankedRole) {
                    await applyRoleToMember(
                        client,
                        fstate.userid,
                        fstate.guild,
                        unrankedRole.id,
                        guilddata.autoroles.filter(i => i.name !== 'unranked').map(i => i.id)
                    );
                }
                
                io.emit('STEP_UPDATE', { step: 5, name: 'APPLY_ROLE', success: true, rank: 'Unranked' });
            } else {
                // Ranked
                const currentRank = currentData.currenttierpatched.split(' ')[0].toLowerCase();
                const roleToAdd = guilddata.autoroles.find(item => item.name === currentRank);
                
                if (!roleToAdd) {
                    console.error(`[${state}] Rank not configured: ${currentRank}`);
                    io.emit('STEP_UPDATE', { step: 5, name: 'APPLY_ROLE', success: false });
                    await getDB('state').deleteOne({ code: state });
                    return;
                }
                
                await applyRoleToMember(
                    client,
                    fstate.userid,
                    fstate.guild,
                    roleToAdd.id,
                    guilddata.autoroles.filter(item => item.name !== currentRank).map(item => item.id)
                );
                
                io.emit('STEP_UPDATE', { step: 5, name: 'APPLY_ROLE', success: true, rank: currentData.currenttierpatched });
                
                // STEP 8: Write Log
                await getDB('linkv2-logs').insertOne({
                    userid: fstate.userid,
                    date: new Date(),
                    admin: null,
                    guild: { id: fstate.guild, name: null },
                    event: 'add',
                    type: 'autorole',
                    rank: {
                        name: currentData.currenttierpatched.split(' ')[0],
                        id: roleToAdd.id,
                    },
                    riotid: `${userinfo.data.gameName}#${userinfo.data.tagLine}`,
                    rpuuid: userinfo.data.puuid,
                    puuid: accountData.data.data.puuid,
                });
            }
            
            // STEP 6: Save RSO DB
            console.log(`[${state}] Step 6: Saving RSO DB`);
            await getDB('rso').updateOne(
                { puuid: userinfo.data.puuid }, 
                { $set: { puuid: userinfo.data.puuid } }, 
                { upsert: true }
            );
            io.emit('STEP_UPDATE', { step: 6, name: 'SET_RSO_DB', success: true });
            
            // STEP 7: Save Link DB
            console.log(`[${state}] Step 7: Saving Link DB`);
            await getDB('linkv2').updateOne(
                { userid: fstate.userid },
                {
                    $set: {
                        puuid: accountData.data.data.puuid,
                        rpuuid: userinfo.data.puuid,
                        region: region.data.activeShard
                    }
                },
                { upsert: true }
            );
            io.emit('STEP_UPDATE', { step: 7, name: 'SET_LINK_DB', success: true });
            
            io.emit('STEP_UPDATE', { step: 8, name: 'WRITING_LOGS', success: true });
            
            // STEP 9: Delete State
            console.log(`[${state}] Step 9: Deleting State`);
            await getDB('state').deleteOne({ code: state });
            io.emit('STEP_UPDATE', { step: 9, name: 'DELETE_STATE_DB', success: true });
            
            // STEP 10: Done
            console.log(`[${state}] Step 10: Done`);
            io.emit('STEP_UPDATE', { step: 10, name: 'DONE', success: true });
        }
        
    } catch (error) {
        console.error('OAuth Flow Error:', error);
        io.emit('ERROR', { message: 'Ein Fehler ist aufgetreten' });
    }
}

// Helper: Apply Role to Member
async function applyRoleToMember(client, userId, guildId, roleToAdd, rolesToRemove) {
    try {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) {
            console.error('Guild not found:', guildId);
            return;
        }
        
        const member = await guild.members.fetch(userId).catch(e => {
            console.error('Member not found:', userId, e);
            return null;
        });
        
        if (!member) return;
        
        // Entferne alte Rollen
        if (rolesToRemove.length > 0) {
            const rolesToRemoveFiltered = rolesToRemove.filter(id => member.roles.cache.has(id));
            if (rolesToRemoveFiltered.length > 0) {
                await member.roles.remove(rolesToRemoveFiltered).catch(console.error);
            }
        }
        
        // Füge neue Rolle hinzu
        if (!member.roles.cache.has(roleToAdd)) {
            await member.roles.add(roleToAdd).catch(console.error);
        }
        
        console.log(`✅ Role applied to ${userId} in ${guildId}`);
    } catch (error) {
        console.error('Apply Role Error:', error);
    }
}

// Status Seite
fastify.get('/rso', async (req, res) => {
    return res.sendFile('rso.html');
});

// Health Check
fastify.get('/health', async (req, res) => {
    return { status: 'ok', timestamp: new Date().toISOString() };
});

// Socket.IO Connection Handler
fastify.ready((err) => {
    if (err) throw err;
    
    fastify.io.on('connection', (socket) => {
        console.log('Client connected:', socket.id);
        
        socket.on('disconnect', () => {
            console.log('Client disconnected:', socket.id);
        });
    });
});

// Start Server
async function startWebServer(discordClient) {
    try {
        fastify.discordClient = discordClient;
        
        const port = process.env.PORT || 3000;
        await fastify.listen({ port: port, host: '0.0.0.0' });
        
        console.log(`✅ Web Server läuft auf Port ${port}`);
        console.log(`📍 OAuth Redirect: ${basedata.domain}/oauth-finished.html`);
        
        return fastify;
    } catch (err) {
        console.error('❌ Web Server Start Fehler:', err);
        process.exit(1);
    }
}

module.exports = { startWebServer, fastify };

