# TAST - Discord Bot mit VALORANT Integration

Discord Bot mit VALORANT Rank Verification, Auto-Roles und Webserver.

## 📁 Projektstruktur

```
TAST/
├── 📂 app/                    # Hauptordner der Anwendung
│   │
│   ├── 📂 src/                # Quellcode
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
│   ├── 📂 scripts/            # PowerShell Scripts
│   │   ├── deploy-gh-pages.ps1    # GitHub Pages Deployment
│   │   ├── install-service.ps1    # Windows Service Installation
│   │   ├── manage-service.ps1     # Service Management
│   │   ├── start-bot.bat          # Bot starten
│   │   └── nssm.exe               # Service Manager
│   │
│   ├── 📂 config/             # Konfiguration
│   │   └── riot.txt           # Riot API Verification
│   │
│   ├── 📂 data/               # Daten (nicht in Git!)
│   │   ├── abwesenheiten.json # Abwesenheiten
│   │   ├── basedata.json      # Basis-Konfiguration
│   │   ├── mvp_votes.json     # MVP Votes
│   │   ├── premier_backup.json # Premier Backup
│   │   ├── roles.json         # Rollen-Konfiguration
│   │   └── warnings.json      # Verwarnungen
│   │
│   ├── 📂 public/             # Statische Webseiten
│   │   ├── index.html         # Hauptseite
│   │   ├── player.html        # Spieler-Statistiken
│   │   ├── rso.html           # RSO OAuth
│   │   └── warnings.html      # Verwarnungen
│   │
│   └── 📂 dist/               # GitHub Pages Build
│       └── (generiert durch deploy-gh-pages.ps1)
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
node app/src/bot/index.js

# Mit Batch-Script
.\app\scripts\start-bot.bat

# Als Windows Service
.\app\scripts\install-service.ps1
```

### GitHub Pages deployen

```powershell
.\app\scripts\deploy-gh-pages.ps1
```

## 📚 Dokumentation

Siehe `docs/` Ordner für detaillierte Dokumentation:
- [API Dokumentation](docs/API.md)
- [GitHub Pages Setup](docs/GITHUB_PAGES_SETUP.md)

## 🔐 Konfiguration

Sensible Daten liegen im `app/data/` Ordner und sind nicht in Git.

Die `app/config/riot.txt` enthält den Riot API Verification Code und muss öffentlich sein.

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
- `app\scripts\deploy-gh-pages.ps1` - GitHub Pages deployen
- `app\scripts\install-service.ps1` - Als Windows Service installieren
- `app\scripts\manage-service.ps1` - Service verwalten
- `app\scripts\start-bot.bat` - Bot direkt starten

## 📄 Lizenz

Private Project

