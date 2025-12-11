/**
 * VALORANT Auto-Role Integration
 * 
 * Dieses Modul wird in index.js integriert um:
 * - /autorole Command zu registrieren
 * - Button Handler für autoroles_* zu registrieren
 * - Webserver für OAuth zu starten
 * - MongoDB zu initialisieren
 */

const { SlashCommandBuilder } = require('discord.js');
const { initializeDatabase, connectMongo } = require('./methods.js');
const { startWebServer } = require('./webserver.js');
const autoroleCommand = require('./commands/slash/autorole.js');
const autoroleButton = require('./commands/buttons/autoroles.js');

// Initialisiere VALORANT System
async function initializeValorantSystem(client) {
    try {
        console.log('\n🎮 Initialisiere VALORANT Rank System...');
        
        // 1. MongoDB verbinden
        await connectMongo();
        
        // 2. Database Indexes erstellen
        await initializeDatabase();
        
        // 3. Web Server starten
        await startWebServer(client);
        
        console.log('✅ VALORANT Rank System erfolgreich initialisiert!\n');
        return true;
    } catch (error) {
        console.error('❌ Fehler beim Initialisieren des VALORANT Systems:', error);
        console.log('⚠️ Der Bot läuft weiter, aber die Rank-Verifizierung ist nicht verfügbar.\n');
        return false;
    }
}

// Füge /autorole Command zur Commands-Liste hinzu
function addAutoroleCommand(commandsArray) {
    commandsArray.push(autoroleCommand.data.toJSON());
    console.log('✅ /autorole Command registriert');
    return commandsArray;
}

// Handle AutoRole Button Interactions
async function handleAutoroleButton(interaction) {
    // Prüfe ob es ein autoroles_ Button ist
    if (!interaction.customId.startsWith('autoroles_')) {
        return false; // Nicht unser Button
    }
    
    try {
        const args = interaction.customId.split('_');
        await autoroleButton.execute(interaction, args);
        return true; // Button wurde behandelt
    } catch (error) {
        console.error('AutoRole Button Error:', error);
        
        try {
            const errorMessage = { 
                content: '❌ Ein Fehler ist aufgetreten. Bitte versuche es später erneut.',
                ephemeral: true 
            };
            
            if (interaction.replied || interaction.deferred) {
                await interaction.editReply(errorMessage);
            } else {
                await interaction.reply(errorMessage);
            }
        } catch (replyError) {
            console.error('Error sending error message:', replyError);
        }
        
        return true; // Button wurde behandelt (mit Fehler)
    }
}

// Handle /autorole Slash Command
async function handleAutoroleCommand(interaction) {
    if (interaction.commandName !== 'autorole') {
        return false; // Nicht unser Command
    }
    
    try {
        await autoroleCommand.execute(interaction);
        return true; // Command wurde behandelt
    } catch (error) {
        console.error('AutoRole Command Error:', error);
        
        try {
            const errorMessage = { 
                content: '❌ Ein Fehler ist aufgetreten. Bitte versuche es später erneut.',
                ephemeral: true 
            };
            
            if (interaction.replied || interaction.deferred) {
                await interaction.editReply(errorMessage);
            } else {
                await interaction.reply(errorMessage);
            }
        } catch (replyError) {
            console.error('Error sending error message:', replyError);
        }
        
        return true; // Command wurde behandelt (mit Fehler)
    }
}

module.exports = {
    initializeValorantSystem,
    addAutoroleCommand,
    handleAutoroleButton,
    handleAutoroleCommand
};

