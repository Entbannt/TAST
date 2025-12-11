# GitHub Pages Deployment Script
# Dieses Script deployed den dist-Ordner auf den gh-pages Branch

Write-Host "=== GitHub Pages Deployment ===" -ForegroundColor Cyan

# Prüfe ob git installiert ist
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Host "Fehler: Git ist nicht installiert!" -ForegroundColor Red
    exit 1
}

# Prüfe ob wir in einem Git-Repository sind
if (-not (Test-Path .git)) {
    Write-Host "Fehler: Kein Git-Repository gefunden!" -ForegroundColor Red
    exit 1
}

# Stelle sicher, dass alle Änderungen committed sind
$status = git status --porcelain
if ($status) {
    Write-Host "Warnung: Es gibt uncommitted changes!" -ForegroundColor Yellow
    Write-Host "Bitte committe zuerst alle Änderungen im Hauptbranch." -ForegroundColor Yellow
    $continue = Read-Host "Trotzdem fortfahren? (j/n)"
    if ($continue -ne "j") {
        exit 0
    }
}

# Aktualisiere den dist-Ordner
Write-Host "`nAktualisiere dist-Ordner..." -ForegroundColor Green
if (-not (Test-Path app\5-dist)) {
    New-Item -ItemType Directory -Path app\5-dist | Out-Null
}
Copy-Item app\6-config\riot.txt app\5-dist\ -Force
Copy-Item app\3-public\*.html app\5-dist\ -Force
Write-Host "Dateien aktualisiert!" -ForegroundColor Green

# Prüfe ob gh-pages Branch existiert
$branchExists = git branch --list gh-pages
if (-not $branchExists) {
    Write-Host "`nErstelle gh-pages Branch..." -ForegroundColor Yellow
    
    # Erstelle einen orphan branch (keine Historie)
    git checkout --orphan gh-pages
    git rm -rf .
    
    # Kopiere dist Inhalte
    Get-ChildItem app\5-dist\* | Copy-Item -Destination . -Recurse -Force
    
    # Erstelle .gitignore für gh-pages
    @"
# Ignoriere alles außer dist Inhalte
node_modules/
*.json
*.js
*.ps1
*.bat
*.exe
"@ | Out-File -FilePath .gitignore -Encoding utf8
    
    # Commit und push
    git add .
    git commit -m "Initial GitHub Pages commit"
    
    Write-Host "`nPushe gh-pages Branch..." -ForegroundColor Green
    git push -u origin gh-pages
    
    # Zurück zum main branch
    git checkout main
    
    Write-Host "`n=== Deployment abgeschlossen! ===" -ForegroundColor Cyan
    Write-Host "GitHub Pages ist jetzt eingerichtet." -ForegroundColor Green
    Write-Host "Gehe zu deinen Repository Settings > Pages und wähle 'gh-pages' Branch aus." -ForegroundColor Yellow
} else {
    Write-Host "`nAktualisiere gh-pages Branch mit Subtree..." -ForegroundColor Green
    
    # Stelle sicher, dass wir auf dem richtigen Branch sind
    $currentBranch = git rev-parse --abbrev-ref HEAD
    Write-Host "Aktueller Branch: $currentBranch" -ForegroundColor Cyan
    
    # Committe dist Änderungen im aktuellen Branch falls nötig
    git add app/5-dist/
    $distStatus = git status --porcelain app/5-dist/
    if ($distStatus) {
        git commit -m "Update dist folder for GitHub Pages" -ErrorAction SilentlyContinue
    }
    
    # Push zum gh-pages Branch mit subtree
    Write-Host "Pushe dist-Ordner zu gh-pages..." -ForegroundColor Green
    git subtree push --prefix app/5-dist origin gh-pages
    
    Write-Host "`n=== Deployment abgeschlossen! ===" -ForegroundColor Cyan
    Write-Host "GitHub Pages wurde aktualisiert!" -ForegroundColor Green
}

Write-Host "`nDeine Seite wird verfügbar sein unter:" -ForegroundColor Cyan
Write-Host "https://<dein-username>.github.io/<repository-name>/" -ForegroundColor White
Write-Host "`nDie riot.txt wird erreichbar sein unter:" -ForegroundColor Cyan
Write-Host "https://<dein-username>.github.io/<repository-name>/riot.txt" -ForegroundColor White

