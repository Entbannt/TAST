# Service Management Script für Discord Bot
param(
    [Parameter(Mandatory=$true)]
    [ValidateSet("start", "stop", "restart", "status", "logs", "uninstall")]
    [string]$Action,
    
    [string]$ServiceName = "DiscordBot"
)

function Show-Usage {
    Write-Host "Discord Bot Service Manager" -ForegroundColor Cyan
    Write-Host "Verwendung: .\manage-service.ps1 -Action <action>" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Verfügbare Aktionen:" -ForegroundColor White
    Write-Host "  start     - Service starten" -ForegroundColor Green
    Write-Host "  stop      - Service stoppen" -ForegroundColor Red
    Write-Host "  restart   - Service neu starten" -ForegroundColor Yellow
    Write-Host "  status    - Service-Status anzeigen" -ForegroundColor Cyan
    Write-Host "  logs      - Letzte Logs anzeigen" -ForegroundColor Magenta
    Write-Host "  uninstall - Service deinstallieren" -ForegroundColor Red
    Write-Host ""
    Write-Host "Beispiel: .\manage-service.ps1 -Action start" -ForegroundColor Gray
}

# Prüfen ob Service existiert
try {
    $service = Get-Service -Name $ServiceName -ErrorAction Stop
} catch {
    Write-Host "FEHLER: Service '$ServiceName' nicht gefunden!" -ForegroundColor Red
    Write-Host "Bitte führen Sie zuerst 'install-service.ps1' aus." -ForegroundColor Yellow
    exit 1
}

switch ($Action.ToLower()) {
    "start" {
        Write-Host "Starte Service '$ServiceName'..." -ForegroundColor Yellow
        try {
            Start-Service -Name $ServiceName
            Write-Host "Service erfolgreich gestartet!" -ForegroundColor Green
        } catch {
            Write-Host "FEHLER beim Starten: $($_.Exception.Message)" -ForegroundColor Red
        }
    }
    
    "stop" {
        Write-Host "Stoppe Service '$ServiceName'..." -ForegroundColor Yellow
        try {
            Stop-Service -Name $ServiceName -Force
            Write-Host "Service erfolgreich gestoppt!" -ForegroundColor Green
        } catch {
            Write-Host "FEHLER beim Stoppen: $($_.Exception.Message)" -ForegroundColor Red
        }
    }
    
    "restart" {
        Write-Host "Starte Service '$ServiceName' neu..." -ForegroundColor Yellow
        try {
            Restart-Service -Name $ServiceName -Force
            Write-Host "Service erfolgreich neu gestartet!" -ForegroundColor Green
        } catch {
            Write-Host "FEHLER beim Neustart: $($_.Exception.Message)" -ForegroundColor Red
        }
    }
    
    "status" {
        $service = Get-Service -Name $ServiceName
        $status = $service.Status
        $startType = (Get-WmiObject -Class Win32_Service -Filter "Name='$ServiceName'").StartMode
        
        Write-Host "Service Status für '$ServiceName':" -ForegroundColor Cyan
        Write-Host "  Status: $status" -ForegroundColor $(if ($status -eq "Running") { "Green" } else { "Red" })
        Write-Host "  Start-Typ: $startType" -ForegroundColor White
        Write-Host "  Display Name: $($service.DisplayName)" -ForegroundColor Gray
    }
    
    "logs" {
        $logPath = Join-Path (Get-Location) "bot-service.log"
        if (Test-Path $logPath) {
            Write-Host "Letzte 50 Zeilen der Logs:" -ForegroundColor Cyan
            Write-Host "----------------------------------------" -ForegroundColor Gray
            Get-Content -Path $logPath -Tail 50
            Write-Host "----------------------------------------" -ForegroundColor Gray
            Write-Host "Vollständige Logs: $logPath" -ForegroundColor Gray
        } else {
            Write-Host "Keine Log-Datei gefunden: $logPath" -ForegroundColor Yellow
        }
    }
    
    "uninstall" {
        Write-Host "Deinstalliere Service '$ServiceName'..." -ForegroundColor Red
        $confirm = Read-Host "Sind Sie sicher? (ja/nein)"
        if ($confirm.ToLower() -eq "ja" -or $confirm.ToLower() -eq "j" -or $confirm.ToLower() -eq "yes" -or $confirm.ToLower() -eq "y") {
            try {
                # Service stoppen
                Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
                
                # Service löschen
                sc.exe delete $ServiceName
                
                Write-Host "Service erfolgreich deinstalliert!" -ForegroundColor Green
            } catch {
                Write-Host "FEHLER beim Deinstallieren: $($_.Exception.Message)" -ForegroundColor Red
            }
        } else {
            Write-Host "Deinstallation abgebrochen." -ForegroundColor Yellow
        }
    }
    
    default {
        Write-Host "Unbekannte Aktion: $Action" -ForegroundColor Red
        Show-Usage
    }
}
