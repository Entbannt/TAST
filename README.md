# TAST - Discord Bot mit VALORANT Integration

Discord Bot mit VALORANT Rank Verification, Auto-Roles und Webserver.

## 📁 Projektstruktur

```
TAST/
├── 📂 app/                    # Hauptordner der Anwendung
│   │
│   ├── 📂 1-src/              # Quellcode
│   │   ├── 📂 bot/            # Discord Bot Logik
│   │   │   ├── index.js       # Haupteinstiegspunkt
│   │   │   ├── methods.js     # Bot Methoden
│   │   │   └── valorant-integration.js
│   │   ├── 📂 commands/       # Discord Commands
│   │   │   ├── buttons/       # Button Interactions
│   │   │   └── slash/         # Slash Commands
│   │   ├── 📂 webserver/      # Web Server
│   │   │   └── webserver.js   # Express/Fastify Server
│   │   └── 📂 utils/          # Hilfsfunktionen
│   │
│   ├── 📂 2-data/             # Daten (nicht in Git!)
│   │   ├── abwesenheiten.json # Abwesenheiten
│   │   ├── basedata.json      # Basis-Konfiguration
│   │   ├── mvp_votes.json     # MVP Votes
│   │   ├── premier_backup.json # Premier Backup
│   │   ├── roles.json         # Rollen-Konfiguration
│   │   └── warnings.json      # Verwarnungen
│   │
│   ├── 📂 3-public/           # Statische Webseiten
│   │   ├── index.html         # Hauptseite
│   │   ├── player.html        # Spieler-Statistiken
│   │   ├── rso.html           # RSO OAuth
│   │   └── warnings.html      # Verwarnungen
│   │
│   ├── 📂 4-scripts/          # PowerShell Scripts
│   │   ├── deploy-gh-pages.ps1    # GitHub Pages Deployment
│   │   ├── install-service.ps1    # Windows Service Installation
│   │   ├── manage-service.ps1     # Service Management
│   │   ├── start-bot.bat          # Bot starten
│   │   └── nssm.exe               # Service Manager
│   │
│   ├── 📂 5-dist/             # GitHub Pages Build
│   │   └── (generiert durch deploy-gh-pages.ps1)
│   │
│   └── 📂 6-config/           # Konfiguration
│       └── riot.txt           # Riot API Verification
│
├── 📂 docs/                   # Dokumentation
│   ├── API.md                 # API Dokumentation
│   └── GITHUB_PAGES_SETUP.md  # GitHub Pages Anleitung
│
├── 📄 package.json            # Node.js Dependencies
├── 📄 README.md               # Diese Datei
└── 📄 .gitignore              # Git Ignore Regeln
```

## 🚀 Quick Start

### Installation

```bash
npm install
```

### Bot starten

```bash
# Mit npm
npm start

# Direkt
node app/1-src/bot/index.js

# Mit Batch-Script
.\app\4-scripts\start-bot.bat

# Als Windows Service
.\app\4-scripts\install-service.ps1
```

### GitHub Pages deployen

```powershell
.\app\4-scripts\deploy-gh-pages.ps1
```

## 📚 Dokumentation

Siehe `docs/` Ordner für detaillierte Dokumentation:
- [API Dokumentation](docs/API.md)
- [GitHub Pages Setup](docs/GITHUB_PAGES_SETUP.md)

## 🔐 Konfiguration

Sensible Daten liegen im `app/2-data/` Ordner und sind nicht in Git.

Die `app/6-config/riot.txt` enthält den Riot API Verification Code und muss öffentlich sein.

## 🌐 GitHub Pages

Die öffentlichen HTML-Seiten werden über GitHub Pages bereitgestellt:
- URL: `https://entbannt.github.io/TAST/`
- Riot Verification: `https://entbannt.github.io/TAST/riot.txt`

## 🛠️ Entwicklung

```bash
# Bot im Development-Modus
npm run dev
```

## 📦 Scripts

- `npm start` - Bot starten
- `npm run dev` - Development Modus
- `app\4-scripts\deploy-gh-pages.ps1` - GitHub Pages deployen
- `app\4-scripts\install-service.ps1` - Als Windows Service installieren
- `app\4-scripts\manage-service.ps1` - Service verwalten
- `app\4-scripts\start-bot.bat` - Bot direkt starten

## 📄 Lizenz

Private Project

