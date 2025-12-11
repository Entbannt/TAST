const { uuidv4, getDB, axios, getGuildSettings, getRankCategory, basedata } = require('../../methods.js');
const { EmbedBuilder } = require('discord.js');

async function execute(interaction, args) {
    await interaction.deferReply({ ephemeral: true });
    
    const action = args[1];
    
    switch (action) {
        case 'generate': {
            // Link für Rank-Verifizierung generieren
            try {
                const uuid = uuidv4();
                await getDB('state').insertOne({
                    userid: interaction.user.id, 
                    guild: interaction.guildId, 
                    code: uuid, 
                    expireAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 Stunden ab jetzt
                    type: 'autorole'
                });
                
                const verifyLink = `${basedata.domain}/v1/rso/redirect/${uuid}`;
                
                const embed = new EmbedBuilder()
                    .setTitle('🔗 Verifizierungs-Link erstellt')
                    .setDescription(`Klicke auf den Link um deinen VALORANT Rang zu verifizieren:\n\n${verifyLink}`)
                    .setColor(0xff4654)
                    .setFooter({ text: 'Link ist 24 Stunden gültig' })
                    .setTimestamp();
                
                return interaction.editReply({ embeds: [embed] });
            } catch (error) {
                console.error('Generate Link Error:', error);
                
                const errorEmbed = new EmbedBuilder()
                    .setTitle('❌ Fehler')
                    .setDescription('Beim Erstellen des Links ist ein Fehler aufgetreten.')
                    .setColor(0xff0000);
                
                return interaction.editReply({ embeds: [errorEmbed] });
            }
        }
        
        case 'update': {
            // Rank aktualisieren
            try {
                const link = await getDB('linkv2').findOne({ userid: interaction.user.id });
                
                if (!link) {
                    const embed = new EmbedBuilder()
                        .setTitle('❌ Kein Account verknüpft')
                        .setDescription('Du musst zuerst deinen VALORANT Account verknüpfen!\nVerwende `/autorole generate` um einen Link zu erstellen.')
                        .setColor(0xff0000);
                    
                    return interaction.editReply({ embeds: [embed] });
                }
                
                // Guild Settings laden
                const guilddata = await getGuildSettings(interaction.guildId);
                
                if (!guilddata || !guilddata.autoroles || guilddata.autoroles.length === 0) {
                    const embed = new EmbedBuilder()
                        .setTitle('❌ Keine Rollen konfiguriert')
                        .setDescription('Der Server-Administrator muss zuerst die Rank-Rollen einrichten.\nVerwende `/autorole setup` als Admin.')
                        .setColor(0xff0000);
                    
                    return interaction.editReply({ embeds: [embed] });
                }
                
                // MMR abrufen
                const mmr = await axios.get(
                    `https://api.henrikdev.xyz/valorant/v2/by-puuid/mmr/${link.region}/${link.puuid}`,
                    { params: { asia: 'true' } }
                ).catch(e => e);
                
                if (mmr.response) {
                    const embed = new EmbedBuilder()
                        .setTitle('❌ Fehler beim Abrufen des Ranks')
                        .setDescription('Die VALORANT API ist momentan nicht verfügbar. Versuche es später erneut.')
                        .setColor(0xff0000);
                    
                    return interaction.editReply({ embeds: [embed] });
                }
                
                const currentData = mmr.data.data.current_data;
                
                // Unranked Check
                if (currentData.currenttier == null || currentData.games_needed_for_rating != 0) {
                    const unrankedRole = guilddata.autoroles.find(i => i.name === 'unranked');
                    
                    if (unrankedRole) {
                        // Entferne alle anderen Rollen
                        const rolesToRemove = guilddata.autoroles
                            .filter(i => i.name !== 'unranked')
                            .map(i => i.id)
                            .filter(id => interaction.member.roles.cache.has(id));
                        
                        if (rolesToRemove.length > 0) {
                            await interaction.member.roles.remove(rolesToRemove).catch(console.error);
                        }
                        
                        // Füge Unranked-Rolle hinzu
                        if (!interaction.member.roles.cache.has(unrankedRole.id)) {
                            await interaction.member.roles.add(unrankedRole.id).catch(console.error);
                        }
                    }
                    
                    const embed = new EmbedBuilder()
                        .setTitle('⚠️ Unranked')
                        .setDescription(`Du hast noch keinen Rang in der aktuellen Episode.\n\n**Benötigte Spiele:** ${currentData.games_needed_for_rating}\n\nSpiele deine Platzierungsspiele um einen Rang zu erhalten!`)
                        .setColor(0xffa500);
                    
                    return interaction.editReply({ embeds: [embed] });
                }
                
                // Rank-Rolle zuweisen
                const currentRank = currentData.currenttierpatched.split(' ')[0].toLowerCase();
                const roleToAdd = guilddata.autoroles.find(item => item.name === currentRank);
                
                if (!roleToAdd) {
                    const embed = new EmbedBuilder()
                        .setTitle('❌ Rang nicht konfiguriert')
                        .setDescription(`Die Rolle für **${currentRank}** ist nicht eingerichtet.\nBitte kontaktiere einen Administrator.`)
                        .setColor(0xff0000);
                    
                    return interaction.editReply({ embeds: [embed] });
                }
                
                // Entferne alle anderen Rank-Rollen
                const rolesToRemove = guilddata.autoroles
                    .filter(item => item.name !== currentRank)
                    .map(item => item.id)
                    .filter(id => interaction.member.roles.cache.has(id));
                
                if (rolesToRemove.length > 0) {
                    await interaction.member.roles.remove(rolesToRemove).catch(console.error);
                }
                
                // Füge neue Rolle hinzu
                if (!interaction.member.roles.cache.has(roleToAdd.id)) {
                    await interaction.member.roles.add(roleToAdd.id).catch(console.error);
                }
                
                // Log speichern
                await getDB('linkv2-logs').insertOne({
                    userid: interaction.user.id,
                    date: new Date(),
                    admin: null,
                    guild: { id: interaction.guildId, name: interaction.guild.name },
                    event: 'update',
                    type: 'autorole',
                    rank: {
                        name: currentData.currenttierpatched.split(' ')[0],
                        id: roleToAdd.id,
                    },
                    riotid: `${mmr.data.data.name}#${mmr.data.data.tag}`,
                    rpuuid: link.rpuuid,
                    puuid: link.puuid,
                });
                
                const embed = new EmbedBuilder()
                    .setTitle('✅ Rang aktualisiert')
                    .setDescription(`Deine Rolle wurde erfolgreich aktualisiert!`)
                    .addFields(
                        { name: '🎯 Rank', value: currentData.currenttierpatched, inline: true },
                        { name: '📊 ELO', value: currentData.elo.toString(), inline: true },
                        { name: '🎮 Riot ID', value: `${mmr.data.data.name}#${mmr.data.data.tag}`, inline: false }
                    )
                    .setColor(0x00ff00)
                    .setTimestamp();
                
                return interaction.editReply({ embeds: [embed] });
            } catch (error) {
                console.error('Update Rank Error:', error);
                
                const errorEmbed = new EmbedBuilder()
                    .setTitle('❌ Fehler')
                    .setDescription('Beim Aktualisieren des Rangs ist ein Fehler aufgetreten.')
                    .setColor(0xff0000);
                
                return interaction.editReply({ embeds: [errorEmbed] });
            }
        }
        
        case 'remove': {
            // Alle Rank-Rollen entfernen
            try {
                const guilddata = await getGuildSettings(interaction.guildId);
                
                if (!guilddata || !guilddata.autoroles || guilddata.autoroles.length === 0) {
                    const embed = new EmbedBuilder()
                        .setTitle('✅ Keine Rollen zu entfernen')
                        .setDescription('Es sind keine Rank-Rollen konfiguriert.')
                        .setColor(0x808080);
                    
                    return interaction.editReply({ embeds: [embed] });
                }
                
                const rolesToRemove = guilddata.autoroles
                    .map(item => item.id)
                    .filter(id => interaction.member.roles.cache.has(id));
                
                if (rolesToRemove.length > 0) {
                    await interaction.member.roles.remove(rolesToRemove).catch(console.error);
                }
                
                // Log speichern
                await getDB('linkv2-logs').insertOne({
                    userid: interaction.user.id,
                    date: new Date(),
                    admin: null,
                    guild: { id: interaction.guildId, name: interaction.guild.name },
                    event: 'remove',
                    type: 'autorole',
                    rank: null,
                    riotid: null,
                    rpuuid: null,
                    puuid: null,
                });
                
                const embed = new EmbedBuilder()
                    .setTitle('🗑️ Rollen entfernt')
                    .setDescription('Alle Rank-Rollen wurden erfolgreich entfernt.')
                    .setColor(0x808080);
                
                return interaction.editReply({ embeds: [embed] });
            } catch (error) {
                console.error('Remove Roles Error:', error);
                
                const errorEmbed = new EmbedBuilder()
                    .setTitle('❌ Fehler')
                    .setDescription('Beim Entfernen der Rollen ist ein Fehler aufgetreten.')
                    .setColor(0xff0000);
                
                return interaction.editReply({ embeds: [errorEmbed] });
            }
        }
        
        default: {
            const embed = new EmbedBuilder()
                .setTitle('❌ Ungültige Aktion')
                .setDescription('Bitte verwende eine gültige Aktion: generate, update, remove')
                .setColor(0xff0000);
            
            return interaction.editReply({ embeds: [embed] });
        }
    }
}

module.exports = {
    name: 'autoroles',
    execute
};

