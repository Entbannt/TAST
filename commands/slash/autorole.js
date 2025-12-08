const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { getGuildSettings, getDB, roles } = require('../../methods.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('autorole')
        .setDescription('VALORANT Rank Verifizierung und automatische Rollenzuweisung')
        .addSubcommand(subcommand =>
            subcommand
                .setName('verify')
                .setDescription('Verifiziere deinen VALORANT Account und erhalte deine Rank-Rolle')
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('setup')
                .setDescription('Konfiguriere die Rank-Rollen für diesen Server (nur Admins)')
                .addRoleOption(option =>
                    option.setName('unranked')
                        .setDescription('Rolle für Unranked Spieler')
                        .setRequired(false))
                .addRoleOption(option =>
                    option.setName('iron')
                        .setDescription('Rolle für Iron Spieler')
                        .setRequired(false))
                .addRoleOption(option =>
                    option.setName('bronze')
                        .setDescription('Rolle für Bronze Spieler')
                        .setRequired(false))
                .addRoleOption(option =>
                    option.setName('silver')
                        .setDescription('Rolle für Silver Spieler')
                        .setRequired(false))
                .addRoleOption(option =>
                    option.setName('gold')
                        .setDescription('Rolle für Gold Spieler')
                        .setRequired(false))
                .addRoleOption(option =>
                    option.setName('platinum')
                        .setDescription('Rolle für Platinum Spieler')
                        .setRequired(false))
                .addRoleOption(option =>
                    option.setName('diamond')
                        .setDescription('Rolle für Diamond Spieler')
                        .setRequired(false))
                .addRoleOption(option =>
                    option.setName('ascendant')
                        .setDescription('Rolle für Ascendant Spieler')
                        .setRequired(false))
                .addRoleOption(option =>
                    option.setName('immortal')
                        .setDescription('Rolle für Immortal Spieler')
                        .setRequired(false))
                .addRoleOption(option =>
                    option.setName('radiant')
                        .setDescription('Rolle für Radiant Spieler')
                        .setRequired(false))
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('info')
                .setDescription('Zeigt deine aktuellen Verifizierungsinformationen')
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('unlink')
                .setDescription('Entferne die Verknüpfung mit deinem VALORANT Account')
        ),

    async execute(interaction) {
        const subcommand = interaction.options.getSubcommand();

        switch (subcommand) {
            case 'verify': {
                // Erstelle Buttons für Verifizierung
                const row = new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder()
                            .setCustomId('autoroles_generate')
                            .setLabel('🔗 Link generieren')
                            .setStyle(ButtonStyle.Primary),
                        new ButtonBuilder()
                            .setCustomId('autoroles_update')
                            .setLabel('🔄 Rang aktualisieren')
                            .setStyle(ButtonStyle.Success),
                        new ButtonBuilder()
                            .setCustomId('autoroles_remove')
                            .setLabel('🗑️ Rollen entfernen')
                            .setStyle(ButtonStyle.Danger)
                    );

                const embed = new EmbedBuilder()
                    .setTitle('🎮 VALORANT Rank Verifizierung')
                    .setDescription(
                        '**Willkommen zum Rank-Verifizierungssystem!**\n\n' +
                        '**Anleitung:**\n' +
                        '1️⃣ Klicke auf **Link generieren**\n' +
                        '2️⃣ Melde dich mit deinem Riot Account an\n' +
                        '3️⃣ Erhalte automatisch deine Rank-Rolle!\n\n' +
                        '**Features:**\n' +
                        '🔗 Sicherer OAuth Login über Riot Games\n' +
                        '🔄 Aktualisiere deinen Rang jederzeit\n' +
                        '🗑️ Entferne Rollen bei Bedarf\n\n' +
                        '**Hinweis:** Der Verifizierungs-Link ist 24 Stunden gültig.'
                    )
                    .setColor(0xff4654)
                    .setThumbnail('https://i.imgur.com/3bYPXJF.png')
                    .setFooter({ text: 'VALORANT Rank System' })
                    .setTimestamp();

                await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
                break;
            }

            case 'setup': {
                // Nur für Admins
                if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
                    const embed = new EmbedBuilder()
                        .setTitle('❌ Keine Berechtigung')
                        .setDescription('Nur Server-Administratoren können die Rollen konfigurieren.')
                        .setColor(0xff0000);
                    
                    return interaction.reply({ embeds: [embed], ephemeral: true });
                }

                await interaction.deferReply({ ephemeral: true });

                try {
                    const guilddata = await getGuildSettings(interaction.guildId);
                    
                    // Sammle alle konfigurierten Rollen
                    const configuredRoles = [];
                    
                    for (const roleName of roles) {
                        const role = interaction.options.getRole(roleName);
                        if (role) {
                            configuredRoles.push({
                                name: roleName,
                                id: role.id
                            });
                        }
                    }

                    if (configuredRoles.length === 0) {
                        const embed = new EmbedBuilder()
                            .setTitle('❌ Keine Rollen angegeben')
                            .setDescription('Bitte gib mindestens eine Rolle an, um sie zu konfigurieren.')
                            .setColor(0xff0000);
                        
                        return interaction.editReply({ embeds: [embed] });
                    }

                    // Aktualisiere oder erstelle Guild Settings
                    const existingRoles = guilddata.autoroles || [];
                    
                    // Merge neue Rollen mit bestehenden
                    for (const newRole of configuredRoles) {
                        const existingIndex = existingRoles.findIndex(r => r.name === newRole.name);
                        if (existingIndex >= 0) {
                            existingRoles[existingIndex] = newRole;
                        } else {
                            existingRoles.push(newRole);
                        }
                    }

                    await getDB('settings').updateOne(
                        { gid: interaction.guildId },
                        { 
                            $set: { 
                                autoroles: existingRoles 
                            } 
                        },
                        { upsert: true }
                    );

                    // Erstelle Übersicht
                    const roleList = configuredRoles
                        .map(r => `✅ **${r.name.charAt(0).toUpperCase() + r.name.slice(1)}**: <@&${r.id}>`)
                        .join('\n');

                    const embed = new EmbedBuilder()
                        .setTitle('✅ Rollen konfiguriert')
                        .setDescription(
                            `Die folgenden Rollen wurden erfolgreich eingerichtet:\n\n${roleList}\n\n` +
                            `**Wichtig:** Stelle sicher, dass die Bot-Rolle ÜBER diesen Rollen in der Hierarchie steht!`
                        )
                        .setColor(0x00ff00)
                        .setTimestamp();

                    await interaction.editReply({ embeds: [embed] });
                } catch (error) {
                    console.error('Setup Error:', error);
                    
                    const errorEmbed = new EmbedBuilder()
                        .setTitle('❌ Fehler')
                        .setDescription('Beim Konfigurieren der Rollen ist ein Fehler aufgetreten.')
                        .setColor(0xff0000);
                    
                    await interaction.editReply({ embeds: [errorEmbed] });
                }
                break;
            }

            case 'info': {
                await interaction.deferReply({ ephemeral: true });

                try {
                    const link = await getDB('linkv2').findOne({ userid: interaction.user.id });

                    if (!link) {
                        const embed = new EmbedBuilder()
                            .setTitle('ℹ️ Keine Verknüpfung')
                            .setDescription(
                                'Dein Discord Account ist noch nicht mit einem VALORANT Account verknüpft.\n\n' +
                                'Verwende `/autorole verify` um deinen Account zu verifizieren.'
                            )
                            .setColor(0x0099ff);
                        
                        return interaction.editReply({ embeds: [embed] });
                    }

                    // Hole Riot Account Info
                    const { axios, basedata } = require('../../methods.js');
                    const riot = await axios.get(
                        `https://americas.api.riotgames.com/riot/account/v1/accounts/by-puuid/${link.rpuuid}`,
                        { headers: { 'X-Riot-Token': basedata.riottoken } }
                    ).catch(e => e);

                    if (riot.response) {
                        const embed = new EmbedBuilder()
                            .setTitle('ℹ️ Account verknüpft')
                            .setDescription('Dein Account ist verknüpft, aber die Details konnten nicht abgerufen werden.')
                            .addFields(
                                { name: '🆔 Discord', value: `<@${interaction.user.id}>`, inline: true },
                                { name: '🌍 Region', value: link.region.toUpperCase(), inline: true }
                            )
                            .setColor(0x0099ff);
                        
                        return interaction.editReply({ embeds: [embed] });
                    }

                    const embed = new EmbedBuilder()
                        .setTitle('ℹ️ Account Informationen')
                        .setDescription('Dein Discord Account ist erfolgreich mit VALORANT verknüpft.')
                        .addFields(
                            { name: '🆔 Discord', value: `<@${interaction.user.id}>`, inline: true },
                            { name: '🎮 Riot ID', value: `${riot.data.gameName}#${riot.data.tagLine}`, inline: true },
                            { name: '🌍 Region', value: link.region.toUpperCase(), inline: true }
                        )
                        .setColor(0x00ff00)
                        .setTimestamp();

                    await interaction.editReply({ embeds: [embed] });
                } catch (error) {
                    console.error('Info Error:', error);
                    
                    const errorEmbed = new EmbedBuilder()
                        .setTitle('❌ Fehler')
                        .setDescription('Beim Abrufen der Informationen ist ein Fehler aufgetreten.')
                        .setColor(0xff0000);
                    
                    await interaction.editReply({ embeds: [errorEmbed] });
                }
                break;
            }

            case 'unlink': {
                await interaction.deferReply({ ephemeral: true });

                try {
                    const result = await getDB('linkv2').deleteOne({ userid: interaction.user.id });

                    if (result.deletedCount === 0) {
                        const embed = new EmbedBuilder()
                            .setTitle('ℹ️ Keine Verknüpfung')
                            .setDescription('Dein Account ist nicht verknüpft.')
                            .setColor(0x0099ff);
                        
                        return interaction.editReply({ embeds: [embed] });
                    }

                    // Log speichern
                    await getDB('linkv2-logs').insertOne({
                        userid: interaction.user.id,
                        date: new Date(),
                        admin: null,
                        guild: { id: interaction.guildId, name: interaction.guild.name },
                        event: 'unlink',
                        type: 'autorole',
                        rank: null,
                        riotid: null,
                        rpuuid: null,
                        puuid: null,
                    });

                    const embed = new EmbedBuilder()
                        .setTitle('✅ Verknüpfung entfernt')
                        .setDescription('Die Verknüpfung mit deinem VALORANT Account wurde erfolgreich entfernt.')
                        .setColor(0x00ff00);

                    await interaction.editReply({ embeds: [embed] });
                } catch (error) {
                    console.error('Unlink Error:', error);
                    
                    const errorEmbed = new EmbedBuilder()
                        .setTitle('❌ Fehler')
                        .setDescription('Beim Entfernen der Verknüpfung ist ein Fehler aufgetreten.')
                        .setColor(0xff0000);
                    
                    await interaction.editReply({ embeds: [errorEmbed] });
                }
                break;
            }
        }
    },
};

