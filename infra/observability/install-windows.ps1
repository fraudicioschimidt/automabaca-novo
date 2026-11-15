param(
    [string]$Destination = (Join-Path $env:LOCALAPPDATA 'AutomaBACA\logs'),
    [ValidatePattern('^[a-zA-Z0-9_-]+$')][string]$SshAlias = 'hermes'
)
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSEdition -ne 'Desktop' -or $PSVersionTable.PSVersion -lt [Version]'5.1') {
    throw 'Execute este instalador com powershell.exe (Windows PowerShell 5.1).'
}
$root = [IO.Path]::GetFullPath($Destination)
[void](New-Item -ItemType Directory -Path $root -Force)
if ((Get-Item -LiteralPath $root).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Destino nao pode ser um link.' }
$scriptPath = Join-Path $root 'sync-windows.ps1'
Get-Command scp.exe,ssh.exe -CommandType Application -ErrorAction Stop | Out-Null
if ($root.Contains('"')) { throw 'Caminho nao suportado.' }
foreach ($name in @('sync-windows.ps1','windows-launcher.cs')) {
    $target = Join-Path $root $name
    if ((Test-Path -LiteralPath $target) -and ((Get-Item -LiteralPath $target -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Arquivo de instalacao nao pode ser um link.' }
    $partial = Join-Path $root ('.download-' + [Guid]::NewGuid().ToString('N'))
    $hashPath = $partial + '.sha256'
    $hashName = [IO.Path]::GetFileNameWithoutExtension($name) + '.sha256'
    try {
        & scp.exe -q -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=yes "${SshAlias}:/srv/apps/automabaca-novo/exports/log-tools/$name" $partial
        if ($LASTEXITCODE -ne 0) { throw ('Falha ao baixar ' + $name) }
        & scp.exe -q -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=yes "${SshAlias}:/srv/apps/automabaca-novo/exports/log-tools/$hashName" $hashPath
        if ($LASTEXITCODE -ne 0) { throw 'Falha ao baixar checksum.' }
        $expected = (Get-Content -LiteralPath $hashPath -Raw).Trim()
        if ($expected -notmatch '^[a-f0-9]{64}$' -or (Get-FileHash -LiteralPath $partial -Algorithm SHA256).Hash -ine $expected) { throw ('Checksum invalido: ' + $name) }
        Move-Item -LiteralPath $partial -Destination $target -Force
    } finally {
        foreach ($temporary in @($partial,$hashPath)) { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force } }
    }
}
# Build locally against the .NET Framework already used by Windows PowerShell.
# A new name allows updating even while an earlier launcher is running.
$launcherPath = Join-Path $root ('sync-windows-hidden-' + [Guid]::NewGuid().ToString('N') + '.exe')
Add-Type -TypeDefinition (Get-Content -LiteralPath (Join-Path $root 'windows-launcher.cs') -Raw) -OutputAssembly $launcherPath -OutputType WindowsApplication
Write-Output 'Validando a copia em segundo plano...'
$start = New-Object Diagnostics.ProcessStartInfo
$start.FileName = $launcherPath
$start.Arguments = $SshAlias
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$process = [Diagnostics.Process]::Start($start)
try {
    $process.WaitForExit()
    if ($process.ExitCode -ne 0) { throw ('Validacao falhou. Consulte last-error.json e launcher-error.json em ' + $root + '. A tarefa anterior foi preservada.') }
} finally { $process.Dispose() }
$action = New-ScheduledTaskAction -Execute $launcherPath -Argument $SshAlias -WorkingDirectory $root
$repeat = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 15) -RepetitionDuration (New-TimeSpan -Days 3650)
$logon = New-ScheduledTaskTrigger -AtLogOn -User ([Security.Principal.WindowsIdentity]::GetCurrent().Name)
$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 12)
$taskName = 'AutomaBACA - copia de logs'
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($repeat,$logon) -Settings $settings -Principal $principal -Force | Out-Null
Write-Output ('Atualizado: copia automatica sem abrir janelas, a cada 15 minutos enquanto seu usuario estiver conectado. Destino: ' + $root)
Write-Output ('Estado: Get-ScheduledTaskInfo -TaskName "' + $taskName + '"')
