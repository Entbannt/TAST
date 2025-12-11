# GitHub Pages Setup mit Subtree

Diese Anleitung erklärt, wie du GitHub Pages für die Riot API Verification und öffentliche HTML-Seiten einrichtest.

## 🎯 Übersicht

- **dist-Ordner**: Enthält alle öffentlichen Dateien für GitHub Pages
- **riot.txt**: Wichtig! Muss öffentlich für Riot API Verification erreichbar sein
- **gh-pages Branch**: Separater Branch nur für die öffentlichen Dateien (Subtree)

## 💰 Kosten

**GitHub Pages ist KOSTENLOS für öffentliche Repositories!** 🎉
- Kein 30-Tage-Limit
- Unbegrenzte Laufzeit
- Bedingung: Repository muss öffentlich sein

## 📋 Voraussetzungen

- Git installiert
- Repository auf GitHub erstellt
- **Repository ist öffentlich** (siehe `make-repo-public.md`)

## 🚀 Erstmaliges Setup

### Schritt 1: Repository öffentlich machen

**WICHTIG**: Befolge ZUERST die Anleitung in `make-repo-public.md`!

Sensible Daten wurden bereits aus Git entfernt:
- ✅ JSON-Dateien mit Discord-Daten
- ✅ node_modules

### Schritt 2: Pushe den aktuellen Stand

```powershell
git push origin main
```

Falls es Fehler gibt (z.B. "diverged"):
```powershell
git pull --rebase origin main
# oder bei Konflikten:
git push origin main --force-with-lease
```

### Schritt 3: GitHub Pages deployen

Führe das Deployment-Script aus:

```powershell
.\deploy-gh-pages.ps1
```

Das Script wird:
1. Den dist-Ordner mit den neuesten Dateien aktualisieren
2. Einen gh-pages Branch erstellen (oder aktualisieren)
3. Nur den Inhalt des dist-Ordners auf den gh-pages Branch pushen

### Schritt 4: GitHub Pages aktivieren

1. Gehe zu deinem Repository auf GitHub
2. Klicke auf **Settings** > **Pages**
3. Du siehst **KEINE Zahlungsaufforderung** (weil Repo öffentlich ist!)
4. Wähle unter "Source":
   - **Branch**: `gh-pages`
   - **Folder**: `/ (root)`
5. Klicke auf **Save**

### Schritt 5: Warte auf Deployment

GitHub Pages braucht 1-2 Minuten zum Deployment. Du erhältst eine URL wie:

```
https://<dein-username>.github.io/<repository-name>/
```

## 🔄 Updates deployen

Wenn du die HTML-Dateien oder riot.txt aktualisierst:

1. **Dateien im public/ Ordner oder riot.txt bearbeiten**
2. **Deployment-Script ausführen**:
   ```powershell
   .\deploy-gh-pages.ps1
   ```

Das Script aktualisiert automatisch den gh-pages Branch.

## 📝 Manuelle Subtree-Befehle

Falls du den Subtree manuell verwalten möchtest:

### Ersten Subtree Push:
```bash
git subtree push --prefix dist origin gh-pages
```

### Subtree aktualisieren:
```bash
# Aktualisiere dist-Ordner
Copy-Item riot.txt dist\ -Force
Copy-Item public\*.html dist\ -Force

# Committe Änderungen
git add dist/
git commit -m "Update GitHub Pages content"

# Pushe Subtree
git subtree push --prefix dist origin gh-pages
```

## ✅ Riot API Verification

Die riot.txt Datei wird öffentlich erreichbar sein unter:

```
https://<dein-username>.github.io/<repository-name>/riot.txt
```

Diese URL kannst du im Riot Developer Portal als Verification URL angeben.

## 📂 dist-Ordner Struktur

```
dist/
├── riot.txt          # Riot API Verification Code
├── index.html        # Hauptseite
├── player.html       # Spieler-Statistiken
├── rso.html          # RSO Integration
├── warnings.html     # Verwarnungen
└── README.md         # Dokumentation
```

## 🔒 Sicherheit

Der dist-Ordner enthält **nur** öffentliche Dateien:
- ✅ HTML-Dateien (statisch, keine Geheimnisse)
- ✅ riot.txt (öffentlicher Verification Code)
- ❌ Keine sensiblen JSON-Dateien
- ❌ Keine Node.js Backend-Dateien
- ❌ Keine API-Keys oder Tokens

Die .gitignore-Datei stellt sicher, dass sensible Daten nicht versehentlich committed werden.

## 🛠️ Troubleshooting

### Problem: "Updates are rejected because the remote contains work"

```powershell
git fetch origin gh-pages
git subtree push --prefix dist origin gh-pages
```

### Problem: "Working tree has modifications"

Committe zuerst alle Änderungen:

```powershell
git add .
git commit -m "Update before deployment"
.\deploy-gh-pages.ps1
```

### Problem: GitHub Pages zeigt alte Version

Warte 2-3 Minuten und leere deinen Browser-Cache (Ctrl+Shift+R).

### Problem: "Upgrade or make this repository public"

Dein Repository ist noch privat! Siehe `make-repo-public.md` für die Anleitung.

## 📚 Weitere Informationen

- [GitHub Pages Dokumentation](https://docs.github.com/pages)
- [Git Subtree Tutorial](https://www.atlassian.com/git/tutorials/git-subtree)
- [Riot API Verification](https://developer.riotgames.com/docs/portal#_verification)

## 🎉 Fertig!

Deine öffentlichen Dateien sind jetzt auf GitHub Pages verfügbar und die Riot API Verification sollte funktionieren!

