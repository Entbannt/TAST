# PowerShell Script zum Installieren des Discord Bots als Windows Service
# Dieses Script muss als Administrator ausgeführt werden!

param(
    [string]$ServiceName = "DiscordBot",
    [string]$ServiceDisplayName = "Discord Bot Service",
    [string]$ServiceDescription = "Automatisch startender Discord Bot"
)

# Prüfen ob als Administrator ausgeführt
if (-NOT ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole] "Administrator")) {
    Write-Host "FEHLER: Dieses Script muss als Administrator ausgeführt werden!" -ForegroundColor Red
    Write-Host "Rechtsklick auf PowerShell -> 'Als Administrator ausführen'" -ForegroundColor Yellow
    Read-Host "Drücken Sie Enter zum Beenden..."
    exit 1
}

# Aktuelles Verzeichnis
$CurrentPath = Get-Location
$BotPath = Join-Path $CurrentPath "index.js"
$BatchPath = Join-Path $CurrentPath "start-bot.bat"

# Prüfen ob Bot-Dateien existieren
if (-not (Test-Path $BotPath)) {
    Write-Host "FEHLER: index.js nicht gefunden in $CurrentPath" -ForegroundColor Red
    Read-Host "Drücken Sie Enter zum Beenden..."
    exit 1
}

# Node.js Pfad finden
$NodePath = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $NodePath) {
    Write-Host "FEHLER: Node.js nicht gefunden! Bitte installieren Sie Node.js." -ForegroundColor Red
    Read-Host "Drücken Sie Enter zum Beenden..."
    exit 1
}

Write-Host "Node.js gefunden: $NodePath" -ForegroundColor Green
Write-Host "Bot-Pfad: $BotPath" -ForegroundColor Green

# Service stoppen falls er bereits existiert
try {
    $existingService = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($existingService) {
        Write-Host "Stoppe existierenden Service..." -ForegroundColor Yellow
        Stop-Service -Name $ServiceName -Force
        Write-Host "Entferne existierenden Service..." -ForegroundColor Yellow
        sc.exe delete $ServiceName
        Start-Sleep -Seconds 2
    }
} catch {
    Write-Host "Service existiert noch nicht." -ForegroundColor Gray
}

# NSSM herunterladen und installieren (Non-Sucking Service Manager)
$nssmPath = Join-Path $CurrentPath "nssm.exe"
if (-not (Test-Path $nssmPath)) {
    Write-Host "Lade NSSM herunter..." -ForegroundColor Yellow
    try {
        # NSSM für 64-bit Windows herunterladen
        $nssmUrl = "https://nssm.cc/release/nssm-2.24.zip"
        $tempZip = Join-Path $env:TEMP "nssm.zip"
        $tempExtract = Join-Path $env:TEMP "nssm"
        
        Invoke-WebRequest -Uri $nssmUrl -OutFile $tempZip
        Expand-Archive -Path $tempZip -DestinationPath $tempExtract -Force
        
        # NSSM.exe kopieren (64-bit Version)
        $nssmSource = Join-Path $tempExtract "nssm-2.24\win64\nssm.exe"
        Copy-Item -Path $nssmSource -Destination $nssmPath
        
        # Temp-Dateien löschen
        Remove-Item -Path $tempZip -Force
        Remove-Item -Path $tempExtract -Recurse -Force
        
        Write-Host "NSSM erfolgreich heruntergeladen!" -ForegroundColor Green
    } catch {
        Write-Host "FEHLER beim Herunterladen von NSSM: $($_.Exception.Message)" -ForegroundColor Red
        Read-Host "Drücken Sie Enter zum Beenden..."
        exit 1
    }
}

# Service mit NSSM erstellen
Write-Host "Erstelle Windows Service..." -ForegroundColor Yellow
try {
    & $nssmPath install $ServiceName $NodePath $BotPath
    & $nssmPath set $ServiceName DisplayName "$ServiceDisplayName"
    & $nssmPath set $ServiceName Description "$ServiceDescription"
    & $nssmPath set $ServiceName Start SERVICE_AUTO_START
    & $nssmPath set $ServiceName AppDirectory $CurrentPath
    
    # Service-Neustart bei Fehler konfigurieren
    & $nssmPath set $ServiceName AppExit Default Restart
    & $nssmPath set $ServiceName AppRestartDelay 5000
    
    # Logging konfigurieren
    $logPath = Join-Path $CurrentPath "bot-service.log"
    & $nssmPath set $ServiceName AppStdout $logPath
    & $nssmPath set $ServiceName AppStderr $logPath
    
    Write-Host "Service '$ServiceName' erfolgreich erstellt!" -ForegroundColor Green
    Write-Host "Service wird automatisch beim Systemstart gestartet." -ForegroundColor Green
    Write-Host "Logs werden in: $logPath" -ForegroundColor Cyan
    
    # Service starten
    Write-Host "Starte Service..." -ForegroundColor Yellow
    Start-Service -Name $ServiceName
    
    $serviceStatus = Get-Service -Name $ServiceName
    if ($serviceStatus.Status -eq "Running") {
        Write-Host "Service erfolgreich gestartet!" -ForegroundColor Green
    } else {
        Write-Host "WARNUNG: Service konnte nicht gestartet werden. Status: $($serviceStatus.Status)" -ForegroundColor Yellow
        Write-Host "Prüfen Sie die Logs in: $logPath" -ForegroundColor Cyan
    }
    
} catch {
    Write-Host "FEHLER beim Erstellen des Services: $($_.Exception.Message)" -ForegroundColor Red
}

Write-Host "`nService-Management Befehle:" -ForegroundColor Cyan
Write-Host "Service starten:  Start-Service -Name $ServiceName" -ForegroundColor Gray
Write-Host "Service stoppen:  Stop-Service -Name $ServiceName" -ForegroundColor Gray
Write-Host "Service status:   Get-Service -Name $ServiceName" -ForegroundColor Gray
Write-Host "Service löschen:  sc.exe delete $ServiceName" -ForegroundColor Gray

Read-Host "`nDrücken Sie Enter zum Beenden..."
